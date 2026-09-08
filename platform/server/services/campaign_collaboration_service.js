'use strict';

const crypto = require('node:crypto');
const idempotencyService = require('./idempotency_service');
const knowledgeService = require('./knowledge_service');
const { requestHash } = require('./sqlite_digest_service');
const {
  CollaborationResourceContractError,
  isCanonicalCollaborationResource,
  isReservedV2ProposalNotes,
  isV2CollaborationResourceInput,
  isVersionedCollaborationResourceInput,
  normalizeCollaborationResource,
  resolveResourceQuotedPrice,
  serializeCollaborationResource
} = require('./collaboration_resource_contract');
const {
  buildCollectionAccessPredicate,
  getCampaignAccess
} = require('./campaign_access_service');

const ACTIVE_STATUSES = Object.freeze([
  'proposed',
  'contacted',
  'negotiating',
  'confirmed',
  'contract_sent',
  'contracted',
  'live',
  'content_review'
]);
const CANCELLABLE_STATUSES = Object.freeze([
  'proposed',
  'contacted',
  'negotiating',
  'confirmed',
  'contract_sent',
  'contracted',
  'live',
  'content_review'
]);
const COLLABORATION_RELATIONS = Object.freeze([
  'order',
  'execution',
  'publication',
  'settlement'
]);
const LIFECYCLE_STATES = Object.freeze([
  'lead',
  'qualified',
  'demand_confirmed',
  'proposal_draft',
  'proposal_confirmed',
  'influencer_shortlist',
  'ordered',
  'executing',
  'published',
  'settled',
  'reviewed'
]);
const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const LINKED_CREATE_KEYS = new Set([
  'campaign_id',
  'influencer_id',
  'demand_id',
  'status',
  'proposal_notes',
  'resource',
  'cost_quoted',
  'notes',
  'timeline_start',
  'timeline_end'
]);
const LINKED_UPDATE_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'reason',
  'status',
  'cost_quoted',
  'cost_actual',
  'content_url',
  'notes',
  'timeline_start',
  'timeline_end',
  'campaign_relation',
  'confirm_cost_actual'
]);
const LINKED_CANCELLATION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'reason',
  'action'
]);
const CONTRACT_CONFIRMATION_KEYS = new Set([
  'campaign_id',
  'expected_version',
  'contract_reference',
  'counterparty_name',
  'signed_at',
  'confirmation_note'
]);
const CONTRACT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

class CampaignCollaborationServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new CampaignCollaborationServiceError(statusCode, code, message, details);
}

function requirePositiveSafeId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a positive JavaScript-safe integer`);
  }
  return value;
}

function requireActiveActor(db, userId) {
  const actor = db.prepare(`
    SELECT id,role,is_active
    FROM users
    WHERE id=?
  `).get(userId);
  if (!actor || actor.is_active !== 1) {
    return null;
  }
  return actor;
}

function collaborationObjectPredicate() {
  return `(
    collaboration.user_id=?
    OR EXISTS (
      SELECT 1
      FROM users platform_actor
      WHERE platform_actor.id=?
        AND platform_actor.role='admin'
        AND typeof(platform_actor.is_active)='integer'
        AND platform_actor.is_active=1
    )
    OR EXISTS (
      SELECT 1
      FROM organization_memberships owner_membership
      JOIN organization_memberships actor_membership
        ON actor_membership.org_id=owner_membership.org_id
       AND actor_membership.user_id=?
       AND actor_membership.role_code='org_admin'
       AND actor_membership.status='active'
      JOIN users owner
        ON owner.id=owner_membership.user_id
       AND typeof(owner.is_active)='integer'
       AND owner.is_active=1
      WHERE owner_membership.user_id=collaboration.user_id
        AND owner_membership.status='active'
    )
  )`;
}

function assertAllowedKeys(body, allowedKeys, message) {
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', message);
  }
}

function isCanonicalCost(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function v2CollaborationResource(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isV2CollaborationResourceInput(parsed)
      ? normalizeCollaborationResource(parsed)
      : null;
  } catch (error) {
    return null;
  }
}

function contractConfirmationText(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', { field });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field,
      max_length: maxLength
    });
  }
  return normalized;
}

function normalizedSignedAt(value, enforceNotFuture = true) {
  const raw = contractConfirmationText(value, 'signed_at', 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  if (!match) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'signed_at'
    });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'signed_at'
    });
  }
  const timestamp = Date.parse(raw);
  if (
    !Number.isFinite(timestamp) ||
    (enforceNotFuture && timestamp > Date.now() + CONTRACT_FUTURE_TOLERANCE_MS)
  ) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'signed_at'
    });
  }
  return new Date(timestamp).toISOString();
}

function normalizedContractConfirmation(body) {
  if (Object.keys(body).some((key) => !CONTRACT_CONFIRMATION_KEYS.has(key))) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.');
  }
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) {
    throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
      field: 'expected_version'
    });
  }
  return Object.freeze({
    campaignId: body.campaign_id,
    expectedVersion: body.expected_version,
    contractReference: contractConfirmationText(body.contract_reference, 'contract_reference', 160),
    counterpartyName: contractConfirmationText(body.counterparty_name, 'counterparty_name', 160),
    signedAt: normalizedSignedAt(body.signed_at),
    confirmationNote: contractConfirmationText(body.confirmation_note, 'confirmation_note', 500)
  });
}

function authorizedCollaborationScope(userId) {
  const campaignAccess = buildCollectionAccessPredicate(
    'collaboration_stats',
    { userId }
  );
  return {
    sql: `
      classified_links AS (
        SELECT id,record_id,org_id,campaign_id,bundle_id,revoked_at
        FROM campaign_record_links
        WHERE record_type='collaboration'
          AND relation_type IN ('order','execution','publication','settlement')
      ),
      classified_records AS (
        SELECT record_id
        FROM classified_links
        GROUP BY record_id
      ),
      active_identities AS (
        SELECT record_id,org_id,campaign_id,bundle_id
        FROM classified_links
        WHERE revoked_at IS NULL
        GROUP BY record_id,org_id,campaign_id,bundle_id
      ),
      active_custody AS (
        SELECT record_id,MIN(org_id) AS org_id,MIN(campaign_id) AS campaign_id
        FROM active_identities
        GROUP BY record_id
        HAVING COUNT(*)=1
      ),
      latest_revoked_custody AS (
        SELECT link.record_id,link.org_id,link.campaign_id
        FROM classified_links link
        WHERE link.revoked_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM active_identities active
            WHERE active.record_id=link.record_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM classified_links newer
            WHERE newer.record_id=link.record_id
              AND newer.revoked_at IS NOT NULL
              AND (
                newer.revoked_at>link.revoked_at
                OR (newer.revoked_at=link.revoked_at AND newer.id>link.id)
              )
          )
      ),
      campaign_scope AS (
        SELECT record_id,org_id,campaign_id FROM active_custody
        UNION ALL
        SELECT record_id,org_id,campaign_id FROM latest_revoked_custody
      ),
      authorized_collaborations AS (
        SELECT collaboration.id,campaign_scope.campaign_id AS custody_campaign_id
        FROM collaborations collaboration
        LEFT JOIN classified_records classification
          ON classification.record_id=CAST(collaboration.id AS TEXT)
        LEFT JOIN campaign_scope
          ON campaign_scope.record_id=CAST(collaboration.id AS TEXT)
        WHERE ${collaborationObjectPredicate()}
          AND (
            classification.record_id IS NULL
            OR (
              campaign_scope.record_id IS NOT NULL
              AND ${campaignAccess.sql}
            )
          )
      )
    `,
    params: [userId, userId, userId, ...campaignAccess.params]
  };
}

function legacyCollaborationColumns(alias) {
  return `${alias}.id, ${alias}.demand_id, ${alias}.influencer_id, ${alias}.user_id,
    ${alias}.status, ${alias}.proposal_notes, ${alias}.cost_quoted, ${alias}.cost_actual,
    ${alias}.content_url, ${alias}.roi_data, ${alias}.timeline_start, ${alias}.timeline_end,
    ${alias}.notes, ${alias}.created_at, ${alias}.updated_at,
    influencer.kol_handle, influencer.platform, influencer.followers, influencer.category,
    influencer.region, influencer.project_name, influencer.product_name,
    influencer.content_deliverable, influencer.quoted_price`;
}

function readAuthorizedCollaboration(db, userId, collaborationId, includeCustody) {
  const scope = authorizedCollaborationScope(userId);
  const custodyProjection = includeCustody
    ? ', authorized.custody_campaign_id AS __custody_campaign_id'
    : '';
  return db.prepare(`
    WITH ${scope.sql}
    SELECT ${legacyCollaborationColumns('collaboration')}${custodyProjection}
    FROM authorized_collaborations authorized
    JOIN collaborations collaboration ON collaboration.id=authorized.id
    JOIN influencers influencer ON collaboration.influencer_id=influencer.id
    WHERE collaboration.id=?
    LIMIT 1
  `).get(...scope.params, collaborationId) || null;
}

function archiveSummary(content) {
  return Array.from(content.replace(/\s+/gu, ' ').trim()).slice(0, 1000).join('');
}

function requireCampaignAccess(db, userId, campaignId) {
  const access = getCampaignAccess(db, { userId, campaignId });
  if (!access.ok) {
    throw serviceError(access.status, access.code, 'Campaign access is unavailable.');
  }
  return access;
}

function requireCampaignWrite(db, userId, campaignId) {
  const access = requireCampaignAccess(db, userId, campaignId);
  if (!access.permissions.write) {
    throw serviceError(
      409,
      access.campaign.operational_status === 'cancelled' ? 'CAMPAIGN_CANCELLED' : 'CAMPAIGN_ON_HOLD',
      'Campaign is not writable.',
      { operational_status: access.campaign.operational_status }
    );
  }
  return access;
}

function idempotencyOutcome(reservation) {
  if (reservation.state === 'replay') {
    return { status: reservation.statusCode, body: reservation.responseBody };
  }
  if (reservation.state === 'processing') {
    throw serviceError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The idempotent request is still processing.');
  }
  if (reservation.state === 'conflict') {
    throw serviceError(409, 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key was already used.');
  }
  throw serviceError(410, 'IDEMPOTENCY_EXPIRED', 'The idempotency response expired.');
}

function activeRelations(db, campaignId, collaborationId) {
  return db.prepare(`
    SELECT relation_type
    FROM campaign_record_links
    WHERE campaign_id=? AND record_type='collaboration' AND record_id=? AND revoked_at IS NULL
    ORDER BY CASE relation_type
      WHEN 'order' THEN 1 WHEN 'execution' THEN 2 WHEN 'publication' THEN 3 WHEN 'settlement' THEN 4
      ELSE 99 END
  `).all(campaignId, String(collaborationId)).map((row) => row.relation_type);
}

function contractConfirmation(db, campaignId, collaborationId) {
  const rows = db.prepare(`
    SELECT
      entry.id,entry.source_id,entry.business_type,entry.business_id,entry.created_by,
      entry.visibility,entry.metadata_json,entry.created_at,
      link.org_id,link.created_by AS link_created_by,link.metadata_json AS link_metadata_json,
      campaign.org_id AS campaign_org_id,actor.display_name AS confirmed_by_name
    FROM campaign_record_links link
    JOIN knowledge_entries entry
      ON entry.id=CAST(link.record_id AS INTEGER)
     AND entry.source_type='collaboration_contract_confirmation'
     AND entry.entry_type='collaboration_contract_confirmation'
    JOIN campaigns campaign ON campaign.id=link.campaign_id
    LEFT JOIN users actor
      ON actor.id=json_extract(entry.metadata_json,'$.confirmed_by')
    WHERE link.campaign_id=?
      AND link.record_type='knowledge_entry'
      AND link.relation_type='knowledge'
      AND link.revoked_at IS NULL
      AND json_extract(entry.metadata_json,'$.collaboration_id')=?
    ORDER BY entry.id DESC
    LIMIT 2
  `).all(campaignId, collaborationId);
  if (!rows.length) return null;
  if (rows.length !== 1) {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
  }
  const row = rows[0];
  let metadata;
  let linkMetadata;
  try {
    metadata = JSON.parse(row.metadata_json);
    linkMetadata = JSON.parse(row.link_metadata_json);
  } catch (error) {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
  }
  let signedAt;
  let confirmedAt;
  try {
    signedAt = normalizedSignedAt(metadata.signed_at, false);
    confirmedAt = normalizedSignedAt(metadata.confirmed_at, false);
  } catch (error) {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
  }
  const expectedSourceId = `${collaborationId}:${metadata.row_version}`;
  if (
    metadata.schema_version !== 1 || metadata.collaboration_id !== collaborationId ||
    !Number.isSafeInteger(metadata.row_version) || metadata.row_version < 1 ||
    !Number.isSafeInteger(metadata.confirmed_by) || metadata.confirmed_by < 1 ||
    metadata.retrieval_eligible !== false || signedAt !== metadata.signed_at ||
    typeof metadata.confirmed_at !== 'string' || confirmedAt !== metadata.confirmed_at ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(metadata.confirmed_at) ||
    typeof metadata.contract_reference !== 'string' || !metadata.contract_reference.trim() || metadata.contract_reference.length > 160 ||
    typeof metadata.counterparty_name !== 'string' || !metadata.counterparty_name.trim() || metadata.counterparty_name.length > 160 ||
    typeof metadata.confirmation_note !== 'string' || !metadata.confirmation_note.trim() || metadata.confirmation_note.length > 500 ||
    String(row.source_id) !== expectedSourceId || row.business_type !== 'campaign' ||
    String(row.business_id) !== String(campaignId) || row.visibility !== 'team' ||
    row.created_by !== metadata.confirmed_by || row.link_created_by !== metadata.confirmed_by ||
    row.org_id !== row.campaign_org_id ||
    !linkMetadata || linkMetadata.producer_type !== 'collaboration_contract_confirmation' ||
    linkMetadata.producer_id !== collaborationId ||
    linkMetadata.source_type !== 'collaboration_contract_confirmation' ||
    String(linkMetadata.source_id) !== expectedSourceId
  ) {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence is inconsistent.');
  }
  return {
    id: row.id,
    contract_reference: metadata.contract_reference,
    counterparty_name: metadata.counterparty_name,
    signed_at: metadata.signed_at,
    confirmation_note: metadata.confirmation_note,
    confirmed_by: metadata.confirmed_by,
    confirmed_by_name: row.confirmed_by_name || null,
    confirmed_at: metadata.confirmed_at
  };
}

function insertLink(db, values) {
  const bundleId = values.bundleId || crypto.randomBytes(32).toString('hex');
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    values.orgId, values.campaignId, values.recordType, bundleId,
    String(values.recordId), values.relationType, values.userId,
    JSON.stringify(values.metadata || {})
  );
  return { id: Number(result.lastInsertRowid), bundleId };
}

function activeCollaborationLinks(db, campaignId, collaborationId) {
  return db.prepare(`
    SELECT id,bundle_id,relation_type
    FROM campaign_record_links
    WHERE campaign_id=? AND record_type='collaboration' AND record_id=?
      AND relation_type IN ('order','execution','publication','settlement')
      AND revoked_at IS NULL
    ORDER BY CASE relation_type
      WHEN 'settlement' THEN 1
      WHEN 'publication' THEN 2
      WHEN 'execution' THEN 3
      WHEN 'order' THEN 4
      ELSE 99 END,id
  `).all(campaignId, String(collaborationId));
}

function activeCollaborationBundle(db, campaignId, collaborationId) {
  const links = activeCollaborationLinks(db, campaignId, collaborationId);
  if (links.length === 0) return null;
  const bundleIds = new Set(links.map((link) => link.bundle_id));
  if (bundleIds.size !== 1) {
    throw serviceError(
      409,
      'CAMPAIGN_EVIDENCE_IN_USE',
      'Campaign collaboration evidence is inconsistent.'
    );
  }
  return { bundleId: links[0].bundle_id, links };
}

function collaborationCustody(db, collaborationId) {
  const active = db.prepare(`
    SELECT org_id,campaign_id,bundle_id
    FROM campaign_record_links
    WHERE record_type='collaboration' AND record_id=?
      AND relation_type IN ('order','execution','publication','settlement')
      AND revoked_at IS NULL
    ORDER BY id
  `).all(String(collaborationId));
  if (active.length > 0) {
    const identities = new Set(active.map((row) => (
      `${row.org_id}:${row.campaign_id}:${row.bundle_id}`
    )));
    if (identities.size !== 1) {
      throw serviceError(
        409,
        'CAMPAIGN_EVIDENCE_IN_USE',
        'Campaign collaboration evidence is inconsistent.'
      );
    }
    return {
      classification: 'campaign_classified',
      state: 'active',
      orgId: active[0].org_id,
      campaignId: active[0].campaign_id,
      bundleId: active[0].bundle_id
    };
  }
  const historical = db.prepare(`
    SELECT org_id,campaign_id,bundle_id
    FROM campaign_record_links
    WHERE record_type='collaboration' AND record_id=?
      AND relation_type IN ('order','execution','publication','settlement')
      AND revoked_at IS NOT NULL
    ORDER BY revoked_at DESC,id DESC
    LIMIT 1
  `).get(String(collaborationId));
  if (historical) {
    return {
      classification: 'campaign_classified',
      state: 'historical',
      orgId: historical.org_id,
      campaignId: historical.campaign_id,
      bundleId: historical.bundle_id
    };
  }
  return {
    classification: 'unclassified',
    state: 'none',
    orgId: null,
    campaignId: null,
    bundleId: null
  };
}

function insertLinkAttachedEvent(db, values) {
  const recordType = values.recordType || 'collaboration';
  const recordId = values.recordId || values.collaborationId;
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?, 'link_attached',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.orgId, values.campaignId, values.userId, values.reason, 'collaboration_link',
    JSON.stringify({
      bundle_id: values.link.bundleId,
      relation_types: [values.relationType],
      record_type: recordType,
      record_id: String(recordId),
      link_ids: [values.link.id]
    }),
    values.requestId || null,
    values.auditFingerprint
  );
}

function insertLinkRevokedEvent(db, values) {
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?,'link_revoked',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.orgId,
    values.campaignId,
    values.userId,
    values.reason,
    'collaboration_link',
    JSON.stringify({
      bundle_id: values.bundle.bundleId,
      relation_types: values.bundle.links.map((link) => link.relation_type).sort(),
      record_type: 'collaboration',
      record_id: String(values.collaborationId),
      revoked_link_ids: values.bundle.links.map((link) => link.id).sort((left, right) => left - right)
    }),
    values.requestId || null,
    values.auditFingerprint
  );
}

function insertOperationalCancellationEvent(db, values) {
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?,'operational_status_changed',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.orgId,
    values.campaignId,
    values.userId,
    values.reason,
    'collaboration_link',
    JSON.stringify({
      previous_status: 'on_hold',
      next_status: 'cancelled',
      previous_version: values.previousVersion,
      next_version: values.previousVersion + 1
    }),
    values.requestId || null,
    values.auditFingerprint
  );
}

function revokeCollaborationBundle(db, values) {
  const bundle = activeCollaborationBundle(db, values.campaignId, values.collaborationId);
  if (!bundle) {
    throw serviceError(
      409,
      'CAMPAIGN_EVIDENCE_IN_USE',
      'Campaign collaboration evidence is inconsistent.'
    );
  }
  for (const link of bundle.links) {
    const update = db.prepare(`
      UPDATE campaign_record_links
      SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,revoke_reason=?
      WHERE id=? AND revoked_at IS NULL
    `).run(values.userId, values.reason, link.id);
    if (update.changes !== 1) {
      throw serviceError(
        409,
        'CAMPAIGN_EVIDENCE_IN_USE',
        'Campaign collaboration evidence changed concurrently.'
      );
    }
  }
  return bundle;
}

function updateCollaborationCancelled(db, values) {
  const update = db.prepare(`
    UPDATE collaborations
    SET status='cancelled',row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND row_version=?
      AND status IN ('proposed','contacted','negotiating','confirmed','contract_sent','contracted','live','content_review')
  `).run(values.collaborationId, values.expectedVersion);
  if (update.changes !== 1) {
    throw serviceError(
      409,
      'STALE_COLLABORATION_VERSION',
      'Collaboration version is stale.'
    );
  }
}

function cancelWorkflowDependents(db, campaignId) {
  db.prepare(`
    UPDATE workflow_tasks
    SET status='cancelled'
    WHERE status='pending'
      AND instance_id IN (
        SELECT id FROM workflow_instances
        WHERE campaign_id=? AND status IN ('active','paused')
      )
  `).run(campaignId);
  db.prepare(`
    UPDATE workflow_instances
    SET status='cancelled'
    WHERE campaign_id=? AND status IN ('active','paused')
  `).run(campaignId);
  db.prepare(`
    UPDATE campaign_workflow_dispatches
    SET status='cancelled',lease_until=NULL,lease_token=NULL,next_attempt_at=NULL,
      last_error_code='CAMPAIGN_CANCELLED',last_error='Campaign cancelled',
      updated_at=CURRENT_TIMESTAMP
    WHERE campaign_id=?
      AND status IN ('pending','processing','failed_initialization')
  `).run(campaignId);
}

function cancelCampaignCascade(db, values) {
  const collaborations = db.prepare(`
    SELECT collaboration.id,collaboration.row_version,
      COUNT(DISTINCT link.bundle_id) AS active_bundle_count
    FROM collaborations collaboration
    JOIN campaign_record_links link
      ON link.record_type='collaboration'
     AND link.record_id=CAST(collaboration.id AS TEXT)
     AND link.campaign_id=?
     AND link.relation_type IN ('order','execution','publication','settlement')
     AND link.revoked_at IS NULL
    WHERE collaboration.status IN ('proposed','contacted','negotiating','confirmed','contract_sent','contracted','live','content_review')
    GROUP BY collaboration.id,collaboration.row_version
    ORDER BY collaboration.id
  `).all(values.campaignId);
  const target = collaborations.find((row) => row.id === values.collaborationId);
  if (!target || target.row_version !== values.expectedVersion) {
    throw serviceError(
      409,
      'STALE_COLLABORATION_VERSION',
      'Collaboration version is stale.'
    );
  }
  if (collaborations.some((row) => row.active_bundle_count !== 1)) {
    throw serviceError(
      409,
      'CAMPAIGN_EVIDENCE_IN_USE',
      'Campaign collaboration evidence is inconsistent.'
    );
  }
  if (
    values.campaignVersion === SAFE_MAX ||
    collaborations.some((row) => row.row_version === SAFE_MAX)
  ) {
    throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
  }
  for (const collaboration of collaborations) {
    revokeCollaborationBundle(db, {
      campaignId: values.campaignId,
      collaborationId: collaboration.id,
      userId: values.userId,
      reason: values.reason
    });
    updateCollaborationCancelled(db, {
      collaborationId: collaboration.id,
      expectedVersion: collaboration.row_version
    });
  }
  cancelWorkflowDependents(db, values.campaignId);
  const campaignUpdate = db.prepare(`
    UPDATE campaigns
    SET operational_status='cancelled',row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND operational_status='on_hold' AND row_version=?
  `).run(values.campaignId, values.campaignVersion);
  if (campaignUpdate.changes !== 1) {
    throw serviceError(
      409,
      'INVALID_COLLABORATION_TRANSITION',
      'Collaboration cancellation requires a held campaign.'
    );
  }
  insertOperationalCancellationEvent(db, {
    orgId: values.orgId,
    campaignId: values.campaignId,
    userId: values.userId,
    reason: values.reason,
    previousVersion: values.campaignVersion,
    requestId: values.requestId,
    auditFingerprint: values.auditFingerprint
  });
}

function isOrderedOrLater(lifecycleState) {
  return LIFECYCLE_STATES.indexOf(lifecycleState) >= LIFECYCLE_STATES.indexOf('ordered');
}

function errorResponse(code, message) {
  return { error: message, code };
}

function completeJson(db, reservation, hash, statusCode, responseBody) {
  idempotencyService.completeJsonInTransaction(db, {
    ledgerId: reservation.ledgerId,
    requestHash: hash,
    leaseToken: reservation.leaseToken,
    statusCode,
    responseBody
  });
  return { status: statusCode, body: responseBody };
}

function collaborationArchive(db, values) {
  const row = db.prepare(`
    SELECT id,influencer_id,status,row_version,cost_quoted,cost_actual,cost_actual_confirmed
    FROM collaborations
    WHERE id=?
  `).get(values.collaborationId);
  if (!row) throw new Error('Committed collaboration was not found.');
  const campaignRelation = values.campaignRelation === undefined
    ? null
    : values.campaignRelation;
  if (campaignRelation !== null && !COLLABORATION_RELATIONS.includes(campaignRelation)) {
    throw new Error('Committed collaboration campaign relation is invalid.');
  }
  const contentValues = {
    id: row.id,
    influencer_id: row.influencer_id,
    status: row.status,
    row_version: row.row_version,
    campaign_relation: campaignRelation,
    cost_actual: row.cost_actual,
    cost_actual_confirmed: row.cost_actual_confirmed
  };
  if (values.resource) {
    contentValues.cost_quoted = row.cost_quoted;
    contentValues.resource = values.resource;
  }
  const content = JSON.stringify(contentValues);
  const archive = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: values.orgId,
    campaignId: values.campaignId,
    createdBy: values.userId,
    entryType: 'campaign_collaboration',
    title: `Campaign collaboration #${row.id}`,
    summary: archiveSummary(content),
    content,
    tags: ['campaign', 'collaboration'],
    sourceType: 'campaign_collaboration',
    sourceId: `${row.id}:${row.row_version}`,
    visibility: 'team',
    metadata: {}
  });
  if (archive.status !== 'created') {
    throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Collaboration archive evidence already exists.');
  }
  insertLink(db, {
    orgId: values.orgId,
    campaignId: values.campaignId,
    userId: values.userId,
    recordType: 'knowledge_entry',
    recordId: archive.entry.id,
    relationType: 'knowledge',
    metadata: { producer_type: 'collaboration', producer_id: values.collaborationId }
  });
  knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, archive.capacityGaugePlan);
  return archive;
}

function createCampaignCollaborationService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('campaign collaboration service requires a SQLite database');
  }

  function list(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    if (!requireActiveActor(db, userId)) return { collaborations: [] };
    const rawCampaignId = input && input.campaignId;
    const campaignId = rawCampaignId === undefined || rawCampaignId === null || rawCampaignId === ''
      ? null
      : Number(rawCampaignId);
    if (campaignId !== null && (!Number.isSafeInteger(campaignId) || campaignId < 1)) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'Campaign id is invalid.');
    }
    const includeCampaignContext = campaignId !== null ||
      input && (input.includeCampaignContext === true || input.includeCampaignContext === '1' || input.includeCampaignContext === 'true');
    const scope = authorizedCollaborationScope(userId);
    const conditions = [];
    const params = [...scope.params];
    if (input.status) {
      conditions.push('collaboration.status=?');
      params.push(input.status);
    }
    if (input.demandId) {
      conditions.push('collaboration.demand_id=?');
      params.push(parseInt(input.demandId));
    }
    if (campaignId !== null) {
      conditions.push('authorized.custody_campaign_id=?');
      params.push(campaignId);
    }
    const contextProjection = includeCampaignContext
      ? `, collaboration.row_version,
        authorized.custody_campaign_id AS campaign_id,
        campaign.name AS campaign_name,
        campaign.lifecycle_state AS campaign_lifecycle_state,
        campaign.operational_status AS campaign_operational_status`
      : '';
    const contextJoin = includeCampaignContext
      ? 'LEFT JOIN campaigns campaign ON campaign.id=authorized.custody_campaign_id'
      : '';
    const rows = db.prepare(`
      WITH ${scope.sql}
      SELECT ${legacyCollaborationColumns('collaboration')}${contextProjection}
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
      JOIN influencers influencer ON collaboration.influencer_id=influencer.id
      ${contextJoin}
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY collaboration.updated_at DESC
      LIMIT 200
    `).all(...params);
    const collaborations = includeCampaignContext
      ? rows.map((row) => ({
          ...row,
          active_relations: row.campaign_id === null
            ? []
            : activeRelations(db, row.campaign_id, row.id),
          contract_confirmation: row.campaign_id === null
            ? null
            : contractConfirmation(db, row.campaign_id, row.id)
        }))
      : rows;
    return { collaborations };
  }

  function get(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    if (!requireActiveActor(db, userId)) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    const row = readAuthorizedCollaboration(db, userId, collaborationId, false);
    if (!row) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    return row;
  }

  function updateLegacy(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const body = input && input.body && typeof input.body === 'object'
      ? input.body
      : {};
    return db.transaction(() => {
      if (!requireActiveActor(db, userId)) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
      }
      const authorized = readAuthorizedCollaboration(
        db,
        userId,
        collaborationId,
        true
      );
      if (!authorized) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
      }
      const {
        __custody_campaign_id: custodyCampaignId,
        ...current
      } = authorized;
      if (custodyCampaignId !== null) {
        throw serviceError(
          409,
          'CAMPAIGN_CONTEXT_REQUIRED',
          'Campaign context is required for this collaboration.',
          { campaign_id: custodyCampaignId }
        );
      }
      if (Object.hasOwn(body, 'cost_quoted') && isCanonicalCollaborationResource(current.proposal_notes)) {
        throw serviceError(409, 'RESOURCE_QUOTE_LOCKED', 'A confirmed resource order locks its quoted price.');
      }
      const update = db.prepare(`
        UPDATE collaborations
        SET
          status=COALESCE(?,status),
          cost_quoted=COALESCE(?,cost_quoted),
          cost_actual=COALESCE(?,cost_actual),
          content_url=COALESCE(?,content_url),
          notes=COALESCE(?,notes),
          timeline_start=COALESCE(?,timeline_start),
          timeline_end=COALESCE(?,timeline_end),
          row_version=row_version+1,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version<?
      `).run(
        body.status,
        body.cost_quoted,
        body.cost_actual,
        body.content_url,
        body.notes,
        body.timeline_start,
        body.timeline_end,
        collaborationId,
        Number.MAX_SAFE_INTEGER
      );
      if (update.changes !== 1) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }
      return { current, collaboration: get({ userId, collaborationId }) };
    }).immediate();
  }

  function confirmContract(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(
      input && input.collaborationId,
      'collaborationId'
    );
    const body = input && input.body && typeof input.body === 'object' && !Array.isArray(input.body)
      ? input.body
      : null;
    if (!body || !Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1) {
      throw serviceError(400, 'INVALID_CONTRACT_CONFIRMATION', 'Signed contract evidence is invalid.', {
        field: 'campaign_id'
      });
    }
    if (!requireActiveActor(db, userId)) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    get({ userId, collaborationId });
    const campaignId = body.campaign_id;
    const initialCustody = collaborationCustody(db, collaborationId);
    if (
      initialCustody.classification !== 'campaign_classified' ||
      initialCustody.state !== 'active' ||
      initialCustody.campaignId !== campaignId
    ) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    const initialAccess = requireCampaignWrite(db, userId, campaignId);
    const confirmation = normalizedContractConfirmation(body);
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const hash = requestHash({
      method: 'POST',
      path: `/api/collaborations/${collaborationId}/contract-confirmations`,
      campaignId,
      kind: 'json',
      payload: body
    });
    const reservationInput = {
      organizationId: initialAccess.campaign.org_id,
      actorUserId: userId,
      campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.update.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };

    return db.transaction(() => {
      const access = requireCampaignWrite(db, userId, campaignId);
      get({ userId, collaborationId });
      const custody = collaborationCustody(db, collaborationId);
      if (
        custody.classification !== 'campaign_classified' ||
        custody.state !== 'active' ||
        custody.campaignId !== campaignId
      ) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
      }
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);

      const current = db.prepare('SELECT * FROM collaborations WHERE id=?').get(collaborationId);
      if (contractConfirmation(db, campaignId, collaborationId)) {
        throw serviceError(409, 'CONTRACT_ALREADY_CONFIRMED', 'Signed contract was already confirmed.');
      }
      if (current.row_version !== confirmation.expectedVersion) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      if (!['confirmed', 'contract_sent'].includes(current.status)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Signed contract confirmation is not available from the current status.');
      }
      if (!v2CollaborationResource(current.proposal_notes)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Signed contract confirmation requires a version 2 order.');
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }

      const update = db.prepare(`
        UPDATE collaborations
        SET status='contracted',row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(collaborationId, confirmation.expectedVersion);
      if (update.changes !== 1) {
        throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      }
      const confirmedAt = db.prepare(`
        SELECT replace(CURRENT_TIMESTAMP,' ','T') || '.000Z' AS now
      `).get().now;
      const metadata = {
        schema_version: 1,
        collaboration_id: collaborationId,
        row_version: confirmation.expectedVersion + 1,
        contract_reference: confirmation.contractReference,
        counterparty_name: confirmation.counterpartyName,
        signed_at: confirmation.signedAt,
        confirmation_note: confirmation.confirmationNote,
        confirmed_by: userId,
        confirmed_at: confirmedAt,
        retrieval_eligible: false
      };
      const evidenceContent = JSON.stringify({
        collaboration_id: collaborationId,
        checkpoint: 'signed_contract',
        status: 'contracted',
        evidence_recorded: true
      });
      const evidence = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
        organizationId: access.campaign.org_id,
        campaignId,
        createdBy: userId,
        entryType: 'collaboration_contract_confirmation',
        title: `Signed contract checkpoint #${collaborationId}`,
        summary: `Signed contract evidence recorded for collaboration #${collaborationId}.`,
        content: evidenceContent,
        tags: ['campaign', 'collaboration', 'contract'],
        sourceType: 'collaboration_contract_confirmation',
        sourceId: `${collaborationId}:${confirmation.expectedVersion + 1}`,
        visibility: 'team',
        metadata
      });
      if (evidence.status !== 'created') {
        throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Signed contract evidence already exists.');
      }
      const evidenceLink = insertLink(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: evidence.entry.id,
        relationType: 'knowledge',
        metadata: {
          producer_type: 'collaboration_contract_confirmation',
          producer_id: collaborationId,
          source_type: 'collaboration_contract_confirmation',
          source_id: `${collaborationId}:${confirmation.expectedVersion + 1}`
        }
      });
      insertLinkAttachedEvent(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'knowledge_entry',
        recordId: evidence.entry.id,
        relationType: 'knowledge',
        link: evidenceLink,
        requestId: input.requestId,
        auditFingerprint: reservation.auditFingerprint,
        reason: 'Signed contract confirmed'
      });
      knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, evidence.capacityGaugePlan);
      collaborationArchive(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        collaborationId,
        campaignRelation: null
      });
      const persisted = contractConfirmation(db, campaignId, collaborationId);
      const response = {
        success: true,
        campaign_id: campaignId,
        status: 'contracted',
        row_version: confirmation.expectedVersion + 1,
        active_relations: activeRelations(db, campaignId, collaborationId),
        contract_confirmation: persisted
      };
      return completeJson(db, reservation, hash, 201, response);
    }).immediate();
  }

  function createLinked(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const body = input && input.body && typeof input.body === 'object' ? input.body : null;
    if (!body) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'campaign_id and influencer_id are required.');
    }
    assertAllowedKeys(body, LINKED_CREATE_KEYS, 'Linked collaboration body is invalid.');
    if (!Number.isSafeInteger(body.campaign_id) || !Number.isSafeInteger(body.influencer_id)) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'campaign_id and influencer_id are required.');
    }
    if (body.status !== undefined && body.status !== 'confirmed') {
      throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Linked collaborations start confirmed.');
    }
    if (isReservedV2ProposalNotes(body.proposal_notes) && !isV2CollaborationResourceInput(body.resource)) {
      throw serviceError(
        400,
        'RESOURCE_V2_REQUIRES_RESOURCE',
        'Version 2 collaboration orders must be supplied through resource.'
      );
    }
    const campaignId = body.campaign_id;
    const initialAccess = requireCampaignWrite(db, userId, campaignId);
    const rawResource = body.resource && typeof body.resource === 'object' ? body.resource : {};
    const hasLegacyResource = Object.keys(rawResource).length > 0;
    const versionedResourceRequest = isVersionedCollaborationResourceInput(body.resource);
    let resourcePayload = null;
    let proposalNotes = body.proposal_notes || (hasLegacyResource ? JSON.stringify(rawResource) : null);
    let costQuoted = body.cost_quoted !== undefined && body.cost_quoted !== null && body.cost_quoted !== ''
      ? body.cost_quoted
      : (rawResource.quoted_price || rawResource.price || 0);
    try {
      if (versionedResourceRequest) {
        resourcePayload = normalizeCollaborationResource(body.resource);
        if (Object.hasOwn(body, 'proposal_notes')) {
          throw serviceError(
            400,
            'RESOURCE_PROPOSAL_NOTES_CONFLICT',
            'resource and proposal_notes cannot be supplied together.'
          );
        }
        proposalNotes = serializeCollaborationResource(resourcePayload);
        costQuoted = resolveResourceQuotedPrice(resourcePayload, body.cost_quoted);
      }
    } catch (error) {
      if (error instanceof CollaborationResourceContractError) {
        throw serviceError(error.statusCode, error.code, error.message, error.details);
      }
      throw error;
    }
    const resourceFallbacks = versionedResourceRequest && resourcePayload.extensions
      ? resourcePayload.extensions
      : rawResource;
    const resourceNoteFallback = typeof resourceFallbacks.notes === 'string' ? resourceFallbacks.notes : '';
    const resourceTimelineStart = typeof resourceFallbacks.timeline_start === 'string' ? resourceFallbacks.timeline_start : null;
    const resourceTimelineEnd = typeof resourceFallbacks.timeline_end === 'string' ? resourceFallbacks.timeline_end : null;
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const hashPayload = resourcePayload
      ? Object.assign({}, body, { resource: resourcePayload, cost_quoted: costQuoted })
      : body;
    const hash = requestHash({
      method: 'POST',
      path: '/api/collaborations',
      campaignId,
      kind: 'json',
      payload: hashPayload
    });
    const reservationInput = {
      organizationId: initialAccess.campaign.org_id,
      actorUserId: userId,
      campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'collaboration.create.linked',
      key,
      requestHash: hash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    };
    return db.transaction(() => {
      const access = requireCampaignWrite(db, userId, campaignId);
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const influencer = db.prepare('SELECT id FROM influencers WHERE id=? AND is_active=1').get(body.influencer_id);
      if (!influencer) throw serviceError(404, 'RECORD_NOT_FOUND', 'Influencer was not found.');
      const result = db.prepare(`
        INSERT INTO collaborations (demand_id,influencer_id,user_id,status,proposal_notes,cost_quoted,notes,timeline_start,timeline_end,row_version,cost_actual_confirmed)
        VALUES (?,?,?,?,?,?,?,?,?,1,0)
      `).run(
        body.demand_id || null, body.influencer_id, userId, 'confirmed', proposalNotes,
        costQuoted, body.notes || resourceNoteFallback || '',
        body.timeline_start || resourceTimelineStart, body.timeline_end || resourceTimelineEnd
      );
      const collaborationId = Number(result.lastInsertRowid);
      const archive = collaborationArchive(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        collaborationId,
        campaignRelation: 'order',
        resource: resourcePayload
      });
      const link = insertLink(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        recordType: 'collaboration',
        recordId: collaborationId,
        relationType: 'order',
        metadata: { knowledge_entry_id: archive.entry.id }
      });
      insertLinkAttachedEvent(db, {
        orgId: access.campaign.org_id, campaignId, userId, collaborationId,
        relationType: 'order', link, requestId: input.requestId, auditFingerprint: reservation.auditFingerprint,
        reason: 'Linked order'
      });
      const response = {
        id: collaborationId,
        campaign_id: campaignId,
        row_version: 1,
        active_relations: activeRelations(db, campaignId, collaborationId)
      };
      idempotencyService.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: 201,
        responseBody: response
      });
      return { status: 201, body: response };
    }).immediate();
  }

  function updateLinked(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    const collaborationId = requirePositiveSafeId(input && input.collaborationId, 'collaborationId');
    const body = input && input.body && typeof input.body === 'object' ? input.body : null;
    if (!body) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'campaign_id, expected_version, and reason are required.');
    }
    const cancellation = Object.hasOwn(body, 'action');
    assertAllowedKeys(
      body,
      cancellation ? LINKED_CANCELLATION_KEYS : LINKED_UPDATE_KEYS,
      cancellation
        ? 'Collaboration cancellation body is invalid.'
        : 'Linked collaboration body is invalid.'
    );
    if (
      !Number.isSafeInteger(body.campaign_id) || body.campaign_id < 1 ||
      !Number.isSafeInteger(body.expected_version) || body.expected_version < 1 ||
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 1 || body.reason.length > 1000
    ) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'campaign_id, expected_version, and reason are required.');
    }
    if (cancellation && body.action !== 'cancel') {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'action is reserved for collaboration cancellation.');
    }
    if (
      body.campaign_relation !== undefined &&
      !COLLABORATION_RELATIONS.includes(body.campaign_relation)
    ) {
      throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
    }
    if (
      Object.hasOwn(body, 'cost_actual') &&
      !isCanonicalCost(body.cost_actual)
    ) {
      throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'cost_actual is invalid.');
    }
    if (
      body.campaign_relation === 'settlement' &&
      (
        body.status !== 'completed' ||
        !Object.hasOwn(body, 'cost_actual') ||
        body.confirm_cost_actual !== true
      )
    ) {
      throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
    }
    if (
      body.confirm_cost_actual === true &&
      (
        body.status !== 'completed' ||
        !Object.hasOwn(body, 'cost_actual')
      )
    ) {
      throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Cost reconfirmation is invalid.');
    }
    const campaignId = body.campaign_id;
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw serviceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const initialAccess = cancellation
      ? requireCampaignAccess(db, userId, campaignId)
      : requireCampaignWrite(db, userId, campaignId);
    get({ userId, collaborationId });
    const initialCustody = collaborationCustody(db, collaborationId);
    if (
      initialCustody.classification === 'campaign_classified' &&
      initialCustody.campaignId !== campaignId
    ) {
      throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
    }
    const hash = requestHash({ method: 'PUT', path: `/api/collaborations/${collaborationId}`, campaignId, kind: 'json', payload: body });
    const reservationInput = {
      organizationId: initialAccess.campaign.org_id,
      actorUserId: userId, campaignId, secondaryCampaignId: null, resourceClaim: null,
      scope: 'collaboration.update.linked', key, requestHash: hash,
      expectedEventCount: cancellation || body.campaign_relation ? 1 : 0,
      operationTimeoutSeconds: 60
    };
    return db.transaction(() => {
      const access = requireCampaignAccess(db, userId, campaignId);
      get({ userId, collaborationId });
      const preReservationCustody = collaborationCustody(db, collaborationId);
      if (
        preReservationCustody.classification === 'campaign_classified' &&
        preReservationCustody.campaignId !== campaignId
      ) {
        throw serviceError(404, 'RECORD_NOT_FOUND', 'Collaboration was not found.');
      }
      let reservation = idempotencyService.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') reservation = idempotencyService.reserveProcessingInTransaction(db, reservationInput);
      if (reservation.state !== 'reserved') return idempotencyOutcome(reservation);
      const current = db.prepare('SELECT * FROM collaborations WHERE id=?').get(collaborationId);
      if (current.row_version !== body.expected_version) throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      if (Object.hasOwn(body, 'cost_quoted') && isCanonicalCollaborationResource(current.proposal_notes)) {
        throw serviceError(409, 'RESOURCE_QUOTE_LOCKED', 'A confirmed resource order locks its quoted price.');
      }
      if (current.row_version === SAFE_MAX) {
        throw serviceError(409, 'ROW_VERSION_EXHAUSTED', 'Collaboration row version is exhausted.');
      }

      if (cancellation) {
        if (
          preReservationCustody.classification !== 'campaign_classified' ||
          preReservationCustody.state !== 'active' ||
          preReservationCustody.campaignId !== campaignId ||
          !CANCELLABLE_STATUSES.includes(current.status)
        ) {
          throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration cancellation is invalid.');
        }
        if (access.campaign.operational_status !== 'on_hold') {
          throw serviceError(
            409,
            'INVALID_COLLABORATION_TRANSITION',
            'Collaboration cancellation requires a held campaign.'
          );
        }
        if (isOrderedOrLater(access.campaign.lifecycle_state)) {
          cancelCampaignCascade(db, {
            orgId: access.campaign.org_id,
            campaignId,
            campaignVersion: access.campaign.row_version,
            collaborationId,
            expectedVersion: body.expected_version,
            userId,
            reason: body.reason,
            requestId: input.requestId,
            auditFingerprint: reservation.auditFingerprint
          });
        } else {
          const bundle = revokeCollaborationBundle(db, {
            campaignId,
            collaborationId,
            userId,
            reason: body.reason
          });
          updateCollaborationCancelled(db, {
            collaborationId,
            expectedVersion: body.expected_version
          });
          insertLinkRevokedEvent(db, {
            orgId: access.campaign.org_id,
            campaignId,
            collaborationId,
            userId,
            reason: body.reason,
            bundle,
            requestId: input.requestId,
            auditFingerprint: reservation.auditFingerprint
          });
        }
        collaborationArchive(db, {
          orgId: access.campaign.org_id,
          campaignId,
          userId,
          collaborationId,
          campaignRelation: null
        });
        const response = {
          success: true,
          campaign_id: campaignId,
          row_version: body.expected_version + 1,
          active_relations: []
        };
        return completeJson(db, reservation, hash, 200, response);
      }

      if (!access.permissions.write) {
        throw serviceError(
          409,
          access.campaign.operational_status === 'cancelled'
            ? 'CAMPAIGN_CANCELLED'
            : 'CAMPAIGN_ON_HOLD',
          'Campaign is not writable.',
          { operational_status: access.campaign.operational_status }
        );
      }
      const adopting = preReservationCustody.classification === 'unclassified';
      if (adopting) {
        if (
          body.campaign_relation !== 'order' ||
          !['confirmed', 'contract_sent', 'live', 'content_review', 'completed'].includes(current.status)
        ) {
          throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration adoption is invalid.');
        }
      } else if (
        preReservationCustody.state !== 'active' ||
        preReservationCustody.campaignId !== campaignId
      ) {
        throw serviceError(
          409,
          'RECORD_REQUIRES_LINK_CORRECTION',
          'Collaboration evidence requires link correction.'
        );
      }
      const nextStatus = body.status === undefined ? current.status : body.status;
      const allowed = {
        confirmed: ['confirmed', 'contract_sent', 'contracted', 'live'],
        contract_sent: ['contract_sent', 'contracted', 'live'],
        contracted: ['contracted', 'live'],
        live: ['live', 'content_review', 'completed'],
        content_review: ['content_review', 'completed'],
        completed: ['completed']
      };
      if (!allowed[current.status] || !allowed[current.status].includes(nextStatus)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration transition is invalid.');
      }
      if (
        nextStatus === 'contracted' &&
        current.status !== 'contracted'
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Signed contracts must be confirmed through the contract checkpoint.');
      }
      if (
        nextStatus === 'live' &&
        ['confirmed', 'contract_sent'].includes(current.status) &&
        isReservedV2ProposalNotes(current.proposal_notes)
      ) {
        throw serviceError(409, 'CONTRACT_CONFIRMATION_REQUIRED', 'Signed contract confirmation is required before execution.');
      }
      const costChanged = Object.hasOwn(body, 'cost_actual') && body.cost_actual !== current.cost_actual;
      const relations = activeRelations(db, campaignId, collaborationId);
      const relation = body.campaign_relation;
      if (relation && relations.includes(relation)) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      if (relation === 'order' && !adopting) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      if (
        relation === 'execution' &&
        (!relations.includes('order') || !['live', 'content_review', 'completed'].includes(nextStatus))
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      if (
        relation === 'publication' &&
        (
          nextStatus !== 'completed' ||
          !relations.includes('order') ||
          !relations.includes('execution')
        )
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      if (
        relation === 'settlement' &&
        (
          body.status !== 'completed' ||
          !relations.includes('publication') ||
          !Object.hasOwn(body, 'cost_actual') ||
          !isCanonicalCost(body.cost_actual) ||
          body.confirm_cost_actual !== true
        )
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Collaboration relation is invalid.');
      }
      const activeSettlement = relations.includes('settlement');
      const reconfirmingCost = (
        costChanged &&
        activeSettlement &&
        body.confirm_cost_actual === true
      );
      if (
        body.confirm_cost_actual === true &&
        relation !== 'settlement' &&
        !reconfirmingCost
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Cost reconfirmation is invalid.');
      }
      if (
        reconfirmingCost &&
        (
          body.status !== 'completed' ||
          !relations.includes('publication') ||
          !Object.hasOwn(body, 'cost_actual') ||
          !isCanonicalCost(body.cost_actual)
        )
      ) {
        throw serviceError(409, 'INVALID_COLLABORATION_TRANSITION', 'Cost reconfirmation is invalid.');
      }
      if (
        costChanged &&
        activeSettlement &&
        body.confirm_cost_actual !== true &&
        ['settled', 'reviewed'].includes(access.campaign.lifecycle_state)
      ) {
        return completeJson(
          db,
          reservation,
          hash,
          409,
          errorResponse(
            'COLLABORATION_COST_CONFIRMATION_REQUIRED',
            'Cost confirmation is required.'
          )
        );
      }
      const confirmed = relation === 'settlement' || reconfirmingCost
        ? 1
        : costChanged
          ? 0
          : current.cost_actual_confirmed;
      const update = db.prepare(`
        UPDATE collaborations SET status=?,cost_quoted=COALESCE(?,cost_quoted),cost_actual=COALESCE(?,cost_actual),
          content_url=COALESCE(?,content_url),notes=COALESCE(?,notes),timeline_start=COALESCE(?,timeline_start),
          timeline_end=COALESCE(?,timeline_end),cost_actual_confirmed=?,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND row_version=?
      `).run(nextStatus, body.cost_quoted, body.cost_actual, body.content_url, body.notes, body.timeline_start, body.timeline_end, confirmed, collaborationId, body.expected_version);
      if (update.changes !== 1) throw serviceError(409, 'STALE_COLLABORATION_VERSION', 'Collaboration version is stale.');
      if (relation) {
        const activeBundle = adopting
          ? null
          : activeCollaborationBundle(db, campaignId, collaborationId);
        if (!adopting && !activeBundle) {
          throw serviceError(409, 'CAMPAIGN_EVIDENCE_IN_USE', 'Campaign collaboration evidence is inconsistent.');
        }
        const link = insertLink(db, {
          orgId: access.campaign.org_id,
          campaignId,
          userId,
          recordType: 'collaboration',
          recordId: collaborationId,
          relationType: relation,
          bundleId: activeBundle && activeBundle.bundleId,
          metadata: relation === 'publication'
            ? {
              confirmed_by: userId,
              confirmed_at: db.prepare('SELECT CURRENT_TIMESTAMP AS now').get().now
            }
            : {}
        });
        insertLinkAttachedEvent(db, {
          orgId: access.campaign.org_id,
          campaignId,
          userId,
          collaborationId,
          relationType: relation,
          link,
          requestId: input.requestId,
          auditFingerprint: reservation.auditFingerprint,
          reason: body.reason
        });
      }
      collaborationArchive(db, {
        orgId: access.campaign.org_id,
        campaignId,
        userId,
        collaborationId,
        campaignRelation: relation || null
      });
      const response = { success: true, campaign_id: campaignId, row_version: body.expected_version + 1, active_relations: activeRelations(db, campaignId, collaborationId) };
      return completeJson(db, reservation, hash, 200, response);
    }).immediate();
  }

  function stats(input) {
    const userId = requirePositiveSafeId(input && input.userId, 'userId');
    if (!requireActiveActor(db, userId)) {
      return {
        stats: {
          byStatus: [],
          totalActive: 0,
          totalCompleted: 0,
          totalCost: 0,
          totalCostCurrency: null,
          costByCurrency: []
        }
      };
    }
    const scope = authorizedCollaborationScope(userId);
    const byStatus = db.prepare(`
      WITH ${scope.sql}
      SELECT collaboration.status,COUNT(*) AS count
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
      GROUP BY collaboration.status
    `).all(...scope.params);
    const totalActive = db.prepare(`
      WITH ${scope.sql}
      SELECT COUNT(*) AS count
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
      WHERE collaboration.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
    `).get(...scope.params, ...ACTIVE_STATUSES).count;
    const totalCompleted = db.prepare(`
      WITH ${scope.sql}
      SELECT COUNT(*) AS count
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
      WHERE collaboration.status='completed'
    `).get(...scope.params).count;
    const costRows = db.prepare(`
      WITH ${scope.sql}
      SELECT collaboration.proposal_notes,collaboration.cost_actual,collaboration.cost_quoted
      FROM authorized_collaborations authorized
      JOIN collaborations collaboration ON collaboration.id=authorized.id
    `).all(...scope.params);
    const totals = new Map();
    costRows.forEach((row) => {
      let currency = 'USD';
      try {
        const resource = JSON.parse(row.proposal_notes || 'null');
        if (
          resource &&
          resource.schema === 'turingmarket.collaboration-order.v2' &&
          /^[A-Z]{3}$/.test(resource.currency || '')
        ) {
          currency = resource.currency;
        }
      } catch (error) {}
      const rawCost = row.cost_actual !== null && row.cost_actual !== undefined
        ? row.cost_actual
        : row.cost_quoted;
      const cost = typeof rawCost === 'number' && Number.isFinite(rawCost) ? rawCost : 0;
      totals.set(currency, (totals.get(currency) || 0) + cost);
    });
    const costByCurrency = Array.from(totals, ([currency, totalCost]) => ({ currency, totalCost }))
      .sort((left, right) => left.currency.localeCompare(right.currency));
    const singleCurrency = costByCurrency.length === 1 ? costByCurrency[0] : null;
    const totalCost = singleCurrency ? singleCurrency.totalCost : (costByCurrency.length ? null : 0);
    const totalCostCurrency = singleCurrency ? singleCurrency.currency : null;
    return {
      stats: { byStatus, totalActive, totalCompleted, totalCost, totalCostCurrency, costByCurrency }
    };
  }

  return Object.freeze({ confirmContract, createLinked, get, list, stats, updateLegacy, updateLinked });
}

module.exports = {
  CampaignCollaborationServiceError,
  createCampaignCollaborationService
};
