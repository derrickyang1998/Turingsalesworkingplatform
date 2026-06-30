(function (window, document) {
  'use strict';

  const containers = [
    'app',
    'm1Container',
    'm2Container',
    'm3Container',
    'm4Container',
    'm5Container',
    'adminContainer',
    'kbContainer'
  ];

  const DOM = {
    showContainer(id) {
      containers.forEach((containerId) => {
        const el = document.getElementById(containerId);
        if (el) el.classList.toggle('hidden', containerId !== id);
      });
    },

    setActiveTab(tab) {
      Utils.qsa('#tabBar .tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      });
    },

    showModule(containerId, tab) {
      DOM.showContainer(containerId);
      DOM.setActiveTab(tab);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    setHtml(id, html) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    },

    value(id) {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    }
  };

  window.DOM = DOM;
})(window, document);
