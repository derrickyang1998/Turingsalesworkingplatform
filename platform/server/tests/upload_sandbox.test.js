'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  SANDBOX_LIMITS,
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
  normalizeSystemdEffectiveProperties,
  readSystemdProperties,
  systemdInspectionUnitName,
  runCommandNoDisclosure,
  runPressureProbe,
  validateParserOutput,
  verifyInstalledParserArtifacts,
  verifyParserRuntimeTree,
  verifyCheckedInArtifacts,
  workerMain
} = require('../services/upload_sandbox_service');
const {
  createParserAcceptanceFixtures
} = require('../scripts/upload_sandbox_self_test');
const {
  createPhase4RequestPipeline
} = require('../middleware/phase4_request_pipeline');

const TEST_PARSER_IDENTITY = process.platform === 'linux'
  ? {
      uid: process.getuid() === 0 ? 65_534 : process.getuid(),
      gid: process.getgid() === 0 ? 65_534 : process.getgid()
    }
  : null;
const TEST_SOCKET_DENIAL_EVIDENCE = Object.freeze([
  Object.freeze({ operation: 'filesystem_af_unix_bind', errno: 'EAFNOSUPPORT' }),
  Object.freeze({ operation: 'abstract_af_unix_connect', errno: 'EAFNOSUPPORT' }),
  Object.freeze({ operation: 'journald_dev_log_send', errno: 'EAFNOSUPPORT' }),
  Object.freeze({ operation: 'journald_native_send', errno: 'EAFNOSUPPORT' }),
  Object.freeze({ operation: 'journald_stdout_send', errno: 'EAFNOSUPPORT' }),
  Object.freeze({ operation: 'syslog_dev_log_send', errno: 'EAFNOSUPPORT' }),
  Object.freeze({ operation: 'inet4_tcp_connect', errno: 'EAFNOSUPPORT' }),
  Object.freeze({ operation: 'inet4_udp_connect', errno: 'EAFNOSUPPORT' }),
  Object.freeze({ operation: 'inet6_tcp_connect', errno: 'EAFNOSUPPORT' })
]);
const TEST_AIO_DENIAL_EVIDENCE = Object.freeze([
  Object.freeze({ operation: 'io_uring_setup_socket_path', errno: 'EPERM' }),
  Object.freeze({ operation: 'io_uring_enter_socket_path', errno: 'EPERM' }),
  Object.freeze({ operation: 'io_uring_register_socket_path', errno: 'EPERM' })
]);
const TEST_PID_NAMESPACE_PROOF = Object.freeze({
  contract: 'tm-parser-private-pids-v1',
  self_pid: 1,
  visible_pids: Object.freeze([1])
});

function multipartBody(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if (part.file) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
        `Content-Type: ${part.mime}\r\n\r\n`,
        'utf8'
      ));
      chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf8'));
      chunks.push(Buffer.from('\r\n', 'utf8'));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
        'utf8'
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

test('closed upload registry recognizes only knowledge, influencer, and demand parser routes', () => {
  assert.equal(matchUploadRoute('POST', '/api/knowledge/upload').id, 'parser.knowledge-upload');
  assert.equal(matchUploadRoute('POST', '/api/influencers/upload').id, 'parser.influencer-upload');
  assert.equal(matchUploadRoute('POST', '/api/demand/parse-file').id, 'parser.demand-parse');

  for (const [method, route] of [
    ['GET', '/api/knowledge/upload'],
    ['POST', '/api/knowledge/upload/extra'],
    ['POST', '/api/influencers/import'],
    ['POST', '/api/demand/parse'],
    ['POST', '/api/unknown/upload']
  ]) {
    assert.equal(matchUploadRoute(method, route), null, `${method} ${route}`);
  }
});

test('bounded multipart decode produces the exact tm-request-v1 golden hash', async () => {
  const boundary = 'tm-sandbox-golden';
  const multipart = await decodeMultipartBody({
    route: matchUploadRoute('POST', '/api/knowledge/upload'),
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: multipartBody(boundary, [
      { name: 'campaign_id', value: '42' },
      {
        file: true,
        name: 'file',
        filename: 'brief.csv',
        mime: 'text/csv',
        value: Buffer.from('a,b\n', 'utf8')
      }
    ])
  });

  assert.deepEqual(multipart.fields, [
    { name: 'campaign_id', occurrence: 0, value: '42' }
  ]);
  assert.equal(multipart.files.length, 1);
  assert.deepEqual(
    {
      fieldName: multipart.files[0].fieldName,
      occurrence: multipart.files[0].occurrence,
      basename: multipart.files[0].basename,
      mime: multipart.files[0].mime,
      length: multipart.files[0].length,
      sha256: multipart.files[0].sha256
    },
    {
      fieldName: 'file',
      occurrence: 0,
      basename: 'brief.csv',
      mime: 'text/csv',
      length: 4,
      sha256: '5be08c9684a1d25efcee09318204824278b08bbfb4aef973ffefd0b9d7478313'
    }
  );
  assert.equal(hashMultipartRequest({
    method: 'POST',
    path: '/api/knowledge/upload',
    campaignId: 42,
    multipart
  }), '535cada37d03ecd97abf9536b5a92ea7829b7b5d978db57fe1225da98037858b');
});

test('multipart decoder rejects duplicate, unknown, control-bearing, and path-bearing parts', async () => {
  const route = matchUploadRoute('POST', '/api/knowledge/upload');
  const cases = [
    {
      name: 'duplicate field',
      parts: [
        { name: 'campaign_id', value: '42' },
        { name: 'campaign_id', value: '43' },
        { file: true, name: 'file', filename: 'brief.csv', mime: 'text/csv', value: 'a,b\n' }
      ]
    },
    {
      name: 'unknown field',
      parts: [
        { name: 'unreviewed_option', value: 'true' },
        { file: true, name: 'file', filename: 'brief.csv', mime: 'text/csv', value: 'a,b\n' }
      ]
    },
    {
      name: 'control-bearing value',
      parts: [
        { name: 'title', value: 'brief\u0001title' },
        { file: true, name: 'file', filename: 'brief.csv', mime: 'text/csv', value: 'a,b\n' }
      ]
    },
    {
      name: 'path-bearing filename',
      parts: [
        { file: true, name: 'file', filename: '../brief.csv', mime: 'text/csv', value: 'a,b\n' }
      ]
    },
    {
      name: 'second file',
      parts: [
        { file: true, name: 'file', filename: 'brief.csv', mime: 'text/csv', value: 'a,b\n' },
        { file: true, name: 'file', filename: 'other.csv', mime: 'text/csv', value: 'c,d\n' }
      ],
      code: 'UPLOAD_LIMIT_EXCEEDED'
    },
    {
      name: 'missing file',
      parts: [{ name: 'title', value: 'brief' }]
    }
  ];

  for (const item of cases) {
    const boundary = `tm-reject-${item.name.replace(/[^a-z]/g, '-')}`;
    await assert.rejects(
      decodeMultipartBody({
        route,
        contentType: `multipart/form-data; boundary=${boundary}`,
        rawBody: multipartBody(boundary, item.parts)
      }),
      (error) => error && error.code === (item.code || 'UPLOAD_INVALID_CONTENT'),
      item.name
    );
  }
});

test('multipart decoder rejects MIME-extension disagreement and every byte overflow', async () => {
  const route = matchUploadRoute('POST', '/api/knowledge/upload');
  const boundary = 'tm-mime-reject';
  await assert.rejects(
    decodeMultipartBody({
      route,
      contentType: `multipart/form-data; boundary=${boundary}`,
      rawBody: multipartBody(boundary, [
        {
          file: true,
          name: 'file',
          filename: 'brief.csv',
          mime: 'application/json',
          value: '{}'
        }
      ])
    }),
    (error) => error && error.statusCode === 415 && error.code === 'UPLOAD_UNSUPPORTED_TYPE'
  );

  const fileBoundary = 'tm-file-overflow';
  await assert.rejects(
    decodeMultipartBody({
      route,
      contentType: `multipart/form-data; boundary=${fileBoundary}`,
      rawBody: multipartBody(fileBoundary, [
        {
          file: true,
          name: 'file',
          filename: 'large.txt',
          mime: 'text/plain',
          value: Buffer.alloc(route.limits.fileBytes + 1, 0x61)
        }
      ])
    }),
    (error) => error && error.statusCode === 413 && error.code === 'UPLOAD_LIMIT_EXCEEDED'
  );

  await assert.rejects(
    decodeMultipartBody({
      route,
      contentType: 'multipart/form-data; boundary=tm-envelope-overflow',
      rawBody: Buffer.alloc(route.limits.rawBodyBytes + 1, 0x61)
    }),
    (error) => error && error.statusCode === 413 && error.code === 'UPLOAD_LIMIT_EXCEEDED'
  );
});

test('canonical multipart hash conflicts when field value, bytes, MIME, or basename changes', async () => {
  const route = matchUploadRoute('POST', '/api/knowledge/upload');
  async function digest(parts, boundary) {
    const multipart = await decodeMultipartBody({
      route,
      contentType: `multipart/form-data; boundary=${boundary}`,
      rawBody: multipartBody(boundary, parts)
    });
    return hashMultipartRequest({
      method: 'POST',
      path: '/api/knowledge/upload',
      campaignId: 42,
      multipart
    });
  }
  const baseParts = [
    { name: 'campaign_id', value: '42' },
    { file: true, name: 'file', filename: 'brief.csv', mime: 'text/csv', value: 'a,b\n' }
  ];
  const baseline = await digest(baseParts, 'tm-hash-base');
  const variants = [
    [
      { name: 'campaign_id', value: '43' },
      baseParts[1]
    ],
    [
      baseParts[0],
      { ...baseParts[1], value: 'a,c\n' }
    ],
    [
      baseParts[0],
      { ...baseParts[1], filename: 'brief.txt', mime: 'text/plain' }
    ],
    [
      baseParts[0],
      { ...baseParts[1], filename: 'renamed.csv' }
    ]
  ];
  const hashes = [];
  for (let index = 0; index < variants.length; index += 1) {
    hashes.push(await digest(variants[index], `tm-hash-variant-${index}`));
  }
  assert.equal(new Set([baseline, ...hashes]).size, hashes.length + 1);
});

test('multipart decoder rejects extension and MIME that disagree with magic bytes', async () => {
  const route = matchUploadRoute('POST', '/api/knowledge/upload');
  for (const item of [
    {
      filename: 'fake.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      value: 'not-a-zip'
    },
    {
      filename: 'fake.pdf',
      mime: 'application/pdf',
      value: 'not-a-pdf'
    }
  ]) {
    const boundary = `tm-magic-${path.extname(item.filename).slice(1)}`;
    await assert.rejects(
      decodeMultipartBody({
        route,
        contentType: `multipart/form-data; boundary=${boundary}`,
        rawBody: multipartBody(boundary, [
          { file: true, name: 'file', ...item }
        ])
      }),
      (error) => error && error.code === 'UPLOAD_INVALID_CONTENT'
    );
  }
});

function fakeDatabase(activeAdmissions = 0) {
  const statements = [];
  return {
    inTransaction: false,
    statements,
    exec(sql) {
      statements.push(sql);
      if (sql === 'BEGIN IMMEDIATE') this.inTransaction = true;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') this.inTransaction = false;
    },
    prepare(sql) {
      return {
        get() {
          if (/COUNT\(\*\).*active_count/is.test(sql)) {
            return { active_count: activeAdmissions };
          }
          throw new Error('Unexpected fake query');
        }
      };
    }
  };
}

function statfsWithAvailableBytes(bytes) {
  return async () => ({ bavail: bytes, bsize: 1 });
}

test('durable parser admission reserves once before files and enforces the exact ledger scope', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-admit-'));
  const db = fakeDatabase(0);
  const reservations = [];
  const idempotency = {
    reserveProcessingInTransaction(database, input) {
      assert.equal(database.inTransaction, true);
      reservations.push(input);
      return {
        state: 'reserved',
        ledgerId: 91,
        requestHash: input.requestHash,
        leaseToken: 'b'.repeat(64),
        operationDeadline: '2099-01-01 00:00:00'
      };
    }
  };
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    db,
    idempotency,
    spoolRoot,
    inspectSpoolBytes: async () => 0,
    statfs: statfsWithAvailableBytes(
      SANDBOX_LIMITS.freeFloorBytes + SANDBOX_LIMITS.reservationBytes
    ),
    randomBytes: (size) => Buffer.alloc(size, 0xab)
  });
  const request = {};
  try {
    const context = {
      requestId: 'upload-admission-request-01',
      route: matchUploadRoute('POST', '/api/knowledge/upload'),
      principal: { organizationId: 9, userId: 7 },
      method: 'POST',
      path: '/api/knowledge/upload'
    };
    const [first, second] = await Promise.all([
      service.admitRequest(request, context),
      service.admitRequest(request, context)
    ]);

    assert.strictEqual(second, first);
    assert.equal(reservations.length, 1);
    assert.deepEqual(
      {
        organizationId: reservations[0].organizationId,
        actorUserId: reservations[0].actorUserId,
        campaignId: reservations[0].campaignId,
        scope: reservations[0].scope,
        expectedEventCount: reservations[0].expectedEventCount,
        operationTimeoutSeconds: reservations[0].operationTimeoutSeconds
      },
      {
        organizationId: 9,
        actorUserId: 7,
        campaignId: null,
        scope: 'parser.knowledge-upload.admission',
        expectedEventCount: 0,
        operationTimeoutSeconds: 90
      }
    );
    assert.match(reservations[0].key, /^parser-[0-9a-f]{64}$/);
    assert.match(reservations[0].requestHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(fs.readdirSync(spoolRoot), []);
    assert.deepEqual(db.statements, ['BEGIN IMMEDIATE', 'COMMIT']);
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('spool reservation and 2 GiB free floor reject before durable reservation or job creation', async () => {
  for (const item of [
    {
      name: 'spool pressure',
      observedBytes: SANDBOX_LIMITS.spoolBytes,
      availableBytes: SANDBOX_LIMITS.freeFloorBytes + SANDBOX_LIMITS.reservationBytes
    },
    {
      name: 'free-space floor',
      observedBytes: 0,
      availableBytes: SANDBOX_LIMITS.freeFloorBytes + SANDBOX_LIMITS.reservationBytes - 1
    }
  ]) {
    const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-pressure-'));
    let reservations = 0;
    const service = createUploadSandboxService({
      parserIdentity: TEST_PARSER_IDENTITY,
      db: fakeDatabase(0),
      idempotency: {
        reserveProcessingInTransaction() {
          reservations += 1;
          throw new Error('must not reserve');
        }
      },
      spoolRoot,
      inspectSpoolBytes: async () => item.observedBytes,
      statfs: statfsWithAvailableBytes(item.availableBytes)
    });
    try {
      await assert.rejects(
        service.admitRequest({}, {
          requestId: `pressure-${item.name}`,
          route: matchUploadRoute('POST', '/api/knowledge/upload'),
          principal: { organizationId: 9, userId: 7 },
          method: 'POST',
          path: '/api/knowledge/upload'
        }),
        (error) => (
          error &&
          error.statusCode === 507 &&
          error.code === 'IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED'
        ),
        item.name
      );
      assert.equal(reservations, 0);
      assert.deepEqual(fs.readdirSync(spoolRoot), []);
    } finally {
      fs.rmSync(spoolRoot, { recursive: true, force: true });
    }
  }
});

function responseDouble() {
  const response = new EventEmitter();
  response.headers = {};
  response.destroyed = false;
  response.writableEnded = false;
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value; };
  response.end = (body) => {
    response.body = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    response.writableEnded = true;
    response.emit('finish');
  };
  return response;
}

test('pipeline records durable admission and fences it when bounded multipart decoding fails', async () => {
  const policy = {
    id: 'parser.knowledge-upload',
    mediaKind: 'multipart',
    maxRawBytes: 1024,
    admission: 'parser.knowledge-upload.admission'
  };
  const admission = { ledgerId: 91, leaseToken: 'b'.repeat(64) };
  let markAdmitted;
  const admitted = new Promise((resolve) => { markAdmitted = resolve; });
  const failures = [];
  const pipeline = createPhase4RequestPipeline({
    registry: { match: () => policy },
    authenticate: async () => ({ id: 7 }),
    admit: async (request) => {
      assert.equal(request.listenerCount('data'), 0);
      markAdmitted();
      return admission;
    },
    parseMultipart: async () => {
      throw Object.assign(new Error('malformed'), {
        status: 400,
        code: 'UPLOAD_INVALID_CONTENT'
      });
    },
    onAdmissionFailure: async (_request, reserved, error) => {
      failures.push({ reserved, code: error.code });
    },
    generateRequestId: () => 'pipeline-admission-request-01'
  });
  const request = new PassThrough();
  request.method = 'POST';
  request.url = '/api/knowledge/upload';
  request.originalUrl = request.url;
  request.headers = {
    authorization: 'Bearer accepted',
    'content-type': 'multipart/form-data; boundary=broken'
  };
  request.socket = { destroyed: true };
  const response = responseDouble();
  let nextCalls = 0;
  const pending = pipeline.middleware(request, response, () => { nextCalls += 1; });
  await admitted;
  request.end(Buffer.from('--broken\r\ninvalid\r\n--broken--\r\n'));
  await pending;

  assert.strictEqual(request.phase4Request.admission, admission);
  assert.deepEqual(failures, [{ reserved: admission, code: 'UPLOAD_INVALID_CONTENT' }]);
  assert.equal(nextCalls, 0);
  assert.equal(response.statusCode, 500);
});

test('pipeline refuses a shared upload before reading when admission is not durable', async () => {
  const policy = {
    id: 'parser.knowledge-upload',
    mediaKind: 'multipart',
    maxRawBytes: 1024,
    admission: 'parser.knowledge-upload.admission'
  };
  let parserCalls = 0;
  let nextCalls = 0;
  const pipeline = createPhase4RequestPipeline({
    registry: { match: () => policy },
    authenticate: async () => ({ id: 7 }),
    admit: async (request) => {
      assert.equal(request.listenerCount('data'), 0);
      return true;
    },
    parseMultipart: async () => {
      parserCalls += 1;
      return { body: {}, files: [] };
    },
    requireDurableAdmission: true,
    generateRequestId: () => 'pipeline-missing-admission-01'
  });
  const request = new PassThrough();
  request.method = 'POST';
  request.url = '/api/knowledge/upload';
  request.originalUrl = request.url;
  request.headers = {
    authorization: 'Bearer accepted',
    'content-type': 'multipart/form-data; boundary=missing-admission'
  };
  request.socket = { destroyed: true };
  const response = responseDouble();
  const pending = pipeline.middleware(request, response, () => { nextCalls += 1; });
  request.end(Buffer.from('--missing-admission--\r\n'));
  await pending;

  assert.equal(parserCalls, 0);
  assert.equal(nextCalls, 0);
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body.toString('utf8')).code, 'UPLOAD_SANDBOX_NOT_READY');
});

test('pipeline hook adapter maps the authenticated closed route without exposing a client path', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-hooks-'));
  const db = fakeDatabase(0);
  let failedAdmission = null;
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    db,
    idempotency: {
      reserveProcessingInTransaction(_database, input) {
        return {
          state: 'reserved',
          ledgerId: 91,
          requestHash: input.requestHash,
          leaseToken: 'b'.repeat(64)
        };
      }
    },
    spoolRoot,
    inspectSpoolBytes: async () => 0,
    statfs: statfsWithAvailableBytes(
      SANDBOX_LIMITS.freeFloorBytes + SANDBOX_LIMITS.reservationBytes
    ),
    failAdmission: async (admission) => { failedAdmission = admission; }
  });
  const hooks = service.createPipelineHooks({
    resolvePrincipal: async () => ({ organizationId: 9, userId: 7 })
  });
  assert.equal(hooks.admit.requiresDurableAdmission, true);
  const request = {
    method: 'POST',
    originalUrl: '/api/knowledge/upload',
    headers: { 'content-type': 'multipart/form-data; boundary=tm-hook-adapter' }
  };
  const policy = {
    id: 'parser.knowledge-upload',
    admission: 'parser.knowledge-upload.admission'
  };
  try {
    const admission = await hooks.admit(request, {
      requestId: 'pipeline-hook-request-01',
      policy
    });
    const parsed = await hooks.parseMultipart(
      request,
      multipartBody('tm-hook-adapter', [
        { name: 'campaign_id', value: '42' },
        {
          file: true,
          name: 'file',
          filename: 'brief.csv',
          mime: 'text/csv',
          value: 'a,b\n'
        }
      ]),
      policy
    );
    assert.equal(parsed.body.campaign_id, '42');
    assert.equal(parsed.file.originalname, 'brief.csv');
    assert.equal(Object.hasOwn(parsed.file, 'path'), false);
    assert.equal(parsed.canonicalRequestHash,
      '535cada37d03ecd97abf9536b5a92ea7829b7b5d978db57fe1225da98037858b');
    assert.equal(parsed.sandboxMultipart.files[0].basename, 'brief.csv');

    await hooks.onAdmissionFailure(request, admission, new Error('body failed'));
    assert.strictEqual(failedAdmission, admission);
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('worker CLI parses a securely staged CSV and validator rejects hard-linked output', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-job-'));
  const boundary = 'tm-worker-csv';
  const multipart = await decodeMultipartBody({
    route: matchUploadRoute('POST', '/api/knowledge/upload'),
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: multipartBody(boundary, [
      {
        file: true,
        name: 'file',
        filename: 'creators.csv',
        mime: 'text/csv',
        value: 'handle,followers\ncreator,100\n'
      }
    ])
  });
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    spoolRoot,
    randomBytes: (size) => Buffer.alloc(size, 0x1a)
  });
  let job;
  try {
    job = await service.stageJob(multipart, {
      ledgerId: 91,
      requestHash: 'a'.repeat(64),
      leaseToken: 'b'.repeat(64),
      route: 'parser.knowledge-upload'
    });
    assert.match(job.id, /^[0-9a-f]{32}$/);
    assert.equal(path.dirname(job.root), path.resolve(spoolRoot));
    assert.equal(path.basename(job.inputPath), 'input.bin');
    assert.equal(path.basename(job.requestPath), 'request.json');
    assert.equal(path.basename(job.outputRoot), 'output');
    assert.deepEqual(fs.readdirSync(job.outputRoot).sort(), [
      'manifest.json',
      'result.json'
    ]);
    assert.equal(fs.statSync(path.join(job.outputRoot, 'result.json')).size, 0);
    for (const filePath of [job.inputPath, job.requestPath]) {
      const stat = fs.lstatSync(filePath);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
    }
    if (process.platform === 'linux') {
      const outputStat = fs.lstatSync(job.outputRoot);
      const manifestStat = fs.lstatSync(path.join(job.outputRoot, 'manifest.json'));
      const resultStat = fs.lstatSync(path.join(job.outputRoot, 'result.json'));
      assert.equal(outputStat.mode & 0o777, 0o550);
      assert.equal(outputStat.uid, 0);
      assert.equal(outputStat.gid, TEST_PARSER_IDENTITY.gid);
      assert.equal(manifestStat.mode & 0o777, 0o440);
      assert.equal(manifestStat.uid, 0);
      assert.equal(manifestStat.gid, TEST_PARSER_IDENTITY.gid);
      assert.equal(resultStat.mode & 0o777, 0o600);
      assert.equal(resultStat.uid, TEST_PARSER_IDENTITY.uid);
      assert.equal(resultStat.gid, TEST_PARSER_IDENTITY.gid);
    }

    await workerMain([
      'worker',
      '--job-id', job.id,
      '--request', job.requestPath,
      '--input', job.inputPath,
      '--output-root', job.outputRoot
    ]);
    const validated = await validateParserOutput(job.outputRoot);
    assert.equal(validated.route, 'parser.knowledge-upload');
    assert.equal(validated.data.kind, 'table');
    assert.equal(validated.data.rows.length, 1);
    assert.equal(validated.data.rows[0].handle, 'creator');

    fs.linkSync(
      path.join(job.outputRoot, 'result.json'),
      path.join(job.outputRoot, 'result-hardlink.json')
    );
    await assert.rejects(
      validateParserOutput(job.outputRoot),
      (error) => error && error.code === 'UPLOAD_INVALID_CONTENT'
    );
  } finally {
    if (job) await service.cleanupJob(job);
    assert.deepEqual(fs.readdirSync(spoolRoot), []);
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('validator rejects ordinary extra entries and many-file output pressure', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-output-pressure-'));
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    spoolRoot
  });
  let job;
  try {
    job = await service.stageJob(await decodedCsv(), {
      ledgerId: 91,
      requestHash: 'a'.repeat(64),
      leaseToken: 'b'.repeat(64),
      route: 'parser.knowledge-upload'
    });
    await workerMain([
      'worker',
      '--job-id', job.id,
      '--request', job.requestPath,
      '--input', job.inputPath,
      '--output-root', job.outputRoot
    ]);

    fs.writeFileSync(path.join(job.outputRoot, 'ordinary-extra.json'), '{}');
    await assert.rejects(
      validateParserOutput(job.outputRoot),
      (error) => error && error.code === 'UPLOAD_INVALID_CONTENT'
    );
    fs.unlinkSync(path.join(job.outputRoot, 'ordinary-extra.json'));

    for (let index = 0; index < 256; index += 1) {
      fs.writeFileSync(path.join(job.outputRoot, `pressure-${index}.tmp`), 'x');
    }
    await assert.rejects(
      validateParserOutput(job.outputRoot),
      (error) => error && error.code === 'UPLOAD_INVALID_CONTENT'
    );
  } finally {
    if (job) await service.cleanupJob(job);
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('validator rejects result inode ownership, mode, xattrs, links, and timestamp drift', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-result-metadata-'));
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    spoolRoot
  });
  let job;
  try {
    job = await service.stageJob(await decodedCsv(), {
      ledgerId: 91,
      requestHash: 'a'.repeat(64),
      leaseToken: 'b'.repeat(64),
      route: 'parser.knowledge-upload'
    });
    await workerMain([
      'worker',
      '--job-id', job.id,
      '--request', job.requestPath,
      '--input', job.inputPath,
      '--output-root', job.outputRoot
    ]);

    const stat = fs.statSync(job.resultPath);
    const nowMs = Date.now();
    const validMetadata = {
      isRegular: true,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      gid: stat.gid,
      mode: 0o600,
      nlink: 1,
      size: stat.size,
      mtimeMs: nowMs,
      ctimeMs: nowMs,
      xattrs: []
    };
    const options = {
      expectedResultMetadata: {
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        gid: stat.gid,
        mode: 0o600,
        lifecycleStartedMs: nowMs - 1_000
      },
      inspectResultMetadata: async () => validMetadata,
      now: () => nowMs
    };
    await validateParserOutput(job.outputRoot, options);

    for (const drift of [
      { mode: 0o640 },
      { uid: stat.uid + 1 },
      { gid: stat.gid + 1 },
      { nlink: 2 },
      { xattrs: ['user.hidden'] },
      { mtimeMs: nowMs - 10_000 },
      { ctimeMs: nowMs + 10_000 }
    ]) {
      await assert.rejects(
        validateParserOutput(job.outputRoot, {
          ...options,
          inspectResultMetadata: async () => ({ ...validMetadata, ...drift })
        }),
        (error) => error && error.code === 'UPLOAD_INVALID_CONTENT'
      );
    }
  } finally {
    if (job) await service.cleanupJob(job);
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

function zipWithDeclaredExpansion(uncompressedBytes) {
  const name = Buffer.from('xl/worksheets/sheet1.xml', 'utf8');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(1, 18);
  local.writeUInt32LE(uncompressedBytes, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(1, 20);
  central.writeUInt32LE(uncompressedBytes, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + 1, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, Buffer.from([0x00]), central, eocd]);
}

test('worker rejects a declared zip bomb before parser output is created', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-zipbomb-'));
  const boundary = 'tm-worker-zipbomb';
  const multipart = await decodeMultipartBody({
    route: matchUploadRoute('POST', '/api/knowledge/upload'),
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: multipartBody(boundary, [
      {
        file: true,
        name: 'file',
        filename: 'bomb.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        value: zipWithDeclaredExpansion(SANDBOX_LIMITS.expandedBytes + 1)
      }
    ])
  });
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    spoolRoot
  });
  let job;
  try {
    job = await service.stageJob(multipart, {
      ledgerId: 91,
      requestHash: 'a'.repeat(64),
      leaseToken: 'b'.repeat(64),
      route: 'parser.knowledge-upload'
    });
    await assert.rejects(
      workerMain([
        'worker',
        '--job-id', job.id,
        '--request', job.requestPath,
        '--input', job.inputPath,
        '--output-root', job.outputRoot
      ]),
      (error) => error && error.code === 'UPLOAD_LIMIT_EXCEEDED'
    );
    assert.deepEqual(fs.readdirSync(job.outputRoot).sort(), [
      'manifest.json',
      'result.json'
    ]);
    assert.equal(fs.statSync(path.join(job.outputRoot, 'result.json')).size, 0);
  } finally {
    if (job) await service.cleanupJob(job);
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

async function decodedCsv(routePath = '/api/knowledge/upload') {
  const route = matchUploadRoute('POST', routePath);
  const boundary = `tm-process-${route.id}`;
  return decodeMultipartBody({
    route,
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: multipartBody(boundary, [
      {
        file: true,
        name: 'file',
        filename: 'input.csv',
        mime: 'text/csv',
        value: 'name,value\nalpha,1\n'
      }
    ])
  });
}

test('trusted parser completion events classify outcomes without disclosing upload data', async () => {
  const route = matchUploadRoute('POST', '/api/knowledge/upload');
  const boundary = 'tm-parser-observability';
  const multipart = await decodeMultipartBody({
    route,
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: multipartBody(boundary, [{
      file: true,
      name: 'file',
      filename: 'confidential-customer-list.csv',
      mime: 'text/csv',
      value: 'private-customer-name,private-customer-value\nsecret,42\n'
    }])
  });
  const cases = [
    {
      name: 'timeout',
      error: () => Object.assign(new Error('private parser stderr timeout'), {
        code: 'UPLOAD_PARSE_TIMEOUT'
      }),
      outcome: { Result: 'timeout', ExecMainStatus: '15', OOMKilled: 'no' },
      category: 'timeout'
    },
    {
      name: 'oom',
      error: () => new Error('private parser stderr oom'),
      outcome: { Result: 'oom-kill', ExecMainStatus: '9', OOMKilled: 'yes' },
      category: 'oom'
    },
    {
      name: 'capacity',
      error: () => new UploadSandboxError(
        413,
        'UPLOAD_LIMIT_EXCEEDED',
        'private parser capacity detail'
      ),
      outcome: { Result: 'exit-code', ExecMainStatus: '75', OOMKilled: 'no' },
      category: 'capacity'
    },
    {
      name: 'systemd',
      error: () => Object.assign(new Error('private systemd stderr'), {
        code: 'COMMAND_FAILED'
      }),
      outcome: { Result: 'unavailable', ExecMainStatus: '', OOMKilled: 'no' },
      category: 'systemd'
    },
    {
      name: 'runtime-drift',
      error: () => new UploadSandboxError(
        500,
        'UPLOAD_SANDBOX_NOT_READY',
        'private runtime path drift'
      ),
      outcome: { Result: 'success', ExecMainStatus: '0', OOMKilled: 'no' },
      category: 'runtime-drift'
    },
    {
      name: 'general',
      error: () => new Error('private parser stderr general'),
      outcome: { Result: 'exit-code', ExecMainStatus: '1', OOMKilled: 'no' },
      category: 'general'
    }
  ];

  for (const item of cases) {
    const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tm-parser-event-${item.name}-`));
    const events = [];
    const ticks = [1_000, 1_025];
    const service = createUploadSandboxService({
      parserIdentity: TEST_PARSER_IDENTITY,
      spoolRoot,
      monotonicNow: () => ticks.shift(),
      executeJob: async () => { throw item.error(); },
      inspectJobOutcome: async () => item.outcome,
      killJob: async () => {},
      failAdmission: async () => {},
      emitControllerEvent(event) {
        assert.deepEqual(fs.readdirSync(spoolRoot), []);
        events.push(event);
      }
    });
    try {
      await assert.rejects(service.processUpload({
        multipart,
        admission: {
          ledgerId: 91,
          requestHash: 'a'.repeat(64),
          leaseToken: 'b'.repeat(64),
          route: route.id
        },
        assertAuthorized: async () => {},
        assertLeaseOwned: async () => {},
        finalize: async () => ({ ok: true })
      }));
      assert.deepEqual(events, [{
        event: 'parser_job_completed',
        route: route.id,
        duration_ms: 25,
        result_category: item.category,
        systemd: {
          Result: item.outcome.Result,
          ExecMainStatus: item.outcome.ExecMainStatus === ''
            ? null
            : Number(item.outcome.ExecMainStatus),
          OOMKilled: item.outcome.OOMKilled === 'yes'
        }
      }], item.name);
      const serialized = JSON.stringify(events);
      for (const secret of [
        'confidential-customer-list.csv',
        'private-customer-name',
        'private-customer-value',
        'private parser',
        'private systemd',
        'private runtime'
      ]) {
        assert.equal(serialized.includes(secret), false, `${item.name}: ${secret}`);
      }
    } finally {
      fs.rmSync(spoolRoot, { recursive: true, force: true });
    }
  }
});

test('worker parses the generated minimal XLSX and PPTX payload markers through production parsers', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-ooxml-'));
  const service = createUploadSandboxService({ parserIdentity: TEST_PARSER_IDENTITY, spoolRoot });
  const fixtures = createParserAcceptanceFixtures().filter(({ format }) => format !== 'bmp');
  let index = 0;
  try {
    for (const fixture of fixtures) {
      index += 1;
      const route = matchUploadRoute('POST', '/api/demand/parse-file');
      const multipart = {
        route,
        fields: [],
        files: [{
          buffer: fixture.buffer,
          basename: fixture.filename,
          mime: fixture.mime,
          length: fixture.buffer.length,
          sha256: require('node:crypto').createHash('sha256').update(fixture.buffer).digest('hex')
        }]
      };
      const job = await service.stageJob(multipart, {
        ledgerId: 200 + index,
        requestHash: String(index).repeat(64),
        leaseToken: String(index + 2).repeat(64),
        route: route.id
      });
      try {
        await workerMain([
          'worker', '--job-id', job.id, '--request', job.requestPath,
          '--input', job.inputPath, '--output-root', job.outputRoot
        ]);
        const parsed = await validateParserOutput(job.outputRoot);
        assert.match(parsed.data.text, new RegExp(fixture.marker));
        assert.equal(parsed.data.parser, fixture.parser);
        assert.equal(parsed.data.fallback, false);
      } finally {
        await service.cleanupJob(job);
      }
    }
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('worker scratch staging does not require the copy_file_range fast path', { concurrency: false }, async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-copy-fallback-'));
  const service = createUploadSandboxService({ parserIdentity: TEST_PARSER_IDENTITY, spoolRoot });
  const fixture = createParserAcceptanceFixtures().find(({ format }) => format === 'xlsx');
  const route = matchUploadRoute('POST', '/api/demand/parse-file');
  const originalCopyFile = fs.promises.copyFile;
  let job;

  fs.promises.copyFile = async () => {
    throw Object.assign(new Error('copy_file_range is denied by the parser sandbox'), {
      code: 'EPERM'
    });
  };
  try {
    const multipart = {
      route,
      fields: [],
      files: [{
        buffer: fixture.buffer,
        basename: fixture.filename,
        mime: fixture.mime,
        length: fixture.buffer.length,
        sha256: require('node:crypto').createHash('sha256').update(fixture.buffer).digest('hex')
      }]
    };
    job = await service.stageJob(multipart, {
      ledgerId: 299,
      requestHash: 'a'.repeat(64),
      leaseToken: 'b'.repeat(64),
      route: route.id
    });
    await workerMain([
      'worker', '--job-id', job.id, '--request', job.requestPath,
      '--input', job.inputPath, '--output-root', job.outputRoot
    ]);
    const parsed = await validateParserOutput(job.outputRoot);
    assert.match(parsed.data.text, new RegExp(fixture.marker));
    assert.equal(parsed.data.parser, fixture.parser);
  } finally {
    fs.promises.copyFile = originalCopyFile;
    if (job) await service.cleanupJob(job).catch(() => {});
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('trusted parser completion event records a successful job exactly once', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-parser-event-success-'));
  const events = [];
  const ticks = [2_000, 2_040];
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    spoolRoot,
    monotonicNow: () => ticks.shift(),
    executeJob: async (job) => workerMain([
      'worker',
      '--job-id', job.id,
      '--request', job.requestPath,
      '--input', job.inputPath,
      '--output-root', job.outputRoot
    ]),
    inspectJobOutcome: async () => ({
      Result: 'success',
      ExecMainStatus: '0',
      OOMKilled: 'no'
    }),
    emitControllerEvent(event) {
      assert.deepEqual(fs.readdirSync(spoolRoot), []);
      events.push(event);
    },
    idempotency: {
      completeAdmissionInTransaction() {}
    }
  });
  try {
    await service.processUpload({
      multipart: await decodedCsv(),
      admission: {
        ledgerId: 91,
        requestHash: 'a'.repeat(64),
        leaseToken: 'b'.repeat(64),
        route: 'parser.knowledge-upload'
      },
      assertAuthorized: async () => {},
      assertLeaseOwned: async () => {},
      finalize: async (_parsed, lifecycle) => {
        lifecycle.completeAdmissionInTransaction({ inTransaction: true });
        return { ok: true };
      }
    });
    assert.deepEqual(events, [{
      event: 'parser_job_completed',
      route: 'parser.knowledge-upload',
      duration_ms: 40,
      result_category: 'success',
      systemd: {
        Result: 'success',
        ExecMainStatus: 0,
        OOMKilled: false
      }
    }]);
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('timeout, crash, revocation, and final conflict kill and clean before admission failure', async () => {
  const cases = ['timeout', 'crash', 'revocation', 'final-conflict'];
  for (const name of cases) {
    const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tm-upload-${name}-`));
    const events = [];
    let authorizationChecks = 0;
    const service = createUploadSandboxService({
      parserIdentity: TEST_PARSER_IDENTITY,
      spoolRoot,
      executeJob: async (job) => {
        events.push('execute');
        if (name === 'timeout') {
          fs.writeFileSync(path.join(job.outputRoot, 'partial'), 'partial');
          throw Object.assign(new Error('late parser stderr must stay hidden'), {
            code: 'UPLOAD_PARSE_TIMEOUT',
            statusCode: 408
          });
        }
        if (name === 'crash') {
          throw new Error('parser stdout and stderr must stay hidden');
        }
        await workerMain([
          'worker',
          '--job-id', job.id,
          '--request', job.requestPath,
          '--input', job.inputPath,
          '--output-root', job.outputRoot
        ]);
      },
      killJob: async () => { events.push('kill'); },
      failAdmission: async () => {
        assert.deepEqual(fs.readdirSync(spoolRoot), []);
        events.push('failed');
      }
    });
    try {
      await assert.rejects(
        service.processUpload({
          multipart: await decodedCsv(),
          admission: {
            ledgerId: 91,
            requestHash: 'a'.repeat(64),
            leaseToken: 'b'.repeat(64),
            route: 'parser.knowledge-upload'
          },
          assertAuthorized: async () => {
            authorizationChecks += 1;
            if (name === 'revocation' && authorizationChecks === 2) {
              throw Object.assign(new Error('revoked'), { code: 'CAMPAIGN_FORBIDDEN' });
            }
          },
          assertLeaseOwned: async () => {},
          finalize: async () => {
            assert.deepEqual(fs.readdirSync(spoolRoot), []);
            if (name === 'final-conflict') {
              throw Object.assign(new Error('conflict'), { code: 'IDEMPOTENCY_KEY_REUSED' });
            }
            return { ok: true };
          }
        }),
        (error) => {
          assert.equal(error.message.includes('parser stdout'), false);
          assert.equal(error.message.includes('parser stderr'), false);
          return true;
        },
        name
      );
      assert.deepEqual(fs.readdirSync(spoolRoot), []);
      assert.equal(events.at(-1), 'failed');
      assert.equal(events.includes('kill'), name === 'timeout' || name === 'crash');
    } finally {
      fs.rmSync(spoolRoot, { recursive: true, force: true });
    }
  }
});

test('failed cgroup collection preserves parser residue and the processing admission', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-collect-fail-'));
  let failAdmissionCalls = 0;
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    spoolRoot,
    executeJob: async () => {
      throw new Error('parser crashed');
    },
    killJob: async () => {
      throw new Error('cgroup still active');
    },
    failAdmission: async () => {
      failAdmissionCalls += 1;
    }
  });
  try {
    await assert.rejects(
      service.processUpload({
        multipart: await decodedCsv(),
        admission: {
          ledgerId: 91,
          requestHash: 'a'.repeat(64),
          leaseToken: 'b'.repeat(64),
          route: 'parser.knowledge-upload'
        },
        assertAuthorized: async () => {},
        assertLeaseOwned: async () => {},
        finalize: async () => ({ ok: true })
      }),
      (error) => error && error.code === 'UPLOAD_SANDBOX_CLEANUP_FAILED'
    );
    assert.equal(failAdmissionCalls, 0);
    assert.equal(fs.readdirSync(spoolRoot).length, 1);
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('successful parser cleanup precedes final transaction and admission completion', async () => {
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-success-'));
  const events = [];
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    spoolRoot,
    executeJob: async (job) => workerMain([
      'worker',
      '--job-id', job.id,
      '--request', job.requestPath,
      '--input', job.inputPath,
      '--output-root', job.outputRoot
    ]),
    idempotency: {
      completeAdmissionInTransaction(database) {
        assert.equal(database.inTransaction, true);
        events.push('completed');
      }
    }
  });
  try {
    const result = await service.processUpload({
      multipart: await decodedCsv(),
      admission: {
        ledgerId: 91,
        requestHash: 'a'.repeat(64),
        leaseToken: 'b'.repeat(64),
        route: 'parser.knowledge-upload'
      },
      assertAuthorized: async () => {},
      assertLeaseOwned: async () => {},
      finalize: async (parsed, lifecycle) => {
        assert.deepEqual(fs.readdirSync(spoolRoot), []);
        events.push('finalize');
        lifecycle.completeAdmissionInTransaction({ inTransaction: true });
        return { rows: parsed.data.rows.length };
      }
    });
    assert.deepEqual(result, { rows: 1 });
    assert.deepEqual(events, ['finalize', 'completed']);
    assert.deepEqual(fs.readdirSync(spoolRoot), []);
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('captured child output is never disclosed and timeout is bounded', async () => {
  await assert.rejects(
    runCommandNoDisclosure(process.execPath, [
      '-e',
      'process.stdout.write("sensitive-stdout");process.stderr.write("sensitive-stderr");process.exit(7)'
    ], { timeoutMs: 2000 }),
    (error) => (
      error &&
      !error.message.includes('sensitive-stdout') &&
      !error.message.includes('sensitive-stderr')
    )
  );
  const started = Date.now();
  await assert.rejects(
    runCommandNoDisclosure(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 30
    }),
    (error) => error && error.code === 'COMMAND_TIMEOUT'
  );
  assert.ok(Date.now() - started < 2000);
});

test('checked-in parser artifacts verify and effective-property drift is startup fatal', async () => {
  const runtime = loadRuntimeManifest();
  const verified = await verifyCheckedInArtifacts({
    expectedManifestSha256: runtime.manifestSha256
  });
  assert.equal(verified.manifestSha256, runtime.manifestSha256);
  assert.equal(verified.routeRegistrySha256, runtime.manifest.route_registry_sha256);

  const serviceProperties = runtime.manifest.effective_properties['turingmarket-parser@.service'];
  const sliceProperties = runtime.manifest.effective_properties['turingmarket-parser.slice'];
  assert.equal(runtime.manifest.minimum_systemd_version, 257);
  assert.equal(serviceProperties.RootDirectory, '/var/lib/turingmarket-parser/runtime-root');
  assert.equal(serviceProperties.MountAPIVFS, 'yes');
  assert.equal(serviceProperties.BindLogSockets, 'no');
  assert.equal(serviceProperties.PrivateMounts, 'yes');
  assert.equal(serviceProperties.PrivatePIDs, 'yes');
  assert.equal(serviceProperties.RestrictAddressFamilies, 'none');
  assert.equal(serviceProperties.RestrictNamespaces, 'yes');
  assert.equal(serviceProperties.NoExecPaths, '/');
  assert.equal(
    serviceProperties.BindReadOnlyPaths.includes('/root/turingmarket/platform/server'),
    false
  );
  assert.equal(
    serviceProperties.ExecPaths,
    '/bin/bash /lib /lib64 /opt/turingmarket-parser/app /usr/bin/env /usr/bin/node /usr/bin/python3 /usr/lib /usr/local/lib /usr/local/libexec/turingmarket/parse_upload_sandbox.sh'
  );
  assert.equal(serviceProperties.WorkingDirectory, '/opt/turingmarket-parser/app');
  assert.equal(
    runtime.manifest.artifacts['services/file_ingest_service.js']?.length,
    64
  );
  assert.deepEqual(Object.keys(runtime.manifest.runtime_tree).sort(), [
    'bytes',
    'directories',
    'files',
    'format',
    'root',
    'sha256'
  ]);
  assert.equal(
    runtime.manifest.runtime_tree.root,
    '/var/lib/turingmarket-parser/runtime-root'
  );
  await assert.rejects(
    assertUploadSandboxStartupReady({
      expectedManifestSha256: runtime.manifestSha256,
      idempotency: {
        reserveProcessingInTransaction() {},
        completeAdmissionInTransaction() {},
        failInternalInTransaction() {}
      },
      verifyIdentity: async () => ({ ...runtime.manifest.identity, uid: 64123, gid: 64123 }),
      verifyInstalledArtifacts: async () => {},
      systemdVersion: async () => 257,
      systemctlShow: async (unit) => unit === 'turingmarket-parser@.service'
        ? { ...serviceProperties, MemoryMax: '256M' }
        : sliceProperties,
      recoverAdmissions: async () => {},
      runSelfTests: async () => Object.fromEntries(
        runtime.manifest.required_self_tests.map((name) => [name, true])
      )
    }),
    (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
  );

  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-old-self-tests-'));
  try {
    await assert.rejects(
      assertUploadSandboxStartupReady({
        expectedManifestSha256: runtime.manifestSha256,
        spoolRoot,
        idempotency: {
          reserveProcessingInTransaction() {},
          completeAdmissionInTransaction() {},
          failInternalInTransaction() {}
        },
        verifyIdentity: async () => ({
          ...runtime.manifest.identity,
          uid: 64123,
          gid: 64123
        }),
        verifyInstalledArtifacts: async () => {},
        systemdVersion: async () => 257,
        systemctlShow: async (unit) => unit === 'turingmarket-parser@.service'
          ? serviceProperties
          : sliceProperties,
        recoverAdmissions: async () => {},
        staleUnitController: {
          async kill() {},
          async stop() {},
          async resetFailed() {},
          async assertCollected() {}
        },
        runSelfTests: async () => Object.fromEntries(
          runtime.manifest.required_self_tests
            .filter((name) => ![
              'dev_submount_write_denial',
              'writable_filesystem_inventory'
            ].includes(name))
            .map((name) => [name, true])
        )
      }),
      (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
    );
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('startup rejects systemd versions that cannot enforce PrivatePIDs', async () => {
  const runtime = loadRuntimeManifest();
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-systemd-version-'));
  let propertyReads = 0;
  try {
    await assert.rejects(
      assertUploadSandboxStartupReady({
        expectedManifestSha256: runtime.manifestSha256,
        spoolRoot,
        idempotency: {
          reserveProcessingInTransaction() {},
          completeAdmissionInTransaction() {},
          failInternalInTransaction() {}
        },
        verifyIdentity: async () => ({
          ...runtime.manifest.identity,
          uid: 64123,
          gid: 64123
        }),
        verifyInstalledArtifacts: async () => {},
        systemdVersion: async () => 256,
        systemctlShow: async (unit) => {
          propertyReads += 1;
          return runtime.manifest.effective_properties[unit];
        },
        recoverAdmissions: async () => {},
        staleUnitController: {
          async kill() {},
          async stop() {},
          async resetFailed() {},
          async assertCollected() {}
        },
        runSelfTests: async () => Object.fromEntries(
          runtime.manifest.required_self_tests.map((name) => [name, true])
        )
      }),
      (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
    );
    assert.equal(propertyReads, 0);
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('private temp and writable /dev submounts are inaccessible and output is capped', async () => {
  const runtime = loadRuntimeManifest();
  const serviceProperties = runtime.manifest.effective_properties['turingmarket-parser@.service'];
  const unitText = fs.readFileSync(
    path.join(__dirname, '..', 'systemd', 'turingmarket-parser@.service'),
    'utf8'
  );
  assert.equal(serviceProperties.PrivateTmp, 'no');
  assert.equal(serviceProperties.PrivateIPC, 'yes');
  assert.equal(serviceProperties.PrivatePIDs, 'yes');
  assert.equal(serviceProperties.BindLogSockets, 'no');
  assert.equal(serviceProperties.RestrictAddressFamilies, 'none');
  assert.match(serviceProperties.SystemCallFilter, /~@mount accept accept4 bind connect /);
  assert.match(serviceProperties.SystemCallFilter, / socket socketcall @aio(?: |$)/);
  assert.doesNotMatch(serviceProperties.SystemCallFilter, /(?:^| )socketpair(?: |$)/);
  assert.doesNotMatch(serviceProperties.SystemCallFilter, /(?:^| )shutdown(?: |$)/);
  assert.match(serviceProperties.SystemCallFilter, /(?:^| )@chown(?: |$)/);
  for (const syscall of [
    'chmod',
    'fchmod',
    'fchmodat',
    'fchmodat2',
    'io_uring_setup',
    'io_uring_enter',
    'io_uring_register',
    'setxattr',
    'lsetxattr',
    'fsetxattr',
    'removexattr',
    'lremovexattr',
    'fremovexattr',
    'utime',
    'utimes',
    'futimesat',
    'utimensat'
  ]) {
    assert.match(serviceProperties.SystemCallFilter, new RegExp(`(?:^| )${syscall}(?: |$)`));
  }
  assert.equal(
    serviceProperties.InaccessiblePaths,
    '/tmp /var/tmp'
  );
  assert.equal((unitText.match(/^PrivateIPC=yes$/gm) || []).length, 1);
  assert.equal((unitText.match(/^PrivatePIDs=yes$/gm) || []).length, 1);
  assert.equal((unitText.match(/^BindLogSockets=no$/gm) || []).length, 1);
  assert.equal((unitText.match(/^RestrictAddressFamilies=none$/gm) || []).length, 1);
  assert.doesNotMatch(unitText, /^RestrictAddressFamilies=.*AF_UNIX.*$/gm);
  assert.equal(
    (unitText.match(/^SystemCallFilter=~@mount accept accept4 bind connect .* socket socketcall @aio .*$/gm) || []).length,
    1
  );
  assert.equal(
    (unitText.match(
      /^InaccessiblePaths=\/tmp \/var\/tmp$/gm
    ) || []).length,
    1
  );
  assert.equal(
    serviceProperties.TemporaryFileSystem,
    [
      '/scratch:rw,nosuid,nodev,noexec,size=128M,mode=1777',
      '/dev/shm:ro,nosuid,nodev,noexec,size=1,mode=000',
      '/dev/mqueue:ro,nosuid,nodev,noexec,size=1,mode=000',
      '/dev/hugepages:ro,nosuid,nodev,noexec,size=1,mode=000',
      '/dev/pts:ro,nosuid,nodev,noexec,size=1,mode=000'
    ].join(' ')
  );
  assert.equal(serviceProperties.TimeoutStartUSec, '20s');
  assert.equal(Object.hasOwn(serviceProperties, 'RuntimeMaxUSec'), false);
  assert.equal(serviceProperties.LimitFSIZE, String(SANDBOX_LIMITS.outputBytes));
  assert.match(serviceProperties.Environment, /(?:^| )TMPDIR=\/scratch(?: |$)/);
  assert.match(serviceProperties.Environment, /(?:^| )TMP=\/scratch(?: |$)/);
  assert.match(serviceProperties.Environment, /(?:^| )TEMP=\/scratch(?: |$)/);
  assert.match(
    serviceProperties.BindReadOnlyPaths,
    /\/var\/lib\/turingmarket-parser\/jobs\/%i\/output:\/output/
  );
  assert.equal(
    serviceProperties.BindPaths,
    '/var/lib/turingmarket-parser/jobs/%i/output/result.json:/output/result.json'
  );
  assert.equal(serviceProperties.BindReadOnlyPaths.includes('/run/systemd/journal'), false);
  assert.equal(serviceProperties.BindReadOnlyPaths.includes('/dev/log'), false);
  assert.doesNotMatch(
    unitText,
    /^(?:BindPaths|BindReadOnlyPaths)=.*(?:\/run\/systemd\/journal|\/dev\/log).*$/gm
  );
  assert.ok(runtime.manifest.required_self_tests.includes('private_temp_write_denial'));
  assert.ok(runtime.manifest.required_self_tests.includes('dev_submount_write_denial'));
  assert.ok(runtime.manifest.required_self_tests.includes('writable_filesystem_inventory'));
  assert.ok(runtime.manifest.required_self_tests.includes('mount_isolation'));
  assert.ok(runtime.manifest.required_self_tests.includes('socket_creation_denial'));
  assert.ok(runtime.manifest.required_self_tests.includes('host_log_socket_denial'));
  assert.ok(runtime.manifest.required_self_tests.includes('aio_socket_bypass_denial'));
  assert.ok(runtime.manifest.required_self_tests.includes('pid_namespace_sibling_fd_denial'));
  assert.ok(runtime.manifest.required_self_tests.includes('result_inode_metadata_denial'));
  assert.ok(runtime.manifest.required_self_tests.includes('output_pressure'));
  assert.ok(runtime.manifest.required_self_tests.includes('xlsx_parsing'));
  assert.ok(runtime.manifest.required_self_tests.includes('pptx_parsing'));
  assert.ok(runtime.manifest.required_self_tests.includes('ocr_inference'));
  assert.equal(runtime.manifest.required_self_tests.length, 21);

  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-output-cap-'));
  const service = createUploadSandboxService({
    parserIdentity: TEST_PARSER_IDENTITY,
    spoolRoot
  });
  let job;
  try {
    job = await service.stageJob(await decodedCsv(), {
      ledgerId: 91,
      requestHash: 'a'.repeat(64),
      leaseToken: 'b'.repeat(64),
      route: 'parser.knowledge-upload'
    });
    fs.writeFileSync(
      path.join(job.outputRoot, 'result.json'),
      Buffer.alloc(SANDBOX_LIMITS.outputBytes + 1, 0x20)
    );
    await assert.rejects(
      validateParserOutput(job.outputRoot),
      (error) => error && error.code === 'UPLOAD_INVALID_CONTENT'
    );
  } finally {
    if (job) await service.cleanupJob(job);
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('writable filesystem audit rejects shared dev storage and proves the closed contract', async () => {
  const mountInfoText = [
    '31 20 0:31 / /scratch rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=131072k',
    '32 20 8:1 /jobs/id/output/result.json /output/result.json rw - ext4 /dev/sda1 rw',
    '33 20 0:32 / /dev/shm rw,nosuid,nodev - tmpfs tmpfs rw,size=65536k'
  ].join('\n');
  const writableDirectories = new Set(['/scratch', '/dev/shm']);
  const options = {
    mountInfoText,
    probeDirectoryWritable: async (target) => writableDirectories.has(target),
    probeExistingFileWritable: async (target) => target === '/output/result.json',
    inspectHostSocketPath: async () => false,
    probeSocketIsolation: async () => TEST_SOCKET_DENIAL_EVIDENCE,
    probeAioIsolation: async () => TEST_AIO_DENIAL_EVIDENCE,
    inspectPidNamespace: async () => TEST_PID_NAMESPACE_PROOF
  };

  await assert.rejects(
    auditWritableFilesystem(options),
    (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
  );

  writableDirectories.delete('/dev/shm');
  const proof = await auditWritableFilesystem(options);
  assert.equal(proof.version, 1);
  assert.equal(proof.contract, 'tm-parser-writable-filesystem-v1');
  assert.match(proof.mount_info_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(proof.allowed_writable_paths, ['/scratch', '/output/result.json']);
  assert.deepEqual(proof.unexpected_writable_paths, []);
  assert.deepEqual(proof.denied_write_paths, [
    '/dev',
    '/dev/hugepages',
    '/dev/mqueue',
    '/dev/pts',
    '/dev/shm',
    '/tmp',
    '/var/tmp'
  ]);
  assert.equal(proof.audited_rw_mounts, 3);
  assert.deepEqual(proof.aio_denial_evidence, TEST_AIO_DENIAL_EVIDENCE);
  assert.deepEqual(proof.pid_namespace, TEST_PID_NAMESPACE_PROOF);
});

test('socket audit rejects read-only host log sockets and requires policy-level denial', async () => {
  const mountInfoText = [
    '31 20 0:31 / /scratch rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=131072k',
    '32 20 8:1 /jobs/id/output/result.json /output/result.json rw - ext4 /dev/sda1 rw'
  ].join('\n');
  const hostLogSocketPaths = [
    '/dev/log',
    '/run/systemd/journal/dev-log',
    '/run/systemd/journal/socket',
    '/run/systemd/journal/stdout'
  ];
  const options = {
    mountInfoText,
    probeDirectoryWritable: async (target) => target === '/scratch',
    probeExistingFileWritable: async (target) => target === '/output/result.json',
    inspectHostSocketPath: async () => false,
    probeSocketIsolation: async () => TEST_SOCKET_DENIAL_EVIDENCE,
    probeAioIsolation: async () => TEST_AIO_DENIAL_EVIDENCE,
    inspectPidNamespace: async () => TEST_PID_NAMESPACE_PROOF
  };

  const proof = await auditWritableFilesystem(options);
  assert.equal(proof.socket_contract, 'tm-parser-no-sockets-v1');
  assert.deepEqual(proof.host_log_socket_paths, hostLogSocketPaths);
  assert.deepEqual(proof.present_host_log_socket_paths, []);
  assert.deepEqual(proof.host_log_socket_mounts, []);
  assert.deepEqual(proof.socket_denial_evidence, TEST_SOCKET_DENIAL_EVIDENCE);
  assert.deepEqual(proof.aio_denial_evidence, TEST_AIO_DENIAL_EVIDENCE);
  assert.deepEqual(proof.pid_namespace, TEST_PID_NAMESPACE_PROOF);

  await assert.rejects(
    auditWritableFilesystem({
      ...options,
      mountInfoText: `${mountInfoText}\n` +
        '33 20 0:32 / /run/systemd/journal/socket ro - tmpfs tmpfs ro'
    }),
    (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
  );
  await assert.rejects(
    auditWritableFilesystem({
      ...options,
      inspectHostSocketPath: async (target) => target === '/dev/log'
    }),
    (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
  );
  await assert.rejects(
    auditWritableFilesystem({
      ...options,
      probeSocketIsolation: async () => TEST_SOCKET_DENIAL_EVIDENCE.map((item) => (
        item.operation === 'abstract_af_unix_connect'
          ? { ...item, errno: 'ECONNREFUSED' }
          : item
      ))
    }),
    (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
  );
  await assert.rejects(
    auditWritableFilesystem({
      ...options,
      probeAioIsolation: async () => TEST_AIO_DENIAL_EVIDENCE.map((item) => (
        item.operation === 'io_uring_setup_socket_path'
          ? { ...item, errno: 'EINVAL' }
          : item
      ))
    }),
    (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
  );
  await assert.rejects(
    auditWritableFilesystem({
      ...options,
      inspectPidNamespace: async () => ({
        ...TEST_PID_NAMESPACE_PROOF,
        self_pid: 4812,
        visible_pids: [1, 4812]
      })
    }),
    (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
  );
});

test('deterministic parser runtime tree rejects transitive dependency byte drift', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-parser-runtime-tree-'));
  const dependencyRoot = path.join(
    runtimeRoot,
    'opt',
    'turingmarket-parser',
    'app',
    'node_modules',
    'transitive-package'
  );
  fs.mkdirSync(dependencyRoot, { recursive: true });
  const dependencyPath = path.join(dependencyRoot, 'index.js');
  fs.writeFileSync(dependencyPath, 'module.exports = "pinned";\n');
  try {
    const pinned = await inspectParserRuntimeTree(runtimeRoot, {
      requireRootOwnership: false
    });
    await verifyParserRuntimeTree(runtimeRoot, pinned, {
      requireRootOwnership: false
    });

    fs.writeFileSync(dependencyPath, 'module.exports = "drift!";\n');
    await assert.rejects(
      verifyParserRuntimeTree(runtimeRoot, pinned, {
        requireRootOwnership: false
      }),
      (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('parser pressure self-test protocol rejects unmounted or unknown probes', async () => {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-parser-pressure-'));
  const outputRoot = path.join(scratchRoot, 'output');
  const requestPath = path.join(scratchRoot, 'request.json');
  const inputPath = path.join(scratchRoot, 'input.bin');
  const jobId = 'f'.repeat(32);
  const manifest = {
    version: 2,
    files: [{ path: 'result.json', mime: 'application/json', max_bytes: SANDBOX_LIMITS.outputBytes }],
    total_writable_bytes: SANDBOX_LIMITS.outputBytes
  };
  fs.mkdirSync(outputRoot, { mode: 0o550 });
  fs.writeFileSync(inputPath, 'x');
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(outputRoot, 'result.json'), '', { mode: 0o600 });
  const args = [
    'worker', '--job-id', jobId, '--request', requestPath,
    '--input', inputPath, '--output-root', outputRoot
  ];
  try {
    fs.writeFileSync(requestPath, JSON.stringify({
      version: 1,
      job_id: jobId,
      self_test: 'unknown-pressure-v1'
    }));
    await assert.rejects(workerMain(args), (error) => error && error.code === 'UPLOAD_INVALID_CONTENT');

    for (const probe of ['scratch-pressure-v1', 'output-pressure-v1']) {
      fs.writeFileSync(requestPath, JSON.stringify({
        version: 1,
        job_id: jobId,
        self_test: probe
      }));
      fs.truncateSync(path.join(outputRoot, 'result.json'), 0);
      await assert.rejects(
        workerMain(args),
        (error) => error && error.code === 'UPLOAD_INVALID_CONTENT',
        probe
      );
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('pressure proof accepts only kernel limit outcomes', async () => {
  function fakeSpawn(code, signal = null) {
    return () => {
      const child = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => child.emit('close', code, signal));
      return child;
    };
  }
  for (const [code, errno] of [[73, 'EFBIG'], [74, 'ENOSPC'], [75, 'EDQUOT']]) {
    const proof = await runPressureProbe(
      'output-pressure-v1',
      '/output/result.json',
      1024,
      2048,
      { spawn: fakeSpawn(code) }
    );
    assert.deepEqual(proof, {
      contract: 'output-pressure-v1',
      denied: true,
      errno,
      limit_bytes: 1024,
      attempted_bytes: 2048
    });
  }
  await assert.rejects(
    runPressureProbe(
      'scratch-pressure-v1',
      '/scratch/probe',
      1024,
      2048,
      { spawn: fakeSpawn(70) }
    ),
    (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
  );
});

test('startup recovery runs before stale cgroup cleanup and leaves no job residue', async () => {
  const runtime = loadRuntimeManifest();
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-restart-'));
  const staleId = 'a'.repeat(32);
  const staleRoot = path.join(spoolRoot, staleId);
  fs.mkdirSync(path.join(staleRoot, 'output'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staleRoot, 'input.bin'), 'stale');
  const order = [];
  try {
    await assertUploadSandboxStartupReady({
      spoolRoot,
      expectedManifestSha256: runtime.manifestSha256,
      idempotency: {
        reserveProcessingInTransaction() {},
        completeAdmissionInTransaction() {},
        failInternalInTransaction() {}
      },
      verifyIdentity: async () => ({ ...runtime.manifest.identity, uid: 64123, gid: 64123 }),
      verifyInstalledArtifacts: async () => {},
      systemdVersion: async () => 257,
      systemctlShow: async (unit) => runtime.manifest.effective_properties[unit],
      recoverAdmissions: async () => { order.push('recover'); },
      staleUnitController: {
        async kill(unit) {
          assert.equal(unit, `turingmarket-parser@${staleId}.service`);
          order.push('kill');
        },
        async stop() { order.push('stop'); },
        async resetFailed() { order.push('reset'); },
        async assertCollected() { order.push('collected'); }
      },
      inspectSpoolBytes: async () => 0,
      statfs: statfsWithAvailableBytes(
        SANDBOX_LIMITS.freeFloorBytes + SANDBOX_LIMITS.reservationBytes
      ),
      runSelfTests: async () => Object.fromEntries(
        runtime.manifest.required_self_tests.map((name) => [name, true])
      )
    });
    assert.deepEqual(order, ['recover', 'kill', 'stop', 'reset', 'collected']);
    assert.deepEqual(fs.readdirSync(spoolRoot), []);
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('failed startup cgroup collection preserves stale residue and aborts readiness', async () => {
  const runtime = loadRuntimeManifest();
  const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-restart-collect-fail-'));
  const staleId = 'c'.repeat(32);
  const staleRoot = path.join(spoolRoot, staleId);
  fs.mkdirSync(path.join(staleRoot, 'output'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staleRoot, 'input.bin'), 'stale');
  const order = [];
  try {
    await assert.rejects(
      assertUploadSandboxStartupReady({
        spoolRoot,
        expectedManifestSha256: runtime.manifestSha256,
        idempotency: {
          reserveProcessingInTransaction() {},
          completeAdmissionInTransaction() {},
          failInternalInTransaction() {}
        },
        verifyIdentity: async () => ({ ...runtime.manifest.identity, uid: 64123, gid: 64123 }),
        verifyInstalledArtifacts: async () => {},
        systemdVersion: async () => 257,
        systemctlShow: async (unit) => runtime.manifest.effective_properties[unit],
        recoverAdmissions: async () => { order.push('recover'); },
        staleUnitController: {
          async kill() { order.push('kill'); },
          async stop() { order.push('stop'); },
          async resetFailed() { order.push('reset'); },
          async assertCollected() {
            order.push('collect-failed');
            throw new Error('nonempty ControlGroup');
          }
        },
        runSelfTests: async () => Object.fromEntries(
          runtime.manifest.required_self_tests.map((name) => [name, true])
        )
      }),
      (error) => error && error.code === 'UPLOAD_SANDBOX_NOT_READY'
    );
    assert.deepEqual(order, [
      'recover',
      'kill',
      'stop',
      'reset',
      'collect-failed'
    ]);
    assert.equal(fs.existsSync(staleRoot), true);
    assert.deepEqual(fs.readdirSync(staleRoot).sort(), ['input.bin', 'output']);
  } finally {
    fs.rmSync(spoolRoot, { recursive: true, force: true });
  }
});

test('sub-second expired or stolen admission never starts the parser unit', async () => {
  for (const reason of ['expired', 'stolen']) {
    const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tm-upload-prelaunch-${reason}-`));
    let startCalls = 0;
    let leaseChecks = 0;
    let failedAdmissions = 0;
    const systemd = {
      async start() { startCalls += 1; },
      async kill() {},
      async stop() {},
      async resetFailed() {},
      async assertCollected() {}
    };
    const service = createUploadSandboxService({
      parserIdentity: TEST_PARSER_IDENTITY,
      spoolRoot,
      systemd,
      failAdmission: async () => { failedAdmissions += 1; }
    });
    const admission = {
      ledgerId: 91,
      requestHash: 'a'.repeat(64),
      leaseToken: reason === 'expired' ? 'b'.repeat(64) : 'c'.repeat(64),
      route: 'parser.knowledge-upload'
    };
    try {
      const startedAt = Date.now();
      await assert.rejects(
        service.processUpload({
          multipart: await decodedCsv(),
          admission,
          assertAuthorized: async () => {},
          assertLeaseOwned: async (ownedAdmission) => {
            leaseChecks += 1;
            assert.strictEqual(ownedAdmission, admission);
            throw Object.assign(new Error(reason), {
              code: reason === 'expired'
                ? 'IDEMPOTENCY_DEADLINE_EXPIRED'
                : 'IDEMPOTENCY_IN_PROGRESS'
            });
          },
          finalize: async () => ({ ok: true })
        }),
        (error) => error && error.code === 'IDEMPOTENCY_IN_PROGRESS'
      );
      assert.ok(Date.now() - startedAt < 1000, reason);
      assert.equal(startCalls, 0, reason);
      assert.equal(leaseChecks, 1, reason);
      assert.equal(failedAdmissions, 1, reason);
      assert.deepEqual(fs.readdirSync(spoolRoot), [], reason);
    } finally {
      fs.rmSync(spoolRoot, { recursive: true, force: true });
    }
  }
});

test('provisioned Linux parser units pass systemd verification', {
  skip: process.platform !== 'linux' || process.env.TM_UPLOAD_SANDBOX_LINUX_E2E !== '1'
}, async () => {
  await runCommandNoDisclosure('/usr/bin/systemd-analyze', [
    'verify',
    path.join(__dirname, '..', 'systemd', 'turingmarket-parser.slice'),
    path.join(__dirname, '..', 'systemd', 'turingmarket-parser@.service')
  ], { timeoutMs: 30_000 });
});

test('systemd template properties are inspected through a non-running instance', () => {
  assert.equal(
    systemdInspectionUnitName('turingmarket-parser@.service'),
    'turingmarket-parser@test_instance.service'
  );
  assert.equal(
    systemdInspectionUnitName('turingmarket-parser.slice'),
    'turingmarket-parser.slice'
  );
  assert.throws(
    () => systemdInspectionUnitName('other-parser@.service'),
    /invalid parser systemd unit/
  );
});

test('systemd effective properties normalize only proven systemd expansions', () => {
  const runtime = loadRuntimeManifest();
  const expectedService = runtime.manifest.effective_properties[
    'turingmarket-parser@.service'
  ];
  const observedService = {
    ...expectedService,
    IPAddressDeny: '0.0.0.0/0 ::/0',
    RestrictAddressFamilies: '',
    SystemCallFilter: [
      'brk', 'close', 'execve', 'exit', 'exit_group', 'fstat',
      'mmap', 'mprotect', 'openat', 'read', 'shutdown', 'socketpair', 'write'
    ].join(' '),
    SystemCallErrorNumber: '1',
    BindReadOnlyPaths: [
      '/var/lib/turingmarket-parser/jobs/test_instance/input.bin:/input/input.bin:rbind',
      '/var/lib/turingmarket-parser/jobs/test_instance/request.json:/runtime/request.json:rbind',
      '/var/lib/turingmarket-parser/jobs/test_instance/output:/output:rbind'
    ].join(' '),
    BindPaths: '/var/lib/turingmarket-parser/jobs/test_instance/output/result.json:/output/result.json:rbind'
  };
  assert.deepEqual(
    normalizeSystemdEffectiveProperties(
      'turingmarket-parser@.service',
      observedService,
      expectedService
    ),
    expectedService
  );
  assert.throws(
    () => normalizeSystemdEffectiveProperties(
      'turingmarket-parser@.service',
      { ...observedService, SystemCallFilter: `${observedService.SystemCallFilter} socket` },
      expectedService
    ),
    /effective property drift/
  );
  assert.throws(
    () => normalizeSystemdEffectiveProperties(
      'turingmarket-parser@.service',
      { ...observedService, IPAddressDeny: '0.0.0.0/0' },
      expectedService
    ),
    /effective property drift/
  );

  const expectedSlice = runtime.manifest.effective_properties['turingmarket-parser.slice'];
  const observedSlice = { ...expectedSlice };
  delete observedSlice.CPUAccounting;
  assert.deepEqual(
    normalizeSystemdEffectiveProperties(
      'turingmarket-parser.slice',
      observedSlice,
      expectedSlice
    ),
    expectedSlice
  );
  assert.throws(
    () => normalizeSystemdEffectiveProperties(
      'turingmarket-parser.slice',
      { ...observedSlice, MemoryMax: '1073741824' },
      expectedSlice
    ),
    /effective property drift/
  );
});

test('real root parser unit exposes only scratch and the exact result inode', {
  skip: process.platform !== 'linux' ||
    process.env.TM_UPLOAD_SANDBOX_LINUX_E2E !== '1' ||
    process.getuid() !== 0,
  timeout: 120_000
}, async () => {
  const runtime = loadRuntimeManifest();
  await verifyInstalledParserArtifacts(runtime.manifest);
  const expectedService = runtime.manifest.effective_properties[
    'turingmarket-parser@.service'
  ];
  assert.equal(expectedService.BindLogSockets, 'no');
  assert.equal(expectedService.RestrictAddressFamilies, 'none');
  assert.equal(expectedService.PrivatePIDs, 'yes');
  assert.match(expectedService.SystemCallFilter, /~@mount accept accept4 bind connect /);
  assert.match(expectedService.SystemCallFilter, / socket socketcall @aio(?: |$)/);
  for (const [unitName, expected] of Object.entries(runtime.manifest.effective_properties)) {
    assert.deepEqual(await readSystemdProperties(unitName, expected), expected);
  }

  const uidResult = await runCommandNoDisclosure('/usr/bin/id', [
    '-u',
    'turingmarket-parser'
  ], { captureStdout: true, timeoutMs: 5_000 });
  const gidResult = await runCommandNoDisclosure('/usr/bin/id', [
    '-g',
    'turingmarket-parser'
  ], { captureStdout: true, timeoutMs: 5_000 });
  const service = createUploadSandboxService({
    parserIdentity: {
      uid: Number(uidResult.stdout.trim()),
      gid: Number(gidResult.stdout.trim())
    },
    spoolRoot: '/var/lib/turingmarket-parser/jobs'
  });
  let job;
  try {
    job = await service.stageJob(await decodedCsv(), {
      ledgerId: 1,
      requestHash: 'a'.repeat(64),
      leaseToken: 'b'.repeat(64),
      route: 'parser.knowledge-upload'
    });
    const requestBytes = Buffer.from(JSON.stringify({
      version: 1,
      job_id: job.id,
      self_test: 'writable-filesystem-v1'
    }), 'utf8');
    const requestFd = fs.openSync(job.requestPath, 'r+');
    try {
      fs.ftruncateSync(requestFd, 0);
      fs.writeSync(requestFd, requestBytes, 0, requestBytes.length, 0);
      fs.fsyncSync(requestFd);
    } finally {
      fs.closeSync(requestFd);
    }
    fs.chownSync(job.requestPath, 0, Number(gidResult.stdout.trim()));
    fs.chmodSync(job.requestPath, 0o440);

    await runCommandNoDisclosure('/usr/bin/systemctl', ['start', job.unitName], {
      timeoutMs: 30_000
    });
    assert.deepEqual(fs.readdirSync(job.outputRoot).sort(), ['manifest.json', 'result.json']);
    const result = JSON.parse(fs.readFileSync(job.resultPath, 'utf8'));
    assert.deepEqual(Object.keys(result).sort(), ['data', 'route', 'version']);
    assert.equal(result.version, 1);
    assert.equal(result.route, 'parser.sandbox-self-test');
    assert.equal(result.data.contract, 'tm-parser-writable-filesystem-v1');
    assert.equal(result.data.socket_contract, 'tm-parser-no-sockets-v1');
    assert.deepEqual(result.data.allowed_writable_paths, [
      '/scratch',
      '/output/result.json'
    ]);
    assert.deepEqual(result.data.unexpected_writable_paths, []);
    for (const target of [
      '/dev',
      '/dev/shm',
      '/dev/mqueue',
      '/dev/hugepages',
      '/dev/pts',
      '/tmp',
      '/var/tmp'
    ]) {
      assert.ok(result.data.denied_write_paths.includes(target), target);
    }
    assert.deepEqual(result.data.host_log_socket_mounts, []);
    assert.deepEqual(result.data.present_host_log_socket_paths, []);
    assert.deepEqual(result.data.host_log_socket_paths, [
      '/dev/log',
      '/run/systemd/journal/dev-log',
      '/run/systemd/journal/socket',
      '/run/systemd/journal/stdout'
    ]);
    assert.deepEqual(
      result.data.socket_denial_evidence.map((item) => item.operation),
      [
        'filesystem_af_unix_bind',
        'abstract_af_unix_connect',
        'journald_dev_log_send',
        'journald_native_send',
        'journald_stdout_send',
        'syslog_dev_log_send',
        'inet4_tcp_connect',
        'inet4_udp_connect',
        'inet6_tcp_connect'
      ]
    );
    for (const evidence of result.data.socket_denial_evidence) {
      assert.ok(
        ['EPERM', 'EACCES', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes(evidence.errno),
        `${evidence.operation}:${evidence.errno}`
      );
    }
    assert.deepEqual(
      result.data.aio_denial_evidence.map((item) => item.operation),
      [
        'io_uring_setup_socket_path',
        'io_uring_enter_socket_path',
        'io_uring_register_socket_path'
      ]
    );
    assert.ok(result.data.aio_denial_evidence.every((item) => item.errno === 'EPERM'));
    assert.deepEqual(result.data.pid_namespace, {
      contract: 'tm-parser-private-pids-v1',
      self_pid: 1,
      visible_pids: [1]
    });
    const resultMetadata = await inspectResultMetadata(job.resultPath);
    assert.equal(resultMetadata.isRegular, true);
    assert.equal(resultMetadata.uid, Number(uidResult.stdout.trim()));
    assert.equal(resultMetadata.gid, Number(gidResult.stdout.trim()));
    assert.equal(resultMetadata.mode, 0o600);
    assert.equal(resultMetadata.nlink, 1);
    assert.deepEqual(resultMetadata.xattrs, []);
    assert.ok(resultMetadata.mtimeMs >= job.resultMetadata.lifecycleStartedMs - 2_000);
    assert.ok(resultMetadata.ctimeMs >= job.resultMetadata.lifecycleStartedMs - 2_000);
    assert.ok(resultMetadata.mtimeMs <= Date.now() + 2_000);
    assert.ok(resultMetadata.ctimeMs <= Date.now() + 2_000);
  } finally {
    if (job) {
      await service.killJob(job);
      await service.cleanupJob(job);
    }
  }
});

test('concurrent root parser units cannot see or open sibling proc fds', {
  skip: process.platform !== 'linux' ||
    process.env.TM_UPLOAD_SANDBOX_LINUX_E2E !== '1' ||
    process.getuid() !== 0,
  timeout: 120_000
}, async () => {
  const runtime = loadRuntimeManifest();
  const versionResult = await runCommandNoDisclosure('/usr/bin/systemctl', ['--version'], {
    captureStdout: true,
    timeoutMs: 5_000
  });
  const versionMatch = /^systemd\s+([0-9]+)(?:\s|$)/m.exec(versionResult.stdout);
  assert.ok(versionMatch);
  assert.ok(Number(versionMatch[1]) >= runtime.manifest.minimum_systemd_version);

  const uidResult = await runCommandNoDisclosure('/usr/bin/id', [
    '-u',
    'turingmarket-parser'
  ], { captureStdout: true, timeoutMs: 5_000 });
  const gidResult = await runCommandNoDisclosure('/usr/bin/id', [
    '-g',
    'turingmarket-parser'
  ], { captureStdout: true, timeoutMs: 5_000 });
  const parserGid = Number(gidResult.stdout.trim());
  const service = createUploadSandboxService({
    parserIdentity: {
      uid: Number(uidResult.stdout.trim()),
      gid: parserGid
    },
    spoolRoot: '/var/lib/turingmarket-parser/jobs'
  });
  const jobs = [];
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const writePeerRequest = (job, peerPid) => {
    const bytes = Buffer.from(JSON.stringify({
      version: 1,
      job_id: job.id,
      self_test: 'pid-namespace-peer-v1',
      peer_pid: peerPid
    }), 'utf8');
    const fd = fs.openSync(job.requestPath, 'r+');
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, bytes, 0, bytes.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chownSync(job.requestPath, 0, parserGid);
    fs.chmodSync(job.requestPath, 0o440);
  };
  const waitForMainPid = async (unitName) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = await runCommandNoDisclosure('/usr/bin/systemctl', [
        'show',
        unitName,
        '--property=MainPID',
        '--value'
      ], { captureStdout: true, timeoutMs: 5_000 });
      const pid = Number(value.stdout.trim());
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
      await sleep(50);
    }
    assert.fail(`unit did not expose MainPID: ${unitName}`);
  };
  const waitForSuccess = async (unitName) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const value = await runCommandNoDisclosure('/usr/bin/systemctl', [
        'show',
        unitName,
        '--property=ActiveState,Result,ExecMainStatus'
      ], { captureStdout: true, timeoutMs: 5_000 });
      const properties = Object.fromEntries(value.stdout.trim().split(/\r?\n/).map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      if (properties.ActiveState === 'inactive') {
        assert.equal(properties.Result, 'success');
        assert.equal(properties.ExecMainStatus, '0');
        return;
      }
      assert.notEqual(properties.ActiveState, 'failed');
      await sleep(50);
    }
    assert.fail(`unit did not complete: ${unitName}`);
  };

  try {
    for (const marker of ['c', 'd']) {
      jobs.push(await service.stageJob(await decodedCsv(), {
        ledgerId: marker === 'c' ? 101 : 102,
        requestHash: marker.repeat(64),
        leaseToken: (marker === 'c' ? 'e' : 'f').repeat(64),
        route: 'parser.knowledge-upload'
      }));
    }
    writePeerRequest(jobs[0], 0);
    await runCommandNoDisclosure('/usr/bin/systemctl', [
      '--no-block',
      'start',
      jobs[0].unitName
    ], { timeoutMs: 5_000 });
    const firstPid = await waitForMainPid(jobs[0].unitName);

    writePeerRequest(jobs[1], firstPid);
    await runCommandNoDisclosure('/usr/bin/systemctl', [
      '--no-block',
      'start',
      jobs[1].unitName
    ], { timeoutMs: 5_000 });
    const secondPid = await waitForMainPid(jobs[1].unitName);
    assert.equal(fs.existsSync(`/proc/${firstPid}/fd`), true);
    assert.equal(fs.existsSync(`/proc/${secondPid}/fd`), true);
    writePeerRequest(jobs[0], secondPid);

    await Promise.all(jobs.map((job) => waitForSuccess(job.unitName)));
    const expectedPeers = [secondPid, firstPid];
    for (const [index, job] of jobs.entries()) {
      const result = JSON.parse(fs.readFileSync(job.resultPath, 'utf8'));
      const proof = result.data.sibling_pid_isolation;
      assert.equal(proof.contract, 'tm-parser-sibling-proc-fd-denial-v1');
      assert.equal(proof.peer_pid, expectedPeers[index]);
      assert.equal(proof.self_pid, 1);
      assert.deepEqual(proof.visible_pids, [1]);
      assert.deepEqual(proof.evidence.map((item) => item.operation), [
        'peer_proc_visibility',
        'peer_fd_directory_visibility',
        'peer_fd_read_open',
        'peer_fd_write_open'
      ]);
      assert.ok(proof.evidence.every((item) => ['ENOENT', 'ESRCH'].includes(item.errno)));
    }
  } finally {
    for (const job of jobs.reverse()) {
      await service.killJob(job).catch(() => {});
      await service.cleanupJob(job).catch(() => {});
    }
  }
});
