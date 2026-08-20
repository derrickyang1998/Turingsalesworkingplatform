#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HEX_64 = /^[0-9a-f]{64}$/;
const PARSER_RUNTIME_TREE_FORMAT = 'tm-parser-runtime-tree-v1';
const RAW_OBSERVATIONS_FORMAT = 'tm-parser-self-test-observations-v1';
const ACCEPTANCE_BINDING_FORMAT = 'tm-parser-acceptance-binding-v1';
const INSTALLED_POLICY_OBSERVATION_FORMAT = 'tm-parser-installed-policy-observation-v1';
const BUILD_BOUNDARY_OBSERVATION_FORMAT = 'tm-parser-build-boundary-observation-v1';
const BUILD_EVIDENCE_FORMAT = 'tm-parser-runtime-build-evidence-v2';
const BUILD_BOUNDARY_FORMAT = 'tm-parser-build-boundary-v1';
const SYSTEMCTL = '/usr/bin/systemctl';
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze';
const RUNUSER = '/usr/sbin/runuser';
const BUILD_USER = 'turingmarket-gate';
const BUILD_GROUP = 'turingmarket-gate';
const PINNED_SYSTEM_CALL_POLICY = Object.freeze({
  format: "tm-systemd-concrete-syscall-policy-v1",
  systemd: "systemd 259 (259.5-0ubuntu3.4)",
  architecture: "x86_64",
  libseccomp: "2.6.0-2ubuntu5",
  parser_maximum_sha256: "01eb648439377a58afd2ba87a16b67f59c122b32550683371703bfc6e9e6a74a",
  parser_maximum: Object.freeze([
    "_llseek", "_newselect", "access", "add_key", "alarm", "arch_prctl",
    "arm_fadvise64_64", "brk", "cacheflush", "capget", "chdir", "clock_getres",
    "clock_getres_time64", "clock_gettime", "clock_gettime64", "clock_nanosleep", "clock_nanosleep_time64", "clone",
    "clone3", "close", "close_range", "copy_file_range", "creat", "dup",
    "dup2", "dup3", "epoll_create", "epoll_create1", "epoll_ctl", "epoll_ctl_old",
    "epoll_pwait", "epoll_pwait2", "epoll_wait", "epoll_wait_old", "eventfd", "eventfd2",
    "execve", "execveat", "exit", "exit_group", "faccessat", "faccessat2",
    "fadvise64", "fadvise64_64", "fallocate", "fchdir", "fcntl", "fcntl64",
    "fdatasync", "fgetxattr", "file_getattr", "file_setattr", "flistxattr", "flock",
    "fork", "fstat", "fstat64", "fstatat", "fstatat64", "fstatfs",
    "fstatfs64", "fsync", "ftruncate", "ftruncate64", "futex", "futex_time64",
    "futex_waitv", "get_mempolicy", "get_robust_list", "get_thread_area", "getcpu", "getcwd",
    "getdents", "getdents64", "getegid", "getegid32", "geteuid", "geteuid32",
    "getgid", "getgid32", "getgroups", "getgroups32", "getitimer", "getpgid",
    "getpgrp", "getpid", "getppid", "getpriority", "getrandom", "getresgid",
    "getresgid32", "getresuid", "getresuid32", "getrlimit", "getrusage", "getsid",
    "gettid", "gettimeofday", "getuid", "getuid32", "getxattr", "getxattrat",
    "inotify_add_watch", "inotify_init", "inotify_init1", "inotify_rm_watch", "ioctl", "ioprio_get",
    "ipc", "kcmp", "keyctl", "kill", "landlock_add_rule", "landlock_create_ruleset",
    "landlock_restrict_self", "lgetxattr", "link", "linkat", "listmount", "listxattr",
    "listxattrat", "llistxattr", "llseek", "lseek", "lsm_get_self_attr", "lsm_list_modules",
    "lstat", "lstat64", "madvise", "membarrier", "memfd_create", "mkdir",
    "mkdirat", "mknod", "mknodat", "mlock", "mlock2", "mlockall",
    "mmap", "mmap2", "mprotect", "mq_getsetattr", "mq_notify", "mq_open",
    "mq_timedreceive", "mq_timedreceive_time64", "mq_timedsend", "mq_timedsend_time64", "mq_unlink", "mremap",
    "mseal", "msgctl", "msgget", "msgrcv", "msgsnd", "msync",
    "munlock", "munlockall", "munmap", "name_to_handle_at", "nanosleep", "newfstat",
    "newfstatat", "oldfstat", "oldlstat", "oldolduname", "oldstat", "olduname",
    "open", "open_tree", "openat", "openat2", "pause", "personality",
    "pidfd_open", "pidfd_send_signal", "pipe", "pipe2", "poll", "ppoll",
    "ppoll_time64", "prctl", "pread64", "preadv", "preadv2", "prlimit64",
    "process_madvise", "process_vm_readv", "process_vm_writev", "pselect6", "pselect6_time64", "pwrite64",
    "pwritev", "pwritev2", "read", "readahead", "readdir", "readlink",
    "readlinkat", "readv", "remap_file_pages", "removexattrat", "rename", "renameat",
    "renameat2", "request_key", "restart_syscall", "riscv_flush_icache", "riscv_hwprobe", "rmdir",
    "rseq", "rt_sigaction", "rt_sigpending", "rt_sigprocmask", "rt_sigqueueinfo", "rt_sigreturn",
    "rt_sigsuspend", "rt_sigtimedwait", "rt_sigtimedwait_time64", "rt_tgsigqueueinfo", "sched_get_priority_max", "sched_get_priority_min",
    "sched_getaffinity", "sched_getattr", "sched_getparam", "sched_getscheduler", "sched_rr_get_interval", "sched_rr_get_interval_time64",
    "sched_yield", "seccomp", "select", "semctl", "semget", "semop",
    "semtimedop", "semtimedop_time64", "sendfile", "sendfile64", "set_robust_list", "set_thread_area",
    "set_tid_address", "set_tls", "setfsgid", "setfsgid32", "setgid", "setgid32",
    "setitimer", "setns", "setpgid", "setregid", "setregid32", "setresgid",
    "setresgid32", "setsid", "setxattrat", "shmat", "shmctl", "shmdt",
    "shmget", "shutdown", "sigaction", "sigaltstack", "signal", "signalfd",
    "signalfd4", "sigpending", "sigprocmask", "sigreturn", "sigsuspend", "socketpair",
    "splice", "stat", "stat64", "statfs", "statfs64", "statmount",
    "statx", "swapcontext", "symlink", "symlinkat", "sync", "sync_file_range",
    "sync_file_range2", "syncfs", "sysinfo", "tee", "tgkill", "time",
    "timer_create", "timer_delete", "timer_getoverrun", "timer_gettime", "timer_gettime64", "timer_settime",
    "timer_settime64", "timerfd_create", "timerfd_gettime", "timerfd_gettime64", "timerfd_settime", "timerfd_settime64",
    "times", "tkill", "truncate", "truncate64", "ugetrlimit", "umask",
    "uname", "unlink", "unlinkat", "unshare", "uretprobe", "userfaultfd",
    "utimensat_time64", "vfork", "vmsplice", "wait4", "waitid", "waitpid",
    "write", "writev"
  ]),
  build_maximum_sha256: "eb4ead68cbf55ebccc38ff57ad87225ba8bd47b40095c53e98b00787dbd2b6d5",
  build_maximum: Object.freeze([
    "_llseek", "_newselect", "access", "add_key", "alarm", "arch_prctl",
    "arm_fadvise64_64", "brk", "cacheflush", "capget", "chdir", "chmod",
    "clock_getres", "clock_getres_time64", "clock_gettime", "clock_gettime64", "clock_nanosleep", "clock_nanosleep_time64",
    "clone", "clone3", "close", "close_range", "copy_file_range", "creat",
    "dup", "dup2", "dup3", "epoll_create", "epoll_create1", "epoll_ctl",
    "epoll_ctl_old", "epoll_pwait", "epoll_pwait2", "epoll_wait", "epoll_wait_old", "eventfd",
    "eventfd2", "execve", "execveat", "exit", "exit_group", "faccessat",
    "faccessat2", "fadvise64", "fadvise64_64", "fallocate", "fchdir", "fchmod",
    "fchmodat", "fchmodat2", "fcntl", "fcntl64", "fdatasync", "fgetxattr",
    "file_getattr", "file_setattr", "flistxattr", "flock", "fork", "fremovexattr",
    "fsetxattr", "fstat", "fstat64", "fstatat", "fstatat64", "fstatfs",
    "fstatfs64", "fsync", "ftruncate", "ftruncate64", "futex", "futex_time64",
    "futex_waitv", "futimesat", "get_mempolicy", "get_robust_list", "get_thread_area", "getcpu",
    "getcwd", "getdents", "getdents64", "getegid", "getegid32", "geteuid",
    "geteuid32", "getgid", "getgid32", "getgroups", "getgroups32", "getitimer",
    "getpgid", "getpgrp", "getpid", "getppid", "getpriority", "getrandom",
    "getresgid", "getresgid32", "getresuid", "getresuid32", "getrlimit", "getrusage",
    "getsid", "gettid", "gettimeofday", "getuid", "getuid32", "getxattr",
    "getxattrat", "inotify_add_watch", "inotify_init", "inotify_init1", "inotify_rm_watch", "io_cancel",
    "io_destroy", "io_getevents", "io_pgetevents", "io_pgetevents_time64", "io_setup", "io_submit",
    "ioctl", "ioprio_get", "ipc", "kcmp", "keyctl", "kill",
    "landlock_add_rule", "landlock_create_ruleset", "landlock_restrict_self", "lgetxattr", "link", "linkat",
    "listmount", "listxattr", "listxattrat", "llistxattr", "llseek", "lremovexattr",
    "lseek", "lsetxattr", "lsm_get_self_attr", "lsm_list_modules", "lstat", "lstat64",
    "madvise", "membarrier", "memfd_create", "mkdir", "mkdirat", "mknod",
    "mknodat", "mlock", "mlock2", "mlockall", "mmap", "mmap2",
    "mprotect", "mq_getsetattr", "mq_notify", "mq_open", "mq_timedreceive", "mq_timedreceive_time64",
    "mq_timedsend", "mq_timedsend_time64", "mq_unlink", "mremap", "mseal", "msgctl",
    "msgget", "msgrcv", "msgsnd", "msync", "munlock", "munlockall",
    "munmap", "name_to_handle_at", "nanosleep", "newfstat", "newfstatat", "oldfstat",
    "oldlstat", "oldolduname", "oldstat", "olduname", "open", "open_tree",
    "openat", "openat2", "pause", "personality", "pidfd_open", "pidfd_send_signal",
    "pipe", "pipe2", "poll", "ppoll", "ppoll_time64", "prctl",
    "pread64", "preadv", "preadv2", "prlimit64", "process_madvise", "process_vm_readv",
    "process_vm_writev", "pselect6", "pselect6_time64", "pwrite64", "pwritev", "pwritev2",
    "read", "readahead", "readdir", "readlink", "readlinkat", "readv",
    "remap_file_pages", "removexattr", "removexattrat", "rename", "renameat", "renameat2",
    "request_key", "restart_syscall", "riscv_flush_icache", "riscv_hwprobe", "rmdir", "rseq",
    "rt_sigaction", "rt_sigpending", "rt_sigprocmask", "rt_sigqueueinfo", "rt_sigreturn", "rt_sigsuspend",
    "rt_sigtimedwait", "rt_sigtimedwait_time64", "rt_tgsigqueueinfo", "sched_get_priority_max", "sched_get_priority_min", "sched_getaffinity",
    "sched_getattr", "sched_getparam", "sched_getscheduler", "sched_rr_get_interval", "sched_rr_get_interval_time64", "sched_yield",
    "seccomp", "select", "semctl", "semget", "semop", "semtimedop",
    "semtimedop_time64", "sendfile", "sendfile64", "set_robust_list", "set_thread_area", "set_tid_address",
    "set_tls", "setfsgid", "setfsgid32", "setgid", "setgid32", "setitimer",
    "setns", "setpgid", "setregid", "setregid32", "setresgid", "setresgid32",
    "setsid", "setxattr", "setxattrat", "shmat", "shmctl", "shmdt",
    "shmget", "shutdown", "sigaction", "sigaltstack", "signal", "signalfd",
    "signalfd4", "sigpending", "sigprocmask", "sigreturn", "sigsuspend", "socketpair",
    "splice", "stat", "stat64", "statfs", "statfs64", "statmount",
    "statx", "swapcontext", "symlink", "symlinkat", "sync", "sync_file_range",
    "sync_file_range2", "syncfs", "sysinfo", "tee", "tgkill", "time",
    "timer_create", "timer_delete", "timer_getoverrun", "timer_gettime", "timer_gettime64", "timer_settime",
    "timer_settime64", "timerfd_create", "timerfd_gettime", "timerfd_gettime64", "timerfd_settime", "timerfd_settime64",
    "times", "tkill", "truncate", "truncate64", "ugetrlimit", "umask",
    "uname", "unlink", "unlinkat", "unshare", "uretprobe", "userfaultfd",
    "utime", "utimensat", "utimensat_time64", "utimes", "vfork", "vmsplice",
    "wait4", "waitid", "waitpid", "write", "writev"
  ])
});
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MANIFEST_TOP_LEVEL_KEYS = [
  'version',
  'build',
  'minimum_systemd_version',
  'identity',
  'route_registry_sha256',
  'artifacts',
  'runtime_tree',
  'effective_properties',
  'required_self_tests'
];
const RUNTIME_TREE_KEYS = ['format', 'root', 'sha256', 'files', 'directories', 'bytes'];
const RAW_OBSERVATION_KEYS = [
  'format',
  'manifest_sha256',
  'runtime_tree',
  'effective_properties',
  'parser_acceptance',
  'self_tests'
];
const RAW_FIELD_DIGEST_KEYS = RAW_OBSERVATION_KEYS.slice();
const INSTALLED_POLICY_OBSERVATION_KEYS = [
  'format', 'effective_properties', 'manager_state', 'concrete_system_call_policies'
];
const INSTALLED_MANAGER_STATE_KEYS = [
  'Id', 'LoadState', 'FragmentPath', 'SourcePath', 'DropInPaths', 'NeedDaemonReload', 'Transient'
];
const BUILD_OBSERVATION_KEYS = [
  'format',
  'manifest_sha256',
  'source_artifacts_sha256',
  'build_unit',
  'build_unit_properties',
  'build_unit_properties_sha256',
  'build_parent',
  'network_isolation',
  'mount_isolation',
  'credential_isolation',
  'build_parent_inaccessible'
];
const BUILD_PARENT_KEYS = ['device', 'inode', 'mode', 'uid', 'gid'];
const BUILD_BOUNDARY_KEYS = [
  'format',
  'source_artifacts_sha256',
  'build_unit',
  'build_unit_properties',
  'build_unit_properties_sha256',
  'build_unit_stopped',
  'build_unit_collected',
  'network_isolation',
  'mount_isolation',
  'credential_isolation',
  'build_parent_inaccessible'
];
const BUILD_EVIDENCE_KEYS = [
  'format',
  'manifest_sha256',
  'verifier_sha256',
  'runtime_tree',
  'build_boundary'
];
const REQUIRED_ACCEPTANCE = Object.freeze([
  Object.freeze({
    format: 'xlsx',
    parser: 'xlsx-openxml',
    marker: 'TM_XLSX_MARKER_604',
    marker_found: true,
    ocr_used: false
  }),
  Object.freeze({
    format: 'pptx',
    parser: 'pptx-openxml',
    marker: 'TM_PPTX_MARKER_604',
    marker_found: true,
    ocr_used: false
  }),
  Object.freeze({
    format: 'bmp',
    parser: 'local-rapidocr',
    marker: 'OCR 123',
    marker_found: true,
    ocr_used: true
  })
]);
const SYSTEM_CALL_BASELINE = Object.freeze([
  'read', 'write', 'close', 'execve', 'exit', 'exit_group', 'shutdown', 'socketpair'
]);
const SYSTEM_CALL_POLICY_EVIDENCE_KEYS = Object.freeze([
  'format', 'policy', 'reviewed_runtime', 'concrete', 'concrete_sha256',
  'maximum', 'maximum_sha256'
]);
const trustedManifestLoads = new WeakMap();

class StrictJsonParser {
  constructor(text, label) {
    this.text = text;
    this.label = label;
    this.index = 0;
  }

  fail(message) {
    throw new Error(`${this.label}: ${message}`);
  }

  parse() {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail('malformed JSON');
    if (!isPlainObject(value)) this.fail('JSON root must be an object');
    return deepFreeze(value);
  }

  skipWhitespace() {
    while (/[\t\n\r ]/.test(this.text[this.index] || '')) this.index += 1;
  }

  parseValue() {
    this.skipWhitespace();
    const char = this.text[this.index];
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return this.parseString();
    if (char === '-' || (char >= '0' && char <= '9')) return this.parseNumber();
    if (this.text.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    this.fail('malformed JSON');
  }

  parseObject() {
    const object = Object.create(null);
    const keys = new Set();
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return object;
    }
    while (this.index < this.text.length) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail('malformed JSON object key');
      const key = this.parseString();
      if (UNSAFE_KEYS.has(key)) this.fail(`unsafe prototype key "${key}"`);
      if (keys.has(key)) this.fail(`duplicate JSON key "${key}"`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.fail('malformed JSON object separator');
      this.index += 1;
      object[key] = this.parseValue();
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return object;
      }
      if (this.text[this.index] !== ',') this.fail('malformed JSON object');
      this.index += 1;
    }
    this.fail('malformed JSON object');
  }

  parseArray() {
    const array = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return array;
    }
    while (this.index < this.text.length) {
      array.push(this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return array;
      }
      if (this.text[this.index] !== ',') this.fail('malformed JSON array');
      this.index += 1;
    }
    this.fail('malformed JSON array');
  }

  parseString() {
    let result = '';
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === '"') {
        this.index += 1;
        return result;
      }
      const unit = char === '\\' ? this.parseEscape() : this.parseRawStringUnit();
      const codeUnit = unit.charCodeAt(0);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        if (this.index >= this.text.length || this.text[this.index] === '"') {
          this.fail('unpaired high surrogate in JSON string');
        }
        const nextUnit = this.text[this.index] === '\\'
          ? this.parseEscape()
          : this.parseRawStringUnit();
        const nextCodeUnit = nextUnit.charCodeAt(0);
        if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
          this.fail('unpaired high surrogate in JSON string');
        }
        result += String.fromCodePoint(
          0x10000 + ((codeUnit - 0xd800) << 10) + (nextCodeUnit - 0xdc00)
        );
        continue;
      }
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        this.fail('unpaired low surrogate in JSON string');
      }
      result += unit;
    }
    this.fail('malformed JSON string');
  }

  parseRawStringUnit() {
    const char = this.text[this.index];
    if (char < ' ') this.fail('malformed JSON string');
    this.index += 1;
    return char;
  }

  parseEscape() {
    this.index += 1;
    const char = this.text[this.index];
    this.index += 1;
    if (char === '"' || char === '\\' || char === '/') return char;
    if (char === 'b') return '\b';
    if (char === 'f') return '\f';
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 't') return '\t';
    if (char !== 'u') this.fail('malformed JSON escape');
    const hex = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('malformed JSON unicode escape');
    this.index += 4;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  parseNumber() {
    const start = this.index;
    if (this.text[this.index] === '-') this.index += 1;
    if (this.text[this.index] === '0') {
      this.index += 1;
    } else if (this.text[this.index] >= '1' && this.text[this.index] <= '9') {
      while (this.text[this.index] >= '0' && this.text[this.index] <= '9') this.index += 1;
    } else {
      this.fail('malformed JSON number');
    }
    if (this.text[this.index] === '.') {
      this.index += 1;
      if (!(this.text[this.index] >= '0' && this.text[this.index] <= '9')) {
        this.fail('malformed JSON number');
      }
      while (this.text[this.index] >= '0' && this.text[this.index] <= '9') this.index += 1;
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index += 1;
      if (!(this.text[this.index] >= '0' && this.text[this.index] <= '9')) {
        this.fail('malformed JSON number');
      }
      while (this.text[this.index] >= '0' && this.text[this.index] <= '9') this.index += 1;
    }
    const value = Number(this.text.slice(start, this.index));
    if (!Number.isFinite(value)) this.fail('malformed JSON number');
    return value;
  }
}

function parseStrictJson(text, label = 'json') {
  if (Buffer.isBuffer(text)) text = text.toString('utf8');
  if (typeof text !== 'string') throw new Error(`${label}: JSON input must be text`);
  return new StrictJsonParser(text, label).parse();
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeObjectKeys(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeObjectKeys(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`${label}: unsafe prototype key "${key}"`);
    assertSafeObjectKeys(value[key], `${label}.${key}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (!isPlainObject(value)) throw new Error('cannot canonicalize value');
  assertSafeObjectKeys(value, 'canonical JSON');
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}

function assertHex64(value, label) {
  if (typeof value !== 'string' || !HEX_64.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex string`);
  }
}

function assertExactKeys(object, expected, label) {
  if (!isPlainObject(object)) throw new Error(`${label} must be an object`);
  assertSafeObjectKeys(object, label);
  const keys = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || !wanted.every((key, index) => keys[index] === key)) {
    throw new Error(`${label} has unknown or missing key`);
  }
}

function assertExactKeySet(object, expected, label) {
  assertExactKeys(object, expected, label);
}

function runTrustedCommand(command, args, options = {}) {
  const runner = options.spawnSync || spawnSync;
  const result = runner(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 15_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8'
    }
  });
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('trusted operating-system observation failed');
  }
  if (result.stdout.length > 1024 * 1024) {
    throw new Error('trusted operating-system observation exceeded its bound');
  }
  return result.stdout.trimEnd();
}

function parseSystemdProperties(output, expectedKeys, label) {
  if (typeof output !== 'string') throw new Error(`${label} must be text`);
  const properties = Object.create(null);
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`${label} is malformed`);
    const key = line.slice(0, separator);
    if (Object.hasOwn(properties, key)) throw new Error(`${label} has duplicate property`);
    properties[key] = line.slice(separator + 1);
  }
  assertExactKeySet(properties, expectedKeys, label);
  return properties;
}

function systemdProperties(unit, propertyNames, options = {}) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9@_.-]+$/.test(unit)) {
    throw new Error('invalid systemd unit name');
  }
  const output = runTrustedCommand(SYSTEMCTL, [
    'show',
    systemdInspectionUnitName(unit),
    '--no-pager',
    `--property=${propertyNames.join(',')}`
  ], options);
  return parseSystemdProperties(output, propertyNames, `systemd unit ${unit}`);
}

function systemdInspectionUnitName(unit) {
  if (unit === 'turingmarket-parser@.service') {
    return 'turingmarket-parser@test_instance.service';
  }
  return unit;
}

function systemdExpandedPath(value, expected, unit) {
  if (
    unit !== 'turingmarket-parser@.service' ||
    typeof value !== 'string' || typeof expected !== 'string'
  ) return false;
  const expanded = expected
    .replaceAll('%i', 'test_instance')
    .split(' ')
    .map((entry) => `${entry}:rbind`)
    .join(' ');
  return value === expanded;
}

function directSystemdSyscallGroupEntries(group, options = {}) {
  if (!/^@[a-z0-9-]+$/.test(group)) throw new Error('invalid systemd syscall group');
  if (typeof options.expandSyscallGroup === 'function') {
    const entries = options.expandSyscallGroup(group);
    if (!Array.isArray(entries)) throw new Error('invalid systemd syscall group expansion');
    return entries.slice();
  }
  const output = runTrustedCommand(
    SYSTEMD_ANALYZE,
    ['--no-pager', 'syscall-filter', group],
    options
  );
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines[0] !== group || !lines[1].startsWith('#')) {
    throw new Error('invalid systemd syscall group expansion');
  }
  return lines.slice(2);
}

function expandSystemdSyscallGroup(group, options = {}, state = {}) {
  const cache = state.cache || new Map();
  const stack = state.stack || new Set();
  if (cache.has(group)) return new Set(cache.get(group));
  if (stack.has(group) || stack.size >= 32) throw new Error('cyclic systemd syscall group');
  stack.add(group);
  const expanded = new Set();
  const entries = directSystemdSyscallGroupEntries(group, options);
  if (entries.length > 4096) throw new Error('systemd syscall group expansion exceeded its bound');
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new Error('invalid systemd syscall group entry');
    if (entry.startsWith('@')) {
      for (const syscall of expandSystemdSyscallGroup(entry, options, { cache, stack })) {
        expanded.add(syscall);
      }
    } else {
      if (!/^[A-Za-z0-9_]+$/.test(entry)) throw new Error('invalid systemd syscall group entry');
      expanded.add(entry);
    }
  }
  stack.delete(group);
  cache.set(group, [...expanded]);
  return new Set(expanded);
}

function systemCallPolicyName(unit) {
  const policy = unit === 'turingmarket-parser@.service'
    ? 'parser'
    : unit === 'turingmarket-parser-build.service'
      ? 'build'
      : null;
  if (!policy) throw new Error('unknown system call policy unit');
  return policy;
}

function pinnedSystemCallMaximumSha256(unit, options = {}) {
  const policy = systemCallPolicyName(unit);
  const testPins = options.pinnedSystemCallMaximumSha256ForTest;
  if (testPins !== undefined) {
    assertExactKeys(testPins, ['parser', 'build'], 'test system call policy pins');
    assertHex64(testPins.parser, 'test parser system call policy pin');
    assertHex64(testPins.build, 'test build system call policy pin');
    return testPins[policy];
  }
  return PINNED_SYSTEM_CALL_POLICY[`${policy}_maximum_sha256`];
}

function parseSystemCallList(value, label, requireSorted = false) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const tokens = value.split(/\s+/).filter(Boolean);
  if (
    tokens.length < 1 || new Set(tokens).size !== tokens.length ||
    tokens.some((token) => !/^[A-Za-z0-9_]+$/.test(token))
  ) {
    throw new Error(`${label} is invalid`);
  }
  const sorted = [...tokens].sort();
  if (requireSorted && tokens.some((token, index) => token !== sorted[index])) {
    throw new Error(`${label} is not canonical`);
  }
  return sorted;
}

function measureConcreteSystemCallPolicy(value, expected, unit, options = {}) {
  if (typeof expected !== 'string') throw new Error('system call policy is invalid');
  const allowedTokens = parseSystemCallList(value, 'concrete system call policy');
  const allowed = new Set(allowedTokens);
  const expectedTokens = expected.split(/\s+/).filter(Boolean);
  const denyIndex = expectedTokens.findIndex((token) => token.startsWith('~'));
  if (denyIndex < 1 || expectedTokens[0] !== '@system-service') return false;
  const allowPolicy = expectedTokens.slice(0, denyIndex);
  const denyPolicy = expectedTokens.slice(denyIndex).map((token) => (
    token.startsWith('~') ? token.slice(1) : token
  ));
  const cache = new Map();
  const expandPolicy = (tokens) => {
    const syscalls = new Set();
    for (const token of tokens) {
      if (token.startsWith('@')) {
        for (const syscall of expandSystemdSyscallGroup(token, options, { cache, stack: new Set() })) {
          syscalls.add(syscall);
        }
      } else {
        if (!/^[A-Za-z0-9_]+$/.test(token)) throw new Error('invalid systemd syscall policy');
        syscalls.add(token);
      }
    }
    return syscalls;
  };
  const maximumAllowed = expandPolicy(allowPolicy);
  for (const syscall of expandPolicy(denyPolicy)) maximumAllowed.delete(syscall);
  const dynamicMaximum = [...maximumAllowed].sort();
  if (sha256Canonical(dynamicMaximum) !== pinnedSystemCallMaximumSha256(unit, options)) {
    throw new Error('system call policy maximum drift');
  }
  const policy = systemCallPolicyName(unit);
  const reviewedMaximum = PINNED_SYSTEM_CALL_POLICY[`${policy}_maximum`];
  if (
    sha256Canonical(reviewedMaximum) !== PINNED_SYSTEM_CALL_POLICY[`${policy}_maximum_sha256`] ||
    [...allowed].some((syscall) => !maximumAllowed.has(syscall)) ||
    [...allowed].some((syscall) => !reviewedMaximum.includes(syscall)) ||
    !SYSTEM_CALL_BASELINE.every((syscall) => allowed.has(syscall))
  ) {
    throw new Error('concrete system call policy mismatch');
  }
  return deepFreeze({
    format: 'tm-concrete-system-call-policy-evidence-v1',
    policy,
    reviewed_runtime: {
      systemd: PINNED_SYSTEM_CALL_POLICY.systemd,
      architecture: PINNED_SYSTEM_CALL_POLICY.architecture,
      libseccomp: PINNED_SYSTEM_CALL_POLICY.libseccomp
    },
    concrete: allowedTokens,
    concrete_sha256: sha256Canonical(allowedTokens),
    maximum: reviewedMaximum.slice(),
    maximum_sha256: PINNED_SYSTEM_CALL_POLICY[`${policy}_maximum_sha256`]
  });
}

function validateConcreteSystemCallPolicyEvidence(evidence, unit) {
  try {
    assertExactKeys(evidence, SYSTEM_CALL_POLICY_EVIDENCE_KEYS, 'system call policy evidence');
    if (evidence.format !== 'tm-concrete-system-call-policy-evidence-v1') throw new Error('format mismatch');
    const policy = systemCallPolicyName(unit);
    if (evidence.policy !== policy) throw new Error('policy mismatch');
    assertExactKeys(
      evidence.reviewed_runtime,
      ['systemd', 'architecture', 'libseccomp'],
      'reviewed system call runtime'
    );
    if (
      evidence.reviewed_runtime.systemd !== PINNED_SYSTEM_CALL_POLICY.systemd ||
      evidence.reviewed_runtime.architecture !== PINNED_SYSTEM_CALL_POLICY.architecture ||
      evidence.reviewed_runtime.libseccomp !== PINNED_SYSTEM_CALL_POLICY.libseccomp
    ) throw new Error('runtime mismatch');
    if (!Array.isArray(evidence.concrete) || !Array.isArray(evidence.maximum)) throw new Error('list mismatch');
    const concrete = parseSystemCallList(evidence.concrete.join(' '), 'concrete evidence', true);
    const maximum = parseSystemCallList(evidence.maximum.join(' '), 'maximum evidence', true);
    const reviewedMaximum = PINNED_SYSTEM_CALL_POLICY[`${policy}_maximum`];
    if (
      !sameValue(maximum, reviewedMaximum) ||
      evidence.maximum_sha256 !== PINNED_SYSTEM_CALL_POLICY[`${policy}_maximum_sha256`] ||
      sha256Canonical(maximum) !== evidence.maximum_sha256 ||
      sha256Canonical(concrete) !== evidence.concrete_sha256 ||
      concrete.some((syscall) => !maximum.includes(syscall)) ||
      !SYSTEM_CALL_BASELINE.every((syscall) => concrete.includes(syscall))
    ) throw new Error('identity mismatch');
    assertHex64(evidence.concrete_sha256, 'concrete system call policy SHA-256');
  } catch {
    throw new Error('concrete system call policy evidence mismatch');
  }
  return true;
}

function normalizedSystemCallFilter(value, expected, unit, options = {}) {
  try {
    measureConcreteSystemCallPolicy(value, expected, unit, options);
    return true;
  } catch {
    return false;
  }
}

function normalizeSystemdProperty(unit, property, value, wanted, options = {}) {
  if (value === wanted && property !== 'SystemCallFilter') return wanted;
  const expansions = Object.freeze({
    IPAddressDeny: (observed, expected) => (
      expected === 'any' && observed === '0.0.0.0/0 ::/0'
    ),
    RestrictAddressFamilies: (observed, expected) => (
      expected === 'none' && observed === ''
    ),
    SystemCallFilter: (observed, expected) => (
      normalizedSystemCallFilter(observed, expected, unit, options)
    ),
    SystemCallErrorNumber: (observed, expected) => (
      expected === 'EPERM' && observed === '1'
    ),
    BindReadOnlyPaths: (observed, expected) => (
      systemdExpandedPath(observed, expected, unit)
    ),
    BindPaths: (observed, expected) => systemdExpandedPath(observed, expected, unit)
  });
  if (expansions[property] && expansions[property](value, wanted)) return wanted;
  throw new Error(`systemd property mismatch: ${unit}.${property}`);
}

function normalizeInstalledSystemdProperties(unit, observed, expected, options = {}) {
  const normalized = { ...observed };
  for (const [property, wanted] of Object.entries(expected)) {
    try {
      normalized[property] = normalizeSystemdProperty(
        unit,
        property,
        normalized[property],
        wanted,
        options
      );
    } catch {
      throw new Error(`installed systemd policy mismatch for ${unit}`);
    }
  }
  return normalized;
}

function assertVerifierSha256(expectedVerifierSha256) {
  assertHex64(expectedVerifierSha256, 'expected verifier SHA-256');
  const observed = sha256Bytes(fs.readFileSync(__filename));
  if (observed !== expectedVerifierSha256) throw new Error('verifier SHA-256 mismatch');
  return observed;
}

function readStrictEvidenceFile(filePath, label) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute`);
  }
  const resolvedPath = path.resolve(filePath);
  const pathBefore = fs.lstatSync(resolvedPath, { bigint: true });
  const descriptor = fs.openSync(resolvedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > 16n * 1024n * 1024n) {
      throw new Error(`${label} metadata is unsafe`);
    }
    assertSameRuntimeStat(pathBefore, stat, `${label} changed`);
    if (process.platform === 'linux' && (
      stat.uid !== 0n || stat.gid !== 0n || (stat.mode & 0o022n) !== 0n
    )) {
      throw new Error(`${label} metadata is unsafe`);
    }
    const bytes = fs.readFileSync(descriptor);
    const statAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(resolvedPath, { bigint: true });
    assertSameRuntimeStat(stat, statAfter, `${label} changed`);
    assertSameRuntimeStat(stat, pathAfter, `${label} changed`);
    return parseStrictJson(bytes, label);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertRuntimeTreeIdentity(tree, label, allowRoot) {
  const keys = allowRoot ? RUNTIME_TREE_KEYS : RUNTIME_TREE_KEYS.filter((key) => key !== 'root');
  assertExactKeySet(tree, keys, label);
  if (tree.format !== PARSER_RUNTIME_TREE_FORMAT) throw new Error(`${label} format mismatch`);
  if (allowRoot && (typeof tree.root !== 'string' || !path.posix.isAbsolute(tree.root))) {
    throw new Error(`${label} root must be absolute`);
  }
  assertHex64(tree.sha256, `${label} SHA-256`);
  for (const key of ['files', 'directories', 'bytes']) {
    if (!Number.isSafeInteger(tree[key]) || tree[key] < 0) {
      throw new Error(`${label} ${key} must be a safe non-negative integer`);
    }
  }
}

function runtimeTreeWithoutRoot(tree) {
  return {
    format: tree.format,
    sha256: tree.sha256,
    files: tree.files,
    directories: tree.directories,
    bytes: tree.bytes
  };
}

async function measureRuntimeTree(root, options = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('runtime root must be an absolute path');
  }
  const resolvedRoot = path.resolve(root);
  const requireRootOwnership = options.requireRootOwnership !== false;
  const testHooks = options.testHooks;
  if (testHooks !== undefined) {
    assertExactKeySet(testHooks, ['afterDirectoryRead'], 'runtime tree test hooks');
    if (typeof testHooks.afterDirectoryRead !== 'function') {
      throw new Error('runtime tree test hook must be a function');
    }
  }
  const digest = crypto.createHash('sha256');
  let files = 0;
  let directories = 1;
  let bytes = 0;
  let rootStat;
  try {
    rootStat = fs.lstatSync(resolvedRoot, { bigint: true });
  } catch {
    throw new Error('unsafe runtime tree: root is unavailable');
  }
  assertSafeDirectoryStat(rootStat, rootStat.dev, requireRootOwnership, 'root');

  digest.update(frame(PARSER_RUNTIME_TREE_FORMAT));
  digest.update(frame('directory'));
  digest.update(frame(''));
  digest.update(frame(formatMode(rootStat)));

  async function visitDirectory(absolutePath, relativePath, before) {
    let descriptor = null;
    try {
      descriptor = openDirectoryDescriptor(absolutePath);
      if (descriptor !== null) {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        assertSameRuntimeStat(before, opened, 'runtime tree directory changed');
      }
      const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
      if (testHooks) {
        await testHooks.afterDirectoryRead(Object.freeze({ absolutePath, relativePath }));
      }
      entries.sort((left, right) => Buffer.compare(
        Buffer.from(left.name, 'utf8'),
        Buffer.from(right.name, 'utf8')
      ));
      for (const entry of entries) {
        const childRelativePath = relativePath
          ? `${relativePath}/${entry.name}`
          : entry.name;
        const target = path.join(absolutePath, entry.name);
        let stat;
        try {
          stat = fs.lstatSync(target, { bigint: true });
        } catch {
          throw new Error('unsafe runtime tree: entry changed during traversal');
        }
        if (stat.isSymbolicLink()) {
          throw new Error('unsafe runtime tree: symbolic link rejected');
        }
        if (stat.isDirectory()) {
          assertSafeDirectoryStat(stat, rootStat.dev, requireRootOwnership, childRelativePath);
          directories += 1;
          digest.update(frame('directory'));
          digest.update(frame(childRelativePath));
          digest.update(frame(formatMode(stat)));
          await visitDirectory(target, childRelativePath, stat);
        } else if (stat.isFile()) {
          const file = hashRuntimeTreeFile(target, stat, rootStat.dev, requireRootOwnership);
          files += 1;
          bytes += file.bytes;
          if (!Number.isSafeInteger(bytes)) throw new Error('runtime tree byte overflow');
          digest.update(frame('file'));
          digest.update(frame(childRelativePath));
          digest.update(frame(file.mode));
          digest.update(frame(String(file.bytes)));
          digest.update(frame(file.sha256));
        } else {
          throw new Error('unsafe runtime tree: unsupported entry rejected');
        }
        if (files + directories > 100_000) throw new Error('runtime tree entry overflow');
      }
      const after = fs.lstatSync(absolutePath, { bigint: true });
      assertSameRuntimeStat(before, after, 'runtime tree directory changed');
      if (descriptor !== null) {
        const openedAfter = fs.fstatSync(descriptor, { bigint: true });
        assertSameRuntimeStat(before, openedAfter, 'runtime tree directory changed');
      }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
  }

  await visitDirectory(resolvedRoot, '', rootStat);
  return deepFreeze({
    format: PARSER_RUNTIME_TREE_FORMAT,
    sha256: digest.digest('hex'),
    files,
    directories,
    bytes
  });
}

function formatMode(stat) {
  return Number(stat.mode & 0o7777n).toString(8).padStart(4, '0');
}

function assertSafeOwnershipAndMode(stat, requireRootOwnership) {
  if (!requireRootOwnership) return;
  if (stat.uid !== 0n || stat.gid !== 0n) {
    throw new Error('unsafe runtime tree: non-root ownership rejected');
  }
  if ((stat.mode & 0o022n) !== 0n) {
    throw new Error('unsafe runtime tree: writable installed artifact rejected');
  }
}

function assertSafeDirectoryStat(stat, expectedDevice, requireRootOwnership, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expectedDevice || stat.nlink < 1n) {
    throw new Error(`unsafe runtime tree: directory ${label} rejected`);
  }
  assertSafeOwnershipAndMode(stat, requireRootOwnership);
}

function assertSafeFileStat(stat, expectedDevice, requireRootOwnership) {
  if (!stat.isFile() || stat.dev !== expectedDevice) {
    throw new Error('unsafe runtime tree: file rejected');
  }
  if (stat.nlink !== 1n) {
    throw new Error('unsafe runtime tree: hard-linked file rejected');
  }
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('unsafe runtime tree: file size rejected');
  }
  assertSafeOwnershipAndMode(stat, requireRootOwnership);
}

function assertSameRuntimeStat(before, after, message) {
  for (const key of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs']) {
    if (before[key] !== after[key]) throw new Error(message);
  }
}

function openDirectoryDescriptor(absolutePath) {
  if (process.platform === 'win32' || typeof fs.constants.O_DIRECTORY !== 'number') return null;
  const flags = fs.constants.O_RDONLY |
    fs.constants.O_DIRECTORY |
    (fs.constants.O_NOFOLLOW || 0);
  try {
    return fs.openSync(absolutePath, flags);
  } catch {
    throw new Error('unsafe runtime tree: directory handle rejected');
  }
}

function hashRuntimeTreeFile(target, pathStat, expectedDevice, requireRootOwnership) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(target, flags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertSafeFileStat(before, expectedDevice, requireRootOwnership);
    assertSameRuntimeStat(pathStat, before, 'runtime tree file changed');
    const fileBytes = Number(before.size);
    const contentDigest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < fileBytes) {
      const length = Math.min(buffer.length, fileBytes - position);
      const bytesRead = fs.readSync(descriptor, buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error('short runtime tree read');
      contentDigest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    assertSameRuntimeStat(before, after, 'runtime tree file changed');
    const pathAfter = fs.lstatSync(target, { bigint: true });
    assertSameRuntimeStat(before, pathAfter, 'runtime tree file changed');
    return Object.freeze({
      bytes: fileBytes,
      mode: formatMode(before),
      sha256: contentDigest.digest('hex')
    });
  } catch (error) {
    if (/runtime tree|short runtime/.test(error.message)) throw error;
    throw new Error('unsafe runtime tree: file changed during traversal');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateTrustedManifest(manifest) {
  assertExactKeys(manifest, MANIFEST_TOP_LEVEL_KEYS, 'trusted parser manifest');
  if (manifest.version !== 3) throw new Error('trusted parser manifest version mismatch');
  assertExactKeys(manifest.build, ['format', 'architecture', 'node_version', 'python_version'], 'manifest build');
  if (manifest.build.format !== 'tm-parser-runtime-build-v1') throw new Error('manifest build format mismatch');
  assertExactKeys(manifest.identity, [
    'user',
    'group',
    'home',
    'shell',
    'locked',
    'supplementary_groups'
  ], 'manifest identity');
  if (!Array.isArray(manifest.identity.supplementary_groups)) {
    throw new Error('manifest identity supplementary groups must be an array');
  }
  assertHex64(manifest.route_registry_sha256, 'manifest route registry SHA-256');
  if (!isPlainObject(manifest.artifacts) || Object.keys(manifest.artifacts).length < 1) {
    throw new Error('manifest artifacts must be a non-empty object');
  }
  for (const [name, digest] of Object.entries(manifest.artifacts)) {
    if (typeof name !== 'string' || path.isAbsolute(name) || name.includes('..')) {
      throw new Error('manifest artifact path is unsafe');
    }
    assertHex64(digest, `manifest artifact ${name}`);
  }
  assertRuntimeTreeIdentity(manifest.runtime_tree, 'manifest runtime tree', true);
  assertExactKeySet(
    manifest.effective_properties,
    ['turingmarket-parser@.service', 'turingmarket-parser.slice'],
    'manifest effective properties'
  );
  for (const [unit, properties] of Object.entries(manifest.effective_properties)) {
    if (!isPlainObject(properties) || Object.keys(properties).length < 1) {
      throw new Error(`manifest effective properties for ${unit} must be a non-empty object`);
    }
    for (const [key, value] of Object.entries(properties)) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        throw new Error(`manifest effective property ${unit}.${key} must be a string`);
      }
    }
  }
  if (!Array.isArray(manifest.required_self_tests) || manifest.required_self_tests.length < 1) {
    throw new Error('manifest required self-tests must be a non-empty array');
  }
  const names = new Set();
  for (const name of manifest.required_self_tests) {
    if (typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name) || names.has(name)) {
      throw new Error('manifest required self-tests are invalid');
    }
    names.add(name);
  }
  return deepFreeze(manifest);
}

function loadTrustedParserManifest(manifestPath, expectedSha256) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    throw new Error('trusted parser manifest path is required');
  }
  assertHex64(expectedSha256, 'expected manifest SHA-256');
  const resolvedPath = path.resolve(manifestPath);
  const pathBefore = fs.lstatSync(resolvedPath, { bigint: true });
  const descriptor = fs.openSync(resolvedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > 1024n * 1024n) {
      throw new Error('trusted parser manifest file metadata is unsafe');
    }
    assertSameRuntimeStat(pathBefore, stat, 'trusted parser manifest file changed');
    if (process.platform === 'linux' && (stat.mode & 0o022n) !== 0n) {
      throw new Error('trusted parser manifest file metadata is unsafe');
    }
    const bytes = fs.readFileSync(descriptor);
    const statAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(resolvedPath, { bigint: true });
    assertSameRuntimeStat(stat, statAfter, 'trusted parser manifest file changed');
    assertSameRuntimeStat(stat, pathAfter, 'trusted parser manifest file changed');
    const actualSha256 = sha256Bytes(bytes);
    if (actualSha256 !== expectedSha256) throw new Error('trusted parser manifest SHA-256 mismatch');
    const manifest = validateTrustedManifest(parseStrictJson(bytes, 'trusted parser manifest'));
    const loadResult = Object.freeze({
      format: 'tm-trusted-parser-manifest-load-v1',
      manifest,
      sha256: actualSha256
    });
    trustedManifestLoads.set(loadResult, Object.freeze({
      manifest,
      sha256: actualSha256,
      rawBytes: bytes.toString('latin1')
    }));
    return loadResult;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readInstalledUnitArtifact(target) {
  const resolvedPath = path.resolve(target);
  const before = fs.lstatSync(resolvedPath, { bigint: true });
  const descriptor = fs.openSync(
    resolvedPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() || stat.uid !== 0n || stat.gid !== 0n || stat.nlink !== 1n ||
      (stat.mode & 0o022n) !== 0n || stat.size < 1n || stat.size > 1024n * 1024n
    ) {
      throw new Error('installed systemd unit metadata is unsafe');
    }
    assertSameRuntimeStat(before, stat, 'installed systemd unit changed');
    const bytes = fs.readFileSync(descriptor);
    assertSameRuntimeStat(stat, fs.fstatSync(descriptor, { bigint: true }), 'installed systemd unit changed');
    assertSameRuntimeStat(stat, fs.lstatSync(resolvedPath, { bigint: true }), 'installed systemd unit changed');
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyInstalledUnitArtifact(unit, observed, manifest, options = {}) {
  const artifacts = {
    'turingmarket-parser@.service': 'systemd/turingmarket-parser@.service',
    'turingmarket-parser.slice': 'systemd/turingmarket-parser.slice'
  };
  const relativePath = artifacts[unit];
  const target = observed.FragmentPath;
  const expectedTarget = `/etc/systemd/system/${unit}`;
  if (!relativePath || target !== expectedTarget) {
    throw new Error(`installed systemd policy mismatch for ${unit}`);
  }
  const reader = options.readInstalledArtifact || readInstalledUnitArtifact;
  const bytes = reader(target, unit);
  if (!Buffer.isBuffer(bytes) || sha256Bytes(bytes) !== manifest.artifacts[relativePath]) {
    throw new Error(`installed systemd unit identity mismatch for ${unit}`);
  }
}

function expectedInstalledManagerState(unit, expected) {
  return {
    Id: systemdInspectionUnitName(unit),
    LoadState: 'loaded',
    FragmentPath: expected.FragmentPath,
    SourcePath: '',
    DropInPaths: '',
    NeedDaemonReload: 'no',
    Transient: 'no'
  };
}

function selectInstalledManagerState(raw) {
  return Object.fromEntries(INSTALLED_MANAGER_STATE_KEYS.map((name) => [name, raw[name]]));
}

function observeInstalledSystemdPolicy(manifest, options = {}) {
  validateTrustedManifest(manifest);
  const effectiveProperties = {};
  const managerState = {};
  const concreteSystemCallPolicies = {};
  for (const [unit, expected] of Object.entries(manifest.effective_properties)) {
    const propertyNames = [...new Set([...Object.keys(expected), ...INSTALLED_MANAGER_STATE_KEYS])];
    const raw = systemdProperties(unit, propertyNames, options);
    const managerBefore = selectInstalledManagerState(raw);
    const expectedManager = expectedInstalledManagerState(unit, expected);
    if (!sameValue(managerBefore, expectedManager)) {
      throw new Error(`installed systemd policy mismatch for ${unit}`);
    }
    if (Object.hasOwn(expected, 'SystemCallFilter')) {
      concreteSystemCallPolicies[unit] = measureConcreteSystemCallPolicy(
        raw.SystemCallFilter,
        expected.SystemCallFilter,
        unit,
        options
      );
    }
    const policy = Object.fromEntries(Object.keys(expected).map((name) => [name, raw[name]]));
    const observed = normalizeInstalledSystemdProperties(
      unit,
      policy,
      expected,
      options
    );
    if (!sameValue(observed, expected)) {
      throw new Error(`installed systemd policy mismatch for ${unit}`);
    }
    verifyInstalledUnitArtifact(unit, managerBefore, manifest, options);
    const managerAfter = selectInstalledManagerState(systemdProperties(
      unit,
      INSTALLED_MANAGER_STATE_KEYS,
      options
    ));
    if (!sameValue(managerAfter, managerBefore)) {
      throw new Error(`installed systemd manager state changed for ${unit}`);
    }
    effectiveProperties[unit] = observed;
    managerState[unit] = managerBefore;
  }
  return deepFreeze({
    format: INSTALLED_POLICY_OBSERVATION_FORMAT,
    effective_properties: effectiveProperties,
    manager_state: managerState,
    concrete_system_call_policies: concreteSystemCallPolicies
  });
}

function validateInstalledPolicyObservation(observation, manifest) {
  assertExactKeys(
    observation,
    INSTALLED_POLICY_OBSERVATION_KEYS,
    'installed systemd policy observation'
  );
  if (observation.format !== INSTALLED_POLICY_OBSERVATION_FORMAT) {
    throw new Error('independent installed policy observation mismatch');
  }
  if (!sameValue(observation.effective_properties, manifest.effective_properties)) {
    throw new Error('independent installed policy observation mismatch');
  }
  const units = Object.keys(manifest.effective_properties);
  assertExactKeys(observation.manager_state, units, 'installed systemd manager state');
  const policyUnits = units.filter((unit) => (
    Object.hasOwn(manifest.effective_properties[unit], 'SystemCallFilter')
  ));
  assertExactKeys(
    observation.concrete_system_call_policies,
    policyUnits,
    'installed concrete system call policies'
  );
  for (const unit of units) {
    assertExactKeys(
      observation.manager_state[unit],
      INSTALLED_MANAGER_STATE_KEYS,
      `installed systemd manager state for ${unit}`
    );
    const expected = expectedInstalledManagerState(unit, manifest.effective_properties[unit]);
    if (!sameValue(observation.manager_state[unit], expected)) {
      throw new Error('independent installed policy observation mismatch');
    }
    if (policyUnits.includes(unit)) {
      validateConcreteSystemCallPolicyEvidence(
        observation.concrete_system_call_policies[unit],
        unit
      );
    }
  }
}

function hashPinnedSourceFile(target, expectedSha256, expectedDevice) {
  const pathBefore = fs.lstatSync(target, { bigint: true });
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() || stat.dev !== expectedDevice || stat.uid !== 0n || stat.gid !== 0n ||
      stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n
    ) {
      throw new Error('parser source artifact metadata is unsafe');
    }
    assertSameRuntimeStat(pathBefore, stat, 'parser source artifact changed');
    const bytes = fs.readFileSync(descriptor);
    const statAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(target, { bigint: true });
    assertSameRuntimeStat(stat, statAfter, 'parser source artifact changed');
    assertSameRuntimeStat(stat, pathAfter, 'parser source artifact changed');
    if (sha256Bytes(bytes) !== expectedSha256) throw new Error('parser source artifact SHA-256 mismatch');
  } finally {
    fs.closeSync(descriptor);
  }
}

function measureSourceArtifacts(sourceRoot, manifest) {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) {
    throw new Error('parser source root must be absolute');
  }
  const resolvedRoot = path.resolve(sourceRoot);
  const rootStat = fs.lstatSync(resolvedRoot, { bigint: true });
  if (
    !rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0n || rootStat.gid !== 0n ||
    (rootStat.mode & 0o022n) !== 0n
  ) {
    throw new Error('parser source root metadata is unsafe');
  }
  for (const [relativePath, expectedSha256] of Object.entries(manifest.artifacts)) {
    const target = path.resolve(resolvedRoot, ...relativePath.split('/'));
    if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('parser source artifact path escaped');
    hashPinnedSourceFile(target, expectedSha256, rootStat.dev);
  }
  return sha256Canonical(manifest.artifacts);
}

const BUILD_SYSTEM_CALL_FILTER = [
  '@system-service', '~@mount', '@privileged', '@raw-io', '@reboot', '@swap',
  '@resources', '@obsolete', '@debug', '@clock',
  'accept', 'accept4', 'bind', 'connect', 'getpeername', 'getsockname', 'getsockopt',
  'listen', 'recv', 'recvfrom', 'recvmmsg', 'recvmmsg_time64', 'recvmsg', 'send',
  'sendmmsg', 'sendmsg', 'sendto', 'setsockopt', 'socket', 'socketcall',
  'io_uring_setup', 'io_uring_enter', 'io_uring_register'
].join(' ');

const BUILD_UNIT_LIVE_PROPERTIES = Object.freeze([
  'LoadState', 'ActiveState', 'SubState', 'MainPID', 'NeedDaemonReload'
]);
const BUILD_UNIT_MOUNT_PROPERTIES = Object.freeze([
  'TemporaryFileSystem', 'InaccessiblePaths', 'BindReadOnlyPaths', 'BindPaths', 'ReadWritePaths'
]);
const BUILD_UNIT_EVIDENCE_PROPERTIES = Object.freeze(['SystemCallPolicyEvidence']);
const BUILD_UNIT_FRAGMENT_DERIVED_PROPERTIES = Object.freeze([
  'EnvironmentFiles',
  'LoadCredential',
  'LoadCredentialEncrypted',
  'SetCredential',
  'SetCredentialEncrypted'
]);

const BUILD_UNIT_STATIC_PROPERTIES = Object.freeze({
  Type: 'exec',
  Transient: 'yes',
  CollectMode: 'inactive-or-failed',
  FragmentPath: '/run/systemd/transient/turingmarket-parser-build.service',
  DropInPaths: '',
  User: BUILD_USER,
  Group: BUILD_GROUP,
  SupplementaryGroups: '',
  UMask: '0077',
  WorkingDirectory: '/build-work',
  PrivateNetwork: 'yes',
  IPAddressDeny: 'any',
  RestrictAddressFamilies: 'AF_UNIX',
  PrivateMounts: 'yes',
  PrivateTmp: 'yes',
  PrivateUsers: 'yes',
  PrivateDevices: 'yes',
  DevicePolicy: 'closed',
  PrivateIPC: 'yes',
  PrivatePIDs: 'yes',
  ProtectSystem: 'strict',
  ProtectHome: 'yes',
  ProtectProc: 'invisible',
  ProcSubset: 'pid',
  ProtectKernelTunables: 'yes',
  ProtectKernelModules: 'yes',
  ProtectKernelLogs: 'yes',
  ProtectControlGroups: 'yes',
  ProtectClock: 'yes',
  ProtectHostname: 'yes',
  NoNewPrivileges: 'yes',
  CapabilityBoundingSet: '',
  AmbientCapabilities: '',
  RestrictNamespaces: 'yes',
  RestrictSUIDSGID: 'yes',
  LockPersonality: 'yes',
  SystemCallArchitectures: 'native',
  SystemCallFilter: BUILD_SYSTEM_CALL_FILTER,
  SystemCallErrorNumber: 'EPERM',
  KeyringMode: 'private',
  Environment: '',
  EnvironmentFiles: '',
  LoadCredential: '',
  LoadCredentialEncrypted: '',
  SetCredential: '',
  SetCredentialEncrypted: '',
  MemoryMax: '3221225472',
  TasksMax: '256',
  LimitNOFILE: '1024',
  LimitNOFILESoft: '1024',
  LimitCORE: '0',
  LimitCORESoft: '0',
  TimeoutStartUSec: '20min',
  TimeoutStopUSec: '5s',
  StandardInput: 'null',
  StandardOutput: 'journal',
  StandardError: 'journal'
});

const BUILD_TEMPORARY_FILE_SYSTEMS = Object.freeze([
  '/root:ro',
  '/home:ro',
  '/etc:ro',
  '/opt:ro',
  '/srv:ro',
  '/tmp:ro',
  '/var:ro',
  '/run:ro',
  '/data:ro',
  '/mnt:ro',
  '/media:ro'
]);
const BUILD_INACCESSIBLE_PATHS = Object.freeze([
  '/etc/turingmarket',
  '/etc/credstore',
  '/etc/credstore.encrypted',
  '/run/credentials',
  '/run/secrets',
  '/root/turingmarket',
  '/var/lib/turingmarket-gate',
  '/var/lib/turingmarket-parser',
  '/opt/turingmarket',
  '/srv/turingmarket'
]);
const BUILD_MOUNT_EVIDENCE_PROPERTIES = Object.freeze({
  TemporaryFileSystem: BUILD_TEMPORARY_FILE_SYSTEMS.join(' '),
  InaccessiblePaths: BUILD_INACCESSIBLE_PATHS.join(' '),
  BindReadOnlyPaths: 'source-root:/build-input dependency-cache-root:/dependency-cache',
  BindPaths: 'build-work:/build-work',
  ReadWritePaths: '/build-work'
});

function observeBuildFragmentIsolation(fragmentPath, options = {}) {
  if (fragmentPath !== BUILD_UNIT_STATIC_PROPERTIES.FragmentPath) {
    throw new Error('parser build unit fragment path mismatch');
  }
  const reader = options.readBuildUnitArtifact || readInstalledUnitArtifact;
  const bytes = reader(fragmentPath);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024) {
    throw new Error('parser build unit fragment is invalid');
  }
  const text = bytes.toString('utf8');
  if (text.includes('\0') || /\r(?!\n)/.test(text) || !Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('parser build unit fragment encoding is invalid');
  }

  let serviceSections = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.endsWith('\\')) {
      throw new Error('parser build unit line continuation is not allowed');
    }
    const line = rawLine.trim();
    if (line === '[Service]') serviceSections += 1;
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (/^EnvironmentFile[ \t]*=/.test(line)) {
      throw new Error('parser build unit environment file directive is not allowed');
    }
    if (/^(?:LoadCredential|LoadCredentialEncrypted|SetCredential|SetCredentialEncrypted)[ \t]*=/.test(line)) {
      throw new Error('parser build unit credential directive is not allowed');
    }
  }
  if (serviceSections !== 1) throw new Error('parser build unit service section mismatch');
  return Object.freeze({
    EnvironmentFiles: '',
    LoadCredential: '',
    LoadCredentialEncrypted: '',
    SetCredential: '',
    SetCredentialEncrypted: ''
  });
}

function validateBuildUnitProperties(properties) {
  try {
    assertExactKeys(
      properties,
      [
        ...BUILD_UNIT_LIVE_PROPERTIES,
        ...Object.keys(BUILD_UNIT_STATIC_PROPERTIES),
        ...BUILD_UNIT_MOUNT_PROPERTIES,
        ...BUILD_UNIT_EVIDENCE_PROPERTIES
      ],
      'build unit properties'
    );
    if (
      properties.LoadState !== 'loaded' || properties.ActiveState !== 'active' ||
      properties.SubState !== 'running' || properties.NeedDaemonReload !== 'no' ||
      !/^[1-9][0-9]*$/.test(properties.MainPID)
    ) {
      throw new Error('live state mismatch');
    }
    for (const [name, expected] of Object.entries(BUILD_UNIT_STATIC_PROPERTIES)) {
      if (properties[name] !== expected) throw new Error(`static property mismatch: ${name}`);
    }
    for (const [name, expected] of Object.entries(BUILD_MOUNT_EVIDENCE_PROPERTIES)) {
      if (properties[name] !== expected) throw new Error(`mount property mismatch: ${name}`);
    }
    validateConcreteSystemCallPolicyEvidence(
      properties.SystemCallPolicyEvidence,
      'turingmarket-parser-build.service'
    );
  } catch {
    throw new Error('build unit properties mismatch');
  }
  return true;
}

function exactSystemdTokenSet(value, expected, normalize = (token) => token) {
  if (typeof value !== 'string') return false;
  const tokens = value.split(/\s+/).filter(Boolean).map(normalize);
  if (tokens.some((token) => typeof token !== 'string' || token.length === 0)) return false;
  const observed = [...tokens].sort();
  const wanted = [...expected].sort();
  return observed.length === wanted.length &&
    new Set(observed).size === observed.length &&
    observed.every((token, index) => token === wanted[index]);
}

function validateBuildMountIsolation(observed, roots) {
  if (!isPlainObject(observed) || !isPlainObject(roots)) {
    throw new Error('build mount isolation mismatch');
  }
  const { sourceRoot, dependencyCacheRoot, buildWork } = roots;
  for (const target of [sourceRoot, dependencyCacheRoot, buildWork]) {
    if (typeof target !== 'string' || !path.isAbsolute(target) || /\s/.test(target)) {
      throw new Error('build mount isolation mismatch');
    }
  }
  const stripOptional = (token) => token.startsWith('-') ? token.slice(1) : token;
  const stripRecursiveBind = (token) => token.endsWith(':rbind')
    ? token.slice(0, -':rbind'.length)
    : token;
  if (
    !exactSystemdTokenSet(
      observed.TemporaryFileSystem,
      BUILD_TEMPORARY_FILE_SYSTEMS
    ) ||
    !exactSystemdTokenSet(
      observed.InaccessiblePaths,
      BUILD_INACCESSIBLE_PATHS,
      stripOptional
    ) ||
    !exactSystemdTokenSet(
      observed.BindReadOnlyPaths,
      [`${sourceRoot}:/build-input`, `${dependencyCacheRoot}:/dependency-cache`],
      stripRecursiveBind
    ) ||
    !exactSystemdTokenSet(
      observed.BindPaths,
      [`${buildWork}:/build-work`],
      stripRecursiveBind
    ) ||
    !exactSystemdTokenSet(observed.ReadWritePaths, ['/build-work'])
  ) {
    throw new Error('build mount isolation mismatch');
  }
  return true;
}

function observeBuildUnit(unit, sourceRoot, dependencyCacheRoot, buildWork, options = {}) {
  if (unit !== 'turingmarket-parser-build.service') throw new Error('unexpected parser build unit');
  for (const value of [sourceRoot, dependencyCacheRoot, buildWork]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('invalid parser build mount');
  }
  const propertyNames = [
    ...BUILD_UNIT_LIVE_PROPERTIES,
    ...Object.keys(BUILD_UNIT_STATIC_PROPERTIES).filter(
      (name) => !BUILD_UNIT_FRAGMENT_DERIVED_PROPERTIES.includes(name)
    ),
    ...BUILD_UNIT_MOUNT_PROPERTIES
  ];
  const observed = systemdProperties(unit, propertyNames, options);
  Object.assign(observed, observeBuildFragmentIsolation(observed.FragmentPath, options));
  const systemCallPolicyEvidence = measureConcreteSystemCallPolicy(
    observed.SystemCallFilter,
    BUILD_UNIT_STATIC_PROPERTIES.SystemCallFilter,
    unit,
    options
  );
  if (
    observed.LoadState !== 'loaded' || observed.ActiveState !== 'active' ||
    observed.SubState !== 'running' || observed.NeedDaemonReload !== 'no'
  ) {
    throw new Error('parser build unit was not live for observation');
  }
  if (!/^[1-9][0-9]*$/.test(observed.MainPID)) throw new Error('parser build unit has no non-root process');
  for (const [property, expected] of Object.entries(BUILD_UNIT_STATIC_PROPERTIES)) {
    try {
      observed[property] = normalizeSystemdProperty(
        unit,
        property,
        observed[property],
        expected,
        options
      );
    } catch {
      throw new Error(`parser build unit property mismatch: ${property}`);
    }
  }
  validateBuildMountIsolation(observed, { sourceRoot, dependencyCacheRoot, buildWork });
  Object.assign(observed, BUILD_MOUNT_EVIDENCE_PROPERTIES);
  observed.SystemCallPolicyEvidence = systemCallPolicyEvidence;
  validateBuildUnitProperties(observed);
  return deepFreeze(observed);
}

function observeBuildParent(buildParent, options = {}) {
  if (typeof buildParent !== 'string' || !path.isAbsolute(buildParent)) {
    throw new Error('parser build parent must be absolute');
  }
  const stat = fs.lstatSync(path.resolve(buildParent), { bigint: true });
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n ||
    (stat.mode & 0o777n) !== 0o700n
  ) {
    throw new Error('parser build parent metadata is unsafe');
  }
  for (const permission of ['-r', '-x']) {
    runTrustedCommand(RUNUSER, [
      '-u', BUILD_USER, '--', '/usr/bin/test', '!', permission, path.resolve(buildParent)
    ], options);
  }
  return deepFreeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: '0700',
    uid: 0,
    gid: 0
  });
}

function observeBuildBoundary(options = {}) {
  const {
    trustedManifest,
    expectedManifestSha256,
    expectedVerifierSha256,
    sourceRoot,
    unit,
    buildParent,
    dependencyCacheRoot,
    buildWork,
    commandOptions
  } = options;
  const loaded = trustedManifestLoads.get(trustedManifest);
  if (!loaded) throw new Error('trusted manifest load result is required');
  if (loaded.sha256 !== expectedManifestSha256) throw new Error('manifest SHA-256 mismatch');
  assertVerifierSha256(expectedVerifierSha256);
  const sourceArtifactsSha256 = measureSourceArtifacts(sourceRoot, loaded.manifest);
  const unitProperties = observeBuildUnit(
    unit,
    sourceRoot,
    dependencyCacheRoot,
    buildWork,
    commandOptions
  );
  const buildParentIdentity = observeBuildParent(buildParent, commandOptions);
  return deepFreeze({
    format: BUILD_BOUNDARY_OBSERVATION_FORMAT,
    manifest_sha256: loaded.sha256,
    source_artifacts_sha256: sourceArtifactsSha256,
    build_unit: unit,
    build_unit_properties: unitProperties,
    build_unit_properties_sha256: sha256Canonical(unitProperties),
    build_parent: buildParentIdentity,
    network_isolation: true,
    mount_isolation: true,
    credential_isolation: true,
    build_parent_inaccessible: true
  });
}

function validateBuildBoundaryObservation(observation, manifest) {
  assertExactKeys(observation, BUILD_OBSERVATION_KEYS, 'build boundary observation');
  if (observation.format !== BUILD_BOUNDARY_OBSERVATION_FORMAT) {
    throw new Error('build boundary observation format mismatch');
  }
  assertHex64(observation.manifest_sha256, 'build boundary manifest SHA-256');
  assertHex64(observation.source_artifacts_sha256, 'build boundary source artifacts SHA-256');
  assertHex64(observation.build_unit_properties_sha256, 'build unit properties SHA-256');
  if (!isPlainObject(observation.build_unit_properties)) {
    throw new Error('build unit properties are missing');
  }
  if (sha256Canonical(observation.build_unit_properties) !== observation.build_unit_properties_sha256) {
    throw new Error('build unit properties SHA-256 mismatch');
  }
  validateBuildUnitProperties(observation.build_unit_properties);
  if (observation.build_unit !== 'turingmarket-parser-build.service') {
    throw new Error('build boundary unit mismatch');
  }
  assertExactKeys(observation.build_parent, BUILD_PARENT_KEYS, 'build parent observation');
  if (
    !/^[0-9]+$/.test(observation.build_parent.device) ||
    !/^[0-9]+$/.test(observation.build_parent.inode) ||
    observation.build_parent.mode !== '0700' ||
    observation.build_parent.uid !== 0 || observation.build_parent.gid !== 0
  ) {
    throw new Error('build parent observation mismatch');
  }
  if (observation.source_artifacts_sha256 !== sha256Canonical(manifest.artifacts)) {
    throw new Error('build source artifact identity mismatch');
  }
  for (const name of [
    'network_isolation', 'mount_isolation', 'credential_isolation', 'build_parent_inaccessible'
  ]) {
    if (observation[name] !== true) throw new Error(`build boundary ${name} was not verified`);
  }
}

function validateBuildEvidence(
  evidence,
  manifestSha256,
  verifierSha256,
  expectedRuntimeTree,
  expectedSourceArtifactsSha256
) {
  assertExactKeys(evidence, BUILD_EVIDENCE_KEYS, 'build evidence');
  if (evidence.format !== BUILD_EVIDENCE_FORMAT) throw new Error('build evidence format mismatch');
  if (evidence.manifest_sha256 !== manifestSha256) throw new Error('build evidence manifest SHA-256 mismatch');
  if (evidence.verifier_sha256 !== verifierSha256) throw new Error('build evidence verifier SHA-256 mismatch');
  assertRuntimeTreeIdentity(evidence.runtime_tree, 'build evidence runtime tree', false);
  if (!sameValue(evidence.runtime_tree, expectedRuntimeTree)) throw new Error('build evidence runtime identity mismatch');
  assertExactKeys(evidence.build_boundary, BUILD_BOUNDARY_KEYS, 'build boundary');
  if (evidence.build_boundary.format !== BUILD_BOUNDARY_FORMAT) throw new Error('build boundary format mismatch');
  for (const name of ['source_artifacts_sha256', 'build_unit_properties_sha256']) {
    assertHex64(evidence.build_boundary[name], `build boundary ${name}`);
  }
  if (!isPlainObject(evidence.build_boundary.build_unit_properties)) {
    throw new Error('build unit properties are missing');
  }
  if (
    sha256Canonical(evidence.build_boundary.build_unit_properties) !==
    evidence.build_boundary.build_unit_properties_sha256
  ) {
    throw new Error('build unit properties SHA-256 mismatch');
  }
  validateBuildUnitProperties(evidence.build_boundary.build_unit_properties);
  if (evidence.build_boundary.build_unit !== 'turingmarket-parser-build.service') {
    throw new Error('build boundary unit mismatch');
  }
  if (evidence.build_boundary.source_artifacts_sha256 !== expectedSourceArtifactsSha256) {
    throw new Error('build source artifact identity mismatch');
  }
  for (const name of [
    'build_unit_stopped', 'build_unit_collected', 'network_isolation', 'mount_isolation',
    'credential_isolation', 'build_parent_inaccessible'
  ]) {
    if (evidence.build_boundary[name] !== true) throw new Error(`build boundary ${name} was not verified`);
  }
}

async function finalizeBuildBoundary(options = {}) {
  const {
    trustedManifest,
    expectedManifestSha256,
    expectedVerifierSha256,
    observation,
    runtimeRoot,
    unit,
    buildParent,
    commandOptions
  } = options;
  const loaded = trustedManifestLoads.get(trustedManifest);
  if (!loaded) throw new Error('trusted manifest load result is required');
  if (loaded.sha256 !== expectedManifestSha256) throw new Error('manifest SHA-256 mismatch');
  const verifierSha256 = assertVerifierSha256(expectedVerifierSha256);
  validateBuildBoundaryObservation(observation, loaded.manifest);
  if (observation.manifest_sha256 !== loaded.sha256 || observation.build_unit !== unit) {
    throw new Error('build boundary observation identity mismatch');
  }
  const parentAfter = observeBuildParent(buildParent, commandOptions);
  if (!sameValue(parentAfter, observation.build_parent)) throw new Error('build parent changed during build');
  const loadState = runTrustedCommand(
    SYSTEMCTL,
    ['show', unit, '--no-pager', '--property=LoadState', '--value'],
    commandOptions
  );
  if (loadState !== 'not-found') throw new Error('parser build unit was not collected');
  const runtimeTree = await measureRuntimeTree(runtimeRoot, { requireRootOwnership: false });
  const expectedRuntimeTree = runtimeTreeWithoutRoot(loaded.manifest.runtime_tree);
  if (!sameValue(runtimeTree, expectedRuntimeTree)) throw new Error('built parser runtime identity mismatch');
  return deepFreeze({
    format: BUILD_EVIDENCE_FORMAT,
    manifest_sha256: loaded.sha256,
    verifier_sha256: verifierSha256,
    runtime_tree: runtimeTree,
    build_boundary: {
      format: BUILD_BOUNDARY_FORMAT,
      source_artifacts_sha256: observation.source_artifacts_sha256,
      build_unit: observation.build_unit,
      build_unit_properties: observation.build_unit_properties,
      build_unit_properties_sha256: observation.build_unit_properties_sha256,
      build_unit_stopped: true,
      build_unit_collected: true,
      network_isolation: observation.network_isolation,
      mount_isolation: observation.mount_isolation,
      credential_isolation: observation.credential_isolation,
      build_parent_inaccessible: observation.build_parent_inaccessible
    }
  });
}

function validateRawObservations(raw, manifestSha256, requiredSelfTests) {
  assertExactKeys(raw, RAW_OBSERVATION_KEYS, 'raw observations');
  if (raw.format !== RAW_OBSERVATIONS_FORMAT) throw new Error('raw observations format mismatch');
  if (raw.manifest_sha256 !== manifestSha256) throw new Error('raw observations manifest SHA-256 mismatch');
  assertRuntimeTreeIdentity(raw.runtime_tree, 'raw observations runtime tree', false);
  if (!isPlainObject(raw.effective_properties)) throw new Error('raw observations effective properties must be an object');
  if (!Array.isArray(raw.parser_acceptance) || raw.parser_acceptance.length !== REQUIRED_ACCEPTANCE.length) {
    throw new Error('raw observations must contain concrete parser acceptance observations');
  }
  for (let index = 0; index < REQUIRED_ACCEPTANCE.length; index += 1) {
    assertExactKeys(
      raw.parser_acceptance[index],
      ['format', 'parser', 'marker', 'marker_found', 'ocr_used'],
      `raw observations parser acceptance ${index}`
    );
    if (!sameValue(raw.parser_acceptance[index], REQUIRED_ACCEPTANCE[index])) {
      throw new Error('raw observations parser acceptance mismatch');
    }
  }
  assertExactKeys(raw.self_tests, requiredSelfTests, 'raw observations self-tests');
  for (const name of requiredSelfTests) {
    if (raw.self_tests[name] !== true) {
      throw new Error(`required self-test ${name} was not exactly true`);
    }
  }
}

function bindAcceptanceEvidence(options = {}) {
  const {
    trustedManifest,
    expectedManifestSha256,
    expectedVerifierSha256,
    selfTestEvidence,
    runtimeObservation,
    installedPolicyObservation,
    buildEvidence
  } = options;
  if (Object.hasOwn(options, 'manifest') || Object.hasOwn(options, 'manifestSha256')) {
    throw new Error('trusted manifest load result is required');
  }
  const loaded = trustedManifestLoads.get(trustedManifest);
  if (!loaded) throw new Error('trusted manifest load result is required');
  assertHex64(expectedManifestSha256, 'expected manifest SHA-256');
  assertHex64(expectedVerifierSha256, 'expected verifier SHA-256');
  if (loaded.sha256 !== expectedManifestSha256) throw new Error('manifest SHA-256 mismatch');

  const verifierSha256 = assertVerifierSha256(expectedVerifierSha256);
  const manifest = loaded.manifest;
  if (!isPlainObject(selfTestEvidence) || selfTestEvidence.format !== RAW_OBSERVATIONS_FORMAT) {
    throw new Error('raw observations are required for parser acceptance binding');
  }

  validateRawObservations(selfTestEvidence, loaded.sha256, manifest.required_self_tests);
  const expectedRuntimeTree = runtimeTreeWithoutRoot(manifest.runtime_tree);
  if (!sameValue(runtimeObservation, selfTestEvidence.runtime_tree)) {
    throw new Error('runtime tree observation mismatch');
  }
  if (!sameValue(selfTestEvidence.runtime_tree, expectedRuntimeTree)) {
    throw new Error('runtime tree identity mismatch');
  }
  if (!sameValue(selfTestEvidence.effective_properties, manifest.effective_properties)) {
    throw new Error('effective property identity mismatch');
  }
  validateInstalledPolicyObservation(installedPolicyObservation, manifest);
  validateBuildEvidence(
    buildEvidence,
    loaded.sha256,
    verifierSha256,
    expectedRuntimeTree,
    sha256Canonical(manifest.artifacts)
  );

  const rawFieldsSha256 = Object.fromEntries(
    RAW_FIELD_DIGEST_KEYS.map((name) => [name, sha256Canonical(selfTestEvidence[name])])
  );

  return deepFreeze({
    format: ACCEPTANCE_BINDING_FORMAT,
    manifest_sha256: loaded.sha256,
    verifier_sha256: verifierSha256,
    raw_observations_sha256: sha256Canonical(selfTestEvidence),
    raw_fields_sha256: rawFieldsSha256,
    runtime_identity: expectedRuntimeTree,
    installed_policy_sha256: sha256Canonical(installedPolicyObservation.effective_properties),
    installed_manager_state_sha256: sha256Canonical(installedPolicyObservation.manager_state),
    installed_concrete_syscall_policy_sha256: sha256Canonical(
      installedPolicyObservation.concrete_system_call_policies
    ),
    build_evidence_sha256: sha256Canonical(buildEvidence),
    required_self_tests: manifest.required_self_tests.slice()
  });
}

function relativeRequireTargets() {
  return [];
}

function parseCliArgs(argv) {
  const result = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error('invalid argument');
    const name = key.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('missing argument value');
    if (Object.hasOwn(result, name)) throw new Error('duplicate argument');
    result[name] = value;
    index += 1;
  }
  return result;
}

async function cli(argv) {
  const command = argv[0];
  const args = parseCliArgs(argv.slice(1));
  if (command === 'measure-runtime') {
    if (!args.root || Object.keys(args).some((key) => !['root', 'require-root-ownership'].includes(key))) {
      throw new Error('invalid measure-runtime arguments');
    }
    const requireRootOwnership = args['require-root-ownership'] === undefined
      ? true
      : args['require-root-ownership'] === 'true';
    if (args['require-root-ownership'] !== undefined && !['true', 'false'].includes(args['require-root-ownership'])) {
      throw new Error('invalid root ownership option');
    }
    process.stdout.write(`${canonicalJson(await measureRuntimeTree(args.root, { requireRootOwnership }))}\n`);
    return;
  }
  if (command === 'observe-build-boundary') {
    const expected = [
      'manifest',
      'expected-manifest-sha256',
      'expected-verifier-sha256',
      'source-root',
      'unit',
      'build-parent',
      'dependency-cache-root',
      'build-work'
    ];
    if (!expected.every((key) => args[key]) || Object.keys(args).some((key) => !expected.includes(key))) {
      throw new Error('invalid observe-build-boundary arguments');
    }
    const trustedManifest = loadTrustedParserManifest(args.manifest, args['expected-manifest-sha256']);
    const observation = observeBuildBoundary({
      trustedManifest,
      expectedManifestSha256: args['expected-manifest-sha256'],
      expectedVerifierSha256: args['expected-verifier-sha256'],
      sourceRoot: args['source-root'],
      unit: args.unit,
      buildParent: args['build-parent'],
      dependencyCacheRoot: args['dependency-cache-root'],
      buildWork: args['build-work']
    });
    process.stdout.write(`${canonicalJson(observation)}\n`);
    return;
  }
  if (command === 'finalize-build-boundary') {
    const expected = [
      'manifest',
      'expected-manifest-sha256',
      'expected-verifier-sha256',
      'observation',
      'runtime-root',
      'unit',
      'build-parent'
    ];
    if (!expected.every((key) => args[key]) || Object.keys(args).some((key) => !expected.includes(key))) {
      throw new Error('invalid finalize-build-boundary arguments');
    }
    const trustedManifest = loadTrustedParserManifest(args.manifest, args['expected-manifest-sha256']);
    const observation = readStrictEvidenceFile(args.observation, 'build boundary observation');
    const evidence = await finalizeBuildBoundary({
      trustedManifest,
      expectedManifestSha256: args['expected-manifest-sha256'],
      expectedVerifierSha256: args['expected-verifier-sha256'],
      observation,
      runtimeRoot: args['runtime-root'],
      unit: args.unit,
      buildParent: args['build-parent']
    });
    process.stdout.write(`${canonicalJson(evidence)}\n`);
    return;
  }
  if (command === 'bind-acceptance') {
    const expected = [
      'manifest',
      'expected-manifest-sha256',
      'expected-verifier-sha256',
      'raw-observations',
      'runtime-root',
      'build-evidence'
    ];
    if (!expected.every((key) => args[key]) || Object.keys(args).some((key) => !expected.includes(key))) {
      throw new Error('invalid bind-acceptance arguments');
    }
    const trustedManifest = loadTrustedParserManifest(args.manifest, args['expected-manifest-sha256']);
    const raw = readStrictEvidenceFile(args['raw-observations'], 'raw observations');
    const buildEvidence = readStrictEvidenceFile(args['build-evidence'], 'build evidence');
    const runtimeObservation = await measureRuntimeTree(args['runtime-root'], { requireRootOwnership: true });
    const installedPolicyObservation = observeInstalledSystemdPolicy(trustedManifest.manifest);
    const binding = bindAcceptanceEvidence({
      trustedManifest,
      expectedManifestSha256: args['expected-manifest-sha256'],
      expectedVerifierSha256: args['expected-verifier-sha256'],
      selfTestEvidence: raw,
      runtimeObservation,
      installedPolicyObservation,
      buildEvidence
    });
    process.stdout.write(`${canonicalJson(binding)}\n`);
    return;
  }
  throw new Error('unknown command');
}

module.exports = Object.freeze({
  parseStrictJson,
  measureRuntimeTree,
  loadTrustedParserManifest,
  bindAcceptanceEvidence,
  observeInstalledSystemdPolicy,
  observeBuildBoundary,
  finalizeBuildBoundary,
  normalizeSystemdProperty,
  measureConcreteSystemCallPolicy,
  validateConcreteSystemCallPolicyEvidence,
  observeBuildUnit,
  validateBuildMountIsolation,
  relativeRequireTargets
});

if (require.main === module) {
  cli(process.argv.slice(2)).catch(() => {
    process.stderr.write('trusted parser runtime verifier failed\n');
    process.exitCode = 1;
  });
}
