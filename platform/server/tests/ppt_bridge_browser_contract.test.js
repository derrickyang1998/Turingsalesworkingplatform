'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-deploy');
const {
  installBaselineAuthState,
  installBaselineBrowserControls,
  installFixtureApi,
  loadBaselineFixture
} = require('./helpers/browser_fixture');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const serverRoot = path.join(platformRoot, 'server');
const privateRunRoot = path.join(repoRoot, '.superpowers', 'sdd', 'task-10-ppt-contract');
const fixture = loadBaselineFixture();
const TEST_JWT_SECRET = 'Gq4ciweEvyDk7NmUz9vWUTYtYKlE63fJYMmApVa39nU';

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function publicTestEnvironment(port, dbPath) {
  const allowed = [
    'ComSpec', 'HOME', 'PATH', 'Path', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR', 'windir'
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return Object.assign(env, {
    NODE_ENV: 'test',
    PORT: String(port),
    SERVER_HOST: '127.0.0.1',
    TM_DISABLE_DOTENV: '1',
    DB_PATH: dbPath,
    UPLOAD_SANDBOX_SPOOL_ROOT: path.join(path.dirname(dbPath), 'upload-sandbox'),
    TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
    JWT_SECRET: TEST_JWT_SECRET,
    DEFAULT_ADMIN_USERNAME: 'task10-admin',
    DEFAULT_ADMIN_PASSWORD: 'task-10-browser-contract-password',
    OBISIDIAN_KB_ROOT: '',
    PLATFORM_KB_VAULT_ROOT: ''
  });
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 20_000;
  const readyMarker = 'TuringMarket server running on http://localhost:' + new URL(baseUrl).port;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Task 10 fixture server exited early:\n' + output.join(''));
    }
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok && output.join('').includes(readyMarker)) return;
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Task 10 fixture server:\n' + output.join(''));
}

async function waitForChildExit(child, timeoutMs) {
  if (!child.pid) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer;
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  return exited || child.exitCode !== null || child.signalCode !== null;
}

async function terminateServer(child, output) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let exited = await waitForChildExit(child, 5_000);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    exited = await waitForChildExit(child, 5_000);
  }
  assert.equal(exited, true, 'Task 10 fixture server failed to exit:\n' + output.join(''));
}

function makeRunRoot() {
  const allowedRoot = path.resolve(privateRunRoot);
  fs.mkdirSync(allowedRoot, { recursive: true });
  return fs.mkdtempSync(path.join(allowedRoot, 'run-'));
}

function removeRunRoot(runRoot) {
  const allowedRoot = path.resolve(privateRunRoot);
  const target = path.resolve(runRoot);
  if (path.dirname(target) !== allowedRoot) throw new Error('Refusing unsafe Task 10 cleanup');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.equal(fs.existsSync(target), false, 'Task 10 temporary run root must be removed');
}

function assertDownloadFilenameContract(requestedFilename, suggestedFilename, extension, platform = process.platform) {
  const expectedSuffix = `.${extension}`.toLowerCase();
  assert.equal(
    requestedFilename.toLowerCase().endsWith(expectedSuffix),
    true,
    `the application must request a ${expectedSuffix} download filename`
  );
  if (suggestedFilename.toLowerCase().endsWith(expectedSuffix)) return;

  const linuxUnicodeFallback = platform === 'linux'
    && suggestedFilename === 'download'
    && /[^\x00-\x7f]/.test(requestedFilename);
  assert.equal(
    linuxUnicodeFallback,
    true,
    `unexpected browser download filename: requested=${requestedFilename}, suggested=${suggestedFilename}, platform=${platform}`
  );
}

async function triggerDownloadWithRequestedFilename(page, globalFunctionName) {
  await page.evaluate(() => {
    const nativeClick = HTMLAnchorElement.prototype.click;
    window.__tmNativeDownloadClick = nativeClick;
    window.__tmRequestedDownloadFilename = null;
    HTMLAnchorElement.prototype.click = function interceptedDownloadClick(...args) {
      window.__tmRequestedDownloadFilename = String(this.download || '');
      HTMLAnchorElement.prototype.click = nativeClick;
      return nativeClick.apply(this, args);
    };
  });

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate((functionName) => window[functionName](), globalFunctionName);
  const download = await downloadPromise;
  const capture = await page.evaluate(() => ({
    requestedFilename: window.__tmRequestedDownloadFilename,
    nativeClickRestored: HTMLAnchorElement.prototype.click === window.__tmNativeDownloadClick
  }));
  assert.equal(capture.nativeClickRestored, true, 'the download click interception must restore the native prototype');
  const requestedFilename = capture.requestedFilename;
  assert.equal(typeof requestedFilename, 'string', 'the application download request must be observable');
  return { download, requestedFilename };
}

test('browser download filename compatibility is limited to Linux Unicode requests', () => {
  assert.doesNotThrow(() => assertDownloadFilenameContract('TuringMarket方案.html', 'download', 'html', 'linux'));
  assert.doesNotThrow(() => assertDownloadFilenameContract('TuringMarket方案.pptx', 'download', 'pptx', 'linux'));
  assert.throws(
    () => assertDownloadFilenameContract('TuringMarket.pptx', 'download', 'pptx', 'linux'),
    /unexpected browser download filename/
  );
  assert.throws(
    () => assertDownloadFilenameContract('TuringMarket方案.pptx', 'download', 'pptx', 'win32'),
    /unexpected browser download filename/
  );
  for (const nearMiss of ['Download', 'download.tmp']) {
    assert.throws(
      () => assertDownloadFilenameContract('TuringMarket方案.pptx', nearMiss, 'pptx', 'linux'),
      /unexpected browser download filename/
    );
  }
  assert.throws(
    () => assertDownloadFilenameContract('TuringMarket方案.html', 'download', 'pptx', 'linux'),
    /application must request a \.pptx download filename/
  );
});

async function startFixtureServerAttempt() {
  const port = await reservePort();
  const runRoot = makeRunRoot();
  const dbPath = path.join(runRoot, 'fixture.db');
  const output = [];
  let child;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: serverRoot,
      env: publicTestEnvironment(port, dbPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));
    const spawnFailure = new Promise((resolve, reject) => {
      child.once('error', (error) => {
        output.push(String(error && error.message ? error.message : error));
        reject(error);
      });
    });
    await Promise.race([waitForServer(baseUrl, child, output), spawnFailure]);
    return { port, runRoot, output, child, baseUrl };
  } catch (error) {
    try {
      if (child) await terminateServer(child, output);
    } finally {
      removeRunRoot(runRoot);
    }
    throw error;
  }
}

async function startFixtureServer() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await startFixtureServerAttempt();
    } catch (error) {
      lastError = error;
      if (!/EADDRINUSE/.test(String(error && error.message ? error.message : error))) throw error;
    }
  }
  throw lastError || new Error('Task 10 fixture server could not reserve a loopback port');
}

function structuredOutline() {
  return {
    outline: {
      title: 'Task 10 Success Deck',
      subtitle: 'Locked PPT bridge browser contract',
      sections: [
        { title: 'Task 10 Success Deck', type: 'cover', points: ['Locked PPT bridge browser contract'], note: 'TuringMarket' },
        { title: 'Knowledge-grounded strategy', type: 'content', points: ['Use approved context', 'Preserve the latest interface'], note: 'Contract evidence' },
        { title: 'Budget and KPI', type: 'stats', points: ['$25K campaign budget', '35 creators', '4.5% engagement target'], note: 'Measured outputs' }
      ]
    },
    research: {
      queries: ['Task 10 fixture research'],
      sources: [{ title: 'Fixture source', url: 'https://fixture.invalid/task-10' }]
    },
    knowledge_references: [{ id: 10, title: 'Task 10 knowledge fixture' }],
    fallback: false
  };
}

async function installScenarioRoutes(page, state) {
  await page.route('**/api/demand/parse-file', async (route) => {
    const request = route.request();
    const postData = request.postDataBuffer();
    state.parseCalls.push({
      method: request.method(),
      url: request.url(),
      contentType: request.headers()['content-type'] || '',
      body: postData ? Buffer.from(postData).toString('utf8') : ''
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        fileName: 'task10-context.txt',
        extractedText: 'Task 10 approved context requires the latest interface, knowledge-grounded recommendations, editable slides, and measurable campaign outcomes. This readable fixture text must reach the AI outline request without production network access.',
        fallback: false,
        parser: 'task-10-browser-fixture',
        warning: ''
      })
    });
  });

  await page.route('**/api/ai/ppt-outline', async (route) => {
    state.outlineBodies.push(route.request().postDataJSON());
    if (state.mode === 'fallback') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: 'Task 10 forced outline failure' })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(structuredOutline())
    });
  });

  await page.route('**/api/proposal/generate-ppt', async (route) => {
    state.pptxBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      body: Buffer.from('TASK10-PPTX-FIXTURE', 'utf8')
    });
  });
}

async function createScenario(browser, baseUrl, port, mode) {
  const state = {
    mode,
    parseCalls: [],
    outlineBodies: [],
    pptxBodies: [],
    externalRequests: [],
    pageErrors: []
  };
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 }
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== baseUrl) {
      state.externalRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.fallback();
  });
  context.on('page', (createdPage) => {
    createdPage.on('pageerror', (error) => state.pageErrors.push(error.message));
  });

  const page = await context.newPage();
  await installBaselineBrowserControls(page, { fixture });
  process.env.TM_BROWSER_FIXTURE_PORT = String(port);
  await installFixtureApi(page, { fixture });
  await installScenarioRoutes(page, state);
  await installBaselineAuthState(page, fixture.auth.admin);

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => typeof window.switchPage === 'function');
  await page.evaluate(() => window.switchPage('m3'));
  await page.locator('#page-m3').waitFor({ state: 'visible' });
  return { context, page, state };
}

async function fillDemandAndOpenPPTStep(page, brand) {
  await page.locator('details:has(#d_brand) > summary').click();
  await page.locator('#d_brand').fill(brand);
  await page.locator('#d_product').fill('Task 10 Power Station');
  await page.locator('#d_usp').fill('Reliable off-grid power with measurable creator conversion');
  await page.evaluate(() => {
    for (const id of ['d_category', 'd_area', 'd_budget']) {
      const select = document.getElementById(id);
      select.selectedIndex = 1;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    window.goStep3();
  });
  await page.locator('#m3s3').waitFor({ state: 'visible' });
}

function assertNoUnhandledActivity(page, state, expectedConsoleErrors) {
  assert.deepEqual(page.__baselineUnhandledApiCalls, [], 'all browser API calls must be fixture-owned');
  assert.deepEqual(page.__baselineUnhandledNetworkRequests, [], 'the page must not attempt external network access');
  assert.deepEqual(
    page.__baselinePageErrors,
    expectedConsoleErrors || [],
    'the primary page must not emit errors beyond the deliberately forced fallback response'
  );
  assert.deepEqual(state.externalRequests, [], 'all pages and popups must remain off the public network');
  assert.deepEqual(state.pageErrors, [], 'all created pages must remain error-free');
}

test('Task 10 locked ppt.js owns and preserves the complete browser PPT workflow', { timeout: 120_000 }, async () => {
  let server;
  let browser;
  const previousFixturePort = process.env.TM_BROWSER_FIXTURE_PORT;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });

    const success = await createScenario(browser, server.baseUrl, server.port, 'success');
    try {
      const ownership = await success.page.evaluate(() => {
        const scripts = Array.from(document.scripts).map((script) => script.getAttribute('src') || '');
        const source = window.generateHTMLPPT.toString();
        const exportedNames = [
          'generateHTMLPPT', 'handlePPTContextFile', 'addPPTInstruction', 'clearPPTContext',
          'downloadHTMLPPT', 'downloadPPTX', 'previewPPT', 'copyPPTSource', 'openPPTEditor',
          'closePPTEditor', 'savePPTEditorAndRender', 'previewEditedPPT', 'selectPPTEditorSlide',
          'addPPTEditorSlide', 'duplicatePPTEditorSlide', 'deletePPTEditorSlide', 'movePPTEditorSlide'
        ];
        return {
          scripts,
          source,
          pptBuild: window.tmPPTBuild,
          appBuild: window.TMBuild && window.TMBuild.app,
          exported: exportedNames.every((name) => typeof window[name] === 'function')
        };
      });
      const appIndex = ownership.scripts.indexOf('app.js?v=20260811v060crmsalesworkspace');
      const pptIndex = ownership.scripts.indexOf('ppt.js?v=20260702v916kbbridge');
      assert.ok(appIndex >= 0 && pptIndex > appIndex, 'locked ppt.js must load after the current app.js');
      assert.equal(ownership.pptBuild, '20260702-v916-kb-bridge-client-cn');
      assert.equal(ownership.appBuild, '20260811-v060-crm-sales-workspace');
      assert.equal(ownership.exported, true, 'ppt.js must expose the complete interaction surface');
      assert.match(ownership.source, /^async function generateHTMLPPT/);
      assert.match(ownership.source, /buildPPTDeckContext/);
      assert.match(ownership.source, /\/ai\/ppt-outline/);
      assert.doesNotMatch(ownership.source, /cdnjs\.cloudflare\.com/);

      await fillDemandAndOpenPPTStep(success.page, 'Task 10 Brand');
      await success.page.locator('#pptContextInput').fill('Prioritize the approved competitor comparison and preserve the latest UI.');
      await success.page.locator('button[onclick="addPPTInstruction()"]') .click();
      await success.page.locator('#pptContextFile').setInputFiles({
        name: 'task10-context.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Task 10 browser context file', 'utf8')
      });
      await success.page.waitForFunction(() => (
        document.getElementById('pptContextStatus').textContent.includes('task10-context.txt')
      ));
      assert.equal(success.state.parseCalls.length, 1, 'the context file must use the parse route');
      assert.equal(success.state.parseCalls[0].method, 'POST');
      assert.match(success.state.parseCalls[0].contentType, /^multipart\/form-data;\s*boundary=/i);
      assert.match(success.state.parseCalls[0].body, /filename="task10-context\.txt"/);
      assert.match(success.state.parseCalls[0].body, /Task 10 browser context file/);

      await success.page.locator('#btnGenPPT').click();
      await success.page.waitForFunction(() => (
        document.getElementById('proposalOutput').textContent.includes('Task 10 Success Deck')
      ));
      assert.equal(success.state.outlineBodies.length, 1, 'generation must call the AI outline route once');
      const outlineRequest = success.state.outlineBodies[0];
      assert.equal(outlineRequest.demand.brand, 'Task 10 Brand');
      assert.equal(outlineRequest.demand.product, 'Task 10 Power Station');
      assert.match(outlineRequest.deckContext, /Prioritize the approved competitor comparison/);
      assert.match(outlineRequest.deckContext, /Task 10 approved context requires the latest interface/);
      assert.equal(outlineRequest.previousOutline, null);

      await success.page.evaluate(() => window.openPPTEditor());
      await success.page.waitForFunction(() => getComputedStyle(document.getElementById('tmPPTEditorOverlay')).display === 'flex');
      assert.equal(await success.page.locator('.tm-ppt-slide-item').count(), 3);
      await success.page.locator('#pptEditorDeckTitle').fill('Task 10 Edited Deck');
      await success.page.locator('#pptEditorSlideTitle').fill('Task 10 Edited Cover');
      await success.page.evaluate(() => window.savePPTEditorAndRender());
      await success.page.waitForFunction(() => document.getElementById('proposalOutput').textContent.includes('Task 10 Edited Deck'));

      await success.page.evaluate(() => window.addPPTEditorSlide());
      assert.equal(await success.page.locator('.tm-ppt-slide-item').count(), 4);
      await success.page.locator('#pptEditorSlideTitle').fill('Task 10 Added Contract Slide');
      await success.page.evaluate(() => window.duplicatePPTEditorSlide());
      assert.equal(await success.page.locator('.tm-ppt-slide-item').count(), 5);
      const beforeMove = await success.page.locator('.tm-ppt-slide-item').allTextContents();
      await success.page.evaluate(() => window.movePPTEditorSlide(1));
      const afterMove = await success.page.locator('.tm-ppt-slide-item').allTextContents();
      assert.notDeepEqual(afterMove, beforeMove, 'move operation must reorder the edited slides');
      await success.page.evaluate(() => window.deletePPTEditorSlide());
      assert.equal(await success.page.locator('.tm-ppt-slide-item').count(), 4);
      await success.page.evaluate(() => window.savePPTEditorAndRender());
      const expectedFinalSlideTitles = [
        'Task 10 Edited Deck',
        'Task 10 Added Contract Slide',
        'Knowledge-grounded strategy',
        'Budget and KPI'
      ];
      assert.deepEqual(
        await success.page.locator('.tm-ppt-slide-item span').allTextContents(),
        expectedFinalSlideTitles,
        'saved editor state must preserve the exact add, move, and delete result'
      );

      const {
        download: htmlDownload,
        requestedFilename: htmlRequestedFilename
      } = await triggerDownloadWithRequestedFilename(success.page, 'downloadHTMLPPT');
      assertDownloadFilenameContract(
        htmlRequestedFilename,
        htmlDownload.suggestedFilename(),
        'html'
      );
      const htmlPath = path.join(server.runRoot, 'task-10-edited.html');
      await htmlDownload.saveAs(htmlPath);
      const html = fs.readFileSync(htmlPath, 'utf8');
      assert.match(html, /Task 10 Edited Deck/);
      assert.match(html, /Task 10 Added Contract Slide/);
      assert.doesNotMatch(html, /Task 10 Added Contract Slide 副本/);
      assert.match(html, /<!DOCTYPE html>/i);

      const {
        download: pptxDownload,
        requestedFilename: pptxRequestedFilename
      } = await triggerDownloadWithRequestedFilename(success.page, 'downloadPPTX');
      assertDownloadFilenameContract(
        pptxRequestedFilename,
        pptxDownload.suggestedFilename(),
        'pptx'
      );
      const pptxPath = path.join(server.runRoot, 'task-10-edited.pptx');
      await pptxDownload.saveAs(pptxPath);
      assert.equal(fs.readFileSync(pptxPath, 'utf8'), 'TASK10-PPTX-FIXTURE');
      assert.equal(success.state.pptxBodies.length, 1);
      assert.equal(success.state.pptxBodies[0].outline.title, 'Task 10 Edited Deck');
      assert.equal(success.state.pptxBodies[0].demand.brand, 'Task 10 Brand');
      assert.deepEqual(
        success.state.pptxBodies[0].outline.sections.map((section) => section.title),
        expectedFinalSlideTitles,
        'PPTX request must use the exact saved slide order without the deleted duplicate'
      );
      assert.equal(
        success.state.pptxBodies[0].outline.materials.some((item) => item.name === 'task10-context.txt'),
        true,
        'PPTX generation must preserve parsed material references'
      );

      const popupPromise = success.page.waitForEvent('popup');
      await success.page.evaluate(() => window.previewPPT());
      const popup = await popupPromise;
      await popup.waitForFunction(() => document.body && document.body.innerText.includes('Task 10 Edited Deck'));
      assert.match(await popup.title(), /Task 10 Edited Deck/);
      await popup.close();

      await success.page.bringToFront();
      await success.page.evaluate(() => window.copyPPTSource());
      await success.page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('Task 10 Edited Deck'));
      const clipboard = await success.page.evaluate(() => navigator.clipboard.readText());
      assert.match(clipboard, /Task 10 Edited Deck/);
      assert.match(clipboard, /<!DOCTYPE html>/i);

      assertNoUnhandledActivity(success.page, success.state);
    } finally {
      await success.context.close();
    }

    const fallback = await createScenario(browser, server.baseUrl, server.port, 'fallback');
    try {
      await fillDemandAndOpenPPTStep(fallback.page, 'Task 10 Fallback Brand');
      await fallback.page.locator('#btnGenPPT').click();
      await fallback.page.waitForFunction(() => {
        const output = document.getElementById('proposalOutput');
        return output &&
          output.textContent.includes('Task 10 forced outline failure') &&
          output.querySelector('button[onclick="downloadHTMLPPT()"]') &&
          output.querySelector('button[onclick="downloadPPTX()"]');
      });
      assert.equal(fallback.state.outlineBodies.length, 1, 'fallback must follow a real failed outline request');
      assert.equal(await fallback.page.locator('#proposalOutput button[onclick="downloadHTMLPPT()"]') .count(), 1);
      assert.equal(await fallback.page.locator('#proposalOutput button[onclick="downloadPPTX()"]') .count(), 1);
      assert.match(await fallback.page.locator('#proposalOutput').textContent(), /Task 10 Fallback Brand/);

      const {
        download: fallbackHtmlDownload,
        requestedFilename: fallbackHtmlRequestedFilename
      } = await triggerDownloadWithRequestedFilename(fallback.page, 'downloadHTMLPPT');
      const fallbackHtmlPath = path.join(server.runRoot, 'task-10-fallback.html');
      await fallbackHtmlDownload.saveAs(fallbackHtmlPath);
      assertDownloadFilenameContract(
        fallbackHtmlRequestedFilename,
        fallbackHtmlDownload.suggestedFilename(),
        'html'
      );
      const fallbackHtml = fs.readFileSync(fallbackHtmlPath, 'utf8');
      assert.match(fallbackHtml, /Task 10 Fallback Brand/);
      assert.match(fallbackHtml, /<!DOCTYPE html>/i);

      const {
        download: fallbackPptxDownload,
        requestedFilename: fallbackPptxRequestedFilename
      } = await triggerDownloadWithRequestedFilename(fallback.page, 'downloadPPTX');
      const fallbackPptxPath = path.join(server.runRoot, 'task-10-fallback.pptx');
      await fallbackPptxDownload.saveAs(fallbackPptxPath);
      assertDownloadFilenameContract(
        fallbackPptxRequestedFilename,
        fallbackPptxDownload.suggestedFilename(),
        'pptx'
      );
      assert.equal(fs.readFileSync(fallbackPptxPath, 'utf8'), 'TASK10-PPTX-FIXTURE');
      assert.equal(fallback.state.pptxBodies.length, 1);
      assert.match(fallback.state.pptxBodies[0].outline.title, /Task 10 Fallback Brand/);
      assertNoUnhandledActivity(fallback.page, fallback.state, [
        'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'
      ]);
    } finally {
      await fallback.context.close();
    }
  } finally {
    try {
      try {
        if (browser) await browser.close();
      } finally {
        if (server) {
          try {
            await terminateServer(server.child, server.output);
          } finally {
            removeRunRoot(server.runRoot);
          }
        }
      }
    } finally {
      if (previousFixturePort === undefined) delete process.env.TM_BROWSER_FIXTURE_PORT;
      else process.env.TM_BROWSER_FIXTURE_PORT = previousFixturePort;
    }
  }
});
