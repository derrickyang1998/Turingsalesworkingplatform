(function initializePPTPreviewRuntime(global) {
  'use strict';

  var documentRef = global.document;
  if (!documentRef) return;

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function isNativeControl(target) {
    var tagName = String(target && target.tagName || '').toUpperCase();
    return ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SUMMARY'].indexOf(tagName) >= 0;
  }

  function isHandledSpace(event) {
    return event.key === ' ' && !isNativeControl(event.target);
  }

  function initializeStageDeck() {
    var stage = documentRef.getElementById('deckStage');
    var slides = Array.prototype.slice.call(documentRef.querySelectorAll('.slide'));
    if (!stage || !slides.length) return false;

    var counter = documentRef.getElementById('deckCounter');
    var progress = documentRef.getElementById('deckProgress');
    var controls = documentRef.querySelectorAll('.deck-controls button');
    var index = 0;

    function fit() {
      var scale = Math.min(global.innerWidth / 1920, global.innerHeight / 1080);
      var x = (global.innerWidth - 1920 * scale) / 2;
      var y = (global.innerHeight - 1080 * scale) / 2;
      stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
    }

    function show(nextIndex) {
      index = clamp(nextIndex, 0, slides.length - 1);
      slides.forEach(function(slide, slideIndex) {
        slide.classList.toggle('active', slideIndex === index);
      });
      if (counter) counter.textContent = (index + 1) + ' / ' + slides.length;
      if (progress) progress.style.width = ((index + 1) / slides.length * 100) + '%';
    }

    var deck = Object.freeze({
      next: function() { show(index + 1); },
      prev: function() { show(index - 1); },
      show: show,
      fit: fit
    });
    global.deck = deck;

    if (controls[0]) controls[0].addEventListener('click', deck.prev);
    if (controls[1]) controls[1].addEventListener('click', deck.next);
    global.addEventListener('resize', fit);
    global.addEventListener('keydown', function(event) {
      if (['ArrowRight', 'PageDown'].indexOf(event.key) >= 0 || isHandledSpace(event)) deck.next();
      if (['ArrowLeft', 'PageUp'].indexOf(event.key) >= 0) deck.prev();
    });
    fit();
    show(0);
    return true;
  }

  function initializeReportDeck() {
    var sections = Array.prototype.slice.call(documentRef.querySelectorAll('section[id]'));
    if (!sections.length) return false;

    var navLinks = Array.prototype.slice.call(documentRef.querySelectorAll('.nav-links a'));
    var counter = documentRef.getElementById('tmDeckCounter');
    var progress = documentRef.getElementById('tmDeckProgress');
    var controls = documentRef.querySelectorAll('.page-controls button');
    var fadeElements = Array.prototype.slice.call(documentRef.querySelectorAll('.fade-in'));
    var barElements = Array.prototype.slice.call(documentRef.querySelectorAll('.platform-bar-fill[data-width], .wb-fill[data-width]'));
    var activeIndex = 0;

    function updateDeckState(nextIndex) {
      activeIndex = clamp(nextIndex, 0, sections.length - 1);
      var activeId = sections[activeIndex] && sections[activeIndex].id;
      navLinks.forEach(function(link) {
        link.classList.toggle('active', String(link.getAttribute('href') || '').replace('#', '') === activeId);
      });
      if (counter) counter.textContent = (activeIndex + 1) + ' / ' + sections.length;
      if (progress) progress.style.width = ((activeIndex + 1) / sections.length * 100) + '%';
    }

    function scrollToSection(nextIndex) {
      var boundedIndex = clamp(nextIndex, 0, sections.length - 1);
      var target = sections[boundedIndex];
      updateDeckState(boundedIndex);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function indexForFragment(fragment) {
      var value = String(fragment || '');
      if (value.charAt(0) !== '#') return -1;
      var id = value.slice(1);
      for (var index = 0; index < sections.length; index += 1) {
        if (sections[index].id === id) return index;
      }
      return -1;
    }

    function syncDeckStateFromFragment(fragment) {
      var fragmentIndex = indexForFragment(fragment);
      if (fragmentIndex < 0) return false;
      updateDeckState(fragmentIndex);
      return true;
    }

    global.tmDeckNext = function() { scrollToSection(activeIndex + 1); };
    global.tmDeckPrev = function() { scrollToSection(activeIndex - 1); };
    if (controls[0]) controls[0].addEventListener('click', global.tmDeckPrev);
    if (controls[1]) controls[1].addEventListener('click', global.tmDeckNext);
    navLinks.forEach(function(link) {
      var linkIndex = indexForFragment(link.getAttribute('href'));
      if (linkIndex < 0) return;
      link.addEventListener('click', function() { updateDeckState(linkIndex); });
    });
    global.addEventListener('hashchange', function() {
      syncDeckStateFromFragment(global.location && global.location.hash);
    });

    if (typeof global.IntersectionObserver === 'function') {
      var fadeObserver = new global.IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) entry.target.classList.add('visible');
        });
      }, { threshold: 0.12 });
      fadeElements.forEach(function(element) {
        fadeObserver.observe(element);
      });

      barElements.forEach(function(element) {
        var barObserver = new global.IntersectionObserver(function(entries) {
          entries.forEach(function(entry) {
            if (entry.isIntersecting) entry.target.style.width = entry.target.dataset.width + '%';
          });
        }, { threshold: 0.3 });
        barObserver.observe(element);
      });

      var navObserver = new global.IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) updateDeckState(sections.indexOf(entry.target));
        });
      }, { threshold: 0.58 });
      sections.forEach(function(section) { navObserver.observe(section); });
    } else {
      fadeElements.forEach(function(element) { element.classList.add('visible'); });
      barElements.forEach(function(element) { element.style.width = element.dataset.width + '%'; });
    }

    global.addEventListener('keydown', function(event) {
      if (['ArrowDown', 'PageDown'].indexOf(event.key) >= 0 || isHandledSpace(event)) {
        event.preventDefault();
        global.tmDeckNext();
      }
      if (['ArrowUp', 'PageUp'].indexOf(event.key) >= 0) {
        event.preventDefault();
        global.tmDeckPrev();
      }
      if (event.key === 'Home') {
        event.preventDefault();
        scrollToSection(0);
      }
      if (event.key === 'End') {
        event.preventDefault();
        scrollToSection(sections.length - 1);
      }
    });

    var orb = documentRef.getElementById('cursorOrb');
    if (orb) {
      global.addEventListener('pointermove', function(event) {
        orb.style.left = event.clientX + 'px';
        orb.style.top = event.clientY + 'px';
      });
    }
    if (!syncDeckStateFromFragment(global.location && global.location.hash)) updateDeckState(0);
    return true;
  }

  function initialize() {
    if (!initializeStageDeck()) initializeReportDeck();
  }

  if (documentRef.readyState === 'loading') documentRef.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})(typeof window !== 'undefined' ? window : globalThis);
