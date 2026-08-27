'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const plannerPath = path.join(__dirname, '..', 'scripts', 'check_cutover_capacity.py');
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MINIMUM_MARGIN = 512 * MIB;
const MINIMUM_INODE_MARGIN = 1024;
const TARGET_KEYS = Object.freeze([
  'backup-root',
  'database-path',
  'live-dir',
  'parser-state-root',
  'ppt-cache-root'
]);

function findPython3() {
  const candidates = [
    { command: process.env.PYTHON3, prefix: [] },
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] },
    { command: 'py', prefix: ['-3'] }
  ].filter(({ command }) => command);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '--version'], {
      encoding: 'utf8',
      timeout: 10_000
    });
    if (probe.status === 0 && /Python 3\./.test(`${probe.stdout}${probe.stderr}`)) return candidate;
  }
  return null;
}

const python3 = findPython3();

function writeBytes(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 0x61));
}

function writeSparseBytes(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, 'w');
  try {
    fs.ftruncateSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function createCapacityTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cutover-capacity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  const paths = {
    root,
    backupRoot: path.join(root, 'backups', 'release'),
    parserStateRoot: path.join(root, 'parser-state'),
    databasePath: path.join(root, 'database', 'turingmarket.db'),
    pptCacheRoot: path.join(root, 'ppt-cache'),
    liveDir: path.join(root, 'live'),
    candidateDir: path.join(root, 'candidate'),
    parserStage: path.join(root, 'parser-stage'),
    restoreSnapshot: path.join(root, 'backups', 'release', 'cutover-snapshot'),
    fixturePath: path.join(root, 'capacity-fixture.json')
  };

  for (const directory of [
    paths.backupRoot,
    paths.parserStateRoot,
    paths.pptCacheRoot,
    paths.liveDir,
    paths.candidateDir,
    paths.parserStage,
    path.join(paths.restoreSnapshot, 'database'),
    path.join(paths.restoreSnapshot, 'ppt-cache'),
    path.join(paths.restoreSnapshot, 'parser-appliance')
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  writeBytes(paths.databasePath, 100);
  writeBytes(path.join(paths.pptCacheRoot, 'one.pptx'), 20);
  writeBytes(path.join(paths.pptCacheRoot, 'nested', 'two.pptx'), 30);
  writeBytes(path.join(paths.parserStateRoot, 'runtime-root', 'runtime.bin'), 70);
  writeBytes(path.join(paths.parserStage, 'runtime.bin'), 120);
  writeBytes(path.join(paths.liveDir, 'node_modules', 'root.bin'), 30);
  writeBytes(path.join(paths.liveDir, 'server', 'node_modules', 'server.bin'), 20);
  writeBytes(path.join(paths.candidateDir, 'node_modules', 'root.bin'), 80);
  writeBytes(path.join(paths.candidateDir, 'server', 'node_modules', 'server.bin'), 40);
  writeBytes(path.join(paths.restoreSnapshot, 'database', 'turingmarket.db'), 140);
  writeBytes(path.join(paths.restoreSnapshot, 'ppt-cache', 'one.pptx'), 25);
  writeBytes(path.join(paths.restoreSnapshot, 'ppt-cache', 'nested', 'two.pptx'), 35);
  writeBytes(path.join(paths.backupRoot, 'platform', 'app.js'), 10);
  writeBytes(path.join(paths.backupRoot, 'repository', 'CHANGELOG.md'), 15);
  fs.writeFileSync(path.join(paths.restoreSnapshot, 'parser-appliance', 'parser-runtime.measurement'), '220:5\n', 'ascii');
  fs.writeFileSync(path.join(paths.backupRoot, 'root-node-modules.measurement'), '80:3\n', 'ascii');
  fs.writeFileSync(path.join(paths.backupRoot, 'server-node-modules.measurement'), '120:4\n', 'ascii');

  return paths;
}

function targetFixture(stDev, availableBytes, availableInodes = 1_000_000) {
  return {
    st_dev: stDev,
    available_bytes: availableBytes,
    available_inodes: availableInodes
  };
}

function writeFixture(paths, targets) {
  assert.deepEqual(Object.keys(targets).sort(), [...TARGET_KEYS]);
  fs.writeFileSync(paths.fixturePath, `${JSON.stringify({
    contract: 'tm-cutover-capacity-fixture-v1',
    targets
  })}\n`, 'utf8');
}

function runPlanner(paths) {
  assert.ok(python3, 'Python 3 is required for the cutover capacity tests');
  return spawnSync(python3.command, [
    ...python3.prefix,
    plannerPath,
    '--backup-root', paths.backupRoot,
    '--parser-state-root', paths.parserStateRoot,
    '--database-path', paths.databasePath,
    '--ppt-cache-root', paths.pptCacheRoot,
    '--live-dir', paths.liveDir,
    '--candidate-dir', paths.candidateDir,
    '--parser-stage', paths.parserStage,
    '--fixture-json', paths.fixturePath
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * MIB
  });
}

function runRestorePlanner(paths) {
  assert.ok(python3, 'Python 3 is required for the restore capacity tests');
  return spawnSync(python3.command, [
    ...python3.prefix,
    plannerPath,
    '--mode', 'restore',
    '--backup-root', paths.backupRoot,
    '--parser-state-root', paths.parserStateRoot,
    '--database-path', paths.databasePath,
    '--ppt-cache-root', paths.pptCacheRoot,
    '--live-dir', paths.liveDir,
    '--restore-snapshot', paths.restoreSnapshot,
    '--fixture-json', paths.fixturePath
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * MIB
  });
}

function parseReport(result) {
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.ok(lines[0], `planner did not emit JSON: ${result.stderr}`);
  return { lines, report: JSON.parse(lines[0]) };
}

function expectedMeasurements(parserStageBytes = 120) {
  return {
    candidate_node_modules_bytes: 120,
    candidate_node_modules_inodes: 4,
    database_bytes: 100,
    database_inodes: 1,
    existing_parser_runtime_bytes: 70,
    existing_parser_runtime_inodes: 2,
    live_node_modules_bytes: 50,
    live_node_modules_inodes: 4,
    parser_stage_bytes: parserStageBytes,
    parser_stage_inodes: 2,
    ppt_cache_bytes: 50,
    ppt_cache_inodes: 4
  };
}

test('inode requirements are explicit and exact boundary availability succeeds', (t) => {
  const paths = createCapacityTree(t);
  const requiredInodes = 14;
  const exactAvailableInodes = requiredInodes + MINIMUM_INODE_MARGIN;
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(5, 2 * GIB, exactAvailableInodes)
  ])));

  const result = runPlanner(paths);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const { report } = parseReport(result);
  assert.deepEqual(report.measurements, expectedMeasurements());
  assert.deepEqual(report.devices[0].inode_components, {
    cutover_snapshot_inodes: 7,
    first_install_ppt_cache_inodes: 0,
    rollback_node_modules_inodes: 0,
    parser_install_inodes: 2,
    rollback_database_stage_inodes: 1,
    rollback_ppt_stage_inodes: 4
  });
  assert.equal(report.devices[0].available_inodes, exactAvailableInodes);
  assert.equal(report.devices[0].required_inodes, requiredInodes);
  assert.equal(report.devices[0].margin_inodes, MINIMUM_INODE_MARGIN);
  assert.equal(report.devices[0].required_with_margin_inodes, exactAvailableInodes);
  assert.equal(report.devices[0].byte_sufficient, true);
  assert.equal(report.devices[0].inode_sufficient, true);
  assert.equal(report.devices[0].sufficient, true);
  assert.equal(report.ok, true);
});

test('restore mode measures the immutable rollback snapshot before writer shutdown', (t) => {
  const paths = createCapacityTree(t);
  writeFixture(paths, {
    'backup-root': targetFixture(61, 2 * GIB),
    'database-path': targetFixture(62, 2 * GIB),
    'live-dir': targetFixture(63, 2 * GIB),
    'parser-state-root': targetFixture(64, 2 * GIB),
    'ppt-cache-root': targetFixture(65, 2 * GIB)
  });

  const result = runRestorePlanner(paths);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const { lines, report } = parseReport(result);
  assert.deepEqual(lines.slice(1), ['RESTORE_CAPACITY_OK']);
  assert.equal(report.mode, 'restore');
  assert.deepEqual(report.measurements, {
    restore_code_bytes: 25,
    restore_code_inodes: 4,
    restore_database_bytes: 140,
    restore_database_inodes: 1,
    restore_node_modules_bytes: 200,
    restore_node_modules_inodes: 7,
    restore_parser_runtime_bytes: 220,
    restore_parser_runtime_inodes: 5,
    restore_ppt_cache_bytes: 60,
    restore_ppt_cache_inodes: 4
  });
  assert.deepEqual(report.devices.map(({ st_dev: stDev, required_bytes: bytes, required_inodes: inodes }) => ({
    stDev, bytes, inodes
  })), [
    { stDev: 61, bytes: 0, inodes: 0 },
    { stDev: 62, bytes: 140, inodes: 1 },
    { stDev: 63, bytes: 225, inodes: 11 },
    { stDev: 64, bytes: 220, inodes: 5 },
    { stDev: 65, bytes: 60, inodes: 4 }
  ]);
});

test('one inode below the required safety boundary fails closed with JSON output', (t) => {
  const paths = createCapacityTree(t);
  const requiredWithMarginInodes = 14 + MINIMUM_INODE_MARGIN;
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(6, 2 * GIB, requiredWithMarginInodes - 1)
  ])));

  const result = runPlanner(paths);
  assert.notEqual(result.status, 0);
  const { lines, report } = parseReport(result);
  assert.equal(lines.length, 1);
  assert.equal(report.ok, false);
  assert.equal(report.devices.length, 1);
  assert.equal(report.devices[0].byte_sufficient, true);
  assert.equal(report.devices[0].inode_sufficient, false);
  assert.equal(report.devices[0].sufficient, false);
  assert.equal(report.devices[0].available_inodes, requiredWithMarginInodes - 1);
  assert.equal(report.devices[0].required_with_margin_inodes, requiredWithMarginInodes);
  assert.match(result.stderr, /insufficient cutover capacity/i);
  assert.doesNotMatch(result.stdout, /CUTOVER_CAPACITY_OK/);
});

test('same-device requirements aggregate once and retain the minimum target availability', (t) => {
  const paths = createCapacityTree(t);
  writeFixture(paths, {
    'backup-root': targetFixture(7, 4 * GIB),
    'database-path': targetFixture(7, 3 * GIB),
    'live-dir': targetFixture(7, 2 * GIB),
    'parser-state-root': targetFixture(7, 5 * GIB),
    'ppt-cache-root': targetFixture(7, 6 * GIB)
  });

  const first = runPlanner(paths);
  assert.equal(first.status, 0, first.stderr || first.stdout || first.error?.message);
  assert.equal(first.stderr, '');
  const { lines, report } = parseReport(first);
  assert.deepEqual(lines.slice(1), ['CUTOVER_CAPACITY_OK']);
  assert.equal(report.contract, 'tm-cutover-capacity-v1');
  assert.equal(report.ok, true);
  assert.deepEqual(report.measurements, expectedMeasurements());
  assert.deepEqual(report.devices, [{
    available_bytes: 2 * GIB,
    available_inodes: 1_000_000,
    byte_sufficient: true,
    components: {
      cutover_snapshot_bytes: 220,
      rollback_node_modules_bytes: 0,
      parser_install_bytes: 120,
      rollback_database_stage_bytes: 100,
      rollback_ppt_stage_bytes: 50
    },
    inode_components: {
      cutover_snapshot_inodes: 7,
      first_install_ppt_cache_inodes: 0,
      rollback_node_modules_inodes: 0,
      parser_install_inodes: 2,
      rollback_database_stage_inodes: 1,
      rollback_ppt_stage_inodes: 4
    },
    inode_sufficient: true,
    margin_bytes: MINIMUM_MARGIN,
    margin_inodes: MINIMUM_INODE_MARGIN,
    required_bytes: 490,
    required_inodes: 14,
    required_with_margin_bytes: MINIMUM_MARGIN + 490,
    required_with_margin_inodes: MINIMUM_INODE_MARGIN + 14,
    st_dev: 7,
    sufficient: true,
    targets: [...TARGET_KEYS]
  }]);

  const second = runPlanner(paths);
  assert.equal(second.status, 0, second.stderr || second.stdout || second.error?.message);
  assert.equal(second.stdout, first.stdout, 'identical inputs must produce byte-stable stdout');
});

test('rollback dependency reserve uses live minus candidate on the live-dir target device', (t) => {
  const paths = createCapacityTree(t);
  writeBytes(path.join(paths.liveDir, 'node_modules', 'extra.bin'), 200);
  writeFixture(paths, {
    'backup-root': targetFixture(11, 2 * GIB),
    'database-path': targetFixture(13, 2 * GIB),
    'live-dir': targetFixture(15, 2 * GIB),
    'parser-state-root': targetFixture(12, 2 * GIB),
    'ppt-cache-root': targetFixture(14, 2 * GIB)
  });

  const result = runPlanner(paths);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const { report } = parseReport(result);
  assert.deepEqual(report.measurements, {
    ...expectedMeasurements(),
    live_node_modules_bytes: 250,
    live_node_modules_inodes: 5
  });
  assert.deepEqual(
    report.devices.map(({ st_dev, required_bytes, required_inodes, targets }) => ({
      st_dev,
      required_bytes,
      required_inodes,
      targets
    })),
    [
      { st_dev: 11, required_bytes: 220, required_inodes: 7, targets: ['backup-root'] },
      { st_dev: 12, required_bytes: 120, required_inodes: 2, targets: ['parser-state-root'] },
      { st_dev: 13, required_bytes: 100, required_inodes: 1, targets: ['database-path'] },
      { st_dev: 14, required_bytes: 50, required_inodes: 4, targets: ['ppt-cache-root'] },
      { st_dev: 15, required_bytes: 130, required_inodes: 1, targets: ['live-dir'] }
    ]
  );
  const liveDevice = report.devices.find(({ st_dev: stDev }) => stDev === 15);
  assert.deepEqual(liveDevice.components, {
    rollback_node_modules_bytes: 130
  });
  assert.deepEqual(liveDevice.inode_components, {
    rollback_node_modules_inodes: 1
  });
  assert.ok(report.devices.every((device) => device.margin_bytes === MINIMUM_MARGIN));
});

test('ten-percent margin uses integer ceiling and exact boundary availability succeeds', (t) => {
  const paths = createCapacityTree(t);
  const parserStageBytes = 5 * GIB + 1;
  if (process.platform === 'win32') {
    const tempFilesystem = fs.statfsSync(os.tmpdir());
    const availableBytes = tempFilesystem.bavail * tempFilesystem.bsize;
    if (availableBytes < parserStageBytes) {
      t.skip(`requires ${parserStageBytes} bytes on the Windows temp filesystem; ${availableBytes} available`);
      return;
    }
  }
  writeSparseBytes(path.join(paths.parserStage, 'runtime.bin'), parserStageBytes);
  const requiredBytes = parserStageBytes + 370;
  const marginBytes = Math.ceil(requiredBytes / 10);
  const exactAvailable = requiredBytes + marginBytes;
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(21, exactAvailable)
  ])));

  const result = runPlanner(paths);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const { report } = parseReport(result);
  assert.equal(report.devices[0].required_bytes, requiredBytes);
  assert.equal(report.devices[0].margin_bytes, marginBytes);
  assert.ok(marginBytes > MINIMUM_MARGIN);
  assert.equal(report.devices[0].required_with_margin_bytes, exactAvailable);
  assert.equal(report.devices[0].available_bytes, exactAvailable);
  assert.equal(report.devices[0].sufficient, true);
});

test('one byte below the required safety boundary exits nonzero without the success marker', (t) => {
  const paths = createCapacityTree(t);
  const requiredWithMargin = MINIMUM_MARGIN + 490;
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(31, requiredWithMargin - 1)
  ])));

  const result = runPlanner(paths);
  assert.notEqual(result.status, 0);
  const { lines, report } = parseReport(result);
  assert.equal(lines.length, 1);
  assert.equal(report.ok, false);
  assert.equal(report.devices.length, 1);
  assert.equal(report.devices[0].sufficient, false);
  assert.equal(report.devices[0].available_bytes, requiredWithMargin - 1);
  assert.match(result.stderr, /insufficient cutover capacity/i);
  assert.doesNotMatch(result.stdout, /CUTOVER_CAPACITY_OK/);
});

test('a symbolic link anywhere in a measured tree is rejected without following it', (t) => {
  const paths = createCapacityTree(t);
  const linkPath = path.join(paths.pptCacheRoot, 'parser-stage-link');
  try {
    fs.symlinkSync(paths.parserStage, linkPath, 'junction');
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(41, 2 * GIB)
  ])));

  const result = runPlanner(paths);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /symbolic link/i);
});

test('an input with an unexpected top-level file type is rejected', (t) => {
  const paths = createCapacityTree(t);
  fs.rmSync(paths.databasePath);
  fs.mkdirSync(paths.databasePath);
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(51, 2 * GIB)
  ])));

  const result = runPlanner(paths);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /database-path.*regular file/i);
});

test('a missing parser state root is resolved against its existing parent for first install', (t) => {
  const paths = createCapacityTree(t);
  fs.rmSync(paths.parserStateRoot, { recursive: true, force: true });
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(61, 2 * GIB)
  ])));

  const result = runPlanner(paths);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const { report } = parseReport(result);
  assert.equal(report.measurements.existing_parser_runtime_bytes, 0);
  assert.equal(report.measurements.existing_parser_runtime_inodes, 0);
  assert.equal(report.devices[0].components.cutover_snapshot_bytes, 150);
  assert.equal(report.devices[0].inode_components.cutover_snapshot_inodes, 5);
  assert.equal(report.devices[0].components.parser_install_bytes, 120);
});

test('a missing PPT cache root is treated as an empty first-install target', (t) => {
  const paths = createCapacityTree(t);
  fs.rmSync(paths.pptCacheRoot, { recursive: true, force: true });
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(66, 2 * GIB)
  ])));

  const result = runPlanner(paths);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const { report } = parseReport(result);
  assert.equal(report.measurements.ppt_cache_bytes, 0);
  assert.equal(report.measurements.ppt_cache_inodes, 0);
  assert.equal(report.devices[0].components.cutover_snapshot_bytes, 170);
  assert.equal(report.devices[0].inode_components.cutover_snapshot_inodes, 3);
  assert.equal(report.devices[0].components.rollback_ppt_stage_bytes, 0);
  assert.equal(report.devices[0].inode_components.rollback_ppt_stage_inodes, 0);
  assert.equal(report.devices[0].inode_components.first_install_ppt_cache_inodes, 1);
});

test('node_modules links are measured without following their targets', (t) => {
  const paths = createCapacityTree(t);
  const external = path.join(paths.root, 'external-large-tree');
  writeSparseBytes(path.join(external, 'large.bin'), GIB);
  const link = path.join(paths.candidateDir, 'node_modules', '.bin', 'external');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(external, link, 'junction');
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  writeFixture(paths, Object.fromEntries(TARGET_KEYS.map((key) => [
    key,
    targetFixture(71, 2 * GIB)
  ])));

  const result = runPlanner(paths);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const { report } = parseReport(result);
  assert.ok(
    report.measurements.candidate_node_modules_bytes < MIB,
    'the external target bytes must not be followed into the node_modules measurement'
  );
  assert.equal(
    report.measurements.candidate_node_modules_inodes,
    6,
    'the link and its parent consume inodes, but the external target tree must not be counted'
  );
  assert.equal(report.devices[0].inode_components.rollback_node_modules_inodes, 0);
});
