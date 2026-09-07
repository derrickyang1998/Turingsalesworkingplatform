'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PptArtifactStoreError } = require('./ppt_artifact_store');

const CUSTOMER_REPORT_PPT_CONTRACT_VERSION = 'customer-report-ppt-v1';
const CUSTOMER_REPORT_CONTRACT_VERSION = 'customer_safe_v1';
const CUSTOMER_REPORT_REDACTION_POLICY_VERSION = 'customer-safe-v1';
const PPT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const REQUIRED_SECTION_KEYS = Object.freeze([
  'project_overview',
  'data_summary',
  'eligible_comparisons',
  'key_indicators',
  'excellent_cases',
  'data_limits_and_risks',
  'optimization_and_next_cycle'
]);
const UNSAFE_REPORT_TEXT = Object.freeze([
  /(?:https?|ftp):\/\//i,
  /\bwww\./i,
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?(?:[/?#][^\s]*)?/i,
  /\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:[/?#][^\s]*)?/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+?\d[\d\s().-]{6,}\d)/,
  /[$€£¥]/,
  /\b(?:USD|CNY|RMB|EUR|GBP|JPY|AUD|CAD)\s*\d/i,
  /\b\d+(?:\.\d+)?\s*(?:USD|CNY|RMB|EUR|GBP|JPY|AUD|CAD)\b/i,
  /\d+(?:\.\d+)?\s*(?:元|块|人民币|美元|美金|欧元|英镑|日元|万|千)/i,
  /[零〇○一二两三四五六七八九十百千万亿兆壹贰叁肆伍陆柒捌玖拾佰仟萬億兆]+(?:[点\.][零〇○一二两三四五六七八九十百千万亿兆壹贰叁肆伍陆柒捌玖拾佰仟萬億兆]+)?\s*(?:元|圓|块|人民币|美元|美金|欧元|英镑|日元|港币|台币)/,
  /\b(?:CPM|CPC|CPE|CPI|CPS|CPV|ROI|ROAS|GMV|CTR|CVR|revenue|sales|cost|spend|budget|attributed[_\s-]?revenue)\b/i,
  /(?:花费|成本|预算|费用|报价|成交价|成交金额|成交额|交易额|售价|定价|单价|回款|利润|佣金|投放|收入|销售额|营收|转化金额|千次展示成本|单次点击成本|商业机密|机密|保密|内部|仅限内部)/,
  /\b(?:confidential|internal(?:\s+only)?|private)\b/i
]);

class CustomerReportDeliveryServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'CustomerReportDeliveryServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new CustomerReportDeliveryServiceError(statusCode, code, message, details);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveId(value, field) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && String(parsed) === value) return parsed;
  }
  throw serviceError(400, 'CUSTOMER_REPORT_PPT_INPUT_INVALID', `${field} is invalid.`, { field });
}

function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not permit non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  throw new TypeError('Canonical JSON contains an unsupported value.');
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function customerVisibleStrings(report) {
  const values = [];
  const collect = (value) => {
    if (typeof value === 'string') {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (plainObject(value)) Object.values(value).forEach(collect);
  };
  collect(report && report.title);
  collect(report && report.sections);
  return values;
}

function hasUnsafeCustomerVisibleText(report) {
  return customerVisibleStrings(report).some((value) => (
    UNSAFE_REPORT_TEXT.some((pattern) => pattern.test(value))
  ));
}

function artifactCacheKey(context, snapshot) {
  return crypto.createHash('sha256').update([
    'tm-customer-report-ppt-artifact-v1',
    String(context.organizationId),
    String(context.campaignId),
    String(snapshot.id),
    snapshot.report_sha256
  ].join('\n'), 'utf8').digest('hex');
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
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${rfc5987Filename(filename)}`,
    'Content-Length': String(artifact.bytes),
    ETag: `"${artifact.sha256}"`,
    'Cache-Control': 'private, max-age=0, no-store'
  };
}

function closeVerificationDescriptor(artifact) {
  if (!artifact || !Number.isInteger(artifact.fd) || artifact.fd < 0) return;
  try { fs.closeSync(artifact.fd); } catch {}
}

function ensurePrivateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw serviceError(503, 'CUSTOMER_REPORT_PPT_WORKSPACE_UNAVAILABLE', 'Customer report PPT workspace is unavailable.');
  }
}

function createWorkDirectory(tempDir, cacheKey) {
  ensurePrivateDirectory(tempDir);
  return fs.mkdtempSync(path.join(tempDir, `customer-report-ppt-${cacheKey.slice(0, 16)}-`));
}

function mapArtifactError(error, replay) {
  if (!(error instanceof PptArtifactStoreError) && !(error && /^PPT_ARTIFACT_/.test(error.code || ''))) {
    return null;
  }
  if (replay) {
    return serviceError(
      503,
      'CUSTOMER_REPORT_PPT_ARTIFACT_UNAVAILABLE',
      'The retained customer report PPT cannot be verified for download.'
    );
  }
  if (error && error.code === 'PPT_ARTIFACT_INVALID') {
    return serviceError(502, 'CUSTOMER_REPORT_PPT_GENERATION_FAILED', 'Customer report PPT output is invalid.');
  }
  return serviceError(
    503,
    'CUSTOMER_REPORT_PPT_ARTIFACT_UNAVAILABLE',
    'Customer report PPT artifact storage is unavailable.'
  );
}

function assertSnapshotSource(delivery) {
  const context = delivery && delivery.context;
  const snapshot = delivery && delivery.snapshot;
  if (!context || !snapshot) {
    throw serviceError(409, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'The customer report snapshot cannot be delivered.');
  }
  const organizationId = positiveId(context.organizationId, 'organization_id');
  const campaignId = positiveId(context.campaignId, 'campaign_id');
  const userId = positiveId(context.userId, 'user_id');
  const snapshotId = positiveId(snapshot.id, 'snapshot_id');
  const report = snapshot.report;
  if (!validHash(snapshot.report_sha256) || !plainObject(report)) {
    throw serviceError(409, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'The customer report snapshot identity is invalid.');
  }
  if (
    report.contract_version !== CUSTOMER_REPORT_CONTRACT_VERSION ||
    report.redaction_policy_version !== CUSTOMER_REPORT_REDACTION_POLICY_VERSION ||
    report.recipient_profile !== 'customer' ||
    report.status !== 'sealed' ||
    !plainObject(report.sections) ||
    REQUIRED_SECTION_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(report.sections, key))
  ) {
    throw serviceError(409, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'The customer report snapshot contract is invalid.');
  }
  let serialized;
  let reportHash;
  try {
    serialized = JSON.stringify(report);
    reportHash = canonicalHash(report);
  } catch (_error) {
    throw serviceError(409, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'The customer report snapshot cannot be verified.');
  }
  if (serialized.length > 524288 || reportHash !== snapshot.report_sha256 || hasUnsafeCustomerVisibleText(report)) {
    throw serviceError(409, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'The customer report snapshot is outside the delivery scope.');
  }
  return Object.freeze({
    context: Object.freeze({ organizationId, campaignId, userId }),
    snapshot: Object.freeze({
      id: snapshotId,
      report_sha256: snapshot.report_sha256,
      report
    })
  });
}

function createCustomerReportDeliveryService(db, options) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Customer report delivery service options are required.');
  }
  if (!options.snapshotService || typeof options.snapshotService.getForDelivery !== 'function') {
    throw new TypeError('A customer report snapshot service with delivery access is required.');
  }
  if (!options.artifactStore ||
    typeof options.artifactStore.publishFromFile !== 'function' ||
    typeof options.artifactStore.readVerified !== 'function' ||
    typeof options.artifactStore.readExisting !== 'function' ||
    typeof options.artifactStore.remove !== 'function' ||
    typeof options.artifactStore.runJanitor !== 'function') {
    throw new TypeError('A customer report PPT artifact store is required.');
  }
  if (typeof options.tempDir !== 'string' || !path.isAbsolute(options.tempDir)) {
    throw new TypeError('Customer report PPT tempDir must be absolute.');
  }
  if (typeof options.runPptGenerator !== 'function') {
    throw new TypeError('Customer report PPT runPptGenerator is required.');
  }

  const snapshotService = options.snapshotService;
  const artifactStore = options.artifactStore;
  const tempDir = path.resolve(options.tempDir);
  const runPptGenerator = options.runPptGenerator;

  function deliverySource(input) {
    const campaignId = positiveId(input && input.campaignId, 'campaign_id');
    const snapshotId = positiveId(input && input.snapshotId, 'snapshot_id');
    const user = input && input.user;
    if (!user || positiveId(user.id, 'user_id') < 1) {
      throw serviceError(401, 'CUSTOMER_REPORT_PPT_UNAUTHORIZED', 'An authenticated user is required.');
    }
    let delivery;
    try {
      delivery = snapshotService.getForDelivery({ user, campaignId, snapshotId });
    } catch (error) {
      if (error && error.name === 'CustomerReportSnapshotServiceError') throw error;
      if (error && Number.isSafeInteger(error.statusCode) && typeof error.code === 'string') throw error;
      throw serviceError(500, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'Customer report delivery authorization could not be verified.');
    }
    const source = assertSnapshotSource(delivery);
    if (source.context.campaignId !== campaignId || source.snapshot.id !== snapshotId) {
      throw serviceError(409, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'Customer report delivery scope is invalid.');
    }
    return source;
  }

  function findArtifact(context, snapshotId) {
    return db.prepare(`
      SELECT id,org_id,campaign_id,snapshot_id,created_by,report_contract_version,
        redaction_policy_version,ppt_contract_version,snapshot_report_sha256,
        artifact_cache_key,artifact_sha256,artifact_bytes,created_at
      FROM customer_report_ppt_artifacts
      WHERE org_id=? AND campaign_id=? AND snapshot_id=? AND ppt_contract_version=?
      LIMIT 1
    `).get(
      context.organizationId,
      context.campaignId,
      snapshotId,
      CUSTOMER_REPORT_PPT_CONTRACT_VERSION
    );
  }

  function materializeArtifact(row) {
    if (!row ||
      row.report_contract_version !== CUSTOMER_REPORT_CONTRACT_VERSION ||
      row.redaction_policy_version !== CUSTOMER_REPORT_REDACTION_POLICY_VERSION ||
      row.ppt_contract_version !== CUSTOMER_REPORT_PPT_CONTRACT_VERSION ||
      !validHash(row.snapshot_report_sha256) || !validHash(row.artifact_cache_key) ||
      !validHash(row.artifact_sha256) || !Number.isSafeInteger(row.artifact_bytes) || row.artifact_bytes < 4
    ) {
      throw serviceError(500, 'CUSTOMER_REPORT_PPT_ARTIFACT_INVALID', 'Customer report PPT artifact evidence is invalid.');
    }
    let artifact;
    try {
      artifact = artifactStore.readVerified({
        cacheKey: row.artifact_cache_key,
        sha256: row.artifact_sha256,
        bytes: row.artifact_bytes
      });
      return {
        status: 200,
        headers: binaryHeaders(`customer-report-${row.snapshot_id}.pptx`, artifact),
        filePath: artifact.filePath,
        replayed: true
      };
    } catch (error) {
      const mapped = mapArtifactError(error, true);
      if (mapped) throw mapped;
      throw serviceError(500, 'CUSTOMER_REPORT_PPT_ARTIFACT_INVALID', 'Customer report PPT artifact verification failed.');
    } finally {
      closeVerificationDescriptor(artifact);
    }
  }

  function generateArtifact(source) {
    const cacheKey = artifactCacheKey(source.context, source.snapshot);
    const workDir = createWorkDirectory(tempDir, cacheKey);
    const outputPath = path.join(workDir, 'customer-report.pptx');
    try {
      try {
        const generatorResult = runPptGenerator({
          report: source.snapshot.report,
          outputPath,
          campaignId: source.context.campaignId,
          snapshotId: source.snapshot.id
        });
        if (generatorResult && typeof generatorResult.then === 'function') {
          throw new Error('asynchronous renderer is not supported');
        }
      } catch (_error) {
        throw serviceError(502, 'CUSTOMER_REPORT_PPT_GENERATION_FAILED', 'Customer report PPT generation failed.');
      }
      try {
        return Object.assign({ publishedByThisAttempt: true }, artifactStore.publishFromFile({ cacheKey, sourcePath: outputPath }));
      } catch (error) {
        if (error && error.code === 'PPT_ARTIFACT_EXISTS') {
          try {
            return Object.assign({ publishedByThisAttempt: false }, artifactStore.readExisting({ cacheKey }));
          } catch (existingError) {
            const mappedExisting = mapArtifactError(existingError, false);
            if (mappedExisting) throw mappedExisting;
            throw serviceError(503, 'CUSTOMER_REPORT_PPT_ARTIFACT_UNAVAILABLE', 'Existing customer report PPT cannot be verified.');
          }
        }
        const mapped = mapArtifactError(error, false);
        if (mapped) throw mapped;
        throw serviceError(503, 'CUSTOMER_REPORT_PPT_ARTIFACT_UNAVAILABLE', 'Customer report PPT cannot be retained.');
      }
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  function cleanupUncommittedArtifact(artifact) {
    if (!artifact || artifact.publishedByThisAttempt !== true) return;
    try {
      const retained = db.prepare(`
        SELECT 1 AS retained
        FROM customer_report_ppt_artifacts
        WHERE artifact_cache_key=?
        LIMIT 1
      `).get(artifact.cacheKey);
      if (retained) return;
    } catch (_error) {
      return;
    }
    try { artifactStore.remove({ cacheKey: artifact.cacheKey }); } catch {}
  }

  function generate(input) {
    const source = deliverySource(input);
    const existing = findArtifact(source.context, source.snapshot.id);
    if (existing) {
      if (existing.snapshot_report_sha256 !== source.snapshot.report_sha256) {
        throw serviceError(409, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'The retained PPT is bound to a different customer report snapshot.');
      }
      return materializeArtifact(existing);
    }

    const artifact = generateArtifact(source);
    let stored;
    try {
      stored = db.transaction(() => {
        const current = deliverySource(input);
        if (
          current.context.organizationId !== source.context.organizationId ||
          current.context.campaignId !== source.context.campaignId ||
          current.snapshot.id !== source.snapshot.id ||
          current.snapshot.report_sha256 !== source.snapshot.report_sha256
        ) {
          throw serviceError(409, 'CUSTOMER_REPORT_PPT_SOURCE_INVALID', 'The customer report snapshot changed before delivery was recorded.');
        }
        const alreadyStored = findArtifact(current.context, current.snapshot.id);
        if (alreadyStored) return alreadyStored;
        const result = db.prepare(`
          INSERT INTO customer_report_ppt_artifacts (
            org_id,campaign_id,snapshot_id,created_by,report_contract_version,
            redaction_policy_version,ppt_contract_version,snapshot_report_sha256,
            artifact_cache_key,artifact_sha256,artifact_bytes
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          current.context.organizationId,
          current.context.campaignId,
          current.snapshot.id,
          current.context.userId,
          CUSTOMER_REPORT_CONTRACT_VERSION,
          CUSTOMER_REPORT_REDACTION_POLICY_VERSION,
          CUSTOMER_REPORT_PPT_CONTRACT_VERSION,
          current.snapshot.report_sha256,
          artifact.cacheKey,
          artifact.sha256,
          artifact.bytes
        );
        db.prepare(`
          INSERT INTO activity_log (user_id,action,module,details,ip_address)
          VALUES (?,?,?,?,NULL)
        `).run(
          current.context.userId,
          'generate_customer_report_ppt',
          'performance',
          `Generated retained customer report PPT for snapshot ${current.snapshot.id}`
        );
        return db.prepare(`
          SELECT id,org_id,campaign_id,snapshot_id,created_by,report_contract_version,
            redaction_policy_version,ppt_contract_version,snapshot_report_sha256,
            artifact_cache_key,artifact_sha256,artifact_bytes,created_at
          FROM customer_report_ppt_artifacts
          WHERE id=?
        `).get(result.lastInsertRowid);
      }).immediate();
    } catch (error) {
      if (error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const replay = findArtifact(source.context, source.snapshot.id);
        if (replay && replay.snapshot_report_sha256 === source.snapshot.report_sha256) {
          return materializeArtifact(replay);
        }
      }
      cleanupUncommittedArtifact(artifact);
      if (error instanceof CustomerReportDeliveryServiceError) throw error;
      if (error && error.name === 'CustomerReportSnapshotServiceError') throw error;
      throw serviceError(500, 'CUSTOMER_REPORT_PPT_AUDIT_FAILED', 'Customer report PPT delivery could not be recorded.');
    }
    const result = materializeArtifact(stored);
    return Object.assign({}, result, { replayed: stored.artifact_cache_key !== artifact.cacheKey ? true : false });
  }

  function runArtifactJanitor(input = {}) {
    const retainedCacheKeys = db.prepare(`
      SELECT artifact_cache_key
      FROM customer_report_ppt_artifacts
      WHERE ppt_contract_version=?
      ORDER BY id
    `).all(CUSTOMER_REPORT_PPT_CONTRACT_VERSION).map((row) => row.artifact_cache_key);
    return artifactStore.runJanitor({
      liveCacheKeys: [],
      retainedCacheKeys,
      expiringCacheKeys: [],
      attemptRootDir: tempDir,
      orphanMinAgeMs: input.orphanMinAgeMs,
      nowMs: input.nowMs,
      maxScanEntries: input.maxScanEntries
    });
  }

  return Object.freeze({ generate, runArtifactJanitor });
}

module.exports = {
  CUSTOMER_REPORT_PPT_CONTRACT_VERSION,
  CustomerReportDeliveryServiceError,
  createCustomerReportDeliveryService
};
