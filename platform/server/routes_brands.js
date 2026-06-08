module.exports = function(app, db, authMiddleware) {
  app.post('/api/brands', authMiddleware, (req, res) => {
    var b = req.body;
    var existing = db.prepare('SELECT id FROM brands WHERE name = ?').get(b.name);
    if (existing) {
      db.prepare('UPDATE brands SET name_cn=?, industry_tags=?, market=?, estimated_annual_revenue=?, user_base=?, amazon_rating=?, youtube_followers=?, instagram_followers=?, tiktok_followers=?, search_volume_monthly=?, monthly_posts=?, avg_engagement=?, avg_views=?, top_platform=?, creative_angles=?, top_products=? WHERE id=?').run(
        b.name_cn, (b.industry_tags||[]).join(','), b.market, b.estimated_annual_revenue, b.user_base, b.amazon_rating, b.youtube_followers, b.instagram_followers, b.tiktok_followers, b.search_volume_monthly, b.monthly_posts, b.avg_engagement, b.avg_views, b.top_platform, (b.creative_angles||[]).join(','), (b.top_products||[]).join(','), existing.id
      );
      return res.json({ id: existing.id, updated: true });
    }
    var r = db.prepare('INSERT INTO brands (name, name_cn, industry_tags, market, estimated_annual_revenue, user_base, amazon_rating, youtube_followers, instagram_followers, tiktok_followers, search_volume_monthly, monthly_posts, avg_engagement, avg_views, top_platform, creative_angles, top_products) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      b.name, b.name_cn, (b.industry_tags||[]).join(','), b.market, b.estimated_annual_revenue, b.user_base, b.amazon_rating, b.youtube_followers, b.instagram_followers, b.tiktok_followers, b.search_volume_monthly, b.monthly_posts, b.avg_engagement, b.avg_views, b.top_platform, (b.creative_angles||[]).join(','), (b.top_products||[]).join(',')
    );
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
};
