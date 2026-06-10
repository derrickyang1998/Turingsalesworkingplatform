// TuringMarket v4.0 - Multi-user Team Platform
const API = window.location.origin + '/api';
const DS_URL = "https://api.deepseek.com/v1/chat/completions";
const DS_KEY = "sk-5951a22df4fc48ca874b86b87f43cee3";
let AUTH_TOKEN = localStorage.getItem('tm_token') || '';
let CURRENT_USER = null;
let BRANDS = [], INFLUENCERS = [], TEMPLATES = [], CBLOCKS = {};
let curDemand = null, selTpl = null, lastMatch = [], lastProp = "";
let uploadedFileContent = "";
let chatHistory = [{role: "system", content: "You are the TuringMarket AI assistant. Answer in Chinese, concise and professional."}];


// ==== DYNAMIC NAV REBUILD ====
(function rebuildNav() {
  var sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  
  var pages = [
    { id: 'm0', icon: '🚀', label: '客户管道' },
    { id: 'm1', icon: '📊', label: '行业品牌智库' },
    { id: 'm2', icon: '🎯', label: '客户策略规划' },
    { id: 'm3', icon: '📋', label: '需求接入 & 方案生成' },
    { id: 'm4', icon: '👥', label: '网红匹配 & 执行管理' },
    { id: 'm5', icon: '🤖', label: 'AI 助手' },
    { id: 'workflow-designer', icon: '✏️', label: '流程设计' },
    { id: 'workflow-templates', icon: '📋', label: '流程模板' },
    { id: 'workflow-instances', icon: '⚡', label: '流程实例' },
    { id: 'workflow-tasks', icon: '📌', label: '我的待办' },
    { id: 'admin', icon: '🛡️', label: '管理控制室', adminOnly: true }
  ];
  
  // Remove all existing nav items
  var existing = sidebar.querySelectorAll('.nav-item');
  for (var i = 0; i < existing.length; i++) { existing[i].remove(); }
  
  // Create new nav items
  for (var j = 0; j < pages.length; j++) {
    (function(p) {
      var el = document.createElement('div');
      el.className = 'nav-item';
      if (p.adminOnly) el.className += ' admin-only';
      if (p.id === 'm1') el.className += ' active';
      el.setAttribute('data-page', p.id);
      el.onclick = function() { switchPage(p.id); };
      el.style.cursor = 'pointer';
      el.innerHTML = '<span class="nav-icon">' + p.icon + '</span> ' + p.label;
      // Insert after sidebar-logo, before sidebar-footer
      var footer = sidebar.querySelector('.sidebar-footer');
      if (footer) {
        sidebar.insertBefore(el, footer);
      } else {
        sidebar.appendChild(el);
      }
    })(pages[j]);
  }
})();
// ==== FIX DOM NESTING: ensure all page-* divs are direct children of <main> ====
(function fixPageParents() {
  var main = document.querySelector('main');
  if (!main) return;
  // Wait a tick for DOM to settle, then move any misplaced page divs
  setTimeout(function() {
    var allPages = document.querySelectorAll('[id^="page-"]');
    for (var i = 0; i < allPages.length; i++) {
      if (allPages[i].parentElement !== main) {
        console.log('[TM] Fixing parent for: ' + allPages[i].id);
        main.appendChild(allPages[i]);
      }
    }
  }, 100);
})();


// ===== AUTH =====
async function doLogin() {
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value.trim();
  if (!u || !p) return showLoginError('请输入用户名和密码');
  try {
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const d = await r.json();
    if (!r.ok) return showLoginError(d.error || '登录失败');
    AUTH_TOKEN = d.token;
    CURRENT_USER = d.user;
    localStorage.setItem('tm_token', AUTH_TOKEN);
    localStorage.setItem('tm_user', JSON.stringify(CURRENT_USER));
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    if (CURRENT_USER.role === 'admin') {
      document.querySelectorAll('.admin-only').forEach(el => el.classList.add('visible'));
    }
    try { await initApp(); } catch(e2) { console.error(e2); }
  } catch (e) { showLoginError('Network error: ' + e.message) }
}

function showLoginError(msg) { toast(msg, 'error'); }

async function doLogout() {
  try {
    await fetch(API + '/auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH_TOKEN }
    });
  } catch (e) {}
  AUTH_TOKEN = ''; CURRENT_USER = null;
  localStorage.removeItem('tm_token'); localStorage.removeItem('tm_user');
  location.reload();
}

function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
  opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
  return fetch(API + url, opts);
}

// ===== APP INIT =====
async function initApp() { console.log("[TM] initApp starting");
  // Hide all non-M1 pages (they start visible for text metrics)
  
  try {
    const [bdResp, ir, tr] = await Promise.all([
      fetch('data/industry_brands_v2.json'),
      fetch('data/influencer_schema.json'),
      fetch('data/proposal_templates.json')
    ]);
    const bd = await bdResp.json();
    window.INDUSTRY_TREE = bd.industry_tree;
    const idata = await ir.json();
    const tdata = await tr.json();
    BRANDS = bd.brands || bd;
    INFLUENCERS = idata.sample_influencers || [];
    TEMPLATES = tdata.templates;
    CBLOCKS = tdata.common_blocks || {};
    try { var rb = await apiFetch('/brands'); var dbBrands = await rb.json(); if (dbBrands.brands && dbBrands.brands.length) { var en = {}; BRANDS.forEach(function(b) { en[b.name] = true; }); dbBrands.brands.forEach(function(db) { if (!en[db.name]) { BRANDS.push(db); en[db.name] = true; } }); } } catch(e) {} console.log("[TM] Calling initM1, initM3, initM4"); loadCustomers(); initM1(); initM3(); initM4(); console.log("[TM] init complete");
    var brandCountEl = document.getElementById('brandCount'); if (brandCountEl) brandCountEl.textContent = BRANDS.length + ' brands';
    var sfEl = document.getElementById('sidebarFooter'); if (sfEl && CURRENT_USER) sfEl.textContent = CURRENT_USER.display_name + ' . ' + CURRENT_USER.department;
    return
    document.getElementById('brandCount').textContent = BRANDS.length + ' brands';
    if (CURRENT_USER) {
      document.getElementById('sidebarFooter').textContent = CURRENT_USER.display_name + ' · ' + CURRENT_USER.department;
    }
  } catch (e) { console.error('initApp error:', e); document.getElementById('app').style.display = 'flex'; toast('Data load failed: ' + e.message, 'error'); try { initM1(); } catch(e2) {} }
}

// ===== C0: CUSTOMER PIPELINE (纷享销客CRM Style) =====
const CUST_STAGES = {
  lead: '开发中', proposal: '方案中', negotiation: '谈判中',
  won: '成交', maintenance: '维护中', lost: '丢失'
};
let curCrmView = 'pipeline';
let curStageFilter = '';
let curPriorityFilter = '';
let customersCache = [];

async function loadCustomers() {
  var search = document.getElementById('custSearch')?.value || '';
  var stage = document.getElementById('custStageFilter')?.value || '';
  var priority = document.getElementById('custPriorityFilter')?.value || '';
  var isPool = curCrmView === 'seapool';
  var qs = '?';
  if (isPool) qs += 'is_public=1';
  if (stage) qs += (qs.length > 1 ? '&' : '') + 'stage=' + stage;
  if (search) qs += (qs.length > 1 ? '&' : '') + 'search=' + encodeURIComponent(search);
  try {
    var r = await apiFetch('/customers' + qs);
    var d = await r.json();
    customersCache = d.customers || [];
    renderCustomerTable(customersCache, isPool);
    loadCustomerStats();
  } catch (e) { console.error(e); }
}

async function loadCustomerStats() {
  try {
    var r = await apiFetch('/customers/stats');
    var d = await r.json();
    // Update stats badges
    var total = document.getElementById('m0_totalCustomers');
    if (total) total.textContent = d.total || 0;
    var pool = document.getElementById('m0_poolCount');
    if (pool) pool.textContent = d.publicPool || 0;
    var val = document.getElementById('m0_totalValue');
    if (val) val.textContent = d.totalOppValue ? d.totalOppValue.toLocaleString() : '0';
    var poolTab = document.getElementById('m0_seapoolTabCount');
    if (poolTab) poolTab.textContent = d.publicPool || 0;
  } catch (e) {}
}

function switchCrmView(view) {
  curCrmView = view;
  document.querySelectorAll('.crm-tab').forEach(function(t) {
    t.style.borderBottomColor = 'transparent';
    t.style.color = 'var(--text2)';
    t.style.fontWeight = 'normal';
  });
  var tabs = document.querySelectorAll('.crm-tab');
  var idx = view === 'pipeline' ? 0 : view === 'seapool' ? 1 : 2;
  if (tabs[idx]) {
    tabs[idx].style.borderBottomColor = '#1a1a1a';
    tabs[idx].style.color = '#1a1a1a';
    tabs[idx].style.fontWeight = '600';
  }
  // Toggle views
  var pipeView = document.getElementById('crmPipelineView');
  var poolView = document.getElementById('crmSeaPoolView');
  var oppView = document.getElementById('oppTable');
  if (pipeView) pipeView.style.display = view === 'pipeline' ? 'block' : 'none';
  if (poolView) poolView.style.display = view === 'seapool' ? 'block' : 'none';
  if (oppView) oppView.style.display = view === 'opportunities' ? 'block' : 'none';
  if (view === 'opportunities') { loadOpportunities(); return; }
  loadCustomers();
}

function renderCustomerTable(data, isPool) {
  var tbody = document.getElementById('custTableBody');
  if (!data || !data.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;opacity:.5">暂无客户数据</td></tr>';
    return;
  }
  var h = '';
  data.forEach(function(c) {
    var stageLabel = CUST_STAGES[c.stage] || c.stage;
    h += '<tr style="cursor:pointer" onclick="openCustomerDetail(' + c.id + ')">';
    h += '<td><strong>' + esc(c.brand_name || '-') + '</strong></td>';
    h += '<td>' + esc(c.company_name || '-') + '</td>';
    h += '<td>' + esc(c.industry || '-') + '</td>';
    h += '<td><select onclick="event.stopPropagation()" onchange="changeCustomerStage(' + c.id + ', this.value)" style="width:auto;font-size:11px">';
    Object.keys(CUST_STAGES).forEach(function(k) {
      h += '<option value="' + k + '"' + (c.stage === k ? ' selected' : '') + '>' + CUST_STAGES[k] + '</option>';
    });
    h += '</select></td>';
    h += '<td>' + esc(c.contact_person || '-') + '</td>';
    h += '<td>' + (c.opportunity_value ? '¥' + Number(c.opportunity_value).toLocaleString() : '-') + '</td>';
    h += '<td>' + esc(c.created_by_name || '-') + '</td>';
    h += '<td style="font-size:10px;opacity:.6">' + (c.updated_at ? c.updated_at.substring(0, 10) : '-') + '</td>';
    h += '<td onclick="event.stopPropagation()">';
    if (isPool) {
      h += '<button class="btn btn-sm btn-primary" onclick="claimCustomer(' + c.id + ')">认领</button>';
    } else {
      h += '<button class="btn btn-sm btn-outline" onclick="openCustomerDetail(' + c.id + ')">详情</button>';
    }
    h += '</td></tr>';
  });
  tbody.innerHTML = h;
}

// ===== CUSTOMER DETAIL SIDEBAR =====
async function openCustomerDetail(id) {
  try {
    var r = await apiFetch('/customers/' + id + '/detail');
    var d = await r.json();
    if (!d.customer) { toast('客户不存在', 'error'); return; }
    var c = d.customer;
    var html = '<div class="sidebar-section"><h4>基本信息</h4>';
    html += '<div class="field"><span class="field-label">品牌</span><span class="field-value">' + esc(c.brand_name || '-') + '</span></div>';
    html += '<div class="field"><span class="field-label">公司</span><span class="field-value">' + esc(c.company_name || '-') + '</span></div>';
    html += '<div class="field"><span class="field-label">行业</span><span class="field-value">' + esc(c.industry || '-') + '</span></div>';
    html += '<div class="field"><span class="field-label">联系人</span><span class="field-value">' + esc(c.contact_person || '-') + '</span></div>';
    html += '<div class="field"><span class="field-label">阶段</span><span class="field-value">' + (CUST_STAGES[c.stage] || c.stage) + '</span></div>';
    html += '<div class="field"><span class="field-label">来源</span><span class="field-value">' + esc(c.source || '-') + '</span></div>';
    html += '<div class="field"><span class="field-label">预算</span><span class="field-value">' + esc(c.budget_estimate || '-') + '</span></div>';
    html += '<div class="field"><span class="field-label">备注</span><span class="field-value">' + esc(c.notes || '-') + '</span></div>';
    html += '</div>';

    // Actions
    html += '<div class="sidebar-section" style="display:flex;gap:8px;flex-wrap:wrap">';
    if (c.is_public == 1) {
      html += '<button class="btn btn-primary btn-sm" onclick="claimCustomer(' + c.id + ');closeCustomerDetail()">📥 认领客户</button>';
    } else {
      html += '<button class="btn btn-outline btn-sm" onclick="returnToPool(' + c.id + ');closeCustomerDetail()">🌊 释放到公海</button>';
    }
    html += '<button class="btn btn-outline btn-sm" onclick="editCustomer(' + c.id + ');closeCustomerDetail()">✏️ 编辑</button>';
    html += '<button class="btn btn-sm btn-primary" onclick="showOppModal(' + c.id + ')">💼 新增商机</button>';
    html += '</div>';

    // Opportunities
    html += '<div class="sidebar-section"><h4>商机 (' + (d.opportunities || []).length + ')</h4>';
    if (d.opportunities && d.opportunities.length) {
      html += '<div style="font-size:12px">';
      d.opportunities.forEach(function(o) {
        html += '<div style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">';
        html += '<div style="font-weight:600">' + esc(o.name) + '</div>';
        html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2)">';
        html += '<span>¥' + (o.value || 0).toLocaleString() + '</span>';
        html += '<span>' + (o.stage || '-') + ' | ' + (o.win_probability || 0) + '%</span>';
        html += '</div></div>';
      });
      html += '</div>';
    } else {
      html += '<p style="font-size:12px;color:var(--text2)">暂无商机</p>';
    }
    html += '</div>';

    // Activity log
    html += '<div class="sidebar-section"><h4>活动日志</h4>';
    if (d.activity && d.activity.length) {
      html += '<div style="font-size:12px;max-height:300px;overflow-y:auto">';
      d.activity.forEach(function(a) {
        html += '<div style="padding:6px 0;border-bottom:1px solid var(--border)">';
        html += '<span style="color:var(--text2)">' + (a.created_at || '').substring(0, 16) + '</span> ';
        html += '<strong>' + esc(a.action || '') + '</strong>';
        if (a.display_name) html += ' <span style="color:var(--text2)">by ' + esc(a.display_name) + '</span>';
        if (a.notes) html += '<br><span style="color:#666">' + esc(a.notes) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<p style="font-size:12px;color:var(--text2)">暂无活动记录</p>';
    }
    html += '</div>';

    // Add activity form
    html += '<div class="sidebar-section">';
    html += '<h4>添加跟进</h4>';
    html += '<div style="display:flex;gap:6px">';
    html += '<input id="activityText" placeholder="输入跟进内容..." style="flex:1;padding:6px 10px;font-size:12px">';
    html += '<button class="btn btn-primary btn-sm" onclick="addCustomerActivity(' + c.id + ')">记录</button>';
    html += '</div></div>';

    document.getElementById('custDetailTitle').textContent = c.brand_name || '客户详情';
    document.getElementById('custDetailBody').innerHTML = html;
    document.getElementById('custDetailOverlay').style.display = 'block';
    document.getElementById('custDetailSidebar').classList.add('open');
  } catch (e) { toast('加载失败: ' + e.message, 'error'); }
}

function closeCustomerDetail() {
  document.getElementById('custDetailOverlay').style.display = 'none';
  document.getElementById('custDetailSidebar').classList.remove('open');
}

// ===== CLAIM / RETURN POOL =====
async function claimCustomer(id) {
  try {
    await apiFetch('/customers/' + id + '/claim', { method: 'POST' });
    toast('已认领客户');
    loadCustomers();
  } catch (e) { toast('认领失败: ' + e.message, 'error'); }
}
async function returnToPool(id) {
  try {
    await apiFetch('/customers/' + id + '/return', { method: 'POST' });
    toast('已释放到公海');
    loadCustomers();
  } catch (e) { toast('释放失败: ' + e.message, 'error'); }
}

// ===== OPPORTUNITIES =====
async function loadOpportunities() {
  document.getElementById('custTable').style.display = 'none';
  document.getElementById('oppTable').style.display = 'block';
  try {
    var r = await apiFetch('/opportunities?pageSize=1000');
    var d = await r.json();
    var tbody = document.getElementById('oppTableBody');
    var rows = d.rows || d.opportunities || [];
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;opacity:.5">暂无商机</td></tr>'; return; }
    var h = '';
    rows.forEach(function(o) {
      h += '<tr><td><strong>' + esc(o.name) + '</strong></td>';
      h += '<td>' + (o.customer_name || '-') + '</td>';
      h += '<td>¥' + (o.value || 0).toLocaleString() + '</td>';
      h += '<td>' + esc(o.stage || '-') + '</td>';
      h += '<td>' + (o.win_probability || 0) + '%</td>';
      h += '<td style="font-size:11px">' + (o.expected_close_date || '-') + '</td>';
      h += '<td><button class="btn btn-sm btn-outline" onclick="deleteOpportunity(' + o.id + ')">删除</button></td></tr>';
    });
    tbody.innerHTML = h;
  } catch (e) {
    document.getElementById('oppTableBody').innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px">加载失败: ' + e.message + '</td></tr>';
  }
}

var currentOppCustomerId = null;
function showOppModal(customerId) {
  currentOppCustomerId = customerId;
  document.getElementById('oppEditId').value = '';
  document.getElementById('oppCustomerId').value = customerId || '';
  document.getElementById('oppName').value = '';
  document.getElementById('oppValue').value = '';
  document.getElementById('oppStage').value = 'discovery';
  document.getElementById('oppProbability').value = '50';
  document.getElementById('oppProduct').value = '';
  document.getElementById('oppChannel').value = '';
  document.getElementById('oppCloseDate').value = '';
  document.getElementById('oppNotes').value = '';
  document.getElementById('oppModalTitle').textContent = '新增商机';
  document.getElementById('oppModalOverlay').style.display = 'flex';
}
function closeOppModal() { document.getElementById('oppModalOverlay').style.display = 'none'; }

async function saveOpportunity() {
  var name = document.getElementById('oppName').value.trim();
  if (!name) { toast('请输入商机名称', 'error'); return; }
  var body = {
    customer_id: currentOppCustomerId || document.getElementById('oppCustomerId').value,
    name: name,
    value: Number(document.getElementById('oppValue').value) || 0,
    stage: document.getElementById('oppStage').value,
    win_probability: Number(document.getElementById('oppProbability').value) || 50,
    product_name: document.getElementById('oppProduct').value.trim(),
    channel_type: document.getElementById('oppChannel').value.trim(),
    expected_close_date: document.getElementById('oppCloseDate').value || null,
    notes: document.getElementById('oppNotes').value.trim()
  };
  try {
    await apiFetch('/opportunities', { method: 'POST', body: JSON.stringify(body) });
    toast('商机已创建');
    closeOppModal();
    loadOpportunities();
  } catch (e) { toast('保存失败: ' + e.message, 'error'); }
}
async function deleteOpportunity(id) {
  if (!confirm('确定删除此商机？')) return;
  try { await apiFetch('/opportunities/' + id, { method: 'DELETE' }); toast('已删除'); loadOpportunities(); }
  catch (e) { toast('删除失败', 'error'); }
}

// ===== ACTIVITY LOG =====
async function addCustomerActivity(customerId) {
  var text = document.getElementById('activityText')?.value;
  if (!text) { toast('请输入跟进内容', 'error'); return; }
  try {
    await apiFetch('/customers/' + customerId + '/activity', {
      method: 'POST',
      body: JSON.stringify({ action: '跟进', notes: text })
    });
    toast('已记录');
    openCustomerDetail(customerId);
  } catch (e) { toast('记录失败: ' + e.message, 'error'); }
}

// ===== ORIGINAL CRM FUNCTIONS (enhanced) =====
async function loadCustomerStats_old() { /* kept for compatibility */ }

function filterCustomers(stage) {
  curStageFilter = stage;
  document.querySelectorAll('#m0StageFilter .tag').forEach(function(t) { t.classList.remove('active'); });
  var activeEl = document.querySelector('#m0StageFilter [data-stage="' + stage + '"]');
  if (activeEl) activeEl.classList.add('active');
  else document.querySelector('#m0StageFilter .tag').classList.add('active');
  loadCustomers();
}

// Page load - check for existing session
(async function () {
  const saved = localStorage.getItem('tm_token');
  const savedUser = localStorage.getItem('tm_user');
  if (saved && savedUser) {
    try {
      const r = await fetch(API + '/auth/me', { headers: { 'Authorization': 'Bearer ' + saved } });
      if (r.ok) {
        const d = await r.json();
        AUTH_TOKEN = saved;
        CURRENT_USER = d.user;
        document.getElementById('authOverlay').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        if (CURRENT_USER.role === 'admin') {
          document.querySelectorAll('.admin-only').forEach(el => el.classList.add('visible'));
        }
        await initApp();
        return;
      }
    } catch (e) {}
  }
  document.getElementById('authOverlay').style.display = 'flex';
})();


// ===== PHASE 4: AI STRATEGY PLANNING (DeepSeek V4 Flash) =====
async function generateAIStrategy() {
  var input = document.getElementById('aiStrategyInput').value.trim();
  if (!input) { toast('Please enter customer description', 'error'); return; }
  var out = document.getElementById('aiStrategyOutput');
  var status = document.getElementById('aiStatus');
  status.textContent = 'Analyzing...';
  out.style.display = '';
  out.innerHTML = '<span style="opacity:.5">🧠 AI analyzing your customer profile...</span>';
  
  var context = {
    brandCount: BRANDS.length,
    sampleBrands: BRANDS.slice(0,15).map(function(b) { return { name: b.name, industry: (b.industry_tags||[]).join(', '), revenue: b.estimated_annual_revenue }; }),
    industries: Object.keys((window.INDUSTRY_TREE || {})).join(', ')
  };
  
  var prompt = 'You are a senior overseas influencer marketing strategist at TuringMarket. Analyze the customer profile below and provide a comprehensive strategy in Chinese:\n\nCustomer: ' + input + '\n\nReference data (from our brand database): ' + JSON.stringify(context) + '\n\nProvide: 1) Market opportunity analysis 2) Recommended influencer types and platforms 3) Estimated budget allocation (60-30-10 model) 4) Competitor benchmarking suggestions 5) 3-month execution roadmap 6) Risk factors and mitigation. Format with clear headings and bullet points. Be specific and actionable.';
  
  try {
    var resp = await fetch(DS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DS_KEY },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 2500 })
    });
    if (!resp.ok) throw new Error('API:' + resp.status);
    var data = await resp.json();
    var result = data.choices[0].message.content;
    // Parse markdown formatting
    result = result.replace(/### (.*)/g, '<h3 style="margin-top:16px;font-size:16px">$1</h3>');
    result = result.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/\- (.*)/g, '<li>$1</li>');
    result = result.replace(/\n/g, '<br>');
    out.innerHTML = result;
    status.textContent = 'Analysis complete';
    // Track token usage
    if (data.usage) trackTokenUsage('deepseek-chat', 'strategy', data.usage.prompt_tokens, data.usage.completion_tokens, data.usage.total_tokens);
  } catch(e) {
    out.innerHTML = '<span style="color:#d94641">Analysis failed: ' + e.message + '</span>';
    status.textContent = 'Failed';
  }
}
function trackTokenUsage(model, endpoint, promptTokens, completionTokens, totalTokens) {
  try {
    fetch(API + '/token-usage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, endpoint: endpoint, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens })
    });
  } catch(e) {}
}
// ===== END PHASE 4 =====
// ===== UTILS =====

function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function toast(m, ty) { ty = ty || 'success'; const c = document.getElementById('toastContainer'), e = document.createElement('div'); e.className = 'toast toast-' + ty; e.textContent = m; c.appendChild(e); setTimeout(function () { e.remove() }, 3000) }

function exportBrandCSV() {
  if (!BRANDS || !BRANDS.length) { toast("No brands to export", "error"); return; }
  var csv = "Name,CN_Name,Industry,Revenue,Users,Website,Amazon,Contact_Emails,LinkedIn\n";
  BRANDS.forEach(function(b) {
    csv += [
      '"' + (b.name || "").replace(/"/g,'""') + '"',
      '"' + (b.name_cn || "").replace(/"/g,'""') + '"',
      '"' + ((b.industry_tags || []).join("; ")).replace(/"/g,'""') + '"',
      b.estimated_annual_revenue || "N/A",
      b.user_base || "N/A",
      b.website || "",
      b.amazon_store || "",
      b.contact_emails || "",
      b.linkedin_url || ""
    ].join(",") + "\n";
  });
  dlFile("turingmarket_brands_" + getDate() + ".csv", "\uFEFF" + csv, "text/csv");
  toast("Exported " + BRANDS.length + " brands");
}

function dlFile(name, content, type) { const b = new Blob([content], { type: type || 'text/plain' }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u) }
function switchTheme(t) { /* Theme locked to Notion style */ }
(function () { document.body.className = ''; })();
function switchPage(id) {
  var i, navs, pages, ni, pg;
  navs = document.querySelectorAll('.nav-item');
  for (i = 0; i < navs.length; i++) { navs[i].classList.remove('active'); }
  ni = document.querySelector('[data-page=\"' + id + '\"]');
  if (ni) ni.classList.add('active');
  pages = document.querySelectorAll('.page');
  for (i = 0; i < pages.length; i++) { 
    pages[i].classList.remove('active'); 
    pages[i].style.display = 'none'; 
  }
  pg = document.getElementById('page-' + id);
  if (pg) { 
    pg.classList.add('active'); 
    pg.style.display = 'block';
  }
  if (id === 'm0') loadCustomers();
  if (id === 'admin') loadAdminDashboard();
  if (id === 'workflow-templates') { setTimeout(function() { if (typeof wfLoadTemplates === 'function') wfLoadTemplates(); }, 200); }
  if (id === 'workflow-instances') { setTimeout(function() { if (typeof wfLoadInstances === 'function') wfLoadInstances(); }, 200); }
  if (id === 'workflow-tasks') { setTimeout(function() { if (typeof wfLoadTasks === 'function') wfLoadTasks(); }, 200); }
}


// ===== CRM FUNCTIONS =====
var crmCurrentView = 'pipeline';
function switchCrmView(view) {
  crmCurrentView = view;
  document.querySelectorAll('.crm-tab').forEach(function(t) { t.style.color = 'var(--text2)'; t.style.borderBottom = '2px solid transparent'; });
  if (event && event.target) { event.target.style.color = ''; event.target.style.borderBottom = '2px solid #1a1a1a'; }
  document.getElementById('crmPipelineView').style.display = view === 'pipeline' ? '' : 'none';
  document.getElementById('crmSeaPoolView').style.display = view === 'seapool' ? '' : 'none';
  document.getElementById('crmOpportunityView').style.display = view === 'opportunities' ? '' : 'none';
  if (view === 'seapool') loadSeaPool();
  if (view === 'opportunities') loadOpportunityKanban();
}
async function loadSeaPool() {
  try {
    var r = await apiFetch('/customers/sea-pool');
    var d = await r.json();
    var customers = d.customers || [];
    var h = '<table><thead><tr><th>品牌</th><th>公司</th><th>行业</th><th>最后更新</th><th style="width:65px">操作</th></tr></thead><tbody>';
    if (!customers.length) { h += '<tr><td colspan="5" style="text-align:center;padding:30px;opacity:.5">🌊 公海池暂无客户</td></tr>'; }
    else { customers.forEach(function(c) { h += '<tr><td><strong>'+(c.brand_name||'')+'</strong></td><td>'+(c.company_name||'')+'</td><td>'+(c.industry||'')+'</td><td style="font-size:11px;opacity:.6">'+(c.updated_at||'').substring(0,10)+'</td><td><button class="btn btn-sm btn-primary" onclick="claimCustomer('+c.id+')">认领</button></td></tr>'; }); }
    h += '</tbody></table>';
    document.getElementById('seaPoolTable').innerHTML = h;
    document.getElementById('m0_seapoolTabCount').textContent = customers.length;
  } catch(e) {}
}
async function claimCustomer(id) {
  try { await apiFetch('/customers/' + id + '/claim', { method: 'POST' }); toast('客户已认领到你的库'); loadCustomers(); loadSeaPool(); loadDashboard(); } catch(e) { toast('认领失败', 'error'); }
}
async function loadDashboard() {
  try {
    var r = await apiFetch('/customers/dashboard');
    var d = await r.json();
    document.getElementById('m0_totalCustomers').textContent = d.total || 0;
    document.getElementById('m0_poolCount').textContent = d.poolCount || 0;
    document.getElementById('m0_totalValue').textContent = (d.totalValue||0).toLocaleString();
  } catch(e) {}
}
async function loadOpportunityKanban() {
  try {
    var r = await apiFetch('/customers?stage=proposal&stage=negotiation');
    var d = await r.json();
    var opps = (d.customers||[]).filter(function(c) { return c.opportunity_value > 0; });
    var stages = [{id:'proposal',label:'📝 方案',color:'#dbeafe'},{id:'negotiation',label:'🤝 谈判',color:'#ede9fe'}];
    var h = '';
    stages.forEach(function(s) {
      var items = opps.filter(function(o) { return o.stage === s.id; });
      h += '<div style="flex:1;min-width:200px;background:'+s.color+';border-radius:8px;padding:12px"><div style="font-weight:600;margin-bottom:8px">'+s.label+' ('+items.length+')</div>';
      items.forEach(function(o) { h += '<div style="background:#fff;border-radius:6px;padding:8px;margin-bottom:6px;font-size:12px"><strong>'+(o.brand_name||'')+'</strong><br><span style="opacity:.6">'+(o.company_name||'')+'</span><br><span style="color:#0f7b3c;font-weight:600">$'+(o.opportunity_value||0).toLocaleString()+'</span></div>'; });
      h += '</div>';
    });
    document.getElementById('oppKanbanColumns').innerHTML = h || '<p style="opacity:.5">暂无商机数据</p>';
  } catch(e) {}
}
// Update loadCustomers to call dashboard
var _origLoadCustomers = loadCustomers;
loadCustomers = async function() { await _origLoadCustomers(); /*loadDashboard();*/ };
// Hash-driven routing
window.onhashchange = function() {
  var h = location.hash.replace('#', '') || 'm1';
  switchPage(h);
};

// Initial hash
(function() {
  var h = location.hash.replace('#', '') || 'm1';
  if (h !== 'm1') setTimeout(function() { switchPage(h); }, 200);
})();
function gv(id) { var e = document.getElementById(id); return e ? e.value : '' }
function getDate() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }


// ===== PHASE 5: DEMAND FILE ANALYSIS =====
var uploadedDemandContent = '';
function analyzeDemandFile(e) {
  var f = e.target.files[0]; if (!f) return;
  var s = document.getElementById('uploadOK'); if (!s) return;
  s.innerHTML = '<span>Analyzing: ' + f.name + '...</span>';
  var reader = new FileReader();
  reader.onload = function(ev) {
    uploadedDemandContent = ev.target.result.substring(0, 8000);
    s.innerHTML = '<span style="color:#0f7b3c">File loaded ('+(f.size/1024).toFixed(1)+'KB). Click "AI Analyze" to generate proposal.</span>';
  };
  reader.readAsText(f);
}
async function analyzeDemandWithAI() {
  if (!uploadedDemandContent) { toast('Please upload a file first', 'error'); return; }
  var output = document.getElementById('proposalOutput');
  output.innerHTML = '<span style="opacity:.5">AI analyzing demand...</span>';
  var prompt = 'Analyze this customer demand document and generate a structured influencer marketing proposal in Chinese. Include: 1) Executive summary 2) Market analysis 3) Recommended strategy (60-30-10 model) 4) Influencer matching criteria 5) Budget estimation 6) Timeline 7) KPIs.\n\nDocument: ' + uploadedDemandContent;
  try {
    var resp = await fetch(DS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DS_KEY }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 3000 }) });
    var d = await resp.json();
    output.innerHTML = '<div style="white-space:pre-wrap;font-size:13px;line-height:1.6">' + d.choices[0].message.content.replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>') + '</div><div style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="downloadProposal()">Download MD</button><button class="btn btn-sm" onclick="downloadProposalHTML()">Export HTML</button></div>';
    lastProp = d.choices[0].message.content;
    toast('Proposal generated');
  } catch(e) { output.innerHTML = '<span style="color:#d94641">Analysis failed: ' + e.message + '</span>'; }
}
function downloadProposalHTML() {
  if (!lastProp) return;
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Influencer Marketing Proposal</title><style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:20px;line-height:1.8}h2{color:#1a1a1a;border-bottom:2px solid #1a1a1a;padding-bottom:8px}ul{margin:12px 0}li{margin:6px 0}</style></head><body>' + lastProp.replace(/\n/g,'<br>').replace(/### (.*)/g,'<h2>$1</h2>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>') + '</body></html>';
  dlFile('proposal.html', html, 'text/html');
  toast('HTML downloaded');
}

// ===== PHASE 6: INFLUENCER FILTERS + EXPORT =====
function applyInfFilters() {
  var project = document.getElementById('filt_project')?.value || '';
  var product = document.getElementById('filt_product')?.value || '';
  var platform = document.getElementById('filt_platform')?.value || '';
  var country = document.getElementById('filt_region')?.value || '';
  var tag = document.getElementById('filt_category')?.value || '';
  var filtered = (lastMatch.length ? lastMatch : INFLUENCERS).filter(function(inf) {
    if (project && (inf.project||'') !== project) return false;
    if (product && (inf.product||'') !== product) return false;
    if (platform && (inf.platform||'') !== platform) return false;
    if (country && (inf.region||'') !== country) return false;
    if (tag && (inf.category||'') !== tag) return false;
    return true;
  });
  renderInfTable(filtered, false);
}
function exportFilteredInf() {
  var chk = []; document.querySelectorAll('.infcb:checked').forEach(function(c) { chk.push(parseInt(c.dataset.idx)); });
  var data = chk.length ? chk.map(function(i) { return lastMatch[i]; }).filter(Boolean) : lastMatch;
  if (!data || !data.length) { toast('No data to export', 'error'); return; }
  var csv = 'No.,KOL Handle,Platform,Followers,Category,Region,Collab Type,Cost(USD),CPM\n';
  data.forEach(function(inf, i) { csv += (i+1)+',"'+(inf.kol_handle||'')+'",'+inf.platform+','+(inf.followers||0)+','+(inf.category||'')+','+(inf.region||'')+','+(inf.collab_type||'')+','+(inf.cost_usd||0)+','+(inf.cpm||'')+'\n'; });
  dlFile('influencers_'+getDate()+'.csv', '\uFEFF'+csv, 'text/csv');
  toast('Exported '+data.length+' influencers');
}

// ===== PHASE 7: AI ASSISTANT WITH MEMORY =====
let aiMemory = {};
let aiMemoryKey = 'tm_ai_memory';
(function loadAIMemory() {
  try { aiMemory = JSON.parse(localStorage.getItem(aiMemoryKey) || '{}'); } catch(e) { aiMemory = {}; }
})();
function saveAIMemory() { localStorage.setItem(aiMemoryKey, JSON.stringify(aiMemory)); }
function enhancedSendChat() {
  var inp = document.getElementById('chatInput'); var msg = inp.value.trim();
  if (!msg) return;
  addChatMsg('user', msg); inp.value = '';
  // Build context from memory
  var memKeys = Object.keys(aiMemory).slice(-5);
  var memContext = memKeys.length ? '\n\nPrevious discussions: ' + memKeys.map(function(k) { return k + ': ' + aiMemory[k].substring(0, 100); }).join('\n') : '';
  chatHistory.push({ role: 'user', content: msg });
  // Store in memory
  var memId = 'm' + Date.now();
  aiMemory[memId] = msg;
  saveAIMemory();
  
  var msgs = document.getElementById('chatMessages');
  var td = document.createElement('div'); td.className = 'chat-msg assistant'; td.innerHTML = '<div class=bubble>...</div>'; msgs.appendChild(td);
  
  fetch(DS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DS_KEY }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: 'You are TuringMarket AI assistant. You have access to: ' + BRANDS.length + ' brands database. Be concise and professional in Chinese. Previous context: ' + memContext }, { role: 'user', content: msg }], temperature: 0.7, max_tokens: 1500 }) })
    .then(function(r) { return r.json(); })
    .then(function(d) { td.remove(); var reply = d.choices[0].message.content; chatHistory.push({ role: 'assistant', content: reply }); aiMemory[memId+'_r'] = reply; saveAIMemory(); addChatMsg('assistant', reply); })
    .catch(function(e) { td.remove(); addChatMsg('assistant', 'Error: ' + e.message); });
}


// ===== PHASE 9: KNOWLEDGE BASE ACCUMULATION SYSTEM =====
let knowledgeBase = [];
let KB_STORAGE_KEY = 'tm_knowledge_base';

// Load KB from server on init
async function loadKnowledgeBase() {
  try {
    var r = await apiFetch('/knowledge');
    var d = await r.json();
    knowledgeBase = d.entries || [];
    console.log('[KB] Loaded ' + knowledgeBase.length + ' entries');
  } catch(e) { 
    try { knowledgeBase = JSON.parse(localStorage.getItem(KB_STORAGE_KEY) || '[]'); } catch(x) { knowledgeBase = []; }
  }
}

// Save KB to server
async function saveKnowledgeEntry(entry) {
  knowledgeBase.push(entry);
  // Keep last 500 entries locally
  if (knowledgeBase.length > 500) knowledgeBase = knowledgeBase.slice(-500);
  localStorage.setItem(KB_STORAGE_KEY, JSON.stringify(knowledgeBase));
  // Sync to server
  try {
    await apiFetch('/knowledge', { method: 'POST', body: JSON.stringify(entry) });
  } catch(e) { /* offline - saved locally */ }
}

// Search KB for relevant entries  
function searchKnowledge(query) {
  var q = (query || '').toLowerCase();
  if (!q) return [];
  return knowledgeBase.filter(function(e) {
    return (e.title||'').toLowerCase().indexOf(q) >= 0 ||
           (e.content||'').toLowerCase().indexOf(q) >= 0 ||
           (e.tags||[]).some(function(t) { return t.toLowerCase().indexOf(q) >= 0; });
  }).slice(0, 10);
}

// Auto-archive: save demand files, AI outputs, and proposals to KB
async function archiveToKB(type, title, content, tags) {
  var entry = {
    type: type || 'note',
    title: title || '',
    content: content || '',
    tags: tags || [],
    timestamp: new Date().toISOString(),
    user: CURRENT_USER ? CURRENT_USER.display_name : 'system'
  };
  await saveKnowledgeEntry(entry);
}

// Hook into existing flows to auto-archive
var _origSaveCustomer = saveCustomer;
saveCustomer = async function() {
  await _origSaveCustomer();
  var brand = document.getElementById('custBrand').value.trim();
  var company = document.getElementById('custCompany').value.trim();
  var industry = document.getElementById('custIndustry').value;
  if (brand) {
    await archiveToKB('customer', 'New customer: ' + brand, brand + ' / ' + company + ' / ' + industry, [industry, 'customer']);
  }
};

var _origGenerateAIStrategy = generateAIStrategy;
generateAIStrategy = async function() {
  await _origGenerateAIStrategy();
  var input = document.getElementById('aiStrategyInput').value.trim();
  if (input) {
    await archiveToKB('strategy', 'Strategy for: ' + input.substring(0, 50), input, ['strategy', 'ai']);
  }
};

// KB search UI for AI Assistant
function searchKBForAI(query) {
  var results = searchKnowledge(query);
  if (!results.length) return '';
  return '\n\n[Knowledge Base Results]:\n' + results.map(function(e, i) { 
    return (i+1) + '. ' + e.title + ': ' + (e.content||'').substring(0, 200); 
  }).join('\n');
}

// Initialize KB on startup
setTimeout(function() { loadKnowledgeBase(); }, 3000);
// ===== PHASE 8: ADMIN USER MANAGEMENT (纷享销客 Style) =====
async function loadAdminUsers() {
  try { var r = await apiFetch('/admin/users'); var d = await r.json(); renderAdminUserTable(d.users || []); } catch(e) {}
}
function renderAdminUserTable(users) {
  var tbody = document.getElementById('ad_userTableBody'); if (!tbody) return;
  var h = '';
  users.forEach(function(u) {
    h += '<tr><td><strong>'+u.username+'</strong></td><td>'+u.display_name+'</td><td>'+(u.department||'-')+'</td><td>'+u.role+'</td><td>'+(u.api_quota||0).toLocaleString()+'</td><td>'+(u.last_login||'Never').substring(0,10)+'</td><td>'+(u.is_active?'<span style="color:#0f7b3c">Active</span>':'<span style="color:#d94641">Inactive</span>')+'</td><td><button class="btn btn-sm" onclick="adminResetPw('+u.id+')">Reset PW</button><button class="btn btn-sm" onclick="toggleUserActive('+u.id+','+!u.is_active+')">'+(u.is_active?'Deactivate':'Activate')+'</button></td></tr>';
  });
  tbody.innerHTML = h;
}
async function toggleUserActive(id, active) { try { await apiFetch('/admin/users/'+id, {method:'PUT',body:JSON.stringify({is_active:active})}); loadAdminUsers(); toast('User '+(active?'activated':'deactivated')); } catch(e) { toast('Failed','error'); } }
async function adminResetPw(userId) { try { await apiFetch('/admin/users/reset-password/'+userId, {method:'POST'}); toast('Password reset to turing2026'); } catch(e) { toast('Failed','error'); } }
// ===== CROSS-MODULE INTERCONNECT =====
let currentCustomer = null;

function setCurrentCustomer(cust) {
  currentCustomer = cust;
  if (cust) toast('已选择客户: ' + cust.brand_name);
}

function clearCurrentCustomer() {
  currentCustomer = null;
}

function goToM1(cust) {
  setCurrentCustomer(cust);
  switchPage('m1');
  setTimeout(function() {
    // Auto-filter brand tree by customer industry
    if (cust.industry) {
      var treeTags = document.querySelectorAll('#industryTreeContainer .tag');
      treeTags.forEach(function(t) {
        if (t.textContent.trim() === cust.industry || t.getAttribute('data-tag') === cust.industry) {
          t.click();
        }
      });
      // Also set the search to the customer brand
      var searchEl = document.getElementById('brandSearch');
      if (searchEl) {
        searchEl.value = cust.industry;
      }
    }
  }, 500);
}





// ===== PHASE 3: BRAND SEARCH + SIMILAR BRANDS =====
function searchNewBrand() {
  var q = (document.getElementById('brandSearch').value || '').trim();
  if (!q) { toast('Please enter a brand name', 'error'); return; }
  var results = BRANDS.filter(function(b) {
    return (b.name||'').toLowerCase().indexOf(q.toLowerCase()) >= 0 || 
           (b.name_cn||'').indexOf(q) >= 0;
  });
  if (results.length) { renderBrands(results); toast('Found ' + results.length + ' brands matching ' + q); }
  else { toast('No exact match - showing similar brands', 'info'); showSimilarBrands(q); }
  try { apiFetch('/brands', { method: 'POST', body: JSON.stringify({ name: q, data_source: 'search_archive' }) }); } catch(e) {}
}
function filterBrands() {
  var q = (document.getElementById('brandSearch').value || '').trim().toLowerCase();
  if (!q) { renderBrands(BRANDS); hideSimilarBrands(); return; }
  var results = BRANDS.filter(function(b) {
    return (b.name||'').toLowerCase().indexOf(q) >= 0 || (b.name_cn||'').indexOf(q) >= 0;
  });
  renderBrands(results);
  if (results.length === 0) showSimilarBrands(q); else hideSimilarBrands();
}
function showSimilarBrands(query) {
  var sim = BRANDS.filter(function(b) {
    return (b.industry_tags||[]).some(function(t) { return t.toLowerCase().indexOf(query.toLowerCase()) >= 0; });
  }).slice(0, 8);
  var c = document.getElementById('similarBrandsContainer');
  if (!c) return;
  if (sim.length) {
    var h = '<div style="font-size:11px;margin-top:8px"><strong>Similar Brands:</strong> ';
    sim.forEach(function(b) { h += '<span class="sim-tag" style="cursor:pointer;margin:2px;padding:2px 8px;background:var(--surface2);border-radius:12px;font-size:10px" onclick="document.getElementById(\x27brandSearch\x27).value=\x27'+(b.name||'').replace(/\x27/g,'')+'\x27;filterBrands()">'+(b.name||'')+'</span>'; });
    h += '</div>';
    c.innerHTML = h;
  }
}
function hideSimilarBrands() { var c = document.getElementById('similarBrandsContainer'); if (c) c.innerHTML = ''; }
// ===== END PHASE 3 =====
// ===== M1: BRAND HUB =====
let activeTag = null;
function initM1() {
  // Load industry tree if available
  if (window.INDUSTRY_TREE) {
    renderIndustryTree();
  } else {
    // Fallback: load tags from brands
    var tags = [], seen = {};
    BRANDS.forEach(function (b) { b.industry_tags.forEach(function (t) { if (!seen[t]) { seen[t] = true; tags.push(t) } }) });
    tags.sort();
    var h = '';
    tags.forEach(function (t) { h += '<span class=tag data-tag="' + t + '" onclick=filterByTag("' + t + '")>' + t + '</span>' });
    document.getElementById('tagGroup').innerHTML = h;
  }
  renderBrands(BRANDS);
}

// ===== V5: INDUSTRY TREE =====
function renderIndustryTree() {
  var tree = INDUSTRY_TREE || {};
  var container = document.getElementById('tagGroup'); if(document.getElementById('tagCount')) document.getElementById('tagCount').textContent = Object.keys(tree).reduce(function(s,c){return s+(tree[c].sub_tags||[]).length},0) + ' tags';
  if (!container) return;
  var h = '<div class="tree-container">';
  Object.keys(tree).sort().forEach(function(cat) {
    var catData = tree[cat];
    var subCount = (catData.sub_tags || []).length;
    var brandCount = BRANDS.filter(function(b) {
      return b.industry_tags && b.industry_tags.some(function(t) {
        return catData.sub_tags && catData.sub_tags.indexOf(t) >= 0;
      });
    }).length;
    
    h += '<div class="tree-node">';
    h += '<div class="tree-parent" onclick="toggleTreeNode(this)" data-cat="' + esc(cat) + '">';
    h += '<span class="tree-icon">▸</span>';
    h += '<span>' + esc(cat) + '</span>';
    h += '<span style="font-size:10px;opacity:.4">(' + brandCount + ' brands)</span>';
    h += '</div>';
    h += '<div class="tree-children" id="tree-' + esc(cat).replace(/[^a-zA-Z0-9]/g,'_') + '">';
    
    (catData.sub_tags || []).forEach(function(tag) {
      var tBrands = BRANDS.filter(function(b) {
        return (b.industry_tags || []).indexOf(tag) >= 0;
      });
      h += '<div class="tree-child" data-tag="' + esc(tag) + '" onclick="var t=this.getAttribute(\x27data-tag\x27);filterByTreeTag(t,this)">';
      h += esc(tag);
      h += '<span class="count">' + tBrands.length + '</span>';
      h += '</div>';
    });
    
    h += '</div></div>';
  });
  h += '</div>';
  container.innerHTML = h;
}

function toggleTreeNode(el) {
  el.classList.toggle('expanded');
  var children = el.nextElementSibling;
  if (children) children.classList.toggle('open');
}

function filterBrands() {
  var q = (document.getElementById("brandSearch")?.value || "").toLowerCase();
  var f = BRANDS;
  if (activeTag) {
    f = f.filter(function(b) { return (b.industry_tags || []).indexOf(activeTag) >= 0; });
  }
  if (q) {
    f = f.filter(function(b) { return b.name.toLowerCase().includes(q) || (b.name_cn || "").toLowerCase().includes(q); });
  }
  renderBrands(f);
  var bc = document.getElementById("brandCount");
  if (bc) bc.textContent = f.length + " / " + BRANDS.length + " brands";
  // Highlight matching tree nodes
  if (activeTag) {
    document.querySelectorAll(".tree-child").forEach(function(c) {
      if (c.getAttribute("data-tag") === activeTag) c.classList.add("active");
      else c.classList.remove("active");
    });
  }
}

function filterByTreeTag(tag, el) {
  activeTag = activeTag === tag ? null : tag;
  document.querySelectorAll('.tree-child').forEach(function(c) { c.classList.remove('active') });
  if (activeTag && el) el.classList.add('active');
  document.querySelectorAll('.tree-parent').forEach(function(p) { p.classList.remove('active') });
  filterBrands();
}

// ===== V5: BD INSIGHTS =====


// ===== V5: Enhanced brand rendering with social videos, PR, contacts =====

function filterByTag(t) {
  activeTag = activeTag === t ? null : t;
  document.querySelectorAll("#tagGroup .tag").forEach(function(e) {
    e.classList.toggle("active", e.dataset.tag === activeTag);
  });
  filterBrands();
}

function renderBrandsV5(brands) {
  // Show ALL brands (no slice limit)
  brands = brands || BRANDS;
  var container = document.getElementById("brandList");
  if (!container) return;
  if (!brands.length) {
    container.innerHTML = "<div class='card' style='text-align:center;padding:40px;opacity:.5'>No matching brands</div>";
    return;
  }
  var h = "";
  brands.forEach(function(b) {
    var sf = (b.overseas_presence || {}).social_followers || {};
    var ytK = ((sf.youtube || 0)/1000).toFixed(0);
    var igK = ((sf.instagram || 0)/1000).toFixed(0);
    var tkK = ((sf.tiktok || 0)/1000).toFixed(0);
    var rev = b.estimated_annual_revenue || "N/A";
    var users = b.user_base || "N/A";
    var tags = (b.industry_tags || []).slice(0,4);
    
    h += "<div class='brand-card'>";
    h += "<div class='brand-card-main'>";
    h += "<div class='brand-card-header'>";
    h += "<div><div class='brand-card-name'>" + esc(b.name) + " <span class='brand-card-name-cn'>" + esc(b.name_cn || "") + "</span></div>";
    h += "<div class='brand-card-tags'>";
    tags.forEach(function(t) { h += "<span class='brand-tag'>" + esc(t) + "</span>"; });
    h += "</div></div>";
    h += "<div class='brand-card-rev'><div class='rev-value'>" + esc(rev) + "</div><div class='rev-users'>" + esc(users) + "</div></div>";
    h += "</div>";
    // Social + links row
    h += "<div class='brand-card-metrics'>";
    h += "<span>YouTube " + ytK + "K</span>";
    h += "<span>Instagram " + igK + "K</span>";
    h += "<span>TikTok " + tkK + "K</span>";
    if (b.website) h += "<a href='" + esc(b.website) + "' target='_blank' class='brand-link'>Website</a>";
    if (b.amazon_store) h += "<a href='" + esc(b.amazon_store) + "' target='_blank' class='brand-link'>Amazon</a>";
    if (b.contact_emails) h += "<span class='brand-emails'>" + esc(b.contact_emails) + "</span>";
    h += "</div>";
    h += "</div></div>";
  });
  container.innerHTML = h;
  var bc = document.getElementById("brandCount");
  if (bc) bc.textContent = brands.length + " / " + BRANDS.length + " brands";
}

function toggleBrandExpanded(id) {
  var body = document.getElementById('beb-' + id);
  if (body) body.classList.toggle('open');
}

function switchPlatformTab(el, brandId, tab) {
  // brandId and tab are now passed directly from data attributes
  if (typeof brandId === "object") { var tmp = brandId; brandId = tmp.getAttribute ? tmp.getAttribute("data-bid") : String(tmp); }
  if (typeof tab === "object") { tab = tab.getAttribute ? tab.getAttribute("data-plat") : String(tab); }
  // Update active tab
  el.parentElement.querySelectorAll('.platform-tab').forEach(function(t) { t.classList.remove('active') });
  el.classList.add('active');
  
  // Hide all panels
  ['youtube','instagram','tiktok'].forEach(function(p) {
    var v = document.getElementById('videos-' + brandId + '-' + p);
    if (v) v.style.display = 'none';
  });
  var pr = document.getElementById('pr-' + brandId);
  var ct = document.getElementById('contacts-' + brandId);
  var bd = document.getElementById('bd-' + brandId);
  if (pr) pr.style.display = 'none';
  if (ct) ct.style.display = 'none';
  if (bd) bd.style.display = 'none';
  
  // Show selected
  if (tab === 'pr' && pr) pr.style.display = 'block';
  else if (tab === 'contacts' && ct) ct.style.display = 'block';
  else if (tab === 'bd' && bd) bd.style.display = 'block';
  else {
    var v = document.getElementById('videos-' + brandId + '-' + tab);
    if (v) v.style.display = 'grid';
  }
}

// Override renderBrands to use V5
function renderBrands(brands) { renderBrandsV5(brands); }



function toggleBrandDetail(id){
  var el=document.getElementById(id);
  if(el)el.classList.toggle("open");
}

function copyEmail(email){
  navigator.clipboard.writeText(email).then(function(){toast("已复制: "+email)});
}

// Brand enrichment with token tracking
async function searchNewBrand() {
  var q = (document.getElementById('brandSearch')?.value || '').trim();
  if (!q) { toast('Enter brand name', 'error'); return }
  var a = document.getElementById('brandEnrichArea');
  a.innerHTML = '<div class=brand-enrich>Searching: ' + q + '...</div>';
  try {
    var r = await fetch(DS_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DS_KEY },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: 'You are a brand data analyst. Output JSON only.' }, { role: 'user', content: 'Provide data for brand "' + q + '" as JSON with fields: name, name_cn, industry_tags, market, estimated_annual_revenue, user_base, amazon_rating, youtube_followers, instagram_followers, tiktok_followers, brand_search_volume_monthly, total_posts, avg_engagement_rate, avg_views_per_post, top_platform, creative_angles, top_products_featured' }], temperature: 0.3, max_tokens: 600 })
    });
    if (!r.ok) throw new Error('API:' + r.status);
    var d = await r.json();
    var usage = d.usage || {};
    trackTokenUsage('deepseek-chat', 'brand_enrich', usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0);
    var t = d.choices[0].message.content;
    if (t.includes('```')) t = t.split('```')[1].replace(/json\n?/, '') || t;
    var bd = JSON.parse(t);
    var nb = { id: 'cust_' + Date.now(), name: bd.name || q, name_cn: bd.name_cn || '', industry_tags: bd.industry_tags || ['Other'], market: bd.market || 'global', estimated_annual_revenue: bd.estimated_annual_revenue || '$100M+', user_base: bd.user_base || '', overseas_presence: { amazon_rating: bd.amazon_rating || 4.0, social_followers: { youtube: bd.youtube_followers || 0, instagram: bd.instagram_followers || 0, tiktok: bd.tiktok_followers || 0 }, brand_search_volume_monthly: bd.brand_search_volume_monthly || 0 }, social_content_monthly: { total_posts: bd.total_posts || 0, creative_angles: bd.creative_angles || [], top_products_featured: bd.top_products_featured || [], last_12_months: { avg_engagement_rate: bd.avg_engagement_rate || '3.0%', avg_views_per_post: bd.avg_views_per_post || 0, top_platform: bd.top_platform || 'YouTube' } }, case_study_available: false };
    BRANDS.unshift(nb); renderBrands([nb]); try { var sd={name:nb.name,name_cn:nb.name_cn,industry_tags:nb.industry_tags,market:nb.market,estimated_annual_revenue:nb.estimated_annual_revenue,user_base:nb.user_base,amazon_rating:(nb.overseas_presence||{}).amazon_rating,youtube_followers:(nb.overseas_presence||{}).social_followers?nb.overseas_presence.social_followers.youtube:0,instagram_followers:(nb.overseas_presence||{}).social_followers?nb.overseas_presence.social_followers.instagram:0,tiktok_followers:(nb.overseas_presence||{}).social_followers?nb.overseas_presence.social_followers.tiktok:0,search_volume_monthly:(nb.overseas_presence||{}).brand_search_volume_monthly,monthly_posts:(nb.social_content_monthly||{}).total_posts,avg_engagement:(nb.social_content_monthly||{}).last_12_months?nb.social_content_monthly.last_12_months.avg_engagement_rate:'',avg_views:(nb.social_content_monthly||{}).last_12_months?nb.social_content_monthly.last_12_months.avg_views_per_post:0,top_platform:(nb.social_content_monthly||{}).last_12_months?nb.social_content_monthly.last_12_months.top_platform:'',creative_angles:nb.social_content_monthly?nb.social_content_monthly.creative_angles:[],top_products:nb.social_content_monthly?nb.social_content_monthly.top_products_featured:[]}; apiFetch('/brands',{method:'POST',body:JSON.stringify(sd)}); } catch(e) {}
    document.getElementById('brandCount').textContent = BRANDS.length + ' brands';
    a.innerHTML = '<div class=brand-enrich>✅ Enriched: ' + nb.name + ' · ' + nb.industry_tags.join(' · ') + ' · ' + nb.estimated_annual_revenue + '</div>';
    toast('Brand enriched: ' + nb.name)
  } catch (e) { a.innerHTML = '<div class=brand-enrich>❌ Failed: ' + e.message + '</div>' }
}

async function trackTokenUsage(model, endpoint, prompt, completion, total) {
  try {
    await apiFetch('/token-usage', { method: 'POST', body: JSON.stringify({ model, endpoint, prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }) })
  } catch (e) { }
}

// ===== M2: STRATEGY (unchanged from v3) =====
function updateStrategy() {
  var s = document.getElementById('s_stage')?.value, i = document.getElementById('s_industry')?.value;
  var b = document.getElementById('s_budget')?.value, g = document.getElementById('s_goal')?.value;
  if (!s || !i || !b || !g) { document.getElementById('strategyOut').classList.add('hidden'); return }
  var sm = { new: { n: 'New Brand', f: 'Build awareness, get first users', r: 'High', t: '3-6 months' }, growing: { n: 'Growing', f: 'Scale verified channels', r: 'Medium', t: 'Continuous' }, established: { n: 'Established', f: 'Refined ops, build moat', r: 'Low', t: 'Annual' }, launch: { n: 'Product Launch', f: 'Fast product awareness', r: 'Med-High', t: '1mo warmup + 2mo scale' } };
  var st = sm[s] || sm.new;
  var bl = b === 'low' ? '$5K-15K/mo' : b === 'mid' ? '$15K-50K/mo' : '$50K-150K+/mo';
  var mb = BRANDS.filter(function (b) { return b.industry_tags.includes(i) });
  document.getElementById('strategyOut').classList.remove('hidden');
  var h = '<div class="grid grid-3" style="margin-bottom:16px"><div class=stat><div class=stat-value style=font-size:18px>' + st.n + '</div><div class=stat-label>Profile</div></div><div class=stat><div class=stat-value style=font-size:18px>' + bl + '</div><div class=stat-label>Budget</div></div><div class=stat><div class=stat-value style=font-size:18px>' + st.r + '</div><div class=stat-label>Risk</div></div></div>';
  h += '<h3>💡 Client Thinking</h3><div style="background:var(--surface2);border-radius:8px;padding:14px;margin-bottom:14px"><ul style="font-size:12px;padding-left:18px;opacity:.7">';
  if (s === 'new') h += '<li>"How much to spend? When to see results?"</li><li>"Does my product have overseas market?"</li>';
  else if (s === 'growing') h += '<li>"How to scale?"</li><li>"What are competitors doing?"</li>';
  else if (s === 'established') h += '<li>"How to build moat?"</li><li>"Blue ocean opportunities?"</li>';
  else h += '<li>"Fast launch strategy?"</li><li>"Big or small KOL?"</li>';
  h += '</ul></div>';
  h += '<h3>🎯 Strategy</h3><table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px"><tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:8px;opacity:.5">Dimension</th><th style="text-align:left;padding:8px;opacity:.5">Recommendation</th></tr>';
  h += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px;font-weight:600">Platform</td><td style="padding:8px">' + (g.indexOf('conversion') >= 0 ? 'YouTube(50%)+TikTok(30%)+Instagram(20%)' : 'YouTube(40%)+TikTok(40%)+Instagram(20%)') + '</td></tr>';
  h += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px;font-weight:600">Tiers</td><td style="padding:8px">' + (b === 'low' ? 'Nano/Micro (80%), Mid (20%)' : 'Nano(40%), Micro(35%), Mid(20%), Macro(5%)') + '</td></tr>';
  h += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px;font-weight:600">Budget</td><td style="padding:8px">60% influencer + 30% amplify + 10% test</td></tr>';
  h += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px;font-weight:600">Timeline</td><td style="padding:8px">' + st.t + '</td></tr>';
  h += '<tr><td style="padding:8px;font-weight:600">KPIs</td><td style="padding:8px">Engagement ≥3%, CPM<$45, ROI≥3:1</td></tr></table>';
  h += '<h3>📊 Industry Benchmarks</h3>';
  if (mb.length) { h += '<p style="font-size:12px;opacity:.7;margin-bottom:8px">[' + i + '] ' + mb.length + ' brands</p><div style="display:flex;flex-wrap:wrap;gap:8px">'; mb.slice(0, 8).forEach(function (b) { h += '<div style="background:var(--surface2);padding:8px 14px;border-radius:8px;font-size:11px"><strong>' + b.name + '</strong> ' + (b.name_cn || '') + '<br><span style=opacity:.5>' + b.estimated_annual_revenue + '</span></div>' }); h += '</div>' }
  else h += '<p style=opacity:.5>No brands tracked</p>';
  h += '<h3 style="margin-top:14px">⚠️ Notes</h3><ul style="font-size:12px;padding-left:18px"><li>Long-term = 40-50% higher ROI</li><li>Secure content usage rights</li>' + (b === 'low' ? '<li>Focus on single platform (YouTube recommended)</li>' : '') + '</ul>';
  document.getElementById('strategyContent').innerHTML = h
}



// ===== M3: DEMAND & PROPOSAL =====
function initM3() {
  var c = document.getElementById('tmplSelect');
  if (!c || !TEMPLATES.length) return;
  var h = "";
  for (var ti = 0; ti < TEMPLATES.length; ti++) {
    var t = TEMPLATES[ti];
    h += '<div class="card" style="cursor:pointer;padding:14px" id="tcard-' + t.id + '" onclick="selTmpl(' + "'" + t.id + "'" + ')"><h3 style="font-size:14px">' + t.name + '</h3><p style="font-size:11px;opacity:.6;margin:6px 0">' + t.description + '</p></div>';
  }
  c.innerHTML = h;
}
function goAnalyze() {
  var brand = gv("d_brand"), product = gv("d_product"), usp = gv("d_usp");
  if (!brand || !product || !usp) { toast("请至少填写品牌、产品、USP", "error"); return; }
  curDemand = { brand: brand, company: gv("d_company"), product: product, usp: usp, budget: gv("d_budget"), platform: gv("d_platform"), area: gv("d_area"), category: gv("d_category"), competitors: gv("d_competitors"), notes: gv("d_notes") };
  document.getElementById("analysisResult").innerHTML = "<table style='width:100%;font-size:12px'><tr><td><strong>品牌:</strong> " + esc(brand) + "</td><td><strong>产品:</strong> " + esc(product) + "</td></tr><tr><td><strong>卖点:</strong> " + esc(usp) + "</td><td><strong>预算:</strong> " + (curDemand.budget || "待定") + "</td></tr></table>";
  document.getElementById("m3s1").classList.add("hidden");
  document.getElementById("m3s2").classList.remove("hidden");
  updSteps(2);
}
function goGenerate() { document.getElementById("m3s2").classList.add("hidden"); document.getElementById("m3s3").classList.remove("hidden"); updSteps(3); initM3(); }
function updSteps(n) { for (var i = 1; i <= 3; i++) { var el = document.getElementById("step" + i); if (el) { el.classList.remove("active", "done"); if (i < n) el.classList.add("done"); if (i === n) el.classList.add("active"); } } }
function selTmpl(id) { selTpl = id; }
function generateProposal() {
  if (!curDemand) { toast("请先完成需求分析", "error"); return; }
  if (!selTpl) { toast("请选择方案模板", "error"); return; }
  var tpl = TEMPLATES.find(function(t) { return t.id === selTpl; });
  if (!tpl) return;
  var nl = "\n"; var h = "# " + (curDemand.brand || "品牌") + " 红人营销方案" + nl + nl + "**TuringMarket 图灵集市**" + nl + nl + "## 客户需求" + nl + "- 品牌: " + (curDemand.brand || "") + nl + "- 产品: " + (curDemand.product || "") + nl + "- 卖点: " + (curDemand.usp || "") + nl + "- 平台: " + (curDemand.platform || "") + nl + "- 市场: " + (curDemand.area || "") + nl + "- 预算: " + (curDemand.budget || "") + nl + nl + "## 模板: " + tpl.name + nl;
  for (var si = 0; si < tpl.sections.length; si++) { h += (si + 1) + ". " + tpl.sections[si] + nl; }
  lastProp = h;
  var displayH = h.replace(/&/g,"&amp;").replace(/</g,"&lt;");
  document.getElementById("propResult").innerHTML = '<div class="card"><h3>✅ 方案已生成</h3><pre style="font-size:12px;max-height:300px;overflow-y:auto;background:var(--surface2);padding:12px;border-radius:8px;white-space:pre-wrap">' + displayH + '</pre><div class="btn-group"><button class="btn btn-primary btn-sm" onclick="downloadProposal()">📥 下载 MD</button><button class="btn btn-sm" onclick="copyProposal()">📋 复制</button></div></div>';
  toast("方案已生成");
}
function downloadProposal() { if (lastProp) dlFile((curDemand ? curDemand.brand : "proposal") + "_proposal.md", lastProp, "text/markdown"); }
function copyProposal() { if (lastProp) { try { navigator.clipboard.writeText(lastProp); toast("已复制"); } catch(e) {} } }

// ===== HTML PPT GENERATION (reveal.js) =====
var lastPPT="";
;


function escapeHTML(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}



function switchTab(id) { document.querySelectorAll('#tabBar .tab').forEach(function (t) { t.classList.remove('active') }); var tabEl = document.querySelector('[data-tab="' + id + '"]'); if (tabEl) tabEl.classList.add('active'); var t1=document.getElementById('tab1-content');var t2=document.getElementById('tab2-content');var t3=document.getElementById('tab3-content');if(t1)t1.classList.toggle('hidden',id!=='tab1');if(t2)t2.classList.toggle('hidden',id!=='tab2');if(t3)t3.classList.toggle('hidden',id!=='tab3') }
// ===== M4: INFLUENCER MATCHING (API-driven) =====
lastMatch = []; var lastInfAPI = [];

async function initM4() {
  await loadInfluencersFromAPI();
  renderInfTable(lastMatch);
  await loadCollaborations();
  var cnt = document.getElementById('m4InfCount');
  if (cnt) cnt.textContent = lastInfAPI.length + ' influencers in database · 智能匹配 · 合作追踪';
}

async function loadInfluencersFromAPI() {
  var search = document.getElementById('filt_search')?.value || '';
  var platform = document.getElementById('filt_platform')?.value || '';
  var category = document.getElementById('filt_category')?.value || '';
  var region = document.getElementById('filt_region')?.value || '';
  var sort = document.getElementById('filt_sort')?.value || 'followers';
  var qs = '?sort_by=' + sort;
  if (search) qs += '&search=' + encodeURIComponent(search);
  if (platform) qs += '&platform=' + encodeURIComponent(platform);
  if (category) qs += '&category=' + encodeURIComponent(category);
  if (region) qs += '&region=' + encodeURIComponent(region);
  try {
    var r = await apiFetch('/influencers' + qs);
    var d = await r.json();
    lastInfAPI = d.influencers || [];
    lastMatch = lastInfAPI;
    return lastInfAPI;
  } catch (e) { console.error(e); lastInfAPI = []; lastMatch = []; return []; }
}

function matchInfluencers() {
  var c = document.getElementById('infTableContainer');
  c.innerHTML = '<p style=\"text-align:center;padding:30px;opacity:.5\">Loading...</p>';
  loadInfluencersFromAPI().then(function (data) { renderInfTable(data); });
}

async function smartMatch() {
  var c = document.getElementById('infTableContainer');
  c.innerHTML = '<p style=\"text-align:center;padding:30px;opacity:.5\">智能匹配中...</p>';
  var body = {};
  var cat = document.getElementById('filt_category')?.value;
  var plat = document.getElementById('filt_platform')?.value;
  var region = document.getElementById('filt_region')?.value;
  if (cat) body.category = cat;
  if (plat) body.platform = plat;
  if (region) body.region = region;
  try {
    var r = await apiFetch('/influencers/match', { method: 'POST', body: JSON.stringify(body) });
    var d = await r.json();
    lastMatch = d.matches || [];
    renderInfTable(d.matches || [], true);
    toast('Smart matched ' + (d.matches || []).length + ' influencers');
  } catch (e) {
    c.innerHTML = '<p style=\"text-align:center;padding:30px;opacity:.5\">Match failed: ' + e.message + '</p>';
  }
}

function renderInfTable(data, showScore) {
  var c = document.getElementById('infTableContainer');
  if (!data || !data.length) { c.innerHTML = '<p style=\"text-align:center;padding:30px;opacity:.5\">No influencers found</p>'; return; }
  var h = '<table class=\"influencer-table\"><thead><tr><th><input type=\"checkbox\" onclick=\"toggleAll(this)\"></th><th>#</th><th>网红</th><th>Platform</th><th>Followers</th><th>Engagement</th><th>Region</th><th>Category</th><th>Cost(USD)</th><th>CPM</th>' + (showScore ? '<th>Match</th>' : '') + '<th>操作</th></tr></thead><tbody>';
  data.forEach(function(inf, i) {
    h += '<tr><td><input type=\"checkbox\" class=\"infcb\" data-idx=\"' + i + '\"></td><td>' + (i + 1) + '</td>';
    h += '<td><strong>' + esc(inf.kol_handle || '') + '</strong><br><span style=\"font-size:10px;opacity:.6\">' + esc(inf.content_style || '') + '</span></td>';
    h += '<td>' + esc(inf.platform || '-') + '</td>';
    h += '<td>' + ((inf.followers || 0) >= 1000 ? ((inf.followers / 1000).toFixed(0) + 'K') : (inf.followers || 0)) + '</td>';
    h += '<td>' + (inf.avg_engagement ? (inf.avg_engagement.toFixed(1) + '%') : '-') + '</td>';
    h += '<td>' + esc(inf.region || '-') + '</td>';
    h += '<td>' + esc(inf.category || '-') + '</td>';
    h += '<td>\$' + (inf.cost_usd || 0) + '</td>';
    h += '<td>' + (inf.cpm || '-') + '</td>';
    if (showScore) h += '<td><span style=\"font-weight:700;color:var(--green)\">' + (inf.match_score || 0) + '</span></td>';
    h += '<td><button class=\"btn btn-sm\" onclick=\"startCollab(' + inf.id + ')\">合作</button></td></tr>';
  });
  h += '</tbody></table>';
  c.innerHTML = h;
  var cnt = document.getElementById('m4InfCount');
  if (cnt) cnt.textContent = data.length + ' results · 智能匹配 · 合作追踪';
}

// ===== COLLABORATION TRACKING =====
async function loadCollaborations(status) {
  var filterEl = document.getElementById('collabFilter');
  var s = status || (filterEl ? filterEl.value : '');
  try {
    var qs = s ? '?status=' + encodeURIComponent(s) : '';
    var r = await apiFetch('/collaborations' + qs);
    var d = await r.json();
    var cs = d.collaborations || [];
    renderCollabTable(cs);
    var st = document.getElementById('collabStatsBar');
    if (st) {
      var counts = {}; cs.forEach(function(c) { counts[c.status] = (counts[c.status] || 0) + 1; });
      var labels = { proposed: '提案中', contacted: '已建联', negotiating: '谈判中', confirmed: '已确认', contract_sent: '合同已发', live: '合作中', content_review: '审核中', completed: '已完成', cancelled: '已取消' };
      st.innerHTML = Object.keys(counts).map(function(k) { return '<span style=\"font-size:11px;background:var(--surface2);padding:4px 10px;border-radius:20px\">' + (labels[k] || k) + ': <strong>' + counts[k] + '</strong></span>'; }).join('');
    }
  } catch (e) {
    document.getElementById('execTableContainer').innerHTML = '<p style=\"text-align:center;padding:30px;opacity:.5\">加载失败: ' + e.message + '</p>';
  }
}

function renderCollabTable(data) {
  var c = document.getElementById('execTableContainer');
  c.innerHTML = '<div id=\"execTableArea\"></div>';
  var area = document.getElementById('execTableArea');
  if (!data || !data.length) { area.innerHTML = '<p style=\"text-align:center;padding:30px;opacity:.5\">暂无合作记录</p>'; return; }
  var STATUS_LABELS = { proposed: '提案中', contacted: '已建联', negotiating: '谈判中', confirmed: '已确认', contract_sent: '合同已发', live: '合作中', content_review: '审核中', completed: '已完成', cancelled: '已取消' };
  var h = '<table><thead><tr><th>网红</th><th>Platform</th><th>Followers</th><th>状态</th><th>报价</th><th>备注</th><th>更新</th><th>操作</th></tr></thead><tbody>';
  data.forEach(function(collab) {
    h += '<tr><td><strong>' + esc(collab.kol_handle || '') + '</strong></td>';
    h += '<td>' + esc(collab.platform || '-') + '</td>';
    h += '<td>' + ((collab.followers || 0) >= 1000 ? ((collab.followers / 1000).toFixed(0) + 'K') : (collab.followers || 0)) + '</td>';
    h += '<td><select id=\"st_' + collab.id + '\" onchange=\"updateCollabStatus(' + collab.id + ')\" style=\"width:auto;font-size:11px\">';
    Object.keys(STATUS_LABELS).forEach(function(k) { h += '<option value=\"' + k + '\"' + (collab.status === k ? ' selected' : '') + '>' + STATUS_LABELS[k] + '</option>'; });
    h += '</select></td>';
    h += '<td>\$' + (collab.cost_quoted || 0) + '</td>';
    h += '<td style=\"max-width:120px;font-size:10px\">' + esc(collab.notes || '-') + '</td>';
    h += '<td style=\"font-size:9px;opacity:.5\">' + (collab.updated_at ? collab.updated_at.substring(0, 16) : '-') + '</td>';
    h += '<td><button class=\"btn btn-sm\" onclick=\"updateCollabStatus(' + collab.id + ')\">保存</button></td></tr>';
  });
  h += '</tbody></table>';
  area.innerHTML = h;
}

async function startCollab(infId) {
  var notes = prompt('合作备注（可选）：');
  if (notes === null) return;
  try {
    var r = await apiFetch('/collaborations', { method: 'POST', body: JSON.stringify({ influencer_id: infId, notes: notes || '' }) });
    if (!r.ok) throw new Error(await r.text());
    var d = await r.json();
    toast('Collaboration started: #' + d.id);
    switchTab('tab2');
    loadCollaborations();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function updateCollabStatus(collabId) {
  var sel = document.getElementById('st_' + collabId);
  if (!sel) return;
  var newStatus = sel.value;
  try {
    var r = await apiFetch('/collaborations/' + collabId, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
    if (!r.ok) throw new Error(await r.text());
    toast('Status updated to: ' + newStatus);
    loadCollaborations(newStatus);
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

// ===== KEEP: legacy upload support =====
function handleUpload(e) {
  var f = e.target.files[0]; if (!f) return;
  var s = document.getElementById('uploadOK');
  var ext = f.name.split('.').pop().toLowerCase();
  if (['csv', 'json', 'xls', 'xlsx'].indexOf(ext) === -1) {
    s.innerHTML = '<span style=\"color:#d94641\">不支持 .' + ext + ' 格式，请上传 CSV/JSON/XLS/XLSX</span>';
    return;
  }
  s.innerHTML = '<span>正在读取: ' + f.name + ' (' + (f.size / 1024).toFixed(1) + 'KB)...</span>';
  var r = new FileReader();
  if (ext === 'json') {
    r.onload = function(ev) {
      try {
        var d = JSON.parse(ev.target.result);
        var inf = Array.isArray(d) ? d : (d.influencers || d.data || []);
        if (inf.length) { INFLUENCERS = inf; s.innerHTML = '<span style=\"color:#0f7b3c\">' + inf.length + ' 位网红已加载</span>'; matchInfluencers(); showInfPreview(inf); }
        else { s.innerHTML = '<span style=\"color:#d94641\">未找到网红数据</span>'; }
      } catch (err) { s.innerHTML = '<span style=\"color:#d94641\">JSON 解析失败: ' + err.message + '</span>'; }
    };
    r.readAsText(f);
  } else {
    r.onload = function(ev) {
      var txt = ev.target.result || '';
      if (!txt.trim()) { s.innerHTML = '<span style=\"color:#d94641\">文件为空</span>'; return; }
      var rows = txt.split('\n').filter(function(l) { return l.trim(); });
      var headers = rows[0].split(/[,\t;]/).map(function(h) { return h.trim().replace(/"/g, '').replace(/^\uFEFF/, ''); });
      var inf = rows.slice(1).map(function(row) {
        var vals = row.match(/(".*?"|[^',\t\s;]+)(?=\s*[,;\t]|\s*$)/g) || row.split(/[,\t;]/);
        var o = {};
        headers.forEach(function(h, i) { o[h] = vals[i] ? vals[i].trim().replace(/^'|'$/g, '') : ''; });
        return o;
      }).filter(function(o) { return o.kol_handle || o.name || o.Name || o['KOL Handle']; });
      if (inf.length) { INFLUENCERS = inf; s.innerHTML = '<span style=\"color:#0f7b3c\">' + inf.length + ' 位网红已加载</span>'; matchInfluencers(); showInfPreview(inf); }
      else { s.innerHTML = '<span style=\"color:#d94641\">未识别到网红数据，请检查格式</span>'; }
    };
    r.readAsText(f);
  }
}
function showInfPreview(data) {
  var c = document.getElementById('infPreview'); if (!c) return;
  var h = '<table style=\"width:100%;font-size:10px;border-collapse:collapse\"><tr style=\"border-bottom:1px solid var(--border)\">';
  var keys = Object.keys(data[0] || {}).slice(0, 6);
  keys.forEach(function(k) { h += '<th style=\"text-align:left;padding:4px;opacity:.5\">' + esc(k) + '</th>'; });
  h += '</tr>';
  data.slice(0, 5).forEach(function(r) {
    h += '<tr style=\"border-bottom:1px solid var(--border)\">';
    keys.forEach(function(k) { h += '<td style=\"padding:4px;font-size:9px\">' + esc(String(r[k] || '')) + '</td>'; });
    h += '</tr>';
  });
  if (data.length > 5) h += '<tr><td colspan=\"' + keys.length + '\" style=\"padding:4px;opacity:.4;text-align:center\">... 共 ' + data.length + ' 条</td></tr>';
  h += '</table>'; c.innerHTML = h;
}
function downloadInfTemplateJSON() {
  var tpl = [{ kol_handle: '@example_kol', platform: 'YouTube', profile_link: 'https://youtube.com/@example', followers: 50000, region: 'US', category: '3C', avg_views_10: 25000, collab_type: 'Dedicated Video', cost_usd: 2500, cpm: 50 }];
  dlFile('influencer_template.json', JSON.stringify(tpl, null, 2), 'application/json');
}
function downloadInfTemplate() { dlFile('influencer_template.csv', '\uFEFF' + 'kol_handle,platform,profile_link,followers,avg_views_10,category,region,language,collab_type,cost_usd,cpm,content_style,brand_collab_history,contact_email\n@TechReviewPro,YouTube,https://youtube.com/@example,125000,45000,3C,US,EN,Dedicated,2500,55,Reviews,Anker;Ugreen,contact@example.com\n', 'text/csv'); }
function toggleAll(cb) { document.querySelectorAll('.infcb').forEach(function(c) { c.checked = cb.checked; }); }
function exportSubmissionCSV() {
  var chk = [], cbs = document.querySelectorAll('.infcb:checked');
  cbs.forEach(function(c) { chk.push(parseInt(c.dataset.idx)); });
  chk = chk.filter(function(i) { return !isNaN(i); });
  var data = chk.length ? chk.map(function(i) { return lastMatch[i]; }).filter(Boolean) : lastMatch;
  if (!data.length) { toast('No data', 'error'); return; }
  var csv = 'No.,Date,Submitter,Project,Product,Duplicate,KOL Handle,Followers,Link,Platform,Country,Tag,AvgViews10,Cost,Deliverable,TuringNote,Price,Email,CPM,CPV\n';
  data.forEach(function(inf, i) { csv += (i + 1) + ',' + getDate() + ',\"' + (inf.kol_handle || inf.name || '') + '\",' + (inf.followers || 0) + ',\"' + (inf.profile_link || '') + '\",' + inf.platform + ',' + inf.region + ',' + inf.category + ',' + (inf.avg_views_10 || 0) + ',' + inf.collab_type + ',' + (inf.cost_usd || 0) + ',' + (inf.cpm || '') + '\n'; });
  dlFile('influencer_' + getDate() + '.csv', '\uFEFF' + csv, 'text/csv'); toast('Exported ' + data.length);
}
async function sendChat() { var inp = document.getElementById('chatInput'); var msg = inp.value.trim(); if (!msg) return; addChatMsg('user', msg); inp.value = ''; chatHistory.push({ role: 'user', content: msg }); var msgs = document.getElementById('chatMessages'); var td = document.createElement('div'); td.className = 'chat-msg assistant'; td.innerHTML = '<div class=bubble>...</div>'; msgs.appendChild(td); msgs.scrollTop = msgs.scrollHeight; try { var ctx = JSON.stringify({ brandCount: BRANDS.length, sample: BRANDS.slice(0, 10).map(function (b) { return { name: b.name, industry: b.industry_tags.slice(0, 3) } }) }); var systemMsg = { role: 'system', content: chatHistory[0].content + '\n\nDB: ' + ctx }; var allMsgs = [systemMsg]; for (var i = 1; i < chatHistory.length; i++) allMsgs.push(chatHistory[i]); var resp = await fetch(DS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DS_KEY }, body: JSON.stringify({ model: 'deepseek-chat', messages: allMsgs, temperature: 0.7, max_tokens: 1500 }) }); td.remove(); if (!resp.ok) throw new Error('API:' + resp.status); var d = await resp.json(); var usage = d.usage || {}; trackTokenUsage('deepseek-chat', 'ai_chat', usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0); var reply = d.choices[0].message.content; chatHistory.push({ role: 'assistant', content: reply }); addChatMsg('assistant', reply); if (chatHistory.length > 20) chatHistory = [chatHistory[0]].concat(chatHistory.slice(-19)) } catch (e) { td.remove(); addChatMsg('assistant', 'Error: ' + e.message) } }
function addChatMsg(role, content) { var msgs = document.getElementById('chatMessages'); var div = document.createElement('div'); div.className = 'chat-msg ' + role; var formatted = content.replace(/\n/g, '<br>').replace(/```([^`]+)```/g, '<pre>$1</pre>'); div.innerHTML = '<div class=bubble>' + formatted + '</div>'; msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight }
function clearChat() { chatHistory = [chatHistory[0]]; document.getElementById('chatMessages').innerHTML = '<div class="chat-msg assistant"><div class=bubble>Chat cleared. How can I help?</div></div>' }

// ===== FEISHU =====
async function pushToFeishu() {
  var status=document.getElementById("feishuStatus");
  status.innerHTML="<span>Connecting...</span>";
  try {
    var chk=[],cbs=document.querySelectorAll(".infcb:checked");
    cbs.forEach(function(c){chk.push(parseInt(c.dataset.idx))});
    chk=chk.filter(function(i){return !isNaN(i)});
    var data=chk.length?chk.map(function(i){return lastMatch[i]}).filter(Boolean):lastMatch;
    if(!data||!data.length){status.innerHTML="<span>No data selected</span>";return}
    var csv="No.,KOL Handle,Platform,Followers,Category,Region,Collab Type,Cost(USD),CPM"+String.fromCharCode(10);
    data.forEach(function(inf,i){
      var row=[];
      row.push(i+1);
      row.push(inf.kol_handle||inf.name||"");
      row.push(inf.platform||"");
      row.push(inf.followers||0);
      row.push(inf.category||"");
      row.push(inf.region||"");
      row.push(inf.collab_type||"");
      row.push(inf.cost_usd||0);
      row.push(inf.cpm||"-");
      csv+=row.map(function(v){return typeof v=="string"?"\""+v.replace(/\"/g,"\"\"")+"\"":v}).join(",")+String.fromCharCode(10);
    });
    dlFile("KOL_"+getDate()+".csv","\uFEFF"+csv,"text/csv");
    status.innerHTML="<span style=color:#0f7b3c>Exported "+data.length+" influencers to CSV</span>";
    toast("CSV downloaded: "+data.length+" rows");
  } catch(e) {
    status.innerHTML="<span style=color:#d94641>Failed: "+e.message+"</span>";
  }
}

﻿// ===== ADMIN DASHBOARD =====
async function loadAdminDashboard() {
  try {
    var r = await apiFetch("/admin/overview");
    var s = await r.json();
    s = s.stats || s;
    document.getElementById("ad_totalUsers").textContent = s.totalUsers || 0;
    document.getElementById("ad_totalDemands").textContent = s.totalDemands || 0;
    document.getElementById("ad_totalProposals").textContent = s.totalProposals || 0;
    document.getElementById("ad_totalTokens").textContent = ((s.totalTokens || 0) / 1000).toFixed(0) + "K";
    var ur = await apiFetch("/admin/users");
    var ud = await ur.json();
    var userH = "";
    for (var ui = 0; ui < ud.users.length; ui++) {
      var u = ud.users[ui];
      userH += "<tr><td><strong>" + u.username + "</strong></td><td>" + u.display_name + "</td><td>" + (u.department || "-") + "</td><td>" + u.role + "</td><td>" + (u.api_quota || 0).toLocaleString() + "</td><td>" + (u.is_active ? "✅" : "❌") + "</td><td><button class='btn btn-sm' onclick='adminResetPw(" + u.id + ")'>重置密码</button></td></tr>";
    }
    document.getElementById("ad_userTableBody").innerHTML = userH;
    var tu = s.tokenUsageTrend || [];
    var tokenH = "<div style='font-size:12px;margin-bottom:8px;opacity:.5'>最近30天</div>";
    for (var ti = 0; ti < Math.min(tu.length, 7); ti++) {
      tokenH += "<div style='display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px'><span>" + tu[ti].date + "</span><span style=font-weight:600>" + ((tu[ti].tokens || 0) / 1000).toFixed(0) + "K</span></div>";
    }
    document.getElementById("ad_tokenRank").innerHTML = tokenH;
    var actH = "";
    for (var ai = 0; ai < Math.min((s.recentActivity || []).length, 30); ai++) {
      var a = s.recentActivity[ai];
      actH += "<div style='display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px'><span><strong>" + a.display_name + "</strong> " + a.action + "</span><span style=opacity:.5>" + (a.created_at ? a.created_at.substring(11, 16) : "") + "</span></div>";
    }
    document.getElementById("ad_recentActivity").innerHTML = actH || "<p style=opacity:.5>No activity yet</p>";
  } catch(e) { console.error("Admin load error:", e); }
}
async function adminResetPw(userId) { try { await apiFetch("/admin/users/reset-password/" + userId, { method: "POST" }); toast("Password reset to: turing2026"); } catch(e) { toast("Failed: " + e.message, "error"); } }
async function adminAddUser(){var u=prompt("Username:");if(!u)return;var d=prompt("Display name:");if(!d)return;var p=prompt("Department:")||"General";try{await apiFetch("/admin/users",{method:"POST",body:JSON.stringify({username:u,display_name:d,department:p,password:"turing2026"})});loadAdminUsers();toast("User "+u+" created");}catch(e){toast("Failed","error")}}

async function adminCreateInvite() { try { var r = await apiFetch("/admin/invites", { method: "POST" }); var d = await r.json(); document.getElementById("ad_inviteResult").textContent = "邀请码: " + d.code + " (7天有效)"; toast("Invite code: " + d.code); } catch(e) { toast("Failed: " + e.message, "error"); } }


// ===== ADMIN DASHBOARD =====
async function loadAdminDashboard() {
  try {
    var r = await apiFetch("/admin/overview");
    var s = await r.json();
    s = s.stats || s;
    document.getElementById("ad_totalUsers").textContent = s.totalUsers || 0;
    document.getElementById("ad_totalDemands").textContent = s.totalDemands || 0;
    document.getElementById("ad_totalProposals").textContent = s.totalProposals || 0;
    document.getElementById("ad_totalTokens").textContent = ((s.totalTokens || 0) / 1000).toFixed(0) + "K";
    var ur = await apiFetch("/admin/users");
    var ud = await ur.json();
    var userH = "";
    for (var ui = 0; ui < ud.users.length; ui++) {
      var u = ud.users[ui];
      userH += "<tr><td><strong>" + u.username + "</strong></td><td>" + u.display_name + "</td><td>" + (u.department || "-") + "</td><td>" + u.role + "</td><td>" + (u.api_quota || 0).toLocaleString() + "</td><td>" + (u.is_active ? "✅" : "❌") + "</td><td><button class='btn btn-sm' onclick='adminResetPw(" + u.id + ")'>重置密码</button></td></tr>";
    }
    document.getElementById("ad_userTableBody").innerHTML = userH;
  } catch(e) { console.error("Admin load error:", e); }
}
async function adminResetPw(userId) { try { await apiFetch("/admin/users/reset-password/" + userId, { method: "POST" }); toast("Password reset to: turing2026"); } catch(e) { toast("Failed: " + e.message, "error"); } }
async function adminCreateInvite() { try { var r = await apiFetch("/admin/invites", { method: "POST" }); var d = await r.json(); document.getElementById("ad_inviteResult").textContent = "邀请码: " + d.code + " (7天有效)"; toast("Invite code: " + d.code); } catch(e) { toast("Failed: " + e.message, "error"); } }

// ===== LOGOUT BUTTON (add to sidebar) =====
(function () {
  var footer = document.querySelector('.sidebar-footer');
  if (footer) {
    footer.innerHTML = '<a href="#" onclick="doLogout()" style="color:var(--text2);font-size:10px">🚪 退出登录</a> · <span id="sidebarUser" style="font-size:10px;opacity:.5"></span>';
  }
})();

// ==========================================
// WORKFLOW ENGINE - Frontend Module
// ==========================================

// ---- API Helper ----
function wfApi(path, method, body) {
  return fetch(API + '/workflow' + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH_TOKEN },
    body: body ? JSON.stringify(body) : undefined
  }).then(function(r) { return r.json(); });
}

// ---- State ----
var wfState = {
  templateId: null,
  nodes: [],
  edges: [],
  selectedNode: null,
  selectedEdge: null,
  nodeCounter: 0,
  connectingFrom: null,
  history: [],
  historyIndex: -1
};

// ---- Designer Init ----
function initWorkflowDesigner() {
  var canvas = document.getElementById('wf-svg-canvas');
  if (!canvas) return;

  var wrapper = document.getElementById('wf-canvas-wrapper');

  canvas.addEventListener('dragover', function(e) { e.preventDefault(); });
  canvas.addEventListener('drop', function(e) {
    e.preventDefault();
    var type = e.dataTransfer.getData('text/plain');
    if (!type) return;
    var rect = canvas.getBoundingClientRect();
    wfAddNode(type, e.clientX - rect.left, e.clientY - rect.top);
  });

  // Palette drag
  var palettes = document.querySelectorAll('.wf-node-palette');
  for (var p = 0; p < palettes.length; p++) {
    palettes[p].addEventListener('dragstart', function(e) {
      e.dataTransfer.setData('text/plain', this.dataset.type);
    });
  }

  // Canvas click - deselect
  canvas.addEventListener('click', function(e) {
    if (e.target === canvas || e.target.id === 'wf-edges-layer' || e.target.id === 'wf-nodes-layer') {
      wfDeselectAll();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    var designerPage = document.getElementById('page-workflow-designer');
    if (!designerPage || designerPage.style.display === 'none') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      wfDeleteSelected();
    }
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); wfUndo(); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); wfRedo(); }
  });
}

// ---- Node Management ----
function wfAddNode(type, x, y) {
  var nodeId = 'node_' + (++wfState.nodeCounter);
  var labels = { start: '开始', end: '结束', approval: '审批', task: '任务',
    condition: '条件', parallel: '并行', timer: '定时',
    webhook: 'Webhook', auto_action: '自动动作', sub_process: '子流程' };
  var widths = { start: 100, end: 100, approval: 120, task: 120, condition: 100,
    parallel: 100, timer: 100, webhook: 120, auto_action: 120, sub_process: 120 };

  var node = { id: nodeId, type: type, label: labels[type] || type,
    x: x - (widths[type] || 100) / 2, y: y - 30,
    width: widths[type] || 100, height: 60, config: wfDefaultConfig(type) };

  wfSaveState();
  wfState.nodes.push(node);
  wfRenderAll();
  wfSelectNode(nodeId);
}

function wfDefaultConfig(type) {
  switch (type) {
    case 'start': return { trigger: 'manual' };
    case 'approval': return { title: '请审批', assignee_role: 'admin' };
    case 'task': return { title: '请处理', assignee_role: 'user' };
    case 'condition': return { expression: { operator: '==', left: { var: 'data.status' }, right: 'approved' } };
    case 'timer': return { delay_minutes: 60 };
    case 'webhook': return { url: '', method: 'POST', headers: {} };
    case 'auto_action': return { action_type: 'update_field', field: 'status', value: 'processed' };
    case 'sub_process': return { template_id: null };
    default: return {};
  }
}

// ---- SVG Rendering ----
function wfRenderAll() {
  var nodesLayer = document.getElementById('wf-nodes-layer');
  var edgesLayer = document.getElementById('wf-edges-layer');
  var empty = document.getElementById('wf-canvas-empty');
  if (empty) empty.style.display = wfState.nodes.length === 0 ? 'block' : 'none';

  if (nodesLayer) { nodesLayer.innerHTML = '';
    for (var n = 0; n < wfState.nodes.length; n++) wfRenderNode(wfState.nodes[n]); }
  if (edgesLayer) { edgesLayer.innerHTML = '';
    for (var e = 0; e < wfState.edges.length; e++) wfRenderEdge(wfState.edges[e]); }
}

function wfRenderNode(node) {
  var ns = 'http://www.w3.org/2000/svg';
  var g = document.createElementNS(ns, 'g');
  g.setAttribute('class', 'wf-node-svg' + (wfState.selectedNode === node.id ? ' wf-node-selected' : ''));
  g.dataset.nodeId = node.id;

  var isRounded = node.type === 'start' || node.type === 'end';
  var rx = isRounded ? 30 : 6;
  var colors = { start: '#e8f5e9', end: '#fbe9e7', approval: '#fff3e0', task: '#e3f2fd',
    condition: '#f3e5f5', parallel: '#e0f2f1', timer: '#fff8e1',
    webhook: '#fce4ec', auto_action: '#e8eaf6', sub_process: '#f1f8e9' };

  var rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('class', 'wf-node-bg');
  rect.setAttribute('x', node.x); rect.setAttribute('y', node.y);
  rect.setAttribute('width', node.width); rect.setAttribute('height', node.height);
  rect.setAttribute('rx', rx); rect.setAttribute('ry', rx);
  rect.setAttribute('fill', colors[node.type] || '#f5f5f5');
  rect.setAttribute('stroke', '#999'); rect.setAttribute('stroke-width', '1.5');
  g.appendChild(rect);

  var text = document.createElementNS(ns, 'text');
  text.setAttribute('x', node.x + node.width / 2); text.setAttribute('y', node.y + node.height / 2);
  text.setAttribute('text-anchor', 'middle'); text.setAttribute('dominant-baseline', 'middle');
  text.setAttribute('font-size', '13px'); text.setAttribute('fill', '#333');
  text.setAttribute('pointer-events', 'none');
  text.textContent = node.label;
  g.appendChild(text);

  var typeText = document.createElementNS(ns, 'text');
  typeText.setAttribute('x', node.x + node.width / 2); typeText.setAttribute('y', node.y + node.height - 10);
  typeText.setAttribute('text-anchor', 'middle'); typeText.setAttribute('font-size', '9px');
  typeText.setAttribute('fill', '#999'); typeText.setAttribute('pointer-events', 'none');
  typeText.textContent = node.type;
  g.appendChild(typeText);

  // Top anchor
  if (node.type !== 'start') {
    var topA = document.createElementNS(ns, 'circle');
    topA.setAttribute('class', 'wf-anchor'); topA.setAttribute('cx', node.x + node.width / 2);
    topA.setAttribute('cy', node.y); topA.setAttribute('r', '5');
    topA.dataset.anchor = 'input'; topA.dataset.nodeId = node.id;
    g.appendChild(topA);
  }

  // Bottom anchor
  if (node.type !== 'end') {
    var botA = document.createElementNS(ns, 'circle');
    botA.setAttribute('class', 'wf-anchor'); botA.setAttribute('cx', node.x + node.width / 2);
    botA.setAttribute('cy', node.y + node.height); botA.setAttribute('r', '5');
    botA.dataset.anchor = 'output'; botA.dataset.nodeId = node.id;
    g.appendChild(botA);
  }

  // Click
  g.addEventListener('click', function(e) { e.stopPropagation(); wfSelectNode(this.dataset.nodeId); });

  // Drag handlers
  var dragging = false, startX, startY, nodeStartX, nodeStartY;
  g.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('wf-anchor')) return;
    dragging = true; startX = e.clientX; startY = e.clientY;
    nodeStartX = node.x; nodeStartY = node.y;
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    node.x = Math.max(0, nodeStartX + e.clientX - startX);
    node.y = Math.max(0, nodeStartY + e.clientY - startY);
    wfRenderAll();
    if (wfState.selectedNode === node.id) wfSelectNode(node.id);
  });

  document.addEventListener('mouseup', function() {
    if (dragging) { dragging = false; wfSaveState(); }
  });

  // Connection anchors
  var anchors = g.querySelectorAll('.wf-anchor');
  for (var a = 0; a < anchors.length; a++) {
    anchors[a].addEventListener('mousedown', function(e) {
      e.stopPropagation();
      if (this.dataset.anchor === 'output') {
        wfState.connectingFrom = { nodeId: this.dataset.nodeId };
        var line = document.getElementById('wf-connection-line');
        line.setAttribute('x1', this.getAttribute('cx'));
        line.setAttribute('y1', this.getAttribute('cy'));
        line.setAttribute('x2', this.getAttribute('cx'));
        line.setAttribute('y2', this.getAttribute('cy'));
        line.style.display = 'block';
      }
    });
  }

  var nl = document.getElementById('wf-nodes-layer');
  if (nl) nl.appendChild(g);
}

function wfRenderEdge(edge) {
  var fromNode = null, toNode = null;
  for (var i = 0; i < wfState.nodes.length; i++) {
    if (wfState.nodes[i].id === edge.from) fromNode = wfState.nodes[i];
    if (wfState.nodes[i].id === edge.to) toNode = wfState.nodes[i];
  }
  if (!fromNode || !toNode) return;

  var x1 = fromNode.x + fromNode.width / 2;
  var y1 = fromNode.y + fromNode.height;
  var x2 = toNode.x + toNode.width / 2;
  var y2 = toNode.y;
  var cy1 = y1 + Math.abs(y2 - y1) * 0.5;
  var cy2 = y2 - Math.abs(y2 - y1) * 0.5;
  var d = 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + cy1 + ', ' + x2 + ' ' + cy2 + ', ' + x2 + ' ' + y2;

  var ns = 'http://www.w3.org/2000/svg';
  var g = document.createElementNS(ns, 'g');
  g.style.cursor = 'pointer'; g.dataset.edgeId = edge.id;

  var path = document.createElementNS(ns, 'path');
  path.setAttribute('class', 'wf-edge');
  path.setAttribute('d', d);
  path.setAttribute('marker-end', 'url(#arrowhead)');
  if (edge.condition) path.setAttribute('stroke-dasharray', '5,3');
  g.appendChild(path);

  if (edge.label) {
    var label = document.createElementNS(ns, 'text');
    label.setAttribute('class', 'wf-edge-label');
    label.setAttribute('x', (x1 + x2) / 2); label.setAttribute('y', (y1 + y2) / 2 - 10);
    label.setAttribute('text-anchor', 'middle');
    label.textContent = edge.label;
    g.appendChild(label);
  }

  g.addEventListener('click', function(e) { e.stopPropagation(); wfSelectEdge(this.dataset.edgeId); });

  var el = document.getElementById('wf-edges-layer');
  if (el) el.appendChild(g);
}

// ---- Connection Line ----
document.addEventListener('mousemove', function(e) {
  if (!wfState.connectingFrom) return;
  var line = document.getElementById('wf-connection-line');
  if (!line) return;
  var canvas = document.getElementById('wf-svg-canvas');
  if (!canvas) return;
  var rect = canvas.getBoundingClientRect();
  line.setAttribute('x2', e.clientX - rect.left);
  line.setAttribute('y2', e.clientY - rect.top);
});

document.addEventListener('mouseup', function(e) {
  if (!wfState.connectingFrom) return;
  var line = document.getElementById('wf-connection-line');
  if (line) line.style.display = 'none';

  if (e.target.classList.contains('wf-anchor') && e.target.dataset.anchor === 'input') {
    var toNodeId = e.target.dataset.nodeId;
    var fromNodeId = wfState.connectingFrom.nodeId;
    if (fromNodeId !== toNodeId) {
      var exists = false;
      for (var i = 0; i < wfState.edges.length; i++) {
        if (wfState.edges[i].from === fromNodeId && wfState.edges[i].to === toNodeId) { exists = true; break; }
      }
      if (!exists) {
        wfSaveState();
        wfState.edges.push({ id: 'edge_' + Date.now(), from: fromNodeId, to: toNodeId, label: '', condition: null });
        wfRenderAll();
      }
    }
  }
  wfState.connectingFrom = null;
});

// ---- Selection ----
function wfSelectNode(nodeId) { wfState.selectedNode = nodeId; wfState.selectedEdge = null; wfRenderAll(); wfShowNodeProperties(nodeId); }
function wfSelectEdge(edgeId) { wfState.selectedNode = null; wfState.selectedEdge = edgeId; wfRenderAll(); wfShowEdgeProperties(edgeId); }

function wfDeselectAll() {
  wfState.selectedNode = null; wfState.selectedEdge = null; wfRenderAll();
  var pc = document.getElementById('wf-prop-content');
  if (pc) pc.innerHTML = '<p style="color:#999;padding:20px;text-align:center;">点击节点或连线<br>编辑属性</p>';
}

function wfDeleteSelected() {
  if (wfState.selectedNode) {
    wfSaveState();
    var nodeId = wfState.selectedNode;
    wfState.nodes = wfState.nodes.filter(function(n) { return n.id !== nodeId; });
    wfState.edges = wfState.edges.filter(function(e) { return e.from !== nodeId && e.to !== nodeId; });
    wfState.selectedNode = null;
    wfRenderAll();
    wfDeselectAll();
  } else if (wfState.selectedEdge) {
    wfSaveState();
    wfState.edges = wfState.edges.filter(function(e) { return e.id !== wfState.selectedEdge; });
    wfState.selectedEdge = null;
    wfRenderAll();
    wfDeselectAll();
  }
}

// ---- Property Panels ----
function wfShowNodeProperties(nodeId) {
  var node = null;
  for (var i = 0; i < wfState.nodes.length; i++) {
    if (wfState.nodes[i].id === nodeId) { node = wfState.nodes[i]; break; }
  }
  if (!node) return;

  var config = node.config || {};
  var html = '<div class="wf-prop-field"><label>节点ID</label><input value="' + node.id + '" readonly></div>';
  html += '<div class="wf-prop-field"><label>类型</label><input value="' + node.type + '" readonly></div>';
  html += '<div class="wf-prop-field"><label>显示名称</label><input value="' + node.label + '" onchange="wfUpdateNodeProp(\'' + nodeId + '\',\'label\',this.value)"></div>';

  if (node.type === 'approval' || node.type === 'task') {
    html += '<div class="wf-prop-field"><label>标题</label><input value="' + (config.title || '') + '" onchange="wfUpdateNodeConfig(\'' + nodeId + '\',\'title\',this.value)"></div>';
    html += '<div class="wf-prop-field"><label>负责人角色</label><select onchange="wfUpdateNodeConfig(\'' + nodeId + '\',\'assignee_role\',this.value)">'
      + '<option value="user"' + (config.assignee_role === 'user' ? ' selected' : '') + '>普通用户</option>'
      + '<option value="admin"' + (config.assignee_role === 'admin' ? ' selected' : '') + '>管理员</option></select></div>';
  }

  if (node.type === 'condition') {
    html += '<div class="wf-prop-field"><label>条件表达式 (JSON)</label><textarea onchange="wfUpdateCondition(\'' + nodeId + '\',this.value)">' + JSON.stringify(config.expression || {}, null, 2) + '</textarea>'
      + '<small style="color:#999">示例: {"operator":"==","left":{"var":"data.value"},"right":"high"}</small></div>';
  }

  if (node.type === 'timer') {
    html += '<div class="wf-prop-field"><label>延迟(分钟)</label><input type="number" value="' + (config.delay_minutes || 60) + '" onchange="wfUpdateNodeConfig(\'' + nodeId + '\',\'delay_minutes\',parseInt(this.value))"></div>';
  }

  if (node.type === 'webhook') {
    html += '<div class="wf-prop-field"><label>URL</label><input value="' + (config.url || '') + '" onchange="wfUpdateNodeConfig(\'' + nodeId + '\',\'url\',this.value)"></div>';
  }

  if (node.type === 'auto_action') {
    html += '<div class="wf-prop-field"><label>字段名</label><input value="' + (config.field || '') + '" onchange="wfUpdateNodeConfig(\'' + nodeId + '\',\'field\',this.value)"></div>';
    html += '<div class="wf-prop-field"><label>字段值</label><input value="' + (config.value || '') + '" onchange="wfUpdateNodeConfig(\'' + nodeId + '\',\'value\',this.value)"></div>';
  }

  if (node.type === 'start') {
    html += '<div class="wf-prop-field"><label>触发方式</label><select onchange="wfUpdateNodeConfig(\'' + nodeId + '\',\'trigger\',this.value)">'
      + '<option value="manual"' + (config.trigger === 'manual' ? ' selected' : '') + '>手动触发</option>'
      + '<option value="auto"' + (config.trigger === 'auto' ? ' selected' : '') + '>自动触发</option></select></div>';
  }

  html += '<div style="padding:10px 16px;"><button onclick="wfDeleteSelected()" style="padding:6px 14px;background:#f44336;color:white;border:none;border-radius:4px;cursor:pointer;">删除节点</button></div>';

  var pc = document.getElementById('wf-prop-content');
  if (pc) pc.innerHTML = html;
}

function wfShowEdgeProperties(edgeId) {
  var edge = null;
  for (var i = 0; i < wfState.edges.length; i++) {
    if (wfState.edges[i].id === edgeId) { edge = wfState.edges[i]; break; }
  }
  if (!edge) return;

  var html = '<div class="wf-prop-field"><label>连线ID</label><input value="' + edge.id + '" readonly></div>';
  html += '<div class="wf-prop-field"><label>标签</label><input value="' + (edge.label || '') + '" onchange="wfUpdateEdgeProp(\'' + edgeId + '\',\'label\',this.value)"></div>';
  html += '<div class="wf-prop-field"><label>条件(JSON,可选)</label><textarea onchange="wfUpdateEdgeCondition(\'' + edgeId + '\',this.value)">' + (edge.condition ? JSON.stringify(edge.condition, null, 2) : '') + '</textarea></div>';
  html += '<div style="padding:10px 16px;"><button onclick="wfDeleteSelected()" style="padding:6px 14px;background:#f44336;color:white;border:none;border-radius:4px;cursor:pointer;">删除连线</button></div>';

  var pc = document.getElementById('wf-prop-content');
  if (pc) pc.innerHTML = html;
}

function wfUpdateNodeProp(nodeId, prop, value) {
  for (var i = 0; i < wfState.nodes.length; i++) {
    if (wfState.nodes[i].id === nodeId) { wfState.nodes[i][prop] = value; break; }
  }
  wfRenderAll(); wfSaveState();
}

function wfUpdateNodeConfig(nodeId, key, value) {
  for (var i = 0; i < wfState.nodes.length; i++) {
    if (wfState.nodes[i].id === nodeId) { wfState.nodes[i].config[key] = value; break; }
  }
  wfSaveState();
}

function wfUpdateEdgeProp(edgeId, prop, value) {
  for (var i = 0; i < wfState.edges.length; i++) {
    if (wfState.edges[i].id === edgeId) { wfState.edges[i][prop] = value; break; }
  }
  wfRenderAll(); wfSaveState();
}

function wfUpdateCondition(nodeId, jsonStr) {
  try {
    for (var i = 0; i < wfState.nodes.length; i++) {
      if (wfState.nodes[i].id === nodeId) { wfState.nodes[i].config.expression = JSON.parse(jsonStr); break; }
    }
    wfSaveState();
  } catch(e) { alert('JSON格式错误: ' + e.message); }
}

function wfUpdateEdgeCondition(edgeId, jsonStr) {
  try {
    for (var i = 0; i < wfState.edges.length; i++) {
      if (wfState.edges[i].id === edgeId) { wfState.edges[i].condition = jsonStr ? JSON.parse(jsonStr) : null; break; }
    }
    wfRenderAll(); wfSaveState();
  } catch(e) { alert('JSON格式错误: ' + e.message); }
}

// ---- Undo/Redo ----
function wfSaveState() {
  var state = { nodes: JSON.parse(JSON.stringify(wfState.nodes)), edges: JSON.parse(JSON.stringify(wfState.edges)), nodeCounter: wfState.nodeCounter };
  if (wfState.historyIndex < wfState.history.length - 1) {
    wfState.history = wfState.history.slice(0, wfState.historyIndex + 1);
  }
  wfState.history.push(state);
  if (wfState.history.length > 50) wfState.history.shift();
  wfState.historyIndex = wfState.history.length - 1;
}

function wfUndo() {
  if (wfState.historyIndex <= 0) return;
  wfState.historyIndex--;
  var state = wfState.history[wfState.historyIndex];
  wfState.nodes = JSON.parse(JSON.stringify(state.nodes));
  wfState.edges = JSON.parse(JSON.stringify(state.edges));
  wfState.nodeCounter = state.nodeCounter;
  wfDeselectAll();
}

function wfRedo() {
  if (wfState.historyIndex >= wfState.history.length - 1) return;
  wfState.historyIndex++;
  var state = wfState.history[wfState.historyIndex];
  wfState.nodes = JSON.parse(JSON.stringify(state.nodes));
  wfState.edges = JSON.parse(JSON.stringify(state.edges));
  wfState.nodeCounter = state.nodeCounter;
  wfDeselectAll();
}

function wfClearCanvas() {
  if (!confirm('确定清空画布？')) return;
  wfSaveState();
  wfState.nodes = []; wfState.edges = [];
  wfState.selectedNode = null; wfState.selectedEdge = null;
  wfState.templateId = null;
  document.getElementById('wf-template-name').value = '';
  document.getElementById('wf-template-id').textContent = '';
  wfRenderAll(); wfDeselectAll();
}

// ---- Save/Load Template ----
function wfSaveTemplate() {
  var name = document.getElementById('wf-template-name').value.trim();
  if (!name) { alert('请输入流程名称'); return; }
  if (wfState.nodes.length === 0) { alert('画布为空'); return; }

  var templateId = document.getElementById('wf-template-id').textContent;
  var data = { name: name, nodes: wfState.nodes, edges: wfState.edges };

  if (templateId) {
    wfApi('/templates/' + templateId, 'PUT', data).then(function(r) {
      if (r.success) alert('保存成功'); else alert('保存失败: ' + (r.error || '未知错误'));
    });
  } else {
    wfApi('/templates', 'POST', data).then(function(r) {
      if (r.id) { document.getElementById('wf-template-id').textContent = r.id; alert('保存成功，ID: ' + r.id); }
      else alert('保存失败: ' + (r.error || '未知错误'));
    });
  }
}

function wfPublishTemplate() {
  var templateId = document.getElementById('wf-template-id').textContent;
  if (!templateId) { alert('请先保存模板'); return; }
  wfApi('/templates/' + templateId + '/publish', 'POST').then(function(r) {
    if (r.success) alert('发布成功');
  });
}

function wfLoadTemplate(templateId) {
  wfApi('/templates/' + templateId).then(function(r) {
    if (!r.template) { alert('模板不存在'); return; }
    var t = r.template;
    switchPage('workflow-designer');
    document.getElementById('wf-template-name').value = t.name;
    document.getElementById('wf-template-id').textContent = t.id;
    wfState.nodes = t.nodes || [];
    wfState.edges = t.edges || [];
    wfState.nodeCounter = wfState.nodes.length;
    wfState.history = [{ nodes: JSON.parse(JSON.stringify(wfState.nodes)), edges: JSON.parse(JSON.stringify(wfState.edges)), nodeCounter: wfState.nodeCounter }];
    wfState.historyIndex = 0;
    wfRenderAll();
  });
}

// ---- Templates List ----
function wfLoadTemplates() {
  wfApi('/templates').then(function(r) {
    var tbody = document.getElementById('wf-templates-body');
    if (!tbody) return;
    if (!r.templates || r.templates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;">暂无模板</td></tr>';
      return;
    }
    tbody.innerHTML = r.templates.map(function(t) {
      return '<tr><td><strong>' + t.name + '</strong></td><td>' + (t.module || '-') + '</td><td>' + (t.category || '-')
        + '</td><td>v' + t.version + '</td><td><span class="wf-badge ' + (t.is_active ? 'wf-badge-completed' : 'wf-badge-paused') + '">'
        + (t.is_active ? '已发布' : '草稿') + '</span></td><td>' + (t.created_at || '-')
        + '</td><td><button onclick="wfLoadTemplate(' + t.id + ')" style="padding:4px 10px;border:1px solid #ccc;border-radius:3px;cursor:pointer;background:white;">编辑</button> '
        + '<button onclick="wfDeleteTemplate(' + t.id + ')" style="padding:4px 10px;border:1px solid #f44336;border-radius:3px;cursor:pointer;background:white;color:#f44336;">删除</button></td></tr>';
    }).join('');
  });
}

function wfDeleteTemplate(id) {
  if (!confirm('确定删除模板？')) return;
  wfApi('/templates/' + id, 'DELETE').then(function(r) {
    if (r.success) wfLoadTemplates();
  });
}

// ---- Instances ----
function wfLoadInstances() {
  var statusFilter = document.getElementById('wf-inst-filter-status');
  var url = '/instances';
  if (statusFilter && statusFilter.value) url += '?status=' + statusFilter.value;

  wfApi(url).then(function(r) {
    var tbody = document.getElementById('wf-instances-body');
    if (!tbody) return;
    if (!r.instances || r.instances.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;">暂无流程实例</td></tr>';
      return;
    }
    tbody.innerHTML = r.instances.map(function(inst) {
      return '<tr><td>#' + inst.id + '</td><td>' + (inst.template_name || '-') + '</td><td>' + inst.business_type
        + '</td><td>' + inst.business_id + '</td><td><span class="wf-badge wf-badge-' + inst.status + '">' + inst.status + '</span></td>'
        + '<td>' + (inst.started_by || '-') + '</td><td>' + (inst.created_at || '-')
        + '</td><td><button onclick="wfShowInstanceDetail(' + inst.id + ')" style="padding:4px 10px;border:1px solid #2196F3;border-radius:3px;cursor:pointer;background:white;color:#2196F3;">详情</button>'
        + (inst.status === 'active' ? ' <button onclick="wfCancelInstance(' + inst.id + ')" style="padding:4px 10px;border:1px solid #f44336;border-radius:3px;cursor:pointer;background:white;color:#f44336;">取消</button>' : '')
        + '</td></tr>';
    }).join('');
  });
}

function wfShowInstanceDetail(instanceId) {
  wfApi('/instances/' + instanceId).then(function(r) {
    if (!r.instance) { alert('实例不存在'); return; }
    var modal = document.getElementById('wf-instance-modal');
    var body = document.getElementById('wf-instance-modal-body');
    var title = document.getElementById('wf-instance-modal-title');
    if (!modal || !body) return;
    if (title) title.textContent = '流程实例 #' + instanceId;

    var nodeStatuses = r.node_statuses || {};
    var nodeColors = { start: '#e8f5e9', end: '#fbe9e7', approval: '#fff3e0', task: '#e3f2fd',
      condition: '#f3e5f5', parallel: '#e0f2f1', timer: '#fff8e1',
      webhook: '#fce4ec', auto_action: '#e8eaf6', sub_process: '#f1f8e9' };

    var html = '<div style="margin-bottom:20px;">';
    html += '<p>模板: <strong>' + (r.instance.template_name || '-') + '</strong> | 状态: <span class="wf-badge wf-badge-' + r.instance.status + '">' + r.instance.status + '</span></p>';

    // Flow visualization
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:16px 0;">';
    if (r.nodes) {
      for (var i = 0; i < r.nodes.length; i++) {
        var node = r.nodes[i];
        var ns = nodeStatuses[node.id];
        var borderColor = node.is_current ? '#FF9800' : (ns && ns.completed ? '#4CAF50' : '#ddd');
        html += '<div style="padding:8px 16px;border:2px solid ' + borderColor + ';border-radius:6px;background:' + (nodeColors[node.type] || '#f5f5f5') + ';font-size:13px;">'
          + node.label + (node.is_current ? ' ⬅' : '') + '</div>';
        if (i < r.nodes.length - 1) html += '<span style="color:#999;">→</span>';
      }
    }
    html += '</div>';

    // Tasks
    if (r.tasks && r.tasks.length > 0) {
      html += '<h4 style="margin:16px 0 8px;">任务列表</h4><table class="wf-table"><thead><tr><th>任务</th><th>类型</th><th>状态</th><th>处理人</th><th>备注</th></tr></thead><tbody>';
      for (var t = 0; t < r.tasks.length; t++) {
        var task = r.tasks[t];
        html += '<tr><td>' + task.title + '</td><td>' + task.node_type + '</td>'
          + '<td><span class="wf-badge wf-badge-' + task.status + '">' + task.status + '</span></td>'
          + '<td>' + (task.completed_by || '-') + '</td><td>' + (task.comment || '-') + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    // Logs
    if (r.logs && r.logs.length > 0) {
      html += '<h4 style="margin:16px 0 8px;">执行日志</h4><div style="max-height:200px;overflow-y:auto;background:#fafafa;padding:12px;border-radius:4px;font-size:12px;">';
      for (var l = 0; l < r.logs.length; l++) {
        var log = r.logs[l];
        html += '<div style="padding:4px 0;border-bottom:1px solid #eee;"><span style="color:#999;">' + log.created_at + '</span> '
          + '<span style="font-weight:600;">' + (log.node_id || '-') + '</span> '
          + '<span>' + log.action + '</span>'
          + (log.user_id ? ' <span style="color:#888;">by user#' + log.user_id + '</span>' : '') + '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    body.innerHTML = html;
    modal.style.display = 'flex';
  });
}

function wfCancelInstance(id) {
  if (!confirm('确定取消此流程？')) return;
  wfApi('/instances/' + id + '/cancel', 'POST').then(function(r) {
    if (r.success) wfLoadInstances();
  });
}

// ---- Tasks ----
function wfLoadTasks() {
  var filter = document.getElementById('wf-task-filter');
  var url = '/tasks';
  if (filter && filter.value) url += '?status=' + filter.value;

  wfApi(url).then(function(r) {
    var container = document.getElementById('wf-tasks-list');
    if (!container) return;
    if (!r.tasks || r.tasks.length === 0) {
      container.innerHTML = '<p style="text-align:center;color:#999;padding:40px;">暂无任务</p>';
      return;
    }
    container.innerHTML = r.tasks.map(function(task) {
      return '<div class="wf-task-card"><div class="wf-task-title">' + task.title + '</div>'
        + '<div class="wf-task-meta">流程: ' + (task.template_name || '-') + ' | '
        + '业务: ' + (task.business_type || '-') + '#' + (task.business_id || '-') + ' | '
        + '状态: <span class="wf-badge wf-badge-' + task.status + '">' + task.status + '</span>'
        + (task.created_at ? ' | 创建: ' + task.created_at : '') + '</div>'
        + (task.description ? '<p style="font-size:13px;color:#555;margin-bottom:10px;">' + task.description + '</p>' : '')
        + '<div class="wf-task-actions">'
        + (task.node_type === 'approval'
          ? '<button class="btn-approve" onclick="wfHandleTask(' + task.id + ',\'approve\')">✓ 批准</button>'
            + '<button class="btn-reject" onclick="wfHandleTask(' + task.id + ',\'reject\')">✗ 驳回</button>'
          : '<button class="btn-complete" onclick="wfHandleTask(' + task.id + ',\'complete\')">完成</button>')
        + '<input id="wf-task-comment-' + task.id + '" placeholder="备注..." style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;">'
        + '</div></div>';
    }).join('');
  });
}

function wfHandleTask(taskId, action) {
  var commentEl = document.getElementById('wf-task-comment-' + taskId);
  var comment = commentEl ? commentEl.value : '';
  var endpoint = action === 'reject' ? '/reject' : (action === 'approve' ? '/approve' : '/complete');

  wfApi('/tasks/' + taskId + endpoint, 'POST', { comment: comment }).then(function(r) {
    if (r.success) { wfLoadTasks(); }
    else { alert('操作失败: ' + (r.error || '未知错误')); }
  });
}











// ===== M1: BRAND INTELLIGENCE HUB (v8.0) =====
var brandSearchHistory = JSON.parse(localStorage.getItem('tm_brand_search_history') || '[]');
function initM1() {
  if (window.INDUSTRY_TREE) { renderIndustryTree(); }
  else {
    var tags = [], seen = {};
    BRANDS.forEach(function(b) { (b.industry_tags || []).forEach(function(t) { if (!seen[t]) { seen[t] = true; tags.push(t); } }); });
    tags.sort();
    var c = document.getElementById('tagGroup');
    if (c) c.innerHTML = tags.map(function(t) { return '<span class=tag data-tag="' + t + '" onclick=filterByTag("' + t + '")>' + t + '</span>'; }).join('');
  }
  renderBrands(BRANDS);
  renderSearchHistory();
}
function renderIndustryTree() {
  var tree = window.INDUSTRY_TREE || {};
  var container = document.getElementById('tagGroup');
  if (!container) return;
  var h = '<div class="tree-container">';
  Object.keys(tree).sort().forEach(function(cat) {
    var cd = tree[cat];
    var bc = BRANDS.filter(function(b) { return b.industry_tags && b.industry_tags.some(function(t) { return cd.sub_tags && cd.sub_tags.indexOf(t) >= 0; }); }).length;
    h += '<div class="tree-node"><div class="tree-parent" onclick="toggleTreeNode(this)"><span class="tree-icon">&#9658;</span><span>' + esc(cat) + '</span><span style="font-size:10px;opacity:.4">(' + bc + ')</span></div>';
    h += '<div class="tree-children">';
    (cd.sub_tags || []).forEach(function(tag) {
      var cnt = BRANDS.filter(function(b) { return (b.industry_tags || []).indexOf(tag) >= 0; }).length;
      h += '<div class="tree-child" data-tag="' + esc(tag) + '" onclick="filterByTreeTag(this.getAttribute(\'data-tag\'),this)">' + esc(tag) + '<span class="count">' + cnt + '</span></div>';
    });
    h += '</div></div>';
  });
  h += '</div>';
  container.innerHTML = h;
}
function toggleTreeNode(el) { el.classList.toggle('expanded'); var ch = el.nextElementSibling; if (ch) ch.classList.toggle('open'); }
function filterBrands() {
  var q = (document.getElementById('brandSearch')?.value || '').trim().toLowerCase();
  var f = BRANDS;
  if (activeTag) { f = f.filter(function(b) { return (b.industry_tags || []).indexOf(activeTag) >= 0; }); }
  if (q) {
    f = f.filter(function(b) { return b.name.toLowerCase().includes(q) || (b.name_cn || '').toLowerCase().includes(q); });
    archiveBrandSearch(q);
  }
  renderBrands(f);
  var bc = document.getElementById('brandCount');
  if (bc) bc.textContent = f.length + ' / ' + BRANDS.length + ' brands';
}
function filterByTag(t) { activeTag = activeTag === t ? null : t; document.querySelectorAll('#tagGroup .tag').forEach(function(e) { e.classList.toggle('active', e.dataset.tag === activeTag); }); filterBrands(); }
function filterByTreeTag(tag, el) { activeTag = activeTag === tag ? null : tag; document.querySelectorAll('.tree-child').forEach(function(c) { c.classList.remove('active'); }); if (activeTag && el) el.classList.add('active'); filterBrands(); }
function archiveBrandSearch(q) { if (!q) return; brandSearchHistory = brandSearchHistory.filter(function(s) { return s !== q; }); brandSearchHistory.unshift(q); if (brandSearchHistory.length > 20) brandSearchHistory = brandSearchHistory.slice(0, 20); localStorage.setItem('tm_brand_search_history', JSON.stringify(brandSearchHistory)); renderSearchHistory(); }
function renderSearchHistory() {
  var c = document.getElementById('searchHistory');
  if (!c) return;
  if (!brandSearchHistory.length) { c.innerHTML = ''; return; }
  c.innerHTML = '<div style="font-size:11px;margin-top:6px;color:#999">Recent: ' + brandSearchHistory.slice(0, 5).map(function(s) { return '<span style="cursor:pointer;margin:2px;padding:1px 6px;background:var(--surface2);border-radius:8px;font-size:10px" onclick="document.getElementById(\'brandSearch\').value=\'' + esc(s).replace(/'/g, '') + '\';filterBrands()">' + esc(s) + '</span>'; }).join('') + '</div>';
}
function renderBrands(brands) {
  brands = brands || BRANDS;
  var container = document.getElementById('brandList');
  if (!container) return;
  if (!brands.length) { container.innerHTML = '<div class="card" style="text-align:center;padding:40px;opacity:.5">No matching brands</div>'; return; }
  var h = '';
  brands.forEach(function(b, idx) {
    var sf = (b.overseas_presence || {}).social_followers || {};
    var bid = 'b_' + (b.id || idx);
    h += '<div class="brand-card">';
    h += '<div class="brand-card-main" onclick="toggleBrandSocial(this,\'' + bid + '\')">';
    h += '<div class="brand-card-header"><div><div class="brand-card-name">' + esc(b.name) + '</div>';
    h += '<div class="brand-card-tags">' + (b.industry_tags || []).slice(0, 4).map(function(t) { return '<span class="brand-tag">' + esc(t) + '</span>'; }).join('') + '</div></div>';
    h += '<div class="brand-card-rev"><div class="rev-value">' + esc(b.estimated_annual_revenue || 'N/A') + '</div><div class="rev-users">' + esc(b.user_base || '') + '</div></div></div>';
    h += '<div class="brand-card-metrics"><span>YT ' + (((sf.youtube||0)/1000).toFixed(0)) + 'K</span><span>IG ' + (((sf.instagram||0)/1000).toFixed(0)) + 'K</span><span>TT ' + (((sf.tiktok||0)/1000).toFixed(0)) + 'K</span>';
    if (b.website) h += '<a href="' + esc(b.website) + '" target="_blank" class="brand-link">Web</a>';
    h += '</div></div>';
    h += '<div class="brand-social-panel" id="bsp-' + bid + '" style="display:none;padding:10px;border-top:1px solid var(--border)">';
    h += '<div class="platform-tabs" style="display:flex;gap:4px;margin-bottom:8px">';
    h += '<span class="platform-tab active" data-plat="youtube" data-bid="' + bid + '" onclick="switchPlatformTab(this)">YouTube</span>';
    h += '<span class="platform-tab" data-plat="instagram" data-bid="' + bid + '" onclick="switchPlatformTab(this)">Instagram</span>';
    h += '<span class="platform-tab" data-plat="tiktok" data-bid="' + bid + '" onclick="switchPlatformTab(this)">TikTok</span></div>';
    h += '<div id="videos-' + bid + '-youtube" class="sg"><div style="text-align:center;padding:15px;color:#999;font-size:12px">Click refresh to load videos</div></div>';
    h += '<div id="videos-' + bid + '-instagram" class="sg" style="display:none"></div>';
    h += '<div id="videos-' + bid + '-tiktok" class="sg" style="display:none"></div>';
    h += '<button class="btn btn-xs" onclick="loadSocialForBrand(\'' + esc(b.name) + '\',\'' + bid + '\',\'youtube\')">Refresh</button></div></div>';
  });
  container.innerHTML = h;
  var bc = document.getElementById('brandCount');
  if (bc) bc.textContent = brands.length + ' / ' + BRANDS.length + ' brands';
}
function toggleBrandSocial(el, bid) { var p = document.getElementById('bsp-' + bid); if (p) { p.style.display = p.style.display === 'none' ? 'block' : 'none'; } }
function switchPlatformTab(el) {
  var p = el.parentElement;
  p.querySelectorAll('.platform-tab').forEach(function(t) { t.classList.remove('active'); });
  el.classList.add('active');
  var bid = el.getAttribute('data-bid');
  var plat = el.getAttribute('data-plat');
  ['youtube','instagram','tiktok'].forEach(function(pf) { var v = document.getElementById('videos-' + bid + '-' + pf); if (v) v.style.display = pf === plat ? 'block' : 'none'; });
}
function loadSocialForBrand(bn, bid, pf) {
  var c = document.getElementById('videos-' + bid + '-' + pf);
  if (!c) return;
  c.innerHTML = '<div style="text-align:center;padding:15px;color:#999;font-size:12px">Loading...</div>';
}
function exportBrandCSV() {
  if (!BRANDS || !BRANDS.length) { toast('No brands', 'error'); return; }
  var csv = 'Name,Industry,Revenue,YouTube,Instagram,TikTok\\n';
  BRANDS.forEach(function(b) { var sf = (b.overseas_presence||{}).social_followers||{}; csv += esc(b.name) + ',' + ((b.industry_tags||[]).join(';')) + ',' + (b.estimated_annual_revenue||'') + ',' + ((sf.youtube||0)/1000).toFixed(0) + 'K' + ',' + ((sf.instagram||0)/1000).toFixed(0) + 'K' + ',' + ((sf.tiktok||0)/1000).toFixed(0) + 'K\\n'; });
  dlFile('brands.csv', '\\ufeff' + csv, 'text/csv');
}
// ===== M3: DEMAND & PROPOSAL (v8.0) =====
var uploadedDemandContent = '';
var demandAnalysisResult = '';
function handleDemandFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  processDemandFile(file);
}
function handleDemandDrop(event) {
  event.preventDefault();
  var file = event.dataTransfer.files[0];
  if (!file) return;
  processDemandFile(file);
}
function processDemandFile(file) {
  var status = document.getElementById('demandFileStatus');
  if (!status) return;
  status.innerHTML = 'Reading: ' + file.name + '...';
  document.getElementById('btnAnalyzeAI').disabled = true;
  var reader = new FileReader();
  reader.onload = function(e) {
    uploadedDemandContent = e.target.result;
    status.innerHTML = 'OK: ' + file.name + ' (' + (uploadedDemandContent.length / 1024).toFixed(1) + 'KB)';
    document.getElementById('btnAnalyzeAI').disabled = false;
    document.getElementById('aiAnalyzeHint').textContent = 'Ready to analyze';
  };
  reader.readAsText(file);
}
function analyzeDemandAI() {
  var status = document.getElementById('demandFileStatus');
  var out = document.getElementById('analysisOut');
  var hint = document.getElementById('aiAnalyzeHint');
  if (!uploadedDemandContent && !document.getElementById('d_brand')?.value) {
    toast('Upload a file or fill info', 'error');
    return;
  }
  hint.textContent = 'Analyzing...';
  var prompt = 'Analyze this demand and extract as JSON with: brand, company, product, usp, industry, budget_range, target_market, platforms, competitors(array), requirements(array) Content: ' + (uploadedDemandContent || ('Brand: ' + (document.getElementById('d_brand')?.value||'') + ' Product: ' + (document.getElementById('d_product')?.value||'')));
  fetch(DS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DS_KEY }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: 'Output JSON only.' }, { role: 'user', content: prompt }], temperature: 0.1, max_tokens: 2000 }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var content = d.choices?.[0]?.message?.content || '';
      if (content.includes('{')) { var js = content.indexOf('{'); var je = content.lastIndexOf('}') + 1; content = content.substring(js, je); }
      var parsed = JSON.parse(content);
      demandAnalysisResult = parsed;
      var h = '<h3>AI Analysis</h3><div class="detail-section">';
      h += '<div class="detail-field"><span class="detail-field-label">Brand</span><span class="detail-field-value"><input id="edit_brand" value="' + esc(parsed.brand||'') + '"></span></div>';
      h += '<div class="detail-field"><span class="detail-field-label">Product</span><span class="detail-field-value"><input id="edit_product" value="' + esc(parsed.product||'') + '"></span></div>';
      h += '<div class="detail-field"><span class="detail-field-label">Industry</span><span class="detail-field-value"><input id="edit_industry" value="' + esc(parsed.industry||'') + '"></span></div>';
      h += '<div class="detail-field"><span class="detail-field-label">Budget</span><span class="detail-field-value"><input id="edit_budget" value="' + esc(parsed.budget_range||'') + '"></span></div>';
      h += '<div class="detail-field"><span class="detail-field-label">Market</span><span class="detail-field-value"><input id="edit_market" value="' + esc(parsed.target_market||'') + '"></span></div>';
      h += '<div class="detail-field"><span class="detail-field-label">Platforms</span><span class="detail-field-value"><input id="edit_platforms" value="' + esc((parsed.platforms||[]).join(', ')) + '"></span></div>';
      h += '</div><p style="font-size:11px;color:#999">Edit fields above if needed. Then click Next to generate proposal.</p>';
      out.innerHTML = h;
      hint.textContent = 'OK';
      document.getElementById('m3s1').classList.add('hidden');
      document.getElementById('m3s2').classList.remove('hidden');
      updSteps(2);
    }).catch(function(e) { hint.textContent = 'Failed'; out.innerHTML = '<p style="color:red">' + e.message + '</p>'; });
}
function getEditedDemand() {
  return {
    brand: document.getElementById('edit_brand')?.value || document.getElementById('d_brand')?.value || '',
    product: document.getElementById('edit_product')?.value || document.getElementById('d_product')?.value || '',
    industry: document.getElementById('edit_industry')?.value || document.getElementById('d_category')?.value || '',
    budget: document.getElementById('edit_budget')?.value || document.getElementById('d_budget')?.value || '',
    market: document.getElementById('edit_market')?.value || document.getElementById('d_area')?.value || '',
    platforms: document.getElementById('edit_platforms')?.value || ''
  };
}
function goStep3() { document.getElementById('m3s2').classList.add('hidden'); document.getElementById('m3s3').classList.remove('hidden'); updSteps(3); }
function resetDemand() { uploadedDemandContent = ''; demandAnalysisResult = ''; document.getElementById('m3s2').classList.add('hidden'); document.getElementById('m3s3').classList.add('hidden'); document.getElementById('m3s1').classList.remove('hidden'); document.getElementById('demandFileStatus').innerHTML = ''; document.getElementById('btnAnalyzeAI').disabled = true; document.getElementById('aiAnalyzeHint').textContent = 'Upload first'; updSteps(1); }
function generateHTMLPPT() {
  var demand = getEditedDemand();
  var brand = demand.brand || 'Brand';
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + esc(brand) + ' Proposal</title>';
  html += '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/4.3.1/reveal.min.css">';
  html += '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/4.3.1/theme/night.min.css">';
  html += '<style>.reveal section{padding:40px}.reveal h2{color:#e94560}</style></head><body><div class="reveal"><div class="slides">';
  html += '<section class="cover-slide"><h1>' + esc(brand) + '</h1><h3>Influencer Marketing Proposal</h3></section>';
  var sections = lastProp ? lastProp.split('\n').filter(Boolean) : ['Strategy', 'Execution'];
  sections.forEach(function(s) { html += '<section><h2>' + esc(s) + '</h2></section>'; });
  html += '</div></div><script src="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/4.3.1/reveal.min.js"><\/script><script>Reveal.initialize({hash:true})<\/script></body></html>';
  dlFile(brand + '_proposal.html', html, 'text/html');
  toast('HTML proposal downloaded');
}
// ===== M4: INFLUENCER (v8.0) =====
function initM4() { loadInfluencersFromAPI().then(function() { renderInfTable(lastInfAPI); loadCollaborations(); }); }
function loadInfluencersFromAPI() {
  var qs = '?sort_by=followers';
  var p = document.getElementById('filt_platform')?.value;
  var r = document.getElementById('filt_region')?.value;
  if (p) qs += '&platform=' + encodeURIComponent(p);
  if (r) qs += '&region=' + encodeURIComponent(r);
  return apiFetch('/influencers' + qs).then(function(r) { return r.json(); }).then(function(d) { lastInfAPI = d.influencers || []; renderInfTable(lastInfAPI); }).catch(function() { lastInfAPI = []; });
}
function matchInfluencers() { loadInfluencersFromAPI(); }
function renderInfTable(data) {
  var c = document.getElementById('infTableContainer');
  if (!c) return;
  if (!data || !data.length) { c.innerHTML = '<p style="text-align:center;padding:30px;opacity:.5">No influencers</p>'; return; }
  var h = '<table><thead><tr><th><input type="checkbox" id="selectAllInf" onchange="document.querySelectorAll(\'.infcb\').forEach(function(cb){cb.checked=this.checked})"></th><th>KOL</th><th>Platform</th><th>Followers</th><th>Project</th><th>Product</th><th>Region</th><th>Tags</th><th>Cost</th><th>CPM</th></tr></thead><tbody>';
  data.forEach(function(inf) {
    h += '<tr><td><input type="checkbox" class="infcb" value="' + inf.id + '"></td>';
    h += '<td><strong>' + esc(inf.kol_handle||'') + '</strong></td>';
    h += '<td>' + esc(inf.platform||'-') + '</td>';
    h += '<td>' + ((inf.followers||0)>=1000?((inf.followers/1000).toFixed(0)+'K'):(inf.followers||0)) + '</td>';
    h += '<td>' + esc(inf.project_name||'-') + '</td>';
    h += '<td>' + esc(inf.product_name||'-') + '</td>';
    h += '<td>' + esc(inf.region||'-') + '</td>';
    h += '<td>' + esc(inf.tags||'-') + '</td>';
    h += '<td>$' + (inf.cost_usd||0) + '</td>';
    h += '<td>' + (inf.cpm||'-') + '</td></tr>';
  });
  h += '</tbody></table>';
  c.innerHTML = h;
}
function getSelectedInfIds() { var ids = []; document.querySelectorAll('.infcb:checked').forEach(function(cb) { if (cb.value) ids.push(parseInt(cb.value)); }); return ids; }
function exportAll() { return exportInf('all'); }
function exportFiltered() { return exportInf('filtered'); }
function exportSelected() { var ids = getSelectedInfIds(); if (!ids.length) { toast('Select influencers first', 'error'); return; } return exportInf('selected', ids); }
function exportInf(mode, ids) {
  var body = { mode: mode };
  if (mode === 'selected' && ids) body.ids = ids;
  if (mode === 'filtered') body.filters = { platform: document.getElementById('filt_platform')?.value||'', region: document.getElementById('filt_region')?.value||'',
    project_name: document.getElementById('filt_project')?.value||'', product_name: document.getElementById('filt_product')?.value||'', tags: document.getElementById('filt_tags')?.value||'' };
  return apiFetch('/influencers/export', { method: 'POST', body: JSON.stringify(body) }).then(function(r) { if (!r.ok) throw new Error(); return r.blob(); }).then(function(blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'influencers_export.csv'; a.click(); toast('Export done');
  }).catch(function(e) { toast('Export failed', 'error'); });
}
function importInfluencers(rows) {
  if (!rows || !rows.length) return;
  apiFetch('/influencers/import', { method: 'POST', body: JSON.stringify({ rows: rows }) }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.imported) { toast('Imported ' + d.imported); loadInfluencersFromAPI(); }
  }).catch(function(e) { toast('Import: ' + e.message, 'error'); });
}
function downloadInfTemplate() {
  var csv = '日期,提报人,项目,推广产品,是否重复,网红频道名称,网红粉丝量,网红频道链接,社媒平台,国家,标签,近10个视频均播,成本价,网红交付物,Turing备注,对外商务报价,邮箱,cpm,cpv';
  dlFile('influencer_template.csv', csv + '\n', 'text/csv');
}
// ===== M5: AI ASSISTANT (v8.0) =====
aiMemory = aiMemory || {};
try { aiMemory = JSON.parse(localStorage.getItem('tm_ai_memory') || '{}'); } catch(e) { aiMemory = {}; }
function saveAIMemory() { localStorage.setItem('tm_ai_memory', JSON.stringify(aiMemory)); }
function sendChat() {
  var inp = document.getElementById('chatInput');
  var msg = inp ? inp.value.trim() : '';
  if (!msg) return;
  addChatMsg('user', msg);
  inp.value = '';
  var memKeys = Object.keys(aiMemory).slice(-10);
  var memContext = memKeys.length ? '\n\nPast:\n' + memKeys.map(function(k) { return '- ' + String(aiMemory[k]).substring(0, 200); }).join('\n') : '';
  var memId = 'm' + Date.now();
  aiMemory[memId] = msg;
  saveAIMemory();
  var msgs = document.getElementById('chatMessages');
  var td = document.createElement('div');
  td.className = 'chat-msg assistant';
  td.innerHTML = '<div class="bubble">Thinking...</div>';
  msgs.appendChild(td);
  msgs.scrollTop = msgs.scrollHeight;
  var systemPrompt = 'You are TuringMarket AI, an expert in influencer marketing. Be concise in Chinese. Database: ' + BRANDS.length + ' brands.' + memContext;
  var messages = [{role:'system', content: systemPrompt}];
  for (var ci = 0; ci < chatHistory.length && ci < 8; ci++) { messages.push(chatHistory[ci]); }
  messages.push({role:'user', content: msg});
  fetch(DS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DS_KEY }, body: JSON.stringify({ model: 'deepseek-chat', messages: messages, temperature: 0.7, max_tokens: 2048 }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      td.remove();
      var reply = d.choices ? d.choices[0].message.content : 'No response.';
      chatHistory.push({role:'assistant', content: reply});
      aiMemory[memId + '_r'] = reply.substring(0, 500);
      saveAIMemory();
      addChatMsg('assistant', reply);
    }).catch(function(e) { td.innerHTML = '<div class="bubble" style="color:#f44336">Error: ' + e.message + '</div>'; });
}
function addChatMsg(role, text) {
  var msgs = document.getElementById('chatMessages');
  if (!msgs) return;
  var div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  var formatted = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  div.innerHTML = '<div class="bubble">' + formatted + '</div>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}
function clearChat() { document.getElementById('chatMessages').innerHTML = '<div class="chat-msg assistant"><div class="bubble">Chat cleared</div></div>'; chatHistory = [{role:'system', content:'You are TuringMarket AI assistant.'}]; }
function clearAIMemory() { if (!confirm('Clear memory?')) return; aiMemory = {}; saveAIMemory(); toast('Memory cleared'); }
// ===== ADMIN (v8.0) =====
function switchAdminTab(tab) {
  ['overview','users','knowledge','tokens'].forEach(function(t) { var el = document.getElementById('admin-tab-' + t); if (el) el.style.display = t === tab ? 'block' : 'none'; });
  if (tab === 'overview') loadAdminDashboard();
  if (tab === 'users') loadAdminUsers();
  if (tab === 'tokens') loadAdminTokens();
}
function loadAdminDashboard() {
  apiFetch('/admin/overview').then(function(r) { return r.json(); }).then(function(d) {
    var s = d.stats || d;
    ['ad_totalUsers','ad_totalDemands','ad_totalTokens'].forEach(function(id) { var el = document.getElementById(id); if (el) el.textContent = id === 'ad_totalTokens' ? ((s.totalTokens||0)/1000).toFixed(0)+'K' : (s.totalUsers||s.totalDemands||0); });
  }).catch(function(e) {});
}
function loadAdminUsers() {
  apiFetch('/admin/users').then(function(r) { return r.json(); }).then(function(d) { renderAdminUserTable(d.users||[]); }).catch(function(e) {});
}
function renderAdminUserTable(users) {
  var tbody = document.getElementById('ad_userTableBody');
  if (!tbody) return;
  tbody.innerHTML = users.map(function(u) {
    return '<tr><td><strong>' + esc(u.username) + '</strong></td><td>' + esc(u.display_name) + '</td><td>' + esc(u.department||'-') + '</td><td>' + u.role + '</td><td>' + (u.api_quota||0).toLocaleString() + '</td><td>' + (u.last_login||'').substring(0,10) + '</td><td>' + (u.is_active ? '<span style="color:#0f7b3c">Active</span>' : '<span style="color:#d94641">Inactive</span>') + '</td><td><button class="btn btn-xs" onclick="adminResetPw('+u.id+')">Reset</button> <button class="btn btn-xs" onclick="toggleUserActive('+u.id+','+(u.is_active?0:1)+')">'+(u.is_active?'Disable':'Enable')+'</button></td></tr>';
  }).join('');
}
function loadAdminTokens() {
  apiFetch('/token-usage').then(function(r) { return r.json(); }).then(function(d) {
    var c = document.getElementById('ad_tokenTable');
    if (!c) return;
    var usage = d.usage || [];
    if (!usage.length) { c.innerHTML = '<p style="opacity:.5">No data</p>'; return; }
    c.innerHTML = '<table><thead><tr><th>User</th><th>Dept</th><th>Requests</th><th>Tokens</th><th>Last</th></tr></thead><tbody>' + usage.map(function(u) {
      return '<tr><td>' + esc(u.display_name||u.username||'') + '</td><td>' + esc(u.department||'-') + '</td><td>' + (u.request_count||0) + '</td><td>' + (u.total_tokens||0).toLocaleString() + '</td><td>' + (u.last_used||'').substring(0,10) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }).catch(function(e) {});
}
function toggleUserActive(id, active) { apiFetch('/admin/users/'+id, {method:'PUT', body:JSON.stringify({is_active:active})}).then(function() { loadAdminUsers(); toast(active?'Activated':'Deactivated'); }).catch(function(e) { toast('Failed','error'); }); }
function adminResetPw(id) { apiFetch('/admin/users/reset-password/'+id, {method:'POST'}).then(function() { toast('Reset to turing2026'); }).catch(function(e) { toast('Failed','error'); }); }
function adminCreateInvite() { apiFetch('/admin/invites', {method:'POST'}).then(function(r){return r.json();}).then(function(d) { var el = document.getElementById('ad_inviteResult'); if (el) el.textContent = 'Code: ' + d.code; toast('Invite: '+d.code); }).catch(function(e) { toast('Failed','error'); }); }
