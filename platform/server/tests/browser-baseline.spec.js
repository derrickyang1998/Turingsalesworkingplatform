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
      }

      if (journey.role === 'admin') {
        await expect(page.locator('.nav-item.admin-only')).toBeVisible();
      }
      if (journey.role === 'user') {
        await expect(page.locator('.nav-item.admin-only')).toBeHidden();
      }
      if (journey.journey === 'admin-demand-ppt') {
        await expect(page).toHaveURL(/\/$/);
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

  test('records the pre-edit direct-path gap', async ({ page }) => {
    await installBaselineAuthState(page, fixture.auth.admin);
    await page.goto('/m4', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => typeof window.switchPage === 'function');
    await waitForBaselineReady(page);

    await expect(page).toHaveURL(/\/m4$/);
    await expect(page.locator('#page-m0')).toBeVisible();
    await expect(page.locator('#page-m4')).toBeHidden();
    await recordKnownBaselineGaps(page, null, runContext);
  });

  test('records the pre-edit refresh restoration gap', async ({ page }) => {
    await navigateBaselineJourney(page, {
      role: 'admin',
      pageId: 'm4',
      substate: { tab: 2 }
    }, { fixture });
    await expect(page.locator('#page-m4')).toBeVisible();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => typeof window.switchPage === 'function');
    await waitForBaselineReady(page);
    await expect(page.locator('#page-m0')).toBeVisible();
    await expect(page.locator('#page-m4')).toBeHidden();
    await recordKnownBaselineGaps(page, null, runContext);
  });

  test('records the pre-edit back-forward restoration gap', async ({ page }) => {
    await navigateBaselineJourney(page, { role: 'admin', pageId: 'm4' }, { fixture });
    await page.evaluate(() => {
      history.replaceState({ pageId: 'm4' }, '', '/m4');
      history.pushState({ pageId: 'm0' }, '', '/m0');
      window.switchPage('m0');
    });
    await expect(page.locator('#page-m0')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/m4$/);
    await expect(page.locator('#page-m0')).toBeVisible();
    await expect(page.locator('#page-m4')).toBeHidden();

    await page.goForward();
    await expect(page).toHaveURL(/\/m0$/);
    await expect(page.locator('#page-m0')).toBeVisible();
    await waitForBaselineReady(page);
    await recordKnownBaselineGaps(page, null, runContext);
  });

  test('records the pre-edit heading-focus gap', async ({ page }) => {
    await navigateBaselineJourney(page, { role: 'admin', pageId: 'm4' }, { fixture });
    const focusState = await page.evaluate(() => {
      const heading = document.querySelector('#page-m4 h1, #page-m4 h2, #page-m4 h3');
      return {
        activeTag: document.activeElement && document.activeElement.tagName,
        headingFocused: document.activeElement === heading
      };
    });
    expect(focusState).toEqual({ activeTag: 'BODY', headingFocused: false });
    await waitForBaselineReady(page);
    await recordKnownBaselineGaps(page, null, runContext);
  });
});
