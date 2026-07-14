'use strict';

const { test, expect } = require('playwright-deploy/test');
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
    app: '20260714-v040-product-shell-design-system',
    ppt: '20260702-v916-kb-bridge-client-cn'
  });

  const publicAssets = new Map([
    ['/client/shared/build_info.js', '20260714-v040-product-shell-design-system'],
    ['/client/core/navigation.js', 'window.TMNavigation = Object.freeze'],
    ['/client/core/accessibility.js', 'window.TMAccessibility = Object.freeze'],
    ['/client/core/shell.js', 'window.TMShell = Object.freeze'],
    ['/client/styles/tokens.css', '--tm-color-control-border: #8a94a3;'],
    ['/client/styles/components.css', '.tm-checkbox-target {'],
    ['/client/styles/layout.css', '.tm-mobile-bar,']
  ]);
  for (const [asset, marker] of publicAssets) {
    const response = await request.get(asset);
    expect(response.status(), asset).toBe(200);
    expect(await response.text(), `${asset} marker`).toContain(marker);
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
