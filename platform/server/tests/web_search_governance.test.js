'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const webSearch = require('../services/web_search_service');

function openCacheDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE web_search_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      query TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function okResponse(results) {
  return {
    ok: true,
    status: 200,
    async json() { return { results, answer: 'provider-only answer must not be persisted' }; }
  };
}

test('Tavily results keep only canonical HTTP sources, deduplicate URLs, and discard raw payloads', async () => {
  const retrievedAt = '2026-08-26T08:00:00.000Z';
  const result = await webSearch.searchWeb('  campaign   performance  ', {
    apiKey: 'test-key',
    maxRetries: 0,
    now: () => Date.parse(retrievedAt),
    fetchImpl: async () => okResponse([
      {
        title: 'Primary result',
        url: 'HTTPS://user:password@Example.com/watch?utm_source=tavily&id=7#section',
        content: 'Evidence for the campaign.',
        score: 0.91
      },
      {
        title: 'Duplicate tracking variant',
        url: 'https://example.com/watch?id=7&utm_medium=referral',
        content: 'Duplicate evidence.'
      },
      { title: 'Unsafe script', url: 'javascript:alert(1)', content: 'unsafe' },
      { title: 'Unsupported protocol', url: 'ftp://example.com/file', content: 'unsafe' },
      { title: 'Second result', url: 'http://news.example.org/story', content: 'Second evidence.' }
    ])
  });

  assert.equal(result.used, true);
  assert.equal(result.provider, 'tavily');
  assert.equal(result.query, 'campaign performance');
  assert.equal(result.retrieved_at, retrievedAt);
  assert.deepEqual(result.results.map((row) => row.url), [
    'https://example.com/watch?id=7',
    'http://news.example.org/story'
  ]);
  assert.equal(result.results[0].provider, 'tavily');
  assert.equal(result.results[0].retrieved_at, retrievedAt);
  assert.equal(Object.hasOwn(result, 'response'), false);
  assert.equal(Object.hasOwn(result, 'answer'), false);
  assert.doesNotMatch(JSON.stringify(result), /password|provider-only answer|utm_/i);
});

test('governed cache fallback uses a canonical query and never exposes provider exception text', async () => {
  const db = openCacheDatabase();
  try {
    const live = await webSearch.searchWeb('campaign   performance', {
      apiKey: 'test-key',
      db,
      maxRetries: 0,
      fetchImpl: async () => okResponse([
        { title: 'Cached source', url: 'https://example.com/source?utm_source=x', content: 'Cached evidence.' }
      ])
    });
    webSearch.cacheSearchResult(db, '  campaign performance ', live);

    const stored = db.prepare('SELECT query,response_json FROM web_search_cache').get();
    assert.equal(stored.query, 'campaign performance');
    assert.doesNotMatch(stored.response_json, /response|answer|utm_source|test-key/i);

    const fallback = await webSearch.searchWeb(' campaign    performance ', {
      apiKey: 'test-key',
      db,
      maxRetries: 0,
      fetchImpl: async () => {
        throw new Error('SECRET_INTERNAL_CONNECTION_DETAIL');
      }
    });

    assert.equal(fallback.used, true);
    assert.equal(fallback.cached, true);
    assert.equal(fallback.reason_code, 'cache_fallback');
    assert.equal(fallback.fallback_reason_code, 'provider_network_error');
    assert.deepEqual(fallback.results.map((row) => row.url), ['https://example.com/source']);
    assert.doesNotMatch(JSON.stringify(fallback), /SECRET_INTERNAL_CONNECTION_DETAIL/);
  } finally {
    db.close();
  }
});

test('Tavily retries one transient response but does not retry a permanent request failure', async () => {
  let transientCalls = 0;
  const recovered = await webSearch.searchWeb('retry contract', {
    apiKey: 'test-key',
    maxRetries: 1,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      transientCalls += 1;
      if (transientCalls === 1) return { ok: false, status: 503 };
      return okResponse([{ title: 'Recovered', url: 'https://example.com/recovered', content: 'ok' }]);
    }
  });
  assert.equal(transientCalls, 2);
  assert.equal(recovered.used, true);

  let permanentCalls = 0;
  const rejected = await webSearch.searchWeb('permanent contract', {
    apiKey: 'test-key',
    maxRetries: 1,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      permanentCalls += 1;
      return { ok: false, status: 400 };
    }
  });
  assert.equal(permanentCalls, 1);
  assert.equal(rejected.used, false);
  assert.equal(rejected.reason_code, 'provider_request_rejected');
});

test('Tavily timeout and circuit breaker fail closed with stable public reason codes', async () => {
  const timedOut = await webSearch.searchWeb('timeout contract', {
    apiKey: 'test-key',
    maxRetries: 0,
    timeoutMs: 15,
    fetchImpl: async () => new Promise(() => {})
  });
  assert.equal(timedOut.used, false);
  assert.equal(timedOut.reason_code, 'provider_timeout');

  const circuitState = { consecutiveFailures: 0, openUntil: 0 };
  let calls = 0;
  for (let index = 0; index < 2; index += 1) {
    const failed = await webSearch.searchWeb('circuit contract', {
      apiKey: 'test-key',
      maxRetries: 0,
      circuitState,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 60_000,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('provider offline');
      }
    });
    assert.equal(failed.used, false);
    assert.equal(failed.reason_code, 'provider_network_error');
  }
  const open = await webSearch.searchWeb('circuit contract', {
    apiKey: 'test-key',
    maxRetries: 0,
    circuitState,
    circuitFailureThreshold: 2,
    circuitCooldownMs: 60_000,
    fetchImpl: async () => {
      calls += 1;
      return okResponse([]);
    }
  });
  assert.equal(calls, 2);
  assert.equal(open.used, false);
  assert.equal(open.reason_code, 'provider_circuit_open');
});

test('Tavily timeout aborts its derived request signal when an outer AI deadline signal exists', async () => {
  const outer = new AbortController();
  let requestSignal;
  const result = await webSearch.searchWeb('derived timeout contract', {
    apiKey: 'test-key',
    maxRetries: 0,
    timeoutMs: 15,
    signal: outer.signal,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    }
  });

  assert.equal(result.reason_code, 'provider_timeout');
  assert.ok(requestSignal);
  assert.notEqual(requestSignal, outer.signal);
  assert.equal(requestSignal.aborted, true);
  assert.equal(outer.signal.aborted, false);
});
