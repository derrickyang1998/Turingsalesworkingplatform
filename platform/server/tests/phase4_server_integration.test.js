'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const Database = require('better-sqlite3');

const platformRoot = path.join(__dirname, '..', '..');
const serverEntry = path.join(platformRoot, 'server', 'server.js');
const parserManifestPath = path.join(
  platformRoot,
  'server',
  'systemd',
  'turingmarket-parser.manifest.json'
);
const TEST_JWT_SECRET = crypto
  .createHash('sha256')
  .update('phase4-server-integration-jwt-v1')
  .digest('base64url');
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
const RELEASE_PINNED_UPLOAD_MANIFEST_SHA256 =
  '75199daa1cee1b55f57257263177f3c5e287b6462b5a3bd2bc62c67a096395b2';

test('production parser manifest pin matches the exact checked-in manifest bytes', () => {
  const observed = crypto
    .createHash('sha256')
    .update(fs.readFileSync(parserManifestPath))
    .digest('hex');
  assert.equal(observed, RELEASE_PINNED_UPLOAD_MANIFEST_SHA256);
});
const REQUIRED_UPLOAD_SANDBOX_SELF_TESTS = Object.freeze([
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
const LEGACY_EIGHTEEN_UPLOAD_SANDBOX_SELF_TESTS = Object.freeze(
  REQUIRED_UPLOAD_SANDBOX_SELF_TESTS.filter((name) => ![
    'xlsx_parsing',
    'pptx_parsing',
    'ocr_inference'
  ].includes(name))
);
const LEGACY_FIFTEEN_UPLOAD_SANDBOX_SELF_TESTS = Object.freeze(
  REQUIRED_UPLOAD_SANDBOX_SELF_TESTS.filter((name) => (
    name !== 'aio_socket_bypass_denial' &&
    name !== 'pid_namespace_sibling_fd_denial' &&
    name !== 'result_inode_metadata_denial'
  ))
);
const LEGACY_THIRTEEN_UPLOAD_SANDBOX_SELF_TESTS = Object.freeze(
  LEGACY_FIFTEEN_UPLOAD_SANDBOX_SELF_TESTS.filter((name) => (
    name !== 'socket_creation_denial' &&
    name !== 'host_log_socket_denial'
  ))
);
const LEGACY_ELEVEN_UPLOAD_SANDBOX_SELF_TESTS = Object.freeze(
  LEGACY_THIRTEEN_UPLOAD_SANDBOX_SELF_TESTS.filter((name) => (
    name !== 'dev_submount_write_denial' &&
    name !== 'writable_filesystem_inventory'
  ))
);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixturePptx(label) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`phase4-server-ppt:${label}`, 'utf8')
  ]);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early (${child.exitCode}).\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_error) {
      // The test server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for test server.\n${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function jsonRequest(baseUrl, requestPath, options = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    options.headers || {}
  );
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(baseUrl + requestPath, {
    method: options.method || 'GET',
    headers,
    body: Object.hasOwn(options, 'body')
      ? JSON.stringify(options.body)
      : undefined
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
    text
  };
}

async function binaryRequest(baseUrl, requestPath, options = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    options.headers || {}
  );
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(baseUrl + requestPath, {
    method: options.method || 'GET',
    headers,
    body: Object.hasOwn(options, 'body')
      ? JSON.stringify(options.body)
      : undefined
  });
  return {
    response,
    bytes: Buffer.from(await response.arrayBuffer())
  };
}

async function multipartRequest(baseUrl, requestPath, options = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(options.fields || {})) {
    form.append(name, String(value));
  }
  form.append(
    'file',
    new Blob([options.file.bytes], { type: options.file.type }),
    options.file.name
  );
  const headers = Object.assign({}, options.headers || {});
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(baseUrl + requestPath, {
    method: 'POST',
    headers,
    body: form
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
    text
  };
}

function nodeOptionsWithPreload(preloadPath) {
  return `--require=${preloadPath}`;
}

test('Phase 4 server child environment excludes inherited configuration and allows only explicit preload overrides', () => {
  const sourceEnvironment = {
    PATH: '/test/bin',
    NODE_OPTIONS: '--require inherited-hook.js',
    DEEPSEEK_API_KEY: 'inherited-deepseek-key',
    TAVILY_API_KEY: 'inherited-tavily-key',
    TM_ENV_FILE: '/untrusted.env',
    DB_PATH: '/production.db'
  };
  assert.deepEqual(isolatedChildEnvironment({}, sourceEnvironment), { PATH: '/test/bin' });
  assert.deepEqual(
    isolatedChildEnvironment({ NODE_OPTIONS: '--require=/tmp/controlled-preload.js' }, sourceEnvironment),
    { PATH: '/test/bin', NODE_OPTIONS: '--require=/tmp/controlled-preload.js' }
  );
});

function writeGeneratorPreload(rootDir) {
  const preloadPath = path.join(rootDir, 'ppt-generator-preload.js');
  const counterPath = path.join(rootDir, 'ppt-generator-count.txt');
  const source = `'use strict';
const fs = require('node:fs');
const childProcess = require('node:child_process');
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function(file, args, options) {
  if (Array.isArray(args) && args[0] && /generate_ppt\\.py$/i.test(args[0])) {
    fs.appendFileSync(${JSON.stringify(counterPath)}, 'render\\n');
    const payload = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const renderCount = fs.readFileSync(${JSON.stringify(counterPath)}, 'utf8')
      .trim()
      .split(/\\r?\\n/)
      .length;
    const label = payload && payload.outline && payload.outline.title === 'Legacy nondeterministic replay'
      ? 'legacy-variant-' + renderCount
      : 'runtime';
    fs.writeFileSync(
      args[2],
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from('phase4-server-ppt:' + label, 'utf8')
      ])
    );
    return Buffer.alloc(0);
  }
  return originalExecFileSync.call(this, file, args, options);
};
`;
  fs.writeFileSync(preloadPath, source);
  return { preloadPath, counterPath };
}

function writeCompositionProbePreload(rootDir, options = {}) {
  const preloadPath = path.join(rootDir, 'server-composition-preload.js');
  const eventPath = path.join(rootDir, 'server-composition-events.ndjson');
  const source = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const eventPath = ${JSON.stringify(eventPath)};
const failJanitorStartup = ${options.failJanitorStartup === true};
const failUploadReadiness = ${options.failUploadReadiness === true};
const legacyEighteenSelfTests = ${options.legacyEighteenSelfTests === true};
const legacyFifteenSelfTests = ${options.legacyFifteenSelfTests === true};
const legacyElevenSelfTests = ${options.legacyElevenSelfTests === true};
const legacyThirteenSelfTests = ${options.legacyThirteenSelfTests === true};
const triggerShutdown = ${options.triggerShutdown === true};
const event = (name, details = {}) => {
  fs.appendFileSync(eventPath, JSON.stringify({ name, ...details }) + '\\n');
};
const originalLoad = Module._load;
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalProcessOnce = process.once.bind(process);
let collaborationInstance = null;
let janitorRuns = 0;
let janitorTimer = null;
const shutdownHandlers = new Map();

process.once = function(name, listener) {
  if (name === 'SIGTERM' || name === 'SIGINT') {
    shutdownHandlers.set(name, listener);
    event('shutdown_handler_registered', { signal: name });
  }
  return originalProcessOnce(name, listener);
};

global.setInterval = function(callback, delay, ...args) {
  const stack = new Error().stack || '';
  if (delay === 60 * 60 * 1000 && /server\\.js/.test(stack)) {
    event('janitor_interval_registered', { delay });
    callback(...args);
    janitorTimer = {
      unref() { event('janitor_interval_unref'); }
    };
    return janitorTimer;
  }
  return originalSetInterval(callback, delay, ...args);
};

global.clearInterval = function(timer) {
  if (timer === janitorTimer) {
    event('janitor_interval_cleared');
    return;
  }
  return originalClearInterval(timer);
};

Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  const parentFile = parent && parent.filename ? parent.filename : '';
  const parentName = path.basename(parentFile);

  if (request === './services/upload_sandbox_service' && parentName === 'server.js') {
    return {
      ...loaded,
      async assertUploadSandboxStartupReady(options) {
        event('upload_readiness_started', {
          expectedManifestSha256: options.expectedManifestSha256
        });
        if (failUploadReadiness) {
          throw new Error('probe upload readiness failure');
        }
        const selfTests = await options.runSelfTests();
        const projectedSelfTests = { ...selfTests };
        if (legacyEighteenSelfTests) {
          delete projectedSelfTests.xlsx_parsing;
          delete projectedSelfTests.pptx_parsing;
          delete projectedSelfTests.ocr_inference;
        }
        if (legacyFifteenSelfTests || legacyThirteenSelfTests || legacyElevenSelfTests) {
          delete projectedSelfTests.aio_socket_bypass_denial;
          delete projectedSelfTests.pid_namespace_sibling_fd_denial;
          delete projectedSelfTests.result_inode_metadata_denial;
        }
        if (legacyThirteenSelfTests || legacyElevenSelfTests) {
          delete projectedSelfTests.socket_creation_denial;
          delete projectedSelfTests.host_log_socket_denial;
        }
        if (legacyElevenSelfTests) {
          delete projectedSelfTests.dev_submount_write_denial;
          delete projectedSelfTests.writable_filesystem_inventory;
        }
        event('upload_self_tests_projected', {
          names: Object.keys(projectedSelfTests),
          allTrue: Object.values(projectedSelfTests).every((value) => value === true)
        });
        const systemdVersion = typeof options.systemdVersion === 'function'
          ? await options.systemdVersion()
          : null;
        event('upload_systemd_version_projected', { systemdVersion });
        const readinessOptions = {
          ...options,
          runSelfTests: async () => projectedSelfTests
        };
        if (systemdVersion !== null) {
          readinessOptions.systemdVersion = async () => systemdVersion;
        }
        const readiness = await loaded.assertUploadSandboxStartupReady(readinessOptions);
        event('upload_readiness_completed');
        return readiness;
      },
      createUploadSandboxService(options) {
        event('upload_sandbox_constructed');
        const service = loaded.createUploadSandboxService(options);
        return {
          ...service,
          createPipelineHooks(hookOptions) {
            event('upload_pipeline_hooks_created');
            return service.createPipelineHooks(hookOptions);
          },
          processUpload(input) {
            event('upload_process_started', {
              route: input && input.multipart && input.multipart.route
                ? input.multipart.route.id
                : null
            });
            return service.processUpload(input);
          }
        };
      }
    };
  }

  if (request === './services/campaign_workflow_service' && parentName === 'server.js') {
    return {
      ...loaded,
      startCampaignWorkflowDispatcher(...args) {
        event('workflow_dispatcher_started');
        return loaded.startCampaignWorkflowDispatcher(...args);
      }
    };
  }

  if (
    request === './services/campaign_collaboration_service' &&
    (parentName === 'server.js' || parentName === 'routes.js')
  ) {
    return {
      ...loaded,
      createCampaignCollaborationService(db) {
        event('collaboration_constructed', { parent: parentName });
        collaborationInstance = loaded.createCampaignCollaborationService(db);
        return collaborationInstance;
      }
    };
  }

  if (request === './routes' && parentName === 'server.js') {
    return function(...args) {
      const options = args[3] || {};
      event('collaboration_injected', {
        same: options.campaignCollaborationService === collaborationInstance
      });
      return loaded(...args);
    };
  }

  if (request === './services/campaign_ppt_service' && parentName === 'server.js') {
    return {
      ...loaded,
      createCampaignPptService(...args) {
        const service = loaded.createCampaignPptService(...args);
        return {
          generate: service.generate,
          runArtifactJanitor(input) {
            janitorRuns += 1;
            event('janitor_run', { run: janitorRuns });
            if (failJanitorStartup && janitorRuns === 1) {
              throw new Error('probe startup janitor failure');
            }
            return service.runArtifactJanitor(input);
          }
        };
      }
    };
  }

  if (request === 'express' && parentName === 'server.js') {
    const wrappedExpress = function(...args) {
      const app = loaded(...args);
      const originalPost = app.post.bind(app);
      const originalListen = app.listen.bind(app);
      app.post = function(routePath, ...handlers) {
        if (
          routePath === '/api/proposal/generate-ppt' ||
          routePath === '/api/campaigns/:id/proposals/:proposalId/ppt'
        ) {
          event('ppt_post_registered', { routePath });
        }
        return originalPost(routePath, ...handlers);
      };
      app.listen = function(...listenArgs) {
        event('server_listen_called');
        const server = originalListen(...listenArgs);
        if (triggerShutdown) {
          setImmediate(() => {
            const handler = shutdownHandlers.get('SIGTERM');
            event('shutdown_probe_triggered', { registered: Boolean(handler) });
            if (handler) handler();
            else process.exit(97);
          });
        }
        return server;
      };
      return app;
    };
    Object.assign(wrappedExpress, loaded);
    return wrappedExpress;
  }

  return loaded;
};
`;
  fs.writeFileSync(preloadPath, source);
  return { preloadPath, eventPath };
}

function writeUploadRevocationPreload(rootDir) {
  const preloadPath = path.join(rootDir, 'upload-revocation-preload.js');
  const source = `'use strict';
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  const parentName = path.basename(parent && parent.filename ? parent.filename : '');
  if (request !== './services/upload_sandbox_service' || parentName !== 'server.js') {
    return loaded;
  }
  return {
    ...loaded,
    createUploadSandboxService(options) {
      const service = loaded.createUploadSandboxService(options);
      return {
        ...service,
        async processUpload(input) {
          let authorizationChecks = 0;
          return service.processUpload({
            ...input,
            async assertAuthorized() {
              authorizationChecks += 1;
              if (authorizationChecks === 2) {
                options.db.prepare('DELETE FROM sessions').run();
              }
              return input.assertAuthorized();
            }
          });
        }
      };
    }
  };
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function readProbeEvents(eventPath) {
  if (!fs.existsSync(eventPath)) return [];
  return fs.readFileSync(eventPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function startTestServer(prefix, envOverrides = {}) {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tempDir, 'test.db');
  const outputChunks = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: isolatedChildEnvironment({
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
      UPLOAD_DIR: path.join(tempDir, 'uploads'),
      UPLOAD_SANDBOX_SPOOL_ROOT: path.join(tempDir, 'upload-sandbox'),
      TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
      TMP_DIR: path.join(tempDir, 'tmp'),
      PPT_CACHE_DIR: path.join(tempDir, 'ppt-cache'),
      JWT_SECRET: TEST_JWT_SECRET,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure',
      ...envOverrides
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, () => outputChunks.join(''));
  return {
    baseUrl,
    child,
    dbPath,
    tempDir,
    output: () => outputChunks.join(''),
    async close() {
      await stopChild(child);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

async function runTestServerToExit(prefix, envOverrides = {}, timeoutMs = 15000) {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outputChunks = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: isolatedChildEnvironment({
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'test.db'),
      UPLOAD_SANDBOX_SPOOL_ROOT: path.join(tempDir, 'upload-sandbox'),
      TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
      UPLOAD_DIR: path.join(tempDir, 'uploads'),
      TMP_DIR: path.join(tempDir, 'tmp'),
      PPT_CACHE_DIR: path.join(tempDir, 'ppt-cache'),
      JWT_SECRET: TEST_JWT_SECRET,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure',
      ...envOverrides
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));
  let timer;
  try {
    const exit = once(child, 'exit');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Test server did not exit.\n${outputChunks.join('')}`));
      }, timeoutMs);
    });
    const [code, signal] = await Promise.race([exit, timeout]);
    return { code, signal, output: outputChunks.join('') };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function seedPrivilegedAiReadFixture(server, label) {
  const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'AdminTest1!Secure' }
  });
  assert.equal(login.response.status, 200, login.text + '\n' + server.output());

  const created = await jsonRequest(server.baseUrl, '/api/admin/users', {
    method: 'POST',
    token: login.body.token,
    body: {
      username: `ai-read-owner-${label}`,
      password: 'AiReadOwner1!Safe',
      display_name: `AI Read Owner ${label}`,
      role: 'user',
      department: 'Sales',
      email: `ai-read-owner-${label}@example.invalid`
    }
  });
  assert.equal(created.response.status, 200, created.text);

  const fixtureDb = new Database(server.dbPath);
  let conversationId;
  try {
    const result = fixtureDb.prepare(`
      INSERT INTO ai_conversations (
        user_id,title,visibility,source_module,created_at,updated_at
      ) VALUES (?,?,'private','assistant',datetime('now'),datetime('now'))
    `).run(created.body.id, `AI read route ${label}`);
    conversationId = Number(result.lastInsertRowid);
    fixtureDb.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,model,prompt_tokens,
        completion_tokens,total_tokens,metadata_json
      ) VALUES (?,?,'assistant','route answer','fixture-model',0,0,0,'{}')
    `).run(conversationId, created.body.id);
  } finally {
    fixtureDb.close();
  }

  return {
    token: login.body.token,
    userId: Number(created.body.id),
    conversationId
  };
}

function rawExchange(port, bytes, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw HTTP exchange timed out'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('login and auth me preserve the user object and add current auth context', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-auth-context-');
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());
    assert.deepEqual(Object.keys(login.body).sort(), [
      'auth_context',
      'token',
      'user'
    ]);
    assert.deepEqual(Object.keys(login.body.auth_context.organization), [
      'id',
      'code',
      'name',
      'role_code'
    ]);
    assert.equal(login.body.auth_context.organization.code, 'turingmarket-default');
    assert.equal(login.body.auth_context.organization.role_code, 'org_admin');
    assert.equal(Array.isArray(login.body.auth_context.teams), true);
    assert.equal(login.body.auth_context.teams.length > 0, true);
    for (const team of login.body.auth_context.teams) {
      assert.deepEqual(Object.keys(team), [
        'id',
        'code',
        'name',
        'role_code'
      ]);
    }

    const me = await jsonRequest(server.baseUrl, '/api/auth/me', {
      token: login.body.token
    });
    assert.equal(me.response.status, 200);
    assert.deepEqual(me.body.user, login.body.user);
    assert.deepEqual(me.body.auth_context, login.body.auth_context);
  } finally {
    await server.close();
  }
});

test('production user writers synchronize identity state and protect the user directory', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-identity-writers-');
  try {
    const adminLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(
      adminLogin.response.status,
      200,
      adminLogin.text + '\n' + server.output()
    );

    const created = await jsonRequest(server.baseUrl, '/api/admin/users', {
      method: 'POST',
      token: adminLogin.body.token,
      body: {
        username: 'identity-user',
        password: 'IdentityUser1!Safe',
        display_name: 'Identity User',
        role: 'user',
        department: 'Sales',
        email: 'identity@example.invalid'
      }
    });
    assert.equal(created.response.status, 200, created.text);
    assert.deepEqual(Object.keys(created.body).sort(), ['id', 'message']);
    const createdUserId = Number(created.body.id);
    assert.equal(Number.isSafeInteger(createdUserId), true);

    let inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.deepEqual(
        inspection.prepare(`
          SELECT role_code,status
          FROM organization_memberships
          WHERE user_id=?
        `).get(createdUserId),
        { role_code: 'member', status: 'active' }
      );
      assert.deepEqual(
        inspection.prepare(`
          SELECT membership.role_code,membership.status,team.name
          FROM team_memberships membership
          JOIN teams team
            ON team.org_id=membership.org_id
           AND team.id=membership.team_id
          WHERE membership.user_id=? AND membership.status='active'
        `).all(createdUserId),
        [{ role_code: 'member', status: 'active', name: 'Sales' }]
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM activity_log
          WHERE action='identity_state_changed'
            AND module='identity'
            AND json_extract(details,'$.subject_user_id')=?
            AND json_extract(details,'$.reason')='user_create'
        `).get(createdUserId).count,
        1
      );
    } finally {
      inspection.close();
    }

    const memberLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'identity-user', password: 'IdentityUser1!Safe' }
    });
    assert.equal(memberLogin.response.status, 200, memberLogin.text);

    const promoted = await jsonRequest(
      server.baseUrl,
      `/api/admin/users/${createdUserId}`,
      {
        method: 'PUT',
        token: adminLogin.body.token,
        body: {
          role: 'admin',
          department: 'Leadership'
        }
      }
    );
    assert.equal(promoted.response.status, 200, promoted.text);
    assert.deepEqual(promoted.body, { success: true });

    const revokedAfterPromotion = await jsonRequest(
      server.baseUrl,
      '/api/auth/me',
      { token: memberLogin.body.token }
    );
    assert.equal(revokedAfterPromotion.response.status, 401);

    inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(
        inspection.prepare('SELECT role FROM users WHERE id=?')
          .get(createdUserId).role,
        'admin'
      );
      assert.deepEqual(
        inspection.prepare(`
          SELECT role_code,status
          FROM organization_memberships
          WHERE user_id=?
        `).get(createdUserId),
        { role_code: 'org_admin', status: 'active' }
      );
      assert.deepEqual(
        inspection.prepare(`
          SELECT membership.role_code,membership.status,team.name
          FROM team_memberships membership
          JOIN teams team
            ON team.org_id=membership.org_id
           AND team.id=membership.team_id
          WHERE membership.user_id=?
          ORDER BY membership.status,team.name
        `).all(createdUserId),
        [
          { role_code: 'team_lead', status: 'active', name: 'Leadership' },
          { role_code: 'team_lead', status: 'revoked', name: 'Sales' }
        ]
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM sessions
          WHERE user_id=?
        `).get(createdUserId).count,
        0
      );
    } finally {
      inspection.close();
    }

    const registered = await jsonRequest(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      token: adminLogin.body.token,
      body: {
        username: 'directory-member',
        password: 'DirectoryMember1!Safe',
        display_name: 'Directory Member',
        role: 'user',
        department: 'Sales',
        email: 'directory@example.invalid'
      }
    });
    assert.equal(registered.response.status, 200, registered.text);
    const registeredUserId = Number(registered.body.id);

    const directoryMemberLogin = await jsonRequest(
      server.baseUrl,
      '/api/auth/login',
      {
        method: 'POST',
        body: {
          username: 'directory-member',
          password: 'DirectoryMember1!Safe'
        }
      }
    );
    assert.equal(directoryMemberLogin.response.status, 200);

    const forbiddenDirectory = await jsonRequest(
      server.baseUrl,
      '/api/users',
      { token: directoryMemberLogin.body.token }
    );
    assert.equal(forbiddenDirectory.response.status, 403);
    assert.deepEqual(forbiddenDirectory.body, { error: 'Admin only' });

    const adminDirectory = await jsonRequest(server.baseUrl, '/api/users', {
      token: adminLogin.body.token
    });
    assert.equal(adminDirectory.response.status, 200);
    assert.equal(Array.isArray(adminDirectory.body.users), true);

    const promotedLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'identity-user', password: 'IdentityUser1!Safe' }
    });
    assert.equal(promotedLogin.response.status, 200);

    const deactivated = await jsonRequest(
      server.baseUrl,
      `/api/admin/users/${createdUserId}`,
      {
        method: 'DELETE',
        token: adminLogin.body.token
      }
    );
    assert.equal(deactivated.response.status, 200, deactivated.text);
    assert.deepEqual(deactivated.body, { success: true });

    const revokedAfterDeactivation = await jsonRequest(
      server.baseUrl,
      '/api/auth/me',
      { token: promotedLogin.body.token }
    );
    assert.equal(revokedAfterDeactivation.response.status, 401);

    inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(
        inspection.prepare('SELECT is_active FROM users WHERE id=?')
          .get(createdUserId).is_active,
        0
      );
      assert.deepEqual(
        inspection.prepare(`
          SELECT DISTINCT status
          FROM organization_memberships
          WHERE user_id=?
          UNION
          SELECT DISTINCT status
          FROM team_memberships
          WHERE user_id=?
        `).all(createdUserId, createdUserId),
        [{ status: 'revoked' }]
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM activity_log
          WHERE action='identity_state_changed'
            AND module='identity'
            AND json_extract(details,'$.subject_user_id')=?
        `).get(createdUserId).count,
        3
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM organization_memberships
          WHERE user_id=? AND status='active'
        `).get(registeredUserId).count,
        1
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM team_memberships
          WHERE user_id=? AND status='active'
        `).get(registeredUserId).count,
        1
      );
    } finally {
      inspection.close();
    }
  } finally {
    await server.close();
  }
});

test('production user writers preserve the SQLite ID high-water mark and reject noncanonical path IDs', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-user-id-boundary-');
  try {
    const adminLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(
      adminLogin.response.status,
      200,
      adminLogin.text + '\n' + server.output()
    );

    const setup = new Database(server.dbPath);
    try {
      const updated = setup.prepare(`
        UPDATE sqlite_sequence
        SET seq=500
        WHERE name='users'
      `).run();
      assert.equal(updated.changes, 1);
    } finally {
      setup.close();
    }

    const created = await jsonRequest(server.baseUrl, '/api/admin/users', {
      method: 'POST',
      token: adminLogin.body.token,
      body: {
        username: 'high-water-user',
        password: 'HighWaterUser1!Safe',
        display_name: 'High Water User',
        role: 'user',
        department: 'Sales',
        email: 'high-water@example.invalid'
      }
    });
    assert.equal(created.response.status, 200, created.text);
    assert.equal(created.body.id, 501);

    for (const rawId of ['0501', '+501', '501.0', '9007199254740992']) {
      const malformed = await jsonRequest(
        server.baseUrl,
        `/api/admin/users/${rawId}`,
        {
          method: 'PUT',
          token: adminLogin.body.token,
          body: { role: 'admin' }
        }
      );
      assert.equal(malformed.response.status, 400, rawId + ': ' + malformed.text);
      assert.deepEqual(malformed.body, { error: 'Invalid user id' });
    }

    const malformedDelete = await jsonRequest(
      server.baseUrl,
      '/api/admin/users/0501',
      {
        method: 'DELETE',
        token: adminLogin.body.token
      }
    );
    assert.equal(malformedDelete.response.status, 400, malformedDelete.text);
    assert.deepEqual(malformedDelete.body, { error: 'Invalid user id' });

    const malformedReset = await jsonRequest(
      server.baseUrl,
      '/api/admin/users/reset-password/0501',
      {
        method: 'POST',
        token: adminLogin.body.token,
        body: { password: 'WronglyCoerced1!Safe' }
      }
    );
    assert.equal(malformedReset.response.status, 400, malformedReset.text);
    assert.deepEqual(malformedReset.body, { error: 'Invalid user id' });

    const originalPasswordStillWorks = await jsonRequest(
      server.baseUrl,
      '/api/auth/login',
      {
        method: 'POST',
        body: {
          username: 'high-water-user',
          password: 'HighWaterUser1!Safe'
        }
      }
    );
    assert.equal(
      originalPasswordStillWorks.response.status,
      200,
      originalPasswordStillWorks.text
    );

    const inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.deepEqual(
        inspection.prepare(`
          SELECT id,role,is_active
          FROM users
          WHERE id=501
        `).get(),
        { id: 501, role: 'user', is_active: 1 }
      );
      assert.equal(
        inspection.prepare(`
          SELECT seq
          FROM sqlite_sequence
          WHERE name='users'
        `).get().seq,
        501
      );
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM activity_log
          WHERE action='identity_state_changed'
            AND module='identity'
            AND json_extract(details,'$.subject_user_id')=501
        `).get().count,
        1
      );
    } finally {
      inspection.close();
    }
  } finally {
    await server.close();
  }
});

test('owned campaign ingress authenticates before reading a slow JSON body', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-auth-first-');
  try {
    const port = Number(new URL(server.baseUrl).port);
    const startedAt = Date.now();
    const response = await rawExchange(port, [
      'POST /api/campaigns HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Content-Length: 65536',
      'X-Request-Id: auth-first-campaign-request',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    assert.equal(Date.now() - startedAt < 1000, true);
    assert.match(response, /^HTTP\/1\.1 401\b/);
    assert.match(response, /\r\nX-Request-Id: auth-first-campaign-request\r\n/i);
    assert.match(response, /\r\nConnection: close\r\n/i);
    assert.match(response, /"code":"AUTHENTICATION_REQUIRED"/);
    assert.match(response, /"request_id":"auth-first-campaign-request"/);
  } finally {
    await server.close();
  }
});

test('all shared upload policies authenticate before fixed or chunked multipart bodies', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-upload-auth-first-');
  try {
    const port = Number(new URL(server.baseUrl).port);
    const routes = [
      '/api/knowledge/upload',
      '/api/influencers/upload',
      '/api/demand/parse-file'
    ];
    for (const [index, requestPath] of routes.entries()) {
      const requestId = `upload-auth-first-${index + 1}`;
      const transferHeader = index % 2 === 0
        ? 'Content-Length: 65536'
        : 'Transfer-Encoding: chunked';
      const startedAt = Date.now();
      const response = await rawExchange(port, [
        `POST ${requestPath} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Content-Type: multipart/form-data; boundary=phase4-upload-boundary',
        transferHeader,
        `X-Request-Id: ${requestId}`,
        'Connection: close',
        '',
        ''
      ].join('\r\n'));
      assert.equal(Date.now() - startedAt < 1000, true, requestPath);
      assert.match(response, /^HTTP\/1\.1 401\b/, requestPath);
      assert.match(response, /\r\nConnection: close\r\n/i, requestPath);
      assert.match(response, new RegExp(`"request_id":"${requestId}"`), requestPath);
      assert.match(response, /"code":"AUTHENTICATION_REQUIRED"/, requestPath);
    }
  } finally {
    await server.close();
  }
});

test('noncanonical campaign paths stay inside authentication and request admission', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-noncanonical-paths-');
  try {
    const port = Number(new URL(server.baseUrl).port);
    const startedAt = Date.now();
    const response = await rawExchange(port, [
      'PATCH /API/CAMPAIGNS/foo/ HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Content-Length: 65536',
      'X-Request-Id: noncanonical-auth-first',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    assert.equal(Date.now() - startedAt < 1000, true);
    assert.match(response, /^HTTP\/1\.1 401\b/);
    assert.match(response, /\r\nX-Request-Id: noncanonical-auth-first\r\n/i);
    assert.match(response, /\r\nConnection: close\r\n/i);
    assert.match(response, /"code":"AUTHENTICATION_REQUIRED"/);
    assert.match(response, /"request_id":"noncanonical-auth-first"/);

    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    for (const requestPath of [
      '/api/campaigns/07',
      '/api/campaigns/foo',
      '/api/campaigns/+7'
    ]) {
      const malformed = await jsonRequest(server.baseUrl, requestPath, {
        token: login.body.token,
        headers: { 'X-Request-Id': 'malformed-campaign-path' }
      });
      assert.equal(malformed.response.status, 400, malformed.text);
      assert.equal(malformed.body.code, 'INVALID_CAMPAIGN_INPUT');
      assert.equal(malformed.body.request_id, 'malformed-campaign-path');
      assert.equal(
        malformed.response.headers.get('x-request-id'),
        'malformed-campaign-path'
      );
    }

    const trailing = await jsonRequest(server.baseUrl, '/api/campaigns/7/', {
      token: login.body.token,
      headers: { 'X-Request-Id': 'trailing-campaign-path' }
    });
    assert.equal(trailing.response.status, 404, trailing.text);
    assert.equal(trailing.body.code, 'CAMPAIGN_NOT_FOUND');
    assert.equal(trailing.body.request_id, 'trailing-campaign-path');
  } finally {
    await server.close();
  }
});

test('production registers all six shared workflow policies and classifies malformed, missing, and linked IDs before parsers', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-workflow-owner-');
  try {
    const missing = await jsonRequest(
      server.baseUrl,
      '/api/workflow/tasks/880099/approve',
      { method: 'POST', headers: { 'X-Request-Id': 'missing-workflow-task' } }
    );
    assert.equal(missing.response.status, 401, missing.text);
    assert.deepEqual(missing.body, { error: 'No token provided' });
    assert.equal(missing.response.headers.get('x-request-id'), null);

    const malformed = await jsonRequest(
      server.baseUrl,
      '/api/workflow/tasks/01/approve',
      { method: 'POST', headers: { 'X-Request-Id': 'malformed-workflow-task' } }
    );
    assert.equal(malformed.response.status, 401, malformed.text);
    assert.equal(malformed.body.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(malformed.body.request_id, 'malformed-workflow-task');
    assert.equal(
      malformed.response.headers.get('x-request-id'),
      'malformed-workflow-task'
    );

    const inspection = new Database(server.dbPath);
    let linkedTaskId;
    try {
      inspection.pragma('busy_timeout = 5000');
      const identity = inspection.prepare(`
        SELECT user.id AS user_id,membership.org_id,team.team_id
        FROM users user
        JOIN organization_memberships membership
          ON membership.user_id=user.id AND membership.status='active'
        JOIN team_memberships team
          ON team.user_id=user.id AND team.org_id=membership.org_id
         AND team.status='active'
        WHERE user.is_active=1
        ORDER BY CASE WHEN membership.role_code='org_admin' THEN 0 ELSE 1 END,user.id
        LIMIT 1
      `).get();
      assert.ok(identity);
      inspection.prepare(`
        INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to)
        VALUES (880001,'Classifier brand','Classifier company','qualified','test',?,?)
      `).run(identity.user_id, identity.user_id);
      inspection.prepare(`
        INSERT INTO opportunities (
          id,customer_id,name,stage,value,win_probability,product_name,
          channel_type,created_by
        ) VALUES (880002,880001,'Classifier opportunity','proposal',1,50,'Test','influencer',?)
      `).run(identity.user_id);
      inspection.prepare(`
        INSERT INTO campaigns (
          id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
          lifecycle_state,operational_status,row_version
        ) VALUES (880003,?,'Classifier campaign',880001,880002,?,?,'lead','active',1)
      `).run(identity.org_id, identity.user_id, identity.team_id);
      inspection.prepare(`
        INSERT INTO workflow_templates (
          id,name,description,module,category,nodes,edges,version,is_active,created_by
        ) VALUES (880004,'Classifier workflow','','customer','approval','[]','[]',1,1,?)
      `).run(identity.user_id);
      const instanceId = Number(inspection.prepare(`
        INSERT INTO workflow_instances (
          template_id,business_type,business_id,current_node_id,status,node_data,started_by
        ) VALUES (880004,'customer',880001,'legacy-node','active','{}',?)
      `).run(identity.user_id).lastInsertRowid);
      linkedTaskId = Number(inspection.prepare(`
        INSERT INTO workflow_tasks (
          instance_id,node_id,node_type,title,description,assignee_id,status
        ) VALUES (?,'legacy-node','task','Classifier task','',?,'pending')
      `).run(instanceId, identity.user_id).lastInsertRowid);
      const linkId = Number(inspection.prepare(
        'SELECT COALESCE(MAX(id),0)+1 AS id FROM campaign_record_links'
      ).get().id);
      inspection.prepare(`
        INSERT INTO campaign_record_links (
          id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
          created_by,metadata_json
        ) VALUES (?,?,880003,'workflow_instance',?,?,'workflow',?,'{}')
      `).run(
        linkId,
        identity.org_id,
        '8'.repeat(64),
        String(instanceId),
        identity.user_id
      );
    } finally {
      inspection.close();
    }

    const linked = await jsonRequest(
      server.baseUrl,
      `/api/workflow/tasks/${linkedTaskId}/approve`,
      { method: 'POST', headers: { 'X-Request-Id': 'linked-workflow-task' } }
    );
    assert.equal(linked.response.status, 401, linked.text);
    assert.equal(linked.body.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(linked.body.request_id, 'linked-workflow-task');
    assert.equal(linked.response.headers.get('x-request-id'), 'linked-workflow-task');

    for (const requestPath of [
      '/api/workflow/tasks/nope/approve',
      '/api/workflow/tasks/nope/reject',
      '/api/workflow/tasks/nope/complete',
      '/api/workflow/instances/nope/pause',
      '/api/workflow/instances/nope/resume',
      '/api/workflow/instances/nope/cancel'
    ]) {
      const response = await jsonRequest(server.baseUrl, requestPath, {
        method: 'POST',
        headers: { 'X-Request-Id': 'shared-workflow-policy' }
      });
      assert.equal(response.response.status, 401, `${requestPath}: ${response.text}`);
      assert.equal(response.body.code, 'AUTHENTICATION_REQUIRED');
      assert.equal(response.response.headers.get('x-request-id'), 'shared-workflow-policy');
    }
  } finally {
    await server.close();
  }
});

test('production server mounts the authenticated campaign route module', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-campaign-mount-');
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    const campaigns = await jsonRequest(
      server.baseUrl,
      '/api/campaigns?limit=1&offset=0',
      { token: login.body.token }
    );
    assert.equal(campaigns.response.status, 200, campaigns.text);
    assert.deepEqual(Object.keys(campaigns.body), [
      'items',
      'total',
      'limit',
      'offset'
    ]);
    assert.equal(campaigns.body.limit, 1);
    assert.equal(campaigns.body.offset, 0);
    assert.equal(Array.isArray(campaigns.body.items), true);
  } finally {
    await server.close();
  }
});

test('production registers reassignment policy and proves auth-first parser and campaign route ownership', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-reassignment-policy-');
  try {
    const port = Number(new URL(server.baseUrl).port);
    const startedAt = Date.now();
    const unauthenticated = await rawExchange(port, [
      'POST /api/campaigns/1/workflow-tasks/1/reassign HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Content-Length: 65536',
      'X-Request-Id: reassignment-auth-first',
      'Idempotency-Key: reassignment-auth-first-key',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    assert.equal(Date.now() - startedAt < 1000, true);
    assert.match(unauthenticated, /^HTTP\/1\.1 401\b/);
    assert.match(unauthenticated, /\r\nX-Request-Id: reassignment-auth-first\r\n/i);
    assert.match(unauthenticated, /"code":"AUTHENTICATION_REQUIRED"/);

    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    const malformedPath = await jsonRequest(
      server.baseUrl,
      '/api/campaigns/01/workflow-tasks/1/reassign',
      {
        method: 'POST',
        token: login.body.token,
        headers: {
          'X-Request-Id': 'reassignment-malformed-path',
          'Idempotency-Key': 'reassignment-malformed-path-key'
        },
        body: {}
      }
    );
    assert.equal(malformedPath.response.status, 400, malformedPath.text);
    assert.equal(malformedPath.body.code, 'INVALID_CAMPAIGN_INPUT');
    assert.equal(malformedPath.body.request_id, 'reassignment-malformed-path');

    const wrongMediaResponse = await fetch(
      `${server.baseUrl}/api/campaigns/1/workflow-tasks/1/reassign`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${login.body.token}`,
          'Content-Type': 'text/plain',
          'X-Request-Id': 'reassignment-wrong-media',
          'Idempotency-Key': 'reassignment-wrong-media-key'
        },
        body: '{}'
      }
    );
    const wrongMedia = await wrongMediaResponse.json();
    assert.equal(wrongMediaResponse.status, 415);
    assert.equal(wrongMedia.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(wrongMedia.request_id, 'reassignment-wrong-media');

    const malformedJsonResponse = await fetch(
      `${server.baseUrl}/api/campaigns/1/workflow-tasks/1/reassign`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${login.body.token}`,
          'Content-Type': 'application/json',
          'X-Request-Id': 'reassignment-malformed-json',
          'Idempotency-Key': 'reassignment-malformed-json-key'
        },
        body: '{'
      }
    );
    const malformedJson = await malformedJsonResponse.json();
    assert.equal(malformedJsonResponse.status, 400);
    assert.equal(malformedJson.code, 'INVALID_REQUEST_BODY');
    assert.equal(malformedJson.request_id, 'reassignment-malformed-json');

    const missing = await jsonRequest(
      server.baseUrl,
      '/api/campaigns/900719/workflow-tasks/900720/reassign',
      {
        method: 'POST',
        token: login.body.token,
        headers: {
          'X-Request-Id': 'reassignment-route-proof',
          'Idempotency-Key': 'reassignment-route-proof-key'
        },
        body: {
          expected_task_status: 'pending',
          expected_instance_status: 'active',
          expected_assignment_version: 1,
          assignee_id: login.body.user.id,
          assignee_role: null,
          reason: 'Route registration proof'
        }
      }
    );
    assert.equal(missing.response.status, 404, missing.text);
    assert.equal(missing.body.code, 'CAMPAIGN_NOT_FOUND');
    assert.equal(missing.body.request_id, 'reassignment-route-proof');
  } finally {
    await server.close();
  }
});

test('AI chat route forwards campaign context and Idempotency-Key into the linked RAG path', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-ai-chat-route-', {
    DEEPSEEK_API_KEY: '',
    TAVILY_API_KEY: ''
  });
  let fixtureDb;
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    fixtureDb = new Database(server.dbPath);
    const identity = fixtureDb.prepare(`
      SELECT organization.id AS org_id, team.id AS team_id
      FROM organizations organization
      JOIN teams team ON team.org_id=organization.id
      WHERE organization.code='turingmarket-default'
      ORDER BY team.id
      LIMIT 1
    `).get();
    assert.ok(identity, 'fixture organization and team must exist');

    const fixture = {
      customer_id: 940401,
      opportunity_id: 940402,
      campaign_id: 940403,
      user_id: login.body.user.id,
      org_id: identity.org_id,
      team_id: identity.team_id
    };
    fixtureDb.transaction(() => {
      fixtureDb.prepare(`
        INSERT OR IGNORE INTO organization_memberships (
          org_id,user_id,role_code,status
        ) VALUES (@org_id,@user_id,'org_admin','active')
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT OR IGNORE INTO team_memberships (
          org_id,team_id,user_id,role_code,status
        ) VALUES (@org_id,@team_id,@user_id,'team_lead','active')
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO customers (
          id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
        ) VALUES (
          @customer_id,'AI route contract','AI route contract Ltd',
          'qualified','phase4-ai-route',@user_id,@user_id,0
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO opportunities (
          id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
        ) VALUES (
          @opportunity_id,@customer_id,'AI route opportunity','proposal',1000,50,
          'AI route product','influencer',@user_id
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO campaigns (
          id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
          lifecycle_state,operational_status,row_version
        ) VALUES (
          @campaign_id,@org_id,'AI route campaign',@customer_id,@opportunity_id,
          @user_id,@team_id,'lead','active',1
        )
      `).run(fixture);
    })();
    fixtureDb.close();
    fixtureDb = null;

    const chat = await jsonRequest(server.baseUrl, '/api/ai/chat', {
      method: 'POST',
      token: login.body.token,
      headers: {
        'Idempotency-Key': 'ai-route-header-0001',
        'X-Request-Id': 'ai-route-contract-0001'
      },
      body: {
        message: 'Verify the linked RAG request boundary.',
        campaign_id: fixture.campaign_id,
        knowledge_entry_ids: []
      }
    });
    assert.equal(chat.response.status, 503, chat.text);
    assert.equal(chat.body.code, 'AI_PROVIDER_UNAVAILABLE');
    assert.equal(chat.body.request_id, 'ai-route-contract-0001');

    fixtureDb = new Database(server.dbPath, { readonly: true });
    assert.deepEqual(fixtureDb.prepare(`
      SELECT scope,campaign_id,state,status_code
      FROM request_idempotency
      WHERE scope='ai.conversation.create.linked'
        AND idempotency_key='ai-route-header-0001'
    `).all(), [{
      scope: 'ai.conversation.create.linked',
      campaign_id: fixture.campaign_id,
      state: 'completed',
      status_code: 503
    }]);
  } finally {
    if (fixtureDb) fixtureDb.close();
    await server.close();
  }
});

test('AI conversation routes persist one service-owned privileged audit with the HTTP request ID', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-ai-read-route-');
  try {
    const fixture = await seedPrivilegedAiReadFixture(server, 'audit');
    const invalid = await jsonRequest(
      server.baseUrl,
      '/api/ai/conversations?reference_type=javascript',
      { token: fixture.token, headers: { 'X-Request-Id': 'ai-read-invalid-filter-0001' } }
    );
    assert.equal(invalid.response.status, 400, invalid.text + '\n' + server.output());
    assert.deepEqual(invalid.body, {
      error: 'Invalid AI audit reference type.',
      code: 'INVALID_AI_AUDIT_FILTER',
      request_id: 'ai-read-invalid-filter-0001'
    });

    const listRequestId = 'ai-read-list-route-0001';
    const listed = await jsonRequest(server.baseUrl, '/api/ai/conversations', {
      token: fixture.token,
      headers: { 'X-Request-Id': listRequestId }
    });
    assert.equal(listed.response.status, 200, listed.text + '\n' + server.output());
    assert.equal(
      listed.body.conversations.some((row) => row.id === fixture.conversationId),
      true
    );

    const detailRequestId = 'ai-read-detail-route-0001';
    const detail = await jsonRequest(
      server.baseUrl,
      `/api/ai/conversations/${fixture.conversationId}`,
      {
        token: fixture.token,
        headers: { 'X-Request-Id': detailRequestId }
      }
    );
    assert.equal(detail.response.status, 200, detail.text);
    assert.equal(detail.body.conversation.id, fixture.conversationId);

    const inspection = new Database(server.dbPath, { readonly: true });
    try {
      const listAudits = inspection.prepare(`
        SELECT details
        FROM activity_log
        WHERE action='admin_list_ai_conversations' AND module='ai_audit'
      `).all();
      assert.equal(listAudits.length, 1);
      assert.equal(JSON.parse(listAudits[0].details).request_id, listRequestId);

      const detailAudits = inspection.prepare(`
        SELECT details
        FROM activity_log
        WHERE action='admin_view_ai_conversation' AND module='ai_audit'
      `).all();
      assert.equal(detailAudits.length, 1);
      assert.equal(JSON.parse(detailAudits[0].details).request_id, detailRequestId);
    } finally {
      inspection.close();
    }
  } finally {
    await server.close();
  }
});

test('AI manual-promotion route is idempotent and persists a bounded mutation audit', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-ai-manual-promotion-route-');
  try {
    const fixture = await seedPrivilegedAiReadFixture(server, 'manual-promotion');
    const inspection = new Database(server.dbPath, { readonly: true });
    let messageId;
    try {
      messageId = inspection.prepare(
        "SELECT id FROM ai_messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1"
      ).get(fixture.conversationId).id;
    } finally {
      inspection.close();
    }

    const requestPath = `/api/ai/conversations/${fixture.conversationId}/messages/${messageId}/promote`;
    const first = await jsonRequest(server.baseUrl, requestPath, {
      method: 'POST',
      token: fixture.token,
      headers: { 'X-Request-Id': 'ai-manual-promotion-route-0001' },
      body: { visibility: 'private' }
    });
    const replay = await jsonRequest(server.baseUrl, requestPath, {
      method: 'POST',
      token: fixture.token,
      headers: { 'X-Request-Id': 'ai-manual-promotion-route-0002' },
      body: { visibility: 'private' }
    });

    assert.equal(first.response.status, 200, first.text + '\n' + server.output());
    assert.equal(replay.response.status, 200, replay.text);
    assert.equal(first.body.status, 'promoted');
    assert.equal(replay.body.status, 'already_promoted');
    assert.equal(replay.body.knowledge_entry_id, first.body.knowledge_entry_id);

    const verified = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(verified.prepare(`
        SELECT COUNT(*) AS count FROM knowledge_entries
        WHERE entry_type='ai_chat_summary' AND source_type='ai_selected_message' AND source_id=?
      `).get(messageId).count, 1);
      const audits = verified.prepare(`
        SELECT details FROM activity_log
        WHERE action='manual_promote_ai_message' AND module='ai_knowledge'
        ORDER BY id
      `).all();
      assert.equal(audits.length, 2);
      assert.equal(JSON.parse(audits[0].details).request_id, 'ai-manual-promotion-route-0001');
      assert.equal(JSON.parse(audits[1].details).request_id, 'ai-manual-promotion-route-0002');
    } finally {
      verified.close();
    }
  } finally {
    await server.close();
  }
});

test('AI conversation routes fail closed with the bounded audit error envelope', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-ai-read-audit-failure-');
  try {
    const fixture = await seedPrivilegedAiReadFixture(server, 'failure');
    const setup = new Database(server.dbPath);
    try {
      setup.exec(`
        CREATE TRIGGER fail_ai_read_route_audit
        BEFORE INSERT ON activity_log
        WHEN NEW.module='ai_audit'
        BEGIN
          SELECT RAISE(ABORT,'forced AI read route audit failure');
        END
      `);
    } finally {
      setup.close();
    }

    for (const request of [
      {
        path: '/api/ai/conversations',
        requestId: 'ai-read-list-failure-0001'
      },
      {
        path: `/api/ai/conversations/${fixture.conversationId}`,
        requestId: 'ai-read-detail-failure-0001'
      }
    ]) {
      const result = await jsonRequest(server.baseUrl, request.path, {
        token: fixture.token,
        headers: { 'X-Request-Id': request.requestId }
      });
      assert.equal(result.response.status, 500, result.text);
      assert.deepEqual(result.body, {
        error: 'AI conversation read audit could not be persisted.',
        code: 'AUDIT_PERSISTENCE_FAILED',
        request_id: request.requestId
      });
    }
  } finally {
    await server.close();
  }
});

test('collaboration routes use the injected singleton and one request-id fallback for linked writes', () => {
  const registered = {};
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = function(routePath, ...handlers) {
      registered[`${method.toUpperCase()} ${routePath}`] = handlers;
    };
  }
  const calls = [];
  const campaignCollaborationService = {
    createLinked(input) {
      calls.push({ method: 'createLinked', input });
      return { status: 201, body: { id: 7001 } };
    },
    list() { return { collaborations: [] }; },
    stats() { return { stats: {} }; },
    updateLegacy() { throw new Error('legacy update was not expected'); },
    updateLinked(input) {
      calls.push({ method: 'updateLinked', input });
      return { status: 200, body: { success: true } };
    }
  };
  const authMiddleware = (_request, _response, next) => next();
  require('../routes')(
    app,
    {},
    authMiddleware,
    {
      campaignCollaborationService,
      feishuBitableOutboxService: Object.freeze({})
    }
  );

  assert.equal(Object.hasOwn(registered, 'POST /api/collaborations'), true);
  assert.equal(Object.hasOwn(registered, 'GET /api/collaborations'), true);
  assert.equal(Object.hasOwn(registered, 'PUT /api/collaborations/:id'), true);
  assert.equal(Object.hasOwn(registered, 'GET /api/collaborations/stats'), true);

  function responseRecorder() {
    return {
      statusCode: 200,
      body: null,
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(body) { this.body = body; return this; }
    };
  }

  const createResponse = responseRecorder();
  registered['POST /api/collaborations'].at(-1)({
    body: { campaign_id: 81, influencer_id: 82 },
    user: { id: 9 },
    phase4Request: { requestId: 'collaboration-create-phase4' },
    headers: { 'idempotency-key': 'collaboration-create-key' },
    get(name) { return name === 'Idempotency-Key' ? 'collaboration-create-key' : undefined; }
  }, createResponse);
  assert.equal(createResponse.statusCode, 201);
  assert.deepEqual(createResponse.body, { id: 7001 });

  const updateResponse = responseRecorder();
  registered['PUT /api/collaborations/:id'].at(-1)({
    body: { campaign_id: 81, expected_version: 1, reason: 'Route contract' },
    params: { id: '7001' },
    user: { id: 9 },
    requestId: 'collaboration-update-top-level',
    phase4Request: { requestId: 'collaboration-update-phase4' },
    headers: { 'idempotency-key': 'collaboration-update-key' },
    get(name) { return name === 'Idempotency-Key' ? 'collaboration-update-key' : undefined; }
  }, updateResponse);
  assert.equal(updateResponse.statusCode, 200);
  assert.deepEqual(updateResponse.body, { success: true });
  assert.deepEqual(calls.map(({ method, input }) => ({
    method,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey
  })), [
    {
      method: 'createLinked',
      requestId: 'collaboration-create-phase4',
      idempotencyKey: 'collaboration-create-key'
    },
    {
      method: 'updateLinked',
      requestId: 'collaboration-update-top-level',
      idempotencyKey: 'collaboration-update-key'
    }
  ]);
});

test('collaboration create and update policies reject unauthenticated JSON before route handlers', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-collaboration-policies-');
  try {
    for (const request of [
      { method: 'POST', path: '/api/collaborations', requestId: 'collaboration-create-auth-first' },
      { method: 'PUT', path: '/api/collaborations/1', requestId: 'collaboration-update-auth-first' }
    ]) {
      const result = await jsonRequest(server.baseUrl, request.path, {
        method: request.method,
        headers: { 'X-Request-Id': request.requestId },
        body: { campaign_id: 81 }
      });
      assert.equal(result.response.status, 401, result.text);
      assert.equal(result.body.code, 'AUTHENTICATION_REQUIRED');
      assert.equal(result.body.request_id, request.requestId);
    }
  } finally {
    await server.close();
  }
});

test('influencer upload commits its legacy envelope and parser admission in one transaction', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-influencer-sandbox-');
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());
    const csv = [
      'KOL Handle,Platform,Followers,Link,Project',
      '@sandbox_route_kol,TikTok,42000,https://example.com/sandbox-route,Sandbox Route'
    ].join('\n');
    const uploaded = await multipartRequest(
      server.baseUrl,
      '/api/influencers/upload',
      {
        token: login.body.token,
        headers: { 'X-Request-Id': 'influencer-sandbox-success' },
        fields: { batch_id: 'influencer-sandbox-batch' },
        file: {
          name: 'influencers.csv',
          type: 'text/csv',
          bytes: Buffer.from(csv, 'utf8')
        }
      }
    );
    assert.equal(uploaded.response.status, 200, uploaded.text + '\n' + server.output());
    assert.deepEqual(Object.keys(uploaded.body), [
      'imported',
      'skipped',
      'total',
      'batch',
      'skipped_rows',
      'sample',
      'knowledge_entry_id'
    ]);
    assert.equal(uploaded.body.imported, 1);
    assert.equal(uploaded.body.batch, 'influencer-sandbox-batch');

    const inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(inspection.prepare(`
        SELECT COUNT(*) AS count
        FROM influencers
        WHERE import_batch='influencer-sandbox-batch'
          AND kol_handle='@sandbox_route_kol'
      `).get().count, 1);
      assert.deepEqual(inspection.prepare(`
        SELECT state,status_code,response_kind
        FROM request_idempotency
        WHERE scope='parser.influencer-upload.admission'
      `).get(), {
        state: 'completed',
        status_code: 200,
        response_kind: 'admission'
      });
    } finally {
      inspection.close();
    }
    const spoolRoot = path.join(server.tempDir, 'upload-sandbox');
    assert.equal(fs.existsSync(spoolRoot), true);
    assert.deepEqual(fs.readdirSync(spoolRoot), []);
    const controllerEvents = server.output().split(/\r?\n/)
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === 'parser_job_completed');
    assert.deepEqual(controllerEvents, [{
      event: 'parser_job_completed',
      route: 'parser.influencer-upload',
      duration_ms: controllerEvents[0] && controllerEvents[0].duration_ms,
      result_category: 'success',
      systemd: {
        Result: 'unavailable',
        ExecMainStatus: null,
        OOMKilled: false
      }
    }]);
    assert.ok(Number.isSafeInteger(controllerEvents[0].duration_ms));
    assert.equal(server.output().includes('influencers.csv'), false);
    assert.equal(server.output().includes('@sandbox_route_kol'), false);
  } finally {
    await server.close();
  }
});

test('influencer import rolls back when parser admission completion conflicts', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-influencer-admission-rollback-');
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());
    const setup = new Database(server.dbPath);
    try {
      setup.exec(`
        CREATE TRIGGER fail_influencer_parser_completion
        BEFORE UPDATE OF state ON request_idempotency
        WHEN OLD.scope='parser.influencer-upload.admission'
          AND NEW.state='completed'
        BEGIN
          SELECT RAISE(ABORT,'forced parser admission completion conflict');
        END
      `);
    } finally {
      setup.close();
    }
    const csv = [
      'KOL Handle,Platform,Followers',
      '@rollback_route_kol,YouTube,31000'
    ].join('\n');
    const uploaded = await multipartRequest(
      server.baseUrl,
      '/api/influencers/upload',
      {
        token: login.body.token,
        headers: { 'X-Request-Id': 'influencer-admission-rollback' },
        fields: { batch_id: 'influencer-admission-rollback' },
        file: {
          name: 'rollback.csv',
          type: 'text/csv',
          bytes: Buffer.from(csv, 'utf8')
        }
      }
    );
    assert.equal(uploaded.response.status, 500, uploaded.text);
    const inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(inspection.prepare(`
        SELECT COUNT(*) AS count FROM influencers
        WHERE import_batch='influencer-admission-rollback'
      `).get().count, 0);
      assert.equal(inspection.prepare(`
        SELECT COUNT(*) AS count FROM knowledge_entries
        WHERE source_type='influencer_import'
          AND source_id='influencer-admission-rollback'
      `).get().count, 0);
      assert.equal(inspection.prepare(`
        SELECT state FROM request_idempotency
        WHERE scope='parser.influencer-upload.admission'
      `).get().state, 'failed');
    } finally {
      inspection.close();
    }
  } finally {
    await server.close();
  }
});

test('demand parsing completes admission and deduplicates the uploaded requirement sheet', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-demand-sandbox-');
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());
    const beforeDb = new Database(server.dbPath, { readonly: true });
    const beforeKnowledge = beforeDb.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count;
    beforeDb.close();

    const uploaded = await multipartRequest(
      server.baseUrl,
      '/api/demand/parse-file',
      {
        token: login.body.token,
        headers: { 'X-Request-Id': 'demand-sandbox-success' },
        file: {
          name: 'demand.txt',
          type: 'text/plain',
          bytes: Buffer.from('Brand: Northstar\nBudget: 50000\nMarket: US', 'utf8')
        }
      }
    );
    assert.equal(uploaded.response.status, 200, uploaded.text + '\n' + server.output());
    assert.deepEqual(Object.keys(uploaded.body), [
      'fileName',
      'extractedText',
      'analysisHint',
      'fallback',
      'parser',
      'needsOcr',
      'ocrUsed',
      'demand_entry'
    ]);
    assert.equal(uploaded.body.fileName, 'demand.txt');
    assert.match(uploaded.body.extractedText, /Northstar/);
    assert.ok(Number.isSafeInteger(uploaded.body.demand_entry.id));

    const replay = await multipartRequest(
      server.baseUrl,
      '/api/demand/parse-file',
      {
        token: login.body.token,
        headers: { 'X-Request-Id': 'demand-sandbox-replay' },
        file: {
          name: 'demand.txt',
          type: 'text/plain',
          bytes: Buffer.from('Brand: Northstar\nBudget: 50000\nMarket: US', 'utf8')
        }
      }
    );
    assert.equal(replay.response.status, 200, replay.text + '\n' + server.output());
    assert.equal(replay.body.demand_entry.id, uploaded.body.demand_entry.id);

    const inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(
        inspection.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count,
        beforeKnowledge + 1
      );
      const demandMetadata = JSON.parse(inspection.prepare(`
        SELECT metadata_json FROM knowledge_entries WHERE id=?
      `).get(uploaded.body.demand_entry.id).metadata_json);
      assert.equal(demandMetadata.artifact_contract, 'tm-business-artifact-v1');
      assert.equal(demandMetadata.artifact_state, 'ingested');
      assert.equal(demandMetadata.artifact_type, 'requirement_sheet');
      assert.match(demandMetadata.file_sha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(inspection.prepare(`
        SELECT state,status_code,response_kind
        FROM request_idempotency
        WHERE scope='parser.demand-parse.admission'
      `).get(), {
        state: 'completed',
        status_code: 200,
        response_kind: 'admission'
      });
    } finally {
      inspection.close();
    }
  } finally {
    await server.close();
  }
});

test('knowledge upload dispatches only present campaign IDs and replays the canonical multipart hash', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-knowledge-sandbox-');
  let fixtureDb;
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    const unlinked = await multipartRequest(
      server.baseUrl,
      '/api/knowledge/upload',
      {
        token: login.body.token,
        headers: { 'X-Request-Id': 'knowledge-unlinked-omission' },
        fields: {
          title: 'Unlinked omission upload',
          summary: '',
          entry_type: 'uploaded_document',
          source_type: 'knowledge_upload',
          source_id: 'unlinked-omission.txt',
          tags: '["upload"]'
        },
        file: {
          name: 'unlinked-omission.txt',
          type: 'text/plain',
          bytes: Buffer.from('unlinked omission content', 'utf8')
        }
      }
    );
    assert.equal(unlinked.response.status, 200, unlinked.text);
    assert.deepEqual(Object.keys(unlinked.body), ['entry', 'rows']);

    const presentButEmpty = await multipartRequest(
      server.baseUrl,
      '/api/knowledge/upload',
      {
        token: login.body.token,
        headers: { 'X-Request-Id': 'knowledge-present-empty-campaign' },
        fields: { campaign_id: '' },
        file: {
          name: 'empty-campaign.txt',
          type: 'text/plain',
          bytes: Buffer.from('must not enter omission branch', 'utf8')
        }
      }
    );
    assert.equal(presentButEmpty.response.status, 400, presentButEmpty.text);
    assert.equal(presentButEmpty.body.code, 'UPLOAD_INVALID_CONTENT');

    fixtureDb = new Database(server.dbPath);
    const identity = fixtureDb.prepare(`
      SELECT organization.id AS org_id,membership.team_id
      FROM organizations organization
      JOIN team_memberships membership ON membership.org_id=organization.id
      WHERE organization.code='turingmarket-default'
        AND membership.user_id=?
        AND membership.status='active'
      ORDER BY membership.team_id
      LIMIT 1
    `).get(login.body.user.id);
    assert.ok(identity, 'fixture user must have an active organization team');
    const fixture = {
      customer_id: 960101,
      opportunity_id: 960102,
      campaign_id: 960103,
      user_id: login.body.user.id,
      org_id: identity.org_id,
      team_id: identity.team_id
    };
    fixtureDb.transaction(() => {
      fixtureDb.prepare(`
        INSERT INTO customers (
          id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
        ) VALUES (
          @customer_id,'Knowledge upload','Knowledge upload Ltd',
          'qualified','phase4-knowledge-upload',@user_id,@user_id,0
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO opportunities (
          id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
        ) VALUES (
          @opportunity_id,@customer_id,'Knowledge upload opportunity','proposal',1000,50,
          'Knowledge upload product','influencer',@user_id
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO campaigns (
          id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
          lifecycle_state,operational_status,row_version
        ) VALUES (
          @campaign_id,@org_id,'Knowledge upload campaign',@customer_id,@opportunity_id,
          @user_id,@team_id,'proposal_confirmed','active',1
        )
      `).run(fixture);
    })();
    fixtureDb.close();
    fixtureDb = null;

    const linkedFields = {
      campaign_id: String(fixture.campaign_id),
      title: 'Linked multipart upload',
      summary: 'Linked multipart summary',
      entry_type: 'uploaded_document',
      source_type: 'knowledge_upload',
      source_id: 'linked-multipart.txt',
      visibility: 'private',
      tags: '["linked","upload"]'
    };
    const linkedHeaders = {
      'Idempotency-Key': 'knowledge-multipart-replay-0001',
      'X-Request-Id': 'knowledge-multipart-replay-0001'
    };
    const linkedFile = {
      name: 'linked-multipart.txt',
      type: 'text/plain',
      bytes: Buffer.from('canonical linked multipart content', 'utf8')
    };
    const first = await multipartRequest(server.baseUrl, '/api/knowledge/upload', {
      token: login.body.token,
      headers: linkedHeaders,
      fields: linkedFields,
      file: linkedFile
    });
    assert.equal(first.response.status, 200, first.text + '\n' + server.output());
    assert.deepEqual(Object.keys(first.body), ['entry', 'rows']);

    const replay = await multipartRequest(server.baseUrl, '/api/knowledge/upload', {
      token: login.body.token,
      headers: linkedHeaders,
      fields: linkedFields,
      file: linkedFile
    });
    assert.equal(replay.response.status, 200, replay.text);
    assert.deepEqual(replay.body, first.body);

    const conflict = await multipartRequest(server.baseUrl, '/api/knowledge/upload', {
      token: login.body.token,
      headers: linkedHeaders,
      fields: linkedFields,
      file: {
        ...linkedFile,
        bytes: Buffer.from('changed canonical linked multipart content', 'utf8')
      }
    });
    assert.equal(conflict.response.status, 409, conflict.text);

    fixtureDb = new Database(server.dbPath, { readonly: true });
    assert.equal(fixtureDb.prepare(`
      SELECT COUNT(*) AS count
      FROM request_idempotency
      WHERE scope='knowledge.upload.linked'
        AND idempotency_key='knowledge-multipart-replay-0001'
        AND state='completed'
    `).get().count, 1);
    assert.equal(fixtureDb.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type='knowledge_entry'
        AND relation_type='knowledge' AND revoked_at IS NULL
    `).get(fixture.campaign_id).count, 1);
    assert.equal(fixtureDb.prepare(`
      SELECT COUNT(*) AS count
      FROM request_idempotency
      WHERE scope='parser.knowledge-upload.admission' AND state='completed'
    `).get().count, 3);
  } finally {
    if (fixtureDb) fixtureDb.close();
    await server.close();
  }
});

test('upload final authorization re-reads the live session before business persistence', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-upload-revocation-'));
  const preloadPath = writeUploadRevocationPreload(probeRoot);
  const server = await startTestServer('tm-phase4-upload-revocation-server-', {
    NODE_OPTIONS: nodeOptionsWithPreload(preloadPath)
  });
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());
    const uploaded = await multipartRequest(
      server.baseUrl,
      '/api/influencers/upload',
      {
        token: login.body.token,
        headers: { 'X-Request-Id': 'upload-final-revocation' },
        fields: { batch_id: 'upload-final-revocation' },
        file: {
          name: 'revoked.csv',
          type: 'text/csv',
          bytes: Buffer.from('KOL Handle,Platform\n@revoked_route_kol,TikTok', 'utf8')
        }
      }
    );
    assert.equal(uploaded.response.status, 401, uploaded.text);
    const inspection = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(inspection.prepare(`
        SELECT COUNT(*) AS count FROM influencers
        WHERE import_batch='upload-final-revocation'
      `).get().count, 0);
      assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
      assert.equal(inspection.prepare(`
        SELECT state FROM request_idempotency
        WHERE scope='parser.influencer-upload.admission'
      `).get().state, 'failed');
    } finally {
      inspection.close();
    }
  } finally {
    await server.close();
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('legacy demand and confirmed proposal use the unified business artifact contract', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-legacy-artifact-route-');
  let inspection;
  try {
    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());
    const demand = await jsonRequest(server.baseUrl, '/api/demands', {
      method: 'POST',
      token: login.body.token,
      body: {
        brand_name: 'Legacy artifact brand',
        product_name: 'Legacy artifact product',
        industry: 'Consumer electronics',
        target_market: 'US',
        data_json: { requirement: 'confirmed' }
      }
    });
    assert.equal(demand.response.status, 200, demand.text);
    const proposal = await jsonRequest(server.baseUrl, '/api/proposals', {
      method: 'POST',
      token: login.body.token,
      body: {
        demand_id: demand.body.id,
        template_id: 'legacy-confirmed-template',
        content: '{"title":"Legacy confirmed proposal"}'
      }
    });
    assert.equal(proposal.response.status, 200, proposal.text);

    inspection = new Database(server.dbPath, { readonly: true });
    const artifacts = inspection.prepare(`
      SELECT source_type,source_id,metadata_json
      FROM knowledge_entries
      WHERE (source_type='demand_record' AND source_id=?)
         OR (source_type='proposal_record' AND source_id=?)
      ORDER BY source_type
    `).all(demand.body.id, proposal.body.id);
    assert.equal(artifacts.length, 2);
    const demandMetadata = JSON.parse(
      artifacts.find((row) => row.source_type === 'demand_record').metadata_json
    );
    const proposalMetadata = JSON.parse(
      artifacts.find((row) => row.source_type === 'proposal_record').metadata_json
    );
    assert.deepEqual({
      contract: demandMetadata.artifact_contract,
      state: demandMetadata.artifact_state,
      type: demandMetadata.artifact_type
    }, {
      contract: 'tm-business-artifact-v1',
      state: 'ingested',
      type: 'requirement_sheet'
    });
    assert.deepEqual({
      contract: proposalMetadata.artifact_contract,
      state: proposalMetadata.artifact_state,
      type: proposalMetadata.artifact_type
    }, {
      contract: 'tm-business-artifact-v1',
      state: 'confirmed',
      type: 'confirmed_proposal'
    });
  } finally {
    if (inspection) inspection.close();
    await server.close();
  }
});

test('one PPT endpoint preserves legacy omission and replays linked persisted proposal bytes', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-ppt-generator-'));
  const generator = writeGeneratorPreload(probeRoot);
  const server = await startTestServer('tm-phase4-campaign-ppt-route-', {
    NODE_OPTIONS: nodeOptionsWithPreload(generator.preloadPath),
    PYTHON_BIN: process.execPath
  });
  let fixtureDb;
  try {
    const pathName = '/api/proposal/generate-ppt';
    const unauthenticated = await jsonRequest(server.baseUrl, pathName, {
      method: 'POST',
      headers: { 'X-Request-Id': 'campaign-ppt-auth-first' },
      body: { campaign_id: 950403 }
    });
    assert.equal(unauthenticated.response.status, 401, unauthenticated.text);
    assert.equal(unauthenticated.body.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(unauthenticated.body.request_id, 'campaign-ppt-auth-first');

    const login = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.response.status, 200, login.text + '\n' + server.output());

    const alternate = await jsonRequest(
      server.baseUrl,
      '/api/campaigns/950403/proposals/950405/ppt',
      {
        method: 'POST',
        token: login.body.token,
        body: { campaign_id: 950403 }
      }
    );
    assert.equal(alternate.response.status, 404, alternate.text);

    const legacy = await binaryRequest(server.baseUrl, pathName, {
      method: 'POST',
      token: login.body.token,
      body: { outline: { title: 'Legacy omission route' } }
    });
    assert.equal(legacy.response.status, 200);
    assert.match(legacy.response.headers.get('content-disposition'), /filename="proposal\.pptx"/);
    assert.deepEqual(legacy.bytes, fixturePptx('runtime'));

    const nondeterministicBody = {
      outline: { title: 'Legacy nondeterministic replay' }
    };
    const nondeterministicFirst = await binaryRequest(server.baseUrl, pathName, {
      method: 'POST',
      token: login.body.token,
      body: nondeterministicBody
    });
    const nondeterministicSecond = await binaryRequest(server.baseUrl, pathName, {
      method: 'POST',
      token: login.body.token,
      body: nondeterministicBody
    });
    assert.equal(nondeterministicFirst.response.status, 200);
    assert.equal(nondeterministicSecond.response.status, 200);
    assert.deepEqual(nondeterministicFirst.bytes, fixturePptx('legacy-variant-2'));
    assert.deepEqual(nondeterministicSecond.bytes, fixturePptx('legacy-variant-3'));

    fixtureDb = new Database(server.dbPath);
    const legacyPptArchive = fixtureDb.prepare(`
      SELECT entry_type,source_type,metadata_json
      FROM knowledge_entries
      WHERE source_type='ppt_generation'
        AND title='PPT 成品：Legacy omission route'
      LIMIT 1
    `).get();
    assert.ok(legacyPptArchive);
    assert.equal(legacyPptArchive.entry_type, 'proposal_ppt_output');
    const legacyPptMetadata = JSON.parse(legacyPptArchive.metadata_json);
    assert.equal(legacyPptMetadata.artifact_contract, 'tm-business-artifact-v1');
    assert.equal(legacyPptMetadata.artifact_state, 'completed');
    assert.equal(legacyPptMetadata.artifact_type, 'ppt_output');
    assert.match(legacyPptMetadata.artifact_sha256, /^[0-9a-f]{64}$/);
    assert.equal(legacyPptMetadata.artifact_bytes, legacy.bytes.length);
    const nondeterministicArchives = fixtureDb.prepare(`
      SELECT source_id,metadata_json
      FROM knowledge_entries
      WHERE source_type='ppt_generation'
        AND title='PPT 成品：Legacy nondeterministic replay'
      ORDER BY id
    `).all();
    assert.equal(nondeterministicArchives.length, 2);
    assert.equal(new Set(nondeterministicArchives.map((row) => row.source_id)).size, 2);
    assert.equal(new Set(nondeterministicArchives.map((row) => (
      JSON.parse(row.metadata_json).artifact_sha256
    ))).size, 2);
    fixtureDb.exec(`
      CREATE TRIGGER reject_legacy_ppt_archive_for_cleanup_test
      BEFORE INSERT ON knowledge_entries
      WHEN NEW.source_type='ppt_generation'
      BEGIN SELECT RAISE(ABORT,'injected legacy PPT archive failure'); END
    `);
    const failedLegacy = await jsonRequest(server.baseUrl, pathName, {
      method: 'POST',
      token: login.body.token,
      body: { outline: { title: 'Legacy archive cleanup failure' } }
    });
    assert.equal(failedLegacy.response.status, 500, failedLegacy.text);
    assert.match(failedLegacy.body.error, /injected legacy PPT archive failure/);
    assert.deepEqual(
      fs.readdirSync(path.join(server.tempDir, 'tmp')).filter((name) => (
        /^ppt_data_.*\.json$/.test(name) || /^proposal_.*\.pptx$/.test(name)
      )),
      []
    );
    assert.equal(fixtureDb.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope='proposal.ppt.generate.linked'
    `).get().count, 0);
    const identity = fixtureDb.prepare(`
      SELECT organization.id AS org_id,team.id AS team_id
      FROM organizations organization
      JOIN teams team ON team.org_id=organization.id
      WHERE organization.code='turingmarket-default'
      ORDER BY team.id
      LIMIT 1
    `).get();
    assert.ok(identity, 'fixture organization and team must exist');
    const outline = { title: 'PPT route persisted outline' };
    const fixture = {
      customer_id: 950401,
      opportunity_id: 950402,
      campaign_id: 950403,
      demand_id: 950404,
      proposal_id: 950405,
      user_id: login.body.user.id,
      org_id: identity.org_id,
      team_id: identity.team_id,
      proposal_bundle_id: sha256('phase4-server-ppt-proposal-bundle'),
      proposal_content: JSON.stringify(outline)
    };
    fixtureDb.transaction(() => {
      fixtureDb.prepare(`
        INSERT OR IGNORE INTO organization_memberships (org_id,user_id,role_code,status)
        VALUES (@org_id,@user_id,'org_admin','active')
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT OR IGNORE INTO team_memberships (org_id,team_id,user_id,role_code,status)
        VALUES (@org_id,@team_id,@user_id,'team_lead','active')
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO customers (
          id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
        ) VALUES (
          @customer_id,'PPT route contract','PPT route contract Ltd',
          'qualified','phase4-ppt-route',@user_id,@user_id,0
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO opportunities (
          id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
        ) VALUES (
          @opportunity_id,@customer_id,'PPT route opportunity','proposal',1000,50,
          'PPT route product','influencer',@user_id
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO campaigns (
          id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
          lifecycle_state,operational_status,row_version
        ) VALUES (
          @campaign_id,@org_id,'PPT route campaign',@customer_id,@opportunity_id,
          @user_id,@team_id,'proposal_confirmed','active',1
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO demands (id,user_id,brand_name,data_json)
        VALUES (@demand_id,@user_id,'PPT route demand','{}')
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO proposals (id,user_id,demand_id,template_id,content)
        VALUES (@proposal_id,@user_id,@demand_id,'ppt-template',@proposal_content)
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO campaign_record_links (
          org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
        ) VALUES (
          @org_id,@campaign_id,'proposal',@proposal_bundle_id,@proposal_record_id,'proposal',@user_id,'{}'
        )
      `).run({ ...fixture, proposal_record_id: String(fixture.proposal_id) });
    })();
    fixtureDb.close();
    fixtureDb = null;

    const linkedBody = {
      campaign_id: fixture.campaign_id,
      proposal_id: fixture.proposal_id,
      proposal_content_sha256: sha256(JSON.stringify(outline)),
      outline
    };
    const linkedOptions = {
      method: 'POST',
      token: login.body.token,
      headers: {
        'Idempotency-Key': 'campaign-ppt-route-replay-0001',
        'X-Request-Id': 'campaign-ppt-route-replay-0001'
      },
      body: linkedBody
    };
    const first = await binaryRequest(server.baseUrl, pathName, linkedOptions);
    assert.equal(first.response.status, 200, first.bytes.toString('utf8'));
    assert.equal(
      first.response.headers.get('content-disposition'),
      `attachment; filename="proposal-${fixture.proposal_id}.pptx"; ` +
        `filename*=UTF-8''proposal-${fixture.proposal_id}.pptx`
    );
    assert.deepEqual(first.bytes, fixturePptx('runtime'));

    const replay = await binaryRequest(server.baseUrl, pathName, linkedOptions);
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.bytes, first.bytes);
    assert.equal(
      fs.readFileSync(generator.counterPath, 'utf8').trim().split(/\r?\n/).length,
      5,
      'legacy outputs, archive-failure cleanup, and first linked render each invoke the generator once'
    );

    fixtureDb = new Database(server.dbPath, { readonly: true });
    const ledger = fixtureDb.prepare(`
      SELECT id,campaign_id,state,status_code,response_kind,response_sha256,response_bytes
      FROM request_idempotency
      WHERE scope='proposal.ppt.generate.linked'
        AND idempotency_key='campaign-ppt-route-replay-0001'
    `).get();
    assert.deepEqual(ledger, {
      id: ledger.id,
      campaign_id: fixture.campaign_id,
      state: 'completed',
      status_code: 200,
      response_kind: 'binary',
      response_sha256: sha256(fixturePptx('runtime')),
      response_bytes: fixturePptx('runtime').length
    });
    assert.deepEqual(JSON.parse(fixtureDb.prepare(`
      SELECT metadata_json FROM campaign_record_links
      WHERE campaign_id=? AND record_type='proposal' AND record_id=? AND relation_type='ppt'
    `).get(fixture.campaign_id, String(fixture.proposal_id)).metadata_json), {
      proposal_content_sha256: linkedBody.proposal_content_sha256,
      request_ledger_id: ledger.id
    });
    assert.equal(fixtureDb.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE entry_type='campaign_ppt' AND business_id=?
    `).get(String(fixture.campaign_id)).count, 1);
  } finally {
    if (fixtureDb) fixtureDb.close();
    await server.close();
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('production owns one collaboration singleton, one PPT route, and the janitor lifecycle', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-composition-probe-'));
  try {
    const probe = writeCompositionProbePreload(probeRoot, { triggerShutdown: true });
    const result = await runTestServerToExit('tm-phase4-composition-server-', {
      NODE_OPTIONS: nodeOptionsWithPreload(probe.preloadPath)
    });
    const events = readProbeEvents(probe.eventPath);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      events.filter((entry) => entry.name === 'collaboration_constructed'),
      [{ name: 'collaboration_constructed', parent: 'server.js' }]
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'collaboration_injected'),
      [{ name: 'collaboration_injected', same: true }]
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_readiness_started'),
      [{
        name: 'upload_readiness_started',
        expectedManifestSha256: RELEASE_PINNED_UPLOAD_MANIFEST_SHA256
      }]
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_self_tests_projected'),
      [{
        name: 'upload_self_tests_projected',
        names: [...REQUIRED_UPLOAD_SANDBOX_SELF_TESTS],
        allTrue: true
      }]
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_systemd_version_projected'),
      [{ name: 'upload_systemd_version_projected', systemdVersion: 257 }]
    );
    assert.equal(events.filter((entry) => entry.name === 'upload_readiness_completed').length, 1);
    assert.equal(events.filter((entry) => entry.name === 'upload_sandbox_constructed').length, 1);
    assert.equal(events.filter((entry) => entry.name === 'upload_pipeline_hooks_created').length, 1);
    assert.equal(events.filter((entry) => entry.name === 'workflow_dispatcher_started').length, 1);
    assert.deepEqual(
      events.filter((entry) => entry.name === 'ppt_post_registered').map((entry) => entry.routePath),
      ['/api/proposal/generate-ppt']
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'janitor_run').map((entry) => entry.run),
      [1, 2]
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'janitor_interval_registered').map((entry) => entry.delay),
      [60 * 60 * 1000]
    );
    assert.equal(events.filter((entry) => entry.name === 'janitor_interval_unref').length, 1);
    assert.equal(events.filter((entry) => entry.name === 'janitor_interval_cleared').length, 1);
    assert.ok(
      events.findIndex((entry) => entry.name === 'server_listen_called') >
        events.findIndex((entry) => entry.name === 'janitor_run')
    );
    assert.ok(
      events.findIndex((entry) => entry.name === 'server_listen_called') >
        events.findIndex((entry) => entry.name === 'upload_readiness_completed')
    );
    assert.ok(
      events.findIndex((entry) => entry.name === 'workflow_dispatcher_started') >
        events.findIndex((entry) => entry.name === 'upload_readiness_completed')
    );
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('health exposes the startup-pinned parser readiness without reading mutable request-time state', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-health-parser-readiness-');
  try {
    const response = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.parser, {
      ready: true,
      manifest_sha256: RELEASE_PINNED_UPLOAD_MANIFEST_SHA256
    });
  } finally {
    await server.close();
  }
});

test('production readiness uses the release manifest pin before any listener starts', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-production-pin-'));
  try {
    const probe = writeCompositionProbePreload(probeRoot, {
      failUploadReadiness: true
    });
    const result = await runTestServerToExit('tm-phase4-production-pin-server-', {
      NODE_ENV: 'production',
      TM_UPLOAD_SANDBOX_TEST_MODE: '',
      NODE_OPTIONS: nodeOptionsWithPreload(probe.preloadPath)
    });
    const events = readProbeEvents(probe.eventPath);
    assert.notEqual(result.code, 0);
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_readiness_started'),
      [{
        name: 'upload_readiness_started',
        expectedManifestSha256: RELEASE_PINNED_UPLOAD_MANIFEST_SHA256
      }]
    );
    assert.equal(events.some((entry) => entry.name === 'upload_self_tests_projected'), false);
    assert.equal(events.some((entry) => entry.name === 'upload_sandbox_constructed'), false);
    assert.equal(events.some((entry) => entry.name === 'server_listen_called'), false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('upload readiness rejects a legacy eighteen-result self-test runner', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-eighteen-self-tests-'));
  try {
    const probe = writeCompositionProbePreload(probeRoot, {
      legacyEighteenSelfTests: true
    });
    const result = await runTestServerToExit('tm-phase4-eighteen-self-tests-server-', {
      NODE_OPTIONS: nodeOptionsWithPreload(probe.preloadPath)
    });
    const events = readProbeEvents(probe.eventPath);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /UPLOAD_SANDBOX_NOT_READY/);
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_self_tests_projected'),
      [{
        name: 'upload_self_tests_projected',
        names: [...LEGACY_EIGHTEEN_UPLOAD_SANDBOX_SELF_TESTS],
        allTrue: true
      }]
    );
    assert.equal(events.some((entry) => entry.name === 'upload_readiness_completed'), false);
    assert.equal(events.some((entry) => entry.name === 'server_listen_called'), false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('upload readiness rejects a legacy fifteen-result self-test runner', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-fifteen-self-tests-'));
  try {
    const probe = writeCompositionProbePreload(probeRoot, {
      legacyFifteenSelfTests: true
    });
    const result = await runTestServerToExit('tm-phase4-fifteen-self-tests-server-', {
      NODE_OPTIONS: nodeOptionsWithPreload(probe.preloadPath)
    });
    const events = readProbeEvents(probe.eventPath);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /UPLOAD_SANDBOX_NOT_READY/);
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_self_tests_projected'),
      [{
        name: 'upload_self_tests_projected',
        names: [...LEGACY_FIFTEEN_UPLOAD_SANDBOX_SELF_TESTS],
        allTrue: true
      }]
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_systemd_version_projected'),
      [{ name: 'upload_systemd_version_projected', systemdVersion: 257 }]
    );
    assert.equal(events.some((entry) => entry.name === 'upload_readiness_completed'), false);
    assert.equal(events.some((entry) => entry.name === 'upload_sandbox_constructed'), false);
    assert.equal(events.some((entry) => entry.name === 'server_listen_called'), false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('upload readiness rejects a legacy thirteen-result self-test runner', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-thirteen-self-tests-'));
  try {
    const probe = writeCompositionProbePreload(probeRoot, {
      legacyThirteenSelfTests: true
    });
    const result = await runTestServerToExit('tm-phase4-thirteen-self-tests-server-', {
      NODE_OPTIONS: nodeOptionsWithPreload(probe.preloadPath)
    });
    const events = readProbeEvents(probe.eventPath);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /UPLOAD_SANDBOX_NOT_READY/);
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_self_tests_projected'),
      [{
        name: 'upload_self_tests_projected',
        names: [...LEGACY_THIRTEEN_UPLOAD_SANDBOX_SELF_TESTS],
        allTrue: true
      }]
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_systemd_version_projected'),
      [{ name: 'upload_systemd_version_projected', systemdVersion: 257 }]
    );
    assert.equal(events.some((entry) => entry.name === 'upload_readiness_completed'), false);
    assert.equal(events.some((entry) => entry.name === 'upload_sandbox_constructed'), false);
    assert.equal(events.some((entry) => entry.name === 'server_listen_called'), false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('upload readiness rejects a legacy eleven-result self-test runner', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-eleven-self-tests-'));
  try {
    const probe = writeCompositionProbePreload(probeRoot, {
      legacyElevenSelfTests: true
    });
    const result = await runTestServerToExit('tm-phase4-eleven-self-tests-server-', {
      NODE_OPTIONS: nodeOptionsWithPreload(probe.preloadPath)
    });
    const events = readProbeEvents(probe.eventPath);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /UPLOAD_SANDBOX_NOT_READY/);
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_self_tests_projected'),
      [{
        name: 'upload_self_tests_projected',
        names: [...LEGACY_ELEVEN_UPLOAD_SANDBOX_SELF_TESTS],
        allTrue: true
      }]
    );
    assert.deepEqual(
      events.filter((entry) => entry.name === 'upload_systemd_version_projected'),
      [{ name: 'upload_systemd_version_projected', systemdVersion: 257 }]
    );
    assert.equal(events.some((entry) => entry.name === 'upload_readiness_completed'), false);
    assert.equal(events.some((entry) => entry.name === 'upload_sandbox_constructed'), false);
    assert.equal(events.some((entry) => entry.name === 'server_listen_called'), false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('upload sandbox readiness failure prevents dispatcher and listen startup', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-upload-readiness-failure-'));
  try {
    const probe = writeCompositionProbePreload(probeRoot, {
      failUploadReadiness: true,
      triggerShutdown: true
    });
    const result = await runTestServerToExit('tm-phase4-upload-readiness-failure-server-', {
      NODE_OPTIONS: nodeOptionsWithPreload(probe.preloadPath)
    });
    const events = readProbeEvents(probe.eventPath);
    assert.notEqual(result.code, 0);
    assert.equal(events.filter((entry) => entry.name === 'upload_readiness_started').length, 1);
    assert.equal(events.some((entry) => entry.name === 'upload_readiness_completed'), false);
    assert.equal(events.some((entry) => entry.name === 'upload_sandbox_constructed'), false);
    assert.equal(events.some((entry) => entry.name === 'workflow_dispatcher_started'), false);
    assert.equal(events.some((entry) => entry.name === 'server_listen_called'), false);
    assert.equal(events.some((entry) => entry.name === 'janitor_interval_registered'), false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('PPT janitor startup failure prevents listen and interval ownership', {
  timeout: 30000
}, async () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-janitor-failure-'));
  try {
    const probe = writeCompositionProbePreload(probeRoot, {
      failJanitorStartup: true,
      triggerShutdown: true
    });
    const result = await runTestServerToExit('tm-phase4-janitor-failure-server-', {
      NODE_OPTIONS: nodeOptionsWithPreload(probe.preloadPath)
    });
    const events = readProbeEvents(probe.eventPath);
    assert.notEqual(result.code, 0);
    assert.deepEqual(
      events.filter((entry) => entry.name === 'janitor_run').map((entry) => entry.run),
      [1]
    );
    assert.equal(events.some((entry) => entry.name === 'server_listen_called'), false);
    assert.equal(events.some((entry) => entry.name === 'janitor_interval_registered'), false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('demand and proposal routes authorize classified rows before search, order, and limit', {
  timeout: 30000
}, async () => {
  const server = await startTestServer('tm-phase4-record-collections-');
  let fixtureDb;
  try {
    const adminLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(adminLogin.response.status, 200, adminLogin.text + '\n' + server.output());
    const created = await jsonRequest(server.baseUrl, '/api/admin/users', {
      method: 'POST',
      token: adminLogin.body.token,
      body: {
        username: 'collection-route-user',
        password: 'CollectionRoute1!Safe',
        display_name: 'Collection Route User',
        role: 'user',
        department: 'Collection Routes'
      }
    });
    assert.equal(created.response.status, 200, created.text);
    const memberLogin = await jsonRequest(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'collection-route-user', password: 'CollectionRoute1!Safe' }
    });
    assert.equal(memberLogin.response.status, 200, memberLogin.text);

    fixtureDb = new Database(server.dbPath);
    const identity = fixtureDb.prepare(`
      SELECT organization.id AS org_id
      FROM organizations organization
      WHERE organization.code='turingmarket-default'
    `).get();
    const fixture = {
      org_id: identity.org_id,
      admin_id: adminLogin.body.user.id,
      member_id: memberLogin.body.user.id,
      team_id: 970500,
      customer_id: 970501,
      opportunity_id: 970502,
      campaign_id: 970503,
      accessible_demand_id: 970601,
      accessible_proposal_id: 970602
    };
    fixtureDb.transaction(() => {
      fixtureDb.prepare(`
        INSERT INTO teams (id,org_id,code,name)
        VALUES (@team_id,@org_id,'collection-route-private','Collection Route Private')
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
        VALUES (@org_id,@team_id,@admin_id,'team_lead','active')
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO customers (
          id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
        ) VALUES (
          @customer_id,'Collection route campaign','Collection route campaign Ltd',
          'qualified','phase4-collection-route',@admin_id,@admin_id,0
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO opportunities (
          id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
        ) VALUES (
          @opportunity_id,@customer_id,'Collection route opportunity','proposal',1000,50,
          'Collection route product','influencer',@admin_id
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO campaigns (
          id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
          lifecycle_state,operational_status,row_version
        ) VALUES (
          @campaign_id,@org_id,'Collection route inaccessible campaign',
          @customer_id,@opportunity_id,@admin_id,@team_id,'lead','active',1
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO demands (
          id,user_id,brand_name,data_json,created_at,updated_at
        ) VALUES (
          @accessible_demand_id,@member_id,'needle authorized legacy','{}',
          '2025-01-01 00:00:00','2025-01-01 00:00:00'
        )
      `).run(fixture);
      fixtureDb.prepare(`
        INSERT INTO proposals (id,user_id,demand_id,template_id,content,created_at)
        VALUES (
          @accessible_proposal_id,@member_id,NULL,'needle-authorized-legacy',
          'needle authorized legacy','2025-01-01 00:00:00'
        )
      `).run(fixture);

      const insertDemand = fixtureDb.prepare(`
        INSERT INTO demands (id,user_id,brand_name,data_json,created_at,updated_at)
        VALUES (?,?,'needle inaccessible classified','{}',?,?)
      `);
      const insertProposal = fixtureDb.prepare(`
        INSERT INTO proposals (id,user_id,demand_id,template_id,content,created_at)
        VALUES (?,?,NULL,'needle-inaccessible','needle inaccessible classified',?)
      `);
      const insertLink = fixtureDb.prepare(`
        INSERT INTO campaign_record_links (
          org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
          created_by,metadata_json,created_at
        ) VALUES (?,?,?,?,?,?,?,'{}',?)
      `);
      for (let index = 1; index <= 205; index += 1) {
        const minute = String(index % 60).padStart(2, '0');
        const hour = String(Math.floor(index / 60)).padStart(2, '0');
        const createdAt = `2026-01-02 ${hour}:${minute}:00`;
        const demandId = 971000 + index;
        const proposalId = 972000 + index;
        insertDemand.run(demandId, fixture.member_id, createdAt, createdAt);
        insertProposal.run(proposalId, fixture.member_id, createdAt);
        insertLink.run(
          fixture.org_id,
          fixture.campaign_id,
          'demand',
          sha256(`route-demand-${index}`),
          String(demandId),
          'demand',
          fixture.member_id,
          createdAt
        );
        insertLink.run(
          fixture.org_id,
          fixture.campaign_id,
          'proposal',
          sha256(`route-proposal-${index}`),
          String(proposalId),
          'proposal',
          fixture.member_id,
          createdAt
        );
      }
    })();
    fixtureDb.close();
    fixtureDb = null;

    const demands = await jsonRequest(server.baseUrl, '/api/demands?search=needle', {
      token: memberLogin.body.token
    });
    assert.equal(demands.response.status, 200, demands.text);
    assert.deepEqual(demands.body.demands.map((row) => row.id), [fixture.accessible_demand_id]);

    const proposals = await jsonRequest(server.baseUrl, '/api/proposals?search=needle', {
      token: memberLogin.body.token
    });
    assert.equal(proposals.response.status, 200, proposals.text);
    assert.deepEqual(proposals.body.proposals.map((row) => row.id), [fixture.accessible_proposal_id]);
  } finally {
    if (fixtureDb) fixtureDb.close();
    await server.close();
  }
});
