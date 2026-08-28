const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const serverRoot = path.resolve(__dirname, '..');
const parserRoot = path.join(serverRoot, 'parser-runtime');
const scriptsRoot = path.join(serverRoot, 'scripts');
const buildScript = path.join(scriptsRoot, 'build_upload_sandbox_runtime.sh');
const provisionScript = path.join(scriptsRoot, 'provision_upload_sandbox_runtime.sh');
const trustedVerifierPath = path.join(scriptsRoot, 'trusted_parser_runtime_verifier.js');
const runtimeManifestPath = path.join(serverRoot, 'systemd', 'turingmarket-parser.manifest.json');
const linuxTransactionAvailable = process.platform === 'linux'
  || (process.platform === 'win32' && process.env.TM_RUN_WSL_PARSER_TRANSACTION_TESTS === '1');
const linuxTransactionSkip = linuxTransactionAvailable
  ? false
  : 'requires native Linux or an explicitly enabled WSL root transaction environment';

const expectedPythonRequirements = [
  ['certifi', '2026.7.22', '62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775'],
  ['charset-normalizer', '3.5.0', '82cc5835997ec78afe293a192e385099355770a7db94b2fb1239d36b32796f1c'],
  ['colorlog', '6.12.0', '30d392604e9110045a2c2aeefc27d7a017abbab63f3a8aee594eac0801df784e'],
  ['flatbuffers', '25.12.19', '7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4'],
  ['idna', '3.18', '7f952cbe720b688055e3f87de14f5c3e5fdaa8bc3928985c4077ca689de849a2'],
  ['numpy', '2.5.2', '318b9a4c845dbea06708a29c84ee429cc3065048db34cdb799047643492050ee'],
  ['omegaconf', '2.4.0.dev13', 'a9725a3b578e9ab4b95bd7413751133287740ee4eeb7644c233821380889fd3d'],
  ['onnxruntime', '1.28.0', '6afdc83f1317c136e92fc29f5ee9f058de59d87c0b22cee3fdbfbaa0ccc2098a'],
  ['opencv-python', '5.0.0.93', 'c8de2dec111122a02e8beb28e16c31904992dfd6186560b142a92c71403c1039'],
  ['packaging', '26.3', 'd7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c'],
  ['pillow', '12.3.0', '251bf95b67017e27b13d82f5b326234ca62d70f9cf4c2b9032de2358a3b12c7b'],
  ['protobuf', '7.35.1', '74758715c53d7158fb76caf4f0cfdacc5329a4b1bb994f865d6cf302d413a1c4'],
  ['pyclipper', '1.4.0', '773c0e06b683214dcfc6711be230c83b03cddebe8a57eae053d4603dd63582f9'],
  ['PyMuPDF', '1.27.2.3', '857842b4888827bd6155a1131341b2822a7ebe9a8c15a975fd7d490d7a64a30c'],
  ['pypdf', '6.14.2', '3f07891af76dc002657e04993ab9b4de81de29f9013b9761d0b7968bff12e946'],
  ['PyYAML', '6.0.3', 'c458b6d084f9b935061bc36216e8a69a7e293a2f1e68bf956dcd9e6cbcd143f5'],
  ['rapidocr', '3.9.2', '04d6b8d151f823d930bd91910555f57bea897c0c44fa6794267b94cf9c1ef9a0'],
  ['requests', '2.34.2', '2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0'],
  ['shapely', '2.1.2', '21952dc00df38a2c28375659b07a3979d22641aeb104751e769c3ee825aadecf'],
  ['six', '1.17.0', '4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274'],
  ['tqdm', '4.70.0', '7f585706bfddbdebf89daac705b2dfcc16890130727d3197ca62c732b4310953'],
  ['typing_extensions', '4.16.0', '481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8'],
  ['urllib3', '2.7.0', '9fb4c81ebbb1ce9531cce37674bbc6f1360472bc18ca9a553ede278ef7276897']
];

function read(target) {
  return fs.readFileSync(target, 'utf8');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function runBash(args, options = {}) {
  const bash = process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : 'bash';
  function bashPath(value) {
    if (process.platform !== 'win32' || !path.isAbsolute(value)) return value;
    if (value.startsWith('/')) return value;
    return `/${value[0].toLowerCase()}${value.slice(2).replace(/\\/g, '/')}`;
  }
  return spawnSync(bash, args.map(bashPath), {
    cwd: options.cwd || serverRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8'
    }
  });
}

function runLinuxBash(source) {
  const command = process.platform === 'win32' ? 'wsl.exe' : 'unshare';
  const args = process.platform === 'win32'
    ? ['-u', 'root', '--', 'bash', '-s']
    : ['--user', '--map-root-user', '--fork', 'bash', '--noprofile', '--norc', '-s'];
  return spawnSync(command, args, {
    cwd: serverRoot,
    encoding: 'utf8',
    input: source,
    env: {
      ...process.env,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      WSL_UTF8: '1'
    }
  });
}

function linuxTransactionTest(name, fn) {
  return test(name, { skip: linuxTransactionSkip }, fn);
}

test('Linux runtime transaction fixtures use namespace root without host privileges', () => {
  const helper = runLinuxBash.toString();
  assert.match(helper, /process\.platform === 'win32' \? 'wsl\.exe' : 'unshare'/);
  assert.match(helper, /'--user', '--map-root-user', '--fork'/);
  assert.doesNotMatch(helper, /process\.platform === 'win32' \? 'wsl\.exe' : 'bash'/);
});

function runtimeTransactionFunctions() {
  const source = read(provisionScript).replace(/\r\n/g, '\n');
  const match = source.match(
    /# BEGIN PARSER RUNTIME TRANSACTION\n([\s\S]*?)# END PARSER RUNTIME TRANSACTION\n/
  );
  assert.ok(match, 'provisioner must expose its parser runtime transaction functions');
  return match[1];
}

function runRuntimeTransactionScenario(body) {
  const functions = runtimeTransactionFunctions();
  return runLinuxBash([
    'set -Eeuo pipefail',
    'scratch="$(mktemp -d /tmp/tm-parser-transaction-test.XXXXXX)"',
    'trap \'rm -rf --one-file-system -- "$scratch"\' EXIT',
    'STATE_ROOT="$scratch/state"',
    'RUNTIME_ROOT="$STATE_ROOT/runtime-root"',
    'STAGED_RUNTIME="$scratch/staged-runtime"',
    'SNAPSHOT_ROOT="$scratch/snapshot"',
    `EXPECTED_SHA256="${'a'.repeat(64)}"`,
    'RUNTIME_TRANSACTION_ROOT=""',
    'RUNTIME_TRANSACTION_RECOVERY=""',
    'install -d -o root -g root -m 0700 "$STATE_ROOT" "$STAGED_RUNTIME" "$SNAPSHOT_ROOT"',
    'printf \'%s\\n\' candidate > "$STAGED_RUNTIME/runtime-id"',
    'chmod 0400 "$STAGED_RUNTIME/runtime-id"',
    'printf \'%s\\n\' snapshot-fixture > "$SNAPSHOT_ROOT/SHA256SUMS"',
    'chmod 0600 "$SNAPSHOT_ROOT/SHA256SUMS"',
    'validate_runtime_against_manifest() {',
    '  test -n "$EXPECTED_SHA256" || return 91',
    '  test "$(cat "$1/runtime-id")" = candidate',
    '}',
    functions,
    body
  ].join('\n'));
}

function runPython(args, options = {}) {
  const configuredPython = options.env?.PYTHON3
    || process.env.PYTHON3
    || options.env?.PYTHON_BIN
    || process.env.PYTHON_BIN;
  const command = configuredPython || (process.platform === 'win32' ? 'py' : 'python3');
  const versionArgs = process.platform === 'win32' && !configuredPython ? ['-3.14'] : [];
  return spawnSync(command, [...versionArgs, '-B', ...args], {
    cwd: options.cwd || serverRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
      PYTHONDONTWRITEBYTECODE: '1'
    }
  });
}

function writeTextBmp(target, text) {
  const glyphs = {
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110']
  };
  const scale = 10;
  const padding = 24;
  const glyphWidth = 6 * scale;
  const width = padding * 2 + (text.length * glyphWidth) - scale;
  const height = padding * 2 + (7 * scale);
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const bitmap = Buffer.alloc(54 + pixelBytes, 0xff);

  bitmap.write('BM', 0, 2, 'ascii');
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(pixelBytes, 34);
  bitmap.writeInt32LE(2835, 38);
  bitmap.writeInt32LE(2835, 42);

  for (let glyphIndex = 0; glyphIndex < text.length; glyphIndex += 1) {
    const glyph = glyphs[text[glyphIndex]];
    assert.ok(glyph, `missing fixture glyph: ${text[glyphIndex]}`);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = padding + (glyphIndex * glyphWidth) + (column * scale) + dx;
            const y = padding + (row * scale) + dy;
            const offset = 54 + ((height - 1 - y) * rowStride) + (x * 3);
            bitmap[offset] = 0;
            bitmap[offset + 1] = 0;
            bitmap[offset + 2] = 0;
          }
        }
      }
    }
  }
  fs.writeFileSync(target, bitmap);
}

function runOcrImageContract(mode) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-rapidocr-contract-'));
  const imagePath = path.join(scratch, 'ocr-self-test.bmp');
  const stubRoot = path.join(scratch, 'python');
  fs.mkdirSync(stubRoot);
  writeTextBmp(imagePath, 'OCR 123');
  fs.writeFileSync(path.join(stubRoot, 'rapidocr.py'), `
import os

class RapidOCROutput:
    txts = ["OCR 123", "LOW CONFIDENCE"]
    scores = [0.99, 0.10]

class RapidOCR:
    def __call__(self, image_path):
        with open(image_path, "rb") as image:
            if image.read(2) != b"BM":
                raise RuntimeError("self-test did not receive a BMP image")
        if os.environ.get("TM_TEST_RAPIDOCR_MODE") == "legacy":
            return ([[None, "OCR 123", 0.99], [None, "LOW CONFIDENCE", 0.10]], 0.01)
        return RapidOCROutput()
`, 'utf8');

  const existingPythonPath = process.env.PYTHONPATH;
  const pythonPath = existingPythonPath
    ? `${stubRoot}${path.delimiter}${existingPythonPath}`
    : stubRoot;
  const execution = runPython([
    path.join(serverRoot, 'ocr_document_text.py'),
    '--self-test-image',
    imagePath,
    'OCR 123'
  ], {
    env: {
      PYTHONPATH: pythonPath,
      TM_TEST_RAPIDOCR_MODE: mode
    }
  });
  fs.rmSync(scratch, { recursive: true, force: true });
  return execution;
}

test('parser runtime dependency closure is exact and independently locked', () => {
  const packageJson = JSON.parse(read(path.join(parserRoot, 'package.json')));
  const packageLock = JSON.parse(read(path.join(parserRoot, 'package-lock.json')));
  const requirements = read(path.join(parserRoot, 'requirements.lock'));

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'commonjs');
  assert.deepEqual(packageJson.dependencies, {
    'read-excel-file': '9.2.0'
  });
  assert.equal(packageLock.lockfileVersion, 3);
  assert.deepEqual(packageLock.packages[''].dependencies, packageJson.dependencies);
  assert.match(
    requirements,
    /^pypdf==6\.14\.2 \\\r?\n\s+--hash=sha256:3f07891af76dc002657e04993ab9b4de81de29f9013b9761d0b7968bff12e946$/m
  );
  assert.match(
    requirements,
    /^PyMuPDF==1\.27\.2\.3 \\\r?\n\s+--hash=sha256:857842b4888827bd6155a1131341b2822a7ebe9a8c15a975fd7d490d7a64a30c$/m
  );
  assert.doesNotMatch(requirements, />=|~=|\*|--extra-index-url/);
});

function trustedParserVerifierBindingFixture(verifier) {
  const manifestBytes = fs.readFileSync(runtimeManifestPath);
  const manifestSha256 = require('node:crypto').createHash('sha256').update(manifestBytes).digest('hex');
  const manifest = JSON.parse(manifestBytes);
  const verifierSha256 = require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(trustedVerifierPath)).digest('hex');
  const allTrue = Object.fromEntries(manifest.required_self_tests.map((name) => [name, true]));
  const raw = {
    format: 'tm-parser-self-test-observations-v1',
    manifest_sha256: manifestSha256,
    runtime_tree: { ...manifest.runtime_tree, root: undefined },
    effective_properties: manifest.effective_properties,
    parser_acceptance: [
      { format: 'xlsx', parser: 'xlsx-openxml', marker: 'TM_XLSX_MARKER_604', marker_found: true, ocr_used: false },
      { format: 'pptx', parser: 'pptx-openxml', marker: 'TM_PPTX_MARKER_604', marker_found: true, ocr_used: false },
      { format: 'bmp', parser: 'local-rapidocr', marker: 'OCR 123', marker_found: true, ocr_used: true }
    ],
    self_tests: allTrue
  };
  delete raw.runtime_tree.root;
  const buildUnitProperties = buildUnitObservationFixture(verifier);
  const buildEvidence = {
    format: 'tm-parser-runtime-build-evidence-v2',
    manifest_sha256: manifestSha256,
    verifier_sha256: verifierSha256,
    runtime_tree: raw.runtime_tree,
    build_boundary: {
      format: 'tm-parser-build-boundary-v1',
      source_artifacts_sha256: require('node:crypto').createHash('sha256')
        .update(canonicalJson(manifest.artifacts)).digest('hex'),
      build_unit: 'turingmarket-parser-build.service',
      build_unit_properties: buildUnitProperties,
      build_unit_properties_sha256: require('node:crypto').createHash('sha256')
        .update(canonicalJson(buildUnitProperties)).digest('hex'),
      build_unit_stopped: true,
      build_unit_collected: true,
      network_isolation: true,
      mount_isolation: true,
      credential_isolation: true,
      build_parent_inaccessible: true
    }
  };
  return {
    manifest,
    manifestSha256,
    verifierSha256,
    allTrue,
    raw,
    buildEvidence,
    trustedManifest: verifier.loadTrustedParserManifest(runtimeManifestPath, manifestSha256)
  };
}

function installedPolicyObservationFixture(manifest, verifier) {
  const expected = manifest.effective_properties['turingmarket-parser@.service'].SystemCallFilter;
  return {
    format: 'tm-parser-installed-policy-observation-v1',
    effective_properties: manifest.effective_properties,
    manager_state: {
      'turingmarket-parser@.service': {
        Id: 'turingmarket-parser@test_instance.service',
        LoadState: 'loaded',
        FragmentPath: '/etc/systemd/system/turingmarket-parser@.service',
        SourcePath: '',
        DropInPaths: '',
        NeedDaemonReload: 'no',
        Transient: 'no'
      },
      'turingmarket-parser.slice': {
        Id: 'turingmarket-parser.slice',
        LoadState: 'loaded',
        FragmentPath: '/etc/systemd/system/turingmarket-parser.slice',
        SourcePath: '',
        DropInPaths: '',
        NeedDaemonReload: 'no',
        Transient: 'no'
      }
    },
    concrete_system_call_policies: {
      'turingmarket-parser@.service': verifier.measureConcreteSystemCallPolicy(
        SYSTEM_CALL_BASELINE.join(' '),
        expected,
        'turingmarket-parser@.service',
        parserVerifierTestOptions()
      )
    }
  };
}

const SYSTEM_CALL_BASELINE = Object.freeze([
  'read', 'write', 'close', 'execve', 'exit', 'exit_group', 'shutdown', 'socketpair'
]);
const TEST_SYSTEM_CALL_POLICY_PINS = Object.freeze({
  parser: require('node:crypto').createHash('sha256')
    .update(canonicalJson([...SYSTEM_CALL_BASELINE].sort())).digest('hex'),
  build: require('node:crypto').createHash('sha256')
    .update(canonicalJson([...SYSTEM_CALL_BASELINE, 'chmod'].sort())).digest('hex')
});

function parserVerifierTestOptions(overrides = {}) {
  return {
    expandSyscallGroup: parserSyscallGroupFixture,
    pinnedSystemCallMaximumSha256ForTest: TEST_SYSTEM_CALL_POLICY_PINS,
    readBuildUnitArtifact: () => Buffer.from([
      '# /run/systemd/transient/turingmarket-parser-build.service',
      '[Unit]',
      'Description=parser build fixture',
      '[Service]',
      'Type=exec',
      ''
    ].join('\n')),
    ...overrides
  };
}

function parserSyscallGroupFixture(group) {
  const groups = {
    '@system-service': [
      ...SYSTEM_CALL_BASELINE,
      'accept', 'chmod', 'io_uring_setup', 'mount', 'ptrace', 'reboot'
    ],
    '@mount': ['mount'],
    '@aio': ['io_uring_setup'],
    '@chown': ['chown'],
    '@privileged': ['@clock', '@module', '@raw-io', '@reboot', '@swap', 'capset'],
    '@clock': ['clock_settime'],
    '@module': ['init_module'],
    '@raw-io': ['iopl'],
    '@reboot': ['reboot'],
    '@swap': ['swapon'],
    '@resources': ['setrlimit'],
    '@obsolete': ['_sysctl'],
    '@debug': ['ptrace']
  };
  if (!Object.hasOwn(groups, group)) throw new Error(`unexpected syscall group ${group}`);
  return groups[group];
}

function buildUnitObservationFixture(verifier, overrides = {}) {
  const roots = {
    sourceRoot: '/var/lib/turingmarket-parser-build/input',
    dependencyCacheRoot: '/var/cache/turingmarket-parser-dependencies',
    buildWork: '/var/lib/turingmarket-parser-build/work'
  };
  const raw = {
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    MainPID: '4242',
    NeedDaemonReload: 'no',
    Type: 'exec',
    Transient: 'yes',
    CollectMode: 'inactive-or-failed',
    FragmentPath: '/run/systemd/transient/turingmarket-parser-build.service',
    DropInPaths: '',
    User: 'turingmarket-gate',
    Group: 'turingmarket-gate',
    SupplementaryGroups: '',
    UMask: '0077',
    WorkingDirectory: '/build-work',
    PrivateNetwork: 'yes',
    IPAddressDeny: '0.0.0.0/0 ::/0',
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
    SystemCallFilter: SYSTEM_CALL_BASELINE.join(' '),
    SystemCallErrorNumber: '1',
    KeyringMode: 'private',
    Environment: '',
    EnvironmentFiles: '',
    LoadCredential: '[unprintable]',
    LoadCredentialEncrypted: '[unprintable]',
    SetCredential: '[unprintable]',
    SetCredentialEncrypted: '[unprintable]',
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
    StandardError: 'journal',
    TemporaryFileSystem: [
      '/root:ro', '/home:ro', '/etc:ro', '/opt:ro',
      '/srv:ro', '/tmp:ro', '/var:ro', '/run:ro',
      '/data:ro', '/mnt:ro', '/media:ro'
    ].join(' '),
    InaccessiblePaths: [
      '-/etc/turingmarket', '-/etc/credstore', '-/etc/credstore.encrypted',
      '-/run/credentials', '-/run/secrets', '-/root/turingmarket',
      '-/var/lib/turingmarket-gate', '-/var/lib/turingmarket-parser',
      '-/opt/turingmarket', '-/srv/turingmarket'
    ].join(' '),
    BindReadOnlyPaths: [
      `${roots.sourceRoot}:/build-input:rbind`,
      `${roots.dependencyCacheRoot}:/dependency-cache:rbind`
    ].join(' '),
    BindPaths: `${roots.buildWork}:/build-work:rbind`,
    ReadWritePaths: '/build-work'
  };
  const spawnSync = (_command, args) => {
    const keys = args.find((value) => value.startsWith('--property='))
      .slice('--property='.length).split(',')
      .filter((key) => key !== 'EnvironmentFiles');
    return {
      status: 0,
      stdout: `${keys.map((key) => `${key}=${raw[key]}`).join('\n')}\n`,
      stderr: ''
    };
  };
  return verifier.observeBuildUnit(
    'turingmarket-parser-build.service',
    roots.sourceRoot,
    roots.dependencyCacheRoot,
    roots.buildWork,
    parserVerifierTestOptions({ spawnSync, ...overrides })
  );
}

test('trusted verifier derives redacted environment and credential facts from the transient fragment', () => {
  const verifier = require(trustedVerifierPath);
  const observed = buildUnitObservationFixture(verifier);
  assert.equal(observed.EnvironmentFiles, '');
  assert.equal(observed.LoadCredential, '');
  assert.equal(observed.LoadCredentialEncrypted, '');
  assert.equal(observed.SetCredential, '');
  assert.equal(observed.SetCredentialEncrypted, '');
  assert.throws(() => buildUnitObservationFixture(verifier, {
    readBuildUnitArtifact: () => Buffer.from([
      '[Unit]',
      'Description=parser build fixture',
      '[Service]',
      'EnvironmentFile=/run/untrusted-parser.env',
      'Type=exec',
      ''
    ].join('\n'))
  }), /environment file/i);
  assert.throws(() => buildUnitObservationFixture(verifier, {
    readBuildUnitArtifact: () => Buffer.from([
      '[Unit]',
      'Description=parser build fixture',
      '[Service]',
      'EnvironmentFile\\',
      '=/run/untrusted-parser.env',
      'Type=exec',
      ''
    ].join('\n'))
  }), /continuation|environment file/i);
  assert.throws(() => buildUnitObservationFixture(verifier, {
    readBuildUnitArtifact: () => Buffer.from([
      '[Unit]',
      'Description=parser build fixture',
      '[Service]',
      'LoadCredential=api-token:/run/untrusted-token',
      'Type=exec',
      ''
    ].join('\n'))
  }), /credential/i);
});

test('trusted parser verifier rejects forged booleans and binds canonical raw observations', async () => {
  assert.equal(fs.existsSync(trustedVerifierPath), true, 'independent parser verifier must exist');
  const verifier = require(trustedVerifierPath);
  const {
    manifest,
    manifestSha256,
    verifierSha256,
    allTrue,
    raw,
    buildEvidence,
    trustedManifest
  } = trustedParserVerifierBindingFixture(verifier);
  const installedPolicyObservation = installedPolicyObservationFixture(manifest, verifier);

  assert.throws(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: allTrue,
    runtimeObservation: manifest.runtime_tree,
    installedPolicyObservation,
    buildEvidence
  }), /raw observations/i);

  const bound = verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation,
    buildEvidence
  });
  assert.equal(bound.format, 'tm-parser-acceptance-binding-v1');
  assert.equal(bound.manifest_sha256, manifestSha256);
  assert.equal(bound.verifier_sha256, verifierSha256);
  assert.equal(bound.build_evidence_sha256.length, 64);
  assert.equal(bound.installed_policy_sha256.length, 64);
  assert.equal(bound.installed_manager_state_sha256.length, 64);
  assert.equal(bound.installed_concrete_syscall_policy_sha256.length, 64);
  assert.deepEqual(Object.keys(bound.raw_fields_sha256), [
    'format', 'manifest_sha256', 'runtime_tree', 'effective_properties', 'parser_acceptance', 'self_tests'
  ]);

  const canonicalBuildEvidence = verifier.parseStrictJson(
    canonicalJson(buildEvidence),
    'canonical build evidence'
  );
  assert.doesNotThrow(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation,
    buildEvidence: canonicalBuildEvidence
  }));

  assert.throws(() => verifier.parseStrictJson('{"format":"x","format":"y"}', 'fixture'), /duplicate/i);
  assert.throws(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: '0'.repeat(64),
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation,
    buildEvidence
  }), /verifier SHA-256/i);

  const forgedBuildEvidence = JSON.parse(JSON.stringify(buildEvidence));
  forgedBuildEvidence.build_boundary.source_artifacts_sha256 = '0'.repeat(64);
  assert.throws(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation,
    buildEvidence: forgedBuildEvidence
  }), /source artifact identity/i);

  const forgedBuildProperties = JSON.parse(JSON.stringify(buildEvidence));
  forgedBuildProperties.build_boundary.build_unit_properties.PrivateNetwork = 'no';
  assert.throws(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation,
    buildEvidence: forgedBuildProperties
  }), /build unit properties SHA-256 mismatch/i);

  forgedBuildProperties.build_boundary.build_unit_properties_sha256 = require('node:crypto')
    .createHash('sha256')
    .update(canonicalJson(forgedBuildProperties.build_boundary.build_unit_properties))
    .digest('hex');
  assert.throws(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation,
    buildEvidence: forgedBuildProperties
  }), /build unit properties mismatch/i);

  const incompleteBuildProperties = JSON.parse(JSON.stringify(buildEvidence));
  delete incompleteBuildProperties.build_boundary.build_unit_properties.User;
  incompleteBuildProperties.build_boundary.build_unit_properties_sha256 = require('node:crypto')
    .createHash('sha256')
    .update(canonicalJson(incompleteBuildProperties.build_boundary.build_unit_properties))
    .digest('hex');
  assert.throws(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation,
    buildEvidence: incompleteBuildProperties
  }), /build unit properties mismatch/i);

  const forgedBuildSyscallPolicy = JSON.parse(JSON.stringify(buildEvidence));
  const buildPolicy = forgedBuildSyscallPolicy.build_boundary
    .build_unit_properties.SystemCallPolicyEvidence;
  buildPolicy.maximum.push('future_system_call');
  buildPolicy.maximum.sort();
  buildPolicy.maximum_sha256 = require('node:crypto').createHash('sha256')
    .update(canonicalJson(buildPolicy.maximum)).digest('hex');
  forgedBuildSyscallPolicy.build_boundary.build_unit_properties_sha256 = require('node:crypto')
    .createHash('sha256')
    .update(canonicalJson(forgedBuildSyscallPolicy.build_boundary.build_unit_properties))
    .digest('hex');
  assert.throws(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation,
    buildEvidence: forgedBuildSyscallPolicy
  }), /build unit properties mismatch/i);

  const forgedInstalledSyscallPolicy = JSON.parse(JSON.stringify(installedPolicyObservation));
  const installedPolicy = forgedInstalledSyscallPolicy.concrete_system_call_policies
    ['turingmarket-parser@.service'];
  installedPolicy.maximum.push('future_system_call');
  installedPolicy.maximum.sort();
  installedPolicy.maximum_sha256 = require('node:crypto').createHash('sha256')
    .update(canonicalJson(installedPolicy.maximum)).digest('hex');
  assert.throws(() => verifier.bindAcceptanceEvidence({
    trustedManifest,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation: forgedInstalledSyscallPolicy,
    buildEvidence
  }), /concrete system call policy evidence mismatch/i);
});

test('trusted parser verifier rejects forged in-memory manifests and binds loaded bytes', () => {
  const verifier = require(trustedVerifierPath);
  const {
    manifest,
    manifestSha256,
    verifierSha256,
    raw
  } = trustedParserVerifierBindingFixture(verifier);
  const forgedManifest = JSON.parse(JSON.stringify(manifest));
  forgedManifest.identity.user = 'forged-parser';

  assert.throws(() => verifier.bindAcceptanceEvidence({
    manifest: forgedManifest,
    manifestSha256,
    expectedManifestSha256: manifestSha256,
    expectedVerifierSha256: verifierSha256,
    selfTestEvidence: raw,
    runtimeObservation: raw.runtime_tree,
    installedPolicyObservation: installedPolicyObservationFixture(manifest, verifier)
  }), /trusted manifest load result/i);
  assert.throws(
    () => verifier.loadTrustedParserManifest(runtimeManifestPath, '0'.repeat(64)),
    /manifest SHA-256 mismatch/i
  );
});

test('trusted parser verifier matches the existing framed runtime tree digest', async (t) => {
  const verifier = require(trustedVerifierPath);
  const { inspectParserRuntimeTree } = require('../services/upload_sandbox_service');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-parser-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'z-last.txt'), 'last');
  fs.writeFileSync(path.join(root, '\u00e9-first.txt'), 'utf8-name');
  fs.writeFileSync(path.join(root, 'nested', 'payload.bin'), Buffer.from([0, 1, 2, 255]));

  const trusted = await verifier.measureRuntimeTree(root, { requireRootOwnership: false });
  const existing = await inspectParserRuntimeTree(root, { requireRootOwnership: false });
  assert.deepEqual(trusted, existing);
});

test('trusted parser verifier rejects duplicate CLI flags', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-parser-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const execution = spawnSync(process.execPath, [
    trustedVerifierPath,
    'measure-runtime',
    '--root', root,
    '--root', root,
    '--require-root-ownership', 'false'
  ], {
    cwd: serverRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC: '0'
    }
  });

  assert.equal(execution.status, 1, execution.stderr || execution.stdout);
  assert.equal(execution.stderr, 'trusted parser runtime verifier failed\n');
});

test('trusted parser verifier exposes only a bounded failure code during provisioning diagnostics', () => {
  const execution = spawnSync(process.execPath, [
    trustedVerifierPath,
    'unknown-command',
    '--private-path',
    '/tmp/should-not-leak'
  ], {
    cwd: serverRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC: '1'
    }
  });

  assert.equal(execution.status, 1, execution.stderr || execution.stdout);
  assert.equal(execution.stderr, 'trusted parser runtime verifier failed: cli-command\n');
  assert.doesNotMatch(execution.stderr, /private-path|should-not-leak|tmp/i);
});

test('trusted parser verifier maps every diagnostic branch and binding stage to a fixed allowlisted code', async () => {
  const verifier = require(trustedVerifierPath);
  const cases = [
    ['unknown command', 'cli-command'],
    ['invalid bind-acceptance arguments', 'cli-arguments'],
    ['trusted parser verifier SHA-256 mismatch', 'verifier-identity'],
    ['manifest SHA-256 mismatch', 'manifest-identity'],
    ['raw observations are required', 'self-test-envelope'],
    ['runtime tree observation mismatch', 'runtime-observation'],
    ['runtime tree identity mismatch', 'runtime-identity'],
    ['effective property identity mismatch', 'self-test-policy'],
    ['installed systemd manager state changed', 'installed-manager-race'],
    ['installed systemd unit identity mismatch', 'installed-unit-identity'],
    ['concrete system call policy evidence mismatch', 'installed-syscall-policy'],
    ['installed systemd policy mismatch', 'installed-policy'],
    ['build source artifact identity mismatch', 'build-source-identity'],
    ['build unit properties mismatch', 'build-policy'],
    ['build boundary unit mismatch', 'build-evidence'],
    ['evidence file JSON mismatch', 'evidence-format'],
    ['/tmp/private-path?token=should-not-leak', 'internal']
  ];

  for (const [message, expected] of cases) {
    assert.equal(verifier.diagnosticFailureCode(new Error(message)), expected);
  }
  assert.equal(verifier.diagnosticFailureCode('/tmp/private-path'), 'internal');

  const stageCodes = [
    'manifest-load',
    'raw-evidence-read',
    'build-evidence-read',
    'runtime-measure',
    'installed-policy-observe',
    'acceptance-bind'
  ];
  for (const code of stageCodes) {
    await assert.rejects(
      verifier.runDiagnosticStage(code, () => {
        throw new Error('/tmp/private-path?token=should-not-leak');
      }),
      (error) => verifier.diagnosticFailureCode(error) === code
    );
  }
  await assert.rejects(
    verifier.runDiagnosticStage('runtime-measure', () => {
      throw new Error('manifest SHA-256 mismatch');
    }),
    (error) => verifier.diagnosticFailureCode(error) === 'manifest-identity'
  );

  const source = read(trustedVerifierPath);
  for (const code of stageCodes) {
    assert.match(source, new RegExp(`runDiagnosticStage\\('${code}'`));
  }

  const installedPolicyStageCodes = [
    'service-properties-read',
    'service-syscall-policy',
    'service-policy-normalize',
    'service-unit-artifact',
    'service-manager-recheck',
    'slice-properties-read',
    'slice-policy-normalize',
    'slice-unit-artifact',
    'slice-manager-recheck'
  ];
  for (const code of installedPolicyStageCodes) {
    assert.throws(
      () => verifier.runDiagnosticStageSync(code, () => {
        throw new Error('/tmp/private-path?token=should-not-leak');
      }),
      (error) => verifier.diagnosticFailureCode(error) === code
    );
    assert.match(source, new RegExp(`['\"]${code}['\"]`));
  }
});

test('trusted parser verifier validates escaped and raw surrogate pairs', () => {
  const verifier = require(trustedVerifierPath);
  const expected = String.fromCodePoint(0x1f600);
  assert.equal(verifier.parseStrictJson('{"value":"\\ud83d\\ude00"}', 'fixture').value, expected);
  assert.equal(verifier.parseStrictJson(`{"value":"${expected}"}`, 'fixture').value, expected);

  for (const malformed of [
    '{"value":"\\ud83d"}',
    '{"value":"\\ude00"}',
    `{"value":"${String.fromCharCode(0xd83d)}"}`,
    `{"value":"${String.fromCharCode(0xde00)}"}`
  ]) {
    assert.throws(() => verifier.parseStrictJson(malformed, 'fixture'), /surrogate/i);
  }
});

test('trusted parser verifier rejects a directory changed during enumeration', async (t) => {
  const verifier = require(trustedVerifierPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-parser-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'payload.txt'), 'stable');
  let rootHookCalls = 0;

  await assert.rejects(verifier.measureRuntimeTree(root, {
    requireRootOwnership: false,
    testHooks: {
      afterDirectoryRead({ absolutePath, relativePath }) {
        if (relativePath !== '') return;
        rootHookCalls += 1;
        const changed = new Date('2000-01-01T00:00:00.000Z');
        fs.utimesSync(absolutePath, changed, changed);
      }
    }
  }), /directory changed|unsafe runtime tree/i);
  assert.equal(rootHookCalls, 1);
});

test('trusted parser verifier rejects hardlinked runtime files', async (t) => {
  const verifier = require(trustedVerifierPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-parser-hardlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'payload.txt');
  fs.writeFileSync(original, 'linked');
  try {
    fs.linkSync(original, path.join(root, 'payload-copy.txt'));
  } catch (error) {
    t.skip(`hardlink creation unavailable: ${error.message}`);
    return;
  }

  await assert.rejects(
    verifier.measureRuntimeTree(root, { requireRootOwnership: false }),
    /hard-linked|hardlink|unsafe runtime tree/i
  );
});

test('trusted parser verifier rejects writable artifacts in strict ownership mode', async (t) => {
  const verifier = require(trustedVerifierPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-parser-writable-'));
  const payload = path.join(root, 'payload.txt');
  t.after(() => {
    try { fs.chmodSync(root, 0o700); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(payload, 'writable');
  const owner = fs.lstatSync(root);
  if ((owner.uid !== 0 || owner.gid !== 0) && process.platform !== 'win32') {
    t.skip('strict ownership fixture requires a root-owned temporary directory');
    return;
  }
  fs.chmodSync(root, 0o555);
  fs.chmodSync(payload, 0o666);

  await assert.rejects(
    verifier.measureRuntimeTree(root, { requireRootOwnership: true }),
    /writable installed artifact/i
  );
});

test('trusted parser verifier measures regular trees without importing parser implementation code', async (t) => {
  assert.equal(fs.existsSync(trustedVerifierPath), true, 'independent parser verifier must exist');
  const verifier = require(trustedVerifierPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-parser-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'payload.txt'), 'parser bytes');
  const observed = await verifier.measureRuntimeTree(root, { requireRootOwnership: false });
  assert.deepEqual({ files: observed.files, directories: observed.directories, bytes: observed.bytes }, {
    files: 1,
    directories: 2,
    bytes: 12
  });
  assert.match(observed.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(verifier.relativeRequireTargets(), []);

  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(path.join(root, 'nested'), link, 'junction');
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.message}`);
    return;
  }
  await assert.rejects(
    verifier.measureRuntimeTree(root, { requireRootOwnership: false }),
    /symbolic link|unsafe runtime tree/i
  );
});

test('Python 3.14 OCR dependency closure is complete, exact, and hash-pinned', () => {
  const requirements = read(path.join(parserRoot, 'requirements.lock')).replace(/\r\n/g, '\n');
  const expected = `${expectedPythonRequirements
    .map(([name, version, hash]) => `${name}==${version} \\\n    --hash=sha256:${hash}`)
    .join('\n')}\n`;

  assert.equal(requirements, expected);
  assert.match(requirements, /^rapidocr==3\.9\.2 \\$/m);
  assert.match(requirements, /^onnxruntime==1\.28\.0 \\$/m);
  assert.doesNotMatch(requirements, /rapidocr_onnxruntime/);
});

test('OCR image self-test accepts the RapidOCR 3 output object with a real raster image', () => {
  const execution = runOcrImageContract('object');

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const payload = JSON.parse(execution.stdout);
  assert.equal(payload.text, 'OCR 123');
  assert.deepEqual(payload.warnings, []);
  assert.deepEqual(payload.meta, {
    image: true,
    self_test: true,
    expected_text: 'OCR 123'
  });
});

test('OCR image self-test retains the legacy tuple result compatibility path', () => {
  const execution = runOcrImageContract('legacy');

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const payload = JSON.parse(execution.stdout);
  assert.equal(payload.text, 'OCR 123');
  assert.equal(payload.meta.self_test, true);
});

test('parser runtime manifest pins the exact production-built tree', () => {
  const manifest = JSON.parse(read(runtimeManifestPath));
  const sitecustomizePath = path.join(serverRoot, 'parser-runtime', 'sitecustomize.py');
  const pipCaPath = path.join(serverRoot, 'parser-runtime', 'pip-cacert.crt');
  assert.equal(fs.existsSync(sitecustomizePath), true, 'sitecustomize must be a repository-pinned build input');
  assert.equal(
    manifest.artifacts['parser-runtime/sitecustomize.py'],
    require('node:crypto').createHash('sha256').update(fs.readFileSync(sitecustomizePath)).digest('hex'),
    'the parser manifest must pin the repository-owned sitecustomize bytes'
  );
  assert.equal(fs.existsSync(pipCaPath), true, 'the offline pip CA bundle must be a repository-pinned build input');
  assert.equal(
    manifest.artifacts['parser-runtime/pip-cacert.crt'],
    require('node:crypto').createHash('sha256').update(fs.readFileSync(pipCaPath)).digest('hex'),
    'the parser manifest must pin the offline pip CA bundle bytes'
  );
  assert.deepEqual(manifest.runtime_tree, {
    format: 'tm-parser-runtime-tree-v1',
    root: '/var/lib/turingmarket-parser/runtime-root',
    sha256: 'f88e8b7d73f4759a539cb74cc81518172c4588ca5668bc6d7dbbea46d762cf6c',
    files: 3476,
    directories: 435,
    bytes: 640592018
  });
});

function runtimeBuilderSourceSections() {
  const source = read(buildScript);
  const workerMatch = source.match(
    /# BEGIN UNPRIVILEGED BUILD WORKER\r?\n([\s\S]*?)# END UNPRIVILEGED BUILD WORKER\r?\n/
  );
  assert.ok(workerMatch, 'builder must expose a separately testable unprivileged worker section');
  return {
    source,
    controller: source.replace(workerMatch[0], ''),
    worker: workerMatch[1]
  };
}

test('runtime builder preserves the pinned reproducible no-symlink runtime contract', () => {
  const { source, controller, worker } = runtimeBuilderSourceSections();
  const manifest = JSON.parse(read(runtimeManifestPath));
  const copiedInputs = source.match(/for required in \\\r?\n([\s\S]*?); do\r?\n  copy_build_input/);
  assert.ok(copiedInputs, 'builder must expose its trusted build-input closure');
  for (const artifact of Object.keys(manifest.artifacts)) {
    assert.match(
      copiedInputs[1],
      new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `builder must observe the pinned source artifact ${artifact}`
    );
  }

  assert.match(source, /^#!\/usr\/bin\/env bash\r?\nset -Eeuo pipefail\r?\n/);
  assert.match(source, /Linux/);
  assert.match(source, /x86_64/);
  assert.match(source, /v20\.20\.2/);
  assert.match(source, /3\.14\.4/);
  assert.match(source, /--require-hashes/);
  assert.match(source, /--only-binary=:all:/);
  assert.match(source, /--no-compile/);
  assert.match(source, /--no-index/);
  assert.match(source, /npm ci --offline --omit=dev --ignore-scripts/);
  assert.match(
    source,
    /SYSTEMD_ROOT_DIRECTORY_MOUNTPOINTS=\(dev etc input output proc root run runtime scratch sys var\)/
  );
  assert.match(
    worker,
    /for mountpoint in "\$\{SYSTEMD_ROOT_DIRECTORY_MOUNTPOINTS\[@\]\}"; do\r?\n\s+install -d -m 0755/
  );
  assert.match(worker, /install -m 0644 \/dev\/null "\$OUTPUT_ROOT\/input\/input\.bin"/);
  assert.match(worker, /install -m 0644 \/dev\/null "\$OUTPUT_ROOT\/runtime\/request\.json"/);
  assert.match(worker, /chmod 0755 "\$OUTPUT_ROOT"\/\{input,output,runtime,scratch\}/);
  assert.match(worker, /chmod 0644 "\$OUTPUT_ROOT\/input\/input\.bin" "\$OUTPUT_ROOT\/runtime\/request\.json"/);
  assert.match(
    controller,
    /find "\$ROOT_STAGE" -xdev -type f ! -perm \/0111 -exec chmod 0444 \{\} \+\r?\nchown -R 0:0 "\$ROOT_STAGE"\r?\nchmod 0755 "\$ROOT_STAGE"\/\{input,output,runtime,scratch\}\r?\nchmod 0644 "\$ROOT_STAGE\/input\/input\.bin" "\$ROOT_STAGE\/runtime\/request\.json"/,
    'root sealing must preserve the pinned systemd mountpoint modes before identity measurement'
  );
  assert.match(source, /--dependency-cache-root/);
  assert.match(source, /--trusted-verifier/);
  assert.match(source, /--expected-verifier-sha256/);
  assert.match(source, /--expected-sha256/);
  assert.match(source, /--json/);
  assert.match(source, /ldd/);
  assert.doesNotMatch(worker, /\bawk\b/, 'the isolated worker must not depend on the host /etc alternatives chain');
  assert.match(worker, /--exclude='sitecustomize\.py'/);
  assert.match(worker, /PIP_BUNDLED_CA="\$SOURCE_ROOT\/parser-runtime\/pip-cacert\.crt"/);
  assert.match(worker, /certifi_core\.DEBIAN_CA_CERTS_PATH = ca_bundle/);
  assert.match(worker, /from pip\._internal\.cli\.main import main as pip_main/);
  assert.doesNotMatch(worker, /\/usr\/bin\/python3 -m pip install/);
  assert.match(
    worker,
    /install -d -m 0755 "\$OUTPUT_ROOT\/usr\/lib\/python3\.14"[\s\S]*?copy_file "\$SOURCE_ROOT\/parser-runtime\/sitecustomize\.py" \/usr\/lib\/python3\.14\/sitecustomize\.py 0444[\s\S]*?find "\$OUTPUT_ROOT" -xdev -type d -exec chmod 0555 \{\} \+/,
    'the pinned sitecustomize copy must occur while the staging directory is writable and before final sealing'
  );
  assert.match(
    worker,
    /copy_file "\$SOURCE_ROOT\/parser-runtime\/sitecustomize\.py" \/usr\/lib\/python3\.14\/sitecustomize\.py 0444/
  );
  assert.match(source, /case "\$library" in "\$OUTPUT_ROOT"\/\*\) continue/);
  assert.match(source, /declare -A EXECUTABLE_CLOSURE=\(\)/);
  assert.match(source, /EXECUTABLE_CLOSURE\["\$target"\]=1/);
  assert.match(source, /chmod 0555 "\$OUTPUT_ROOT\$executable"/);
  assert.match(source, /if \[\[ -L "\$OUTPUT_ROOT\/lib" && "\$\(readlink -- "\$OUTPUT_ROOT\/lib"\)" = usr\/lib \]\]; then/);
  assert.match(source, /rm -- "\$OUTPUT_ROOT\/lib"/);
  assert.match(source, /cp -a --reflink=auto "\$OUTPUT_ROOT\/usr\/lib\/\." "\$OUTPUT_ROOT\/lib\/"/);
  assert.match(source, /find[^\r\n]+-type l/);
  assert.match(source, /chown -R 0:0/);
  assert.match(source, /chmod 0555/);
  assert.doesNotMatch(source, /\beval\b/);

  for (const artifact of [
    'extract_document_text.py',
    'extract_xlsx_text.py',
    'ocr_document_text.py',
    'services/file_ingest_service.js',
    'services/upload_sandbox_service.js',
    'scripts/parse_upload_sandbox.sh'
  ]) {
    assert.match(source, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('runtime builder root controller never runs package tooling or imports candidate payload code', () => {
  const { controller, worker } = runtimeBuilderSourceSections();

  assert.doesNotMatch(controller, /(?:\/usr\/bin\/python3|python3)\s+-m\s+pip\s+install/);
  assert.doesNotMatch(controller, /\bnpm\s+(?:ci|install|rebuild)\b/);
  assert.doesNotMatch(controller, /from\s+rapidocr\s+import|RapidOCR\s*\(/);
  assert.doesNotMatch(controller, /require\([^\r\n]*upload_sandbox_service\.js/);
  assert.doesNotMatch(controller, /TM_INSPECT_VERIFIER=[^\r\n]*upload_sandbox_service\.js/);
  assert.doesNotMatch(controller, /\/opt\/turingmarket-parser\/app\/services\/upload_sandbox_service\.js['"]?\s*\)/);
  assert.match(controller, /verify_trusted_verifier/);
  assert.match(controller, /sha256sum[^\r\n]*"\$TRUSTED_VERIFIER"/);
  assert.match(
    controller,
    /\/usr\/bin\/node "\$TRUSTED_VERIFIER" measure-runtime --root "\$BUILD_RUNTIME" --require-root-ownership false/
  );
  assert.match(
    controller,
    /\/usr\/bin\/node "\$TRUSTED_VERIFIER" measure-runtime --root "\$ROOT_STAGE" --require-root-ownership true/
  );

  assert.match(worker, /\[\[ "\$\(id -u\)" -ne 0 \]\]/);
  assert.match(worker, /from pip\._internal\.cli\.main import main as pip_main/);
  assert.match(worker, /'--no-index'/);
  assert.match(worker, /npm ci --offline --omit=dev --ignore-scripts/);
  assert.match(worker, /from rapidocr import RapidOCR/);
  assert.match(worker, /RapidOCR\(\)/);
  assert.match(worker, /PARSER_OCR_ENGINE_INIT_OK/);
});

test('runtime builder accepts a verifier only from the immutable content-addressed trusted bundle', () => {
  const { controller } = runtimeBuilderSourceSections();

  assert.match(controller, /assert_trusted_verifier_location/);
  assert.match(controller, /\/usr\/local\/libexec\/turingmarket\/production-source-trust\//);
  assert.match(controller, /bundles\/[^\r\n]*\/server\/scripts\/trusted_parser_runtime_verifier/);
  assert.match(controller, /BASH_REMATCH\[2\][^\r\n]*BASH_REMATCH\[3\]/);
  assert.match(controller, /"\$SOURCE_ROOT"\|"\$SOURCE_ROOT"\/\*/);
  assert.match(controller, /\/var\/lib\/turingmarket-gate\/releases/);
  assert.match(controller, /\/root\/turingmarket\/\.deploy-v030\.lock\/parser-appliance\/source/);
});

test('runtime builder launches exactly one fixed-identity disposable offline build unit', () => {
  const { controller } = runtimeBuilderSourceSections();
  const unitMatch = controller.match(
    /# BEGIN DISPOSABLE BUILD UNIT\r?\n([\s\S]*?)# END DISPOSABLE BUILD UNIT\r?\n/
  );
  assert.ok(unitMatch, 'trusted controller must expose the complete disposable unit contract');
  const unit = unitMatch[1];

  assert.equal((controller.match(/\bsystemd-run\b/g) || []).length, 1);
  assert.match(unit, /systemd-run --quiet --wait --collect/);
  assert.match(unit, /--service-type=exec/);
  assert.match(unit, /--property="User=turingmarket-gate"/);
  assert.match(unit, /--property="Group=turingmarket-gate"/);
  assert.doesNotMatch(unit, /DynamicUser=no|User=root|Group=root/);
  for (const property of [
    'PrivateNetwork=yes',
    'IPAddressDeny=any',
    'RestrictAddressFamilies=AF_UNIX',
    'PrivateMounts=yes',
    'PrivateTmp=yes',
    'PrivateUsers=yes',
    'PrivateDevices=yes',
    'DevicePolicy=closed',
    'PrivateIPC=yes',
    'PrivatePIDs=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'ProtectProc=invisible',
    'ProcSubset=pid',
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'RestrictNamespaces=yes',
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    'SystemCallArchitectures=native',
    'UMask=0077',
    'KeyringMode=private'
  ]) {
    assert.match(unit, new RegExp(`--property="${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  assert.match(unit, /SystemCallFilter=~[^\r\n]*@mount[^\r\n]*@privileged[^\r\n]*\bsocket\b[^\r\n]*\bsocketcall\b/);
  assert.match(unit, /--property="TemporaryFileSystem=\/root:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/home:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/etc:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/opt:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/srv:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/tmp:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/var:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/run:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/data:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/mnt:ro"/);
  assert.match(unit, /--property="TemporaryFileSystem=\/media:ro"/);
  assert.match(unit, /--property="InaccessiblePaths=-\/etc\/turingmarket -\/etc\/credstore -\/etc\/credstore\.encrypted -\/run\/credentials -\/run\/secrets"/);
  assert.match(unit, /--property="BindReadOnlyPaths=\$BUILD_INPUT:\/build-input"/);
  assert.match(unit, /--property="BindReadOnlyPaths=\$DEPENDENCY_CACHE_ROOT:\/dependency-cache"/);
  assert.match(unit, /--property="BindPaths=\$BUILD_WORK:\/build-work"/);
  assert.match(unit, /--property="ReadWritePaths=\/build-work"/);
  assert.doesNotMatch(unit, /Bind(?:ReadOnly)?Paths=\$SOURCE_ROOT|EnvironmentFile=|LoadCredential=|SetCredential=|PassEnvironment=|--setenv/);
  assert.match(unit, /\/usr\/bin\/env -i/);
  assert.match(unit, /PIP_CONFIG_FILE=\/dev\/null/);
  assert.match(unit, /npm_config_userconfig=\/dev\/null/);
});

test('runtime builder keeps npm user and global config files distinct', () => {
  const { controller, worker } = runtimeBuilderSourceSections();

  assert.match(controller, /npm_config_userconfig=\/dev\/null/);
  assert.match(controller, /npm_config_globalconfig=\/build-work\/npm-global\.npmrc/);
  assert.match(worker, /NPM_GLOBAL_CONFIG=\/build-work\/npm-global\.npmrc/);
  assert.match(worker, /install -m 0600 \/dev\/null "\$NPM_GLOBAL_CONFIG"/);
  assert.doesNotMatch(
    controller,
    /npm_config_userconfig=([^\s\\]+)[\s\S]*?npm_config_globalconfig=\1(?:\s|\\)/
  );
});

test('runtime builder hides the private build parent and collects the unit before verification and sealing', () => {
  const { controller } = runtimeBuilderSourceSections();

  assert.match(controller, /mktemp -d \/var\/lib\/turingmarket-parser-build\.XXXXXXXXXXXX/);
  assert.match(controller, /chmod 0700 "\$BUILD_PARENT"/);
  assert.match(controller, /runuser -u "\$BUILD_USER" -- test ! -r "\$BUILD_PARENT"/);
  assert.match(controller, /runuser -u "\$BUILD_USER" -- test ! -x "\$BUILD_PARENT"/);
  assert.match(controller, /assert_dependency_cache/);
  assert.match(controller, /npm\/\_cacache/);
  assert.match(controller, /python[^\r\n]*\.whl/);

  const collected = controller.indexOf('systemd-run --quiet --wait --collect');
  const unprivilegedVerification = controller.indexOf('measure-runtime --root "$BUILD_RUNTIME"');
  const rootStageCreation = controller.indexOf('ROOT_STAGE="$(mktemp -d');
  const rootVerification = controller.indexOf('measure-runtime --root "$ROOT_STAGE"');
  const publication = controller.indexOf('mv -T -- "$ROOT_STAGE" "$OUTPUT_ROOT"');
  assert.ok(collected >= 0, 'build unit must be collected');
  assert.ok(
    collected < unprivilegedVerification &&
      unprivilegedVerification < rootStageCreation &&
      rootStageCreation < rootVerification &&
      rootVerification < publication,
    'stopped unit collection, verification, root sealing, root verification, and publication must be ordered'
  );
});

test('provisioner declares snapshot, atomic install, verification, and idempotent rollback', () => {
  const source = read(provisionScript);

  assert.match(source, /^#!\/usr\/bin\/env bash\r?\nset -Eeuo pipefail\r?\n/);
  assert.match(source, /snapshot\)/);
  assert.match(source, /install\)/);
  assert.match(source, /rollback\)/);
  assert.match(source, /flock/);
  assert.match(source, /RENAME_EXCHANGE/);
  assert.match(source, /turingmarket-parser@\*\.service/);
  assert.match(source, /systemctl[^\r\n]+daemon-reload/);
  assert.match(source, /systemctl[^\r\n]+cat turingmarket-parser@\.service/);
  assert.match(source, /systemctl[^\r\n]+cat turingmarket-parser\.slice/);
  assert.match(source, /useradd/);
  assert.match(source, /passwd[^\r\n]+-l/);
  assert.match(source, /\/usr\/sbin\/nologin/);
  assert.match(source, /--trusted-verifier/);
  assert.match(source, /--expected-verifier-sha256/);
  assert.match(source, /--expected-sha256/);
  assert.match(source, /--json/);
  assert.match(source, /bind-acceptance/);
  assert.match(source, /--raw-observations/);
  assert.match(source, /--build-evidence/);
  assert.match(source, /--expected-manifest-sha256/);
  assert.match(source, /TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC/);
  assert.match(source, /TM_UPLOAD_SANDBOX_DIAGNOSTIC=1/);
  assert.match(source, /--diagnose/);
  assert.match(source, /rollback_from_snapshot/);
  assert.match(source, /trap[^\r\n]+ERR/);
  assert.match(source, /parser-runtime\.tgz/);
  assert.match(source, /cd "\$SNAPSHOT_ROOT"/);
  assert.match(source, /find \.[^\r\n]+SHA256SUMS/);
  assert.match(source, /ROLLBACK_ARMED=1/);
  assert.match(source, /validate_runtime_against_manifest/);
  assert.match(source, /verify_trusted_verifier/);
  assert.match(source, /sha256sum[^\r\n]*"\$TRUSTED_VERIFIER"/);
  assert.match(
    source,
    /\/usr\/bin\/node "\$TRUSTED_VERIFIER" measure-runtime --root "\$root" --require-root-ownership true/
  );
  assert.match(source, /files.*directories.*bytes/s);
  assert.match(source, /\/var\/lib\/turingmarket-parser\/runtime-root/);
  assert.match(source, /\/etc\/systemd\/system\/turingmarket-parser@\.service/);
  assert.match(source, /valid_single_release_child[\s\S]*\/var\/lib\/turingmarket-gate\/snapshots parser-appliance/);
  assert.doesNotMatch(source, /services\/upload_sandbox_service\.js/);
  assert.doesNotMatch(source, /\beval\b/);
});

for (const scenario of [
  { name: 'before the runtime exchange', boundary: '' },
  {
    name: 'after the runtime exchange',
    boundary: 'exchange_runtime_paths "$RUNTIME_ROOT" "$RUNTIME_TRANSACTION_STAGE"'
  },
  {
    name: 'after the old runtime is parked',
    boundary: [
      'exchange_runtime_paths "$RUNTIME_ROOT" "$RUNTIME_TRANSACTION_STAGE"',
      'mv -T -- "$RUNTIME_TRANSACTION_STAGE" "$RUNTIME_TRANSACTION_PREVIOUS"'
    ].join('\n')
  },
  {
    name: 'after the old runtime is removed',
    boundary: [
      'exchange_runtime_paths "$RUNTIME_ROOT" "$RUNTIME_TRANSACTION_STAGE"',
      'mv -T -- "$RUNTIME_TRANSACTION_STAGE" "$RUNTIME_TRANSACTION_PREVIOUS"',
      'rm -rf --one-file-system -- "$RUNTIME_TRANSACTION_PREVIOUS"'
    ].join('\n')
  }
]) {
  linuxTransactionTest(`journal-bound recovery completes install ${scenario.name}`, () => {
    const execution = runRuntimeTransactionScenario([
      'runtime_transaction_paths',
      'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
      'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
      'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
      'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
      'write_runtime_transaction_journal',
      scenario.boundary,
      'recover_runtime_transaction install',
      'test "$RUNTIME_TRANSACTION_RECOVERY" = completed',
      'test "$(cat "$RUNTIME_ROOT/runtime-id")" = candidate',
      'test ! -e "$RUNTIME_TRANSACTION_STAGE"',
      'test ! -e "$RUNTIME_TRANSACTION_PREVIOUS"',
      'test ! -e "$RUNTIME_TRANSACTION_JOURNAL"'
    ].filter(Boolean).join('\n'));

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  });
}

linuxTransactionTest('rollback reconciles a journal-bound post-exchange install before restoring snapshot state', () => {
  const execution = runRuntimeTransactionScenario([
    'runtime_transaction_paths',
    'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
    'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
    'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
    'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
    'write_runtime_transaction_journal',
    'exchange_runtime_paths "$RUNTIME_ROOT" "$RUNTIME_TRANSACTION_STAGE"',
    'EXPECTED_SHA256=""',
    'recover_runtime_transaction rollback',
    'test "$RUNTIME_TRANSACTION_RECOVERY" = completed',
    'test "$(cat "$RUNTIME_ROOT/runtime-id")" = candidate',
    'test ! -e "$RUNTIME_TRANSACTION_STAGE"',
    'test ! -e "$RUNTIME_TRANSACTION_PREVIOUS"',
    'test ! -e "$RUNTIME_TRANSACTION_JOURNAL"'
  ].join('\n'));

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
});

linuxTransactionTest('recovery promotes a complete journal after crashing between new journal fsync and rename', () => {
  const execution = runRuntimeTransactionScenario([
    'runtime_transaction_paths',
    'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
    'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
    'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
    'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
    'mv() {',
    '  if [[ "$#" -eq 4 && "$1" = -T && "$2" = -- &&',
    '        "$3" = "$RUNTIME_TRANSACTION_JOURNAL_NEW" && "$4" = "$RUNTIME_TRANSACTION_JOURNAL" ]]; then',
    '    return 99',
    '  fi',
    '  command mv "$@"',
    '}',
    'set +e',
    '( set -e; write_runtime_transaction_journal )',
    'code=$?',
    'set -e',
    'unset -f mv',
    'test "$code" -eq 99',
    'test -f "$RUNTIME_TRANSACTION_JOURNAL_NEW"',
    'test ! -e "$RUNTIME_TRANSACTION_JOURNAL"',
    'recover_runtime_transaction install',
    'test "$RUNTIME_TRANSACTION_RECOVERY" = completed',
    'test "$(cat "$RUNTIME_ROOT/runtime-id")" = candidate',
    'test ! -e "$RUNTIME_TRANSACTION_STAGE"',
    'test ! -e "$RUNTIME_TRANSACTION_PREVIOUS"',
    'test ! -e "$RUNTIME_TRANSACTION_JOURNAL"',
    'test ! -e "$RUNTIME_TRANSACTION_JOURNAL_NEW"'
  ].join('\n'));

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
});

for (const scenario of [
  {
    name: 'partial',
    corrupt: [
      'head -n 6 "$RUNTIME_TRANSACTION_JOURNAL_NEW" > "$scratch/partial"',
      'chmod 0600 "$scratch/partial"',
      'mv -T -- "$scratch/partial" "$RUNTIME_TRANSACTION_JOURNAL_NEW"'
    ].join('\n'),
    expectedError: /invalid parser runtime transaction journal staging file; no changes made/
  },
  {
    name: 'stage-identity-mismatched',
    corrupt: [
      'mv -T -- "$RUNTIME_TRANSACTION_STAGE" "$scratch/journal-candidate"',
      'install -d -o root -g root -m 0555 "$RUNTIME_TRANSACTION_STAGE"',
      'printf \'%s\\n\' foreign > "$RUNTIME_TRANSACTION_STAGE/runtime-id"',
      'chmod 0400 "$RUNTIME_TRANSACTION_STAGE/runtime-id"'
    ].join('\n'),
    expectedError: /parser runtime transaction state does not match its staging journal; no changes made/
  }
]) {
  linuxTransactionTest(`recovery rejects a ${scenario.name} new journal without changing runtime state`, () => {
    const execution = runRuntimeTransactionScenario([
      'runtime_transaction_paths',
      'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
      'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
      'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
      'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
      'write_runtime_transaction_journal',
      'mv -T -- "$RUNTIME_TRANSACTION_JOURNAL" "$RUNTIME_TRANSACTION_JOURNAL_NEW"',
      scenario.corrupt,
      'set +e',
      'recover_runtime_transaction install',
      'code=$?',
      'set -e',
      'test "$code" -eq 66',
      'test "$(cat "$RUNTIME_ROOT/runtime-id")" = previous',
      'test -f "$RUNTIME_TRANSACTION_JOURNAL_NEW"',
      'test ! -e "$RUNTIME_TRANSACTION_JOURNAL"',
      scenario.name === 'partial'
        ? 'test "$(cat "$RUNTIME_TRANSACTION_STAGE/runtime-id")" = candidate'
        : 'test "$(cat "$RUNTIME_TRANSACTION_STAGE/runtime-id")" = foreign && test "$(cat "$scratch/journal-candidate/runtime-id")" = candidate'
    ].join('\n'));

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    assert.match(execution.stderr, scenario.expectedError);
  });
}

for (const scenario of [
  {
    name: 'group-writable',
    corrupt: 'chmod 0660 "$RUNTIME_TRANSACTION_JOURNAL_NEW"',
    preserve: 'test "$(stat -c \'%a\' "$RUNTIME_TRANSACTION_JOURNAL_NEW")" = 660'
  },
  {
    name: 'hard-linked',
    corrupt: 'ln -- "$RUNTIME_TRANSACTION_JOURNAL_NEW" "$scratch/new-journal-link"',
    preserve: 'test "$(stat -c \'%h\' "$RUNTIME_TRANSACTION_JOURNAL_NEW")" -eq 2 && test -f "$scratch/new-journal-link"'
  }
]) {
  linuxTransactionTest(`recovery rejects a ${scenario.name} new journal without changing runtime state`, () => {
    const execution = runRuntimeTransactionScenario([
      'runtime_transaction_paths',
      'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
      'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
      'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
      'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
      'write_runtime_transaction_journal',
      'mv -T -- "$RUNTIME_TRANSACTION_JOURNAL" "$RUNTIME_TRANSACTION_JOURNAL_NEW"',
      scenario.corrupt,
      'set +e',
      'recover_runtime_transaction install',
      'code=$?',
      'set -e',
      'test "$code" -eq 66',
      'test "$(cat "$RUNTIME_ROOT/runtime-id")" = previous',
      'test "$(cat "$RUNTIME_TRANSACTION_STAGE/runtime-id")" = candidate',
      'test -f "$RUNTIME_TRANSACTION_JOURNAL_NEW"',
      'test ! -e "$RUNTIME_TRANSACTION_JOURNAL"',
      scenario.preserve
    ].join('\n'));

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    assert.match(execution.stderr, /unsafe parser runtime transaction journal staging file; no changes made/);
  });
}

linuxTransactionTest('recovery rejects simultaneous authoritative and new journals without changing runtime state', () => {
  const execution = runRuntimeTransactionScenario([
    'runtime_transaction_paths',
    'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
    'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
    'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
    'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
    'write_runtime_transaction_journal',
    'cp --preserve=mode,ownership -- "$RUNTIME_TRANSACTION_JOURNAL" "$RUNTIME_TRANSACTION_JOURNAL_NEW"',
    'set +e',
    'recover_runtime_transaction install',
    'code=$?',
    'set -e',
    'test "$code" -eq 66',
    'test "$(cat "$RUNTIME_ROOT/runtime-id")" = previous',
    'test "$(cat "$RUNTIME_TRANSACTION_STAGE/runtime-id")" = candidate',
    'test -f "$RUNTIME_TRANSACTION_JOURNAL"',
    'test -f "$RUNTIME_TRANSACTION_JOURNAL_NEW"',
    'test "$(stat -c \'%h\' "$RUNTIME_TRANSACTION_JOURNAL")" -eq 1',
    'test "$(stat -c \'%h\' "$RUNTIME_TRANSACTION_JOURNAL_NEW")" -eq 1'
  ].join('\n'));

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.match(execution.stderr, /ambiguous parser runtime transaction journals; no changes made/);
});

linuxTransactionTest('install removes only an exact verified unjournaled pre-swap stage', () => {
  const execution = runRuntimeTransactionScenario([
    'runtime_transaction_paths',
    'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
    'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
    'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
    'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
    'recover_runtime_transaction install',
    'test "$RUNTIME_TRANSACTION_RECOVERY" = cleaned',
    'test "$(cat "$RUNTIME_ROOT/runtime-id")" = previous',
    'test ! -e "$RUNTIME_TRANSACTION_STAGE"'
  ].join('\n'));

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
});

linuxTransactionTest('recovery preserves an ambiguous unjournaled stage when live also matches the candidate', () => {
  const execution = runRuntimeTransactionScenario([
    'runtime_transaction_paths',
    'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_ROOT"',
    'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
    'set +e',
    'recover_runtime_transaction install',
    'code=$?',
    'set -e',
    'test "$code" -eq 66',
    'test "$(cat "$RUNTIME_ROOT/runtime-id")" = candidate',
    'test "$(cat "$RUNTIME_TRANSACTION_STAGE/runtime-id")" = candidate',
    'test ! -e "$RUNTIME_TRANSACTION_JOURNAL"',
    'test ! -e "$RUNTIME_TRANSACTION_JOURNAL_NEW"'
  ].join('\n'));

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.match(execution.stderr, /ambiguous unjournaled parser runtime stage; no changes made/);
});

linuxTransactionTest('recovery rejects legacy PID-suffixed remnants without changing them', () => {
  const execution = runRuntimeTransactionScenario([
    'runtime_transaction_paths',
    'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
    'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
    'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
    'install -d -o root -g root -m 0700 "$STATE_ROOT/.runtime-root.install.4242"',
    'printf \'%s\\n\' legacy > "$STATE_ROOT/.runtime-root.install.4242/runtime-id"',
    'chmod 0400 "$STATE_ROOT/.runtime-root.install.4242/runtime-id"',
    'set +e',
    'recover_runtime_transaction install',
    'code=$?',
    'set -e',
    'test "$code" -eq 66',
    'test "$(cat "$RUNTIME_ROOT/runtime-id")" = previous',
    'test "$(cat "$STATE_ROOT/.runtime-root.install.4242/runtime-id")" = legacy'
  ].join('\n'));

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.match(execution.stderr, /legacy PID-suffixed parser runtime remnant requires manual reconciliation; no changes made/);
});

linuxTransactionTest('recovery rejects an identity-mismatched journal without changing any runtime path', () => {
  const execution = runRuntimeTransactionScenario([
    'runtime_transaction_paths',
    'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
    'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
    'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
    'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
    'write_runtime_transaction_journal',
    'mv -- "$RUNTIME_TRANSACTION_STAGE" "$scratch/journal-candidate"',
    'install -d -o root -g root -m 0555 "$RUNTIME_TRANSACTION_STAGE"',
    'printf \'%s\\n\' foreign > "$RUNTIME_TRANSACTION_STAGE/runtime-id"',
    'chmod 0400 "$RUNTIME_TRANSACTION_STAGE/runtime-id"',
    'set +e',
    'recover_runtime_transaction install',
    'code=$?',
    'set -e',
    'test "$code" -eq 66',
    'test "$(cat "$RUNTIME_ROOT/runtime-id")" = previous',
    'test "$(cat "$RUNTIME_TRANSACTION_STAGE/runtime-id")" = foreign',
    'test "$(cat "$scratch/journal-candidate/runtime-id")" = candidate',
    'test -f "$RUNTIME_TRANSACTION_JOURNAL"'
  ].join('\n'));

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.match(execution.stderr, /parser runtime transaction state does not match its journal; no changes made/);
});

linuxTransactionTest('recovery rejects a non-root-only journal without changing any runtime path', () => {
  const execution = runRuntimeTransactionScenario([
    'runtime_transaction_paths',
    'install -d -o root -g root -m 0555 "$RUNTIME_ROOT"',
    'printf \'%s\\n\' previous > "$RUNTIME_ROOT/runtime-id"',
    'chmod 0400 "$RUNTIME_ROOT/runtime-id"',
    'cp -a -- "$STAGED_RUNTIME" "$RUNTIME_TRANSACTION_STAGE"',
    'write_runtime_transaction_journal',
    'chmod 0644 "$RUNTIME_TRANSACTION_JOURNAL"',
    'set +e',
    'recover_runtime_transaction install',
    'code=$?',
    'set -e',
    'test "$code" -eq 66',
    'test "$(cat "$RUNTIME_ROOT/runtime-id")" = previous',
    'test "$(cat "$RUNTIME_TRANSACTION_STAGE/runtime-id")" = candidate',
    'test -f "$RUNTIME_TRANSACTION_JOURNAL"'
  ].join('\n'));

  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.match(execution.stderr, /unsafe parser runtime transaction journal; no changes made/);
});

test('both lifecycle scripts pass bash syntax validation', () => {
  for (const script of [buildScript, provisionScript]) {
    const result = runBash(['-n', script]);
    assert.equal(result.status, 0, `${path.basename(script)}: ${result.stderr}`);
  }
});

test('builder rejects relative roots before creating output', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-parser-build-reject-'));
  try {
    const before = fs.readdirSync(scratch);
    const result = runBash([
      buildScript,
      '--source-root', 'relative-source',
      '--output-root', 'relative-output',
      '--json'
    ]);
    assert.equal(result.status, 64, result.stderr);
    assert.deepEqual(fs.readdirSync(scratch), before);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('builder requires the trusted verifier pin and offline dependency cache before platform checks', () => {
  const base = [
    buildScript,
    '--source-root', '/trusted/source',
    '--output-root', '/trusted/output'
  ];
  for (const omitted of [
    [],
    ['--dependency-cache-root', '/trusted/cache'],
    [
      '--dependency-cache-root', '/trusted/cache',
      '--trusted-verifier', '/trusted/verifier.js'
    ]
  ]) {
    const result = runBash([...base, ...omitted]);
    assert.equal(result.status, 64, result.stderr || result.stdout);
  }
});

test('builder rejects malformed verifier pins and duplicate arguments under Git Bash', () => {
  const required = [
    buildScript,
    '--source-root', '/trusted/source',
    '--output-root', '/trusted/output',
    '--dependency-cache-root', '/trusted/cache',
    '--trusted-verifier', '/trusted/verifier.js'
  ];
  for (const tail of [
    ['--expected-verifier-sha256', 'A'.repeat(64)],
    ['--expected-verifier-sha256', '0'.repeat(63)],
    [
      '--expected-verifier-sha256', '0'.repeat(64),
      '--trusted-verifier', '/trusted/other-verifier.js'
    ],
    [
      '--expected-verifier-sha256', '0'.repeat(64),
      '--json', '--json'
    ]
  ]) {
    const result = runBash([...required, ...tail]);
    assert.equal(result.status, 64, result.stderr || result.stdout);
  }
});

test('builder rejects source and release verifiers before platform-specific execution', () => {
  const digest = 'a'.repeat(64);
  const args = [
    buildScript,
    '--source-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source',
    '--output-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.stage',
    '--dependency-cache-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/dependency-cache',
    '--expected-verifier-sha256', digest
  ];
  for (const verifier of [
    '/root/turingmarket/.deploy-v030.lock/parser-appliance/source/scripts/trusted_parser_runtime_verifier.js',
    '/var/lib/turingmarket-gate/releases/v060-crm-sales-workspace-20260814-120000/platform/server/scripts/trusted_parser_runtime_verifier.js',
    '/tmp/trusted_parser_runtime_verifier.js'
  ]) {
    const result = runBash([...args, '--trusted-verifier', verifier]);
    assert.equal(result.status, 64, `${verifier}: ${result.stderr || result.stdout}`);
  }
});

test('builder requires the exact content-addressed trusted bundle verifier path', () => {
  const gateSha = 'a'.repeat(64);
  const manifestSha = 'b'.repeat(64);
  const otherSha = 'c'.repeat(64);
  const trustedPrefix = `/usr/local/libexec/turingmarket/production-source-trust/${gateSha}/${manifestSha}`;
  const args = [
    buildScript,
    '--source-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source',
    '--output-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.stage',
    '--dependency-cache-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/dependency-cache',
    '--expected-verifier-sha256', otherSha,
    '--expected-manifest-sha256', manifestSha
  ];
  for (const verifier of [
    `${trustedPrefix}/runtime/${manifestSha}/server/scripts/trusted_parser_runtime_verifier.js`,
    `${trustedPrefix}/bundles/${otherSha}/server/scripts/trusted_parser_runtime_verifier.js`,
    `${trustedPrefix}/bundles/${manifestSha}/server/scripts/other_verifier.js`
  ]) {
    const result = runBash([...args, '--trusted-verifier', verifier]);
    assert.equal(result.status, 64, `${verifier}: ${result.stderr || result.stdout}`);
  }

  const approved = `${trustedPrefix}/bundles/${manifestSha}/server/scripts/trusted_parser_runtime_verifier.js`;
  const result = runBash([...args, '--trusted-verifier', approved]);
  assert.notEqual(result.status, 64, result.stderr || result.stdout);
});

test('provisioner rejects relative snapshot roots before live mutation', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-parser-provision-reject-'));
  try {
    const before = fs.readdirSync(scratch);
    const result = runBash([
      provisionScript,
      'snapshot',
      '--snapshot-root', 'relative-snapshot',
      '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
      '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
      '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
      '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
    ]);
    assert.equal(result.status, 64, result.stderr);
    assert.deepEqual(fs.readdirSync(scratch), before);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('provisioner rejects nested or traversal lifecycle roots before live mutation', () => {
  const invalidSnapshotRoots = [
    '/var/lib/turingmarket-gate/snapshots/release/nested/parser-appliance',
    '/var/lib/turingmarket-gate/snapshots/../outside/parser-appliance',
    '/var/lib/turingmarket-gate/snapshots/./parser-appliance',
    '/var/lib/turingmarket-gate/snapshots/release name/parser-appliance',
    '/var/lib/turingmarket-gate/snapshots/release\nbreak/parser-appliance'
  ];
  for (const snapshotRoot of invalidSnapshotRoots) {
    const result = runBash([
      provisionScript,
      'snapshot',
      '--snapshot-root', snapshotRoot,
      '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
      '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
      '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
      '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
    ]);
    assert.equal(result.status, 64, `${snapshotRoot}: ${result.stderr}`);
  }

  for (const stagedRuntime of [
    '/var/lib/turingmarket-gate/releases/release/nested/parser-runtime.stage',
    '/var/lib/turingmarket-gate/releases/../outside/parser-runtime.stage',
    '/var/lib/turingmarket-gate/releases/.v060-parser-runtime.unsafe/nested',
    '/var/lib/turingmarket-gate/releases/.v060-parser-runtime.bad name'
  ]) {
    const result = runBash([
      provisionScript,
      'install',
      '--snapshot-root', '/var/lib/turingmarket-gate/releases/.v060-parser-snapshot',
      '--staged-runtime', stagedRuntime,
      '--source-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source',
      '--expected-sha256', '0'.repeat(64),
      '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
      '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
      '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
      '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
    ]);
    assert.equal(result.status, 64, `${stagedRuntime}: ${result.stderr}`);
  }
});

test('provisioner requires the trusted verifier pin before live mutation', () => {
  const base = [
    provisionScript,
    'install',
    '--snapshot-root', '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/parser-appliance',
    '--staged-runtime', '/root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.stage',
    '--source-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source',
    '--expected-sha256', '0'.repeat(64),
    '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
    '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
    '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
    '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
  ];
  for (const omitted of [
    [],
    ['--trusted-verifier', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source/scripts/trusted_parser_runtime_verifier.js'],
    ['--expected-verifier-sha256', '0'.repeat(64)]
  ]) {
    const result = runBash([...base, ...omitted]);
    assert.equal(result.status, 64, result.stderr || result.stdout);
  }
});

test('provisioner rejects malformed verifier pins and non-approved verifier paths under Git Bash', () => {
  const required = [
    provisionScript,
    'install',
    '--snapshot-root', '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/parser-appliance',
    '--staged-runtime', '/root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.stage',
    '--source-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source',
    '--expected-sha256', '0'.repeat(64),
    '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
    '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
    '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
    '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test',
    '--trusted-verifier', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source/scripts/trusted_parser_runtime_verifier.js'
  ];
  for (const tail of [
    ['--expected-verifier-sha256', 'A'.repeat(64)],
    ['--expected-verifier-sha256', '0'.repeat(63)],
    [
      '--expected-verifier-sha256', '0'.repeat(64),
      '--trusted-verifier', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source/scripts/other_verifier.js'
    ],
    [
      '--expected-verifier-sha256', '0'.repeat(64),
      '--trusted-verifier', '/root/turingmarket/platform/server/scripts/trusted_parser_runtime_verifier.js'
    ]
  ]) {
    const result = runBash([...required, ...tail]);
    assert.equal(result.status, 64, result.stderr || result.stdout);
  }
});

test('provisioner accepts only the exact versioned backup parser snapshot location', () => {
  const valid = runBash([
    provisionScript,
    'snapshot',
    '--snapshot-root', '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/parser-appliance',
    '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
    '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
    '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
    '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
  ]);
  assert.equal(valid.status, 65, valid.stderr);

  for (const snapshotRoot of [
    '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/nested/parser-appliance',
    '/root/turingmarket/backups/v060-crm-sales-workspace-latest/parser-appliance',
    '/root/turingmarket/backups/v050-campaign-business-spine-20260813-120000/parser-appliance'
  ]) {
    const result = runBash([
      provisionScript,
      'snapshot',
      '--snapshot-root', snapshotRoot,
      '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
      '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
      '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
      '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
    ]);
    assert.equal(result.status, 64, `${snapshotRoot}: ${result.stderr}`);
  }
});

test('provisioner accepts only the exact cutover snapshot staging parser location', () => {
  const valid = runBash([
    provisionScript,
    'snapshot',
    '--snapshot-root', '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/.cutover-snapshot.0123456789abcdef0123456789abcdef/parser-appliance',
    '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
    '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
    '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
    '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
  ]);
  assert.equal(valid.status, 65, valid.stderr);

  for (const snapshotRoot of [
    '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/.cutover-snapshot.bad/parser-appliance',
    '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/.cutover-snapshot.0123456789abcdef0123456789abcdef/nested/parser-appliance',
    '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/cutover-snapshot/parser-appliance'
  ]) {
    const result = runBash([
      provisionScript,
      'snapshot',
      '--snapshot-root', snapshotRoot,
      '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
      '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
      '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
      '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
    ]);
    assert.equal(result.status, 64, `${snapshotRoot}: ${result.stderr}`);
  }
});

test('provisioner accepts the exact finalized cutover parser snapshot only for install or rollback', () => {
  const finalized = '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/cutover-snapshot/parser-appliance';
  const snapshot = runBash([
    provisionScript,
    'snapshot',
    '--snapshot-root', finalized,
    '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
    '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
    '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
    '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
  ]);
  assert.equal(snapshot.status, 64, snapshot.stderr);

  const rollback = runBash([
    provisionScript,
    'rollback',
    '--snapshot-root', finalized,
    '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
    '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
    '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
    '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
  ]);
  assert.equal(rollback.status, 65, rollback.stderr);
});

test('provisioner accepts only the root-only lifecycle stage and source', () => {
  const trustedVerifier = `/usr/local/libexec/turingmarket/production-source-trust/${'a'.repeat(64)}/${'b'.repeat(64)}/bundles/${'b'.repeat(64)}/server/scripts/trusted_parser_runtime_verifier.js`;
  const trustedArgs = [
    '--trusted-verifier', trustedVerifier,
    '--expected-verifier-sha256', '0'.repeat(64),
    '--expected-manifest-sha256', '1'.repeat(64),
    '--build-evidence', '/root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.evidence.json'
  ];
  const valid = runBash([
    provisionScript,
    'install',
    '--snapshot-root', '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/parser-appliance',
    '--staged-runtime', '/root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.stage',
    '--source-root', '/root/turingmarket/.deploy-v030.lock/parser-appliance/source',
    ...trustedArgs,
    '--expected-sha256', '0'.repeat(64),
    '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
    '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
    '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
    '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
  ]);
  assert.equal(valid.status, 65, valid.stderr);

  for (const sourceRoot of [
    '/root/turingmarket/.deploy-v030.lock/parser-appliance/source/nested',
    '/root/turingmarket/platform/server',
    '/var/lib/turingmarket-gate/releases/v060-crm-sales-workspace-20260813-120000/server',
    '/var/lib/turingmarket-gate/releases/v050-campaign-business-spine-20260813-120000/server'
  ]) {
    const result = runBash([
      provisionScript,
      'install',
      '--snapshot-root', '/root/turingmarket/backups/v060-crm-sales-workspace-20260813-120000/parser-appliance',
      '--staged-runtime', '/root/turingmarket/.deploy-v030.lock/parser-appliance/runtime.stage',
      '--source-root', sourceRoot,
      ...trustedArgs,
      '--expected-sha256', '0'.repeat(64),
      '--runtime-root', '/var/lib/turingmarket-parser/runtime-root',
      '--service-unit-target', '/etc/systemd/system/turingmarket-parser@.service',
      '--slice-unit-target', '/etc/systemd/system/turingmarket-parser.slice',
      '--self-test-target', '/usr/local/libexec/turingmarket/upload_sandbox_self_test'
    ]);
    assert.equal(result.status, 64, `${sourceRoot}: ${result.stderr}`);
  }
});

test('provisioner revalidates the canonical parser source root after realpath', () => {
  const source = read(provisionScript);
  assert.match(source, /SOURCE_ROOT="\$\(realpath -e -- "\$SOURCE_ROOT"\)"\r?\n\s*\[\[ "\$SOURCE_ROOT" = \/root\/turingmarket\/\.deploy-v030\.lock\/parser-appliance\/source \]\] \|\| usage/);
});

test('root provisioning invokes only the dependency-free trusted self-test controller', () => {
  const source = read(provisionScript);
  assert.match(source, /run_trusted_parser_self_test\(\)/);
  assert.match(source, /TM_UPLOAD_SANDBOX_MANIFEST_PATH="\$SOURCE_ROOT\/systemd\/turingmarket-parser\.manifest\.json"/);
  assert.match(source, /TM_UPLOAD_SANDBOX_SERVER_ROOT="\$RUNTIME_ROOT\/opt\/turingmarket-parser\/app"/);
  assert.match(source, /"\$SELF_TEST_TARGET" "\$mode"/);
  assert.doesNotMatch(source, /run_nonroot_parser_self_test|NON-ROOT PARSER SELF-TEST UNIT/);
  assert.doesNotMatch(source, /systemd-run[\s\S]*turingmarket-parser-self-test\.service/);
  assert.doesNotMatch(source, /TM_UPLOAD_SANDBOX_SPOOL_ROOT=/);
});

test('runtime evidence mismatch emits canonical identity facts only in diagnostic mode', () => {
  const source = read(provisionScript);
  assert.match(source, /TM_PROVISION_DIAGNOSTIC="\$\{TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC:-0\}"/);
  assert.match(source, /parser runtime evidence details:/);
  assert.match(source, /'expected': projection/);
  assert.match(source, /'observed': observed/);
});

test('provision and cutover authorize only the exact raw envelope through trusted binding', () => {
  const provision = read(provisionScript);
  const deploy = read(path.resolve(serverRoot, '..', 'deploy_v8.ps1'));

  assert.match(provision, /bind-acceptance/);
  assert.match(provision, /--raw-observations/);
  assert.match(provision, /--runtime-root/);
  assert.match(provision, /--build-evidence/);
  assert.match(deploy, /"\$ParserLifecycleProvisioner" verify/);
  assert.match(deploy, /--trusted-verifier "\$ParserTrustedVerifier"/);
  assert.match(deploy, /--expected-verifier-sha256/);
  assert.match(deploy, /--expected-manifest-sha256/);
  assert.match(deploy, /--build-evidence "\$ParserRuntimeEvidence"/);
  for (const source of [provision, deploy]) {
    assert.doesNotMatch(source, /sorted\(result\) != sorted\(required\)/);
  }
  assert.match(provision, /--expected-manifest-sha256/);
  assert.match(deploy, /installed parser self-test envelope/i);
});

test('trusted verifier independently observes installed policy instead of echoing candidate policy', () => {
  const source = read(trustedVerifierPath);

  assert.match(source, /function observeInstalledSystemdPolicy\(/);
  assert.match(source, /\/usr\/bin\/systemctl/);
  assert.match(source, /installed_policy_sha256/);
  assert.match(source, /observeInstalledSystemdPolicy\(.*manifest/s);
  assert.doesNotMatch(source, /installedPolicyObservation:\s*raw\.effective_properties/);
});

test('trusted verifier normalizes exact systemd expansions and inspects a concrete template instance', () => {
  const verifier = require(trustedVerifierPath);
  const { manifest } = trustedParserVerifierBindingFixture(verifier);
  const calls = [];
  const spawnSync = (_command, args) => {
    calls.push(args);
    const unit = args[1];
    const keyList = args.find((value) => value.startsWith('--property='))
      .slice('--property='.length).split(',');
    const manifestUnit = unit === 'turingmarket-parser@test_instance.service'
      ? 'turingmarket-parser@.service'
      : unit;
    const observed = { ...manifest.effective_properties[manifestUnit] };
    if (manifestUnit === 'turingmarket-parser.slice') {
      delete observed.CPUAccounting;
    }
    observed.Id = unit;
    observed.LoadState = 'loaded';
    observed.SourcePath = '';
    observed.NeedDaemonReload = 'no';
    observed.Transient = 'no';
    if (manifestUnit === 'turingmarket-parser@.service') {
      observed.IPAddressDeny = '0.0.0.0/0 ::/0';
      observed.RestrictAddressFamilies = '';
      observed.SystemCallErrorNumber = '1';
      observed.BindReadOnlyPaths = observed.BindReadOnlyPaths
        .replaceAll('%i', 'test_instance').split(' ').map((value) => `${value}:rbind`).join(' ');
      observed.BindPaths = observed.BindPaths
        .replaceAll('%i', 'test_instance').split(' ').map((value) => `${value}:rbind`).join(' ');
      observed.SystemCallFilter = 'read write close execve exit exit_group shutdown socketpair';
    }
    return {
      status: 0,
      stdout: `${keyList
        .filter((key) => observed[key] !== undefined)
        .map((key) => `${key}=${observed[key]}`).join('\n')}\n`,
      stderr: ''
    };
  };

  const readInstalledArtifact = (_target, unit) => fs.readFileSync(path.join(
    serverRoot,
    'systemd',
    unit
  ));
  const diagnosticStages = [];
  const observation = verifier.observeInstalledSystemdPolicy(
    manifest,
    parserVerifierTestOptions({
      spawnSync,
      readInstalledArtifact,
      runDiagnosticStageSync: (code, operation) => {
        diagnosticStages.push(code);
        return operation();
      }
    })
  );
  assert.deepEqual(observation, installedPolicyObservationFixture(manifest, verifier));
  assert.deepEqual(diagnosticStages, [
    'service-properties-read',
    'service-syscall-policy',
    'service-policy-normalize',
    'service-unit-artifact',
    'service-manager-recheck',
    'slice-properties-read',
    'slice-policy-normalize',
    'slice-unit-artifact',
    'slice-manager-recheck'
  ]);
  assert.equal(calls[0][1], 'turingmarket-parser@test_instance.service');
  assert.match(calls[0].find((value) => value.startsWith('--property=')), /LoadState/);
  assert.match(calls[0].find((value) => value.startsWith('--property=')), /NeedDaemonReload/);
  assert.equal(calls.length, 4, 'manager controls must be observed before and after each unit artifact hash');

  const drifted = (_command, args) => {
    const result = spawnSync(_command, args);
    if (args[1] === 'turingmarket-parser@test_instance.service') {
      result.stdout = result.stdout.replace('PrivateNetwork=yes', 'PrivateNetwork=no');
    }
    return result;
  };
  assert.throws(
    () => verifier.observeInstalledSystemdPolicy(manifest, parserVerifierTestOptions({
      spawnSync: drifted,
      readInstalledArtifact
    })),
    /installed systemd policy mismatch/i
  );

  let raceCall = 0;
  const managerRace = (_command, args) => {
    raceCall += 1;
    const result = spawnSync(_command, args);
    if (raceCall === 2) {
      result.stdout = result.stdout.replace('Transient=no', 'Transient=yes');
    }
    return result;
  };
  assert.throws(
    () => verifier.observeInstalledSystemdPolicy(manifest, parserVerifierTestOptions({
      spawnSync: managerRace,
      readInstalledArtifact
    })),
    /installed systemd manager state changed/i
  );

  const staleManager = (_command, args) => {
    const result = spawnSync(_command, args);
    result.stdout = result.stdout.replace('NeedDaemonReload=no', 'NeedDaemonReload=yes');
    return result;
  };
  assert.throws(
    () => verifier.observeInstalledSystemdPolicy(manifest, parserVerifierTestOptions({
      spawnSync: staleManager,
      readInstalledArtifact
    })),
    /installed systemd policy mismatch/i
  );

  assert.throws(
    () => verifier.observeInstalledSystemdPolicy(manifest, parserVerifierTestOptions({
      spawnSync,
      readInstalledArtifact: () => Buffer.from('forged unit', 'utf8')
    })),
    /unit identity mismatch/i
  );
});

test('trusted verifier rejects any concrete syscall that the symbolic policy denies', () => {
  const verifier = require(trustedVerifierPath);
  const { manifest } = trustedParserVerifierBindingFixture(verifier);
  const expected = manifest.effective_properties['turingmarket-parser@.service'].SystemCallFilter;
  const options = parserVerifierTestOptions();

  assert.equal(verifier.normalizeSystemdProperty(
    'turingmarket-parser@.service',
    'SystemCallFilter',
    SYSTEM_CALL_BASELINE.join(' '),
    expected,
    options
  ), expected);
  for (const syscall of ['mount', 'reboot', 'ptrace', 'io_uring_setup', 'chmod', 'accept']) {
    assert.throws(() => verifier.normalizeSystemdProperty(
      'turingmarket-parser@.service',
      'SystemCallFilter',
      [...SYSTEM_CALL_BASELINE, syscall].join(' '),
      expected,
      options
    ), /systemd property mismatch/i, syscall);
  }
});

test('trusted verifier rejects target syscall-group drift beyond the reviewed concrete maximum', () => {
  const verifier = require(trustedVerifierPath);
  const { manifest } = trustedParserVerifierBindingFixture(verifier);
  const expected = manifest.effective_properties['turingmarket-parser@.service'].SystemCallFilter;
  const pins = {
    parser: require('node:crypto').createHash('sha256')
      .update(canonicalJson([...SYSTEM_CALL_BASELINE].sort())).digest('hex'),
    build: require('node:crypto').createHash('sha256')
      .update(canonicalJson([...SYSTEM_CALL_BASELINE, 'chmod'].sort())).digest('hex')
  };
  const options = {
    expandSyscallGroup: parserSyscallGroupFixture,
    pinnedSystemCallMaximumSha256ForTest: pins
  };
  assert.doesNotThrow(() => verifier.normalizeSystemdProperty(
    'turingmarket-parser@.service',
    'SystemCallFilter',
    SYSTEM_CALL_BASELINE.join(' '),
    expected,
    options
  ));

  const driftedOptions = {
    ...options,
    expandSyscallGroup: (group) => group === '@system-service'
      ? [...parserSyscallGroupFixture(group), 'future_system_call']
      : parserSyscallGroupFixture(group)
  };
  assert.throws(() => verifier.normalizeSystemdProperty(
    'turingmarket-parser@.service',
    'SystemCallFilter',
    SYSTEM_CALL_BASELINE.join(' '),
    expected,
    driftedOptions
  ), /systemd property mismatch/i);
});

test('trusted verifier normalizes systemd IPAddressDeny expansion for the live build unit', () => {
  const verifier = require(trustedVerifierPath);
  for (const value of ['0.0.0.0/0 ::/0', '::/0 0.0.0.0/0']) {
    assert.equal(
      verifier.normalizeSystemdProperty(
        'turingmarket-parser-build.service',
        'IPAddressDeny',
        value,
        'any'
      ),
      'any'
    );
  }
  assert.throws(() => verifier.normalizeSystemdProperty(
    'turingmarket-parser-build.service',
    'IPAddressDeny',
    '0.0.0.0/0',
    'any'
  ), /systemd property mismatch/i);
});

test('trusted verifier independently observes every configured build-unit security control', () => {
  const verifier = require(trustedVerifierPath);
  const roots = {
    sourceRoot: '/var/lib/turingmarket-parser-build/input',
    dependencyCacheRoot: '/var/cache/turingmarket-parser-dependencies',
    buildWork: '/var/lib/turingmarket-parser-build/work'
  };
  const expected = {
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    MainPID: '4242',
    NeedDaemonReload: 'no',
    Type: 'exec',
    Transient: 'yes',
    CollectMode: 'inactive-or-failed',
    FragmentPath: '/run/systemd/transient/turingmarket-parser-build.service',
    DropInPaths: '',
    User: 'turingmarket-gate',
    Group: 'turingmarket-gate',
    SupplementaryGroups: '',
    UMask: '0077',
    WorkingDirectory: '/build-work',
    PrivateNetwork: 'yes',
    IPAddressDeny: '0.0.0.0/0 ::/0',
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
    SystemCallFilter: SYSTEM_CALL_BASELINE.join(' '),
    SystemCallErrorNumber: '1',
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
    StandardError: 'journal',
    TemporaryFileSystem: [
      '/root:ro', '/home:ro', '/etc:ro', '/opt:ro',
      '/srv:ro', '/tmp:ro', '/var:ro', '/run:ro',
      '/data:ro', '/mnt:ro', '/media:ro'
    ].join(' '),
    InaccessiblePaths: [
      '-/etc/turingmarket', '-/etc/credstore', '-/etc/credstore.encrypted',
      '-/run/credentials', '-/run/secrets', '-/root/turingmarket',
      '-/var/lib/turingmarket-gate', '-/var/lib/turingmarket-parser',
      '-/opt/turingmarket', '-/srv/turingmarket'
    ].join(' '),
    BindReadOnlyPaths: [
      `${roots.sourceRoot}:/build-input:rbind`,
      `${roots.dependencyCacheRoot}:/dependency-cache:rbind`
    ].join(' '),
    BindPaths: `${roots.buildWork}:/build-work:rbind`,
    ReadWritePaths: '/build-work'
  };
  const spawnSync = (_command, args) => {
    const keyList = args.find((value) => value.startsWith('--property='))
      .slice('--property='.length).split(',')
      .filter((key) => key !== 'EnvironmentFiles');
    return {
      status: 0,
      stdout: `${keyList.map((key) => `${key}=${expected[key]}`).join('\n')}\n`,
      stderr: ''
    };
  };
  const options = parserVerifierTestOptions({ spawnSync });

  assert.doesNotThrow(() => verifier.observeBuildUnit(
    'turingmarket-parser-build.service',
    roots.sourceRoot,
    roots.dependencyCacheRoot,
    roots.buildWork,
    options
  ));
  for (const property of [
    'Type', 'Transient', 'CollectMode',
    'ProtectKernelTunables', 'ProtectKernelModules', 'ProtectKernelLogs',
    'ProtectControlGroups', 'ProtectClock', 'ProtectHostname',
    'MemoryMax', 'TasksMax', 'LimitNOFILE', 'LimitNOFILESoft', 'LimitCORE', 'LimitCORESoft',
    'TimeoutStartUSec', 'TimeoutStopUSec', 'StandardInput',
    'StandardOutput', 'StandardError'
  ]) {
    const original = expected[property];
    expected[property] = original === 'yes' ? 'no' : 'forged';
    assert.throws(() => verifier.observeBuildUnit(
      'turingmarket-parser-build.service',
      roots.sourceRoot,
      roots.dependencyCacheRoot,
      roots.buildWork,
      options
    ), /parser build unit property mismatch/i, property);
    expected[property] = original;
  }
});

test('trusted verifier rejects every extra build mount including production data paths', () => {
  const verifier = require(trustedVerifierPath);
  const roots = {
    sourceRoot: '/var/lib/turingmarket-parser-build/input',
    dependencyCacheRoot: '/var/cache/turingmarket-parser-dependencies',
    buildWork: '/var/lib/turingmarket-parser-build/work'
  };
  const observed = {
    TemporaryFileSystem: [
      '/root:ro', '/home:ro', '/etc:ro', '/opt:ro',
      '/srv:ro', '/tmp:ro', '/var:ro', '/run:ro',
      '/data:ro', '/mnt:ro', '/media:ro'
    ].join(' '),
    InaccessiblePaths: [
      '-/etc/turingmarket', '-/etc/credstore', '-/etc/credstore.encrypted',
      '-/run/credentials', '-/run/secrets', '-/root/turingmarket',
      '-/var/lib/turingmarket-gate', '-/var/lib/turingmarket-parser',
      '-/opt/turingmarket', '-/srv/turingmarket'
    ].join(' '),
    BindReadOnlyPaths: [
      `${roots.sourceRoot}:/build-input:rbind`,
      `${roots.dependencyCacheRoot}:/dependency-cache:rbind`
    ].join(' '),
    BindPaths: `${roots.buildWork}:/build-work:rbind`,
    ReadWritePaths: '/build-work'
  };
  assert.doesNotThrow(() => verifier.validateBuildMountIsolation(observed, roots));
  assert.throws(() => verifier.validateBuildMountIsolation({
    ...observed,
    BindReadOnlyPaths: `${observed.BindReadOnlyPaths} /etc/turingmarket:/secrets:rbind`
  }, roots), /build mount isolation mismatch/i);
  assert.throws(() => verifier.validateBuildMountIsolation({
    ...observed,
    ReadWritePaths: '/build-work /var/lib/turingmarket'
  }, roots), /build mount isolation mismatch/i);
});

test('builder binds trusted source, live unit isolation, collection, and parent access evidence', () => {
  const source = read(buildScript);

  assert.match(source, /observe-build-boundary/);
  assert.match(source, /finalize-build-boundary/);
  assert.match(source, /tm-parser-runtime-build-evidence-v2/);
  assert.match(source, /source_artifacts_sha256/);
  assert.match(source, /'build_unit_properties',\s*'build_unit_properties_sha256'/);
  assert.match(source, /build_unit_properties_sha256/);
  assert.match(source, /build_unit_stopped/);
  assert.match(source, /build_unit_collected/);
  assert.match(source, /credential_isolation/);
  assert.match(source, /build_parent_inaccessible/);
  assert.match(source, /systemd-run --quiet --wait --collect[\s\S]*&/);
  assert.match(source, /wait "\$BUILD_SYSTEMD_RUN_PID"/);
  assert.match(source, /--unit "\$BUILD_UNIT"/);
  assert.match(source, /--source-root "\$BUILD_INPUT"/);
  assert.match(source, /--build-parent "\$BUILD_PARENT"/);
});

test('deployment validators accept and bind the complete parser build unit evidence', () => {
  const deploy = read(path.join(serverRoot, '..', 'deploy_v8.ps1'));
  const boundarySchemas = Array.from(deploy.matchAll(/(?:boundary_required|expected_boundary)\s*=\s*\{([\s\S]*?)\n\s*\}/g));
  assert.equal(boundarySchemas.length, 2, 'preparation and cutover validators must define exact boundary schemas');
  for (const schema of boundarySchemas) {
    assert.match(schema[1], /'build_unit_properties'/);
    assert.match(schema[1], /'build_unit_properties_sha256'/);
  }
  assert.equal(
    (deploy.match(/build unit properties SHA-256 mismatch/g) || []).length >= 2,
    true,
    'both root validators must rehash the complete build unit properties'
  );
  const digestSites = Array.from(deploy.matchAll(/properties_digest = hashlib\.sha256/g));
  assert.equal(digestSites.length, 2, 'preparation and cutover validators must each compute the digest');
  for (const site of digestSites) {
    const hereDocumentStart = deploy.lastIndexOf("<<'PY'", site.index);
    assert.ok(hereDocumentStart >= 0, 'validator must be embedded in a Python here-document');
    assert.match(
      deploy.slice(hereDocumentStart, site.index),
      /import hashlib/,
      'every validator that computes a SHA-256 digest must import hashlib'
    );
  }
});

test('deployment enables parser lifecycle diagnostics only for the guarded install', () => {
  const deploy = read(path.join(serverRoot, '..', 'deploy_v8.ps1'));
  const privilegedInvocations = deploy.match(
    /TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC=[01] "\$Parser(?:Rollback|Lifecycle)Provisioner" (?:install|rollback|verify|snapshot)/g
  ) || [];
  assert.equal(privilegedInvocations.length, 5);
  assert.deepEqual(
    privilegedInvocations.filter((invocation) => invocation.includes('DIAGNOSTIC=1')),
    ['TM_UPLOAD_SANDBOX_PROVISION_DIAGNOSTIC=1 "$ParserLifecycleProvisioner" install'],
    'only the guarded install may emit bounded diagnostic evidence'
  );
  assert.equal(
    (deploy.match(/"\$Parser(?:Rollback|Lifecycle)Provisioner" (?:install|rollback|verify|snapshot)/g) || []).length,
    privilegedInvocations.length,
    'every privileged lifecycle invocation must set diagnostics explicitly'
  );
});

test('parser rollback validates a preserved identity before stopping units or deleting runtime state', () => {
  const source = read(provisionScript);
  const rollback = source.match(/rollback_from_snapshot\(\) \{([\s\S]*?)\n\}/);
  assert.ok(rollback, 'rollback_from_snapshot must exist');
  const body = rollback[1];
  const identityCheck = body.indexOf('present) validate_snapshot_identity');
  assert.ok(identityCheck >= 0, 'preserved parser identity must be validated');
  assert.ok(identityCheck < body.indexOf('stop_parser_units'), 'identity validation must precede service stop');
  assert.ok(identityCheck < body.indexOf('rm -rf --one-file-system -- "$RUNTIME_ROOT"'), 'identity validation must precede runtime deletion');
});
