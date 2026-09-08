function collaborationRequestId(request) {
  return request.requestId ||
    request.phase4Request && request.phase4Request.requestId ||
    'campaign-link-request';
}

function canonicalPositiveRouteId(value) {
  const text = String(value || '');
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && String(parsed) === text ? parsed : null;
}

function contractDocumentDisposition(document) {
  const encoded = encodeURIComponent(document.original_filename)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="contract-${document.id}.pdf"; filename*=UTF-8''${encoded}`;
}

const { createFeishuClient, FeishuClientError } = require('./feishu_client');
const {
  FeishuBitableOutboxError,
  createFeishuBitableOutboxService
} = require('./services/feishu_bitable_outbox_service');
const {
  CollaborationResourceContractError,
  isReservedV2ProposalNotes,
  isV2CollaborationResourceInput,
  isVersionedCollaborationResourceInput,
  normalizeCollaborationResource,
  resolveResourceQuotedPrice,
  serializeCollaborationResource
} = require('./services/collaboration_resource_contract');
const {
  InfluencerSavedViewError,
  createInfluencerSavedViewService
} = require('./services/influencer_saved_view_service');

class InfluencerFilterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InfluencerFilterError';
    this.code = 'INVALID_INFLUENCER_FILTER';
    this.statusCode = 400;
  }
}

const INFLUENCER_FILTER_TEXT_LIMIT = 200;

function influencerFilterObject(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InfluencerFilterError('Influencer filters must be an object.');
  }
  return value;
}

function influencerTextFilter(filters, name) {
  const value = filters[name];
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InfluencerFilterError(`Invalid ${name} filter.`);
  }
  const normalized = String(value).trim();
  if (normalized.length > INFLUENCER_FILTER_TEXT_LIMIT) {
    throw new InfluencerFilterError(`${name} filter is too long.`);
  }
  return normalized;
}

function influencerIntegerFilter(filters, name, options = {}) {
  let value = influencerTextFilter(filters, name);
  if (!value) return null;
  if (options.allowHash) value = value.replace(/^#/, '');
  if (!/^\d{1,16}$/.test(value)) {
    throw new InfluencerFilterError(`Invalid ${name} filter.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (options.minimum || 0)) {
    throw new InfluencerFilterError(`Invalid ${name} filter.`);
  }
  return parsed;
}

function influencerAmountFilter(filters, name) {
  const value = influencerTextFilter(filters, name);
  if (!value) return null;
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(value)) {
    throw new InfluencerFilterError(`Invalid ${name} filter.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InfluencerFilterError(`Invalid ${name} filter.`);
  }
  return parsed;
}

function buildInfluencerSelect(filters, options = {}) {
  filters = influencerFilterObject(filters);
  let sql = 'SELECT * FROM influencers WHERE is_active = 1';
  const params = [];
  const exactText = [
    ['platform', 'platform'],
    ['category', 'category'],
    ['region', 'region']
  ];
  const containsText = [
    ['project_name', 'project_name'],
    ['product_name', 'product_name'],
    ['filter_kol_handle', 'kol_handle'],
    ['filter_platform', 'platform'],
    ['filter_project_name', 'project_name'],
    ['filter_product_name', 'product_name'],
    ['filter_region', 'region'],
    ['filter_parent_record', 'parent_record'],
    ['filter_profile_link', 'profile_link']
  ];

  exactText.forEach(function(definition) {
    const value = influencerTextFilter(filters, definition[0]);
    if (!value) return;
    sql += ` AND ${definition[1]} = ?`;
    params.push(value);
  });
  containsText.forEach(function(definition) {
    const value = influencerTextFilter(filters, definition[0]);
    if (!value) return;
    sql += ` AND ${definition[1]} LIKE ?`;
    params.push('%' + value + '%');
  });

  const tags = influencerTextFilter(filters, 'tags');
  if (tags) {
    sql += ' AND (tags LIKE ? OR category LIKE ?)';
    params.push('%' + tags + '%', '%' + tags + '%');
  }

  const type = influencerTextFilter(filters, 'filter_type');
  if (type) {
    sql += " AND COALESCE(NULLIF(influencer_type, ''), NULLIF(tags, ''), NULLIF(category, ''), '') LIKE ?";
    params.push('%' + type + '%');
  }

  const deliverable = influencerTextFilter(filters, 'filter_content_deliverable');
  if (deliverable) {
    sql += " AND COALESCE(NULLIF(content_deliverable, ''), NULLIF(collab_type, ''), '') LIKE ?";
    params.push('%' + deliverable + '%');
  }

  const search = influencerTextFilter(filters, 'search');
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

  const id = influencerIntegerFilter(filters, 'filter_id', { allowHash: true, minimum: 1 });
  if (id !== null) {
    sql += ' AND id = ?';
    params.push(id);
  }
  const followers = influencerIntegerFilter(filters, 'filter_followers');
  if (followers !== null) {
    sql += ' AND followers = ?';
    params.push(followers);
  }
  const cost = influencerAmountFilter(filters, 'filter_cost');
  if (cost !== null) {
    sql += ' AND COALESCE(NULLIF(quoted_price, 0), cost_usd, 0) = ?';
    params.push(cost);
  }
  const dedicatedAmounts = [
    ['filter_cost_usd', 'cost_usd'],
    ['filter_quoted_price', 'quoted_price'],
    ['filter_cpm', 'cpm'],
    ['filter_cpv', 'cpv']
  ];
  dedicatedAmounts.forEach(function(definition) {
    const value = influencerAmountFilter(filters, definition[0]);
    if (value === null) return;
    sql += ` AND COALESCE(${definition[1]}, 0) = ?`;
    params.push(value);
  });
  const minFollowers = influencerIntegerFilter(filters, 'min_followers');
  if (minFollowers !== null) {
    sql += ' AND followers >= ?';
    params.push(minFollowers);
  }
  const maxFollowers = influencerIntegerFilter(filters, 'max_followers');
  if (maxFollowers !== null) {
    sql += ' AND followers <= ?';
    params.push(maxFollowers);
  }

  const sortBy = influencerTextFilter(filters, 'sort_by');
  const sortColumns = { engagement: 'avg_engagement', followers: 'followers', cost_usd: 'cost_usd' };
  const sortColumn = sortColumns[sortBy] || 'followers';
  sql += ` ORDER BY ${sortColumn} DESC`;
  if (options.limit !== false) sql += ' LIMIT 200';
  return { sql, params };
}

function sendInfluencerFilterError(res, error) {
  if (!(error instanceof InfluencerFilterError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

module.exports = function(app, db, authMiddleware, options = {}) {

const businessKnowledge = require('./services/business_knowledge_service');
const influencerWorkflow = require('./services/influencer_workflow_service');
const influencerSavedViews = options.influencerSavedViewService || createInfluencerSavedViewService(db);
const campaignCollaboration = options.campaignCollaborationService;
const feishuClient = options.feishuClient || createFeishuClient();
const feishuBitableOutbox = options.feishuBitableOutboxService || createFeishuBitableOutboxService(db);

function feishuCampaignId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && String(parsed) === value) return parsed;
  }
  return null;
}

function writeFeishuSyncAudit(req, action, details) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, action, 'influencer', JSON.stringify(details || {}), req.ip);
  } catch (auditError) {}
}

function feishuFailure(error) {
  if (error instanceof FeishuBitableOutboxError) {
    return { statusCode: error.statusCode || 500, code: error.code, message: error.message };
  }
  if (error instanceof FeishuClientError) {
    return { statusCode: error.statusCode || 502, code: error.code, message: error.message };
  }
  return { statusCode: 502, code: 'FEISHU_SYNC_FAILED', message: 'Feishu sync failed.' };
}

function bitableOutboxEnabled(status, campaignId) {
  return campaignId !== null && Boolean(status && status.configured && status.mode === 'bitable' && status.sync_available);
}

function requiresFeishuReconciliation(failure) {
  return [
    'FEISHU_PROVIDER_UNAVAILABLE',
    'FEISHU_WRITE_RESULT_INCOMPLETE',
    'FEISHU_SYNC_FAILED',
    'FEISHU_OUTBOX_FINALIZATION_FAILED',
    'FEISHU_OUTBOX_RECEIPT_INVALID'
  ].includes(failure.code);
}

// ===== INFLUENCER ROUTES =====
app.get('/api/influencers', authMiddleware, (req, res) => {
  try {
    const query = buildInfluencerSelect(req.query);
    const influencers = db.prepare(query.sql).all(...query.params);
    res.json({ influencers, total: influencers.length });
  } catch (error) {
    if (sendInfluencerFilterError(res, error)) return;
    res.status(500).json({ error: error.message });
  }
});

function sendInfluencerViewError(res, error) {
  if (!(error instanceof InfluencerSavedViewError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

app.get('/api/influencer-views', authMiddleware, (req, res) => {
  try {
    res.json(influencerSavedViews.list({ userId: req.user.id }));
  } catch (error) {
    if (sendInfluencerViewError(res, error)) return;
    res.status(500).json({ error: 'Saved views are unavailable.' });
  }
});

app.post('/api/influencer-views', authMiddleware, (req, res) => {
  try {
    const result = influencerSavedViews.save({ userId: req.user.id, body: req.body });
    res.status(result.status).json({ view: result.view });
  } catch (error) {
    if (sendInfluencerViewError(res, error)) return;
    res.status(500).json({ error: 'Saved view could not be stored.' });
  }
});

app.delete('/api/influencer-views/:id', authMiddleware, (req, res) => {
  try {
    const removed = influencerSavedViews.remove({ userId: req.user.id, viewId: req.params.id });
    if (!removed) return res.status(404).json({ error: 'Saved view was not found.', code: 'INFLUENCER_VIEW_NOT_FOUND' });
    return res.json({ success: true });
  } catch (error) {
    if (sendInfluencerViewError(res, error)) return;
    return res.status(500).json({ error: 'Saved view could not be deleted.' });
  }
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
  if (isReservedV2ProposalNotes(proposal_notes) && !isV2CollaborationResourceInput(resource)) {
    return res.status(400).json({
      error: 'Version 2 collaboration orders must be supplied through resource.',
      code: 'RESOURCE_V2_REQUIRES_RESOURCE'
    });
  }
  const versionedResourceRequest = isVersionedCollaborationResourceInput(resource);
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

app.post('/api/collaborations/:id/contract-documents', authMiddleware, (req, res) => {
  try {
    const collaborationId = canonicalPositiveRouteId(req.params.id);
    if (collaborationId === null) {
      return res.status(400).json({
        error: 'Collaboration id is invalid.',
        code: 'INVALID_COLLABORATION_ID'
      });
    }
    const result = campaignCollaboration.uploadContractDocument({
      userId: req.user.id,
      collaborationId,
      requestId: collaborationRequestId(req),
      idempotencyKey: req.get ? req.get('Idempotency-Key') : req.headers && req.headers['idempotency-key'],
      body: req.body
    });
    res.status(result.status || 201).json(result.body);
  } catch (error) {
    const status = error.statusCode || error.status || 500;
    const body = {
      error: error.message || 'Contract document upload failed.',
      code: error.code || 'INTERNAL_ERROR'
    };
    if (error.details !== undefined) body.details = error.details;
    res.status(status).json(body);
  }
});

app.get('/api/collaborations/:id/contract-documents', authMiddleware, (req, res) => {
  try {
    const collaborationId = canonicalPositiveRouteId(req.params.id);
    if (collaborationId === null) {
      return res.status(400).json({
        error: 'Collaboration id is invalid.',
        code: 'INVALID_COLLABORATION_ID'
      });
    }
    res.json(campaignCollaboration.listContractDocuments({
      userId: req.user.id,
      collaborationId
    }));
  } catch (error) {
    const status = error.statusCode || error.status || 500;
    const body = {
      error: error.message || 'Contract document list failed.',
      code: error.code || 'INTERNAL_ERROR'
    };
    if (error.details !== undefined) body.details = error.details;
    res.status(status).json(body);
  }
});

app.get('/api/collaborations/:id/contract-documents/:documentId/download', authMiddleware, (req, res) => {
  try {
    const collaborationId = canonicalPositiveRouteId(req.params.id);
    const documentId = canonicalPositiveRouteId(req.params.documentId);
    if (collaborationId === null || documentId === null) {
      return res.status(400).json({
        error: 'Contract document id is invalid.',
        code: 'INVALID_CONTRACT_DOCUMENT_ID'
      });
    }
    const result = campaignCollaboration.downloadContractDocument({
      userId: req.user.id,
      collaborationId,
      documentId
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contractDocumentDisposition(result.document));
    res.setHeader('Content-Length', String(result.bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(result.bytes);
  } catch (error) {
    const status = error.statusCode || error.status || 500;
    const body = {
      error: error.message || 'Contract document download failed.',
      code: error.code || 'INTERNAL_ERROR'
    };
    if (error.details !== undefined) body.details = error.details;
    res.status(status).json(body);
  }
});

app.post('/api/collaborations/:id/contract-confirmations', authMiddleware, (req, res) => {
  try {
    const collaborationIdText = String(req.params.id || '');
    const collaborationId = /^[1-9]\d*$/.test(collaborationIdText)
      ? Number(collaborationIdText)
      : null;
    if (!Number.isSafeInteger(collaborationId)) {
      return res.status(400).json({
        error: 'Collaboration id is invalid.',
        code: 'INVALID_COLLABORATION_ID'
      });
    }
    const result = campaignCollaboration.confirmContract({
      userId: req.user.id,
      collaborationId,
      requestId: collaborationRequestId(req),
      idempotencyKey: req.get ? req.get('Idempotency-Key') : req.headers && req.headers['idempotency-key'],
      body: req.body
    });
    res.status(result.status || 201).json(result.body);
  } catch (error) {
    const status = error.statusCode || error.status || 500;
    const body = {
      error: error.message || 'Signed contract confirmation failed.',
      code: error.code || 'INTERNAL_ERROR'
    };
    if (error.details !== undefined) body.details = error.details;
    res.status(status).json(body);
  }
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
    const campaignRequested = Boolean(req.body && Object.hasOwn(req.body, 'campaign_id'));
    const campaignId = campaignRequested ? feishuCampaignId(req.body.campaign_id) : null;
    if (campaignRequested && campaignId === null) {
      return res.status(400).json({
        error: 'A valid campaign_id is required for campaign-scoped Feishu delivery.',
        code: 'FEISHU_OUTBOX_REQUEST_INVALID'
      });
    }
    const feishuStatus = campaignId === null ? null : feishuClient.getStatus();
    if (bitableOutboxEnabled(feishuStatus, campaignId)) {
      if (typeof feishuClient.prepareBitableOutboxPayload !== 'function') {
        throw new FeishuClientError('FEISHU_OUTBOX_NOT_SUPPORTED', 'Feishu Bitable delivery is not available.', 502);
      }
      const snapshot = feishuClient.prepareBitableOutboxPayload({ records, operationId });
      const reservation = feishuBitableOutbox.reserve({
        userId: req.user.id,
        campaignId,
        operationId,
        records: snapshot.records
      });
      if (reservation.state === 'replay') {
        return res.json({
          configured: true,
          synced: reservation.delivery.record_count,
          records: reservation.delivery.record_count,
          delivery: reservation.delivery
        });
      }
      if (reservation.state === 'failed') {
        return res.status(409).json({
          error: 'This Feishu delivery previously failed. Use the explicit retry workflow.',
          code: 'FEISHU_OUTBOX_RETRY_REQUIRED',
          delivery: reservation.delivery
        });
      }
      if (reservation.state === 'processing') {
        return res.status(409).json({
          error: 'This Feishu delivery requires reconciliation before another write is attempted.',
          code: 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED',
          delivery: reservation.delivery
        });
      }
      let result;
      try {
        result = await feishuClient.syncInfluencers({
          records,
          csv,
          operationId,
          bitableRecords: snapshot.records,
          includeReceipt: true
        });
      } catch (providerError) {
        const providerFailure = feishuFailure(providerError);
        if (requiresFeishuReconciliation(providerFailure)) {
          writeFeishuSyncAudit(req, 'feishu_sync_reconciliation_required', {
            campaign_id: campaignId,
            delivery_id: reservation.delivery.id,
            code: providerFailure.code
          });
          return res.status(202).json({
            error: 'Feishu delivery result requires reconciliation before another write is attempted.',
            code: 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED',
            delivery: reservation.delivery
          });
        }
        feishuBitableOutbox.fail({
          deliveryId: reservation.delivery.id,
          reservationToken: reservation.reservationToken,
          errorCode: providerFailure.code
        });
        throw providerError;
      }
      if (!result.configured) {
        const delivery = feishuBitableOutbox.fail({
          deliveryId: reservation.delivery.id,
          reservationToken: reservation.reservationToken,
          errorCode: 'FEISHU_BITABLE_WRITE_NOT_AVAILABLE'
        });
        return res.json({
          configured: false,
          records: result.records,
          csv: result.csv,
          message: result.message || 'Feishu Bitable write is no longer available. CSV fallback is ready for manual upload.',
          delivery
        });
      }
      let delivery;
      try {
        delivery = feishuBitableOutbox.complete({
          deliveryId: reservation.delivery.id,
          reservationToken: reservation.reservationToken,
          remoteRecordIds: result.remoteRecordIds
        });
      } catch (finalizationError) {
        const finalizationFailure = feishuFailure(finalizationError);
        writeFeishuSyncAudit(req, 'feishu_sync_reconciliation_required', {
          campaign_id: campaignId,
          delivery_id: reservation.delivery.id,
          code: finalizationFailure.code
        });
        return res.status(202).json({
          error: 'Feishu delivery result requires reconciliation before another write is attempted.',
          code: 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED',
          delivery: reservation.delivery
        });
      }
      writeFeishuSyncAudit(req, 'feishu_sync', {
        mode: result.mode,
        synced: result.synced,
        campaign_id: campaignId,
        delivery_id: delivery.id,
        delivery_status: delivery.status
      });
      return res.json({ configured: true, synced: result.synced, records: result.records, delivery });
    }
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
    writeFeishuSyncAudit(req, 'feishu_sync', { mode: result.mode, synced: result.synced });
    res.json({ configured: true, synced: result.synced, records: result.records });
  } catch (e) {
    const failure = feishuFailure(e);
    writeFeishuSyncAudit(req, 'feishu_sync_failed', { code: failure.code });
    res.status(failure.statusCode).json({ error: failure.message, code: failure.code });
  }
});

app.get('/api/campaigns/:id/feishu-deliveries', authMiddleware, (req, res) => {
  try {
    const deliveries = feishuBitableOutbox.list({
      userId: req.user.id,
      campaignId: req.params.id,
      limit: req.query && req.query.limit
    });
    res.json({ deliveries });
  } catch (error) {
    const failure = feishuFailure(error);
    res.status(failure.statusCode).json({ error: failure.message, code: failure.code });
  }
});

app.post('/api/campaigns/:id/feishu-deliveries/:deliveryId/reconcile', authMiddleware, (req, res) => {
  try {
    const delivery = feishuBitableOutbox.reconcile({
      userId: req.user.id,
      campaignId: req.params.id,
      deliveryId: req.params.deliveryId,
      remoteRecordIds: req.body && req.body.remote_record_ids
    });
    writeFeishuSyncAudit(req, 'feishu_sync_reconciled', {
      campaign_id: delivery.campaign_id,
      delivery_id: delivery.id,
      delivery_status: delivery.status,
      synced: delivery.record_count
    });
    res.json({ delivery });
  } catch (error) {
    const failure = feishuFailure(error);
    writeFeishuSyncAudit(req, 'feishu_sync_reconcile_failed', { code: failure.code });
    res.status(failure.statusCode).json({ error: failure.message, code: failure.code });
  }
});

app.post('/api/campaigns/:id/feishu-deliveries/:deliveryId/retry', authMiddleware, async (req, res) => {
  try {
    const campaignId = feishuCampaignId(req.params.id);
    const deliveryId = feishuCampaignId(req.params.deliveryId);
    const operationId = req.get
      ? req.get('Idempotency-Key')
      : req.headers && req.headers['idempotency-key'];
    if (campaignId === null || deliveryId === null) {
      return res.status(400).json({
        error: 'A valid campaign and Feishu delivery are required for retry.',
        code: 'FEISHU_OUTBOX_REQUEST_INVALID'
      });
    }
    const feishuStatus = feishuClient.getStatus();
    if (!bitableOutboxEnabled(feishuStatus, campaignId)) {
      throw new FeishuClientError('FEISHU_BITABLE_WRITE_NOT_AVAILABLE', 'Feishu Bitable delivery is not available.', 409);
    }
    const reservation = feishuBitableOutbox.retry({
      userId: req.user.id,
      campaignId,
      deliveryId,
      operationId,
      reason: req.body && req.body.reason
    });
    if (reservation.state === 'replay') {
      if (reservation.delivery.status === 'succeeded') {
        writeFeishuSyncAudit(req, 'feishu_sync_retry_replayed', {
          campaign_id: campaignId,
          delivery_id: reservation.delivery.id,
          retry_of_delivery_id: deliveryId,
          delivery_status: reservation.delivery.status
        });
        return res.json({
          configured: true,
          replayed: true,
          synced: reservation.delivery.remote_record_count,
          records: reservation.delivery.record_count,
          delivery: reservation.delivery
        });
      }
      if (reservation.delivery.status === 'pending') {
        return res.status(202).json({
          error: 'Feishu retry result requires reconciliation before another write is attempted.',
          code: 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED',
          delivery: reservation.delivery
        });
      }
      return res.status(409).json({
        error: 'The existing retry delivery failed. Retry that delivery explicitly after resolving the failure.',
        code: 'FEISHU_OUTBOX_RETRY_CHILD_FAILED',
        delivery: reservation.delivery
      });
    }
    let result;
    try {
      result = await feishuClient.syncInfluencers({
        records: reservation.records,
        csv: '',
        operationId,
        bitableRecords: reservation.records,
        includeReceipt: true
      });
    } catch (providerError) {
      const providerFailure = feishuFailure(providerError);
      if (requiresFeishuReconciliation(providerFailure)) {
        writeFeishuSyncAudit(req, 'feishu_sync_retry_reconciliation_required', {
          campaign_id: campaignId,
          delivery_id: reservation.delivery.id,
          retry_of_delivery_id: deliveryId,
          code: providerFailure.code
        });
        return res.status(202).json({
          error: 'Feishu retry result requires reconciliation before another write is attempted.',
          code: 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED',
          delivery: reservation.delivery
        });
      }
      const delivery = feishuBitableOutbox.fail({
        deliveryId: reservation.delivery.id,
        reservationToken: reservation.reservationToken,
        errorCode: providerFailure.code
      });
      writeFeishuSyncAudit(req, 'feishu_sync_retry_failed', {
        campaign_id: campaignId,
        delivery_id: delivery.id,
        retry_of_delivery_id: deliveryId,
        code: providerFailure.code
      });
      return res.status(providerFailure.statusCode).json({
        error: providerFailure.message,
        code: providerFailure.code,
        delivery
      });
    }
    if (!result.configured) {
      const delivery = feishuBitableOutbox.fail({
        deliveryId: reservation.delivery.id,
        reservationToken: reservation.reservationToken,
        errorCode: 'FEISHU_BITABLE_WRITE_NOT_AVAILABLE'
      });
      return res.json({
        configured: false,
        records: result.records,
        csv: result.csv,
        message: result.message || 'Feishu Bitable write is no longer available. CSV fallback is ready for manual upload.',
        delivery
      });
    }
    let delivery;
    try {
      delivery = feishuBitableOutbox.complete({
        deliveryId: reservation.delivery.id,
        reservationToken: reservation.reservationToken,
        remoteRecordIds: result.remoteRecordIds
      });
    } catch (finalizationError) {
      const finalizationFailure = feishuFailure(finalizationError);
      writeFeishuSyncAudit(req, 'feishu_sync_retry_reconciliation_required', {
        campaign_id: campaignId,
        delivery_id: reservation.delivery.id,
        retry_of_delivery_id: deliveryId,
        code: finalizationFailure.code
      });
      return res.status(202).json({
        error: 'Feishu retry result requires reconciliation before another write is attempted.',
        code: 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED',
        delivery: reservation.delivery
      });
    }
    writeFeishuSyncAudit(req, 'feishu_sync_retry', {
      mode: result.mode,
      synced: result.synced,
      campaign_id: campaignId,
      delivery_id: delivery.id,
      retry_of_delivery_id: deliveryId,
      delivery_status: delivery.status
    });
    return res.json({ configured: true, synced: result.synced, records: result.records, delivery });
  } catch (error) {
    const failure = feishuFailure(error);
    writeFeishuSyncAudit(req, 'feishu_sync_retry_failed', { code: failure.code });
    return res.status(failure.statusCode).json({ error: failure.message, code: failure.code });
  }
});

app.post('/api/influencers/export', authMiddleware, (req, res) => {
  try {
    const { mode, ids, filters } = req.body;
    let sql;
    let params;
    if (mode === 'selected') {
      sql = 'SELECT * FROM influencers WHERE is_active = 1';
      params = [];
      const selectedIds = Array.isArray(ids)
        ? ids.map(Number).filter(function(id) { return Number.isInteger(id) && id > 0; })
        : [];
      if (selectedIds.length) {
        sql += ' AND id IN (' + selectedIds.map(function() { return '?' }).join(',') + ')';
        params.push.apply(params, selectedIds);
      } else {
        sql += ' AND 1 = 0';
      }
      sql += ' ORDER BY followers DESC';
    } else {
      const query = buildInfluencerSelect(mode === 'filtered' ? filters : {}, { limit: false });
      sql = query.sql;
      params = query.params;
    }
    const influencers = db.prepare(sql).all(...params);
    const csv = influencerWorkflow.buildInfluencerCsv(influencers);
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=influencers_export.csv');
    res.send(csv);
  } catch (e) {
    if (sendInfluencerFilterError(res, e)) return;
    res.status(500).json({ error: e.message });
  }
});

};
