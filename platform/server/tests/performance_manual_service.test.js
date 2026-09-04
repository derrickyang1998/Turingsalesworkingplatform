const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration = require('../migrations/010_performance_manual_foundation');
const {
  PerformanceManualServiceError,
  createPerformanceManualService,
  createPerformanceAiReviewService
} = require('../services/performance_manual_service');

function createFixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      operational_status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(org_id,id)
    ) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY(org_id,user_id)
    ) STRICT;
    INSERT INTO campaigns (id,org_id,owner_user_id,name,operational_status)
    VALUES (7,1,1,'Merach Autumn Launch','active');
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (1,1,'org_admin','active'),(1,2,'member','active');
  `);
  migration.apply(db);

  function getCampaignAccess(_database, input) {
    if (Number(input.campaignId) !== 7) {
      return { ok: false, status: 404, code: 'CAMPAIGN_NOT_FOUND' };
    }
    const role = Number(input.userId) === 1 ? 'org_admin' : 'team_member';
    return {
      ok: true,
      role,
      organization: { id: 1, role_code: role === 'org_admin' ? 'org_admin' : 'member' },
      campaign: {
        id: 7,
        org_id: 1,
        owner_user_id: 1,
        operational_status: 'active'
      },
      permissions: { read: true, write: true }
    };
  }

  return {
    db,
    service: createPerformanceManualService(db, { getCampaignAccess })
  };
}

function addCanonicalVideo(service) {
  return service.createContent({
    userId: 1,
    campaignId: 7,
    body: {
      url: 'https://youtu.be/dQw4w9WgXcQ?utm_source=launch-sheet',
      creator_name: 'Creator One',
      creator_id: 'creator-1',
      product: 'Merach S19',
      tags: ['launch', 'how-to']
    }
  }).content;
}

function confirmedCommercialInput() {
  return {
    base_currency: 'USD',
    creator_fee: 500,
    product_sample_cost: 100,
    logistics_cost: 100,
    paid_media_spend: 300,
    platform_agency_fee: 100,
    other_cost: 100,
    attributed_revenue: 1800,
    client_charge: 1500,
    attribution_model: 'last_touch',
    attribution_window: '30_days'
  };
}

function addComparableReviewData(service, options = {}) {
  const strongest = addCanonicalVideo(service);
  const weakest = service.createContent({
    userId: 1,
    campaignId: 7,
    body: {
      url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1',
      creator_name: 'Creator Two',
      creator_id: 'creator-2',
      product: 'Merach S19',
      tags: ['launch', 'review']
    }
  }).content;
  service.recordManualInput({
    userId: 1,
    campaignId: 7,
    contentId: strongest.id,
    body: Object.assign({
      observation: { views: 4200, likes: 210, comments: 40, saves: 30, shares: 20 },
      correction_reason: 'Current strongest observation'
    }, options.withCommercial ? { commercial: confirmedCommercialInput(), confirmed: true } : {})
  });
  service.recordManualInput({
    userId: 1,
    campaignId: 7,
    contentId: weakest.id,
    body: {
      observation: { views: 800, likes: 16, comments: 4, saves: 1, shares: 0 },
      correction_reason: 'Current weakest observation'
    }
  });
  return { strongest, weakest };
}

function rejectedAiCompletion() {
  const error = new Error('DeepSeek is unavailable for linked AI chat.');
  error.name = 'AIServiceError';
  error.statusCode = 503;
  error.code = 'AI_PROVIDER_UNAVAILABLE';
  return error;
}

function validateFakeAiReviewCompletion(input, answer) {
  if (typeof input.validateCompletion === 'function' && input.validateCompletion(answer) !== true) {
    throw rejectedAiCompletion();
  }
  if (typeof input.validateBeforePersist === 'function' && input.validateBeforePersist(answer) !== true) {
    throw rejectedAiCompletion();
  }
}

function aiReviewProtocol(strongest, weakest, options = {}) {
  return JSON.stringify({
    contract_version: 1,
    top_evidence_ids: [`PERF-${strongest.id}`],
    bottom_evidence_ids: [`PERF-${weakest.id}`],
    experiment_types: options.experiment_types || ['data_coverage', 'cohort_comparison'],
    human_confirmation: 'required'
  });
}

test('creates one campaign-scoped canonical content record and preserves its original URL', () => {
  const { db, service } = createFixture();
  try {
    const content = addCanonicalVideo(service);

    assert.equal(content.campaign_id, 7);
    assert.equal(content.platform, 'youtube');
    assert.equal(content.canonical_identity, 'youtube:dQw4w9WgXcQ');
    assert.equal(content.original_url, 'https://youtu.be/dQw4w9WgXcQ?utm_source=launch-sheet');
    assert.deepEqual(content.tags, ['launch', 'how-to']);

    assert.throws(() => service.createContent({
      userId: 1,
      campaignId: 7,
      body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
    }), (error) => (
      error instanceof PerformanceManualServiceError &&
      error.code === 'PERFORMANCE_CONTENT_DUPLICATE'
    ));
  } finally {
    db.close();
  }
});

test('appends confirmed manual facts and calculates campaign KPI values from the confirmed commercial basis', () => {
  const { db, service } = createFixture();
  try {
    const content = addCanonicalVideo(service);
    const result = service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: content.id,
      body: {
        observation: {
          views: 1000,
          impressions: 2000,
          likes: 80,
          comments: 20,
          saves: 10,
          shares: 10,
          clicks: 100,
          conversions: 20
        },
        commercial: confirmedCommercialInput(),
        confirmed: true,
        correction_reason: 'Initial campaign snapshot'
      }
    });

    assert.equal(result.manual_input.approval_state, 'approved');
    assert.equal(result.observation.views, 1000);

    const dashboard = service.getDashboard({ userId: 1, campaignId: 7, query: {} });
    assert.equal(dashboard.records.total, 1);
    assert.equal(dashboard.totals.views.value, 1000);
    assert.equal(dashboard.metrics.core_view_er.value, 0.1);
    assert.equal(dashboard.metrics.total_campaign_cost.value, 1200);
    assert.equal(dashboard.metrics.cpm.value, 600);
    assert.equal(dashboard.metrics.cpc.value, 12);
    assert.equal(dashboard.metrics.roi.value, 0.5);
    assert.equal(dashboard.metrics.roas.value, 6);
    assert.equal(dashboard.top_contents[0].content.id, content.id);
  } finally {
    db.close();
  }
});

test('does not disclose commercial input or financial KPI values to a campaign team member', () => {
  const { db, service } = createFixture();
  try {
    const content = addCanonicalVideo(service);
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: content.id,
      body: {
        observation: { views: 1000, likes: 80, comments: 20 },
        commercial: confirmedCommercialInput(),
        confirmed: true,
        correction_reason: 'Creator fee corrected to USD 10,000.'
      }
    });

    const list = service.listContents({
      userId: 2,
      campaignId: 7,
      query: { q: 'creator-1' }
    });
    const dashboard = service.getDashboard({ userId: 2, campaignId: 7, query: {} });

    assert.equal(list.capabilities.can_view_commercial, false);
    assert.equal(Object.hasOwn(list.items[0], 'commercial'), false);
    assert.equal(Object.hasOwn(list.items[0].latest_observation, 'correction_reason'), false);
    assert.equal(dashboard.capabilities.can_view_commercial, false);
    assert.equal(Object.hasOwn(dashboard.metrics, 'roi'), false);
    assert.equal(Object.hasOwn(dashboard.metrics, 'roas'), false);
    assert.equal(Object.hasOwn(dashboard.metrics, 'total_campaign_cost'), false);
  } finally {
    db.close();
  }
});

test('uses the latest observed_at value when a late backfill is appended', () => {
  const { db, service } = createFixture();
  try {
    const content = addCanonicalVideo(service);
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: content.id,
      body: {
        observation: {
          views: 1000,
          observed_at: '2026-09-02T12:00:00.000Z'
        }
      }
    });
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: content.id,
      body: {
        observation: {
          views: 100,
          observed_at: '2026-09-01T12:00:00.000Z'
        }
      }
    });

    const list = service.listContents({ userId: 1, campaignId: 7, query: {} });
    const dashboard = service.getDashboard({ userId: 1, campaignId: 7, query: {} });

    assert.equal(list.items[0].latest_observation.observed_at, '2026-09-02T12:00:00.000Z');
    assert.equal(list.items[0].latest_observation.views, 1000);
    assert.equal(dashboard.totals.views.value, 1000);
  } finally {
    db.close();
  }
});

test('imports accepted parsed rows atomically while returning malformed rows as safe rejections', () => {
  const { db, service } = createFixture();
  try {
    const result = service.importContentRows({
      userId: 1,
      campaignId: 7,
      body: {
        mapping_version: 'performance-v1',
        provenance: {
          source_mode: 'csv_xlsx',
          file_hash: 'a'.repeat(64)
        },
        column_mapping: {
          content_url: 'Video URL',
          creator_name: 'Creator',
          tags: 'Tags'
        },
        rows: [
          {
            source_row_number: 2,
            'Video URL': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            Creator: 'Creator One',
            Tags: 'launch,how-to'
          },
          {
            source_row_number: 3,
            'Video URL': 'not-a-url',
            Creator: 'Rejected Creator',
            Tags: 'invalid'
          }
        ]
      }
    });

    assert.equal(result.accepted_count, 1);
    assert.equal(result.rejected_count, 1);
    assert.equal(result.rows[1].error.code, 'PERFORMANCE_CONTENT_IMPORT_URL_INVALID');
    assert.equal(service.listContents({ userId: 1, campaignId: 7, query: {} }).items.length, 1);
  } finally {
    db.close();
  }
});

test('imports batch metric snapshots for existing canonical content and skips an exact CSV replay', () => {
  const { db, service } = createFixture();
  try {
    const content = addCanonicalVideo(service);
    const request = {
      userId: 1,
      campaignId: 7,
      body: {
        mapping_version: 'performance-metrics-v1',
        provenance: {
          source_mode: 'csv_xlsx',
          file_hash: 'b'.repeat(64)
        },
        column_mapping: {
          content_url: '视频链接',
          observed_at: '数据更新时间',
          views: '播放量',
          likes: '点赞数',
          comments: '评论数',
          shares: '转发数',
          clicks: '点击数'
        },
        rows: [
          {
            source_row_number: 2,
            视频链接: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            数据更新时间: '2026-09-02T12:00:00.000Z',
            播放量: '1,250',
            点赞数: '88',
            评论数: 12,
            转发数: '4',
            点击数: '34'
          },
          {
            source_row_number: 3,
            视频链接: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1',
            数据更新时间: '2026-09-02T12:00:00.000Z',
            播放量: '100'
          }
        ]
      }
    };

    const imported = service.importMetricRows(request);
    assert.equal(imported.contract_version, 'performance-metric-import-v1');
    assert.equal(imported.accepted_count, 1);
    assert.equal(imported.duplicate_count, 0);
    assert.equal(imported.rejected_count, 1);
    assert.equal(imported.rows[0].publication_id, content.id);
    assert.equal(imported.rows[1].error.code, 'PERFORMANCE_METRIC_IMPORT_CONTENT_NOT_FOUND');

    const current = service.listContents({ userId: 1, campaignId: 7, query: {} }).items[0];
    assert.equal(current.latest_observation.source_mode, 'csv_xlsx');
    assert.equal(current.latest_observation.views, 1250);
    assert.equal(current.latest_observation.clicks, 34);
    assert.equal(current.metrics.core_view_er.value, 0.08);

    const replayed = service.importMetricRows(request);
    assert.equal(replayed.accepted_count, 0);
    assert.equal(replayed.duplicate_count, 1);
    assert.equal(replayed.rejected_count, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM performance_metric_observations').get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('rejects malformed batch metric cells without creating an observation', () => {
  const { db, service } = createFixture();
  try {
    addCanonicalVideo(service);
    const result = service.importMetricRows({
      userId: 1,
      campaignId: 7,
      body: {
        mapping_version: 'performance-metrics-v1',
        provenance: {
          source_mode: 'csv_xlsx',
          file_hash: 'c'.repeat(64)
        },
        column_mapping: {
          content_url: '视频链接',
          observed_at: '数据更新时间',
          views: '播放量'
        },
        rows: [{
          source_row_number: 2,
          视频链接: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          数据更新时间: '2026-09-02T12:00:00.000Z',
          播放量: '-1'
        }]
      }
    });

    assert.equal(result.accepted_count, 0);
    assert.equal(result.duplicate_count, 0);
    assert.equal(result.rejected_count, 1);
    assert.equal(result.rows[0].error.code, 'PERFORMANCE_METRIC_IMPORT_ROW_INVALID');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM performance_metric_observations').get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('requires an explicit data update time mapping for batch metric imports', () => {
  const { db, service } = createFixture();
  try {
    assert.throws(() => service.importMetricRows({
      userId: 1,
      campaignId: 7,
      body: {
        mapping_version: 'performance-metrics-v1',
        provenance: {
          source_mode: 'csv_xlsx',
          file_hash: 'd'.repeat(64)
        },
        column_mapping: {
          content_url: '视频链接',
          views: '播放量'
        },
        rows: []
      }
    }), (error) => error instanceof PerformanceManualServiceError &&
      error.code === 'PERFORMANCE_METRIC_IMPORT_TIMESTAMP_MAPPING_REQUIRED');
  } finally {
    db.close();
  }
});

test('returns a campaign-scoped read-only source and Feishu mapping preview for an administrator', () => {
  const { db, service } = createFixture();
  try {
    const before = db.prepare('SELECT COUNT(*) AS count FROM campaign_publications').get().count;
    const preview = service.getIntegrationPreview({ userId: 1, campaignId: 7 });

    assert.equal(preview.contract_version, 'performance-integration-preview-v1');
    assert.equal(preview.campaign_id, 7);
    assert.equal(preview.capabilities.can_view, true);
    assert.deepEqual(preview.data_sources.map((source) => source.id), ['manual', 'csv_xlsx']);
    assert.equal(preview.data_sources.every((source) => source.dispatch_available === false), true);
    assert.equal(
      preview.data_sources.find((source) => source.id === 'csv_xlsx').supports.includes('metric_input'),
      true
    );
    assert.equal(preview.feishu.status, 'preview_only');
    assert.equal(preview.feishu.provider_validation, 'not_attempted');
    assert.equal(preview.feishu.write_attempted, false);
    assert.equal(
      preview.feishu.field_mapping.some((field) => field.source_key === 'commercial.creator_fee'),
      true
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_publications').get().count, before);
  } finally {
    db.close();
  }
});

test('omits commercial fields from the preview for a non-privileged campaign member', () => {
  const { db, service } = createFixture();
  try {
    const preview = service.getIntegrationPreview({ userId: 2, campaignId: 7 });

    assert.equal(preview.capabilities.can_view, true);
    assert.equal(preview.capabilities.can_view_commercial, false);
    assert.equal(
      preview.data_sources.find((source) => source.id === 'manual').supports.includes('commercial_input'),
      false
    );
    assert.equal(
      preview.feishu.field_mapping.some((field) => field.access === 'commercial'),
      false
    );
  } finally {
    db.close();
  }
});

test('exports only the current filtered content view for a commercial-capable operator', () => {
  const { db, service } = createFixture();
  try {
    const matching = addCanonicalVideo(service);
    service.createContent({
      userId: 1,
      campaignId: 7,
      body: {
        url: 'https://www.tiktok.com/@creator/video/1234567890123456789',
        creator_name: 'Other Creator',
        tags: ['other']
      }
    });
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: matching.id,
      body: {
        observation: { views: 1000, likes: 80, comments: 20, clicks: 100 },
        commercial: confirmedCommercialInput(),
        confirmed: true
      }
    });

    const exported = service.exportContents({
      userId: 1,
      campaignId: 7,
      scope: 'filtered',
      query: { tag: 'launch' }
    });

    assert.equal(exported.scope, 'filtered');
    assert.equal(exported.total, 1);
    assert.match(exported.csv, /^\uFEFF/);
    assert.match(exported.csv, /视频花费/);
    assert.match(exported.csv, /Creator One/);
    assert.doesNotMatch(exported.csv, /Other Creator/);
  } finally {
    db.close();
  }
});

test('redacts commercial columns from a team member export', () => {
  const { db, service } = createFixture();
  try {
    const content = addCanonicalVideo(service);
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: content.id,
      body: {
        observation: { views: 1000, likes: 80, comments: 20 },
        commercial: confirmedCommercialInput(),
        confirmed: true,
        correction_reason: 'Commercial correction must remain private.'
      }
    });

    const exported = service.exportContents({
      userId: 2,
      campaignId: 7,
      scope: 'filtered',
      query: {}
    });

    assert.equal(exported.total, 1);
    assert.doesNotMatch(exported.csv, /视频花费|归因收入|ROI|ROAS/);
    assert.doesNotMatch(exported.csv, /Commercial correction must remain private/);
    assert.match(exported.csv, /Creator One/);
  } finally {
    db.close();
  }
});

test('exports all campaign content when all scope is requested', () => {
  const { db, service } = createFixture();
  try {
    addCanonicalVideo(service);
    service.createContent({
      userId: 1,
      campaignId: 7,
      body: {
        url: 'https://www.tiktok.com/@creator/video/1234567890123456789',
        creator_name: 'Other Creator',
        tags: ['other']
      }
    });

    const exported = service.exportContents({
      userId: 1,
      campaignId: 7,
      scope: 'all',
      query: { tag: 'launch' }
    });

    assert.equal(exported.scope, 'all');
    assert.equal(exported.total, 2);
    assert.match(exported.csv, /Creator One/);
    assert.match(exported.csv, /Other Creator/);
  } finally {
    db.close();
  }
});

test('escapes spreadsheet formula strings after non-breaking whitespace in CSV exports', () => {
  const { db, service } = createFixture();
  try {
    const content = addCanonicalVideo(service);
    db.exec('DROP TRIGGER campaign_publications_no_update');
    db.prepare('UPDATE campaign_publications SET creator_name=? WHERE id=?')
      .run('\u00A0=HYPERLINK("https://unsafe.example", "unsafe")', content.id);

    const exported = service.exportContents({
      userId: 1,
      campaignId: 7,
      scope: 'all',
      query: {}
    });

    assert.match(exported.csv, /"'\u00A0=HYPERLINK/);
  } finally {
    db.close();
  }
});

test('builds a campaign-scoped metadata-only review evidence pack from current performance snapshots', () => {
  const { db, service } = createFixture();
  try {
    const strongest = addCanonicalVideo(service);
    const weakest = service.createContent({
      userId: 1,
      campaignId: 7,
      body: {
        url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1',
        creator_name: 'Creator Two',
        creator_id: 'creator-2',
        product: 'Merach S19',
        tags: ['launch', 'review']
      }
    }).content;
    const mid = service.createContent({
      userId: 1,
      campaignId: 7,
      body: {
        url: 'https://www.tiktok.com/@creator/video/1234567890123456789',
        creator_name: 'Creator Three',
        creator_id: 'creator-3',
        product: 'Merach S19',
        tags: ['launch']
      }
    }).content;
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: strongest.id,
      body: {
        observation: {
          views: 4200,
          likes: 210,
          comments: 40,
          saves: 30,
          shares: 20,
          observed_at: '2026-09-02T12:00:00.000Z'
        }
      }
    });
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: weakest.id,
      body: {
        observation: {
          views: 800,
          likes: 16,
          comments: 4,
          saves: 1,
          shares: 0,
          observed_at: '2026-09-01T12:00:00.000Z'
        }
      }
    });
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: mid.id,
      body: {
        observation: {
          views: 1200,
          likes: 48,
          comments: 10,
          saves: 4,
          shares: 2,
          observed_at: '2026-09-02T10:00:00.000Z'
        }
      }
    });

    const review = service.getReviewEvidence({
      userId: 1,
      campaignId: 7,
      query: { top_metric: 'views' }
    });

    assert.equal(review.contract_version, 'performance-review-evidence-v1');
    assert.equal(review.analysis.mode, 'metadata_only');
    assert.equal(review.analysis.media_evidence.status, 'not_collected');
    assert.equal(review.records.total, 3);
    assert.equal(review.records.active_with_observations, 3);
    assert.equal(review.rankings.status, 'available');
    assert.equal(review.rankings.metric, 'views');
    assert.equal(review.rankings.comparable_records, 3);
    assert.equal(review.rankings.top_contents[0].content.id, strongest.id);
    assert.equal(review.rankings.bottom_contents[0].content.id, weakest.id);
    assert.equal(review.rankings.top_contents[0].evidence.latest_observation.observed_at, '2026-09-02T12:00:00.000Z');
    assert.equal(review.breakdowns.platforms[0].content_count, 2);
    assert.deepEqual(
      review.data_quality.metric_coverage.find((item) => item.metric === 'views'),
      { metric: 'views', available_records: 3, total_records: 3, coverage: 1 }
    );
    assert.equal(review.limitations.some((item) => item.code === 'media_evidence_not_collected'), true);
  } finally {
    db.close();
  }
});

test('does not expose commercial facts in a review evidence pack for a team member', () => {
  const { db, service } = createFixture();
  try {
    const content = addCanonicalVideo(service);
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: content.id,
      body: {
        observation: { views: 1000, likes: 80, comments: 20 },
        commercial: confirmedCommercialInput(),
        confirmed: true,
        correction_reason: 'Commercial facts must remain private.'
      }
    });
    const second = service.createContent({
      userId: 1,
      campaignId: 7,
      body: {
        url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1',
        creator_name: 'Creator Two',
        creator_id: 'creator-2'
      }
    }).content;
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: second.id,
      body: { observation: { views: 300, likes: 10, comments: 2 } }
    });

    const review = service.getReviewEvidence({
      userId: 2,
      campaignId: 7,
      query: { top_metric: 'views' }
    });

    assert.equal(review.capabilities.can_view_commercial, false);
    assert.equal(Object.hasOwn(review.metrics, 'roi'), false);
    assert.equal(Object.hasOwn(review.metrics, 'roas'), false);
    assert.equal(Object.hasOwn(review.rankings.top_contents[0].content, 'commercial'), false);
    assert.equal(review.limitations.some((item) => item.code === 'commercial_metrics_restricted'), true);
  } finally {
    db.close();
  }
});

test('withholds content rankings when the selected metric has less than eighty percent coverage', () => {
  const { db, service } = createFixture();
  try {
    const observed = addCanonicalVideo(service);
    service.createContent({
      userId: 1,
      campaignId: 7,
      body: {
        url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1',
        creator_name: 'Missing Snapshot Creator'
      }
    });
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: observed.id,
      body: { observation: { views: 1200, likes: 48, comments: 12 } }
    });

    const review = service.getReviewEvidence({
      userId: 1,
      campaignId: 7,
      query: { top_metric: 'views' }
    });

    assert.equal(review.rankings.status, 'insufficient_coverage');
    assert.equal(review.rankings.eligibility.coverage, 0.5);
    assert.deepEqual(review.rankings.top_contents, []);
    assert.deepEqual(review.rankings.bottom_contents, []);
    assert.equal(review.limitations.some((item) => item.code === 'ranking_coverage_insufficient'), true);
  } finally {
    db.close();
  }
});

test('uses disjoint performance cohorts for two through five comparable records', () => {
  for (const recordCount of [2, 3, 4, 5]) {
    const { db, service } = createFixture();
    try {
      for (let index = 0; index < recordCount; index += 1) {
        const content = service.createContent({
          userId: 1,
          campaignId: 7,
          body: {
            url: `https://www.youtube.com/watch?v=${String(index + 1).padStart(11, 'A')}`,
            creator_name: `Cohort Creator ${index + 1}`
          }
        }).content;
        service.recordManualInput({
          userId: 1,
          campaignId: 7,
          contentId: content.id,
          body: { observation: { views: 1000 + index * 100 } }
        });
      }
      const review = service.getReviewEvidence({
        userId: 1,
        campaignId: 7,
        query: { top_metric: 'views' }
      });
      const topIds = review.rankings.top_contents.map((item) => item.content.id);
      const bottomIds = review.rankings.bottom_contents.map((item) => item.content.id);
      const expectedCohortSize = Math.floor(recordCount / 2);

      assert.equal(topIds.length, expectedCohortSize, `${recordCount} records: top cohort size`);
      assert.equal(bottomIds.length, expectedCohortSize, `${recordCount} records: bottom cohort size`);
      assert.deepEqual(topIds.filter((id) => bottomIds.includes(id)), [], `${recordCount} records: cohorts overlap`);
    } finally {
      db.close();
    }
  }
});

test('generates an evidence-bound AI review draft without sending commercial or URL fields to the model', async () => {
  const { db, service } = createFixture();
  try {
    const { strongest, weakest } = addComparableReviewData(service, { withCommercial: true });
    const requests = [];
    const aiReviewService = createPerformanceAiReviewService(db, {
      performanceService: service,
      aiService: {
        async handleChat(_database, input) {
          requests.push(input);
          const response = {
            conversation_id: 31,
            message_id: 32,
            answer: aiReviewProtocol(strongest, weakest),
            model: 'deepseek-test',
            usage: { total_tokens: 99 },
            latency_ms: 12,
            knowledge_references: [],
            web_search: { used: false },
            summary_promotion: { status: 'retained_only', reason: 'disabled' },
            archived_summary_id: null,
            degraded: false,
            status: 'succeeded'
          };
          validateFakeAiReviewCompletion(input, response.answer);
          return response;
        }
      }
    });

    const result = await aiReviewService.createDraft({
      user: { id: 1, role: 'admin' },
      campaignId: 7,
      body: { top_metric: 'views' },
      idempotencyKey: 'ai-review-test-1',
      requestId: 'ai-review-request-1'
    });

    assert.equal(result.status, 'generated');
    assert.equal(result.analysis.mode, 'metadata_only');
    assert.equal(result.analysis.web_search.used, false);
    assert.equal(result.analysis.knowledge_promotion.status, 'not_started');
    assert.equal(result.confidence.level, 'medium');
    assert.match(result.confidence.detail, /2\/2/);
    assert.equal(result.evidence.citation_validation.valid, true);
    assert.equal(result.evidence.draft_validation.valid, true);
    assert.match(result.evidence.snapshot_hash, /^[a-f0-9]{64}$/);
    assert.match(result.draft, new RegExp(`\\[PERF-${strongest.id}\\]`));
    assert.match(result.draft, new RegExp(`\\[PERF-${weakest.id}\\]`));
    assert.doesNotMatch(result.draft, /contract_version|top_evidence_ids/);
    assert.equal(result.ai.conversation_id, 31);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].allowWeb, false);
    assert.equal(requests[0].archiveSummary, false);
    assert.equal(requests[0].source_module, 'performance_review');
    assert.equal(requests[0].entry_type, 'performance_review_methodology');
    assert.equal(requests[0].source_type, 'performance_review_methodology');
    assert.equal(requests[0].quality_state, 'confirmed');
    assert.equal(requests[0].business_type, 'campaign');
    assert.equal(requests[0].business_id, '7');
    assert.equal(Object.hasOwn(requests[0], 'knowledge_entry_ids'), false);
    assert.doesNotMatch(requests[0].message, /confirmed_commercial|creator_fee|attributed_revenue|\"roi\"|\"roas\"/i);
    assert.doesNotMatch(requests[0].message, /https?:\/\//i);
  } finally {
    db.close();
  }
});

test('does not call AI when current performance evidence cannot support a comparable ranking', async () => {
  const { db, service } = createFixture();
  try {
    const observed = addCanonicalVideo(service);
    service.createContent({
      userId: 1,
      campaignId: 7,
      body: { url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1', creator_name: 'Missing Snapshot Creator' }
    });
    service.recordManualInput({
      userId: 1,
      campaignId: 7,
      contentId: observed.id,
      body: { observation: { views: 1200, likes: 48, comments: 12 } }
    });
    let callCount = 0;
    const aiReviewService = createPerformanceAiReviewService(db, {
      performanceService: service,
      aiService: { async handleChat() { callCount += 1; throw new Error('must not run'); } }
    });

    const result = await aiReviewService.createDraft({
      user: { id: 1, role: 'admin' },
      campaignId: 7,
      body: { top_metric: 'views' },
      idempotencyKey: 'ai-review-test-2',
      requestId: 'ai-review-request-2'
    });

    assert.equal(result.status, 'not_ready');
    assert.equal(result.reason_code, 'insufficient_comparable_data');
    assert.equal(result.draft, null);
    assert.equal(result.ai, null);
    assert.equal(callCount, 0);
  } finally {
    db.close();
  }
});

test('withholds AI review drafts that fail citation or content-boundary validation', async () => {
  const { db, service } = createFixture();
  try {
    const { strongest, weakest } = addComparableReviewData(service);
    const aiReviewService = createPerformanceAiReviewService(db, {
      performanceService: service,
      aiService: {
        async handleChat(_database, input) {
          const response = {
            conversation_id: 41,
            message_id: 42,
            answer: `The call to action drove conversions [PERF-${strongest.id}] while [PERF-${weakest.id}] needs attention; 需人工确认。`,
            model: 'deepseek-test',
            usage: {},
            latency_ms: 10,
            knowledge_references: [],
            web_search: { used: false },
            summary_promotion: { status: 'retained_only' },
            degraded: false,
            status: 'succeeded'
          };
          validateFakeAiReviewCompletion(input, response.answer);
          return response;
        }
      }
    });

    const result = await aiReviewService.createDraft({
      user: { id: 1, role: 'admin' },
      campaignId: 7,
      body: { top_metric: 'views' },
      idempotencyKey: 'ai-review-test-3',
      requestId: 'ai-review-request-3'
    });

    assert.equal(result.status, 'withheld');
    assert.equal(result.reason_code, 'draft_safety_validation_failed');
    assert.equal(result.draft, null);
    assert.equal(result.ai, null);
    assert.equal(result.evidence.draft_validation.causal_media_claim_detected, true);
  } finally {
    db.close();
  }
});

test('withholds AI review drafts when the protocol reuses one item across opposing cohorts', async () => {
  const { db, service } = createFixture();
  try {
    const { strongest } = addComparableReviewData(service);
    const aiReviewService = createPerformanceAiReviewService(db, {
      performanceService: service,
      aiService: {
        async handleChat(_database, input) {
          const response = {
            conversation_id: 46,
            message_id: 47,
            answer: aiReviewProtocol(strongest, strongest),
            model: 'deepseek-test',
            usage: {},
            latency_ms: 10,
            knowledge_references: [],
            web_search: { used: false },
            summary_promotion: { status: 'retained_only' },
            degraded: false,
            status: 'succeeded'
          };
          validateFakeAiReviewCompletion(input, response.answer);
          return response;
        }
      }
    });

    const result = await aiReviewService.createDraft({
      user: { id: 1, role: 'admin' },
      campaignId: 7,
      body: { top_metric: 'views' },
      idempotencyKey: 'ai-review-test-overlap',
      requestId: 'ai-review-request-overlap'
    });

    assert.equal(result.status, 'withheld');
    assert.equal(result.reason_code, 'ai_review_protocol_invalid');
    assert.deepEqual(result.evidence.protocol_validation.overlapping, [`PERF-${strongest.id}`]);
  } finally {
    db.close();
  }
});

test('withholds a generated AI review draft when the performance evidence changes before it can be shown', async () => {
  const { db, service } = createFixture();
  try {
    const { strongest, weakest } = addComparableReviewData(service);
    let evidenceReadCount = 0;
    const performanceService = {
      getReviewEvidence(input) {
        const evidence = service.getReviewEvidence(input);
        evidenceReadCount += 1;
        if (evidenceReadCount > 1) {
          return Object.assign({}, evidence, {
            records: Object.assign({}, evidence.records, { total: evidence.records.total + 1 })
          });
        }
        return evidence;
      }
    };
    const aiReviewService = createPerformanceAiReviewService(db, {
      performanceService,
      aiService: {
        async handleChat(_database, input) {
          const response = {
            conversation_id: 51,
            message_id: 52,
            answer: aiReviewProtocol(strongest, weakest),
            model: 'deepseek-test',
            usage: {},
            latency_ms: 10,
            knowledge_references: [],
            web_search: { used: false },
            summary_promotion: { status: 'retained_only' },
            degraded: false,
            status: 'succeeded'
          };
          validateFakeAiReviewCompletion(input, response.answer);
          return response;
        }
      }
    });

    const result = await aiReviewService.createDraft({
      user: { id: 1, role: 'admin' },
      campaignId: 7,
      body: { top_metric: 'views' },
      idempotencyKey: 'ai-review-test-4',
      requestId: 'ai-review-request-4'
    });

    assert.equal(result.status, 'stale_snapshot');
    assert.equal(result.reason_code, 'review_evidence_changed');
    assert.equal(result.draft, null);
    assert.equal(result.ai, null);
  } finally {
    db.close();
  }
});

test('withholds provider-degraded AI review output instead of returning an unsafe draft', async () => {
  const { db, service } = createFixture();
  try {
    addComparableReviewData(service);
    const aiReviewService = createPerformanceAiReviewService(db, {
      performanceService: service,
      aiService: {
        async handleChat() {
          return {
            conversation_id: 61,
            message_id: 62,
            answer: 'Provider fallback content',
            model: 'fallback',
            usage: {},
            latency_ms: 10,
            knowledge_references: [],
            web_search: { used: false },
            summary_promotion: { status: 'retained_only' },
            degraded: true,
            status: 'succeeded'
          };
        }
      }
    });

    const result = await aiReviewService.createDraft({
      user: { id: 1, role: 'admin' },
      campaignId: 7,
      body: { top_metric: 'views' },
      idempotencyKey: 'ai-review-test-5',
      requestId: 'ai-review-request-5'
    });

    assert.equal(result.status, 'withheld');
    assert.equal(result.reason_code, 'ai_review_unavailable');
    assert.equal(result.draft, null);
  } finally {
    db.close();
  }
});
