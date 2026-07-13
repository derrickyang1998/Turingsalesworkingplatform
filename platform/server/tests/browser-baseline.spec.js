'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('playwright/test');
const {
  BASELINE_FIXTURE_VERSION,
  getBaselineRunContext,
  installBaselineAuthState,
  installBaselineBrowserControls,
  installFixtureApi,
  loadBaselineFixture,
  loadBaselineManifest,
  navigateBaselineJourney,
  recordBaselineEnvironment,
  recordKnownBaselineGaps,
  screenshotPathForSlot,
  waitForBaselineReady,
  writeBaselineRunMetadata
} = require('./helpers/browser_fixture');
const influencerWorkflow = require('../services/influencer_workflow_service');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const baselineVersion = 'v0.2.9';
const fixture = loadBaselineFixture();
const manifest = loadBaselineManifest({ repoRoot, baselineVersion });
const runContext = getBaselineRunContext({ repoRoot, baselineVersion });
const journeys = manifest.screenshotSlots
  .filter((slot) => slot.viewport === manifest.viewports[0].name)
  .map((slot) => ({
    role: slot.role,
    journey: slot.journey,
    pageId: slot.pageId,
    substate: slot.substate
  }));

function expectedPathForJourney(journey) {
  if (journey.pageId === 'login') return '/';
  if (journey.pageId === 'm0-detail') {
    return `/m0-detail?view=${(journey.substate && journey.substate.view) || 'pipeline'}`;
  }
  if (journey.pageId === 'm4') {
    return `/m4?tab=${(journey.substate && journey.substate.tab) || 'tab1'}`;
  }
  if (journey.pageId === 'admin') {
    return `/admin?tab=${(journey.substate && journey.substate.tab) || 'overview'}`;
  }
  const simplePaths = {
    m0: '/m0',
    m1: '/m1',
    m2: '/m2',
    m3: '/m3',
    m5: '/m5',
    'workflow-designer': '/workflow',
    'workflow-templates': '/workflow-templates',
    'workflow-instances': '/workflow-instances',
    'workflow-tasks': '/tasks'
  };
  return simplePaths[journey.pageId] || '/m0';
}

function stripBom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
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
  if (values.length) values[0] = stripBom(values[0]);
  return values;
}

function parseCsvRows(csv) {
  return stripBom(csv)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseCsvLine);
}

async function readDownloadCsv(download, label) {
  const target = path.join(os.tmpdir(), `tm-task9-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.csv`);
  await download.saveAs(target);
  try {
    return fs.readFileSync(target, 'utf8');
  } finally {
    fs.rmSync(target, { force: true });
  }
}

function expectApprovedCsv(csv) {
  expect(parseCsvRows(csv)[0]).toEqual(influencerWorkflow.TEMPLATE_HEADERS);
}

async function openM4(page, tab) {
  await installBaselineAuthState(page, fixture.auth.admin);
  await page.goto(`/m4?tab=${tab || 'tab1'}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => typeof window.switchPage === 'function');
  await expect(page.locator('#page-m4')).toBeVisible();
  await expectM4Tab(page, tab || 'tab1');
  await waitForBaselineReady(page);
}

async function expectM4Tab(page, tab) {
  await expect.poll(() => page.evaluate((expected) => {
    const active = document.querySelector('#tabBar .tab.active');
    const panel = document.getElementById(`${expected}-content`);
    return {
      activeTab: active && active.getAttribute('data-tab'),
      panelVisible: !!panel && !panel.classList.contains('hidden')
    };
  }, tab)).toEqual({ activeTab: tab, panelVisible: true });
}

async function expectAdminTab(page, tab) {
  await expect.poll(() => page.evaluate((expected) => {
    const panel = document.getElementById(`admin-tab-${expected}`);
    return {
      pageVisible: getComputedStyle(document.getElementById('page-admin')).display !== 'none',
      panelVisible: !!panel && getComputedStyle(panel).display !== 'none'
    };
  }, tab)).toEqual({ pageVisible: true, panelVisible: true });
}

async function expectCrmView(page, view) {
  const selectorByView = {
    pipeline: '#crmPipelineView',
    seapool: '#crmSeaPoolView',
    opportunities: '#crmOpportunityView'
  };
  await expect.poll(() => page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    return !!panel && getComputedStyle(panel).display !== 'none';
  }, selectorByView[view])).toBe(true);
}

async function expectActiveHeadingFocused(page, pageId) {
  await expect.poll(() => page.evaluate((id) => {
    const heading = document.querySelector(`#page-${id} h2`);
      return {
        focused: document.activeElement === heading,
        tagName: document.activeElement && document.activeElement.tagName,
        tabindex: heading && heading.getAttribute('tabindex'),
        outline: heading && (heading.style.outline || '')
      };
  }, pageId)).toEqual({
    focused: true,
    tagName: 'H2',
    tabindex: '-1',
    outline: 'none'
  });
}

async function prepareLockedScreenshotCapture(page, journey) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (journey.journey === 'public-login') {
    await expect.poll(() => page.evaluate(() => {
      const loginButton = document.querySelector('#authOverlay .btn-primary');
      return !!loginButton && loginButton.matches(':hover');
    }), {
      message: 'public login button must not be hovered before locked screenshot capture'
    }).toBe(false);
  }
}

async function exerciseBrandWorkspace(page) {
  await page.evaluate(() => {
    window.__tmTask8Opened = [];
    window.open = (url, target) => {
      window.__tmTask8Opened.push({ url, target });
      return null;
    };
  });

  await page.locator('#brandSearch').fill('Fixture Labs');
  await page.evaluate(() => window.filterBrands());
  await expect(page.locator('#brandResults .brand-result-item')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem('tm_brand_search_history') || '[]');
    return history[0] || null;
  })).toBe('fixture labs');

  await page.locator('#searchHistory button').first().click();
  await expect(page.locator('#brandSearch')).toHaveValue('fixture labs');

  const firstTreeParent = page.locator('.tree-parent').first();
  await expect(firstTreeParent).toBeVisible();
  await firstTreeParent.click();
  const firstTreeTag = page.locator('.tree-child').first();
  await expect(firstTreeTag).toBeVisible();
  const selectedTag = await firstTreeTag.getAttribute('data-tag');
  await firstTreeTag.click();
  await expect(firstTreeTag).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.activeTag || null)).toBe(selectedTag);

  await page.evaluate(() => {
    window.activeTag = null;
    document.querySelectorAll('.tree-child').forEach((node) => node.classList.remove('active'));
    document.getElementById('brandSearch').value = 'Fixture Labs';
    window.filterBrands();
  });
  await page.locator('#brandResults .brand-result-item').first().click();
  await expect(page.locator('#brandDetailPanel')).toContainText('Fixture Labs');

  await page.locator('#brandSocialSources button').first().click();
  await expect.poll(() => page.evaluate(() => window.__tmTask8Opened.length)).toBeGreaterThan(0);

  await page.locator('#brandDetailPanel button[onclick*="showRelatedBrands"]').click();
  await expect(page.locator('#brandRelOverlay')).toBeVisible();
  await page.locator('#brandRelOverlay .brel-tag').first().click();
  await expect(page.locator('#brandRelOverlay')).toHaveCount(0);
  await expect(page.locator('#brandSearch')).not.toHaveValue('');

  await page.locator('#brandSearch').fill('Fixture Labs');
  await page.evaluate(() => window.filterBrands());
  await page.locator('#brandResults .brand-result-item').first().click();
  await page.locator('#brandDetailPanel button[onclick*="copyBrandBriefToDemand"]').click();
  await expect(page.locator('#page-m3')).toBeVisible();
  await expect(page.locator('#d_brand')).toHaveValue('Fixture Labs');

  await page.evaluate(() => window.switchPage('m1'));
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.brand-workspace-actions button[onclick="exportBrandCSV()"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('brands.csv');

  await page.evaluate(() => {
    if (typeof closeBrandRelModal === 'function') closeBrandRelModal();
    localStorage.removeItem('tm_brand_search_history');
    window.brandSearchHistory = [];
    window.activeTag = null;
    window.selectedBrandName = '';
    const search = document.getElementById('brandSearch');
    if (search) search.value = '';
    if (typeof renderIndustryTree === 'function') renderIndustryTree();
    if (typeof filterBrands === 'function') filterBrands();
    if (typeof renderSearchHistory === 'function') renderSearchHistory();
    if (typeof selectBrand === 'function') selectBrand(0);
    const toast = document.getElementById('toastContainer');
    if (toast) toast.remove();
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    document.querySelectorAll('.brand-tree-scroll, .brand-results-list, .brand-detail-panel').forEach((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await expect(page.locator('#page-m1')).toBeVisible();
  await expect(page.locator('#searchHistory button')).toHaveCount(0);
}

test.describe('deterministic pre-edit browser baseline', () => {
  test.afterAll(() => {
    writeBaselineRunMetadata(runContext);
  });

  test.beforeEach(async ({ page }, testInfo) => {
    await installBaselineBrowserControls(page, { fixture, testInfo });
    await installFixtureApi(page, { fixture });
  });

  for (const journey of journeys) {
    test(`${journey.role} ${journey.journey}`, async ({ page, browser }, testInfo) => {
      const viewport = testInfo.project.name;
      const slot = manifest.screenshotSlots.find((candidate) => (
        candidate.viewport === viewport
        && candidate.role === journey.role
        && candidate.journey === journey.journey
      ));
      expect(slot, `${viewport}/${journey.journey} slot must exist`).toBeTruthy();

      await navigateBaselineJourney(page, journey, { fixture });
      await waitForBaselineReady(page);
      const environment = await recordBaselineEnvironment(page, browser, testInfo, runContext);

      expect(fixture.version).toBe(BASELINE_FIXTURE_VERSION);
      expect(environment.os).toBe('Windows');
      expect(environment.locale).toBe('zh-CN');
      expect(environment.timezone).toBe('Asia/Shanghai');
      expect(environment.colorScheme).toBe('light');
      expect(environment.reducedMotion).toBe('reduce');
      expect(environment.deviceScaleFactor).toBe(1);
      expect(environment.browserRevision).toBe('1223');
      expect(environment.fonts['Segoe UI']).toBe(true);
      expect(environment.fonts['Microsoft YaHei']).toBe(true);

      if (journey.journey === 'public-login') {
        await expect(page.locator('#authOverlay')).toBeVisible();
        await expect.poll(() => page.evaluate(() => localStorage.getItem('tm_token'))).toBeNull();
      } else {
        await expect(page.locator('#app')).toBeVisible();
        await expect(page.locator(`#page-${journey.pageId}`)).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`${expectedPathForJourney(journey).replace(/[?]/g, '\\?')}$`));
      }

      if (journey.role === 'admin') {
        await expect(page.locator('.nav-item.admin-only')).toBeVisible();
      }
      if (journey.role === 'user') {
        await expect(page.locator('.nav-item.admin-only')).toBeHidden();
      }
      if (journey.journey === 'admin-demand-ppt') {
        await expect(page).toHaveURL(/\/m3$/);
        await expect(page.locator('script[src="ppt.js?v=20260702v916kbbridge"]')).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => window.tmPPTBuild)).toBe('20260702-v916-kb-bridge-client-cn');
      }

      await recordKnownBaselineGaps(page, journey, runContext);
      await prepareLockedScreenshotCapture(page, journey);
      await page.screenshot({
        path: screenshotPathForSlot(runContext, slot),
        fullPage: false,
        animations: 'disabled',
        caret: 'hide'
      });
    });
  }

  test('admin brand workspace supports Task 8 interactions outside locked screenshot capture', async ({ page }) => {
    await navigateBaselineJourney(page, {
      role: 'admin',
      journey: 'admin-brand',
      pageId: 'm1',
      substate: null
    }, { fixture });
    await waitForBaselineReady(page);
    await exerciseBrandWorkspace(page);
  });

  test('restores direct URL page and substate after confirmed session restore', async ({ page }) => {
    await installBaselineAuthState(page, fixture.auth.admin);
    await page.goto('/m4?tab=tab2', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => typeof window.switchPage === 'function');
    await waitForBaselineReady(page);

    await expect(page).toHaveURL(/\/m4\?tab=tab2$/);
    await expect(page.locator('#page-m4')).toBeVisible();
    await expect(page.locator('#page-m0')).toBeHidden();
    await expectM4Tab(page, 'tab2');
    await expectActiveHeadingFocused(page, 'm4');
  });

  test('refresh preserves restored page and canonical substate', async ({ page }) => {
    await navigateBaselineJourney(page, {
      role: 'admin',
      pageId: 'm4',
      substate: { tab: 'tab2' }
    }, { fixture });
    await expect(page.locator('#page-m4')).toBeVisible();
    await expect(page).toHaveURL(/\/m4\?tab=tab2$/);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => typeof window.switchPage === 'function');
    await waitForBaselineReady(page);
    await expect(page.locator('#page-m4')).toBeVisible();
    await expect(page.locator('#page-m0')).toBeHidden();
    await expectM4Tab(page, 'tab2');
  });

  test('back and forward restore visible page and substate without manual app calls', async ({ page }) => {
    await navigateBaselineJourney(page, { role: 'admin', pageId: 'm4', substate: { tab: 'tab3' } }, { fixture });
    await expect(page).toHaveURL(/\/m4\?tab=tab3$/);
    await page.evaluate(() => window.switchPage('m0'));
    await expect(page.locator('#page-m0')).toBeVisible();
    await expect(page).toHaveURL(/\/m0$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/m4\?tab=tab3$/);
    await expect(page.locator('#page-m4')).toBeVisible();
    await expect(page.locator('#page-m0')).toBeHidden();
    await expectM4Tab(page, 'tab3');

    await page.goForward();
    await expect(page).toHaveURL(/\/m0$/);
    await expect(page.locator('#page-m0')).toBeVisible();
    await waitForBaselineReady(page);
  });

  test('customer workflow M4 handoff adds exactly one history entry', async ({ page }) => {
    await installBaselineAuthState(page, fixture.auth.admin);
    await page.goto('/m0-detail?view=pipeline', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => typeof window.openWorkflowFromCustomer === 'function');

    const customerRow = page.locator('#custTableBody tr').filter({ hasText: 'Fixture Labs' });
    await expect(customerRow).toBeVisible();
    const historyLengthBeforeHandoff = await page.evaluate(() => history.length);

    await customerRow.locator('td').first().click();
    const customerSidebar = page.locator('#custDetailSidebar');
    await expect(customerSidebar).toHaveClass(/open/);
    await customerSidebar.getByRole('button', { name: /匹配达人/ }).click();

    await expect(page).toHaveURL(/\/m4\?tab=tab1$/);
    await expect(page.locator('#page-m4')).toBeVisible();
    await expectM4Tab(page, 'tab1');
    const historyLengthAfterHandoff = await page.evaluate(() => history.length);

    await page.goBack();
    await expect.poll(() => page.evaluate(({ before, after }) => ({
      historyEntriesAdded: after - before,
      pathAfterBack: location.pathname + location.search,
      priorPageVisible: getComputedStyle(document.getElementById('page-m0-detail')).display !== 'none',
      m4Visible: getComputedStyle(document.getElementById('page-m4')).display !== 'none'
    }), { before: historyLengthBeforeHandoff, after: historyLengthAfterHandoff })).toEqual({
      historyEntriesAdded: 1,
      pathAfterBack: '/m0-detail?view=pipeline',
      priorPageVisible: true,
      m4Visible: false
    });
  });

  test('page navigation focuses the active page first h2 at every viewport', async ({ page }) => {
    await navigateBaselineJourney(page, { role: 'admin', pageId: 'm4' }, { fixture });
    await expectActiveHeadingFocused(page, 'm4');
    await waitForBaselineReady(page);
  });

  test('URL restoration applies CRM, admin, and kb substates with role gates', async ({ page }) => {
    await installBaselineAuthState(page, fixture.auth.admin);
    await page.goto('/m0-detail?view=seapool', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await waitForBaselineReady(page);
    await expect(page.locator('#page-m0-detail')).toBeVisible();
    await expectCrmView(page, 'seapool');

    await page.goto('/admin?tab=tokens&preview=v030', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await waitForBaselineReady(page);
    await expectAdminTab(page, 'tokens');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.tmPreview)).toBe('v030');

    await page.goto('/m4?tab=tab2&preview=v030', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await waitForBaselineReady(page);
    await expect(page).toHaveURL(/\/m4\?tab=tab2&preview=v030$/);
    await expect(page.locator('#page-m4')).toBeVisible();
    await expectM4Tab(page, 'tab2');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.tmPreview)).toBe('v030');

    await page.goto('/kb', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await waitForBaselineReady(page);
    await expectAdminTab(page, 'knowledge');
  });

  test('non-admin direct admin, kb, and preview routes normalize to CRM board', async ({ page }) => {
    await installBaselineAuthState(page, fixture.auth.user);
    await page.goto('/admin?tab=users&preview=v030', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await waitForBaselineReady(page);
    await expect(page).toHaveURL(/\/m0$/);
    await expect(page.locator('#page-m0')).toBeVisible();
    await expect(page.locator('#page-admin')).toBeHidden();
    await expect(page.locator('.nav-item.admin-only')).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.tmPreview || null)).toBeNull();

    await page.goto('/kb', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await waitForBaselineReady(page);
    await expect(page).toHaveURL(/\/m0$/);
    await expect(page.locator('#page-m0')).toBeVisible();
    await expect(page.locator('#page-admin')).toBeHidden();

    await page.goto('/m4?tab=tab2&preview=v030', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await waitForBaselineReady(page);
    await expect(page).toHaveURL(/\/m4\?tab=tab2$/);
    await expect(page.locator('#page-m4')).toBeVisible();
    await expectM4Tab(page, 'tab2');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.tmPreview || null)).toBeNull();
  });
});

test.describe('Task 9 M4 workflow', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await installBaselineBrowserControls(page, { fixture, testInfo });
    await installFixtureApi(page, { fixture });
  });

  test('admin runs query-aware list, import, export, Feishu, order, and status flows', async ({ page }) => {
    await openM4(page, 'tab1');

    await expect(page.locator('#infTableContainer tbody tr')).toHaveCount(2);
    await expect(page.locator('#infTableContainer')).toContainText('FixtureCreator');
    await expect(page.locator('#infTableContainer')).toContainText('SampleCreator');
    await expect.poll(() => page.locator('.m4-table thead th').first().evaluate((node) => getComputedStyle(node).position)).toBe('sticky');
    await expect.poll(() => page.locator('.m4-table .infcb').first().evaluate((node) => {
      const style = getComputedStyle(node);
      return { width: style.width, minWidth: style.minWidth };
    })).toEqual({ width: '16px', minWidth: '16px' });

    for (const [term, expectedHandles] of [
      ['401', ['FixtureCreator']],
      ['smart-home', ['SampleCreator']],
      ['sample-creator', ['SampleCreator']],
      ['fixture-parent', ['FixtureCreator', 'SampleCreator']]
    ]) {
      await page.locator('#filt_search').fill(term);
      await expect
        .poll(() => page.locator('#infTableContainer tbody tr').evaluateAll((rows) => rows.map((row) => row.textContent || '')))
        .toEqual(expectedHandles.map((handle) => expect.stringContaining(handle)));
    }

    await page.locator('#filt_search').fill('');
    await expect(page.locator('#infTableContainer tbody tr')).toHaveCount(2);

    const allDownloadPromise = page.waitForEvent('download');
    await page.locator('button[onclick="exportAll()"]').click();
    const allCsv = await readDownloadCsv(await allDownloadPromise, 'all');
    expectApprovedCsv(allCsv);
    expect(allCsv).toContain('FixtureCreator');
    expect(allCsv).toContain('SampleCreator');

    await page.locator('#filt_search').fill('401');
    await expect(page.locator('#infTableContainer tbody tr')).toHaveCount(1);
    const filteredDownloadPromise = page.waitForEvent('download');
    await page.locator('button[onclick="exportFiltered()"]').click();
    const filteredCsv = await readDownloadCsv(await filteredDownloadPromise, 'filtered');
    expectApprovedCsv(filteredCsv);
    expect(filteredCsv).toContain('FixtureCreator');
    expect(filteredCsv).not.toContain('SampleCreator');

    await page.locator('.m4-table .infcb').first().check();
    const selectedDownloadPromise = page.waitForEvent('download');
    await page.locator('button[onclick="exportSelected()"]').click();
    const selectedCsv = await readDownloadCsv(await selectedDownloadPromise, 'selected');
    expectApprovedCsv(selectedCsv);
    expect(selectedCsv).toContain('FixtureCreator');
    expect(selectedCsv).not.toContain('SampleCreator');

    await page.evaluate(() => window.switchTab('tab3'));
    await expectM4Tab(page, 'tab3');
    const templateDownloadPromise = page.waitForEvent('download');
    await page.locator('#tab3-content button[onclick="downloadInfTemplate()"]').click();
    const templateCsv = await readDownloadCsv(await templateDownloadPromise, 'template');
    expectApprovedCsv(templateCsv);

    const feishuDownloadPromise = page.waitForEvent('download');
    await page.locator('#tab3-content button[onclick="pushToFeishu()"]').click();
    const feishuCsv = await readDownloadCsv(await feishuDownloadPromise, 'feishu');
    expectApprovedCsv(feishuCsv);
    expect(feishuCsv).toContain('FixtureCreator');
    await expect(page.locator('#feishuStatus')).toContainText(/Fallback|CSV|未配置|manual/i);

    await page.locator('#tab3-content button[onclick="openInfUploadModal()"]').click();
    await expect(page.locator('#infUploadModal')).toBeVisible();
    const uploadCsv = '\uFEFF' + influencerWorkflow.TEMPLATE_HEADERS.join(',') + '\n' + [
      '2026-07-13',
      'Browser Fixture',
      'Browser Import Project',
      'Browser Import Product',
      'No',
      '@browser_import',
      '56000',
      'https://fixture.invalid/browser-import',
      'TikTok',
      'US',
      'Browser Tech',
      '17000',
      '800',
      '1 browser video',
      'Browser import note',
      '1300',
      'browser-import@example.invalid',
      '40',
      '0.08',
      'BROWSER-PARENT'
    ].join(',') + '\n';
    await page.locator('#infFileModal').setInputFiles({
      name: 'task9-browser-import.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(uploadCsv, 'utf8')
    });
    await expect(page.locator('#infModalStatus')).toContainText(/Imported|导入|uploaded/i);
    await page.evaluate(() => {
      const modal = document.getElementById('infUploadModal');
      if (modal) modal.style.display = 'none';
    });
    await page.evaluate(() => window.switchTab('tab1'));
    await expectM4Tab(page, 'tab1');
    await page.locator('#filt_search').fill('browser-import');
    await expect(page.locator('#infTableContainer')).toContainText('@browser_import');

    await page.locator('#filt_search').fill('401');
    await expect(page.locator('#infTableContainer tbody tr')).toHaveCount(1);
    await page.locator('#infTableContainer tbody tr').first().getByRole('button', { name: '下单' }).click();
    await expect(page.locator('#collabOrderModal')).toBeVisible();
    await expect(page.locator('#orderProject')).toHaveValue('Fixture Launch');
    await expect(page.locator('#orderProduct')).toHaveValue('Fixture Device');
    await expect(page.locator('#orderDeliverable')).toHaveValue('1 dedicated video');
    await expect(page.locator('#orderQuotedPrice')).toHaveValue('3000');
    await page.locator('#orderTimelineStart').fill('2026-07-20');
    await page.locator('#orderTimelineEnd').fill('2026-07-30');
    await page.locator('#orderNotes').fill('Task 9 browser order');
    await page.locator('#collabOrderModal button[onclick="submitCollabOrder()"]').click();
    await expectM4Tab(page, 'tab2');
    await expect(page.locator('#execTableContainer')).toContainText('FixtureCreator');
    await expect(page.locator('#execTableContainer')).toContainText('Task 9 browser order');

    const statusSelect = page.locator('#execTableContainer select').first();
    const statusPutPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'PUT' && /^\/api\/collaborations\/\d+$/.test(url.pathname);
    });
    const statusReloadPromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/collaborations' && response.ok();
    });
    await statusSelect.selectOption('completed');
    await statusPutPromise;
    await statusReloadPromise;
    await expect.poll(() => page.locator('#execTableContainer select').first().inputValue()).toBe('completed');

    const fixtureEvents = page.__tmTask9M4Calls || [];
    const putEvent = fixtureEvents.find((event) => event.type === 'collaboration-status-put' && event.body.status === 'completed');
    expect(putEvent).toBeTruthy();
    const reloadEvent = fixtureEvents.find((event) => (
      event.type === 'collaboration-list' &&
      event.index > putEvent.index &&
      event.collaborations.some((row) => row.id === putEvent.id && row.status === 'completed')
    ));
    expect(reloadEvent).toBeTruthy();
  });
});
