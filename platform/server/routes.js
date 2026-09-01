function collaborationRequestId(request) {
  return request.requestId ||
    request.phase4Request && request.phase4Request.requestId ||
    'campaign-link-request';
}

const { createFeishuClient, FeishuClientError } = require('./feishu_client');
const {
  CollaborationResourceContractError,
  isV1CollaborationResourceInput,
  normalizeCollaborationResource,
  resolveResourceQuotedPrice,
  serializeCollaborationResource
} = require('./services/collaboration_resource_contract');

module.exports = function(app, db, authMiddleware, options = {}) {

const businessKnowledge = require('./services/business_knowledge_service');
const influencerWorkflow = require('./services/influencer_workflow_service');
const campaignCollaboration = options.campaignCollaborationService;
const feishuClient = options.feishuClient || createFeishuClient();

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
  const versionedResourceRequest = isV1CollaborationResourceInput(resource);
  let resourcePayload = resource && typeof resource === 'object' ? resource : {};
  let resourceNotes = proposal_notes || (Object.keys(resourcePayload).length ? JSON.stringify(resourcePayload) : null);
  let quoted = cost_quoted !== undefined && cost_quoted !== null && cost_quoted !== ''
    ? cost_quoted
    : (resourcePayload.quoted_price || resourcePayload.price || 0);
  try {
    if (versionedResourceRequest) {
      resourcePayload = normalizeCollaborationResource(resource);
      if (Object.hasOwn(req.body, 'proposal_notes')) {
        return res.status(400).json({
          error: 'resource and proposal_notes cannot be supplied together.',
          code: 'RESOURCE_PROPOSAL_NOTES_CONFLICT'
        });
      }
      resourceNotes = serializeCollaborationResource(resourcePayload);
      quoted = resolveResourceQuotedPrice(resourcePayload, cost_quoted);
    }
  } catch (error) {
    if (error instanceof CollaborationResourceContractError) {
      const body = { error: error.message, code: error.code };
      if (error.details !== undefined) body.details = error.details;
      return res.status(error.statusCode).json(body);
    }
    throw error;
  }
  const resourceFallbacks = versionedResourceRequest && resourcePayload.extensions
    ? resourcePayload.extensions
    : resourcePayload;
  const resourceNoteFallback = typeof resourceFallbacks.notes === 'string' ? resourceFallbacks.notes : '';
  const resourceTimelineStart = typeof resourceFallbacks.timeline_start === 'string' ? resourceFallbacks.timeline_start : null;
  const resourceTimelineEnd = typeof resourceFallbacks.timeline_end === 'string' ? resourceFallbacks.timeline_end : null;
  const result = db.prepare('INSERT INTO collaborations (demand_id, influencer_id, user_id, status, proposal_notes, cost_quoted, notes, timeline_start, timeline_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    demand_id, influencer_id, req.user.id, status || 'proposed', resourceNotes, quoted || 0, notes || resourceNoteFallback || '', timeline_start || resourceTimelineStart, timeline_end || resourceTimelineEnd
  );
  db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'create_collab', 'collaboration', 'Created collaboration for influencer ' + influencer_id, req.ip);
  businessKnowledge.archiveCollaboration(db, db.prepare('SELECT * FROM collaborations WHERE id = ?').get(result.lastInsertRowid), req.user);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/collaborations', authMiddleware, (req, res) => {
  const { status, demand_id, campaign_id, include_campaign_context } = req.query;
  res.json(campaignCollaboration.list({
    userId: req.user.id,
    status,
    demandId: demand_id,
    campaignId: campaign_id,
    includeCampaignContext: include_campaign_context === '1' || include_campaign_context === 'true'
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
    const operationId = req.get
      ? req.get('Idempotency-Key')
      : req.headers && req.headers['idempotency-key'];
    const result = await feishuClient.syncInfluencers({ records, csv, operationId });
    if (!result.configured) {
      return res.json({
        configured: false,
        records: result.records,
        csv: result.csv,
        message: result.mode === 'bitable'
          ? result.message
          : 'FEISHU_WEBHOOK_URL is not configured. CSV fallback is ready for manual upload.'
      });
    }
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'feishu_sync', 'influencer', 'Synced ' + result.synced + ' influencers to Feishu ' + result.mode, req.ip);
    res.json({ configured: true, synced: result.synced, records: result.records });
  } catch (e) {
    const statusCode = e instanceof FeishuClientError ? e.statusCode : 502;
    const code = e instanceof FeishuClientError ? e.code : 'FEISHU_SYNC_FAILED';
    const message = e instanceof FeishuClientError ? e.message : 'Feishu sync failed.';
    try {
      db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, 'feishu_sync_failed', 'influencer', JSON.stringify({ code }), req.ip);
    } catch (auditError) {}
    res.status(statusCode).json({ error: message, code });
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
