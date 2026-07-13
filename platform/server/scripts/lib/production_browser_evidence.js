'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class EvidenceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'EvidenceError';
    this.code = /^[A-Z0-9_]+$/.test(String(code || '')) ? code : 'UNEXPECTED_ERROR';
  }
}

function failureSummary(operation, error) {
  const safeOperation = String(operation || 'EVIDENCE').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const code = error instanceof EvidenceError ? error.code : 'UNEXPECTED_ERROR';
  return `PRODUCTION_${safeOperation}_FAILED=${code}`;
}

function cleanSecretValue(value) {
  const text = String(value || '').trim().replace(/^`|`$/g, '');
  if (!text || /^<.*>$/.test(text)) return '';
  return text;
}

function selectCredential(candidates, actorUsername = '') {
  const valid = candidates
    .map((candidate) => ({
      username: cleanSecretValue(candidate && (candidate.username || candidate.user || candidate.account)),
      password: cleanSecretValue(candidate && (candidate.password || candidate.temporary_password)),
      role: String(candidate && candidate.role || '').trim().toLowerCase()
    }))
    .filter((candidate) => candidate.username && candidate.password);
  if (!valid.length) throw new EvidenceError('CREDENTIAL_MANIFEST_INVALID', 'Credential manifest contains no usable account');
  const selected = valid.find((candidate) => actorUsername && candidate.username === actorUsername)
    || valid.find((candidate) => candidate.role === 'admin' || candidate.role === 'administrator')
    || valid[0];
  if (selected.username.length > 256 || selected.password.length > 4096) {
    throw new EvidenceError('CREDENTIAL_MANIFEST_INVALID', 'Credential fields exceed safe limits');
  }
  return { username: selected.username, password: selected.password };
}

function credentialsFromJson(value) {
  if (Array.isArray(value)) return selectCredential(value);
  if (!value || typeof value !== 'object') return null;
  if ((value.username || value.user || value.account) && (value.password || value.temporary_password)) {
    return selectCredential([value]);
  }
  for (const key of ['credentials', 'users', 'accounts']) {
    if (Array.isArray(value[key])) return selectCredential(value[key], value.actor_username);
  }
  if (Array.isArray(value.rotations)) return selectCredential(value.rotations, value.actor_username);
  return null;
}

function normalizedHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function parseMarkdownTable(text) {
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!/^\s*\|/.test(lines[index]) || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) continue;
    const headers = lines[index].split('|').slice(1, -1).map(normalizedHeader);
    const usernameIndex = headers.findIndex((header) => ['username', 'user', 'account', '用户名', '账号'].includes(header));
    const passwordIndex = headers.findIndex((header) => ['password', 'temporarypassword', '密码', '临时密码'].includes(header));
    const roleIndex = headers.findIndex((header) => ['role', '角色'].includes(header));
    if (usernameIndex < 0 || passwordIndex < 0) continue;
    const rows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length && /^\s*\|/.test(lines[rowIndex]); rowIndex += 1) {
      const cells = lines[rowIndex].split('|').slice(1, -1).map(cleanSecretValue);
      rows.push({
        username: cells[usernameIndex],
        password: cells[passwordIndex],
        role: roleIndex >= 0 ? cells[roleIndex] : ''
      });
    }
    if (rows.length) return selectCredential(rows);
  }
  return null;
}

function parseCredentialManifest(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  try {
    const parsed = credentialsFromJson(JSON.parse(source));
    if (parsed) return parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  for (const match of source.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    try {
      const parsed = credentialsFromJson(JSON.parse(match[1]));
      if (parsed) return parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  const tableCredential = parseMarkdownTable(source);
  if (tableCredential) return tableCredential;

  const username = source.match(/^\s*(?:[-*]\s*)?(?:username|user|account|用户名|账号)\s*[:：]\s*(.+?)\s*$/im);
  const password = source.match(/^\s*(?:[-*]\s*)?(?:password|temporary password|密码|临时密码)\s*[:：]\s*(.+?)\s*$/im);
  if (username && password) return selectCredential([{ username: username[1], password: password[1] }]);
  throw new EvidenceError('CREDENTIAL_MANIFEST_INVALID', 'Credential manifest format is unsupported');
}

function isInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function rejectLinksInExistingAncestors(targetPath, label) {
  let current = path.resolve(targetPath);
  const root = path.parse(current).root;
  while (true) {
    const stat = lstatIfPresent(current);
    if (stat && stat.isSymbolicLink()) {
      throw new EvidenceError('UNSAFE_PRIVATE_PATH', `${label} contains a symbolic link, junction, or reparse point`);
    }
    if (current === root) break;
    current = path.dirname(current);
  }
}

function requireAbsolutePath(value, label) {
  const text = String(value || '');
  if (!text || !path.isAbsolute(text)) throw new EvidenceError('INVALID_PRIVATE_PATH', `${label} must be absolute`);
  const resolved = path.resolve(text);
  rejectLinksInExistingAncestors(resolved, label);
  return resolved;
}

function validateCredentialManifestPath(value, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..', '..', '..', '..'));
  const manifestPath = requireAbsolutePath(value, 'credential manifest');
  if (isInside(repoRoot, manifestPath)) {
    throw new EvidenceError('INVALID_PRIVATE_PATH', 'Credential manifest must stay outside the repository');
  }
  const stat = lstatIfPresent(manifestPath);
  if (!stat || !stat.isFile()) throw new EvidenceError('INVALID_PRIVATE_PATH', 'Credential manifest must be a regular file');
  return manifestPath;
}

function validateStorageStatePath(value, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..', '..', '..', '..'));
  const allowedRoot = path.join(repoRoot, '.superpowers', 'sdd');
  const statePath = requireAbsolutePath(value, 'production storage state');
  if (!isInside(allowedRoot, statePath) || statePath === allowedRoot || path.extname(statePath).toLowerCase() !== '.json') {
    throw new EvidenceError('INVALID_STORAGE_STATE_PATH', 'Production storage state must be a JSON file under the ignored private test root');
  }
  return statePath;
}

function validateEvidenceDirectory(value, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..', '..', '..', '..'));
  const evidenceDir = requireAbsolutePath(value, 'production evidence directory');
  if (isInside(repoRoot, evidenceDir)) {
    throw new EvidenceError('INVALID_EVIDENCE_PATH', 'Production evidence directory must stay outside the repository');
  }
  return evidenceDir;
}

function ensureEvidenceDirectory(value, options = {}) {
  const evidenceDir = validateEvidenceDirectory(value, options);
  const parent = path.dirname(evidenceDir);
  const parentStat = lstatIfPresent(parent);
  if (!parentStat || !parentStat.isDirectory()) {
    throw new EvidenceError('INVALID_EVIDENCE_PATH', 'Production evidence parent directory must already exist');
  }
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  rejectLinksInExistingAncestors(evidenceDir, 'production evidence directory');
  try { fs.chmodSync(evidenceDir, 0o700); } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  return evidenceDir;
}

function assertSafeFileTarget(filePath, allowedRoot, label) {
  const root = path.resolve(allowedRoot);
  const target = path.resolve(filePath);
  if (!isInside(root, target) || target === root) throw new EvidenceError('UNSAFE_PRIVATE_PATH', `${label} escapes its private root`);
  rejectLinksInExistingAncestors(path.dirname(target), label);
  const stat = lstatIfPresent(target);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new EvidenceError('UNSAFE_PRIVATE_PATH', `${label} target is not a regular private file`);
  }
  return target;
}

function writePrivateBuffer(filePath, buffer, options = {}) {
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(filePath));
  const target = assertSafeFileTarget(filePath, allowedRoot, 'private output');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  rejectLinksInExistingAncestors(path.dirname(target), 'private output');
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, buffer, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
    try { fs.chmodSync(target, 0o600); } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}

function writePrivateJson(filePath, value, options = {}) {
  return writePrivateBuffer(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), options);
}

function writePrivateText(filePath, value, options = {}) {
  return writePrivateBuffer(filePath, Buffer.from(String(value), 'utf8'), options);
}

function removePrivateFile(filePath, options = {}) {
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(filePath));
  const target = assertSafeFileTarget(filePath, allowedRoot, 'private state');
  fs.rmSync(target, { force: true });
}

function validateProductionBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (_error) {
    throw new EvidenceError('INVALID_PRODUCTION_URL', 'Production base URL is invalid');
  }
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new EvidenceError('INVALID_PRODUCTION_URL', 'Production base URL must use HTTPS or a loopback tunnel');
  }
  if (url.username || url.password) throw new EvidenceError('INVALID_PRODUCTION_URL', 'Production base URL must not contain credentials');
  if (url.search) throw new EvidenceError('INVALID_PRODUCTION_URL', 'Production base URL must not contain a query');
  if (url.hash) throw new EvidenceError('INVALID_PRODUCTION_URL', 'Production base URL must not contain a fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw new EvidenceError('INVALID_PRODUCTION_URL', 'Production base URL must target the application root');
  url.pathname = '/';
  return url;
}

function routeTemplateForPath(pathname, templates) {
  const actual = String(pathname || '').split('/').filter(Boolean);
  for (const template of templates) {
    if (!String(template).startsWith('/api/') || String(template).includes('{*')) continue;
    const expected = String(template).split('/').filter(Boolean);
    if (actual.length !== expected.length) continue;
    const matches = expected.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
    if (matches) return `/${expected.map((segment) => segment.startsWith(':') ? ':id' : segment).join('/')}`;
  }
  return null;
}

function sanitizeRoutePath(pathname, templates = []) {
  if (pathname === '/') return '/';
  const matchedTemplate = routeTemplateForPath(pathname, templates);
  if (matchedTemplate) return matchedTemplate;
  return String(pathname || '').startsWith('/api/') ? '/api/:unmatched' : '/:asset';
}

function routeEvidence(method, requestUrl, status, expectedOrigin, templates = []) {
  const url = new URL(requestUrl);
  if (url.origin !== expectedOrigin) throw new EvidenceError('CROSS_ORIGIN_REQUEST', 'Production capture attempted a cross-origin request');
  const normalizedMethod = String(method || '').toUpperCase();
  if (!['GET', 'HEAD'].includes(normalizedMethod)) {
    throw new EvidenceError('NON_READ_REQUEST', 'Production capture attempted a non-read request');
  }
  return { method: normalizedMethod, path: sanitizeRoutePath(url.pathname, templates), status: Number(status) };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function storageStateFor(baseUrl, token, user) {
  return {
    cookies: [],
    origins: [{
      origin: baseUrl.origin,
      localStorage: [
        { name: 'tm_token', value: token },
        { name: 'tm_user', value: JSON.stringify(user) }
      ]
    }]
  };
}

function sessionFromStorageState(state, expectedOrigin) {
  const origin = state && Array.isArray(state.origins) && state.origins.find((entry) => entry.origin === expectedOrigin);
  const values = new Map(origin && Array.isArray(origin.localStorage) ? origin.localStorage.map((entry) => [entry.name, entry.value]) : []);
  const token = String(values.get('tm_token') || '');
  let user;
  try { user = JSON.parse(values.get('tm_user') || 'null'); } catch (_error) { user = null; }
  if (!token || !user) throw new EvidenceError('INVALID_STORAGE_STATE', 'Production storage state is missing a session');
  return { token, user };
}

async function destroySession(options) {
  const baseUrl = options.baseUrl;
  const token = options.token;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let logoutStatus = null;
  try {
    const response = await fetchImpl(new URL('/api/auth/logout', baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    logoutStatus = response.status;
  } catch (_error) {
    logoutStatus = null;
  }

  let verification;
  try {
    verification = await fetchImpl(new URL('/api/auth/me', baseUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (_error) {
    throw new EvidenceError('SESSION_VERIFICATION_FAILED', 'Could not verify production session destruction');
  }
  if (![401, 403].includes(verification.status)) {
    throw new EvidenceError('SESSION_NOT_REVOKED', 'Production session remains active after cleanup');
  }
  return { verified: true, logoutStatus, verificationStatus: verification.status };
}

async function withSessionCleanup(options) {
  let captureResult;
  let captureError;
  let cleanupResult;
  let cleanupError;
  try {
    captureResult = await options.capture();
  } catch (error) {
    captureError = error;
  }
  try {
    cleanupResult = await options.destroySession();
  } catch (error) {
    cleanupError = error;
  }
  try {
    removePrivateFile(options.statePath, { allowedRoot: options.allowedRoot || path.dirname(options.statePath) });
  } catch (error) {
    if (!cleanupError) cleanupError = error;
  }
  if (cleanupError) throw cleanupError;
  if (captureError) throw captureError;
  return { captureResult, cleanupResult };
}

module.exports = {
  EvidenceError,
  destroySession,
  ensureEvidenceDirectory,
  failureSummary,
  parseCredentialManifest,
  rejectLinksInExistingAncestors,
  removePrivateFile,
  routeEvidence,
  sanitizeRoutePath,
  sessionFromStorageState,
  sha256File,
  storageStateFor,
  validateCredentialManifestPath,
  validateEvidenceDirectory,
  validateProductionBaseUrl,
  validateStorageStatePath,
  withSessionCleanup,
  writePrivateBuffer,
  writePrivateJson,
  writePrivateText
};
