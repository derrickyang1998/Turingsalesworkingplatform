const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'platform', 'index.html'), 'utf8');
const appPath = path.join(repoRoot, 'platform', 'app.js');
const appJs = fs.readFileSync(appPath, 'utf8');
const generatorPath = path.join(repoRoot, 'platform', 'server', 'scripts', 'generate_ui_baseline_manifest.js');

const task8FunctionNames = Object.freeze([
  'initM1',
  'renderIndustryTree',
  'filterBrands',
  'filterByTag',
  'filterByTreeTag',
  'renderSearchHistory',
  'renderBrands',
  'toggleBrandSocial',
  'switchPlatformTab',
  'loadSocialForBrand',
  'exportBrandCSV'
]);

function loadGenerator() {
  return require(generatorPath);
}

function scanCurrentScripts() {
  const { scanClassicScripts } = loadGenerator();
  return scanClassicScripts([
    { path: path.join(repoRoot, 'platform', 'app.js'), loadOrder: 1 },
    { path: path.join(repoRoot, 'platform', 'ppt.js'), loadOrder: 2 }
  ]);
}

function lineStartOffset(source, lineNumber) {
  if (lineNumber <= 1) return 0;
  let line = 1;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      if (line === lineNumber) return i + 1;
    }
  }
  throw new Error(`Line ${lineNumber} is outside source`);
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error(`No matching brace at offset ${openIndex}`);
}

function extractFunctionSourceByLine(source, lineNumber) {
  const start = lineStartOffset(source, lineNumber);
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error(`No function body at line ${lineNumber}`);
  const end = findMatchingBrace(source, open);
  return source.slice(start, end + 1);
}

function activeFunctionSource(name, inventory = scanCurrentScripts()) {
  const definition = inventory.activeDefinitions[name];
  assert.ok(definition, `${name} must be in the active definition inventory`);
  assert.equal(definition.source, 'platform/app.js', `${name} must come from app.js`);
  return extractFunctionSourceByLine(appJs, definition.line);
}

function firstFunctionSource(name, inventory = scanCurrentScripts()) {
  const definition = inventory.declarations.find((entry) => entry.name === name && entry.source === 'platform/app.js');
  assert.ok(definition, `${name} must be present in app.js`);
  return extractFunctionSourceByLine(appJs, definition.line);
}

function extractClickDelegation() {
  const marker = 'document.addEventListener("click", function(e) {';
  const start = appJs.indexOf(marker);
  assert.notEqual(start, -1, 'brand relation click delegation must be present');
  const open = appJs.indexOf('{', start);
  const end = findMatchingBrace(appJs, open);
  return appJs.slice(start, end + 1) + ');';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function createClassList(element) {
  function values() {
    return String(element.className || '').split(/\s+/).filter(Boolean);
  }
  function save(items) {
    element.className = Array.from(new Set(items)).join(' ');
    element.attributes.class = element.className;
  }
  return {
    add(name) {
      const items = values();
      if (!items.includes(name)) items.push(name);
      save(items);
    },
    remove(name) {
      save(values().filter((item) => item !== name));
    },
    contains(name) {
      return values().includes(name);
    },
    toggle(name, force) {
      const has = values().includes(name);
      const shouldAdd = force === undefined ? !has : !!force;
      if (shouldAdd) this.add(name);
      else this.remove(name);
      return shouldAdd;
    }
  };
}

class TestElement {
  constructor(tagName, ownerDocument, attributes = {}) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = {};
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.value = '';
    this.textContent = '';
    this._innerHTML = '';
    this._parsedChildren = [];
    this.className = '';
    this.id = '';
    this.nextElementSibling = null;
    this.listeners = {};
    this.classList = createClassList(this);

    for (const [name, value] of Object.entries(attributes)) {
      this.setAttribute(name, value);
    }
  }

  set innerHTML(value) {
    for (const child of this._parsedChildren) {
      this.ownerDocument.unregisterElement(child);
    }
    this._innerHTML = String(value || '');
    this._parsedChildren = parseElementsFromHtml(this._innerHTML, this.ownerDocument, this);
    this.children = this._parsedChildren.slice();
  }

  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(name, value) {
    const text = decodeHtml(value == null ? '' : value);
    this.attributes[name] = text;
    if (name === 'id') this.id = text;
    if (name === 'class') this.className = text;
    if (name === 'style') this.style.cssText = text;
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    this.ownerDocument.registerElement(child);
    return child;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
    this.ownerDocument.unregisterElement(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  click() {
    for (const handler of this.listeners.click || []) handler({ currentTarget: this, target: this });
    this.ownerDocument.dispatchClick(this);
  }

  querySelectorAll(selector) {
    return this.ownerDocument.querySelectorAll(selector).filter((candidate) => isDescendant(candidate, this));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class TestDocument {
  constructor() {
    this.elements = [];
    this.byId = new Map();
    this.listeners = {};
    this.body = new TestElement('body', this, { id: 'body' });
    this.registerElement(this.body);
  }

  createKnownElement(id, tagName = 'div') {
    const element = new TestElement(tagName, this, { id });
    this.registerElement(element);
    this.body.appendChild(element);
    return element;
  }

  createElement(tagName) {
    return new TestElement(tagName, this);
  }

  registerElement(element) {
    if (!this.elements.includes(element)) this.elements.push(element);
    if (element.id) this.byId.set(element.id, element);
    for (const child of element.children || []) this.registerElement(child);
  }

  unregisterElement(element) {
    this.elements = this.elements.filter((candidate) => candidate !== element);
    if (element.id && this.byId.get(element.id) === element) this.byId.delete(element.id);
    for (const child of element.children || []) this.unregisterElement(child);
  }

  getElementById(id) {
    return this.byId.get(id) || null;
  }

  querySelectorAll(selector) {
    const parts = String(selector || '').trim().split(/\s+/);
    const targetSelector = parts[parts.length - 1];
    const ancestorSelectors = parts.slice(0, -1).reverse();
    return this.elements.filter((element) => (
      matchesSelector(element, targetSelector)
      && matchesAncestorSelectors(element.parentElement, ancestorSelectors)
    ));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  dispatchClick(target) {
    for (const handler of this.listeners.click || []) {
      handler({ target });
    }
  }
}

function isDescendant(element, parent) {
  let cursor = element;
  while (cursor) {
    if (cursor === parent) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

function matchesAncestorSelectors(start, selectors) {
  let cursor = start;
  for (const selector of selectors) {
    while (cursor && !matchesSelector(cursor, selector)) cursor = cursor.parentElement;
    if (!cursor) return false;
    cursor = cursor.parentElement;
  }
  return true;
}

function parseAttributes(raw) {
  const attributes = {};
  const attrPattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attrPattern.exec(raw || ''))) {
    attributes[match[1]] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function parseElementsFromHtml(html, document, parent) {
  const elements = [];
  const tagPattern = /<([a-zA-Z][\w-]*)([^>]*)>/g;
  let match;
  while ((match = tagPattern.exec(html || ''))) {
    if (match[1].startsWith('/')) continue;
    const element = new TestElement(match[1], document, parseAttributes(match[2]));
    element.parentElement = parent;
    elements.push(element);
    document.registerElement(element);
  }
  return elements;
}

function matchesSelector(element, selector) {
  if (!selector) return false;
  let remaining = selector;

  const attrMatches = [];
  remaining = remaining.replace(/\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g, (_full, name, a, b, c) => {
    attrMatches.push([name, decodeHtml(a ?? b ?? String(c || '').replace(/^['"]|['"]$/g, ''))]);
    return '';
  });

  const idMatch = remaining.match(/#([\w-]+)/);
  if (idMatch && element.id !== idMatch[1]) return false;
  remaining = remaining.replace(/#[\w-]+/g, '');

  const classMatches = Array.from(remaining.matchAll(/\.([\w-]+)/g)).map((match) => match[1]);
  for (const className of classMatches) {
    if (!element.classList.contains(className)) return false;
  }
  remaining = remaining.replace(/\.[\w-]+/g, '');

  const tag = remaining.trim();
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  for (const [name, expected] of attrMatches) {
    const actual = element.getAttribute(name);
    if (actual == null) return false;
    if (expected && actual !== expected) return false;
  }
  return true;
}

function createLocalStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(key) {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
    snapshot() {
      return { ...store };
    }
  };
}

function sampleBrands() {
  return [
    {
      id: 'db_fixture',
      name: 'Fixture Labs',
      name_cn: 'Fixture CN',
      company: 'Fixture Labs Ltd.',
      industry_tags: ['smart-home', 'launch'],
      market: 'US',
      relation_group: 'Fixture Group',
      estimated_annual_revenue: '$50M-$100M',
      user_base: '2M users',
      description: 'smart home launch brand',
      website: 'https://fixture.invalid/labs',
      contact_emails: 'bd@fixture.invalid,press@fixture.invalid',
      overseas_presence: {
        social_followers: { youtube: 120000, instagram: 80000, tiktok: 45000 },
        brand_search_volume_monthly: 12345
      },
      social_content_monthly: {
        total_posts: 48,
        creative_angles: ['creator review', 'launch demo', 'comparison'],
        top_products_featured: ['Fixture Hub'],
        last_12_months: {
          avg_engagement_rate: '4.2%',
          avg_views_per_post: 38000,
          top_platform: 'YouTube'
        }
      },
      case_study_available: true,
      last_updated: '2026-07-13'
    },
    {
      id: 'db_sample',
      name: 'Sample Home',
      name_cn: 'Sample CN',
      company: 'Sample Home Inc.',
      industry_tags: ['smart-home', 'appliance'],
      market: 'EU',
      relation_group: 'Fixture Group',
      estimated_annual_revenue: '$10M-$50M',
      user_base: '900K users',
      description: 'related home appliance brand',
      overseas_presence: {
        social_followers: { youtube: 70000, instagram: 110000, tiktok: 51000 },
        brand_search_volume_monthly: 8000
      },
      social_content_monthly: {
        total_posts: 20,
        creative_angles: ['home tour'],
        last_12_months: { top_platform: 'Instagram' }
      },
      last_updated: '2026-07-13'
    },
    {
      id: 'rival',
      name: 'Rival Works',
      name_cn: 'Rival CN',
      company: 'Rival Works Co.',
      industry_tags: ['smart-home', 'launch', 'outdoor'],
      market: 'US',
      estimated_annual_revenue: '$20M',
      user_base: '1M users',
      description: 'competitor with overlapping tags',
      overseas_presence: {
        social_followers: { youtube: 90000, instagram: 60000, tiktok: 120000 },
        brand_search_volume_monthly: 6000
      },
      social_content_monthly: {
        creative_angles: ['comparison', 'field test'],
        last_12_months: { top_platform: 'TikTok' }
      }
    },
    {
      id: 'quote_brand',
      name: 'Quote,Works',
      name_cn: '"Quoted" CN',
      company: 'Quote Works LLC',
      industry_tags: ['outdoor', 'review'],
      market: 'CA',
      estimated_annual_revenue: '$5M',
      user_base: '50K users',
      description: 'csv quoting target',
      website: 'https://fixture.invalid/quote',
      contact_email: 'quote@fixture.invalid',
      overseas_presence: {
        social_followers: { youtube: 1000, instagram: 2000, tiktok: 3000 },
        brand_search_volume_monthly: 42
      },
      social_content_monthly: {
        last_12_months: { top_platform: 'TikTok' }
      }
    },
    {
      id: 'bare',
      name: 'Bare Brand',
      industry_tags: ['other'],
      market: 'APAC',
      description: 'not ready for knowledge base'
    }
  ];
}

function createBrandVm(options = {}) {
  const inventory = scanCurrentScripts();
  const document = new TestDocument();
  const ids = [
    'tagGroup',
    'tagCount',
    'brandSearch',
    'brandSort',
    'searchHistory',
    'brandResults',
    'brandList',
    'brandWorkspaceStats',
    'brandDetailPanel',
    'brandCount',
    'brandActiveFilter',
    'd_brand',
    'd_company',
    'd_category',
    'd_competitors',
    'd_usp',
    'd_notes',
    'page-m1',
    'page-m3'
  ];
  for (const id of ids) {
    const tag = id === 'brandSearch' || id.startsWith('d_') ? 'input' : id === 'brandSort' ? 'select' : 'div';
    document.createKnownElement(id, tag);
  }
  document.getElementById('brandSort').value = 'relevance';

  const localStorage = createLocalStorage(options.storage);
  const downloads = [];
  const toasts = [];
  const opened = [];
  const apiCalls = [];
  const pages = [];

  const context = {
    __brands: JSON.parse(JSON.stringify(options.brands || sampleBrands())),
    __apiReject: false,
    __apiResult: { searchUrl: 'https://fixture.invalid/social-search' },
    console,
    document,
    localStorage,
    navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    encodeURIComponent,
    decodeURIComponent,
    URL,
    JSON,
    String,
    Number,
    Array,
    Object,
    Math,
    Promise,
    window: null
  };
  context.window = context;
  context.globalThis = context;
  context.INDUSTRY_TREE = options.industryTree || {
    Consumer: { sub_tags: ['smart-home', 'launch'] },
    Outdoor: { sub_tags: ['outdoor', 'review'] }
  };
  context.apiFetch = (url) => {
    apiCalls.push(url);
    if (context.__apiReject) return Promise.reject(new Error('fixture network failure'));
    return Promise.resolve({
      json: () => Promise.resolve(context.__apiResult)
    });
  };
  context.dlFile = (name, content, mime) => {
    downloads.push({ name, content, mime });
  };
  context.toast = (message, type) => {
    toasts.push({ message, type });
  };
  context.open = (url, target) => {
    opened.push({ url, target });
    return null;
  };
  context.switchPage = (id) => {
    pages.push(id);
    const m1 = document.getElementById('page-m1');
    const m3 = document.getElementById('page-m3');
    if (m1) m1.style.display = id === 'm1' ? 'block' : 'none';
    if (m3) m3.style.display = id === 'm3' ? 'block' : 'none';
  };

  const functionNames = [
    'esc',
    'toggleTreeNode',
    'archiveBrandSearch',
    'renderBrandWorkspaceStats',
    'selectBrand',
    'selectBrandByName',
    'getSelectedBrand',
    'renderBrandDetail',
    'renderBrandKnowledgeStatus',
    'renderBrandOpportunityPanel',
    'renderBrandSocialSources',
    'renderBrandRelations',
    'brandKpi',
    'openBrandSocialSearch',
    'copyBrandBriefToDemand',
    'setValueIfPresent',
    'brandTags',
    'brandFollowers',
    'brandContent',
    'brandContacts',
    'isBrandKnowledgeReady',
    'normalizeList',
    'sortBrandResults',
    'brandRevenueScore',
    'brandSocialScore',
    'brandSearchScore',
    'formatCompactNumber',
    'inlineJsArg',
    'csvCell',
    'buildBrandSearchUrl',
    'buildBrandRelationCache',
    'findRelatedBrands',
    'findCompetitorBrands',
    'showRelatedBrands',
    'closeBrandRelModal'
  ];
  const sources = [
    'var BRANDS = __brands;',
    'var activeTag = null;',
    'var selectedBrandName = "";',
    'var currentBrandResults = [];',
    'var _brandRelationCache = null;',
    "var brandSearchHistory = JSON.parse(localStorage.getItem('tm_brand_search_history') || '[]');",
    ...functionNames.map((name) => firstFunctionSource(name, inventory)),
    ...task8FunctionNames.map((name) => activeFunctionSource(name, inventory)),
    extractClickDelegation()
  ];
  vm.createContext(context);
  vm.runInContext(sources.join('\n\n'), context, { filename: 'task8-brand-vm.js' });

  return { context, document, localStorage, downloads, toasts, opened, apiCalls, pages };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('brand library exposes the command workspace shell without changing the PPT bridge', () => {
  [
    'brandWorkspace',
    'brandWorkspaceStats',
    'brandResults',
    'brandDetailPanel',
    'brandKnowledgeStatus',
    'brandOpportunityPanel',
    'brandSocialSources'
  ].forEach((id) => assert.match(indexHtml, new RegExp(`id="${id}"`), id));

  assert.match(indexHtml, /ppt\.js\?v=20260702v916kbbridge/);
});

test('brand workspace implements required active command functions', () => {
  [
    'selectBrand',
    'renderBrandWorkspaceStats',
    'renderBrandDetail',
    'renderBrandKnowledgeStatus',
    'renderBrandOpportunityPanel',
    'openBrandSocialSearch',
    'copyBrandBriefToDemand',
    'showRelatedBrands'
  ].forEach((fn) => assert.match(appJs, new RegExp(`function\\s+${fn}\\s*\\(`), fn));

  assert.match(appJs, /apiFetch\('\/brands'/);
  assert.match(appJs, /apiFetch\('\/brands\/enrich'/);
});

test('brand search persists history, renders six replay chips, and restores a replayed query', () => {
  const { context, document, localStorage } = createBrandVm({
    storage: {
      tm_brand_search_history: JSON.stringify(['older1', 'older2', 'older3', 'older4', 'older5', 'older6', 'older7'])
    }
  });

  context.initM1();
  const search = document.getElementById('brandSearch');
  search.value = 'Fixture Labs';
  context.filterBrands();

  assert.deepEqual(JSON.parse(localStorage.getItem('tm_brand_search_history')).slice(0, 2), ['fixture labs', 'older1']);
  assert.equal(document.querySelectorAll('#searchHistory button').length, 6);
  assert.equal(context.currentBrandResults.length, 1);
  assert.equal(context.currentBrandResults[0].name, 'Fixture Labs');

  search.value = '';
  const firstHistory = document.querySelector('#searchHistory button');
  vm.runInContext(firstHistory.getAttribute('onclick'), context);

  assert.equal(search.value, 'fixture labs');
  assert.equal(context.currentBrandResults.length, 1);
  assert.equal(context.currentBrandResults[0].name, 'Fixture Labs');
});

test('industry tree tag selection filters brands and toggles active state', () => {
  const { context, document } = createBrandVm();

  context.initM1();
  assert.equal(document.getElementById('tagCount').textContent, '4 tags');

  const smartHome = document.querySelector('.tree-child[data-tag="smart-home"]');
  assert.ok(smartHome, 'smart-home tree tag must render');

  context.filterByTreeTag('smart-home', smartHome);
  assert.equal(context.activeTag, 'smart-home');
  assert.equal(smartHome.classList.contains('active'), true);
  assert.deepEqual(context.currentBrandResults.map((brand) => brand.name), ['Fixture Labs', 'Sample Home', 'Rival Works']);
  assert.equal(document.getElementById('brandCount').textContent, '3 / 5 brands');

  context.filterByTag('smart-home');
  assert.equal(context.activeTag, null);
  assert.equal(document.getElementById('brandCount').textContent, '5 / 5 brands');
});

test('brand selection renders active cards, detail panels, KB status, socials, and relation actions', () => {
  const { context, document } = createBrandVm();

  context.initM1();
  context.selectBrand(1);

  assert.equal(context.selectedBrandName, 'Sample Home');
  assert.match(document.getElementById('brandResults').innerHTML, /brand-result-item active/);
  assert.match(document.getElementById('brandDetailPanel').innerHTML, /Sample Home/);
  assert.match(document.getElementById('brandDetailPanel').innerHTML, /id="brandKnowledgeStatus"/);
  assert.match(document.getElementById('brandDetailPanel').innerHTML, /id="brandOpportunityPanel"/);
  assert.match(document.getElementById('brandDetailPanel').innerHTML, /id="brandSocialSources"/);
  assert.match(document.getElementById('brandDetailPanel').innerHTML, /showRelatedBrands/);

  assert.equal(context.isBrandKnowledgeReady(context.BRANDS[0]), true);
  assert.equal(context.isBrandKnowledgeReady(context.BRANDS[4]), false);
  assert.notEqual(
    context.renderBrandKnowledgeStatus(context.BRANDS[0]),
    context.renderBrandKnowledgeStatus(context.BRANDS[4]),
    'ready and not-ready knowledge statuses must render differently'
  );
});

test('social actions call the API URL, open the API result, and fall back to generated platform URLs', async () => {
  const { context, document, opened, apiCalls } = createBrandVm();

  context.initM1();
  context.openBrandSocialSearch('Fixture Labs', 'instagram');
  await flushPromises();

  assert.equal(apiCalls[0], '/brands/social-search?brand=Fixture%20Labs&platform=instagram');
  assert.deepEqual(opened[0], { url: 'https://fixture.invalid/social-search', target: '_blank' });

  context.__apiReject = true;
  context.openBrandSocialSearch('Fixture Labs', 'tiktok');
  await flushPromises();
  assert.equal(opened[1].url, 'https://www.tiktok.com/search/video?q=Fixture%20Labs');

  context.__apiReject = false;
  context.loadSocialForBrand('Sample Home', 'ignored', 'youtube');
  await flushPromises();
  assert.equal(apiCalls.at(-1), '/brands/social-search?brand=Sample%20Home&platform=youtube');

  context.selectedBrandName = 'Fixture Labs';
  context.switchPlatformTab({
    getAttribute(name) {
      return name === 'data-plat' ? 'instagram' : null;
    }
  });
  await flushPromises();
  assert.equal(apiCalls.at(-1), '/brands/social-search?brand=Fixture%20Labs&platform=instagram');

  const beforeToggle = document.getElementById('brandDetailPanel').innerHTML;
  context.toggleBrandSocial(null, 'ignored');
  assert.equal(document.getElementById('brandDetailPanel').innerHTML, beforeToggle);
});

test('relation cache distinguishes related brands from tag-overlap competitors and modal tags filter results', () => {
  const { context, document } = createBrandVm();

  context.initM1();
  const fixtureBrand = context.BRANDS[0];

  assert.deepEqual(Array.from(context.findRelatedBrands(fixtureBrand), (brand) => brand.name), ['Sample Home']);
  assert.deepEqual(Array.from(context.findCompetitorBrands(fixtureBrand), (brand) => brand.name), ['Rival Works']);

  context.showRelatedBrands('Fixture Labs');
  const tags = document.querySelectorAll('.brel-tag');
  assert.deepEqual(tags.map((tag) => tag.getAttribute('data-bn')), ['Sample Home', 'Rival Works']);

  tags[1].click();
  assert.equal(document.getElementById('brandSearch').value, 'Rival Works');
  assert.equal(context.currentBrandResults.length, 1);
  assert.equal(context.currentBrandResults[0].name, 'Rival Works');
  assert.equal(document.getElementById('brandRelOverlay'), null);
});

test('copy-to-demand navigates to M3 and fills demand fields from the selected brand brief', () => {
  const { context, document, pages } = createBrandVm();

  context.initM1();
  context.copyBrandBriefToDemand('Fixture Labs');

  assert.deepEqual(pages, ['m3']);
  assert.equal(document.getElementById('d_brand').value, 'Fixture Labs');
  assert.equal(document.getElementById('d_company').value, 'Fixture Labs Ltd.');
  assert.equal(document.getElementById('d_category').value, 'smart-home');
  assert.equal(document.getElementById('d_competitors').value, 'Rival Works');
  assert.equal(document.getElementById('d_usp').value, 'creator review / launch demo / comparison');
  assert.match(document.getElementById('d_notes').value, /Fixture Labs/);
});

test('CSV export uses filtered rows with locked header, quoting, BOM, filename, MIME, and download call', () => {
  const { context, document, downloads } = createBrandVm();

  context.initM1();
  document.getElementById('brandSearch').value = 'Quote';
  context.filterBrands();
  context.exportBrandCSV();

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'brands.csv');
  assert.equal(downloads[0].mime, 'text/csv');
  assert.equal(downloads[0].content.charCodeAt(0), 0xfeff);

  const csv = downloads[0].content.slice(1);
  const lines = csv.trimEnd().split('\n');
  assert.equal(
    lines[0],
    'Name,Chinese Name,Industry Tags,Market,Revenue,User Base,Search Volume,YouTube,Instagram,TikTok,Top Platform,Website,Contacts'
  );
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^"Quote,Works","""Quoted"" CN","outdoor;review","CA","\$5M","50K users","42","1000","2000","3000","TikTok","https:\/\/fixture\.invalid\/quote","quote@fixture\.invalid"$/);
});
