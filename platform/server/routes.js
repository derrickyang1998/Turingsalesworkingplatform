module.exports = function(app, db, authMiddleware) {

// ===== INFLUENCER ROUTES =====
app.get('/api/influencers', authMiddleware, (req, res) => {
  const { platform, category, region, search, min_followers, max_followers, sort_by } = req.query;
  let sql = 'SELECT * FROM influencers WHERE is_active = 1';
  const params = [];
  if (platform) { sql += ' AND platform = ?'; params.push(platform); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (region) { sql += ' AND region = ?'; params.push(region); }
  if (search) { sql += ' AND (kol_handle LIKE ? OR content_style LIKE ? OR brand_collab_history LIKE ?)'; params.push('%' + search + '%', '%' + search + '%', '%' + search + '%'); }
  if (min_followers) { sql += ' AND followers >= ?'; params.push(parseInt(min_followers)); }
  if (max_followers) { sql += ' AND followers <= ?'; params.push(parseInt(max_followers)); }
  sql += ' ORDER BY ' + ((sort_by === 'engagement' || sort_by === 'followers' || sort_by === 'cost_usd') ? sort_by : 'followers') + ' DESC LIMIT 200';
  const influencers = db.prepare(sql).all(...params);
  res.json({ influencers, total: influencers.length });
});

app.post('/api/influencers', authMiddleware, (req, res) => {
  const { platform, kol_handle, profile_link, followers, avg_views_10, avg_engagement, category, sub_category, region, language, content_style, collab_type, cost_usd, cost_range_min, cost_range_max, cpm, brand_collab_history, contact_email } = req.body;
  const result = db.prepare(`INSERT INTO influencers (platform, kol_handle, profile_link, followers, avg_views_10, avg_engagement, category, sub_category, region, language, content_style, collab_type, cost_usd, cost_range_min, cost_range_max, cpm, brand_collab_history, contact_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    platform, kol_handle, profile_link, followers || 0, avg_views_10 || 0, avg_engagement || 0, category, sub_category, region, language, content_style, collab_type || 'Dedicated', cost_usd || 0, cost_range_min, cost_range_max, cpm, brand_collab_history, contact_email
  );
  res.json({ id: result.lastInsertRowid });
});

app.post('/api/influencers/match', authMiddleware, (req, res) => {
  const { category, platform, region, min_followers, max_followers } = req.body;
  let sql = 'SELECT * FROM influencers WHERE is_active = 1';
  const params = [];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (platform) { sql += ' AND platform = ?'; params.push(platform); }
  if (region) { sql += ' AND region = ?'; params.push(region); }
  if (min_followers) { sql += ' AND followers >= ?'; params.push(parseInt(min_followers)); }
  if (max_followers) { sql += ' AND followers <= ?'; params.push(parseInt(max_followers)); }
  const all = db.prepare(sql).all(...params);
  const scored = all.map(inf => {
    let score = 0;
    if (inf.avg_engagement) score += Math.min(inf.avg_engagement, 10) * 8;
    if (inf.followers) score += Math.min(Math.log10(inf.followers) * 10, 40);
    if (inf.avg_views_10) score += Math.min(Math.log10(inf.avg_views_10) * 5, 20);
    if (inf.cpm && inf.cpm < 50) score += 15;
    else if (inf.cpm && inf.cpm < 100) score += 8;
    if (inf.brand_collab_history && inf.brand_collab_history.length > 0) score += 10;
    score = Math.round(score);
    return { ...inf, match_score: score };
  });
  scored.sort((a, b) => b.match_score - a.match_score);
  res.json({ matches: scored.slice(0, 30) });
});

// ===== COLLABORATION ROUTES =====
app.post('/api/collaborations', authMiddleware, (req, res) => {
  const { demand_id, influencer_id, status, proposal_notes, cost_quoted, notes } = req.body;
  const result = db.prepare('INSERT INTO collaborations (demand_id, influencer_id, user_id, status, proposal_notes, cost_quoted, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    demand_id, influencer_id, req.user.id, status || 'proposed', proposal_notes, cost_quoted || 0, notes
  );
  db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'create_collab', 'collaboration', 'Created collaboration for influencer ' + influencer_id, req.ip);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/collaborations', authMiddleware, (req, res) => {
  const { status, demand_id } = req.query;
  let sql = 'SELECT c.*, i.kol_handle, i.platform, i.followers, i.category FROM collaborations c JOIN influencers i ON c.influencer_id = i.id';
  const params = [];
  const conditions = [];
  if (status) { conditions.push('c.status = ?'); params.push(status); }
  if (demand_id) { conditions.push('c.demand_id = ?'); params.push(parseInt(demand_id)); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY c.updated_at DESC LIMIT 200';
  const collabs = db.prepare(sql).all(...params);
  res.json({ collaborations: collabs });
});

app.put('/api/collaborations/:id', authMiddleware, (req, res) => {
  const { status, cost_quoted, cost_actual, content_url, notes, timeline_start, timeline_end } = req.body;
  db.prepare('UPDATE collaborations SET status = COALESCE(?, status), cost_quoted = COALESCE(?, cost_quoted), cost_actual = COALESCE(?, cost_actual), content_url = COALESCE(?, content_url), notes = COALESCE(?, notes), timeline_start = COALESCE(?, timeline_start), timeline_end = COALESCE(?, timeline_end), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, cost_quoted, cost_actual, content_url, notes, timeline_start, timeline_end, req.params.id);
  db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'update_collab', 'collaboration', 'Updated collaboration ' + req.params.id + ' to ' + (status || 'no_status_change'), req.ip);
  res.json({ success: true });
});

app.get('/api/collaborations/stats', authMiddleware, (req, res) => {
  const stats = {
    byStatus: db.prepare('SELECT status, COUNT(*) as count FROM collaborations GROUP BY status').all(),
    totalActive: db.prepare(`SELECT COUNT(*) as count FROM collaborations WHERE status IN ('proposed', 'contacted', 'negotiating', 'confirmed', 'contract_sent', 'live', 'content_review')`).get().count,
    totalCompleted: db.prepare(`SELECT COUNT(*) as count FROM collaborations WHERE status = 'completed'`).get().count,
    totalCost: db.prepare('SELECT COALESCE(SUM(COALESCE(cost_actual, cost_quoted)), 0) as total FROM collaborations').get().total,
  };
  res.json({ stats });
});

// ===== V8.1: INFLUENCER IMPORT/EXPORT =====
app.post('/api/influencers/import', authMiddleware, (req, res) => {
  try {
    const { rows, batch_id } = req.body;
    if (!rows || !rows.length) return res.status(400).json({ error: 'No rows provided' });
    const insert = db.prepare(`INSERT INTO influencers (platform, kol_handle, profile_link, followers, avg_views_10, avg_engagement, category, sub_category, region, language, content_style, collab_type, cost_usd, cpm, brand_collab_history, contact_email, project_name, product_name, reporter, tags, quoted_price, content_deliverable, is_duplicate, import_batch, data_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let imported = 0, skipped = 0;
    const batch = batch_id || 'import_' + Date.now();
    const doImport = db.transaction(function() {
      for (const row of rows) {
        const platform = row['\u793e\u5a92\u5e73\u53f0'] || row['platform'] || '';
        const kol_handle = row['\u7f51\u7ea2\u9891\u9053\u540d\u79f0'] || row['kol_handle'] || '';
        if (!kol_handle) { skipped++; continue; }
        const link = row['\u7f51\u7ea2\u9891\u9053\u94fe\u63a5'] || row['profile_link'] || '';
        insert.run(
          platform, kol_handle, link,
          parseInt(row['\u7f51\u7ea2\u7c89\u4e1d\u91cf'] || row['followers'] || 0),
          parseFloat(row['\u8fd110\u4e2a\u89c6\u9891\u5747\u64ad'] || row['avg_views_10'] || 0) || 0,
          parseFloat(row['cpm'] || row['avg_engagement'] || 0) || 0,
          row['\u6807\u7b7e'] || row['category'] || '', '',
          row['\u56fd\u5bb6'] || row['region'] || '', '',
          '', 'Dedicated',
          parseFloat(row['\u6210\u672c\u4ef7'] || row['cost_usd'] || 0) || 0,
          parseFloat(row['cpm'] || 0) || 0,
          '', row['\u90ae\u7bb1'] || row['contact_email'] || '',
          row['\u9879\u76ee'] || row['project_name'] || '',
          row['\u63a8\u5e7f\u4ea7\u54c1'] || row['product_name'] || '',
          row['\u63d0\u62a5\u4eba'] || row['reporter'] || '',
          row['\u6807\u7b7e'] || row['tags'] || '',
          parseFloat(row['\u5bf9\u5916\u5546\u52a1\u62a5\u4ef7'] || row['quoted_price'] || 0) || 0,
          row['\u7f51\u7ea2\u4ea4\u4ed8\u7269'] || row['content_deliverable'] || '',
          0, batch, 'import'
        );
        imported++;
      }
    });
    doImport();
    res.json({ imported, skipped, batch, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/influencers/export', authMiddleware, (req, res) => {
  try {
    const { mode, ids, filters } = req.body;
    let sql = 'SELECT * FROM influencers WHERE 1=1';
    const params = [];
    if (mode === 'selected' && ids && ids.length) {
      sql += ' AND id IN (' + ids.map(function() { return '?' }).join(',') + ')';
      params.push.apply(params, ids);
    } else if (mode === 'filtered' && filters) {
      if (filters.platform) { sql += ' AND platform = ?'; params.push(filters.platform); }
      if (filters.region) { sql += ' AND region = ?'; params.push(filters.region); }
      if (filters.project_name) { sql += ' AND project_name = ?'; params.push(filters.project_name); }
      if (filters.product_name) { sql += ' AND product_name = ?'; params.push(filters.product_name); }
      if (filters.tags) { sql += ' AND tags LIKE ?'; params.push('%' + filters.tags + '%'); }
      if (filters.search) { sql += ' AND (kol_handle LIKE ? OR project_name LIKE ? OR product_name LIKE ?)'; params.push('%' + filters.search + '%', '%' + filters.search + '%', '%' + filters.search + '%'); }
    }
    sql += ' ORDER BY followers DESC';
    const influencers = db.prepare(sql).all(...params);
    const headers = ['\u65e5\u671f', '\u63d0\u62a5\u4eba', '\u9879\u76ee', '\u63a8\u5e7f\u4ea7\u54c1', '\u662f\u5426\u91cd\u590d', '\u7f51\u7ea2\u9891\u9053\u540d\u79f0', '\u7f51\u7ea2\u7c89\u4e1d\u91cf', '\u7f51\u7ea2\u9891\u9053\u94fe\u63a5', '\u793e\u5a92\u5e73\u53f0', '\u56fd\u5bb6', '\u6807\u7b7e', '\u8fd110\u4e2a\u89c6\u9891\u5747\u64ad', '\u6210\u672c\u4ef7', '\u7f51\u7ea2\u4ea4\u4ed8\u7269', 'Turing\u5907\u6ce8', '\u5bf9\u5916\u5546\u52a1\u62a5\u4ef7', '\u90ae\u7bb1', 'cpm', 'cpv'];
    const csvRows = influencers.map(function(inf) {
      return [ (inf.created_at||'').substring(0,10), inf.reporter||'', inf.project_name||'', inf.product_name||'', inf.is_duplicate ? '\u662f' : '\u5426', inf.kol_handle||'', inf.followers||0, inf.profile_link||'', inf.platform||'', inf.region||'', inf.tags||'', inf.avg_views_10||0, inf.cost_usd||0, inf.content_deliverable||'', '', inf.quoted_price||0, inf.contact_email||'', inf.cpm||0, '' ].join(',');
    });
    const csv = '\ufeff' + headers.join(',') + '\n' + csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=influencers_export.csv');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

};