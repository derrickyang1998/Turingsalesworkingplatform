const DEFAULT_TAVILY_URL = 'https://api.tavily.com/search';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 15000;
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 10;
const DEFAULT_CIRCUIT_STATE = { consecutiveFailures: 0, openUntil: 0 };
const PUBLIC_REASONS = Object.freeze({
  disabled: 'disabled',
  empty_query: 'empty query',
  provider_not_supported: 'provider not supported in v1',
  provider_not_configured: 'tavily api key not configured',
  fetch_not_available: 'web search fetch not available',
  provider_timeout: 'web search timed out',
  provider_network_error: 'web search temporarily unavailable',
  provider_rate_limited: 'web search temporarily rate limited',
  provider_unavailable: 'web search temporarily unavailable',
  provider_request_rejected: 'web search request was rejected',
  provider_invalid_response: 'web search returned an invalid response',
  provider_circuit_open: 'web search temporarily paused after repeated failures',
  cache_fallback: 'using a recent cached web search result'
});

function scalarSlice(value, limit) {
  return Array.from(String(value || '')).slice(0, limit).join('');
}

function normalizeQuery(query) {
  return scalarSlice(String(query || '').replace(/\s+/g, ' ').trim(), MAX_QUERY_LENGTH);
}

function normalizeProvider(provider) {
  return scalarSlice(String(provider || 'tavily').trim().toLowerCase(), 80) || 'tavily';
}

function removeTrackingParameters(url) {
  const keys = [];
  url.searchParams.forEach(function(_value, key) { keys.push(key); });
  keys.forEach(function(key) {
    if (/^(utm_.+|gclid|fbclid|msclkid|mc_[ce]id|ref_src|ref_url)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  });
  const entries = Array.from(url.searchParams.entries()).sort(function(left, right) {
    const keyOrder = left[0].localeCompare(right[0]);
    return keyOrder || left[1].localeCompare(right[1]);
  });
  url.search = '';
  entries.forEach(function(entry) { url.searchParams.append(entry[0], entry[1]); });
}

function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    url.hash = '';
    removeTrackingParameters(url);
    return scalarSlice(url.toString(), 2000);
  } catch (_error) {
    return '';
  }
}

function isoTimestamp(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function sqliteTimestampToIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return isoTimestamp(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
}

function normalizeScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(number, 1));
}

function normalizeResult(item, provider, retrievedAt, cached) {
  const source = item && typeof item === 'object' ? item : {};
  const url = canonicalHttpUrl(source.url || source.link || '');
  if (!url) return null;
  return {
    title: scalarSlice(source.title || source.name || url || 'Web result', 500),
    url,
    snippet: scalarSlice(source.content || source.snippet || source.description || '', 4000),
    score: normalizeScore(source.score),
    provider,
    retrieved_at: retrievedAt,
    cached: cached === true || source.cached === true
  };
}

function safeReasonCode(value, fallback) {
  const code = String(value || '');
  return Object.prototype.hasOwnProperty.call(PUBLIC_REASONS, code) ? code : fallback;
}

function governSearchResult(result, provider, options) {
  const source = result && typeof result === 'object' ? result : {};
  const opts = options || {};
  const normalizedProvider = normalizeProvider(source.provider || provider);
  const nowValue = typeof opts.now === 'function' ? opts.now() : Date.now();
  const retrievedAt = isoTimestamp(source.retrieved_at || source.retrievedAt || nowValue) || new Date().toISOString();
  const maxResults = Math.min(Math.max(parseInt(opts.maxResults || MAX_RESULTS, 10) || MAX_RESULTS, 1), MAX_RESULTS);
  const seen = new Set();
  const rows = [];
  (Array.isArray(source.results) ? source.results : []).forEach(function(item) {
    if (rows.length >= maxResults) return;
    const normalized = normalizeResult(item, normalizedProvider, retrievedAt, source.cached === true);
    if (!normalized || seen.has(normalized.url)) return;
    seen.add(normalized.url);
    rows.push(normalized);
  });
  const used = source.used === true;
  const fallbackCode = used ? '' : 'provider_unavailable';
  const reasonCode = safeReasonCode(source.reason_code, fallbackCode);
  const governed = {
    used,
    provider: normalizedProvider,
    query: normalizeQuery(opts.query !== undefined ? opts.query : source.query),
    results: rows,
    retrieved_at: retrievedAt,
    cached: source.cached === true
  };
  if (reasonCode) {
    governed.reason_code = reasonCode;
    governed.reason = PUBLIC_REASONS[reasonCode];
  }
  if (source.fallback_reason_code) {
    governed.fallback_reason_code = safeReasonCode(
      source.fallback_reason_code,
      'provider_unavailable'
    );
  }
  if (source.cached_at) governed.cached_at = isoTimestamp(source.cached_at) || String(source.cached_at);
  return governed;
}

function unavailable(provider, query, reasonCode, extra) {
  return Object.assign({
    used: false,
    provider,
    query,
    results: [],
    reason_code: reasonCode,
    reason: PUBLIC_REASONS[reasonCode] || PUBLIC_REASONS.provider_unavailable,
    cached: false
  }, extra || {});
}

function timeoutForAttempt(opts, nowValue) {
  const configured = Number(opts.timeoutMs);
  let timeoutMs = Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const deadlineAt = Number(opts.deadlineAt);
  if (Number.isFinite(deadlineAt)) {
    timeoutMs = Math.min(timeoutMs, Math.max(1, Math.floor(deadlineAt - nowValue)));
  }
  return Math.max(1, timeoutMs);
}

async function fetchWithTimeout(fetchImpl, url, fetchOptions, opts, nowValue) {
  const timeoutMs = timeoutForAttempt(opts, nowValue);
  const externalSignal = opts.signal;
  if (externalSignal && externalSignal.aborted) {
    throw externalSignal.reason || new Error('Web search aborted.');
  }
  const controller = new AbortController();
  const requestOptions = Object.assign({}, fetchOptions, {
    signal: controller.signal
  });
  let timer;
  let detachExternal = null;
  let rejectExternal;
  const externalAbortPromise = new Promise(function(_resolve, reject) {
    rejectExternal = reject;
  });
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    const onAbort = function() {
      const reason = externalSignal.reason || new Error('Web search aborted.');
      controller.abort(reason);
      rejectExternal(reason);
    };
    externalSignal.addEventListener('abort', onAbort, { once: true });
    detachExternal = function() { externalSignal.removeEventListener('abort', onAbort); };
  }
  const timeoutPromise = new Promise(function(_resolve, reject) {
    timer = setTimeout(function() {
      const error = new Error('WEB_SEARCH_TIMEOUT');
      error.code = 'WEB_SEARCH_TIMEOUT';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, requestOptions),
      timeoutPromise,
      externalAbortPromise
    ]);
  } finally {
    clearTimeout(timer);
    if (detachExternal) detachExternal();
  }
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function statusReasonCode(status) {
  if (status === 429) return 'provider_rate_limited';
  if (isTransientStatus(status)) return 'provider_unavailable';
  return 'provider_request_rejected';
}

function circuitState(opts) {
  const supplied = opts.circuitState;
  if (supplied && typeof supplied === 'object') return supplied;
  return DEFAULT_CIRCUIT_STATE;
}

function circuitOpen(state, nowValue) {
  return Number(state.openUntil || 0) > nowValue;
}

function resetCircuit(state) {
  state.consecutiveFailures = 0;
  state.openUntil = 0;
}

function recordCircuitFailure(state, opts, nowValue) {
  const configuredThreshold = parseInt(opts.circuitFailureThreshold || 3, 10) || 3;
  const threshold = Math.max(1, Math.min(configuredThreshold, 10));
  const configuredCooldown = Number(opts.circuitCooldownMs);
  const cooldownMs = Number.isFinite(configuredCooldown) && configuredCooldown > 0
    ? Math.min(Math.floor(configuredCooldown), 300000)
    : 60000;
  state.consecutiveFailures = Math.max(0, Number(state.consecutiveFailures) || 0) + 1;
  if (state.consecutiveFailures >= threshold) state.openUntil = nowValue + cooldownMs;
}

function sleep(ms, implementation) {
  if (typeof implementation === 'function') return implementation(ms);
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function cachedFallback(db, query, provider, reasonCode) {
  const cached = getCachedSearchResult(db, query, provider);
  if (!cached) return null;
  return Object.assign({}, cached, {
    reason_code: 'cache_fallback',
    reason: PUBLIC_REASONS.cache_fallback,
    fallback_reason_code: reasonCode
  });
}

async function searchWeb(query, opts) {
  opts = opts || {};
  const provider = normalizeProvider(opts.provider || process.env.WEB_SEARCH_PROVIDER || 'tavily');
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.TAVILY_API_KEY;
  const fetchImpl = opts.fetchImpl || global.fetch;
  const normalizedQuery = normalizeQuery(query);
  const maxResults = Math.min(Math.max(parseInt(opts.maxResults || 5, 10) || 5, 1), MAX_RESULTS);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  if (!normalizedQuery) return unavailable(provider, normalizedQuery, 'empty_query');
  if (provider !== 'tavily') return unavailable(provider, normalizedQuery, 'provider_not_supported');
  if (!apiKey) return unavailable(provider, normalizedQuery, 'provider_not_configured');
  if (typeof fetchImpl !== 'function') return unavailable(provider, normalizedQuery, 'fetch_not_available');

  const state = circuitState(opts);
  const initialNow = Number(now());
  if (circuitOpen(state, initialNow)) {
    return cachedFallback(opts.db, normalizedQuery, provider, 'provider_circuit_open') ||
      unavailable(provider, normalizedQuery, 'provider_circuit_open');
  }

  const configuredRetries = parseInt(opts.maxRetries === undefined ? 1 : opts.maxRetries, 10);
  const maxRetries = Math.max(0, Math.min(Number.isFinite(configuredRetries) ? configuredRetries : 1, 1));
  let terminalCode = 'provider_unavailable';

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptNow = Number(now());
    if (Number.isFinite(Number(opts.deadlineAt)) && attemptNow >= Number(opts.deadlineAt)) {
      terminalCode = 'provider_timeout';
      break;
    }
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        query: normalizedQuery,
        search_depth: opts.searchDepth || 'basic',
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false
      })
    };
    let response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        opts.url || DEFAULT_TAVILY_URL,
        fetchOptions,
        opts,
        attemptNow
      );
    } catch (error) {
      if (opts.signal && opts.signal.aborted) throw error;
      terminalCode = error && error.code === 'WEB_SEARCH_TIMEOUT'
        ? 'provider_timeout'
        : 'provider_network_error';
      if (attempt < maxRetries) {
        await sleep(Math.max(0, Number(opts.retryDelayMs) || 150), opts.sleepImpl);
        continue;
      }
      break;
    }

    if (!response || response.ok !== true) {
      const status = Number(response && response.status);
      terminalCode = statusReasonCode(status);
      if (isTransientStatus(status) && attempt < maxRetries) {
        await sleep(Math.max(0, Number(opts.retryDelayMs) || 150), opts.sleepImpl);
        continue;
      }
      if (!isTransientStatus(status)) {
        const fallback = cachedFallback(opts.db, normalizedQuery, provider, terminalCode);
        return fallback || unavailable(provider, normalizedQuery, terminalCode);
      }
      break;
    }

    let data;
    try {
      data = await response.json();
    } catch (_error) {
      terminalCode = 'provider_invalid_response';
      break;
    }
    const governed = governSearchResult({
      used: true,
      provider,
      query: normalizedQuery,
      results: Array.isArray(data && data.results) ? data.results : [],
      retrieved_at: new Date(Number(now())).toISOString()
    }, provider, {
      query: normalizedQuery,
      maxResults,
      now
    });
    resetCircuit(state);
    return governed;
  }

  recordCircuitFailure(state, opts, Number(now()));
  return cachedFallback(opts.db, normalizedQuery, provider, terminalCode) ||
    unavailable(provider, normalizedQuery, terminalCode);
}

function formatWebContext(searchResult) {
  if (!searchResult || !searchResult.results || !searchResult.results.length) return '';
  return searchResult.results.map(function(item, index) {
    return `[WEB-${index + 1}] ${item.title}\n${item.url}\n${item.snippet || ''}`;
  }).join('\n\n');
}

function cacheSearchResult(db, query, result) {
  if (!db || !result || !result.used) return;
  try {
    const write = () => cacheSearchResultInTransaction(db, query, result);
    if (db.inTransaction) write();
    else db.transaction(write).immediate();
  } catch (_error) {}
}

function cacheSearchResultInTransaction(db, query, result) {
  if (!db || !db.inTransaction) {
    throw new Error('cacheSearchResultInTransaction requires an existing transaction');
  }
  if (!result || !result.used) return null;
  const provider = normalizeProvider(result.provider || 'tavily');
  const normalizedQuery = normalizeQuery(query || result.query);
  const governed = governSearchResult(result, provider, {
    query: normalizedQuery,
    maxResults: MAX_RESULTS
  });
  if (!normalizedQuery || !governed.used) return null;
  const stored = {
    used: true,
    provider,
    query: normalizedQuery,
    results: governed.results.map(function(row) {
      return Object.assign({}, row, { cached: false });
    }),
    retrieved_at: governed.retrieved_at
  };
  return db.prepare(
    'INSERT INTO web_search_cache (provider, query, response_json) VALUES (?, ?, ?)'
  ).run(provider, normalizedQuery, JSON.stringify(stored));
}

function getCachedSearchResult(db, query, provider) {
  const normalizedQuery = normalizeQuery(query);
  if (!db || !normalizedQuery) return null;
  try {
    const normalizedProvider = normalizeProvider(provider || 'tavily');
    const row = db.prepare(`
      SELECT response_json,created_at
      FROM web_search_cache
      WHERE provider = ? AND query = ? AND created_at >= datetime('now', '-1 day')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(normalizedProvider, normalizedQuery);
    if (!row) return null;
    const parsed = JSON.parse(row.response_json || '{}');
    if (!parsed || !Array.isArray(parsed.results)) return null;
    const cachedAt = sqliteTimestampToIso(row.created_at);
    const governed = governSearchResult(Object.assign({}, parsed, {
      used: true,
      cached: true,
      cached_at: cachedAt
    }), normalizedProvider, {
      query: normalizedQuery,
      maxResults: MAX_RESULTS
    });
    governed.results = governed.results.map(function(item) {
      return Object.assign({}, item, { cached: true });
    });
    return governed;
  } catch (_error) {
    return null;
  }
}

module.exports = {
  searchWeb,
  formatWebContext,
  cacheSearchResult,
  cacheSearchResultInTransaction,
  getCachedSearchResult,
  governSearchResult,
  normalizeQuery,
  canonicalHttpUrl
};
