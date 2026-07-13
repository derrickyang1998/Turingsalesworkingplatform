(function () {
  'use strict';

  var NAV_PAGES = [
    { id: 'm0', icon: '看', label: '客户看板' },
    { id: 'm0-detail', icon: '客', label: '客户明细' },
    { id: 'm1', icon: '智', label: '行业品牌智库' },
    { id: 'm2', icon: '策', label: '客户策略规划' },
    { id: 'm3', icon: '需', label: '需求接入 & 方案生成' },
    { id: 'm4', icon: '红', label: '网红匹配 & 执行管理' },
    { id: 'm5', icon: '🤖', label: 'AI 助手' },
    { id: 'workflow-designer', icon: '流', label: '流程设计' },
    { id: 'workflow-templates', icon: '模', label: '流程模板' },
    { id: 'workflow-instances', icon: '实', label: '流程实例' },
    { id: 'workflow-tasks', icon: '待', label: '我的待办' },
    { id: 'admin', icon: '管', label: '管理控制室', adminOnly: true }
  ];

  var SIMPLE_PATH_BY_PAGE = {
    m0: '/m0',
    m1: '/m1',
    m2: '/m2',
    m3: '/m3',
    m5: '/m5',
    'workflow-designer': '/workflow',
    'workflow-templates': '/workflow-templates',
    'workflow-instances': '/workflow-instances',
    'workflow-tasks': '/tasks'
  };

  var PAGE_BY_PATH = {
    '/': 'm0',
    '/m0': 'm0',
    '/m1': 'm1',
    '/m2': 'm2',
    '/m3': 'm3',
    '/m5': 'm5',
    '/workflow': 'workflow-designer',
    '/workflow-templates': 'workflow-templates',
    '/workflow-instances': 'workflow-instances',
    '/tasks': 'workflow-tasks'
  };

  var CRM_VIEWS = ['pipeline', 'seapool', 'opportunities'];
  var M4_TABS = ['tab1', 'tab2', 'tab3'];
  var ADMIN_TABS = ['overview', 'users', 'knowledge', 'ai-audit', 'tokens'];
  var activeUser = null;
  var popstateBound = false;

  function fallbackState() {
    return { pageId: 'm0', substate: null, preview: null };
  }

  function copySubstate(substate) {
    if (!substate) return null;
    var copy = {};
    Object.keys(substate).forEach(function (key) {
      copy[key] = substate[key];
    });
    return copy;
  }

  function state(pageId, substate, preview) {
    return {
      pageId: pageId,
      substate: substate || null,
      preview: preview === 'v030' ? 'v030' : null
    };
  }

  function isAdmin(user) {
    return !!(user && user.role === 'admin');
  }

  function searchParamsFromLocation(locationLike) {
    var raw = locationLike && locationLike.search ? String(locationLike.search) : '';
    if (raw.charAt(0) === '?') raw = raw.slice(1);
    return new URLSearchParams(raw);
  }

  function parsePathState(pathname, params) {
    var preview = params.get('preview') === 'v030' ? 'v030' : null;
    var pageId = PAGE_BY_PATH[pathname];
    if (pageId) return state(pageId, null, preview);

    if (pathname === '/m0-detail') {
      var view = params.get('view') || 'pipeline';
      if (CRM_VIEWS.indexOf(view) === -1) return fallbackState();
      return state('m0-detail', { view: view }, preview);
    }

    if (pathname === '/m4') {
      var tab = params.get('tab') || 'tab1';
      if (M4_TABS.indexOf(tab) === -1) return fallbackState();
      return state('m4', { tab: tab }, preview);
    }

    if (pathname === '/admin') {
      var adminTab = params.get('tab') || 'overview';
      if (ADMIN_TABS.indexOf(adminTab) === -1) return fallbackState();
      return state('admin', { tab: adminTab }, preview);
    }

    if (pathname === '/kb') {
      return state('admin', { tab: 'knowledge' }, preview);
    }

    return fallbackState();
  }

  function stateFromLocation(locationLike) {
    var pathname = locationLike && locationLike.pathname ? String(locationLike.pathname) : '/';
    return parsePathState(pathname, searchParamsFromLocation(locationLike));
  }

  function pathForState(input) {
    var pageId = input && input.pageId;
    var substate = input && input.substate ? input.substate : {};
    var preview = input && input.preview === 'v030' ? 'v030' : null;
    var params = new URLSearchParams();
    var path = SIMPLE_PATH_BY_PAGE[pageId];

    if (pageId === 'm0-detail') {
      var view = substate.view || 'pipeline';
      if (CRM_VIEWS.indexOf(view) === -1) return '/m0';
      params.set('view', view);
      path = '/m0-detail';
    } else if (pageId === 'm4') {
      var tab = substate.tab || 'tab1';
      if (M4_TABS.indexOf(tab) === -1) return '/m0';
      params.set('tab', tab);
      path = '/m4';
    } else if (pageId === 'admin') {
      var adminTab = substate.tab || 'overview';
      if (ADMIN_TABS.indexOf(adminTab) === -1) return '/m0';
      params.set('tab', adminTab);
      path = '/admin';
    } else if (!path) {
      return '/m0';
    }

    if (preview === 'v030') params.set('preview', preview);
    var query = params.toString();
    return query ? path + '?' + query : path;
  }

  function normalizeStateForUser(rawState, user) {
    if (!rawState || !rawState.pageId) return fallbackState();
    if (rawState.pageId === 'admin' && !isAdmin(user)) return fallbackState();
    return state(
      rawState.pageId,
      copySubstate(rawState.substate),
      isAdmin(user) ? rawState.preview : null
    );
  }

  function stateFromPage(pageId, substate, preview) {
    var path = pathForState({ pageId: pageId, substate: substate, preview: preview });
    var queryIndex = path.indexOf('?');
    return stateFromLocation({
      pathname: queryIndex === -1 ? path : path.slice(0, queryIndex),
      search: queryIndex === -1 ? '' : path.slice(queryIndex)
    });
  }

  function rebuildNav() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    var existing = sidebar.querySelectorAll('.nav-item');
    for (var i = 0; i < existing.length; i += 1) existing[i].remove();

    for (var j = 0; j < NAV_PAGES.length; j += 1) {
      (function (page) {
        var el = document.createElement('div');
        el.className = 'nav-item';
        if (page.adminOnly) el.className += ' admin-only';
        if (page.id === 'm0') el.className += ' active';
        el.setAttribute('data-page', page.id);
        el.onclick = function () {
          if (typeof window.switchPage === 'function') window.switchPage(page.id);
          else navigate(page.id);
        };
        el.style.cursor = 'pointer';
        el.innerHTML = '<span class="nav-icon">' + page.icon + '</span> ' + page.label;
        var footer = sidebar.querySelector('.sidebar-footer');
        if (footer) sidebar.insertBefore(el, footer);
        else sidebar.appendChild(el);
      })(NAV_PAGES[j]);
    }
  }

  function applyPreview(stateToApply, user) {
    if (!document.documentElement || !document.documentElement.dataset) return;
    if (stateToApply.preview === 'v030' && isAdmin(user)) {
      document.documentElement.dataset.tmPreview = 'v030';
    } else {
      delete document.documentElement.dataset.tmPreview;
    }
  }

  function applyPageState(stateToApply) {
    var pageId = stateToApply.pageId;
    var navs = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navs.length; i += 1) navs[i].classList.remove('active');
    var nav = document.querySelector('[data-page="' + pageId + '"]');
    if (nav) nav.classList.add('active');

    var pages = document.querySelectorAll('.page');
    for (var j = 0; j < pages.length; j += 1) {
      pages[j].classList.remove('active');
      pages[j].style.display = 'none';
    }
    var page = document.getElementById('page-' + pageId);
    if (page) {
      page.classList.add('active');
      page.style.display = 'block';
    }
    focusActiveHeading(page);
  }

  function focusActiveHeading(page) {
    if (!page) return;
    var heading = page.querySelector('h2');
    if (!heading || typeof heading.focus !== 'function') return;
    if (typeof heading.__tmNavigationFocusRestore === 'function') {
      heading.__tmNavigationFocusRestore();
    }
    var hadTabindex = typeof heading.hasAttribute === 'function' ? heading.hasAttribute('tabindex') : heading.getAttribute('tabindex') !== null;
    var previousTabindex = heading.getAttribute('tabindex');
    var previousOutline = heading.style.outline || '';
    function restoreFocusAttributes() {
      if (hadTabindex) {
        heading.setAttribute('tabindex', previousTabindex);
      } else if (typeof heading.removeAttribute === 'function') {
        heading.removeAttribute('tabindex');
      }
      heading.style.outline = previousOutline;
      heading.__tmNavigationFocusRestore = null;
    }
    heading.__tmNavigationFocusRestore = restoreFocusAttributes;
    heading.setAttribute('tabindex', '-1');
    heading.style.outline = 'none';
    try {
      heading.focus({ preventScroll: true });
    } catch (_error) {
      heading.focus();
    }
    if (typeof heading.addEventListener === 'function') {
      heading.addEventListener('blur', restoreFocusAttributes, { once: true });
    }
  }

  function dispatchApplied(stateToApply, options) {
    if (typeof document.dispatchEvent !== 'function' || typeof window.CustomEvent !== 'function') return;
    document.dispatchEvent(new window.CustomEvent('tm:navigation-applied', {
      detail: {
        state: {
          pageId: stateToApply.pageId,
          substate: copySubstate(stateToApply.substate),
          preview: stateToApply.preview
        },
        options: {
          fromPopState: !!(options && options.fromPopState)
        }
      }
    }));
  }

  function writeHistory(stateToApply, options) {
    if (options && options.fromPopState) return;
    var method = options && options.replace ? 'replaceState' : 'pushState';
    if (!window.history || typeof window.history[method] !== 'function') return;
    window.history[method]({
      tmNavigation: true,
      pageId: stateToApply.pageId,
      substate: copySubstate(stateToApply.substate),
      preview: stateToApply.preview
    }, '', pathForState(stateToApply));
  }

  function applyState(stateToApply, options, user) {
    applyPreview(stateToApply, user);
    applyPageState(stateToApply);
    writeHistory(stateToApply, options || {});
    dispatchApplied(stateToApply, options || {});
    return stateToApply;
  }

  function navigate(pageId, options) {
    var navOptions = options || {};
    if (navOptions.user) activeUser = navOptions.user;
    var rawState = stateFromPage(pageId, navOptions.substate, navOptions.preview);
    var stateToApply = normalizeStateForUser(rawState, navOptions.user || activeUser);
    return applyState(stateToApply, navOptions, navOptions.user || activeUser);
  }

  function bindPopstate() {
    if (popstateBound || typeof window.addEventListener !== 'function') return;
    popstateBound = true;
    window.addEventListener('popstate', function () {
      var stateToApply = normalizeStateForUser(stateFromLocation(window.location), activeUser);
      applyState(stateToApply, { fromPopState: true }, activeUser);
    });
  }

  function bindPageNormalizedFocus() {
    if (typeof document.addEventListener !== 'function') return;
    document.addEventListener('tm:navigation-pages-normalized', function () {
      focusActiveHeading(document.querySelector('.page.active'));
    });
  }

  function restore(user) {
    activeUser = user || null;
    bindPopstate();
    var stateToApply = normalizeStateForUser(stateFromLocation(window.location), activeUser);
    return applyState(stateToApply, { replace: true }, activeUser);
  }

  rebuildNav();
  bindPageNormalizedFocus();

  window.TMNavigation = Object.freeze({
    stateFromLocation: stateFromLocation,
    pathForState: pathForState,
    navigate: navigate,
    restore: restore
  });
})();
