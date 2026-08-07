'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

const HEX_64 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const PARSER_RUNTIME_TREE_FORMAT = 'tm-parser-runtime-tree-v1';
const PARSER_RUNTIME_ROOT = '/var/lib/turingmarket-parser/runtime-root';
const WRITABLE_FILESYSTEM_CONTRACT = 'tm-parser-writable-filesystem-v1';
const WRITABLE_FILESYSTEM_SELF_TEST = 'writable-filesystem-v1';
const PID_NAMESPACE_PEER_SELF_TEST = 'pid-namespace-peer-v1';
const PID_NAMESPACE_PEER_CONTRACT = 'tm-parser-sibling-proc-fd-denial-v1';
const SOCKET_ISOLATION_CONTRACT = 'tm-parser-no-sockets-v1';
const PID_NAMESPACE_CONTRACT = 'tm-parser-private-pids-v1';
const MINIMUM_SYSTEMD_VERSION = 257;
const RESULT_TIMESTAMP_TOLERANCE_MS = 2_000;
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
const EXPECTED_INACCESSIBLE_PATHS =
  '/tmp /var/tmp /dev/shm -/dev/mqueue -/dev/hugepages /dev/pts';
const HOST_LOG_SOCKET_PATHS = Object.freeze([
  '/dev/log',
  '/run/systemd/journal/dev-log',
  '/run/systemd/journal/socket',
  '/run/systemd/journal/stdout'
]);
const SOCKET_DENIAL_OPERATIONS = Object.freeze([
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
const SOCKET_POLICY_DENIAL_ERRORS = Object.freeze([
  'EPERM',
  'EACCES',
  'EAFNOSUPPORT',
  'EPROTONOSUPPORT'
]);
const SOCKET_PROBE_SOURCE = [
  'import errno, json, os, socket',
  'results = []',
  'def probe(name, family, kind, action, address, payload=None):',
  '    sock = None',
  '    code = "ALLOWED"',
  '    try:',
  '        sock = socket.socket(family, kind)',
  '        if action == "bind":',
  '            sock.bind(address)',
  '        else:',
  '            sock.connect(address)',
  '            if payload is not None:',
  '                sock.send(payload)',
  '    except OSError as error:',
  '        code = errno.errorcode.get(error.errno, "ERRNO_%s" % error.errno)',
  '    finally:',
  '        if sock is not None:',
  '            sock.close()',
  '    results.append({"operation": name, "errno": code})',
  'probe_path = "/scratch/.tm-parser-socket-probe-%d" % os.getpid()',
  'try:',
  '    os.unlink(probe_path)',
  'except FileNotFoundError:',
  '    pass',
  'probe("filesystem_af_unix_bind", socket.AF_UNIX, socket.SOCK_STREAM, "bind", probe_path)',
  'try:',
  '    os.unlink(probe_path)',
  'except FileNotFoundError:',
  '    pass',
  'probe("abstract_af_unix_connect", socket.AF_UNIX, socket.SOCK_STREAM, "connect", "\\0tm-parser-socket-probe")',
  'probe("journald_dev_log_send", socket.AF_UNIX, socket.SOCK_DGRAM, "send", "/run/systemd/journal/dev-log", b"TM_SOCKET_DENIAL_PROBE=1")',
  'probe("journald_native_send", socket.AF_UNIX, socket.SOCK_DGRAM, "send", "/run/systemd/journal/socket", b"TM_SOCKET_DENIAL_PROBE=1")',
  'probe("journald_stdout_send", socket.AF_UNIX, socket.SOCK_STREAM, "send", "/run/systemd/journal/stdout", b"TM_SOCKET_DENIAL_PROBE=1\\n")',
  'probe("syslog_dev_log_send", socket.AF_UNIX, socket.SOCK_DGRAM, "send", "/dev/log", b"TM_SOCKET_DENIAL_PROBE=1")',
  'probe("inet4_tcp_connect", socket.AF_INET, socket.SOCK_STREAM, "connect", ("127.0.0.1", 9))',
  'probe("inet4_udp_connect", socket.AF_INET, socket.SOCK_DGRAM, "send", ("127.0.0.1", 9), b"TM_SOCKET_DENIAL_PROBE")',
  'probe("inet6_tcp_connect", socket.AF_INET6, socket.SOCK_STREAM, "connect", ("::1", 9))',
  'print(json.dumps(results, separators=(",", ":")))'
].join('\n');
const AIO_DENIAL_OPERATIONS = Object.freeze([
  'io_uring_setup_socket_path',
  'io_uring_enter_socket_path',
  'io_uring_register_socket_path'
]);
const AIO_PROBE_SOURCE = [
  'import ctypes, errno, json, os, platform',
  'machine = platform.machine().lower()',
  'if machine not in ("x86_64", "amd64", "aarch64", "arm64", "riscv64"):',
  '    raise SystemExit(64)',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'libc.syscall.restype = ctypes.c_long',
  'results = []',
  'def record(name, number, args):',
  '    ctypes.set_errno(0)',
  '    value = libc.syscall(ctypes.c_long(number), *args)',
  '    code = "ALLOWED" if value >= 0 else errno.errorcode.get(ctypes.get_errno(), "UNKNOWN")',
  '    if value >= 0 and name == "io_uring_setup_socket_path":',
  '        os.close(value)',
  '    results.append({"operation": name, "errno": code})',
  'params = (ctypes.c_ubyte * 256)()',
  'record("io_uring_setup_socket_path", 425, [ctypes.c_uint(2), ctypes.byref(params)])',
  'record("io_uring_enter_socket_path", 426, [ctypes.c_int(-1), ctypes.c_uint(0), ctypes.c_uint(1), ctypes.c_uint(0), ctypes.c_void_p(), ctypes.c_size_t(0)])',
  'record("io_uring_register_socket_path", 427, [ctypes.c_int(-1), ctypes.c_uint(0), ctypes.c_void_p(), ctypes.c_uint(0)])',
  'print(json.dumps(results, separators=(",", ":")))'
].join('\n');
const RESULT_METADATA_PROBE_SOURCE = [
  'import json, os, stat, sys',
  'flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)',
  'fd = os.open(sys.argv[1], flags)',
  'try:',
  '    value = os.fstat(fd)',
  '    attrs = sorted(os.listxattr(fd))',
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
  '        "xattrs": attrs',
  '    }',
  '    print(json.dumps(result, separators=(",", ":")))',
  'finally:',
  '    os.close(fd)'
].join('\n');

const SANDBOX_LIMITS = Object.freeze({
  rawBodyBytes: 22_020_096,
  fileBytes: 15_728_640,
  files: 1,
  fields: 20,
  parts: 25,
  fieldBytes: 262_144,
  outputBytes: 10 * 1024 * 1024,
  expandedBytes: 100 * 1024 * 1024,
  archiveEntries: 10_000,
  worksheetsOrSlides: 64,
  rows: 100_000,
  cells: 1_000_000,
  pdfPages: 500,
  admissionSeconds: 90,
  bodySeconds: 60,
  parserSeconds: 20,
  reservationBytes: 128 * 1024 * 1024,
  spoolBytes: 512 * 1024 * 1024,
  freeFloorBytes: 2 * 1024 * 1024 * 1024
});

const PARSER_OUTPUT_MANIFEST = Object.freeze({
  version: 2,
  files: Object.freeze([
    Object.freeze({
      path: 'result.json',
      mime: 'application/json',
      max_bytes: SANDBOX_LIMITS.outputBytes
    })
  ]),
  total_writable_bytes: SANDBOX_LIMITS.outputBytes
});
const PARSER_OUTPUT_MANIFEST_BYTES = Buffer.from(
  JSON.stringify(PARSER_OUTPUT_MANIFEST),
  'utf8'
);
const PARSER_OUTPUT_ENTRIES = Object.freeze(['manifest.json', 'result.json']);

const MIME_BY_EXTENSION = Object.freeze({
  '.csv': Object.freeze(['text/csv', 'application/vnd.ms-excel']),
  '.json': Object.freeze(['application/json']),
  '.md': Object.freeze(['text/markdown', 'text/plain']),
  '.txt': Object.freeze(['text/plain']),
  '.xlsx': Object.freeze([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]),
  '.xlsm': Object.freeze([
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]),
  '.pdf': Object.freeze(['application/pdf']),
  '.docx': Object.freeze([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]),
  '.pptx': Object.freeze([
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]),
  '.jpg': Object.freeze(['image/jpeg']),
  '.jpeg': Object.freeze(['image/jpeg']),
  '.png': Object.freeze(['image/png']),
  '.webp': Object.freeze(['image/webp']),
  '.bmp': Object.freeze(['image/bmp']),
  '.tif': Object.freeze(['image/tiff']),
  '.tiff': Object.freeze(['image/tiff'])
});

function routePolicy(id, routePath, admissionScope, textFields, extensions) {
  return Object.freeze({
    id,
    method: 'POST',
    path: routePath,
    admissionScope,
    fileField: 'file',
    textFields: Object.freeze([...textFields]),
    extensions: Object.freeze([...extensions]),
    limits: SANDBOX_LIMITS
  });
}

const UPLOAD_ROUTES = Object.freeze([
  routePolicy(
    'parser.knowledge-upload',
    '/api/knowledge/upload',
    'parser.knowledge-upload.admission',
    [
      'campaign_id',
      'title',
      'summary',
      'entry_type',
      'source_type',
      'source_id',
      'visibility',
      'tags',
      'business_type',
      'business_id'
    ],
    ['.csv', '.json', '.md', '.txt', '.xlsx', '.xlsm', '.pdf', '.docx', '.pptx']
  ),
  routePolicy(
    'parser.influencer-upload',
    '/api/influencers/upload',
    'parser.influencer-upload.admission',
    ['batch_id'],
    ['.csv', '.json', '.xlsx']
  ),
  routePolicy(
    'parser.demand-parse',
    '/api/demand/parse-file',
    'parser.demand-parse.admission',
    [],
    [
      '.csv', '.json', '.md', '.txt', '.xlsx', '.xlsm', '.pdf', '.docx', '.pptx',
      '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'
    ]
  )
]);

const SERVER_ROOT = path.resolve(__dirname, '..');
const RUNTIME_MANIFEST_PATH = path.join(
  SERVER_ROOT,
  'systemd',
  'turingmarket-parser.manifest.json'
);
const RUNTIME_ARTIFACTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'extract_document_text.py',
  'extract_xlsx_text.py',
  'ocr_document_text.py',
  'services/file_ingest_service.js',
  'services/upload_sandbox_service.js',
  'scripts/parse_upload_sandbox.sh',
  'systemd/turingmarket-parser@.service',
  'systemd/turingmarket-parser.slice'
]);
const INSTALLED_RUNTIME_ARTIFACTS = Object.freeze({
  'systemd/turingmarket-parser@.service': Object.freeze({
    path: '/etc/systemd/system/turingmarket-parser@.service',
    mode: 0o644
  }),
  'systemd/turingmarket-parser.slice': Object.freeze({
    path: '/etc/systemd/system/turingmarket-parser.slice',
    mode: 0o644
  })
});
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
  'output_pressure'
]);
const EXPECTED_IDENTITY = Object.freeze({
  user: 'turingmarket-parser',
  group: 'turingmarket-parser',
  home: '/nonexistent',
  shell: '/usr/sbin/nologin',
  locked: true,
  supplementary_groups: Object.freeze([])
});
const EXPECTED_SERVICE_PROPERTIES = Object.freeze({
  FragmentPath: '/etc/systemd/system/turingmarket-parser@.service',
  DropInPaths: '',
  Slice: 'turingmarket-parser.slice',
  User: 'turingmarket-parser',
  Group: 'turingmarket-parser',
  UMask: '0077',
  Environment: 'LANG=C.UTF-8 LC_ALL=C.UTF-8 TMPDIR=/scratch TMP=/scratch TEMP=/scratch PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1',
  RootDirectory: PARSER_RUNTIME_ROOT,
  MountAPIVFS: 'yes',
  BindLogSockets: 'no',
  PrivateMounts: 'yes',
  NoNewPrivileges: 'yes',
  CapabilityBoundingSet: '',
  AmbientCapabilities: '',
  PrivateNetwork: 'yes',
  PrivateIPC: 'yes',
  PrivatePIDs: 'yes',
  IPAddressDeny: 'any',
  RestrictAddressFamilies: 'none',
  PrivateDevices: 'yes',
  DevicePolicy: 'closed',
  PrivateTmp: 'no',
  PrivateUsers: 'yes',
  ProtectSystem: 'strict',
  ProtectHome: 'yes',
  ProtectKernelTunables: 'yes',
  ProtectKernelModules: 'yes',
  ProtectControlGroups: 'yes',
  ProtectClock: 'yes',
  ProtectHostname: 'yes',
  ProtectProc: 'invisible',
  ProcSubset: 'pid',
  RestrictNamespaces: 'yes',
  RestrictSUIDSGID: 'yes',
  LockPersonality: 'yes',
  SystemCallArchitectures: 'native',
  SystemCallFilter: '@system-service ~@mount @network-io @aio io_uring_setup io_uring_enter io_uring_register @chown @privileged @raw-io @reboot @swap @resources @obsolete @debug @clock chmod fchmod fchmodat fchmodat2 setxattr lsetxattr fsetxattr removexattr lremovexattr fremovexattr utime utimes futimesat utimensat',
  SystemCallErrorNumber: 'EPERM',
  TasksMax: '32',
  LimitNOFILE: '64',
  LimitFSIZE: String(SANDBOX_LIMITS.outputBytes),
  MemoryMax: '536870912',
  CPUQuotaPerSecUSec: '1s',
  RuntimeMaxUSec: '20s',
  TimeoutStopUSec: '5s',
  SendSIGKILL: 'yes',
  LimitCORE: '0',
  OOMPolicy: 'kill',
  TemporaryFileSystem: '/scratch:rw,nosuid,nodev,noexec,size=128M',
  InaccessiblePaths: EXPECTED_INACCESSIBLE_PATHS,
  BindReadOnlyPaths: '/var/lib/turingmarket-parser/jobs/%i/input.bin:/input/input.bin /var/lib/turingmarket-parser/jobs/%i/request.json:/runtime/request.json /var/lib/turingmarket-parser/jobs/%i/output:/output',
  BindPaths: '/var/lib/turingmarket-parser/jobs/%i/output/result.json:/output/result.json',
  NoExecPaths: '/',
  ExecPaths: '/bin/bash /lib /lib64 /opt/turingmarket-parser/app /usr/bin/env /usr/bin/node /usr/bin/python3 /usr/lib /usr/local/lib /usr/local/libexec/turingmarket/parse_upload_sandbox.sh',
  WorkingDirectory: '/opt/turingmarket-parser/app',
  KillMode: 'control-group',
  StandardOutput: 'null',
  StandardError: 'null'
});
const EXPECTED_SLICE_PROPERTIES = Object.freeze({
  FragmentPath: '/etc/systemd/system/turingmarket-parser.slice',
  DropInPaths: '',
  MemoryAccounting: 'yes',
  CPUAccounting: 'yes',
  TasksAccounting: 'yes',
  IOAccounting: 'yes',
  MemoryHigh: '1610612736',
  MemoryMax: '2147483648',
  CPUQuotaPerSecUSec: '4s',
  TasksMax: '128'
});

class UploadSandboxError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'UploadSandboxError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function uploadError(statusCode, code, message, details) {
  return new UploadSandboxError(statusCode, code, message, details);
}

function normalizedText(value, label) {
  if (typeof value !== 'string') {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', `Invalid ${label}`);
  }
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (CONTROL.test(normalized)) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', `Invalid ${label}`);
  }
  return normalized;
}

function normalizeMime(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) return '';
  return normalized;
}

function safeBasename(value) {
  const normalized = normalizedText(value, 'upload basename');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized !== path.posix.basename(normalized) ||
    normalized !== path.win32.basename(normalized) ||
    Buffer.byteLength(normalized, 'utf8') > 255
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid upload basename');
  }
  return normalized;
}

function matchUploadRoute(method, routePath) {
  const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : '';
  const normalizedPath = typeof routePath === 'string'
    ? routePath.split(/[?#]/, 1)[0]
    : '';
  return UPLOAD_ROUTES.find((route) => (
    route.method === normalizedMethod && route.path === normalizedPath
  )) || null;
}

function assertMimeAndExtension(route, basename, mime) {
  const extension = path.extname(basename).toLowerCase();
  const acceptedMimes = MIME_BY_EXTENSION[extension];
  if (
    !route.extensions.includes(extension) ||
    !acceptedMimes ||
    !acceptedMimes.includes(mime)
  ) {
    throw uploadError(415, 'UPLOAD_UNSUPPORTED_TYPE', 'Unsupported upload type');
  }
  return extension;
}

function assertMagicBytes(extension, bytes) {
  const starts = (...values) => (
    bytes.length >= values.length && values.every((value, index) => bytes[index] === value)
  );
  let valid = true;
  if (extension === '.xlsx' || extension === '.xlsm' || extension === '.docx' || extension === '.pptx') {
    valid = starts(0x50, 0x4b, 0x03, 0x04);
  } else if (extension === '.pdf') {
    valid = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  } else if (extension === '.png') {
    valid = starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  } else if (extension === '.jpg' || extension === '.jpeg') {
    valid = starts(0xff, 0xd8, 0xff);
  } else if (extension === '.webp') {
    valid = bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  } else if (extension === '.bmp') {
    valid = starts(0x42, 0x4d);
  } else if (extension === '.tif' || extension === '.tiff') {
    valid = starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a);
  }
  if (!valid) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Upload content does not match its type');
  }
}

function inspectZipArchive(bytes) {
  const minimumEocd = 22;
  let eocdOffset = -1;
  const searchStart = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Malformed ZIP container');
  }
  const disk = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = bytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const centralBytes = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  const commentBytes = bytes.readUInt16LE(eocdOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries < 1 ||
    totalEntries > SANDBOX_LIMITS.archiveEntries ||
    eocdOffset + minimumEocd + commentBytes !== bytes.length ||
    centralOffset + centralBytes !== eocdOffset ||
    centralOffset < 30 ||
    centralOffset > bytes.length
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Malformed ZIP container');
  }

  let offset = centralOffset;
  let expandedBytes = 0;
  let worksheetCount = 0;
  let slideCount = 0;
  const names = new Set();
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocdOffset || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Malformed ZIP central directory');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const compressedBytes = bytes.readUInt32LE(offset + 20);
    const uncompressedBytes = bytes.readUInt32LE(offset + 24);
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const extraBytes = bytes.readUInt16LE(offset + 30);
    const entryCommentBytes = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      flags & 0x0001 ||
      nameBytes < 1 ||
      end > eocdOffset ||
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      localOffset >= centralOffset
    ) {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Unsafe ZIP entry');
    }
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType === 0xa000) {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'ZIP symlinks are not allowed');
    }
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameBytes).toString('utf8');
    const name = normalizedText(rawName, 'ZIP entry name');
    const components = name.split('/');
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      /^[A-Za-z]:/.test(name) ||
      components.some((component) => component === '' || component === '.' || component === '..') ||
      names.has(name)
    ) {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Unsafe ZIP entry name');
    }
    names.add(name);
    expandedBytes += uncompressedBytes;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > SANDBOX_LIMITS.expandedBytes) {
      throw uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Expanded ZIP content exceeds the limit');
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) worksheetCount += 1;
    if (/^ppt\/slides\/[^/]+\.xml$/i.test(name)) slideCount += 1;
    if (
      worksheetCount > SANDBOX_LIMITS.worksheetsOrSlides ||
      slideCount > SANDBOX_LIMITS.worksheetsOrSlides
    ) {
      throw uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Worksheet or slide count exceeds the limit');
    }
    offset = end;
  }
  if (offset !== eocdOffset) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Malformed ZIP central directory');
  }
  return Object.freeze({
    entries: totalEntries,
    expandedBytes,
    worksheetCount,
    slideCount
  });
}

function inspectContainer(extension, bytes) {
  if (['.xlsx', '.xlsm', '.docx', '.pptx'].includes(extension)) {
    return inspectZipArchive(bytes);
  }
  if (extension === '.pdf') {
    const pageCount = (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    if (pageCount > SANDBOX_LIMITS.pdfPages) {
      throw uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'PDF page count exceeds the limit');
    }
  }
  return null;
}

function decodeMultipartBody({ route, contentType, rawBody }) {
  if (!route || !UPLOAD_ROUTES.includes(route)) {
    return Promise.reject(uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Unknown upload route'));
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length > route.limits.rawBodyBytes) {
    return Promise.reject(uploadError(
      413,
      'UPLOAD_LIMIT_EXCEEDED',
      'Upload envelope exceeds the request limit'
    ));
  }
  if (typeof contentType !== 'string') {
    return Promise.reject(uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid multipart request'));
  }

  return new Promise((resolve, reject) => {
    let parser;
    try {
      const Busboy = require('busboy');
      parser = Busboy({
        headers: { 'content-type': contentType },
        defParamCharset: 'utf8',
        preservePath: true,
        limits: {
          fileSize: route.limits.fileBytes,
          files: route.limits.files,
          fields: route.limits.fields,
          parts: route.limits.parts,
          fieldSize: route.limits.fieldBytes
        }
      });
    } catch {
      reject(uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid multipart request'));
      return;
    }

    const fields = [];
    const files = [];
    const seenNames = new Set();
    let settled = false;
    let terminalError = null;

    function fail(error) {
      if (terminalError) return;
      terminalError = error instanceof UploadSandboxError
        ? error
        : uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid multipart request');
    }

    function duplicateOrUnknown(name, accepted) {
      const normalized = normalizedText(name, 'multipart field name');
      if (!accepted.has(normalized) || seenNames.has(normalized)) {
        throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid multipart field');
      }
      seenNames.add(normalized);
      return normalized;
    }

    parser.on('field', (name, value, info) => {
      try {
        if (info && (info.nameTruncated || info.valueTruncated)) {
          throw uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Upload field exceeds the request limit');
        }
        const normalizedName = duplicateOrUnknown(name, new Set(route.textFields));
        fields.push({
          name: normalizedName,
          occurrence: 0,
          value: normalizedText(value, 'multipart field value')
        });
      } catch (error) {
        fail(error);
      }
    });

    parser.on('file', (name, stream, info) => {
      let normalizedName;
      let basename;
      let mime;
      try {
        normalizedName = duplicateOrUnknown(name, new Set([route.fileField]));
        basename = safeBasename(info && info.filename);
        mime = normalizeMime(info && info.mimeType);
        if (!mime) throw uploadError(415, 'UPLOAD_UNSUPPORTED_TYPE', 'Unsupported upload type');
        assertMimeAndExtension(route, basename, mime);
      } catch (error) {
        fail(error);
        stream.resume();
        return;
      }

      const chunks = [];
      let length = 0;
      let limited = false;
      stream.on('limit', () => {
        limited = true;
        fail(uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Upload file exceeds the request limit'));
      });
      stream.on('data', (chunk) => {
        if (terminalError || limited) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > route.limits.fileBytes) {
          limited = true;
          fail(uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Upload file exceeds the request limit'));
          return;
        }
        chunks.push(bytes);
      });
      stream.on('end', () => {
        if (terminalError || limited) return;
        if (length === 0) {
          fail(uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Upload file is empty'));
          return;
        }
        const buffer = Buffer.concat(chunks, length);
        try {
          assertMagicBytes(path.extname(basename).toLowerCase(), buffer);
        } catch (error) {
          fail(error);
          return;
        }
        files.push({
          fieldName: normalizedName,
          occurrence: 0,
          basename,
          mime,
          length,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
          buffer
        });
      });
    });

    parser.on('filesLimit', () => fail(uploadError(
      413,
      'UPLOAD_LIMIT_EXCEEDED',
      'Upload contains too many files'
    )));
    parser.on('fieldsLimit', () => fail(uploadError(
      413,
      'UPLOAD_LIMIT_EXCEEDED',
      'Upload contains too many fields'
    )));
    parser.on('partsLimit', () => fail(uploadError(
      413,
      'UPLOAD_LIMIT_EXCEEDED',
      'Upload contains too many parts'
    )));
    parser.on('error', () => fail(uploadError(
      400,
      'UPLOAD_INVALID_CONTENT',
      'Invalid multipart request'
    )));
    parser.on('close', () => {
      if (settled) return;
      settled = true;
      if (terminalError) return reject(terminalError);
      if (files.length !== 1 || !seenNames.has(route.fileField)) {
        return reject(uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Exactly one upload file is required'));
      }
      return resolve(Object.freeze({
        route,
        fields: Object.freeze(fields.map(Object.freeze)),
        files: Object.freeze(files.map(Object.freeze))
      }));
    });

    Readable.from([rawBody]).pipe(parser);
  });
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}

function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
}

function canonicalPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new TypeError('Invalid request path');
  }
  const rawPath = value.split(/[?#]/, 1)[0];
  return rawPath.split('/').map((segment, index) => {
    if (index === 0) return '';
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new TypeError('Invalid request path');
    }
    return encodeURIComponent(decoded).replace(/[!'()*]/g, (character) => (
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ));
  }).join('/');
}

function multipartPayload(multipart) {
  if (!multipart || !Array.isArray(multipart.fields) || !Array.isArray(multipart.files)) {
    throw new TypeError('Invalid multipart value');
  }
  const records = [];
  for (const field of multipart.fields) {
    records.push({
      name: field.name,
      kind: 0,
      occurrence: field.occurrence,
      bytes: Buffer.concat([
        frame('text'),
        frame(field.name),
        frame(String(field.occurrence)),
        frame(field.value)
      ])
    });
  }
  for (const file of multipart.files) {
    if (!HEX_64.test(file.sha256)) throw new TypeError('Invalid multipart file digest');
    records.push({
      name: file.fieldName,
      kind: 1,
      occurrence: file.occurrence,
      bytes: Buffer.concat([
        frame('file'),
        frame(file.fieldName),
        frame(String(file.occurrence)),
        frame(file.basename),
        frame(file.mime),
        frame(String(file.length)),
        frame(file.sha256)
      ])
    });
  }
  records.sort((left, right) => (
    Buffer.from(left.name, 'utf8').compare(Buffer.from(right.name, 'utf8')) ||
    left.kind - right.kind ||
    left.occurrence - right.occurrence
  ));
  return Buffer.concat([u32(records.length), ...records.map((record) => record.bytes)]);
}

function hashMultipartRequest({ method, path: requestPath, campaignId, multipart }) {
  const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : '';
  if (!/^(?:DELETE|GET|HEAD|PATCH|POST|PUT)$/.test(normalizedMethod)) {
    throw new TypeError('Invalid request method');
  }
  const campaign = campaignId === null || campaignId === undefined || campaignId === ''
    ? ''
    : String(campaignId);
  if (campaign !== '' && (!/^[1-9][0-9]*$/.test(campaign) || !Number.isSafeInteger(Number(campaign)))) {
    throw new TypeError('Invalid campaign ID');
  }
  const bytes = Buffer.concat([
    frame('tm-request-v1'),
    frame(normalizedMethod),
    frame(canonicalPath(requestPath)),
    frame(campaign),
    frame('multipart'),
    frame(multipartPayload(multipart))
  ]);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parserAdmissionHash({ organizationId, userId, method, path: requestPath, requestId }) {
  const values = [organizationId, userId];
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Invalid parser admission principal');
  }
  const normalizedRequestId = normalizedText(requestId, 'request ID');
  if (normalizedRequestId.length < 1 || normalizedRequestId.length > 128) {
    throw new TypeError('Invalid parser admission request ID');
  }
  return crypto.createHash('sha256').update(Buffer.concat([
    frame('tm-parser-admission-v1'),
    frame(String(organizationId)),
    frame(String(userId)),
    frame(String(method).toUpperCase()),
    frame(canonicalPath(requestPath)),
    frame(normalizedRequestId)
  ])).digest('hex');
}

function safeNumber(value, label) {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return number;
}

async function defaultInspectSpoolBytes(root) {
  let total = 0;
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) {
        throw uploadError(507, 'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED', 'Parser spool is not safe');
      }
      if (stat.isDirectory()) {
        await visit(target);
      } else if (stat.isFile()) {
        total += stat.size;
        if (!Number.isSafeInteger(total)) {
          throw uploadError(507, 'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED', 'Parser spool is too large');
        }
      } else {
        throw uploadError(507, 'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED', 'Parser spool is not safe');
      }
    }
  }
  await visit(root);
  return total;
}

function withImmediateTransaction(db, callback) {
  if (!db || typeof db.exec !== 'function' || db.inTransaction) {
    throw new TypeError('Parser admission requires an idle database connection');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = callback();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      if (db.inTransaction) db.exec('ROLLBACK');
    } catch {
      // Preserve the original fail-closed error.
    }
    throw error;
  }
}

function activeParserAdmissions(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS active_count
    FROM request_idempotency
    WHERE scope IN (
      'parser.knowledge-upload.admission',
      'parser.influencer-upload.admission',
      'parser.demand-parse.admission'
    )
      AND state='processing'
      AND datetime(operation_deadline)>CURRENT_TIMESTAMP
  `).get();
  return safeNumber(row && row.active_count, 'active parser admission count');
}

async function assertSpoolCapacity(options, activeCount) {
  const observedBytes = safeNumber(
    await options.inspectSpoolBytes(options.spoolRoot),
    'parser spool byte count'
  );
  const stat = await options.statfs(options.spoolRoot);
  const availableBytes = safeNumber(stat && stat.bavail, 'parser spool available blocks') *
    safeNumber(stat && stat.bsize, 'parser spool block size');
  if (!Number.isSafeInteger(availableBytes)) {
    throw uploadError(
      507,
      'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED',
      'Parser spool capacity could not be measured safely'
    );
  }
  const reservedBytes = activeCount * SANDBOX_LIMITS.reservationBytes;
  const projectedBytes = Math.max(observedBytes, reservedBytes) + SANDBOX_LIMITS.reservationBytes;
  if (
    projectedBytes > SANDBOX_LIMITS.spoolBytes ||
    availableBytes - SANDBOX_LIMITS.reservationBytes < SANDBOX_LIMITS.freeFloorBytes
  ) {
    throw uploadError(
      507,
      'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED',
      'Parser spool capacity was reached'
    );
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, fs.constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'EPERM'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (handle) await handle.close();
  }
}

async function assertDirectory(target, expectedMode, expected = {}) {
  const stat = await fsp.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw uploadError(500, 'UPLOAD_INVALID_CONTENT', 'Parser job directory is invalid');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== expectedMode) {
    throw uploadError(500, 'UPLOAD_INVALID_CONTENT', 'Parser job directory permissions are invalid');
  }
  if (
    process.platform === 'linux' && (
      expected.uid !== undefined && stat.uid !== expected.uid ||
      expected.gid !== undefined && stat.gid !== expected.gid ||
      expected.dev !== undefined && stat.dev !== expected.dev
    )
  ) {
    throw uploadError(500, 'UPLOAD_INVALID_CONTENT', 'Parser job directory ownership is invalid');
  }
  return stat;
}

async function writeExclusiveFile(target, bytes, mode) {
  const flags = fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(target, flags, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length) {
      throw uploadError(500, 'UPLOAD_INVALID_CONTENT', 'Parser job file is invalid');
    }
  } finally {
    await handle.close();
  }
}

async function writeStagedResultFile(target, bytes) {
  const flags = fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fsp.open(target, flags);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== 0 ||
      process.platform !== 'win32' && (before.mode & 0o777) !== 0o600
    ) {
      throw uploadError(500, 'UPLOAD_INVALID_CONTENT', 'Parser result target is invalid');
    }
    await handle.writeFile(bytes);
    await handle.truncate(bytes.length);
    await handle.sync();
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== bytes.length ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      process.platform !== 'win32' && (after.mode & 0o777) !== 0o600
    ) {
      throw uploadError(500, 'UPLOAD_INVALID_CONTENT', 'Parser result target changed');
    }
  } finally {
    if (handle) await handle.close();
  }
}

async function readRegularNoFollow(target, maxBytes) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fsp.open(target, flags);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser output is invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.nlink !== 1
    ) {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser output changed during validation');
    }
    return {
      bytes,
      stat: after,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    };
  } catch (error) {
    if (error instanceof UploadSandboxError) throw error;
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser output is invalid');
  } finally {
    if (handle) await handle.close();
  }
}

function exactObject(value, keys) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

async function inspectResultMetadata(target) {
  if (process.platform === 'linux') {
    try {
      const result = await runCommandNoDisclosure('/usr/bin/python3', [
        '-I',
        '-c',
        RESULT_METADATA_PROBE_SOURCE,
        target
      ], {
        captureStdout: true,
        timeoutMs: 2_000,
        env: safeControllerEnvironment()
      });
      return JSON.parse(result.stdout);
    } catch {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result metadata is invalid');
    }
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fsp.open(target, flags);
    const value = await handle.stat();
    return {
      isRegular: value.isFile(),
      dev: value.dev,
      ino: value.ino,
      uid: value.uid,
      gid: value.gid,
      mode: value.mode & 0o777,
      nlink: value.nlink,
      size: value.size,
      mtimeMs: value.mtimeMs,
      ctimeMs: value.ctimeMs,
      xattrs: []
    };
  } catch (error) {
    if (error instanceof UploadSandboxError) throw error;
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result metadata is invalid');
  } finally {
    if (handle) await handle.close();
  }
}

async function validateParserOutput(outputRoot, options = {}) {
  await assertDirectory(outputRoot, 0o550);
  const entries = await fsp.readdir(outputRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    !sameValue(names, PARSER_OUTPUT_ENTRIES) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser output contains unexpected entries');
  }
  const manifestPath = path.join(outputRoot, 'manifest.json');
  const firstManifest = await readRegularNoFollow(manifestPath, 4_096);
  let manifest;
  try {
    manifest = JSON.parse(firstManifest.bytes.toString('utf8'));
  } catch {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser output manifest is invalid');
  }
  if (
    !firstManifest.bytes.equals(PARSER_OUTPUT_MANIFEST_BYTES) ||
    !sameValue(manifest, PARSER_OUTPUT_MANIFEST)
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser output manifest is invalid');
  }

  const resultPath = path.join(outputRoot, PARSER_OUTPUT_MANIFEST.files[0].path);
  if (path.dirname(path.resolve(resultPath)) !== path.resolve(outputRoot)) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser output escaped its root');
  }
  const first = await readRegularNoFollow(resultPath, SANDBOX_LIMITS.outputBytes);
  const second = await readRegularNoFollow(resultPath, SANDBOX_LIMITS.outputBytes);
  if (
    second.sha256 !== first.sha256 ||
    second.bytes.length !== first.bytes.length ||
    second.stat.dev !== first.stat.dev ||
    second.stat.ino !== first.stat.ino
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser output changed during validation');
  }
  const expectedKeys = ['dev', 'ino', 'uid', 'gid', 'mode', 'lifecycleStartedMs'];
  const suppliedExpected = options.expectedResultMetadata;
  if (suppliedExpected !== undefined && !exactObject(suppliedExpected, expectedKeys)) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result metadata contract is invalid');
  }
  const now = options.now || Date.now;
  const nowMs = now();
  const expected = suppliedExpected || {
    dev: second.stat.dev,
    ino: second.stat.ino,
    uid: second.stat.uid,
    gid: second.stat.gid,
    mode: process.platform === 'linux' ? 0o600 : second.stat.mode & 0o777,
    lifecycleStartedMs: nowMs - SANDBOX_LIMITS.parserSeconds * 1_000
  };
  if (
    !Number.isFinite(nowMs) ||
    expectedKeys.some((key) => !Number.isFinite(expected[key])) ||
    expected.mode !== (process.platform === 'linux' ? 0o600 : expected.mode)
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result metadata contract is invalid');
  }
  const metadataInspector = options.inspectResultMetadata || inspectResultMetadata;
  let metadata;
  try {
    metadata = await metadataInspector(resultPath);
  } catch (error) {
    if (error instanceof UploadSandboxError) throw error;
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result metadata is invalid');
  }
  const metadataKeys = [
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
  ];
  const earliestTimestamp = expected.lifecycleStartedMs - RESULT_TIMESTAMP_TOLERANCE_MS;
  const latestTimestamp = nowMs + RESULT_TIMESTAMP_TOLERANCE_MS;
  if (
    !exactObject(metadata, metadataKeys) ||
    metadata.isRegular !== true ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino ||
    metadata.uid !== expected.uid ||
    metadata.gid !== expected.gid ||
    metadata.mode !== expected.mode ||
    metadata.nlink !== 1 ||
    metadata.size !== second.bytes.length ||
    metadata.dev !== second.stat.dev ||
    metadata.ino !== second.stat.ino ||
    !Number.isFinite(metadata.mtimeMs) ||
    !Number.isFinite(metadata.ctimeMs) ||
    metadata.mtimeMs < earliestTimestamp ||
    metadata.mtimeMs > latestTimestamp ||
    metadata.ctimeMs < earliestTimestamp ||
    metadata.ctimeMs > latestTimestamp ||
    !Array.isArray(metadata.xattrs) ||
    metadata.xattrs.length !== 0
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result metadata is invalid');
  }
  let result;
  try {
    result = JSON.parse(second.bytes.toString('utf8'));
  } catch {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result is invalid');
  }
  if (
    !exactObject(result, ['version', 'route', 'data']) ||
    result.version !== 1 ||
    !UPLOAD_ROUTES.some((route) => route.id === result.route) ||
    result.data === null ||
    typeof result.data !== 'object' ||
    Array.isArray(result.data)
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result is invalid');
  }
  return result;
}

function parseWorkerArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 9 ||
    argv[0] !== 'worker' ||
    argv[1] !== '--job-id' ||
    argv[3] !== '--request' ||
    argv[5] !== '--input' ||
    argv[7] !== '--output-root' ||
    !/^[0-9a-f]{32}$/.test(argv[2])
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser worker invocation');
  }
  const values = {
    jobId: argv[2],
    requestPath: path.resolve(argv[4]),
    inputPath: path.resolve(argv[6]),
    outputRoot: path.resolve(argv[8])
  };
  if (
    path.basename(values.requestPath) !== 'request.json' ||
    path.basename(values.inputPath) !== 'input.bin' ||
    path.basename(values.outputRoot) !== 'output'
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser worker mount');
  }
  return values;
}

function jsonBytes(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser result is not serializable');
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length < 1 || bytes.length > SANDBOX_LIMITS.outputBytes) {
    throw uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Extracted parser output exceeds the limit');
  }
  return bytes;
}

function decodeMountInfoPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function parseMountInfo(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser mount inventory is invalid');
  }
  const lines = value.split('\n').filter(Boolean);
  if (lines.length < 1 || lines.length > 4096) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser mount inventory is invalid');
  }
  return lines.map((line) => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    const mountId = Number(fields[0]);
    const mountPoint = fields.length > 5 ? decodeMountInfoPath(fields[4]) : '';
    const mountOptions = fields.length > 5 ? fields[5].split(',') : [];
    if (
      separator < 6 ||
      separator + 3 >= fields.length ||
      !Number.isSafeInteger(mountId) || mountId <= 0 ||
      !mountPoint.startsWith('/') || mountPoint.includes('\0') ||
      (!mountOptions.includes('rw') && !mountOptions.includes('ro')) ||
      (mountOptions.includes('rw') && mountOptions.includes('ro'))
    ) {
      throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser mount inventory is invalid');
    }
    return Object.freeze({
      mountId,
      mountPoint,
      writable: mountOptions.includes('rw')
    });
  });
}

function expectedWriteDenial(error) {
  return error && [
    'EACCES',
    'EPERM',
    'EROFS',
    'ENOENT',
    'ENOTDIR',
    'ELOOP',
    'ENXIO',
    'ENODEV',
    'EINVAL',
    'EOPNOTSUPP'
  ].includes(error.code);
}

async function readMountInfo() {
  const handle = await fsp.open(
    '/proc/self/mountinfo',
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > 1024 * 1024) {
        throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser mount inventory is invalid');
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function inspectHostSocketPath(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
}

async function probeSocketIsolation() {
  if (process.platform !== 'linux') {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Linux socket isolation probe is required');
  }
  let evidence;
  try {
    const result = await runCommandNoDisclosure('/usr/bin/python3', [
      '-I',
      '-c',
      SOCKET_PROBE_SOURCE
    ], {
      captureStdout: true,
      timeoutMs: 2_000,
      env: safeControllerEnvironment()
    });
    evidence = JSON.parse(result.stdout);
  } catch {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser socket isolation probe failed');
  }
  if (
    !Array.isArray(evidence) ||
    evidence.length !== SOCKET_DENIAL_OPERATIONS.length ||
    evidence.some((item, index) => (
      !exactObject(item, ['operation', 'errno']) ||
      item.operation !== SOCKET_DENIAL_OPERATIONS[index] ||
      !SOCKET_POLICY_DENIAL_ERRORS.includes(item.errno)
    ))
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser socket isolation contract failed');
  }
  return Object.freeze(evidence.map((item) => Object.freeze({ ...item })));
}

async function probeAioIsolation() {
  if (process.platform !== 'linux') {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Linux AIO isolation probe is required');
  }
  let evidence;
  try {
    const result = await runCommandNoDisclosure('/usr/bin/python3', [
      '-I',
      '-c',
      AIO_PROBE_SOURCE
    ], {
      captureStdout: true,
      timeoutMs: 2_000,
      env: safeControllerEnvironment()
    });
    evidence = JSON.parse(result.stdout);
  } catch {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser AIO isolation probe failed');
  }
  if (
    !Array.isArray(evidence) ||
    evidence.length !== AIO_DENIAL_OPERATIONS.length ||
    evidence.some((item, index) => (
      !exactObject(item, ['operation', 'errno']) ||
      item.operation !== AIO_DENIAL_OPERATIONS[index] ||
      item.errno !== 'EPERM'
    ))
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser AIO isolation contract failed');
  }
  return Object.freeze(evidence.map((item) => Object.freeze({ ...item })));
}

async function inspectPidNamespace() {
  if (process.platform !== 'linux') {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Linux PID namespace proof is required');
  }
  const visiblePids = (await fsp.readdir('/proc', { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[0-9]+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);
  return Object.freeze({
    contract: PID_NAMESPACE_CONTRACT,
    self_pid: process.pid,
    visible_pids: Object.freeze(visiblePids)
  });
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPeerPid(requestPath, jobId, initialRequest) {
  const deadline = Date.now() + 8_000;
  let candidate = initialRequest;
  while (Date.now() < deadline) {
    if (
      exactObject(candidate, ['version', 'job_id', 'self_test', 'peer_pid']) &&
      candidate.version === 1 &&
      candidate.job_id === jobId &&
      candidate.self_test === PID_NAMESPACE_PEER_SELF_TEST &&
      Number.isSafeInteger(candidate.peer_pid) &&
      candidate.peer_pid > 1
    ) {
      return candidate.peer_pid;
    }
    await pause(50);
    try {
      const requestFile = await readRegularNoFollow(requestPath, 65_536);
      candidate = JSON.parse(requestFile.bytes.toString('utf8'));
    } catch {
      candidate = null;
    }
  }
  throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Sibling PID namespace probe timed out');
}

async function probeSiblingPidIsolation(peerPid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(peerPid) || peerPid <= 1) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Sibling PID namespace probe is invalid');
  }
  const peerRoot = `/proc/${peerPid}`;
  const operations = [
    ['peer_proc_visibility', async () => fsp.lstat(peerRoot)],
    ['peer_fd_directory_visibility', async () => fsp.readdir(`${peerRoot}/fd`)],
    ['peer_fd_read_open', async () => {
      const handle = await fsp.open(
        `${peerRoot}/fd/0`,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      await handle.close();
    }],
    ['peer_fd_write_open', async () => {
      const handle = await fsp.open(
        `${peerRoot}/fd/1`,
        fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      await handle.close();
    }]
  ];
  const evidence = [];
  for (const [operation, probe] of operations) {
    let code = 'ALLOWED';
    try {
      await probe();
    } catch (error) {
      code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    }
    evidence.push(Object.freeze({ operation, errno: code }));
  }
  if (evidence.some((item) => !['ENOENT', 'ESRCH'].includes(item.errno))) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Sibling PID namespace isolation failed');
  }
  const namespace = await inspectPidNamespace();
  if (namespace.self_pid !== 1 || !sameValue(namespace.visible_pids, [1])) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Sibling PID namespace isolation failed');
  }
  return Object.freeze({
    contract: PID_NAMESPACE_PEER_CONTRACT,
    peer_pid: peerPid,
    self_pid: namespace.self_pid,
    visible_pids: namespace.visible_pids,
    evidence: Object.freeze(evidence)
  });
}

async function probeDirectoryWritable(target) {
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (expectedWriteDenial(error)) return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  const marker = path.posix.join(
    target,
    `.tm-parser-write-probe-${crypto.randomBytes(16).toString('hex')}`
  );
  const flags = fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0);
  let handle;
  let created = false;
  try {
    handle = await fsp.open(marker, flags, 0o600);
    created = true;
    const createdStat = await handle.stat();
    if (!createdStat.isFile() || createdStat.nlink !== 1) {
      throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser write probe is invalid');
    }
    return true;
  } catch (error) {
    if (!created && expectedWriteDenial(error)) return false;
    throw error;
  } finally {
    if (handle) await handle.close();
    if (created) await fsp.unlink(marker);
  }
}

async function probeExistingFileWritable(target) {
  const flags = fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fsp.open(target, flags);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser result inode is invalid');
    }
    return true;
  } catch (error) {
    if (!handle && expectedWriteDenial(error)) return false;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function auditWritableFilesystem(options = {}) {
  const mountInfoText = options.mountInfoText === undefined
    ? await readMountInfo()
    : options.mountInfoText;
  const entries = parseMountInfo(mountInfoText);
  const topMountByPath = new Map();
  for (const entry of entries) {
    const current = topMountByPath.get(entry.mountPoint);
    if (!current || entry.mountId > current.mountId) {
      topMountByPath.set(entry.mountPoint, entry);
    }
  }
  const rwMountPoints = [...topMountByPath.values()]
    .filter((entry) => entry.writable)
    .map((entry) => entry.mountPoint)
    .sort();
  const pidInspector = options.inspectPidNamespace || inspectPidNamespace;
  const pidNamespace = await pidInspector();
  if (
    !exactObject(pidNamespace, ['contract', 'self_pid', 'visible_pids']) ||
    pidNamespace.contract !== PID_NAMESPACE_CONTRACT ||
    pidNamespace.self_pid !== 1 ||
    !sameValue(pidNamespace.visible_pids, [1])
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser PID namespace contract failed');
  }
  const hostLogSocketMounts = HOST_LOG_SOCKET_PATHS.filter((target) => (
    topMountByPath.has(target)
  ));
  const pathInspector = options.inspectHostSocketPath || inspectHostSocketPath;
  const presentHostLogSocketPaths = [];
  for (const target of HOST_LOG_SOCKET_PATHS) {
    if (await pathInspector(target)) presentHostLogSocketPaths.push(target);
  }
  if (hostLogSocketMounts.length > 0 || presentHostLogSocketPaths.length > 0) {
    throw uploadError(
      500,
      'UPLOAD_SANDBOX_NOT_READY',
      'Parser host log socket isolation contract failed'
    );
  }
  const socketProbe = options.probeSocketIsolation || probeSocketIsolation;
  const socketDenialEvidence = await socketProbe();
  if (
    !Array.isArray(socketDenialEvidence) ||
    socketDenialEvidence.length !== SOCKET_DENIAL_OPERATIONS.length ||
    socketDenialEvidence.some((item, index) => (
      !exactObject(item, ['operation', 'errno']) ||
      item.operation !== SOCKET_DENIAL_OPERATIONS[index] ||
      !SOCKET_POLICY_DENIAL_ERRORS.includes(item.errno)
    ))
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser socket isolation contract failed');
  }
  const frozenSocketEvidence = Object.freeze(
    socketDenialEvidence.map((item) => Object.freeze({ ...item }))
  );
  const aioProbe = options.probeAioIsolation || probeAioIsolation;
  const aioDenialEvidence = await aioProbe();
  if (
    !Array.isArray(aioDenialEvidence) ||
    aioDenialEvidence.length !== AIO_DENIAL_OPERATIONS.length ||
    aioDenialEvidence.some((item, index) => (
      !exactObject(item, ['operation', 'errno']) ||
      item.operation !== AIO_DENIAL_OPERATIONS[index] ||
      item.errno !== 'EPERM'
    ))
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser AIO isolation contract failed');
  }
  const frozenAioEvidence = Object.freeze(
    aioDenialEvidence.map((item) => Object.freeze({ ...item }))
  );
  const directoryProbe = options.probeDirectoryWritable || probeDirectoryWritable;
  const fileProbe = options.probeExistingFileWritable || probeExistingFileWritable;
  const unexpected = new Set();
  let scratchWritable = false;
  let resultWritable = false;

  for (const mountPoint of rwMountPoints) {
    if (mountPoint === '/output/result.json') {
      resultWritable = await fileProbe(mountPoint);
      if (!resultWritable) unexpected.add(mountPoint);
      continue;
    }
    const writable = await directoryProbe(mountPoint);
    if (mountPoint === '/scratch') {
      scratchWritable = writable;
      if (!writable) unexpected.add(mountPoint);
    } else if (writable) {
      unexpected.add(mountPoint);
    }
  }
  for (const target of DENIED_WRITE_PATHS) {
    if (await directoryProbe(target)) unexpected.add(target);
  }
  if (
    !scratchWritable ||
    !resultWritable ||
    unexpected.size > 0 ||
    !topMountByPath.has('/scratch') ||
    !topMountByPath.has('/output/result.json')
  ) {
    throw uploadError(
      500,
      'UPLOAD_SANDBOX_NOT_READY',
      'Parser writable filesystem contract failed'
    );
  }
  return Object.freeze({
    version: 1,
    contract: WRITABLE_FILESYSTEM_CONTRACT,
    socket_contract: SOCKET_ISOLATION_CONTRACT,
    mount_info_sha256: crypto.createHash('sha256').update(mountInfoText).digest('hex'),
    allowed_writable_paths: ALLOWED_WRITABLE_PATHS,
    denied_write_paths: DENIED_WRITE_PATHS,
    unexpected_writable_paths: Object.freeze([]),
    audited_rw_mounts: rwMountPoints.length,
    host_log_socket_paths: HOST_LOG_SOCKET_PATHS,
    present_host_log_socket_paths: Object.freeze([]),
    host_log_socket_mounts: Object.freeze([]),
    socket_denial_evidence: frozenSocketEvidence,
    aio_denial_evidence: frozenAioEvidence,
    pid_namespace: Object.freeze({
      contract: pidNamespace.contract,
      self_pid: pidNamespace.self_pid,
      visible_pids: Object.freeze([...pidNamespace.visible_pids])
    })
  });
}

function parserFallbackText(file, reason) {
  return [
    `File name: ${file.basename}`,
    `File size: ${file.length} bytes`,
    reason ? `Parser note: ${reason}` : '',
    'The file could not be fully parsed. Confirm missing product, market, budget, platform, and campaign requirements.'
  ].filter(Boolean).join('\n');
}

async function runWorkerPython(scriptName, inputPath, timeoutMs) {
  const scriptPath = path.join(__dirname, '..', scriptName);
  const python = process.platform === 'linux'
    ? '/usr/bin/python3'
    : (process.env.PYTHON_BIN || 'python');
  const result = await runCommandNoDisclosure(python, [scriptPath, inputPath], {
    captureStdout: true,
    timeoutMs,
    env: {
      ...(process.platform === 'win32' ? { PATH: process.env.PATH || '' } : {}),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TMPDIR: process.platform === 'linux' ? '/scratch' : (process.env.TMPDIR || ''),
      TMP: process.platform === 'linux' ? '/scratch' : (process.env.TMP || ''),
      TEMP: process.platform === 'linux' ? '/scratch' : (process.env.TEMP || ''),
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1'
    }
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Document parser output is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Document parser output is invalid');
  }
  return parsed;
}

async function parseDemandWorkerFile(filePath, file) {
  const extension = path.extname(file.basename).toLowerCase();
  if (['.txt', '.md', '.csv', '.json'].includes(extension)) {
    return {
      text: (await fsp.readFile(filePath)).toString('utf8'),
      parser: 'plain-text',
      fallback: false,
      warnings: [],
      needsOcr: false,
      ocrUsed: false
    };
  }

  const scratchRoot = process.platform === 'linux'
    ? '/scratch'
    : path.dirname(filePath);
  const scratchPath = path.join(scratchRoot, `source${extension}`);
  await fsp.copyFile(filePath, scratchPath, fs.constants.COPYFILE_EXCL);
  try {
    if (['.xlsx', '.xlsm'].includes(extension)) {
      const parsed = await runWorkerPython('extract_xlsx_text.py', scratchPath, 20_000);
      const text = String(parsed.text || '').trim();
      return {
        text: text || parserFallbackText(file, 'xlsx parser returned no text'),
        parser: parsed.parser || 'xlsx-openxml',
        fallback: !text,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        needsOcr: false,
        ocrUsed: false
      };
    }
    if (['.pdf', '.docx', '.pptx'].includes(extension)) {
      const parsed = await runWorkerPython('extract_document_text.py', scratchPath, 20_000);
      const text = String(parsed.text || '').trim();
      return {
        text: text || parserFallbackText(file, 'document parser returned no text'),
        parser: parsed.parser || 'document',
        fallback: !text,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        needsOcr: Boolean(parsed.needs_ocr || parsed.needsOcr),
        ocrUsed: false
      };
    }
    if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'].includes(extension)) {
      try {
        const parsed = await runWorkerPython('ocr_document_text.py', scratchPath, 20_000);
        const text = String(parsed.text || '').trim();
        return {
          text: text || parserFallbackText(file, 'Image file requires OCR or pasted text context.'),
          parser: parsed.parser || 'image-ocr',
          fallback: !text,
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
          needsOcr: !text,
          ocrUsed: Boolean(text)
        };
      } catch {
        return {
          text: parserFallbackText(file, 'Image file requires OCR or pasted text context.'),
          parser: 'image-ocr',
          fallback: true,
          warnings: ['Local OCR failed'],
          needsOcr: true,
          ocrUsed: false
        };
      }
    }
    throw uploadError(415, 'UPLOAD_UNSUPPORTED_TYPE', 'Upload type is not supported');
  } finally {
    await fsp.unlink(scratchPath).catch(() => {});
  }
}

async function parseWorkerFile(route, filePath, file) {
  const extension = path.extname(file.basename).toLowerCase();
  const descriptor = {
    path: filePath,
    originalname: file.basename,
    mimetype: file.mime,
    size: file.length
  };
  if (
    route.id === 'parser.demand-parse' ||
    ['.pdf', '.docx', '.pptx', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']
      .includes(extension)
  ) {
    const parsed = await parseDemandWorkerFile(filePath, file);
    if (Buffer.byteLength(String(parsed.text || ''), 'utf8') > SANDBOX_LIMITS.outputBytes) {
      throw uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Extracted parser output exceeds the limit');
    }
    return parsed;
  }
  const parsed = await require('./file_ingest_service').readUploadedFile(descriptor);
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  if (rows.length > SANDBOX_LIMITS.rows) {
    throw uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Parsed row count exceeds the limit');
  }
  let cells = 0;
  for (const row of rows) {
    cells += row && typeof row === 'object' ? Object.keys(row).length : 0;
    if (cells > SANDBOX_LIMITS.cells) {
      throw uploadError(413, 'UPLOAD_LIMIT_EXCEEDED', 'Parsed cell count exceeds the limit');
    }
  }
  return parsed;
}

async function workerMain(argv) {
  const input = parseWorkerArguments(argv);
  await assertDirectory(input.outputRoot, 0o550);
  const outputEntries = await fsp.readdir(input.outputRoot, { withFileTypes: true });
  if (
    !sameValue(outputEntries.map((entry) => entry.name).sort(), PARSER_OUTPUT_ENTRIES) ||
    outputEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser output layout');
  }
  const outputManifest = await readRegularNoFollow(
    path.join(input.outputRoot, 'manifest.json'),
    4_096
  );
  if (!outputManifest.bytes.equals(PARSER_OUTPUT_MANIFEST_BYTES)) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser output layout');
  }
  const requestFile = await readRegularNoFollow(input.requestPath, 65_536);
  let request;
  try {
    request = JSON.parse(requestFile.bytes.toString('utf8'));
  } catch {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser job request');
  }
  const realUnitMounts = process.platform === 'linux' &&
    input.requestPath === '/runtime/request.json' &&
    input.inputPath === '/input/input.bin' &&
    input.outputRoot === '/output';
  const writableFilesystemProof = realUnitMounts
    ? await auditWritableFilesystem()
    : null;
  if (
    exactObject(request, ['version', 'job_id', 'self_test', 'peer_pid']) &&
    request.version === 1 &&
    request.job_id === input.jobId &&
    request.self_test === PID_NAMESPACE_PEER_SELF_TEST &&
    Number.isSafeInteger(request.peer_pid) &&
    request.peer_pid >= 0
  ) {
    if (!writableFilesystemProof) {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser self-test request');
    }
    const peerPid = await waitForPeerPid(input.requestPath, input.jobId, request);
    const siblingProof = await probeSiblingPidIsolation(peerPid);
    await pause(3_000);
    const resultBytes = jsonBytes({
      version: 1,
      route: 'parser.sandbox-self-test',
      data: {
        ...writableFilesystemProof,
        sibling_pid_isolation: siblingProof
      }
    });
    const resultSha256 = crypto.createHash('sha256').update(resultBytes).digest('hex');
    await writeStagedResultFile(path.join(input.outputRoot, 'result.json'), resultBytes);
    await fsyncDirectory(input.outputRoot);
    return { bytes: resultBytes.length, sha256: resultSha256 };
  }
  if (
    exactObject(request, ['version', 'job_id', 'self_test']) &&
    request.version === 1 &&
    request.job_id === input.jobId &&
    request.self_test === WRITABLE_FILESYSTEM_SELF_TEST
  ) {
    if (!writableFilesystemProof) {
      throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser self-test request');
    }
    const resultBytes = jsonBytes({
      version: 1,
      route: 'parser.sandbox-self-test',
      data: writableFilesystemProof
    });
    const resultSha256 = crypto.createHash('sha256').update(resultBytes).digest('hex');
    await writeStagedResultFile(path.join(input.outputRoot, 'result.json'), resultBytes);
    await fsyncDirectory(input.outputRoot);
    return { bytes: resultBytes.length, sha256: resultSha256 };
  }
  if (
    !exactObject(request, ['version', 'job_id', 'route', 'fields', 'file']) ||
    request.version !== 1 ||
    request.job_id !== input.jobId ||
    !Array.isArray(request.fields) ||
    !exactObject(request.file, ['basename', 'mime', 'length', 'sha256'])
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser job request');
  }
  const route = UPLOAD_ROUTES.find((item) => item.id === request.route);
  if (!route) throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser job route');
  const basename = safeBasename(request.file.basename);
  const mime = normalizeMime(request.file.mime);
  const extension = assertMimeAndExtension(route, basename, mime);
  if (
    !Number.isSafeInteger(request.file.length) ||
    request.file.length < 1 ||
    request.file.length > SANDBOX_LIMITS.fileBytes ||
    !HEX_64.test(request.file.sha256)
  ) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid parser job file metadata');
  }
  const file = await readRegularNoFollow(input.inputPath, SANDBOX_LIMITS.fileBytes);
  if (file.bytes.length !== request.file.length || file.sha256 !== request.file.sha256) {
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser input digest is invalid');
  }
  assertMagicBytes(extension, file.bytes);
  inspectContainer(extension, file.bytes);
  const data = await parseWorkerFile(route, input.inputPath, request.file);
  const resultBytes = jsonBytes({ version: 1, route: route.id, data });
  const resultSha256 = crypto.createHash('sha256').update(resultBytes).digest('hex');
  await writeStagedResultFile(path.join(input.outputRoot, 'result.json'), resultBytes);
  await fsyncDirectory(input.outputRoot);
  return { bytes: resultBytes.length, sha256: resultSha256 };
}

function commandError(code, message) {
  const error = new Error(message);
  error.name = 'SandboxCommandError';
  error.code = code;
  return error;
}

function cleanupFenceError() {
  return uploadError(
    500,
    'UPLOAD_SANDBOX_CLEANUP_FAILED',
    'Parser process collection or cleanup could not be verified'
  );
}

function runCommandNoDisclosure(command, args, options = {}) {
  if (
    typeof command !== 'string' || command.length === 0 ||
    !Array.isArray(args) || !args.every((value) => typeof value === 'string')
  ) {
    return Promise.reject(new TypeError('Invalid command invocation'));
  }
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError('Invalid command timeout'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout = [];
    let child;
    try {
      child = (options.spawn || childProcess.spawn)(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env === undefined ? process.env : options.env
      });
    } catch {
      reject(commandError('COMMAND_FAILED', 'Sandbox command could not start'));
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(commandError('COMMAND_TIMEOUT', 'Sandbox command timed out'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    }

    function onAbort() {
      try { child.kill('SIGKILL'); } catch {}
      finish(commandError('COMMAND_ABORTED', 'Sandbox command was aborted'));
    }

    function onOutput(chunk, keep) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > 65_536) {
        try { child.kill('SIGKILL'); } catch {}
        finish(commandError('COMMAND_OUTPUT_LIMIT', 'Sandbox command output exceeded its limit'));
        return;
      }
      if (keep) stdout.push(bytes);
    }

    if (options.signal) {
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (child.stdout) child.stdout.on('data', (chunk) => onOutput(chunk, options.captureStdout === true));
    if (child.stderr) child.stderr.on('data', (chunk) => onOutput(chunk, false));
    child.once('error', () => finish(commandError('COMMAND_FAILED', 'Sandbox command failed')));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) {
        finish(commandError('COMMAND_FAILED', 'Sandbox command failed'));
        return;
      }
      finish(null, {
        stdout: options.captureStdout === true
          ? Buffer.concat(stdout).toString('utf8')
          : ''
      });
    });
  });
}

function safeControllerEnvironment() {
  return Object.freeze({
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  });
}

function createSystemdController(options = {}) {
  const command = options.command || '/usr/bin/systemctl';
  const env = options.env || safeControllerEnvironment();
  const run = (args, runOptions = {}) => runCommandNoDisclosure(command, args, {
    ...runOptions,
    env,
    spawn: options.spawn
  });
  return Object.freeze({
    start(unitName, startOptions = {}) {
      return run(['start', unitName], {
        signal: startOptions.signal,
        timeoutMs: startOptions.timeoutMs || 25_000
      });
    },
    kill(unitName) {
      return run(['kill', '--kill-who=all', '--signal=KILL', unitName], {
        timeoutMs: 5_000
      });
    },
    stop(unitName) {
      return run(['stop', unitName], { timeoutMs: 5_000 });
    },
    resetFailed(unitName) {
      return run(['reset-failed', unitName], { timeoutMs: 5_000 });
    },
    async assertCollected(unitName) {
      const result = await run([
        'show',
        unitName,
        '--no-pager',
        '--property=ActiveState,SubState,ControlGroup'
      ], { timeoutMs: 5_000, captureStdout: true });
      const state = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map((line) => {
        const separator = line.indexOf('=');
        return separator < 1 ? ['', ''] : [line.slice(0, separator), line.slice(separator + 1)];
      }).filter(([name]) => name));
      if (
        state.ActiveState !== 'inactive' ||
        state.SubState !== 'dead' ||
        state.ControlGroup !== ''
      ) {
        throw commandError('COMMAND_FAILED', 'Parser cgroup collection was not verified');
      }
    }
  });
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalObject(value[key]);
    return result;
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalObject(left)) === JSON.stringify(canonicalObject(right));
}

async function hashRuntimeTreeFile(target, expectedDevice, requireRootOwnership) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fsp.open(target, flags);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== expectedDevice ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      requireRootOwnership && (
        before.uid !== 0 ||
        before.gid !== 0 ||
        (before.mode & 0o022) !== 0
      )
    ) {
      throw new Error('unsafe runtime tree file');
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error('short runtime tree read');
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.nlink !== 1 ||
      (after.mode & 0o7777) !== (before.mode & 0o7777)
    ) {
      throw new Error('runtime tree file changed');
    }
    return Object.freeze({
      bytes: before.size,
      mode: before.mode & 0o7777,
      sha256: digest.digest('hex')
    });
  } finally {
    if (handle) await handle.close();
  }
}

async function inspectParserRuntimeTree(root, options = {}) {
  const runtimeRoot = path.resolve(root);
  const requireRootOwnership = options.requireRootOwnership === undefined
    ? process.platform === 'linux'
    : options.requireRootOwnership === true;
  let rootStat;
  try {
    rootStat = await fsp.lstat(runtimeRoot);
  } catch {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser runtime tree is unavailable');
  }
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    requireRootOwnership && (
      rootStat.uid !== 0 ||
      rootStat.gid !== 0 ||
      (rootStat.mode & 0o022) !== 0
    )
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser runtime tree is unsafe');
  }

  const digest = crypto.createHash('sha256');
  let files = 0;
  let directories = 1;
  let bytes = 0;
  digest.update(frame(PARSER_RUNTIME_TREE_FORMAT));
  digest.update(frame('directory'));
  digest.update(frame(''));
  digest.update(frame((rootStat.mode & 0o7777).toString(8).padStart(4, '0')));

  async function visit(directory, relativeDirectory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(
      Buffer.from(left.name, 'utf8'),
      Buffer.from(right.name, 'utf8')
    ));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const target = path.join(directory, entry.name);
      const stat = await fsp.lstat(target);
      if (
        stat.isSymbolicLink() ||
        stat.dev !== rootStat.dev ||
        requireRootOwnership && (
          stat.uid !== 0 ||
          stat.gid !== 0 ||
          (stat.mode & 0o022) !== 0
        )
      ) {
        throw new Error('unsafe runtime tree entry');
      }
      if (stat.isDirectory()) {
        directories += 1;
        digest.update(frame('directory'));
        digest.update(frame(relativePath));
        digest.update(frame((stat.mode & 0o7777).toString(8).padStart(4, '0')));
        await visit(target, relativePath);
      } else if (stat.isFile()) {
        const file = await hashRuntimeTreeFile(
          target,
          rootStat.dev,
          requireRootOwnership
        );
        files += 1;
        bytes += file.bytes;
        if (!Number.isSafeInteger(bytes)) throw new Error('runtime tree byte overflow');
        digest.update(frame('file'));
        digest.update(frame(relativePath));
        digest.update(frame(file.mode.toString(8).padStart(4, '0')));
        digest.update(frame(String(file.bytes)));
        digest.update(frame(file.sha256));
      } else {
        throw new Error('unsupported runtime tree entry');
      }
      if (files + directories > 100_000) throw new Error('runtime tree entry overflow');
    }
  }

  try {
    await visit(runtimeRoot, '');
  } catch (error) {
    if (error instanceof UploadSandboxError) throw error;
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser runtime tree is unsafe');
  }
  return Object.freeze({
    format: PARSER_RUNTIME_TREE_FORMAT,
    sha256: digest.digest('hex'),
    files,
    directories,
    bytes
  });
}

async function verifyParserRuntimeTree(root, expected, options = {}) {
  const runtimeRoot = path.resolve(root);
  const includesRoot = expected && Object.hasOwn(expected, 'root');
  const includesMetrics = expected && Object.hasOwn(expected, 'files');
  const expectedKeys = [
    'format',
    ...(includesRoot ? ['root'] : []),
    'sha256',
    ...(includesMetrics ? ['files', 'directories', 'bytes'] : [])
  ];
  if (
    !exactObject(expected, expectedKeys) ||
    expected.format !== PARSER_RUNTIME_TREE_FORMAT ||
    expected.root !== undefined && path.resolve(expected.root) !== runtimeRoot ||
    !HEX_64.test(expected.sha256) ||
    includesMetrics && (
      !Number.isSafeInteger(expected.files) || expected.files < 1 ||
      !Number.isSafeInteger(expected.directories) || expected.directories < 1 ||
      !Number.isSafeInteger(expected.bytes) || expected.bytes < 1
    )
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser runtime tree manifest is invalid');
  }
  const observed = await inspectParserRuntimeTree(runtimeRoot, options);
  const comparedKeys = includesMetrics
    ? ['format', 'sha256', 'files', 'directories', 'bytes']
    : ['format', 'sha256'];
  const projection = Object.fromEntries(comparedKeys.map((key) => [key, expected[key]]));
  const observedProjection = Object.fromEntries(
    comparedKeys.map((key) => [key, observed[key]])
  );
  if (!sameValue(observedProjection, projection)) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser runtime tree drift was detected');
  }
  return observed;
}

function routeRegistrySha256() {
  const projection = UPLOAD_ROUTES.map((route) => ({
    id: route.id,
    method: route.method,
    path: route.path,
    admission_scope: route.admissionScope,
    file_field: route.fileField,
    text_fields: [...route.textFields],
    extensions: [...route.extensions],
    limits: route.limits
  }));
  return crypto.createHash('sha256')
    .update(Buffer.from(JSON.stringify(projection), 'utf8'))
    .digest('hex');
}

function readRuntimeManifestBytes(manifestPath = RUNTIME_MANIFEST_PATH) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(manifestPath, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1024 * 1024) {
      throw new Error('invalid manifest file');
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function loadRuntimeManifest(options = {}) {
  const manifestPath = path.resolve(options.manifestPath || RUNTIME_MANIFEST_PATH);
  const bytes = readRuntimeManifestBytes(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser runtime manifest is invalid');
  }
  return Object.freeze({
    manifestPath,
    serverRoot: path.resolve(options.serverRoot || SERVER_ROOT),
    manifest,
    manifestSha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

function assertRuntimeManifest(manifest) {
  const expectedTopLevel = [
    'version',
    'minimum_systemd_version',
    'identity',
    'route_registry_sha256',
    'artifacts',
    'runtime_tree',
    'effective_properties',
    'required_self_tests'
  ];
  if (
    !exactObject(manifest, expectedTopLevel) ||
    manifest.version !== 2 ||
    manifest.minimum_systemd_version !== MINIMUM_SYSTEMD_VERSION ||
    !sameValue(manifest.identity, EXPECTED_IDENTITY) ||
    !HEX_64.test(manifest.route_registry_sha256) ||
    manifest.route_registry_sha256 !== routeRegistrySha256() ||
    !exactObject(manifest.artifacts, RUNTIME_ARTIFACTS) ||
    !RUNTIME_ARTIFACTS.every((name) => HEX_64.test(manifest.artifacts[name])) ||
    !exactObject(manifest.runtime_tree, ['format', 'root', 'sha256']) ||
    manifest.runtime_tree.format !== PARSER_RUNTIME_TREE_FORMAT ||
    manifest.runtime_tree.root !== PARSER_RUNTIME_ROOT ||
    !HEX_64.test(manifest.runtime_tree.sha256) ||
    !exactObject(manifest.effective_properties, [
      'turingmarket-parser@.service',
      'turingmarket-parser.slice'
    ]) ||
    !sameValue(
      manifest.effective_properties['turingmarket-parser@.service'],
      EXPECTED_SERVICE_PROPERTIES
    ) ||
    !sameValue(
      manifest.effective_properties['turingmarket-parser.slice'],
      EXPECTED_SLICE_PROPERTIES
    ) ||
    !sameValue(manifest.required_self_tests, REQUIRED_SELF_TESTS)
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser runtime manifest drift was detected');
  }
}

async function verifyCheckedInArtifacts(options = {}) {
  const runtime = loadRuntimeManifest(options);
  if (
    typeof options.expectedManifestSha256 !== 'string' ||
    !HEX_64.test(options.expectedManifestSha256) ||
    runtime.manifestSha256 !== options.expectedManifestSha256
  ) {
    throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser release manifest drift was detected');
  }
  assertRuntimeManifest(runtime.manifest);
  for (const relativePath of RUNTIME_ARTIFACTS) {
    const absolutePath = path.resolve(runtime.serverRoot, relativePath);
    if (
      absolutePath === runtime.serverRoot ||
      !absolutePath.startsWith(`${runtime.serverRoot}${path.sep}`)
    ) {
      throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser artifact path is invalid');
    }
    const artifact = await readRegularNoFollow(absolutePath, 4 * 1024 * 1024);
    if (artifact.sha256 !== runtime.manifest.artifacts[relativePath]) {
      throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser artifact drift was detected');
    }
  }
  return Object.freeze({
    ...runtime,
    routeRegistrySha256: routeRegistrySha256()
  });
}

async function captureSystemCommand(command, args) {
  const result = await runCommandNoDisclosure(command, args, {
    captureStdout: true,
    timeoutMs: 5_000,
    env: safeControllerEnvironment()
  });
  return result.stdout.trim();
}

async function readSystemdVersion() {
  const output = await captureSystemCommand('/usr/bin/systemctl', ['--version']);
  const match = /^systemd\s+([0-9]+)(?:\s|$)/m.exec(output);
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('systemd version is invalid');
  }
  return version;
}

async function defaultVerifyIdentity() {
  const passwd = await captureSystemCommand('/usr/bin/getent', [
    'passwd',
    EXPECTED_IDENTITY.user
  ]);
  const group = await captureSystemCommand('/usr/bin/getent', [
    'group',
    EXPECTED_IDENTITY.group
  ]);
  const groups = await captureSystemCommand('/usr/bin/id', [
    '-Gn',
    EXPECTED_IDENTITY.user
  ]);
  const status = await captureSystemCommand('/usr/bin/passwd', [
    '-S',
    EXPECTED_IDENTITY.user
  ]);
  const passwdFields = passwd.split(':');
  const groupFields = group.split(':');
  const uid = Number(passwdFields[2]);
  const gid = Number(passwdFields[3]);
  if (
    passwdFields.length !== 7 ||
    passwdFields[0] !== EXPECTED_IDENTITY.user ||
    groupFields.length !== 4 ||
    groupFields[0] !== EXPECTED_IDENTITY.group ||
    passwdFields[3] !== groupFields[2] ||
    !Number.isSafeInteger(uid) || uid <= 0 ||
    !Number.isSafeInteger(gid) || gid <= 0
  ) {
    throw new Error('identity mismatch');
  }
  const memberships = groups.split(/\s+/).filter(Boolean);
  return {
    user: passwdFields[0],
    group: groupFields[0],
    home: passwdFields[5],
    shell: passwdFields[6],
    locked: /^\S+\s+(?:L|LK)\b/.test(status),
    supplementary_groups: memberships.filter((name) => name !== groupFields[0]),
    uid,
    gid
  };
}

function verifiedParserIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('identity drift');
  }
  const projection = Object.fromEntries(
    Object.keys(EXPECTED_IDENTITY).map((key) => [key, value[key]])
  );
  if (
    !sameValue(projection, EXPECTED_IDENTITY) ||
    !Number.isSafeInteger(value.uid) || value.uid <= 0 ||
    !Number.isSafeInteger(value.gid) || value.gid <= 0
  ) {
    throw new Error('identity drift');
  }
  return Object.freeze({ uid: value.uid, gid: value.gid });
}

async function verifyInstalledParserArtifacts(manifest) {
  if (process.platform !== 'linux') throw new Error('Linux parser runtime is required');
  for (const [relativePath, installed] of Object.entries(INSTALLED_RUNTIME_ARTIFACTS)) {
    const artifact = await readRegularNoFollow(installed.path, 4 * 1024 * 1024);
    if (
      artifact.sha256 !== manifest.artifacts[relativePath] ||
      artifact.stat.uid !== 0 ||
      artifact.stat.gid !== 0 ||
      (artifact.stat.mode & 0o777) !== installed.mode
    ) {
      throw new Error('installed parser artifact drift');
    }
  }
  await verifyParserRuntimeTree(PARSER_RUNTIME_ROOT, manifest.runtime_tree, {
    requireRootOwnership: true
  });
}

async function readSystemdProperties(unitName, expectedProperties) {
  const names = Object.keys(expectedProperties);
  const output = await captureSystemCommand('/usr/bin/systemctl', [
    'show',
    unitName,
    '--no-pager',
    `--property=${names.join(',')}`
  ]);
  const result = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function readinessError() {
  return uploadError(
    500,
    'UPLOAD_SANDBOX_NOT_READY',
    'Production upload sandbox readiness failed'
  );
}

async function assertUploadSandboxStartupReady(options = {}) {
  try {
    const verified = await verifyCheckedInArtifacts(options);
    const idempotency = options.idempotency;
    if (
      !idempotency ||
      typeof idempotency.reserveProcessingInTransaction !== 'function' ||
      typeof idempotency.completeAdmissionInTransaction !== 'function' ||
      typeof idempotency.failInternalInTransaction !== 'function'
    ) {
      throw new Error('ledger capability drift');
    }

    const systemdVersionReader = options.systemdVersion || readSystemdVersion;
    const systemdVersion = await systemdVersionReader();
    if (
      !Number.isSafeInteger(systemdVersion) ||
      systemdVersion < verified.manifest.minimum_systemd_version
    ) {
      throw new Error('PrivatePIDs requires a newer systemd');
    }

    const verifyIdentity = options.verifyIdentity || defaultVerifyIdentity;
    const identity = await verifyIdentity();
    const parserIdentity = verifiedParserIdentity(identity);

    const verifyInstalledArtifacts = options.verifyInstalledArtifacts ||
      verifyInstalledParserArtifacts;
    await verifyInstalledArtifacts(verified.manifest);

    const systemctlShow = options.systemctlShow || readSystemdProperties;
    for (const [unitName, expected] of Object.entries(
      verified.manifest.effective_properties
    )) {
      const effective = await systemctlShow(unitName, expected);
      if (!sameValue(effective, expected)) throw new Error('effective property drift');
    }

    if (typeof options.recoverAdmissions !== 'function') {
      throw new Error('admission recovery unavailable');
    }
    await options.recoverAdmissions();

    const spoolRoot = path.resolve(options.spoolRoot || '/var/lib/turingmarket-parser/jobs');
    const spoolStat = await assertDirectory(
      spoolRoot,
      0o700,
      process.platform === 'linux' ? { uid: 0, gid: 0 } : undefined
    );
    const staleUnitController = options.staleUnitController ||
      createSystemdController(options.systemdOptions);
    if (
      !staleUnitController ||
      typeof staleUnitController.kill !== 'function' ||
      typeof staleUnitController.stop !== 'function' ||
      typeof staleUnitController.resetFailed !== 'function' ||
      typeof staleUnitController.assertCollected !== 'function'
    ) {
      throw new Error('stale parser unit controller unavailable');
    }
    const entries = await fsp.readdir(spoolRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f]{32}$/.test(entry.name)) {
        throw new Error('unsafe stale job entry');
      }
      const unitName = `turingmarket-parser@${entry.name}.service`;
      await staleUnitController.kill(unitName).catch(() => {});
      await staleUnitController.stop(unitName);
      await staleUnitController.resetFailed(unitName);
      await staleUnitController.assertCollected(unitName);
      await removeTreeNoFollow(path.join(spoolRoot, entry.name), spoolStat.dev);
      await fsyncDirectory(spoolRoot);
    }
    if ((await fsp.readdir(spoolRoot)).length !== 0) throw new Error('stale parser residue');

    const statfs = options.statfs || fsp.statfs;
    const inspectSpoolBytes = options.inspectSpoolBytes || defaultInspectSpoolBytes;
    await assertSpoolCapacity({ spoolRoot, statfs, inspectSpoolBytes }, 0);

    if (typeof options.runSelfTests !== 'function') {
      throw new Error('runtime self-tests unavailable');
    }
    const selfTests = await options.runSelfTests();
    if (!REQUIRED_SELF_TESTS.every((name) => selfTests && selfTests[name] === true)) {
      throw new Error('runtime self-test drift');
    }

    return Object.freeze({
      ready: true,
      manifestSha256: verified.manifestSha256,
      routeRegistrySha256: verified.routeRegistrySha256,
      systemdVersion,
      parserIdentity
    });
  } catch (error) {
    if (error instanceof UploadSandboxError && error.code === 'UPLOAD_SANDBOX_NOT_READY') {
      throw error;
    }
    throw readinessError();
  }
}

async function executeSystemdJob(systemd, job, options = {}) {
  if (!job || !/^[0-9a-f]{32}$/.test(job.id)) {
    throw new TypeError('Invalid parser systemd job');
  }
  const controller = new AbortController();
  let abortReason = null;
  const onAbort = () => {
    abortReason = uploadError(408, 'UPLOAD_PARSE_TIMEOUT', 'Upload parsing was aborted');
    controller.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    abortReason = uploadError(408, 'UPLOAD_PARSE_TIMEOUT', 'Upload parsing timed out');
    controller.abort();
  }, SANDBOX_LIMITS.parserSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  let leaseTimer = null;
  try {
    if (typeof options.assertLeaseOwned !== 'function') {
      throw new TypeError('Parser admission lease assertion is required');
    }
    try {
      await options.assertLeaseOwned(job.admission);
    } catch {
      throw uploadError(
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'Parser admission lease is no longer owned'
      );
    }
    if (abortReason) throw abortReason;
    leaseTimer = setInterval(async () => {
      try {
        await options.assertLeaseOwned(job.admission);
      } catch {
        abortReason = uploadError(
          409,
          'IDEMPOTENCY_IN_PROGRESS',
          'Parser admission lease is no longer owned'
        );
        controller.abort();
      }
    }, 1000);
    if (typeof leaseTimer.unref === 'function') leaseTimer.unref();
    await systemd.start(job.unitName, {
      signal: controller.signal,
      timeoutMs: (SANDBOX_LIMITS.parserSeconds + 5) * 1000
    });
    if (abortReason) throw abortReason;
  } catch (error) {
    if (abortReason) throw abortReason;
    if (error instanceof UploadSandboxError) throw error;
    throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Isolated parser failed');
  } finally {
    clearTimeout(timer);
    if (leaseTimer) clearInterval(leaseTimer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

async function removeTreeNoFollow(target, expectedDevice) {
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (expectedDevice !== undefined && stat.dev !== expectedDevice) {
    throw cleanupFenceError();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await fsp.unlink(target);
    return;
  }
  const entries = await fsp.readdir(target);
  for (const name of entries) {
    await removeTreeNoFollow(path.join(target, name), expectedDevice);
  }
  await fsyncDirectory(target);
  await fsp.rmdir(target);
}

function createUploadSandboxService(options = {}) {
  const spoolRoot = path.resolve(options.spoolRoot || '/var/lib/turingmarket-parser/jobs');
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || Date.now;
  const parserIdentity = options.parserIdentity || null;
  const admissionByRequest = new WeakMap();
  const dependencies = {
    ...options,
    spoolRoot,
    now,
    statfs: options.statfs || fsp.statfs,
    inspectSpoolBytes: options.inspectSpoolBytes || defaultInspectSpoolBytes
  };
  const systemd = options.systemd || createSystemdController(options.systemdOptions);

  async function admitRequest(request, context) {
    if (!request || (typeof request !== 'object' && typeof request !== 'function')) {
      throw new TypeError('Parser admission request is required');
    }
    if (admissionByRequest.has(request)) return admissionByRequest.get(request);
    if (!context || !UPLOAD_ROUTES.includes(context.route)) {
      throw new TypeError('Closed parser route is required');
    }
    const principal = context.principal;
    if (
      !principal ||
      !Number.isSafeInteger(principal.organizationId) || principal.organizationId <= 0 ||
      !Number.isSafeInteger(principal.userId) || principal.userId <= 0
    ) {
      throw new TypeError('Authenticated parser principal is required');
    }
    if (
      !dependencies.db ||
      !dependencies.idempotency ||
      typeof dependencies.idempotency.reserveProcessingInTransaction !== 'function'
    ) {
      throw new TypeError('Existing idempotency admission primitive is required');
    }
    let resolveAdmission;
    let rejectAdmission;
    const pendingAdmission = new Promise((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    pendingAdmission.catch(() => {});
    admissionByRequest.set(request, pendingAdmission);
    try {
      await assertDirectory(
        spoolRoot,
        0o700,
        process.platform === 'linux' ? { uid: 0, gid: 0 } : undefined
      );
      const observedBytes = await dependencies.inspectSpoolBytes(spoolRoot);
      const stat = await dependencies.statfs(spoolRoot);
      let reservation;
      withImmediateTransaction(dependencies.db, () => {
        const activeCount = activeParserAdmissions(dependencies.db);
        const availableBytes = safeNumber(stat && stat.bavail, 'parser spool available blocks') *
          safeNumber(stat && stat.bsize, 'parser spool block size');
        const reservedBytes = activeCount * SANDBOX_LIMITS.reservationBytes;
        const projectedBytes = Math.max(
          safeNumber(observedBytes, 'parser spool byte count'),
          reservedBytes
        ) + SANDBOX_LIMITS.reservationBytes;
        if (
          !Number.isSafeInteger(availableBytes) ||
          projectedBytes > SANDBOX_LIMITS.spoolBytes ||
          availableBytes - SANDBOX_LIMITS.reservationBytes < SANDBOX_LIMITS.freeFloorBytes
        ) {
          throw uploadError(
            507,
            'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED',
            'Parser spool capacity was reached'
          );
        }
        const requestHash = parserAdmissionHash({
          organizationId: principal.organizationId,
          userId: principal.userId,
          method: context.method,
          path: context.path,
          requestId: context.requestId
        });
        const key = `parser-${randomBytes(32).toString('hex')}`;
        const reserved = dependencies.idempotency.reserveProcessingInTransaction(
          dependencies.db,
          {
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            campaignId: null,
            scope: context.route.admissionScope,
            key,
            requestHash,
            expectedEventCount: 0,
            operationTimeoutSeconds: SANDBOX_LIMITS.admissionSeconds
          }
        );
        reservation = Object.freeze({
          ...reserved,
          requestHash,
          key,
          route: context.route.id,
          organizationId: principal.organizationId,
          userId: principal.userId
        });
      });
      admissionByRequest.set(request, reservation);
      resolveAdmission(reservation);
      return reservation;
    } catch (error) {
      admissionByRequest.delete(request);
      rejectAdmission(error);
      throw error;
    }
  }

  async function stageJob(multipart, admission) {
    if (
      !multipart ||
      !UPLOAD_ROUTES.includes(multipart.route) ||
      !Array.isArray(multipart.files) ||
      multipart.files.length !== 1 ||
      !admission ||
      !Number.isSafeInteger(admission.ledgerId) || admission.ledgerId <= 0 ||
      !HEX_64.test(admission.requestHash) ||
      !HEX_64.test(admission.leaseToken) ||
      admission.route !== multipart.route.id
    ) {
      throw new TypeError('Valid parser multipart and admission are required');
    }
    if (
      process.platform === 'linux' && (
        !parserIdentity ||
        !Number.isSafeInteger(parserIdentity.uid) || parserIdentity.uid <= 0 ||
        !Number.isSafeInteger(parserIdentity.gid) || parserIdentity.gid <= 0
      )
    ) {
      throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser identity is not available');
    }
    const lifecycleStartedMs = now();
    if (!Number.isFinite(lifecycleStartedMs)) {
      throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Parser lifecycle clock is invalid');
    }
    const spoolStat = await assertDirectory(
      spoolRoot,
      0o700,
      process.platform === 'linux' ? { uid: 0, gid: 0 } : undefined
    );
    let id;
    let root;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      id = randomBytes(16).toString('hex');
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('Secure parser job ID generation failed');
      root = path.join(spoolRoot, id);
      try {
        await fsp.mkdir(root, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt === 7) throw error;
      }
    }
    const outputRoot = path.join(root, 'output');
    const outputManifestPath = path.join(outputRoot, 'manifest.json');
    const resultPath = path.join(outputRoot, 'result.json');
    const inputPath = path.join(root, 'input.bin');
    const requestPath = path.join(root, 'request.json');
    try {
      await fsp.mkdir(outputRoot, { mode: 0o700 });
      await assertDirectory(
        root,
        0o700,
        process.platform === 'linux' ? { uid: 0, gid: 0, dev: spoolStat.dev } : undefined
      );
      const file = multipart.files[0];
      const stagedSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
      if (file.buffer.length !== file.length || stagedSha256 !== file.sha256) {
        throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Upload changed before parser staging');
      }
      await writeExclusiveFile(inputPath, file.buffer, 0o440);
      const requestBytes = jsonBytes({
        version: 1,
        job_id: id,
        route: multipart.route.id,
        fields: multipart.fields.map((field) => ({
          name: field.name,
          occurrence: field.occurrence,
          value: field.value
        })),
        file: {
          basename: file.basename,
          mime: file.mime,
          length: file.length,
          sha256: file.sha256
        }
      });
      await writeExclusiveFile(requestPath, requestBytes, 0o440);
      await writeExclusiveFile(
        outputManifestPath,
        PARSER_OUTPUT_MANIFEST_BYTES,
        0o440
      );
      await writeExclusiveFile(resultPath, Buffer.alloc(0), 0o600);
      if (process.platform === 'linux') {
        for (const stagedPath of [inputPath, requestPath]) {
          await fsp.chown(stagedPath, 0, parserIdentity.gid);
          await fsp.chmod(stagedPath, 0o440);
        }
        await fsp.chown(outputManifestPath, 0, parserIdentity.gid);
        await fsp.chmod(outputManifestPath, 0o440);
        await fsp.chown(resultPath, parserIdentity.uid, parserIdentity.gid);
        await fsp.chmod(resultPath, 0o600);
        await fsp.chown(outputRoot, 0, parserIdentity.gid);
      }
      await fsp.chmod(outputRoot, 0o550);
      await assertDirectory(
        outputRoot,
        0o550,
        process.platform === 'linux'
          ? { uid: 0, gid: parserIdentity.gid, dev: spoolStat.dev }
          : undefined
      );
      const resultHandle = await fsp.open(
        resultPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      let resultStat;
      try {
        resultStat = await resultHandle.stat();
      } finally {
        await resultHandle.close();
      }
      if (
        !resultStat.isFile() ||
        resultStat.nlink !== 1 ||
        resultStat.size !== 0 ||
        process.platform === 'linux' && (
          resultStat.uid !== parserIdentity.uid ||
          resultStat.gid !== parserIdentity.gid ||
          (resultStat.mode & 0o777) !== 0o600
        )
      ) {
        throw uploadError(500, 'UPLOAD_INVALID_CONTENT', 'Parser result target is invalid');
      }
      const resultMetadata = Object.freeze({
        dev: resultStat.dev,
        ino: resultStat.ino,
        uid: resultStat.uid,
        gid: resultStat.gid,
        mode: process.platform === 'linux' ? 0o600 : resultStat.mode & 0o777,
        lifecycleStartedMs
      });
      await fsyncDirectory(root);
      await fsyncDirectory(spoolRoot);
      return Object.freeze({
        id,
        unitName: `turingmarket-parser@${id}.service`,
        root,
        inputPath,
        requestPath,
        outputRoot,
        resultPath,
        resultMetadata,
        device: spoolStat.dev,
        admission
      });
    } catch (error) {
      try {
        await removeTreeNoFollow(root, spoolStat.dev);
        await fsyncDirectory(spoolRoot);
      } catch {
        throw cleanupFenceError();
      }
      throw error;
    }
  }

  async function cleanupJob(job) {
    if (
      !job ||
      !/^[0-9a-f]{32}$/.test(job.id) ||
      path.resolve(job.root) !== path.join(spoolRoot, job.id) ||
      !Number.isSafeInteger(job.device) || job.device < 0
    ) {
      throw new TypeError('Invalid parser job cleanup target');
    }
    await removeTreeNoFollow(job.root, job.device);
    await fsyncDirectory(spoolRoot);
    try {
      await fsp.lstat(job.root);
      throw cleanupFenceError();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function killJob(job) {
    if (!job || !/^[0-9a-f]{32}$/.test(job.id)) return;
    if (typeof dependencies.killJob === 'function') {
      await dependencies.killJob(job);
      return;
    }
    await systemd.kill(job.unitName).catch(() => {});
    await systemd.stop(job.unitName);
    await systemd.resetFailed(job.unitName);
    await systemd.assertCollected(job.unitName);
  }

  function completeAdmissionInTransaction(database, admission) {
    if (
      !dependencies.idempotency ||
      typeof dependencies.idempotency.completeAdmissionInTransaction !== 'function'
    ) {
      throw new TypeError('Existing completed/admission ledger primitive is required');
    }
    return dependencies.idempotency.completeAdmissionInTransaction(database, {
      ledgerId: admission.ledgerId,
      requestHash: admission.requestHash,
      leaseToken: admission.leaseToken
    });
  }

  async function failAdmission(admission) {
    if (typeof dependencies.failAdmission === 'function') {
      return dependencies.failAdmission(admission);
    }
    if (
      !dependencies.db ||
      !dependencies.idempotency ||
      typeof dependencies.idempotency.failInternalInTransaction !== 'function'
    ) {
      throw new TypeError('Existing failed-admission ledger primitive is required');
    }
    return withImmediateTransaction(dependencies.db, () => (
      dependencies.idempotency.failInternalInTransaction(dependencies.db, {
        ledgerId: admission.ledgerId,
        requestHash: admission.requestHash,
        leaseToken: admission.leaseToken
      })
    ));
  }

  async function processUpload(input) {
    if (
      !input ||
      typeof input.assertAuthorized !== 'function' ||
      typeof input.assertLeaseOwned !== 'function' ||
      typeof input.finalize !== 'function'
    ) {
      throw new TypeError('Parser authorization, lease, and finalization callbacks are required');
    }
    let job = null;
    let cleaned = false;
    let executionCollected = false;
    try {
      await input.assertAuthorized();
      job = await stageJob(input.multipart, input.admission);
      try {
        if (typeof dependencies.executeJob === 'function') {
          try {
            await input.assertLeaseOwned(job.admission);
          } catch {
            throw uploadError(
              409,
              'IDEMPOTENCY_IN_PROGRESS',
              'Parser admission lease is no longer owned'
            );
          }
          await dependencies.executeJob(job, {
            signal: input.signal,
            assertLeaseOwned: input.assertLeaseOwned
          });
        } else {
          await executeSystemdJob(systemd, job, {
            signal: input.signal,
            assertLeaseOwned: input.assertLeaseOwned
          });
        }
        executionCollected = true;
      } catch (error) {
        if (error instanceof UploadSandboxError) throw error;
        if (error && error.code === 'UPLOAD_PARSE_TIMEOUT') {
          throw uploadError(408, 'UPLOAD_PARSE_TIMEOUT', 'Upload parsing timed out');
        }
        throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Isolated parser failed');
      }
      const parsed = await validateParserOutput(job.outputRoot, {
        expectedResultMetadata: job.resultMetadata,
        inspectResultMetadata: dependencies.inspectResultMetadata,
        now: dependencies.now
      });
      if (parsed.route !== input.multipart.route.id) {
        throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Parser route result did not match');
      }
      await cleanupJob(job);
      cleaned = true;
      await input.assertAuthorized();
      let admissionCompleted = false;
      const lifecycle = Object.freeze({
        completeAdmissionInTransaction: (database) => {
          if (admissionCompleted) throw new TypeError('Parser admission already completed');
          admissionCompleted = true;
          return completeAdmissionInTransaction(database, input.admission);
        }
      });
      const value = await input.finalize(parsed, lifecycle);
      if (!admissionCompleted) {
        throw new TypeError('Final parser transaction did not complete its admission');
      }
      return value;
    } catch (error) {
      if (error && error.code === 'UPLOAD_SANDBOX_CLEANUP_FAILED') throw error;
      if (job && !cleaned) {
        try {
          if (!executionCollected) await killJob(job);
          await cleanupJob(job);
          cleaned = true;
        } catch {
          throw cleanupFenceError();
        }
      }
      if (input && input.admission) {
        try {
          await failAdmission(input.admission);
        } catch {
          throw uploadError(
            500,
            'AUDIT_PERSISTENCE_FAILED',
            'Parser admission failure could not be fenced'
          );
        }
      }
      throw error;
    }
  }

  function createPipelineHooks(hookOptions = {}) {
    if (typeof hookOptions.resolvePrincipal !== 'function') {
      throw new TypeError('Authenticated parser principal resolver is required');
    }

    function resolveClosedRoute(request, policy) {
      const route = matchUploadRoute(
        request && request.method,
        request && (request.originalUrl || request.url || request.path)
      );
      if (
        !route ||
        !policy ||
        policy.id !== route.id ||
        policy.admission !== route.admissionScope
      ) {
        throw uploadError(500, 'UPLOAD_SANDBOX_NOT_READY', 'Upload route registry drift was detected');
      }
      return route;
    }

    const hooks = {
      async admit(request, context) {
        const route = resolveClosedRoute(request, context && context.policy);
        const principal = await hookOptions.resolvePrincipal(request, context);
        return admitRequest(request, {
          requestId: context.requestId,
          route,
          principal,
          method: request.method,
          path: request.originalUrl || request.url || request.path
        });
      },
      async parseMultipart(request, rawBody, policy) {
        const route = resolveClosedRoute(request, policy);
        const contentType = request && request.headers && request.headers['content-type'];
        const multipart = await decodeMultipartBody({ route, contentType, rawBody });
        const body = {};
        for (const field of multipart.fields) body[field.name] = field.value;
        const campaignValue = Object.hasOwn(body, 'campaign_id') ? body.campaign_id : null;
        let campaignId = null;
        if (campaignValue !== null) {
          if (!/^[1-9][0-9]*$/.test(campaignValue) || !Number.isSafeInteger(Number(campaignValue))) {
            throw uploadError(400, 'UPLOAD_INVALID_CONTENT', 'Invalid multipart campaign ID');
          }
          campaignId = Number(campaignValue);
        }
        const canonicalRequestHash = hashMultipartRequest({
          method: request.method,
          path: request.originalUrl || request.url || request.path,
          campaignId,
          multipart
        });
        const sourceFile = multipart.files[0];
        const file = Object.freeze({
          fieldname: sourceFile.fieldName,
          originalname: sourceFile.basename,
          mimetype: sourceFile.mime,
          size: sourceFile.length,
          sha256: sourceFile.sha256
        });
        return Object.freeze({
          body: Object.freeze(body),
          file,
          files: Object.freeze([file]),
          canonicalRequestHash,
          sandboxMultipart: multipart
        });
      },
      async onAdmissionFailure(_request, admission) {
        return failAdmission(admission);
      }
    };
    Object.defineProperty(hooks.admit, 'requiresDurableAdmission', {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false
    });
    return Object.freeze(hooks);
  }

  return Object.freeze({
    admitRequest,
    cleanupJob,
    completeAdmissionInTransaction,
    createPipelineHooks,
    failAdmission,
    killJob,
    processUpload,
    stageJob
  });
}

if (require.main === module) {
  workerMain(process.argv.slice(2)).catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  SANDBOX_LIMITS,
  UPLOAD_ROUTES,
  UploadSandboxError,
  auditWritableFilesystem,
  assertUploadSandboxStartupReady,
  createUploadSandboxService,
  decodeMultipartBody,
  hashMultipartRequest,
  inspectResultMetadata,
  inspectParserRuntimeTree,
  loadRuntimeManifest,
  matchUploadRoute,
  readSystemdProperties,
  runCommandNoDisclosure,
  validateParserOutput,
  verifyInstalledParserArtifacts,
  verifyParserRuntimeTree,
  verifyCheckedInArtifacts,
  workerMain
};
