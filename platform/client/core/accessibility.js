(function () {
  'use strict';

  var initialized = false;
  var generatedId = 0;
  var observer = null;
  var activeDialog = null;
  var dialogOpener = null;
  var dialogWasHidden = false;
  var dialogDismiss = null;
  var inertRecords = [];
  var dialogStack = [];
  var FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function ensureId(element, prefix) {
    if (element.id) return element.id;
    generatedId += 1;
    element.id = (prefix || 'tm-control') + '-' + generatedId;
    return element.id;
  }

  function associateLabels() {
    var labels = document.querySelectorAll('label');
    for (var index = 0; index < labels.length; index += 1) {
      var label = labels[index];
      if (label.htmlFor || label.getAttribute('for')) continue;
      var control = label.querySelector('input,select,textarea');
      if (!control && label.nextElementSibling && label.nextElementSibling.matches) {
        if (label.nextElementSibling.matches('input,select,textarea')) control = label.nextElementSibling;
      }
      if (!control && label.parentElement) {
        control = label.parentElement.querySelector('input,select,textarea');
      }
      if (!control) continue;
      label.htmlFor = ensureId(control, 'tm-field');
    }
  }

  function nameCustomerStageControls() {
    var controls = document.querySelectorAll('#custTableBody select[onchange*="changeCustomerStage"]');
    for (var index = 0; index < controls.length; index += 1) {
      if (controls[index].getAttribute('aria-label') || controls[index].getAttribute('aria-labelledby')) continue;
      var row = controls[index].closest ? controls[index].closest('tr') : null;
      var brand = row && row.cells && row.cells.length ? String(row.cells[0].textContent || '').trim() : '';
      controls[index].setAttribute('aria-label', '更新客户阶段' + (brand ? '：' + brand : ''));
    }
  }

  function hideDecorativeIcons() {
    var icons = document.querySelectorAll('.nav-icon');
    for (var index = 0; index < icons.length; index += 1) {
      icons[index].setAttribute('aria-hidden', 'true');
    }
  }

  function tabElements(tabList) {
    return Array.prototype.slice.call(tabList.querySelectorAll('.tab[data-tab],.crm-tab[data-tab]'));
  }

  function panelForTab(tab) {
    var explicitPanelId = tab.getAttribute('data-panel');
    if (explicitPanelId) return document.getElementById(explicitPanelId);
    var panelId = tab.getAttribute('data-tab');
    if (!panelId) return null;
    return document.getElementById(panelId) || document.getElementById(panelId + '-content');
  }

  function prepareCrmTabs(tabList) {
    var tabs = tabList.querySelectorAll('.crm-tab');
    var contracts = [
      { tab: 'pipeline', panel: 'crmPipelineView' },
      { tab: 'seapool', panel: 'crmSeaPoolView' },
      { tab: 'opportunities', panel: 'crmOpportunityView' }
    ];
    for (var index = 0; index < tabs.length && index < contracts.length; index += 1) {
      tabs[index].setAttribute('data-tab', contracts[index].tab);
      tabs[index].setAttribute('data-panel', contracts[index].panel);
    }
  }

  function updateTabState(tabList, focusTab) {
    var tabs = tabElements(tabList);
    if (!tabs.length) return;
    var active = null;
    for (var index = 0; index < tabs.length; index += 1) {
      if (tabs[index].classList.contains('active')) {
        active = tabs[index];
        break;
      }
    }
    if (!active) active = tabs[0];
    var focusOwner = focusTab && tabs.indexOf(focusTab) !== -1 ? focusTab : active;

    for (var tabIndex = 0; tabIndex < tabs.length; tabIndex += 1) {
      var tab = tabs[tabIndex];
      var panel = panelForTab(tab);
      var selected = tab === active;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('tabindex', tab === focusOwner ? '0' : '-1');
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (panel) {
        tab.setAttribute('aria-controls', ensureId(panel, 'tm-panel'));
        ensureId(tab, 'tm-tab');
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        panel.hidden = !selected;
      }
    }
  }

  function bindTabList(tabList) {
    tabList.setAttribute('role', 'tablist');
    updateTabState(tabList);
    var tabs = tabElements(tabList);
    for (var index = 0; index < tabs.length; index += 1) {
      var tab = tabs[index];
      if (tab.__tmAccessibilityTabBound) continue;
      tab.__tmAccessibilityTabBound = true;
      tab.addEventListener('click', function () {
        var owner = this.parentElement;
        window.setTimeout(function () { updateTabState(owner); }, 0);
      });
      tab.addEventListener('keydown', function (event) {
        var owner = this.parentElement;
        var ownerTabs = tabElements(owner);
        var current = ownerTabs.indexOf(this);
        var next = current;
        var vertical = owner.getAttribute('aria-orientation') === 'vertical';
        if (event.key === 'ArrowRight' || (vertical && event.key === 'ArrowDown')) next = (current + 1) % ownerTabs.length;
        if (event.key === 'ArrowLeft' || (vertical && event.key === 'ArrowUp')) next = (current - 1 + ownerTabs.length) % ownerTabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = ownerTabs.length - 1;
        if (next !== current) {
          event.preventDefault();
          updateTabState(owner, ownerTabs[next]);
          ownerTabs[next].focus();
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.click();
          updateTabState(owner, this);
          this.focus();
        }
      });
    }
  }

  function enhanceTabs() {
    var tabLists = document.querySelectorAll('.tabs,.tm-crm-tabs');
    for (var index = 0; index < tabLists.length; index += 1) {
      if (tabLists[index].classList.contains('tm-crm-tabs')) prepareCrmTabs(tabLists[index]);
      bindTabList(tabLists[index]);
    }
  }

  function enhanceUploads() {
    var surfaces = document.querySelectorAll('.file-upload');
    for (var index = 0; index < surfaces.length; index += 1) {
      var surface = surfaces[index];
      var inputId = surface.getAttribute('data-file-input');
      var input = surface.querySelector('input[type="file"]') || (inputId ? document.getElementById(inputId) : null);
      if (!input && surface.nextElementSibling && surface.nextElementSibling.matches('input[type="file"]')) {
        input = surface.nextElementSibling;
      }
      if (!input) continue;
      surface.setAttribute('role', 'button');
      if (!surface.hasAttribute('tabindex')) surface.setAttribute('tabindex', '0');
      if (!surface.getAttribute('aria-label') && !surface.getAttribute('aria-labelledby')) {
        if (input.labels && input.labels.length) {
          surface.setAttribute('aria-labelledby', ensureId(input.labels[0], 'tm-upload-label'));
        } else {
          var text = surface.querySelector('.upload-text');
          surface.setAttribute('aria-label', text ? String(text.textContent || '').trim() : '选择文件');
        }
      }
      if (surface.__tmAccessibilityUploadBound) continue;
      surface.__tmAccessibilityUploadBound = true;
      surface.addEventListener('keydown', function (event) {
        if (event.target !== this) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        var targetId = this.getAttribute('data-file-input');
        var fileInput = this.querySelector('input[type="file"]') || (targetId ? document.getElementById(targetId) : null);
        if (!fileInput && this.nextElementSibling && this.nextElementSibling.matches('input[type="file"]')) {
          fileInput = this.nextElementSibling;
        }
        if (fileInput) fileInput.click();
      });
    }
  }

  function initializeLiveRegions() {
    var container = document.getElementById('toastContainer');
    if (container) {
      container.removeAttribute('role');
      container.removeAttribute('aria-live');
      container.removeAttribute('aria-atomic');
    }
    var loading = document.querySelectorAll('.tm-state-loading');
    for (var index = 0; index < loading.length; index += 1) {
      loading[index].setAttribute('role', 'status');
      loading[index].setAttribute('aria-live', 'polite');
    }
  }

  function focusableElements(container) {
    return Array.prototype.slice.call(container.querySelectorAll(FOCUSABLE)).filter(function (element) {
      return !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0;
    });
  }

  function setBackgroundInert(dialog) {
    inertRecords = [];
    var branch = dialog;
    while (branch && branch !== document.body) {
      var parent = branch.parentElement;
      if (!parent) break;
      var siblings = parent.children;
      for (var index = 0; index < siblings.length; index += 1) {
        var sibling = siblings[index];
        if (sibling === branch) continue;
        inertRecords.push({ element: sibling, inert: !!sibling.inert });
        sibling.inert = true;
      }
      branch = parent;
    }
  }

  function restoreBackground() {
    for (var index = 0; index < inertRecords.length; index += 1) {
      inertRecords[index].element.inert = inertRecords[index].inert;
    }
    inertRecords = [];
  }

  function dialogHost(dialog) {
    if (!dialog || !dialog.closest) return dialog;
    return dialog.closest('.modal-overlay,.wf-modal,.detail-sidebar,.detail-panel') || dialog;
  }

  function isStyleDrivenDialogHost(host) {
    return !!(host && host.matches && host.matches('.modal-overlay,.wf-modal'));
  }

  function revealDialogSurface(dialog) {
    var host = dialogHost(dialog);
    if (!host) return;
    if (isStyleDrivenDialogHost(host) && host.style.display === 'none') {
      host.style.removeProperty('display');
    }
    host.hidden = false;
    host.inert = false;
    host.removeAttribute('aria-hidden');
  }

  function hideDialogSurface(dialog) {
    var host = dialogHost(dialog);
    if (!host) return;
    host.classList.remove('open');
    if (isStyleDrivenDialogHost(host)) {
      host.style.display = 'none';
      host.hidden = false;
      host.inert = false;
      host.removeAttribute('aria-hidden');
      return;
    }
    host.hidden = true;
    host.inert = true;
    host.setAttribute('aria-hidden', 'true');
  }

  function openDialog(dialog, opener, dismiss) {
    if (!dialog) return false;
    if (activeDialog === dialog) {
      if (typeof dismiss === 'function') dialogDismiss = dismiss;
      return true;
    }
    if (activeDialog) {
      dialogStack.push({
        dialog: activeDialog,
        opener: dialogOpener,
        wasHidden: dialogWasHidden,
        dismiss: dialogDismiss
      });
      restoreBackground();
    }
    activeDialog = dialog;
    dialogOpener = opener || document.activeElement;
    dialogWasHidden = dialog.hasAttribute('hidden');
    dialogDismiss = typeof dismiss === 'function' ? dismiss : null;
    revealDialogSurface(dialog);
    dialog.hidden = false;
    dialog.inert = false;
    dialog.removeAttribute('aria-hidden');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (!dialog.__tmAccessibilityKeydownBound) {
      dialog.__tmAccessibilityKeydownBound = true;
      dialog.addEventListener('keydown', function (event) {
        if (activeDialog === this) trapDialogKeydown(event);
      });
    }
    associateLabels();
    setBackgroundInert(dialog);
    var focusable = focusableElements(dialog);
    if (focusable.length) focusable[0].focus();
    else {
      dialog.setAttribute('tabindex', '-1');
      dialog.focus();
    }
    return true;
  }

  function closeDialog(dialog) {
    var target = dialog || activeDialog;
    if (!target || target !== activeDialog) return false;
    if (dialogWasHidden) target.hidden = true;
    restoreBackground();
    var opener = dialogOpener;
    var previous = dialogStack.pop() || null;
    if (previous && isVisible(previous.dialog)) {
      activeDialog = previous.dialog;
      dialogOpener = previous.opener;
      dialogWasHidden = previous.wasHidden;
      dialogDismiss = previous.dismiss || null;
      setBackgroundInert(activeDialog);
    } else {
      activeDialog = null;
      dialogOpener = null;
      dialogWasHidden = false;
      dialogDismiss = null;
      dialogStack = [];
    }
    if (opener && typeof opener.focus === 'function' && isVisible(opener)) opener.focus();
    else if (activeDialog) {
      var focusable = focusableElements(activeDialog);
      if (focusable.length) focusable[0].focus();
      else activeDialog.focus();
    }
    return true;
  }

  function dismissAllDialogs() {
    var records = [];
    if (activeDialog) records.push({ dialog: activeDialog, dismiss: dialogDismiss });
    for (var index = dialogStack.length - 1; index >= 0; index -= 1) {
      var stacked = dialogStack[index];
      var alreadyRecorded = records.some(function (record) { return record.dialog === stacked.dialog; });
      if (!alreadyRecorded) records.push({ dialog: stacked.dialog, dismiss: stacked.dismiss });
    }
    restoreBackground();
    activeDialog = null;
    dialogOpener = null;
    dialogWasHidden = false;
    dialogDismiss = null;
    dialogStack = [];
    for (var recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      var record = records[recordIndex];
      if (typeof record.dismiss === 'function') record.dismiss();
      hideDialogSurface(record.dialog);
    }
    return records.length;
  }

  function requestDialogClose() {
    if (!activeDialog) return;
    var dialog = activeDialog;
    var closeControl = dialog.querySelector('.modal-close,.wf-modal-close,[data-dialog-close]');
    if (closeControl && typeof closeControl.click === 'function') {
      closeControl.click();
    } else if (!dialogWasHidden) {
      var host = dialog.closest('.modal-overlay,.wf-modal,.detail-sidebar,.detail-panel');
      if (host && host !== dialog) host.style.display = 'none';
    }
    closeDialog(dialog);
  }

  function trapDialogKeydown(event) {
    if (!activeDialog) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      requestDialogClose();
      return;
    }
    if (event.key !== 'Tab') return;
    var focusable = focusableElements(activeDialog);
    if (!focusable.length) {
      event.preventDefault();
      activeDialog.focus();
      return;
    }
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

  function isVisible(element) {
    if (!element || element.hidden) return false;
    var drawer = element.closest ? element.closest('.detail-sidebar,.detail-panel') : null;
    if (drawer && !drawer.classList.contains('open')) return false;
    var current = element;
    while (current && current.nodeType === 1) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      var style = window.getComputedStyle ? window.getComputedStyle(current) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      current = current.parentElement;
    }
    return element.getClientRects().length > 0;
  }

  function syncVisibleDialog() {
    if (activeDialog && !isVisible(activeDialog)) closeDialog(activeDialog);
    var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    var candidate = null;
    for (var index = 0; index < dialogs.length; index += 1) {
      if (isVisible(dialogs[index])) candidate = dialogs[index];
    }
    if (!candidate || candidate === activeDialog) return;
    var alreadyStacked = dialogStack.some(function (record) { return record.dialog === candidate; });
    if (!alreadyStacked) openDialog(candidate, document.activeElement);
  }

  function updateDocumentTitle() {
    var heading = document.querySelector('.page.active h1,.page.active h2');
    if (!heading) return;
    var title = String(heading.textContent || '').trim();
    if (title) document.title = title + ' · TuringMarket';
  }

  function refresh() {
    associateLabels();
    nameCustomerStageControls();
    hideDecorativeIcons();
    enhanceTabs();
    enhanceUploads();
    initializeLiveRegions();
    updateDocumentTitle();
    window.setTimeout(syncVisibleDialog, 0);
  }

  function init() {
    refresh();
    if (initialized) return;
    initialized = true;
    document.addEventListener('tm:navigation-applied', function () {
      window.setTimeout(refresh, 0);
    });
    if (window.MutationObserver && document.body) {
      observer = new MutationObserver(function () {
        associateLabels();
        nameCustomerStageControls();
        window.setTimeout(syncVisibleDialog, 0);
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
      });
    }
  }

  window.TMAccessibility = Object.freeze({
    init: init,
    refresh: refresh,
    openDialog: openDialog,
    closeDialog: closeDialog,
    dismissAllDialogs: dismissAllDialogs
  });

  init();
})();
