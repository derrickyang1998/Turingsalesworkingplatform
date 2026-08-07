'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const FILE_MODES = Object.freeze({
  parent: 0o710,
  socket: 0o660,
  privateFile: 0o600,
  nginxBypass: 0o640
});

const ALLOWED_ENVIRONMENT = new Set([
  'TM_REPLAY_MODE',
  'TM_REPLAY_ROOT',
  'TM_REPLAY_METHOD',
  'TM_REPLAY_PATH',
  'TM_REPLAY_HEADER_NAME',
  'TM_REPLAY_HEADER_SHA256',
  'TM_REPLAY_SOURCE_SHA256',
  'TM_REPLAY_RUN_ID',
  'TM_REPLAY_CANDIDATE_PORT',
  'TM_REPLAY_WWW_DATA_GID',
  'TM_REPLAY_MAX_BODY_BYTES',
  'TM_REPLAY_MAX_HEADER_BYTES',
  'TM_REPLAY_MAX_RESPONSE_BYTES',
  'TM_REPLAY_TIMEOUT_MS',
  'TM_REPLAY_NGINX_BYPASS_PATH',
  'TM_REPLAY_FAULT'
]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

class GateError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function reject(code, statusCode, message) {
  throw new GateError(code, statusCode, message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    reject('MISSING_CONFIGURATION', 500, `Missing required configuration: ${name}`);
  }
  return value;
}

function boundedInteger(environment, name, minimum, maximum) {
  const value = requireEnvironment(environment, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) reject('INVALID_CONFIGURATION', 500, `${name} is invalid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    reject('INVALID_CONFIGURATION', 500, `${name} is outside its allowed bound`);
  }
  return number;
}

function loadConfig(environment) {
  for (const name of Object.keys(environment)) {
    if (!ALLOWED_ENVIRONMENT.has(name)) {
      reject('UNSANITIZED_ENVIRONMENT', 500, 'Replay helper requires an empty, explicit environment');
    }
  }
  const mode = requireEnvironment(environment, 'TM_REPLAY_MODE');
  if (!['serve', 'verify-state', 'cleanup'].includes(mode)) {
    reject('INVALID_MODE', 500, 'Replay helper mode is invalid');
  }
  const root = path.resolve(requireEnvironment(environment, 'TM_REPLAY_ROOT'));
  if (!path.isAbsolute(root)) reject('INVALID_CONFIGURATION', 500, 'Replay root must be absolute');
  const method = requireEnvironment(environment, 'TM_REPLAY_METHOD');
  if (!/^[A-Z]+$/.test(method) || method === 'CONNECT') {
    reject('INVALID_CONFIGURATION', 500, 'Replay method is invalid');
  }
  const requestPath = requireEnvironment(environment, 'TM_REPLAY_PATH');
  if (!requestPath.startsWith('/') || requestPath.startsWith('//') || /[?#\s]/.test(requestPath)) {
    reject('INVALID_CONFIGURATION', 500, 'Replay path must be an exact origin-form path');
  }
  const claimHeaderName = requireEnvironment(environment, 'TM_REPLAY_HEADER_NAME').toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(claimHeaderName) ||
      HOP_BY_HOP_HEADERS.has(claimHeaderName)) {
    reject('INVALID_CONFIGURATION', 500, 'Replay claim header name is invalid');
  }
  const expectedClaimDigest = requireEnvironment(environment, 'TM_REPLAY_HEADER_SHA256');
  const sourceDigest = requireEnvironment(environment, 'TM_REPLAY_SOURCE_SHA256');
  if (!/^[0-9a-f]{64}$/.test(expectedClaimDigest) || !/^[0-9a-f]{64}$/.test(sourceDigest)) {
    reject('INVALID_CONFIGURATION', 500, 'Replay digest configuration is invalid');
  }
  const runId = requireEnvironment(environment, 'TM_REPLAY_RUN_ID');
  if (runId.length > 256 || /[\r\n\0]/.test(runId)) {
    reject('INVALID_CONFIGURATION', 500, 'Replay run identity is invalid');
  }
  const nginxBypassPath = path.resolve(requireEnvironment(environment, 'TM_REPLAY_NGINX_BYPASS_PATH'));
  return Object.freeze({
    mode,
    root,
    socketPath: path.join(root, 'replay.sock'),
    expectedHeaderPath: path.join(root, 'expected-header'),
    pendingPath: path.join(root, 'probe.pending'),
    claimedPath: path.join(root, 'probe.claimed'),
    claimStagePath: path.join(root, 'probe.claim-evidence'),
    resultPath: path.join(root, 'probe.result'),
    pidPath: path.join(root, 'probe.pid'),
    nginxBypassPath,
    method,
    path: requestPath,
    claimHeaderName,
    expectedClaimDigest,
    sourceDigest,
    runDigest: sha256(Buffer.from(runId, 'utf8')),
    candidatePort: boundedInteger(environment, 'TM_REPLAY_CANDIDATE_PORT', 1024, 65535),
    maxBodyBytes: boundedInteger(environment, 'TM_REPLAY_MAX_BODY_BYTES', 0, 1024 * 1024),
    maxHeaderBytes: boundedInteger(environment, 'TM_REPLAY_MAX_HEADER_BYTES', 1024, 64 * 1024),
    maxResponseBytes: boundedInteger(environment, 'TM_REPLAY_MAX_RESPONSE_BYTES', 1, 16 * 1024 * 1024),
    timeoutMs: boundedInteger(environment, 'TM_REPLAY_TIMEOUT_MS', 100, 30_000),
    fault: environment.TM_REPLAY_FAULT || null,
    identity: Object.freeze({
      rootUid: 0,
      rootGid: 0,
      wwwDataGid: boundedInteger(environment, 'TM_REPLAY_WWW_DATA_GID', 1, 65535)
    })
  });
}

function parseReplayRequest(raw, policy) {
  if (!Buffer.isBuffer(raw)) reject('INVALID_REQUEST', 400, 'Request must be bytes');
  if (raw.length > policy.maxHeaderBytes + policy.maxBodyBytes + 4) {
    reject('REQUEST_TOO_LARGE', 413, 'Request exceeds configured bounds');
  }

  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 0 || separator > policy.maxHeaderBytes) {
    reject('MALFORMED_HEADERS', 400, 'Malformed request framing');
  }
  const head = raw.subarray(0, separator).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = lines.shift();
  const match = /^([A-Z]+) ([^ ]+) HTTP\/1\.1$/.exec(requestLine || '');
  if (!match) reject('MALFORMED_REQUEST_LINE', 400, 'Malformed request line');
  const [, method, target] = match;
  if (method === 'CONNECT') reject('CONNECT_FORBIDDEN', 405, 'CONNECT is forbidden');
  if (method !== policy.method) reject('METHOD_MISMATCH', 405, 'Request method does not match');
  if (!target.startsWith('/') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    reject('ABSOLUTE_FORM_FORBIDDEN', 400, 'Only origin-form targets are accepted');
  }
  if (target !== policy.path) reject('PATH_MISMATCH', 404, 'Request path does not match');

  const seen = new Map();
  const headers = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line)) reject('OBS_FOLD_FORBIDDEN', 400, 'Folded headers are forbidden');
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!header) reject('MALFORMED_HEADER', 400, 'Malformed header');
    const name = header[1].toLowerCase();
    const value = header[2].trim();
    if (!/^[\t\x20-\x7e]*$/.test(value)) reject('MALFORMED_HEADER', 400, 'Malformed header value');
    if (seen.has(name)) reject('DUPLICATE_HEADER', 400, 'Duplicate headers are forbidden');
    seen.set(name, value);
    headers.push([name, value]);
  }

  if (!seen.has('host') || seen.get('host').length === 0) reject('HOST_REQUIRED', 400, 'Host is required');
  if (seen.has('transfer-encoding')) reject('TRANSFER_ENCODING_FORBIDDEN', 400, 'Transfer encoding is forbidden');
  if (seen.has('upgrade')) reject('UPGRADE_FORBIDDEN', 400, 'Protocol upgrades are forbidden');
  if (seen.has('expect')) reject('EXPECT_FORBIDDEN', 417, 'Expect is forbidden');
  const nominatedHopHeaders = new Set();
  if (seen.has('connection')) {
    for (const token of seen.get('connection').split(',')) {
      const name = token.trim().toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
        reject('MALFORMED_CONNECTION', 400, 'Connection header is malformed');
      }
      nominatedHopHeaders.add(name);
    }
  }
  const contentLengthValue = seen.get('content-length');
  if (contentLengthValue === undefined || !/^(0|[1-9][0-9]*)$/.test(contentLengthValue)) {
    reject('CONTENT_LENGTH_REQUIRED', 411, 'One canonical content length is required');
  }
  const bodyBytes = Number(contentLengthValue);
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes > policy.maxBodyBytes) {
    reject('BODY_TOO_LARGE', 413, 'Body exceeds configured bound');
  }
  const body = raw.subarray(separator + 4);
  if (body.length > bodyBytes) reject('PIPELINING_FORBIDDEN', 400, 'Pipelined requests are forbidden');
  if (body.length < bodyBytes) reject('FRAMING_MISMATCH', 400, 'Request framing does not match content length');

  const claim = seen.get(policy.claimHeaderName);
  if (claim === undefined) reject('CLAIM_REQUIRED', 401, 'Replay claim is required');
  const claimBytes = Buffer.from(claim, 'utf8');
  if (claimBytes.length !== policy.expectedClaim.length ||
      !crypto.timingSafeEqual(claimBytes, policy.expectedClaim)) {
    reject('CLAIM_MISMATCH', 403, 'Replay claim does not match');
  }

  return {
    method,
    pathDigest: sha256(Buffer.from(target, 'utf8')),
    requestDigest: sha256(raw),
    bodyDigest: sha256(body),
    bodyBytes,
    body,
    forwardHeaders: headers.filter(([name]) =>
      !name.startsWith('x-tm-replay-') &&
      !HOP_BY_HOP_HEADERS.has(name) &&
      !nominatedHopHeaders.has(name)
    )
  };
}

function forwardToCandidate(config, request, fault = null) {
  return new Promise((resolve, rejectPromise) => {
    const headers = Object.fromEntries(request.forwardHeaders.filter(([name]) => name !== 'host'));
    headers.host = `127.0.0.1:${config.candidatePort}`;
    headers.connection = 'close';
    const outgoing = http.request({
      host: '127.0.0.1',
      port: config.candidatePort,
      method: config.method,
      path: config.path,
      headers,
      agent: false,
      timeout: config.timeoutMs,
      maxHeaderSize: config.maxHeaderBytes
    }, (response) => {
      const rawResponseHeaders = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index].toLowerCase();
        rawResponseHeaders.push([name, response.rawHeaders[index + 1]]);
      }
      const nominatedResponseHeaders = new Set();
      for (const [, value] of rawResponseHeaders.filter(([name]) => name === 'connection')) {
        for (const token of value.split(',')) {
          const name = token.trim().toLowerCase();
          if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
            response.destroy();
            rejectPromise(new GateError('MALFORMED_CANDIDATE_CONNECTION', 502, 'Candidate connection header is invalid'));
            return;
          }
          nominatedResponseHeaders.add(name);
        }
      }
      const responseHeaders = rawResponseHeaders.filter(([name]) =>
        !HOP_BY_HOP_HEADERS.has(name) &&
        !nominatedResponseHeaders.has(name) &&
        !name.startsWith('x-tm-replay-')
      );
      const declaredLength = response.headers['content-length'];
      if (declaredLength !== undefined &&
          (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > config.maxResponseBytes)) {
        response.destroy();
        rejectPromise(new GateError('RESPONSE_TOO_LARGE', 502, 'Candidate response exceeds configured bound'));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > config.maxResponseBytes) {
          response.destroy(new GateError('RESPONSE_TOO_LARGE', 502, 'Candidate response exceeds configured bound'));
          return;
        }
        chunks.push(chunk);
        if (fault && fault.point === 'during-response') {
          if (typeof fault.action === 'function') fault.action('during-response');
          response.destroy(new GateError('INJECTED_CRASH', 500, 'Injected gate crash'));
        }
      });
      response.once('aborted', () => {
        rejectPromise(new GateError('CANDIDATE_ABORTED', 502, 'Candidate response was incomplete'));
      });
      response.once('error', rejectPromise);
      response.once('end', () => {
        resolve({
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: responseHeaders,
          body: Buffer.concat(chunks, total)
        });
      });
    });
    outgoing.once('timeout', () => {
      outgoing.destroy(new GateError('CANDIDATE_TIMEOUT', 504, 'Candidate request timed out'));
    });
    outgoing.once('error', rejectPromise);
    outgoing.end(request.body);
  });
}

function modeOf(stat) {
  return stat.mode & 0o777;
}

function requireModeChecks(config) {
  return process.platform !== 'win32' || config.allowNonPosixTestPlatform !== true;
}

function assertIdentity(stat, uid, gid, label) {
  if (stat.uid !== uid || stat.gid !== gid) {
    reject('UNSAFE_OWNERSHIP', 500, `${label} ownership is unsafe`);
  }
}

function sameInode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function noFollowFlags(flags, { directory = false } = {}) {
  if (typeof fs.constants.O_NOFOLLOW === 'number') flags |= fs.constants.O_NOFOLLOW;
  else if (process.platform !== 'win32') {
    reject('NOFOLLOW_UNAVAILABLE', 500, 'Kernel no-follow file opens are required');
  }
  if (directory) {
    if (typeof fs.constants.O_DIRECTORY === 'number') flags |= fs.constants.O_DIRECTORY;
    else if (process.platform !== 'win32') {
      reject('DIRECTORY_OPEN_UNAVAILABLE', 500, 'Kernel directory-only opens are required');
    }
  }
  return flags;
}

function readLinuxMountId(descriptor) {
  if (process.platform !== 'linux') return null;
  let fdInfo;
  try {
    fdInfo = fs.readFileSync(`/proc/self/fdinfo/${descriptor}`).toString('utf8');
  } catch {
    reject('MOUNT_ID_UNAVAILABLE', 500, 'Linux mount identity is unavailable');
  }
  const match = /^mnt_id:\s*([0-9]+)\s*$/m.exec(fdInfo);
  if (!match) reject('MOUNT_ID_UNAVAILABLE', 500, 'Linux mount identity is malformed');
  return match[1];
}

function openDirectoryIdentity(directoryPath, label) {
  const before = fs.lstatSync(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    reject('UNSAFE_ROOT', 500, `${label} is not a directory`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, noFollowFlags(fs.constants.O_RDONLY, { directory: true }));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory() || !sameInode(before, opened)) {
      reject('ROOT_IDENTITY_RACE', 500, `${label} changed while it was opened`);
    }
    return {
      descriptor,
      stat: opened,
      mountId: readLinuxMountId(descriptor),
      path: directoryPath,
      label
    };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof GateError) throw error;
    if (error && ['ELOOP', 'ENOENT', 'ENOTDIR'].includes(error.code)) {
      reject('ROOT_IDENTITY_RACE', 500, `${label} changed while it was opened`);
    }
    throw error;
  }
}

function assertDirectoryHandleStable(handle) {
  let current;
  try {
    current = fs.lstatSync(handle.path);
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
      reject('ROOT_IDENTITY_RACE', 500, `${handle.label} changed while in use`);
    }
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameInode(current, handle.stat)) {
    reject('ROOT_IDENTITY_RACE', 500, `${handle.label} changed while in use`);
  }
  const opened = fs.fstatSync(handle.descriptor);
  if (!opened.isDirectory() || !sameInode(opened, handle.stat) ||
      readLinuxMountId(handle.descriptor) !== handle.mountId) {
    reject('ROOT_IDENTITY_RACE', 500, `${handle.label} identity changed while in use`);
  }
}

function openValidatedRoot(config) {
  const resolved = path.resolve(config.root);
  if (resolved !== config.root || fs.realpathSync.native(config.root) !== resolved) {
    reject('UNSAFE_ROOT', 500, 'Gate root is not canonical');
  }
  const root = openDirectoryIdentity(config.root, 'Gate root');
  try {
    if (requireModeChecks(config) && modeOf(root.stat) !== FILE_MODES.parent) {
      reject('UNSAFE_MODE', 500, 'Gate root mode is unsafe');
    }
    assertIdentity(root.stat, config.identity.rootUid, config.identity.wwwDataGid, 'Gate root');
    const parent = openDirectoryIdentity(path.dirname(config.root), 'Gate root parent');
    try {
      if (parent.stat.dev !== root.stat.dev ||
          (process.platform === 'linux' && parent.mountId !== root.mountId)) {
        reject('MOUNT_SUBSTITUTION', 500, 'Gate root crosses a mount boundary');
      }
    } finally {
      fs.closeSync(parent.descriptor);
    }
    assertDirectoryHandleStable(root);
    return root;
  } catch (error) {
    fs.closeSync(root.descriptor);
    throw error;
  }
}

function validateRoot(config) {
  const root = openValidatedRoot(config);
  try {
    return root.stat;
  } finally {
    fs.closeSync(root.descriptor);
  }
}

function assertPrivateMetadata(stat, rootStat, config, allowedLinks) {
  if (!stat.isFile() || stat.isSymbolicLink() || !allowedLinks.includes(stat.nlink)) {
    reject('UNSAFE_STATE_FILE', 500, 'Gate state is not a permitted regular file');
  }
  if (requireModeChecks(config) && modeOf(stat) !== FILE_MODES.privateFile) {
    reject('UNSAFE_MODE', 500, 'Gate state mode is unsafe');
  }
  assertIdentity(stat, config.identity.rootUid, config.identity.rootGid, 'Gate state');
  if (stat.dev !== rootStat.dev) reject('MOUNT_SUBSTITUTION', 500, 'Gate state crosses a device boundary');
}

function assertPrivateHandleStable(handle, config) {
  const opened = fs.fstatSync(handle.descriptor);
  assertPrivateMetadata(opened, handle.root.stat, config, handle.allowedLinks);
  if (!sameInode(opened, handle.stat) ||
      (process.platform === 'linux' && readLinuxMountId(handle.descriptor) !== handle.root.mountId)) {
    reject('PRIVATE_FILE_RACE', 500, 'Gate state identity changed while in use');
  }
  let current;
  try {
    current = fs.lstatSync(handle.path);
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
      reject('PRIVATE_FILE_RACE', 500, 'Gate state path changed while in use');
    }
    throw error;
  }
  if (!sameInode(current, opened) || current.isSymbolicLink()) {
    reject('PRIVATE_FILE_RACE', 500, 'Gate state path changed while in use');
  }
  assertPrivateMetadata(current, handle.root.stat, config, handle.allowedLinks);
  assertDirectoryHandleStable(handle.root);
}

function openValidatedPrivateFile(filePath, config, {
  required = true,
  allowedLinks = [1],
  flags = fs.constants.O_RDONLY
} = {}) {
  const root = openValidatedRoot(config);
  let descriptor;
  try {
    if (path.dirname(path.resolve(filePath)) !== config.root) {
      reject('PATH_ESCAPE', 500, 'Gate state path escapes the canonical root');
    }
    let before;
    try {
      before = fs.lstatSync(filePath);
    } catch (error) {
      if (!required && error && error.code === 'ENOENT') {
        fs.closeSync(root.descriptor);
        return null;
      }
      throw error;
    }
    assertPrivateMetadata(before, root.stat, config, allowedLinks);
    try {
      descriptor = fs.openSync(filePath, noFollowFlags(flags));
    } catch (error) {
      if (error && ['ELOOP', 'ENOENT', 'ENOTDIR'].includes(error.code)) {
        reject('PRIVATE_FILE_RACE', 500, 'Gate state changed while it was opened');
      }
      throw error;
    }
    const opened = fs.fstatSync(descriptor);
    assertPrivateMetadata(opened, root.stat, config, allowedLinks);
    if (!sameInode(before, opened) ||
        (process.platform === 'linux' && readLinuxMountId(descriptor) !== root.mountId)) {
      reject('PRIVATE_FILE_RACE', 500, 'Gate state changed while it was opened');
    }
    const handle = { descriptor, stat: opened, root, path: filePath, allowedLinks };
    assertPrivateHandleStable(handle, config);
    return handle;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.closeSync(root.descriptor);
    throw error;
  }
}

function closeValidatedPrivateFile(handle) {
  fs.closeSync(handle.descriptor);
  fs.closeSync(handle.root.descriptor);
}

function validatePrivateFile(filePath, config, { required = true, allowedLinks = [1] } = {}) {
  const handle = openValidatedPrivateFile(filePath, config, { required, allowedLinks });
  if (!handle) return null;
  try {
    return handle.stat;
  } finally {
    closeValidatedPrivateFile(handle);
  }
}

function readPrivateFile(filePath, config, options = {}) {
  const handle = openValidatedPrivateFile(filePath, config, options);
  if (!handle) return null;
  try {
    const value = fs.readFileSync(handle.descriptor);
    assertPrivateHandleStable(handle, config);
    return value;
  } finally {
    closeValidatedPrivateFile(handle);
  }
}

function parseEvidence(filePath, config) {
  let parsed;
  try {
    parsed = JSON.parse(readPrivateFile(filePath, config).toString('utf8'));
  } catch (error) {
    if (error instanceof GateError) throw error;
    reject('INVALID_EVIDENCE', 500, 'Gate evidence is invalid');
  }
  if (!parsed || parsed.schema_version !== 1 ||
      parsed.source_digest !== config.sourceDigest ||
      parsed.run_digest !== config.runDigest) {
    reject('EVIDENCE_MISMATCH', 500, 'Gate evidence does not match this release');
  }
  return parsed;
}

function validateGateState(config) {
  validateRoot(config);
  const expected = readPrivateFile(config.expectedHeaderPath, config);
  if (sha256(expected) !== config.expectedClaimDigest) {
    reject('EXPECTED_CLAIM_MISMATCH', 500, 'Expected claim digest does not match');
  }
  const pending = validatePrivateFile(config.pendingPath, config, { required: false });
  const claimed = validatePrivateFile(config.claimedPath, config, { required: false });
  const claimStage = validatePrivateFile(config.claimStagePath, config, { required: false });
  const claimResidue = validatePrivateFile(atomicResiduePath(config.claimStagePath, config), config, {
    required: false,
    allowedLinks: [1, 2]
  });
  if (claimed) {
    try {
      const claimEvidence = parseEvidence(config.claimedPath, config);
      if (claimStage) {
        const stagedEvidence = parseEvidence(config.claimStagePath, config);
        if (stagedEvidence.request_digest !== claimEvidence.request_digest) {
          reject('EVIDENCE_MISMATCH', 500, 'Claim stage does not match claimed evidence');
        }
      }
    } catch (error) {
      if (!claimStage) return 'claimed-corrupt';
      parseEvidence(config.claimStagePath, config);
      return 'claimed-interrupted';
    }
    return pending ? 'claimed-interrupted' : 'claimed';
  }
  if (!pending) reject('NOT_ARMED', 409, 'Replay gate is not armed');
  parseEvidence(config.pendingPath, config);
  if (claimStage) parseEvidence(config.claimStagePath, config);
  return claimStage || claimResidue ? 'armed-staged' : 'armed';
}

function fsyncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32' || !['EINVAL', 'EPERM'].includes(error.code)) throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAtomicPrivate(filePath, value, config, fault = null) {
  return writeAtomicPrivateWithFault(filePath, value, config, fault);
}

function atomicResiduePath(filePath, config) {
  if (path.dirname(path.resolve(filePath)) !== config.root) {
    reject('PATH_ESCAPE', 500, 'Atomic state path escapes the canonical root');
  }
  return path.join(config.root, `.atomic-${path.basename(filePath)}.pending`);
}

function privateFileEquals(filePath, expectedBytes, config) {
  const actual = readPrivateFile(filePath, config, { allowedLinks: [1, 2] });
  return actual.length === expectedBytes.length && crypto.timingSafeEqual(actual, expectedBytes);
}

function recoverAtomicPrivate(filePath, expectedBytes, config) {
  validateRoot(config);
  const residuePath = atomicResiduePath(filePath, config);
  let target = validatePrivateFile(filePath, config, { required: false, allowedLinks: [1, 2] });
  let residue = validatePrivateFile(residuePath, config, { required: false, allowedLinks: [1, 2] });
  if (!target && !residue) return { complete: false, recovered: false };
  if (target && !residue) {
    if (target.nlink !== 1 || !privateFileEquals(filePath, expectedBytes, config)) {
      reject('ATOMIC_TARGET_MISMATCH', 500, 'Atomic target does not match expected evidence');
    }
    return { complete: true, recovered: false };
  }
  if (!target && residue) {
    if (residue.nlink !== 1) reject('ATOMIC_RESIDUE_MISMATCH', 500, 'Atomic residue link count is unsafe');
    if (!privateFileEquals(residuePath, expectedBytes, config)) {
      validateRoot(config);
      validatePrivateFile(residuePath, config);
      fs.unlinkSync(residuePath);
      fsyncDirectory(config.root);
      return { complete: false, recovered: false };
    }
    fs.linkSync(residuePath, filePath);
    fsyncDirectory(config.root);
    target = validatePrivateFile(filePath, config, { allowedLinks: [2] });
    residue = validatePrivateFile(residuePath, config, { allowedLinks: [2] });
  }
  if (!target || !residue || target.dev !== residue.dev || target.ino !== residue.ino ||
      target.nlink !== 2 || residue.nlink !== 2 || !privateFileEquals(filePath, expectedBytes, config)) {
    reject('ATOMIC_RESIDUE_MISMATCH', 500, 'Atomic target and residue are not the same evidence inode');
  }
  validateRoot(config);
  validatePrivateFile(residuePath, config, { allowedLinks: [2] });
  fs.unlinkSync(residuePath);
  fsyncDirectory(config.root);
  validatePrivateFile(filePath, config);
  return { complete: true, recovered: true };
}

function writeAtomicPrivateWithFault(filePath, value, config, fault = null) {
  validateRoot(config);
  const expectedBytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const recovered = recoverAtomicPrivate(filePath, expectedBytes, config);
  if (recovered.complete) return recovered.recovered;
  const temporaryPath = atomicResiduePath(filePath, config);
  const flags = fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, flags, FILE_MODES.privateFile);
    fs.fchmodSync(descriptor, FILE_MODES.privateFile);
    writeComplete(descriptor, expectedBytes);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  validatePrivateFile(temporaryPath, config);
  injectFault(fault, 'after-audit-stage-fsync');
  try {
    fs.linkSync(temporaryPath, filePath);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const concurrent = recoverAtomicPrivate(filePath, expectedBytes, config);
      if (concurrent.complete) return concurrent.recovered;
    }
    throw error;
  }
  fsyncDirectory(config.root);
  injectFault(fault, 'after-audit-link-before-unlink');
  const completed = recoverAtomicPrivate(filePath, expectedBytes, config);
  if (!completed.complete) reject('ATOMIC_PUBLISH_FAILED', 500, 'Atomic publication did not complete');
  return true;
}

function validateNginxBypass(config, { required = true } = {}) {
  if (path.dirname(config.nginxBypassPath) === config.root) {
    return validatePrivateFile(config.nginxBypassPath, config, { required });
  }
  const parent = path.dirname(config.nginxBypassPath);
  if (path.resolve(config.nginxBypassPath) !== config.nginxBypassPath ||
      fs.realpathSync.native(parent) !== parent) {
    reject('UNSAFE_NGINX_PATH', 500, 'Nginx bypass path is not canonical');
  }
  let stat;
  try {
    stat = fs.lstatSync(config.nginxBypassPath);
  } catch (error) {
    if (!required && error && error.code === 'ENOENT') return null;
    throw error;
  }
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.dev !== parentStat.dev) {
    reject('UNSAFE_NGINX_PATH', 500, 'Nginx bypass path is unsafe');
  }
  assertIdentity(stat, config.identity.rootUid, config.identity.wwwDataGid, 'Nginx bypass');
  if (requireModeChecks(config) && modeOf(stat) !== FILE_MODES.nginxBypass) {
    reject('UNSAFE_MODE', 500, 'Nginx bypass mode is unsafe');
  }
  return stat;
}

function validateSocket(config, { required = true } = {}) {
  const rootStat = validateRoot(config);
  let stat;
  try {
    stat = fs.lstatSync(config.socketPath);
  } catch (error) {
    if (!required && error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.dev !== rootStat.dev) {
    reject('UNSAFE_SOCKET', 500, 'Replay socket is unsafe');
  }
  assertIdentity(stat, config.identity.rootUid, config.identity.wwwDataGid, 'Replay socket');
  if (requireModeChecks(config) && modeOf(stat) !== FILE_MODES.socket) {
    reject('UNSAFE_MODE', 500, 'Replay socket mode is unsafe');
  }
  return stat;
}

function safeUnlinkPrivate(filePath, config) {
  if (!validatePrivateFile(filePath, config, { required: false })) return false;
  validateRoot(config);
  validatePrivateFile(filePath, config);
  fs.unlinkSync(filePath);
  fsyncDirectory(config.root);
  return true;
}

function parseProcStartTicks(statLine) {
  const commandEnd = statLine.lastIndexOf(')');
  if (commandEnd < 0) reject('INVALID_PROCESS_IDENTITY', 500, 'Process stat is malformed');
  const fields = statLine.slice(commandEnd + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  if (!/^[0-9]+$/.test(startTicks || '')) {
    reject('INVALID_PROCESS_IDENTITY', 500, 'Process starttime is malformed');
  }
  return startTicks;
}

function nullSeparatedMap(bytes) {
  const values = new Map();
  for (const entry of bytes.toString('utf8').split('\0')) {
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return values;
}

function readLinuxProcessIdentity(pid) {
  if (process.platform !== 'linux') reject('LINUX_REQUIRED', 500, 'Process identity requires Linux');
  const procRoot = `/proc/${pid}`;
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id');
  const statLine = fs.readFileSync(path.join(procRoot, 'stat'), 'utf8');
  const executable = fs.realpathSync.native(path.join(procRoot, 'exe'));
  const command = fs.readFileSync(path.join(procRoot, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
  if (command.length < 2) reject('INVALID_PROCESS_IDENTITY', 500, 'Replay helper command line is incomplete');
  const processCwd = fs.realpathSync.native(path.join(procRoot, 'cwd'));
  const scriptCandidate = path.isAbsolute(command[1]) ? command[1] : path.join(processCwd, command[1]);
  const scriptPath = fs.realpathSync.native(scriptCandidate);
  const environment = nullSeparatedMap(fs.readFileSync(path.join(procRoot, 'environ')));
  const runId = environment.get('TM_REPLAY_RUN_ID') || '';
  return {
    pid,
    bootIdDigest: sha256(bootId),
    processStartTicks: parseProcStartTicks(statLine),
    executableDigest: sha256(Buffer.from(executable, 'utf8')),
    scriptDigest: sha256(Buffer.from(scriptPath, 'utf8')),
    environmentSourceDigest: environment.get('TM_REPLAY_SOURCE_SHA256') || '',
    environmentRunDigest: sha256(Buffer.from(runId, 'utf8')),
    environmentMode: environment.get('TM_REPLAY_MODE') || ''
  };
}

function processIdentityMatches(recorded, observed, config) {
  return Boolean(recorded && observed &&
    recorded.schema_version === 1 &&
    recorded.pid === observed.pid &&
    recorded.source_digest === config.sourceDigest &&
    recorded.run_digest === config.runDigest &&
    recorded.boot_id_digest === observed.bootIdDigest &&
    recorded.process_start_ticks === observed.processStartTicks &&
    recorded.executable_digest === observed.executableDigest &&
    recorded.script_digest === observed.scriptDigest &&
    observed.environmentSourceDigest === config.sourceDigest &&
    observed.environmentRunDigest === config.runDigest &&
    observed.environmentMode === 'serve');
}

function requireRecordedHelperStopped(config) {
  if (!validatePrivateFile(config.pidPath, config, { required: false })) return;
  let evidence;
  try {
    evidence = JSON.parse(readPrivateFile(config.pidPath, config).toString('utf8'));
  } catch {
    reject('INVALID_PID_EVIDENCE', 500, 'Replay helper PID evidence is invalid');
  }
  if (!evidence || evidence.schema_version !== 1 ||
      evidence.source_digest !== config.sourceDigest ||
      evidence.run_digest !== config.runDigest ||
      !Number.isSafeInteger(evidence.pid) || evidence.pid < 2) {
    reject('INVALID_PID_EVIDENCE', 500, 'Replay helper PID evidence does not match');
  }
  if (process.platform !== 'linux') reject('UNSAFE_PID_STOP', 500, 'External helper stop requires Linux');
  let observed;
  try {
    observed = readLinuxProcessIdentity(evidence.pid);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      safeUnlinkPrivate(config.pidPath, config);
      return;
    }
    throw error;
  }
  if (!processIdentityMatches(evidence, observed, config)) {
    reject('PID_NOT_OWNED', 500, 'Recorded PID is not the exact replay helper run');
  }
  reject('HELPER_STILL_RUNNING', 500, 'Replay helper must be stopped by its transient unit before cleanup');
}

function discardAtomicPrivate(filePath, config) {
  const residuePath = atomicResiduePath(filePath, config);
  const target = validatePrivateFile(filePath, config, { required: false, allowedLinks: [1, 2] });
  const residue = validatePrivateFile(residuePath, config, { required: false, allowedLinks: [1, 2] });
  if (target && residue) {
    if (target.dev !== residue.dev || target.ino !== residue.ino || target.nlink !== 2) {
      reject('ATOMIC_RESIDUE_MISMATCH', 500, 'Atomic cleanup residue is not linked to its target');
    }
    validateRoot(config);
    fs.unlinkSync(residuePath);
    fsyncDirectory(config.root);
  } else if (residue) {
    if (residue.nlink !== 1) reject('ATOMIC_RESIDUE_MISMATCH', 500, 'Atomic cleanup residue is unsafe');
    validateRoot(config);
    fs.unlinkSync(residuePath);
    fsyncDirectory(config.root);
  }
  safeUnlinkPrivate(filePath, config);
}

function repairClaimEvidence(config) {
  const claimStat = validatePrivateFile(config.claimedPath, config, { required: false });
  if (!claimStat) {
    discardAtomicPrivate(config.claimStagePath, config);
    return null;
  }
  let claimedEvidence;
  try {
    claimedEvidence = parseEvidence(config.claimedPath, config);
  } catch (error) {
    const stagedEvidence = parseEvidence(config.claimStagePath, config);
    const bytes = Buffer.from(`${JSON.stringify(stagedEvidence)}\n`, 'utf8');
    validateRoot(config);
    const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
    const descriptor = fs.openSync(config.claimedPath, flags);
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== claimStat.dev || opened.ino !== claimStat.ino || opened.nlink !== 1) {
        reject('CLAIM_REPAIR_RACE', 500, 'Claim inode changed during repair');
      }
      fs.ftruncateSync(descriptor, 0);
      writeComplete(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fsyncDirectory(config.root);
    claimedEvidence = parseEvidence(config.claimedPath, config);
  }
  const stageStat = validatePrivateFile(config.claimStagePath, config, { required: false });
  if (stageStat) {
    const stagedEvidence = parseEvidence(config.claimStagePath, config);
    if (stagedEvidence.request_digest !== claimedEvidence.request_digest) {
      reject('EVIDENCE_MISMATCH', 500, 'Claim stage does not match repaired evidence');
    }
    discardAtomicPrivate(config.claimStagePath, config);
  } else if (validatePrivateFile(atomicResiduePath(config.claimStagePath, config), config, {
    required: false,
    allowedLinks: [1, 2]
  })) {
    reject('ATOMIC_RESIDUE_MISMATCH', 500, 'Claimed evidence has an unresolved stage residue');
  }
  return claimedEvidence;
}

function cleanupGate(config) {
  validateRoot(config);
  requireRecordedHelperStopped(config);
  const claimedEvidence = repairClaimEvidence(config);
  if (validateSocket(config, { required: false })) {
    validateSocket(config);
    fs.unlinkSync(config.socketPath);
    fsyncDirectory(config.root);
  }
  safeUnlinkPrivate(config.pendingPath, config);
  safeUnlinkPrivate(config.expectedHeaderPath, config);
  if (validateNginxBypass(config, { required: false })) {
    validateNginxBypass(config);
    fs.unlinkSync(config.nginxBypassPath);
    fsyncDirectory(path.dirname(config.nginxBypassPath));
  }

  const claim = validatePrivateFile(config.claimedPath, config, { required: false });
  if (claim && !claimedEvidence) reject('INVALID_EVIDENCE', 500, 'Claim evidence was not recovered');
  const result = {
    schema_version: 1,
    outcome: 'cleaned',
    source_digest: config.sourceDigest,
    run_digest: config.runDigest,
    claim_present: Boolean(claim)
  };
  if (!validatePrivateFile(config.resultPath, config, { required: false })) {
    writeAtomicPrivate(config.resultPath, result, config);
  }
  const saved = parseEvidence(config.resultPath, config);
  if (saved.outcome !== 'cleaned' && saved.outcome !== 'forwarded') {
    reject('INVALID_EVIDENCE', 500, 'Replay result is not auditable');
  }
  if (validateSocket(config, { required: false }) ||
      validatePrivateFile(config.pendingPath, config, { required: false }) ||
      validatePrivateFile(config.expectedHeaderPath, config, { required: false }) ||
      validatePrivateFile(config.pidPath, config, { required: false }) ||
      validateNginxBypass(config, { required: false })) {
    reject('BYPASS_REMAINS', 500, 'Replay bypass cleanup is incomplete');
  }
  fsyncDirectory(config.root);
  return { ok: true, claimPresent: Boolean(claim), outcome: saved.outcome };
}

function faultFor(config, point) {
  if (config.fault !== point) return null;
  return {
    point,
    action() {
      process.exit(86);
    }
  };
}

function sendError(socket, error) {
  const gateError = error instanceof GateError
    ? error
    : new GateError('GATE_FAILURE', 500, 'Replay gate failed');
  const statusCode = gateError.statusCode >= 400 && gateError.statusCode <= 599
    ? gateError.statusCode
    : 500;
  const body = Buffer.from(JSON.stringify({ ok: false, code: gateError.code }), 'utf8');
  const reason = http.STATUS_CODES[statusCode] || 'Error';
  socket.end(Buffer.concat([
    Buffer.from(
      `HTTP/1.1 ${statusCode} ${reason}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`,
      'latin1'
    ),
    body
  ]));
}

function collectRequest(socket, config) {
  return new Promise((resolve, rejectPromise) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let expectedBytes = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.pause();
      callback(value);
    };
    socket.setTimeout(config.timeoutMs, () => {
      finish(rejectPromise, new GateError('REQUEST_TIMEOUT', 408, 'Replay request timed out'));
    });
    socket.on('error', (error) => finish(rejectPromise, error));
    socket.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > config.maxHeaderBytes + config.maxBodyBytes + 4) {
        finish(rejectPromise, new GateError('REQUEST_TOO_LARGE', 413, 'Replay request exceeds configured bounds'));
        return;
      }
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks, total);
      if (expectedBytes === null) {
        const separator = bytes.indexOf('\r\n\r\n');
        if (separator < 0) {
          if (bytes.length > config.maxHeaderBytes) {
            finish(rejectPromise, new GateError('MALFORMED_HEADERS', 400, 'Replay request headers are malformed'));
          }
          return;
        }
        if (separator > config.maxHeaderBytes) {
          finish(rejectPromise, new GateError('MALFORMED_HEADERS', 400, 'Replay request headers are malformed'));
          return;
        }
        const head = bytes.subarray(0, separator).toString('latin1');
        const lengths = head.match(/(?:^|\r\n)Content-Length:[ \t]*([^\r\n]*)/gi) || [];
        if (lengths.length !== 1) {
          finish(rejectPromise, new GateError('CONTENT_LENGTH_REQUIRED', 411, 'One content length is required'));
          return;
        }
        const value = lengths[0].slice(lengths[0].indexOf(':') + 1).trim();
        if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > config.maxBodyBytes) {
          finish(rejectPromise, new GateError('BODY_TOO_LARGE', 413, 'Replay body is invalid'));
          return;
        }
        expectedBytes = separator + 4 + Number(value);
      }
      if (bytes.length >= expectedBytes) finish(resolve, bytes);
    });
    socket.on('end', () => {
      if (!settled) finish(rejectPromise, new GateError('INCOMPLETE_REQUEST', 400, 'Replay request was incomplete'));
    });
  });
}

function serializeCandidateResponse(response, config) {
  const statusCode = Number.isInteger(response.statusCode) &&
    response.statusCode >= 100 && response.statusCode <= 599
    ? response.statusCode
    : 502;
  const headers = response.headers.filter(([name]) =>
    name !== 'content-length' && name !== 'connection' && !name.startsWith('x-tm-replay-')
  );
  headers.push(['content-length', String(response.body.length)]);
  headers.push(['connection', 'close']);
  const head = Buffer.from(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] || 'Response'}\r\n` +
    `${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`,
    'latin1'
  );
  if (head.length > config.maxHeaderBytes) {
    reject('RESPONSE_HEADERS_TOO_LARGE', 502, 'Candidate response headers exceed configured bound');
  }
  return Buffer.concat([head, response.body]);
}

async function serveGate(config, options = {}) {
  if (process.platform === 'win32') {
    reject('UNIX_SOCKET_REQUIRED', 500, 'Replay helper requires Unix sockets');
  }
  if (!validateGateState(config).startsWith('armed')) {
    reject('ALREADY_CLAIMED', 409, 'Replay was already claimed');
  }
  validateNginxBypass(config);
  if (validateSocket(config, { required: false })) reject('SOCKET_EXISTS', 500, 'Replay socket already exists');

  const expectedClaim = readPrivateFile(config.expectedHeaderPath, config);
  const policy = {
    method: config.method,
    path: config.path,
    claimHeaderName: config.claimHeaderName,
    expectedClaim,
    maxBodyBytes: config.maxBodyBytes,
    maxHeaderBytes: config.maxHeaderBytes
  };
  let claiming = false;
  const server = net.createServer({ allowHalfOpen: true }, async (socket) => {
    socket.setNoDelay(true);
    if (claiming || validatePrivateFile(config.claimedPath, config, { required: false })) {
      sendError(socket, new GateError('ALREADY_CLAIMED', 409, 'Replay was already claimed'));
      return;
    }
    try {
      const raw = await collectRequest(socket, config);
      const request = parseReplayRequest(raw, policy);
      if (claiming) reject('ALREADY_CLAIMED', 409, 'Replay was already claimed');
      claiming = true;
      claimReplay(config, request, faultFor(config, config.fault));
      const response = await forwardToCandidate(config, request, faultFor(config, 'during-response'));
      const result = {
        schema_version: 1,
        outcome: 'forwarded',
        source_digest: config.sourceDigest,
        run_digest: config.runDigest,
        request_digest: request.requestDigest,
        response_digest: sha256(response.body),
        response_bytes: response.body.length,
        status_code: response.statusCode
      };
      if (!writeAtomicPrivate(config.resultPath, result, config)) {
        reject('RESULT_EXISTS', 500, 'Replay result already exists');
      }
      socket.end(serializeCandidateResponse(response, config), () => server.close());
    } catch (error) {
      sendError(socket, error);
    }
  });
  server.on('error', () => {});

  await new Promise((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(config.socketPath, () => {
      server.off('error', rejectPromise);
      resolve();
    });
  });
  fs.chmodSync(config.socketPath, FILE_MODES.socket);
  const socketStat = fs.lstatSync(config.socketPath);
  if (socketStat.uid !== config.identity.rootUid || socketStat.gid !== config.identity.wwwDataGid) {
    fs.chownSync(config.socketPath, config.identity.rootUid, config.identity.wwwDataGid);
  }
  validateSocket(config);
  if (options.writePid !== false) {
    const identity = readLinuxProcessIdentity(process.pid);
    const pidEvidence = {
      schema_version: 1,
      source_digest: config.sourceDigest,
      run_digest: config.runDigest,
      pid: process.pid,
      boot_id_digest: identity.bootIdDigest,
      process_start_ticks: identity.processStartTicks,
      executable_digest: identity.executableDigest,
      script_digest: identity.scriptDigest
    };
    if (!processIdentityMatches(pidEvidence, identity, config)) {
      await new Promise((resolve) => server.close(resolve));
      reject('PROCESS_IDENTITY_MISMATCH', 500, 'Replay helper environment does not match its run');
    }
    if (!writeAtomicPrivate(config.pidPath, pidEvidence, config)) {
      await new Promise((resolve) => server.close(resolve));
      reject('PID_EVIDENCE_EXISTS', 500, 'Replay helper PID evidence already exists');
    }
  }
  return {
    server,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function verifyState(config) {
  const state = validateGateState(config);
  validateNginxBypass(config);
  const socketPresent = Boolean(validateSocket(config, { required: false }));
  return {
    ok: true,
    mode: 'verify-state',
    state,
    socket_present: socketPresent,
    source_digest: config.sourceDigest,
    run_digest: config.runDigest
  };
}

async function main({ argv = process.argv, environment = process.env } = {}) {
  try {
    if (argv.length !== 2) reject('ARGV_FORBIDDEN', 500, 'Replay helper accepts no argv configuration');
    const config = loadConfig(environment);
    if (config.mode === 'verify-state') {
      process.stdout.write(`${JSON.stringify(verifyState(config))}\n`);
      return;
    }
    if (config.mode === 'cleanup') {
      const report = cleanupGate(config);
      process.stdout.write(`${JSON.stringify({ ok: true, mode: 'cleanup', outcome: report.outcome })}\n`);
      return;
    }
    const runtime = await serveGate(config);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'serve', state: 'armed' })}\n`);
    await new Promise((resolve) => runtime.server.once('close', resolve));
  } catch (error) {
    const code = error instanceof GateError ? error.code : 'GATE_FAILURE';
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  }
}

function writeComplete(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset, null);
  }
}

function injectFault(fault, point) {
  if (!fault || fault.point !== point) return;
  if (typeof fault.action === 'function') fault.action(point);
  reject('INJECTED_CRASH', 500, 'Injected gate crash');
}

function claimReplay(config, request, fault = null) {
  const state = validateGateState(config);
  if (!state.startsWith('armed')) reject('ALREADY_CLAIMED', 409, 'Replay was already claimed');
  injectFault(fault, 'before-claim');

  const evidence = Object.freeze({
    schema_version: 1,
    source_digest: config.sourceDigest,
    run_digest: config.runDigest,
    request_digest: request.requestDigest,
    path_digest: request.pathDigest,
    body_digest: request.bodyDigest,
    expected_claim_digest: config.expectedClaimDigest
  });
  const bytes = Buffer.from(`${JSON.stringify(evidence)}\n`, 'utf8');
  writeAtomicPrivate(config.claimStagePath, evidence, config);
  const flags = fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  let descriptor;
  try {
    descriptor = fs.openSync(config.claimedPath, flags, FILE_MODES.privateFile);
    fs.fchmodSync(descriptor, FILE_MODES.privateFile);
    injectFault(fault, 'after-claim-open-before-write');
    if (fault && fault.point === 'during-claim-write') {
      const partialLength = Math.max(1, Math.floor(bytes.length / 2));
      writeComplete(descriptor, bytes.subarray(0, partialLength));
      injectFault(fault, 'during-claim-write');
    }
    writeComplete(descriptor, bytes);
    fs.fsyncSync(descriptor);
    injectFault(fault, 'after-claim-fsync');
  } catch (error) {
    if (error && error.code === 'EEXIST') reject('ALREADY_CLAIMED', 409, 'Replay was already claimed');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  validatePrivateFile(config.claimedPath, config);
  injectFault(fault, 'after-claim-before-unlink');
  validatePrivateFile(config.pendingPath, config);
  validatePrivateFile(config.claimedPath, config);
  fs.unlinkSync(config.pendingPath);
  fsyncDirectory(config.root);
  injectFault(fault, 'after-unlink-before-forward');
  safeUnlinkPrivate(config.claimStagePath, config);
  validateRoot(config);
  validatePrivateFile(config.claimedPath, config);
  return evidence;
}

module.exports = {
  ALLOWED_ENVIRONMENT,
  FILE_MODES,
  GateError,
  HOP_BY_HOP_HEADERS,
  claimReplay,
  cleanupGate,
  forwardToCandidate,
  loadConfig,
  main,
  parseReplayRequest,
  processIdentityMatches,
  serveGate,
  sha256,
  validateGateState,
  verifyState,
  writeAtomicPrivate
};

if (require.main === module) {
  void main();
}
