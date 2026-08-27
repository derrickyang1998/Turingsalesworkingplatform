'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  createProductionSystemdPropertyReader,
  productionSelfTestEnvironment,
  verifyInstalledControlArtifacts
} = require('../services/parser_startup_service');
const {
  normalizeSystemdEffectiveProperties,
  systemdInspectionUnitName
} = require('../services/upload_sandbox_service');

const ARTIFACT_PATH = 'systemd/turingmarket-parser@.service';
const INSTALLED_PATH = '/etc/systemd/system/turingmarket-parser@.service';
const CONTENT = Buffer.from('[Unit]\nDescription=Parser\n', 'utf8');
const SHA256 = crypto.createHash('sha256').update(CONTENT).digest('hex');

function fakeFileSystem(options = {}) {
  const calls = [];
  const stat = {
    isFile: () => true,
    nlink: 1,
    uid: 0,
    gid: 0,
    mode: 0o100644,
    size: CONTENT.length,
    ...options.stat
  };
  return {
    calls,
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    openSync(target, flags) {
      calls.push(['open', target, flags]);
      if (options.openError) throw options.openError;
      return 17;
    },
    fstatSync(descriptor) {
      calls.push(['stat', descriptor]);
      return stat;
    },
    readFileSync(descriptor) {
      calls.push(['read', descriptor]);
      return options.content || CONTENT;
    },
    closeSync(descriptor) {
      calls.push(['close', descriptor]);
    }
  };
}

function verifyWith(fileSystem, expectedSha256 = SHA256) {
  return verifyInstalledControlArtifacts({
    artifacts: { [ARTIFACT_PATH]: expectedSha256 }
  }, {
    fileSystem,
    artifacts: {
      [ARTIFACT_PATH]: { path: INSTALLED_PATH, mode: 0o644 }
    }
  });
}

test('production parser self-test environment is exact and isolated', () => {
  assert.deepEqual(productionSelfTestEnvironment(), {
    HOME: '/root',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: '/tmp',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    TM_UPLOAD_SANDBOX_MANIFEST_PATH:
      require('node:path').join(__dirname, '..', 'systemd', 'turingmarket-parser.manifest.json'),
    TM_UPLOAD_SANDBOX_SERVER_ROOT:
      '/var/lib/turingmarket-parser/runtime-root/opt/turingmarket-parser/app'
  });
});

test('systemd 259 deny-all address order is normalized before strict startup verification', async () => {
  const calls = [];
  const reader = createProductionSystemdPropertyReader({
    async runCommand(command, args, options) {
      calls.push({ command, args, options });
      return {
        stdout: [
          'IPAddressDeny=::/0 0.0.0.0/0',
          'PrivateNetwork=yes',
          ''
        ].join('\n')
      };
    },
    normalizeSystemdEffectiveProperties,
    systemdInspectionUnitName
  });
  const expected = {
    IPAddressDeny: 'any',
    PrivateNetwork: 'yes'
  };

  assert.deepEqual(
    await reader('turingmarket-parser@.service', expected),
    expected
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/systemctl');
  assert.deepEqual(calls[0].args, [
    'show',
    'turingmarket-parser@test_instance.service',
    '--no-pager',
    '--property=IPAddressDeny,PrivateNetwork'
  ]);
  assert.deepEqual(calls[0].options.env, productionSelfTestEnvironment());
});

test('production property reader still rejects an incomplete deny-all expansion', async () => {
  const reader = createProductionSystemdPropertyReader({
    async runCommand() {
      return { stdout: 'IPAddressDeny=::/0\nPrivateNetwork=yes\n' };
    },
    normalizeSystemdEffectiveProperties,
    systemdInspectionUnitName
  });

  await assert.rejects(
    reader('turingmarket-parser@.service', {
      IPAddressDeny: 'any',
      PrivateNetwork: 'yes'
    }),
    /effective property drift/
  );
});

test('installed parser control verification uses no-follow descriptors and exact hashes', () => {
  const fileSystem = fakeFileSystem();
  assert.equal(verifyWith(fileSystem), true);
  assert.deepEqual(fileSystem.calls, [
    ['open', INSTALLED_PATH, fileSystem.constants.O_NOFOLLOW],
    ['stat', 17],
    ['read', 17],
    ['close', 17]
  ]);
});

test('installed parser control verification rejects links, metadata drift, and digest drift', () => {
  const symlinkError = Object.assign(new Error('symlink'), { code: 'ELOOP' });
  const symlink = fakeFileSystem({ openError: symlinkError });
  assert.throws(() => verifyWith(symlink), (error) => error === symlinkError);
  assert.deepEqual(symlink.calls, [['open', INSTALLED_PATH, symlink.constants.O_NOFOLLOW]]);

  for (const stat of [
    { nlink: 2 },
    { uid: 1 },
    { gid: 1 },
    { mode: 0o100664 }
  ]) {
    const fileSystem = fakeFileSystem({ stat });
    assert.throws(() => verifyWith(fileSystem), /control artifact is unsafe/);
    assert.deepEqual(fileSystem.calls.at(-1), ['close', 17]);
  }

  const digestDrift = fakeFileSystem({ content: Buffer.from('drift', 'utf8') });
  assert.throws(() => verifyWith(digestDrift), /control artifact drift/);
  assert.deepEqual(digestDrift.calls.at(-1), ['close', 17]);
});
