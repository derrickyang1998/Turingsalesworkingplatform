(function initializeTMCSPCompat(global) {
  'use strict';

  var documentRef = global.document;
  var ROOT_SELECTOR = '#proposalOutput, #tmPPTEditorOverlay';
  var PREVIEW_RUNTIME_PATH = '/client/features/ppt_preview_runtime.js';
  var NO_ARGUMENT_HANDLERS = Object.freeze({
    'downloadHTMLPPT()': 'downloadHTMLPPT',
    'downloadPPTX()': 'downloadPPTX',
    'previewPPT()': 'previewPPT',
    'copyPPTSource()': 'copyPPTSource',
    'openPPTEditor()': 'openPPTEditor',
    'previewEditedPPT()': 'previewEditedPPT',
    'savePPTEditorAndRender()': 'savePPTEditorAndRender',
    'closePPTEditor()': 'closePPTEditor',
    'addPPTEditorSlide()': 'addPPTEditorSlide',
    'duplicatePPTEditorSlide()': 'duplicatePPTEditorSlide',
    'deletePPTEditorSlide()': 'deletePPTEditorSlide',
    'event.stopPropagation()': 'stopPropagation'
  });
  var HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
  var PREVIEW_ELEMENTS = Object.freeze({
    html: true,
    head: true,
    meta: true,
    title: true,
    style: true,
    body: true,
    main: true,
    div: true,
    section: true,
    article: true,
    span: true,
    p: true,
    h1: true,
    h2: true,
    h3: true,
    strong: true,
    br: true,
    button: true,
    table: true,
    thead: true,
    tbody: true,
    tr: true,
    th: true,
    td: true,
    nav: true,
    a: true,
    i: true,
    img: true
  });
  var GLOBAL_PREVIEW_ATTRIBUTES = Object.freeze({
    id: true,
    class: true,
    style: true,
    lang: true,
    'data-theme': true,
    'data-width': true
  });
  var ELEMENT_PREVIEW_ATTRIBUTES = Object.freeze({
    a: Object.freeze({ href: true }),
    button: Object.freeze({ type: true }),
    img: Object.freeze({ src: true, alt: true, width: true, height: true })
  });
  var trustedPPTActions = new WeakMap();

  function parseFrozenHandler(source) {
    var handler = String(source || '').trim();
    if (Object.prototype.hasOwnProperty.call(NO_ARGUMENT_HANDLERS, handler)) {
      return { action: NO_ARGUMENT_HANDLERS[handler], args: [] };
    }

    var move = handler.match(/^movePPTEditorSlide\((-1|1)\)$/);
    if (move) return { action: 'movePPTEditorSlide', args: [Number(move[1])] };

    var select = handler.match(/^selectPPTEditorSlide\((0|[1-9][0-9]*)\)$/);
    if (select) {
      var index = Number(select[1]);
      if (Number.isSafeInteger(index)) return { action: 'selectPPTEditorSlide', args: [index] };
    }
    return null;
  }

  function validateDelegatedCall(action, args) {
    if (typeof action !== 'string' || !Array.isArray(args)) return null;
    if (action === 'stopPropagation') {
      return args.length === 0 ? { action: action, args: [] } : null;
    }
    if (action === 'movePPTEditorSlide') {
      if (args.length !== 1 || typeof args[0] !== 'number' || (args[0] !== -1 && args[0] !== 1)) return null;
      return parseFrozenHandler(action + '(' + args[0] + ')');
    }
    if (action === 'selectPPTEditorSlide') {
      if (args.length !== 1 || typeof args[0] !== 'number' || !Number.isSafeInteger(args[0]) || args[0] < 0) return null;
      return parseFrozenHandler(action + '(' + String(args[0]) + ')');
    }
    if (args.length !== 0) return null;
    var allowedCall = parseFrozenHandler(action + '()');
    return allowedCall && allowedCall.action === action ? allowedCall : null;
  }

  function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f-\u009f]/.test(String(value || ''));
  }

  function hasClass(element, className) {
    return String(element && element.getAttribute && element.getAttribute('class') || '')
      .split(/\s+/)
      .indexOf(className) >= 0;
  }

  function isSafeFragmentURL(value, previewIds) {
    var url = String(value || '');
    if (hasControlCharacters(url) || url.charAt(0) !== '#' || !isApprovedPreviewId(url.slice(1))) return false;
    if (!previewIds) return true;
    var id = url.slice(1);
    return Object.prototype.hasOwnProperty.call(previewIds, id)
      && isNavigablePreviewTarget(id, previewIds[id]);
  }

  function isSafeImageURL(value) {
    var url = String(value || '');
    if (!url || hasControlCharacters(url) || /[\\\s]/.test(url)) return false;
    if (/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:[/?#][^\s]*)?$/i.test(url)) return true;
    return /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url);
  }

  function isSafePercentage(value) {
    var match = String(value || '').match(/^(?:0|[1-9][0-9]?|100)(?:\.[0-9]+)?%$/);
    return !!match && Number(match[0].slice(0, -1)) <= 100;
  }

  function isSafeDecimal(value, maximum) {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$|^\.[0-9]+$/.test(String(value || ''))) return false;
    var number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= maximum;
  }

  function isSafeInlineStyleValue(property, value) {
    if (hasControlCharacters(value) || /[\\@]/.test(value)) return false;
    if (property === 'width') return isSafePercentage(value);
    if (property === 'font-size' || property === 'margin-top' || property === 'margin-bottom') {
      var pixels = String(value || '').match(/^((?:0|[1-9][0-9]*)(?:\.[0-9]+)?)px$/);
      return !!pixels && Number(pixels[1]) <= 200;
    }
    if (property === 'color') {
      return /^#[0-9A-Fa-f]{3,8}$/.test(value) || /^var\(--[a-z0-9-]+\)$/.test(value);
    }
    if (property === 'opacity') return isSafeDecimal(value, 1);
    if (property === 'font-weight') return /^(?:[1-9]00|normal|bold)$/.test(value);
    if (property === 'letter-spacing') {
      var spacing = String(value || '').match(/^((?:0|[1-9][0-9]*)(?:\.[0-9]+)?|\.[0-9]+)em$/);
      return !!spacing && Number(spacing[1]) <= 2;
    }
    return false;
  }

  function sanitizeInlineStyle(value) {
    var source = String(value || '').trim();
    if (!source || source.length > 512 || hasControlCharacters(source)) return null;
    var sanitized = [];
    var declarations = source.split(';');
    for (var index = 0; index < declarations.length; index += 1) {
      var declaration = declarations[index].trim();
      if (!declaration) continue;
      var match = declaration.match(/^([a-z-]+)\s*:\s*(.+)$/i);
      if (!match) return null;
      var property = match[1].toLowerCase();
      var propertyValue = match[2].trim();
      if (!isSafeInlineStyleValue(property, propertyValue)) return null;
      sanitized.push(property + ':' + propertyValue);
    }
    return sanitized.length ? sanitized.join(';') : null;
  }

  function isSafeStyleSheet(value) {
    var source = String(value || '');
    if (!source || source.length > 250000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(source) || /\\/.test(source)) return false;
    var withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
    var withoutMedia = withoutComments.replace(/@media\b/gi, '');
    if (/@/.test(withoutMedia)) return false;
    return !/(?:url|src|expression|(?:-webkit-)?image-set|cross-fade|image|element|paint)\s*\(|(?:^|[;{])\s*(?:[*_]\s*)?(?:behavior|-moz-binding|src)\s*:|javascript\s*:|data\s*:|https?\s*:|\/\/|<\/?style\b/i.test(withoutComments);
  }

  function isAllowedAttribute(elementName, attributeName) {
    if (GLOBAL_PREVIEW_ATTRIBUTES[attributeName]) return true;
    return !!(ELEMENT_PREVIEW_ATTRIBUTES[elementName] && ELEMENT_PREVIEW_ATTRIBUTES[elementName][attributeName]);
  }

  function isFrozenReportSectionId(value) {
    return /^s(?:0[1-9]|[1-9][0-9]{1,3})$/.test(value);
  }

  function isApprovedPreviewId(value) {
    return /^(?:deckStage|deckCounter|deckProgress|cursorOrb|cover|materials|closing|tmDeckCounter|tmDeckProgress)$/.test(value)
      || isFrozenReportSectionId(value);
  }

  function expectedPreviewElementName(id) {
    if (id === 'deckStage') return 'main';
    if (id === 'deckCounter' || id === 'tmDeckCounter') return 'span';
    if (id === 'deckProgress' || id === 'tmDeckProgress' || id === 'cursorOrb') return 'div';
    if (/^(?:cover|materials|closing)$/.test(id) || isFrozenReportSectionId(id)) return 'section';
    return null;
  }

  function isExpectedPreviewIdElement(id, element) {
    var expectedName = expectedPreviewElementName(id);
    var elementName = String(element && (element.localName || element.tagName) || '').toLowerCase();
    return !!expectedName && elementName === expectedName;
  }

  function isNavigablePreviewTarget(id, element) {
    return (id === 'deckStage' || /^(?:cover|materials|closing)$/.test(id) || isFrozenReportSectionId(id))
      && isExpectedPreviewIdElement(id, element);
  }

  function isAllowedPreviewMeta(element) {
    var attributes = Array.prototype.slice.call(element.attributes || []);
    var values = Object.create(null);
    for (var index = 0; index < attributes.length; index += 1) {
      var name = String(attributes[index].name || '').toLowerCase();
      if (!name || Object.prototype.hasOwnProperty.call(values, name)) return false;
      values[name] = String(attributes[index].value || '');
    }
    var names = Object.keys(values);
    if (names.length === 1) return names[0] === 'charset' && values.charset === 'UTF-8';
    return names.length === 2
      && Object.prototype.hasOwnProperty.call(values, 'name')
      && Object.prototype.hasOwnProperty.call(values, 'content')
      && values.name === 'viewport'
      && /^width=device-width, ?initial-scale=1\.0$/.test(values.content);
  }

  function sanitizePreviewAttribute(element, elementName, attribute) {
    var attributeName = String(attribute.name || '').toLowerCase();
    var value = String(attribute.value || '');
    if (!isAllowedAttribute(elementName, attributeName) || hasControlCharacters(value)) {
      element.removeAttribute(attribute.name);
      return;
    }
    if (attributeName === 'id' && !isApprovedPreviewId(value)) element.removeAttribute(attribute.name);
    else if (attributeName === 'class' && !/^[A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*$/.test(value)) element.removeAttribute(attribute.name);
    else if (attributeName === 'lang' && value !== 'zh-CN') element.removeAttribute(attribute.name);
    else if (attributeName === 'data-theme' && !/^[a-z0-9-]{1,48}$/.test(value)) element.removeAttribute(attribute.name);
    else if (attributeName === 'data-width' && !isSafeDecimal(value, 100)) element.removeAttribute(attribute.name);
    else if (attributeName === 'type' && (elementName !== 'button' || value !== 'button')) element.removeAttribute(attribute.name);
    else if (attributeName === 'href' && !isSafeFragmentURL(value)) element.removeAttribute(attribute.name);
    else if (attributeName === 'style') {
      var style = sanitizeInlineStyle(value);
      if (style) element.setAttribute(attribute.name, style);
      else element.removeAttribute(attribute.name);
    } else if ((attributeName === 'width' || attributeName === 'height') && !/^[1-9][0-9]{0,3}$/.test(value)) {
      element.removeAttribute(attribute.name);
    } else if (attributeName === 'alt' && value.length > 500) {
      element.removeAttribute(attribute.name);
    }
  }

  function collectPreviewIds(parsed) {
    var previewIds = Object.create(null);
    var elements = Array.prototype.slice.call(parsed.querySelectorAll('*'));
    for (var index = 0; index < elements.length; index += 1) {
      var element = elements[index];
      var id = element.getAttribute && element.getAttribute('id');
      if (!id) continue;
      if (!isApprovedPreviewId(id) || !isExpectedPreviewIdElement(id, element)) return null;
      if (Object.prototype.hasOwnProperty.call(previewIds, id)) return null;
      previewIds[id] = element;
    }
    return previewIds;
  }

  function isFrozenDeckDocument(parsed, previewIds) {
    if (!parsed || !parsed.documentElement || String(parsed.documentElement.localName || '').toLowerCase() !== 'html') return false;
    var stage = previewIds.deckStage || null;
    var stageSlides = typeof parsed.querySelectorAll === 'function' ? parsed.querySelectorAll('.slide') : [];
    var stageProfile = !!stage
      && hasClass(stage, 'deck-stage')
      && stageSlides.length > 0
      && !!previewIds.deckCounter
      && !!previewIds.deckProgress
      && parsed.querySelectorAll('.deck-controls').length > 0;
    if (stageProfile) return true;

    var reportSections = typeof parsed.querySelectorAll === 'function' ? parsed.querySelectorAll('section[id]') : [];
    var reportCover = previewIds.cover;
    var reportClosing = previewIds.closing;
    return reportSections.length >= 2
      && !!reportCover
      && !!reportClosing
      && !!previewIds.tmDeckCounter
      && !!previewIds.tmDeckProgress
      && parsed.querySelectorAll('.page-controls').length > 0
      && parsed.querySelectorAll('.nav-links').length > 0;
  }

  function sanitizePreviewDocument(parsed) {
    if (!parsed || typeof parsed.querySelectorAll !== 'function') return false;
    var elements = Array.prototype.slice.call(parsed.querySelectorAll('*'));
    elements.forEach(function(element) {
      var elementName = String(element.localName || element.tagName || '').toLowerCase();
      if (element.namespaceURI !== HTML_NAMESPACE || !PREVIEW_ELEMENTS[elementName]) {
        element.remove();
        return;
      }
      if (elementName === 'meta') {
        if (!isAllowedPreviewMeta(element)) element.remove();
        return;
      }
      if (elementName === 'style' && !isSafeStyleSheet(element.textContent)) {
        element.remove();
        return;
      }
      Array.prototype.slice.call(element.attributes || []).forEach(function(attribute) {
        sanitizePreviewAttribute(element, elementName, attribute);
      });
      if (elementName === 'img' && !isSafeImageURL(element.getAttribute('src'))) element.remove();
    });
    var previewIds = collectPreviewIds(parsed);
    if (!previewIds) return false;
    Array.prototype.slice.call(parsed.querySelectorAll('*')).forEach(function(element) {
      if (String(element.localName || element.tagName || '').toLowerCase() !== 'a') return;
      var href = element.getAttribute('href');
      if (href !== null && !isSafeFragmentURL(href, previewIds)) element.removeAttribute('href');
    });
    return isFrozenDeckDocument(parsed, previewIds);
  }

  function markRejected(element, attributeName) {
    var prior = element.getAttribute('data-tm-csp-rejected');
    var names = prior ? prior.split(',') : [];
    if (names.indexOf(attributeName) < 0) names.push(attributeName);
    element.setAttribute('data-tm-csp-rejected', names.join(','));
  }

  function trustedArgsSource(call) {
    return call.args.length ? JSON.stringify(call.args) : null;
  }

  function clearTrustedPPTAction(element) {
    trustedPPTActions.delete(element);
    element.removeAttribute('data-tm-ppt-action');
    element.removeAttribute('data-tm-ppt-args');
  }

  function hasTrustedPPTMarker(element, call) {
    return !!call
      && element.getAttribute('data-tm-ppt-action') === call.action
      && element.getAttribute('data-tm-ppt-args') === trustedArgsSource(call);
  }

  function registerTrustedPPTAction(element, parsed) {
    var allowedCall = validateDelegatedCall(parsed.action, parsed.args);
    if (!allowedCall) return false;
    var registeredCall = {
      action: allowedCall.action,
      args: allowedCall.args.slice()
    };
    trustedPPTActions.set(element, registeredCall);
    element.setAttribute('data-tm-ppt-action', registeredCall.action);
    var argsSource = trustedArgsSource(registeredCall);
    if (argsSource === null) element.removeAttribute('data-tm-ppt-args');
    else element.setAttribute('data-tm-ppt-args', argsSource);
    return true;
  }

  function translateElement(element) {
    if (!element || element.nodeType !== 1 || !element.attributes) return;
    var eventAttributes = Array.prototype.slice.call(element.attributes).filter(function(attribute) {
      return /^on/i.test(attribute.name);
    });
    if (!eventAttributes.length) {
      var registeredCall = trustedPPTActions.get(element);
      if (registeredCall && hasTrustedPPTMarker(element, registeredCall)) return;
      if (registeredCall
        || element.getAttribute('data-tm-ppt-action') !== null
        || element.getAttribute('data-tm-ppt-args') !== null) {
        clearTrustedPPTAction(element);
        markRejected(element, 'data-tm-ppt-action');
      }
      return;
    }

    clearTrustedPPTAction(element);
    var translatedCall = null;
    eventAttributes.forEach(function(attribute) {
      var attributeName = attribute.name.toLowerCase();
      var source = attribute.value;
      element.removeAttribute(attribute.name);
      if (attributeName !== 'onclick') {
        markRejected(element, attributeName);
        return;
      }

      var parsed = parseFrozenHandler(source);
      if (!parsed) {
        markRejected(element, attributeName);
        return;
      }
      translatedCall = parsed;
    });
    if (translatedCall) registerTrustedPPTAction(element, translatedCall);
  }

  function isApprovedRoot(root) {
    return !!root && (root.id === 'proposalOutput' || root.id === 'tmPPTEditorOverlay');
  }

  function translateRoot(root) {
    if (!isApprovedRoot(root)) return false;
    translateElement(root);
    Array.prototype.forEach.call(root.querySelectorAll('*'), translateElement);
    return true;
  }

  function closestApprovedRoot(element) {
    if (!element || typeof element.closest !== 'function') return null;
    var root = element.closest(ROOT_SELECTOR);
    return isApprovedRoot(root) ? root : null;
  }

  function translateAddedNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (translateRoot(node)) return;
    var containingRoot = closestApprovedRoot(node);
    if (containingRoot) {
      translateElement(node);
      Array.prototype.forEach.call(node.querySelectorAll('*'), translateElement);
      return;
    }
    Array.prototype.forEach.call(node.querySelectorAll(ROOT_SELECTOR), translateRoot);
  }

  function showPreviewError(message) {
    if (typeof global.toast === 'function') global.toast(message, 'error');
  }

  function renderPreviewDocument(popup, html) {
    if (typeof global.DOMParser !== 'function') {
      showPreviewError('Safe PPT preview is not supported by this browser.');
      popup.close();
      return false;
    }

    var parser = new global.DOMParser();
    var parsed = parser.parseFromString(String(html || ''), 'text/html');
    if (!sanitizePreviewDocument(parsed)) {
      showPreviewError('The PPT preview document did not match the approved deck format.');
      popup.close();
      return false;
    }

    var importedRoot = popup.document.importNode(parsed.documentElement, true);
    try {
      popup.opener = null;
    } catch (_error) {
      popup.close();
      return false;
    }
    if (popup.opener !== null) {
      popup.close();
      return false;
    }
    popup.document.replaceChild(importedRoot, popup.document.documentElement);
    var runtime = popup.document.createElement('script');
    runtime.src = PREVIEW_RUNTIME_PATH;
    runtime.async = false;
    popup.document.body.appendChild(runtime);
    return true;
  }

  function previewPPTCompat() {
    if (!global.lastPPT) {
      showPreviewError('Generate a PPT before opening preview.');
      return;
    }
    var popup = global.open('', '_blank');
    if (!popup) {
      showPreviewError('The browser blocked the preview window. Allow pop-ups and try again.');
      return;
    }
    renderPreviewDocument(popup, global.lastPPT);
  }

  function previewEditedPPTCompat() {
    if (typeof global.applyPPTEditorForm === 'function' && !global.applyPPTEditorForm()) return;
    if (typeof global.rebuildPPTFromEditor === 'function') global.rebuildPPTFromEditor(false);
    previewPPTCompat();
  }

  function dispatchPPTAction(event) {
    var target = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-tm-ppt-action]')
      : null;
    if (!target || !closestApprovedRoot(target)) return;

    var allowedCall = trustedPPTActions.get(target);
    if (!allowedCall || !hasTrustedPPTMarker(target, allowedCall)) {
      clearTrustedPPTAction(target);
      markRejected(target, 'data-tm-ppt-action');
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (allowedCall.action === 'stopPropagation') {
      event.stopPropagation();
      return;
    }
    if (typeof global[allowedCall.action] !== 'function') {
      clearTrustedPPTAction(target);
      markRejected(target, 'data-tm-ppt-action');
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    global[allowedCall.action].apply(global, allowedCall.args);
  }

  function initializeDocumentBindings() {
    Array.prototype.forEach.call(documentRef.querySelectorAll(ROOT_SELECTOR), translateRoot);
    documentRef.addEventListener('click', dispatchPPTAction, true);

    if (typeof global.MutationObserver !== 'function') return;
    var observer = new global.MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        if (mutation.type === 'attributes') {
          if (closestApprovedRoot(mutation.target)) translateElement(mutation.target);
          return;
        }
        Array.prototype.forEach.call(mutation.addedNodes || [], translateAddedNode);
      });
    });
    observer.observe(documentRef.documentElement, {
      subtree: true,
      childList: true,
      attributes: true
    });
  }

  global.previewPPT = previewPPTCompat;
  global.previewEditedPPT = previewEditedPPTCompat;
  global.TMCSPCompat = Object.freeze({
    parseFrozenHandler: parseFrozenHandler,
    sanitizePreviewDocument: sanitizePreviewDocument,
    translateElement: translateElement,
    translateRoot: translateRoot,
    previewRuntimePath: PREVIEW_RUNTIME_PATH
  });

  if (documentRef && typeof documentRef.addEventListener === 'function') initializeDocumentBindings();
})(typeof window !== 'undefined' ? window : globalThis);
