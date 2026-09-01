const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFeishuClient,
  FeishuClientError
} = require('../feishu_client');

function environment(overrides) {
  return Object.assign({
    FEISHU_SYNC_MODE: '',
    FEISHU_WEBHOOK_URL: '',
    FEISHU_WEBHOOK: '',
    FEISHU_WEBHOOK_TEST_URL: '',
    FEISHU_APP_ID: '',
    FEISHU_APP_SECRET: '',
    FEISHU_BITABLE_APP_TOKEN: '',
    FEISHU_BITABLE_TABLE_ID: ''
  }, overrides || {});
}

function okResponse(body, status) {
  return {
    ok: true,
    status: status || 200,
    async json() { return body || {}; }
  };
}

function failedResponse(status, body) {
  return {
    ok: false,
    status,
    async json() { return body || {}; }
  };
}

test('Feishu client reports unconfigured state without exposing configuration values', () => {
  const client = createFeishuClient({ env: environment() });

  assert.deepEqual(client.getStatus(), {
    configured: false,
    mode: 'unconfigured',
    sync_available: false,
    test_available: false,
    missing: ['FEISHU_WEBHOOK_URL_OR_BITABLE_CONFIG']
  });
  assert.doesNotMatch(JSON.stringify(client.getStatus()), /secret|token|https?:/i);
});

test('Feishu client detects incomplete Bitable configuration without falling back to an ambiguous provider', () => {
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basctest'
    })
  });

  assert.deepEqual(client.getStatus(), {
    configured: false,
    mode: 'bitable',
    sync_available: false,
    test_available: false,
    missing: ['FEISHU_BITABLE_TABLE_ID']
  });
});

test('Feishu webhook delivery preserves records and attaches no credentials to the public result', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({ FEISHU_SYNC_MODE: 'webhook', FEISHU_WEBHOOK_URL: 'https://feishu.example.test/hook' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return okResponse({});
    }
  });
  const records = [{ '网红频道名称': '@creator', '父记录': 'CRM-1' }];

  const result = await client.syncInfluencers({
    records,
    csv: '网红频道名称,父记录\n@creator,CRM-1\n',
    operationId: 'sync-test-1'
  });

  assert.deepEqual(result, {
    configured: true,
    mode: 'webhook',
    synced: 1,
    records: 1
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://feishu.example.test/hook');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'sync-test-1');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.event, 'turingmarket.influencers.sync');
  assert.equal(body.source, 'TuringMarket');
  assert.deepEqual(body.records, records);
  assert.match(body.csv, /@creator/);
  assert.doesNotMatch(JSON.stringify(result), /secret|https?:/i);
});

test('Feishu Bitable configuration preserves CSV fallback until a durable write contract is enabled', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test'
    }),
    fetchImpl: async (url, options) => { calls.push({ url, options }); throw new Error('not expected'); }
  });

  const result = await client.syncInfluencers({
    records: [{ '网红频道名称': '@bitable_creator', '父记录': 'CRM-2' }],
    csv: '网红频道名称,父记录\n@bitable_creator,CRM-2\n',
    operationId: 'sync-test-2'
  });

  assert.deepEqual(result, {
    configured: false,
    mode: 'bitable',
    records: 1,
    csv: '网红频道名称,父记录\n@bitable_creator,CRM-2\n',
    message: 'Feishu Bitable write is not enabled. CSV fallback is ready for manual upload.'
  });
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /test-secret|basc_test|tbl_test/i);
});

test('Feishu Bitable connection test acquires a tenant token and performs only a read-only table access check', async () => {
  let calls = 0;
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test'
    }),
    fetchImpl: async (url, options) => {
      calls += 1;
      if (calls === 1) return okResponse({ code: 0, tenant_access_token: 'tenant-test-token' });
      assert.match(url, /\/bitable\/v1\/apps\/basc_test\/tables\/tbl_test\/records\?page_size=1$/);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer tenant-test-token');
      return okResponse({ code: 0, data: { items: [] } });
    }
  });

  assert.deepEqual(client.getStatus(), {
    configured: true,
    mode: 'bitable',
    sync_available: false,
    test_available: true,
    missing: []
  });
  assert.deepEqual(await client.testConnection(), { configured: true, mode: 'bitable', ok: true });
  assert.equal(calls, 2);
});

test('Feishu Bitable connection test rejects an HTTP success response without Feishu success code', async () => {
  let calls = 0;
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test'
    }),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return okResponse({ code: 0, tenant_access_token: 'tenant-test-token' });
      return okResponse({ data: { items: [] } });
    }
  });

  await assert.rejects(
    client.testConnection(),
    (error) => error instanceof FeishuClientError && error.code === 'FEISHU_PROVIDER_REJECTED'
  );
  assert.equal(calls, 2);
});

test('Feishu connection test is non-mutating and normalizes provider failures', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({
      FEISHU_WEBHOOK_URL: 'https://feishu.example.test/live',
      FEISHU_WEBHOOK_TEST_URL: 'https://feishu.example.test/connection'
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return failedResponse(503, { message: 'private upstream diagnostic must not escape' });
    }
  });

  await assert.rejects(
    client.testConnection(),
    (error) => error instanceof FeishuClientError && error.code === 'FEISHU_PROVIDER_UNAVAILABLE'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://feishu.example.test/connection');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.event, 'turingmarket.feishu.connection_test');
  assert.deepEqual(body.records, []);
  assert.equal(Object.hasOwn(body, 'csv'), false);
});

test('Feishu client preserves CSV fallback for an unconfigured sync request', async () => {
  const client = createFeishuClient({ env: environment() });
  const result = await client.syncInfluencers({
    records: [{ '网红频道名称': '@fallback_creator' }],
    csv: '网红频道名称\n@fallback_creator\n'
  });

  assert.deepEqual(result, {
    configured: false,
    mode: 'unconfigured',
    records: 1,
    csv: '网红频道名称\n@fallback_creator\n',
    message: 'Feishu is not configured. CSV fallback is ready for manual upload.'
  });
});
