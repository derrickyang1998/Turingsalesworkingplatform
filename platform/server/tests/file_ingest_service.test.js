const test = require('node:test');
const assert = require('node:assert/strict');

const fileIngest = require('../services/file_ingest_service');
const influencerWorkflow = require('../services/influencer_workflow_service');

test('read-excel-file worksheet objects preserve the approved influencer upload headers', () => {
  const cells = [
    '2026-07-30',
    'Derrick',
    'Northwind / Customer',
    'Portable power station',
    'No',
    'sample_creator',
    125000,
    'https://example.com/@sample_creator',
    'TikTok',
    'US',
    'Outdoor Tech',
    48000,
    1500,
    '1 short video',
    'Introduced by partner',
    2500,
    'creator@example.com',
    31.25,
    0.04,
    'CRM-001'
  ];
  const workbookResult = {
    sheet: 'Sheet1',
    data: [influencerWorkflow.TEMPLATE_HEADERS, cells]
  };

  const rows = fileIngest.normalizeXlsxRows(workbookResult);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), influencerWorkflow.TEMPLATE_HEADERS);

  const normalized = influencerWorkflow.normalizeInfluencerRow(rows[0]);
  assert.deepEqual(normalized, {
    platform: 'TikTok',
    kol_handle: 'sample_creator',
    profile_link: 'https://example.com/@sample_creator',
    followers: 125000,
    avg_views_10: 48000,
    avg_engagement: 0,
    category: 'Outdoor Tech',
    influencer_type: 'Outdoor Tech',
    tags: 'Outdoor Tech',
    region: 'US',
    language: '',
    content_style: '',
    collab_type: 'Dedicated',
    cost_usd: 1500,
    cpm: 31.25,
    cpv: 0.04,
    brand_collab_history: 'Introduced by partner',
    contact_email: 'creator@example.com',
    project_name: 'Northwind / Customer',
    product_name: 'Portable power station',
    reporter: 'Derrick',
    quoted_price: 2500,
    content_deliverable: '1 short video',
    is_duplicate: 0,
    parent_record: 'CRM-001'
  });
});

test('worksheet arrays continue to select the first populated sheet', () => {
  const rows = fileIngest.unwrapXlsxRows([
    { sheet: 'Empty', data: [] },
    { sheet: 'Data', data: [['Name'], ['sample_creator']] }
  ]);

  assert.deepEqual(rows, [['Name'], ['sample_creator']]);
});
