(function (window, document) {
  'use strict';

  const STORAGE_KEY = 'tm_customers';
  const OPP_KEY = 'tm_opportunities';
  const crmTabs = ['my', 'team', 'pool', 'opportunities', 'board'];

  const stageLabels = {
    new_lead: '新线索',
    info_confirmed: '信息确认',
    analysis: '需求分析',
    proposal: '方案报价',
    kol_matching: '网红匹配',
    cooperation: '合作执行',
    won: '赢单',
    lost: '输单'
  };

  const seedCustomers = [
    {
      id: 'cust_seed_1',
      brand: 'Aurora Beauty',
      company: 'Aurora Labs Inc.',
      stage: 'analysis',
      owner: 'Turing BD',
      amount: 180000,
      source: '官网询盘',
      updatedAt: '2026-06-20',
      market: '北美',
      notes: '关注 TikTok Shop 和美妆测评达人。'
    },
    {
      id: 'cust_seed_2',
      brand: 'NovaCharge',
      company: 'NovaCharge Tech',
      stage: 'proposal',
      owner: 'Turing BD',
      amount: 260000,
      source: '展会名片',
      updatedAt: '2026-06-22',
      market: '欧洲',
      notes: '需要达人开箱、测评和亚马逊站外引流。'
    }
  ];

  const state = {
    tab: 'my',
    search: '',
    stage: '',
    customers: [],
    opportunities: []
  };

  function load() {
    state.customers = Utils.getStorage(STORAGE_KEY, seedCustomers);
    state.opportunities = Utils.getStorage(OPP_KEY, [
      {
        id: 'opp_seed_1',
        name: 'Aurora Beauty Q3 Launch',
        customer: 'Aurora Beauty',
        amount: 180000,
        stage: 'analysis',
        probability: '45%',
        owner: 'Turing BD',
        closeDate: '2026-08-20'
      }
    ]);
  }

  function save() {
    Utils.setStorage(STORAGE_KEY, state.customers);
    Utils.setStorage(OPP_KEY, state.opportunities);
  }

  function bindTabs() {
    Utils.qsa('#tabBar .tab-btn').forEach((btn) => {
      const tab = btn.dataset.tab;
      if (crmTabs.includes(tab) && !btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => M0.switchTab(tab));
      }
    });
  }

  function renderStageOptions() {
    const select = Utils.qs('#stageFilter');
    if (!select) return;
    select.innerHTML = '<option value="">全部阶段</option>' + Object.entries(stageLabels)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
  }

  function filteredCustomers() {
    return state.customers.filter((item) => {
      const text = `${item.brand} ${item.company} ${item.owner} ${item.source} ${item.market}`.toLowerCase();
      const matchSearch = !state.search || text.includes(state.search.toLowerCase());
      const matchStage = !state.stage || item.stage === state.stage;
      const matchTab = state.tab !== 'pool' || item.source === '公海池';
      return matchSearch && matchStage && matchTab;
    });
  }

  function stageBadge(stage) {
    return `<span class="stage-badge stage-${stage}">${stageLabels[stage] || stage || '-'}</span>`;
  }

  function renderStats() {
    const demandCount = Utils.getStorage('tm_demands', []).length;
    const proposalCount = state.customers.filter((item) => item.stage === 'proposal').length;
    const html = [
      ['客户总数', state.customers.length, '本地客户库', 'accent'],
      ['需求接入', demandCount, '来自需求方案模块', 'success'],
      ['方案阶段', proposalCount, '可继续生成提案', 'warning'],
      ['预计商机', `¥${state.customers.reduce((sum, item) => sum + Number(item.amount || 0), 0).toLocaleString()}`, '按客户金额汇总', 'accent']
    ].map(([label, value, sub, cls]) => `
      <div class="stat-card ${cls}">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
        <div class="sub">${sub}</div>
      </div>
    `).join('');
    DOM.setHtml('statsRow', html);
  }

  function renderCustomers() {
    const rows = filteredCustomers();
    const tbody = Utils.qs('#tableBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><p>暂无客户数据</p></div></td></tr>';
    } else {
      tbody.innerHTML = rows.map((item) => `
        <tr onclick="M0.openSidebar('${item.id}')">
          <td><strong>${Utils.escapeHtml(item.brand)}</strong></td>
          <td>${Utils.escapeHtml(item.company || '-')}</td>
          <td>${stageBadge(item.stage)}</td>
          <td>${Utils.escapeHtml(item.owner || '-')}</td>
          <td>¥${Number(item.amount || 0).toLocaleString()}</td>
          <td>${Utils.escapeHtml(item.source || '-')}</td>
          <td>${Utils.formatDate(item.updatedAt)}</td>
          <td><button class="btn btn-outline btn-sm" onclick="event.stopPropagation();M0.showAddModal('${item.id}')">编辑</button></td>
        </tr>
      `).join('');
    }
    DOM.setHtml('totalLabel', `共 ${rows.length} 条`);
    DOM.setHtml('pagination', '<span class="info">本地静态版本暂不分页</span><div class="pages"></div>');
  }

  function renderOpportunities() {
    const tbody = Utils.qs('#oppTableBody');
    if (!tbody) return;
    tbody.innerHTML = state.opportunities.map((item) => `
      <tr>
        <td><strong>${Utils.escapeHtml(item.name)}</strong></td>
        <td>${Utils.escapeHtml(item.customer)}</td>
        <td>¥${Number(item.amount || 0).toLocaleString()}</td>
        <td>${stageBadge(item.stage)}</td>
        <td>${Utils.escapeHtml(item.probability || '-')}</td>
        <td>${Utils.escapeHtml(item.owner || '-')}</td>
        <td>${Utils.escapeHtml(item.closeDate || '-')}</td>
        <td><button class="btn btn-outline btn-sm" onclick="M0.switchTab('my')">查看客户</button></td>
      </tr>
    `).join('');
  }

  function renderBoard() {
    const stageCounts = Object.keys(stageLabels).map((stage) => ({
      stage,
      label: stageLabels[stage],
      count: state.customers.filter((item) => item.stage === stage).length
    })).filter((item) => item.count > 0);

    DOM.setHtml('stageChart', stageCounts.map((item) => `
      <div style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <span style="width:72px">${item.label}</span>
        <div style="height:8px;background:var(--primary-light);border-radius:8px;flex:1">
          <div style="height:8px;width:${Math.max(10, item.count * 28)}%;max-width:100%;background:var(--primary);border-radius:8px"></div>
        </div>
        <strong>${item.count}</strong>
      </div>
    `).join('') || '<div class="empty-state"><p>暂无阶段数据</p></div>');

    DOM.setHtml('oppChart', state.opportunities.map((item) => `
      <p style="margin:8px 0"><strong>${Utils.escapeHtml(item.name)}</strong> · ${Utils.escapeHtml(item.probability || '-')} · ¥${Number(item.amount || 0).toLocaleString()}</p>
    `).join('') || '<div class="empty-state"><p>暂无商机数据</p></div>');

    DOM.setHtml('monthlyStats', `
      <p>本月新增需求：${Utils.getStorage('tm_demands', []).length}</p>
      <p>方案确认数：${Utils.getStorage('tm_demands', []).filter((item) => item.status === 'confirmed').length}</p>
      <p>知识库条目：${Utils.getStorage('tm_knowledge_base', []).length}</p>
    `);

    DOM.setHtml('recentActivity', state.customers.slice(0, 5).map((item) => `
      <p style="margin:8px 0">${Utils.escapeHtml(item.brand)} 更新到 ${stageLabels[item.stage] || item.stage}</p>
    `).join(''));
  }

  function syncVisibility() {
    const showOpp = state.tab === 'opportunities';
    const showBoard = state.tab === 'board';
    Utils.qs('#toolbar')?.classList.toggle('hidden', showOpp || showBoard);
    Utils.qs('#tableWrap')?.classList.toggle('hidden', showOpp || showBoard);
    Utils.qs('#oppTableWrap')?.classList.toggle('hidden', !showOpp);
    Utils.qs('#dataBoard')?.classList.toggle('hidden', !showBoard);
  }

  const M0 = {
    stageLabels,

    init() {
      load();
      bindTabs();
      renderStageOptions();
      DOM.setHtml('currentUserDisplay', 'Turing BD 工作台');
      M0.switchTab('my');
    },

    switchTab(tab) {
      state.tab = tab;
      DOM.showModule('app', tab);
      syncVisibility();
      renderStats();
      renderCustomers();
      renderOpportunities();
      renderBoard();
    },

    onSearch() {
      state.search = DOM.value('searchInput');
      renderCustomers();
    },

    onStageFilter() {
      state.stage = DOM.value('stageFilter');
      renderCustomers();
    },

    showAddModal(id) {
      const item = state.customers.find((customer) => customer.id === id) || {};
      DOM.setHtml('custModalTitle', id ? '编辑客户' : '新增客户');
      DOM.setHtml('custModalBody', `
        <input type="hidden" id="custId" value="${Utils.escapeHtml(item.id || '')}">
        <div class="form-group"><label>品牌名</label><input id="custBrand" value="${Utils.escapeHtml(item.brand || '')}"></div>
        <div class="form-group"><label>公司</label><input id="custCompany" value="${Utils.escapeHtml(item.company || '')}"></div>
        <div class="form-row">
          <div class="form-group"><label>阶段</label><select id="custStage">${Object.entries(stageLabels).map(([value, label]) => `<option value="${value}" ${item.stage === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          <div class="form-group"><label>商机金额</label><input id="custAmount" type="number" value="${Utils.escapeHtml(item.amount || '')}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>负责人</label><input id="custOwner" value="${Utils.escapeHtml(item.owner || 'Turing BD')}"></div>
          <div class="form-group"><label>来源</label><input id="custSource" value="${Utils.escapeHtml(item.source || '手动新增')}"></div>
        </div>
        <div class="form-group"><label>备注</label><textarea id="custNotes">${Utils.escapeHtml(item.notes || '')}</textarea></div>
      `);
      Utils.qs('#custModalOverlay')?.classList.add('open');
    },

    closeCustModal() {
      Utils.qs('#custModalOverlay')?.classList.remove('open');
    },

    saveCustomer() {
      const id = DOM.value('custId') || Utils.uid('cust');
      const next = {
        id,
        brand: DOM.value('custBrand'),
        company: DOM.value('custCompany'),
        stage: DOM.value('custStage') || 'new_lead',
        owner: DOM.value('custOwner') || 'Turing BD',
        amount: Number(DOM.value('custAmount') || 0),
        source: DOM.value('custSource') || '手动新增',
        updatedAt: Utils.today(),
        notes: DOM.value('custNotes')
      };
      if (!next.brand) {
        Utils.toast('请填写品牌名', 'warning');
        return;
      }
      const index = state.customers.findIndex((item) => item.id === id);
      if (index >= 0) state.customers[index] = next;
      else state.customers.unshift(next);
      save();
      M0.closeCustModal();
      M0.switchTab(state.tab);
      Utils.toast('客户已保存', 'success');
    },

    openSidebar(id) {
      const item = state.customers.find((customer) => customer.id === id);
      if (!item) return;
      DOM.setHtml('sidebarTitle', item.brand);
      DOM.setHtml('sidebarBody', `
        <div class="detail-grid">
          <div class="detail-item"><div class="lbl">公司</div><div class="val">${Utils.escapeHtml(item.company || '-')}</div></div>
          <div class="detail-item"><div class="lbl">阶段</div><div class="val">${stageBadge(item.stage)}</div></div>
          <div class="detail-item"><div class="lbl">负责人</div><div class="val">${Utils.escapeHtml(item.owner || '-')}</div></div>
          <div class="detail-item"><div class="lbl">商机金额</div><div class="val">¥${Number(item.amount || 0).toLocaleString()}</div></div>
          <div class="detail-item"><div class="lbl">来源</div><div class="val">${Utils.escapeHtml(item.source || '-')}</div></div>
          <div class="detail-item"><div class="lbl">更新时间</div><div class="val">${Utils.formatDate(item.updatedAt)}</div></div>
        </div>
        <div class="m3-analysis-summary"><div class="label">备注</div>${Utils.nl2br(item.notes || '暂无备注')}</div>
        <div class="m3-actions"><button class="btn btn-primary" onclick="M3.switchToM3('${item.brand}')">进入需求方案</button></div>
      `);
      Utils.qs('#sidebarOverlay')?.classList.add('open');
      Utils.qs('#sidebar')?.classList.add('open');
    },

    closeSidebar() {
      Utils.qs('#sidebarOverlay')?.classList.remove('open');
      Utils.qs('#sidebar')?.classList.remove('open');
    },

    addCustomerFromDemand(demand) {
      load();
      const brand = demand.brand || demand.customerName;
      if (!brand) return null;
      const existing = state.customers.find((item) => item.brand.toLowerCase() === brand.toLowerCase());
      const customer = {
        id: existing?.id || Utils.uid('cust'),
        brand,
        company: demand.company || existing?.company || '',
        stage: demand.status === 'confirmed' ? 'proposal' : 'analysis',
        owner: existing?.owner || 'Turing BD',
        amount: Number(demand.budget || existing?.amount || 0),
        source: '需求接入',
        updatedAt: Utils.today(),
        market: demand.market || existing?.market || '',
        notes: demand.objective || demand.brief || existing?.notes || ''
      };
      if (existing) {
        Object.assign(existing, customer);
      } else {
        state.customers.unshift(customer);
      }
      save();
      return customer;
    },

    logout() {
      Utils.toast('静态演示版未接入登录系统', 'info');
    },

    closeOppModal() {
      Utils.qs('#oppModalOverlay')?.classList.remove('open');
    },

    saveOpportunity() {
      Utils.toast('商机弹窗将在后续版本细化', 'info');
    }
  };

  window.M0 = M0;
})(window, document);
