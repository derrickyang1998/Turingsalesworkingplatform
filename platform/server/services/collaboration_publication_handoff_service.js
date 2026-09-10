'use strict';

const crypto = require('node:crypto');
const knowledgeService = require('./knowledge_service');
const { preparePerformanceContentImport } = require('./performance_content_import_service');

const HANDOFF_SOURCE_TYPE = 'campaign_publication_handoff';
const HANDOFF_MAPPING_VERSION = 'phase7-publication-confirmation-v1';
const MAX_PUBLICATIONS = 20;
const PUBLICATION_ITEM_KEYS = new Set(['deliverable_key', 'url', 'published_at', 'note']);

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

function canonicalDraft(campaignId, item) {
  const prepared = preparePerformanceContentImport({
    campaign_id: String(campaignId),
    mapping_version: HANDOFF_MAPPING_VERSION,
    provenance: {
      source_mode: 'csv_xlsx',
      file_hash: sha256(`phase7-publication-confirmation:${campaignId}:${item.deliverable_key}:${item.url}`)
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
      publication.platform,publication.canonical_identity,entry.metadata_json
    FROM collaboration_publication_custody custody
    JOIN campaign_publications publication ON publication.id=custody.publication_id
    JOIN knowledge_entries entry ON entry.id=custody.knowledge_entry_id
    WHERE custody.org_id=? AND custody.campaign_id=? AND custody.collaboration_id=?
    ORDER BY custody.id
  `).all(orgId, campaignId, collaborationId);
}

function projection(db, orgId, campaignId, collaborationId) {
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
    return {
      registration: row.registration_mode,
      custody_id: row.custody_id,
      publication_id: row.publication_id,
      deliverable_key: row.deliverable_key,
      platform: row.platform,
      original_url: row.confirmed_url,
      published_at: row.published_at,
      confirmed_at: row.confirmed_at,
      source: 'collaboration_publication'
    };
  });
  return {
    status: 'tracked',
    campaign_id: campaignId,
    publication_count: items.length,
    items
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

  function project(input) {
    const orgId = positiveSafeId(input && input.orgId, 'orgId');
    const campaignId = positiveSafeId(input && input.campaignId, 'campaignId');
    const collaborationId = positiveSafeId(input && input.collaborationId, 'collaborationId');
    return projection(db, orgId, campaignId, collaborationId);
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
    return projection(db, orgId, campaignId, collaborationId);
  }

  return Object.freeze({ confirmBatch, prepare, project });
}

module.exports = {
  CollaborationPublicationHandoffError,
  HANDOFF_MAPPING_VERSION,
  MAX_PUBLICATIONS,
  createCollaborationPublicationHandoffService,
  preparePublicationConfirmation
};
