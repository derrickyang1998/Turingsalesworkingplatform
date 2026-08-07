function collaborationRequestId(request) {
  return request.requestId ||
    request.phase4Request && request.phase4Request.requestId ||
    'campaign-link-request';
}

module.exports = function(app, db, authMiddleware, options = {}) {

const businessKnowledge = require('./services/business_knowledge_service');
const influencerWorkflow = require('./services/influencer_workflow_service');
const campaignCollaboration = options.campaignCollaborationService;

// ===== INFLUENCER ROUTES =====
app.get('/api/influencers', authMiddleware, (req, res) => {
  const { platform, category, region, search, min_followers, max_followers, sort_by, project_name, product_name, tags } = req.query;
  let sql = 'SELECT * FROM influencers WHERE is_active = 1';
  const params = [];
  if (platform) { sql += ' AND platform = ?'; params.push(platform); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (region) { sql += ' AND region = ?'; params.push(region); }
  if (project_name) { sql += ' AND project_name LIKE ?'; params.push('%' + project_name + '%'); }
  if (product_name) { sql += ' AND product_name LIKE ?'; params.push('%' + product_name + '%'); }
  if (tags) { sql += ' AND (tags LIKE ? OR category LIKE ?)'; params.push('%' + tags + '%', '%' + tags + '%'); }
  if (search) {
    sql += ` AND (
      CAST(id AS TEXT) LIKE ? OR
      kol_handle LIKE ? OR
      profile_link LIKE ? OR
      content_style LIKE ? OR
      brand_collab_history LIKE ? OR
      project_name LIKE ? OR
      product_name LIKE ? OR
      tags LIKE ? OR
      category LIKE ? OR
      platform LIKE ? OR
      region LIKE ? OR
      contact_email LIKE ? OR
      content_deliverable LIKE ? OR
      influencer_type LIKE ? OR
      parent_record LIKE ? OR
      CAST(followers AS TEXT) LIKE ? OR
      CAST(avg_views_10 AS TEXT) LIKE ? OR
      CAST(cost_usd AS TEXT) LIKE ? OR
      CAST(quoted_price AS TEXT) LIKE ? OR
      CAST(cpm AS TEXT) LIKE ? OR
      CAST(cpv AS TEXT) LIKE ?
    )`;
    for (let i = 0; i < 21; i++) params.push('%' + search + '%');
  }
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
  businessKnowledge.archiveInfluencer(db, db.prepare('SELECT * FROM influencers WHERE id = ?').get(result.lastInsertRowid), req.user);
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
  if (req.body && Object.hasOwn(req.body, 'campaign_id')) {
    try {
      const result = campaignCollaboration.createLinked({
        userId: req.user.id,
        requestId: collaborationRequestId(req),
        idempotencyKey: req.get ? req.get('Idempotency-Key') : req.headers && req.headers['idempotency-key'],
        body: req.body
      });
      return res.status(result.status).json(result.body);
    } catch (error) {
      const status = error.statusCode || error.status || 500;
      const body = { error: error.message || 'Collaboration create failed.', code: error.code || 'INTERNAL_ERROR' };
      if (error.details !== undefined) body.details = error.details;
      return res.status(status).json(body);
    }
  }
  const { demand_id, influencer_id, status, proposal_notes, cost_quoted, notes, resource, timeline_start, timeline_end } = req.body;
  const resourcePayload = resource && typeof resource === 'object' ? resource : {};
  const hasResource = Object.keys(resourcePayload).length > 0;
  const resourceNotes = proposal_notes || (hasResource ? JSON.stringify(resourcePayload) : null);
  const quoted = cost_quoted !== undefined && cost_quoted !== null && cost_quoted !== ''
    ? cost_quoted
    : (resourcePayload.quoted_price || resourcePayload.price || 0);
  const result = db.prepare('INSERT INTO collaborations (demand_id, influencer_id, user_id, status, proposal_notes, cost_quoted, notes, timeline_start, timeline_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    demand_id, influencer_id, req.user.id, status || 'proposed', resourceNotes, quoted || 0, notes || resourcePayload.notes || '', timeline_start || resourcePayload.timeline_start || null, timeline_end || resourcePayload.timeline_end || null
  );
  db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'create_collab', 'collaboration', 'Created collaboration for influencer ' + influencer_id, req.ip);
  businessKnowledge.archiveCollaboration(db, db.prepare('SELECT * FROM collaborations WHERE id = ?').get(result.lastInsertRowid), req.user);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/collaborations', authMiddleware, (req, res) => {
  const { status, demand_id } = req.query;
  res.json(campaignCollaboration.list({
    userId: req.user.id,
    status,
    demandId: demand_id
  }));
});

app.put('/api/collaborations/:id', authMiddleware, (req, res) => {
  try {
    const request = {
      userId: req.user.id,
      collaborationId: Number(req.params.id),
      requestId: collaborationRequestId(req),
      idempotencyKey: req.get ? req.get('Idempotency-Key') : req.headers && req.headers['idempotency-key'],
      body: req.body
    };
    const result = req.body && Object.hasOwn(req.body, 'campaign_id')
      ? campaignCollaboration.updateLinked(request)
      : campaignCollaboration.updateLegacy(request);
    if (!Object.hasOwn(req.body || {}, 'campaign_id')) {
      db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'update_collab', 'collaboration', 'Updated collaboration ' + req.params.id + ' to ' + (req.body.status || 'no_status_change'), req.ip);
      businessKnowledge.archiveCollaboration(db, db.prepare('SELECT * FROM collaborations WHERE id = ?').get(req.params.id), req.user);
    }
    res.status(result.status || 200).json(result.body || { success: true });
  } catch (error) {
    const status = error.statusCode || error.status || 500;
    const body = { error: error.message || 'Collaboration update failed.', code: error.code || 'INTERNAL_ERROR' };
    if (error.details !== undefined) body.details = error.details;
    res.status(status).json(body);
  }
});

app.get('/api/collaborations/stats', authMiddleware, (req, res) => {
  res.json(campaignCollaboration.stats({ userId: req.user.id }));
});

// ===== V8.1: INFLUENCER IMPORT/EXPORT =====
app.get('/api/influencers/template', authMiddleware, (req, res) => {
  const csv = influencerWorkflow.buildTemplateCsv();
  res.setHeader('Content-Type', 'text/csv;charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=influencer_import_template.csv');
  res.send(csv);
});

app.post('/api/influencers/import', authMiddleware, (req, res) => {
  try {
    const { rows, batch_id } = req.body;
    const result = influencerWorkflow.importInfluencerRows(db, rows, {
      batch_id,
      user: req.user,
      data_source: 'import'
    });
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/influencers/feishu/sync', authMiddleware, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    const rows = ids.length ? influencerWorkflow.queryInfluencers(db, { ids }) : [];
    if (!rows.length) return res.status(400).json({ error: 'No influencers selected' });
    const csv = influencerWorkflow.buildInfluencerCsv(rows);
    const records = rows.map(function(row, index) {
      const values = influencerWorkflow.influencerToTemplateRow(row, index);
      const record = {};
      influencerWorkflow.TEMPLATE_HEADERS.forEach(function(header, headerIndex) { record[header] = values[headerIndex]; });
      return record;
    });
    const webhook = process.env.FEISHU_WEBHOOK_URL || process.env.FEISHU_WEBHOOK;
    if (!webhook) {
      return res.json({
        configured: false,
        records: records.length,
        csv,
        message: 'FEISHU_WEBHOOK_URL is not configured. CSV fallback is ready for manual upload.'
      });
    }
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'turingmarket.influencers.sync',
        source: 'TuringMarket',
        records,
        csv
      })
    });
    if (!response.ok) {
      return res.status(502).json({ configured: true, synced: 0, records: records.length, error: 'Feishu webhook failed with HTTP ' + response.status, csv });
    }
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'feishu_sync', 'influencer', 'Synced ' + records.length + ' influencers to Feishu workflow', req.ip);
    res.json({ configured: true, synced: records.length, records: records.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/influencers/export', authMiddleware, (req, res) => {
  try {
    const { mode, ids, filters } = req.body;
    let sql = 'SELECT * FROM influencers WHERE is_active = 1';
    const params = [];
    if (mode === 'selected') {
      const selectedIds = Array.isArray(ids)
        ? ids.map(Number).filter(function(id) { return Number.isInteger(id) && id > 0; })
        : [];
      if (selectedIds.length) {
        sql += ' AND id IN (' + selectedIds.map(function() { return '?' }).join(',') + ')';
        params.push.apply(params, selectedIds);
      } else {
        sql += ' AND 1 = 0';
      }
    } else if (mode === 'filtered' && filters) {
      if (filters.platform) { sql += ' AND platform = ?'; params.push(filters.platform); }
      if (filters.category) { sql += ' AND category = ?'; params.push(filters.category); }
      if (filters.region) { sql += ' AND region = ?'; params.push(filters.region); }
      if (filters.project_name) { sql += ' AND project_name LIKE ?'; params.push('%' + filters.project_name + '%'); }
      if (filters.product_name) { sql += ' AND product_name LIKE ?'; params.push('%' + filters.product_name + '%'); }
      if (filters.tags) { sql += ' AND (tags LIKE ? OR category LIKE ?)'; params.push('%' + filters.tags + '%', '%' + filters.tags + '%'); }
      if (filters.search) {
        sql += ` AND (
          CAST(id AS TEXT) LIKE ? OR
          kol_handle LIKE ? OR
          profile_link LIKE ? OR
          content_style LIKE ? OR
          brand_collab_history LIKE ? OR
          project_name LIKE ? OR
          product_name LIKE ? OR
          tags LIKE ? OR
          category LIKE ? OR
          platform LIKE ? OR
          region LIKE ? OR
          contact_email LIKE ? OR
          content_deliverable LIKE ? OR
          influencer_type LIKE ? OR
          parent_record LIKE ? OR
          CAST(followers AS TEXT) LIKE ? OR
          CAST(avg_views_10 AS TEXT) LIKE ? OR
          CAST(cost_usd AS TEXT) LIKE ? OR
          CAST(quoted_price AS TEXT) LIKE ? OR
          CAST(cpm AS TEXT) LIKE ? OR
          CAST(cpv AS TEXT) LIKE ?
        )`;
        for (let i = 0; i < 21; i++) params.push('%' + filters.search + '%');
      }
      if (filters.min_followers) { sql += ' AND followers >= ?'; params.push(parseInt(filters.min_followers)); }
      if (filters.max_followers) { sql += ' AND followers <= ?'; params.push(parseInt(filters.max_followers)); }
    }
    sql += ' ORDER BY followers DESC';
    const influencers = db.prepare(sql).all(...params);
    const csv = influencerWorkflow.buildInfluencerCsv(influencers);
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=influencers_export.csv');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

};
