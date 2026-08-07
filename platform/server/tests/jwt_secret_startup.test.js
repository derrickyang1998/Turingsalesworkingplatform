'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const serverPath = path.join(serverRoot, 'server.js');
const dbPath = path.join(serverRoot, 'db.js');
const {
  pythonChildEnvironment,
  serverListenArgs,
  validateNetworkRuntimeConfig
} = require('../config/runtime_config');

const VALID_SECRET = 'Q8mYp2Vx7Kc4Nz9Rj6Hs3Wt5Ua1Df0LgAbCdEfGhIjA';
const PRODUCT_DEVELOPMENT_SECRET = 'ProductDevelopment0123456789abcdefghijklmnQ';
const DELIMITED_DEFAULT_SECRET = 'A1b2-default-C3d4E5f6G7h8I9j0K1l2M3n4O5P67Q';
const OLD_DEFAULT_SECRET = 'turingmarket-platform-jwt-secret-2026';
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir',
  'TEMP', 'TMP', 'ComSpec', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE',
  'PROCESSOR_ARCHITECTURE', 'SystemDrive'
]);

function isolatedChildEnvironment(overrides, sourceEnvironment = process.env) {
  const environment = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(sourceEnvironment, key)) {
      environment[key] = sourceEnvironment[key];
    }
  }
  return Object.assign(environment, overrides);
}

function assertSecretNotDisclosed(value, secret, label) {
  const output = value === undefined || value === null ? '' : String(value);
  const probes = typeof secret === 'string'
    ? [...new Set([secret, secret.trim()].filter((probe) => probe.length >= 8))]
    : [];
  for (const probe of probes) {
    assert.equal(
      output.includes(probe),
      false,
      `${label} must not disclose JWT_SECRET${probe === secret ? '' : ' after trimming'}`
    );
  }
}

function assertRejected(environment) {
  assert.throws(
    () => validateNetworkRuntimeConfig(environment),
    (error) => {
      assert.equal(error && error.code, 'INVALID_RUNTIME_CONFIGURATION');
      assert.match(error.message, /Invalid runtime configuration/);
      assertSecretNotDisclosed(error.message, environment.JWT_SECRET, 'validation error message');
      return true;
    }
  );
}

const rejectedConfigurations = [
  ['missing NODE_ENV', { JWT_SECRET: VALID_SECRET }],
  ['unknown NODE_ENV', { NODE_ENV: 'staging', JWT_SECRET: VALID_SECRET }],
  ['mis-cased NODE_ENV', { NODE_ENV: 'Production', JWT_SECRET: VALID_SECRET }],
  ['missing JWT_SECRET', { NODE_ENV: 'development' }],
  ['empty JWT_SECRET', { NODE_ENV: 'test', JWT_SECRET: '' }],
  ['whitespace-only JWT_SECRET', { NODE_ENV: 'production', JWT_SECRET: '   \t' }],
  ['JWT_SECRET with surrounding whitespace', {
    NODE_ENV: 'development',
    JWT_SECRET: ` ${VALID_SECRET} `
  }],
  ['one-character JWT_SECRET', { NODE_ENV: 'test', JWT_SECRET: 'x' }],
  ['31-byte JWT_SECRET', { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(31) }],
  ['placeholder JWT_SECRET', {
    NODE_ENV: 'development',
    JWT_SECRET: 'replace_with_at_least_32_random_bytes'
  }],
  ['old embedded default JWT_SECRET', {
    NODE_ENV: 'test',
    JWT_SECRET: OLD_DEFAULT_SECRET
  }]
];

const invalidCanonicalSecrets = [
  ['raw repeated 32-character ASCII material', 'x'.repeat(32)],
  ['raw repeated 33-byte multibyte UTF-8 material', '\u754c'.repeat(11)],
  ['padded base64url encoding', `${VALID_SECRET}=`],
  ['canonical base64url encoding of 31 decoded bytes', 'A'.repeat(42)],
  ['canonical base64url encoding of 33 decoded bytes', 'A'.repeat(44)],
  ['base64url value containing an invalid alphabet character', `${VALID_SECRET.slice(0, -1)}+`],
  ['non-canonical base64url trailing bits', `${VALID_SECRET.slice(0, -1)}B`],
  ['an ASCII-spaced placeholder phrase', 'replace with at least 32 random bytes'],
  ['an NFKC-equivalent full-width placeholder token', `ｃｈａｎｇｅｍｅ-${'x'.repeat(32)}`]
];

const lowDiversityCanonicalSecrets = [
  ['one distinct decoded byte', 'eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg'],
  ['four distinct decoded bytes', 'QUJDREFCQ0RBQkNEQUJDREFCQ0RBQkNEQUJDREFCQ0Q']
];

const predictableCanonicalSecrets = [
  [
    'a repeated 16-byte printable period',
    Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url')
  ],
  [
    'a monotonic 32-byte sequence',
    Buffer.from(Array.from({ length: 32 }, (_value, index) => index)).toString('base64url')
  ]
];

const acceptedCanonicalSecrets = [
  ['a ProductDevelopment substring', PRODUCT_DEVELOPMENT_SECRET],
  ['an embedded delimiter token such as default', DELIMITED_DEFAULT_SECRET]
];

for (const [name, environment] of rejectedConfigurations) {
  test(`network startup rejects ${name}`, () => {
    assertRejected(environment);
  });
}

for (const [invalidForm, jwtSecret] of invalidCanonicalSecrets) {
  test(`canonical JWT contract rejects ${invalidForm}`, () => {
    assertRejected({ NODE_ENV: 'production', JWT_SECRET: jwtSecret });
  });
}

for (const [diversity, jwtSecret] of lowDiversityCanonicalSecrets) {
  test(`decoded JWT diversity guard rejects canonical 32-byte material with ${diversity}`, () => {
    const decodedSecret = Buffer.from(jwtSecret, 'base64url');
    assert.equal(decodedSecret.length, 32, 'fixture must decode to exactly 32 bytes');
    assert.equal(decodedSecret.toString('base64url'), jwtSecret, 'fixture must be canonical');
    assertRejected({ NODE_ENV: 'production', JWT_SECRET: jwtSecret });
  });
}

for (const [pattern, jwtSecret] of predictableCanonicalSecrets) {
  test(`decoded JWT weak-pattern guard rejects canonical 32-byte material with ${pattern}`, () => {
    const decodedSecret = Buffer.from(jwtSecret, 'base64url');
    assert.equal(decodedSecret.length, 32, 'fixture must decode to exactly 32 bytes');
    assert.equal(decodedSecret.toString('base64url'), jwtSecret, 'fixture must be canonical');
    assertRejected({ NODE_ENV: 'production', JWT_SECRET: jwtSecret });
  });
}

test('network listener accepts only the exact IPv4 loopback host', () => {
  for (const environment of [
    {},
    { SERVER_HOST: '' },
    { SERVER_HOST: '0.0.0.0' },
    { SERVER_HOST: '::1' },
    { SERVER_HOST: '127.0.0.1 ' }
  ]) {
    assert.throws(
      () => serverListenArgs(3002, environment),
      (error) => error && error.code === 'INVALID_RUNTIME_CONFIGURATION'
    );
  }
  assert.deepEqual(
    serverListenArgs(3002, { SERVER_HOST: '127.0.0.1' }),
    [3002, '127.0.0.1']
  );
});

test('JWT startup child environment excludes inherited preload and application configuration', () => {
  const environment = isolatedChildEnvironment({}, {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    NODE_OPTIONS: '--require inherited-hook.js',
    JWT_SECRET: 'inherited-secret',
    TM_ENV_FILE: 'C:\\untrusted.env',
    DB_PATH: 'C:\\production.db',
    DEEPSEEK_API_KEY: 'inherited-deepseek-key',
    TAVILY_API_KEY: 'inherited-tavily-key'
  });

  assert.deepEqual(environment, {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp'
  });
});

test('PPT Python child environment excludes inherited application secrets and preload controls', () => {
  assert.equal(typeof pythonChildEnvironment, 'function');
  const environment = pythonChildEnvironment({
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    LANG: 'en_US.UTF-8',
    NODE_OPTIONS: '--require inherited-hook.js',
    JWT_SECRET: 'inherited-jwt-secret',
    TM_ENV_FILE: 'C:\\untrusted.env',
    DB_PATH: 'C:\\production.db',
    DEEPSEEK_API_KEY: 'inherited-deepseek-key',
    TAVILY_API_KEY: 'inherited-tavily-key',
    PYTHONPATH: 'C:\\untrusted-python-modules',
    PYTHONSTARTUP: 'C:\\untrusted-startup.py'
  });

  assert.deepEqual(environment, {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    LANG: 'en_US.UTF-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1'
  });

  const serverSource = fs.readFileSync(serverPath, 'utf8');
  const pythonInvocations = serverSource.match(/(?:childProcess|cp)\.execFileSync\([\s\S]*?\);/g) || [];
  assert.equal(pythonInvocations.length, 2, 'both PPT generator paths must remain covered');
  for (const invocation of pythonInvocations) {
    assert.match(invocation, /env:\s*runtimeConfig\.pythonChildEnvironment\(\)/);
  }
});

for (const nodeEnv of ['development', 'test', 'production']) {
  test(`network startup accepts an externally injected canonical 32-byte secret in ${nodeEnv}`, () => {
    assert.deepEqual(
      validateNetworkRuntimeConfig({ NODE_ENV: nodeEnv, JWT_SECRET: VALID_SECRET }),
      { nodeEnv, jwtSecret: VALID_SECRET }
    );
  });
}

for (const [description, jwtSecret] of acceptedCanonicalSecrets) {
  test(`canonical JWT contract accepts ${description} without lexical over-rejection`, () => {
    const decodedSecret = Buffer.from(jwtSecret, 'base64url');
    assert.equal(jwtSecret.length, 43, 'fixture must use the exact unpadded encoded length');
    assert.equal(decodedSecret.length, 32, 'fixture must decode to exactly 32 bytes');
    assert.equal(decodedSecret.toString('base64url'), jwtSecret, 'fixture must be canonical');
    assert.ok(new Set(decodedSecret).size >= 16, 'fixture must have diverse decoded bytes');
    assert.deepEqual(
      validateNetworkRuntimeConfig({ NODE_ENV: 'production', JWT_SECRET: jwtSecret }),
      { nodeEnv: 'production', jwtSecret }
    );
  });
}

test('invalid JWT startup fails before db import or listen without disclosing the secret', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-jwt-startup-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const dbRequireMarker = path.join(tempRoot, 'db-required');
  const listenMarker = path.join(tempRoot, 'listen-called');
  const leakProbeSecret = ` ${'startup-leak-probe-'.repeat(2)} `;
  const harness = `
    const fs = require('node:fs');
    const Module = require('node:module');
    const net = require('node:net');
    const targetDbPath = ${JSON.stringify(dbPath)};
    const originalLoad = Module._load;
    const originalListen = net.Server.prototype.listen;

    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (resolved === targetDbPath) {
        fs.writeFileSync(process.env.TM_DB_REQUIRE_MARKER, 'reached');
      }
      return originalLoad.apply(this, arguments);
    };

    net.Server.prototype.listen = function() {
      fs.writeFileSync(process.env.TM_LISTEN_MARKER, 'reached');
      return originalListen.apply(this, arguments);
    };

    require(${JSON.stringify(serverPath)});
  `;
  const environment = isolatedChildEnvironment({
    NODE_ENV: 'production',
    JWT_SECRET: leakProbeSecret,
    TM_ENV_FILE: path.join(tempRoot, 'does-not-exist.env'),
    DB_PATH: path.join(tempRoot, 'startup.db'),
    TM_DB_REQUIRE_MARKER: dbRequireMarker,
    TM_LISTEN_MARKER: listenMarker
  });

  const result = spawnSync(process.execPath, ['-e', harness], {
    cwd: serverRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000
  });
  const spawnErrorMessage = result.error && result.error.message;
  const output = [result.stdout, result.stderr, spawnErrorMessage]
    .filter(Boolean)
    .join('\n');

  assert.notEqual(result.status, 0, output);
  assert.match(output, /Invalid runtime configuration/);
  assertSecretNotDisclosed(result.stdout, leakProbeSecret, 'startup stdout');
  assertSecretNotDisclosed(result.stderr, leakProbeSecret, 'startup stderr');
  assertSecretNotDisclosed(spawnErrorMessage, leakProbeSecret, 'startup spawn error');
  assert.equal(fs.existsSync(dbRequireMarker), false, 'db.js must not be required');
  assert.equal(fs.existsSync(listenMarker), false, 'server must not listen');
});

test('invalid SERVER_HOST fails before db import or listen', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-host-startup-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const dbRequireMarker = path.join(tempRoot, 'db-required');
  const listenMarker = path.join(tempRoot, 'listen-called');
  const harness = `
    const fs = require('node:fs');
    const Module = require('node:module');
    const net = require('node:net');
    const targetDbPath = ${JSON.stringify(dbPath)};
    const originalLoad = Module._load;
    const originalListen = net.Server.prototype.listen;

    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (resolved === targetDbPath) {
        fs.writeFileSync(process.env.TM_DB_REQUIRE_MARKER, 'reached');
        throw new Error('db import reached before host validation');
      }
      return originalLoad.apply(this, arguments);
    };

    net.Server.prototype.listen = function() {
      fs.writeFileSync(process.env.TM_LISTEN_MARKER, 'reached');
      return originalListen.apply(this, arguments);
    };

    require(${JSON.stringify(serverPath)});
  `;
  const environment = isolatedChildEnvironment({
    NODE_ENV: 'production',
    JWT_SECRET: VALID_SECRET,
    SERVER_HOST: '0.0.0.0',
    TM_DISABLE_DOTENV: '1',
    DB_PATH: path.join(tempRoot, 'startup.db'),
    TM_DB_REQUIRE_MARKER: dbRequireMarker,
    TM_LISTEN_MARKER: listenMarker
  });

  const result = spawnSync(process.execPath, ['-e', harness], {
    cwd: serverRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000
  });
  const output = [result.stdout, result.stderr, result.error && result.error.message]
    .filter(Boolean)
    .join('\n');

  assert.notEqual(result.status, 0, output);
  assert.match(output, /Invalid runtime configuration.*SERVER_HOST/i);
  assert.equal(fs.existsSync(dbRequireMarker), false, 'db.js must not be required');
  assert.equal(fs.existsSync(listenMarker), false, 'server must not listen');
});

test('valid .env loads before validation and permits db import then listener startup', { timeout: 30_000 }, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-jwt-valid-env-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const envPath = path.join(tempRoot, '.env');
  const startupTrace = path.join(tempRoot, 'startup-trace');
  fs.writeFileSync(
    envPath,
    `NODE_ENV=test\nJWT_SECRET=${VALID_SECRET}\nSERVER_HOST=127.0.0.1\n`,
    'utf8'
  );

  const runtimeConfigPath = path.join(serverRoot, 'config', 'runtime_config.js');
  const harness = `
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const net = require('node:net');
    const targetServerPath = ${JSON.stringify(serverPath)};
    const targetDbPath = ${JSON.stringify(dbPath)};
    const targetRuntimeConfigPath = ${JSON.stringify(runtimeConfigPath)};
    const targetServerRoot = ${JSON.stringify(serverRoot)};
    const originalLoad = Module._load;
    let universalStub;
    universalStub = new Proxy(function() { return universalStub; }, {
      get(_target, property) {
        if (property === 'then' || property === Symbol.iterator) return undefined;
        return universalStub;
      },
      apply() { return universalStub; }
    });

    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (resolved === targetDbPath) {
        fs.appendFileSync(process.env.TM_STARTUP_TRACE, 'db\\n');
        return universalStub;
      }
      const isStubbedServerModule =
        resolved.startsWith(targetServerRoot + path.sep) &&
        !resolved.includes(path.sep + 'node_modules' + path.sep) &&
        resolved !== targetServerPath &&
        resolved !== targetRuntimeConfigPath;
      if (isStubbedServerModule) return universalStub;
      return originalLoad.apply(this, arguments);
    };

    net.Server.prototype.listen = function() {
      fs.appendFileSync(process.env.TM_STARTUP_TRACE, 'listen\\n');
      const callback = Array.from(arguments).findLast((value) => typeof value === 'function');
      if (callback) queueMicrotask(() => callback.call(this));
      return this;
    };

    require(targetServerPath);
  `;
  const environment = isolatedChildEnvironment({
    TM_ENV_FILE: envPath,
    TM_STARTUP_TRACE: startupTrace,
    PORT: '0'
  });

  const result = spawnSync(process.execPath, ['-e', harness], {
    cwd: serverRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000
  });
  const spawnErrorMessage = result.error && result.error.message;
  const output = [result.stdout, result.stderr, spawnErrorMessage]
    .filter(Boolean)
    .join('\n');

  assert.equal(result.status, 0, output);
  assert.deepEqual(
    fs.readFileSync(startupTrace, 'utf8').trim().split(/\r?\n/),
    ['db', 'listen']
  );
  assertSecretNotDisclosed(result.stdout, VALID_SECRET, 'startup stdout');
  assertSecretNotDisclosed(result.stderr, VALID_SECRET, 'startup stderr');
  assertSecretNotDisclosed(spawnErrorMessage, VALID_SECRET, 'startup spawn error');
});
