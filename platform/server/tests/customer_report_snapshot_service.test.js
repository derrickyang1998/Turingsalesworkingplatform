'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledge = require('../services/knowledge_service');
const {
  buildPerformanceReviewEvidenceSnapshot
} = require('../services/performance_manual_service');
const {
  CustomerReportSnapshotServiceError,
  createCustomerReportSnapshotService
} = require('../services/customer_report_snapshot_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATION_NAMES = Object.freeze([
  '002_campaign_business_spine',
  '003_campaign_workflow_dispatch_evidence',
  '004_knowledge_capacity_observability',
  '005_knowledge_custody_projection',
  '006_crm_sales_workspace',
  '007_knowledge_governance',
  '008_feishu_bitable_outbox',
  '009_feishu_bitable_retry_lineage',
  '010_performance_manual_foundation',
  '011_performance_feishu_connection_config',
  '012_performance_ai_review_audit',
  '013_customer_report_snapshot'
]);
const MIGRATIONS = Object.freeze(MIGRATION_NAMES.map((name, index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/${name}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function metric(value, available = true) {
  return { value, available };
}

function reviewEvidence(campaignId, overrides = {}) {
  const top = {
    rank: 1,
    content: {
      id: 901,
      original_url: 'https://private.example/video-901',
      canonical_url: 'https://private.example/video-901',
      platform: 'Instagram',
      creator_id: 'private-creator-901',
      creator_name: 'Private Creator',
      product: 'Launch product',
      tags: ['private-tag']
    },
    metric: { metric: 'views', value: 12000, available: true },
    evidence: {
      latest_observation: {
        id: 1901,
        observed_at: '2026-09-04T09:00:00.000Z',
        source_mode: 'manual'
      }
    }
  };
  const bottom = {
    rank: 1,
    content: {
      id: 902,
      original_url: 'https://private.example/video-902',
      canonical_url: 'https://private.example/video-902',
      platform: 'YouTube',
      creator_id: 'private-creator-902',
      creator_name: 'Another Private Creator',
      product: 'Launch product',
      tags: ['private-tag']
    },
    metric: { metric: 'views', value: 4000, available: true },
    evidence: {
      latest_observation: {
        id: 1902,
        observed_at: '2026-09-04T10:00:00.000Z',
        source_mode: 'manual'
      }
    }
  };
  return Object.assign({
    contract_version: 'performance-review-evidence-v1',
    campaign_id: campaignId,
    scope: {
      type: 'campaign_current_snapshot',
      selected_metric: 'views',
      observation_selector: 'observed_at_desc_id_desc',
      commercial_selector: 'created_at_desc_id_desc'
    },
    records: {
      total: 3,
      active_with_observations: 3,
      confirmed_commercial: 3
    },
    totals: {
      views: metric(24000),
      likes: metric(960),
      comments: metric(120),
      saves: metric(240),
      shares: metric(80),
      clicks: metric(600),
      attributed_revenue: metric(999999)
    },
    metrics: {
      observed_engagement_total: metric(1400),
      core_view_er: metric(0.058333333333333334),
      roi: metric(9.9),
      roas: metric(8.8)
    },
    rankings: {
      status: 'available',
      metric: 'views',
      comparable_records: 3,
      missing_records: 0,
      eligibility: {
        eligible: true,
        minimum_coverage: 0.8,
        coverage: 1,
        comparable_records: 3,
        total_records: 3,
        missing_records: 0,
        reason: null
      },
      top_contents: [top],
      bottom_contents: [bottom]
    },
    breakdowns: {
      platforms: [
        {
          key: 'Instagram',
          label: 'Instagram',
          content_count: 2,
          observed_content_count: 2,
          latest_observed_at: '2026-09-04T10:00:00.000Z',
          metric: {
            metric: 'views', aggregation: 'sum', available: true, value: 18000,
            coverage: 1, available_records: 2, total_records: 2, reason: null
          }
        }
      ],
      products: [
        {
          key: 'Launch product',
          label: 'Launch product',
          content_count: 3,
          observed_content_count: 3,
          latest_observed_at: '2026-09-04T10:00:00.000Z',
          metric: {
            metric: 'views', aggregation: 'sum', available: true, value: 24000,
            coverage: 1, available_records: 3, total_records: 3, reason: null
          }
        }
      ],
      creators: [
        {
          key: 'Private Creator',
          label: 'Private Creator',
          content_count: 1,
          observed_content_count: 1,
          latest_observed_at: '2026-09-04T09:00:00.000Z',
          metric: {
            metric: 'views', aggregation: 'sum', available: true, value: 12000,
            coverage: 1, available_records: 1, total_records: 1, reason: null
          }
        }
      ]
    },
    data_quality: {
      metric_coverage: [
        { metric: 'views', available_records: 3, total_records: 3, coverage: 1 },
        { metric: 'likes', available_records: 3, total_records: 3, coverage: 1 }
      ],
      source_mode_counts: { manual: 3 },
      observation_window: {
        min_observed_at: '2026-09-04T09:00:00.000Z',
        max_observed_at: '2026-09-04T10:00:00.000Z',
        freshness_policy: 'not_configured'
      }
    },
    analysis: {
      mode: 'metadata_only',
      media_evidence: { status: 'not_collected', reason: 'authorized_media_access_required' },
      external_collection: { status: 'not_connected', reason: 'provider_not_enabled' },
      causal_diagnosis: { status: 'not_available', reason: 'media_evidence_not_collected' },
      human_confirmation: { required: true, status: 'confirmed' }
    },
    limitations: [
      { code: 'metadata_only', detail: 'Internal diagnostic text must never reach the customer report.' },
      { code: 'commercial_metrics_restricted', detail: 'attributed_revenue and ROI are internal only.' }
    ]
  }, overrides);
}

function createFixture(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
  const members = db.prepare(`
    SELECT membership.org_id AS orgId,membership.user_id AS userId,team_membership.team_id AS teamId
    FROM organization_memberships membership
    JOIN team_memberships team_membership
      ON team_membership.org_id=membership.org_id
     AND team_membership.user_id=membership.user_id
     AND team_membership.status='active'
    WHERE membership.status='active'
    ORDER BY membership.org_id,membership.user_id
    LIMIT 2
  `).all();
  assert.equal(members.length, 2, 'fixture requires two active organization members');
  const owner = members[0];
  const reader = members[1];
  const campaign = {
    orgId: owner.orgId,
    id: 991003,
    customerId: 991001,
    opportunityId: 991002,
    ownerUserId: owner.userId,
    teamId: owner.teamId,
    name: 'September performance review'
  };
  db.prepare(`
    INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to,is_public)
    VALUES (@customerId,'Snapshot brand','Snapshot brand Ltd','qualified','snapshot-service',@ownerUserId,@ownerUserId,0)
  `).run(campaign);
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by)
    VALUES (@opportunityId,@customerId,'Snapshot opportunity','proposal',1000,50,'Launch product','influencer',@ownerUserId)
  `).run(campaign);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,lifecycle_state,operational_status,row_version
    ) VALUES (
      @id,@orgId,@name,@customerId,@opportunityId,@ownerUserId,@teamId,'lead','active',1
    )
  `).run(campaign);

  let currentEvidence = reviewEvidence(campaign.id);
  const canonical = buildPerformanceReviewEvidenceSnapshot(currentEvidence);
  const reviewContent = 'Confirmed internal AI review: https://private.example/internal-note';
  const sourceContentHash = options.sourceContentHash || sha256(reviewContent);
  let written;
  db.transaction(() => {
    written = knowledge.ingestBusinessArtifact(db, {
      artifactType: 'performance_review_confirmation',
      artifactState: 'confirmed',
      organizationId: campaign.orgId,
      campaignId: campaign.id,
      createdBy: campaign.ownerUserId,
      sourceId: `${campaign.id}:991004`,
      title: 'Confirmed performance review',
      summary: 'Internal review summary',
      content: reviewContent,
      tags: ['performance'],
      visibility: 'team',
      metadata: {
        source_ai: {
          conversation_id: 991005,
          message_id: 991006,
          draft_sha256: sha256(reviewContent),
          draft_contract_version: 'performance-ai-review-draft-v1'
        },
        evidence: {
          snapshot_hash: canonical.snapshotHash,
          selected_metric: 'views',
          citation_ids: ['PERF-901', 'PERF-902']
        },
        confirmation: {
          approved_by: campaign.ownerUserId,
          approved_at: '2026-09-04T11:00:00.000Z',
          final_content_sha256: sourceContentHash,
          request_id: 'approved-review-request',
          idempotency_key: 'approved-review-key-0001',
          contract_version: 'performance-ai-review-approval-v1'
        }
      }
    });
    db.prepare(`
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      campaign.orgId,
      campaign.id,
      'knowledge_entry',
      sha256('snapshot-custody-link'),
      String(written.entry.id),
      'knowledge',
      campaign.ownerUserId,
      JSON.stringify({ source: 'performance_ai_review_confirmation' })
    );
    knowledge.applyKnowledgeCapacityGaugePlanInTransaction(db, written.capacityGaugePlan);
  }).immediate();
  assert.equal(written.status, 'created');

  function getCampaignAccess(_database, input) {
    if (Number(input.campaignId) !== campaign.id) {
      return { ok: false, status: 404, code: 'CAMPAIGN_NOT_FOUND' };
    }
    const userId = Number(input.userId);
    if (userId !== owner.userId && userId !== reader.userId) {
      return { ok: false, status: 403, code: 'CAMPAIGN_FORBIDDEN' };
    }
    const privileged = userId === owner.userId;
    return {
      ok: true,
      role: privileged ? 'owner' : 'team_member',
      campaign: { id: campaign.id, org_id: campaign.orgId, name: campaign.name },
      permissions: { read: true, write: privileged }
    };
  }

  const performanceService = {
    getReviewEvidence(input) {
      assert.equal(Number(input.campaignId), campaign.id);
      assert.equal(input.query.top_metric, 'views');
      return deepClone(currentEvidence);
    }
  };
  const snapshots = createCustomerReportSnapshotService(db, {
    performanceService,
    getCampaignAccess
  });
  const baseInput = {
    user: { id: owner.userId },
    campaignId: campaign.id,
    body: {
      top_metric: 'views',
      title: 'September performance review',
      optimization_actions: ['Keep the strongest opening structure in the next content set.'],
      next_cycle_plan: 'Recheck the same observed metrics at a consistent observation point.'
    }
  };

  return {
    db,
    owner: { id: owner.userId },
    reader: { id: reader.userId },
    campaign,
    sourceEntryId: Number(written.entry.id),
    snapshots,
    currentEvidence: () => currentEvidence,
    setCurrentEvidence(value) { currentEvidence = value; },
    baseInput
  };
}

function previewInput(fixture) {
  return {
    user: fixture.owner,
    campaignId: fixture.campaign.id,
    body: deepClone(fixture.baseInput.body)
  };
}

function sealInput(fixture, overrides = {}) {
  const preview = fixture.snapshots.preview(previewInput(fixture));
  return Object.assign({
    ...previewInput(fixture),
    body: Object.assign({}, fixture.baseInput.body, {
      expected_evidence_snapshot_hash: preview.evidence_snapshot_hash
    }),
    idempotencyKey: 'customer-report-key-0001',
    requestId: 'customer-report-request-0001'
  }, overrides);
}

test('creates a pre-redacted customer-safe preview from confirmed current evidence', () => {
  const fixture = createFixture();
  try {
    const preview = fixture.snapshots.preview(previewInput(fixture));
    const serialized = JSON.stringify(preview);

    assert.equal(preview.contract_version, 'customer_safe_v1');
    assert.equal(preview.redaction_policy_version, 'customer-safe-v1');
    assert.deepEqual(Object.keys(preview.sections), [
      'project_overview',
      'data_summary',
      'eligible_comparisons',
      'key_indicators',
      'excellent_cases',
      'data_limits_and_risks',
      'optimization_and_next_cycle'
    ]);
    assert.equal(preview.sections.key_indicators.commercial.status, 'withheld_pending_approved_scope');
    assert.equal(preview.sections.excellent_cases.cases[0].reference, 'case-1');
    assert.equal(preview.sections.excellent_cases.cases[0].content_id, undefined);
    assert.equal(preview.sections.excellent_cases.cases[0].creator_name, undefined);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('Private Creator'), false);
    assert.equal(serialized.includes('attributed_revenue'), false);
    assert.equal(serialized.includes('999999'), false);
    assert.equal(serialized.includes('internal-note'), false);
    assert.equal(serialized.includes('ROI'), false);
  } finally {
    fixture.db.close();
  }
});

test('requires owner or organization-admin write access for customer report preview and seal', () => {
  const fixture = createFixture();
  try {
    const readerInput = previewInput(fixture);
    readerInput.user = fixture.reader;
    assert.throws(
      () => fixture.snapshots.preview(readerInput),
      (error) => error instanceof CustomerReportSnapshotServiceError && error.code === 'CUSTOMER_REPORT_FORBIDDEN'
    );
    const readerSeal = sealInput(fixture);
    readerSeal.user = fixture.reader;
    assert.throws(
      () => fixture.snapshots.seal(readerSeal),
      (error) => error instanceof CustomerReportSnapshotServiceError && error.code === 'CUSTOMER_REPORT_FORBIDDEN'
    );
    assert.deepEqual(
      fixture.snapshots.list({ userId: fixture.reader.id, campaignId: fixture.campaign.id }).snapshots,
      []
    );
  } finally {
    fixture.db.close();
  }
});

test('rejects stale evidence before sealing a customer report', () => {
  const fixture = createFixture();
  try {
    const input = sealInput(fixture);
    const changed = deepClone(fixture.currentEvidence());
    changed.records.total += 1;
    fixture.setCurrentEvidence(changed);
    assert.throws(
      () => fixture.snapshots.seal(input),
      (error) => error instanceof CustomerReportSnapshotServiceError && error.code === 'CUSTOMER_REPORT_STALE_EVIDENCE'
    );
    assert.equal(
      fixture.db.prepare('SELECT COUNT(*) AS count FROM customer_report_snapshots').get().count,
      0
    );
  } finally {
    fixture.db.close();
  }
});

test('rejects a confirmed review whose stored content no longer matches its approved lineage', () => {
  const fixture = createFixture({ sourceContentHash: sha256('different approved review') });
  try {
    assert.throws(
      () => fixture.snapshots.preview(previewInput(fixture)),
      (error) => error instanceof CustomerReportSnapshotServiceError && error.code === 'CUSTOMER_REPORT_SOURCE_INVALID'
    );
  } finally {
    fixture.db.close();
  }
});

test('seals one immutable pre-redacted report and exactly replays the same idempotency request', () => {
  const fixture = createFixture();
  try {
    const input = sealInput(fixture);
    const first = fixture.snapshots.seal(input);
    const replay = fixture.snapshots.seal(input);
    const stored = fixture.db.prepare(`
      SELECT report_json,source_knowledge_entry_id FROM customer_report_snapshots
    `).get();

    assert.equal(first.status, 'sealed');
    assert.equal(first.snapshot.id, replay.snapshot.id);
    assert.equal(first.snapshot.source_knowledge_entry_id, undefined);
    assert.equal(stored.source_knowledge_entry_id, fixture.sourceEntryId);
    assert.equal(JSON.stringify(first.snapshot).includes('https://'), false);
    assert.equal(JSON.stringify(first.snapshot).includes('Private Creator'), false);
    assert.equal(stored.report_json.includes('https://'), false);
    assert.equal(stored.report_json.includes('Private Creator'), false);
    assert.equal(
      fixture.db.prepare('SELECT COUNT(*) AS count FROM customer_report_snapshots').get().count,
      1
    );
    const listed = fixture.snapshots.list({ userId: fixture.reader.id, campaignId: fixture.campaign.id });
    assert.equal(listed.snapshots.length, 1);
    const loaded = fixture.snapshots.get({
      userId: fixture.reader.id,
      campaignId: fixture.campaign.id,
      snapshotId: first.snapshot.id
    });
    assert.equal(loaded.snapshot.id, first.snapshot.id);
    assert.deepEqual(loaded.snapshot.report, first.snapshot.report);
  } finally {
    fixture.db.close();
  }
});

test('rejects a changed request that reuses an existing customer report idempotency key', () => {
  const fixture = createFixture();
  try {
    fixture.snapshots.seal(sealInput(fixture));
    const conflict = sealInput(fixture, {
      body: Object.assign({}, fixture.baseInput.body, {
        title: 'Changed customer report title',
        expected_evidence_snapshot_hash: fixture.snapshots.preview(previewInput(fixture)).evidence_snapshot_hash
      })
    });
    assert.throws(
      () => fixture.snapshots.seal(conflict),
      (error) => error instanceof CustomerReportSnapshotServiceError && error.code === 'CUSTOMER_REPORT_IDEMPOTENCY_CONFLICT'
    );
  } finally {
    fixture.db.close();
  }
});

test('rejects unsafe operator text before it can enter a customer report', () => {
  const fixture = createFixture();
  try {
    const invalid = previewInput(fixture);
    invalid.body.optimization_actions = ['Send the full details to https://private.example with the $200 budget.'];
    assert.throws(
      () => fixture.snapshots.preview(invalid),
      (error) => error instanceof CustomerReportSnapshotServiceError && error.code === 'CUSTOMER_REPORT_INPUT_INVALID'
    );
    const chineseAmount = previewInput(fixture);
    chineseAmount.body.next_cycle_plan = 'Set aside 1000元 for the next content set.';
    assert.throws(
      () => fixture.snapshots.preview(chineseAmount),
      (error) => error instanceof CustomerReportSnapshotServiceError && error.code === 'CUSTOMER_REPORT_INPUT_INVALID'
    );
  } finally {
    fixture.db.close();
  }
});
