const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright-deploy');

const platformRoot = path.join(__dirname, '..', '..');
const indexPath = path.join(platformRoot, 'index.html');
const appPath = path.join(platformRoot, 'app.js');
const pptPath = path.join(platformRoot, 'ppt.js');
const buildInfoPath = path.join(platformRoot, 'client', 'shared', 'build_info.js');
const navigationPath = path.join(platformRoot, 'client', 'core', 'navigation.js');
const accessibilityPath = path.join(platformRoot, 'client', 'core', 'accessibility.js');
const shellPath = path.join(platformRoot, 'client', 'core', 'shell.js');
const cspCompatPath = path.join(platformRoot, 'client', 'core', 'csp_compat.js');
const previewRuntimePath = path.join(platformRoot, 'client', 'features', 'ppt_preview_runtime.js');
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
const SECURITY_QUERY = '20260714v050campaignbusinessspine';
const PPT_SHA256 = 'f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e';

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function delegatedCSPCompatSource() {
  const source = read(cspCompatPath);
  if (process.env.TM_CSP_DATASET_FALLBACK_MUTANT !== '1') return source;
  const anchor = '    var allowedCall = trustedPPTActions.get(target);';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const fallback = [
    anchor,
    '    if (!allowedCall) {',
    '      var fallbackArgs = [];',
    '      try {',
    "        fallbackArgs = JSON.parse(target.getAttribute('data-tm-ppt-args') || '[]');",
    '      } catch (_error) {}',
    "      allowedCall = validateDelegatedCall(target.getAttribute('data-tm-ppt-action'), fallbackArgs);",
    '    }'
  ].join(newline);
  const mutant = source.replace(anchor, fallback);
  assert.notEqual(mutant, source, 'dataset-fallback mutant anchor must match production dispatch');
  return mutant;
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

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
    toggle(value, force) {
      if (force === true) values.add(value);
      else if (force === false) values.delete(value);
      else if (values.has(value)) values.delete(value);
      else values.add(value);
      return values.has(value);
    }
  };
}

function fakePreviewElement(tagName, initialAttributes = {}, options = {}) {
  const attributes = new Map(Object.entries(initialAttributes).map(([name, value]) => [name, String(value)]));
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    localName: tagName.toLowerCase(),
    namespaceURI: options.namespaceURI || 'http://www.w3.org/1999/xhtml',
    textContent: options.textContent || '',
    removed: false,
    get attributes() {
      return Array.from(attributes, ([name, value]) => ({ name, value }));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    remove() {
      this.removed = true;
    }
  };
}

function fakeStagePreviewDocument(extraElements = []) {
  const documentElement = fakePreviewElement('html', { lang: 'zh-CN' });
  const head = fakePreviewElement('head');
  const style = fakePreviewElement('style', {}, {
    textContent: '.slide{display:block}\n@media print{\n.slide{page-break-after:always}\n}'
  });
  const body = fakePreviewElement('body', { 'data-theme': 'aurora' });
  const stage = fakePreviewElement('main', { id: 'deckStage', class: 'deck-stage' });
  const slide = fakePreviewElement('section', { class: 'slide active' });
  const controls = fakePreviewElement('div', { class: 'deck-controls' });
  const counter = fakePreviewElement('span', { id: 'deckCounter' });
  const progress = fakePreviewElement('div', { id: 'deckProgress', class: 'deck-progress' });
  const elements = [documentElement, head, style, body, stage, slide, controls, counter, progress, ...extraElements];

  return {
    documentElement,
    body,
    elements,
    getElementById(id) {
      return elements.find((element) => !element.removed && element.getAttribute('id') === id) || null;
    },
    querySelectorAll(selector) {
      const active = elements.filter((element) => !element.removed);
      if (selector === '*') return active;
      if (selector === 'section[id]') {
        return active.filter((element) => element.localName === 'section' && element.getAttribute('id'));
      }
      if (selector.startsWith('.')) {
        const className = selector.slice(1);
        return active.filter((element) => String(element.getAttribute('class') || '').split(/\s+/).includes(className));
      }
      return [];
    }
  };
}

function fakeReportPreviewDocument(extraElements = []) {
  const documentElement = fakePreviewElement('html', { lang: 'zh-CN' });
  const head = fakePreviewElement('head');
  const style = fakePreviewElement('style', {}, {
    textContent: 'section{display:block}\n@media print{section{page-break-after:always}}'
  });
  const body = fakePreviewElement('body');
  const nav = fakePreviewElement('nav');
  const navLinks = fakePreviewElement('div', { class: 'nav-links' });
  const coverLink = fakePreviewElement('a', { href: '#cover' });
  const sectionLink = fakePreviewElement('a', { href: '#s01' });
  const closingLink = fakePreviewElement('a', { href: '#closing' });
  const cover = fakePreviewElement('section', { id: 'cover' });
  const section = fakePreviewElement('section', { id: 's01' });
  const closing = fakePreviewElement('section', { id: 'closing' });
  const controls = fakePreviewElement('div', { class: 'page-controls' });
  const counter = fakePreviewElement('span', { id: 'tmDeckCounter' });
  const progress = fakePreviewElement('div', { id: 'tmDeckProgress', class: 'page-progress' });
  const elements = [
    documentElement, head, style, body, nav, navLinks, coverLink, sectionLink, closingLink,
    cover, section, closing, controls, counter, progress, ...extraElements
  ];

  return {
    documentElement,
    body,
    elements,
    getElementById(id) {
      return elements.find((element) => !element.removed && element.getAttribute('id') === id) || null;
    },
    querySelectorAll(selector) {
      const active = elements.filter((element) => !element.removed);
      if (selector === '*') return active;
      if (selector === 'section[id]') {
        return active.filter((element) => element.localName === 'section' && element.getAttribute('id'));
      }
      if (selector.startsWith('.')) {
        const className = selector.slice(1);
        return active.filter((element) => String(element.getAttribute('class') || '').split(/\s+/).includes(className));
      }
      return [];
    }
  };
}

function fakeRuntimeElement(tagName, options = {}) {
  const listeners = new Map();
  const attributes = new Map();
  if (options.id) attributes.set('id', options.id);
  if (options.href) attributes.set('href', options.href);
  return {
    tagName: tagName.toUpperCase(),
    id: options.id || '',
    dataset: { ...(options.dataset || {}) },
    style: {},
    textContent: '',
    classList: fakeClassList(options.classes || []),
    scrollCalls: [],
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type, event = {}) { return listeners.get(type)?.(event); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    scrollIntoView(optionsValue) { this.scrollCalls.push(optionsValue); }
  };
}

function runPreviewRuntime(document, windowOverrides = {}) {
  const listeners = new Map();
  const window = {
    document,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener(type, listener) { listeners.set(type, listener); },
    ...windowOverrides
  };
  window.window = window;
  vm.runInNewContext(read(previewRuntimePath), { window, console }, { filename: previewRuntimePath });
  return { window, listeners };
}

function buildFrozenReportHTML() {
  const context = {
    window: {},
    console,
    curDemand: { brand: 'Fixture Brand', product: 'Fixture Product' }
  };
  context.window.window = context.window;
  vm.runInNewContext(read(pptPath), context, { filename: pptPath });
  return context.buildRevealHTML({
    title: 'Frozen report',
    subtitle: 'CSP compatibility regression fixture',
    sections: [{ title: 'Market plan', type: 'content', points: ['Reach: 42%'] }],
    materials: []
  });
}

function frozenAttributes(source) {
  const attributes = {};
  const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(expression)) {
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function fakePreviewDocumentFromFrozenHTML(html) {
  const styleBodies = Array.from(html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi), (match) => match[1]);
  let styleIndex = 0;
  const elements = Array.from(html.matchAll(/<(?![!/])([A-Za-z][A-Za-z0-9-]*)([^<>]*)>/g), (match) => {
    const tagName = match[1].toLowerCase();
    return fakePreviewElement(tagName, frozenAttributes(match[2]), {
      textContent: tagName === 'style' ? styleBodies[styleIndex++] : ''
    });
  });
  const documentElement = elements.find((element) => element.localName === 'html');
  const body = elements.find((element) => element.localName === 'body');

  return {
    documentElement,
    body,
    elements,
    getElementById(id) {
      return elements.find((element) => !element.removed && element.getAttribute('id') === id) || null;
    },
    querySelectorAll(selector) {
      const active = elements.filter((element) => !element.removed);
      if (selector === '*') return active;
      if (selector === 'section[id]') {
        return active.filter((element) => element.localName === 'section' && element.getAttribute('id'));
      }
      if (selector.startsWith('.')) {
        const className = selector.slice(1);
        return active.filter((element) => String(element.getAttribute('class') || '').split(/\s+/).includes(className));
      }
      return [];
    }
  };
}

function reportRuntimeFixture() {
  const sections = ['cover', 's01', 'closing'].map((id) => fakeRuntimeElement('section', { id }));
  const navLinks = sections.map((section) => fakeRuntimeElement('a', { href: `#${section.id}` }));
  const fades = [fakeRuntimeElement('div', { classes: ['fade-in'] }), fakeRuntimeElement('div', { classes: ['fade-in'] })];
  const bars = [fakeRuntimeElement('div', { dataset: { width: '64' } })];
  const controls = [fakeRuntimeElement('button'), fakeRuntimeElement('button')];
  const counter = fakeRuntimeElement('span', { id: 'tmDeckCounter' });
  const progress = fakeRuntimeElement('div', { id: 'tmDeckProgress' });
  const document = {
    readyState: 'complete',
    getElementById(id) {
      return { tmDeckCounter: counter, tmDeckProgress: progress }[id]
        || sections.find((section) => section.id === id)
        || null;
    },
    querySelectorAll(selector) {
      if (selector === '.slide') return [];
      if (selector === 'section[id]') return sections;
      if (selector === '.nav-links a') return navLinks;
      if (selector === '.page-controls button') return controls;
      if (selector === '.fade-in') return fades;
      if (selector === '.platform-bar-fill[data-width], .wb-fill[data-width]') return bars;
      return [];
    }
  };
  const location = { hash: '' };
  const runtime = runPreviewRuntime(document, { location });
  return { ...runtime, sections, navLinks, fades, bars, controls, counter, progress, location };
}

test('v0.4 shared shell declares all five exact public assets', () => {
  for (const filePath of [...stylePaths, accessibilityPath, shellPath]) {
    assert.equal(fs.existsSync(filePath), true, `${path.relative(platformRoot, filePath)} must exist`);
  }
});

test('index loads styles and Wave 1 scripts in the approved order while PPT remains frozen', () => {
  const indexHtml = read(indexPath);
  assert.deepEqual(sources(indexHtml, 'link').slice(-3), [
    `client/styles/tokens.css?v=${APP_QUERY}`,
    `client/styles/components.css?v=${APP_QUERY}`,
    `client/styles/layout.css?v=${APP_QUERY}`
  ]);
  assert.deepEqual(sources(indexHtml, 'script').slice(-7), [
    'client/shared/build_info.js',
    'client/core/navigation.js',
    'client/core/accessibility.js',
    'client/core/shell.js',
    `app.js?v=${APP_QUERY}`,
    `ppt.js?v=${PPT_QUERY}`,
    `client/core/csp_compat.js?v=${SECURITY_QUERY}`
  ]);
  assert.match(read(buildInfoPath), new RegExp(`app:\\s*['"]${APP_BUILD}['"]`));
  assert.match(read(buildInfoPath), new RegExp(`ppt:\\s*['"]${PPT_BUILD}['"]`));
  assert.equal(sha256(pptPath), PPT_SHA256, 'locked ppt.js bytes must not change');
});

test('CSP compatibility translates only the frozen PPT handler grammar and rejects unknown handlers', () => {
  assert.equal(fs.existsSync(cspCompatPath), true);
  const compatSource = read(cspCompatPath);
  const window = {};
  window.window = window;
  vm.runInNewContext(compatSource, { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;

  assert.ok(compat);
  assert.deepEqual(
    JSON.parse(JSON.stringify(compat.parseFrozenHandler('movePPTEditorSlide(-1)'))),
    { action: 'movePPTEditorSlide', args: [-1] }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(compat.parseFrozenHandler('selectPPTEditorSlide(12)'))),
    { action: 'selectPPTEditorSlide', args: [12] }
  );
  assert.equal(compat.parseFrozenHandler('alert(document.cookie)'), null);
  assert.equal(compat.parseFrozenHandler('downloadHTMLPPT();doLogout()'), null);
  assert.equal(compat.translateRoot({ id: 'app' }), false, 'translator must reject every non-PPT root');

  function fakeElement(attributes) {
    const values = new Map(Object.entries(attributes));
    return {
      nodeType: 1,
      get attributes() { return Array.from(values, ([name, value]) => ({ name, value })); },
      getAttribute(name) { return values.has(name) ? values.get(name) : null; },
      setAttribute(name, value) { values.set(name, String(value)); },
      removeAttribute(name) { values.delete(name); }
    };
  }

  const approved = fakeElement({ onclick: 'downloadHTMLPPT()' });
  compat.translateElement(approved);
  assert.equal(approved.getAttribute('onclick'), null);
  assert.equal(approved.getAttribute('data-tm-ppt-action'), 'downloadHTMLPPT');

  const rejected = fakeElement({
    onclick: 'alert(document.cookie)',
    'data-tm-ppt-action': 'downloadHTMLPPT',
    'data-tm-ppt-args': '[]'
  });
  compat.translateElement(rejected);
  assert.equal(rejected.getAttribute('onclick'), null);
  assert.equal(rejected.getAttribute('data-tm-ppt-action'), null);
  assert.equal(rejected.getAttribute('data-tm-ppt-args'), null);
  assert.equal(rejected.getAttribute('data-tm-csp-rejected'), 'onclick');
  assert.doesNotMatch(compatSource, /\beval\s*\(|\bFunction\s*\(|document\.write\s*\(/);
  assert.match(compatSource, /Safe PPT preview is not supported by this browser\./);
  assert.match(compatSource, /Generate a PPT before opening preview\./);
  assert.match(compatSource, /The browser blocked the preview window\. Allow pop-ups and try again\./);
});

test('delegated editor stopPropagation preserves native-control default behavior', () => {
  const listeners = new Map();
  const document = {
    documentElement: {},
    querySelectorAll() { return []; },
    addEventListener(type, listener, capture) { listeners.set(type, { listener, capture }); }
  };
  const window = { document };
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;

  const binding = listeners.get('click');
  assert.ok(binding, 'delegated click binding must initialize');
  assert.equal(binding.capture, true);
  const root = { id: 'tmPPTEditorOverlay' };

  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) {
    const actionTarget = fakePreviewElement(tagName.toLowerCase(), { onclick: 'event.stopPropagation()' });
    actionTarget.closest = function closest(selector) {
      if (selector === '[data-tm-ppt-action]') {
        return this.getAttribute('data-tm-ppt-action') ? this : null;
      }
      return selector.includes('#tmPPTEditorOverlay') ? root : null;
    };
    compat.translateElement(actionTarget);
    const state = { defaultPrevented: false, propagationStopped: false };
    binding.listener({
      target: actionTarget,
      preventDefault() { state.defaultPrevented = true; },
      stopPropagation() { state.propagationStopped = true; }
    });
    assert.equal(state.defaultPrevented, false, `${tagName} default behavior must remain available`);
    assert.equal(state.propagationStopped, true, `${tagName} click must not escape the editor overlay`);
  }
});

test('delegated PPT actions execute only sanitizer-registered calls and reject forged dataset calls', () => {
  const listeners = new Map();
  const invocations = [];
  const document = {
    documentElement: {},
    querySelectorAll() { return []; },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  const window = {
    document,
    movePPTEditorSlide(value) { invocations.push(['move', value]); },
    selectPPTEditorSlide(value) { invocations.push(['select', value]); },
    downloadHTMLPPT() { invocations.push(['download']); }
  };
  window.window = window;
  vm.runInNewContext(delegatedCSPCompatSource(), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;
  const root = { id: 'tmPPTEditorOverlay' };

  function actionTarget(attributes) {
    const target = fakePreviewElement('button', attributes);
    target.closest = function closest(selector) {
      if (selector === '[data-tm-ppt-action]') {
        return this.getAttribute('data-tm-ppt-action') ? this : null;
      }
      return selector.includes('#tmPPTEditorOverlay') ? root : null;
    };
    return target;
  }

  function dispatch(target) {
    const event = {
      target,
      preventDefault() {},
      stopPropagation() {}
    };
    listeners.get('click')(event);
    return target;
  }

  const forgedCalls = [
    actionTarget({ 'data-tm-ppt-action': 'downloadHTMLPPT' }),
    actionTarget({
      'data-tm-ppt-action': 'movePPTEditorSlide',
      'data-tm-ppt-args': '[1]'
    })
  ];
  for (const forged of forgedCalls) assert.doesNotThrow(() => dispatch(forged));
  assert.deepEqual(invocations, [], 'format-correct DOM dataset must never authorize a call without WeakMap registration');
  for (const forged of forgedCalls) {
    assert.equal(forged.getAttribute('data-tm-ppt-action'), null, 'forged action marker must be cleared');
    assert.equal(forged.getAttribute('data-tm-ppt-args'), null, 'forged argument marker must be cleared');
    assert.equal(forged.getAttribute('data-tm-csp-rejected'), 'data-tm-ppt-action');
  }

  const registered = actionTarget({ onclick: 'movePPTEditorSlide(1)' });
  compat.translateElement(registered);
  dispatch(registered);
  assert.deepEqual(invocations, [['move', 1]], 'translated frozen handler must execute its registered call');

  registered.setAttribute('data-tm-ppt-action', 'downloadHTMLPPT');
  registered.removeAttribute('data-tm-ppt-args');
  dispatch(registered);
  assert.deepEqual(invocations, [['move', 1]], 'mutating the marker must fail closed, not select another global');
});

test('popup DOM policy preserves the complete stylesheet from real frozen buildRevealHTML output', () => {
  const frozenHTML = buildFrozenReportHTML();
  assert.match(frozenHTML, /scroll-behavior:smooth/);
  const parsed = fakePreviewDocumentFromFrozenHTML(frozenHTML);
  const generatedSheet = parsed.elements.find((element) => element.localName === 'style');
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });

  assert.equal(window.TMCSPCompat.sanitizePreviewDocument(parsed), true);
  assert.equal(generatedSheet.removed, false, 'the real frozen report stylesheet must survive as one complete block');
  assert.match(generatedSheet.textContent, /html\{height:100%;scroll-behavior:smooth;scroll-snap-type:y mandatory\}/);
  assert.match(generatedSheet.textContent, /@media print\{/);
});

for (const [label, styleText] of [
  ['direct src() URL values', "body{background:src('/api/probe')}"],
  ['src(var()) values', 'body{background:src(var(--probe))}']
]) {
  test(`popup stylesheet policy rejects ${label}`, () => {
    const dangerousSheet = fakePreviewElement('style', {}, { textContent: styleText });
    const parsed = fakeStagePreviewDocument([dangerousSheet]);
    const window = {};
    window.window = window;
    vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });

    assert.equal(window.TMCSPCompat.sanitizePreviewDocument(parsed), true);
    assert.equal(dangerousSheet.removed, true, `${label} must fail closed`);
  });
}

test('popup DOM policy admits only the exact frozen charset and controlled viewport meta', () => {
  const parsed = fakePreviewDocumentFromFrozenHTML(buildFrozenReportHTML());
  const metaElements = parsed.elements.filter((element) => element.localName === 'meta');
  assert.equal(metaElements.length, 2, 'real buildRevealHTML output must supply exactly two required meta elements');
  const rejectedMeta = [
    fakePreviewElement('meta', { 'http-equiv': 'refresh', content: '0;url=https://evil.test' }),
    fakePreviewElement('meta', { name: 'refresh', content: '0;url=https://evil.test' }),
    fakePreviewElement('meta', { name: 'description', content: 'forged report' }),
    fakePreviewElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1.0, user-scalable=no' }),
    fakePreviewElement('meta', { charset: 'UTF-16' })
  ];
  parsed.elements.push(...rejectedMeta);
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });

  assert.equal(window.TMCSPCompat.sanitizePreviewDocument(parsed), true);
  assert.equal(metaElements[0].getAttribute('charset'), 'UTF-8');
  assert.equal(metaElements[0].removed, false, 'frozen UTF-8 declaration must remain');
  assert.equal(metaElements[1].getAttribute('name'), 'viewport');
  assert.equal(metaElements[1].getAttribute('content'), 'width=device-width, initial-scale=1.0');
  assert.equal(metaElements[1].removed, false, 'frozen viewport declaration must remain');
  for (const meta of rejectedMeta) assert.equal(meta.removed, true, 'every non-frozen meta form must be removed');
});

test('popup DOM policy admits only frozen deck structure and approved fragment or image URLs', () => {
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;

  const nodes = {
    metaRefresh: fakePreviewElement('meta', { 'http-equiv': 'refresh', content: '0;url=https://evil.test' }),
    externalStyle: fakePreviewElement('link', { rel: 'stylesheet', href: 'https://evil.test/deck.css' }),
    form: fakePreviewElement('form', { action: '#deckStage' }),
    object: fakePreviewElement('object', { data: 'https://evil.test/payload' }),
    embed: fakePreviewElement('embed', { src: 'https://evil.test/payload' }),
    iframe: fakePreviewElement('iframe', { srcdoc: '<script>steal()</script>' }),
    script: fakePreviewElement('script', { src: 'https://evil.test/payload.js' }),
    base: fakePreviewElement('base', { href: 'https://evil.test/' }),
    svg: fakePreviewElement('svg', {}, { namespaceURI: 'http://www.w3.org/2000/svg' }),
    svgAnimate: fakePreviewElement('animate', { attributeName: 'href', to: 'https://evil.test' }, { namespaceURI: 'http://www.w3.org/2000/svg' }),
    unknown: fakePreviewElement('video', { src: 'https://evil.test/movie.mp4' }),
    dangerousSheet: fakePreviewElement('style', {}, { textContent: '@import url(https://evil.test/deck.css);' }),
    protocolRelativeSheet: fakePreviewElement('style', {}, { textContent: '.slide{background:image-set("//evil.test/pixel.png" 1x)}' }),
    legacyBehaviorSheet: fakePreviewElement('style', {}, { textContent: '.slide{behavior:inherit}' }),
    legacyBindingSheet: fakePreviewElement('style', {}, { textContent: '.slide{-moz-binding:none}' }),
    sourcePropertySheet: fakePreviewElement('style', {}, { textContent: '.slide{src:local(font)}' }),
    semanticNav: fakePreviewElement('nav', { class: 'nav-links' }),
    safeFragment: fakePreviewElement('a', { href: '#deckStage', target: '_blank', ping: 'https://evil.test/ping' }),
    externalFragment: fakePreviewElement('a', { href: 'https://evil.test/#deckStage' }),
    controlFragment: fakePreviewElement('a', { href: 'java\u0000script:alert(1)' }),
    protocolRelativeFragment: fakePreviewElement('a', { href: '//evil.test/#slide-1' }),
    unknownFragment: fakePreviewElement('a', { href: '#not-generated' }),
    safeHttpsImage: fakePreviewElement('img', { src: 'https://cdn.example.test/deck.png', alt: 'Deck illustration' }),
    safeDataImage: fakePreviewElement('img', { src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Embedded chart' }),
    httpImage: fakePreviewElement('img', { src: 'http://cdn.example.test/deck.png' }),
    svgDataImage: fakePreviewElement('img', { src: 'data:image/svg+xml,<svg onload=alert(1)></svg>' }),
    controlImage: fakePreviewElement('img', { src: 'java\nscript:alert(1)' }),
    executableAttributes: fakePreviewElement('div', {
      onclick: 'steal()',
      srcdoc: '<script>steal()</script>',
      formaction: 'https://evil.test',
      class: 'card'
    }),
    clobberId: fakePreviewElement('div', { id: 'deck', class: 'card' }),
    safeInlineStyle: fakePreviewElement('i', { style: 'width:42%' }),
    unsafeInlineStyle: fakePreviewElement('div', { style: 'background:url(https://evil.test/pixel)' })
  };
  const parsed = fakeStagePreviewDocument(Object.values(nodes));

  assert.equal(compat.sanitizePreviewDocument(parsed), true);
  for (const name of [
    'metaRefresh', 'externalStyle', 'form', 'object', 'embed', 'iframe', 'script', 'base',
    'svg', 'svgAnimate', 'unknown', 'dangerousSheet', 'protocolRelativeSheet', 'legacyBehaviorSheet',
    'legacyBindingSheet', 'sourcePropertySheet', 'httpImage', 'svgDataImage', 'controlImage'
  ]) {
    assert.equal(nodes[name].removed, true, `${name} must be removed`);
  }
  const generatedSheet = parsed.elements.find((element) => element.localName === 'style' && element.textContent.startsWith('.slide'));
  assert.equal(generatedSheet.removed, false, 'normal generated stylesheet newlines must remain valid');
  assert.equal(nodes.semanticNav.removed, false, 'frozen semantic navigation remains structural');
  assert.equal(nodes.safeFragment.getAttribute('href'), '#deckStage');
  assert.equal(nodes.safeFragment.getAttribute('target'), null);
  assert.equal(nodes.safeFragment.getAttribute('ping'), null);
  assert.equal(nodes.externalFragment.getAttribute('href'), null);
  assert.equal(nodes.controlFragment.getAttribute('href'), null);
  assert.equal(nodes.protocolRelativeFragment.getAttribute('href'), null);
  assert.equal(nodes.unknownFragment.getAttribute('href'), null);
  assert.equal(nodes.safeHttpsImage.getAttribute('src'), 'https://cdn.example.test/deck.png');
  assert.equal(nodes.safeDataImage.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(nodes.executableAttributes.getAttribute('onclick'), null);
  assert.equal(nodes.executableAttributes.getAttribute('srcdoc'), null);
  assert.equal(nodes.executableAttributes.getAttribute('formaction'), null);
  assert.equal(nodes.executableAttributes.getAttribute('class'), 'card');
  assert.equal(nodes.clobberId.getAttribute('id'), null, 'unknown IDs must not create named global properties');
  assert.equal(nodes.safeInlineStyle.getAttribute('style'), 'width:42%');
  assert.equal(nodes.unsafeInlineStyle.getAttribute('style'), null);
});

test('popup DOM policy rejects sanitized documents outside the frozen deck profiles', () => {
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const root = fakePreviewElement('html');
  const paragraph = fakePreviewElement('p');
  const parsed = {
    documentElement: root,
    body: fakePreviewElement('body'),
    getElementById() { return null; },
    querySelectorAll(selector) { return selector === '*' ? [root, paragraph] : []; }
  };
  assert.equal(window.TMCSPCompat.sanitizePreviewDocument(parsed), false);
});

test('popup DOM policy requires the frozen report cover, closing, controls, and fragment navigation', () => {
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;

  const validReport = fakeReportPreviewDocument();
  assert.equal(compat.sanitizePreviewDocument(validReport), true);
  const links = validReport.elements.filter((element) => element.localName === 'a');
  assert.deepEqual(links.map((link) => link.getAttribute('href')), ['#cover', '#s01', '#closing']);

  const missingClosing = fakeReportPreviewDocument();
  missingClosing.getElementById('closing').remove();
  assert.equal(compat.sanitizePreviewDocument(missingClosing), false);

  const missingNavigation = fakeReportPreviewDocument();
  missingNavigation.querySelectorAll('.nav-links')[0].remove();
  assert.equal(compat.sanitizePreviewDocument(missingNavigation), false);
});

test('popup fragment policy removes a generated fragment whose target does not exist', () => {
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;

  const missingTarget = fakeReportPreviewDocument();
  missingTarget.getElementById('s01').remove();
  assert.equal(compat.sanitizePreviewDocument(missingTarget), true);
  assert.equal(
    missingTarget.elements.find((element) => element.localName === 'a' && element.getAttribute('href') === '#s01'),
    undefined,
    'a fragment with no surviving target must be removed'
  );
});

test('popup fragment policy removes IDs that the frozen report generator cannot produce', () => {
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;
  const impossibleTarget = fakePreviewElement('section', { id: 's0001' });
  const impossibleLink = fakePreviewElement('a', { href: '#s0001' });
  const parsed = fakeReportPreviewDocument([impossibleTarget, impossibleLink]);

  assert.equal(compat.sanitizePreviewDocument(parsed), true);
  assert.equal(impossibleTarget.getAttribute('id'), null);
  assert.equal(impossibleLink.getAttribute('href'), null);
});

test('popup fragment policy rejects duplicate frozen generated IDs', () => {
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;

  const duplicateTarget = fakeReportPreviewDocument([
    fakePreviewElement('section', { id: 's01' })
  ]);
  assert.equal(compat.sanitizePreviewDocument(duplicateTarget), false, 'duplicate generated IDs must reject the document');
});

test('popup fragment policy rejects frozen IDs attached to the wrong target type', () => {
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;

  const wrongTypeTarget = fakeReportPreviewDocument();
  wrongTypeTarget.getElementById('s01').remove();
  wrongTypeTarget.elements.push(fakePreviewElement('div', { id: 's01' }));
  assert.equal(compat.sanitizePreviewDocument(wrongTypeTarget), false, 'generated section IDs must not resolve to a clobbering div');
});

test('popup fragment policy rejects duplicate core IDs regardless of DOM lookup order', () => {
  const window = {};
  window.window = window;
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });
  const compat = window.TMCSPCompat;

  const clobberedCover = fakeReportPreviewDocument([
    fakePreviewElement('div', { id: 'cover' })
  ]);
  assert.equal(compat.sanitizePreviewDocument(clobberedCover), false, 'duplicate core IDs must fail closed regardless of DOM lookup order');
});

test('popup preview sanitizes before import, severs opener, and then loads the same-origin runtime', () => {
  assert.equal(fs.existsSync(previewRuntimePath), true);
  const parsedSources = [];
  const parsedDocuments = [];
  const loadedRuntimes = [];
  const popups = [];
  const window = {
    DOMParser: function DOMParser() {},
    lastPPT: '<!doctype html><html><body>untrusted deck input</body></html>'
  };
  window.window = window;
  window.DOMParser.prototype.parseFromString = function parseFromString(source) {
    parsedSources.push(source);
    const parsed = fakeStagePreviewDocument([
      fakePreviewElement('script', { src: 'https://evil.test/payload.js' })
    ]);
    parsedDocuments.push(parsed);
    return parsed;
  };
  window.open = function open() {
    const order = [];
    let opener = { trusted: false };
    const popup = {
      order,
      document: {
        documentElement: { kind: 'old-root' },
        body: {
          appendChild(node) {
            order.push('runtime');
            loadedRuntimes.push(node);
          }
        },
        createElement(tagName) { return { tagName, async: true, src: '' }; },
        importNode(node, deep) {
          order.push('import');
          const parsed = parsedDocuments[parsedDocuments.length - 1];
          assert.equal(parsed.elements.find((element) => element.localName === 'script').removed, true);
          return { node, deep };
        },
        replaceChild(nextRoot, priorRoot) {
          order.push('replace');
          assert.equal(popup.opener, null, 'opener must be severed before sanitized content becomes active');
          this.documentElement = nextRoot;
          assert.equal(priorRoot.kind, 'old-root');
        }
      },
      close() { this.closed = true; }
    };
    Object.defineProperty(popup, 'opener', {
      configurable: true,
      get() { return opener; },
      set(value) {
        opener = value;
        order.push('opener');
      }
    });
    popups.push(popup);
    return popup;
  };
  vm.runInNewContext(read(cspCompatPath), { window, console }, { filename: cspCompatPath });

  assert.equal(window.TMCSPCompat.previewRuntimePath, '/client/features/ppt_preview_runtime.js');

  window.previewPPT();
  window.applyPPTEditorForm = () => true;
  window.rebuildPPTFromEditor = () => {};
  window.previewEditedPPT();
  assert.equal(popups.length, 2, 'both preview entry points must open a sanitized document');
  assert.equal(parsedSources.length, 2);
  for (const popup of popups) {
    assert.equal(popup.opener, null);
    assert.deepEqual(popup.order, ['import', 'opener', 'replace', 'runtime']);
  }
  assert.equal(loadedRuntimes.length, 2, 'both preview entry points must append the external runtime');
  for (const runtimeScript of loadedRuntimes) {
    assert.equal(runtimeScript.tagName, 'script');
    assert.equal(runtimeScript.src, '/client/features/ppt_preview_runtime.js');
    assert.equal(runtimeScript.async, false);
  }

  const runtime = read(previewRuntimePath);
  assert.doesNotMatch(runtime, /\beval\s*\(|\bFunction\s*\(/);
  assert.doesNotMatch(runtime, /\son[a-z][\w:-]*\s*=/i);
});

test('preview runtime ignores Space on native controls while preserving arrow and page navigation', () => {
  const stage = fakeRuntimeElement('main', { id: 'deckStage' });
  const slides = [0, 1, 2].map(() => fakeRuntimeElement('section', { classes: ['slide'] }));
  const counter = fakeRuntimeElement('span', { id: 'deckCounter' });
  const progress = fakeRuntimeElement('div', { id: 'deckProgress' });
  const controls = [fakeRuntimeElement('button'), fakeRuntimeElement('button')];
  const document = {
    readyState: 'complete',
    getElementById(id) {
      return { deckStage: stage, deckCounter: counter, deckProgress: progress }[id] || null;
    },
    querySelectorAll(selector) {
      if (selector === '.slide') return slides;
      if (selector === '.deck-controls button') return controls;
      return [];
    }
  };
  const runtime = runPreviewRuntime(document);
  const keydown = runtime.listeners.get('keydown');
  assert.ok(keydown);

  let spaceDefaultPrevented = false;
  keydown({
    key: ' ',
    target: controls[1],
    preventDefault() { spaceDefaultPrevented = true; }
  });
  controls[1].dispatch('click');
  assert.equal(counter.textContent, '2 / 3', 'Space-generated click must advance exactly once');
  assert.equal(spaceDefaultPrevented, false);

  runtime.window.deck.show(0);
  keydown({ key: 'ArrowRight', target: controls[1], preventDefault() {} });
  assert.equal(counter.textContent, '2 / 3');
  runtime.window.deck.show(0);
  keydown({ key: 'PageDown', target: controls[1], preventDefault() {} });
  assert.equal(counter.textContent, '2 / 3');
});

test('preview runtime reveals and progresses report decks without IntersectionObserver', () => {
  const { sections, navLinks, fades, bars, controls, counter, progress } = reportRuntimeFixture();

  for (const element of fades) assert.equal(element.classList.contains('visible'), true);
  assert.equal(bars[0].style.width, '64%');
  controls[1].dispatch('click');
  controls[1].dispatch('click');
  controls[0].dispatch('click');
  assert.deepEqual(
    sections.map((section) => section.scrollCalls.length),
    [0, 2, 1],
    'real report control clicks must progress through deterministic section indices'
  );
  assert.equal(counter.textContent, '2 / 3');
  assert.equal(navLinks[1].classList.contains('active'), true);
  assert.equal(progress.style.width, `${(2 / 3) * 100}%`);
});

test('preview runtime fallback synchronizes legal report anchor clicks before later controls', () => {
  const { sections, navLinks, controls, counter, progress } = reportRuntimeFixture();

  navLinks[2].dispatch('click');
  assert.equal(counter.textContent, '3 / 3');
  assert.equal(navLinks[2].classList.contains('active'), true);
  assert.equal(progress.style.width, '100%');

  controls[0].dispatch('click');
  assert.equal(counter.textContent, '2 / 3', 'Previous must continue from the anchor-selected section');
  assert.equal(navLinks[1].classList.contains('active'), true);
  assert.equal(sections[1].scrollCalls.length, 1);
});

test('preview runtime fallback synchronizes legal hashchange before later controls', () => {
  const { listeners, location, sections, navLinks, controls, counter } = reportRuntimeFixture();
  const hashchange = listeners.get('hashchange');
  assert.ok(hashchange, 'report fallback must bind hashchange state synchronization');

  location.hash = '#closing';
  hashchange();
  assert.equal(counter.textContent, '3 / 3');
  assert.equal(navLinks[2].classList.contains('active'), true);

  controls[0].dispatch('click');
  assert.equal(counter.textContent, '2 / 3', 'Previous must continue from the hash-selected section');
  assert.equal(sections[1].scrollCalls.length, 1);
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
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
