'use strict';

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
      await page.screenshot({
        path: screenshotPathForSlot(runContext, slot),
        fullPage: false,
        animations: 'disabled',
        caret: 'hide'
      });
    });
  }

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
