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

  const response = await fetchImpl(opts.url || DEFAULT_TAVILY_URL, {
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
  });

  if (!response.ok) {
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
    db.prepare('INSERT INTO web_search_cache (provider, query, response_json) VALUES (?, ?, ?)')
      .run(result.provider || 'tavily', query, JSON.stringify(result.response || result.results || {}));
  } catch (e) {}
}

module.exports = {
  searchWeb,
  formatWebContext,
  cacheSearchResult
};
