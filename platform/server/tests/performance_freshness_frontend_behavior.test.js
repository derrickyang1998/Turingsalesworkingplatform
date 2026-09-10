'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'app.js'), 'utf8');

function extractFunction(name) {
  const pattern = new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}');
  const match = appSource.match(pattern);
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

test('freshness URL validation permits only HTTP and HTTPS links', () => {
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(extractFunction('performanceSafeExternalUrl'), context);

  assert.equal(context.performanceSafeExternalUrl('javascript:alert(1)'), '');
  assert.equal(context.performanceSafeExternalUrl('data:text/html,payload'), '');
  assert.equal(context.performanceSafeExternalUrl('vbscript:msgbox(1)'), '');
  assert.equal(context.performanceSafeExternalUrl('https://example.test/video'), 'https://example.test/video');
  assert.equal(
    context.performanceSafeExternalUrl('https://example.test/\" onclick=\"alert(1)'),
    'https://example.test/%22%20onclick=%22alert(1)'
  );
});

test('a queue item outside the filtered list hydrates the existing input modal', () => {
  const opened = [];
  const context = {
    performanceFreshnessQueue: {
      items: [{ publication_id: 42, content: { id: 42, original_url: 'https://example.test/42' } }]
    },
    performanceContents: [{ id: 7 }],
    performancePositiveId(value) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    },
    openPerformanceInputModal(id) { opened.push(id); },
    toast() {}
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('openPerformanceFreshnessInput'), context);

  context.openPerformanceFreshnessInput(42);

  assert.deepEqual(Array.from(context.performanceContents, (item) => item.id), [7, 42]);
  assert.deepEqual(opened, [42]);
});

test('a stale freshness response cannot overwrite the newly selected campaign', async () => {
  let campaignId = 7;
  let resolveJson;
  const renders = [];
  const pendingJson = new Promise((resolve) => { resolveJson = resolve; });
  const element = { innerHTML: '', textContent: '' };
  const context = {
    performanceFreshnessRequestSequence: 0,
    getPerformanceCampaignId() { return campaignId; },
    document: { getElementById() { return element; } },
    apiFetch: async () => ({ ok: true, json: async () => pendingJson }),
    renderPerformanceFreshnessQueue(data) { renders.push(data); },
    encodeURIComponent,
    Error
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('loadPerformanceFreshnessQueue'), context);

  const request = context.loadPerformanceFreshnessQueue();
  campaignId = 8;
  context.performanceFreshnessRequestSequence += 1;
  resolveJson({ campaign_id: 7, summary: {} });
  await request;

  assert.deepEqual(renders, []);
});
