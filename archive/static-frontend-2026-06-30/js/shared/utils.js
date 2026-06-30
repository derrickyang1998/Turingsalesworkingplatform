(function (window, document) {
  'use strict';

  const Utils = {
    qs(selector, root) {
      return (root || document).querySelector(selector);
    },

    qsa(selector, root) {
      return Array.from((root || document).querySelectorAll(selector));
    },

    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]);
    },

    nl2br(value) {
      return Utils.escapeHtml(value).replace(/\n/g, '<br>');
    },

    uid(prefix) {
      return `${prefix || 'id'}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    },

    today() {
      return new Date().toISOString().slice(0, 10);
    },

    formatDate(value) {
      if (!value) return '-';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toISOString().slice(0, 10);
    },

    getStorage(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        console.warn(`Failed to read ${key}`, error);
        return fallback;
      }
    },

    setStorage(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        console.warn(`Failed to write ${key}`, error);
        Utils.toast('本地保存失败，请检查浏览器存储权限', 'error');
        return false;
      }
    },

    splitList(value) {
      if (Array.isArray(value)) return value.filter(Boolean);
      return String(value || '')
        .split(/[\n,，;；、]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    },

    compactText(value, maxLength) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (!maxLength || text.length <= maxLength) return text;
      return `${text.slice(0, maxLength - 1)}…`;
    },

    downloadBlob(fileName, content, type) {
      const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 800);
    },

    toast(message, type) {
      const container = Utils.qs('#toastContainer');
      if (!container) {
        console.log(message);
        return;
      }
      const el = document.createElement('div');
      el.className = `toast ${type || 'info'}`;
      el.textContent = message;
      container.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(12px)';
      }, 2600);
      setTimeout(() => el.remove(), 3100);
    }
  };

  window.Utils = Utils;
  window.Toast = Utils.toast;
})(window, document);
