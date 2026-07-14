(function () {
  'use strict';

  var initialized = false;
  var navigationOpen = false;
  var openButton = null;
  var closeButton = null;
  var sidebar = null;
  var backdrop = null;
  var mobileTitle = null;
  var desktopMedia = null;
  var backgroundInertRecords = [];
  var FOCUSABLE = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function isDesktop() {
    return desktopMedia ? desktopMedia.matches : window.innerWidth > 900;
  }

  function shellAvailable() {
    return !!(openButton && closeButton && sidebar && backdrop);
  }

  function setBackgroundInert(nextInert) {
    for (var restoreIndex = 0; restoreIndex < backgroundInertRecords.length; restoreIndex += 1) {
      backgroundInertRecords[restoreIndex].element.inert = backgroundInertRecords[restoreIndex].inert;
    }
    backgroundInertRecords = [];
    if (!nextInert || !sidebar || !sidebar.parentElement) return;
    var siblings = sidebar.parentElement.children;
    for (var index = 0; index < siblings.length; index += 1) {
      var sibling = siblings[index];
      if (sibling === sidebar || sibling === backdrop) continue;
      backgroundInertRecords.push({ element: sibling, inert: !!sibling.inert });
      sibling.inert = true;
    }
  }

  function focusableInSidebar() {
    if (!sidebar) return [];
    return Array.prototype.slice.call(sidebar.querySelectorAll(FOCUSABLE)).filter(function (element) {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true' || element.getClientRects().length === 0) return false;
      var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
      return !style || (style.display !== 'none' && style.visibility !== 'hidden');
    });
  }

  function setNavigationOpen(nextOpen, options) {
    if (!shellAvailable()) {
      navigationOpen = false;
      return false;
    }
    var settings = options || {};
    if (isDesktop()) {
      navigationOpen = false;
      document.body.classList.remove('tm-nav-open');
      openButton.setAttribute('aria-expanded', 'false');
      sidebar.setAttribute('aria-hidden', 'false');
      sidebar.inert = false;
      setBackgroundInert(false);
      backdrop.hidden = true;
      return false;
    }

    navigationOpen = !!nextOpen;
    document.body.classList.toggle('tm-nav-open', navigationOpen);
    openButton.setAttribute('aria-expanded', navigationOpen ? 'true' : 'false');
    sidebar.setAttribute('aria-hidden', navigationOpen ? 'false' : 'true');
    sidebar.inert = !navigationOpen;
    backdrop.hidden = !navigationOpen;
    setBackgroundInert(navigationOpen);
    if (navigationOpen) {
      closeButton.focus();
    } else if (settings.restoreFocus !== false) {
      openButton.focus();
    }
    return navigationOpen;
  }

  function isNavigationOpen() {
    return navigationOpen;
  }

  function updateMobileTitle() {
    if (!mobileTitle || !sidebar) return;
    var active = sidebar.querySelector('.nav-item.active,[aria-current="page"]');
    if (!active) return;
    mobileTitle.textContent = active.getAttribute('data-label') || String(active.textContent || '').trim();
  }

  function handleKeydown(event) {
    if (!navigationOpen || isDesktop()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setNavigationOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    var focusable = focusableInSidebar();
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBreakpoint() {
    if (!shellAvailable()) return;
    if (isDesktop()) setNavigationOpen(false, { restoreFocus: false });
    else if (!navigationOpen) {
      sidebar.setAttribute('aria-hidden', 'true');
      sidebar.inert = true;
      backdrop.hidden = true;
    }
  }

  function handleNavigationApplied() {
    updateMobileTitle();
    if (!isDesktop()) setNavigationOpen(false, { restoreFocus: false });
  }

  function init() {
    openButton = document.getElementById('tmNavOpen');
    closeButton = document.getElementById('tmNavClose');
    sidebar = document.getElementById('tmSidebar');
    backdrop = document.getElementById('tmNavBackdrop');
    mobileTitle = document.getElementById('tmMobilePageTitle');
    if (!shellAvailable()) {
      navigationOpen = false;
      return;
    }
    if (initialized) {
      handleBreakpoint();
      updateMobileTitle();
      return;
    }

    initialized = true;
    desktopMedia = window.matchMedia ? window.matchMedia('(min-width: 901px)') : null;
    openButton.addEventListener('click', function () { setNavigationOpen(true); });
    closeButton.addEventListener('click', function () { setNavigationOpen(false); });
    backdrop.addEventListener('click', function () { setNavigationOpen(false); });
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('tm:navigation-applied', handleNavigationApplied);
    window.addEventListener('resize', handleBreakpoint);
    if (desktopMedia && typeof desktopMedia.addEventListener === 'function') {
      desktopMedia.addEventListener('change', handleBreakpoint);
    }
    handleBreakpoint();
    updateMobileTitle();
  }

  window.TMShell = Object.freeze({
    init: init,
    setNavigationOpen: setNavigationOpen,
    isNavigationOpen: isNavigationOpen
  });

  init();
})();
