# Phase A: M2 Rebuild + Brand Persistence Implementation Plan

> **For agentic workers:** Follow executing-plans workflow — each step has checkbox for tracking.

**Goal:** Rebuild M2 (Client Strategy) page with verified rendering + auto-save enriched brands to SQLite

**Architecture:** M2 rebuilt with same HTML/CSS pattern as M1 (confirmed working). Brand persistence via SQLite table + API endpoint. Search results auto-saved to DB on new brand discovery.

**Tech Stack:** Vanilla JS SPA + Express.js + SQLite (better-sqlite3)

**Verified baseline (M1) at:** \platform/index.html\ lines with \page-m1\ — structurally identical to what M2 should be

---

### Task 1: Add brands table to DB

**Files:**
- Modify: \platform/server/db.js\

- [ ] **Step 1: Add brands table**

Add after team_invites table:

\\\sql
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_cn TEXT,
  industry_tags TEXT,
  market TEXT DEFAULT 'global',
  estimated_annual_revenue TEXT,
  user_base TEXT,
  amazon_rating REAL,
  youtube_followers INTEGER DEFAULT 0,
  instagram_followers INTEGER DEFAULT 0,
  tiktok_followers INTEGER DEFAULT 0,
  search_volume_monthly INTEGER DEFAULT 0,
  monthly_posts INTEGER DEFAULT 0,
  avg_engagement TEXT,
  avg_views INTEGER DEFAULT 0,
  top_platform TEXT,
  creative_angles TEXT,
  top_products TEXT,
  data_source TEXT DEFAULT 'user_enrich',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
\\\

### Task 2: Add brand API routes

**Files:**
- Create: \platform/server/routes_brands.js\
- Modify: \platform/server/server.js\

- [ ] **Step 1: Create routes_brands.js**

\\\js
module.exports = function(app, db, authMiddleware) {
  app.post('/api/brands', authMiddleware, (req, res) => {
    const b = req.body;
    const existing = db.prepare('SELECT id FROM brands WHERE name = ?').get(b.name);
    if (existing) {
      db.prepare('UPDATE brands SET name_cn=?, industry_tags=?, market=?, estimated_annual_revenue=?, user_base=?, amazon_rating=?, youtube_followers=?, instagram_followers=?, tiktok_followers=?, search_volume_monthly=?, monthly_posts=?, avg_engagement=?, avg_views=?, top_platform=?, creative_angles=?, top_products=? WHERE id=?').run(
        b.name_cn, (b.industry_tags||[]).join(','), b.market, b.estimated_annual_revenue, b.user_base, b.amazon_rating, b.youtube_followers, b.instagram_followers, b.tiktok_followers, b.search_volume_monthly, b.monthly_posts, b.avg_engagement, b.avg_views, b.top_platform, (b.creative_angles||[]).join(','), (b.top_products||[]).join(','), existing.id
      );
      return res.json({ id: existing.id, updated: true });
    }
    const r = db.prepare('INSERT INTO brands (name, name_cn, industry_tags, market, estimated_annual_revenue, user_base, amazon_rating, youtube_followers, instagram_followers, tiktok_followers, search_volume_monthly, monthly_posts, avg_engagement, avg_views, top_platform, creative_angles, top_products) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      b.name, b.name_cn, (b.industry_tags||[]).join(','), b.market, b.estimated_annual_revenue, b.user_base, b.amazon_rating, b.youtube_followers, b.instagram_followers, b.tiktok_followers, b.search_volume_monthly, b.monthly_posts, b.avg_engagement, b.avg_views, b.top_platform, (b.creative_angles||[]).join(','), (b.top_products||[]).join(',')
    );
    res.json({ id: r.lastInsertRowid, updated: false });
  });

  app.get('/api/brands', authMiddleware, (req, res) => {
    const brands = db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all();
    const formatted = brands.map(function(b) {
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
\\\

- [ ] **Step 2: Load routes in server.js**

Insert before health check:

\\\js
require('./routes_brands')(app, db, authMiddleware);
\\\

### Task 3: Auto-save enriched brands

**Files:**
- Modify: \platform/app.js\ (searchNewBrand function)

- [ ] **Step 1: Modify searchNewBrand to auto-save**

After the line \BRANDS.unshift(nb)\ add:

\\\js
// Auto-save to DB
try {
  var saveData = {
    name: nb.name, name_cn: nb.name_cn,
    industry_tags: nb.industry_tags, market: nb.market,
    estimated_annual_revenue: nb.estimated_annual_revenue,
    user_base: nb.user_base,
    amazon_rating: nb.overseas_presence?.amazon_rating,
    youtube_followers: nb.overseas_presence?.social_followers?.youtube,
    instagram_followers: nb.overseas_presence?.social_followers?.instagram,
    tiktok_followers: nb.overseas_presence?.social_followers?.tiktok,
    search_volume_monthly: nb.overseas_presence?.brand_search_volume_monthly,
    monthly_posts: nb.social_content_monthly?.total_posts,
    avg_engagement: nb.social_content_monthly?.last_12_months?.avg_engagement_rate,
    avg_views: nb.social_content_monthly?.last_12_months?.avg_views_per_post,
    top_platform: nb.social_content_monthly?.last_12_months?.top_platform,
    creative_angles: nb.social_content_monthly?.creative_angles,
    top_products: nb.social_content_monthly?.top_products_featured
  };
  apiFetch('/brands', { method: 'POST', body: JSON.stringify(saveData) });
} catch(e) {}
\\\

### Task 4: Load saved brands on startup

**Files:**
- Modify: \platform/app.js\ (initApp function)

- [ ] **Step 1: Load DB brands in initApp**

After the JSON brand load, add:

\\\js
// Load user-enriched brands from DB
try {
  var rb = await apiFetch('/brands');
  var dbBrands = await rb.json();
  if (dbBrands.brands && dbBrands.brands.length) {
    // Merge: deduplicate by name, prefer JSON version
    var existingNames = {};
    BRANDS.forEach(function(b) { existingNames[b.name] = true; });
    dbBrands.brands.forEach(function(db) {
      if (!existingNames[db.name]) {
        BRANDS.push(db);
        existingNames[db.name] = true;
      }
    });
  }
} catch(e) {}
\\\

### Task 5: M2 HTML rebuild (M1-identical pattern)

**Files:**
- Modify: \platform/index.html\

- [ ] **Step 1: Replace M2 page content**

Replace the M2 page div with HTML identical to M1's pattern:

\\\html
<div class="page" id="page-m2">
<h2>🎯 客户策略规划</h2>
<p class="subtitle">根据客户阶段制定差异化红人营销策略</p>
<div class="card">
  <div class="grid grid-3" style="margin-bottom:12px">
    <div><label>品牌阶段</label><select id="s_stage" onchange="updateStrategy()"><option value="">请选择...</option><option value="new">新品牌出海</option><option value="growing">增长期</option><option value="established">成熟品牌</option><option value="launch">新品发布</option></select></div>
    <div><label>目标行业</label><select id="s_industry" onchange="updateStrategy()"><option value="">请选择...</option><option>3C</option><option>储能</option><option>智能家居</option><option>美妆</option><option>户外</option><option>宠物</option><option>医疗</option><option>出行</option></select></div>
    <div><label>预算范围</label><select id="s_budget" onchange="updateStrategy()"><option value="">请选择...</option><option value="low">-15K/mo</option><option value="mid">-50K/mo</option><option value="high">-150K+/mo</option></select></div>
  </div>
  <div style="margin-bottom:12px"><label>核心目标</label><select id="s_goal" onchange="updateStrategy()"><option value="">请选择...</option><option value="awareness">品牌认知</option><option value="conversion">销售转化</option><option value="both">品效合一</option></select></div>
</div>
<div class="card hidden" id="strategyOut"><h3>📋 策略建议</h3><div id="strategyContent"></div></div>
</div>
\\\

### Verification Checklist

- [ ] M2 page renders with correct height (> 0 offsetHeight)
- [ ] Strategy dropdowns visible and interactive
- [ ] Selecting all 4 options shows strategy output
- [ ] Brand search auto-saves to DB (verify via API)
- [ ] Saved brands appear in industry tree on page reload
- [ ] No JS errors in console
