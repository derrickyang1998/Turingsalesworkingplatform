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
    console.log("[TM] Calling initM1, initM3, initM4"); loadCustomers(); initM1(); initM3(); initM4(); console.log("[TM] init complete");
    var brandCountEl = document.getElementById('brandCount'); if (brandCountEl) brandCountEl.textContent = BRANDS.length + ' brands';
    var sfEl = document.getElementById('sidebarFooter'); if (sfEl && CURRENT_USER) sfEl.textContent = CURRENT_USER.display_name + ' . ' + CURRENT_USER.department;
    return
    document.getElementById('brandCount').textContent = BRANDS.length + ' brands';
    if (CURRENT_USER) {
      document.getElementById('sidebarFooter').textContent = CURRENT_USER.display_name + ' · ' + CURRENT_USER.department;
    }
  } catch (e) { console.error('initApp error:', e); document.getElementById('app').style.display = 'flex'; toast('Data load failed: ' + e.message, 'error'); try { initM1(); } catch(e2) {} }
}

// ===== C0: CUSTOMER PIPELINE =====
const CUST_STAGES = {
  new_lead: '新线索', inquiry: '需求沟通', proposal: '方案中',
  influencer_matching: '红人匹配', submitted: '已提报', won: '成交', lost: '丢失'
};
let curStageFilter = '';
let customersCache = [];

async function loadCustomers() {
  var search = document.getElementById('custSearch')?.value || '';
  var qs = ''; if (curStageFilter) qs = '?stage=' + curStageFilter; if (curStatusFilter) qs += (qs ? '&' : '?') + 'status=' + curStatusFilter;
  if (search) qs += (qs ? '&' : '?') + 'search=' + encodeURIComponent(search);
  try {
    var r = await apiFetch('/customers' + qs);
    var d = await r.json();
    customersCache = d.customers || [];
    renderCustomerTable(customersCache);
    loadCustomerStats();
    var m0El = document.getElementById('m0Stats');
    if (m0El) m0El.textContent = '商务SOP · 线索→成交全流程跟踪 · ' + d.total + ' 个客户';
  } catch (e) { console.error(e); }
}

async function loadCustomerStats() {
  try {
    var r = await apiFetch('/customers/stats');
    var d = await r.json();
    var tags = document.querySelectorAll('#m0StageFilter .tag');
    tags.forEach(function(t) {
      var stage = t.getAttribute('data-stage');
      if (!stage) return;
      var found = (d.byStage || []).find(function(s) { return s.stage === stage; });
      t.textContent = CUST_STAGES[stage] + (found ? ' (' + found.count + ')' : '');
    });
  } catch (e) {}
}

function filterCustomers(stage) {
  curStageFilter = stage;
  document.querySelectorAll('#m0StageFilter .tag').forEach(function(t) { t.classList.remove('active'); });
  var activeEl = document.querySelector('#m0StageFilter [data-stage="' + stage + '"]');
  if (activeEl) activeEl.classList.add('active');
  else document.querySelector('#m0StageFilter .tag').classList.add('active');
  loadCustomers();
}

function renderCustomerTable(data) {
  var tbody = document.getElementById('custTableBody');
  if (!data || !data.length) { tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;opacity:.5">暂无客户数据，点击"新增客户"开始</td></tr>'; return; }
  var h = '';
  data.forEach(function(c) {
    var stageLabel = CUST_STAGES[c.stage] || c.stage;
    h += '<tr><td><strong>' + esc(c.brand_name || '-') + '</strong></td>';
    h += '<td>' + esc(c.company_name || '-') + '</td>';
    h += '<td>' + esc(c.industry || '-') + '</td>';
    h += '<td><select onchange="changeCustomerStage(' + c.id + ', this.value)" style="width:auto;font-size:11px">';
    Object.keys(CUST_STAGES).forEach(function(k) { h += '<option value="' + k + '"' + (c.stage === k ? ' selected' : '') + '>' + CUST_STAGES[k] + '</option>'; });
    h += '</select></td>';
    h += '<td>' + esc(c.contact_person || '-') + '</td>';
    h += '<td style="font-size:11px">' + esc(c.budget_estimate || '-') + '</td>';
    h += '<td style="font-size:10px;opacity:.6">' + esc(c.source || '-') + '</td>';
    h += '<td style="font-size:10px;opacity:.6">' + (c.updated_at ? c.updated_at.substring(0, 10) : '-') + '</td>';
    h += '<td><button class="btn btn-sm" onclick="editCustomer(' + c.id + ')">编辑</button></td></tr>';
  });
  tbody.innerHTML = h;
}

function showAddCustomer() {
  document.getElementById('custEditId').value = '';
  document.getElementById('addCustomerTitle').textContent = '新增客户';
  ['custBrand','custCompany','custIndustry','custContact','custContactInfo','custSource','custBudget','custNotes'].forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('addCustomerCard').classList.remove('hidden');
}

function hideAddCustomer() {
  document.getElementById('addCustomerCard').classList.add('hidden');
}

function editCustomer(id) {
  var c = customersCache.find(function(x) { return x.id === id; });
  if (!c) return;
  document.getElementById('custEditId').value = c.id;
  document.getElementById('addCustomerTitle').textContent = '编辑客户: ' + c.brand_name;
  document.getElementById('custBrand').value = c.brand_name || '';
  document.getElementById('custCompany').value = c.company_name || '';
  document.getElementById('custIndustry').value = c.industry || '';
  document.getElementById('custContact').value = c.contact_person || '';
  document.getElementById('custContactInfo').value = c.contact_info || '';
  document.getElementById('custSource').value = c.source || '';
  document.getElementById('custBudget').value = c.budget_estimate || '';
  document.getElementById('custNotes').value = c.notes || '';
  document.getElementById('addCustomerCard').classList.remove('hidden');
}

async function saveCustomer() {
  var brand = document.getElementById('custBrand').value.trim();
  if (!brand) { toast('请填写品牌名称', 'error'); return; }
  var editId = document.getElementById('custEditId').value;
  var body = {
    brand_name: brand,
    company_name: document.getElementById('custCompany').value.trim(),
    industry: document.getElementById('custIndustry').value.trim(),
    contact_person: document.getElementById('custContact').value.trim(),
    contact_info: document.getElementById('custContactInfo').value.trim(),
    source: document.getElementById('custSource').value.trim(),
    budget_estimate: document.getElementById('custBudget').value.trim(),
    notes: document.getElementById('custNotes').value.trim()
  };
  try {
    if (editId) {
      await apiFetch('/customers/' + editId, { method: 'PUT', body: JSON.stringify(body) });
      toast('客户已更新');
    } else {
      await apiFetch('/customers', { method: 'POST', body: JSON.stringify(body) });
      toast('客户已创建');
    }
    hideAddCustomer();
    loadCustomers();
  } catch (e) { toast('保存失败: ' + e.message, 'error'); }
}

async function changeCustomerStage(id, newStage) {
  try {
    await apiFetch('/customers/' + id, { method: 'PUT', body: JSON.stringify({ stage: newStage }) });
    toast('阶段已更新: ' + (CUST_STAGES[newStage] || newStage));
    loadCustomerStats();
  } catch (e) { toast('更新失败: ' + e.message, 'error'); }
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
function switchPage(id) { document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active') }); var ni = document.querySelector('[data-page="' + id + '"]'); if (ni) ni.classList.add('active'); document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active') }); var pg = document.getElementById('page-' + id); if (pg) pg.classList.add('active'); if (id === 'm0') loadCustomers(); if (id === 'admin') loadAdminDashboard() }
function gv(id) { var e = document.getElementById(id); return e ? e.value : '' }
function getDate() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

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
    BRANDS.unshift(nb); renderBrands([nb]);
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
function handleDemandFile(e) {
  var f=e.target.files[0];if(!f)return;
  var s=document.getElementById("demandFileStatus");
  var ext=f.name.split(".").pop().toLowerCase();
  var ok=["pdf","xlsx","xls","docx","doc","txt","csv","jpg","jpeg","png"];
  if(ok.indexOf(ext)===-1){s.innerHTML="<span style=color:#d94641>不支持 ."+ext+" 格式</span>";return}
  s.innerHTML="<span>正在读取: "+f.name+" ("+(f.size/1024).toFixed(1)+"KB)...</span>";
  var r=new FileReader();
  if(ext==="txt"||ext==="csv"){
    r.onload=function(ev){uploadedFileContent=ev.target.result||"";onFileReady(f.name,uploadedFileContent.length)};
    r.readAsText(f);
  }else{
    r.onload=function(ev){uploadedFileContent="[File: "+f.name+" | Size: "+(f.size/1024).toFixed(1)+"KB | Type: "+ext.toUpperCase()+"]";onFileReady(f.name,f.size)};
    r.readAsDataURL(f);
  }
}
function handleDemandDrop(e){var files=e.dataTransfer.files;if(files.length){document.getElementById("demandFile").files=files;handleDemandFile({target:{files:files}})}}
function onFileReady(name,size){var s=document.getElementById("demandFileStatus");s.innerHTML="<span style=color:#0f7b3c>文件已就绪: "+name+"</span>";document.getElementById("btnAnalyzeAI").disabled=false;document.getElementById("aiAnalyzeHint").textContent="点击 AI 分析需求";toast("文件已加载")}

﻿function analyzeDemandAI() {
  var s=document.getElementById("demandFileStatus"),btn=document.getElementById("btnAnalyzeAI");
  btn.disabled=true;btn.textContent="AI 分析中...";
  s.innerHTML="<span>DeepSeek 正在分析需求...</span>";
  var ctx="你是出海品牌红人营销专家。请从客户需求中提取关键信息，以JSON格式返回。";if(uploadedFileContent.indexOf("[Binary:")===0){ctx+="文件为二进制格式(需xlsx解析)，请优先从文件名推断品牌/产品信息。文件名: "+uploadedFileContent+"。";}else{ctx+="\n文件内容: "+uploadedFileContent.slice(0,3000);}
  ctx+="\n返回JSON: {\"brand\":\"品牌名\",\"product\":\"产品名\",\"usp\":\"核心卖点\",\"category\":\"行业\",\"area\":\"目标市场\",\"budget\":\"预算\",\"platform\":\"平台\",\"kolcount\":\"KOL数量\",\"videotype\":\"视频类型\",\"competitors\":\"竞品\",\"notes\":\"重点注意事项和下一步建议\"}";
  fetch(DS_URL,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+DS_KEY},body:JSON.stringify({model:"deepseek-chat",messages:[{role:"user",content:ctx}],temperature:0.3,max_tokens:2000})})
  .then(function(r){return r.json()})
  .then(function(data){
    var reply=data.choices[0].message.content;
    try{apiFetch("/token-usage",{method:"POST",body:JSON.stringify({model:"deepseek-chat",endpoint:"demand_ai",prompt_tokens:data.usage.prompt_tokens||0,completion_tokens:data.usage.completion_tokens||0,total_tokens:data.usage.total_tokens||0})})}catch(e){}
    var parsed={};try{var m=reply.match(/\{[\s\S]*\}/);if(m)parsed=JSON.parse(m[0])}catch(e){}
    curDemand={brand:parsed.brand||gv("d_brand")||"待确认",company:parsed.company||gv("d_company")||"",product:parsed.product||gv("d_product")||"待确认",usp:parsed.usp||gv("d_usp")||"",category:parsed.category||gv("d_category")||"",budget:parsed.budget||gv("d_budget")||"",platform:parsed.platform||gv("d_platform")||"",area:parsed.area||gv("d_area")||"",kolcount:parsed.kolcount||gv("d_kolcount")||"",videotype:parsed.videotype||gv("d_videotype")||"",competitors:parsed.competitors||gv("d_competitors")||"",notes:parsed.notes||gv("d_notes")||""};
    try{apiFetch("/demands",{method:"POST",body:JSON.stringify({brand_name:curDemand.brand,company_name:curDemand.company,product_name:curDemand.product,industry:curDemand.category,budget:curDemand.budget,target_market:curDemand.area,platform:curDemand.platform,data_json:curDemand})})}catch(e){}
    showAnalysisResult();btn.disabled=false;btn.textContent="AI 分析需求";
  })
  .catch(function(e){s.innerHTML="<span style=color:#d94641>AI分析失败: "+e.message+"</span>";btn.disabled=false;btn.textContent="AI 分析需求";toast("AI分析失败","error")});
}

function analyzeDemandManual(){var brand=gv("d_brand"),product=gv("d_product"),usp=gv("d_usp");if(!brand||!product||!usp){toast("请至少填写品牌、产品、USP","error");return}curDemand={brand:brand,company:gv("d_company"),product:product,usp:usp,budget:gv("d_budget"),platform:gv("d_platform"),area:gv("d_area"),category:gv("d_category"),kolcount:gv("d_kolcount"),videotype:gv("d_videotype"),competitors:gv("d_competitors"),notes:gv("d_notes")||""};try{apiFetch("/demands",{method:"POST",body:JSON.stringify({brand_name:brand,company_name:curDemand.company,product_name:product,industry:curDemand.category,budget:curDemand.budget,target_market:curDemand.area,platform:curDemand.platform,data_json:curDemand})})}catch(e){}showAnalysisResult()}

function showAnalysisResult() {
  var d=curDemand;
  var comps=d.competitors?d.competitors.split(/[,;，；\n]/).map(function(c){return c.trim()}).filter(Boolean):[];
  var mb=BRANDS.filter(function(b){return b.industry_tags.some(function(t){return (d.category||"").indexOf(t)>=0})});
  var risks=[];if(!d.budget)risks.push("预算未明确");if(!d.area)risks.push("目标市场未明确");if(!d.platform)risks.push("推广平台未明确");
  var bn=d.budget?parseInt(d.budget.replace(/[^0-9]/g,"")):0;
  var recTmpl=bn>30000?"Full Strategy":bn>10000?"Execution":"Test Phase";
  var h="<h3>AI 分析结果</h3>";
  h+="<div class=\"grid grid-2\" style=\"margin-top:12px\">";
  h+="<div class=\"stat\" style=\"padding:14px\"><div style=\"font-size:11px;opacity:.5\">品牌</div><div style=\"font-weight:700\">"+(d.brand||"-")+"</div></div>";
  h+="<div class=\"stat\" style=\"padding:14px\"><div style=\"font-size:11px;opacity:.5\">产品</div><div style=\"font-weight:700\">"+(d.product||"-")+"</div></div>";
  h+="<div class=\"stat\" style=\"padding:14px\"><div style=\"font-size:11px;opacity:.5\">行业</div><div style=\"font-weight:700\">"+(d.category||"-")+"</div></div>";
  h+="<div class=\"stat\" style=\"padding:14px\"><div style=\"font-size:11px;opacity:.5\">预算</div><div style=\"font-weight:700\">"+(d.budget||"待确认")+"</div></div>";
  h+="<div class=\"stat\" style=\"padding:14px\"><div style=\"font-size:11px;opacity:.5\">市场</div><div style=\"font-weight:700\">"+(d.area||"待确认")+"</div></div>";
  h+="<div class=\"stat\" style=\"padding:14px\"><div style=\"font-size:11px;opacity:.5\">平台</div><div style=\"font-weight:700\">"+(d.platform||"待确认")+"</div></div>";
  h+="</div>";
  if(d.usp)h+="<div style=\"margin-top:12px;padding:12px;background:#fafaf9;border-radius:8px;font-size:12px\"><strong>核心卖点:</strong> "+d.usp+"</div>";
  h+="<h3 style=\"margin-top:16px\">下一步工作建议</h3><ol style=\"font-size:12px;padding-left:18px;line-height:2\">";
  h+="<li><strong>预算确认</strong> — "+(d.budget||"需与客户确认")+"</li>";
  h+="<li><strong>竞品对标</strong> — "+(comps.length?comps.slice(0,3).join(", "):"需收集竞品信息")+"</li>";
  h+="<li><strong>样品安排</strong> — 确认寄送时间线</li><li><strong>合同流程</strong> — 准备合作协议</li></ol>";
  h+="<h3 style=\"margin-top:16px\">重点关注</h3><ul style=\"font-size:12px;padding-left:18px;line-height:1.8\">";
  if(risks.length)risks.forEach(function(r){h+="<li>"+r+"</li>"});else h+="<li>需求信息基本完整</li>";
  h+="<li>行业对标: "+(mb.length?mb.slice(0,5).map(function(b){return b.name}).join(", "):"暂无")+"</li></ul>";
  h+="<h3 style=\"margin-top:16px\">推荐方案</h3><table style=\"width:100%;font-size:12px;border-collapse:collapse\">";
  h+="<tr><td style=\"padding:6px;font-weight:600\">模板</td><td style=\"padding:6px\">"+recTmpl+"</td></tr>";
  h+="<tr><td style=\"padding:6px;font-weight:600\">对标品牌</td><td style=\"padding:6px\">"+(mb.length?mb.slice(0,5).map(function(b){return b.name}).join(", "):"暂无")+"</td></tr>";
  h+="<tr><td style=\"padding:6px;font-weight:600\">下一步</td><td style=\"padding:6px\">确认分析 → 选择模板 → 生成方案</td></tr></table>";
  document.getElementById("analysisOut").innerHTML=h;
  document.getElementById("m3s2").classList.remove("hidden");
  document.getElementById("m3s1").classList.add("hidden");
  updSteps(2);
}
function goStep3() { document.getElementById('m3s3').classList.remove('hidden'); document.getElementById('m3s2').classList.add('hidden'); updSteps(3); initM3(); }
function updSteps(n) { for (var i = 1; i <= 3; i++) { var e = document.getElementById('step' + i); e.classList.remove('active', 'done'); if (i < n) e.classList.add('done'); if (i === n) e.classList.add('active') } }
function resetDemand() { ['f_company', 'f_brand', 'f_product', 'f_usp', 'f_budget', 'f_platform', 'f_area', 'f_category', 'f_followers', 'f_videotype', 'f_kolcount', 'f_publish', 'f_link', 'f_competitors', 'f_audience', 'f_notes'].forEach(function (id) { var e = document.getElementById(id); if (e) e.value = '' }); document.getElementById('m3s2').classList.add('hidden'); document.getElementById('m3s3').classList.add('hidden'); document.getElementById('m3s1').classList.remove('hidden'); updSteps(1); curDemand = null; selTpl = null; document.getElementById('demandFileStatus').innerHTML = '' }
function initM3() { var c = document.getElementById('tmplSelect'); if (!c || !TEMPLATES.length) return; var h = ''; TEMPLATES.forEach(function (t) { h += '<div class="card" style="cursor:pointer;padding:14px" id=tcard-' + t.id + ' onclick=selTmpl("' + t.id + '")><h3 style=font-size:14px>' + t.name + '</h3><p style="font-size:11px;opacity:.6;margin:6px 0">' + t.description + '</p><div style="display:flex;flex-wrap:wrap;gap:3px">'; (t.best_for || []).forEach(function (bf) { h += '<span class=badge>' + bf + '</span>' }); h += '</div><div style="font-size:10px;opacity:.4;margin-top:6px">' + t.sections.length + ' sections</div></div>' }); c.innerHTML = h }
function selTmpl(id) { selTpl = id; document.querySelectorAll('#tmplSelect .card').forEach(function (c) { c.style.borderColor = '' }); var card = document.getElementById('tcard-' + id); if (card) card.style.borderColor = 'var(--accent)' }

function generateProposal() {
  if (!curDemand) { toast('Analyze demand first', 'error'); return }
  if (!selTpl) { toast('Select a template', 'error'); return }
  var t = TEMPLATES.find(function (x) { return x.id === selTpl }); if (!t) return;
  var d = curDemand;
  var p = '# ' + d.brand + ' Influencer Marketing Proposal\n\n> TuringMarket | ' + new Date().toLocaleDateString('zh-CN') + '\n> Template: ' + t.name + '\n\n---\n\n## About TuringMarket\n' + (CBLOCKS.company_intro || '') + '\n\n**Methodology:** ' + (CBLOCKS.methodology || '') + '\n\n---\n\n';
  t.sections.forEach(function (sec, i) {
    p += '## ' + (i + 1) + '. ' + sec + '\n\n';
    if (sec.indexOf('Executive') >= 0 || sec.indexOf('摘要') >= 0) p += 'Based on **' + d.brand + '**, **' + d.product + '** in **' + d.area + '**.\n\n**Core:**\n- USP: ' + d.usp + '\n- Platform: ' + (d.platform || 'YT+TK+IG') + '\n- Budget: ' + (d.budget || 'TBD') + '\n\n';
    else if (sec.indexOf('Market') >= 0 || sec.indexOf('市场') >= 0) p += '### Target: ' + d.area + '\n- Audience: ' + (d.audience || 'TBD') + '\n- Competitors: ' + (d.competitors || 'TBD') + '\n\n';
    else if (sec.indexOf('Competitor') >= 0 || sec.indexOf('竞品') >= 0) p += '### Competitors\n' + (d.competitors ? d.competitors.split(/[,;，；\n]/).filter(Boolean).map(function (c) { return '- **' + c.trim() + '**' }).join('\n') : '- TBD') + '\n\n';
    else if (sec.indexOf('Audience') >= 0 || sec.indexOf('受众') >= 0) p += '### Audience\n' + (d.audience || 'TBD') + '\n\n';
    else if (sec.indexOf('Influencer') >= 0 || sec.indexOf('红人') >= 0) p += '### Influencers\nKOLs: ' + (d.kolcount || 'TBD') + ' | Followers: ' + (d.followers || 'TBD') + ' | Format: ' + (d.videotype || 'TBD') + '\n\nRecommended: Nano 40% | Micro 35% | Mid 20% | Macro 5%\n\n';
    else if (sec.indexOf('Platform') >= 0 || sec.indexOf('平台') >= 0) p += '### Platform\n' + (d.platform || 'YT+TK+IG') + '\n\n|Platform|Role|Share|\n|---|---|---|\n|YouTube|Trust|40-50%|\n|TikTok|Viral|25-35%|\n|Instagram|Aesthetic|20-25%|\n\n';
    else if (sec.indexOf('Budget') >= 0 || sec.indexOf('预算') >= 0) p += '### Budget\nClient: ' + (d.budget || 'TBD') + '\n\n60-30-10 model\n\n';
    else if (sec.indexOf('Timeline') >= 0 || sec.indexOf('时间') >= 0) p += '### Timeline\nTarget: ' + (d.publish || 'TBD') + '\n\n|Phase|Time|Actions|\n|---|---|---|\n|Prep|W1-2|Screening|\n|Test|W3-6|Content|\n|Scale|W7-12|Expand|\n|Review|W13|Analysis|\n\n';
    else if (sec.indexOf('KPI') >= 0 || sec.indexOf('效果') >= 0) p += '### KPIs\nEngagement ≥3% | CPM<$45 | ROI≥3:1 | 50+ assets\n\nNotes: ' + (d.notes || '') + '\n\n'
  });
  p += '\n---\n\n*TuringMarket | ' + new Date().toISOString().split('T')[0] + '*\n';
  lastProp = p;
  
  // Save proposal to server
  apiFetch('/proposals', { method: 'POST', body: JSON.stringify({ demand_id: null, template_id: selTpl, content: p }) }).catch(function (e) { });

  var c = document.getElementById('proposalOutput');
  c.classList.remove('hidden');
  c.innerHTML = p.replace(/\n/g, '<br>');
  // btnDL removed
  // btnCP removed
  c.scrollIntoView({ behavior: 'smooth' });
  toast('Proposal generated!')
}
function downloadProposal() { if (lastProp) dlFile((curDemand?.brand || 'proposal') + '_proposal.md', lastProp, 'text/markdown') }
function copyProposal() { if (lastProp) navigator.clipboard.writeText(lastProp).then(function () { toast('Copied') }) }


// ===== HTML PPT GENERATION (reveal.js) =====
var lastPPT="";
;


function escapeHTML(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}



function switchTab(id) { document.querySelectorAll('#tabBar .tab').forEach(function (t) { t.classList.remove('active') }); var tabEl = document.querySelector('[data-tab="' + id + '"]'); if (tabEl) tabEl.classList.add('active'); var t1=document.getElementById('tab1-content');var t2=document.getElementById('tab2-content');var t3=document.getElementById('tab3-content');if(t1)t1.classList.toggle('hidden',id!=='tab1');if(t2)t2.classList.toggle('hidden',id!=='tab2');if(t3)t3.classList.toggle('hidden',id!=='tab3') }
// ===== M4: INFLUENCER MATCHING (API-driven) =====
lastMatch = []; var lastInfAPI = [];

async function initM4() {
  await loadInfluencersFromAPI();
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
  var csv = 'No.,Date,KOL Handle,Followers,Link,Platform,Region,Category,Avg Views,Collab Type,Cost(USD),CPM\n';
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

// ===== ADMIN DASHBOARD =====
async function loadAdminDashboard() {
  if (!CURRENT_USER || CURRENT_USER.role !== 'admin') return;
  try {
    var r = await apiFetch('/admin/overview');
    var d = await r.json();
    var s = d.stats;
    document.getElementById('ad_totalUsers').textContent = s.totalUsers;
    document.getElementById('ad_totalDemands').textContent = s.totalDemands;
    document.getElementById('ad_totalProposals').textContent = s.totalProposals;
    document.getElementById('ad_totalTokens').textContent = (s.totalTokens / 1000).toFixed(0) + 'K';

    // User table
    var ur = await apiFetch('/admin/users');
    var ud = await ur.json();
    var userH = '';
    ud.users.forEach(function (u) {
      var du = (s.demandsByUser || []).find(function (x) { return x.display_name === u.display_name });
      userH += '<tr><td><strong>' + u.username + '</strong></td><td>' + u.display_name + '</td><td>' + (u.department || '-') + '</td><td><span class=badge>' + u.role + '</span></td><td>' + (u.api_quota || 0).toLocaleString() + '</td><td>' + (du ? du.count : 0) + '</td><td>-</td><td>' + (u.last_login ? u.last_login.substring(0, 10) : 'Never') + '</td><td>' + (u.is_active ? '✅' : '❌') + '</td><td><button class="btn btn-sm" onclick="adminResetPw(' + u.id + ')">重置密码</button></td></tr>';
    });
    document.getElementById('ad_userTableBody').innerHTML = userH;

    // Token ranking
    var tu = s.tokenUsageTrend || [];
    var tokenH = '<div style="font-size:12px;margin-bottom:8px;opacity:.5">最近30天</div>';
    tu.slice(0, 7).forEach(function (d) { tokenH += '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px"><span>' + d.date + '</span><span style=font-weight:600>' + ((d.tokens || 0) / 1000).toFixed(0) + 'K</span></div>' });
    document.getElementById('ad_tokenRank').innerHTML = tokenH;

    // Recent activity
    var actH = '';
    (s.recentActivity || []).slice(0, 30).forEach(function (a) {
      actH += '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px"><span><strong>' + a.display_name + '</strong> ' + a.action + '</span><span style=opacity:.5>' + (a.created_at ? a.created_at.substring(11, 16) : '') + '</span></div>'
    });
    document.getElementById('ad_recentActivity').innerHTML = actH || '<p style=opacity:.5>No activity yet</p>';
  } catch (e) { console.error('Admin load error:', e) }
}

async function adminResetPw(userId) {
  try {
    await apiFetch('/admin/users/reset-password/' + userId, { method: 'POST' });
    toast('Password reset to: turing2026');
  } catch (e) { toast('Failed: ' + e.message, 'error') }
}

async function adminCreateInvite() {
  try {
    var r = await apiFetch('/admin/invites', { method: 'POST' });
    var d = await r.json();
    document.getElementById('ad_inviteResult').textContent = '邀请码: ' + d.code + ' (7天有效)';
    toast('Invite code: ' + d.code);
  } catch (e) { toast('Failed: ' + e.message, 'error') }
}

// ===== LOGOUT BUTTON (add to sidebar) =====
(function () {
  var footer = document.querySelector('.sidebar-footer');
  if (footer) {
    footer.innerHTML = '<a href="#" onclick="doLogout()" style="color:var(--text2);font-size:10px">🚪 退出登录</a> · <span id="sidebarUser" style="font-size:10px;opacity:.5"></span>';
  }
})();
