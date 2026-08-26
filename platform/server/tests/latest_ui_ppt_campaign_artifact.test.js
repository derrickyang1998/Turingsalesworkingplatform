'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', '..', 'app.js');
const pptPath = path.join(__dirname, '..', '..', 'ppt.js');
const appSource = fs.readFileSync(appPath, 'utf8');

function extractFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const match = declaration.exec(source);
  assert.ok(match, `${name} must exist`);
  const openingBrace = source.indexOf('{', match.index);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  assert.fail(`${name} must have a balanced function body`);
}

function loadFunctions(context, names) {
  context.window = context.window || context;
  context.globalThis = context;
  vm.createContext(context);
  for (const name of names) vm.runInContext(extractFunction(appSource, name), context);
  return context;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      return { async json() { return body; } };
    },
    async json() { return body; }
  };
}

function baseContext(overrides = {}) {
  let operation = 0;
  return {
    AUTH_GENERATION: 4,
    activeWorkflowContext: null,
    curDemand: {
      brand: 'Acme',
      company: 'Acme Inc',
      product: 'Power station',
      category: 'Energy',
      budget: '20000',
      area: 'US',
      platform: 'YouTube'
    },
    campaignPptDemandFingerprint: '',
    campaignPptDemandIdempotencyKey: '',
    campaignPptDemandRecord: null,
    campaignPptProposalFingerprint: '',
    campaignPptProposalIdempotencyKey: '',
    campaignPptProposalVersion: null,
    campaignPptDownloadFingerprint: '',
    campaignPptDownloadIdempotencyKey: '',
    campaignPptDownloadInFlight: false,
    campaignPptArchiveState: { status: 'idle', message: '' },
    lastPPTOutline: {
      title: 'Acme Campaign',
      subtitle: 'US launch',
      sections: [{ title: 'Summary', type: 'content', points: ['One'], note: '' }]
    },
    getActiveCampaignId() { return 12; },
    readPositiveInteger: positiveInteger,
    createDemandAnalysisOperationId(prefix) {
      operation += 1;
      return `${prefix}${operation}`;
    },
    renderCampaignPptArchiveStatus() {},
    ...overrides
  };
}

const coreFunctions = [
  'campaignPptFingerprint',
  'campaignPptBuildHeaders',
  'getActiveDemandId',
  'buildCampaignPptDemandPayload',
  'ensureCampaignPptDemandRecord'
];

test('active Campaign persists one demand parent before proposal save and reuses it', async () => {
  const calls = [];
  const context = baseContext({
    async apiFetch(url, options) {
      calls.push({ url, options });
      return jsonResponse(201, { id: 51, campaign_id: 12, link_id: 91 });
    }
  });
  loadFunctions(context, coreFunctions);

  const demandId = await context.ensureCampaignPptDemandRecord(12);
  const replay = await context.ensureCampaignPptDemandRecord(12);

  assert.equal(demandId, 51);
  assert.equal(replay, 51);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/demands');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.campaign_id, 12);
  assert.equal(body.brand_name, 'Acme');
  assert.equal(body.company_name, 'Acme Inc');
  assert.equal(body.product_name, 'Power station');
  assert.equal(body.industry, 'Energy');
  assert.equal(body.target_market, 'US');
  assert.equal(body.platform, 'YouTube');
  assert.equal(body.data_json.brand, 'Acme');
  assert.match(calls[0].options.headers['Idempotency-Key'], /^ppt-demand-/);
  assert.match(calls[0].options.headers['X-Request-Id'], /^ppt-demand-request-/);
  assert.equal(context.curDemand.demand_id, 51);
});

test('demand persistence retries the same content with one key and rejects a stale Campaign response', async () => {
  const keys = [];
  let campaignId = 12;
  let resolveRequest;
  const context = baseContext({
    getActiveCampaignId() { return campaignId; },
    apiFetch(url, options) {
      keys.push(options.headers['Idempotency-Key']);
      return new Promise((resolve) => { resolveRequest = resolve; });
    }
  });
  loadFunctions(context, coreFunctions);

  const pending = context.ensureCampaignPptDemandRecord(12);
  campaignId = 13;
  resolveRequest(jsonResponse(201, { id: 52, campaign_id: 12, link_id: 92 }));
  await assert.rejects(pending, /活动已切换|Campaign/i);
  assert.equal(context.campaignPptDemandRecord, null);
  assert.equal(context.curDemand.demand_id, undefined);

  campaignId = 12;
  context.apiFetch = async function(url, options) {
    keys.push(options.headers['Idempotency-Key']);
    return jsonResponse(201, { id: 52, campaign_id: 12, link_id: 92 });
  };
  assert.equal(await context.ensureCampaignPptDemandRecord(12), 52);
  assert.equal(keys[0], keys[1], 'same demand content must retain its idempotency key');
});

test('linked proposal save uses the exact Campaign demand and only a valid cloned 201 response arms download', async () => {
  const context = baseContext();
  loadFunctions(context, [
    'campaignPptFingerprint',
    'campaignPptBuildHeaders',
    'prepareCampaignPptProposalRequest',
    'observeCampaignPptProposalSave',
    'campaignPptProposalVersionMatches'
  ]);
  const original = {
    method: 'POST',
    body: JSON.stringify({ demand_id: null, template_id: 'ppt_html', content: JSON.stringify(context.lastPPTOutline) })
  };

  const prepared = context.prepareCampaignPptProposalRequest('/proposals', original, 51);
  const body = JSON.parse(prepared.options.body);
  assert.equal(body.campaign_id, 12);
  assert.equal(body.demand_id, 51);
  assert.equal(body.template_id, 'ppt_html');
  assert.deepEqual(JSON.parse(body.content), context.lastPPTOutline);
  assert.match(prepared.options.headers['Idempotency-Key'], /^ppt-proposal-/);
  assert.match(prepared.options.headers['X-Request-Id'], /^ppt-proposal-request-/);

  const retry = context.prepareCampaignPptProposalRequest('/proposals', original, 51);
  assert.equal(retry.options.headers['Idempotency-Key'], prepared.options.headers['Idempotency-Key']);
  assert.notEqual(retry.options.headers['X-Request-Id'], prepared.options.headers['X-Request-Id']);

  await context.observeCampaignPptProposalSave(
    jsonResponse(201, { id: 71, campaign_id: 12, content_sha256: 'a'.repeat(64) }),
    prepared.context
  );
  assert.equal(context.campaignPptProposalVersion.proposalId, 71);
  assert.equal(context.campaignPptProposalVersion.contentSha256, 'a'.repeat(64));
  assert.equal(context.campaignPptProposalVersionMatches(context.lastPPTOutline, 12, 51), true);

  const changed = { ...context.lastPPTOutline, title: 'Changed' };
  assert.equal(context.campaignPptProposalVersionMatches(changed, 12, 51), false);
  await context.observeCampaignPptProposalSave(
    jsonResponse(201, { id: 72, campaign_id: 12, content_sha256: 'invalid' }),
    retry.context
  );
  assert.equal(context.campaignPptProposalVersion, null);
  assert.equal(context.campaignPptArchiveState.status, 'failed');
});

test('linked PPT download injects the verified immutable proposal version and keeps a stable replay key', () => {
  const context = baseContext({
    campaignPptDemandRecord: { campaignId: 12, demandId: 51 },
    campaignPptProposalVersion: null
  });
  loadFunctions(context, [
    'campaignPptFingerprint',
    'campaignPptBuildHeaders',
    'campaignPptProposalVersionMatches',
    'prepareCampaignPptDownloadRequest'
  ]);
  const outlineFingerprint = context.campaignPptFingerprint(context.lastPPTOutline);
  context.campaignPptProposalVersion = {
    campaignId: 12,
    demandId: 51,
    proposalId: 71,
    contentSha256: 'b'.repeat(64),
    outlineFingerprint
  };
  const original = {
    method: 'POST',
    body: JSON.stringify({ outline: context.lastPPTOutline, demand: { brand: 'Acme' } })
  };

  const prepared = context.prepareCampaignPptDownloadRequest('/proposal/generate-ppt', original);
  const body = JSON.parse(prepared.options.body);
  assert.equal(body.campaign_id, 12);
  assert.equal(body.proposal_id, 71);
  assert.equal(body.proposal_content_sha256, 'b'.repeat(64));
  assert.deepEqual(body.outline, context.lastPPTOutline);
  assert.deepEqual(body.demand, { brand: 'Acme' });
  assert.match(prepared.options.headers['Idempotency-Key'], /^ppt-download-/);
  assert.match(prepared.options.headers['X-Request-Id'], /^ppt-download-request-/);

  const retry = context.prepareCampaignPptDownloadRequest('/proposal/generate-ppt', original);
  assert.equal(retry.options.headers['Idempotency-Key'], prepared.options.headers['Idempotency-Key']);
  assert.notEqual(retry.options.headers['X-Request-Id'], prepared.options.headers['X-Request-Id']);
});

test('unlinked proposal and PPTX requests retain their exact legacy options object', () => {
  const context = baseContext({ getActiveCampaignId() { return null; } });
  loadFunctions(context, [
    'campaignPptFingerprint',
    'campaignPptBuildHeaders',
    'prepareCampaignPptProposalRequest',
    'prepareCampaignPptDownloadRequest'
  ]);
  const proposal = { method: 'POST', body: '{"legacy":true}' };
  const download = { method: 'POST', body: '{"outline":{}}' };
  assert.equal(context.prepareCampaignPptProposalRequest('/proposals', proposal, null).options, proposal);
  assert.equal(context.prepareCampaignPptDownloadRequest('/proposal/generate-ppt', download).options, download);
});

test('Campaign editor wrappers invalidate changed outlines and downloads are single-flight', async () => {
  let originalDownloads = 0;
  let ensureCalls = 0;
  let releaseEnsure;
  const context = baseContext({
    campaignPptProposalVersion: {
      campaignId: 12,
      demandId: 51,
      proposalId: 71,
      contentSha256: 'c'.repeat(64),
      outlineFingerprint: ''
    },
    document: { readyState: 'complete' },
    downloadPPTX: async function() { originalDownloads += 1; },
    savePPTEditorAndRender: function() { context.lastPPTOutline.title = 'Edited title'; },
    previewEditedPPT: function() {},
    addPPTEditorSlide: function() {},
    duplicatePPTEditorSlide: function() {},
    deletePPTEditorSlide: function() {},
    movePPTEditorSlide: function() {},
    selectPPTEditorSlide: function() {},
    ensureCampaignPptProposalVersion() {
      ensureCalls += 1;
      return new Promise((resolve) => { releaseEnsure = resolve; });
    }
  });
  context.campaignPptProposalVersion.outlineFingerprint = JSON.stringify(context.lastPPTOutline);
  loadFunctions(context, [
    'campaignPptFingerprint',
    'invalidateCampaignPptProposalVersion',
    'installCampaignPptArtifactBridge'
  ]);

  context.installCampaignPptArtifactBridge();
  const first = context.window.downloadPPTX();
  const second = context.window.downloadPPTX();
  assert.equal(ensureCalls, 1);
  releaseEnsure(context.campaignPptProposalVersion);
  await Promise.all([first, second]);
  assert.equal(originalDownloads, 1);

  context.window.savePPTEditorAndRender();
  assert.equal(context.campaignPptProposalVersion, null);
  assert.equal(context.campaignPptArchiveState.status, 'dirty');
});

test('Campaign switch and auth cleanup clear artifact state while frozen PPT bytes remain unchanged', () => {
  assert.match(extractFunction(appSource, 'setWorkflowContext'), /resetCampaignPptArtifactState\(\)/);
  assert.match(extractFunction(appSource, 'handleAuthExpired'), /resetCampaignPptArtifactState\(\)/);
  assert.match(extractFunction(appSource, 'doLogout'), /resetCampaignPptArtifactState\(\)/);
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(pptPath)).digest('hex'),
    'f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e'
  );
});
