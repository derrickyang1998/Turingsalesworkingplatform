'use strict';

const { test, expect } = require('playwright/test');
const {
  installBaselineAuthState,
  installBaselineBrowserControls,
  installFixtureApi,
  loadBaselineFixture,
  waitForBaselineReady
} = require('./helpers/browser_fixture');

const fixture = loadBaselineFixture();

test('deployment browser smoke loads the public shell and enforces the static boundary', async ({ page, request }) => {
  await installBaselineBrowserControls(page, { fixture });
  await page.goto('/');
  await expect(page.locator('#authOverlay')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.TMBuild)).toEqual({
    app: '20260713-v030-baseline-consolidation',
    ppt: '20260702-v916-kb-bridge-client-cn'
  });

  for (const asset of ['/client/shared/build_info.js', '/client/core/navigation.js']) {
    expect((await request.get(asset)).status(), asset).toBe(200);
  }
  for (const denied of ['/client/unknown.js', '/server/server.js']) {
    expect((await request.get(denied)).status(), denied).toBe(404);
  }
});

test('deployment browser smoke restores authenticated CRM, influencer, and admin routes', async ({ page }) => {
  await installBaselineBrowserControls(page, { fixture });
  await installFixtureApi(page, { fixture });
  await installBaselineAuthState(page, fixture.auth.admin);

  const routes = [
    ['/m0', 'm0'],
    ['/m0-detail?view=pipeline', 'm0-detail'],
    ['/m4?tab=tab1', 'm4'],
    ['/admin?tab=overview', 'admin']
  ];
  for (const [route, pageId] of routes) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator(`#page-${pageId}`)).toBeVisible();
    await waitForBaselineReady(page);
  }
});
