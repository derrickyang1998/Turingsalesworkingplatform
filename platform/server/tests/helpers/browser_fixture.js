'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensureSafeFixtureDirectory,
  resolveSafeFixturePath
} = require('./safe_fixture_paths');
const influencerWorkflow = require('../../services/influencer_workflow_service');

const BASELINE_FIXTURE_VERSION = 'v0.2.9-ui-fixture-1';
const MASK_VERSION = 'v0.2.9-mask-1';
const FROZEN_ROUTE_COUNT = 106;
const FROZEN_DUPLICATE_COUNT = 39;
const CURRENT_ROUTE_COUNT = 113;
const FROZEN_ISO = '2026-07-13T10:00:00.000+08:00';
const RANDOM_VALUE = 0.3141592653589793;

const defaultRepoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const fixturePath = path.join(defaultRepoRoot, 'platform', 'server', 'tests', 'fixtures', 'browser-baseline-data.json');

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function safeSegment(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._-]+$/.test(text) || text === '.' || text === '..') {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return text;
}

function readJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadBaselineFixture() {
  const fixture = readJsonFile(fixturePath, 'Task 3 browser baseline fixture data');
  if (fixture.version !== BASELINE_FIXTURE_VERSION) {
    throw new Error(`Fixture version must be ${BASELINE_FIXTURE_VERSION}; got ${fixture.version}`);
  }
  return fixture;
}

function loadBaselineManifest(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot);
  const baselineVersion = safeSegment(options.baselineVersion || 'v0.2.9', 'baseline version');
  const manifestPath = path.join(repoRoot, 'docs', 'baselines', baselineVersion, 'ui-ppt-manifest.json');
  const manifest = readJsonFile(manifestPath, 'Task 3 UI/PPT baseline manifest');
  if (!Array.isArray(manifest.screenshotSlots) || manifest.screenshotSlots.length !== 72) {
    throw new Error(`Baseline manifest must define 72 screenshot slots; got ${manifest.screenshotSlots && manifest.screenshotSlots.length}`);
  }
  if (!manifest.preEdit || !Array.isArray(manifest.preEdit.routeContracts)) {
    throw new Error('Baseline manifest must retain the frozen pre-edit route contracts');
  }
  if (manifest.preEdit.routeContracts.length !== FROZEN_ROUTE_COUNT) {
    throw new Error(`Pre-edit baseline must preserve ${FROZEN_ROUTE_COUNT} route contracts; got ${manifest.preEdit.routeContracts.length}`);
  }
  if (manifest.preEdit.duplicateInventory.reviewedDuplicateCount !== FROZEN_DUPLICATE_COUNT) {
    throw new Error(`Pre-edit baseline must preserve the ${FROZEN_DUPLICATE_COUNT} duplicate inventory; got ${manifest.preEdit.duplicateInventory.reviewedDuplicateCount}`);
  }
  if (!Array.isArray(manifest.routeContracts) || manifest.routeContracts.length !== CURRENT_ROUTE_COUNT) {
    throw new Error(`Current manifest must define ${CURRENT_ROUTE_COUNT} route contracts; got ${manifest.routeContracts && manifest.routeContracts.length}`);
  }
  if (
    manifest.duplicateInventory.reviewedDuplicateCount !== 1
    || manifest.duplicateInventory.duplicates.length !== 1
    || manifest.duplicateInventory.duplicates[0] !== 'esc'
  ) {
    throw new Error('Current manifest must preserve only the reviewed esc duplicate');
  }
  return manifest;
}

function getBaselineRunContext(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot);
  const baselineVersion = safeSegment(options.baselineVersion || 'v0.2.9', 'baseline version');
  const sddRoot = path.join(repoRoot, '.superpowers', 'sdd');
  const outputRoot = path.resolve(process.env.TM_BASELINE_OUTPUT_DIR || path.join(sddRoot, 'browser-baseline-current'));
  const superpowersRoot = ensureSafeFixtureDirectory(repoRoot, path.join(repoRoot, '.superpowers'), 'private test root');
  ensureSafeFixtureDirectory(superpowersRoot, sddRoot, 'private test data root');
  ensureSafeFixtureDirectory(sddRoot, outputRoot, 'browser baseline output');
  return {
    repoRoot,
    baselineVersion,
    outputRoot,
    runLabel: path.basename(outputRoot),
    metadataPath: path.join(outputRoot, 'run-metadata.json')
  };
}

function readMetadata(context) {
  if (!fs.existsSync(context.metadataPath)) {
    return {
      schemaVersion: 1,
      baselineVersion: context.baselineVersion,
      fixtureVersion: BASELINE_FIXTURE_VERSION,
      maskVersion: MASK_VERSION,
      runLabel: context.runLabel,
      frozenAt: FROZEN_ISO,
      environments: {},
      knownGaps: []
    };
  }
  return JSON.parse(fs.readFileSync(context.metadataPath, 'utf8'));
}

function writeMetadata(context, patcher) {
  const metadata = readMetadata(context);
  patcher(metadata);
  resolveSafeFixturePath(context.outputRoot, context.metadataPath, 'browser baseline metadata');
  fs.writeFileSync(context.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function installBaselineBrowserControls(page, { fixture, motionProfile = 'baseline' }) {
  if (!['baseline', 'native'].includes(motionProfile)) {
    throw new Error(`Unsupported browser fixture motion profile: ${motionProfile}`);
  }
  page.__baselineUnhandledApiCalls = [];
  page.__baselineUnhandledNetworkRequests = [];
  page.__baselinePageErrors = [];
  page.on('pageerror', (error) => {
    page.__baselinePageErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') page.__baselinePageErrors.push(message.text());
  });

  await page.addInitScript(({ frozenIso, randomValue, maskSelectors, motionProfile: profile }) => {
    const fixedMs = Date.parse(frozenIso);
    const NativeDate = Date;
    class FrozenDate extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedMs]));
      }
      static now() {
        return fixedMs;
      }
      static parse(value) {
        return NativeDate.parse(value);
      }
      static UTC(...args) {
        return NativeDate.UTC(...args);
      }
    }
    Object.defineProperty(window, 'Date', { value: FrozenDate });
    Math.random = () => randomValue;

    if (profile === 'baseline') {
      const nativeMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const normalized = String(query || '').replace(/\s+/g, ' ').trim();
        if (normalized === '(prefers-reduced-motion: reduce)') {
          return {
            matches: true,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false; }
          };
        }
        if (normalized === '(prefers-reduced-motion: no-preference)') {
          return {
            matches: false,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false; }
          };
        }
        return nativeMatchMedia(query);
      };
    }

    window.__tmBaseline = {
      frozenAt: frozenIso,
      randomValue,
      maskSelectors,
      motionProfile: profile,
      ready: false
    };

    if (profile === 'native') return;

    document.addEventListener('tm:navigation-applied', () => {
      const heading = document.querySelector('.page.active h2');
      if (heading) heading.style.outline = 'none';
    });

    const css = `
*,*::before,*::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
}
${maskSelectors.join(',')} {
  color: transparent !important;
  text-shadow: none !important;
}
${maskSelectors.join(',')}::after {
  color: #777 !important;
  content: "[masked]";
}
`;
    function installStyle() {
      if (document.getElementById('tm-baseline-disable-motion')) return;
      const style = document.createElement('style');
      style.id = 'tm-baseline-disable-motion';
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    }
    if (document.documentElement) installStyle();
    document.addEventListener('DOMContentLoaded', installStyle, { once: true });
  }, {
    frozenIso: fixture.frozenTime,
    randomValue: RANDOM_VALUE,
    maskSelectors: fixture.mask.selectors,
    motionProfile
  });
}

function jsonResponse(data, status = 200) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(data)
  };
}

function textResponse(body, contentType = 'text/plain; charset=utf-8', status = 200) {
  return { status, contentType, body: String(body) };
}

function userForAuthorization(request, fixture) {
  const auth = request.headers().authorization || '';
  if (auth === `Bearer ${fixture.auth.admin.token}`) return fixture.auth.admin.user;
  if (auth === `Bearer ${fixture.auth.user.token}`) return fixture.auth.user.user;
  return null;
}

function cloneFixtureApiState(fixture) {
  return JSON.parse(JSON.stringify(fixture));
}

function requestJson(request) {
  try {
    return request.postDataJSON() || {};
  } catch (e) {
    try { return JSON.parse(request.postData() || '{}'); } catch (e2) { return {}; }
  }
}

function like(value, needle) {
  if (!needle) return true;
  return String(value === undefined || value === null ? '' : value).toLowerCase().includes(String(needle).toLowerCase());
}

function numberValue(value) {
  const parsed = Number(String(value || '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function activeInfluencers(fixture) {
  return fixture.influencers.filter((row) => row.is_active !== 0);
}

function influencerMatchesSearch(row, search) {
  if (!search) return true;
  return [
    row.id,
    row.kol_handle,
    row.profile_link,
    row.content_style,
    row.brand_collab_history,
    row.project_name,
    row.product_name,
    row.tags,
    row.category,
    row.platform,
    row.region,
    row.contact_email,
    row.content_deliverable,
    row.influencer_type,
    row.parent_record,
    row.followers,
    row.avg_views_10,
    row.cost_usd,
    row.quoted_price,
    row.cpm,
    row.cpv
  ].some((value) => like(value, search));
}

function queryInfluencersFixture(fixture, filters) {
  filters = filters || {};
  let rows = activeInfluencers(fixture);
  if (filters.platform) rows = rows.filter((row) => row.platform === filters.platform);
  if (filters.category) rows = rows.filter((row) => row.category === filters.category);
  if (filters.region) rows = rows.filter((row) => row.region === filters.region);
  if (filters.project_name) rows = rows.filter((row) => like(row.project_name, filters.project_name));
  if (filters.product_name) rows = rows.filter((row) => like(row.product_name, filters.product_name));
  if (filters.tags) rows = rows.filter((row) => like(row.tags, filters.tags) || like(row.category, filters.tags));
  if (filters.search) rows = rows.filter((row) => influencerMatchesSearch(row, filters.search));
  if (filters.min_followers) rows = rows.filter((row) => Number(row.followers || 0) >= Number(filters.min_followers));
  if (filters.max_followers) rows = rows.filter((row) => Number(row.followers || 0) <= Number(filters.max_followers));
  const sortBy = ['engagement', 'followers', 'cost_usd'].includes(filters.sort_by) ? filters.sort_by : 'followers';
  rows = rows.slice().sort((a, b) => Number(b[sortBy] || 0) - Number(a[sortBy] || 0));
  return rows.slice(0, 200);
}

function parseCsvLine(line) {
  const values = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      values.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  values.push(cell);
  if (values.length) values[0] = values[0].replace(/^\uFEFF/, '');
  return values;
}

function parseCsvRows(csv) {
  return String(csv || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseCsvLine);
}

function csvFromInfluencers(rows) {
  return influencerWorkflow.buildInfluencerCsv(rows);
}

function templateCsvFromFixture() {
  return influencerWorkflow.buildTemplateCsv();
}

function csvFromUploadRequest(request) {
  const body = request.postDataBuffer();
  if (!body) return '';
  const text = body.toString('utf8');
  const header = influencerWorkflow.TEMPLATE_HEADERS.join(',');
  const start = text.indexOf(header);
  if (start < 0) return '';
  let csv = text.slice(start);
  const boundaryMatch = /\r?\n--[-A-Za-z0-9]+/.exec(csv);
  if (boundaryMatch) csv = csv.slice(0, boundaryMatch.index);
  return csv.trim() + '\n';
}

function fixtureInfluencerFromTemplateRow(values, fixture) {
  const nextId = Math.max(0, ...fixture.influencers.map((row) => Number(row.id) || 0)) + 1;
  return {
    id: nextId,
    platform: values[8] || '',
    kol_handle: values[5] || '',
    profile_link: values[7] || '',
    followers: numberValue(values[6]),
    avg_views_10: numberValue(values[11]),
    avg_engagement: 0,
    category: values[10] || '',
    sub_category: '',
    region: values[9] || '',
    language: '',
    content_style: '',
    collab_type: values[13] || '',
    cost_usd: numberValue(values[12]),
    quoted_price: numberValue(values[15]),
    brand_collab_history: values[14] || '',
    contact_email: values[16] || '',
    project_name: values[2] || '',
    product_name: values[3] || '',
    reporter: values[1] || '',
    tags: values[10] || '',
    content_deliverable: values[13] || '',
    influencer_type: values[10] || '',
    cpm: numberValue(values[17]),
    cpv: numberValue(values[18]),
    parent_record: values[19] || '',
    is_duplicate: /^(yes|true|1|是|重复)$/i.test(values[4] || '') ? 1 : 0,
    is_active: 1
  };
}

function importInfluencersFromCsv(fixture, csv) {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return [];
  const imported = rows.slice(1).map((values) => fixtureInfluencerFromTemplateRow(values, fixture));
  fixture.influencers.push(...imported);
  return imported;
}

function collaborationStatsFromFixture(fixture) {
  const counts = new Map();
  for (const row of fixture.collaborations) counts.set(row.status, (counts.get(row.status) || 0) + 1);
  const byStatus = Array.from(counts, ([status, count]) => ({ status, count }));
  return {
    stats: {
      byStatus,
      totalActive: fixture.collaborations.filter((row) => ['proposed', 'contacted', 'negotiating', 'confirmed', 'contract_sent', 'live', 'content_review'].includes(row.status)).length,
      totalCompleted: fixture.collaborations.filter((row) => row.status === 'completed').length,
      totalCost: fixture.collaborations.reduce((sum, row) => sum + Number(row.cost_actual || row.cost_quoted || 0), 0)
    }
  };
}

function collaborationWithInfluencer(fixture, body) {
  const influencer = fixture.influencers.find((row) => Number(row.id) === Number(body.influencer_id)) || {};
  const resource = body.resource && typeof body.resource === 'object' ? body.resource : {};
  const nextId = Math.max(0, ...fixture.collaborations.map((row) => Number(row.id) || 0)) + 1;
  return {
    id: nextId,
    influencer_id: Number(body.influencer_id),
    kol_handle: influencer.kol_handle || '',
    platform: influencer.platform || '',
    followers: influencer.followers || 0,
    category: influencer.category || '',
    region: influencer.region || '',
    project_name: influencer.project_name || '',
    product_name: influencer.product_name || '',
    content_deliverable: influencer.content_deliverable || '',
    quoted_price: influencer.quoted_price || 0,
    status: body.status || 'proposed',
    cost_quoted: Number(body.cost_quoted || resource.quoted_price || 0),
    timeline_start: body.timeline_start || '',
    timeline_end: body.timeline_end || '',
    notes: body.notes || '',
    proposal_notes: body.proposal_notes || JSON.stringify(resource),
    updated_at: FROZEN_ISO
  };
}

function apiResponseFor(request, fixture, recorder) {
  const url = new URL(request.url());
  const apiPath = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method().toUpperCase();
  const ok = (data) => jsonResponse(data);
  const record = typeof recorder === 'function' ? recorder : function() {};

  if (method === 'GET' && apiPath === '/health') return ok({ status: 'ok', timestamp: fixture.frozenTime });
  if (method === 'GET' && apiPath === '/auth/me') {
    const user = userForAuthorization(request, fixture);
    return user ? ok({ user }) : jsonResponse({ error: 'Fixture auth required' }, 401);
  }
  if (method === 'POST' && apiPath === '/auth/login') {
    return ok({ token: fixture.auth.admin.token, user: fixture.auth.admin.user });
  }
  if (method === 'POST' && apiPath === '/auth/logout') return ok({ success: true });

  if (method === 'GET' && apiPath === '/brands') return ok({ brands: fixture.brands });
  if (method === 'POST' && apiPath === '/brands/enrich') return ok({ success: true, brand: fixture.brands[0] });
  if (method === 'GET' && apiPath === '/brands/social-search') return ok(fixture.brandSocialSearch);

  if (method === 'GET' && apiPath === '/customers') return ok({ customers: fixture.customers, total: fixture.customers.length });
  if (method === 'GET' && apiPath === '/customers/stats') return ok(fixture.customerStats);
  if (method === 'GET' && apiPath === '/customers/sea-pool') return ok({ customers: fixture.seaPoolCustomers });
  if (method === 'GET' && apiPath === '/customers/dashboard') return ok(fixture.customerDashboard);
  if (method === 'GET' && /^\/customers\/\d+\/detail$/.test(apiPath)) {
    return ok(fixture.customerDetail);
  }
  if (['POST', 'PUT', 'DELETE'].includes(method) && /^\/customers(?:\/\d+(?:\/(?:assign|return|return-pool|archive-result|activity))?)?$/.test(apiPath)) {
    return ok({ success: true, id: fixture.customers[0].id });
  }

  if (method === 'GET' && apiPath === '/opportunities') return ok({ rows: fixture.opportunities, opportunities: fixture.opportunities, total: fixture.opportunities.length });
  if (['POST', 'PUT', 'DELETE'].includes(method) && /^\/opportunities(?:\/\d+)?$/.test(apiPath)) return ok({ success: true, id: fixture.opportunities[0].id });
  if (method === 'GET' && apiPath === '/sales-targets') return ok({ targets: fixture.salesTargets });
  if (method === 'GET' && apiPath === '/sales-performance') return ok(fixture.salesPerformance);
  if (method === 'GET' && apiPath === '/dashboard/sales') return ok(fixture.salesDashboard);
  if (method === 'GET' && apiPath === '/dashboard/stats') return ok(fixture.dashboardStats);

  if (method === 'GET' && apiPath === '/campaigns') {
    let campaigns = Array.isArray(fixture.campaigns) ? fixture.campaigns.slice() : [];
    const operationalStatus = url.searchParams.get('operational_status');
    if (operationalStatus) {
      campaigns = campaigns.filter((campaign) => campaign.operational_status === operationalStatus);
    }
    const limit = Number(url.searchParams.get('limit')) || 25;
    const offset = Number(url.searchParams.get('offset')) || 0;
    return ok({
      items: campaigns.slice(offset, offset + limit),
      total: campaigns.length,
      limit,
      offset
    });
  }
  if (method === 'GET' && /^\/campaigns\/\d+$/.test(apiPath)) {
    const campaignId = Number(apiPath.split('/').pop());
    const campaign = (fixture.campaigns || []).find((item) => Number(item.id) === campaignId);
    return campaign ? ok({ campaign }) : jsonResponse({ error: 'Fixture campaign not found' }, 404);
  }

  if (method === 'GET' && apiPath === '/influencers') {
    const influencers = queryInfluencersFixture(fixture, Object.fromEntries(url.searchParams.entries()));
    return ok({ influencers, total: influencers.length });
  }
  if (method === 'POST' && apiPath === '/influencers/match') return ok({ matches: queryInfluencersFixture(fixture, requestJson(request)) });
  if (method === 'GET' && apiPath === '/influencers/template') return textResponse(fixture.csv.influencerTemplate || templateCsvFromFixture(), 'text/csv; charset=utf-8');
  if (method === 'POST' && apiPath === '/influencers/export') {
    const body = requestJson(request);
    let rows = activeInfluencers(fixture);
    if (body.mode === 'selected') {
      const selected = new Set((Array.isArray(body.ids) ? body.ids : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0));
      rows = selected.size ? rows.filter((row) => selected.has(Number(row.id))) : [];
    } else if (body.mode === 'filtered') {
      rows = queryInfluencersFixture(fixture, body.filters || {});
    } else {
      rows = rows.slice().sort((a, b) => Number(b.followers || 0) - Number(a.followers || 0));
    }
    return textResponse(csvFromInfluencers(rows), 'text/csv; charset=utf-8');
  }
  if (method === 'POST' && apiPath === '/influencers/feishu/sync') {
    const body = requestJson(request);
    const selected = new Set((Array.isArray(body.ids) ? body.ids : []).map(Number));
    const rows = activeInfluencers(fixture).filter((row) => selected.has(Number(row.id)));
    return ok({
      configured: false,
      records: rows.length,
      csv: csvFromInfluencers(rows),
      message: 'FEISHU_WEBHOOK_URL is not configured. CSV fallback is ready for manual upload.'
    });
  }
  if (method === 'GET' && apiPath === '/feishu/status') {
    return ok({
      configured: false,
      mode: 'unconfigured',
      sync_available: false,
      test_available: false,
      missing: ['FEISHU_WEBHOOK_URL_OR_BITABLE_CONFIG']
    });
  }
  if (method === 'POST' && apiPath === '/feishu/test') {
    return jsonResponse({ error: 'Feishu connection test is not configured.', code: 'FEISHU_TEST_NOT_CONFIGURED' }, 409);
  }
  if (method === 'POST' && apiPath === '/influencers/upload') {
    const imported = importInfluencersFromCsv(fixture, csvFromUploadRequest(request));
    return ok({ success: true, imported: imported.length, skipped: 0, sample: imported.slice(0, 5) });
  }
  if (method === 'POST' && apiPath === '/influencers/import') {
    const body = requestJson(request);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    return ok({ success: true, imported: rows.length, skipped: 0, sample: rows.slice(0, 5) });
  }
  if (['POST', 'PUT'].includes(method) && /^\/influencers(?:\/\d+)?$/.test(apiPath)) {
    return ok({ success: true, imported: fixture.influencers.length, skipped: 0, sample: fixture.influencers });
  }
  if (method === 'GET' && apiPath === '/collaborations') {
    let collaborations = fixture.collaborations.slice();
    const status = url.searchParams.get('status');
    if (status) collaborations = collaborations.filter((row) => row.status === status);
    record({
      type: 'collaboration-list',
      collaborations: collaborations.map((row) => ({
        id: Number(row.id),
        status: row.status,
        notes: row.notes || ''
      }))
    });
    return ok({ collaborations });
  }
  if (method === 'GET' && apiPath === '/collaborations/stats') return ok(collaborationStatsFromFixture(fixture));
  if (method === 'POST' && apiPath === '/collaborations') {
    const collab = collaborationWithInfluencer(fixture, requestJson(request));
    fixture.collaborations.unshift(collab);
    return ok({ success: true, id: collab.id });
  }
  if (method === 'PUT' && /^\/collaborations\/\d+$/.test(apiPath)) {
    const id = Number(apiPath.split('/').pop());
    const body = requestJson(request);
    const collab = fixture.collaborations.find((row) => Number(row.id) === id);
    if (collab) {
      if (body.status) collab.status = body.status;
      if (body.notes !== undefined) collab.notes = body.notes;
      if (body.cost_quoted !== undefined) collab.cost_quoted = body.cost_quoted;
      collab.updated_at = FROZEN_ISO;
    }
    record({
      type: 'collaboration-status-put',
      id,
      body,
      status: collab && collab.status
    });
    return ok({ success: true, id });
  }

  if (method === 'GET' && apiPath === '/demands') return ok({ demands: fixture.demands });
  if (method === 'GET' && apiPath === '/proposals') return ok({ proposals: fixture.proposals });
  if (method === 'POST' && apiPath === '/demands') return ok({ id: fixture.demands[0].id });
  if (method === 'POST' && apiPath === '/proposals') return ok({ id: fixture.proposals[0].id });
  if (method === 'POST' && apiPath === '/demand/parse-file') return ok(fixture.ai.demandParse);
  if (method === 'POST' && apiPath === '/ai/demand-analysis') return ok(fixture.ai.demandAnalysis);
  if (method === 'POST' && apiPath === '/ai/ppt-outline') return ok(fixture.ai.pptOutline);
  if (method === 'POST' && apiPath === '/ai/proposal-draft') return ok(fixture.ai.proposalDraft);
  if (method === 'POST' && apiPath === '/ai/strategy') return ok(fixture.ai.strategy);
  if (method === 'POST' && apiPath === '/ai/chat') return ok(fixture.ai.chat);
  if (method === 'POST' && apiPath === '/proposal/generate-ppt') return ok(fixture.ai.generatedPpt);

  if (method === 'GET' && apiPath === '/knowledge') return ok({ entries: fixture.knowledge.entries, total: fixture.knowledge.entries.length });
  if (method === 'GET' && apiPath === '/knowledge/search') return ok({ results: fixture.knowledge.entries });
  if (method === 'GET' && apiPath === '/knowledge/similar') return ok({ results: fixture.knowledge.entries });
  if (method === 'GET' && apiPath === '/knowledge/categories') return ok({ categories: fixture.knowledge.categories });
  if (['POST', 'PUT'].includes(method) && /^\/knowledge(?:\/\d+\/use|\/ingest|\/upload)?$/.test(apiPath)) return ok({ success: true, id: fixture.knowledge.entries[0].id });
  if (method === 'POST' && apiPath.startsWith('/admin/knowledge/')) return ok({ success: true, imported: 1 });

  if (method === 'GET' && apiPath === '/admin/overview') return ok({ stats: fixture.admin.overview });
  if (method === 'GET' && apiPath === '/admin/users') return ok({ users: fixture.users });
  if (method === 'POST' && apiPath === '/admin/invites') return ok({ code: 'FIXTURE-INVITE' });
  if (method === 'POST' && /^\/admin\/users\/reset-password\/\d+$/.test(apiPath)) return ok({ temporary_password: 'fixture-reset-password' });
  if (['POST', 'PUT', 'DELETE'].includes(method) && /^\/admin\/users(?:\/\d+)?$/.test(apiPath)) return ok({ success: true });
  if (method === 'GET' && apiPath === '/token-usage') return ok({ usage: fixture.tokenUsage });
  if (method === 'POST' && apiPath === '/token-usage') return ok({ success: true });
  if (method === 'GET' && apiPath === '/users') return ok({ users: fixture.users });
  if (method === 'POST' && apiPath === '/auth/register') return ok({ success: true, id: fixture.users[0].id });

  if (method === 'GET' && apiPath === '/ai/conversations') return ok({ conversations: fixture.ai.conversations });
  if (method === 'GET' && /^\/ai\/conversations\/\d+$/.test(apiPath)) return ok({ conversation: fixture.ai.conversationDetail });

  if (method === 'GET' && apiPath === '/workflow/templates') return ok({ templates: fixture.workflow.templates });
  if (method === 'GET' && /^\/workflow\/templates\/\d+$/.test(apiPath)) return ok({ template: fixture.workflow.templates[0] });
  if (method === 'GET' && apiPath === '/workflow/instances') return ok({ instances: fixture.workflow.instances });
  if (method === 'GET' && apiPath === '/workflow/instances/by-business') return ok({ instances: fixture.workflow.instances });
  if (method === 'GET' && /^\/workflow\/instances\/\d+$/.test(apiPath)) return ok(fixture.workflow.instanceDetail);
  if (method === 'GET' && apiPath === '/workflow/tasks') return ok({ tasks: fixture.workflow.tasks });
  if (method === 'GET' && /^\/workflow\/tasks\/\d+$/.test(apiPath)) return ok({ task: fixture.workflow.tasks[0] });
  if (method === 'GET' && apiPath === '/workflow/stats') return ok(fixture.workflow.stats);
  if (['POST', 'PUT', 'DELETE'].includes(method) && apiPath.startsWith('/workflow/')) return ok({ success: true, id: fixture.workflow.templates[0].id });

  return null;
}

function classifyFixtureRequest(requestUrl, expectedOrigin) {
  const url = new URL(requestUrl);
  if (url.origin !== expectedOrigin) return 'external';
  return url.pathname.startsWith('/api/') ? 'api' : 'static';
}

function fixtureScenarioResponse(request, scenario) {
  const url = new URL(request.url());
  const apiPath = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method().toUpperCase();

  if (scenario.loginFailure && method === 'POST' && apiPath === '/auth/login') {
    const failure = scenario.loginFailure === true ? {} : scenario.loginFailure;
    return jsonResponse(
      { error: failure.error || 'Fixture invalid credentials' },
      Number(failure.status || 401)
    );
  }

  const expiry = scenario.expireNextApi;
  if (!expiry || scenario.expiryConsumed) return null;
  const expectedPath = typeof expiry === 'string' ? expiry : expiry.path;
  const expectedMethod = typeof expiry === 'string' ? null : expiry.method;
  const normalizedPath = expectedPath && String(expectedPath).replace(/^\/api/, '');
  if (normalizedPath && normalizedPath !== apiPath) return null;
  if (expectedMethod && String(expectedMethod).toUpperCase() !== method) return null;
  scenario.expiryConsumed = true;
  return jsonResponse({ error: 'Fixture session expired' }, 401);
}

async function installFixtureApi(page, {
  fixture,
  loginFailure = null,
  expireNextApi = null,
  routingScope = 'page',
  expectedOrigin = null
}) {
  if (!['page', 'context'].includes(routingScope)) {
    throw new Error(`Unsupported fixture routing scope: ${routingScope}`);
  }
  const port = Number(process.env.TM_BROWSER_FIXTURE_PORT || 43187);
  const allowedOrigin = expectedOrigin || `http://127.0.0.1:${port}`;
  const fixtureState = cloneFixtureApiState(fixture);
  const scenario = { loginFailure, expireNextApi, expiryConsumed: false };
  page.__tmTask9M4Calls = [];
  let task9M4CallIndex = 0;
  const recordTask9M4Call = (event) => {
    task9M4CallIndex += 1;
    page.__tmTask9M4Calls.push(Object.assign({ index: task9M4CallIndex }, event));
  };
  page.__tmFixtureScenario = scenario;
  const routeOwner = routingScope === 'context' ? page.context() : page;
  await routeOwner.route('**/*', async (route) => {
    const request = route.request();
    const classification = classifyFixtureRequest(request.url(), allowedOrigin);
    if (classification === 'external') {
      const url = new URL(request.url());
      page.__baselineUnhandledNetworkRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    if (classification === 'static') {
      await route.continue();
      return;
    }
    const response = fixtureScenarioResponse(route.request(), scenario)
      || apiResponseFor(route.request(), fixtureState, recordTask9M4Call);
    if (!response) {
      const url = new URL(request.url());
      page.__baselineUnhandledApiCalls.push(`${request.method()} ${url.pathname}${url.search}`);
      await route.fulfill(jsonResponse({ error: 'Unstubbed fixture API route' }, 500));
      return;
    }
    await route.fulfill(response);
  });
}

async function installBaselineAuthState(page, auth) {
  await page.addInitScript(({ authState }) => {
    localStorage.clear();
    if (authState) {
      localStorage.setItem('tm_token', authState.token);
      localStorage.setItem('tm_user', JSON.stringify(authState.user));
    }
  }, { authState: auth });
}

async function navigateBaselineJourney(page, journey, { fixture }) {
  const auth = journey.role === 'admin' ? fixture.auth.admin : journey.role === 'user' ? fixture.auth.user : null;
  await installBaselineAuthState(page, auth);

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  if (!auth) {
    await page.locator('#authOverlay').waitFor({ state: 'visible' });
    return;
  }

  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => typeof window.switchPage === 'function');
  await page.evaluate(({ pageId, substate }) => {
    window.switchPage(pageId);
    if (pageId === 'm0-detail' && substate && substate.view && typeof window.switchCrmView === 'function') {
      window.switchCrmView(substate.view);
    }
    if (pageId === 'm4' && substate && substate.tab && typeof window.switchTab === 'function') {
      window.switchTab(substate.tab);
    }
    if (pageId === 'admin' && substate && substate.tab && typeof window.switchAdminTab === 'function') {
      window.switchAdminTab(substate.tab);
    }
  }, { pageId: journey.pageId, substate: journey.substate || null });
  await page.locator(`#page-${journey.pageId}`).waitFor({ state: 'visible' });
}

async function maskDynamicContent(page) {
  await page.evaluate(() => {
    const selectors = (window.__tmBaseline && window.__tmBaseline.maskSelectors) || [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = '[masked]';
        } else {
          element.textContent = '[masked]';
        }
        if (element instanceof HTMLAnchorElement) element.href = 'https://fixture.invalid/masked';
      });
    }

    const textPatterns = [
      [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'masked@example.invalid'],
      [/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, 'https://fixture.invalid/link'],
      [/\b(?:sk|tvly)-[A-Za-z0-9_-]{12,}\b/g, '[secret-mask]'],
      [/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/g, '[secret-mask]'],
      [/\b20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b/g, '[date-mask]']
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      let value = node.nodeValue || '';
      for (const [pattern, replacement] of textPatterns) value = value.replace(pattern, replacement);
      node.nodeValue = value;
    }
  });
}

async function waitForBaselineReady(page, { maskDynamicContent: shouldMaskDynamicContent = true } = {}) {
  await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(100);
  if (shouldMaskDynamicContent) await maskDynamicContent(page);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (page.__baselineUnhandledApiCalls.length) {
    throw new Error(`Unstubbed baseline API calls: ${page.__baselineUnhandledApiCalls.join(', ')}`);
  }
  if (page.__baselineUnhandledNetworkRequests.length) {
    throw new Error(`Unexpected baseline network requests: ${page.__baselineUnhandledNetworkRequests.join(', ')}`);
  }
  if (page.__baselinePageErrors.length) {
    throw new Error(`Baseline page errors: ${page.__baselinePageErrors.join(' | ')}`);
  }
}

async function recordBaselineEnvironment(page, browser, testInfo, context) {
  const browserPath = browser.browserType().executablePath();
  const revision = (browserPath.match(/chromium-(\d+)/i) || [])[1] || null;
  const browserVersion = browser.version();
  const client = await page.evaluate(() => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    return {
      locale: options.locale,
      timezone: options.timeZone,
      colorScheme: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
      deviceScaleFactor: window.devicePixelRatio,
      fonts: {
        'Segoe UI': document.fonts.check('12px "Segoe UI"'),
        'Microsoft YaHei': document.fonts.check('12px "Microsoft YaHei"')
      }
    };
  });
  const environment = {
    os: os.platform() === 'win32' ? 'Windows' : os.platform(),
    arch: os.arch(),
    browserName: browser.browserType().name(),
    browserVersion,
    browserRevision: revision,
    project: testInfo.project.name,
    viewport: testInfo.project.use.viewport,
    ...client
  };
  writeMetadata(context, (metadata) => {
    metadata.environments[testInfo.project.name] = environment;
  });
  return environment;
}

async function recordKnownBaselineGaps(_page, _journey, context) {
  const gaps = [
    {
      contract: 'direct-path',
      status: 'known-baseline-gap',
      ownerTask: 6,
      reason: 'Pre-edit navigation is DOM-only; the baseline uses window.switchPage instead of URL restoration.',
      observed: 'Opening /m4 preserves the path but initializes the default CRM board instead of M4.'
    },
    {
      contract: 'refresh-restore',
      status: 'known-baseline-gap',
      ownerTask: 6,
      reason: 'Pre-edit substate is not serialized, so refresh does not restore CRM/M4/admin subviews.',
      observed: 'Reloading M4 tab 2 returns to the default CRM board.'
    },
    {
      contract: 'back-forward',
      status: 'known-baseline-gap',
      ownerTask: 6,
      reason: 'Pre-edit switchPage does not push browser history entries.',
      observed: 'A popstate from /m0 to /m4 changes the URL but leaves the CRM board visible.'
    },
    {
      contract: 'heading-focus',
      status: 'known-baseline-gap',
      ownerTask: 6,
      reason: 'Pre-edit page switches do not move focus to the active page heading.',
      observed: 'After switching to M4, document.body remains the active element.'
    },
    {
      contract: 'admin-knowledge-loader',
      status: 'known-baseline-gap',
      ownerPhase: 6,
      reason: 'The pre-edit administrator knowledge tab renders its shell but has no loadKnowledgeBase implementation.'
    }
  ];
  writeMetadata(context, (metadata) => {
    metadata.knownGaps = metadata.knownGaps.filter((gap) => gap.contract !== 'mobile-shell-content');
    const existing = new Set(metadata.knownGaps.map((gap) => gap.contract));
    for (const gap of gaps) {
      if (!existing.has(gap.contract)) metadata.knownGaps.push(gap);
    }
  });
}

function screenshotPathForSlot(context, slot) {
  const relative = path.join(
    safeSegment(slot.role, 'role'),
    safeSegment(slot.viewport, 'viewport'),
    `${safeSegment(slot.journey, 'journey')}.png`
  );
  const target = path.join(context.outputRoot, relative);
  ensureSafeFixtureDirectory(context.outputRoot, path.dirname(target), 'browser baseline screenshot directory');
  resolveSafeFixturePath(context.outputRoot, target, 'browser baseline screenshot');
  return target;
}

function writeBaselineRunMetadata(context) {
  writeMetadata(context, (metadata) => {
    metadata.completed = true;
    metadata.expectedPngCount = 72;
    metadata.pathStyle = 'role/viewport/journey.png';
  });
}

module.exports = {
  BASELINE_FIXTURE_VERSION,
  classifyFixtureRequest,
  getBaselineRunContext,
  installBaselineBrowserControls,
  installBaselineAuthState,
  installFixtureApi,
  loadBaselineFixture,
  loadBaselineManifest,
  navigateBaselineJourney,
  recordBaselineEnvironment,
  recordKnownBaselineGaps,
  screenshotPathForSlot,
  waitForBaselineReady,
  writeBaselineRunMetadata
};
