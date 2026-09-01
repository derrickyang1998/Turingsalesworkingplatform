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
    FEISHU_BITABLE_TABLE_ID: '',
    FEISHU_BITABLE_WRITE_ENABLED: '',
    FEISHU_BITABLE_INCLUDE_CONTACT_EMAIL: ''
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

const APPROVED_BITABLE_FIELDS = [
  '日期', '提报人', '项目&客户', '推广产品', '是否重复', '网红频道名称', '网红粉丝量', '网红频道链接',
  '社媒平台', '国家', '网红类型', '近10个视频均播', '网红成本价格（折算美元）', '网红交付物（植入-完播等信息）',
  'Turing备注', '对外商务报价（美元）', '网红联系方式', 'CPM（自动计算）', 'CPV(自动计算)', '父记录'
];

function bitableFieldsResponse(fieldNames) {
  return okResponse({
    code: 0,
    data: { items: (fieldNames || APPROVED_BITABLE_FIELDS).map(function(fieldName) { return { field_name: fieldName }; }) }
  });
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

test('Feishu Bitable batch delivery requires an explicit write gate and a UUID idempotency key', async () => {
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test',
      FEISHU_BITABLE_WRITE_ENABLED: 'true'
    }),
    fetchImpl: async function() { throw new Error('not expected'); }
  });

  assert.equal(client.getStatus().sync_available, true);
  await assert.rejects(
    client.syncInfluencers({
      records: [{ '网红频道名称': '@creator' }],
      csv: '网红频道名称\n@creator\n',
      operationId: 'm4-collaboration-123'
    }),
    function(error) {
      return error instanceof FeishuClientError && error.code === 'FEISHU_IDEMPOTENCY_REQUIRED' && error.statusCode === 400;
    }
  );
});

test('Feishu Bitable batch delivery preflights the approved fields and strips contact data by default', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test',
      FEISHU_BITABLE_WRITE_ENABLED: 'true'
    }),
    fetchImpl: async function(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) return okResponse({ code: 0, tenant_access_token: 'tenant-test-token' });
      if (calls.length === 2) {
        return bitableFieldsResponse();
      }
      return okResponse({ code: 0, data: { records: [{ record_id: 'rec_test_1' }] } });
    }
  });

  const result = await client.syncInfluencers({
    records: [{
      '日期': '2026-09-01',
      '网红频道名称': '@creator',
      '网红频道链接': 'https://example.com/creator',
      '网红联系方式': 'creator@example.com',
      '父记录': 'CRM-101',
      'private_field': 'must-not-leak'
    }],
    csv: '网红频道名称\n@creator\n',
    operationId: 'd6c42da2-1c45-45db-9cbe-1bd06d5250b5'
  });

  assert.deepEqual(result, { configured: true, mode: 'bitable', synced: 1, records: 1 });
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /\/bitable\/v1\/apps\/basc_test\/tables\/tbl_test\/fields\?page_size=100$/);
  assert.equal(calls[1].options.method, 'GET');
  assert.match(calls[2].url, /\/bitable\/v1\/apps\/basc_test\/tables\/tbl_test\/records\/batch_create$/);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer tenant-test-token');
  const body = JSON.parse(calls[2].options.body);
  assert.equal(body.client_token, 'd6c42da2-1c45-45db-9cbe-1bd06d5250b5');
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].fields['网红频道名称'], '@creator');
  assert.equal(body.records[0].fields['父记录'], 'CRM-101');
  assert.equal(Object.hasOwn(body.records[0].fields, '网红联系方式'), false);
  assert.equal(Object.hasOwn(body.records[0].fields, 'private_field'), false);
  assert.doesNotMatch(JSON.stringify(result), /test-secret|tenant-test-token|rec_test_1/i);
});

test('Feishu Bitable delivery sends the prebuilt outbox snapshot without re-projecting changed source rows', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test',
      FEISHU_BITABLE_WRITE_ENABLED: 'true'
    }),
    fetchImpl: async function(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) return okResponse({ code: 0, tenant_access_token: 'tenant-test-token' });
      if (calls.length === 2) return bitableFieldsResponse();
      return okResponse({ code: 0, data: { records: [{ record_id: 'rec_snapshot_1' }] } });
    }
  });
  const operationId = 'f58f171f-71b8-4dda-84dd-7d27e43ef5f5';
  const sourceRecords = [{
    '网红频道名称': '@snapshot_creator',
    '网红频道链接': 'https://example.com/snapshot',
    '父记录': 'CRM-101'
  }];
  const snapshot = client.prepareBitableOutboxPayload({ records: sourceRecords, operationId });
  sourceRecords[0]['网红频道名称'] = '@changed_after_reservation';

  const result = await client.syncInfluencers({
    records: sourceRecords,
    csv: '网红频道名称\n@snapshot_creator\n',
    operationId,
    bitableRecords: snapshot.records,
    includeReceipt: true
  });

  assert.deepEqual(result.remoteRecordIds, ['rec_snapshot_1']);
  const body = JSON.parse(calls[2].options.body);
  assert.deepEqual(body.records, snapshot.records);
  assert.equal(body.records[0].fields['网红频道名称'], '@snapshot_creator');
});

test('Feishu Bitable batch delivery rejects a response that repeats one remote record ID', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test',
      FEISHU_BITABLE_WRITE_ENABLED: 'true'
    }),
    fetchImpl: async function(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) return okResponse({ code: 0, tenant_access_token: 'tenant-test-token' });
      if (calls.length === 2) return bitableFieldsResponse();
      return okResponse({
        code: 0,
        data: { records: [{ record_id: 'rec_duplicate' }, { record_id: 'rec_duplicate' }] }
      });
    }
  });

  await assert.rejects(
    client.syncInfluencers({
      records: [{ '网红频道名称': '@creator-one' }, { '网红频道名称': '@creator-two' }],
      csv: '网红频道名称\n@creator-one\n@creator-two\n',
      operationId: 'fd1d679a-6a69-4f93-b431-e78f11ad578b'
    }),
    function(error) {
      return error instanceof FeishuClientError && error.code === 'FEISHU_WRITE_RESULT_INCOMPLETE';
    }
  );
  assert.equal(calls.length, 3);
});

test('Feishu Bitable batch delivery requires the full remote template even when contact values are withheld', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test',
      FEISHU_BITABLE_WRITE_ENABLED: 'true'
    }),
    fetchImpl: async function(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) return okResponse({ code: 0, tenant_access_token: 'tenant-test-token' });
      return bitableFieldsResponse(APPROVED_BITABLE_FIELDS.filter(function(fieldName) { return fieldName !== '网红联系方式'; }));
    }
  });

  await assert.rejects(
    client.syncInfluencers({
      records: [{ '网红频道名称': '@creator' }],
      csv: '网红频道名称\n@creator\n',
      operationId: 'd36cfaf8-f15d-4d61-aae3-76a4c829b3df'
    }),
    function(error) {
      return error instanceof FeishuClientError && error.code === 'FEISHU_BITABLE_SCHEMA_MISMATCH' && error.statusCode === 409;
    }
  );
  assert.equal(calls.length, 2);
});

test('Feishu Bitable batch delivery rejects a nonnumeric logical success code', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test',
      FEISHU_BITABLE_WRITE_ENABLED: 'true'
    }),
    fetchImpl: async function(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) return okResponse({ code: 0, tenant_access_token: 'tenant-test-token' });
      if (calls.length === 2) return bitableFieldsResponse();
      return okResponse({ code: false, data: { records: [{ record_id: 'rec_test_1' }] } });
    }
  });

  await assert.rejects(
    client.syncInfluencers({
      records: [{ '网红频道名称': '@creator' }],
      csv: '网红频道名称\n@creator\n',
      operationId: '7f639498-3429-45ea-ae2b-abf1d8cda9d4'
    }),
    function(error) {
      return error instanceof FeishuClientError && error.code === 'FEISHU_PROVIDER_REJECTED' && error.statusCode === 502;
    }
  );
  assert.equal(calls.length, 3);
});

test('Feishu Bitable batch delivery stops before create when a required remote field is missing', async () => {
  const calls = [];
  const client = createFeishuClient({
    env: environment({
      FEISHU_SYNC_MODE: 'bitable',
      FEISHU_APP_ID: 'cli_test_app',
      FEISHU_APP_SECRET: 'test-secret',
      FEISHU_BITABLE_APP_TOKEN: 'basc_test',
      FEISHU_BITABLE_TABLE_ID: 'tbl_test',
      FEISHU_BITABLE_WRITE_ENABLED: 'true'
    }),
    fetchImpl: async function(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) return okResponse({ code: 0, tenant_access_token: 'tenant-test-token' });
      return okResponse({ code: 0, data: { items: [{ field_name: '网红频道名称' }] } });
    }
  });

  await assert.rejects(
    client.syncInfluencers({
      records: [{ '网红频道名称': '@creator' }],
      csv: '网红频道名称\n@creator\n',
      operationId: '70a829e1-e764-4a51-944b-b4f165c1ea95'
    }),
    function(error) {
      return error instanceof FeishuClientError && error.code === 'FEISHU_BITABLE_SCHEMA_MISMATCH' && error.statusCode === 409;
    }
  );
  assert.equal(calls.length, 2);
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
