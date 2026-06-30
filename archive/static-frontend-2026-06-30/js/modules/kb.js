(function (window, document) {
  'use strict';

  const STORAGE_KEY = 'tm_knowledge_base';

  const seedEntries = [
    {
      id: 'kb_seed_1',
      category: 'strategy',
      title: '北美美妆新品红人投放框架',
      content: '北美美妆新品适合先用 TikTok 短视频做痛点场景和真实测评，再用 Instagram Reels 复用素材，并保留 YouTube 深度测评作为信任资产。',
      tags: ['北美', '美妆', 'TikTok', 'Instagram'],
      source: '系统预置',
      createdAt: '2026-06-26'
    },
    {
      id: 'kb_seed_2',
      category: 'strategy',
      title: '3C产品达人brief重点',
      content: '3C 产品达人 brief 应包含核心参数、对比对象、真实使用场景、禁用表达、购买路径和素材授权范围，避免只给卖点列表导致内容同质化。',
      tags: ['3C', 'YouTube', '开箱', '测评'],
      source: '系统预置',
      createdAt: '2026-06-26'
    },
    {
      id: 'kb_seed_3',
      category: 'proposal',
      title: '方案确认流程规范',
      content: 'PPT 或 HTML 生成前需要经过 AI 草稿、人工修改、确认方案三步，确认后的内容再进入导出和知识库归档。',
      tags: ['proposal', 'PPT', '流程'],
      source: '系统预置',
      createdAt: '2026-06-26'
    }
  ];

  const state = {
    entries: [],
    category: 'all',
    selectedId: ''
  };

  function load() {
    state.entries = Utils.getStorage(STORAGE_KEY, []);
  }

  function save() {
    Utils.setStorage(STORAGE_KEY, state.entries);
  }

  function categories() {
    const counts = state.entries.reduce((acc, item) => {
      acc[item.category || 'other'] = (acc[item.category || 'other'] || 0) + 1;
      return acc;
    }, {});
    return [
      ['all', '全部', state.entries.length],
      ['customer', '客户', counts.customer || 0],
      ['strategy', '策略', counts.strategy || 0],
      ['proposal', '方案', counts.proposal || 0],
      ['other', '其他', counts.other || 0]
    ];
  }

  function filteredEntries() {
    if (state.category === 'all') return state.entries;
    return state.entries.filter((item) => (item.category || 'other') === state.category);
  }

  function render() {
    const rows = filteredEntries();
    const selected = state.entries.find((item) => item.id === state.selectedId) || rows[0];
    if (selected) state.selectedId = selected.id;
    DOM.setHtml('kbContent', `
      <div class="kb-layout">
        <div class="kb-sidebar">
          <h3>知识分类</h3>
          ${categories().map(([key, label, count]) => `
            <div class="kb-category-item ${state.category === key ? 'active' : ''}" onclick="KB.setCategory('${key}')">${label} (${count})</div>
          `).join('')}
        </div>
        <div class="kb-main">
          <h3>知识条目</h3>
          <div style="display:grid;grid-template-columns:minmax(240px,360px) 1fr;gap:18px">
            <div>
              ${rows.length ? rows.map((item) => `
                <div class="kb-entry" onclick="KB.selectEntry('${item.id}')">
                  <div class="title">${Utils.escapeHtml(item.title)}</div>
                  <div class="meta"><span>${Utils.escapeHtml(item.category || 'other')}</span><span>${Utils.formatDate(item.createdAt)}</span></div>
                  <div class="preview">${Utils.escapeHtml(Utils.compactText(item.content, 80))}</div>
                </div>
              `).join('') : '<div class="kb-empty">暂无知识条目</div>'}
            </div>
            <div>
              ${selected ? `
                <div class="kb-detail-meta">
                  <span>${Utils.escapeHtml(selected.category || 'other')}</span>
                  <span>${Utils.escapeHtml(selected.source || '-')}</span>
                  <span>${Utils.formatDate(selected.createdAt)}</span>
                </div>
                <h3>${Utils.escapeHtml(selected.title)}</h3>
                <div style="margin-bottom:10px">${(selected.tags || []).map((tag) => `<span class="kb-tag">${Utils.escapeHtml(tag)}</span>`).join('')}</div>
                <div class="kb-detail-content">${Utils.nl2br(selected.content || '')}</div>
              ` : '<div class="kb-empty">请选择知识条目</div>'}
            </div>
          </div>
        </div>
      </div>
    `);
  }

  const KB = {
    ensureSeed() {
      load();
      if (!state.entries.length) {
        state.entries = seedEntries.slice();
        save();
      }
    },

    switchToKB() {
      KB.ensureSeed();
      load();
      DOM.showModule('kbContainer', 'kb');
      render();
    },

    setCategory(category) {
      state.category = category;
      render();
    },

    selectEntry(id) {
      state.selectedId = id;
      render();
    },

    addEntry(entry) {
      load();
      const title = entry.title || '未命名知识';
      const category = entry.category || 'other';
      const existing = state.entries.find((item) => item.title === title && item.category === category);
      const next = {
        id: existing?.id || Utils.uid('kb'),
        category,
        title,
        content: entry.content || '',
        tags: entry.tags || [],
        source: entry.source || '手动归档',
        createdAt: existing?.createdAt || Utils.today(),
        updatedAt: Utils.today()
      };
      if (existing) Object.assign(existing, next);
      else state.entries.unshift(next);
      save();
      return next;
    },

    searchKnowledge(query) {
      load();
      const q = String(query || '').toLowerCase();
      return state.entries.filter((item) => `${item.title} ${item.content} ${(item.tags || []).join(' ')}`.toLowerCase().includes(q));
    }
  };

  window.KB = KB;
})(window, document);
