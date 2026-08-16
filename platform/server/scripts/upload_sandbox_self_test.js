#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_SELF_TESTS = Object.freeze([
  'identity',
  'mount_isolation',
  'syscall_denial',
  'network_denial',
  'socket_creation_denial',
  'host_log_socket_denial',
  'aio_socket_bypass_denial',
  'pid_namespace_sibling_fd_denial',
  'result_inode_metadata_denial',
  'write_escape_denial',
  'aggregate_memory_pressure',
  'aggregate_cpu_pressure',
  'aggregate_task_pressure',
  'scratch_pressure',
  'private_temp_write_denial',
  'dev_submount_write_denial',
  'writable_filesystem_inventory',
  'output_pressure',
  'xlsx_parsing',
  'pptx_parsing',
  'ocr_inference'
]);
const ALLOWED_WRITABLE_PATHS = Object.freeze(['/scratch', '/output/result.json']);
const DENIED_WRITE_PATHS = Object.freeze([
  '/dev',
  '/dev/hugepages',
  '/dev/mqueue',
  '/dev/pts',
  '/dev/shm',
  '/tmp',
  '/var/tmp'
]);
const HOST_LOG_SOCKET_PATHS = Object.freeze([
  '/dev/log',
  '/run/systemd/journal/dev-log',
  '/run/systemd/journal/socket',
  '/run/systemd/journal/stdout'
]);
const SOCKET_OPERATIONS = Object.freeze([
  'filesystem_af_unix_bind',
  'abstract_af_unix_connect',
  'journald_dev_log_send',
  'journald_native_send',
  'journald_stdout_send',
  'syslog_dev_log_send',
  'inet4_tcp_connect',
  'inet4_udp_connect',
  'inet6_tcp_connect'
]);
const AIO_OPERATIONS = Object.freeze([
  'io_uring_setup_socket_path',
  'io_uring_enter_socket_path',
  'io_uring_register_socket_path'
]);
const PID_OPERATIONS = Object.freeze([
  'peer_proc_visibility',
  'peer_fd_directory_visibility',
  'peer_fd_read_open',
  'peer_fd_write_open'
]);
const SOCKET_DENIAL_ERRNOS = Object.freeze([
  'EPERM',
  'EACCES',
  'EAFNOSUPPORT',
  'EPROTONOSUPPORT'
]);
const PID_DENIAL_ERRNOS = Object.freeze(['ENOENT', 'ESRCH']);
const PRESSURE_ERRNOS = Object.freeze(['EFBIG', 'ENOSPC', 'EDQUOT', 'SIGXFSZ']);
const SAFE_ENVIRONMENT = Object.freeze({
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8'
});
const SERVICE_UNIT = 'turingmarket-parser@.service';
const SLICE_UNIT = 'turingmarket-parser.slice';
const SPOOL_ROOT = '/var/lib/turingmarket-parser/jobs';
const PARSER_RUNTIME_ROOT = '/var/lib/turingmarket-parser/runtime-root';
const PARSER_RUNTIME_APP_ROOT = `${PARSER_RUNTIME_ROOT}/opt/turingmarket-parser/app`;
const PARSER_RUNTIME_TREE_FORMAT = 'tm-parser-runtime-tree-v1';
const RAW_OBSERVATIONS_FORMAT = 'tm-parser-self-test-observations-v1';
const RESULT_TIMESTAMP_TOLERANCE_MS = 2_000;
const HEX_64 = /^[0-9a-f]{64}$/;
const UNIT_NAME = /^turingmarket-parser@([0-9a-f]{32})\.service$/;
const SANDBOX_LIMITS = Object.freeze({ outputBytes: 10 * 1024 * 1024 });
const TRUSTED_UPLOAD_ROUTES = Object.freeze([
  Object.freeze({ id: 'parser.knowledge-upload' }),
  Object.freeze({ id: 'parser.demand-parse' })
]);
const PARSER_OUTPUT_MANIFEST_BYTES = Buffer.from(JSON.stringify({
  version: 2,
  files: [{
    path: 'result.json',
    mime: 'application/json',
    max_bytes: SANDBOX_LIMITS.outputBytes
  }],
  total_writable_bytes: SANDBOX_LIMITS.outputBytes
}), 'utf8');
const INSTALLED_UNIT_ARTIFACTS = Object.freeze({
  'systemd/turingmarket-parser@.service': '/etc/systemd/system/turingmarket-parser@.service',
  'systemd/turingmarket-parser.slice': '/etc/systemd/system/turingmarket-parser.slice'
});
const RUNTIME_SOURCE_ARTIFACTS = Object.freeze({
  'parser-runtime/package.json': `${PARSER_RUNTIME_APP_ROOT}/package.json`,
  'parser-runtime/package-lock.json': `${PARSER_RUNTIME_APP_ROOT}/package-lock.json`,
  'parser-runtime/requirements.lock': `${PARSER_RUNTIME_APP_ROOT}/parser-runtime/requirements.lock`,
  'extract_document_text.py': `${PARSER_RUNTIME_APP_ROOT}/extract_document_text.py`,
  'extract_xlsx_text.py': `${PARSER_RUNTIME_APP_ROOT}/extract_xlsx_text.py`,
  'ocr_document_text.py': `${PARSER_RUNTIME_APP_ROOT}/ocr_document_text.py`,
  'services/file_ingest_service.js': `${PARSER_RUNTIME_APP_ROOT}/services/file_ingest_service.js`,
  'services/upload_sandbox_service.js': `${PARSER_RUNTIME_APP_ROOT}/services/upload_sandbox_service.js`,
  'scripts/parse_upload_sandbox.sh': `${PARSER_RUNTIME_ROOT}/usr/local/libexec/turingmarket/parse_upload_sandbox.sh`
});
const RESULT_METADATA_PROBE_SOURCE = [
  'import json, os, stat, sys',
  'flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)',
  'fd = os.open(sys.argv[1], flags)',
  'try:',
  '    value = os.fstat(fd)',
  '    result = {',
  '        "isRegular": stat.S_ISREG(value.st_mode),',
  '        "dev": value.st_dev,',
  '        "ino": value.st_ino,',
  '        "uid": value.st_uid,',
  '        "gid": value.st_gid,',
  '        "mode": stat.S_IMODE(value.st_mode),',
  '        "nlink": value.st_nlink,',
  '        "size": value.st_size,',
  '        "mtimeMs": value.st_mtime_ns // 1000000,',
  '        "ctimeMs": value.st_ctime_ns // 1000000,',
  '        "xattrs": sorted(os.listxattr(fd))',
  '    }',
  '    print(json.dumps(result, separators=(",", ":")))',
  'finally:',
  '    os.close(fd)'
].join('\n');
const PARSER_ACCEPTANCE_SPECS = Object.freeze([
  Object.freeze({
    format: 'xlsx',
    filename: 'parser-self-test.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parser: 'xlsx-openxml',
    marker: 'TM_XLSX_MARKER_604'
  }),
  Object.freeze({
    format: 'pptx',
    filename: 'parser-self-test.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    parser: 'pptx-openxml',
    marker: 'TM_PPTX_MARKER_604'
  }),
  Object.freeze({
    format: 'bmp',
    filename: 'parser-self-test.bmp',
    mime: 'image/bmp',
    parser: 'local-rapidocr',
    marker: 'OCR 123'
  })
]);
const REPRESENTATIVE_SYSCALL_DENIALS = Object.freeze([
  Object.freeze({ operation: 'filesystem_af_unix_bind', token: 'socket' }),
  Object.freeze({ operation: 'inet4_tcp_connect', token: 'connect' }),
  Object.freeze({ operation: 'io_uring_setup_socket_path', token: 'io_uring_setup' })
]);

function diagnosticRunCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env || SAFE_ENVIRONMENT
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs || 30_000);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes <= 65_536) target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal || bytes > 65_536) {
        const error = new Error('diagnostic child command failed');
        error.capturedStderr = Buffer.concat(stderr).toString('utf8');
        error.exitCode = code;
        error.signal = signal;
        reject(error);
        return;
      }
      resolve({ stdout: options.captureStdout === true ? Buffer.concat(stdout).toString('utf8') : '' });
    });
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

function sameArray(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function sameRecord(value, expected) {
  if (!exactKeys(value, Object.keys(expected))) return false;
  return Object.keys(expected).every((key) => value[key] === expected[key]);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [entryName, entryText] of entries) {
    const name = Buffer.from(entryName, 'utf8');
    const data = Buffer.from(entryText, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100444 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

function minimalXlsx(marker) {
  return storedZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Acceptance" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${marker}</t></is></c></row></sheetData></worksheet>`]
  ]);
}

function minimalPptx(marker) {
  return storedZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'],
    ['ppt/presentation.xml', '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'],
    ['ppt/_rels/presentation.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'],
    ['ppt/slides/slide1.xml', `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${marker}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`]
  ]);
}

function textBmp(text) {
  const glyphs = {
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110']
  };
  const scale = 12;
  const padding = 30;
  const glyphWidth = 6 * scale;
  const width = padding * 2 + text.length * glyphWidth - scale;
  const height = padding * 2 + 7 * scale;
  const stride = Math.ceil((width * 3) / 4) * 4;
  const bitmap = Buffer.alloc(54 + stride * height, 0xff);
  bitmap.write('BM', 0, 2, 'ascii');
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(stride * height, 34);
  for (let glyphIndex = 0; glyphIndex < text.length; glyphIndex += 1) {
    const glyph = glyphs[text[glyphIndex]];
    if (!glyph) throw new Error('unsupported OCR fixture glyph');
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = padding + glyphIndex * glyphWidth + column * scale + dx;
            const y = padding + row * scale + dy;
            const offset = 54 + (height - 1 - y) * stride + x * 3;
            bitmap.fill(0, offset, offset + 3);
          }
        }
      }
    }
  }
  return bitmap;
}

function createParserAcceptanceFixtures() {
  return Object.freeze(PARSER_ACCEPTANCE_SPECS.map((spec) => Object.freeze({
    ...spec,
    buffer: spec.format === 'xlsx'
      ? minimalXlsx(spec.marker)
      : spec.format === 'pptx'
        ? minimalPptx(spec.marker)
        : textBmp(spec.marker)
  })));
}

function parseDeclaredSyscallDenyTokens(filter) {
  if (typeof filter !== 'string' || filter.length > 16_384) return null;
  const tokens = filter.trim().split(/\s+/).filter(Boolean);
  const inverted = tokens.findIndex((token) => token.startsWith('~'));
  if (inverted < 1 || tokens[0] !== '@system-service') return null;
  const deny = tokens.slice(inverted).map((token, index) => (
    index === 0 ? token.slice(1) : token
  ));
  if (
    deny.some((token) => !/^(?:@[a-z0-9-]+|[a-z0-9_]+)$/.test(token)) ||
    new Set(deny).size !== deny.length
  ) return null;
  return Object.freeze(deny);
}

function validateParserAcceptanceEvidence(value) {
  return Array.isArray(value) && value.length === PARSER_ACCEPTANCE_SPECS.length &&
    value.every((item, index) => {
      const expected = PARSER_ACCEPTANCE_SPECS[index];
      return exactKeys(item, [
        'format', 'filename', 'mime', 'parser', 'marker', 'marker_found', 'ocr_used'
      ]) &&
        item.format === expected.format && item.filename === expected.filename &&
        item.mime === expected.mime && item.parser === expected.parser &&
        item.marker === expected.marker && item.marker_found === true &&
        item.ocr_used === (expected.format === 'bmp');
    });
}

function validateSyscallPolicyEvidence(value) {
  if (!exactKeys(value, [
    'contract', 'declared_deny_tokens', 'verified_deny_tokens', 'representative_denials'
  ]) || value.contract !== 'tm-parser-syscall-deny-v1' ||
    !Array.isArray(value.declared_deny_tokens) || value.declared_deny_tokens.length < 1 ||
    !sameArray(value.verified_deny_tokens, value.declared_deny_tokens) ||
    !Array.isArray(value.representative_denials) ||
    value.representative_denials.length !== REPRESENTATIVE_SYSCALL_DENIALS.length
  ) return false;
  return value.representative_denials.every((item, index) => (
    exactKeys(item, ['operation', 'token', 'errno']) &&
    item.operation === REPRESENTATIVE_SYSCALL_DENIALS[index].operation &&
    item.token === REPRESENTATIVE_SYSCALL_DENIALS[index].token &&
    value.declared_deny_tokens.includes(item.token) &&
    SOCKET_DENIAL_ERRNOS.includes(item.errno)
  ));
}

function validateIdentityEvidence(identity, expected) {
  if (
    !exactKeys(identity, [
      'user',
      'group',
      'home',
      'shell',
      'locked',
      'supplementary_groups',
      'uid',
      'gid'
    ]) ||
    !exactKeys(expected, [
      'user',
      'group',
      'home',
      'shell',
      'locked',
      'supplementary_groups'
    ]) ||
    !Number.isSafeInteger(identity.uid) || identity.uid <= 0 ||
    !Number.isSafeInteger(identity.gid) || identity.gid <= 0
  ) {
    return false;
  }
  return Object.keys(expected).every((key) => (
    key === 'supplementary_groups'
      ? sameArray(identity[key], expected[key])
      : identity[key] === expected[key]
  ));
}

function validateOperationEvidence(value, operations, allowedErrnos) {
  return Array.isArray(value) &&
    value.length === operations.length &&
    value.every((item, index) => (
      exactKeys(item, ['operation', 'errno']) &&
      item.operation === operations[index] &&
      allowedErrnos.includes(item.errno)
    ));
}

function validateWritableEvidence(value) {
  const keys = [
    'version',
    'contract',
    'socket_contract',
    'mount_info_sha256',
    'allowed_writable_paths',
    'denied_write_paths',
    'unexpected_writable_paths',
    'audited_rw_mounts',
    'host_log_socket_paths',
    'present_host_log_socket_paths',
    'host_log_socket_mounts',
    'socket_denial_evidence',
    'aio_denial_evidence',
    'pid_namespace'
  ];
  return exactKeys(value, keys) &&
    value.version === 1 &&
    value.contract === 'tm-parser-writable-filesystem-v1' &&
    value.socket_contract === 'tm-parser-no-sockets-v1' &&
    typeof value.mount_info_sha256 === 'string' &&
    HEX_64.test(value.mount_info_sha256) &&
    sameArray(value.allowed_writable_paths, ALLOWED_WRITABLE_PATHS) &&
    sameArray(value.denied_write_paths, DENIED_WRITE_PATHS) &&
    sameArray(value.unexpected_writable_paths, []) &&
    Number.isSafeInteger(value.audited_rw_mounts) &&
    value.audited_rw_mounts >= ALLOWED_WRITABLE_PATHS.length &&
    sameArray(value.host_log_socket_paths, HOST_LOG_SOCKET_PATHS) &&
    sameArray(value.present_host_log_socket_paths, []) &&
    sameArray(value.host_log_socket_mounts, []) &&
    validateOperationEvidence(
      value.socket_denial_evidence,
      SOCKET_OPERATIONS,
      SOCKET_DENIAL_ERRNOS
    ) &&
    validateOperationEvidence(value.aio_denial_evidence, AIO_OPERATIONS, ['EPERM']) &&
    exactKeys(value.pid_namespace, ['contract', 'self_pid', 'visible_pids']) &&
    value.pid_namespace.contract === 'tm-parser-private-pids-v1' &&
    value.pid_namespace.self_pid === 1 &&
    sameArray(value.pid_namespace.visible_pids, [1]);
}

function validCgroupPath(value) {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    value.length > 1 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    !value.split('/').includes('..') &&
    path.posix.normalize(value) === value;
}

function validateMembership(value, sliceControlGroup) {
  if (
    !exactKeys(value, [
      'unit_name',
      'main_pid',
      'slice',
      'control_group',
      'proc_control_group',
      'cgroup_exists',
      'cgroup_procs',
      'host_pid_changed'
    ]) ||
    !UNIT_NAME.test(value.unit_name) ||
    !Number.isSafeInteger(value.main_pid) || value.main_pid <= 1 ||
    value.slice !== SLICE_UNIT ||
    !validCgroupPath(sliceControlGroup) ||
    !validCgroupPath(value.control_group) ||
    value.control_group === sliceControlGroup ||
    !value.control_group.startsWith(`${sliceControlGroup}/`) ||
    value.proc_control_group !== value.control_group ||
    value.cgroup_exists !== true ||
    typeof value.host_pid_changed !== 'boolean' ||
    !Array.isArray(value.cgroup_procs) ||
    !value.cgroup_procs.every((pid) => Number.isSafeInteger(pid) && pid > 1)
  ) {
    return false;
  }
  return value.cgroup_procs.includes(value.main_pid);
}

function validateAggregateEvidence(value) {
  if (
    !exactKeys(value, [
      'slice_properties_verified',
      'slice_control_group',
      'memberships'
    ]) ||
    value.slice_properties_verified !== true ||
    !Array.isArray(value.memberships) ||
    value.memberships.length !== 2 ||
    !value.memberships.every((item) => validateMembership(item, value.slice_control_group))
  ) {
    return false;
  }
  const unitNames = new Set(value.memberships.map((item) => item.unit_name));
  const pids = new Set(value.memberships.map((item) => item.main_pid));
  const cgroups = new Set(value.memberships.map((item) => item.control_group));
  return unitNames.size === 2 && pids.size === 2 && cgroups.size === 2;
}

function validatePidProof(value, expectedPeerPid) {
  return exactKeys(value, [
    'contract',
    'peer_pid',
    'self_pid',
    'visible_pids',
    'evidence'
  ]) &&
    value.contract === 'tm-parser-sibling-proc-fd-denial-v1' &&
    value.peer_pid === expectedPeerPid &&
    value.self_pid === 1 &&
    sameArray(value.visible_pids, [1]) &&
    validateOperationEvidence(value.evidence, PID_OPERATIONS, PID_DENIAL_ERRNOS);
}

function validatePidEvidence(proofs, memberships) {
  return Array.isArray(proofs) && proofs.length === 2 &&
    Array.isArray(memberships) && memberships.length === 2 &&
    validatePidProof(proofs[0], proofs[0].peer_pid) &&
    validatePidProof(proofs[1], proofs[1].peer_pid) &&
    proofs[0].peer_pid !== memberships[0].main_pid &&
    proofs[1].peer_pid !== memberships[1].main_pid &&
    (
      memberships[0].host_pid_changed ||
      proofs[0].peer_pid === memberships[1].main_pid
    ) &&
    (
      memberships[1].host_pid_changed ||
      proofs[1].peer_pid === memberships[0].main_pid
    );
}

function validatePressureEvidence(value, expectedContract) {
  return exactKeys(value, [
    'contract',
    'denied',
    'errno',
    'limit_bytes',
    'attempted_bytes'
  ]) &&
    value.contract === expectedContract &&
    value.denied === true &&
    PRESSURE_ERRNOS.includes(value.errno) &&
    Number.isSafeInteger(value.limit_bytes) && value.limit_bytes > 0 &&
    Number.isSafeInteger(value.attempted_bytes) &&
    value.attempted_bytes > value.limit_bytes;
}

function validateResultMetadataEvidence(value, expected) {
  if (
    !exactKeys(value, [
      'isRegular',
      'dev',
      'ino',
      'uid',
      'gid',
      'mode',
      'nlink',
      'size',
      'mtimeMs',
      'ctimeMs',
      'xattrs'
    ]) ||
    !exactKeys(expected, [
      'dev',
      'ino',
      'uid',
      'gid',
      'lifecycle_started_ms',
      'observed_at_ms',
      'max_bytes'
    ]) ||
    value.isRegular !== true ||
    value.dev !== expected.dev ||
    value.ino !== expected.ino ||
    value.uid !== expected.uid ||
    value.gid !== expected.gid ||
    value.mode !== 0o600 ||
    value.nlink !== 1 ||
    !Number.isSafeInteger(value.size) || value.size < 1 ||
    !Number.isSafeInteger(expected.max_bytes) ||
    value.size > expected.max_bytes ||
    !Array.isArray(value.xattrs) || value.xattrs.length !== 0 ||
    !Number.isFinite(value.mtimeMs) || !Number.isFinite(value.ctimeMs) ||
    !Number.isFinite(expected.lifecycle_started_ms) ||
    !Number.isFinite(expected.observed_at_ms)
  ) {
    return false;
  }
  const earliest = expected.lifecycle_started_ms - RESULT_TIMESTAMP_TOLERANCE_MS;
  const latest = expected.observed_at_ms + RESULT_TIMESTAMP_TOLERANCE_MS;
  return value.mtimeMs >= earliest && value.mtimeMs <= latest &&
    value.ctimeMs >= earliest && value.ctimeMs <= latest;
}

function composeSelfTestResult(evidence) {
  const foundation = isRecord(evidence) &&
    evidence.manifest_verified === true &&
    evidence.installed_runtime_verified === true &&
    evidence.systemd_service_verified === true &&
    evidence.systemd_slice_verified === true &&
    validateIdentityEvidence(evidence.identity, evidence.expected_identity);
  const writable = foundation && validateWritableEvidence(evidence.writable);
  const aggregate = foundation && validateAggregateEvidence(evidence.aggregate);
  const pid = aggregate && validatePidEvidence(
    evidence.pid_proofs,
    evidence.aggregate.memberships
  );
  const metadata = foundation &&
    Array.isArray(evidence.result_metadata_checks) &&
    evidence.result_metadata_checks.length === 5 &&
    evidence.result_metadata_checks.every((item) => item === true);
  const scratch = foundation && isRecord(evidence.pressure) &&
    validatePressureEvidence(evidence.pressure.scratch, 'scratch-pressure-v1');
  const output = foundation && isRecord(evidence.pressure) &&
    validatePressureEvidence(evidence.pressure.output, 'output-pressure-v1');
  const parserAcceptance = foundation &&
    validateParserAcceptanceEvidence(evidence.parser_acceptance);
  const syscallPolicy = foundation &&
    validateSyscallPolicyEvidence(evidence.syscall_policy);
  return Object.freeze({
    identity: foundation,
    mount_isolation: writable,
    syscall_denial: writable && syscallPolicy,
    network_denial: writable,
    socket_creation_denial: writable,
    host_log_socket_denial: writable,
    aio_socket_bypass_denial: writable,
    pid_namespace_sibling_fd_denial: pid,
    result_inode_metadata_denial: metadata,
    write_escape_denial: writable,
    aggregate_memory_pressure: aggregate,
    aggregate_cpu_pressure: aggregate,
    aggregate_task_pressure: aggregate,
    scratch_pressure: scratch,
    private_temp_write_denial: writable,
    dev_submount_write_denial: writable,
    writable_filesystem_inventory: writable,
    output_pressure: output,
    xlsx_parsing: parserAcceptance,
    pptx_parsing: parserAcceptance,
    ocr_inference: parserAcceptance
  });
}

function assertCompleteSelfTestResult(value) {
  if (
    !exactKeys(value, REQUIRED_SELF_TESTS) ||
    !REQUIRED_SELF_TESTS.every((name) => value[name] === true)
  ) {
    throw new Error('upload sandbox self-test evidence is incomplete');
  }
  return value;
}

function assertRootlessRuntimeTree(value) {
  if (
    !exactKeys(value, ['format', 'sha256', 'files', 'directories', 'bytes']) ||
    value.format !== 'tm-parser-runtime-tree-v1' ||
    !HEX_64.test(value.sha256) ||
    !Number.isSafeInteger(value.files) || value.files < 1 ||
    !Number.isSafeInteger(value.directories) || value.directories < 1 ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1
  ) {
    throw new Error('invalid rootless runtime tree observation');
  }
}

function assertEffectiveProperties(value) {
  if (!exactKeys(value, [SERVICE_UNIT, SLICE_UNIT])) {
    throw new Error('invalid effective properties observation');
  }
  for (const properties of Object.values(value)) {
    if (
      !isRecord(properties) || Object.keys(properties).length < 1 ||
      Object.entries(properties).some(([key, property]) => (
        typeof key !== 'string' || !key || typeof property !== 'string'
      ))
    ) {
      throw new Error('invalid effective properties observation');
    }
  }
}

function composeRawSelfTestObservations({
  manifestSha256,
  runtimeTree,
  effectiveProperties,
  evidence
} = {}) {
  if (!HEX_64.test(manifestSha256 || '')) {
    throw new Error('invalid manifest SHA-256 observation');
  }
  assertRootlessRuntimeTree(runtimeTree);
  assertEffectiveProperties(effectiveProperties);
  if (!validateParserAcceptanceEvidence(evidence && evidence.parser_acceptance)) {
    throw new Error('invalid parser acceptance observation');
  }
  const selfTests = assertCompleteSelfTestResult(composeSelfTestResult(evidence));
  const parserAcceptance = evidence.parser_acceptance.map((item) => Object.freeze({
    format: item.format,
    parser: item.parser,
    marker: item.marker,
    marker_found: item.marker_found,
    ocr_used: item.ocr_used
  }));
  return Object.freeze({
    format: RAW_OBSERVATIONS_FORMAT,
    manifest_sha256: manifestSha256,
    runtime_tree: Object.freeze({ ...runtimeTree }),
    effective_properties: Object.freeze(Object.fromEntries(
      Object.entries(effectiveProperties).map(([unit, properties]) => [
        unit,
        Object.freeze({ ...properties })
      ])
    )),
    parser_acceptance: Object.freeze(parserAcceptance),
    self_tests: selfTests
  });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([size, bytes]);
}

function assertStableStat(before, after, label) {
  for (const key of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeMs', 'ctimeMs']) {
    if (before[key] !== after[key]) throw new Error(`${label} changed during observation`);
  }
}

function readTrustedFile(target, maxBytes = 16 * 1024 * 1024) {
  const before = fs.lstatSync(target);
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes ||
      stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0
    ) {
      throw new Error('trusted parser file metadata is unsafe');
    }
    assertStableStat(before, stat, 'trusted parser file');
    const bytes = fs.readFileSync(descriptor);
    assertStableStat(stat, fs.fstatSync(descriptor), 'trusted parser file');
    assertStableStat(stat, fs.lstatSync(target), 'trusted parser file');
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateSelfTestManifest(manifest) {
  if (
    !exactKeys(manifest, [
      'version', 'build', 'minimum_systemd_version', 'identity',
      'route_registry_sha256', 'artifacts', 'runtime_tree',
      'effective_properties', 'required_self_tests'
    ]) ||
    manifest.version !== 3 ||
    !isRecord(manifest.identity) ||
    !exactKeys(manifest.identity, [
      'user', 'group', 'home', 'shell', 'locked', 'supplementary_groups'
    ]) ||
    manifest.identity.user !== 'turingmarket-parser' ||
    manifest.identity.group !== 'turingmarket-parser' ||
    manifest.identity.home !== '/nonexistent' ||
    manifest.identity.shell !== '/usr/sbin/nologin' ||
    manifest.identity.locked !== true ||
    !sameArray(manifest.identity.supplementary_groups, []) ||
    !isRecord(manifest.artifacts) || Object.keys(manifest.artifacts).length < 1 ||
    Object.entries(manifest.artifacts).some(([name, digest]) => (
      !/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('/') ||
      name.split('/').includes('..') || !HEX_64.test(digest)
    )) ||
    !exactKeys(manifest.runtime_tree, [
      'format', 'root', 'sha256', 'files', 'directories', 'bytes'
    ]) ||
    manifest.runtime_tree.format !== PARSER_RUNTIME_TREE_FORMAT ||
    manifest.runtime_tree.root !== PARSER_RUNTIME_ROOT ||
    !HEX_64.test(manifest.runtime_tree.sha256) ||
    !Number.isSafeInteger(manifest.runtime_tree.files) || manifest.runtime_tree.files < 1 ||
    !Number.isSafeInteger(manifest.runtime_tree.directories) ||
      manifest.runtime_tree.directories < 1 ||
    !Number.isSafeInteger(manifest.runtime_tree.bytes) || manifest.runtime_tree.bytes < 1 ||
    !isRecord(manifest.effective_properties) ||
    !exactKeys(manifest.effective_properties, [SERVICE_UNIT, SLICE_UNIT]) ||
    Object.values(manifest.effective_properties).some((properties) => (
      !isRecord(properties) || Object.keys(properties).length < 1 ||
      Object.values(properties).some((value) => typeof value !== 'string')
    )) ||
    !sameArray(manifest.required_self_tests, REQUIRED_SELF_TESTS)
  ) {
    throw new Error('parser runtime manifest is invalid');
  }
  return manifest;
}

function loadTrustedSelfTestManifest({ manifestPath, serverRoot } = {}) {
  if (
    typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath) ||
    path.resolve(serverRoot || '') !== PARSER_RUNTIME_APP_ROOT
  ) {
    throw new Error('trusted parser manifest location is invalid');
  }
  const bytes = readTrustedFile(path.resolve(manifestPath), 1024 * 1024);
  let manifest;
  try {
    manifest = validateSelfTestManifest(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (/manifest/.test(error.message)) throw error;
    throw new Error('parser runtime manifest is invalid');
  }
  return Object.freeze({
    manifest,
    manifestSha256: sha256(bytes),
    manifestPath: path.resolve(manifestPath),
    serverRoot: PARSER_RUNTIME_APP_ROOT
  });
}

function runtimeSourceArtifactPath(relativePath) {
  const target = RUNTIME_SOURCE_ARTIFACTS[relativePath];
  if (!target) throw new Error('parser source artifact is not a runtime payload');
  return target;
}

function verifyTrustedSourceArtifacts(manifest) {
  for (const relativePath of Object.keys(RUNTIME_SOURCE_ARTIFACTS)) {
    const expected = manifest.artifacts[relativePath];
    if (!HEX_64.test(expected || '')) throw new Error('parser source artifact is missing');
    const target = runtimeSourceArtifactPath(relativePath);
    if (sha256(readTrustedFile(target, 1024 * 1024 * 1024)) !== expected) {
      throw new Error('parser source artifact drift');
    }
  }
  return true;
}

function verifyTrustedInstalledArtifacts(manifest) {
  for (const [relativePath, target] of Object.entries(INSTALLED_UNIT_ARTIFACTS)) {
    if (manifest.artifacts[relativePath] !== sha256(readTrustedFile(target, 1024 * 1024))) {
      throw new Error('installed parser artifact drift');
    }
  }
  return true;
}

function formatMode(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, '0');
}

function assertRuntimeEntry(stat, rootDevice, directory) {
  if (
    stat.isSymbolicLink() || stat.dev !== rootDevice || stat.uid !== 0 || stat.gid !== 0 ||
    (stat.mode & 0o022) !== 0 ||
    directory && !stat.isDirectory() ||
    !directory && (!stat.isFile() || stat.nlink !== 1)
  ) {
    throw new Error('parser runtime tree contains an unsafe entry');
  }
}

function measureTrustedRuntimeTree(runtimeRoot) {
  const resolvedRoot = path.resolve(runtimeRoot);
  if (resolvedRoot !== PARSER_RUNTIME_ROOT) throw new Error('parser runtime root mismatch');
  const rootStat = fs.lstatSync(resolvedRoot);
  assertRuntimeEntry(rootStat, rootStat.dev, true);
  const digest = crypto.createHash('sha256');
  let files = 0;
  let directories = 1;
  let bytes = 0;
  digest.update(frame(PARSER_RUNTIME_TREE_FORMAT));
  digest.update(frame('directory'));
  digest.update(frame(''));
  digest.update(frame(formatMode(rootStat)));

  function visit(absoluteRoot, relativeRoot, directoryStat) {
    const entries = fs.readdirSync(absoluteRoot, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(
      Buffer.from(left.name, 'utf8'),
      Buffer.from(right.name, 'utf8')
    ));
    for (const entry of entries) {
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const target = path.join(absoluteRoot, entry.name);
      const before = fs.lstatSync(target);
      if (before.isDirectory()) {
        assertRuntimeEntry(before, rootStat.dev, true);
        directories += 1;
        digest.update(frame('directory'));
        digest.update(frame(relativePath));
        digest.update(frame(formatMode(before)));
        visit(target, relativePath, before);
      } else {
        assertRuntimeEntry(before, rootStat.dev, false);
        const descriptor = fs.openSync(
          target,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        );
        try {
          const opened = fs.fstatSync(descriptor);
          assertStableStat(before, opened, 'parser runtime file');
          const fileDigest = crypto.createHash('sha256');
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          let position = 0;
          while (position < opened.size) {
            const count = fs.readSync(
              descriptor,
              buffer,
              0,
              Math.min(buffer.length, opened.size - position),
              position
            );
            if (count < 1) throw new Error('parser runtime file read was incomplete');
            fileDigest.update(buffer.subarray(0, count));
            position += count;
          }
          assertStableStat(opened, fs.fstatSync(descriptor), 'parser runtime file');
          assertStableStat(opened, fs.lstatSync(target), 'parser runtime file');
          files += 1;
          bytes += opened.size;
          digest.update(frame('file'));
          digest.update(frame(relativePath));
          digest.update(frame(formatMode(opened)));
          digest.update(frame(String(opened.size)));
          digest.update(frame(fileDigest.digest('hex')));
        } finally {
          fs.closeSync(descriptor);
        }
      }
      if (files + directories > 100_000 || !Number.isSafeInteger(bytes)) {
        throw new Error('parser runtime tree exceeded observation bounds');
      }
    }
    assertStableStat(directoryStat, fs.lstatSync(absoluteRoot), 'parser runtime directory');
  }

  visit(resolvedRoot, '', rootStat);
  return Object.freeze({
    format: PARSER_RUNTIME_TREE_FORMAT,
    sha256: digest.digest('hex'),
    files,
    directories,
    bytes
  });
}

function verifyTrustedRuntimeTree(root, expected) {
  const observed = measureTrustedRuntimeTree(root);
  const projection = {
    format: expected.format,
    sha256: expected.sha256,
    files: expected.files,
    directories: expected.directories,
    bytes: expected.bytes
  };
  if (!sameRecord(observed, projection)) throw new Error('parser runtime tree drift');
  return observed;
}

function systemdInspectionUnitName(unitName) {
  return unitName === SERVICE_UNIT
    ? 'turingmarket-parser@test_instance.service'
    : unitName;
}

function systemdExpandedPath(value, expected, unitName) {
  if (unitName !== SERVICE_UNIT || typeof value !== 'string') return false;
  return value === expected
    .replaceAll('%i', 'test_instance')
    .split(' ')
    .map((entry) => `${entry}:rbind`)
    .join(' ');
}

function normalizeSystemCallFilter(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const allowed = new Set(value.split(/\s+/).filter(Boolean));
  const expectedTokens = expected.split(/\s+/).filter(Boolean);
  const denyIndex = expectedTokens.indexOf('~@mount');
  if (denyIndex < 0 || expectedTokens[0] !== '@system-service') return false;
  const explicitDenials = expectedTokens.slice(denyIndex + 1)
    .filter((token) => !token.startsWith('@'));
  return !explicitDenials.some((token) => allowed.has(token)) &&
    ['read', 'write', 'close', 'execve', 'exit', 'exit_group', 'shutdown', 'socketpair']
      .every((token) => allowed.has(token));
}

function normalizeSystemdProperties(unitName, observed, expected) {
  if (!exactKeys(observed, Object.keys(expected))) {
    throw new Error('parser effective property evidence is incomplete');
  }
  const normalized = { ...observed };
  const expansions = {
    IPAddressDeny: (value, wanted) => wanted === 'any' && value === '0.0.0.0/0 ::/0',
    RestrictAddressFamilies: (value, wanted) => wanted === 'none' && value === '',
    SystemCallFilter: normalizeSystemCallFilter,
    SystemCallErrorNumber: (value, wanted) => wanted === 'EPERM' && value === '1',
    BindReadOnlyPaths: (value, wanted) => systemdExpandedPath(value, wanted, unitName),
    BindPaths: (value, wanted) => systemdExpandedPath(value, wanted, unitName)
  };
  for (const [property, wanted] of Object.entries(expected)) {
    if (normalized[property] === wanted) continue;
    if (expansions[property] && expansions[property](normalized[property], wanted)) {
      normalized[property] = wanted;
      continue;
    }
    throw new Error('parser effective property drift');
  }
  return Object.freeze(normalized);
}

async function readTrustedSystemdProperties(runCommand, unitName, expected) {
  const names = Object.keys(expected);
  const output = await captureCommand(runCommand, '/usr/bin/systemctl', [
    'show',
    systemdInspectionUnitName(unitName),
    '--no-pager',
    `--property=${names.join(',')}`
  ]);
  return normalizeSystemdProperties(unitName, parseProperties(output), expected);
}

function assertTrustedDirectory(target, mode, ownership = {}) {
  const stat = fs.lstatSync(target);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== mode ||
    ownership.uid !== undefined && stat.uid !== ownership.uid ||
    ownership.gid !== undefined && stat.gid !== ownership.gid ||
    ownership.dev !== undefined && stat.dev !== ownership.dev
  ) {
    throw new Error('trusted parser directory metadata is unsafe');
  }
  return stat;
}

function writeExclusiveFile(target, bytes, mode) {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0),
    mode
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error('parser staging write was incomplete');
      offset += count;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(target) {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) |
      (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeTreeNoFollow(target, expectedDevice) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.dev !== expectedDevice) throw new Error('parser cleanup crossed a filesystem');
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) {
      removeTreeNoFollow(path.join(target, entry), expectedDevice);
    }
    fs.rmdirSync(target);
    return;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error('parser cleanup encountered an unsafe inode');
  }
  fs.unlinkSync(target);
}

async function inspectTrustedResultMetadata(runCommand, target) {
  const result = await captureCommand(runCommand, '/usr/bin/python3', [
    '-I',
    '-c',
    RESULT_METADATA_PROBE_SOURCE,
    target
  ]);
  let metadata;
  try {
    metadata = JSON.parse(result);
  } catch {
    throw new Error('parser result metadata observation is invalid');
  }
  return metadata;
}

function createTrustedJobController(options = {}) {
  const spoolRoot = path.resolve(options.spoolRoot || SPOOL_ROOT);
  const parserIdentity = options.parserIdentity;
  const systemd = options.systemd;
  if (
    spoolRoot !== SPOOL_ROOT ||
    !parserIdentity || !Number.isSafeInteger(parserIdentity.uid) || parserIdentity.uid <= 0 ||
    !Number.isSafeInteger(parserIdentity.gid) || parserIdentity.gid <= 0 ||
    !systemd
  ) {
    throw new Error('trusted parser job controller configuration is invalid');
  }

  async function stageJob(multipart, admission) {
    if (
      !multipart || !TRUSTED_UPLOAD_ROUTES.includes(multipart.route) ||
      !Array.isArray(multipart.fields) || !Array.isArray(multipart.files) ||
      multipart.files.length !== 1 ||
      !admission || admission.route !== multipart.route.id ||
      !Number.isSafeInteger(admission.ledgerId) || admission.ledgerId <= 0 ||
      !HEX_64.test(admission.requestHash) || !HEX_64.test(admission.leaseToken)
    ) {
      throw new Error('trusted parser staging request is invalid');
    }
    const file = multipart.files[0];
    if (
      !Buffer.isBuffer(file.buffer) || file.buffer.length !== file.length ||
      sha256(file.buffer) !== file.sha256 || file.length < 1
    ) {
      throw new Error('trusted parser staging payload is invalid');
    }
    const spoolStat = assertTrustedDirectory(spoolRoot, 0o700, { uid: 0, gid: 0 });
    let id;
    let jobRoot;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      id = crypto.randomBytes(16).toString('hex');
      jobRoot = path.join(spoolRoot, id);
      try {
        fs.mkdirSync(jobRoot, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt === 7) throw error;
      }
    }
    const outputRoot = path.join(jobRoot, 'output');
    const inputPath = path.join(jobRoot, 'input.bin');
    const requestPath = path.join(jobRoot, 'request.json');
    const resultPath = path.join(outputRoot, 'result.json');
    const lifecycleStartedMs = Date.now();
    try {
      fs.mkdirSync(outputRoot, { mode: 0o700 });
      assertTrustedDirectory(jobRoot, 0o700, { uid: 0, gid: 0, dev: spoolStat.dev });
      writeExclusiveFile(inputPath, file.buffer, 0o440);
      writeExclusiveFile(requestPath, Buffer.from(JSON.stringify({
        version: 1,
        job_id: id,
        route: multipart.route.id,
        fields: multipart.fields,
        file: {
          basename: file.basename,
          mime: file.mime,
          length: file.length,
          sha256: file.sha256
        }
      }), 'utf8'), 0o440);
      writeExclusiveFile(
        path.join(outputRoot, 'manifest.json'),
        PARSER_OUTPUT_MANIFEST_BYTES,
        0o440
      );
      writeExclusiveFile(resultPath, Buffer.alloc(0), 0o600);
      for (const target of [inputPath, requestPath]) {
        fs.chownSync(target, 0, parserIdentity.gid);
        fs.chmodSync(target, 0o440);
      }
      fs.chownSync(path.join(outputRoot, 'manifest.json'), 0, parserIdentity.gid);
      fs.chmodSync(path.join(outputRoot, 'manifest.json'), 0o440);
      fs.chownSync(resultPath, parserIdentity.uid, parserIdentity.gid);
      fs.chmodSync(resultPath, 0o600);
      fs.chownSync(outputRoot, 0, parserIdentity.gid);
      fs.chmodSync(outputRoot, 0o550);
      assertTrustedDirectory(outputRoot, 0o550, {
        uid: 0,
        gid: parserIdentity.gid,
        dev: spoolStat.dev
      });
      const resultStat = fs.lstatSync(resultPath);
      if (
        !resultStat.isFile() || resultStat.isSymbolicLink() || resultStat.nlink !== 1 ||
        resultStat.size !== 0 || resultStat.uid !== parserIdentity.uid ||
        resultStat.gid !== parserIdentity.gid || (resultStat.mode & 0o777) !== 0o600
      ) {
        throw new Error('trusted parser result target is invalid');
      }
      fsyncDirectory(jobRoot);
      fsyncDirectory(spoolRoot);
      return Object.freeze({
        id,
        unitName: `turingmarket-parser@${id}.service`,
        root: jobRoot,
        inputPath,
        requestPath,
        outputRoot,
        resultPath,
        device: spoolStat.dev,
        resultMetadata: Object.freeze({
          dev: resultStat.dev,
          ino: resultStat.ino,
          uid: resultStat.uid,
          gid: resultStat.gid,
          lifecycleStartedMs
        })
      });
    } catch (error) {
      removeTreeNoFollow(jobRoot, spoolStat.dev);
      fsyncDirectory(spoolRoot);
      throw error;
    }
  }

  async function killJob(job) {
    if (!job || !UNIT_NAME.test(job.unitName)) return;
    await systemd.kill(job.unitName).catch(() => {});
    await systemd.stop(job.unitName).catch(() => {});
    await systemd.resetFailed(job.unitName);
    await systemd.assertCollected(job.unitName);
  }

  async function cleanupJob(job) {
    if (
      !job || !/^[0-9a-f]{32}$/.test(job.id) ||
      path.resolve(job.root) !== path.join(spoolRoot, job.id)
    ) {
      throw new Error('trusted parser cleanup target is invalid');
    }
    removeTreeNoFollow(job.root, job.device);
    fsyncDirectory(spoolRoot);
    if (fs.existsSync(job.root)) throw new Error('trusted parser cleanup was incomplete');
  }

  return Object.freeze({ stageJob, killJob, cleanupJob });
}

function createTrustedSelfTestSandbox(options = {}) {
  const runCommand = options.runCommand || diagnosticRunCommand;
  return Object.freeze({
    SANDBOX_LIMITS,
    UPLOAD_ROUTES: TRUSTED_UPLOAD_ROUTES,
    runCommandNoDisclosure: runCommand,
    loadRuntimeManifest: loadTrustedSelfTestManifest,
    verifyRuntimeSourceArtifacts: async (manifest) => verifyTrustedSourceArtifacts(manifest),
    verifyInstalledParserArtifacts: async (manifest) => verifyTrustedInstalledArtifacts(manifest),
    verifyParserRuntimeTree: async (root, expected) => verifyTrustedRuntimeTree(root, expected),
    readSystemdProperties: (unit, expected) => (
      readTrustedSystemdProperties(runCommand, unit, expected)
    ),
    inspectResultMetadata: (target) => inspectTrustedResultMetadata(runCommand, target),
    createUploadSandboxService: (controllerOptions) => createTrustedJobController({
      ...controllerOptions,
      spoolRoot: SPOOL_ROOT
    })
  });
}

async function captureCommand(runCommand, command, args, timeoutMs = 5_000) {
  let result;
  try {
    result = await runCommand(command, args, {
      captureStdout: true,
      timeoutMs,
      env: SAFE_ENVIRONMENT
    });
  } catch (error) {
    error.selfTestStage = `command:${path.basename(command)}:${args[0] || 'none'}`;
    throw error;
  }
  if (!result || typeof result.stdout !== 'string' || result.stdout.length > 65_536) {
    throw new Error('invalid command evidence');
  }
  return result.stdout.trim();
}

function parseProperties(output) {
  if (typeof output !== 'string') throw new Error('invalid systemd evidence');
  const result = {};
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('invalid systemd evidence');
    const name = line.slice(0, separator);
    if (Object.hasOwn(result, name)) throw new Error('duplicate systemd evidence');
    result[name] = line.slice(separator + 1);
  }
  return result;
}

async function atStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error && !error.selfTestStage) error.selfTestStage = stage;
    throw error;
  }
}

async function verifyIdentity(runCommand, expected) {
  const passwd = await captureCommand(runCommand, '/usr/bin/getent', [
    'passwd',
    expected.user
  ]);
  const group = await captureCommand(runCommand, '/usr/bin/getent', [
    'group',
    expected.group
  ]);
  const groups = await captureCommand(runCommand, '/usr/bin/id', [
    '-Gn',
    expected.user
  ]);
  const status = await captureCommand(runCommand, '/usr/bin/passwd', [
    '-S',
    expected.user
  ]);
  const passwdFields = passwd.split(':');
  const groupFields = group.split(':');
  const uid = Number(passwdFields[2]);
  const gid = Number(passwdFields[3]);
  if (
    passwdFields.length !== 7 || groupFields.length !== 4 ||
    passwdFields[0] !== expected.user || groupFields[0] !== expected.group ||
    passwdFields[3] !== groupFields[2] ||
    !Number.isSafeInteger(uid) || uid <= 0 ||
    !Number.isSafeInteger(gid) || gid <= 0
  ) {
    throw new Error('parser identity mismatch');
  }
  const identity = {
    user: passwdFields[0],
    group: groupFields[0],
    home: passwdFields[5],
    shell: passwdFields[6],
    locked: /^\S+\s+(?:L|LK)\b/.test(status),
    supplementary_groups: groups
      .split(/\s+/)
      .filter(Boolean)
      .filter((name) => name !== groupFields[0]),
    uid,
    gid
  };
  if (!validateIdentityEvidence(identity, expected)) {
    throw new Error('parser identity mismatch');
  }
  return Object.freeze(identity);
}

async function verifySystemdFoundation(sandbox, runCommand, manifest) {
  const versionOutput = await captureCommand(
    runCommand,
    '/usr/bin/systemctl',
    ['--version']
  );
  const versionMatch = /^systemd\s+([0-9]+)(?:\s|$)/m.exec(versionOutput);
  const version = versionMatch ? Number(versionMatch[1]) : NaN;
  if (
    !Number.isSafeInteger(version) ||
    version < manifest.minimum_systemd_version
  ) {
    throw new Error('systemd version mismatch');
  }
  const expectedService = manifest.effective_properties[SERVICE_UNIT];
  const expectedSlice = manifest.effective_properties[SLICE_UNIT];
  const observedService = await sandbox.readSystemdProperties(
    SERVICE_UNIT,
    expectedService
  );
  const observedSlice = await sandbox.readSystemdProperties(SLICE_UNIT, expectedSlice);
  if (!sameRecord(observedService, expectedService)) {
    throw new Error('parser service properties mismatch');
  }
  if (!sameRecord(observedSlice, expectedSlice)) {
    throw new Error('parser slice properties mismatch');
  }
  const syscallDenyTokens = parseDeclaredSyscallDenyTokens(
    expectedService.SystemCallFilter
  );
  if (!syscallDenyTokens) throw new Error('parser syscall deny policy mismatch');
  return Object.freeze({
    service: true,
    slice: true,
    syscallDenyTokens
  });
}

function assertCleanSpool(spoolRoot = SPOOL_ROOT) {
  const stat = fs.lstatSync(spoolRoot);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    stat.uid !== 0 || stat.gid !== 0 ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.readdirSync(spoolRoot).length !== 0
  ) {
    throw new Error('parser self-test spool is not clean');
  }
}

function fixedMultipart(sandbox) {
  const route = sandbox.UPLOAD_ROUTES.find((item) => (
    item.id === 'parser.knowledge-upload'
  ));
  if (!route) throw new Error('parser self-test route is unavailable');
  const buffer = Buffer.from('self_test,value\nparser,1\n', 'utf8');
  return Object.freeze({
    route,
    fields: Object.freeze([]),
    files: Object.freeze([Object.freeze({
      buffer,
      basename: 'self-test.csv',
      mime: 'text/csv',
      length: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    })])
  });
}

function fixtureMultipart(sandbox, fixture) {
  const route = sandbox.UPLOAD_ROUTES.find((item) => item.id === 'parser.demand-parse');
  if (!route) throw new Error('parser functional self-test route is unavailable');
  return Object.freeze({
    route,
    fields: Object.freeze([]),
    files: Object.freeze([Object.freeze({
      buffer: fixture.buffer,
      basename: fixture.filename,
      mime: fixture.mime,
      length: fixture.buffer.length,
      sha256: crypto.createHash('sha256').update(fixture.buffer).digest('hex')
    })])
  });
}

function admissionFor(route, index) {
  const digest = (label) => crypto.createHash('sha256')
    .update(`${label}:${index}:${crypto.randomBytes(32).toString('hex')}`)
    .digest('hex');
  return Object.freeze({
    ledgerId: index + 1,
    requestHash: digest('request'),
    leaseToken: digest('lease'),
    route: route.id
  });
}

function writeSelfTestRequest(job, parserGid, selfTest, peerPid) {
  const request = peerPid === undefined
    ? { version: 1, job_id: job.id, self_test: selfTest }
    : { version: 1, job_id: job.id, self_test: selfTest, peer_pid: peerPid };
  const bytes = Buffer.from(JSON.stringify(request), 'utf8');
  const flags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0);
  const before = fs.lstatSync(job.requestPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('parser request inode is invalid');
  }
  const descriptor = fs.openSync(job.requestPath, flags);
  try {
    fs.ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
    }
    fs.fsyncSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      !after.isFile() || after.nlink !== 1 ||
      after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== bytes.length
    ) {
      throw new Error('parser request inode changed');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chownSync(job.requestPath, 0, parserGid);
  fs.chmodSync(job.requestPath, 0o440);
}

async function systemctl(runCommand, args, options = {}) {
  try {
    return await runCommand('/usr/bin/systemctl', args, {
      captureStdout: options.captureStdout === true,
      timeoutMs: options.timeoutMs || 30_000,
      env: SAFE_ENVIRONMENT
    });
  } catch (error) {
    error.selfTestStage = `systemctl:${args.join(':')}`;
    throw error;
  }
}

function createSelfTestSystemdController(runCommand) {
  if (typeof runCommand !== 'function') {
    throw new TypeError('self-test command runner is required');
  }
  return Object.freeze({
    start(unitName, options = {}) {
      return systemctl(runCommand, ['start', unitName], {
        timeoutMs: options.timeoutMs || 25_000
      });
    },
    kill(unitName) {
      return systemctl(runCommand, [
        'kill',
        '--kill-who=all',
        '--signal=KILL',
        unitName
      ], { timeoutMs: 5_000 });
    },
    stop(unitName) {
      return systemctl(runCommand, ['stop', unitName], { timeoutMs: 5_000 });
    },
    resetFailed(unitName) {
      return systemctl(runCommand, ['reset-failed', unitName], { timeoutMs: 5_000 })
        .catch(async (error) => {
          const collected = await systemctl(runCommand, [
            'show',
            unitName,
            '--no-pager',
            '--property=LoadState,ActiveState,SubState,ControlGroup'
          ], { timeoutMs: 5_000, captureStdout: true }).catch(() => null);
          if (!collected) throw error;
          const state = parseProperties(collected.stdout.trim());
          if (
            ['loaded', 'not-found'].includes(state.LoadState) &&
            state.ActiveState === 'inactive' &&
            state.SubState === 'dead' &&
            state.ControlGroup === ''
          ) return;
          throw error;
        });
    },
    async assertCollected(unitName) {
      const result = await systemctl(runCommand, [
        'show',
        unitName,
        '--no-pager',
        '--property=LoadState,ActiveState,SubState,ControlGroup'
      ], { timeoutMs: 5_000, captureStdout: true });
      const state = parseProperties(result.stdout.trim());
      if (
        !['loaded', 'not-found'].includes(state.LoadState) ||
        state.ActiveState !== 'inactive' ||
        state.SubState !== 'dead' ||
        state.ControlGroup !== ''
      ) {
        throw new Error('parser self-test cgroup collection was not verified');
      }
    }
  });
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMainPid(runCommand, unitName) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await systemctl(runCommand, [
      'show',
      unitName,
      '--no-pager',
      '--property=MainPID',
      '--value'
    ], { captureStdout: true, timeoutMs: 5_000 });
    const pid = Number(result.stdout.trim());
    if (Number.isSafeInteger(pid) && pid > 1) return pid;
    await pause(50);
  }
  throw new Error('parser unit did not expose a main PID');
}

async function waitForSuccess(runCommand, unitName) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await systemctl(runCommand, [
      'show',
      unitName,
      '--no-pager',
      '--property=ActiveState,Result,ExecMainStatus'
    ], { captureStdout: true, timeoutMs: 5_000 });
    const properties = parseProperties(result.stdout.trim());
    if (properties.ActiveState === 'inactive') {
      if (properties.Result !== 'success' || properties.ExecMainStatus !== '0') {
        throw new Error('parser self-test unit failed');
      }
      return;
    }
    if (properties.ActiveState === 'failed') {
      throw new Error('parser self-test unit failed');
    }
    await pause(50);
  }
  throw new Error('parser self-test unit timed out');
}

function readParserResult(job, maxBytes, expectedRoute = 'parser.sandbox-self-test') {
  if (fs.readdirSync(job.outputRoot).sort().join('\n') !== 'manifest.json\nresult.json') {
    throw new Error('parser result layout is invalid');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(job.resultPath, flags);
  let bytes;
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() || stat.nlink !== 1 ||
      stat.size < 1 || stat.size > maxBytes
    ) {
      throw new Error('parser result size is invalid');
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== stat.dev || after.ino !== stat.ino ||
      after.size !== stat.size || bytes.length !== stat.size
    ) {
      throw new Error('parser result changed during validation');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  let result;
  try {
    result = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('parser result is invalid');
  }
  if (
    !exactKeys(result, ['version', 'route', 'data']) ||
    result.version !== 1 ||
    result.route !== expectedRoute ||
    !isRecord(result.data)
  ) {
    throw new Error('parser result contract is invalid');
  }
  return result.data;
}

async function validateJobMetadata(sandbox, job, parserIdentity) {
  const metadata = await sandbox.inspectResultMetadata(job.resultPath);
  return validateResultMetadataEvidence(metadata, {
    dev: job.resultMetadata.dev,
    ino: job.resultMetadata.ino,
    uid: parserIdentity.uid,
    gid: parserIdentity.gid,
    lifecycle_started_ms: job.resultMetadata.lifecycleStartedMs,
    observed_at_ms: Date.now(),
    max_bytes: sandbox.SANDBOX_LIMITS.outputBytes
  });
}

async function cleanJobs(service, jobs) {
  let firstError = null;
  for (const job of [...jobs].reverse()) {
    let collected = false;
    try {
      await service.killJob(job);
      collected = true;
    } catch (error) {
      if (!firstError) firstError = error;
    }
    if (collected) {
      try {
        await service.cleanupJob(job);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  }
  if (firstError) throw firstError;
}

async function runSingleProbe(context, selfTest) {
  let job;
  try {
    job = await context.service.stageJob(
      fixedMultipart(context.sandbox),
      admissionFor(
        fixedMultipart(context.sandbox).route,
        context.nextAdmissionIndex()
      )
    );
    writeSelfTestRequest(job, context.parserIdentity.gid, selfTest);
    await systemctl(context.runCommand, ['start', job.unitName]);
    const data = readParserResult(job, context.sandbox.SANDBOX_LIMITS.outputBytes);
    const metadataValid = await validateJobMetadata(
      context.sandbox,
      job,
      context.parserIdentity
    );
    if (!metadataValid) throw new Error('parser result metadata proof failed');
    return Object.freeze({ data, metadataValid });
  } finally {
    if (job) await cleanJobs(context.service, [job]);
  }
}

async function runParserAcceptanceProbes(context) {
  const evidence = [];
  for (const fixture of createParserAcceptanceFixtures()) {
    let job;
    try {
      const multipart = fixtureMultipart(context.sandbox, fixture);
      job = await context.service.stageJob(
        multipart,
        admissionFor(multipart.route, context.nextAdmissionIndex())
      );
      await systemctl(context.runCommand, ['start', job.unitName], { timeoutMs: 25_000 });
      const data = readParserResult(
        job,
        context.sandbox.SANDBOX_LIMITS.outputBytes,
        multipart.route.id
      );
      const text = typeof data.text === 'string' ? data.text : '';
      const markerFound = text.toLocaleLowerCase('en-US').includes(
        fixture.marker.toLocaleLowerCase('en-US')
      );
      const item = Object.freeze({
        format: fixture.format,
        filename: fixture.filename,
        mime: fixture.mime,
        parser: data.parser,
        marker: fixture.marker,
        marker_found: markerFound,
        ocr_used: data.ocrUsed === true
      });
      if (!validateParserAcceptanceEvidence([...evidence, item].concat(
        PARSER_ACCEPTANCE_SPECS.slice(evidence.length + 1).map((spec) => ({
          ...spec,
          marker_found: true,
          ocr_used: spec.format === 'bmp'
        }))
      ).slice(0, PARSER_ACCEPTANCE_SPECS.length))) {
        throw new Error('parser functional acceptance proof failed');
      }
      if (!await validateJobMetadata(
        context.sandbox,
        job,
        context.parserIdentity
      )) {
        throw new Error('parser functional result metadata proof failed');
      }
      evidence.push(item);
    } finally {
      if (job) await cleanJobs(context.service, [job]);
    }
  }
  if (!validateParserAcceptanceEvidence(evidence)) {
    throw new Error('parser functional acceptance proof failed');
  }
  return Object.freeze(evidence);
}

function syscallPolicyEvidence(tokens, writable) {
  const operationByName = new Map([
    ...writable.socket_denial_evidence,
    ...writable.aio_denial_evidence
  ].map((item) => [item.operation, item]));
  const representative = REPRESENTATIVE_SYSCALL_DENIALS.map((spec) => {
    const observed = operationByName.get(spec.operation);
    return Object.freeze({
      operation: spec.operation,
      token: spec.token,
      errno: observed && observed.errno
    });
  });
  const value = Object.freeze({
    contract: 'tm-parser-syscall-deny-v1',
    declared_deny_tokens: tokens,
    verified_deny_tokens: tokens,
    representative_denials: Object.freeze(representative)
  });
  if (!validateSyscallPolicyEvidence(value)) {
    throw new Error('parser syscall denial proof failed');
  }
  return value;
}

function parseUnifiedCgroup(text) {
  if (typeof text !== 'string' || text.length > 65_536) {
    throw new Error('invalid process cgroup evidence');
  }
  const matches = text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^0::(.+)$/.exec(line);
    return match ? match[1] : null;
  }).filter(Boolean);
  if (matches.length !== 1 || !validCgroupPath(matches[0])) {
    throw new Error('unified process cgroup evidence is unavailable');
  }
  return matches[0];
}

function safeCgroupProcsPath(controlGroup) {
  if (!validCgroupPath(controlGroup)) throw new Error('invalid cgroup path');
  const root = '/sys/fs/cgroup';
  const target = path.posix.resolve(root, `.${controlGroup}`, 'cgroup.procs');
  if (!target.startsWith(`${root}/`)) throw new Error('invalid cgroup path');
  return target;
}

function parsePidList(value) {
  if (typeof value !== 'string' || value.length > 65_536) {
    throw new Error('invalid cgroup process evidence');
  }
  const pids = value.trim().split(/\s+/).filter(Boolean).map(Number);
  if (
    pids.length === 0 ||
    !pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)
  ) {
    throw new Error('invalid cgroup process evidence');
  }
  return pids;
}

async function observeMembership(runCommand, unitName, expectedPid) {
  const result = await systemctl(runCommand, [
    'show',
    unitName,
    '--no-pager',
    '--property=MainPID,Slice,ControlGroup'
  ], { captureStdout: true, timeoutMs: 5_000 });
  const properties = parseProperties(result.stdout.trim());
  if (!exactKeys(properties, ['MainPID', 'Slice', 'ControlGroup'])) {
    throw new Error('parser unit cgroup evidence is incomplete');
  }
  const mainPid = Number(properties.MainPID);
  if (!Number.isSafeInteger(mainPid) || mainPid <= 1) {
    throw new Error('parser unit PID is invalid');
  }
  const procControlGroup = parseUnifiedCgroup(
    fs.readFileSync(`/proc/${mainPid}/cgroup`, 'utf8')
  );
  const cgroupProcsPath = safeCgroupProcsPath(properties.ControlGroup);
  const cgroupExists = fs.statSync(path.dirname(cgroupProcsPath)).isDirectory();
  const cgroupProcs = parsePidList(fs.readFileSync(cgroupProcsPath, 'utf8'));
  return Object.freeze({
    unit_name: unitName,
    main_pid: mainPid,
    slice: properties.Slice,
    control_group: properties.ControlGroup,
    proc_control_group: procControlGroup,
    cgroup_exists: cgroupExists,
    cgroup_procs: Object.freeze(cgroupProcs),
    host_pid_changed: mainPid !== expectedPid
  });
}

async function readSliceControlGroup(runCommand) {
  const result = await systemctl(runCommand, [
    'show',
    SLICE_UNIT,
    '--no-pager',
    '--property=ControlGroup',
    '--value'
  ], { captureStdout: true, timeoutMs: 5_000 });
  const value = result.stdout.trim();
  if (!validCgroupPath(value)) throw new Error('parser slice cgroup is invalid');
  return value;
}

function pidWritableProjection(value) {
  if (!isRecord(value) || !Object.hasOwn(value, 'sibling_pid_isolation')) {
    throw new Error('parser sibling proof is missing');
  }
  const sibling = value.sibling_pid_isolation;
  const writable = { ...value };
  delete writable.sibling_pid_isolation;
  if (!validateWritableEvidence(writable)) {
    throw new Error('parser sibling writable proof failed');
  }
  return Object.freeze({ writable: Object.freeze(writable), sibling });
}

async function runPidProof(context) {
  const jobs = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const multipart = fixedMultipart(context.sandbox);
      jobs.push(await context.service.stageJob(
        multipart,
        admissionFor(multipart.route, context.nextAdmissionIndex())
      ));
    }
    writeSelfTestRequest(
      jobs[0],
      context.parserIdentity.gid,
      'pid-namespace-peer-v1',
      0
    );
    await systemctl(context.runCommand, [
      '--no-block',
      'start',
      jobs[0].unitName
    ], { timeoutMs: 5_000 });
    const firstPid = await waitForMainPid(context.runCommand, jobs[0].unitName);

    writeSelfTestRequest(
      jobs[1],
      context.parserIdentity.gid,
      'pid-namespace-peer-v1',
      firstPid
    );
    await systemctl(context.runCommand, [
      '--no-block',
      'start',
      jobs[1].unitName
    ], { timeoutMs: 5_000 });
    const secondPid = await waitForMainPid(context.runCommand, jobs[1].unitName);

    const sliceControlGroup = await readSliceControlGroup(context.runCommand);
    const memberships = await Promise.all([
      observeMembership(context.runCommand, jobs[0].unitName, firstPid),
      observeMembership(context.runCommand, jobs[1].unitName, secondPid)
    ]);
    const aggregate = Object.freeze({
      slice_properties_verified: true,
      slice_control_group: sliceControlGroup,
      memberships: Object.freeze(memberships)
    });
    if (!validateAggregateEvidence(aggregate)) {
      throw new Error('parser aggregate cgroup proof failed');
    }

    writeSelfTestRequest(
      jobs[0],
      context.parserIdentity.gid,
      'pid-namespace-peer-v1',
      secondPid
    );
    await Promise.all(jobs.map((job) => waitForSuccess(context.runCommand, job.unitName)));

    const proofs = [];
    const metadataChecks = [];
    for (const job of jobs) {
      const data = readParserResult(job, context.sandbox.SANDBOX_LIMITS.outputBytes);
      const projection = pidWritableProjection(data);
      proofs.push(projection.sibling);
      metadataChecks.push(await validateJobMetadata(
        context.sandbox,
        job,
        context.parserIdentity
      ));
    }
    if (!validatePidEvidence(proofs, memberships)) {
      throw new Error('parser sibling PID proof failed');
    }
    if (!metadataChecks.every((item) => item === true)) {
      throw new Error('parser sibling result metadata proof failed');
    }
    return Object.freeze({
      aggregate,
      proofs: Object.freeze(proofs),
      metadataChecks: Object.freeze(metadataChecks)
    });
  } finally {
    if (jobs.length > 0) await cleanJobs(context.service, jobs);
  }
}

async function executeProductionSelfTests(options = {}) {
  const platform = options.platform || process.platform;
  const getuid = options.getuid || process.getuid;
  if (platform !== 'linux' || typeof getuid !== 'function' || getuid() !== 0) {
    throw new Error('production parser self-tests require the trusted Linux root controller');
  }

  const manifestPath = options.manifestPath || process.env.TM_UPLOAD_SANDBOX_MANIFEST_PATH;
  const serverRoot = options.serverRoot || process.env.TM_UPLOAD_SANDBOX_SERVER_ROOT;
  const sandbox = options.sandbox || createTrustedSelfTestSandbox({
    runCommand: options.runCommand
  });
  const baseRunCommand = options.runCommand || (
    process.env.TM_UPLOAD_SANDBOX_DIAGNOSTIC === '1'
      ? diagnosticRunCommand
      : sandbox.runCommandNoDisclosure
  );
  const runCommand = async (...args) => {
    try {
      return await baseRunCommand(...args);
    } catch (error) {
      if (!error.selfTestStage) {
        const command = args[0] || 'unknown';
        const commandArgs = Array.isArray(args[1]) ? args[1] : [];
        error.selfTestStage = `raw:${path.basename(command)}:${commandArgs.join(':')}`;
      }
      throw error;
    }
  };
  const runtime = sandbox.loadRuntimeManifest({ manifestPath, serverRoot });
  const verified = { manifest: runtime.manifest, manifestSha256: runtime.manifestSha256 };
  await atStage('verify:runtime-source-artifacts', () => (
    sandbox.verifyRuntimeSourceArtifacts(verified.manifest)
  ));
  await atStage('verify:installed-runtime-artifacts', () => (
    sandbox.verifyInstalledParserArtifacts(verified.manifest)
  ));
  const runtimeTree = await atStage('observe:runtime-tree', async () => {
    const expected = verified.manifest.runtime_tree;
    if (!expected || typeof sandbox.verifyParserRuntimeTree !== 'function') {
      throw new Error('runtime tree verifier is unavailable');
    }
    const observed = await sandbox.verifyParserRuntimeTree(
      expected.root || options.runtimeRoot || PARSER_RUNTIME_ROOT,
      expected,
      { requireRootOwnership: true }
    );
    return Object.freeze({
      format: observed.format,
      sha256: observed.sha256,
      files: observed.files,
      directories: observed.directories,
      bytes: observed.bytes
    });
  });
  const identity = await atStage('verify:identity', () => (
    verifyIdentity(runCommand, verified.manifest.identity)
  ));
  const systemd = await atStage('verify:systemd-foundation', () => (
    verifySystemdFoundation(sandbox, runCommand, verified.manifest)
  ));
  const spoolRoot = options.spoolRoot || SPOOL_ROOT;
  if (path.resolve(spoolRoot) !== SPOOL_ROOT) {
    throw new Error('production parser self-test spool root is fixed');
  }
  assertCleanSpool(spoolRoot);

  const service = sandbox.createUploadSandboxService({
    parserIdentity: { uid: identity.uid, gid: identity.gid },
    spoolRoot,
    systemd: createSelfTestSystemdController(runCommand)
  });
  let admissionIndex = 1000;
  const context = Object.freeze({
    sandbox,
    runCommand,
    parserIdentity: identity,
    service,
    nextAdmissionIndex() {
      admissionIndex += 1;
      return admissionIndex;
    }
  });

  const writable = await atStage('probe:writable-filesystem-v1', () => (
    runSingleProbe(context, 'writable-filesystem-v1')
  ));
  if (!validateWritableEvidence(writable.data)) {
    throw new Error('parser writable filesystem proof failed');
  }
  const parserAcceptance = await atStage('probe:parser-functional-acceptance-v1', () => (
    runParserAcceptanceProbes(context)
  ));
  const syscallPolicy = syscallPolicyEvidence(systemd.syscallDenyTokens, writable.data);
  const pid = await atStage('probe:pid-namespace-peer-v1', () => runPidProof(context));
  const scratch = await atStage('probe:scratch-pressure-v1', () => (
    runSingleProbe(context, 'scratch-pressure-v1')
  ));
  if (!validatePressureEvidence(scratch.data, 'scratch-pressure-v1')) {
    throw new Error('parser scratch pressure proof failed');
  }
  const output = await atStage('probe:output-pressure-v1', () => (
    runSingleProbe(context, 'output-pressure-v1')
  ));
  if (!validatePressureEvidence(output.data, 'output-pressure-v1')) {
    throw new Error('parser output pressure proof failed');
  }
  assertCleanSpool(spoolRoot);

  const evidence = {
    manifest_verified: true,
    installed_runtime_verified: true,
    systemd_service_verified: systemd.service,
    systemd_slice_verified: systemd.slice,
    identity,
    expected_identity: verified.manifest.identity,
    writable: writable.data,
    pid_proofs: pid.proofs,
    aggregate: pid.aggregate,
    pressure: { scratch: scratch.data, output: output.data },
    parser_acceptance: parserAcceptance,
    syscall_policy: syscallPolicy,
    result_metadata_checks: [
      writable.metadataValid,
      ...pid.metadataChecks,
      scratch.metadataValid,
      output.metadataValid
    ]
  };
  return composeRawSelfTestObservations({
    manifestSha256: verified.manifestSha256,
    runtimeTree,
    effectiveProperties: verified.manifest.effective_properties,
    evidence
  });
}

function assertRawSelfTestObservations(value) {
  if (
    !exactKeys(value, [
      'format',
      'manifest_sha256',
      'runtime_tree',
      'effective_properties',
      'parser_acceptance',
      'self_tests'
    ]) ||
    value.format !== RAW_OBSERVATIONS_FORMAT ||
    !HEX_64.test(value.manifest_sha256 || '')
  ) {
    throw new Error('invalid raw self-test observations');
  }
  assertRootlessRuntimeTree(value.runtime_tree);
  assertEffectiveProperties(value.effective_properties);
  if (
    !Array.isArray(value.parser_acceptance) ||
    value.parser_acceptance.length !== PARSER_ACCEPTANCE_SPECS.length ||
    !value.parser_acceptance.every((item, index) => (
      exactKeys(item, ['format', 'parser', 'marker', 'marker_found', 'ocr_used']) &&
      item.format === PARSER_ACCEPTANCE_SPECS[index].format &&
      item.parser === PARSER_ACCEPTANCE_SPECS[index].parser &&
      item.marker === PARSER_ACCEPTANCE_SPECS[index].marker &&
      item.marker_found === true &&
      item.ocr_used === (item.format === 'bmp')
    ))
  ) {
    throw new Error('invalid raw parser acceptance observations');
  }
  assertCompleteSelfTestResult(value.self_tests);
  return value;
}

async function runCli(argv, options = {}) {
  const writeStdout = options.writeStdout || ((value) => process.stdout.write(value));
  const writeStderr = options.writeStderr || ((value) => process.stderr.write(value));
  const platform = options.platform || process.platform;
  const getuid = options.getuid || process.getuid;
  if (platform !== 'linux' || typeof getuid !== 'function' || getuid() !== 0) {
    writeStderr('upload sandbox self-test failed\n');
    return 65;
  }
  try {
    if (!sameArray(argv, ['--json'])) throw new Error('invalid self-test arguments');
    const execute = options.execute || executeProductionSelfTests;
    const result = assertRawSelfTestObservations(await execute({ platform, getuid }));
    writeStdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    writeStderr('upload sandbox self-test failed\n');
    return 1;
  }
}

async function runDiagnosticCli(argv, options = {}) {
  if (!sameArray(argv, ['--diagnose'])) return 64;
  const platform = options.platform || process.platform;
  const getuid = options.getuid || process.getuid;
  if (platform !== 'linux' || typeof getuid !== 'function' || getuid() !== 0) return 65;
  try {
    const execute = options.execute || executeProductionSelfTests;
    assertRawSelfTestObservations(await execute({ platform, getuid }));
    return 0;
  } catch (error) {
    const stage = error && error.selfTestStage ? `stage=${error.selfTestStage}\n` : '';
    const captured = error && error.capturedStderr ? `child=${error.capturedStderr}\n` : '';
    const message = error && error.stack ? error.stack : String(error);
    (options.writeStderr || ((value) => process.stderr.write(value)))(`${stage}${captured}${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  const diagnostic = process.env.TM_UPLOAD_SANDBOX_DIAGNOSTIC === '1';
  const run = diagnostic ? runDiagnosticCli : runCli;
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write('upload sandbox self-test failed\n');
    process.exitCode = 1;
  });
}

module.exports = {
  PRESSURE_ERRNOS,
  REQUIRED_SELF_TESTS,
  assertCompleteSelfTestResult,
  composeRawSelfTestObservations,
  composeSelfTestResult,
  createParserAcceptanceFixtures,
  createSelfTestSystemdController,
  createTrustedJobController,
  createTrustedSelfTestSandbox,
  executeProductionSelfTests,
  parseDeclaredSyscallDenyTokens,
  parseProperties,
  runtimeSourceArtifactPath,
  runCli,
  runDiagnosticCli,
  validateAggregateEvidence,
  validateIdentityEvidence,
  validatePidEvidence,
  validateParserAcceptanceEvidence,
  validatePressureEvidence,
  validateResultMetadataEvidence,
  validateWritableEvidence
};
