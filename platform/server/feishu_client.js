const FEISHU_API_ORIGIN = 'https://open.feishu.cn/open-apis';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BITABLE_BATCH_RECORDS = 500;
const BITABLE_CONTACT_FIELD = '网红联系方式';
const BITABLE_TEMPLATE_FIELDS = [
  '日期',
  '提报人',
  '项目&客户',
  '推广产品',
  '是否重复',
  '网红频道名称',
  '网红粉丝量',
  '网红频道链接',
  '社媒平台',
  '国家',
  '网红类型',
  '近10个视频均播',
  '网红成本价格（折算美元）',
  '网红交付物（植入-完播等信息）',
  'Turing备注',
  '对外商务报价（美元）',
  BITABLE_CONTACT_FIELD,
  'CPM（自动计算）',
  'CPV(自动计算)',
  '父记录'
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class FeishuClientError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'FeishuClientError';
    this.code = code;
    this.statusCode = statusCode || 502;
  }
}

function readEnvironmentValue(env, name) {
  const value = env && Object.prototype.hasOwnProperty.call(env, name) ? env[name] : '';
  return typeof value === 'string' ? value.trim() : '';
}

function readEnvironmentBoolean(env, name) {
  return ['1', 'true', 'yes', 'on'].indexOf(readEnvironmentValue(env, name).toLowerCase()) !== -1;
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'webhook' || mode === 'bitable') return mode;
  return '';
}

function hasAnyBitableSetting(settings) {
  return settings.appId || settings.appSecret || settings.appToken || settings.tableId;
}

function resolveConfiguration(env) {
  const requestedMode = normalizeMode(readEnvironmentValue(env, 'FEISHU_SYNC_MODE'));
  const webhookUrl = readEnvironmentValue(env, 'FEISHU_WEBHOOK_URL') || readEnvironmentValue(env, 'FEISHU_WEBHOOK');
  const webhookTestUrl = readEnvironmentValue(env, 'FEISHU_WEBHOOK_TEST_URL');
  const bitable = {
    appId: readEnvironmentValue(env, 'FEISHU_APP_ID'),
    appSecret: readEnvironmentValue(env, 'FEISHU_APP_SECRET'),
    appToken: readEnvironmentValue(env, 'FEISHU_BITABLE_APP_TOKEN'),
    tableId: readEnvironmentValue(env, 'FEISHU_BITABLE_TABLE_ID'),
    writeEnabled: readEnvironmentBoolean(env, 'FEISHU_BITABLE_WRITE_ENABLED'),
    includeContactEmail: readEnvironmentBoolean(env, 'FEISHU_BITABLE_INCLUDE_CONTACT_EMAIL')
  };

  let mode = requestedMode;
  if (!mode) {
    if (webhookUrl && hasAnyBitableSetting(bitable)) mode = 'unconfigured';
    else if (webhookUrl) mode = 'webhook';
    else if (hasAnyBitableSetting(bitable)) mode = 'bitable';
    else mode = 'unconfigured';
  }

  if (mode === 'webhook') {
    return {
      mode,
      configured: Boolean(webhookUrl),
      missing: webhookUrl ? [] : ['FEISHU_WEBHOOK_URL'],
      webhookUrl,
      webhookTestUrl
    };
  }

  if (mode === 'bitable') {
    const missing = [];
    if (!bitable.appId) missing.push('FEISHU_APP_ID');
    if (!bitable.appSecret) missing.push('FEISHU_APP_SECRET');
    if (!bitable.appToken) missing.push('FEISHU_BITABLE_APP_TOKEN');
    if (!bitable.tableId) missing.push('FEISHU_BITABLE_TABLE_ID');
    return {
      mode,
      configured: missing.length === 0,
      missing,
      bitable
    };
  }

  return {
    mode: 'unconfigured',
    configured: false,
    missing: ['FEISHU_WEBHOOK_URL_OR_BITABLE_CONFIG']
  };
}

function publicStatus(configuration) {
  return {
    configured: configuration.configured,
    mode: configuration.mode,
    sync_available: configuration.configured && (
      configuration.mode === 'webhook' ||
      (configuration.mode === 'bitable' && configuration.bitable.writeEnabled)
    ),
    test_available: configuration.configured && (
      configuration.mode === 'bitable' || Boolean(configuration.webhookTestUrl)
    ),
    missing: configuration.missing.slice()
  };
}

function safeErrorForStatus(status) {
  if (status === 408 || status === 429 || status >= 500) {
    return new FeishuClientError('FEISHU_PROVIDER_UNAVAILABLE', 'Feishu provider is temporarily unavailable.', 502);
  }
  return new FeishuClientError('FEISHU_PROVIDER_REJECTED', 'Feishu provider rejected the request.', 502);
}

async function parseJsonSafely(response) {
  if (!response || typeof response.json !== 'function') return {};
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function createFeishuClient(options) {
  options = options || {};
  const env = options.env || process.env;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || function(url, init) {
    if (!globalThis.fetch) {
      throw new FeishuClientError('FEISHU_PROVIDER_UNAVAILABLE', 'Feishu provider is temporarily unavailable.', 502);
    }
    return globalThis.fetch(url, init);
  };

  async function request(url, init) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(function() { controller.abort(); }, timeoutMs) : null;
    const requestInit = Object.assign({}, init || {});
    if (controller) requestInit.signal = controller.signal;
    try {
      const response = await fetchImpl(url, requestInit);
      if (!response || !response.ok) throw safeErrorForStatus(response && response.status ? response.status : 0);
      return response;
    } catch (error) {
      if (error instanceof FeishuClientError) throw error;
      throw new FeishuClientError('FEISHU_PROVIDER_UNAVAILABLE', 'Feishu provider is temporarily unavailable.', 502);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function configuration() {
    return resolveConfiguration(env);
  }

  function assertConfigured(config) {
    if (config.configured) return;
    throw new FeishuClientError('FEISHU_NOT_CONFIGURED', 'Feishu is not configured.', 409);
  }

  async function requestTenantToken(config) {
    const response = await request(FEISHU_API_ORIGIN + '/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: config.bitable.appId, app_secret: config.bitable.appSecret })
    });
    const payload = await parseJsonSafely(response);
    if (payload.code !== 0 || typeof payload.tenant_access_token !== 'string' || !payload.tenant_access_token) {
      throw new FeishuClientError('FEISHU_PROVIDER_REJECTED', 'Feishu provider rejected the request.', 502);
    }
    return payload.tenant_access_token;
  }

  async function syncWebhook(config, values) {
    const headers = { 'Content-Type': 'application/json' };
    if (values.operationId) headers['Idempotency-Key'] = values.operationId;
    await request(config.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event: 'turingmarket.influencers.sync',
        source: 'TuringMarket',
        records: values.records,
        csv: values.csv
      })
    });
  }

  function bitableFieldsFor(config) {
    return BITABLE_TEMPLATE_FIELDS.filter(function(fieldName) {
      return config.bitable.includeContactEmail || fieldName !== BITABLE_CONTACT_FIELD;
    });
  }

  function assertBitableWriteRequest(records, operationId) {
    if (!UUID_PATTERN.test(String(operationId || '').trim())) {
      throw new FeishuClientError('FEISHU_IDEMPOTENCY_REQUIRED', 'A UUID Idempotency-Key is required for Feishu Bitable writes.', 400);
    }
    if (records.length > MAX_BITABLE_BATCH_RECORDS) {
      throw new FeishuClientError('FEISHU_BATCH_LIMIT_EXCEEDED', 'Feishu Bitable accepts at most 500 records per batch.', 422);
    }
  }

  function projectBitableRecords(records, config) {
    const fieldNames = bitableFieldsFor(config);
    return records.map(function(record) {
      const fields = {};
      fieldNames.forEach(function(fieldName) {
        const value = record && record[fieldName];
        fields[fieldName] = value === undefined || value === null ? '' : value;
      });
      return { fields };
    });
  }

  function assertPreparedBitableRecords(records, config, expectedCount) {
    const expectedFields = bitableFieldsFor(config).slice().sort();
    if (!Array.isArray(records) || records.length !== expectedCount) {
      throw new FeishuClientError('FEISHU_OUTBOX_SNAPSHOT_INVALID', 'Feishu Bitable delivery snapshot is invalid.', 422);
    }
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
          !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
        throw new FeishuClientError('FEISHU_OUTBOX_SNAPSHOT_INVALID', 'Feishu Bitable delivery snapshot is invalid.', 422);
      }
      const fieldNames = Object.keys(record.fields).sort();
      if (JSON.stringify(fieldNames) !== JSON.stringify(expectedFields)) {
        throw new FeishuClientError('FEISHU_OUTBOX_SNAPSHOT_INVALID', 'Feishu Bitable delivery snapshot is invalid.', 422);
      }
    }
    return records;
  }

  function prepareBitableOutboxPayload(values) {
    values = values || {};
    const records = Array.isArray(values.records) ? values.records : [];
    const config = configuration();
    if (!config.configured || config.mode !== 'bitable' || !config.bitable.writeEnabled) {
      throw new FeishuClientError(
        'FEISHU_BITABLE_WRITE_NOT_AVAILABLE',
        'Feishu Bitable delivery is not available.',
        409
      );
    }
    assertBitableWriteRequest(records, values.operationId);
    return { records: projectBitableRecords(records, config) };
  }

  async function listBitableFields(config, tenantToken) {
    const response = await request(
      FEISHU_API_ORIGIN + '/bitable/v1/apps/' + encodeURIComponent(config.bitable.appToken) +
      '/tables/' + encodeURIComponent(config.bitable.tableId) + '/fields?page_size=100',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + tenantToken }
      }
    );
    const payload = await parseJsonSafely(response);
    const items = payload && payload.data && payload.data.items;
    if (payload.code !== 0 || !Array.isArray(items)) {
      throw new FeishuClientError('FEISHU_PROVIDER_REJECTED', 'Feishu provider rejected the request.', 502);
    }
    return new Set(items.map(function(item) { return item && item.field_name; }).filter(Boolean));
  }

  async function syncBitable(config, records, operationId, preparedRecords) {
    assertBitableWriteRequest(records, operationId);
    const tenantToken = await requestTenantToken(config);
    const expectedFields = BITABLE_TEMPLATE_FIELDS;
    const availableFields = await listBitableFields(config, tenantToken);
    if (expectedFields.some(function(fieldName) { return !availableFields.has(fieldName); })) {
      throw new FeishuClientError('FEISHU_BITABLE_SCHEMA_MISMATCH', 'Feishu Bitable schema does not match the approved import template.', 409);
    }
    const bitableRecords = preparedRecords === undefined
      ? projectBitableRecords(records, config)
      : assertPreparedBitableRecords(preparedRecords, config, records.length);

    const response = await request(
      FEISHU_API_ORIGIN + '/bitable/v1/apps/' + encodeURIComponent(config.bitable.appToken) +
      '/tables/' + encodeURIComponent(config.bitable.tableId) + '/records/batch_create',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + tenantToken,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          client_token: String(operationId).trim(),
          records: bitableRecords
        })
      }
    );
    const payload = await parseJsonSafely(response);
    const createdRecords = payload && payload.data && payload.data.records;
    if (payload.code !== 0) {
      throw new FeishuClientError('FEISHU_PROVIDER_REJECTED', 'Feishu provider rejected the request.', 502);
    }
    if (!Array.isArray(createdRecords) || createdRecords.length !== records.length || createdRecords.some(function(record) {
      return !record || typeof record.record_id !== 'string' || !record.record_id;
    }) || new Set(createdRecords.map(function(record) { return record.record_id; })).size !== records.length) {
      throw new FeishuClientError('FEISHU_WRITE_RESULT_INCOMPLETE', 'Feishu did not confirm every record in the batch.', 502);
    }
    return {
      configured: true,
      mode: 'bitable',
      synced: records.length,
      records: records.length,
      remoteRecordIds: createdRecords.map(function(record) { return record.record_id; })
    };
  }

  async function syncInfluencers(values) {
    values = values || {};
    const records = Array.isArray(values.records) ? values.records : [];
    const csv = typeof values.csv === 'string' ? values.csv : '';
    const config = configuration();
    if (!config.configured) {
      return {
        configured: false,
        mode: config.mode,
        records: records.length,
        csv,
        message: 'Feishu is not configured. CSV fallback is ready for manual upload.'
      };
    }
    if (config.mode === 'bitable') {
      if (config.bitable.writeEnabled) {
        const result = await syncBitable(config, records, values.operationId, values.bitableRecords);
        if (values.includeReceipt) return result;
        return {
          configured: result.configured,
          mode: result.mode,
          synced: result.synced,
          records: result.records
        };
      }
      return {
        configured: false,
        mode: 'bitable',
        records: records.length,
        csv,
        message: 'Feishu Bitable write is not enabled. CSV fallback is ready for manual upload.'
      };
    }
    await syncWebhook(config, { records, csv, operationId: values.operationId });
    return { configured: true, mode: 'webhook', synced: records.length, records: records.length };
  }

  async function testConnection() {
    const config = configuration();
    assertConfigured(config);
    if (config.mode === 'webhook') {
      if (!config.webhookTestUrl) {
        throw new FeishuClientError('FEISHU_TEST_NOT_CONFIGURED', 'Feishu webhook test endpoint is not configured.', 409);
      }
      await request(config.webhookTestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'turingmarket.feishu.connection_test',
          source: 'TuringMarket',
          records: []
        })
      });
    } else {
      const tenantToken = await requestTenantToken(config);
      const response = await request(
        FEISHU_API_ORIGIN + '/bitable/v1/apps/' + encodeURIComponent(config.bitable.appToken) +
        '/tables/' + encodeURIComponent(config.bitable.tableId) + '/records?page_size=1',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + tenantToken }
        }
      );
      const payload = await parseJsonSafely(response);
      if (payload.code !== 0) {
        throw new FeishuClientError('FEISHU_PROVIDER_REJECTED', 'Feishu provider rejected the request.', 502);
      }
    }
    return { configured: true, mode: config.mode, ok: true };
  }

  return {
    getStatus: function() { return publicStatus(configuration()); },
    prepareBitableOutboxPayload,
    syncInfluencers,
    testConnection
  };
}

module.exports = {
  FEISHU_API_ORIGIN,
  FeishuClientError,
  createFeishuClient,
  resolveConfiguration
};
