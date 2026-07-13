#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-deploy');
const {
  EvidenceError,
  destroySession,
  ensureEvidenceDirectory,
  failureSummary,
  rejectLinksInExistingAncestors,
  removePrivateFile,
  routeEvidence,
  sessionFromStorageState,
  sha256File,
  validateProductionBaseUrl,
  validateStorageStatePath,
  withSessionCleanup,
  writePrivateBuffer,
  writePrivateText
} = require('./lib/production_browser_evidence');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const storageRoot = path.join(repoRoot, '.superpowers', 'sdd');
const baselineManifestPath = path.join(repoRoot, 'docs', 'baselines', 'v0.2.9', 'ui-ppt-manifest.json');
const viewports = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'mobile-390', width: 390, height: 844 }
];

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (!value) throw new EvidenceError('MISSING_PRIVATE_ENVIRONMENT', `Missing required environment variable ${name}`);
  return value;
}

function loadExpectedBuild() {
  const manifest = JSON.parse(fs.readFileSync(baselineManifestPath, 'utf8'));
  return {
    app: manifest.buildMarkers && manifest.buildMarkers.app,
    ppt: manifest.buildMarkers && manifest.buildMarkers.ppt,
    pptCacheKey: manifest.scriptCacheKeys && manifest.scriptCacheKeys.ppt,
    routeTemplates: manifest.routeContracts.map((route) => route.path)
  };
}

async function sanitizeProductionPage(page, sensitiveValues) {
  return page.evaluate(({ privateValues }) => {
    let redactionStep = 'INITIALIZE';
    try {
      const redacted = '[redacted]';
      document.title = redacted;
      redactionStep = 'TEXT';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const node of textNodes) {
        if ((node.nodeValue || '').trim()) node.nodeValue = redacted;
      }

      redactionStep = 'ATTRIBUTES';
      const sensitiveAttributes = new Set([
        'alt', 'aria-label', 'data-id', 'data-user', 'data-email', 'data-name',
        'placeholder', 'srcset', 'title', 'value'
      ]);
      for (const element of document.querySelectorAll('*')) {
        if (element instanceof HTMLInputElement) element.value = element.type === 'file' ? '' : redacted;
        if (element instanceof HTMLTextAreaElement) element.value = redacted;
        for (const attribute of [...element.attributes]) {
          const name = attribute.name.toLowerCase();
          if (name.startsWith('data-') || sensitiveAttributes.has(name)) element.setAttribute(attribute.name, redacted);
          if (name === 'href' && element instanceof HTMLAnchorElement) element.setAttribute(attribute.name, '#');
          if (name === 'src' && ['IFRAME', 'VIDEO'].includes(element.tagName)) element.removeAttribute(attribute.name);
          if (name === 'id' && privateValues.some((value) => value && attribute.value.includes(value))) {
            element.id = 'redacted-id';
          }
          if (name === 'style' && /url\s*\(/i.test(attribute.value)) element.style.backgroundImage = 'none';
        }
      }
      redactionStep = 'MEDIA';
      for (const image of document.images) {
        image.removeAttribute('srcset');
        image.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
        image.alt = redacted;
      }
      for (const media of document.querySelectorAll('video, canvas, iframe')) media.style.visibility = 'hidden';

      redactionStep = 'STYLE';
      const style = document.createElement('style');
      style.id = 'tm-production-evidence-redaction';
      style.textContent = `
        *,*::before,*::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
        img,video,canvas,iframe { visibility: hidden !important; }
      `;
      document.head.appendChild(style);
      redactionStep = 'STORAGE';
      localStorage.clear();
      sessionStorage.clear();

      redactionStep = 'SCAN';
      const attributeValues = [];
      const visibleAttributeNames = new Set(['alt', 'aria-label', 'placeholder', 'title', 'value']);
      for (const element of document.body.querySelectorAll('*')) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) attributeValues.push(element.value);
        for (const attribute of [...element.attributes]) {
          const name = attribute.name.toLowerCase();
          if (visibleAttributeNames.has(name) || (name === 'href' && element instanceof HTMLAnchorElement)) {
            attributeValues.push(attribute.value);
          }
        }
      }
      const visibleCorpus = `${document.body.innerText}\n${attributeValues.join('\n')}`;
      const leakedPrivateValues = privateValues.filter((value) => value && value.length >= 3 && visibleCorpus.includes(value));
      const secretPatterns = [
        ['EMAIL', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
        ['URL', /\b(?:https?:\/\/|www\.)[^\s]+/i],
        ['API_KEY', /\b(?:sk|tvly)-[A-Za-z0-9_-]{12,}\b/],
        ['JWT', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
        ['DATE', /\b20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?\b/],
        ['PHONE', /\b(?:\+?\d[\d\s().-]{8,}\d)\b/]
      ];
      const secretPattern = secretPatterns.find(([, pattern]) => pattern.test(visibleCorpus));
      return secretPattern
        ? { leakedPrivateValues: leakedPrivateValues.length, secretLike: true, secretPatternCode: secretPattern[0] }
        : { leakedPrivateValues: leakedPrivateValues.length, secretLike: false };
    } catch (_error) {
      return { internalErrorCode: `REDACTION_${redactionStep}_FAILED` };
    }
  }, { privateValues: sensitiveValues.filter(Boolean).map(String) });
}

function evidenceMarkdown(result, cleanup) {
  const screenshotRows = result.screenshots
    .map((item) => `| ${item.viewport} | ${item.filename} | ${item.width}x${item.height} | ${item.sha256} |`)
    .join('\n');
  const routeRows = result.routes
    .map((item) => `| ${item.method} | ${item.path} | ${item.status} |`)
    .join('\n');
  return `# Production Browser Baseline Evidence

- Captured at: ${result.capturedAt}
- Capture policy: GET/HEAD only, same origin
- Authenticated role: admin
- App build marker: ${result.build.app}
- PPT build marker: ${result.build.ppt}
- Session destroyed: ${cleanup.verified}
- Logout status: ${cleanup.logoutStatus === null ? 'unavailable' : cleanup.logoutStatus}
- Revocation verification status: ${cleanup.verificationStatus}

## Screenshots

| Viewport | File | Dimensions | SHA-256 |
|---|---|---:|---|
${screenshotRows}

## Sanitized Routes

| Method | Path | Status |
|---|---|---:|
${routeRows}
`;
}

async function captureScreenshots(options) {
  const browserType = options.browserType || chromium;
  let browser = null;
  let failure = null;
  let result = null;
  let phase = 'BROWSER_LAUNCH';
  const screenshots = [];
  const routeMap = new Map();
  const createdFiles = options.createdFiles;
  try {
    browser = await browserType.launch({ headless: true, chromiumSandbox: true });
    for (const viewport of viewports) {
      phase = 'CONTEXT_CREATE';
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: 'light',
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
        storageState: options.statePath
      });
      const violations = [];
      await context.route('**/*', async (route) => {
        const request = route.request();
        try {
          routeEvidence(request.method(), request.url(), 0, options.baseUrl.origin, options.expectedBuild.routeTemplates);
          await route.continue();
        } catch (error) {
          violations.push(error);
          await route.abort('blockedbyclient');
        }
      });
      const page = await context.newPage();
      page.on('pageerror', () => violations.push(new EvidenceError('PAGE_ERROR', 'Production page emitted an error')));
      page.on('console', (message) => {
        if (message.type() === 'error') violations.push(new EvidenceError('CONSOLE_ERROR', 'Production page emitted a console error'));
      });
      page.on('response', (response) => {
        try {
          const item = routeEvidence(
            response.request().method(),
            response.url(),
            response.status(),
            options.baseUrl.origin,
            options.expectedBuild.routeTemplates
          );
          routeMap.set(`${item.method} ${item.path} ${item.status}`, item);
          if (item.status >= 500) violations.push(new EvidenceError('SERVER_ERROR_RESPONSE', 'Production page returned a server error'));
        } catch (error) {
          violations.push(error);
        }
      });

      let screenshotBuffer = null;
      let screenshotName = '';
      try {
        phase = 'PAGE_LOAD';
        const navigation = await page.goto(options.baseUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!navigation || navigation.status() >= 500) throw new EvidenceError('PRODUCTION_PAGE_UNAVAILABLE', 'Production application did not load');
        await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForFunction(() => typeof window.switchPage === 'function', null, { timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready : true);

        phase = 'PAGE_VALIDATE';
        const live = await page.evaluate(() => {
          let user = null;
          try { user = JSON.parse(localStorage.getItem('tm_user') || 'null'); } catch (_error) {}
          return {
            role: user && user.role,
            username: user && user.username,
            displayName: user && user.display_name,
            appBuild: window.tmAppBuild,
            pptBuild: window.tmPPTBuild
          };
        });
        if (live.role !== 'admin') throw new EvidenceError('PRODUCTION_ROLE_MISMATCH', 'Production page is not an administrator session');
        if (live.appBuild !== options.expectedBuild.app || live.pptBuild !== options.expectedBuild.ppt) {
          throw new EvidenceError('BUILD_MARKER_MISMATCH', 'Production build marker does not match the approved baseline');
        }
        await page.locator('.nav-item.admin-only').waitFor({ state: 'visible', timeout: 10_000 });
        const pptScriptCount = await page.locator(`script[src="ppt.js?v=${options.expectedBuild.pptCacheKey}"]`).count();
        if (pptScriptCount !== 1) throw new EvidenceError('PPT_SCRIPT_MISMATCH', 'Production PPT script query is not locked');
        if (violations.length) throw violations[0];

        phase = 'PAGE_REDACT';
        const redaction = await sanitizeProductionPage(page, [
          options.session.token,
          live.username,
          live.displayName,
          options.session.user.email
        ]);
        if (redaction.internalErrorCode) {
          throw new EvidenceError(redaction.internalErrorCode, 'Production page redaction failed');
        }
        if (redaction.leakedPrivateValues) throw new EvidenceError('PRIVATE_VALUE_REMAINS', 'Production screenshot still contains a known private value');
        if (redaction.secretLike) {
          throw new EvidenceError(`SECRET_PATTERN_${redaction.secretPatternCode || 'UNKNOWN'}`, 'Production screenshot still contains a private-data pattern');
        }
        await page.waitForTimeout(150);
        if (violations.length) throw violations[0];
        phase = 'SCREENSHOT_BUFFER';
        screenshotBuffer = await page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide' });
        screenshotName = `production-shell-${viewport.name}.png`;
        await page.waitForTimeout(150);
        if (violations.length) throw violations[0];
      } finally {
        try { await context.close(); } catch (error) {
          throw new EvidenceError('CONTEXT_CLOSE_FAILED', 'Production browser context close failed', { cause: error });
        }
      }
      if (violations.length) throw violations[0];
      phase = 'SCREENSHOT_WRITE';
      const screenshotPath = path.join(options.evidenceDir, screenshotName);
      writePrivateBuffer(screenshotPath, screenshotBuffer, { allowedRoot: options.evidenceDir });
      createdFiles.push(screenshotPath);
      screenshots.push({
        viewport: viewport.name,
        filename: screenshotName,
        width: viewport.width,
        height: viewport.height,
        sha256: sha256File(screenshotPath)
      });
    }
    result = {
      capturedAt: new Date().toISOString(),
      build: { app: options.expectedBuild.app, ppt: options.expectedBuild.ppt },
      routes: [...routeMap.values()].sort((left, right) => `${left.path} ${left.status}`.localeCompare(`${right.path} ${right.status}`)),
      screenshots
    };
  } catch (error) {
    failure = error instanceof EvidenceError
      ? error
      : new EvidenceError(`${phase}_FAILED`, 'Production browser phase failed', { cause: error });
  }
  if (browser) {
    try { await browser.close(); } catch (error) {
      if (!failure) failure = new EvidenceError('BROWSER_CLOSE_FAILED', 'Production browser close failed', { cause: error });
    }
  }
  if (failure) throw failure;
  return result;
}

async function captureProductionBrowserBaseline(options = {}) {
  const environment = options.environment || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = validateProductionBaseUrl(requiredEnvironment(environment, 'TM_PRODUCTION_BASE_URL'));
  const statePath = validateStorageStatePath(requiredEnvironment(environment, 'TM_PRODUCTION_STORAGE_STATE'), { repoRoot });
  rejectLinksInExistingAncestors(statePath, 'production storage state');

  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (error) {
    try { removePrivateFile(statePath, { allowedRoot: storageRoot }); } catch (_cleanupError) {}
    throw new EvidenceError('INVALID_STORAGE_STATE', 'Production storage state cannot be read', { cause: error });
  }
  let session;
  try {
    session = sessionFromStorageState(state, baseUrl.origin);
  } catch (error) {
    try { removePrivateFile(statePath, { allowedRoot: storageRoot }); } catch (_cleanupError) {}
    throw error;
  }
  const createdFiles = [];

  try {
    const wrapped = await withSessionCleanup({
      statePath,
      allowedRoot: storageRoot,
      capture: async () => {
        if (session.user.role !== 'admin') throw new EvidenceError('PRODUCTION_ROLE_MISMATCH', 'Storage state is not an administrator session');
        const evidenceDir = ensureEvidenceDirectory(requiredEnvironment(environment, 'TM_PRODUCTION_EVIDENCE_DIR'), { repoRoot });
        return captureScreenshots({
          baseUrl,
          browserType: options.browserType,
          createdFiles,
          evidenceDir,
          expectedBuild: loadExpectedBuild(),
          session,
          statePath
        });
      },
      destroySession: () => destroySession({ baseUrl, token: session.token, fetchImpl })
    });
    const evidenceDir = ensureEvidenceDirectory(requiredEnvironment(environment, 'TM_PRODUCTION_EVIDENCE_DIR'), { repoRoot });
    const notePath = path.join(evidenceDir, 'production-browser-baseline.md');
    writePrivateText(notePath, evidenceMarkdown(wrapped.captureResult, wrapped.cleanupResult), { allowedRoot: evidenceDir });
    createdFiles.push(notePath);
    return { captured: true, screenshots: wrapped.captureResult.screenshots.length, sessionDestroyed: true };
  } catch (error) {
    const evidenceValue = environment.TM_PRODUCTION_EVIDENCE_DIR;
    if (evidenceValue) {
      let evidenceDir = null;
      try { evidenceDir = ensureEvidenceDirectory(evidenceValue, { repoRoot }); } catch (_pathError) {}
      if (evidenceDir) {
        for (const filePath of createdFiles) {
          try { removePrivateFile(filePath, { allowedRoot: evidenceDir }); } catch (_cleanupError) {}
        }
      }
    }
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('PRODUCTION_CAPTURE_FAILED', 'Production browser capture failed', { cause: error });
  }
}

if (require.main === module) {
  captureProductionBrowserBaseline().then((result) => {
    console.log(`PRODUCTION_BROWSER_SCREENSHOTS=${result.screenshots}`);
    console.log('PRODUCTION_BROWSER_SESSION_DESTROYED=1');
  }).catch((error) => {
    console.error(failureSummary('CAPTURE', error));
    process.exitCode = 1;
  });
}

module.exports = {
  captureProductionBrowserBaseline,
  evidenceMarkdown,
  sanitizeProductionPage
};
