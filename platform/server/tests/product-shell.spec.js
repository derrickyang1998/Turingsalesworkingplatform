'use strict';

const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const {
  installBaselineAuthState,
  installBaselineBrowserControls,
  installFixtureApi,
  loadBaselineFixture,
  waitForBaselineReady
} = require('./helpers/browser_fixture');

const fixture = loadBaselineFixture();
const projectViewports = {
  'fixture-1440': { width: 1440, height: 900 },
  'fixture-1920': { width: 1920, height: 1080 },
  'fixture-mobile': { width: 390, height: 844 }
};
const axeTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

test.describe.configure({ mode: 'serial' });

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function restoreProjectViewport(page, testInfo) {
  await page.setViewportSize(projectViewports[testInfo.project.name]);
  await settle(page);
}

async function boot(page, {
  role = 'admin',
  path = '/m0',
  loginFailure = null,
  expireNextApi = null,
  routingScope = 'context'
} = {}) {
  await installBaselineBrowserControls(page, { fixture, motionProfile: 'native' });
  await installFixtureApi(page, { fixture, loginFailure, expireNextApi, routingScope });
  const auth = role === 'admin' ? fixture.auth.admin : role === 'user' ? fixture.auth.user : null;
  await installBaselineAuthState(page, auth);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  if (auth) {
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.TMNavigation && typeof window.switchPage === 'function');
  } else {
    await page.locator('#authOverlay').waitFor({ state: 'visible' });
  }
  await waitForBaselineReady(page, { maskDynamicContent: false });
}

async function expectRuntimeClean(page) {
  await waitForBaselineReady(page, { maskDynamicContent: false });
  expect(page.__baselineUnhandledApiCalls).toEqual([]);
  expect(page.__baselineUnhandledNetworkRequests).toEqual([]);
  expect(page.__baselinePageErrors).toEqual([]);
}

function consumeExpectedPageError(page, pattern) {
  const matching = page.__baselinePageErrors.filter((message) => pattern.test(message));
  expect(matching).toHaveLength(1);
  page.__baselinePageErrors = page.__baselinePageErrors.filter((message) => !pattern.test(message));
}

async function expectTaskAreaVisible(page) {
  const geometry = await page.evaluate(() => {
    const pageElement = document.querySelector('.page.active');
    const heading = pageElement && pageElement.querySelector('h1,h2');
    const pageBox = pageElement && pageElement.getBoundingClientRect();
    const headingBox = heading && heading.getBoundingClientRect();
    return {
      appDisplay: getComputedStyle(document.getElementById('app')).display,
      pageDisplay: pageElement && getComputedStyle(pageElement).display,
      pageBox: pageBox && { top: pageBox.top, bottom: pageBox.bottom, left: pageBox.left, right: pageBox.right },
      headingBox: headingBox && { top: headingBox.top, bottom: headingBox.bottom, left: headingBox.left, right: headingBox.right },
      viewport: { width: innerWidth, height: innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth
    };
  });
  expect(geometry.appDisplay).not.toBe('none');
  expect(geometry.pageDisplay).not.toBe('none');
  expect(geometry.headingBox).not.toBeNull();
  expect(geometry.headingBox.bottom).toBeGreaterThan(0);
  expect(geometry.headingBox.top).toBeLessThan(geometry.viewport.height);
  expect(geometry.headingBox.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.headingBox.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth + 1);
}

async function expectAxeClean(page, surface) {
  const result = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  const details = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target)
  }));
  expect(details, `${surface} axe violations: ${JSON.stringify(details)}`).toEqual([]);
}

test('keeps the product gate on native media and an unmasked deterministic DOM', async ({ page }) => {
  await boot(page, { path: '/m0' });
  const state = await page.evaluate(() => ({
    motionProfile: window.__tmBaseline.motionProfile,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    username: document.getElementById('sidebarFooter').textContent,
    maskedNodes: Array.from(document.querySelectorAll('*')).filter((element) => element.textContent === '[masked]').length
  }));
  expect(state.motionProfile).toBe('native');
  expect(state.reduced).toBe(false);
  expect(state.username).not.toBe('[masked]');
  expect(state.maskedNodes).toBe(0);
  await expectRuntimeClean(page);
});

test('proves desktop non-overlap, mobile visibility, and 200%/400% reflow equivalence', async ({ page }, testInfo) => {
  await boot(page, { path: '/m4?tab=tab1' });
  expect(page.viewportSize()).toEqual(projectViewports[testInfo.project.name]);

  if (page.viewportSize().width > 900) {
    const boxes = await page.evaluate(() => {
      const sidebar = document.getElementById('tmSidebar').getBoundingClientRect();
      const main = document.getElementById('mainContent').getBoundingClientRect();
      return { sidebar: { left: sidebar.left, right: sidebar.right }, main: { left: main.left, right: main.right }, width: innerWidth };
    });
    expect(boxes.sidebar.right).toBeLessThanOrEqual(boxes.main.left + 1);
    expect(boxes.main.right).toBeLessThanOrEqual(boxes.width + 1);
  } else {
    await expectTaskAreaVisible(page);
    await expect(page.locator('#tmSidebar')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('#tmSidebar').evaluate((element) => element.inert)).toBe(true);
  }

  for (const equivalent of [
    { label: '200%', viewport: { width: 640, height: 720 } },
    { label: '400%', viewport: { width: 320, height: 568 } }
  ]) {
    await page.setViewportSize(equivalent.viewport);
    await settle(page);
    await expectTaskAreaVisible(page);
    const controls = await page.evaluate(() => Array.from(document.querySelectorAll('.page.active button:enabled,.page.active input:not([type="hidden"]),.page.active select'))
      .filter((element) => element.getClientRects().length)
      .slice(0, 8)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, width: box.width };
      }));
    expect(controls.length, `${equivalent.label} must retain reachable controls`).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.left, `${equivalent.label} control clipped left`).toBeGreaterThanOrEqual(-1);
      expect(control.right, `${equivalent.label} control clipped right`).toBeLessThanOrEqual(equivalent.viewport.width + 1);
    }
  }

  await restoreProjectViewport(page, testInfo);
  await expectRuntimeClean(page);
});

test('operates the mobile drawer by pointer and keyboard with focus trap, inert background, Escape, and restoration', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { path: '/m0' });
  const open = page.locator('#tmNavOpen');
  const close = page.locator('#tmNavClose');
  const sidebar = page.locator('#tmSidebar');
  const backdrop = page.locator('#tmNavBackdrop');

  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  expect(await sidebar.evaluate((element) => element.inert)).toBe(true);
  await open.click();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
  expect(await page.locator('#mainContent').evaluate((element) => element.inert)).toBe(true);
  await expect(close).toBeFocused();

  const lastNav = sidebar.locator('a.nav-item:visible').last();
  await lastNav.focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastNav).toBeFocused();

  const backdropBox = await backdrop.boundingBox();
  await page.mouse.click(backdropBox.x + backdropBox.width - 4, backdropBox.y + 100);
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await expect(open).toBeFocused();

  await open.focus();
  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  expect(await page.locator('#mainContent').evaluate((element) => element.inert)).toBe(false);

  await page.setViewportSize({ width: 320, height: 568 });
  await settle(page);
  await open.click();
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expectTaskAreaVisible(page);
  await restoreProjectViewport(page, testInfo);
  await expectRuntimeClean(page);
});

test('preserves plain SPA navigation and native Control and middle-click destinations', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, { path: '/m0', routingScope: 'context' });
  const openerUrl = page.url();
  const link = page.locator('#tmSidebar a[data-page="m1"]');
  await expect(link).toHaveAttribute('href', '/m1');

  await link.click();
  await expect(page).toHaveURL(/\/m1$/);
  expect(context.pages()).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(/\/m0$/);

  const modifierPopupPromise = context.waitForEvent('page');
  await link.click({ modifiers: ['Control'] });
  const modifierPopup = await modifierPopupPromise;
  await modifierPopup.waitForLoadState('domcontentloaded');
  await expect(modifierPopup).toHaveURL(/\/m1$/);
  expect(page.url()).toBe(openerUrl);
  await modifierPopup.close();

  const middlePopupPromise = context.waitForEvent('page');
  await link.click({ button: 'middle' });
  const middlePopup = await middlePopupPromise;
  await middlePopup.waitForLoadState('domcontentloaded');
  await expect(middlePopup).toHaveURL(/\/m1$/);
  expect(page.url()).toBe(openerUrl);
  await middlePopup.close();
  await restoreProjectViewport(page, testInfo);
  await expectRuntimeClean(page);
});

test('implements APG manual-activation tabs for CRM and M4 with focus, selection, panels, and URLs in sync', async ({ page }) => {
  await boot(page, { path: '/m0-detail?view=pipeline' });

  const crmList = page.locator('.tm-crm-tabs');
  const crmTabs = crmList.locator('[role="tab"]');
  await expect(crmList).toHaveAttribute('role', 'tablist');
  await expect(crmList).toHaveAccessibleName(/.+/);
  await expect(crmTabs).toHaveCount(3);
  await expect(crmTabs.nth(0)).toHaveAttribute('tabindex', '0');
  await expect(crmTabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await crmTabs.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(crmTabs.nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(crmTabs.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(crmTabs.nth(2)).toBeFocused();
  await expect(crmTabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/m0-detail\?view=opportunities$/);
  const crmPanelId = await crmTabs.nth(2).getAttribute('aria-controls');
  await expect(page.locator(`#${crmPanelId}`)).toBeVisible();
  await page.keyboard.press('Home');
  await expect(crmTabs.nth(0)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(crmTabs.nth(0)).toBeFocused();
  await expect(page).toHaveURL(/\/m0-detail\?view=pipeline$/);

  await page.evaluate(() => window.TMNavigation.navigate('m4', {
    substate: { tab: 'tab1' },
    user: CURRENT_USER
  }));
  await expect(page).toHaveURL(/\/m4\?tab=tab1$/);
  await page.locator('#page-m4').waitFor({ state: 'visible' });
  await waitForBaselineReady(page, { maskDynamicContent: false });
  const m4List = page.locator('#tabBar');
  const m4Tabs = m4List.locator('[role="tab"]');
  await expect(m4List).toHaveAttribute('role', 'tablist');
  await expect(m4List).toHaveAccessibleName(/.+/);
  await expect(m4Tabs).toHaveCount(3);
  await m4Tabs.nth(0).focus();
  await page.keyboard.press('ArrowUp');
  await expect(m4Tabs.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(m4Tabs.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(m4Tabs.nth(1)).toBeFocused();
  await expect(m4Tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/m4\?tab=tab2$/);
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  await expect(m4Tabs.nth(2)).toBeFocused();
  await expect(m4Tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab3-content')).toBeVisible();
  await expect(page).toHaveURL(/\/m4\?tab=tab3$/);
  await expectRuntimeClean(page);
});

test('opens the real demand and M4 file choosers exactly once for Enter and Space', async ({ page }) => {
  await boot(page, { path: '/m3' });
  let chooserCount = 0;
  page.on('filechooser', () => { chooserCount += 1; });

  async function activate(surfaceSelector, inputSelector, key, expectedCount) {
    const surface = page.locator(surfaceSelector);
    const chooser = page.waitForEvent('filechooser');
    await surface.focus();
    await page.keyboard.press(key);
    await chooser;
    await page.waitForTimeout(50);
    expect(chooserCount).toBe(expectedCount);
    await expect(page.locator(inputSelector)).toHaveAttribute('aria-label', /.+/);
  }

  await activate('#demandDropZone', '#demandFile', 'Enter', 1);
  await activate('#demandDropZone', '#demandFile', 'Space', 2);
  await page.goto('/m4?tab=tab3', { waitUntil: 'domcontentloaded' });
  await page.locator('#tab3-content').waitFor({ state: 'visible' });
  await activate('#infDropZone', '#infFile', 'Enter', 3);
  await activate('#infDropZone', '#infFile', 'Space', 4);
  await expectRuntimeClean(page);
});

test('renders CRM funnel fills and active proposal templates with solid visible backgrounds', async ({ page }) => {
  await boot(page, { path: '/m0' });
  const funnelStyles = await page.locator('#m0StageBars .tm-stage-fill').evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage };
  }));
  expect(funnelStyles).toHaveLength(5);
  for (const style of funnelStyles) {
    expect(style.backgroundImage).toBe('none');
    expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  }

  await page.evaluate(() => window.TMNavigation.navigate('m3', { user: CURRENT_USER }));
  await page.locator('#page-m3').waitFor({ state: 'visible' });
  await page.evaluate(() => goGenerate());
  const firstTemplate = page.locator('#tmplSelect .tm-template-card').first();
  await firstTemplate.click();
  await expect(firstTemplate).toHaveClass(/active/);
  const templateStyle = await firstTemplate.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage };
  });
  expect(templateStyle.backgroundImage).toBe('none');
  expect(templateStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  const contrast = await new AxeBuilder({ page }).include('#tmplSelect').withRules(['color-contrast']).analyze();
  expect(contrast.violations).toEqual([]);
  await expectRuntimeClean(page);
});

test('keeps a real customer dialog named, trapped, inert, dismissible, restored, and operable at 320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await boot(page, { path: '/m0-detail?view=pipeline' });
  const opener = page.locator('#page-m0-detail button[onclick="openAddCustomer()"]').first();
  await opener.click();
  const dialog = page.locator('#customerDialog');
  await expect(dialog).toBeVisible();
  const labelledBy = await dialog.getAttribute('aria-labelledby');
  expect(labelledBy).toBeTruthy();
  await expect(page.locator(`#${labelledBy}`)).not.toHaveText('');
  await expect.poll(() => opener.evaluate((element) => !!element.closest('[inert]'))).toBe(true);
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  const focusable = dialog.locator('button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled])');
  const first = focusable.first();
  const last = focusable.last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();

  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(321);
  expect(box.height).toBeLessThanOrEqual(568);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await opener.evaluate((element) => !!element.closest('[inert]'))).toBe(false);
  await restoreProjectViewport(page, testInfo);
  await expectRuntimeClean(page);
});

test('reports empty and server login errors inline and moves focus to the correct field', async ({ page }) => {
  await boot(page, {
    role: null,
    path: '/',
    loginFailure: { status: 401, error: 'Invalid fixture credentials' }
  });
  const username = page.locator('#loginUser');
  const password = page.locator('#loginPass');
  const submit = page.locator('#loginForm button[type="submit"]');
  await submit.click();
  await expect(username).toBeFocused();
  await expect(username).toHaveAttribute('aria-invalid', 'true');
  await username.fill('fixture-user');
  await submit.click();
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await password.fill('wrong-password');
  await submit.click();
  await expect(page.locator('#loginError')).toContainText('Invalid fixture credentials');
  await expect(page.locator('#loginError')).toHaveAttribute('role', 'alert');
  await expect(username).toBeFocused();
  await expect(page.locator('.toast').filter({ hasText: 'Invalid fixture credentials' })).toHaveCount(0);
  consumeExpectedPageError(page, /Failed to load resource:.*401 \(Unauthorized\)/);
  await expectRuntimeClean(page);
});

test('handles a deterministic authenticated 401 by hiding the app and focusing username', async ({ page }) => {
  await boot(page, { path: '/m0', expireNextApi: { method: 'GET', path: '/health' } });
  await page.evaluate(() => apiFetch('/health'));
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#authOverlay')).toBeVisible();
  await expect(page.locator('#loginUser')).toBeFocused();
  await expect(page.locator('.toast [role="alert"]')).toBeVisible();
  expect(await page.evaluate(() => ({ token: localStorage.getItem('tm_token'), user: localStorage.getItem('tm_user') })))
    .toEqual({ token: null, user: null });
  consumeExpectedPageError(page, /Failed to load resource:.*401 \(Unauthorized\)/);
  await expectRuntimeClean(page);
});

test('announces success and error status mutations without moving focus', async ({ page }) => {
  await boot(page, { path: '/m0' });
  const focusOwner = page.locator('#page-m0 button').first();
  await focusOwner.focus();
  await page.evaluate(() => toast('Fixture saved', 'success'));
  await expect(page.locator('#toastContainer')).not.toHaveAttribute('role', /.+/);
  await expect(page.locator('#toastContainer')).not.toHaveAttribute('aria-live', /.+/);
  const successToast = page.locator('.toast').filter({ hasText: 'Fixture saved' });
  await expect(successToast.locator('[role="status"]')).toContainText('Fixture saved');
  await expect(successToast.getByRole('button', { name: '关闭通知' })).toBeVisible();
  await expect(focusOwner).toBeFocused();
  await page.waitForTimeout(3100);
  await expect(successToast).toBeVisible();
  await successToast.getByRole('button', { name: '关闭通知' }).click();
  await expect(successToast).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => {
    document.dispatchEvent(new CustomEvent('tm:navigation-applied'));
    window.setTimeout(resolve, 0);
  }));
  await page.evaluate(() => toast('Fixture failed', 'error'));
  const errorToast = page.locator('.toast').filter({ hasText: 'Fixture failed' });
  await expect(page.locator('#toastContainer')).not.toHaveAttribute('role', /.+/);
  await expect(page.locator('#toastContainer')).not.toHaveAttribute('aria-live', /.+/);
  await expect(errorToast.locator('[role="alert"]')).toContainText('Fixture failed');
  await expect(errorToast.locator('[role="status"], [role="alert"]')).toHaveCount(1);
  await expect(errorToast.getByRole('button', { name: '关闭通知' })).toBeVisible();
  await expect(focusOwner).toBeFocused();
  await expectRuntimeClean(page);
});

test('renders named 16px M4 checkboxes with 24/44px targets and select-all indeterminate state', async ({ page }) => {
  await boot(page, { path: '/m4?tab=tab1' });
  const selectAll = page.locator('#selectAllInf');
  await selectAll.waitFor({ state: 'visible' });
  const inputs = page.locator('#infTableContainer input[type="checkbox"]');
  expect(await inputs.count()).toBeGreaterThan(1);
  for (let index = 0; index < await inputs.count(); index += 1) {
    const name = await inputs.nth(index).getAttribute('aria-label');
    expect(name).toBeTruthy();
    const glyph = await inputs.nth(index).boundingBox();
    expect(Math.round(glyph.width)).toBe(16);
    expect(Math.round(glyph.height)).toBe(16);
    const target = await inputs.nth(index).locator('xpath=..').boundingBox();
    const minimum = page.viewportSize().width <= 900 ? 44 : 24;
    expect(Math.round(target.width)).toBeGreaterThanOrEqual(minimum);
    expect(Math.round(target.height)).toBeGreaterThanOrEqual(minimum);
  }
  const rows = page.locator('.infcb');
  await rows.first().check();
  expect(await selectAll.evaluate((element) => element.indeterminate)).toBe(true);
  await selectAll.check();
  expect(await rows.evaluateAll((elements) => elements.every((element) => element.checked))).toBe(true);
  expect(await selectAll.evaluate((element) => element.indeterminate)).toBe(false);
  await selectAll.uncheck();
  expect(await rows.evaluateAll((elements) => elements.every((element) => !element.checked))).toBe(true);
  await expectRuntimeClean(page);
});

test('adds and selects workflow nodes exactly once per Enter or Space command', async ({ page }) => {
  await boot(page, { path: '/workflow' });
  const palette = page.locator('.wf-node-palette').first();
  const nodes = page.locator('.wf-node-svg[data-node-id]');
  const before = await nodes.count();
  await palette.focus();
  await page.keyboard.press('Enter');
  await expect(nodes).toHaveCount(before + 1);
  await palette.focus();
  await page.keyboard.press('Space');
  await expect(nodes).toHaveCount(before + 2);

  await page.evaluate(() => {
    const original = window.wfSelectNode;
    window.__tmWorkflowSelectionCalls = 0;
    window.wfSelectNode = function () {
      window.__tmWorkflowSelectionCalls += 1;
      return original.apply(this, arguments);
    };
  });
  const node = nodes.last();
  const nodeId = await node.getAttribute('data-node-id');
  await node.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`.wf-node-svg.wf-node-selected[data-node-id="${nodeId}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => window.__tmWorkflowSelectionCalls)).toBe(1);
  await expect(node).toBeFocused();
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.__tmWorkflowSelectionCalls)).toBe(2);
  await expect(nodes).toHaveCount(before + 2);
  await expectRuntimeClean(page);
});

test('pins table headers in their owner and contains mobile horizontal scrolling through the final column', async ({ page }, testInfo) => {
  await boot(page, { path: '/m0-detail?view=pipeline' });
  const crmContainer = page.locator('#crmPipelineView .table-container');
  await crmContainer.locator('tbody tr').first().waitFor({ state: 'visible' });
  await crmContainer.evaluate((container) => {
    const body = container.querySelector('tbody');
    const seed = body.querySelector('tr');
    while (body.children.length < 40) body.appendChild(seed.cloneNode(true));
    container.style.maxHeight = '140px';
    container.scrollTop = 240;
  });
  const sticky = await crmContainer.evaluate((container) => {
    const header = container.querySelector('thead th').getBoundingClientRect();
    const owner = container.getBoundingClientRect();
    return { scrollTop: container.scrollTop, headerTop: header.top, ownerTop: owner.top };
  });
  expect(sticky.scrollTop).toBeGreaterThan(0);
  expect(Math.abs(sticky.headerTop - sticky.ownerTop)).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/m4?tab=tab1', { waitUntil: 'domcontentloaded' });
  const m4Container = page.locator('#infTableContainer');
  await m4Container.locator('table').waitFor({ state: 'visible' });
  const containment = await m4Container.evaluate((container) => {
    container.scrollLeft = container.scrollWidth;
    const owner = container.getBoundingClientRect();
    const last = container.querySelector('thead th:last-child').getBoundingClientRect();
    return {
      ownerScrollWidth: container.scrollWidth,
      ownerClientWidth: container.clientWidth,
      ownerRight: owner.right,
      lastLeft: last.left,
      lastRight: last.right,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      scrollLeft: container.scrollLeft
    };
  });
  expect(containment.ownerScrollWidth).toBeGreaterThan(containment.ownerClientWidth);
  expect(containment.scrollLeft).toBeGreaterThan(0);
  expect(containment.lastLeft).toBeLessThan(containment.ownerRight);
  expect(containment.lastRight).toBeLessThanOrEqual(containment.ownerRight + 1);
  expect(containment.documentScrollWidth).toBeLessThanOrEqual(containment.documentClientWidth + 1);
  await restoreProjectViewport(page, testInfo);
  await expectRuntimeClean(page);
});

test('honors native reduced-motion media while preserving drawer and toast states', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await boot(page, { path: '/m0' });
  await page.evaluate(() => toast('Motion sample', 'success'));
  const normal = await page.evaluate(() => ({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    sidebarTransition: getComputedStyle(document.getElementById('tmSidebar')).transitionDuration,
    toastAnimation: getComputedStyle(document.querySelector('.toast')).animationDuration
  }));
  expect(normal.reduced).toBe(false);
  expect(normal.sidebarTransition).not.toBe('0s');
  expect(normal.toastAnimation).not.toBe('0s');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle(page);
  const reduced = await page.evaluate(() => ({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    sidebarTransition: getComputedStyle(document.getElementById('tmSidebar')).transitionDuration,
    toastAnimation: getComputedStyle(document.querySelector('.toast')).animationDuration,
    closedRight: document.getElementById('tmSidebar').getBoundingClientRect().right
  }));
  expect(reduced.reduced).toBe(true);
  expect(parseFloat(reduced.sidebarTransition)).toBeLessThanOrEqual(0.001);
  expect(parseFloat(reduced.toastAnimation)).toBeLessThanOrEqual(0.001);
  expect(reduced.closedRight).toBeLessThanOrEqual(1);
  await page.locator('#tmNavOpen').click();
  await expect(page.locator('#tmNavClose')).toBeFocused();
  await expect.poll(() => page.locator('#tmSidebar').evaluate((element) => element.getBoundingClientRect().left))
    .toBeGreaterThanOrEqual(-1);
  await page.keyboard.press('Escape');
  await restoreProjectViewport(page, testInfo);
  await expectRuntimeClean(page);
});

test('keeps canonical titles, anchor routes, direct restore, refresh, and history equivalent', async ({ page }) => {
  await boot(page, { path: '/m0' });
  const expectedRoutes = {
    m0: '/m0',
    'm0-detail': '/m0-detail?view=pipeline',
    m1: '/m1',
    m2: '/m2',
    m3: '/m3',
    m4: '/m4?tab=tab1',
    m5: '/m5',
    'workflow-designer': '/workflow',
    'workflow-templates': '/workflow-templates',
    'workflow-instances': '/workflow-instances',
    'workflow-tasks': '/tasks',
    admin: '/admin?tab=overview'
  };
  const routes = await page.locator('#tmSidebar a[data-page]').evaluateAll((links) => Object.fromEntries(links.map((link) => [link.dataset.page, link.getAttribute('href')])));
  expect(routes).toEqual(expectedRoutes);

  const m1 = page.locator('#tmSidebar a[data-page="m1"]');
  if (page.viewportSize().width <= 900) {
    await page.locator('#tmNavOpen').click();
    await expect(page.locator('#tmNavClose')).toBeFocused();
  }
  await m1.click();
  await expect(page).toHaveURL(/\/m1$/);
  const m1Heading = await page.locator('#page-m1 h1,#page-m1 h2').first().innerText();
  await expect(page).toHaveTitle(new RegExp(`${m1Heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*TuringMarket`));
  await page.goBack();
  await expect(page).toHaveURL(/\/m0$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/m1$/);

  await page.goto('/m4?tab=tab2', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#page-m4')).toBeVisible();
  await expect(page.locator('#tabBar [data-tab="tab2"]')).toHaveAttribute('aria-selected', 'true');
  const titleBeforeRefresh = await page.title();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/m4\?tab=tab2$/);
  await expect(page.locator('#tabBar [data-tab="tab2"]')).toHaveAttribute('aria-selected', 'true');
  expect(await page.title()).toBe(titleBeforeRefresh);

  await page.goto('/m0-detail?view=opportunities', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.tm-crm-tabs [role="tab"]').nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#crmOpportunityView')).toBeVisible();
  await expect(page.locator('#oppTableBody tr')).toHaveCount(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#crmOpportunityView')).toBeVisible();
  await expect(page.locator('#oppTableBody tr')).toHaveCount(1);
  await expectRuntimeClean(page);
});

test('exposes visible forced-color focus, control boundaries, current state, table, dialog, and drawer controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ forcedColors: 'active' });
  await boot(page, { path: '/m0-detail?view=pipeline' });
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  const open = page.locator('#tmNavOpen');
  await open.focus();
  const openStyle = await open.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, border: style.borderStyle, borderWidth: style.borderWidth };
  });
  expect(openStyle.outline).not.toBe('none');
  expect(openStyle.border).not.toBe('none');
  expect(parseFloat(openStyle.borderWidth)).toBeGreaterThan(0);
  await expect(page.locator('#tmSidebar a[aria-current="page"]')).toHaveCount(1);
  const selectedCrmTab = page.locator('.tm-crm-tabs [role="tab"][aria-selected="true"]');
  const unselectedCrmTab = page.locator('.tm-crm-tabs [role="tab"][aria-selected="false"]').first();
  const selectedState = await selectedCrmTab.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  const unselectedState = await unselectedCrmTab.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(selectedState.outlineStyle).not.toBe('none');
  expect(parseFloat(selectedState.outlineWidth)).toBeGreaterThan(0);
  expect(unselectedState.outlineStyle).toBe('none');
  await expect(page.locator('#crmPipelineView thead th').first()).toBeVisible();

  await page.goto('/m4?tab=tab2', { waitUntil: 'domcontentloaded' });
  const selectedM4Tab = page.locator('#tabBar [role="tab"][aria-selected="true"]');
  await expect(page.locator('#tabBar [data-tab="tab2"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  await selectedM4Tab.focus();
  await expect(selectedM4Tab).toBeFocused();
  const selectedM4Focus = await selectedM4Tab.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset
    };
  });
  expect(selectedM4Focus.outlineStyle).not.toBe('none');
  expect(parseFloat(selectedM4Focus.outlineWidth)).toBeGreaterThanOrEqual(2);
  expect(parseFloat(selectedM4Focus.outlineOffset)).toBeGreaterThan(0);

  await page.goto('/m0-detail?view=pipeline', { waitUntil: 'domcontentloaded' });

  const opener = page.locator('#page-m0-detail button[onclick="openAddCustomer()"]').first();
  await opener.click();
  const close = page.locator('#customerDialog button[onclick="closeCustModal()"]');
  await expect(page.locator('#custBrand')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  const closeStyle = await close.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, border: style.borderStyle, borderWidth: style.borderWidth };
  });
  expect(closeStyle.outline).not.toBe('none');
  expect(closeStyle.border).not.toBe('none');
  expect(parseFloat(closeStyle.borderWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await open.click();
  await expect(page.locator('#tmNavClose')).toBeFocused();
  await expect(page.locator('#tmSidebar')).toHaveAttribute('aria-hidden', 'false');
  await page.keyboard.press('Escape');
  await restoreProjectViewport(page, testInfo);
  await expectRuntimeClean(page);
});

test('keeps forced-color login fields and focus boundaries visible', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await boot(page, { role: null, path: '/' });
  const username = page.locator('#loginUser');
  await username.focus();
  const style = await username.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { outline: computed.outlineStyle, border: computed.borderStyle, borderWidth: computed.borderWidth };
  });
  expect(style.outline).not.toBe('none');
  expect(style.border).not.toBe('none');
  expect(parseFloat(style.borderWidth)).toBeGreaterThan(0);
  await expectRuntimeClean(page);
});

const axeSurfaces = [
  { name: 'login', role: null, path: '/' },
  { name: 'CRM', role: 'admin', path: '/m0-detail?view=pipeline' },
  { name: 'M4', role: 'admin', path: '/m4?tab=tab1' },
  { name: 'AI', role: 'admin', path: '/m5' },
  { name: 'workflow', role: 'admin', path: '/workflow' },
  { name: 'admin', role: 'admin', path: '/admin?tab=overview' }
];

for (const surface of axeSurfaces) {
  test(`has no undocumented axe WCAG A/AA violations on ${surface.name}`, async ({ page }) => {
    await boot(page, { role: surface.role, path: surface.path });
    await expectAxeClean(page, surface.name);
    await expectRuntimeClean(page);
  });
}
