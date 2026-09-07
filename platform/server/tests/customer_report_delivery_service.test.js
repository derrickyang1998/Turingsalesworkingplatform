'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  CustomerReportDeliveryServiceError,
  createCustomerReportDeliveryService
} = require('../services/customer_report_delivery_service');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function customerReport() {
  return {
    contract_version: 'customer_safe_v1',
    redaction_policy_version: 'customer-safe-v1',
    recipient_profile: 'customer',
    status: 'sealed',
    title: 'September campaign review',
    selected_metric: 'views',
    evidence_snapshot_hash: sha256('evidence'),
    quality_disclosure: {
      evidence_mode: 'metadata_only',
      observed_content_count: 3,
      commercial_scope: 'withheld_pending_approved_scope'
    },
    lineage: { current_evidence_snapshot_hash: sha256('current-evidence') },
    actor: { type: 'authorized_campaign_operator' },
    sections: {
      project_overview: { campaign_name: 'September campaign', content_count: 3 },
      data_summary: { observed_metrics: { views: { status: 'available', value: 24000 } } },
      eligible_comparisons: { status: 'not_available', reason: 'coverage_not_sufficient' },
      key_indicators: { selected_metric: { key: 'views', status: 'available', value: 24000 } },
      excellent_cases: { status: 'available', cases: [{ reference: 'case-1' }] },
      data_limits_and_risks: { limitations: [{ code: 'metadata_only' }] },
      optimization_and_next_cycle: {
        optimization_actions: ['Keep the strongest opening structure.'],
        next_cycle_plan: 'Use the same observation window for the next campaign.'
      }
    }
  };
}

function fixturePptx(label) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`customer-report-ppt:${label}`, 'utf8')
  ]);
}

function createArtifactStore(rootDir) {
  const artifactDir = path.join(rootDir, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const records = new Map();
  function descriptor(cacheKey) {
    const value = records.get(cacheKey);
    if (!value) {
      const error = new Error('artifact missing');
      error.code = 'PPT_ARTIFACT_NOT_FOUND';
      throw error;
    }
    return value;
  }
  return {
    records,
    publishFromFile(input) {
      if (records.has(input.cacheKey)) {
        const error = new Error('artifact exists');
        error.code = 'PPT_ARTIFACT_EXISTS';
        throw error;
      }
      const bytes = fs.readFileSync(input.sourcePath);
      const filePath = path.join(artifactDir, `${input.cacheKey}.pptx`);
      fs.writeFileSync(filePath, bytes, { mode: 0o600 });
      const artifact = Object.freeze({
        cacheKey: input.cacheKey,
        filePath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length
      });
      records.set(input.cacheKey, artifact);
      return artifact;
    },
    readExisting(input) {
      return descriptor(input.cacheKey);
    },
    readVerified(input) {
      const artifact = descriptor(input.cacheKey);
      if (artifact.sha256 !== input.sha256 || artifact.bytes !== input.bytes) {
        const error = new Error('artifact integrity mismatch');
        error.code = 'PPT_ARTIFACT_INTEGRITY_FAILED';
        throw error;
      }
      return artifact;
    },
    remove(input) {
      const artifact = records.get(input.cacheKey);
      if (!artifact) return false;
      records.delete(input.cacheKey);
      try { fs.unlinkSync(artifact.filePath); } catch {}
      return true;
    },
    runJanitor() {
      return { orphanArtifactKeysRemoved: [], orphanStagesRemoved: 0, orphanAttemptsRemoved: 0, scanTruncated: false };
    }
  };
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-customer-report-ppt-'));
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customer_report_ppt_artifacts (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL,
      snapshot_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      report_contract_version TEXT NOT NULL,
      redaction_policy_version TEXT NOT NULL,
      ppt_contract_version TEXT NOT NULL,
      snapshot_report_sha256 TEXT NOT NULL,
      artifact_cache_key TEXT NOT NULL UNIQUE,
      artifact_sha256 TEXT NOT NULL,
      artifact_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id,campaign_id,snapshot_id,ppt_contract_version)
    ) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      details TEXT NOT NULL,
      ip_address TEXT
    ) STRICT;
  `);
  let report = customerReport();
  let authorizationFailureCall = null;
  const sourceCalls = [];
  const snapshotService = {
    getForDelivery(input) {
      sourceCalls.push(input);
      if (sourceCalls.length === authorizationFailureCall) {
        const error = new Error('customer report access changed');
        error.statusCode = 403;
        error.code = 'CUSTOMER_REPORT_FORBIDDEN';
        throw error;
      }
      if (!input.user || input.user.id !== 713) {
        const error = new Error('customer report access is forbidden');
        error.statusCode = 403;
        error.code = 'CUSTOMER_REPORT_FORBIDDEN';
        throw error;
      }
      return {
        context: { userId: 713, campaignId: 719, organizationId: 717 },
        snapshot: {
          id: 721,
          created_at: '2026-09-07 12:00:00',
          report_sha256: sha256(canonicalJson(report)),
          report
        }
      };
    }
  };
  const artifactStore = createArtifactStore(root);
  const renderedReports = [];
  const service = createCustomerReportDeliveryService(db, {
    snapshotService,
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator(input) {
      renderedReports.push(input.report);
      if (options.generatorFails) throw new Error('renderer failed');
      fs.writeFileSync(input.outputPath, fixturePptx(input.snapshotId), { mode: 0o600 });
    }
  });
  t.after(() => {
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    service,
    sourceCalls,
    artifactStore,
    renderedReports,
    setReport(value) { report = value; },
    failAuthorizationOnCall(callNumber) { authorizationFailureCall = callNumber; },
    request(overrides = {}) {
      return {
        user: { id: 713 },
        campaignId: 719,
        snapshotId: 721,
        requestId: 'customer-report-ppt-request-0001',
        ...overrides
      };
    }
  };
}

test('generates one retained customer-report PPT and replays the same immutable artifact', (t) => {
  const fixture = createFixture(t);
  const first = fixture.service.generate(fixture.request());
  const replay = fixture.service.generate(fixture.request({ requestId: 'customer-report-ppt-request-0002' }));

  assert.equal(first.status, 200);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.filePath, replay.filePath);
  assert.equal(first.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.match(first.headers['Content-Disposition'], /customer-report-721\.pptx/);
  assert.equal(fixture.renderedReports.length, 1);
  // The stored result is re-authorized before the append-only artifact row is written.
  assert.equal(fixture.sourceCalls.length, 3);
  assert.equal(JSON.stringify(fixture.renderedReports[0]).includes('https://'), false);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM customer_report_ppt_artifacts').get().count,
    1
  );
  const record = fixture.db.prepare(`
    SELECT org_id,campaign_id,snapshot_id,created_by,ppt_contract_version,snapshot_report_sha256
    FROM customer_report_ppt_artifacts
  `).get();
  assert.deepEqual(record, {
    org_id: 717,
    campaign_id: 719,
    snapshot_id: 721,
    created_by: 713,
    ppt_contract_version: 'customer-report-ppt-v1',
    snapshot_report_sha256: sha256(canonicalJson(fixture.renderedReports[0]))
  });
  assert.equal(
    fixture.db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='generate_customer_report_ppt'").get().count,
    1
  );
});

test('does not classify structural report hashes as customer-visible phone content', (t) => {
  const fixture = createFixture(t);
  const report = customerReport();
  report.evidence_snapshot_hash = '1'.repeat(64);
  report.lineage.current_evidence_snapshot_hash = '2'.repeat(64);
  fixture.setReport(report);

  const result = fixture.service.generate(fixture.request());

  assert.equal(result.status, 200);
  assert.equal(fixture.renderedReports.length, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM customer_report_ppt_artifacts').get().count,
    1
  );
});

test('rejects a non-customer-safe sealed source before rendering or persisting a PPT artifact', (t) => {
  const fixture = createFixture(t);
  const unsafe = customerReport();
  unsafe.sections.optimization_and_next_cycle.next_cycle_plan = 'Use https://internal.example for the private plan.';
  fixture.setReport(unsafe);

  assert.throws(
    () => fixture.service.generate(fixture.request()),
    (error) => error instanceof CustomerReportDeliveryServiceError &&
      error.code === 'CUSTOMER_REPORT_PPT_SOURCE_INVALID'
  );
  assert.equal(fixture.renderedReports.length, 0);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM customer_report_ppt_artifacts').get().count,
    0
  );

  const bareDomain = customerReport();
  bareDomain.sections.optimization_and_next_cycle.next_cycle_plan = 'Review reports.example/path before sharing.';
  fixture.setReport(bareDomain);
  assert.throws(
    () => fixture.service.generate(fixture.request()),
    (error) => error instanceof CustomerReportDeliveryServiceError &&
      error.code === 'CUSTOMER_REPORT_PPT_SOURCE_INVALID'
  );
});

test('does not persist an artifact when the dedicated customer-report renderer fails', (t) => {
  const fixture = createFixture(t, { generatorFails: true });
  assert.throws(
    () => fixture.service.generate(fixture.request()),
    (error) => error instanceof CustomerReportDeliveryServiceError &&
      error.code === 'CUSTOMER_REPORT_PPT_GENERATION_FAILED'
  );
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM customer_report_ppt_artifacts').get().count,
    0
  );
  assert.equal(fixture.artifactStore.records.size, 0);
});

test('does not delete a retained artifact adopted by another request before reauthorization fails', (t) => {
  const fixture = createFixture(t);
  const publish = fixture.artifactStore.publishFromFile.bind(fixture.artifactStore);
  fixture.artifactStore.publishFromFile = (input) => {
    const artifact = publish(input);
    fixture.db.prepare(`
      INSERT INTO customer_report_ppt_artifacts (
        org_id,campaign_id,snapshot_id,created_by,report_contract_version,
        redaction_policy_version,ppt_contract_version,snapshot_report_sha256,
        artifact_cache_key,artifact_sha256,artifact_bytes
      ) VALUES (717,719,721,713,'customer_safe_v1','customer-safe-v1',
        'customer-report-ppt-v1',?,?,?,?)
    `).run(
      sha256(canonicalJson(fixture.renderedReports[0])),
      artifact.cacheKey,
      artifact.sha256,
      artifact.bytes
    );
    return artifact;
  };
  fixture.failAuthorizationOnCall(2);

  assert.throws(
    () => fixture.service.generate(fixture.request()),
    (error) => error instanceof CustomerReportDeliveryServiceError &&
      error.code === 'CUSTOMER_REPORT_PPT_AUDIT_FAILED'
  );
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM customer_report_ppt_artifacts').get().count,
    1
  );
  assert.equal(fixture.artifactStore.records.size, 1);
});
