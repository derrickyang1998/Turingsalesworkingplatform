module.exports = function(app, db, authMiddleware, aiLimiter, aiQuotaGuard) {
  const businessKnowledge = require('./services/business_knowledge_service');
  const llm = require('./services/llm_service');
  const webSearch = require('./services/web_search_service');
  const aiMiddlewares = [authMiddleware];
  if (aiLimiter) aiMiddlewares.push(aiLimiter);
  if (aiQuotaGuard) aiMiddlewares.push(aiQuotaGuard);

  function parseJsonObject(text) {
    var raw = String(text || '').trim();
    if (raw.indexOf('```') >= 0) {
      raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    }
    var first = raw.indexOf('{');
    var last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) raw = raw.slice(first, last + 1);
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function fallbackBrand(name) {
    return {
      name: name,
      name_cn: '',
      industry_tags: ['Other'],
      market: 'global',
      estimated_annual_revenue: '$100M+',
      user_base: '',
      amazon_rating: 4.0,
      youtube_followers: 0,
      instagram_followers: 0,
      tiktok_followers: 0,
      brand_search_volume_monthly: 0,
      total_posts: 0,
      avg_engagement_rate: '3.0%',
      avg_views_per_post: 0,
      top_platform: 'YouTube',
      creative_angles: [],
      top_products_featured: []
    };
  }

  app.post('/api/brands/enrich', aiMiddlewares, async (req, res) => {
    var brand = String(req.body.brand || req.body.name || '').trim();
    if (!brand) return res.status(400).json({ error: 'Brand name required' });
    try {
      var research = await webSearch.searchWeb(brand + ' brand revenue social media influencer marketing', {
        db: db,
        maxResults: 5
      });
      webSearch.cacheSearchResult(db, brand, research);
      var provider = llm.createDeepSeekProvider();
      var completion = await provider.complete({
        messages: [
          { role: 'system', content: 'You are a brand data analyst. Return JSON only. No markdown.' },
          { role: 'user', content: [
            'Create structured brand intelligence for "' + brand + '".',
            'Return JSON with fields: name, name_cn, industry_tags, market, estimated_annual_revenue, user_base, amazon_rating, youtube_followers, instagram_followers, tiktok_followers, brand_search_volume_monthly, total_posts, avg_engagement_rate, avg_views_per_post, top_platform, creative_angles, top_products_featured.',
            'Use these web sources when useful:',
            JSON.stringify((research.results || []).slice(0, 5))
          ].join('\n') }
        ],
        temperature: 0.25,
        max_tokens: 1000
      });
      var parsed = parseJsonObject(completion.content);
      var enriched = Object.assign(fallbackBrand(brand), parsed || {});
      if (!Array.isArray(enriched.industry_tags)) enriched.industry_tags = String(enriched.industry_tags || 'Other').split(/[,;，、]/).map(function(v) { return v.trim(); }).filter(Boolean);
      if (!Array.isArray(enriched.creative_angles)) enriched.creative_angles = String(enriched.creative_angles || '').split(/[,;，、]/).map(function(v) { return v.trim(); }).filter(Boolean);
      if (!Array.isArray(enriched.top_products_featured)) enriched.top_products_featured = String(enriched.top_products_featured || '').split(/[,;，、]/).map(function(v) { return v.trim(); }).filter(Boolean);
      if (completion.usage && (completion.usage.total_tokens || completion.usage.prompt_tokens || completion.usage.completion_tokens)) {
        try {
          db.prepare('INSERT INTO token_usage (user_id, model, prompt_tokens, completion_tokens, total_tokens, endpoint) VALUES (?, ?, ?, ?, ?, ?)')
            .run(req.user.id, completion.model || 'deepseek-chat', completion.usage.prompt_tokens || 0, completion.usage.completion_tokens || 0, completion.usage.total_tokens || 0, 'brand_enrich');
        } catch (e2) {}
      }
      res.json({
        brand: enriched,
        web_results: research.results || [],
        web_search: { used: !!research.used, provider: research.provider || 'tavily', reason: research.reason || '' },
        fallback: !!completion.degraded || !parsed,
        warning: completion.reason || (!parsed ? 'AI returned fallback brand fields' : '')
      });
    } catch (e) {
      res.json({
        brand: fallbackBrand(brand),
        web_results: [],
        web_search: { used: false, provider: 'tavily', reason: e.message },
        fallback: true,
        warning: e.message
      });
    }
  });

  app.post('/api/brands', authMiddleware, (req, res) => {
    var b = req.body;
    var existing = db.prepare('SELECT id FROM brands WHERE name = ?').get(b.name);
    if (existing) {
      db.prepare('UPDATE brands SET name_cn=?, industry_tags=?, market=?, estimated_annual_revenue=?, user_base=?, amazon_rating=?, youtube_followers=?, instagram_followers=?, tiktok_followers=?, search_volume_monthly=?, monthly_posts=?, avg_engagement=?, avg_views=?, top_platform=?, creative_angles=?, top_products=? WHERE id=?').run(
        b.name_cn, (b.industry_tags||[]).join(','), b.market, b.estimated_annual_revenue, b.user_base, b.amazon_rating, b.youtube_followers, b.instagram_followers, b.tiktok_followers, b.search_volume_monthly, b.monthly_posts, b.avg_engagement, b.avg_views, b.top_platform, (b.creative_angles||[]).join(','), (b.top_products||[]).join(','), existing.id
      );
      businessKnowledge.archiveBrand(db, Object.assign({}, b, { id: existing.id }), req.user);
      return res.json({ id: existing.id, updated: true });
    }
    var r = db.prepare('INSERT INTO brands (name, name_cn, industry_tags, market, estimated_annual_revenue, user_base, amazon_rating, youtube_followers, instagram_followers, tiktok_followers, search_volume_monthly, monthly_posts, avg_engagement, avg_views, top_platform, creative_angles, top_products) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      b.name, b.name_cn, (b.industry_tags||[]).join(','), b.market, b.estimated_annual_revenue, b.user_base, b.amazon_rating, b.youtube_followers, b.instagram_followers, b.tiktok_followers, b.search_volume_monthly, b.monthly_posts, b.avg_engagement, b.avg_views, b.top_platform, (b.creative_angles||[]).join(','), (b.top_products||[]).join(',')
    );
    businessKnowledge.archiveBrand(db, Object.assign({}, b, { id: r.lastInsertRowid }), req.user);
    res.json({ id: r.lastInsertRowid, updated: false });
  });

  app.get('/api/brands', authMiddleware, (req, res) => {
    var brands = db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all();
    var formatted = brands.map(function(b) {
      return {
        id: 'db_' + b.id,
        name: b.name,
        name_cn: b.name_cn,
        industry_tags: (b.industry_tags || '').split(',').filter(Boolean),
        market: b.market,
        estimated_annual_revenue: b.estimated_annual_revenue,
        user_base: b.user_base,
        overseas_presence: {
          amazon_rating: b.amazon_rating || 4.0,
          social_followers: { youtube: b.youtube_followers || 0, instagram: b.instagram_followers || 0, tiktok: b.tiktok_followers || 0 },
          brand_search_volume_monthly: b.search_volume_monthly || 0
        },
        social_content_monthly: {
          total_posts: b.monthly_posts || 0,
          creative_angles: (b.creative_angles || '').split(',').filter(Boolean),
          top_products_featured: (b.top_products || '').split(',').filter(Boolean),
          last_12_months: { avg_engagement_rate: b.avg_engagement || '3.0%', avg_views_per_post: b.avg_views || 0, top_platform: b.top_platform || 'YouTube' }
        },
        case_study_available: false
      };
    });
    res.json({ brands: formatted });
  });

  app.get('/api/brands/social-search', authMiddleware, (req, res) => {
    var brand = req.query.brand;
    var platform = req.query.platform || 'youtube';
    if (!brand) return res.status(400).json({ error: 'Brand name required' });
    var cleanTag = String(brand).replace(/[^a-zA-Z0-9]/g, '');
    var searchUrls = {
      youtube: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(brand + ' review') + '&sp=CAI%253D',
      tiktok: 'https://www.tiktok.com/search/video?q=' + encodeURIComponent(brand),
      instagram: 'https://www.instagram.com/explore/tags/' + cleanTag + '/'
    };
    res.json({ items: [], platform: platform, brand: brand, searchUrl: searchUrls[platform] || searchUrls.youtube });
  });
};
