(function (window, document) {
  'use strict';

  function init() {
    if (window.M0 && typeof window.M0.init === 'function') {
      window.M0.init();
    }
    if (window.KB && typeof window.KB.ensureSeed === 'function') {
      window.KB.ensureSeed();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
