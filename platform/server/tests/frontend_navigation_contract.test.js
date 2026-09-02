const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const platformRoot = path.join(__dirname, '..', '..');
const navigationPath = path.join(platformRoot, 'client', 'core', 'navigation.js');

const adminUser = { id: 1, role: 'admin', display_name: 'Admin' };
const normalUser = { id: 2, role: 'user', display_name: 'User' };

class ClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return String(this.element.className || '').split(/\s+/).filter(Boolean);
  }

  set(values) {
    this.element.className = Array.from(new Set(values)).join(' ');
  }

  add(...tokens) {
    this.set(this.values().concat(tokens));
  }

  remove(...tokens) {
    const remove = new Set(tokens);
    this.set(this.values().filter((token) => !remove.has(token)));
  }

  contains(token) {
    return this.values().includes(token);
  }

  toggle(token, force) {
    const has = this.contains(token);
    if (force === true || (!has && force !== false)) {
      this.add(token);
      return true;
    }
    if (has) this.remove(token);
    return false;
  }
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.style = {};
    this.className = '';
    this.id = '';
    this.innerHTML = '';
    this.textContent = '';
    this.classList = new ClassList(this);
    this.eventListeners = {};
  }

  appendChild(child) {
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    const index = this.children.indexOf(reference);
    if (index === -1) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index !== -1) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === 'id') this.id = text;
    if (name === 'class') this.className = text;
  }

  hasAttribute(name) {
    if (name === 'id') return !!this.id;
    if (name === 'class') return !!this.className;
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
  }

  focus(options) {
    this.ownerDocument.activeElement = this;
    this.lastFocusOptions = options || {};
  }

  addEventListener(type, handler, options) {
    this.eventListeners[type] = this.eventListeners[type] || [];
    this.eventListeners[type].push({ handler, once: !!(options && options.once) });
  }

  dispatchEvent(event) {
    const listeners = this.eventListeners[event.type] || [];
    this.eventListeners[event.type] = listeners.filter((listener) => {
      listener.handler.call(this, event);
      return !listener.once;
    });
    return true;
  }

  blur() {
    this.ownerDocument.activeElement = this.ownerDocument.body;
    this.dispatchEvent({ type: 'blur' });
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (element) => {
      if (element !== this && matches(element, selector)) results.push(element);
      for (const child of element.children) visit(child);
    };
    visit(this);
    return results;
  }
}

function matches(element, selector) {
  if (selector === 'h2') return element.tagName === 'H2';
  if (selector === '.sidebar') return element.classList.contains('sidebar');
  if (selector === '.sidebar-footer') return element.classList.contains('sidebar-footer');
  if (selector === '.page') return element.classList.contains('page');
  if (selector.startsWith('.')) {
    return selector.slice(1).split('.').every((token) => element.classList.contains(token));
  }
  const dataPage = selector.match(/^\[data-page="([^"]+)"\]$/);
  if (dataPage) return element.getAttribute('data-page') === dataPage[1];
  return false;
}

function createDocument() {
  const document = {
    documentElement: null,
    body: null,
    activeElement: null,
    dispatchedEvents: [],
    createElement(tagName) {
      return new Element(tagName, document);
    },
    getElementById(id) {
      return find(document.documentElement, (element) => element.id === id);
    },
    querySelector(selector) {
      return document.documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return document.documentElement.querySelectorAll(selector);
    },
    dispatchEvent(event) {
      document.dispatchedEvents.push(event);
      return true;
    }
  };
  document.documentElement = new Element('html', document);
  document.documentElement.dataset = {};
  document.body = new Element('body', document);
  document.activeElement = document.body;
  document.documentElement.appendChild(document.body);

  const sidebar = new Element('nav', document);
  sidebar.className = 'sidebar';
  const staleNav = new Element('div', document);
  staleNav.className = 'nav-item active';
  staleNav.setAttribute('data-page', 'stale');
  const footer = new Element('div', document);
  footer.className = 'sidebar-footer';
  sidebar.appendChild(staleNav);
  sidebar.appendChild(footer);
  document.body.appendChild(sidebar);

  [
    'm0',
    'm0-detail',
    'm1',
    'm2',
    'm3',
    'm4',
    'm5',
    'workflow-designer',
    'workflow-templates',
    'workflow-instances',
    'workflow-tasks',
    'admin'
  ].forEach((pageId) => {
    const page = new Element('div', document);
    page.id = `page-${pageId}`;
    page.className = pageId === 'm0' ? 'page active' : 'page';
    page.style.display = pageId === 'm0' ? 'block' : 'none';
    const heading = new Element('h2', document);
    heading.textContent = `Heading ${pageId}`;
    page.appendChild(heading);
    document.body.appendChild(page);
  });

  return document;
}

function find(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createLocation(pathname = '/', search = '') {
  const location = {
    origin: 'https://tm.test',
    protocol: 'https:',
    host: 'tm.test',
    hostname: 'tm.test',
    port: '',
    hash: ''
  };
  applyLocation(location, pathname + search);
  return location;
}

function applyLocation(location, target) {
  const next = new URL(target, location.origin || 'https://tm.test');
  location.href = next.href;
  location.pathname = next.pathname;
  location.search = next.search;
  location.hash = next.hash;
}

function loadNavigation(pathname = '/', search = '') {
  assert.equal(fs.existsSync(navigationPath), true, 'platform/client/core/navigation.js must exist');
  const document = createDocument();
  const location = createLocation(pathname, search);
  const historyCalls = [];
  const listeners = { popstate: [] };
  const window = {
    window: null,
    document,
    location,
    history: {
      pushState(state, title, url) {
        historyCalls.push({ method: 'pushState', state, title, url });
        applyLocation(location, url);
      },
      replaceState(state, title, url) {
        historyCalls.push({ method: 'replaceState', state, title, url });
        applyLocation(location, url);
      }
    },
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    CustomEvent: function CustomEvent(type, init) {
      return { type, detail: init && init.detail };
    },
    URLSearchParams,
    console,
    setTimeout(callback) {
      callback();
      return 0;
    },
    clearTimeout() {}
  };
  window.window = window;
  document.defaultView = window;
  vm.runInNewContext(fs.readFileSync(navigationPath, 'utf8'), {
    window,
    document,
    location,
    history: window.history,
    CustomEvent: window.CustomEvent,
    URLSearchParams,
    console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout
  }, { filename: navigationPath });

  return {
    window,
    document,
    nav: window.TMNavigation,
    historyCalls,
    listeners,
    setUrl(url) {
      applyLocation(location, url);
    },
    lastNavigationEvent() {
      return document.dispatchedEvents.filter((event) => event.type === 'tm:navigation-applied').at(-1);
    }
  };
}

test('TMNavigation exposes only the approved public browser methods', () => {
  const { nav } = loadNavigation();

  assert.deepEqual(Object.keys(nav).sort(), [
    'navigate',
    'pathForState',
    'restore',
    'stateFromLocation'
  ]);
});

test('navigation rebuild preserves the registry as canonical anchors with grouped admin visibility', () => {
  const { document } = loadNavigation();
  const navItems = document.querySelectorAll('.nav-item');
  const expected = [
    ['m0', '/m0', '<span class="nav-icon" aria-hidden="true">看</span> 客户看板', false],
    ['m0-detail', '/m0-detail?view=pipeline', '<span class="nav-icon" aria-hidden="true">客</span> 客户明细', false],
    ['m1', '/m1', '<span class="nav-icon" aria-hidden="true">智</span> 行业品牌智库', false],
    ['m2', '/m2', '<span class="nav-icon" aria-hidden="true">策</span> 客户策略规划', false],
    ['m3', '/m3', '<span class="nav-icon" aria-hidden="true">需</span> 需求接入 & 方案生成', false],
    ['m4', '/m4?tab=tab1', '<span class="nav-icon" aria-hidden="true">红</span> 网红匹配 & 执行管理', false],
    ['performance-monitor', '/performance-monitor', '<span class="nav-icon" aria-hidden="true">监</span> 内容监控', false],
    ['performance-dashboard', '/performance-dashboard', '<span class="nav-icon" aria-hidden="true">效</span> 效果看板', false],
    ['m5', '/m5', '<span class="nav-icon" aria-hidden="true">🤖</span> AI 助手', false],
    ['workflow-designer', '/workflow', '<span class="nav-icon" aria-hidden="true">流</span> 流程设计', false],
    ['workflow-templates', '/workflow-templates', '<span class="nav-icon" aria-hidden="true">模</span> 流程模板', false],
    ['workflow-instances', '/workflow-instances', '<span class="nav-icon" aria-hidden="true">实</span> 流程实例', false],
    ['workflow-tasks', '/tasks', '<span class="nav-icon" aria-hidden="true">待</span> 我的待办', false],
    ['admin', '/admin?tab=overview', '<span class="nav-icon" aria-hidden="true">管</span> 管理控制室', true]
  ];

  assert.equal(navItems.length, expected.length);
  expected.forEach(([pageId, href, html, adminOnly], index) => {
    assert.equal(navItems[index].tagName, 'A');
    assert.equal(navItems[index].getAttribute('data-page'), pageId);
    assert.equal(navItems[index].getAttribute('href'), href);
    assert.equal(navItems[index].innerHTML, html);
    assert.equal(navItems[index].classList.contains('admin-only'), adminOnly);
  });
  assert.deepEqual(
    document.querySelectorAll('.nav-group-label').map((group) => group.textContent),
    ['客户经营', '方案与执行', '流程协作', '系统管理']
  );
  assert.equal(document.querySelectorAll('.nav-group-label').at(-1).classList.contains('admin-only'), true);
});

test('navigation intercepts only unmodified primary clicks and preserves native new-context behavior', () => {
  const context = loadNavigation('/m0');
  context.nav.restore(adminUser);
  context.historyCalls.length = 0;
  const m4 = context.document.querySelector('[data-page="m4"]');

  let prevented = false;
  m4.dispatchEvent({
    type: 'click',
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault() { prevented = true; }
  });
  assert.equal(prevented, true);
  assert.deepEqual(context.historyCalls.map((call) => [call.method, call.url]), [
    ['pushState', '/m4?tab=tab1']
  ]);

  for (const variant of [
    { button: 1 },
    { button: 0, ctrlKey: true },
    { button: 0, metaKey: true },
    { button: 0, shiftKey: true },
    { button: 0, altKey: true }
  ]) {
    context.historyCalls.length = 0;
    let nativePrevented = false;
    m4.dispatchEvent({
      type: 'click',
      button: variant.button,
      metaKey: !!variant.metaKey,
      ctrlKey: !!variant.ctrlKey,
      shiftKey: !!variant.shiftKey,
      altKey: !!variant.altKey,
      preventDefault() { nativePrevented = true; }
    });
    assert.equal(nativePrevented, false, JSON.stringify(variant));
    assert.deepEqual(context.historyCalls, [], JSON.stringify(variant));
  }
});

test('stateFromLocation and pathForState use the canonical route and substate table', () => {
  const { nav } = loadNavigation();

  [
    [{ pageId: 'm0' }, '/m0'],
    [{ pageId: 'm0-detail' }, '/m0-detail?view=pipeline'],
    [{ pageId: 'm0-detail', substate: { view: 'seapool' } }, '/m0-detail?view=seapool'],
    [{ pageId: 'm4' }, '/m4?tab=tab1'],
    [{ pageId: 'm4', substate: { tab: 'tab3' } }, '/m4?tab=tab3'],
    [{ pageId: 'm4', substate: { tab: 'tab2' }, preview: 'v030' }, '/m4?tab=tab2&preview=v030'],
    [{ pageId: 'admin' }, '/admin?tab=overview'],
    [{ pageId: 'admin', substate: { tab: 'knowledge' } }, '/admin?tab=knowledge'],
    [{ pageId: 'admin', substate: { tab: 'users' }, preview: 'v030' }, '/admin?tab=users&preview=v030'],
    [{ pageId: 'workflow-designer' }, '/workflow'],
    [{ pageId: 'workflow-tasks' }, '/tasks'],
    [{ pageId: 'unknown' }, '/m0'],
    [{ pageId: 'm4', substate: { tab: '2' } }, '/m0']
  ].forEach(([state, expectedPath]) => {
    assert.equal(nav.pathForState(state), expectedPath, JSON.stringify(state));
  });

  [
    ['/', { pageId: 'm0', substate: null, preview: null }],
    ['/m0', { pageId: 'm0', substate: null, preview: null }],
    ['/m0-detail', { pageId: 'm0-detail', substate: { view: 'pipeline' }, preview: null }],
    ['/m0-detail?view=opportunities', { pageId: 'm0-detail', substate: { view: 'opportunities' }, preview: null }],
    ['/m4', { pageId: 'm4', substate: { tab: 'tab1' }, preview: null }],
    ['/m4?tab=tab2', { pageId: 'm4', substate: { tab: 'tab2' }, preview: null }],
    ['/m4?tab=tab2&preview=v030', { pageId: 'm4', substate: { tab: 'tab2' }, preview: 'v030' }],
    ['/m4?tab=2', { pageId: 'm0', substate: null, preview: null }],
    ['/admin', { pageId: 'admin', substate: { tab: 'overview' }, preview: null }],
    ['/admin?tab=ai-audit&preview=v030', { pageId: 'admin', substate: { tab: 'ai-audit' }, preview: 'v030' }],
    ['/kb', { pageId: 'admin', substate: { tab: 'knowledge' }, preview: null }],
    ['/workflow', { pageId: 'workflow-designer', substate: null, preview: null }],
    ['/tasks', { pageId: 'workflow-tasks', substate: null, preview: null }],
    ['/not-real', { pageId: 'm0', substate: null, preview: null }]
  ].forEach(([url, expectedState]) => {
    assert.deepEqual(plain(nav.stateFromLocation(new URL(url, 'https://tm.test'))), expectedState, url);
  });
});

test('restore role-gates admin and kb routes before rendering and gates preview marker to admins', () => {
  const adminContext = loadNavigation('/admin', '?tab=users&preview=v030');
  adminContext.nav.restore(adminUser);
  assert.equal(adminContext.document.getElementById('page-admin').style.display, 'block');
  assert.equal(adminContext.document.documentElement.dataset.tmPreview, 'v030');
  assert.equal(adminContext.lastNavigationEvent().detail.state.pageId, 'admin');
  assert.deepEqual(plain(adminContext.lastNavigationEvent().detail.state.substate), { tab: 'users' });
  assert.deepEqual(adminContext.historyCalls.map((call) => [call.method, call.url]), [
    ['replaceState', '/admin?tab=users&preview=v030']
  ]);

  const userContext = loadNavigation('/kb', '?preview=v030');
  userContext.nav.restore(normalUser);
  assert.equal(userContext.document.getElementById('page-m0').style.display, 'block');
  assert.equal(userContext.document.getElementById('page-admin').style.display, 'none');
  assert.equal(userContext.document.documentElement.dataset.tmPreview, undefined);
  assert.equal(userContext.lastNavigationEvent().detail.state.pageId, 'm0');
  assert.deepEqual(userContext.historyCalls.map((call) => [call.method, call.url]), [
    ['replaceState', '/m0']
  ]);

  const adminPreviewContext = loadNavigation('/m4', '?tab=tab2&preview=v030');
  adminPreviewContext.nav.restore(adminUser);
  assert.equal(adminPreviewContext.document.getElementById('page-m4').style.display, 'block');
  assert.equal(adminPreviewContext.document.documentElement.dataset.tmPreview, 'v030');
  assert.equal(adminPreviewContext.lastNavigationEvent().detail.state.pageId, 'm4');
  assert.deepEqual(plain(adminPreviewContext.historyCalls.map((call) => [call.method, call.url])), [
    ['replaceState', '/m4?tab=tab2&preview=v030']
  ]);

  const userPreviewContext = loadNavigation('/m4', '?tab=tab2&preview=v030');
  userPreviewContext.nav.restore(normalUser);
  assert.equal(userPreviewContext.document.getElementById('page-m4').style.display, 'block');
  assert.equal(userPreviewContext.document.documentElement.dataset.tmPreview, undefined);
  assert.deepEqual(plain(userPreviewContext.historyCalls.map((call) => [call.method, call.url])), [
    ['replaceState', '/m4?tab=tab2']
  ]);
});

test('restore binds popstate once and popstate applies URL state without writing history', () => {
  const context = loadNavigation('/m0');

  context.nav.restore(adminUser);
  context.nav.restore(adminUser);
  assert.equal(context.listeners.popstate.length, 1);

  context.historyCalls.length = 0;
  context.setUrl('/m0-detail?view=seapool');
  context.listeners.popstate[0]({});

  assert.equal(context.document.getElementById('page-m0-detail').style.display, 'block');
  assert.deepEqual(plain(context.lastNavigationEvent().detail.state), {
    pageId: 'm0-detail',
    substate: { view: 'seapool' },
    preview: null
  });
  assert.deepEqual(context.historyCalls, []);
});

test('navigate uses push, replace, and fromPopState history rules', () => {
  const context = loadNavigation('/m0');
  context.nav.restore(adminUser);
  assert.equal(context.document.querySelector('[data-page="m0"]').getAttribute('aria-current'), 'page');
  context.historyCalls.length = 0;

  context.nav.navigate('m4', { substate: { tab: 'tab2' }, user: adminUser });
  assert.equal(context.document.querySelector('[data-page="m0"]').getAttribute('aria-current'), null);
  assert.equal(context.document.querySelector('[data-page="m4"]').getAttribute('aria-current'), 'page');
  context.nav.navigate('m5', { replace: true, user: adminUser });
  context.nav.navigate('m1', { fromPopState: true, user: adminUser });

  assert.deepEqual(context.historyCalls.map((call) => [call.method, call.url]), [
    ['pushState', '/m4?tab=tab2'],
    ['replaceState', '/m5']
  ]);
  assert.equal(context.document.getElementById('page-m1').style.display, 'block');
});

test('navigate focuses the active page first h2 without scrolling or suppressing focus styling', () => {
  const context = loadNavigation('/m0');
  context.nav.restore(adminUser);
  context.historyCalls.length = 0;

  context.nav.navigate('m4', { substate: { tab: 'tab3' }, user: adminUser });

  const heading = context.document.getElementById('page-m4').querySelector('h2');
  assert.equal(context.document.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1');
  assert.equal(heading.style.outline || '', '');
  assert.deepEqual(plain(heading.lastFocusOptions), { preventScroll: true });
  assert.equal(context.document.getElementById('page-m4').style.display, 'block');
  assert.equal(context.document.getElementById('page-m0').style.display, 'none');

  heading.blur();
  assert.equal(context.document.activeElement, context.document.body);
  assert.equal(heading.getAttribute('tabindex'), null);
  assert.equal(heading.style.outline || '', '');
});
