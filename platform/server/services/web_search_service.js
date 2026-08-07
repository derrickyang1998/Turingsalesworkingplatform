const DEFAULT_TAVILY_URL = 'https://api.tavily.com/search';

function normalizeResult(item, provider) {
  return {
    title: item.title || item.name || item.url || 'Web result',
    url: item.url || item.link || '',
    snippet: item.content || item.snippet || item.description || '',
    score: item.score || 0,
    provider: provider
  };
}

async function searchWeb(query, opts) {
  opts = opts || {};
  const provider = opts.provider || process.env.WEB_SEARCH_PROVIDER || 'tavily';
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.TAVILY_API_KEY;
  const fetchImpl = opts.fetchImpl || global.fetch;
  const maxResults = Math.min(parseInt(opts.maxResults || 5, 10) || 5, 10);

  if (!query || !String(query).trim()) {
    return { used: false, provider: provider, results: [], reason: 'empty query' };
  }
  if (provider !== 'tavily') {
    return { used: false, provider: provider, results: [], reason: 'provider not supported in v1' };
  }
  if (!apiKey) {
    return { used: false, provider: provider, results: [], reason: 'tavily api key not configured' };
  }
  if (typeof fetchImpl !== 'function') {
    return { used: false, provider: provider, results: [], reason: 'fetch not available' };
  }

  let response;
  try {
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        query: query,
        search_depth: opts.searchDepth || 'basic',
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false
      })
    };
    if (opts.signal !== undefined) fetchOptions.signal = opts.signal;
    response = await fetchImpl(opts.url || DEFAULT_TAVILY_URL, fetchOptions);
  } catch (e) {
    const cached = getCachedSearchResult(opts.db, query, provider);
    if (cached) return cached;
    return { used: false, provider: provider, results: [], reason: 'web search network error: ' + e.message };
  }

  if (!response.ok) {
    const cached = getCachedSearchResult(opts.db, query, provider);
    if (cached) return cached;
    return {
      used: false,
      provider: provider,
      results: [],
      reason: 'web search failed: ' + response.status
    };
  }

  const data = await response.json();
  const results = (data.results || []).slice(0, maxResults).map(function(item) {
    return normalizeResult(item, provider);
  });

  return {
    used: true,
    provider: provider,
    results: results,
    answer: data.answer || '',
    response: data
  };
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
  } catch (e) {}
}

function cacheSearchResultInTransaction(db, query, result) {
  if (!db || !db.inTransaction) {
    throw new Error('cacheSearchResultInTransaction requires an existing transaction');
  }
  if (!result || !result.used) return null;
  return db.prepare(
    'INSERT INTO web_search_cache (provider, query, response_json) VALUES (?, ?, ?)'
  ).run(result.provider || 'tavily', query, JSON.stringify(result));
}

function getCachedSearchResult(db, query, provider) {
  if (!db || !query) return null;
  try {
    const row = db.prepare(`
      SELECT response_json
      FROM web_search_cache
      WHERE provider = ? AND query = ? AND created_at >= datetime('now', '-1 day')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(provider || 'tavily', query);
    if (!row) return null;
    const parsed = JSON.parse(row.response_json || '{}');
    if (parsed && Array.isArray(parsed.results)) {
      return Object.assign({}, parsed, { used: true, provider: parsed.provider || provider || 'tavily', cached: true });
    }
  } catch (e) {}
  return null;
}

module.exports = {
  searchWeb,
  formatWebContext,
  cacheSearchResult,
  cacheSearchResultInTransaction,
  getCachedSearchResult
};
