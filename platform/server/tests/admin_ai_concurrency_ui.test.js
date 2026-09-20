'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'app.js'), 'utf8');

test('admin organization table reuses the existing AI quota cell for concurrency', () => {
  assert.match(appSource, /<th>AI 配额 \/ 并发<\/th>/);
  assert.match(appSource, /organization\.ai_concurrency/);
  assert.match(appSource, /AI 并发/);
  assert.match(appSource, /earliest_lease_expires_at/);
  assert.match(appSource, /ad_organizationAiConcurrency_/);
  assert.match(appSource, /ad_organizationAiConcurrencySave_/);
  assert.doesNotMatch(appSource, /AI 并发中心/);
});

test('admin concurrency save keeps exact bounds, version, and reason', () => {
  assert.match(appSource, /function saveAdminOrganizationAiConcurrency\(/);
  assert.match(appSource, /concurrencyLimit < 0 \|\| concurrencyLimit > 64/);
  assert.match(appSource, /concurrency_limit: concurrencyLimit/);
  assert.match(appSource, /expected_version: version/);
  assert.match(appSource, /reason: reason/);
  assert.match(appSource, /AI_ORGANIZATION_CONCURRENCY_VERSION_CONFLICT/);
});
