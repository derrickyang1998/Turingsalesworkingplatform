const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const platformRoot = path.join(__dirname, '..', '..');
const indexPath = path.join(platformRoot, 'index.html');
const appPath = path.join(platformRoot, 'app.js');
const pptPath = path.join(platformRoot, 'ppt.js');
const buildInfoPath = path.join(platformRoot, 'client', 'shared', 'build_info.js');
const navigationPath = path.join(platformRoot, 'client', 'core', 'navigation.js');
const accessibilityPath = path.join(platformRoot, 'client', 'core', 'accessibility.js');
const shellPath = path.join(platformRoot, 'client', 'core', 'shell.js');
const repoRoot = path.join(platformRoot, '..');
const designSystemPath = path.join(repoRoot, 'docs', 'product', 'turingmarket-design-system.md');
const migrationPath = path.join(repoRoot, 'CLAUDE_CODE_MIGRATION.md');
const visualChangeRecordPath = path.join(repoRoot, 'docs', 'product', '2026-07-phase3-visual-change-record.md');
const accessibilityResidualRiskPath = path.join(repoRoot, 'docs', 'product', '2026-07-phase3-accessibility-residual-risks.md');
const stylePaths = [
  path.join(platformRoot, 'client', 'styles', 'tokens.css'),
  path.join(platformRoot, 'client', 'styles', 'components.css'),
  path.join(platformRoot, 'client', 'styles', 'layout.css')
];

const APP_BUILD = '20260714-v040-product-shell-design-system';
const APP_QUERY = '20260714v040productshelldesignsystem';
const PPT_BUILD = '20260702-v916-kb-bridge-client-cn';
const PPT_QUERY = '20260702v916kbbridge';
const PPT_SHA256 = 'f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e';

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sources(html, element) {
  const expression = element === 'script'
    ? /<script\s+src=["']([^"']+)["'][^>]*><\/script>/g
    : /<link\s+[^>]*href=["']([^"']+)["'][^>]*>/g;
  return Array.from(html.matchAll(expression), (match) => match[1]);
}

function openingTagById(html, id) {
  const match = html.match(new RegExp(`<[^>]+\\bid=["']${id}["'][^>]*>`, 'i'));
  assert.ok(match, `#${id} opening tag must exist`);
  return match[0];
}

function stripExternalAssets(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  assert.notEqual(end, -1, `${endMarker} must exist after ${startMarker}`);
  return source.slice(start, end);
}

async function addSharedStyles(page) {
  for (const filePath of stylePaths) {
    await page.addStyleTag({ path: filePath });
  }
}

test('v0.4 shared shell declares all five exact public assets', () => {
  for (const filePath of [...stylePaths, accessibilityPath, shellPath]) {
    assert.equal(fs.existsSync(filePath), true, `${path.relative(platformRoot, filePath)} must exist`);
  }
});

test('index loads styles and scripts in the approved v0.4 order while PPT remains frozen', () => {
  const indexHtml = read(indexPath);
  assert.deepEqual(sources(indexHtml, 'link').slice(-3), [
    `client/styles/tokens.css?v=${APP_QUERY}`,
    `client/styles/components.css?v=${APP_QUERY}`,
    `client/styles/layout.css?v=${APP_QUERY}`
  ]);
  assert.deepEqual(sources(indexHtml, 'script').slice(-6), [
    'client/shared/build_info.js',
    'client/core/navigation.js',
    'client/core/accessibility.js',
    'client/core/shell.js',
    `app.js?v=${APP_QUERY}`,
    `ppt.js?v=${PPT_QUERY}`
  ]);
  assert.match(read(buildInfoPath), new RegExp(`app:\\s*['"]${APP_BUILD}['"]`));
  assert.match(read(buildInfoPath), new RegExp(`ppt:\\s*['"]${PPT_BUILD}['"]`));
  assert.equal(sha256(pptPath), PPT_SHA256, 'locked ppt.js bytes must not change');
});

test('Direction A tokens include a visible control boundary and stable control dimensions', () => {
  const tokens = read(stylePaths[0]);
  assert.match(tokens, /--tm-color-canvas\s*:\s*#f5f7fa\b/i);
  assert.match(tokens, /--tm-color-surface\s*:\s*#fff(?:fff)?\b/i);
  assert.match(tokens, /--tm-color-text\s*:\s*#101828\b/i);
  assert.match(tokens, /--tm-color-text-muted\s*:\s*#667085\b/i);
  assert.match(tokens, /--tm-color-accent\s*:\s*#2563eb\b/i);
  assert.match(tokens, /--tm-color-control-border\s*:\s*#8a94a3\b/i);
  assert.match(tokens, /--tm-checkbox-size\s*:\s*16px\b/i);
  assert.match(tokens, /--tm-checkbox-target\s*:\s*24px\b/i);
  assert.match(tokens, /--tm-checkbox-target-mobile\s*:\s*44px\b/i);
  assert.match(tokens, /--tm-sidebar-width\s*:\s*224px\b/i);
  assert.match(tokens, /--tm-work-area-max\s*:\s*1520px\b/i);
});

test('new shared CSS forbids decorative glass effects and preserves focus and reduced motion', () => {
  const css = stylePaths.map(read).join('\n');
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\s*\(/i);
  assert.doesNotMatch(css, /backdrop-filter\s*:|filter\s*:\s*blur\s*\(/i);
  assert.doesNotMatch(css, /letter-spacing\s*:\s*-/i);
  assert.doesNotMatch(css, /transition\s*:\s*all\b/i);
  assert.match(css, /:focus-visible[\s\S]*?outline\s*:\s*2px\s+solid\s+var\(--tm-color-focus\)/i);
  assert.match(css, /:focus-visible[\s\S]*?outline-offset\s*:\s*2px\b/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  assert.match(css, /thead\s+th[\s\S]*?position\s*:\s*sticky/i);
  assert.doesNotMatch(read(indexPath), /letter-spacing\s*:\s*-/i);
});

test('focus and reduced-motion preferences are observable on actual shell motion surfaces', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 844 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(`<!doctype html><html><body>
      <button id="probe">Probe</button>
      <aside id="motionSidebar" class="sidebar"></aside>
      <a id="motionNav" class="nav-item" href="/m0">Customers</a>
      <section id="motionPage" class="page active">Page</section>
      <div id="motionToast" class="toast">Saved</div>
    </body></html>`);
    await addSharedStyles(page);
    await page.keyboard.press('Tab');
    await page.locator('#motionNav').hover();

    const styles = await page.evaluate(() => {
      const milliseconds = (value) => value.split(',').reduce((maximum, item) => {
        const normalized = item.trim();
        const numeric = Number.parseFloat(normalized) || 0;
        return Math.max(maximum, normalized.endsWith('ms') ? numeric : numeric * 1000);
      }, 0);
      const motion = (id) => {
        const computed = getComputedStyle(document.getElementById(id));
        return {
          animationMilliseconds: milliseconds(computed.animationDuration),
          transitionMilliseconds: milliseconds(computed.transitionDuration),
          transform: computed.transform
        };
      };
      const computed = getComputedStyle(document.getElementById('probe'));
      return {
        outlineOffset: computed.outlineOffset,
        outlineStyle: computed.outlineStyle,
        outlineWidth: computed.outlineWidth,
        sidebar: motion('motionSidebar'),
        nav: motion('motionNav'),
        page: motion('motionPage'),
        toast: motion('motionToast')
      };
    });

    assert.deepEqual(
      { width: styles.outlineWidth, style: styles.outlineStyle, offset: styles.outlineOffset },
      { width: '2px', style: 'solid', offset: '2px' }
    );
    for (const surface of ['sidebar', 'nav', 'page', 'toast']) {
      assert.ok(styles[surface].animationMilliseconds <= 0.01, `${surface} animation must be minimized`);
      assert.ok(styles[surface].transitionMilliseconds <= 0.01, `${surface} transition must be minimized`);
      assert.equal(styles[surface].transform, 'none', `${surface} transform must be disabled`);
    }
  } finally {
    await browser.close();
  }
});

test('static shell keeps authentication authoritative and exposes mobile navigation semantics', () => {
  const indexHtml = read(indexPath);
  const layoutCss = read(stylePaths[2]);
  assert.match(indexHtml, /<a[^>]+class=["'][^"']*tm-skip-link[^"']*["'][^>]+href=["']#mainContent["']/i);
  assert.match(indexHtml, /<main\s+id=["']mainContent["']\s+tabindex=["']-1["']/i);
  assert.match(indexHtml, /<nav[^>]+id=["']tmSidebar["'][^>]+aria-label=["'][^"']+["']/i);
  const navOpen = openingTagById(indexHtml, 'tmNavOpen');
  assert.match(navOpen, /aria-label=["'][^"']+["']/i);
  assert.match(navOpen, /aria-controls=["']tmSidebar["']/i);
  assert.match(indexHtml, /id=["']tmNavClose["'][^>]+aria-label=/i);
  assert.match(indexHtml, /id=["']tmNavBackdrop["']/i);
  assert.match(indexHtml, /id=["']tmMobilePageTitle["']/i);
  assert.doesNotMatch(indexHtml, /#app\s*\{[^}]*display\s*:\s*block\s*!important/i);
  assert.doesNotMatch(layoutCss, /#app\s*\{[^}]*display\s*:\s*block\s*!important/i);
});

test('mobile authentication remains hidden before login and after simulated session expiry', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(stripExternalAssets(read(indexPath)));
    await addSharedStyles(page);

    assert.equal(await page.locator('#app').evaluate((element) => getComputedStyle(element).display), 'none');
    await page.locator('#app').evaluate((element) => { element.style.display = 'flex'; });
    assert.notEqual(await page.locator('#app').evaluate((element) => getComputedStyle(element).display), 'none');

    await page.evaluate(() => {
      document.getElementById('app').style.display = 'none';
      document.getElementById('authOverlay').style.display = 'flex';
    });
    assert.equal(await page.locator('#app').evaluate((element) => getComputedStyle(element).display), 'none');
    assert.notEqual(await page.locator('#authOverlay').evaluate((element) => getComputedStyle(element).display), 'none');
  } finally {
    await browser.close();
  }
});

test('actual index startup keeps authentication interactive and ignores closed off-canvas dialogs', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(stripExternalAssets(read(indexPath)));
    await addSharedStyles(page);
    await page.addScriptTag({ path: accessibilityPath });
    await page.waitForTimeout(30);

    assert.equal(await page.locator('#authOverlay').evaluate((element) => element.inert), false);
    assert.equal(await page.locator('#app').evaluate((element) => element.inert), false);
    assert.equal(await page.locator('#customerDetailDialog').evaluate((element) => element.contains(document.activeElement)), false);
  } finally {
    await browser.close();
  }
});

test('reduced motion preserves the mobile drawer closed and open state', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(stripExternalAssets(read(indexPath)));
    await addSharedStyles(page);
    await page.evaluate(() => {
      document.getElementById('authOverlay').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
    });
    await page.addScriptTag({ path: shellPath });

    const closed = await page.locator('#tmSidebar').boundingBox();
    assert.ok(closed.x + closed.width <= 1, 'closed drawer must remain outside the viewport');
    assert.equal(await page.locator('#tmSidebar').evaluate((element) => element.inert), true);
    await page.locator('#tmNavOpen').click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('tmSidebar')).transform === 'none');
    const opened = await page.locator('#tmSidebar').boundingBox();
    const openState = await page.evaluate(() => ({
      bodyClass: document.body.className,
      expanded: document.getElementById('tmNavOpen').getAttribute('aria-expanded'),
      transform: getComputedStyle(document.getElementById('tmSidebar')).transform
    }));
    assert.ok(opened.x >= -1, `open drawer must enter the viewport: ${JSON.stringify({ opened, openState })}`);
    assert.equal(await page.locator('#tmSidebar').evaluate((element) => element.inert), false);
  } finally {
    await browser.close();
  }
});

test('mobile route clicks close the drawer before focusing the destination heading', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(stripExternalAssets(read(indexPath)));
    await addSharedStyles(page);
    await page.evaluate(() => {
      document.getElementById('authOverlay').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      window.history.pushState = function () {};
      window.history.replaceState = function () {};
    });
    await page.addScriptTag({ path: navigationPath });
    await page.addScriptTag({ path: shellPath });
    await page.locator('#tmNavOpen').click();
    await page.locator('#tmSidebar [data-page="m1"]').click();

    assert.equal(await page.locator('#tmNavOpen').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#mainContent').evaluate((element) => element.inert), false);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#page-m1 h2')), true);
  } finally {
    await browser.close();
  }
});

test('production M4 tabs, upload surfaces, filters, and CRM view controls are keyboard named', async () => {
  const switchTabSource = sourceBetween(read(appPath), 'function switchTab(id, options)', '// ===== M4: INFLUENCER MATCHING');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(stripExternalAssets(read(indexPath)));
    await page.evaluate(() => {
      document.getElementById('authOverlay').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      document.querySelectorAll('.page').forEach((pageElement) => pageElement.classList.remove('active'));
      document.getElementById('page-m4').classList.add('active');
      window.uploadClicks = 0;
      document.getElementById('infFile').click = () => { window.uploadClicks += 1; };
    });
    await addSharedStyles(page);
    await page.addScriptTag({ content: switchTabSource });
    await page.addScriptTag({ path: accessibilityPath });

    const firstTab = page.locator('#tabBar [data-tab="tab1"]');
    assert.equal(await firstTab.getAttribute('aria-controls'), 'tab1-content');
    assert.equal(await page.locator('#tab1-content').getAttribute('role'), 'tabpanel');
    await page.locator('#tabBar [data-tab="tab2"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(10);
    assert.equal(await page.locator('#tabBar [data-tab="tab2"]').getAttribute('aria-selected'), 'true');
    await page.locator('#tabBar [data-tab="tab3"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(10);

    const upload = page.locator('#infDropZone');
    assert.equal(await upload.getAttribute('role'), 'button');
    assert.equal(await upload.getAttribute('tabindex'), '0');
    assert.ok(await upload.getAttribute('aria-label'));
    await upload.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.uploadClicks), 2);
    assert.ok(await page.locator('#infFile').getAttribute('aria-label'));
    assert.ok(await page.locator('#demandFile').getAttribute('aria-label'));

    await page.evaluate(() => window.switchTab('tab1', { skipHistory: true }));
    assert.equal(await page.locator('#tabBar [data-tab="tab1"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#tab1-content').evaluate((element) => element.hidden), false);
    assert.equal(await page.locator('#tab3-content').evaluate((element) => element.hidden), true);

    for (const id of ['filt_search', 'filt_project', 'filt_product', 'filt_platform', 'filt_region', 'filt_tags', 'collabFilter']) {
      assert.ok(await page.locator(`#${id}`).getAttribute('aria-label'), `#${id} must have an accessible name`);
    }
    assert.equal(await page.locator('.tm-crm-tabs .crm-tab').first().evaluate((element) => element.tagName), 'BUTTON');
  } finally {
    await browser.close();
  }
});

test('Direction A overrides legacy glass surfaces and implements checkbox target geometry', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(stripExternalAssets(read(indexPath)));
    await addSharedStyles(page);
    const surfaces = await page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        panelBackdrop: style('.tm-glass-panel').backdropFilter,
        panelImage: style('.tm-glass-panel').backgroundImage,
        stageImage: style('.tm-stage-fill').backgroundImage,
        aiImage: style('.tm-ai-panel').backgroundImage,
        strategyCardImage: style('#page-m2 > .card').backgroundImage
      };
    });
    assert.ok(!surfaces.panelBackdrop || surfaces.panelBackdrop === 'none');
    assert.equal(surfaces.panelImage, 'none');
    assert.equal(surfaces.stageImage, 'none');
    assert.equal(surfaces.aiImage, 'none');
    assert.equal(surfaces.strategyCardImage, 'none');

    await page.evaluate(() => {
      const target = document.createElement('label');
      target.id = 'checkboxTarget';
      target.className = 'tm-checkbox-target';
      target.innerHTML = '<input id="checkboxGlyph" type="checkbox" aria-label="Select row">';
      document.body.appendChild(target);
    });
    const desktopTarget = await page.locator('#checkboxTarget').boundingBox();
    const glyph = await page.locator('#checkboxGlyph').boundingBox();
    assert.ok(desktopTarget.width >= 24 && desktopTarget.height >= 24);
    assert.deepEqual({ width: glyph.width, height: glyph.height }, { width: 16, height: 16 });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileTarget = await page.locator('#checkboxTarget').boundingBox();
    assert.ok(mobileTarget.width >= 44 && mobileTarget.height >= 44);
  } finally {
    await browser.close();
  }
});

test('login is a labelled form with announced inline errors and browser autofill contracts', () => {
  const indexHtml = read(indexPath);
  const form = openingTagById(indexHtml, 'loginForm');
  const user = openingTagById(indexHtml, 'loginUser');
  const password = openingTagById(indexHtml, 'loginPass');
  const error = openingTagById(indexHtml, 'loginError');

  assert.match(form, /^<form\b/i);
  assert.match(indexHtml, /<label[^>]+for=["']loginUser["'][^>]*>/i);
  assert.match(user, /^<input\b/i);
  assert.match(user, /name=["']username["']/i);
  assert.match(user, /autocomplete=["']username["']/i);
  assert.match(user, /aria-describedby=["']loginError["']/i);
  assert.match(indexHtml, /<label[^>]+for=["']loginPass["'][^>]*>/i);
  assert.match(password, /^<input\b/i);
  assert.match(password, /name=["']password["']/i);
  assert.match(password, /autocomplete=["']current-password["']/i);
  assert.match(password, /aria-describedby=["']loginError["']/i);
  assert.match(error, /role=["']alert["']/i);
  assert.match(error, /aria-live=["']assertive["']/i);
});

test('off-screen native PPT upload input is named and removed from sequential focus', () => {
  const input = openingTagById(read(indexPath), 'pptContextFile');
  assert.match(input, /aria-label=["'][^"']+["']/i);
  assert.match(input, /tabindex=["']-1["']/i);
});

test('static overlays expose labelled dialog or drawer contracts and named close controls', () => {
  const indexHtml = read(indexPath);
  for (const id of [
    'customerDialog',
    'influencerUploadDialog',
    'customerDetailDialog',
    'workflowInstanceDialog',
    'opportunityDialog',
    'confirmDialog'
  ]) {
    const dialog = openingTagById(indexHtml, id);
    assert.match(dialog, /role=["']dialog["']/i, `${id} must use role=dialog`);
    assert.match(dialog, /aria-modal=["']true["']/i, `${id} must be modal`);
    const labelledBy = dialog.match(/aria-labelledby=["']([^"']+)["']/i);
    assert.ok(labelledBy, `${id} must use aria-labelledby`);
    openingTagById(indexHtml, labelledBy[1]);
  }
  const closeButtons = Array.from(indexHtml.matchAll(/<button[^>]+class=["'][^"']*(?:modal-close|wf-modal-close)[^"']*["'][^>]*>/gi));
  assert.ok(closeButtons.length >= 4, 'representative dialog close controls must exist');
  for (const [button] of closeButtons) {
    assert.match(button, /aria-label=["'][^"']+["']/i);
    assert.match(button, /title=["'][^"']+["']/i);
  }

  for (const id of ['customerDetailPanel', 'custDetailSidebar']) {
    const closedDrawer = openingTagById(indexHtml, id);
    assert.match(closedDrawer, /\shidden(?:\s|>|=)/i, `${id} must be initially hidden`);
    assert.match(closedDrawer, /\sinert(?:\s|>|=)/i, `${id} must be initially inert`);
    assert.match(closedDrawer, /aria-hidden=["']true["']/i, `${id} must be absent from the initial accessibility tree`);
  }
});

test('navigation source uses canonical anchors and never suppresses heading focus', () => {
  const navigation = read(navigationPath);
  assert.match(navigation, /document\.createElement\(['"]a['"]\)/);
  assert.match(navigation, /setAttribute\(['"]href['"],\s*pathForState/);
  assert.match(navigation, /event\.button\s*!==\s*0/);
  for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.match(navigation, new RegExp(`event\\.${modifier}`));
  }
  assert.match(navigation, /aria-current/);
  assert.match(navigation, /aria-hidden/);
  for (const group of ['客户经营', '方案与执行', '流程协作', '系统管理']) {
    assert.match(navigation, new RegExp(group));
  }
  assert.doesNotMatch(navigation, /style\.outline\s*=\s*['"]none['"]/);
});

test('shared app hooks announce auth/status and name M4/workflow controls without changing data flow', () => {
  const app = read(appPath);
  const loginErrorHook = sourceBetween(app, 'function showLoginError', 'async function doLogout');
  const toastHook = sourceBetween(app, 'function toast', 'function toggleBrandDetail');
  assert.match(app, /loginError[\s\S]*?textContent\s*=\s*msg/);
  assert.match(app, /loginUser[\s\S]*?\.focus\s*\(/);
  assert.doesNotMatch(loginErrorHook, /toast\s*\(/);
  assert.doesNotMatch(toastHook, /toastContainer[\s\S]*?aria-live/);
  assert.match(toastHook, /tm-toast-message[\s\S]*?setAttribute\(['"]role['"]/);
  assert.match(toastHook, /ty\s*===\s*['"]error['"]\s*\?\s*['"]alert['"]\s*:\s*['"]status['"]/);
  assert.match(toastHook, /aria-label['"],\s*['"]关闭通知['"]/);
  assert.doesNotMatch(toastHook, /setTimeout[\s\S]*?remove/);
  assert.match(toastHook, /TOAST_QUEUE_LIMIT\s*=\s*3/);
  assert.match(app, /aria-label=["']全选网红["']/);
  assert.match(app, /aria-label=["']选择网红/);
  assert.match(app, /indeterminate/);
  assert.match(app, /tm-checkbox-target/);
  assert.match(app, /collabOrderDialog[\s\S]*?role=["']dialog["']/);
  assert.match(app, /brandRelationDialog[\s\S]*?aria-modal["']?,?[\s\S]*?TMAccessibility\.openDialog/);
  assert.match(app, /showConfirm[\s\S]*?TMAccessibility\.openDialog/);
});

test('Phase 3 docs distinguish deterministic visual gates and record bounded accessibility evidence', () => {
  const designSystem = read(designSystemPath);
  const migration = read(migrationPath);
  const visualChangeRecord = read(visualChangeRecordPath);

  assert.match(designSystem, /Toast container[^\n]+non-live/i);
  assert.match(designSystem, /each (?:toast )?message[^\n]+role="status"[^\n]+role="alert"/i);
  assert.doesNotMatch(designSystem, /Toast container uses `role="status"`/i);

  assert.match(migration, /0\.005[^\n]+repeat-capture|repeat-capture[^\n]+0\.005/i);
  assert.match(migration, /0\.14496597399441002/);
  assert.match(migration, /intentional[^\n]+reviewed/i);

  assert.equal(fs.existsSync(accessibilityResidualRiskPath), true, 'tracked accessibility residual-risk report must exist');
  const residual = read(accessibilityResidualRiskPath);
  for (const required of [
    'NVDA',
    'VoiceOver',
    'browser-native zoom',
    'CSS viewport reflow equivalence',
    'not a full WCAG conformance claim',
    'Phase 4'
  ]) {
    assert.ok(residual.includes(required), `residual-risk report must state: ${required}`);
  }
  assert.match(visualChangeRecord, /2026-07-phase3-accessibility-residual-risks\.md/);
  assert.doesNotMatch(visualChangeRecord, /Task 5 report/i);
});

test('workflow palette and rendered nodes execute keyboard alternatives exactly once', async () => {
  const app = read(appPath);
  const initWorkflowDesigner = sourceBetween(
    app,
    'function initWorkflowDesigner()',
    '// ---- Node Management ----'
  );
  const renderWorkflowNode = sourceBetween(app, 'function wfRenderNode(node)', 'function wfRenderEdge(edge)');
  assert.match(renderWorkflowNode, /requestAnimationFrame[\s\S]*?data-node-id[\s\S]*?focus\s*\(/);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(`<!doctype html><html><body>
      <section id="page-workflow-designer" style="display:block">
        <div id="wf-canvas-wrapper">
          <div class="wf-node-palette" data-type="task">Task</div>
          <svg id="wf-svg-canvas" style="display:block;width:600px;height:400px">
            <g id="wf-edges-layer"></g>
            <g id="wf-nodes-layer"></g>
            <line id="wf-connection-line" style="display:none"></line>
          </svg>
        </div>
      </section>
    </body></html>`);
    await page.addScriptTag({ content: `
      window.workflowAdds = [];
      window.workflowSelections = [];
      window.wfState = {
        selectedNode: null,
        selectedEdge: null,
        draggingNode: null,
        connectingFrom: null,
        designerBindingsBound: false,
        nodes: [],
        edges: []
      };
      window.wfAddNode = function (type, x, y) { window.workflowAdds.push({ type: type, x: x, y: y }); };
      window.wfSelectNode = function (id) { window.workflowSelections.push(id); };
      window.wfHandleWorkflowPointerMove = function () {};
      window.wfHandleWorkflowPointerUp = function () {};
      window.wfDeselectAll = function () {};
      window.wfDeleteSelected = function () {};
      window.wfUndo = function () {};
      window.wfRedo = function () {};
      ${initWorkflowDesigner}
      ${renderWorkflowNode}
      initWorkflowDesigner();
      wfRenderNode({ id: 'node_1', type: 'task', label: 'Task', x: 100, y: 80, width: 120, height: 60 });
    ` });

    const palette = page.locator('.wf-node-palette');
    assert.equal(await palette.getAttribute('tabindex'), '0');
    await palette.focus();
    await page.keyboard.press('Enter');
    assert.equal((await page.evaluate(() => window.workflowAdds)).length, 1);
    await page.keyboard.press('Space');
    const additions = await page.evaluate(() => window.workflowAdds);
    assert.equal(additions.length, 2);
    const canvas = await page.locator('#wf-svg-canvas').boundingBox();
    for (const addition of additions) {
      assert.equal(addition.type, 'task');
      assert.ok(Math.abs(addition.x - canvas.width / 2) <= 1, 'palette node x must use the canvas center');
      assert.ok(Math.abs(addition.y - canvas.height / 2) <= 1, 'palette node y must use the canvas center');
    }

    const node = page.locator('.wf-node-svg[data-node-id="node_1"]');
    assert.equal(await node.getAttribute('tabindex'), '0');
    assert.match(await node.getAttribute('aria-label'), /Task/i);
    await node.focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.workflowSelections), ['node_1']);
    await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => window.workflowSelections), ['node_1', 'node_1']);
  } finally {
    await browser.close();
  }
});
