'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const platformRoot = path.join(__dirname, '..', '..');
const accessibilityPath = path.join(platformRoot, 'client', 'core', 'accessibility.js');
const shellPath = path.join(platformRoot, 'client', 'core', 'shell.js');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

async function withModulePage({ html, modulePath, viewport = { width: 390, height: 844 } }, run) {
  assert.equal(fs.existsSync(modulePath), true, `${path.relative(platformRoot, modulePath)} must exist`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport });
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    await page.addScriptTag({ path: modulePath });
    await run(page);
  } finally {
    await browser.close();
  }
}

test('accessibility module exposes the exact frozen interface and initializes idempotently', async () => {
  const source = read(accessibilityPath);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage/);

  await withModulePage({
    modulePath: accessibilityPath,
    html: '<label id="emailLabel">Email<input id="email"></label>'
  }, async (page) => {
    const result = await page.evaluate(() => {
      window.TMAccessibility.init();
      const firstId = document.getElementById('email').id;
      window.TMAccessibility.init();
      return {
        frozen: Object.isFrozen(window.TMAccessibility),
        keys: Object.keys(window.TMAccessibility).sort(),
        firstId,
        secondId: document.getElementById('email').id,
        inputCount: document.querySelectorAll('#email').length
      };
    });

    assert.equal(result.frozen, true);
    assert.deepEqual(result.keys, ['closeDialog', 'init', 'openDialog', 'refresh']);
    assert.equal(result.firstId, result.secondId);
    assert.equal(result.inputCount, 1);
  });
});

test('accessibility refresh associates labels and hides decorative navigation icons', async () => {
  await withModulePage({
    modulePath: accessibilityPath,
    html: '<label id="searchLabel">Search<input id="searchInput"></label><a class="nav-item"><span class="nav-icon">I</span><span>Customers</span></a>'
  }, async (page) => {
    await page.evaluate(() => {
      window.TMAccessibility.init();
      window.TMAccessibility.refresh();
    });
    assert.equal(await page.locator('#searchLabel').getAttribute('for'), 'searchInput');
    assert.equal(await page.locator('.nav-icon').getAttribute('aria-hidden'), 'true');
  });
});

test('tabs use roving focus and activate Enter and Space exactly once each', async () => {
  await withModulePage({
    modulePath: accessibilityPath,
    html: `
      <div class="tabs" id="tabBar">
        <div class="tab active" data-tab="tab1" onclick="activateTab('tab1')">First</div>
        <div class="tab" data-tab="tab2" onclick="activateTab('tab2')">Second</div>
      </div>
      <section id="tab1" class="tab-content">First panel</section>
      <section id="tab2" class="tab-content" hidden>Second panel</section>
      <script>
        window.activations = [];
        window.activateTab = function (id) {
          window.activations.push(id);
          document.querySelectorAll('.tab').forEach(function (tab) {
            tab.classList.toggle('active', tab.dataset.tab === id);
          });
        };
      </script>
    `
  }, async (page) => {
    await page.evaluate(() => window.TMAccessibility.init());
    const tabs = page.locator('.tab');
    assert.equal(await page.locator('#tabBar').getAttribute('role'), 'tablist');
    assert.equal(await tabs.nth(0).getAttribute('role'), 'tab');
    assert.equal(await page.locator('#tab1').getAttribute('role'), 'tabpanel');
    assert.equal(await tabs.nth(0).getAttribute('tabindex'), '0');
    assert.equal(await tabs.nth(1).getAttribute('tabindex'), '-1');
    assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
    assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'false');

    const tabAssociations = await page.evaluate(() => {
      const first = document.querySelector('[data-tab="tab1"]');
      const second = document.querySelector('[data-tab="tab2"]');
      return {
        zeroTabStops: document.querySelectorAll('#tabBar [tabindex="0"]').length,
        firstControls: first.getAttribute('aria-controls'),
        secondControls: second.getAttribute('aria-controls'),
        firstLabel: document.getElementById('tab1').getAttribute('aria-labelledby'),
        secondLabel: document.getElementById('tab2').getAttribute('aria-labelledby'),
        firstId: first.id,
        secondId: second.id,
        firstHidden: document.getElementById('tab1').hidden,
        secondHidden: document.getElementById('tab2').hidden
      };
    });
    assert.deepEqual(tabAssociations, {
      zeroTabStops: 1,
      firstControls: 'tab1',
      secondControls: 'tab2',
      firstLabel: tabAssociations.firstId,
      secondLabel: tabAssociations.secondId,
      firstId: tabAssociations.firstId,
      secondId: tabAssociations.secondId,
      firstHidden: false,
      secondHidden: true
    });
    assert.ok(tabAssociations.firstId && tabAssociations.secondId);

    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), 'tab2');
    assert.equal(await tabs.nth(1).getAttribute('tabindex'), '0');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.activations), ['tab2']);
    assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'false');
    assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#tab1').evaluate((element) => element.hidden), true);
    assert.equal(await page.locator('#tab2').evaluate((element) => element.hidden), false);

    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), 'tab1');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), 'tab2');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), 'tab1');
    await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => window.activations), ['tab2', 'tab1']);
    assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#tab1').evaluate((element) => element.hidden), false);
    assert.equal(await page.locator('#tab2').evaluate((element) => element.hidden), true);
  });
});

test('upload surface activates its native file input exactly once per keyboard command', async () => {
  await withModulePage({
    modulePath: accessibilityPath,
    html: '<label for="uploadInput">Choose influencer file</label><div class="file-upload" id="uploadSurface"><input id="uploadInput" type="file"></div>'
  }, async (page) => {
    await page.evaluate(() => {
      window.nativeFileClicks = 0;
      document.getElementById('uploadInput').click = () => { window.nativeFileClicks += 1; };
      window.TMAccessibility.init();
      window.TMAccessibility.init();
    });

    const surface = page.locator('#uploadSurface');
    assert.equal(await surface.getAttribute('role'), 'button');
    assert.equal(await surface.getAttribute('tabindex'), '0');
    await surface.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.nativeFileClicks), 1);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.nativeFileClicks), 2);
    assert.equal(await page.locator('#uploadInput').getAttribute('type'), 'file');
    assert.equal(
      await page.locator('#uploadInput').evaluate((input) => input.labels && input.labels[0].textContent.trim()),
      'Choose influencer file'
    );
  });
});

test('dialogs trap focus, inert the background, close on Escape, and restore the opener', async () => {
  await withModulePage({
    modulePath: accessibilityPath,
    html: `
      <button id="opener">Open</button>
      <main id="background"><button>Background action</button></main>
      <div id="dialog" role="dialog" aria-modal="true" aria-labelledby="dialogTitle" hidden>
        <h2 id="dialogTitle">Dialog title</h2>
        <button id="firstAction">First</button>
        <button id="lastAction">Last</button>
      </div>
    `
  }, async (page) => {
    await page.evaluate(() => {
      window.TMAccessibility.init();
      window.TMAccessibility.openDialog(
        document.getElementById('dialog'),
        document.getElementById('opener')
      );
    });

    assert.equal(await page.locator('#dialog').getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('#background').evaluate((element) => element.inert), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'firstAction');

    await page.locator('#lastAction').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'firstAction');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'lastAction');

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#background').evaluate((element) => element.inert), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');
    assert.equal(await page.locator('#dialog').evaluate((element) => element.hidden || getComputedStyle(element).display === 'none'), true);
  });
});

test('navigation events refresh the document title and live status semantics', async () => {
  await withModulePage({
    modulePath: accessibilityPath,
    html: `
      <section class="page active"><h1>Customer board</h1></section>
      <div id="toastContainer"><div class="toast">Saved</div></div>
    `
  }, async (page) => {
    const result = await page.evaluate(() => {
      window.TMAccessibility.init();
      document.dispatchEvent(new CustomEvent('tm:navigation-applied'));
      const live = document.getElementById('toastContainer');
      return { title: document.title, role: live.getAttribute('role'), live: live.getAttribute('aria-live') };
    });
    assert.match(result.title, /Customer board/);
    assert.equal(result.role, 'status');
    assert.equal(result.live, 'polite');
  });
});

test('mobile shell initializes safely when shell nodes are absent', async () => {
  await withModulePage({
    modulePath: shellPath,
    html: '<main>Standalone content</main>'
  }, async (page) => {
    const result = await page.evaluate(() => {
      window.TMShell.init();
      window.TMShell.init();
      return window.TMShell.isNavigationOpen();
    });
    assert.equal(result, false);
  });
});

test('mobile shell owns the complete idempotent drawer state machine without changing auth display', async () => {
  await withModulePage({
    modulePath: shellPath,
    html: `
      <div id="app" style="display:flex">
        <button id="tmNavOpen" aria-controls="tmSidebar" aria-expanded="false">Open</button>
        <span id="tmMobilePageTitle"></span>
        <nav id="tmSidebar" aria-hidden="true">
          <button id="tmNavClose">Close</button>
          <a id="activeNav" class="nav-item active" data-page="m0" href="/m0">Customers</a>
        </nav>
        <button id="tmNavBackdrop" hidden>Dismiss</button>
        <main>Content</main>
      </div>
    `
  }, async (page) => {
    const contract = await page.evaluate(() => {
      window.TMShell.init();
      window.TMShell.init();
      return {
        frozen: Object.isFrozen(window.TMShell),
        keys: Object.keys(window.TMShell).sort(),
        appDisplay: getComputedStyle(document.getElementById('app')).display
      };
    });
    assert.equal(contract.frozen, true);
    assert.deepEqual(contract.keys, ['init', 'isNavigationOpen', 'setNavigationOpen']);
    assert.equal(contract.appDisplay, 'flex');

    await page.locator('#tmNavOpen').click();
    assert.equal(await page.locator('#tmNavOpen').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#tmSidebar').getAttribute('aria-hidden'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tmNavClose');

    await page.locator('#activeNav').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tmNavClose');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'activeNav');

    await page.locator('#tmNavClose').click();
    assert.equal(await page.locator('#tmNavOpen').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tmNavOpen');

    await page.locator('#tmNavOpen').click();
    await page.locator('#tmNavBackdrop').click();
    assert.equal(await page.locator('#tmNavOpen').getAttribute('aria-expanded'), 'false');

    await page.locator('#tmNavOpen').click();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('tm:navigation-applied', {
      detail: { state: { pageId: 'm0' } }
    })));
    assert.equal(await page.locator('#tmNavOpen').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#tmMobilePageTitle').textContent(), 'Customers');

    await page.locator('#tmNavOpen').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tmNavOpen').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tmNavOpen');

    await page.locator('#tmNavOpen').click();
    await page.setViewportSize({ width: 1024, height: 844 });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#tmNavOpen').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#tmSidebar').getAttribute('aria-hidden'), 'false');
    assert.equal(await page.locator('#app').evaluate((element) => getComputedStyle(element).display), 'flex');
  });
});
