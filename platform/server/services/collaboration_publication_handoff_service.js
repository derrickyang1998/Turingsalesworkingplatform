'use strict';

const crypto = require('node:crypto');
const knowledgeService = require('./knowledge_service');
const { preparePerformanceContentImport } = require('./performance_content_import_service');

const HANDOFF_SOURCE_TYPE = 'campaign_publication_handoff';
const HANDOFF_MAPPING_VERSION = 'phase7-publication-confirmation-v1';
const LIFECYCLE_SOURCE_TYPE = 'campaign_publication_lifecycle';
const CORRECTION_MAPPING_VERSION = 'phase7-publication-correction-v1';
const MAX_PUBLICATIONS = 20;
const PUBLICATION_ITEM_KEYS = new Set(['deliverable_key', 'url', 'published_at', 'note']);
const CORRECTION_ITEM_KEYS = new Set(['url', 'published_at', 'correction_reason']);

class CollaborationPublicationHandoffError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'CollaborationPublicationHandoffError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function handoffError(statusCode, code, message, details) {
  return new CollaborationPublicationHandoffError(statusCode, code, message, details);
}

function positiveSafeId(value, field) {
  const numeric = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', `${field} is invalid.`, { field });
  }
  return numeric;
}

function scalarText(value, field, maximum, required = false) {
  if (value === undefined || value === null) {
    if (required) throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', `${field} is required.`, { field });
    return '';
  }
  if (typeof value !== 'string') {
    throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', `${field} must be text.`, { field });
  }
  const normalized = value.trim();
  if (
    (required && !normalized) || normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', `${field} is invalid.`, { field });
  }
  return normalized;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isoTimestamp(value, field, statusCode = 400) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw handoffError(
      statusCode,
      statusCode === 500 ? 'PUBLICATION_HANDOFF_CLOCK_INVALID' : 'INVALID_PUBLICATION_CONFIRMATION',
      `${field} is invalid.`,
      { field }
    );
  }
  return new Date(value).toISOString();
}

function deliverableKey(value) {
  const normalized = scalarText(value, 'deliverable_key', 80, true).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(normalized)) {
    throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'deliverable_key is invalid.', {
      field: 'deliverable_key'
    });
  }
  return normalized;
}

function canonicalDraft(campaignId, item, options = {}) {
  const mappingVersion = options.mappingVersion || HANDOFF_MAPPING_VERSION;
  const sourcePrefix = options.sourcePrefix || 'phase7-publication-confirmation';
  const prepared = preparePerformanceContentImport({
    campaign_id: String(campaignId),
    mapping_version: mappingVersion,
    provenance: {
      source_mode: 'csv_xlsx',
      file_hash: sha256(`${sourcePrefix}:${campaignId}:${item.deliverable_key || 'correction'}:${item.url}`)
    },
    column_mapping: { content_url: 'Content URL' },
    rows: [{ source_row_number: 1, 'Content URL': item.url }]
  });
  const draft = prepared.drafts[0];
  if (!draft) {
    const row = prepared.rows[0] || {};
    const error = row.error || {};
    throw handoffError(
      error.statusCode || 400,
      'INVALID_PUBLICATION_CONFIRMATION',
      error.message || 'Final public URL cannot be tracked.',
      { field: 'url', source_code: error.code || null }
    );
  }
  return draft;
}

function preparePublicationCorrection(campaignIdValue, raw) {
  const campaignId = positiveSafeId(campaignIdValue, 'campaign_id');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw handoffError(400, 'INVALID_PUBLICATION_CORRECTION', 'Publication correction is invalid.');
  }
  for (const key of Object.keys(raw)) {
    if (!CORRECTION_ITEM_KEYS.has(key)) {
      throw handoffError(400, 'INVALID_PUBLICATION_CORRECTION', 'Publication correction contains an unsupported field.', {
        field: key
      });
    }
  }
  const url = scalarText(raw.url, 'url', 2048, true);
  const publishedAt = isoTimestamp(raw.published_at, 'published_at');
  const correctionReason = scalarText(raw.correction_reason, 'correction_reason', 500, true);
  const draft = canonicalDraft(campaignId, { url }, {
    mappingVersion: CORRECTION_MAPPING_VERSION,
    sourcePrefix: 'phase7-publication-correction'
  });
  return Object.freeze({ campaignId, url, publishedAt, correctionReason, draft });
}

function storedPlatform(value) {
  if (value === 'custom_manual') return 'custom';
  return ['tiktok', 'instagram', 'youtube', 'facebook', 'x', 'manual', 'custom'].includes(value)
    ? value
    : 'custom';
}

function preparePublicationConfirmation(campaignIdValue, publications) {
  const campaignId = positiveSafeId(campaignIdValue, 'campaign_id');
  if (!Array.isArray(publications) || publications.length < 1 || publications.length > MAX_PUBLICATIONS) {
    throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'publications must contain 1 to 20 items.', {
      field: 'publications'
    });
  }
  const seenKeys = new Set();
  const seenIdentities = new Set();
  const items = publications.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'Publication item is invalid.', { index });
    }
    for (const key of Object.keys(raw)) {
      if (!PUBLICATION_ITEM_KEYS.has(key)) {
        throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'Publication item contains an unsupported field.', {
          index,
          field: key
        });
      }
    }
    const key = deliverableKey(raw.deliverable_key);
    const url = scalarText(raw.url, 'url', 2048, true);
    const publishedAt = isoTimestamp(raw.published_at, 'published_at');
    const note = scalarText(raw.note, 'note', 500, false) || null;
    if (seenKeys.has(key)) {
      throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'deliverable_key must be unique in the request.', {
        index,
        field: 'deliverable_key'
      });
    }
    seenKeys.add(key);
    const draft = canonicalDraft(campaignId, { deliverable_key: key, url });
    if (seenIdentities.has(draft.canonical_identity)) {
      throw handoffError(400, 'INVALID_PUBLICATION_CONFIRMATION', 'Final public URLs must be unique in the request.', {
        index,
        field: 'url'
      });
    }
    seenIdentities.add(draft.canonical_identity);
    return Object.freeze({ deliverableKey: key, url, publishedAt, note, draft });
  });
  return Object.freeze({ campaignId, items: Object.freeze(items) });
}

function nextSafeId(db, table) {
  const row = db.prepare(`SELECT COALESCE(MAX(id),0) AS maximum FROM ${table}`).get();
  const next = Number(row.maximum) + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw handoffError(409, 'PUBLICATION_CUSTODY_ID_EXHAUSTED', 'Publication custody identifier is exhausted.');
  }
  return next;
}

function publicationByIdentity(db, orgId, campaignId, canonicalIdentity) {
  return db.prepare(`
    SELECT * FROM campaign_publications
    WHERE org_id=? AND campaign_id=? AND canonical_identity=?
    LIMIT 1
  `).get(orgId, campaignId, canonicalIdentity) || null;
}

function custodyByPublication(db, orgId, campaignId, publicationId) {
  return db.prepare(`
    SELECT id,collaboration_id,deliverable_key
    FROM collaboration_publication_custody
    WHERE org_id=? AND campaign_id=? AND publication_id=?
    LIMIT 1
  `).get(orgId, campaignId, publicationId) || null;
}

function custodyByDeliverable(db, orgId, campaignId, collaborationId, key) {
  return db.prepare(`
    SELECT id,publication_id,deliverable_key
    FROM collaboration_publication_custody
    WHERE org_id=? AND campaign_id=? AND collaboration_id=? AND deliverable_key=?
    LIMIT 1
  `).get(orgId, campaignId, collaborationId, key) || null;
}

function custodyRecord(db, orgId, campaignId, collaborationId, custodyId) {
  return db.prepare(`
    SELECT custody.*,publication.creator_id,publication.creator_name,publication.product,
      publication.platform AS baseline_platform,
      publication.canonical_identity AS baseline_canonical_identity,
      publication.platform_content_id AS baseline_platform_content_id
    FROM collaboration_publication_custody custody
    JOIN campaign_publications publication ON publication.id=custody.publication_id
    WHERE custody.id=? AND custody.org_id=? AND custody.campaign_id=? AND custody.collaboration_id=?
    LIMIT 1
  `).get(custodyId, orgId, campaignId, collaborationId) || null;
}

function currentLifecycleSnapshot(db, custody) {
  const latest = db.prepare(`
    SELECT * FROM collaboration_publication_lifecycle_versions
    WHERE custody_id=?
    ORDER BY lifecycle_version DESC LIMIT 1
  `).get(custody.id);
  if (latest) {
    return {
      ledgerId: Number(latest.id),
      lifecycleVersion: Number(latest.lifecycle_version),
      trackingState: latest.tracking_state,
      publicationId: Number(latest.publication_id),
      effectiveUrl: latest.effective_url,
      effectiveUrlSha256: latest.effective_url_sha256,
      canonicalIdentity: latest.canonical_identity,
      platform: latest.platform,
      platformContentId: latest.platform_content_id,
      publishedAt: latest.effective_published_at,
      recordedAt: latest.acted_at,
      action: latest.action
    };
  }
  return {
    ledgerId: null,
    lifecycleVersion: 1,
    trackingState: 'active',
    publicationId: Number(custody.publication_id),
    effectiveUrl: custody.confirmed_url,
    effectiveUrlSha256: custody.final_url_sha256,
    canonicalIdentity: custody.baseline_canonical_identity,
    platform: custody.baseline_platform,
    platformContentId: custody.baseline_platform_content_id,
    publishedAt: custody.published_at,
    recordedAt: custody.confirmed_at,
    action: 'confirmed'
  };
}

function lifecycleBinding(db, publicationId) {
  const baseline = db.prepare(`
    SELECT id AS custody_id,collaboration_id FROM collaboration_publication_custody
    WHERE publication_id=? LIMIT 1
  `).get(publicationId);
  if (baseline) return baseline;
  return db.prepare(`
    SELECT custody_id,collaboration_id FROM collaboration_publication_lifecycle_versions
    WHERE publication_id=? LIMIT 1
  `).get(publicationId) || null;
}

function insertCorrectionPublication(db, input) {
  const draft = input.prepared.draft;
  const customFields = {
    source: 'campaign_collaboration_publication_correction',
    collaboration_id: input.collaborationId,
    custody_id: input.custodyId,
    deliverable_key: input.deliverableKey,
    supersedes_publication_id: input.supersedesPublicationId
  };
  const searchPayload = Object.assign({}, draft.search_payload || {}, {
    creator_id: String(input.creatorId),
    creator_name: input.creatorName || null,
    product: input.product || null,
    tags: ['published', 'phase7-correction'],
    custom_fields: customFields
  });
  const result = db.prepare(`
    INSERT INTO campaign_publications (
      org_id,campaign_id,canonical_identity,original_url,canonical_url,platform,
      platform_content_id,creator_id,creator_name,product,tags_json,custom_fields_json,
      search_payload_json,source_mode,source_file_hash,mapping_version,source_row_number,
      published_at,created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.orgId,
    input.campaignId,
    draft.canonical_identity,
    input.prepared.url,
    draft.canonical_url,
    storedPlatform(draft.platform),
    draft.platform_content_id || null,
    String(input.creatorId),
    input.creatorName || null,
    input.product || null,
    JSON.stringify(['published', 'phase7-correction']),
    JSON.stringify(customFields),
    JSON.stringify(searchPayload),
    'manual',
    null,
    CORRECTION_MAPPING_VERSION,
    null,
    input.prepared.publishedAt,
    input.actorUserId
  );
  return db.prepare('SELECT * FROM campaign_publications WHERE id=?').get(Number(result.lastInsertRowid));
}

function writeLifecycleEvidence(db, input) {
  const written = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: input.orgId,
    campaignId: input.campaignId,
    createdBy: input.actorUserId,
    entryType: LIFECYCLE_SOURCE_TYPE,
    title: input.title,
    summary: input.summary,
    content: JSON.stringify(input.content),
    tags: input.tags,
    sourceType: LIFECYCLE_SOURCE_TYPE,
    sourceId: String(input.sourceId),
    visibility: 'team',
    metadata: input.metadata
  });
  if (written.status !== 'created') {
    throw handoffError(409, 'PUBLICATION_LIFECYCLE_EVIDENCE_CONFLICT', 'Publication lifecycle evidence already exists.');
  }
  const bundleId = crypto.randomBytes(32).toString('hex');
  const link = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (?,?,'knowledge_entry',?,?,'knowledge',?,?)
  `).run(
    input.orgId,
    input.campaignId,
    bundleId,
    String(written.entry.id),
    input.actorUserId,
    JSON.stringify({
      producer_type: LIFECYCLE_SOURCE_TYPE,
      producer_id: input.collaborationId,
      source_type: LIFECYCLE_SOURCE_TYPE,
      source_id: input.sourceId,
      custody_id: input.custodyId,
      publication_id: input.publicationId
    })
  );
  return {
    knowledgeEntryId: Number(written.entry.id),
    capacityGaugePlan: written.capacityGaugePlan,
    link: { id: Number(link.lastInsertRowid), bundleId }
  };
}

function appendLifecycleVersion(db, input) {
  const lifecycleId = nextSafeId(db, 'collaboration_publication_lifecycle_versions');
  const lifecycleVersion = input.previous.lifecycleVersion + 1;
  if (!Number.isSafeInteger(lifecycleVersion) || lifecycleVersion < 2) {
    throw handoffError(409, 'PUBLICATION_VERSION_EXHAUSTED', 'Publication lifecycle version is exhausted.');
  }
  const effectiveUrlSha256 = sha256(input.snapshot.effectiveUrl);
  const metadata = {
    schema_version: 1,
    lifecycle_id: lifecycleId,
    custody_id: input.custody.id,
    collaboration_id: input.collaborationId,
    publication_id: input.snapshot.publicationId,
    lifecycle_version: lifecycleVersion,
    action: input.action,
    tracking_state: input.snapshot.trackingState,
    effective_url_sha256: effectiveUrlSha256,
    reason_sha256: sha256(input.reason),
    acted_at: input.actedAt,
    retrieval_eligible: false
  };
  const evidence = writeLifecycleEvidence(db, {
    orgId: input.orgId,
    campaignId: input.campaignId,
    collaborationId: input.collaborationId,
    custodyId: input.custody.id,
    publicationId: input.snapshot.publicationId,
    actorUserId: input.actorUserId,
    sourceId: lifecycleId,
    title: `Campaign publication lifecycle #${lifecycleId}`,
    summary: `Collaboration ${input.collaborationId} deliverable ${input.custody.deliverable_key} recorded ${input.action} at lifecycle version ${lifecycleVersion}.`,
    content: {
      lifecycle_id: lifecycleId,
      custody_id: input.custody.id,
      lifecycle_version: lifecycleVersion,
      publication_id: input.snapshot.publicationId,
      action: input.action,
      tracking_state: input.snapshot.trackingState
    },
    tags: ['campaign', 'collaboration', 'publication', 'lifecycle', input.action],
    metadata
  });
  db.prepare(`
    INSERT INTO collaboration_publication_lifecycle_versions (
      id,org_id,campaign_id,collaboration_id,custody_id,lifecycle_version,
      previous_version_id,action,tracking_state,publication_id,effective_url,
      effective_url_sha256,canonical_identity,platform,platform_content_id,
      effective_published_at,correction_kind,registration_mode,reason,
      knowledge_entry_id,collaboration_row_version_observed,acted_by,acted_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    lifecycleId,
    input.orgId,
    input.campaignId,
    input.collaborationId,
    input.custody.id,
    lifecycleVersion,
    input.previous.ledgerId,
    input.action,
    input.snapshot.trackingState,
    input.snapshot.publicationId,
    input.snapshot.effectiveUrl,
    effectiveUrlSha256,
    input.snapshot.canonicalIdentity,
    input.snapshot.platform,
    input.snapshot.platformContentId || null,
    input.snapshot.publishedAt,
    input.correctionKind || null,
    input.registrationMode || null,
    input.reason,
    evidence.knowledgeEntryId,
    input.collaborationRowVersionObserved,
    input.actorUserId,
    input.actedAt
  );
  knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, evidence.capacityGaugePlan);
  return {
    lifecycleId,
    lifecycleVersion,
    evidence: { ...evidence.link, knowledgeEntryId: evidence.knowledgeEntryId }
  };
}

function insertPublication(db, input) {
  const draft = input.item.draft;
  const customFields = {
    source: 'campaign_collaboration_publication',
    collaboration_id: input.collaborationId,
    order_reference: input.orderReference || null,
    deliverable_key: input.item.deliverableKey,
    review_submission_entry_id: input.reviewSubmissionEntryId,
    review_decision_entry_id: input.reviewDecisionEntryId,
    publication_relation_link_id: input.publicationRelationLinkId
  };
  const searchPayload = Object.assign({}, draft.search_payload || {}, {
    creator_id: String(input.influencerId),
    creator_name: input.creatorName || null,
    product: input.product || null,
    tags: ['published', 'phase7-handoff'],
    custom_fields: customFields
  });
  const result = db.prepare(`
    INSERT INTO campaign_publications (
      org_id,campaign_id,canonical_identity,original_url,canonical_url,platform,
      platform_content_id,creator_id,creator_name,product,tags_json,custom_fields_json,
      search_payload_json,source_mode,source_file_hash,mapping_version,source_row_number,
      published_at,created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.orgId,
    input.campaignId,
    draft.canonical_identity,
    input.item.url,
    draft.canonical_url,
    storedPlatform(draft.platform),
    draft.platform_content_id || null,
    String(input.influencerId),
    input.creatorName || null,
    input.product || null,
    JSON.stringify(['published', 'phase7-handoff']),
    JSON.stringify(customFields),
    JSON.stringify(searchPayload),
    'manual',
    null,
    HANDOFF_MAPPING_VERSION,
    null,
    input.item.publishedAt,
    input.actorUserId
  );
  return db.prepare('SELECT * FROM campaign_publications WHERE id=?')
    .get(Number(result.lastInsertRowid));
}

function safeMetadata(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function custodyRows(db, orgId, campaignId, collaborationId) {
  return db.prepare(`
    SELECT
      custody.id AS custody_id,custody.org_id,custody.campaign_id,custody.collaboration_id,
      custody.publication_id,custody.deliverable_key,custody.registration_mode,
      custody.confirmed_url,custody.final_url_sha256,custody.published_at,
      custody.confirmed_at,custody.knowledge_entry_id,
      publication.org_id AS publication_org_id,publication.campaign_id AS publication_campaign_id,
      publication.platform,publication.canonical_identity,publication.platform_content_id,
      entry.metadata_json,
      latest.id AS lifecycle_id,latest.lifecycle_version,latest.action AS lifecycle_action,
      latest.tracking_state,latest.publication_id AS lifecycle_publication_id,
      latest.effective_url,latest.effective_url_sha256,latest.canonical_identity AS lifecycle_canonical_identity,
      latest.platform AS lifecycle_platform,latest.platform_content_id AS lifecycle_platform_content_id,
      latest.effective_published_at,latest.correction_kind,latest.registration_mode AS lifecycle_registration_mode,
      latest.reason AS lifecycle_reason,latest.acted_at,latest.knowledge_entry_id AS lifecycle_knowledge_entry_id,
      lifecycle_entry.metadata_json AS lifecycle_metadata_json,
      (SELECT COUNT(*) FROM collaboration_publication_lifecycle_versions counted
        WHERE counted.custody_id=custody.id) AS lifecycle_event_count
    FROM collaboration_publication_custody custody
    JOIN campaign_publications publication ON publication.id=custody.publication_id
    JOIN knowledge_entries entry ON entry.id=custody.knowledge_entry_id
    LEFT JOIN collaboration_publication_lifecycle_versions latest
      ON latest.id=(
        SELECT candidate.id FROM collaboration_publication_lifecycle_versions candidate
        WHERE candidate.custody_id=custody.id
        ORDER BY candidate.lifecycle_version DESC LIMIT 1
      )
    LEFT JOIN knowledge_entries lifecycle_entry ON lifecycle_entry.id=latest.knowledge_entry_id
    WHERE custody.org_id=? AND custody.campaign_id=? AND custody.collaboration_id=?
    ORDER BY custody.id
  `).all(orgId, campaignId, collaborationId);
}

function projection(db, orgId, campaignId, collaborationId, options = {}) {
  const writable = options.writable === true;
  const rows = custodyRows(db, orgId, campaignId, collaborationId);
  if (!rows.length) return null;
  const items = rows.map((row) => {
    const metadata = safeMetadata(row.metadata_json);
    if (
      row.publication_org_id !== orgId || row.publication_campaign_id !== campaignId ||
      !metadata || metadata.schema_version !== 1 || metadata.custody_id !== row.custody_id ||
      metadata.collaboration_id !== collaborationId || metadata.publication_id !== row.publication_id ||
      metadata.final_url_sha256 !== row.final_url_sha256 || metadata.retrieval_eligible !== false ||
      row.final_url_sha256 !== sha256(row.confirmed_url)
    ) {
      throw handoffError(409, 'PUBLICATION_HANDOFF_EVIDENCE_CONFLICT', 'Publication custody evidence is inconsistent.');
    }
    if (row.lifecycle_id !== null) {
      const lifecycleMetadata = safeMetadata(row.lifecycle_metadata_json);
      if (
        !lifecycleMetadata || lifecycleMetadata.schema_version !== 1 ||
        lifecycleMetadata.lifecycle_id !== row.lifecycle_id ||
        lifecycleMetadata.custody_id !== row.custody_id ||
        lifecycleMetadata.collaboration_id !== collaborationId ||
        lifecycleMetadata.publication_id !== row.lifecycle_publication_id ||
        lifecycleMetadata.lifecycle_version !== row.lifecycle_version ||
        lifecycleMetadata.action !== row.lifecycle_action ||
        lifecycleMetadata.effective_url_sha256 !== row.effective_url_sha256 ||
        lifecycleMetadata.retrieval_eligible !== false ||
        row.effective_url_sha256 !== sha256(row.effective_url)
      ) {
        throw handoffError(409, 'PUBLICATION_LIFECYCLE_EVIDENCE_CONFLICT', 'Publication tracking evidence is inconsistent.');
      }
    }
    const lifecycleVersion = row.lifecycle_id === null ? 1 : Number(row.lifecycle_version);
    const trackingStatus = row.lifecycle_id === null ? 'active' : row.tracking_state;
    const currentPublicationId = row.lifecycle_id === null ? row.publication_id : row.lifecycle_publication_id;
    return {
      registration: currentPublicationId === row.publication_id ? row.registration_mode : 'corrected',
      custody_id: row.custody_id,
      publication_id: currentPublicationId,
      deliverable_key: row.deliverable_key,
      platform: row.lifecycle_id === null ? row.platform : row.lifecycle_platform,
      original_url: row.lifecycle_id === null ? row.confirmed_url : row.effective_url,
      published_at: row.lifecycle_id === null ? row.published_at : row.effective_published_at,
      confirmed_at: row.lifecycle_id === null ? row.confirmed_at : row.acted_at,
      source: row.lifecycle_id === null ? 'collaboration_publication' : LIFECYCLE_SOURCE_TYPE,
      lifecycle_version: lifecycleVersion,
      version_number: lifecycleVersion,
      tracking_status: trackingStatus,
      history_count: Number(row.lifecycle_event_count) + 1,
      can_correct: writable,
      can_pause: writable && trackingStatus === 'active',
      can_resume: writable && trackingStatus === 'paused'
    };
  });
  return {
    status: 'tracked',
    campaign_id: campaignId,
    publication_count: items.length,
    items
  };
}

function lifecycleHistory(db, orgId, campaignId, collaborationId, custodyId, limit, beforeVersion) {
  const custody = custodyRecord(db, orgId, campaignId, collaborationId, custodyId);
  if (!custody) {
    throw handoffError(404, 'PUBLICATION_CUSTODY_NOT_FOUND', 'Publication custody was not found.');
  }
  const rows = db.prepare(`
    SELECT id,lifecycle_version,action,tracking_state,publication_id,effective_url,
      effective_published_at,correction_kind,registration_mode,reason,acted_by,acted_at
    FROM collaboration_publication_lifecycle_versions
    WHERE custody_id=? AND lifecycle_version<?
    ORDER BY lifecycle_version DESC
    LIMIT ?
  `).all(custodyId, beforeVersion || Number.MAX_SAFE_INTEGER, limit);
  const items = rows.map((row) => ({
    id: Number(row.id),
    lifecycle_version: Number(row.lifecycle_version),
    action: row.action,
    tracking_status: row.tracking_state,
    publication_id: Number(row.publication_id),
    original_url: row.effective_url,
    published_at: row.effective_published_at,
    correction_kind: row.correction_kind,
    registration: row.registration_mode,
    reason: row.reason,
    acted_by: Number(row.acted_by),
    recorded_at: row.acted_at,
    is_current: false
  }));
  const lowestVersion = rows.length ? Number(rows[rows.length - 1].lifecycle_version) : (beforeVersion || 2);
  if (items.length < limit && lowestVersion <= 2) {
    items.push({
      id: null,
      lifecycle_version: 1,
      action: 'confirmed',
      tracking_status: 'active',
      publication_id: Number(custody.publication_id),
      original_url: custody.confirmed_url,
      published_at: custody.published_at,
      correction_kind: null,
      registration: custody.registration_mode,
      reason: custody.publication_note,
      acted_by: Number(custody.confirmed_by),
      recorded_at: custody.confirmed_at,
      is_current: false
    });
  }
  const current = currentLifecycleSnapshot(db, custody);
  for (const item of items) item.is_current = item.lifecycle_version === current.lifecycleVersion;
  return {
    campaign_id: campaignId,
    collaboration_id: collaborationId,
    custody_id: custodyId,
    total: Number(db.prepare(`
      SELECT COUNT(*)+1 AS total FROM collaboration_publication_lifecycle_versions WHERE custody_id=?
    `).get(custodyId).total),
    items,
    next_cursor: items.length === limit && items[items.length - 1].lifecycle_version > 1
      ? items[items.length - 1].lifecycle_version
      : null
  };
}

function createCollaborationPublicationHandoffService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('collaboration publication handoff service requires a SQLite database');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  function prepare(input) {
    return preparePublicationConfirmation(input && input.campaignId, input && input.publications);
  }

  function prepareCorrection(input) {
    return preparePublicationCorrection(input && input.campaignId, input && input.correction);
  }

  function project(input) {
    const orgId = positiveSafeId(input && input.orgId, 'orgId');
    const campaignId = positiveSafeId(input && input.campaignId, 'campaignId');
    const collaborationId = positiveSafeId(input && input.collaborationId, 'collaborationId');
    return projection(db, orgId, campaignId, collaborationId, {
      writable: Boolean(input && input.writable)
    });
  }

  function history(input) {
    const orgId = positiveSafeId(input && input.orgId, 'orgId');
    const campaignId = positiveSafeId(input && input.campaignId, 'campaignId');
    const collaborationId = positiveSafeId(input && input.collaborationId, 'collaborationId');
    const custodyId = positiveSafeId(input && input.custodyId, 'custodyId');
    const limitValue = input && input.limit === undefined ? 20 : Number(input && input.limit);
    const beforeValue = input && input.beforeVersion === undefined ? null : Number(input && input.beforeVersion);
    if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) {
      throw handoffError(400, 'INVALID_PUBLICATION_HISTORY', 'Publication history limit is invalid.');
    }
    if (beforeValue !== null && (!Number.isSafeInteger(beforeValue) || beforeValue < 2)) {
      throw handoffError(400, 'INVALID_PUBLICATION_HISTORY', 'Publication history cursor is invalid.');
    }
    return lifecycleHistory(
      db,
      orgId,
      campaignId,
      collaborationId,
      custodyId,
      limitValue,
      beforeValue
    );
  }

  function confirmBatch(input) {
    if (db.inTransaction !== true) {
      throw new TypeError('publication handoff requires an existing transaction');
    }
    const orgId = positiveSafeId(input && input.orgId, 'orgId');
    const campaignId = positiveSafeId(input && input.campaignId, 'campaignId');
    const collaborationId = positiveSafeId(input && input.collaborationId, 'collaborationId');
    const actorUserId = positiveSafeId(input && input.actorUserId, 'actorUserId');
    const influencerId = positiveSafeId(input && input.influencerId, 'influencerId');
    const publicationRelationLinkId = positiveSafeId(input && input.publicationRelationLinkId, 'publicationRelationLinkId');
    const reviewSubmissionEntryId = positiveSafeId(input && input.reviewSubmissionEntryId, 'reviewSubmissionEntryId');
    const reviewDecisionEntryId = positiveSafeId(input && input.reviewDecisionEntryId, 'reviewDecisionEntryId');
    const creatorName = scalarText(input && input.creatorName, 'creatorName', 256);
    const product = scalarText(input && input.product, 'product', 256);
    const orderReference = scalarText(input && input.orderReference, 'orderReference', 160);
    const confirmedAt = isoTimestamp(now(), 'confirmed_at', 500);
    const prepared = input && input.prepared;
    if (
      !prepared || prepared.campaignId !== campaignId || !Array.isArray(prepared.items) ||
      prepared.items.length < 1 || prepared.items.length > MAX_PUBLICATIONS
    ) {
      throw new TypeError('publication handoff requires prepared confirmation items');
    }

    for (const item of prepared.items) {
      const existingDeliverable = custodyByDeliverable(
        db,
        orgId,
        campaignId,
        collaborationId,
        item.deliverableKey
      );
      if (existingDeliverable) {
        throw handoffError(409, 'PUBLICATION_DELIVERABLE_CONFLICT', 'This deliverable is already confirmed.');
      }
      let publication = publicationByIdentity(db, orgId, campaignId, item.draft.canonical_identity);
      const registrationMode = publication ? 'existing' : 'created';
      if (!publication) {
        publication = insertPublication(db, {
          orgId,
          campaignId,
          collaborationId,
          actorUserId,
          influencerId,
          publicationRelationLinkId,
          reviewSubmissionEntryId,
          reviewDecisionEntryId,
          creatorName,
          product,
          orderReference,
          item
        });
      } else if (String(publication.creator_id || '') !== String(influencerId)) {
        throw handoffError(
          409,
          'PERFORMANCE_CONTENT_CREATOR_CONFLICT',
          'This tracked content belongs to a different creator.'
        );
      }
      const bound = custodyByPublication(db, orgId, campaignId, publication.id);
      if (bound) {
        throw handoffError(
          409,
          'PERFORMANCE_CONTENT_DUPLICATE',
          'This tracked content is already bound to another deliverable.',
          { collaboration_id: bound.collaboration_id, deliverable_key: bound.deliverable_key }
        );
      }

      const custodyId = nextSafeId(db, 'collaboration_publication_custody');
      const finalUrlSha256 = sha256(item.url);
      const metadata = {
        schema_version: 1,
        custody_id: custodyId,
        collaboration_id: collaborationId,
        publication_id: publication.id,
        deliverable_key: item.deliverableKey,
        registration_mode: registrationMode,
        publication_relation_link_id: publicationRelationLinkId,
        review_submission_entry_id: reviewSubmissionEntryId,
        review_decision_entry_id: reviewDecisionEntryId,
        final_url_sha256: finalUrlSha256,
        note_sha256: item.note ? sha256(item.note) : null,
        published_at: item.publishedAt,
        confirmed_at: confirmedAt,
        retrieval_eligible: false
      };
      const written = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
        organizationId: orgId,
        campaignId,
        createdBy: actorUserId,
        entryType: HANDOFF_SOURCE_TYPE,
        title: `Campaign publication custody #${custodyId}`,
        summary: `Collaboration ${collaborationId} deliverable ${item.deliverableKey} was linked to tracked publication ${publication.id}.`,
        content: JSON.stringify({
          custody_id: custodyId,
          collaboration_id: collaborationId,
          publication_id: publication.id,
          deliverable_key: item.deliverableKey
        }),
        tags: ['campaign', 'collaboration', 'publication', 'performance'],
        sourceType: HANDOFF_SOURCE_TYPE,
        sourceId: String(custodyId),
        visibility: 'team',
        metadata
      });
      if (written.status !== 'created') {
        throw handoffError(409, 'PUBLICATION_HANDOFF_EVIDENCE_CONFLICT', 'Publication custody evidence already exists.');
      }
      db.prepare(`
        INSERT INTO campaign_record_links (
          org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
        ) VALUES (?,?,'knowledge_entry',?,?,'knowledge',?,?)
      `).run(
        orgId,
        campaignId,
        crypto.randomBytes(32).toString('hex'),
        String(written.entry.id),
        actorUserId,
        JSON.stringify({
          producer_type: HANDOFF_SOURCE_TYPE,
          producer_id: collaborationId,
          source_type: HANDOFF_SOURCE_TYPE,
          source_id: custodyId,
          publication_id: publication.id,
          deliverable_key: item.deliverableKey
        })
      );
      db.prepare(`
        INSERT INTO collaboration_publication_custody (
          id,org_id,campaign_id,collaboration_id,publication_id,deliverable_key,
          registration_mode,review_submission_entry_id,review_decision_entry_id,
          publication_relation_link_id,knowledge_entry_id,confirmed_url,final_url_sha256,
          published_at,publication_note,confirmed_by,confirmed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        custodyId,
        orgId,
        campaignId,
        collaborationId,
        publication.id,
        item.deliverableKey,
        registrationMode,
        reviewSubmissionEntryId,
        reviewDecisionEntryId,
        publicationRelationLinkId,
        written.entry.id,
        item.url,
        finalUrlSha256,
        item.publishedAt,
        item.note,
        actorUserId,
        confirmedAt
      );
      knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, written.capacityGaugePlan);
    }
    return projection(db, orgId, campaignId, collaborationId, { writable: true });
  }

  function correct(input) {
    if (db.inTransaction !== true) {
      throw new TypeError('publication correction requires an existing transaction');
    }
    const orgId = positiveSafeId(input && input.orgId, 'orgId');
    const campaignId = positiveSafeId(input && input.campaignId, 'campaignId');
    const collaborationId = positiveSafeId(input && input.collaborationId, 'collaborationId');
    const custodyId = positiveSafeId(input && input.custodyId, 'custodyId');
    const actorUserId = positiveSafeId(input && input.actorUserId, 'actorUserId');
    const expectedLifecycleVersion = positiveSafeId(
      input && input.expectedLifecycleVersion,
      'expectedLifecycleVersion'
    );
    const collaborationRowVersionObserved = positiveSafeId(
      input && input.collaborationRowVersionObserved,
      'collaborationRowVersionObserved'
    );
    const actedAt = isoTimestamp(now(), 'acted_at', 500);
    const prepared = input && input.prepared;
    if (!prepared || prepared.campaignId !== campaignId || !prepared.draft) {
      throw new TypeError('publication correction requires prepared input');
    }
    const custody = custodyRecord(db, orgId, campaignId, collaborationId, custodyId);
    if (!custody) {
      throw handoffError(404, 'PUBLICATION_CUSTODY_NOT_FOUND', 'Publication custody was not found.');
    }
    const current = currentLifecycleSnapshot(db, custody);
    if (current.lifecycleVersion !== expectedLifecycleVersion) {
      throw handoffError(409, 'STALE_PUBLICATION_LIFECYCLE_VERSION', 'Publication lifecycle version is stale.');
    }
    const targetPlatform = storedPlatform(prepared.draft.platform);
    if (targetPlatform !== current.platform) {
      throw handoffError(409, 'PUBLICATION_PLATFORM_CONFLICT', 'Corrected content must remain on the same platform.');
    }

    let correctionKind;
    let registrationMode;
    let publication;
    let publishedAt;
    if (prepared.draft.canonical_identity === current.canonicalIdentity) {
      if (sha256(prepared.url) === current.effectiveUrlSha256) {
        throw handoffError(409, 'PUBLICATION_CORRECTION_UNCHANGED', 'Corrected URL is already current.');
      }
      correctionKind = 'url_alias';
      registrationMode = 'reused_current';
      publication = db.prepare('SELECT * FROM campaign_publications WHERE id=?').get(current.publicationId);
      publishedAt = current.publishedAt;
    } else {
      correctionKind = 'content_replacement';
      publication = publicationByIdentity(db, orgId, campaignId, prepared.draft.canonical_identity);
      if (publication) {
        const binding = lifecycleBinding(db, publication.id);
        if (binding && Number(binding.custody_id) !== custodyId) {
          throw handoffError(409, 'PERFORMANCE_CONTENT_DUPLICATE', 'Corrected content is already bound to another deliverable.', {
            collaboration_id: Number(binding.collaboration_id),
            custody_id: Number(binding.custody_id)
          });
        }
        if (String(publication.creator_id || '') !== String(custody.creator_id || '')) {
          throw handoffError(409, 'PERFORMANCE_CONTENT_CREATOR_CONFLICT', 'Corrected content belongs to a different creator.');
        }
        if (publication.published_at !== prepared.publishedAt) {
          throw handoffError(409, 'PUBLICATION_PUBLISHED_AT_CONFLICT', 'Corrected publication time conflicts with immutable content evidence.');
        }
        registrationMode = binding ? 'reused_history' : 'existing';
      } else {
        publication = insertCorrectionPublication(db, {
          orgId,
          campaignId,
          collaborationId,
          custodyId,
          actorUserId,
          creatorId: custody.creator_id,
          creatorName: custody.creator_name,
          product: custody.product,
          deliverableKey: custody.deliverable_key,
          supersedesPublicationId: current.publicationId,
          prepared
        });
        registrationMode = 'created';
      }
      publishedAt = publication.published_at;
    }
    if (!publication) {
      throw handoffError(409, 'PUBLICATION_LIFECYCLE_EVIDENCE_CONFLICT', 'Current publication evidence could not be resolved.');
    }
    const appended = appendLifecycleVersion(db, {
      orgId,
      campaignId,
      collaborationId,
      custody,
      previous: current,
      action: 'corrected',
      snapshot: {
        trackingState: current.trackingState,
        publicationId: Number(publication.id),
        effectiveUrl: prepared.url,
        canonicalIdentity: publication.canonical_identity,
        platform: publication.platform,
        platformContentId: publication.platform_content_id,
        publishedAt
      },
      correctionKind,
      registrationMode,
      reason: prepared.correctionReason,
      collaborationRowVersionObserved,
      actorUserId,
      actedAt
    });
    return {
      lifecycleVersion: appended.lifecycleVersion,
      projection: projection(db, orgId, campaignId, collaborationId, { writable: true }),
      evidence: appended.evidence
    };
  }

  function changeTracking(input) {
    if (db.inTransaction !== true) {
      throw new TypeError('publication tracking transition requires an existing transaction');
    }
    const orgId = positiveSafeId(input && input.orgId, 'orgId');
    const campaignId = positiveSafeId(input && input.campaignId, 'campaignId');
    const collaborationId = positiveSafeId(input && input.collaborationId, 'collaborationId');
    const custodyId = positiveSafeId(input && input.custodyId, 'custodyId');
    const actorUserId = positiveSafeId(input && input.actorUserId, 'actorUserId');
    const expectedLifecycleVersion = positiveSafeId(
      input && input.expectedLifecycleVersion,
      'expectedLifecycleVersion'
    );
    const collaborationRowVersionObserved = positiveSafeId(
      input && input.collaborationRowVersionObserved,
      'collaborationRowVersionObserved'
    );
    const action = scalarText(input && input.action, 'action', 16, true);
    const reason = scalarText(input && input.reason, 'reason', 500, true);
    if (!['paused', 'resumed'].includes(action)) {
      throw handoffError(400, 'INVALID_PUBLICATION_TRACKING', 'Publication tracking action is invalid.', { field: 'action' });
    }
    const actedAt = isoTimestamp(now(), 'acted_at', 500);
    const custody = custodyRecord(db, orgId, campaignId, collaborationId, custodyId);
    if (!custody) {
      throw handoffError(404, 'PUBLICATION_CUSTODY_NOT_FOUND', 'Publication custody was not found.');
    }
    const current = currentLifecycleSnapshot(db, custody);
    if (current.lifecycleVersion !== expectedLifecycleVersion) {
      throw handoffError(409, 'STALE_PUBLICATION_LIFECYCLE_VERSION', 'Publication lifecycle version is stale.');
    }
    const requestedState = action === 'paused' ? 'paused' : 'active';
    if (current.trackingState === requestedState) {
      throw handoffError(409, 'PUBLICATION_TRACKING_STATE_CONFLICT', 'Publication tracking is already in the requested state.');
    }
    const appended = appendLifecycleVersion(db, {
      orgId,
      campaignId,
      collaborationId,
      custody,
      previous: current,
      action,
      snapshot: {
        trackingState: requestedState,
        publicationId: current.publicationId,
        effectiveUrl: current.effectiveUrl,
        canonicalIdentity: current.canonicalIdentity,
        platform: current.platform,
        platformContentId: current.platformContentId,
        publishedAt: current.publishedAt
      },
      reason,
      collaborationRowVersionObserved,
      actorUserId,
      actedAt
    });
    return {
      lifecycleVersion: appended.lifecycleVersion,
      projection: projection(db, orgId, campaignId, collaborationId, { writable: true }),
      evidence: appended.evidence
    };
  }

  return Object.freeze({
    changeTracking,
    confirmBatch,
    correct,
    history,
    prepare,
    prepareCorrection,
    project
  });
}

module.exports = {
  CollaborationPublicationHandoffError,
  CORRECTION_MAPPING_VERSION,
  HANDOFF_MAPPING_VERSION,
  MAX_PUBLICATIONS,
  createCollaborationPublicationHandoffService,
  preparePublicationCorrection,
  preparePublicationConfirmation
};
