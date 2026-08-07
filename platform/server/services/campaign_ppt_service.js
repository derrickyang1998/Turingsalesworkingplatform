'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const idempotency = require('./idempotency_service');
const knowledgeService = require('./knowledge_service');
const { getTargetAccess } = require('./campaign_access_service');
const {
  canonicalJsonBytes,
  requestHash,
  sha256Hex
} = require('./sqlite_digest_service');
const { PptArtifactStoreError } = require('./ppt_artifact_store');

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PPT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_PPT_PAYLOAD_BYTES = 65_536;
const PPT_OPERATION_TIMEOUT_SECONDS = 180;
const PPT_LINKED_SCOPE = 'proposal.ppt.generate.linked';
const PPT_SCOPES = Object.freeze([
  PPT_LINKED_SCOPE,
  'proposal.ppt.generate.unlinked.admission'
]);
const DEFAULT_JANITOR_BATCH_SIZE = 100;
const CONFIRMED_PROPOSAL_STATES = new Set([
  'proposal_confirmed',
  'influencer_shortlist',
  'ordered',
  'executing',
  'published',
  'settled',
  'reviewed'
]);

class CampaignPptServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'CampaignPptServiceError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new CampaignPptServiceError(statusCode, code, message, details);
}

function positiveId(value, field) {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', `${field} must be a positive integer.`);
  }
  return parsed;
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw serviceError(
      400,
      'INVALID_CAMPAIGN_INPUT',
      'A valid idempotency key is required for PPT generation.'
    );
  }
  return value;
}

function normalizeRequestId(value, key) {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) {
    return value;
  }
  return `ppt:${key}`;
}

function normalizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'PPT payload must be an object.');
  }
  let bytes;
  try {
    bytes = canonicalJsonBytes(value);
  } catch {
    throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'PPT payload must contain valid JSON data.');
  }
  if (bytes.length > MAX_PPT_PAYLOAD_BYTES) {
    throw serviceError(413, 'INVALID_CAMPAIGN_INPUT', 'PPT payload exceeds the retained generation limit.');
  }
  try {
    return Object.freeze({
      bytes,
      value: JSON.parse(bytes.toString('utf8'))
    });
  } catch {
    throw serviceError(400, 'INVALID_CAMPAIGN_INPUT', 'PPT payload could not be normalized.');
  }
}

function normalizeProposalDigest(value) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw serviceError(
      400,
      'INVALID_CAMPAIGN_INPUT',
      'proposal_content_sha256 must be a lowercase SHA-256 digest.'
    );
  }
  return value;
}

function loadProposalVersion(db, proposalId) {
  const proposal = db.prepare('SELECT id,content FROM proposals WHERE id=?').get(proposalId);
  if (!proposal || typeof proposal.content !== 'string') {
    throw serviceError(404, 'RECORD_NOT_FOUND', 'Proposal was not found or is not available.');
  }
  let parsed;
  try {
    parsed = JSON.parse(proposal.content);
  } catch {
    throw serviceError(
      409,
      'PROPOSAL_CONTENT_CHANGED',
      'The confirmed proposal content is no longer a canonical PPT outline.'
    );
  }
  let payload;
  try {
    payload = normalizePayload(parsed);
  } catch {
    throw serviceError(
      409,
      'PROPOSAL_CONTENT_CHANGED',
      'The confirmed proposal content is no longer a canonical PPT outline.'
    );
  }
  return Object.freeze({
    proposalId: proposal.id,
    contentSha256: sha256Hex(payload.bytes),
    payload
  });
}

function requireMatchingProposalVersion(db, proposalId, submittedDigest, submittedOutline) {
  const proposalVersion = loadProposalVersion(db, proposalId);
  const outline = normalizePayload(submittedOutline);
  if (
    submittedDigest !== proposalVersion.contentSha256 ||
    sha256Hex(outline.bytes) !== proposalVersion.contentSha256
  ) {
    throw serviceError(
      409,
      'PROPOSAL_CONTENT_CHANGED',
      'The submitted PPT outline does not match the confirmed proposal version.'
    );
  }
  return proposalVersion;
}

function mapTargetAccess(access) {
  if (access && access.ok) return access;
  const statusCode = access && Number.isSafeInteger(access.status) ? access.status : 404;
  const code = access && typeof access.code === 'string'
    ? access.code
    : 'RECORD_NOT_FOUND';
  if (statusCode === 409) {
    throw serviceError(statusCode, code, 'Campaign is not available for PPT generation.', access.details);
  }
  throw serviceError(statusCode, code, 'Proposal was not found or is not available.', access && access.details);
}

function requireProposalContext(db, userId, campaignId, proposalId) {
  const targetAccess = mapTargetAccess(getTargetAccess(db, {
    userId,
    campaignId,
    recordType: 'proposal',
    recordId: proposalId,
    relationType: 'proposal',
    intent: 'manage'
  }));
  if (!CONFIRMED_PROPOSAL_STATES.has(targetAccess.campaignAccess.campaign.lifecycle_state)) {
    throw serviceError(
      409,
      'PROPOSAL_CONFIRMATION_REQUIRED',
      'The campaign proposal must be confirmed before generating a retained PPT.'
    );
  }
  const proposalLink = db.prepare(`
    SELECT id,bundle_id
    FROM campaign_record_links
    WHERE org_id=? AND campaign_id=? AND record_type='proposal' AND record_id=?
      AND relation_type='proposal' AND revoked_at IS NULL
    LIMIT 1
  `).get(
    targetAccess.campaignAccess.campaign.org_id,
    campaignId,
    String(proposalId)
  );
  if (!proposalLink) {
    throw serviceError(
      404,
      'PROPOSAL_CAMPAIGN_LINK_REQUIRED',
      'Proposal must be linked to the campaign before PPT generation.'
    );
  }
  return {
    organizationId: targetAccess.campaignAccess.campaign.org_id,
    proposalLink,
    targetAccess
  };
}

function activePptLink(db, campaignId, proposalId) {
  return db.prepare(`
    SELECT id
    FROM campaign_record_links
    WHERE campaign_id=? AND record_type='proposal' AND record_id=?
      AND relation_type='ppt' AND revoked_at IS NULL
    LIMIT 1
  `).get(campaignId, String(proposalId));
}

function alreadyLinkedError(proposalId) {
  return serviceError(
    409,
    'RECORD_ALREADY_LINKED',
    'The retained PPT resource is already linked.',
    {
      relation_type: 'ppt',
      record_type: 'proposal',
      record_id: String(proposalId)
    }
  );
}

function assertNoActivePptLink(db, campaignId, proposalId) {
  if (activePptLink(db, campaignId, proposalId)) {
    throw alreadyLinkedError(proposalId);
  }
}

function framedUtf8(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function pptResourceClaim(organizationId, campaignId, proposalId, proposalContentSha256) {
  return sha256Hex(Buffer.concat([
    framedUtf8('tm-ppt-proposal-claim-v1'),
    framedUtf8(String(organizationId)),
    framedUtf8(String(campaignId)),
    framedUtf8(String(proposalId)),
    framedUtf8(proposalContentSha256)
  ]));
}

function artifactCacheKey(input, reservation) {
  const baseCacheKey = sha256Hex(Buffer.from(
    `${input.organizationId}\n${input.userId}\n${input.scope}\n${input.idempotencyKey}`,
    'utf8'
  ));
  const leaseTokenSha256 = sha256Hex(Buffer.from(reservation.leaseToken, 'utf8'));
  return sha256Hex(Buffer.from(
    `tm-artifact-v1\n${baseCacheKey}\n${leaseTokenSha256}`,
    'utf8'
  ));
}

function rfc5987Filename(value) {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(character)) {
      encoded += character;
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return encoded;
}

function binaryHeaders(filename, artifact) {
  return {
    'Content-Type': PPT_CONTENT_TYPE,
    'Content-Disposition': `attachment; filename="${filename}"; ` +
      `filename*=UTF-8''${rfc5987Filename(filename)}`,
    'Content-Length': String(artifact.bytes),
    ETag: `"${artifact.sha256}"`,
    'Cache-Control': 'private, max-age=0, no-store'
  };
}

function mapArtifactError(error, duringReplay) {
  if (!(error instanceof PptArtifactStoreError)) return null;
  if (duringReplay) {
    return serviceError(
      500,
      'REPLAY_ARTIFACT_INVALID',
      'The retained PPT artifact failed replay integrity validation.'
    );
  }
  if (error.code === 'PPT_ARTIFACT_INVALID') {
    return serviceError(502, 'PPT_GENERATION_FAILED', 'Generated PPT output was invalid.');
  }
  return serviceError(
    503,
    'PPT_ARTIFACT_UNAVAILABLE',
    'Generated PPT could not be retained safely.'
  );
}

function materializeBinaryReplay(artifactStore, replay) {
  if (
    !replay ||
    replay.responseKind !== 'binary' ||
    replay.statusCode !== 200 ||
    replay.responseContentType !== PPT_CONTENT_TYPE ||
    typeof replay.responseFilename !== 'string'
  ) {
    throw serviceError(
      500,
      'REPLAY_ARTIFACT_INVALID',
      'Retained PPT replay evidence was invalid.'
    );
  }
  let artifact;
  try {
    artifact = artifactStore.readVerified({
      cacheKey: replay.responseCacheKey,
      sha256: replay.responseSha256,
      bytes: replay.responseBytes
    });
  } catch (error) {
    const mapped = mapArtifactError(error, true);
    if (mapped) throw mapped;
    throw serviceError(
      500,
      'AUDIT_PERSISTENCE_FAILED',
      'Retained PPT replay evidence could not be verified.'
    );
  }
  return {
    status: 200,
    headers: binaryHeaders(replay.responseFilename, artifact),
    filePath: artifact.filePath,
    replayed: true
  };
}

function reservationError(disposition, proposalId) {
  if (disposition && disposition.state === 'conflict') {
    throw serviceError(
      disposition.statusCode || 409,
      disposition.code || 'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key conflicts with an earlier PPT request.'
    );
  }
  if (disposition && disposition.state === 'processing') {
    const error = serviceError(
      409,
      'PPT_GENERATION_IN_PROGRESS',
      'PPT generation is already in progress for this confirmed proposal version.'
    );
    error.retryAfterSeconds = Math.max(1, disposition.retryAfterSeconds || 1);
    throw error;
  }
  if (disposition && disposition.state === 'expired') {
    throw serviceError(410, 'IDEMPOTENCY_EXPIRED', 'Retained PPT generation expired.');
  }
  throw serviceError(
    500,
    'AUDIT_PERSISTENCE_FAILED',
    'PPT generation idempotency state was invalid.'
  );
}

function remapResourceClaimError(error, proposalId) {
  if (!error || typeof error.code !== 'string') return null;
  if (error.code === 'PPT_GENERATION_IN_PROGRESS') {
    const mapped = serviceError(
      409,
      'PPT_GENERATION_IN_PROGRESS',
      'PPT generation is already in progress for this confirmed proposal version.'
    );
    mapped.retryAfterSeconds = Math.max(1, error.retryAfterSeconds || 1);
    return mapped;
  }
  if (error.code === 'RECORD_ALREADY_LINKED') return alreadyLinkedError(proposalId);
  return null;
}

function insertCampaignLink(db, values) {
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    values.organizationId,
    values.campaignId,
    values.recordType,
    values.bundleId,
    String(values.recordId),
    values.relationType,
    values.userId,
    JSON.stringify(values.metadata || {})
  );
  return Number(result.lastInsertRowid);
}

function insertPptEvent(db, values) {
  db.prepare(`
    INSERT INTO campaign_events (
      org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
      reason,source,metadata_json,correlation_id,audit_fingerprint
    ) VALUES (?,?, 'link_attached',NULL,NULL,?,?,?,?,?,?)
  `).run(
    values.organizationId,
    values.campaignId,
    values.userId,
    'Linked ppt',
    'ppt_link',
    JSON.stringify({
      record_type: 'proposal',
      record_id: String(values.proposalId),
      relation_types: ['ppt'],
      link_ids: [values.pptLinkId],
      bundle_id: values.bundleId
    }),
    values.requestId,
    values.auditFingerprint
  );
}

function archivePptKnowledge(db, values) {
  const projection = JSON.stringify({
    proposal_id: values.proposalId,
    proposal_content_sha256: values.proposalContentSha256,
    artifact_sha256: values.artifact.sha256,
    response_bytes: values.artifact.bytes
  });
  const archive = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
    organizationId: values.organizationId,
    campaignId: values.campaignId,
    createdBy: values.userId,
    sourceType: 'campaign_ppt',
    sourceId: `${values.proposalId}:${values.proposalContentSha256}`,
    entryType: 'campaign_ppt',
    title: `Campaign PPT #${values.proposalId}`,
    summary: Array.from(projection.replace(/\s+/gu, ' ').trim()).slice(0, 1000).join(''),
    content: projection,
    tags: ['campaign', 'ppt'],
    visibility: 'team'
  });
  if (archive.status !== 'created') {
    throw serviceError(
      409,
      'KNOWLEDGE_ARCHIVE_CONFLICT',
      'PPT knowledge archive already exists with conflicting evidence.'
    );
  }
  const knowledgeBundle = crypto.randomBytes(32).toString('hex');
  insertCampaignLink(db, {
    organizationId: values.organizationId,
    campaignId: values.campaignId,
    userId: values.userId,
    recordType: 'knowledge_entry',
    recordId: archive.entry.id,
    relationType: 'knowledge',
    bundleId: knowledgeBundle,
    metadata: {}
  });
  if (archive.capacityGaugePlan) {
    knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(
      db,
      archive.capacityGaugePlan
    );
  }
  return archive;
}

function createWorkDirectory(tempDir, cacheKey) {
  try {
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      if (fs.realpathSync(tempDir) !== tempDir) {
        throw new Error('temporary directory cannot use symbolic links');
      }
      fs.chmodSync(tempDir, 0o700);
    }
    const root = fs.lstatSync(tempDir);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error('invalid temporary directory');
    }
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && root.uid !== process.getuid()) {
        throw new Error('temporary directory owner is invalid');
      }
      if ((root.mode & 0o077) !== 0) {
        throw new Error('temporary directory permissions are invalid');
      }
    }
    const workDir = fs.mkdtempSync(path.join(tempDir, `campaign-ppt-${cacheKey}-`));
    const work = fs.lstatSync(workDir);
    if (!work.isDirectory() || work.isSymbolicLink()) {
      throw new Error('invalid generated work directory');
    }
    if (process.platform !== 'win32') fs.chmodSync(workDir, 0o700);
    return workDir;
  } catch {
    throw serviceError(
      503,
      'PPT_ARTIFACT_UNAVAILABLE',
      'PPT generation workspace is unavailable.'
    );
  }
}

function createCampaignPptService(db, options) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Campaign PPT service options are required');
  }
  if (!options.artifactStore || typeof options.artifactStore.publishFromFile !== 'function' ||
    typeof options.artifactStore.readVerified !== 'function' ||
    typeof options.artifactStore.readExisting !== 'function' ||
    typeof options.artifactStore.remove !== 'function' ||
    typeof options.artifactStore.runJanitor !== 'function') {
    throw new TypeError('A PPT artifact store is required');
  }
  if (typeof options.tempDir !== 'string' || !path.isAbsolute(options.tempDir)) {
    throw new TypeError('Campaign PPT service tempDir must be absolute');
  }
  if (typeof options.runPptGenerator !== 'function') {
    throw new TypeError('Campaign PPT service runPptGenerator is required');
  }
  const artifactStore = options.artifactStore;
  const tempDir = path.resolve(options.tempDir);
  const runPptGenerator = options.runPptGenerator;

  function cleanupExpiredArtifact(reservationInput) {
    const artifact = idempotency.readExpiredBinaryArtifact(db, reservationInput);
    if (artifact.state === 'absent') return;
    if (artifact.state === 'conflict') reservationError(artifact);
    if (artifact.state !== 'ready') {
      throw serviceError(
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'Expired PPT cleanup is not ready for this request.'
      );
    }
    const { state: ignoredState, ...cleanupInput } = artifact;
    try {
      artifactStore.remove({ cacheKey: cleanupInput.responseCacheKey });
    } catch (error) {
      const mapped = mapArtifactError(error, false);
      if (mapped) throw mapped;
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'Expired PPT artifact cleanup could not be verified.'
      );
    }
    db.transaction(() => (
      idempotency.discardExpiredBinaryInTransaction(db, cleanupInput)
    )).immediate();
  }

  function reserveOrReplay(input, reservationInput) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let disposition;
      try {
        disposition = db.transaction(() => {
          requireProposalContext(
            db,
            input.userId,
            input.campaignId,
            input.proposalId
          );
          const proposalVersion = requireMatchingProposalVersion(
            db,
            input.proposalId,
            input.proposalContentSha256,
            input.outline
          );
          if (proposalVersion.contentSha256 !== input.proposalContentSha256) {
            throw serviceError(409, 'PROPOSAL_CONTENT_CHANGED', 'The confirmed proposal version changed.');
          }
          let result = idempotency.recoverExpiredInTransaction(db, reservationInput);
          if (result.state === 'absent') {
            assertNoActivePptLink(db, input.campaignId, input.proposalId);
            result = idempotency.reserveProcessingInTransaction(db, reservationInput);
          }
          return result;
        }).immediate();
      } catch (error) {
        const mapped = remapResourceClaimError(error, input.proposalId);
        if (mapped) throw mapped;
        throw error;
      }
      if (disposition.state === 'reserved' || disposition.state === 'replay') {
        return disposition;
      }
      if (disposition.state === 'expired' && disposition.cleanup === 'binary') {
        cleanupExpiredArtifact(reservationInput);
        continue;
      }
      reservationError(disposition, input.proposalId);
    }
    throw serviceError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Expired PPT cleanup did not settle before generation could resume.'
    );
  }

  function generateArtifact(input, reservation) {
    const cacheKey = artifactCacheKey(input, reservation);
    const workDir = createWorkDirectory(tempDir, cacheKey);
    const outputPath = path.join(workDir, 'proposal.pptx');
    try {
      let generatorResult;
      try {
        generatorResult = runPptGenerator({
          payload: input.proposalVersion.payload.value,
          outputPath,
          requestId: input.requestId,
          campaignId: input.campaignId,
          proposalId: input.proposalId
        });
      } catch {
        throw serviceError(502, 'PPT_GENERATION_FAILED', 'PPT generation failed.');
      }
      if (generatorResult && typeof generatorResult.then === 'function') {
        throw serviceError(500, 'AUDIT_PERSISTENCE_FAILED', 'PPT generator must complete synchronously.');
      }
      try {
        return artifactStore.publishFromFile({ cacheKey, sourcePath: outputPath });
      } catch (error) {
        if (error instanceof PptArtifactStoreError && error.code === 'PPT_ARTIFACT_EXISTS') {
          try {
            return artifactStore.readExisting({ cacheKey });
          } catch (existingError) {
            const mappedExisting = mapArtifactError(existingError, false);
            if (mappedExisting) throw mappedExisting;
            throw serviceError(
              500,
              'AUDIT_PERSISTENCE_FAILED',
              'Existing PPT artifact could not be reconciled safely.'
            );
          }
        }
        const mapped = mapArtifactError(error, false);
        if (mapped) throw mapped;
        throw serviceError(
          500,
          'AUDIT_PERSISTENCE_FAILED',
          'Generated PPT artifact could not be published.'
        );
      }
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  function failReservation(reservation, requestHashValue) {
    try {
      db.transaction(() => {
        idempotency.failInternalInTransaction(db, {
          ledgerId: reservation.ledgerId,
          requestHash: requestHashValue,
          leaseToken: reservation.leaseToken
        });
      }).immediate();
    } catch {
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'PPT generation failure could not be recorded safely.'
      );
    }
  }

  function reconcileUncommittedArtifact(artifact) {
    try {
      artifactStore.remove({ cacheKey: artifact.cacheKey });
      return Object.freeze({ state: 'removed' });
    } catch {
      try {
        const retained = artifactStore.readExisting({ cacheKey: artifact.cacheKey });
        if (retained.bytes !== artifact.bytes || retained.sha256 !== artifact.sha256) {
          throw new Error('retained artifact identity changed');
        }
        return Object.freeze({ state: 'retained_for_retry' });
      } catch {
        return Object.freeze({ state: 'unrecoverable' });
      }
    }
  }

  function runArtifactJanitor(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('PPT artifact janitor input must be an object');
    }
    const batchSize = input.batchSize === undefined
      ? DEFAULT_JANITOR_BATCH_SIZE
      : input.batchSize;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new TypeError('PPT artifact janitor batchSize is invalid');
    }

    const recoveryRows = db.prepare(`
      SELECT
        org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
        idempotency_key,request_hash,expected_event_count
      FROM request_idempotency
      WHERE scope IN (?,?) AND (
        state IN ('processing','failed')
          AND datetime(operation_deadline)<=CURRENT_TIMESTAMP
        OR state IN ('failed','completed')
          AND expires_at IS NOT NULL
          AND datetime(expires_at)<=CURRENT_TIMESTAMP
      )
      ORDER BY id
      LIMIT ?
    `).all(...PPT_SCOPES, batchSize);
    let recoveredRows = 0;
    for (const row of recoveryRows) {
      db.transaction(() => {
        idempotency.recoverExpiredInTransaction(db, {
          organizationId: row.org_id,
          actorUserId: row.user_id,
          campaignId: row.campaign_id,
          secondaryCampaignId: row.secondary_campaign_id,
          resourceClaim: row.resource_claim,
          scope: row.scope,
          key: row.idempotency_key,
          requestHash: row.request_hash,
          expectedEventCount: row.expected_event_count
        });
      }).immediate();
      recoveredRows += 1;
    }

    const retainedArtifacts = db.prepare(`
      SELECT
        id,request_hash,state,response_cache_key,response_sha256,response_bytes,
        response_content_type,response_filename
      FROM request_idempotency
      WHERE scope=? AND response_kind='binary'
        AND state IN ('completed','expiring')
      ORDER BY id
    `).all(PPT_LINKED_SCOPE);
    const liveRows = db.prepare(`
      SELECT org_id,user_id,scope,idempotency_key,lease_token
      FROM request_idempotency
      WHERE scope IN (?,?) AND state='processing'
        AND lease_token IS NOT NULL
        AND datetime(lease_until)>CURRENT_TIMESTAMP
        AND datetime(operation_deadline)>CURRENT_TIMESTAMP
      ORDER BY id
    `).all(...PPT_SCOPES);
    const liveCacheKeys = liveRows.map((row) => artifactCacheKey({
      organizationId: row.org_id,
      userId: row.user_id,
      scope: row.scope,
      idempotencyKey: row.idempotency_key
    }, {
      leaseToken: row.lease_token
    }));
    const completedCacheKeys = retainedArtifacts
      .filter((row) => row.state === 'completed')
      .map((row) => row.response_cache_key);
    const expiringRows = retainedArtifacts.filter((row) => row.state === 'expiring');

    let storeResult;
    try {
      storeResult = artifactStore.runJanitor({
        liveCacheKeys,
        retainedCacheKeys: completedCacheKeys,
        expiringCacheKeys: expiringRows.map((row) => row.response_cache_key),
        attemptRootDir: tempDir,
        orphanMinAgeMs: input.orphanMinAgeMs,
        nowMs: input.nowMs,
        maxScanEntries: input.maxScanEntries
      });
    } catch (error) {
      const mapped = mapArtifactError(error, false);
      if (mapped) throw mapped;
      throw error;
    }

    const rowsByCacheKey = new Map();
    for (const row of expiringRows) {
      const rows = rowsByCacheKey.get(row.response_cache_key) || [];
      rows.push(row);
      rowsByCacheKey.set(row.response_cache_key, rows);
    }
    let expiringRemoved = 0;
    let expiringMissing = 0;
    let expiringProtected = 0;
    for (const outcome of storeResult.expiring) {
      if (outcome.state === 'protected') {
        expiringProtected += 1;
        continue;
      }
      const matchingRows = rowsByCacheKey.get(outcome.cacheKey) || [];
      for (const row of matchingRows) {
        db.transaction(() => {
          idempotency.discardExpiredBinaryInTransaction(db, {
            ledgerId: row.id,
            requestHash: row.request_hash,
            responseCacheKey: row.response_cache_key,
            responseSha256: row.response_sha256,
            responseBytes: row.response_bytes,
            responseContentType: row.response_content_type,
            responseFilename: row.response_filename
          });
        }).immediate();
      }
      if (outcome.state === 'removed') expiringRemoved += matchingRows.length;
      if (outcome.state === 'missing') expiringMissing += matchingRows.length;
    }

    return Object.freeze({
      recoveredRows,
      expiringRemoved,
      expiringMissing,
      expiringProtected,
      orphanArtifactsRemoved: storeResult.orphanArtifactKeysRemoved.length,
      orphanStagesRemoved: storeResult.orphanStagesRemoved,
      orphanAttemptsRemoved: storeResult.orphanAttemptsRemoved,
      scanTruncated: storeResult.scanTruncated
    });
  }

  function generate(input) {
    const userId = positiveId(input && input.userId, 'user_id');
    const campaignId = positiveId(input && input.campaignId, 'campaign_id');
    const proposalId = positiveId(input && input.proposalId, 'proposal_id');
    const idempotencyKey = requireIdempotencyKey(input && input.idempotencyKey);
    const requestId = normalizeRequestId(input && input.requestId, idempotencyKey);
    const proposalContentSha256 = normalizeProposalDigest(input && input.proposalContentSha256);
    const outline = normalizePayload(input && input.outline);
    const initial = requireProposalContext(db, userId, campaignId, proposalId);
    const proposalVersion = requireMatchingProposalVersion(
      db,
      proposalId,
      proposalContentSha256,
      outline.value
    );
    const requestHashValue = requestHash({
      method: 'POST',
      path: '/api/proposal/generate-ppt',
      campaignId,
      kind: 'json',
      payload: {
        campaign_id: campaignId,
        proposal_id: proposalId,
        proposal_content_sha256: proposalContentSha256,
        outline: outline.value
      }
    });
    const reservationInput = {
      organizationId: initial.organizationId,
      actorUserId: userId,
      campaignId,
      secondaryCampaignId: null,
      resourceClaim: pptResourceClaim(
        initial.organizationId,
        campaignId,
        proposalId,
        proposalContentSha256
      ),
      scope: PPT_LINKED_SCOPE,
      key: idempotencyKey,
      requestHash: requestHashValue,
      expectedEventCount: 1,
      operationTimeoutSeconds: PPT_OPERATION_TIMEOUT_SECONDS
    };
    const normalizedInput = {
      userId,
      organizationId: initial.organizationId,
      campaignId,
      proposalId,
      requestId,
      idempotencyKey,
      scope: PPT_LINKED_SCOPE,
      proposalContentSha256,
      outline: outline.value,
      proposalVersion
    };
    const reservation = reserveOrReplay(normalizedInput, reservationInput);
    if (reservation.state === 'replay') {
      return materializeBinaryReplay(artifactStore, reservation);
    }

    let artifact;
    try {
      artifact = generateArtifact(normalizedInput, reservation);
    } catch (error) {
      failReservation(reservation, requestHashValue);
      if (error instanceof CampaignPptServiceError) throw error;
      throw serviceError(502, 'PPT_GENERATION_FAILED', 'PPT generation failed.');
    }

    const filename = `proposal-${proposalId}.pptx`;
    const headers = binaryHeaders(filename, artifact);
    let completed;
    try {
      completed = db.transaction(() => {
        const current = requireProposalContext(db, userId, campaignId, proposalId);
        const currentProposalVersion = requireMatchingProposalVersion(
          db,
          proposalId,
          proposalContentSha256,
          outline.value
        );
        if (currentProposalVersion.contentSha256 !== proposalVersion.contentSha256) {
          throw serviceError(409, 'PROPOSAL_CONTENT_CHANGED', 'The confirmed proposal version changed.');
        }
        assertNoActivePptLink(db, campaignId, proposalId);
        const pptLinkId = insertCampaignLink(db, {
          organizationId: current.organizationId,
          campaignId,
          userId,
          recordType: 'proposal',
          recordId: proposalId,
          relationType: 'ppt',
          bundleId: current.proposalLink.bundle_id,
          metadata: {
            proposal_content_sha256: proposalContentSha256,
            request_ledger_id: reservation.ledgerId
          }
        });
        archivePptKnowledge(db, {
          organizationId: current.organizationId,
          campaignId,
          userId,
          proposalId,
          proposalContentSha256,
          artifact,
        });
        insertPptEvent(db, {
          organizationId: current.organizationId,
          campaignId,
          userId,
          proposalId,
          pptLinkId,
          bundleId: current.proposalLink.bundle_id,
          requestId,
          auditFingerprint: reservation.auditFingerprint
        });
        db.prepare(`
          INSERT INTO activity_log (user_id,action,module,details,ip_address)
          VALUES (?,?,?,?,NULL)
        `).run(userId, 'generate_ppt', 'proposal', `Generated retained PPT for proposal ${proposalId}`);
        return idempotency.completeBinaryInTransaction(db, {
          ledgerId: reservation.ledgerId,
          requestHash: requestHashValue,
          leaseToken: reservation.leaseToken,
          statusCode: 200,
          responseCacheKey: artifact.cacheKey,
          responseSha256: artifact.sha256,
          responseBytes: artifact.bytes,
          responseContentType: PPT_CONTENT_TYPE,
          responseFilename: filename,
          responseHeaders: headers
        });
      }).immediate();
    } catch (error) {
      const artifactCleanup = reconcileUncommittedArtifact(artifact);
      failReservation(reservation, requestHashValue);
      if (artifactCleanup.state === 'unrecoverable') {
        throw serviceError(
          503,
          'PPT_ARTIFACT_UNAVAILABLE',
          'PPT artifact cleanup could not be reconciled safely.'
        );
      }
      if (error instanceof CampaignPptServiceError) throw error;
      if (error && Number.isSafeInteger(error.statusCode) && typeof error.code === 'string') {
        throw serviceError(error.statusCode, error.code, error.message, error.details);
      }
      throw serviceError(
        500,
        'AUDIT_PERSISTENCE_FAILED',
        'PPT generation outcome could not be recorded safely.'
      );
    }
    const result = materializeBinaryReplay(artifactStore, completed);
    return { ...result, replayed: false };
  }

  return Object.freeze({ generate, runArtifactJanitor });
}

module.exports = {
  CampaignPptServiceError,
  createCampaignPptService
};
