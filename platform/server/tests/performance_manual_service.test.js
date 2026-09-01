const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration = require('../migrations/010_performance_manual_foundation');
const {
  PerformanceManualServiceError,
  createPerformanceManualService
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
        confirmed: true
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
    assert.equal(dashboard.capabilities.can_view_commercial, false);
    assert.equal(Object.hasOwn(dashboard.metrics, 'roi'), false);
    assert.equal(Object.hasOwn(dashboard.metrics, 'roas'), false);
    assert.equal(Object.hasOwn(dashboard.metrics, 'total_campaign_cost'), false);
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
