'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const express = require('express');

const contractPath = path.join(__dirname, '..', 'contracts', 'campaign_contract.js');
const pipelinePath = path.join(__dirname, '..', 'middleware', 'phase4_request_pipeline.js');

function loadBoundary() {
  return {
    contract: require(contractPath),
    pipeline: require(pipelinePath)
  };
}

function jsonMediaType(request) {
  const value = request.headers['content-type'];
  return typeof value === 'string' && /^application\/json(?:\s*;|$)/i.test(value.trim());
}

async function createHarness(options = {}) {
  const { contract, pipeline: pipelineModule } = loadBoundary();
  const registry = contract.createRoutePolicyRegistry();
  for (const policyName of options.policyNames || []) {
    registry.register(contract.REQUEST_POLICIES[policyName]);
  }

  const observations = {
    authentication: [],
    admission: [],
    multipartParses: 0,
    handled: 0
  };

  const authenticate = options.authenticate || (async (request) => {
    observations.authentication.push({
      data: request.listenerCount('data'),
      readable: request.listenerCount('readable')
    });
    return { id: 7, role: 'user' };
  });

  const admit = options.admit || (async (request) => {
    observations.admission.push({
      data: request.listenerCount('data'),
      readable: request.listenerCount('readable')
    });
    return true;
  });

  const parseMultipart = options.parseMultipart || (async (_request, rawBody) => {
    observations.multipartParses += 1;
    return {
      body: { multipart_bytes: rawBody.length },
      files: []
    };
  });

  const requestPipeline = pipelineModule.createPhase4RequestPipeline({
    registry,
    authenticate,
    admit,
    parseMultipart,
    generateRequestId: options.generateRequestId || (() => 'generated-request-0001'),
    bodyTimeoutMs: options.bodyTimeoutMs
  });

  const app = express();

  // This intentionally runs before the owned pipeline. Exact owned-route matching
  // must keep the global parser from attaching a listener before authentication.
  app.use(express.json({
    limit: '1kb',
    type(request) {
      return !requestPipeline.shouldSkipGlobalBodyParser(request) && jsonMediaType(request);
    }
  }));

  app.use(requestPipeline.middleware);
  app.use((request, response) => {
    observations.handled += 1;
    if (typeof options.handle === 'function') {
      return options.handle(request, response, observations);
    }
    return response.status(200).json({
      request_id: request.requestId || null,
      policy_id: request.phase4Request && request.phase4Request.policy.id,
      raw_bytes: request.phase4Request && request.phase4Request.rawBody
        ? request.phase4Request.rawBody.length
        : 0,
      body: request.body === undefined ? null : request.body
    });
  });

  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  return {
    contract,
    pipelineModule,
    registry,
    requestPipeline,
    observations,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

async function requestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      body = text;
    }
  }
  return { response, text, body };
}

function parseRawResponse(buffer) {
  const source = buffer.toString('utf8');
  const splitAt = source.indexOf('\r\n\r\n');
  assert.notEqual(splitAt, -1, `raw HTTP response must contain headers:\n${source}`);
  const headerLines = source.slice(0, splitAt).split('\r\n');
  const statusMatch = /^HTTP\/1\.[01] (\d{3})\b/.exec(headerLines.shift());
  assert.ok(statusMatch, `raw HTTP status line must be valid:\n${source}`);
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: Number(statusMatch[1]),
    headers,
    body: source.slice(splitAt + 4)
  };
}

function rawExchange(port, initialBytes, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw HTTP exchange timed out'));
    }, options.timeoutMs || 3000);
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    }

    socket.on('connect', () => {
      socket.write(initialBytes);
      if (Array.isArray(options.laterWrites)) {
        for (const write of options.laterWrites) {
          setTimeout(() => {
            if (!socket.destroyed) socket.write(write.bytes);
          }, write.afterMs);
        }
      }
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (chunks.length) return finish();
      clearTimeout(timer);
      reject(error);
    });
  });
}

function fixedRequest(requestPath, headers, body = '') {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const lines = [
    `POST ${requestPath} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: close',
    `Content-Length: ${bodyBuffer.length}`,
    ...headers,
    '',
    ''
  ];
  return Buffer.concat([Buffer.from(lines.join('\r\n')), bodyBuffer]);
}

function chunkedRequest(requestPath, headers, chunks) {
  const head = [
    `POST ${requestPath} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: close',
    'Transfer-Encoding: chunked',
    ...headers,
    '',
    ''
  ].join('\r\n');
  const frames = [Buffer.from(head)];
  for (const chunk of chunks) {
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    frames.push(Buffer.from(body.length.toString(16) + '\r\n'));
    frames.push(body);
    frames.push(Buffer.from('\r\n'));
  }
  frames.push(Buffer.from('0\r\n\r\n'));
  return Buffer.concat(frames);
}

test('request-boundary modules expose the reusable contract and pipeline interfaces', () => {
  assert.equal(fs.existsSync(contractPath), true, 'campaign request contract must exist');
  assert.equal(fs.existsSync(pipelinePath), true, 'Phase 4 request pipeline must exist');

  const { contract, pipeline } = loadBoundary();
  assert.equal(typeof contract.createRoutePolicyRegistry, 'function');
  assert.equal(typeof contract.isValidRequestId, 'function');
  assert.equal(typeof pipeline.createPhase4RequestPipeline, 'function');
  assert.equal(typeof pipeline.Phase4RequestError, 'function');
});

test('request contract freezes the exact raw-byte and multipart limits', () => {
  const { contract } = loadBoundary();

  assert.deepEqual(contract.BODY_LIMITS, {
    CAMPAIGN_CONTROL_JSON: 65_536,
    CAMPAIGN_REVIEW_JSON: 1_048_576,
    EXISTING_DUAL_MODE_JSON: 52_428_800,
    MULTIPART_ENVELOPE: 22_020_096
  });
  assert.deepEqual(contract.MULTIPART_LIMITS, {
    fileBytes: 15_728_640,
    files: 1,
    fields: 20,
    parts: 25,
    fieldBytes: 262_144
  });
  assert.equal(Object.isFrozen(contract.BODY_LIMITS), true);
  assert.equal(Object.isFrozen(contract.MULTIPART_LIMITS), true);

  assert.equal(
    contract.REQUEST_POLICIES.CAMPAIGN_CREATE.maxRawBytes,
    contract.BODY_LIMITS.CAMPAIGN_CONTROL_JSON
  );
  assert.equal(
    contract.REQUEST_POLICIES.CAMPAIGN_REVIEW_CREATE.maxRawBytes,
    contract.BODY_LIMITS.CAMPAIGN_REVIEW_JSON
  );
  assert.equal(
    contract.REQUEST_POLICIES.LEGACY_DEMAND_CREATE.maxRawBytes,
    contract.BODY_LIMITS.EXISTING_DUAL_MODE_JSON
  );
  for (const policyName of [
    'SHARED_KNOWLEDGE_UPLOAD',
    'SHARED_INFLUENCER_UPLOAD',
    'SHARED_DEMAND_PARSE_FILE'
  ]) {
    assert.equal(
      contract.REQUEST_POLICIES[policyName].maxRawBytes,
      contract.BODY_LIMITS.MULTIPART_ENVELOPE
    );
    assert.deepEqual(
      contract.REQUEST_POLICIES[policyName].multipartLimits,
      contract.MULTIPART_LIMITS
    );
  }
});

test('owned-route matching is method and path exact and future policies stay inactive until registered', () => {
  const { contract } = loadBoundary();
  const registry = contract.createRoutePolicyRegistry();

  assert.equal(registry.match('POST', '/api/campaigns'), null);
  assert.equal(registry.match('POST', '/api/campaigns/7/reviews'), null);

  registry.register(contract.REQUEST_POLICIES.CAMPAIGN_CREATE);
  assert.equal(registry.match('POST', '/api/campaigns').id, 'campaign.create');
  assert.equal(registry.match('POST', '/api/campaigns?source=ui').id, 'campaign.create');
  assert.equal(registry.match('GET', '/api/campaigns'), null);
  assert.equal(registry.match('POST', '/api/campaigns/'), null);
  assert.equal(registry.match('POST', '/api/campaigns-extra'), null);
  assert.equal(registry.match('POST', '/api/campaigns/7'), null);
  assert.equal(registry.match('POST', '/api/campaigns/7/reviews'), null);

  registry.register(contract.REQUEST_POLICIES.CAMPAIGN_DETAIL);
  assert.equal(registry.match('GET', '/api/campaigns/7').id, 'campaign.detail');
  assert.equal(registry.match('HEAD', '/api/campaigns/7').id, 'campaign.detail');
  assert.equal(registry.match('GET', '/api/campaigns/07'), null);
  assert.equal(registry.match('GET', '/api/campaigns/0'), null);
  assert.equal(registry.match('GET', '/api/campaigns/+7'), null);
  assert.equal(registry.match('GET', '/api/campaigns/7.0'), null);
  assert.equal(registry.match('GET', '/api/campaigns/9007199254740992'), null);

  assert.throws(
    () => registry.register(contract.REQUEST_POLICIES.CAMPAIGN_CREATE),
    /already registered/i
  );
});

test('request IDs accept exact printable ASCII bounds, echo valid input, and generate deterministic fallbacks', async () => {
  const harness = await createHarness({
    policyNames: ['CAMPAIGN_LIST'],
    generateRequestId: () => 'generated-request-0001'
  });

  try {
    const { contract } = harness;
    assert.equal(contract.isValidRequestId('12345678'), true);
    assert.equal(contract.isValidRequestId('x'.repeat(120)), true);
    assert.equal(contract.isValidRequestId('1234567'), false);
    assert.equal(contract.isValidRequestId('x'.repeat(121)), false);
    assert.equal(contract.isValidRequestId('valid id'), true);
    assert.equal(contract.isValidRequestId('bad\u007fid'), false);
    assert.equal(contract.isValidRequestId('bad\nid00'), false);
    assert.equal(contract.isValidRequestId('请求编号-0001'), false);

    const supplied = await requestJson(harness.baseUrl, '/api/campaigns', {
      headers: { 'X-Request-Id': 'client-request-0001' }
    });
    assert.equal(supplied.response.status, 200);
    assert.equal(supplied.response.headers.get('x-request-id'), 'client-request-0001');
    assert.equal(supplied.body.request_id, 'client-request-0001');

    const generated = await requestJson(harness.baseUrl, '/api/campaigns');
    assert.equal(generated.response.status, 200);
    assert.equal(generated.response.headers.get('x-request-id'), 'generated-request-0001');
    assert.equal(generated.body.request_id, 'generated-request-0001');

    const invalid = await requestJson(harness.baseUrl, '/api/campaigns', {
      headers: { 'X-Request-Id': 'short' }
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.response.headers.get('x-request-id'), 'generated-request-0001');
    assert.deepEqual(invalid.body, {
      error: 'Invalid X-Request-Id',
      code: 'INVALID_REQUEST_ID',
      request_id: 'generated-request-0001'
    });
  } finally {
    await harness.close();
  }
});

test('authentication runs before every body listener and unread 401 responses are JSON with Connection close', async () => {
  let authObservation;
  let admissionCalls = 0;
  const harness = await createHarness({
    policyNames: ['CAMPAIGN_CREATE'],
    authenticate: async (request) => {
      authObservation = {
        data: request.listenerCount('data'),
        readable: request.listenerCount('readable'),
        parsedBody: request.body
      };
      return null;
    },
    admit: async () => {
      admissionCalls += 1;
    }
  });

  try {
    const request = fixedRequest(
      '/api/campaigns',
      [
        'Content-Type: application/json',
        'X-Request-Id: auth-first-request'
      ],
      '{"name":"must-not-parse"}'
    );
    const raw = parseRawResponse(await rawExchange(harness.port, request));

    assert.equal(raw.status, 401);
    assert.equal(raw.headers.connection.toLowerCase(), 'close');
    assert.equal(raw.headers['x-request-id'], 'auth-first-request');
    assert.deepEqual(JSON.parse(raw.body), {
      error: 'Authentication required',
      code: 'AUTHENTICATION_REQUIRED',
      request_id: 'auth-first-request'
    });
    assert.deepEqual(authObservation, {
      data: 0,
      readable: 0,
      parsedBody: undefined
    });
    assert.equal(admissionCalls, 0);
    assert.equal(harness.observations.handled, 0);
  } finally {
    await harness.close();
  }
});

test('admission runs after auth but before multipart listeners for fixed and chunked bodies and creates zero temp files', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-boundary-'));
  let parserCalls = 0;
  const harness = await createHarness({
    policyNames: ['SHARED_KNOWLEDGE_UPLOAD'],
    admit: async (request) => {
      harness.observations.admission.push({
        data: request.listenerCount('data'),
        readable: request.listenerCount('readable')
      });
      throw new harness.pipelineModule.Phase4RequestError(
        429,
        'IDEMPOTENCY_RATE_LIMITED',
        'Request admission limit reached'
      );
    },
    parseMultipart: async () => {
      parserCalls += 1;
      fs.writeFileSync(path.join(tempRoot, 'unexpected-upload.tmp'), 'unexpected');
      return { body: {}, files: [] };
    }
  });

  try {
    const headers = [
      'Authorization: Bearer accepted-by-test',
      'Content-Type: multipart/form-data; boundary=phase4-boundary',
      'X-Request-Id: admission-fixed-001'
    ];
    const fixed = parseRawResponse(await rawExchange(
      harness.port,
      fixedRequest('/api/knowledge/upload', headers, '--phase4-boundary--\r\n')
    ));
    assert.equal(fixed.status, 429);
    assert.equal(fixed.headers.connection.toLowerCase(), 'close');
    assert.equal(JSON.parse(fixed.body).code, 'IDEMPOTENCY_RATE_LIMITED');

    const chunked = parseRawResponse(await rawExchange(
      harness.port,
      chunkedRequest(
        '/api/knowledge/upload',
        headers.filter((header) => !/^X-Request-Id:/i.test(header)).concat(
          'X-Request-Id: admission-chunked-01'
        ),
        ['--phase4-', 'boundary--\r\n']
      )
    ));
    assert.equal(chunked.status, 429);
    assert.equal(chunked.headers.connection.toLowerCase(), 'close');
    assert.equal(JSON.parse(chunked.body).code, 'IDEMPOTENCY_RATE_LIMITED');

    assert.equal(parserCalls, 0);
    assert.equal(harness.observations.handled, 0);
    assert.deepEqual(harness.observations.admission, [
      { data: 0, readable: 0 },
      { data: 0, readable: 0 }
    ]);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    await harness.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('media matrix accepts JSON parameters and exact empty-body compatibility while rejecting unsupported media', async () => {
  const harness = await createHarness({
    policyNames: [
      'CAMPAIGN_CREATE',
      'CAMPAIGN_LIST',
      'KNOWLEDGE_USE',
      'CUSTOMER_DELETE',
      'SHARED_KNOWLEDGE_UPLOAD'
    ]
  });

  try {
    const json = await requestJson(harness.baseUrl, '/api/campaigns', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'Application/JSON; Charset=UTF-8'
      },
      body: '{"name":"Campaign"}'
    });
    assert.equal(json.response.status, 200);
    assert.deepEqual(json.body.body, { name: 'Campaign' });

    for (const headers of [
      { Authorization: 'Bearer accepted-by-test' },
      {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'text/plain'
      }
    ]) {
      const rejected = await requestJson(harness.baseUrl, '/api/campaigns', {
        method: 'POST',
        headers,
        body: '{}'
      });
      assert.equal(rejected.response.status, 415);
      assert.equal(rejected.body.code, 'UNSUPPORTED_MEDIA_TYPE');
      assert.deepEqual(Object.keys(rejected.body), ['error', 'code', 'request_id']);
    }

    for (const headers of [
      { Authorization: 'Bearer accepted-by-test' },
      {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'application/json'
      }
    ]) {
      const emptyGet = await requestJson(harness.baseUrl, '/api/campaigns', { headers });
      assert.equal(emptyGet.response.status, 200);

      const emptyUse = await requestJson(harness.baseUrl, '/api/knowledge/7/use', {
        method: 'POST',
        headers
      });
      assert.equal(emptyUse.response.status, 200);
    }

    const emptyDelete = await requestJson(harness.baseUrl, '/api/customers/7', {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'application/json'
      }
    });
    assert.equal(emptyDelete.response.status, 200);

    const wrongEmptyMedia = await requestJson(harness.baseUrl, '/api/campaigns', {
      headers: {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'text/plain'
      }
    });
    assert.equal(wrongEmptyMedia.response.status, 415);
    assert.equal(wrongEmptyMedia.body.code, 'UNSUPPORTED_MEDIA_TYPE');

    const nonEmptyUse = await requestJson(harness.baseUrl, '/api/knowledge/7/use', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(nonEmptyUse.response.status, 400);
    assert.equal(nonEmptyUse.body.code, 'INVALID_REQUEST_BODY');

    const nonEmptyWrongMedia = await requestJson(harness.baseUrl, '/api/knowledge/7/use', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'text/plain'
      },
      body: 'x'
    });
    assert.equal(nonEmptyWrongMedia.response.status, 400);
    assert.equal(nonEmptyWrongMedia.body.code, 'INVALID_REQUEST_BODY');

    const validMultipart = await requestJson(harness.baseUrl, '/api/knowledge/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'multipart/form-data; boundary="phase4-test-boundary"'
      },
      body: '--phase4-test-boundary--\r\n'
    });
    assert.equal(validMultipart.response.status, 200);
    assert.equal(validMultipart.body.body.multipart_bytes, 26);

    for (const contentType of [
      'multipart/form-data',
      'application/json'
    ]) {
      const invalidMultipart = await requestJson(harness.baseUrl, '/api/knowledge/upload', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer accepted-by-test',
          'Content-Type': contentType
        },
        body: 'body'
      });
      assert.equal(invalidMultipart.response.status, 415);
      assert.equal(invalidMultipart.body.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
  } finally {
    await harness.close();
  }
});

test('fixed and chunked JSON enforce the exact inclusive campaign-control byte boundary', async () => {
  const harness = await createHarness({
    policyNames: ['CAMPAIGN_CREATE']
  });

  try {
    const limit = harness.contract.BODY_LIMITS.CAMPAIGN_CONTROL_JSON;
    const prefix = '{"value":"';
    const suffix = '"}';
    const exactBody = prefix + 'x'.repeat(limit - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
    assert.equal(Buffer.byteLength(exactBody), limit);

    const exact = await requestJson(harness.baseUrl, '/api/campaigns', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer accepted-by-test',
        'Content-Type': 'application/json'
      },
      body: exactBody
    });
    assert.equal(exact.response.status, 200);
    assert.equal(exact.body.raw_bytes, limit);
    assert.equal(exact.body.body.value.length, limit - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));

    const oversizedHeader = [
      'POST /api/campaigns HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: close',
      'Authorization: Bearer accepted-by-test',
      'Content-Type: application/json',
      'X-Request-Id: fixed-oversize-0001',
      `Content-Length: ${limit + 1}`,
      '',
      ''
    ].join('\r\n');
    const fixedRejected = parseRawResponse(await rawExchange(harness.port, oversizedHeader));
    assert.equal(fixedRejected.status, 413);
    assert.equal(fixedRejected.headers.connection.toLowerCase(), 'close');
    assert.equal(JSON.parse(fixedRejected.body).code, 'INVALID_REQUEST_BODY');

    const chunkedAccepted = parseRawResponse(await rawExchange(
      harness.port,
      chunkedRequest(
        '/api/campaigns',
        [
          'Authorization: Bearer accepted-by-test',
          'Content-Type: application/json',
          'X-Request-Id: chunked-accepted-01'
        ],
        ['{"ok":', 'true}']
      )
    ));
    assert.equal(chunkedAccepted.status, 200);
    assert.equal(JSON.parse(chunkedAccepted.body).body.ok, true);

    const chunkedRejected = parseRawResponse(await rawExchange(
      harness.port,
      chunkedRequest(
        '/api/campaigns',
        [
          'Authorization: Bearer accepted-by-test',
          'Content-Type: application/json',
          'X-Request-Id: chunked-oversize-01'
        ],
        [Buffer.alloc(limit, 0x20), Buffer.from('xx')]
      ),
      { timeoutMs: 5000 }
    ));
    assert.equal(chunkedRejected.status, 413);
    assert.equal(chunkedRejected.headers.connection.toLowerCase(), 'close');
    assert.equal(JSON.parse(chunkedRejected.body).code, 'INVALID_REQUEST_BODY');
  } finally {
    await harness.close();
  }
});

test('slow and disconnected bodies terminate without handler work or temporary files', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-phase4-slow-'));
  const unauthorized = await createHarness({
    policyNames: ['CAMPAIGN_CREATE'],
    authenticate: async () => null
  });

  try {
    const slowHead = [
      'POST /api/campaigns HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: close',
      'Content-Type: application/json',
      'Content-Length: 100',
      'X-Request-Id: slow-unauth-0001',
      '',
      ''
    ].join('\r\n');
    const startedAt = Date.now();
    const rejected = parseRawResponse(await rawExchange(unauthorized.port, slowHead, {
      timeoutMs: 1000
    }));
    assert.equal(rejected.status, 401);
    assert.equal(Date.now() - startedAt < 750, true, 'auth rejection must not wait for a slow body');
    assert.equal(unauthorized.observations.handled, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    await unauthorized.close();
  }

  const timed = await createHarness({
    policyNames: ['CAMPAIGN_CREATE'],
    bodyTimeoutMs: 50
  });
  try {
    const slowHead = [
      'POST /api/campaigns HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: close',
      'Authorization: Bearer accepted-by-test',
      'Content-Type: application/json',
      'Content-Length: 100',
      'X-Request-Id: slow-auth-000001',
      '',
      ''
    ].join('\r\n');
    const timedOut = parseRawResponse(await rawExchange(timed.port, slowHead, {
      timeoutMs: 1000
    }));
    assert.equal(timedOut.status, 408);
    assert.equal(timedOut.headers.connection.toLowerCase(), 'close');
    assert.equal(JSON.parse(timedOut.body).code, 'REQUEST_BODY_TIMEOUT');
    assert.equal(timed.observations.handled, 0);

    const socket = net.createConnection({ host: '127.0.0.1', port: timed.port });
    await once(socket, 'connect');
    socket.write([
      'POST /api/campaigns HTTP/1.1',
      'Host: 127.0.0.1',
      'Authorization: Bearer accepted-by-test',
      'Content-Type: application/json',
      'Content-Length: 100',
      'X-Request-Id: disconnect-body-01',
      '',
      '{"'
    ].join('\r\n'));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(timed.observations.handled, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    await timed.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
