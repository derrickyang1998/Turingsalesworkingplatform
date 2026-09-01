const FEISHU_API_ORIGIN = 'https://open.feishu.cn/open-apis';
const DEFAULT_TIMEOUT_MS = 10000;

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
    tableId: readEnvironmentValue(env, 'FEISHU_BITABLE_TABLE_ID')
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
    sync_available: configuration.configured && configuration.mode === 'webhook',
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
      if (Number(payload.code) !== 0) {
        throw new FeishuClientError('FEISHU_PROVIDER_REJECTED', 'Feishu provider rejected the request.', 502);
      }
    }
    return { configured: true, mode: config.mode, ok: true };
  }

  return {
    getStatus: function() { return publicStatus(configuration()); },
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
