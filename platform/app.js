// TuringMarket v4.0 - Multi-user Team Platform
const API = window.location.origin + '/api';
let AUTH_TOKEN = localStorage.getItem('tm_token') || '';
let CURRENT_USER = null;
let CURRENT_AUTH_CONTEXT = null;
let CURRENT_CRM_TEAM_ID = null;
let authExpiredNotified = false;
let AUTH_GENERATION = 0;
let currentAIConversationId = null;
let selectedKnowledgeEntryIds = [];
let selectedKnowledgeCampaignId = null;
let BRANDS = [], INFLUENCERS = [], TEMPLATES = [], CBLOCKS = {};
let curDemand = null, selTpl = null, lastMatch = [], lastProp = "";
let uploadedFileContent = "";
let lastAIStrategyRaw = "";
let chatHistory = [{role: "system", content: "You are the TuringMarket AI assistant. Answer in Chinese, concise and professional."}];
let pptOutlineIdempotencyFingerprint = '';
let pptOutlineIdempotencyKey = '';
let pptGenerationSequence = 0;
let pptGenerationInFlight = false;
let activePptGenerationContext = null;
let campaignPptDemandFingerprint = '';
let campaignPptDemandIdempotencyKey = '';
let campaignPptDemandRecord = null;
let campaignPptProposalFingerprint = '';
let campaignPptProposalIdempotencyKey = '';
let campaignPptProposalVersion = null;
let campaignPptDownloadFingerprint = '';
let campaignPptDownloadIdempotencyKey = '';
let campaignPptDownloadInFlight = false;
let campaignPptArchiveState = { status: 'idle', message: '' };
let aiChatIdempotencyFingerprint = '';
let aiChatIdempotencyKey = '';
let aiChatRequestSequence = 0;
let activeAiChatRequest = null;

// Navigation registry and page visibility are owned by client/core/navigation.js.
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
    if (window.TMNavigation && typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('tm:navigation-pages-normalized'));
    }
  }, 100);
})();


// ===== AUTH =====
function rememberAuthContext(authContext) {
  var source = authContext && authContext.auth_context ? authContext.auth_context : (authContext || {});
  var organization = source.organization && typeof source.organization === 'object' ? source.organization : null;
  var teams = Array.isArray(source.teams) ? source.teams.filter(function(team) {
    if (!team || !Number.isSafeInteger(Number(team.id)) || Number(team.id) < 1) return false;
    if (team.status === 'inactive' || team.status === 'revoked' || team.status === 'disabled') return false;
    if (team.is_active === false || team.is_active === 0 || team.active === false) return false;
    return true;
  }).map(function(team) { return Object.assign({}, team, { id: Number(team.id) }); }) : [];
  CURRENT_AUTH_CONTEXT = { organization: organization, teams: teams };
  var currentTeam = teams.find(function(team) { return team.id === Number(CURRENT_CRM_TEAM_ID); });
  CURRENT_CRM_TEAM_ID = currentTeam ? currentTeam.id : (teams[0] ? teams[0].id : null);
  syncCrmTeamSelector();
  try { localStorage.setItem('tm_auth_context', JSON.stringify(CURRENT_AUTH_CONTEXT)); } catch (e) {}
  return CURRENT_AUTH_CONTEXT;
}

function syncCrmTeamSelector() {
  var selector = document.getElementById('crmTeamSelect');
  if (!selector) return;
  var teams = CURRENT_AUTH_CONTEXT && Array.isArray(CURRENT_AUTH_CONTEXT.teams) ? CURRENT_AUTH_CONTEXT.teams : [];
  selector.innerHTML = teams.length ? teams.map(function(team) {
    return '<option value="' + Number(team.id) + '">' + esc(team.name || team.code || ('Team ' + team.id)) + '</option>';
  }).join('') : '<option value="">无可用团队</option>';
  selector.value = CURRENT_CRM_TEAM_ID ? String(CURRENT_CRM_TEAM_ID) : '';
}

function getSelectedCrmTeamId() {
  var selector = document.getElementById('crmTeamSelect');
  var candidate = selector && selector.value ? Number(selector.value) : Number(CURRENT_CRM_TEAM_ID);
  var teams = CURRENT_AUTH_CONTEXT && Array.isArray(CURRENT_AUTH_CONTEXT.teams) ? CURRENT_AUTH_CONTEXT.teams : [];
  var selected = teams.find(function(team) { return team.id === candidate; });
  return selected ? selected.id : null;
}

function selectCrmTeam(value) {
  var candidate = Number(value);
  var teams = CURRENT_AUTH_CONTEXT && Array.isArray(CURRENT_AUTH_CONTEXT.teams) ? CURRENT_AUTH_CONTEXT.teams : [];
  if (teams.some(function(team) { return team.id === candidate; })) {
    CURRENT_CRM_TEAM_ID = candidate;
    var selector = document.getElementById('crmTeamSelect');
    if (selector) selector.value = String(candidate);
  } else {
    syncCrmTeamSelector();
  }
}

async function doLogin() {
  const userInput = document.getElementById('loginUser');
  const passwordInput = document.getElementById('loginPass');
  const u = userInput.value.trim();
  const p = passwordInput.value.trim();
  clearLoginError();
  if (!u) return showLoginError('请输入用户名', userInput);
  if (!p) return showLoginError('请输入密码', passwordInput);
  try {
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const d = await r.json();
    if (!r.ok) return showLoginError(d.error || '登录失败');
    AUTH_TOKEN = d.token;
    CURRENT_USER = d.user;
    rememberAuthContext(d.auth_context || d.authContext || (d.user && d.user.auth_context));
    AUTH_GENERATION += 1;
    if (typeof invalidateAiChatRequests === 'function') invalidateAiChatRequests();
    currentAIConversationId = null;
    authExpiredNotified = false;
    clearLoginError();
    localStorage.setItem('tm_token', AUTH_TOKEN);
    localStorage.setItem('tm_user', JSON.stringify(CURRENT_USER));
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    if (CURRENT_USER.role === 'admin') {
      document.querySelectorAll('.admin-only').forEach(el => el.classList.add('visible'));
    }
    curCustomerScope = CURRENT_USER.role === 'admin' ? 'all' : 'my';
    updateCustomerScopeTabs();
    try { await initApp(); if (window.TMNavigation) window.TMNavigation.restore(CURRENT_USER); } catch(e2) { console.error(e2); }
  } catch (e) { showLoginError('Network error: ' + e.message) }
}

function clearLoginError() {
  var error = document.getElementById('loginError');
  if (error) error.textContent = '';
  var inputs = [document.getElementById('loginUser'), document.getElementById('loginPass')];
  inputs.forEach(function(input) { if (input) input.removeAttribute('aria-invalid'); });
}

function showLoginError(msg, focusTarget) {
  var loginError = document.getElementById('loginError');
  if (loginError) loginError.textContent = msg;
  var target = focusTarget || document.getElementById('loginUser');
  if (target) {
    target.setAttribute('aria-invalid', 'true');
    target.focus();
  }
}

async function doLogout() {
  try {
    await fetch(API + '/auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AUTH_TOKEN }
    });
  } catch (e) {}
  if (typeof invalidateAiChatRequests === 'function') invalidateAiChatRequests();
  currentAIConversationId = null;
  if (typeof resetCampaignPptArtifactState === 'function') resetCampaignPptArtifactState();
  AUTH_TOKEN = ''; CURRENT_USER = null; CURRENT_AUTH_CONTEXT = null; CURRENT_CRM_TEAM_ID = null; AUTH_GENERATION += 1;
  localStorage.removeItem('tm_token'); localStorage.removeItem('tm_user'); localStorage.removeItem('tm_auth_context');
  location.reload();
}

function handleAuthExpired(message) {
  if (window.TMAccessibility && window.TMAccessibility.dismissAllDialogs) {
    window.TMAccessibility.dismissAllDialogs();
  }
  closeCustomerDetail();
  if (typeof invalidateAiChatRequests === 'function') invalidateAiChatRequests();
  currentAIConversationId = null;
  if (typeof resetCampaignPptArtifactState === 'function') resetCampaignPptArtifactState();
  AUTH_TOKEN = '';
  CURRENT_USER = null;
  CURRENT_AUTH_CONTEXT = null;
  CURRENT_CRM_TEAM_ID = null;
  AUTH_GENERATION += 1;
  localStorage.removeItem('tm_token');
  localStorage.removeItem('tm_user');
  localStorage.removeItem('tm_auth_context');
  var app = document.getElementById('app');
  var auth = document.getElementById('authOverlay');
  var loginUser = document.getElementById('loginUser');
  if (app) app.style.display = 'none';
  if (auth) {
    auth.hidden = false;
    auth.inert = false;
    auth.removeAttribute('aria-hidden');
    auth.style.display = 'flex';
  }
  if (loginUser) loginUser.focus();
  if (!authExpiredNotified) {
    authExpiredNotified = true;
    toast(message || '登录已过期，请重新登录后再操作。', 'error');
  }
}

function beginCampaignPptGeneration() {
  if (pptGenerationInFlight) return null;
  pptGenerationInFlight = true;
  activePptGenerationContext = {
    generation: ++pptGenerationSequence,
    campaignId: typeof getActiveCampaignId === 'function' ? getActiveCampaignId() : null,
    invalidated: false,
    abortController: null
  };
  return activePptGenerationContext;
}

function isCampaignPptGenerationCurrent(requestContext) {
  if (!requestContext || activePptGenerationContext !== requestContext || requestContext.invalidated) return false;
  var activeCampaignId = typeof getActiveCampaignId === 'function' ? getActiveCampaignId() : null;
  return activeCampaignId === requestContext.campaignId;
}

function invalidateCampaignPptGeneration() {
  if (!activePptGenerationContext) return;
  activePptGenerationContext.invalidated = true;
  if (activePptGenerationContext.abortController) {
    try { activePptGenerationContext.abortController.abort(); } catch (error) {}
  }
}

function finishCampaignPptGeneration(requestContext) {
  if (activePptGenerationContext !== requestContext) return false;
  activePptGenerationContext = null;
  pptGenerationInFlight = false;
  return true;
}

function campaignPptFingerprint(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function campaignPptBuildHeaders(options, idempotencyKey, prefix) {
  var headers = {};
  var source = options && options.headers;
  if (source && typeof source.forEach === 'function') {
    source.forEach(function(value, name) { headers[name] = value; });
  } else if (source && typeof source === 'object') {
    Object.keys(source).forEach(function(name) { headers[name] = source[name]; });
  }
  headers['Idempotency-Key'] = idempotencyKey;
  headers['X-Request-Id'] = createDemandAnalysisOperationId(prefix + '-request-');
  return headers;
}

function getActiveDemandId() {
  var campaignId = readPositiveInteger(getActiveCampaignId());
  if (campaignId === null) return null;
  if (
    campaignPptDemandRecord &&
    readPositiveInteger(campaignPptDemandRecord.campaignId) === campaignId
  ) {
    var recordedId = readPositiveInteger(campaignPptDemandRecord.demandId);
    if (recordedId !== null) return recordedId;
  }
  var contexts = [activeWorkflowContext, curDemand];
  for (var index = 0; index < contexts.length; index += 1) {
    var context = contexts[index];
    if (!context || typeof context !== 'object') continue;
    var contextCampaignId = readPositiveInteger(context.campaign_id);
    if (contextCampaignId === null) contextCampaignId = readPositiveInteger(context.campaignId);
    if (contextCampaignId !== campaignId) continue;
    var demandId = readPositiveInteger(context.demand_id);
    if (demandId === null) demandId = readPositiveInteger(context.demandId);
    if (demandId !== null) return demandId;
  }
  return null;
}

function buildCampaignPptDemandPayload(campaignId) {
  var demand = curDemand && typeof curDemand === 'object' ? curDemand : {};
  var workflow = activeWorkflowContext && typeof activeWorkflowContext === 'object'
    ? activeWorkflowContext
    : {};
  var firstText = function(values) {
    for (var index = 0; index < values.length; index += 1) {
      if (values[index] === null || values[index] === undefined) continue;
      var text = String(values[index]).trim();
      if (text) return text;
    }
    return '';
  };
  return {
    campaign_id: readPositiveInteger(campaignId),
    brand_name: firstText([demand.brand, workflow.brand]),
    company_name: firstText([demand.company, workflow.company]),
    product_name: firstText([demand.product, workflow.product]),
    industry: firstText([demand.category, demand.industry, workflow.industry]),
    budget: firstText([demand.budget, workflow.budget]),
    target_market: firstText([demand.area, demand.market, workflow.market]),
    platform: firstText([demand.platform, demand.platforms, workflow.platform]),
    data_json: Object.assign({}, demand, {
      campaign_id: readPositiveInteger(campaignId)
    })
  };
}

async function ensureCampaignPptDemandRecord(campaignId) {
  campaignId = readPositiveInteger(campaignId);
  if (campaignId === null || readPositiveInteger(getActiveCampaignId()) !== campaignId) {
    throw new Error('当前 Campaign 已切换，请重新生成方案。');
  }

  var payload = buildCampaignPptDemandPayload(campaignId);
  var fingerprint = campaignPptFingerprint(payload);
  if (
    campaignPptDemandRecord &&
    campaignPptDemandRecord.campaignId === campaignId &&
    campaignPptDemandRecord.fingerprint === fingerprint
  ) {
    if (readPositiveInteger(campaignPptDemandRecord.demandId) !== null) {
      return campaignPptDemandRecord.demandId;
    }
    if (campaignPptDemandRecord.promise) return campaignPptDemandRecord.promise;
  }

  var explicitDemandId = getActiveDemandId();
  if (explicitDemandId !== null) {
    campaignPptDemandRecord = {
      campaignId: campaignId,
      demandId: explicitDemandId,
      fingerprint: fingerprint,
      autoCreated: false
    };
    return explicitDemandId;
  }

  if (campaignPptDemandFingerprint !== fingerprint || !campaignPptDemandIdempotencyKey) {
    campaignPptDemandFingerprint = fingerprint;
    campaignPptDemandIdempotencyKey = createDemandAnalysisOperationId('ppt-demand-');
  }
  var requestAuthGeneration = AUTH_GENERATION;
  var requestPromise = (async function() {
    var response = await apiFetch('/demands', {
      method: 'POST',
      headers: campaignPptBuildHeaders({}, campaignPptDemandIdempotencyKey, 'ppt-demand'),
      body: JSON.stringify(payload)
    });
    var data = response && typeof response.json === 'function'
      ? await response.json().catch(function() { return {}; })
      : {};
    var demandId = readPositiveInteger(data && data.id);
    var responseCampaignId = readPositiveInteger(data && data.campaign_id);
    if (
      !response || response.status !== 201 ||
      demandId === null || responseCampaignId !== campaignId ||
      readPositiveInteger(data && data.link_id) === null
    ) {
      throw new Error((data && (data.error || data.message)) || 'Campaign 需求归档失败。');
    }
    if (
      !campaignPptDemandRecord ||
      campaignPptDemandRecord.campaignId !== campaignId ||
      campaignPptDemandRecord.fingerprint !== fingerprint ||
      campaignPptDemandRecord.promise !== requestPromise
    ) {
      throw new Error('Campaign 需求内容已替换，已忽略过期归档结果。');
    }
    if (
      requestAuthGeneration !== AUTH_GENERATION ||
      readPositiveInteger(getActiveCampaignId()) !== campaignId
    ) {
      throw new Error('活动已切换，已忽略过期的 Campaign 需求归档结果。');
    }
    campaignPptDemandRecord = {
      campaignId: campaignId,
      demandId: demandId,
      fingerprint: fingerprint,
      autoCreated: true
    };
    if (curDemand && typeof curDemand === 'object') {
      curDemand.campaign_id = campaignId;
      curDemand.demand_id = demandId;
    }
    return demandId;
  })();
  campaignPptDemandRecord = {
    campaignId: campaignId,
    demandId: null,
    fingerprint: fingerprint,
    promise: requestPromise,
    autoCreated: true
  };
  try {
    return await requestPromise;
  } catch (error) {
    if (
      campaignPptDemandRecord &&
      campaignPptDemandRecord.campaignId === campaignId &&
      campaignPptDemandRecord.promise === requestPromise
    ) {
      campaignPptDemandRecord = null;
    }
    throw error;
  }
}

function prepareCampaignPptProposalRequest(url, options, demandId) {
  var campaignId = readPositiveInteger(getActiveCampaignId());
  if (url !== '/proposals' || campaignId === null) return { options: options, context: null };
  demandId = readPositiveInteger(demandId);
  if (demandId === null || !options || typeof options.body !== 'string') {
    throw new Error('当前 Campaign 缺少有效需求记录。');
  }
  var body;
  try { body = JSON.parse(options.body); } catch (error) { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('PPT 方案内容格式无效。');
  }
  body.campaign_id = campaignId;
  body.demand_id = demandId;
  var outline;
  try { outline = JSON.parse(body.content); } catch (error) { outline = null; }
  if (!outline || typeof outline !== 'object' || Array.isArray(outline)) {
    throw new Error('PPT 方案大纲格式无效。');
  }
  var fingerprint = campaignPptFingerprint(body);
  if (campaignPptProposalFingerprint !== fingerprint || !campaignPptProposalIdempotencyKey) {
    campaignPptProposalFingerprint = fingerprint;
    campaignPptProposalIdempotencyKey = createDemandAnalysisOperationId('ppt-proposal-');
  }
  campaignPptArchiveState = { status: 'saving', message: '正在归档最新方案版本...' };
  renderCampaignPptArchiveStatus();
  return {
    options: Object.assign({}, options, {
      headers: campaignPptBuildHeaders(options, campaignPptProposalIdempotencyKey, 'ppt-proposal'),
      body: JSON.stringify(body)
    }),
    context: {
      authGeneration: AUTH_GENERATION,
      campaignId: campaignId,
      demandId: demandId,
      outlineFingerprint: campaignPptFingerprint(outline),
      idempotencyKey: campaignPptProposalIdempotencyKey
    }
  };
}

async function observeCampaignPptProposalSave(response, requestContext) {
  if (!requestContext) return null;
  var data = {};
  try {
    data = response && typeof response.clone === 'function'
      ? await response.clone().json()
      : {};
  } catch (error) {}
  var keys = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data).sort().join(',')
    : '';
  var valid = !!response && response.status === 201 &&
    keys === 'campaign_id,content_sha256,id' &&
    readPositiveInteger(data.id) !== null &&
    readPositiveInteger(data.campaign_id) === requestContext.campaignId &&
    typeof data.content_sha256 === 'string' && /^[a-f0-9]{64}$/.test(data.content_sha256) &&
    requestContext.authGeneration === AUTH_GENERATION &&
    readPositiveInteger(getActiveCampaignId()) === requestContext.campaignId &&
    campaignPptFingerprint(lastPPTOutline) === requestContext.outlineFingerprint;
  if (!valid) {
    campaignPptProposalVersion = null;
    campaignPptArchiveState = {
      status: 'failed',
      message: '最新方案尚未归档，请重试保存后再下载 PPTX。'
    };
    renderCampaignPptArchiveStatus();
    return null;
  }
  campaignPptProposalVersion = {
    campaignId: requestContext.campaignId,
    demandId: requestContext.demandId,
    proposalId: readPositiveInteger(data.id),
    contentSha256: data.content_sha256,
    outlineFingerprint: requestContext.outlineFingerprint,
    idempotencyKey: requestContext.idempotencyKey
  };
  campaignPptArchiveState = {
    status: 'ready',
    message: '最新方案已归档，可生成并下载 PPTX。'
  };
  renderCampaignPptArchiveStatus();
  return campaignPptProposalVersion;
}

function campaignPptProposalVersionMatches(outline, campaignId, demandId) {
  return !!campaignPptProposalVersion &&
    readPositiveInteger(campaignPptProposalVersion.campaignId) === readPositiveInteger(campaignId) &&
    readPositiveInteger(campaignPptProposalVersion.demandId) === readPositiveInteger(demandId) &&
    readPositiveInteger(campaignPptProposalVersion.proposalId) !== null &&
    typeof campaignPptProposalVersion.contentSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(campaignPptProposalVersion.contentSha256) &&
    campaignPptProposalVersion.outlineFingerprint === campaignPptFingerprint(outline);
}

async function ensureCampaignPptProposalVersion() {
  var campaignId = readPositiveInteger(getActiveCampaignId());
  if (campaignId === null) return null;
  if (!lastPPTOutline || typeof lastPPTOutline !== 'object') {
    throw new Error('请先生成 PPT 大纲。');
  }
  var demandId = await ensureCampaignPptDemandRecord(campaignId);
  if (campaignPptProposalVersionMatches(lastPPTOutline, campaignId, demandId)) {
    return campaignPptProposalVersion;
  }
  var response = await apiFetch('/proposals', {
    method: 'POST',
    body: JSON.stringify({
      demand_id: demandId,
      template_id: 'ppt_html',
      content: JSON.stringify(lastPPTOutline)
    })
  });
  if (!response || !response.ok || !campaignPptProposalVersionMatches(lastPPTOutline, campaignId, demandId)) {
    var data = {};
    try { data = await response.clone().json(); } catch (error) {}
    throw new Error(data.error || data.message || '最新方案归档失败。');
  }
  return campaignPptProposalVersion;
}

function prepareCampaignPptDownloadRequest(url, options) {
  var campaignId = readPositiveInteger(getActiveCampaignId());
  if (url !== '/proposal/generate-ppt' || campaignId === null) {
    return { options: options, context: null };
  }
  if (!options || typeof options.body !== 'string') throw new Error('PPTX 请求格式无效。');
  var body;
  try { body = JSON.parse(options.body); } catch (error) { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('PPTX 请求格式无效。');
  }
  var demandId = campaignPptDemandRecord && campaignPptDemandRecord.campaignId === campaignId
    ? readPositiveInteger(campaignPptDemandRecord.demandId)
    : null;
  if (demandId === null && campaignPptProposalVersion) {
    demandId = readPositiveInteger(campaignPptProposalVersion.demandId);
  }
  if (!campaignPptProposalVersionMatches(lastPPTOutline, campaignId, demandId)) {
    throw new Error('最新方案尚未确认归档，请先保存后重试。');
  }
  body.campaign_id = campaignId;
  body.proposal_id = campaignPptProposalVersion.proposalId;
  body.proposal_content_sha256 = campaignPptProposalVersion.contentSha256;
  body.outline = lastPPTOutline;
  var fingerprint = campaignPptFingerprint(body);
  if (campaignPptDownloadFingerprint !== fingerprint || !campaignPptDownloadIdempotencyKey) {
    campaignPptDownloadFingerprint = fingerprint;
    campaignPptDownloadIdempotencyKey = createDemandAnalysisOperationId('ppt-download-');
  }
  return {
    options: Object.assign({}, options, {
      headers: campaignPptBuildHeaders(options, campaignPptDownloadIdempotencyKey, 'ppt-download'),
      body: JSON.stringify(body)
    }),
    context: {
      authGeneration: AUTH_GENERATION,
      campaignId: campaignId,
      demandId: demandId,
      proposalId: campaignPptProposalVersion.proposalId,
      outlineFingerprint: campaignPptProposalVersion.outlineFingerprint
    }
  };
}

function invalidateCampaignPptProposalVersion(reason) {
  campaignPptProposalVersion = null;
  campaignPptProposalFingerprint = '';
  campaignPptProposalIdempotencyKey = '';
  campaignPptDownloadFingerprint = '';
  campaignPptDownloadIdempotencyKey = '';
  campaignPptArchiveState = {
    status: 'dirty',
    message: reason || 'PPT 大纲已修改，请先保存最新方案。'
  };
  renderCampaignPptArchiveStatus();
}

function resetCampaignPptArtifactState(preserveDemand) {
  if (!preserveDemand) {
    campaignPptDemandFingerprint = '';
    campaignPptDemandIdempotencyKey = '';
    campaignPptDemandRecord = null;
  }
  campaignPptProposalFingerprint = '';
  campaignPptProposalIdempotencyKey = '';
  campaignPptProposalVersion = null;
  campaignPptDownloadFingerprint = '';
  campaignPptDownloadIdempotencyKey = '';
  campaignPptDownloadInFlight = false;
  campaignPptArchiveState = { status: 'idle', message: '' };
  renderCampaignPptArchiveStatus();
}

function renderCampaignPptArchiveStatus() {
  if (typeof document === 'undefined') return;
  var output = document.getElementById('proposalOutput');
  if (!output) return;
  var existing = document.getElementById('campaignPptArchiveStatus');
  var campaignId = readPositiveInteger(getActiveCampaignId());
  if (campaignId === null) {
    if (existing) existing.remove();
    return;
  }
  var status = existing || document.createElement('div');
  status.id = 'campaignPptArchiveStatus';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 16px 16px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12px;color:var(--text2)';
  while (status.firstChild) status.removeChild(status.firstChild);
  var message = document.createElement('span');
  var state = campaignPptArchiveState && campaignPptArchiveState.status
    ? campaignPptArchiveState.status
    : 'idle';
  message.textContent = campaignPptArchiveState.message || (state === 'idle'
    ? '尚未归档到当前项目。'
    : '正在处理当前项目方案。');
  status.appendChild(message);
  if (state === 'failed' || state === 'dirty' || state === 'idle') {
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-sm';
    retry.textContent = state === 'idle' ? '保存最新方案' : '重试保存';
    retry.addEventListener('click', function() {
      retry.disabled = true;
      ensureCampaignPptProposalVersion().catch(function(error) {
        campaignPptArchiveState = { status: 'failed', message: error.message || '方案归档失败。' };
        renderCampaignPptArchiveStatus();
      });
    });
    status.appendChild(retry);
  }
  if (!existing) output.appendChild(status);
  var downloadButton = output.querySelector(
    'button[onclick="downloadPPTX()"], button[data-tm-ppt-action="downloadPPTX"]'
  );
  if (downloadButton) {
    downloadButton.disabled = campaignPptDownloadInFlight || (state !== 'ready' && state !== 'generated');
  }
}

function installCampaignPptArtifactBridge() {
  if (
    window.__tmCampaignPptArtifactBridgeInstalled ||
    typeof window.downloadPPTX !== 'function'
  ) return;
  var originalDownloadPPTX = window.downloadPPTX;
  var downloadPromise = null;
  window.downloadPPTX = function() {
    var args = arguments;
    var receiver = this;
    if (readPositiveInteger(getActiveCampaignId()) === null) {
      return originalDownloadPPTX.apply(receiver, args);
    }
    if (downloadPromise) return downloadPromise;
    campaignPptDownloadInFlight = true;
    renderCampaignPptArchiveStatus();
    var proposalPromise;
    try {
      proposalPromise = ensureCampaignPptProposalVersion();
    } catch (error) {
      proposalPromise = Promise.reject(error);
    }
    downloadPromise = Promise.resolve(proposalPromise)
      .then(function() { return originalDownloadPPTX.apply(receiver, args); })
      .catch(function(error) {
        campaignPptArchiveState = {
          status: 'failed',
          message: error && error.message ? error.message : 'PPTX 生成失败。'
        };
        renderCampaignPptArchiveStatus();
        if (typeof toast === 'function') toast(campaignPptArchiveState.message, 'error');
      })
      .finally(function() {
        campaignPptDownloadInFlight = false;
        downloadPromise = null;
        renderCampaignPptArchiveStatus();
      });
    return downloadPromise;
  };

  [
    'savePPTEditorAndRender',
    'previewEditedPPT',
    'addPPTEditorSlide',
    'duplicatePPTEditorSlide',
    'deletePPTEditorSlide',
    'movePPTEditorSlide',
    'selectPPTEditorSlide'
  ].forEach(function(name) {
    if (typeof window[name] !== 'function') return;
    var original = window[name];
    window[name] = function() {
      var before = campaignPptFingerprint(lastPPTOutline);
      var result = original.apply(this, arguments);
      var compare = function() {
        if (
          readPositiveInteger(getActiveCampaignId()) !== null &&
          before !== campaignPptFingerprint(lastPPTOutline)
        ) {
          invalidateCampaignPptProposalVersion('PPT 大纲已修改，请保存最新方案后再下载。');
        }
      };
      if (result && typeof result.then === 'function') return result.then(function(value) {
        compare();
        return value;
      });
      compare();
      return result;
    };
  });
  window.__tmCampaignPptArtifactBridgeInstalled = true;
  renderCampaignPptArchiveStatus();
}

function installCampaignPptRenderFence() {
  if (window.__tmCampaignPptRenderFenceInstalled || typeof window.renderPPTResult !== 'function') return;
  var originalRenderPPTResult = window.renderPPTResult;
  window.renderPPTResult = function(parsed, warning, contextWarning) {
    if (activePptGenerationContext && !isCampaignPptGenerationCurrent(activePptGenerationContext)) {
      if (typeof lastPPTOutline !== 'undefined') lastPPTOutline = null;
      if (typeof lastPPT !== 'undefined') lastPPT = '';
      if (typeof lastPPTSource !== 'undefined') lastPPTSource = '';
      return;
    }
    var result = originalRenderPPTResult.call(this, parsed, warning, contextWarning);
    if (typeof renderCampaignPptArchiveStatus === 'function') renderCampaignPptArchiveStatus();
    return result;
  };
  window.__tmCampaignPptRenderFenceInstalled = true;
}

async function generateCampaignPPT() {
  var requestContext = beginCampaignPptGeneration();
  if (!requestContext) return;
  if (readPositiveInteger(requestContext.campaignId) !== null) {
    resetCampaignPptArtifactState(true);
  }
  try {
    await generateHTMLPPT();
  } finally {
    finishCampaignPptGeneration(requestContext);
  }
}

if (typeof document !== 'undefined') {
  var installCampaignPptBridges = function() {
    installCampaignPptRenderFence();
    installCampaignPptArtifactBridge();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installCampaignPptBridges);
  else setTimeout(installCampaignPptBridges, 0);
}

function prepareCampaignPptOutlineRequest(url, opts) {
  if (url !== '/ai/ppt-outline' || !opts || typeof opts.body !== 'string') return opts;
  var campaignId = typeof getActiveCampaignId === 'function' ? getActiveCampaignId() : null;
  campaignId = typeof readPositiveInteger === 'function' ? readPositiveInteger(campaignId) : null;
  if (campaignId === null) return opts;

  var body;
  try { body = JSON.parse(opts.body); } catch (error) { return opts; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return opts;

  var demand = body.demand && typeof body.demand === 'object' && !Array.isArray(body.demand)
    ? body.demand
    : {};
  var demandAudit = lastDemandAnalysisAI && typeof lastDemandAnalysisAI === 'object'
    ? lastDemandAnalysisAI
    : {};
  var proposalAudit = lastProposalAI && typeof lastProposalAI === 'object'
    ? lastProposalAI
    : {};
  var currentDemand = curDemand && typeof curDemand === 'object' ? curDemand : {};
  var positive = typeof readPositiveInteger === 'function'
    ? readPositiveInteger
    : function(value) {
        var parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      };
  var firstPositive = function(values) {
    for (var index = 0; index < values.length; index += 1) {
      var parsed = positive(values[index]);
      if (parsed !== null) return parsed;
    }
    return null;
  };

  body.campaign_id = campaignId;
  body.demand_analysis_conversation_id = firstPositive([
    currentDemand.demand_analysis_conversation_id,
    demand.demand_analysis_conversation_id,
    demandAudit.conversation_id
  ]);
  body.demand_analysis_message_id = firstPositive([
    currentDemand.demand_analysis_message_id,
    demand.demand_analysis_message_id,
    demandAudit.message_id
  ]);
  body.proposal_conversation_id = firstPositive([
    currentDemand.proposal_conversation_id,
    demand.proposal_conversation_id,
    proposalAudit.conversation_id
  ]);
  body.proposal_message_id = firstPositive([
    currentDemand.proposal_message_id,
    demand.proposal_message_id,
    proposalAudit.message_id
  ]);

  var knowledgeEntryIds = [];
  var seenKnowledge = {};
  var collectKnowledge = function(values) {
    (Array.isArray(values) ? values : []).forEach(function(value) {
      var id = positive(value);
      if (id === null || seenKnowledge[id] || knowledgeEntryIds.length >= 20) return;
      seenKnowledge[id] = true;
      knowledgeEntryIds.push(id);
    });
  };
  collectKnowledge(body.knowledge_entry_ids);
  collectKnowledge(demand.knowledge_entry_ids);
  collectKnowledge(currentDemand.knowledge_entry_ids);
  collectKnowledge(currentDemand.proposal_knowledge_entry_ids);
  collectKnowledge(demandAudit.knowledge_entry_ids);
  collectKnowledge(proposalAudit.knowledge_entry_ids);
  if (typeof getSelectedKnowledgeEntryIds === 'function') collectKnowledge(getSelectedKnowledgeEntryIds());
  body.knowledge_entry_ids = knowledgeEntryIds;
  body.allow_web = false;
  delete body.knowledge_limit;

  var fingerprintBody = Object.assign({}, body);
  delete fingerprintBody.previousOutline;
  var fingerprint = JSON.stringify(fingerprintBody);
  if (pptOutlineIdempotencyFingerprint !== fingerprint || !pptOutlineIdempotencyKey) {
    pptOutlineIdempotencyFingerprint = fingerprint;
    pptOutlineIdempotencyKey = createDemandAnalysisOperationId('ppt-outline-');
  }

  var headers = {};
  if (opts.headers && typeof opts.headers.forEach === 'function') {
    opts.headers.forEach(function(value, name) { headers[name] = value; });
  } else if (opts.headers && typeof opts.headers === 'object') {
    Object.keys(opts.headers).forEach(function(name) { headers[name] = opts.headers[name]; });
  }
  headers['Idempotency-Key'] = pptOutlineIdempotencyKey;
  headers['X-Request-Id'] = createDemandAnalysisOperationId('ppt-outline-request-');
  return Object.assign({}, opts, { headers: headers, body: JSON.stringify(body) });
}

async function apiFetch(url, opts) {
  opts = opts || {};
  if (
    url === '/proposals' &&
    activePptGenerationContext &&
    !isCampaignPptGenerationCurrent(activePptGenerationContext)
  ) {
    return { ok: true, status: 204 };
  }
  var campaignProposalContext = null;
  var campaignDownloadContext = null;
  var campaignId = readPositiveInteger(getActiveCampaignId());
  if (url === '/proposals' && campaignId !== null) {
    var demandId = await ensureCampaignPptDemandRecord(campaignId);
    var preparedProposal = prepareCampaignPptProposalRequest(url, opts, demandId);
    opts = preparedProposal.options;
    campaignProposalContext = preparedProposal.context;
  }
  if (url === '/proposal/generate-ppt' && campaignId !== null) {
    var preparedDownload = prepareCampaignPptDownloadRequest(url, opts);
    opts = preparedDownload.options;
    campaignDownloadContext = preparedDownload.context;
  }
  opts = prepareCampaignPptOutlineRequest(url, opts);
  var upstreamSignal = null;
  var forwardAbort = null;
  var pptAbortController = null;
  if (url === '/ai/ppt-outline' && activePptGenerationContext && typeof AbortController !== 'undefined') {
    pptAbortController = new AbortController();
    activePptGenerationContext.abortController = pptAbortController;
    upstreamSignal = opts.signal || null;
    forwardAbort = function() { pptAbortController.abort(); };
    if (upstreamSignal) {
      if (upstreamSignal.aborted) forwardAbort();
      else upstreamSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    opts = Object.assign({}, opts, { signal: pptAbortController.signal });
  }
  var isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  var headers = new Headers(opts.headers || {});
  var requestToken = AUTH_TOKEN;
  var requestAuthGeneration = AUTH_GENERATION;
  if (requestToken) headers.set('Authorization', 'Bearer ' + requestToken);
  if (!isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  opts.headers = headers;
  var resp;
  try {
    resp = await fetch(API + url, opts);
  } finally {
    if (upstreamSignal && forwardAbort) upstreamSignal.removeEventListener('abort', forwardAbort);
    if (activePptGenerationContext && activePptGenerationContext.abortController === pptAbortController) {
      activePptGenerationContext.abortController = null;
    }
  }
  if (campaignProposalContext) {
    await observeCampaignPptProposalSave(resp, campaignProposalContext);
  }
  if (
    campaignDownloadContext && resp.ok &&
    campaignDownloadContext.authGeneration === AUTH_GENERATION &&
    readPositiveInteger(getActiveCampaignId()) === campaignDownloadContext.campaignId &&
    campaignPptProposalVersion &&
    campaignPptProposalVersion.proposalId === campaignDownloadContext.proposalId &&
    campaignPptProposalVersion.outlineFingerprint === campaignDownloadContext.outlineFingerprint
  ) {
    campaignPptArchiveState = {
      status: 'generated',
      message: 'PPTX 已生成并归档到当前项目。'
    };
    renderCampaignPptArchiveStatus();
  }
  if (resp.status === 401 && requestAuthGeneration === AUTH_GENERATION && requestToken === AUTH_TOKEN) {
    handleAuthExpired();
  }
  return resp;
}

async function requireSuccessfulCustomerMutation(response, fallbackMessage) {
  if (response && response.ok) return response;

  var status = response && Number.isFinite(Number(response.status)) ? Number(response.status) : 0;
  var payload = null;
  if (response && typeof response.json === 'function') {
    try { payload = await response.json(); } catch (e) {}
  }

  var message = '';
  if (payload && typeof payload === 'object') {
    var messageKeys = ['error', 'message', 'title', 'code'];
    for (var i = 0; i < messageKeys.length; i++) {
      var candidate = payload[messageKeys[i]];
      if (typeof candidate === 'string' && candidate.trim()) {
        message = candidate.trim().slice(0, 300);
        break;
      }
    }
  }
  if (!message) message = String(fallbackMessage || '请求失败').slice(0, 300);
  if (status) message += ' (HTTP ' + status + ')';
  throw new Error(message);
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

// ===== C0: CUSTOMER PIPELINE =====
const CUST_STAGES = {
  lead: '开发中',
  info_confirmed: '信息确认',
  advantage_shared: '优势同步',
  needs_confirmed: '需求确认',
  analysis: '数据分析',
  proposal: '方案中',
  kol_matching: '红人匹配',
  cooperation: '合作落地',
  won: '成交',
  paused: '暂停',
  lost: '丢失'
};
let curStageFilter = '';
let curStatusFilter = '';
let curCustomerScope = 'my';
let customersCache = [];

function syncCustomerStageFilterUI(stage) {
  var normalizedStage = stage || '';
  var select = document.getElementById('custStageFilter');
  if (select) select.value = normalizedStage;
  document.querySelectorAll('#m0StageFilter .tag').forEach(function(t) { t.classList.remove('active'); });
  var activeEl = document.querySelector('#m0StageFilter [data-stage="' + normalizedStage + '"]');
  if (activeEl) activeEl.classList.add('active');
}

async function loadCustomers() {
  var search = document.getElementById('custSearch')?.value || '';
  var qs = '?scope=' + encodeURIComponent(curCustomerScope || 'my');
  if (curStageFilter) qs += '&stage=' + encodeURIComponent(curStageFilter);
  if (curStatusFilter) qs += '&status=' + encodeURIComponent(curStatusFilter);
  if (search) qs += (qs ? '&' : '?') + 'search=' + encodeURIComponent(search);
  try {
    var r = await apiFetch('/customers' + qs);
    var d = await r.json();
    customersCache = d.customers || [];
    renderCustomerTable(customersCache);
    renderCrmCommandCenter();
    loadCustomerStats();
    var m0El = document.getElementById('m0Stats');
    if (m0El) m0El.textContent = '商务SOP · 线索→成交全流程跟踪 · ' + d.total + ' 个客户';
  } catch (e) { console.error(e); }
}

async function loadCustomerStats() {
  try {
    var r = await apiFetch('/customers/stats?scope=' + encodeURIComponent(curCustomerScope || 'my'));
    var d = await r.json();
    var stageCounts = d.byStage || {};
    var tags = document.querySelectorAll('#m0StageFilter .tag');
    tags.forEach(function(t) {
      var stage = t.getAttribute('data-stage');
      var label = t.getAttribute('data-label') || (stage ? (CUST_STAGES[stage] || stage) : '全部');
      var count = stage ? (stageCounts[stage] || 0) : (d.total || 0);
      t.textContent = label + ' (' + count + ')';
    });
    var total = document.getElementById('m0_totalCustomers');
    if (total) total.textContent = d.total || 0;
    var pool = document.getElementById('m0_poolCount');
    if (pool) pool.textContent = d.publicPool || 0;
    var poolTab = document.getElementById('m0_seapoolTabCount');
    if (poolTab) poolTab.textContent = d.publicPool || 0;
    var val = document.getElementById('m0_totalValue');
    if (val) val.textContent = d.totalOppValue ? Number(d.totalOppValue).toLocaleString() : '0';
    renderCrmCommandCenter(d);
  } catch (e) {}
}

function countByStageGroup(stageCounts, keys) {
  return keys.reduce(function(sum, key) { return sum + Number(stageCounts[key] || 0); }, 0);
}

function renderCrmCommandCenter(stats) {
  var data = Array.isArray(customersCache) ? customersCache : [];
  var stageCounts = (stats && stats.byStage) || {};
  if (!Object.keys(stageCounts).length && data.length) {
    data.forEach(function(c) {
      var key = c.stage || 'lead';
      stageCounts[key] = (stageCounts[key] || 0) + 1;
    });
  }

  var highIntent = countByStageGroup(stageCounts, ['needs_confirmed', 'analysis', 'proposal', 'kol_matching']);
  var highIntentEl = document.getElementById('m0_highIntentCount');
  if (highIntentEl) highIntentEl.textContent = highIntent;

  var riskNote = document.getElementById('m0_riskNote');
  if (riskNote) riskNote.textContent = highIntent ? highIntent + ' 个需推进' : '节奏健康';

  var groups = [
    { name: '公海池', count: Number((stats && stats.publicPool) || 0) },
    { name: '开发中', count: countByStageGroup(stageCounts, ['lead', 'info_confirmed', 'advantage_shared']) },
    { name: '需求确认', count: countByStageGroup(stageCounts, ['needs_confirmed', 'analysis']) },
    { name: '方案/合作', count: countByStageGroup(stageCounts, ['proposal', 'kol_matching', 'cooperation']) },
    { name: '成交/暂停', count: countByStageGroup(stageCounts, ['won', 'paused']) }
  ];
  var max = Math.max.apply(null, groups.map(function(g) { return g.count; }).concat([1]));
  var bars = document.getElementById('m0StageBars');
  if (bars) {
    bars.innerHTML = groups.map(function(g, idx) {
      var height = Math.max(18, Math.round((g.count / max) * 100));
      var colors = ['#bfdfff', '#9cd0ff', '#7ebdff', '#4aa3ff', '#007aff'];
      return '<div class="tm-stage-bar">'
        + '<div class="tm-stage-track"><div class="tm-stage-fill" style="height:' + height + '%;background-color:' + colors[idx] + '"></div></div>'
        + '<div class="tm-stage-name">' + g.name + '</div>'
        + '<div class="tm-stage-count">' + g.count + '</div>'
        + '</div>';
    }).join('');
  }

  var focus = data.slice().sort(function(a, b) {
    var stageWeight = { proposal: 4, kol_matching: 4, needs_confirmed: 3, analysis: 3, cooperation: 3, won: 2, paused: 1 };
    var av = Number(a.opportunity_value || 0) + (stageWeight[a.stage] || 0) * 100000;
    var bv = Number(b.opportunity_value || 0) + (stageWeight[b.stage] || 0) * 100000;
    return bv - av;
  })[0];
  var brandEl = document.getElementById('m0FocusBrand');
  var bodyEl = document.getElementById('m0FocusBody');
  if (brandEl && bodyEl) {
    if (focus) {
      brandEl.textContent = focus.brand_name || focus.company_name || '未命名客户';
      bodyEl.textContent = (focus.industry ? focus.industry + '行业，' : '')
        + '当前阶段为' + (CUST_STAGES[focus.stage] || focus.stage || '开发中')
        + '。建议先确认下一步动作，并根据客户预算生成策略草稿。';
    } else {
      brandEl.textContent = '等待客户数据';
      bodyEl.textContent = '新增或导入客户后，系统会根据阶段和商机金额推荐优先跟进对象。';
    }
  }

  var aiEl = document.getElementById('m0AiInsightText');
  if (aiEl) {
    var activeCount = data.filter(function(c) { return ['lead', 'needs_confirmed', 'analysis', 'proposal'].indexOf(c.stage) >= 0; }).length;
    aiEl.textContent = activeCount
      ? '检测到 ' + activeCount + ' 个客户仍在推进中。建议为高意向客户生成跟进任务，并把成功策略归档到知识库。'
      : '当前没有明显推进风险。可继续从公海池认领客户或新增线索。';
  }
}

function filterCustomers(stage) {
  curStageFilter = stage || '';
  syncCustomerStageFilterUI(curStageFilter);
  loadCustomers();
}

function setCustomerScope(scope) {
  curCustomerScope = scope || 'my';
  updateCustomerScopeTabs();
  if (curCrmView !== 'pipeline') switchCrmView('pipeline');
  else loadCustomers();
}

function updateCustomerScopeTabs() {
  document.querySelectorAll('.cust-scope-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-scope') === curCustomerScope);
  });
}

function renderCustomerTable(data) {
  var tbody = document.getElementById('custTableBody');
  if (!data || !data.length) { tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;opacity:.5">暂无客户数据，点击"新增客户"开始</td></tr>'; return; }
  var h = '';
  data.forEach(function(c) {
    h += '<tr style="cursor:pointer" onclick="openCustomerDetail(' + c.id + ')"><td><strong>' + esc(c.brand_name || '-') + '</strong></td>';
    h += '<td>' + esc(c.company_name || '-') + '</td>';
    h += '<td>' + esc(c.industry || '-') + '</td>';
    h += '<td>';
    if (Object.prototype.hasOwnProperty.call(CUST_STAGES, c.stage)) {
      h += '<select onclick="event.stopPropagation()" data-previous-value="' + esc(c.stage || 'lead') + '" onchange="changeCustomerStage(' + c.id + ', this.value, this)" style="width:auto;font-size:11px">';
      Object.keys(CUST_STAGES).forEach(function(k) { h += '<option value="' + k + '"' + (c.stage === k ? ' selected' : '') + '>' + CUST_STAGES[k] + '</option>'; });
      h += '</select>';
    } else {
      h += '<span class="legacy-stage-readonly" title="历史阶段只读">' + esc(c.stage || '历史阶段') + '</span>';
    }
    h += '</td>';
    h += '<td>' + esc(c.contact_person || '-') + '</td>';
    h += '<td style="font-size:11px">' + (c.opportunity_value ? '¥' + Number(c.opportunity_value).toLocaleString() : esc(c.budget_estimate || '-')) + '</td>';
    h += '<td style="font-size:10px;opacity:.6">' + esc(c.assigned_to_name || c.created_by_name || c.source || '-') + '</td>';
    h += '<td style="font-size:10px;opacity:.6">' + (c.updated_at ? c.updated_at.substring(0, 10) : '-') + '</td>';
    h += '<td><button class="btn btn-sm" onclick="event.stopPropagation();openCustomerDetail(' + c.id + ')">详情</button> <button class="btn btn-sm" onclick="event.stopPropagation();editCustomer(' + c.id + ')">编辑</button></td></tr>';
  });
  tbody.innerHTML = h;
}

function showAddCustomer() {
  document.getElementById('custEditId').value = '';
  document.getElementById('addCustomerTitle').textContent = '新增客户';
  ['custBrand','custCompany','custIndustry','custContact','custContactInfo','custSource','custBudget','custNotes'].forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('addCustomerCard').classList.remove('hidden');
}

function openAddCustomer() {
  document.getElementById('custModalTitle').textContent = '新增客户';
  document.getElementById('custEditId').value = '';
  ['custBrand','custCompany','custContact','custContactInfo','custIndustry','custSource','custBudget','custNotes'].forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('custStage').value = 'lead';
  var addStage = document.getElementById('custStage');
  if (addStage) {
    addStage.disabled = true;
    if (addStage.dataset) addStage.dataset.originalStage = 'lead';
  }
  document.getElementById('custModal').style.display = 'flex';
}
function closeCustModal() { document.getElementById('custModal').style.display = 'none'; }
function dismissDup() { document.getElementById('dupWarning').style.display = 'none'; }
function editCustomer(id) {
  var c = customersCache.find(function(x) { return x.id === id; });
  if (!c) return;
  document.getElementById('custEditId').value = c.id;
  var title = document.getElementById('custModalTitle');
  if (title) title.textContent = '编辑客户: ' + (c.brand_name || '');
  document.getElementById('custBrand').value = c.brand_name || '';
  document.getElementById('custCompany').value = c.company_name || '';
  document.getElementById('custIndustry').value = c.industry || '';
  document.getElementById('custContact').value = c.contact_person || '';
  document.getElementById('custContactInfo').value = c.contact_info || '';
  document.getElementById('custSource').value = c.source || '';
  document.getElementById('custBudget').value = c.budget_estimate || '';
  document.getElementById('custNotes').value = c.notes || '';
  var stage = document.getElementById('custStage');
  if (stage) {
    stage.disabled = !Object.prototype.hasOwnProperty.call(CUST_STAGES, c.stage);
    stage.value = c.stage || 'lead';
    if (stage.dataset) stage.dataset.originalStage = c.stage || 'lead';
  }
  var modal = document.getElementById('custModal');
  if (modal) modal.style.display = 'flex';
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
    var response;
    var successMessage;
    var fallbackMessage;
    if (editId) {
      var stageEl = document.getElementById('custStage');
      var currentStage = stageEl && stageEl.value;
      var originalStage = stageEl && stageEl.dataset && stageEl.dataset.originalStage;
      if (currentStage && originalStage && currentStage !== originalStage) {
        var evidence = typeof collectCustomerTransitionEvidence === 'function'
          ? await collectCustomerTransitionEvidence(editId, originalStage, currentStage)
          : null;
        if (!evidence) return;
        body.transition = Object.assign({}, evidence, { to_stage: currentStage });
      }
      response = await apiFetch('/customers/' + editId, { method: 'PUT', body: JSON.stringify(body) });
      successMessage = '客户已更新';
      fallbackMessage = '客户更新失败';
    } else {
      var teamId = typeof getSelectedCrmTeamId === 'function' ? getSelectedCrmTeamId() : null;
      if (!teamId) throw new Error('请选择可用团队');
      body.team_id = teamId;
      response = await apiFetch('/customers', { method: 'POST', body: JSON.stringify(body) });
      successMessage = '客户已创建';
      fallbackMessage = '客户创建失败';
    }
    await requireSuccessfulCustomerMutation(response, fallbackMessage);
    toast(successMessage);
    closeCustModal();
    await loadCustomers();
  } catch (e) { toast('保存失败: ' + e.message, 'error'); }
}

async function changeCustomerStage(id, newStage, selectEl) {
  var previousStage = selectEl && typeof selectEl.getAttribute === 'function'
    ? selectEl.getAttribute('data-previous-value')
    : null;
  try {
    var body;
    if (typeof collectCustomerTransitionEvidence === 'function') {
      var evidence = await collectCustomerTransitionEvidence(id, previousStage, newStage);
      if (!evidence) {
        if (selectEl && previousStage !== null) selectEl.value = previousStage;
        return;
      }
      body = { transition: Object.assign({}, evidence, { to_stage: newStage }) };
    } else {
      body = { stage: newStage };
    }
    var response = await apiFetch('/customers/' + id, { method: 'PUT', body: JSON.stringify(body) });
    await requireSuccessfulCustomerMutation(response, '客户阶段更新失败');
    if (selectEl && typeof selectEl.setAttribute === 'function') {
      selectEl.setAttribute('data-previous-value', newStage);
    }
    toast('阶段已更新: ' + (CUST_STAGES[newStage] || newStage));
    loadCustomerStats();
  } catch (e) {
    if (selectEl && previousStage !== null) selectEl.value = previousStage;
    toast('更新失败: ' + e.message, 'error');
  }
}

var pendingCrmEvidenceResolver = null;
var pendingCrmEvidenceConfig = null;

function crmEvidenceDateTimeValue(date) {
  var local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function crmEvidenceSqliteTimestamp(value) {
  if (!value) return null;
  var parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

function finishCrmEvidenceDialog(result) {
  var overlay = document.getElementById('crmEvidenceOverlay');
  var dialog = document.getElementById('crmEvidenceDialog');
  if (dialog && window.TMAccessibility && window.TMAccessibility.closeDialog) {
    window.TMAccessibility.closeDialog(dialog);
  }
  if (overlay) {
    overlay.style.display = 'none';
    overlay.hidden = true;
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
  }
  var resolve = pendingCrmEvidenceResolver;
  pendingCrmEvidenceResolver = null;
  pendingCrmEvidenceConfig = null;
  if (resolve) resolve(result || null);
}

function cancelCrmEvidenceDialog() {
  finishCrmEvidenceDialog(null);
}

function submitCrmEvidenceDialog() {
  var config = pendingCrmEvidenceConfig || {};
  var reasonEl = document.getElementById('crmEvidenceReason');
  var nextActionEl = document.getElementById('crmEvidenceNextAction');
  var dispositionEl = document.getElementById('crmEvidenceDisposition');
  var exceptionEl = document.getElementById('crmEvidenceException');
  var reasonCode = reasonEl && reasonEl.value ? reasonEl.value : '';
  if (!reasonCode) { toast('请选择变更原因', 'error'); return; }

  var result = { reason_code: reasonCode };
  if (config.showNextAction) {
    var nextActionAt = crmEvidenceSqliteTimestamp(nextActionEl && nextActionEl.value);
    if (config.requireNextAction && !nextActionAt) {
      toast('请选择下一步跟进时间', 'error');
      return;
    }
    if (nextActionAt) result.next_action_at = nextActionAt;
  }
  if (config.showDisposition) {
    var disposition = dispositionEl && dispositionEl.value ? dispositionEl.value : '';
    if (config.requireDisposition && !disposition) {
      toast('请选择项目处理方式', 'error');
      return;
    }
    if (disposition) result.campaign_disposition = disposition;
  }
  if (config.allowNoOpportunityException && exceptionEl && exceptionEl.checked) {
    result.reason_code = 'no_opportunity_exception';
    result.no_opportunity_exception = true;
  }
  finishCrmEvidenceDialog(result);
}

function openCrmEvidenceDialog(config) {
  if (pendingCrmEvidenceResolver) finishCrmEvidenceDialog(null);
  var overlay = document.getElementById('crmEvidenceOverlay');
  var dialog = document.getElementById('crmEvidenceDialog');
  var opener = document.activeElement;
  var title = document.getElementById('crmEvidenceTitle');
  var reason = document.getElementById('crmEvidenceReason');
  var nextRow = document.getElementById('crmEvidenceNextActionRow');
  var nextAction = document.getElementById('crmEvidenceNextAction');
  var dispositionRow = document.getElementById('crmEvidenceDispositionRow');
  var disposition = document.getElementById('crmEvidenceDisposition');
  var exceptionRow = document.getElementById('crmEvidenceExceptionRow');
  var exception = document.getElementById('crmEvidenceException');
  if (!overlay || !reason) return Promise.resolve(null);

  pendingCrmEvidenceConfig = config || {};
  title.textContent = config.title || '补充变更依据';
  reason.innerHTML = (config.reasons || []).map(function(option) {
    return '<option value="' + esc(option.value) + '">' + esc(option.label) + '</option>';
  }).join('');
  if (nextRow) nextRow.style.display = config.showNextAction ? '' : 'none';
  if (nextAction) {
    nextAction.value = config.requireNextAction
      ? crmEvidenceDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1000))
      : '';
  }
  if (dispositionRow) dispositionRow.style.display = config.showDisposition ? '' : 'none';
  if (disposition) disposition.value = config.defaultDisposition || '';
  if (exceptionRow) exceptionRow.style.display = config.allowNoOpportunityException ? '' : 'none';
  if (exception) exception.checked = false;
  overlay.hidden = false;
  overlay.inert = false;
  overlay.removeAttribute('aria-hidden');
  overlay.style.display = 'flex';
  if (dialog && window.TMAccessibility && window.TMAccessibility.openDialog) {
    window.TMAccessibility.openDialog(dialog, opener, cancelCrmEvidenceDialog);
  }
  setTimeout(function() { reason.focus(); }, 0);
  return new Promise(function(resolve) { pendingCrmEvidenceResolver = resolve; });
}

async function collectCustomerTransitionEvidence(customerId, fromStage, toStage) {
  var activeStages = ['lead','info_confirmed','advantage_shared','needs_confirmed','analysis','proposal','kol_matching','cooperation'];
  var requireNextAction = toStage === 'paused' ||
    ((fromStage === 'paused' || fromStage === 'lost' || activeStages.indexOf(fromStage) === -1) && activeStages.indexOf(toStage) >= 0);
  var isOrgAdmin = typeof CURRENT_AUTH_CONTEXT !== 'undefined' && CURRENT_AUTH_CONTEXT &&
    CURRENT_AUTH_CONTEXT.organization && CURRENT_AUTH_CONTEXT.organization.role_code === 'org_admin';
  return openCrmEvidenceDialog({
    kind: 'customer_transition',
    customerId: customerId,
    fromStage: fromStage,
    toStage: toStage,
    title: '客户阶段变更依据',
    reasons: [
      { value: 'requirements_changed', label: '客户需求变化' },
      { value: 'budget_changed', label: '预算变化' },
      { value: 'timeline_changed', label: '项目时间变化' },
      { value: 'stakeholder_changed', label: '关键决策人变化' },
      { value: 'data_correction', label: '数据更正' },
      { value: 'no_response', label: '客户暂无回复' },
      { value: 'competitive_loss', label: '竞争原因' }
    ],
    showNextAction: true,
    requireNextAction: requireNextAction,
    showDisposition: false,
    allowNoOpportunityException: toStage === 'won' && isOrgAdmin
  });
}

async function collectCustomerReleaseReason(customerId) {
  var evidence = await openCrmEvidenceDialog({
    kind: 'customer_release',
    customerId: customerId,
    title: '释放客户到公海',
    reasons: [
      { value: 'capacity_rebalance', label: '跟进容量调整' },
      { value: 'territory_change', label: '负责区域调整' },
      { value: 'manager_assignment', label: '管理者重新分配' },
      { value: 'data_correction', label: '数据更正' }
    ],
    showNextAction: false,
    showDisposition: false,
    allowNoOpportunityException: false
  });
  return evidence && evidence.reason_code ? evidence.reason_code : null;
}

// ===== MISSING M0 FUNCTIONS (v8.2 restored) =====
var currentOppCustomerId = null;
var currentOppOriginalStage = null;
var curCrmView = 'pipeline';

function switchCrmView(view, options) { options = options || {}; if (!options.skipHistory && window.TMNavigation) { window.TMNavigation.navigate('m0-detail', { substate: { view: view }, user: CURRENT_USER }); return; }
  curCrmView = view;
  var tabs = document.querySelectorAll('.crm-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.remove('active');
    tabs[i].style.color = 'var(--text2)';
    tabs[i].style.borderBottom = '2px solid transparent';
  }
  var idx = view === 'pipeline' ? 0 : view === 'seapool' ? 1 : 2;
  if (tabs[idx]) { tabs[idx].classList.add('active'); tabs[idx].style.color = ''; tabs[idx].style.borderBottom = '2px solid transparent'; }

  var pv = document.getElementById('crmPipelineView');
  var sv = document.getElementById('crmSeaPoolView');
  var ov = document.getElementById('crmOpportunityView');
  if (pv) pv.style.display = view === 'pipeline' ? '' : 'none';
  if (sv) sv.style.display = view === 'seapool' ? '' : 'none';
  if (ov) ov.style.display = view === 'opportunities' ? '' : 'none';

  var tb = document.querySelector('#page-m0-detail .toolbar-area');
  if (tb) tb.style.display = view === 'opportunities' ? 'none' : '';
  var sf = document.getElementById('m0StageFilter');
  if (sf) sf.style.display = view === 'opportunities' ? 'none' : '';
  if (view === 'pipeline') syncCustomerStageFilterUI(curStageFilter);

  if (view === 'seapool') { var spT = document.getElementById('seaPoolTable'); if (spT) spT.innerHTML = '<p style="opacity:.5;text-align:center;padding:40px">加载中...</p>'; loadSeaPool(); }
  else if (view === 'opportunities') loadOpportunities();
  else loadCustomers();
}

function showConfirm(title, msg) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('confirmDialogOverlay');
    if (!overlay) { resolve(confirm(msg)); return; }
    var dialog = document.getElementById('confirmDialog');
    var opener = document.activeElement;
    document.getElementById('confirmDialogTitle').textContent = title;
    document.getElementById('confirmDialogMessage').textContent = msg;
    overlay.style.display = 'flex';
    var settled = false;
    function cleanup(result) {
      if (settled) return;
      settled = true;
      overlay.style.display = 'none';
      if (window.TMAccessibility) window.TMAccessibility.closeDialog(dialog);
      resolve(result);
    }
    document.getElementById('confirmDialogOk').onclick = function() { cleanup(true); };
    document.getElementById('confirmDialogCancel').onclick = function() { cleanup(false); };
    overlay.onclick = function(e) { if (e.target === overlay) cleanup(false); };
    if (window.TMAccessibility) {
      window.TMAccessibility.openDialog(dialog, opener, function() { cleanup(false); });
    }
  });
}

async function openCustomerDetail(id) {
  try { var r = await apiFetch('/customers/' + id + '/detail'); var d = await r.json();
    if (!d.customer) { toast('客户不存在', 'error'); return; }
    _lastCustomerDetailData = d;
    renderCustomerSidebar(d);
  } catch(e) { toast('加载失败: ' + e.message, 'error'); }
}
function closeCustomerDetail() {
  var dialog = document.getElementById('customerDetailDialog');
  if (dialog && window.TMAccessibility) window.TMAccessibility.closeDialog(dialog);
  var overlays = [document.getElementById('custDetailOverlay'), document.getElementById('customerDetailOverlay')];
  overlays.forEach(function (overlay) {
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.hidden = true;
  });
  var surfaces = [document.getElementById('custDetailSidebar'), document.getElementById('customerDetailPanel')];
  surfaces.forEach(function (surface) {
    if (!surface) return;
    surface.classList.remove('open');
    surface.hidden = true;
    surface.inert = true;
    surface.setAttribute('aria-hidden', 'true');
  });
}
var activeWorkflowContext = null;
function readPositiveInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  var parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function readExplicitCampaignId(context) {
  if (!context || typeof context !== 'object') return null;
  var campaignId = readPositiveInteger(context.campaign_id);
  if (campaignId === null) campaignId = readPositiveInteger(context.campaignId);
  if (campaignId === null && context.campaign && typeof context.campaign === 'object') {
    campaignId = readPositiveInteger(context.campaign.id);
  }
  return campaignId;
}
function getActiveCampaignId() {
  var campaignId = readExplicitCampaignId(activeWorkflowContext);
  if (campaignId === null) campaignId = readExplicitCampaignId(curDemand);
  return campaignId;
}
function rememberKnowledgeEntryForChat(id) {
  var campaignId = getActiveCampaignId();
  if (selectedKnowledgeCampaignId !== campaignId) {
    selectedKnowledgeEntryIds = [];
    selectedKnowledgeCampaignId = campaignId;
  }
  var entryId = readPositiveInteger(id);
  if (entryId === null || selectedKnowledgeEntryIds.indexOf(entryId) >= 0) return;
  selectedKnowledgeEntryIds.push(entryId);
  if (selectedKnowledgeEntryIds.length > 20) selectedKnowledgeEntryIds.splice(0, selectedKnowledgeEntryIds.length - 20);
}
function getSelectedKnowledgeEntryIds() {
  var campaignId = getActiveCampaignId();
  if (selectedKnowledgeCampaignId !== campaignId) {
    selectedKnowledgeEntryIds = [];
    selectedKnowledgeCampaignId = campaignId;
  }
  return selectedKnowledgeEntryIds.slice(0, 20);
}
function createAiChatIdempotencyKey() {
  var prefix = 'ai-chat-';
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return prefix + window.crypto.randomUUID();
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    var randomValues = new Uint32Array(2);
    window.crypto.getRandomValues(randomValues);
    return prefix + Date.now().toString(36) + '-' + randomValues[0].toString(36) + randomValues[1].toString(36);
  }
  return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function mapCustomerStageToStrategyStage(stage) {
  if (stage === 'lead') return 'new';
  if (stage === 'proposal') return 'growing';
  if (stage === 'won') return 'established';
  return '';
}
function buildWorkflowContext(customer, opportunity) {
  customer = customer || {};
  opportunity = opportunity || {};
  var context = {
    customer_id: customer.id || '',
    opportunity_id: opportunity.id || '',
    brand: customer.brand_name || '',
    company: customer.company_name || '',
    industry: customer.industry || '',
    customer_stage: customer.stage || '',
    budget: customer.budget_estimate || '',
    notes: customer.notes || '',
    source: customer.source || '',
    product: opportunity.product_name || '',
    platform: opportunity.channel_type || '',
    market: '',
    tags: customer.industry || ''
  };
  var campaignId = readExplicitCampaignId(opportunity);
  if (campaignId === null) campaignId = readExplicitCampaignId(customer);
  if (campaignId !== null) context.campaign_id = campaignId;
  return context;
}
function setWorkflowContext(context) {
  var previousCampaignId = getActiveCampaignId();
  activeWorkflowContext = context || null;
  var nextCampaignId = readExplicitCampaignId(activeWorkflowContext);
  if (typeof invalidateDemandAnalysisRequests === 'function') invalidateDemandAnalysisRequests();
  if (typeof invalidateProposalDraftRequests === 'function') invalidateProposalDraftRequests();
  if (previousCampaignId !== nextCampaignId) {
    if (typeof invalidateAiChatRequests === 'function') invalidateAiChatRequests();
    if (typeof invalidateCampaignPptGeneration === 'function') invalidateCampaignPptGeneration();
    if (typeof resetCampaignPptArtifactState === 'function') resetCampaignPptArtifactState();
    selectedKnowledgeEntryIds = [];
    selectedKnowledgeCampaignId = nextCampaignId;
    currentAIConversationId = null;
  }
}
function fillWorkflowBrandSearch(context) {
  switchPage('m1');
  var brandSearch = document.getElementById('brandSearch');
  if (brandSearch) brandSearch.value = context.brand || '';
  if (typeof filterBrands === 'function') filterBrands();
}
function fillWorkflowStrategy(context) {
  switchPage('m2');
  var aiInput = document.getElementById('aiStrategyInput');
  if (aiInput) {
    aiInput.value = '品牌：' + (context.brand || '') + '\n公司：' + (context.company || '') + '\n行业：' + (context.industry || '') + '\n当前阶段：' + (CUST_STAGES[context.customer_stage] || context.customer_stage || '') + '\n产品：' + (context.product || '') + '\n预算：' + (context.budget || '') + '\n渠道偏好：' + (context.platform || '') + '\n备注：' + (context.notes || '');
  }
  var stageEl = document.getElementById('s_stage');
  if (stageEl) stageEl.value = mapCustomerStageToStrategyStage(context.customer_stage);
  var industryEl = document.getElementById('s_industry');
  if (industryEl) industryEl.value = context.industry || '';
  var budgetEl = document.getElementById('s_budget');
  if (budgetEl) {
    var budgetValue = '';
    if (String(context.budget).indexOf('15K') >= 0 && String(context.budget).indexOf('50K') >= 0) budgetValue = 'mid';
    else if (String(context.budget).indexOf('50K') >= 0 || String(context.budget).indexOf('100K') >= 0 || String(context.budget).indexOf('>') >= 0) budgetValue = 'high';
    else if (context.budget) budgetValue = 'low';
    budgetEl.value = budgetValue;
  }
  var goalEl = document.getElementById('s_goal');
  if (goalEl && !goalEl.value) goalEl.value = 'both';
  updateStrategy();
  toast('已带入客户上下文到策略规划');
}
function fillWorkflowDemand(context) {
  switchPage('m3');
  resetDemand();
  var mapping = {
    d_brand: context.brand || '',
    d_product: context.product || '',
    d_usp: context.notes || '',
    d_category: context.industry || '',
    d_area: context.market || '',
    d_budget: context.budget || ''
  };
  Object.keys(mapping).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = mapping[id];
  });
  uploadedDemandFileName = '';
  uploadedDemandContent = 'Brand: ' + (context.brand || '') + '\nCompany: ' + (context.company || '') + '\nIndustry: ' + (context.industry || '') + '\nProduct: ' + (context.product || '') + '\nBudget: ' + (context.budget || '') + '\nChannel: ' + (context.platform || '') + '\nNotes: ' + (context.notes || '');
  var statusEl = document.getElementById('demandFileStatus');
  if (statusEl) statusEl.innerHTML = '已从客户详情带入上下文，无需重新上传文件';
  var hintEl = document.getElementById('aiAnalyzeHint');
  if (hintEl) hintEl.textContent = '可直接 AI 分析，或手动补充后继续';
  var btn = document.getElementById('btnAnalyzeAI');
  if (btn) btn.disabled = false;
  toast('已带入客户上下文到需求方案');
}
function fillWorkflowInfluencers(context) {
  switchPage('m4', { substate: { tab: 'tab1' } });
  var fieldMap = {
    filt_project: context.brand || '',
    filt_product: context.product || '',
    filt_platform: context.platform || '',
    filt_region: context.market || '',
    filt_tags: context.tags || ''
  };
  Object.keys(fieldMap).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = fieldMap[id];
  });
  if (typeof syncM4CampaignContextFromWorkflow === 'function') syncM4CampaignContextFromWorkflow();
  matchInfluencers();
  toast('已带入客户上下文到网红匹配');
}
function openWorkflowFromCustomer(target, opportunityId) {
  if (!_lastCustomerDetailData || !_lastCustomerDetailData.customer) {
    toast('客户上下文未加载完成', 'error');
    return;
  }
  var opportunity = null;
  if (opportunityId && _lastCustomerDetailData.opportunities) {
    opportunity = _lastCustomerDetailData.opportunities.find(function(o) { return o.id == opportunityId; }) || null;
  }
  var context = buildWorkflowContext(_lastCustomerDetailData.customer, opportunity);
  setWorkflowContext(context);
  closeCustomerDetail();
  if (target === 'm1') return fillWorkflowBrandSearch(context);
  if (target === 'm2') return fillWorkflowStrategy(context);
  if (target === 'm3') return fillWorkflowDemand(context);
  if (target === 'm4') return fillWorkflowInfluencers(context);
}
async function archiveCustomerArtifact(artifactType, title, content, context) {
  context = context || activeWorkflowContext || {};
  var customerId = context.customer_id || (curDemand && curDemand.customer_id);
  if (!customerId) {
    toast('缺少客户上下文，无法保存到客户记录', 'error');
    return null;
  }
  if (!content || !String(content).trim()) {
    toast('没有可保存的内容', 'error');
    return null;
  }
  var tags = [context.brand, context.company, context.industry, artifactType].filter(Boolean);
  var resp = await apiFetch('/customers/' + customerId + '/archive-result', {
    method: 'POST',
    body: JSON.stringify({
      artifact_type: artifactType,
      title: title,
      content: content,
      tags: tags,
      source_type: 'ai_' + artifactType
    })
  });
  if (!resp.ok) {
    var err = await resp.json().catch(function() { return {}; });
    throw new Error(err.error || '保存失败');
  }
  var data = await resp.json();
  toast('已保存到客户记录和知识库');
  return data;
}

async function fetchSimilarKnowledge(context, type) {
  context = context || {};
  var params = [];
  if (context.brand) params.push('brand=' + encodeURIComponent(context.brand));
  if (context.industry || context.category) params.push('industry=' + encodeURIComponent(context.industry || context.category));
  if (context.product) params.push('product=' + encodeURIComponent(context.product));
  if (context.market || context.area) params.push('market=' + encodeURIComponent(context.market || context.area));
  if (type) params.push('type=' + encodeURIComponent(type));
  params.push('limit=5');
  var resp = await apiFetch('/knowledge/similar?' + params.join('&'));
  if (!resp.ok) return [];
  var data = await resp.json();
  return data.entries || [];
}

function renderKnowledgeReuse(entries, title) {
  entries = entries || [];
  if (!entries.length) {
    return '<div style="font-size:12px;opacity:.55;padding:10px;background:#fafafa;border-radius:8px">暂无可复用历史案例</div>';
  }
  var html = '<div class="card" style="margin-top:12px;background:#f8fafc;border:1px solid #e5e7eb"><h3 style="font-size:14px;margin-bottom:8px">' + esc(title || '可复用历史案例') + '</h3>';
  html += entries.map(function(e) {
    var text = String(e.content || '').replace(/\s+/g, ' ').slice(0, 220);
    return '<div style="padding:10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;margin-bottom:8px">'
      + '<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px"><strong style="font-size:12px">' + esc(e.entry_type || 'note') + ' #' + e.id + '</strong><span style="font-size:11px;opacity:.55">匹配 ' + Number(e.similarity_score || 0).toFixed(1) + ' · 使用 ' + (e.usage_count || 0) + '</span></div>'
      + '<div style="font-size:12px;line-height:1.6;color:#4b5563">' + esc(text) + '</div>'
      + '<button class="btn btn-xs" style="margin-top:6px" onclick="markKnowledgeUsed(' + e.id + ')">标记已复用</button>'
      + '</div>';
  }).join('');
  html += '</div>';
  return html;
}

function markKnowledgeUsed(id) {
  rememberKnowledgeEntryForChat(id);
  apiFetch('/knowledge/' + id + '/use', { method: 'POST' }).then(function() {
    toast('已标记复用');
  }).catch(function(e) { toast('标记失败', 'error'); });
}

async function saveCurrentStrategy() {
  try {
    await archiveCustomerArtifact('strategy', (activeWorkflowContext?.brand || '客户') + ' AI策略分析', lastAIStrategyRaw, activeWorkflowContext);
  } catch(e) { toast('保存策略失败: ' + e.message, 'error'); }
}
async function saveCurrentProposal() {
  try {
    await archiveCustomerArtifact('proposal', (curDemand?.brand || activeWorkflowContext?.brand || '客户') + ' 红人营销方案', lastProp, activeWorkflowContext);
  } catch(e) { toast('保存方案失败: ' + e.message, 'error'); }
}
function renderCustomerSidebar(d) {
  var c = d.customer;
  var html = '<div class="sidebar-section"><h4>基本信息</h4>';
  html += '<div class="field"><span class="field-label">品牌</span><span class="field-value">' + esc(c.brand_name || '-') + '</span></div>';
  html += '<div class="field"><span class="field-label">公司</span><span class="field-value">' + esc(c.company_name || '-') + '</span></div>';
  html += '<div class="field"><span class="field-label">行业</span><span class="field-value">' + esc(c.industry || '-') + '</span></div>';
  html += '<div class="field"><span class="field-label">联系人</span><span class="field-value">' + esc(c.contact_person || '-') + '</span></div>';
  html += '<div class="field"><span class="field-label">阶段</span><span class="field-value">' + (CUST_STAGES[c.stage] || c.stage) + '</span></div>';
  html += '<div class="field"><span class="field-label">来源</span><span class="field-value">' + esc(c.source || '-') + '</span></div>';
  html += '<div class="field"><span class="field-label">预算</span><span class="field-value">' + esc(c.budget_estimate || '-') + '</span></div>';
  html += '<div class="field"><span class="field-label">备注</span><span class="field-value">' + esc(c.notes || '-') + '</span></div></div>';
  html += '<div class="sidebar-section" style="display:flex;gap:8px;flex-wrap:wrap">';
  if (c.is_public == 1) html += '<button class="btn btn-primary btn-sm" onclick="claimCustomer(' + c.id + ', true)">📥 认领客户</button>';
  else html += '<button class="btn btn-outline btn-sm" onclick="returnToPool(' + c.id + ', true)">🌊 释放到公海</button>';
  html += '<button class="btn btn-outline btn-sm" onclick="editCustomer(' + c.id + ');closeCustomerDetail()">✏️ 编辑</button>';
  html += '<button class="btn btn-sm btn-primary" onclick="showOppModal(' + c.id + ')">💼 新增商机</button>';
  html += '<span class="crm-control-unavailable" title="硬删除已禁用">客户硬删除不可用</span></div>';
  html += '<div class="sidebar-section"><h4>下一步动作</h4><div style="display:flex;gap:8px;flex-wrap:wrap">';
  html += '<button class="btn btn-sm btn-outline" onclick="openWorkflowFromCustomer(\'m1\')">🔎 品牌洞察</button>';
  html += '<button class="btn btn-sm btn-outline" onclick="openWorkflowFromCustomer(\'m2\')">🎯 生成策略</button>';
  html += '<button class="btn btn-sm btn-outline" onclick="openWorkflowFromCustomer(\'m3\')">📋 写方案</button>';
  html += '<button class="btn btn-sm btn-outline" onclick="openWorkflowFromCustomer(\'m4\')">👥 匹配达人</button>';
  html += '</div></div>';
  html += '<div class="sidebar-section"><h4>商机 (' + (d.opportunities||[]).length + ')</h4>';
  if (d.opportunities && d.opportunities.length) {
    html += '<div style="font-size:12px">';
    d.opportunities.forEach(function(o) { html += '<div style="padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer" onclick="showOpportunityDetail(' + o.id + ')"><div style="font-weight:600">' + esc(o.name) + '</div><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2)"><span>¥'+(o.value||0).toLocaleString()+'</span><span>'+(o.stage||'-')+' | '+(o.win_probability||0)+'%</span></div></div>'; });
    html += '</div>';
  } else html += '<p style="font-size:12px;color:var(--text2)">暂无商机</p>';
  html += '</div>';
  html += '<div class="sidebar-section"><h4>活动日志</h4>';
  if (d.activity && d.activity.length) {
    html += '<div style="font-size:12px;max-height:300px;overflow-y:auto">';
    d.activity.forEach(function(a) { html += '<div style="padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text2)">'+(a.created_at||'').substring(0,16)+'</span> <strong>'+esc(a.action||'')+'</strong>'+(a.display_name?' <span style="color:var(--text2)">by '+esc(a.display_name)+'</span>':'')+(a.notes?'<br><span style="color:#666">'+esc(a.notes)+'</span>':'')+'</div>'; });
    html += '</div>';
  } else html += '<p style="font-size:12px;color:var(--text2)">暂无活动记录</p>';
  html += '</div>';
  html += '<div class="sidebar-section"><h4>添加跟进</h4><div style="display:flex;gap:6px"><input id="activityText" placeholder="输入跟进内容..." style="flex:1;padding:6px 10px;font-size:12px"><button class="btn btn-primary btn-sm" onclick="addCustomerActivity(' + c.id + ')">记录</button></div></div>';
  document.getElementById('custDetailTitle').textContent = c.brand_name || '客户详情';
  document.getElementById('custDetailBody').innerHTML = html;
  var opener = document.activeElement;
  var overlay = document.getElementById('custDetailOverlay');
  var sidebar = document.getElementById('custDetailSidebar');
  var dialog = document.getElementById('customerDetailDialog');
  overlay.hidden = false;
  overlay.style.display = 'block';
  sidebar.hidden = false;
  sidebar.inert = false;
  sidebar.removeAttribute('aria-hidden');
  sidebar.classList.add('open');
  if (window.TMAccessibility) {
    window.TMAccessibility.openDialog(dialog, opener, function() { closeCustomerDetail(); });
  }
}

var _lastCustomerDetailData = null;
function showOpportunityDetail(id) {
  var opp = null;
  if (_lastCustomerDetailData && _lastCustomerDetailData.opportunities) opp = _lastCustomerDetailData.opportunities.find(function(o){return o.id==id});
  if (!opp) { toast('商机数据未找到','error'); return; }
  var stageLabels={discovery:'需求分析',qualification:'资格确认',proposal:'方案报价','negotiation':'谈判中',won:'已赢单',lost:'已输单'};
  var html='<div class="sidebar-section"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="cursor:pointer;font-size:16px" onclick="renderCustomerSidebar(_lastCustomerDetailData)" title="返回客户详情">←</span><h4 style="margin:0;flex:1">'+esc(opp.name)+'</h4></div></div>';
  html+='<div class="sidebar-section"><div class="field"><span class="field-label">金额</span><span class="field-value">¥'+(opp.value||0).toLocaleString()+'</span></div><div class="field"><span class="field-label">阶段</span><span class="field-value">'+(stageLabels[opp.stage]||opp.stage)+'</span></div><div class="field"><span class="field-label">赢单概率</span><span class="field-value">'+(opp.win_probability||0)+'%</span></div><div class="field"><span class="field-label">产品</span><span class="field-value">'+esc(opp.product_name||'-')+'</span></div><div class="field"><span class="field-label">渠道类型</span><span class="field-value">'+esc(opp.channel_type||'-')+'</span></div><div class="field"><span class="field-label">预计成交</span><span class="field-value">'+(opp.expected_close_date||'-')+'</span></div><div class="field"><span class="field-label">备注</span><span class="field-value">'+esc(opp.notes||'-')+'</span></div></div>';
  html+='<div class="sidebar-section" style="display:flex;gap:8px"><button class="btn btn-sm btn-outline" onclick="renderCustomerSidebar(_lastCustomerDetailData)">← 返回客户</button><span class="crm-control-unavailable" title="硬删除已禁用">商机硬删除不可用</span></div>';
  document.getElementById('custDetailTitle').textContent = '商机: '+opp.name;
  document.getElementById('custDetailBody').innerHTML = html;
}

async function claimCustomer(id, closeDetailOnSuccess) {
  try {
    var teamId = typeof getSelectedCrmTeamId === 'function' ? getSelectedCrmTeamId() : null;
    if (!teamId) { toast('请选择可用团队', 'error'); return; }
    var options = { method: 'POST', body: JSON.stringify({ team_id: teamId }) };
    var response = await apiFetch('/customers/' + id + '/claim', options);
    await requireSuccessfulCustomerMutation(response, '认领客户失败');
    toast('已认领客户');
    if (closeDetailOnSuccess) closeCustomerDetail();
    loadCustomers();
  } catch (e) { toast('认领失败: ' + e.message, 'error'); }
}
async function returnToPool(id, closeDetailOnSuccess) {
  try {
    var reason = typeof collectCustomerReleaseReason === 'function' ? await collectCustomerReleaseReason(id) : null;
    if (!reason) return;
    var options = { method: 'POST', body: JSON.stringify({ reason_code: reason }) };
    var response = await apiFetch('/customers/' + id + '/return', options);
    await requireSuccessfulCustomerMutation(response, '释放客户失败');
    toast('已释放到公海');
    if (closeDetailOnSuccess) closeCustomerDetail();
    loadCustomers();
  } catch (e) { toast('释放失败: ' + e.message, 'error'); }
}

async function loadOpportunities() {
  try { var url='/opportunities?pageSize=1000'; var sf2=document.getElementById('oppStageFilter'); var cf2=document.getElementById('oppCustomerFilter');
    if (sf2&&sf2.value) url+='&stage='+encodeURIComponent(sf2.value);
    if (cf2&&cf2.value.trim()) url+='&search='+encodeURIComponent(cf2.value.trim());
    var resp=await apiFetch(url); var data=await resp.json(); var rows=data.opportunities||data.rows||[];
    var tbody=document.getElementById('oppTableBody'); if(!tbody) return;
    if(!rows.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:30px;opacity:.5">暂无商机</td></tr>';return}
    var sl={discovery:'需求分析',qualification:'资格确认',proposal:'方案报价','negotiation':'谈判中',won:'已赢单',lost:'已输单'};
    var h=''; for(var i=0;i<rows.length;i++){var o=rows[i]; h+='<tr data-opp-id="'+o.id+'" style="cursor:pointer" onclick="editOpportunity('+o.id+')"><td><strong>'+esc(o.name)+'</strong></td><td>'+(o.brand_name||'-')+'</td><td>¥'+(o.value||0).toLocaleString()+'</td><td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:'+(o.stage==='won'?'#e8f5e9':o.stage==='lost'?'#fbe9e7':'#fff3e0')+'">'+(sl[o.stage]||o.stage)+'</span></td><td>'+(o.win_probability||0)+'%</td><td style="font-size:11px">'+(o.expected_close_date||'-')+'</td><td><span class="crm-control-unavailable" title="硬删除已禁用">硬删除不可用</span></td></tr>'; }
    tbody.innerHTML=h; var cnt=document.getElementById('oppCount'); if(cnt)cnt.textContent=rows.length+' 条商机';
  } catch(e){ var tbe=document.getElementById('oppTableBody'); if(tbe)tbe.innerHTML='<tr><td colspan="7" style="text-align:center;padding:30px;color:#d94641">加载失败: '+esc(e.message)+'</td></tr>'; }
}
function showOppModal(cid) {
  currentOppCustomerId = cid;
  currentOppOriginalStage = null;
  document.getElementById('oppEditId').value = '';
  document.getElementById('oppCustomerId').value = cid || '';
  document.getElementById('oppName').value = '';
  document.getElementById('oppValue').value = '';
  var stage = document.getElementById('oppStage');
  stage.value = 'discovery';
  stage.disabled = true;
  document.getElementById('oppProbability').value = '50';
  ['oppProduct','oppChannel','oppCloseDate','oppNotes','oppDecisionChain','oppLossReason'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('oppModalTitle').textContent = '新增商机';
  document.getElementById('oppModalOverlay').style.display = 'flex';
}
function closeOppModal() { document.getElementById('oppModalOverlay').style.display='none'; }
async function saveOpportunity() {
  var name=document.getElementById('oppName').value.trim(); if(!name){toast('请输入商机名称','error');return}
  var customerId=currentOppCustomerId||document.getElementById('oppCustomerId').value; if(!customerId){toast('未指定客户，请从客户详情页创建商机','error');return}
  var stage = document.getElementById('oppStage').value;
  var probabilityInput = document.getElementById('oppProbability').value;
  var probability = probabilityInput === '' ? 50 : Number(probabilityInput);
  if (!Number.isFinite(probability)) probability = 50;
  var body={customer_id:parseInt(customerId)||customerId,name:name,value:Number(document.getElementById('oppValue').value)||0,win_probability:probability,product_name:document.getElementById('oppProduct').value.trim(),channel_type:document.getElementById('oppChannel').value.trim(),expected_close_date:document.getElementById('oppCloseDate').value||null,decision_chain:document.getElementById('oppDecisionChain')?.value.trim()||'',loss_reason:document.getElementById('oppLossReason')?.value.trim()||'',notes:document.getElementById('oppNotes').value.trim()};
  var editId=document.getElementById('oppEditId')?.value;
  if (editId && currentOppOriginalStage && stage !== currentOppOriginalStage) {
    var transitionEvidence = typeof collectOpportunityTransitionEvidence === 'function'
      ? await collectOpportunityTransitionEvidence(editId, currentOppOriginalStage, stage)
      : null;
    if (!transitionEvidence) { toast('请补充商机阶段变更依据', 'error'); return; }
    body.transition = Object.assign({}, transitionEvidence, { to_stage: stage });
  }
  var btn=document.querySelector('#oppModalOverlay .btn-primary'); if(btn){btn.textContent='保存中...';btn.style.opacity='0.6'}
  try { var response = editId ? await apiFetch('/opportunities/'+editId,{method:'PUT',body:JSON.stringify(body)}) : await apiFetch('/opportunities',{method:'POST',body:JSON.stringify(body)});
    await requireSuccessfulCustomerMutation(response, '商机保存失败');
    toast(editId?'商机已更新':'商机已创建'); closeOppModal();
    if(document.getElementById('custDetailSidebar')&&document.getElementById('custDetailSidebar').classList.contains('open')){ try{openCustomerDetail(parseInt(customerId))}catch(e2){} }
    try{loadOpportunities()}catch(e2){}
  } catch(e) { toast('保存失败: '+e.message,'error'); }
  finally { var btn2=document.querySelector('#oppModalOverlay .btn-primary'); if(btn2){btn2.textContent='保存';btn2.style.opacity='1'} }
}
async function collectOpportunityTransitionEvidence(opportunityId, fromStage, toStage) {
  var terminal = toStage === 'won' || toStage === 'lost';
  return openCrmEvidenceDialog({
    kind: 'opportunity_transition',
    opportunityId: opportunityId,
    fromStage: fromStage,
    toStage: toStage,
    title: '商机阶段变更依据',
    reasons: [
      { value: 'requirements_changed', label: '客户需求变化' },
      { value: 'budget_changed', label: '预算变化' },
      { value: 'timeline_changed', label: '项目时间变化' },
      { value: 'stakeholder_changed', label: '关键决策人变化' },
      { value: 'data_correction', label: '数据更正' },
      { value: 'competitive_loss', label: '竞争原因' },
      { value: 'no_response', label: '客户暂无回复' }
    ],
    showNextAction: false,
    showDisposition: true,
    requireDisposition: terminal,
    defaultDisposition: terminal ? 'close' : 'continue',
    allowNoOpportunityException: false
  });
}
async function editOpportunity(id) {
  try {
    var detailResponse = await apiFetch('/opportunities/' + encodeURIComponent(id) + '/detail');
    await requireSuccessfulCustomerMutation(detailResponse, '商机详情加载失败');
    var detailData = await detailResponse.json();
    var opp = detailData && detailData.opportunity;
    if (opp && opp.id != id) opp = null;
    if (!opp) { toast('商机详情未找到', 'error'); return; }

    currentOppCustomerId = opp.customer_id;
    currentOppOriginalStage = opp.stage || 'discovery';
    document.getElementById('oppEditId').value = opp.id || '';
    document.getElementById('oppCustomerId').value = opp.customer_id || '';
    document.getElementById('oppName').value = opp.name || '';
    document.getElementById('oppValue').value = opp.value || '';
    var stage = document.getElementById('oppStage');
    stage.value = opp.stage || 'discovery';
    stage.disabled = false;
    document.getElementById('oppProbability').value = opp.win_probability === null || opp.win_probability === undefined || opp.win_probability === ''
      ? 50
      : opp.win_probability;
    document.getElementById('oppProduct').value = opp.product_name || '';
    document.getElementById('oppChannel').value = opp.channel_type || '';
    document.getElementById('oppCloseDate').value = typeof opp.expected_close_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(opp.expected_close_date)
      ? opp.expected_close_date.slice(0, 10)
      : '';
    document.getElementById('oppDecisionChain').value = opp.decision_chain || '';
    document.getElementById('oppLossReason').value = opp.loss_reason || '';
    document.getElementById('oppNotes').value = opp.notes || '';
    document.getElementById('oppModalTitle').textContent = '编辑商机: ' + opp.name;
    document.getElementById('oppModalOverlay').style.display = 'flex';
  } catch (e) {
    toast('加载失败: ' + e.message, 'error');
  }
}
async function addCustomerActivity(cid) { var text=document.getElementById('activityText')?.value;if(!text){toast('请输入跟进内容','error');return} try{var response=await apiFetch('/customers/'+cid+'/archive-result',{method:'POST',body:JSON.stringify({artifact_type:'note',title:'客户跟进记录',content:text,tags:['crm','follow-up'],source_type:'manual_note'})});await requireSuccessfulCustomerMutation(response,'记录跟进失败');toast('已记录');await openCustomerDetail(cid)} catch(e){toast('记录失败: '+e.message,'error')} }

async function loadSeaPool() {
  try { var r=await apiFetch('/customers/sea-pool'); var d=await r.json(); var customers=d.customers||[];
    var spT=document.getElementById('seaPoolTable'); if(!spT)return;
    var h='<table><thead><tr><th>品牌</th><th>公司</th><th>行业</th><th>最后更新</th><th>操作</th></tr></thead><tbody>';
    if(!customers.length) h+='<tr><td colspan="5" style="text-align:center;padding:30px;opacity:.5">🌊 公海池暂无客户</td></tr>';
    else customers.forEach(function(c){h+='<tr><td><strong>'+(c.brand_name||'')+'</strong></td><td>'+(c.company_name||'')+'</td><td>'+(c.industry||'')+'</td><td style="font-size:11px;opacity:.6">'+(c.updated_at||'').substring(0,10)+'</td><td><button class="btn btn-sm btn-primary" onclick="claimCustomer('+c.id+')">认领</button></td></tr>';});
    h+='</tbody></table>'; spT.innerHTML=h;
    var poolTab=document.getElementById('m0_seapoolTabCount'); if(poolTab)poolTab.textContent=customers.length;
    var pool=document.getElementById('m0_poolCount'); if(pool)pool.textContent=customers.length;
  } catch(e) {}
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
        rememberAuthContext(d.auth_context || d.authContext || (d.user && d.user.auth_context));
        document.getElementById('authOverlay').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        if (CURRENT_USER.role === 'admin') {
          document.querySelectorAll('.admin-only').forEach(el => el.classList.add('visible'));
        }
        curCustomerScope = CURRENT_USER.role === 'admin' ? 'all' : 'my';
        updateCustomerScopeTabs();
        await initApp(); if (window.TMNavigation) window.TMNavigation.restore(CURRENT_USER);
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
  var reuseContext = activeWorkflowContext || {};
  if (!reuseContext.brand) reuseContext.brand = input.slice(0, 80);
  var similarCases = [];
  try {
    similarCases = await fetchSimilarKnowledge(reuseContext, 'strategy');
  } catch(e) { similarCases = []; }

  var context = {
    brandCount: BRANDS.length,
    sampleBrands: BRANDS.slice(0,15).map(function(b) { return { name: b.name, industry: (b.industry_tags||[]).join(', '), revenue: b.estimated_annual_revenue }; }),
    industries: Object.keys((window.INDUSTRY_TREE || {})).join(', '),
    reusableCases: similarCases.map(function(e) {
      return {
        id: e.id,
        type: e.entry_type,
        score: e.similarity_score,
        summary: String(e.content || '').slice(0, 600)
      };
    })
  };

  var prompt = 'You are a senior overseas influencer marketing strategist at TuringMarket. Analyze the customer profile below and provide a comprehensive strategy in Chinese:\n\nCustomer: ' + input + '\n\nReference data (from our brand database and reusable historical cases): ' + JSON.stringify(context) + '\n\nWhen reusableCases are relevant, explicitly borrow their proven tactics, but do not copy text verbatim. Provide: 1) Market opportunity analysis 2) Recommended influencer types and platforms 3) Estimated budget allocation (60-30-10 model) 4) Competitor benchmarking suggestions 5) 3-month execution roadmap 6) Risk factors and mitigation 7) Reusable historical lessons. Format with clear headings and bullet points. Be specific and actionable.';

  try {
    var resp = await apiFetch('/ai/strategy', {
      method: 'POST',
      body: JSON.stringify({ prompt: prompt, input: input })
    });
    if (!resp.ok) {
      var errText = '';
      try { var errJson = await resp.json(); errText = errJson.error || JSON.stringify(errJson); } catch(e0) {}
      throw new Error(errText || ('服务请求失败: ' + resp.status));
    }
    var data = await resp.json();
    var result = data.content || '';
    if (!result) throw new Error('AI 服务未返回内容');
    lastAIStrategyRaw = result;
    var renderedResult = renderSafeMarkdown(result);
    var aiNotice = data.fallback
      ? '<div style="margin-bottom:12px;padding:10px 12px;border-radius:12px;background:#fff7ed;color:#c2410c;font-size:13px">AI 服务当前处于降级模式：' + esc(data.warning || '请检查服务器 DeepSeek API Key') + '</div>'
      : '';
    out.innerHTML = aiNotice + renderKnowledgeReuse(similarCases, '本次策略参考的历史案例') + renderedResult;
    if (activeWorkflowContext && activeWorkflowContext.customer_id) {
      out.innerHTML += '<div style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="saveCurrentStrategy()">保存到客户记录和知识库</button></div>';
    }
    status.textContent = data.fallback ? 'Basic draft generated' : 'Analysis complete';
  } catch(e) {
    out.innerHTML = '<span style="color:#d94641">AI 策略生成失败：' + esc(e.message) + '。请检查登录状态或联系管理员查看服务器 AI 配置。</span>';
    status.textContent = 'Failed';
  }
}
// ===== END PHASE 4 =====
// ===== UTILS =====

function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function renderSafeMarkdown(text) {
  var safe = esc(text || '');
  safe = safe.replace(/^###\s+(.+)$/gm, '<h3 style="margin-top:16px;font-size:16px">$1</h3>');
  safe = safe.replace(/^##\s+(.+)$/gm, '<h3 style="margin-top:16px;font-size:16px">$1</h3>');
  safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/^\-\s+(.+)$/gm, '<li>$1</li>');
  return safe.replace(/\n/g, '<br>');
}
function copyText(t) { try { navigator.clipboard.writeText(t); toast("已复制: " + t); } catch(e) { window.prompt("手动复制邮箱:", t); } }




function toast(m, ty) {
  var TOAST_QUEUE_LIMIT = 3;
  ty = ty || 'success';
  var focusBeforeToast = document.activeElement;
  var c = document.getElementById('toastContainer');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toastContainer';
    c.className = 'toast-container';
    document.body.appendChild(c);
  }
  var e = document.createElement('div');
  e.className = 'toast toast-' + ty + ' ' + ty;
  var message = document.createElement('div');
  message.className = 'tm-toast-message';
  message.setAttribute('role', ty === 'error' ? 'alert' : 'status');
  message.textContent = m;
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'tm-toast-close';
  close.setAttribute('aria-label', '关闭通知');
  close.setAttribute('title', '关闭通知');
  close.textContent = '\u00d7';
  close.addEventListener('click', function () {
    var restoreFocus = document.activeElement === close && focusBeforeToast && focusBeforeToast.isConnected;
    e.remove();
    if (restoreFocus && typeof focusBeforeToast.focus === 'function') focusBeforeToast.focus();
  });
  e.appendChild(message);
  e.appendChild(close);
  c.appendChild(e);
  while (c.children.length > TOAST_QUEUE_LIMIT) {
    var active = document.activeElement;
    var removable = null;
    for (var index = 0; index < c.children.length; index += 1) {
      if (!c.children[index].contains(active)) {
        removable = c.children[index];
        break;
      }
    }
    if (!removable) break;
    removable.remove();
  }
}
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
  if (!q) { toast('请输入品牌名称', 'error'); return }
  var a = document.getElementById('brandEnrichArea');
  if (a) a.innerHTML = '<div class=brand-enrich>正在联网补充品牌情报：' + esc(q) + '...</div>';
  try {
    var r = await apiFetch('/brands/enrich', {
      method: 'POST',
      body: JSON.stringify({ brand: q })
    });
    if (!r.ok) throw new Error('API:' + r.status);
    var d = await r.json();
    var bd = d.brand || d;
    var nb = normalizeEnrichedBrand(bd, q);
    upsertBrandRecord(nb);
    selectedBrandName = nb.name;
    _brandRelationCache = null;
    buildBrandRelationCache();
    try { await apiFetch('/brands', { method: 'POST', body: JSON.stringify(brandToApiPayload(nb)) }); } catch(e2) {}
    filterBrands();
    renderBrandDetail(nb);
    var webNote = d.web_search && d.web_search.used ? ' · 已结合 Tavily 联网来源' : '';
    if (a) a.innerHTML = '<div class=brand-enrich>已补充并归档：' + esc(nb.name) + ' · ' + esc((nb.industry_tags || []).join(' / ')) + ' · ' + esc(nb.estimated_annual_revenue || '') + webNote + '</div>';
    toast('品牌已补充并写入知识库：' + nb.name);
  } catch (e) {
    if (a) a.innerHTML = '<div class=brand-enrich>补充失败：' + esc(e.message) + '</div>';
    toast('品牌补充失败', 'error');
  }
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
    h += '<div class="card tm-template-card" id="tcard-' + t.id + '" onclick="selTmpl(' + "'" + t.id + "'" + ')"><h3 style="font-size:14px">' + esc(t.name) + '</h3><p style="font-size:11px;opacity:.6;margin:6px 0">' + esc(t.description) + '</p></div>';
  }
  h += '<div class="card tm-template-card" id="tcard-custom" onclick="selTmpl(' + "'custom'" + ')"><h3 style="font-size:14px">自定义方案</h3><p style="font-size:11px;opacity:.6;margin:6px 0">按本次客户需求自定义方案标题、汇报结构和页面模块。</p><div style="font-size:11px;color:var(--text2)">适合非标准 brief、临时新增页面或客户指定格式。</div></div>';
  c.innerHTML = h;
  var customBox = document.getElementById('customTemplateBox');
  if (!customBox) {
    c.insertAdjacentHTML('afterend',
      '<div class="tm-custom-template" id="customTemplateBox">'
      + '<div class="grid grid-2">'
      + '<div><label>自定义方案名称</label><input id="customTplName" placeholder="例如：BLUETTI 新品红人营销专项方案"></div>'
      + '<div><label>方案定位</label><input id="customTplDesc" placeholder="例如：适合新品上市、预算拆解、达人执行落地"></div>'
      + '</div>'
      + '<label style="margin-top:10px">方案页面结构（一行一个模块）</label>'
      + '<textarea id="customTplSections" placeholder="例如：\n项目背景与甲方需求理解\n产品卖点与目标人群洞察\n竞品与内容机会分析\n红人矩阵与筛选标准\n预算拆分与执行排期\n风险控制与下一步确认" style="min-height:150px"></textarea>'
      + '</div>'
    );
  }
  updateTemplateSelectionUI();
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
function selTmpl(id) {
  selTpl = id;
  updateTemplateSelectionUI();
}
function updateTemplateSelectionUI() {
  document.querySelectorAll('#tmplSelect .tm-template-card').forEach(function(card) {
    card.classList.toggle('active', card.id === 'tcard-' + selTpl);
  });
  var customBox = document.getElementById('customTemplateBox');
  if (customBox) customBox.classList.toggle('active', selTpl === 'custom');
}
function getSelectedProposalTemplate() {
  if (selTpl === 'custom') {
    var name = (document.getElementById('customTplName')?.value || '').trim() || '自定义方案';
    var desc = (document.getElementById('customTplDesc')?.value || '').trim() || '本次客户需求定制方案';
    var sections = String(document.getElementById('customTplSections')?.value || '')
      .split(/\n+/)
      .map(function(s) { return s.trim(); })
      .filter(Boolean);
    if (!sections.length) {
      sections = ['项目背景与客户需求理解', '产品卖点与目标人群洞察', '红人策略与内容方向', '执行排期与预算拆分', '风险控制与下一步确认'];
    }
    return { id: 'custom', name: name, description: desc, sections: sections };
  }
  return TEMPLATES.find(function(t) { return t.id === selTpl; });
}
var lastProposalAI = null;
var proposalRequestGeneration = 0;
var proposalInFlight = false;
function beginProposalDraftRequest() {
  if (proposalInFlight) return null;
  proposalInFlight = true;
  var campaignId = getActiveCampaignId();
  return {
    generation: ++proposalRequestGeneration,
    campaignId: campaignId,
    requestId: createDemandAnalysisOperationId('proposal-draft-request-'),
    idempotencyKey: campaignId === null ? '' : createDemandAnalysisOperationId('proposal-draft-')
  };
}
function isCurrentProposalDraftRequest(requestContext) {
  return !!requestContext && requestContext.generation === proposalRequestGeneration;
}
function finishProposalDraftRequest(requestContext) {
  if (!isCurrentProposalDraftRequest(requestContext)) return false;
  proposalInFlight = false;
  return true;
}
function invalidateProposalDraftRequests() {
  proposalRequestGeneration += 1;
  proposalInFlight = false;
  lastProposalAI = null;
  var generateButton = document.getElementById('btnGenerateProposal');
  if (generateButton) generateButton.disabled = false;
}
function buildProposalDemandContent(demand) {
  demand = demand || {};
  return [
    '品牌: ' + (demand.brand || ''),
    '公司: ' + (demand.company || ''),
    '产品: ' + (demand.product || ''),
    '卖点: ' + (demand.usp || demand.notes || ''),
    '平台: ' + (demand.platform || ''),
    '市场: ' + (demand.area || ''),
    '预算: ' + (demand.budget || ''),
    '行业: ' + (demand.category || demand.industry || ''),
    '竞品: ' + (demand.competitors || ''),
    '补充要求: ' + (demand.notes || '')
  ].join('\n');
}
function buildProposalDraftRequestOptions(demand, template, requestContext) {
  demand = demand || {};
  template = template || {};
  var seenKnowledge = {};
  var knowledgeEntryIds = [];
  (Array.isArray(demand.knowledge_entry_ids) ? demand.knowledge_entry_ids : []).forEach(function(value) {
    var id = readPositiveInteger(value);
    if (id === null || seenKnowledge[id] || knowledgeEntryIds.length >= 20) return;
    seenKnowledge[id] = true;
    knowledgeEntryIds.push(id);
  });
  var body = {
    title: (demand.brand || demand.product || '客户需求') + ' 红人营销方案',
    demand: demand,
    demand_content: buildProposalDemandContent(demand),
    template: {
      id: String(template.id || '').slice(0, 80),
      name: String(template.name || '').slice(0, 160),
      description: String(template.description || '').slice(0, 600),
      sections: (Array.isArray(template.sections) ? template.sections : []).slice(0, 20).map(function(section) {
        return String(section || '').slice(0, 200);
      })
    },
    allow_web: false,
    knowledge_entry_ids: knowledgeEntryIds,
    demand_analysis_conversation_id: readPositiveInteger(demand.demand_analysis_conversation_id),
    demand_analysis_message_id: readPositiveInteger(demand.demand_analysis_message_id)
  };
  var options = { method: 'POST' };
  if (requestContext && readPositiveInteger(requestContext.campaignId) !== null) {
    body.campaign_id = requestContext.campaignId;
    options.headers = {
      'Idempotency-Key': requestContext.idempotencyKey,
      'X-Request-Id': requestContext.requestId
    };
  }
  options.body = JSON.stringify(body);
  return options;
}
function captureProposalDraftAudit(ai, campaignId) {
  lastProposalAI = normalizeDemandAnalysisAudit(ai, campaignId);
  if (curDemand && typeof curDemand === 'object') {
    curDemand.proposal_conversation_id = lastProposalAI.conversation_id || '';
    curDemand.proposal_message_id = lastProposalAI.message_id || '';
    curDemand.proposal_knowledge_entry_ids = lastProposalAI.knowledge_entry_ids.slice(0, 20);
  }
  if (typeof rememberKnowledgeEntryForChat === 'function') {
    lastProposalAI.knowledge_entry_ids.forEach(rememberKnowledgeEntryForChat);
  }
  return lastProposalAI;
}
function renderProposalDraftEvidence(audit) {
  return renderDemandAnalysisEvidence(audit);
}
function buildLocalProposalDraft(demand, template, similarCases) {
  demand = demand || {};
  template = template || { name: '方案模板', sections: [] };
  similarCases = Array.isArray(similarCases) ? similarCases : [];
  var nl = '\n';
  var content = '# ' + (demand.brand || '品牌') + ' 红人营销方案' + nl + nl
    + '**TuringMarket 图灵集市**' + nl + nl
    + '## 客户需求' + nl
    + '- 品牌: ' + (demand.brand || '') + nl
    + '- 公司: ' + (demand.company || '') + nl
    + '- 产品: ' + (demand.product || '') + nl
    + '- 卖点: ' + (demand.usp || demand.notes || '') + nl
    + '- 平台: ' + (demand.platform || '') + nl
    + '- 市场: ' + (demand.area || '') + nl
    + '- 预算: ' + (demand.budget || '') + nl
    + '- 行业: ' + (demand.category || demand.industry || '') + nl + nl
    + '## 模板: ' + (template.name || '方案模板') + nl;
  (Array.isArray(template.sections) ? template.sections : []).forEach(function(section, index) {
    content += (index + 1) + '. ' + section + nl;
  });
  if (similarCases.length) {
    content += nl + '## 可复用历史案例' + nl;
    similarCases.forEach(function(entry, index) {
      content += (index + 1) + '. 案例 #' + entry.id + '（' + entry.entry_type + '，匹配 '
        + Number(entry.similarity_score || 0).toFixed(1) + '）: '
        + String(entry.content || '').replace(/\s+/g, ' ').slice(0, 260) + nl;
    });
  }
  return content;
}
function renderProposalDraftResult(draft, similarCases, audit, warning) {
  var proposalOut = document.getElementById('proposalOutput') || document.getElementById('propResult');
  if (!proposalOut) return;
  var saveBtn = (curDemand && curDemand.customer_id) || activeWorkflowContext?.customer_id
    ? '<button class="btn btn-primary btn-sm" onclick="saveCurrentProposal()">保存到客户记录和知识库</button>'
    : '';
  var warningHtml = warning
    ? '<div style="margin-bottom:10px;padding:9px 11px;border:1px solid #fed7aa;background:#fff7ed;color:#c2410c;border-radius:8px;font-size:12px">' + esc(warning) + '</div>'
    : '';
  proposalOut.innerHTML = warningHtml
    + renderKnowledgeReuse(similarCases, '本次方案参考的历史案例')
    + renderProposalDraftEvidence(audit)
    + '<div class="card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:8px"><h3 style="margin:0">方案已生成，可直接编辑</h3><span style="font-size:11px;color:var(--text2)">编辑后下载、复制、生成 PPT 都会使用最新草稿</span></div><textarea id="proposalEditor" class="tm-proposal-editor" oninput="updateProposalDraftFromEditor()">' + esc(draft) + '</textarea><div id="proposalTextMirror" style="font-size:1px;line-height:1px;max-height:1px;overflow:hidden;opacity:.01;white-space:pre-wrap">' + esc(draft) + '</div><div class="btn-group" style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="downloadProposal()">下载 MD</button><button class="btn btn-sm" onclick="copyProposal()">复制</button><button class="btn btn-sm" onclick="openProposalToInfluencers()">去匹配达人</button>' + saveBtn + '</div></div>';
}
async function generateProposal() {
  if (!curDemand && typeof syncCurDemandFromAnalysis === 'function') syncCurDemandFromAnalysis();
  if (!curDemand) { toast("请先完成需求分析", "error"); return; }
  if (!selTpl) { toast("请选择方案模板", "error"); return; }
  var tpl = getSelectedProposalTemplate();
  if (!tpl) return;
  var requestContext = beginProposalDraftRequest();
  if (!requestContext) return;
  var generateButton = document.getElementById('btnGenerateProposal');
  if (generateButton) generateButton.disabled = true;
  var similarCases = [];
  if (requestContext.campaignId === null) {
    try {
      similarCases = await fetchSimilarKnowledge(curDemand, 'proposal');
      if (!similarCases.length) similarCases = await fetchSimilarKnowledge(curDemand, 'strategy');
    } catch(e) { similarCases = []; }
  }
  var localDraft = buildLocalProposalDraft(curDemand, tpl, similarCases);
  try {
    if (!isCurrentProposalDraftRequest(requestContext)) return;
    lastProposalAI = null;
    var response = await apiFetch('/ai/proposal-draft', buildProposalDraftRequestOptions(curDemand, tpl, requestContext));
    if (!response.ok) throw new Error('AI proposal request failed');
    var data = await response.json();
    if (!isCurrentProposalDraftRequest(requestContext)) return;
    var generatedDraft = String(data.draft || (data.ai && data.ai.answer) || '').trim();
    if (!generatedDraft) throw new Error('AI proposal response was empty');
    lastProp = generatedDraft;
    var audit = captureProposalDraftAudit(data.ai, requestContext.campaignId);
    var warning = data.ai && data.ai.status === 'degraded' ? 'AI 服务当前为降级输出，请人工复核后再确认方案。' : '';
    renderProposalDraftResult(lastProp, similarCases, audit, warning);
    toast('AI 方案草稿已生成');
  } catch(e) {
    if (!isCurrentProposalDraftRequest(requestContext)) return;
    lastProposalAI = null;
    lastProp = localDraft;
    renderProposalDraftResult(lastProp, similarCases, null, 'AI 服务暂不可用，已保留可编辑的基础方案。');
    toast('已生成基础方案，请人工复核', 'warning');
  } finally {
    var releaseCurrentRequest = isCurrentProposalDraftRequest(requestContext);
    finishProposalDraftRequest(requestContext);
    if (releaseCurrentRequest && generateButton) generateButton.disabled = false;
  }
}
function updateProposalDraftFromEditor() {
  var editor = document.getElementById('proposalEditor');
  if (editor) lastProp = editor.value;
  var mirror = document.getElementById('proposalTextMirror');
  if (mirror) mirror.textContent = lastProp || '';
  return lastProp;
}
function getCurrentProposalDraft() {
  updateProposalDraftFromEditor();
  return lastProp || '';
}
function downloadProposal() { var content = getCurrentProposalDraft(); if (content) dlFile((curDemand ? curDemand.brand : "proposal") + "_proposal.md", content, "text/markdown"); }
function copyProposal() { var content = getCurrentProposalDraft(); if (content) { try { navigator.clipboard.writeText(content); toast("已复制"); } catch(e) {} } }
function openProposalToInfluencers() {
  if (!curDemand) {
    toast('当前方案上下文为空', 'error');
    return;
  }
  setWorkflowContext({
    brand: curDemand.brand || '',
    company: curDemand.company || '',
    industry: curDemand.category || curDemand.industry || '',
    budget: curDemand.budget || '',
    product: curDemand.product || '',
    platform: curDemand.platform || '',
    market: curDemand.area || '',
    tags: curDemand.category || curDemand.industry || ''
  });
  fillWorkflowInfluencers(activeWorkflowContext);
}

// ===== HTML PPT GENERATION (reveal.js) =====
var lastPPT="";
;


function escapeHTML(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}



function switchTab(id, options) { options = options || {}; if (!options.skipHistory && window.TMNavigation) { window.TMNavigation.navigate('m4', { substate: { tab: id }, user: CURRENT_USER }); return; } document.querySelectorAll('#tabBar .tab').forEach(function (t) { t.classList.remove('active') }); var tabEl = document.querySelector('[data-tab="' + id + '"]'); if (tabEl) tabEl.classList.add('active'); var t1=document.getElementById('tab1-content');var t2=document.getElementById('tab2-content');var t3=document.getElementById('tab3-content');if(t1)t1.classList.toggle('hidden',id!=='tab1');if(t2)t2.classList.toggle('hidden',id!=='tab2');if(t3)t3.classList.toggle('hidden',id!=='tab3');if(window.TMAccessibility)window.TMAccessibility.refresh() }
// ===== M4: INFLUENCER MATCHING (API-driven) =====
lastMatch = []; var lastInfAPI = [];

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

function downloadInfTemplateJSON() {
  var tpl = [{ kol_handle: '@example_kol', platform: 'YouTube', profile_link: 'https://youtube.com/@example', followers: 50000, region: 'US', category: '3C', avg_views_10: 25000, collab_type: 'Dedicated Video', cost_usd: 2500, cpm: 50 }];
  dlFile('influencer_template.json', JSON.stringify(tpl, null, 2), 'application/json');
}
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
async function sendChatLegacyUnused() { return sendChat(); }

async function adminAddUser(){var u=prompt("Username:");if(!u)return;var d=prompt("Display name:");if(!d)return;var p=prompt("Department:")||"General";try{var r=await apiFetch("/admin/users",{method:"POST",body:JSON.stringify({username:u,display_name:d,department:p})});var res=await r.json();loadAdminUsers();toast(res.temporary_password?"User "+u+" created. Temporary password: "+res.temporary_password:"User "+u+" created");}catch(e){toast("Failed","error")}}




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
  draggingNode: null,
  history: [],
  historyIndex: -1,
  designerBindingsBound: false
};

// ---- Designer Init ----
function initWorkflowDesigner() {
  var canvas = document.getElementById('wf-svg-canvas');
  if (!canvas) return;
  if (wfState.designerBindingsBound) return;

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
    palettes[p].setAttribute('tabindex', '0');
    palettes[p].setAttribute('role', 'button');
    palettes[p].setAttribute('aria-label', '添加流程节点：' + String(palettes[p].textContent || palettes[p].dataset.type || '').trim());
    palettes[p].addEventListener('dragstart', function(e) {
      e.dataTransfer.setData('text/plain', this.dataset.type);
    });
    palettes[p].addEventListener('keydown', function(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      wfAddNode(this.dataset.type, rect.width / 2, rect.height / 2);
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

  document.addEventListener('mousemove', wfHandleWorkflowPointerMove);
  document.addEventListener('mouseup', wfHandleWorkflowPointerUp);
  wfState.designerBindingsBound = true;
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
  g.setAttribute('tabindex', '0');
  g.setAttribute('role', 'button');
  g.setAttribute('aria-label', node.label + ' 流程节点');

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
  g.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    var selectedNodeId = this.dataset.nodeId;
    wfSelectNode(selectedNodeId);
    window.requestAnimationFrame(function() {
      var nodes = document.querySelectorAll('.wf-node-svg[data-node-id]');
      for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
        if (nodes[nodeIndex].dataset.nodeId === selectedNodeId) {
          nodes[nodeIndex].focus();
          break;
        }
      }
    });
  });

  // Drag handlers
  g.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('wf-anchor')) return;
    wfState.draggingNode = {
      nodeId: node.id,
      startX: e.clientX,
      startY: e.clientY,
      nodeStartX: node.x,
      nodeStartY: node.y
    };
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

// ---- Central Pointer Lifecycle ----
function wfHandleWorkflowPointerMove(e) {
  var drag = wfState.draggingNode;
  if (drag) {
    var node = null;
    for (var n = 0; n < wfState.nodes.length; n++) {
      if (wfState.nodes[n].id === drag.nodeId) { node = wfState.nodes[n]; break; }
    }
    if (!node) {
      wfState.draggingNode = null;
    } else {
      node.x = Math.max(0, drag.nodeStartX + e.clientX - drag.startX);
      node.y = Math.max(0, drag.nodeStartY + e.clientY - drag.startY);
      wfRenderAll();
      if (wfState.selectedNode === node.id) wfShowNodeProperties(node.id);
    }
  }

  if (!wfState.connectingFrom) return;
  var line = document.getElementById('wf-connection-line');
  if (!line) return;
  var canvas = document.getElementById('wf-svg-canvas');
  if (!canvas) return;
  var rect = canvas.getBoundingClientRect();
  line.setAttribute('x2', e.clientX - rect.left);
  line.setAttribute('y2', e.clientY - rect.top);
}

function wfHandleWorkflowPointerUp(e) {
  if (wfState.draggingNode) {
    wfState.draggingNode = null;
    wfSaveState();
  }

  if (!wfState.connectingFrom) return;
  var line = document.getElementById('wf-connection-line');
  if (line) line.style.display = 'none';

  if (e.target && e.target.classList && e.target.classList.contains('wf-anchor') && e.target.dataset.anchor === 'input') {
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
}

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
function wfTaskIsOverdue(task) {
  return task && task.status === 'pending' && task.due_at && new Date(task.due_at.replace(' ', 'T')) < new Date();
}

function wfTaskStatusLabel(status) {
  var map = { pending: '待处理', completed: '已完成', rejected: '已驳回', approved: '已批准' };
  return map[status] || status || '-';
}

function wfTaskBusinessLabel(type) {
  var map = { customer: '客户', demand: '需求', proposal: '方案', collaboration: '合作' };
  return map[type] || type || '-';
}

function wfResetTaskFilters() {
  var ids = ['wf-task-filter', 'wf-task-business-filter', 'wf-task-overdue-filter', 'wf-task-search'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) el.value = '';
  }
  wfLoadTasks();
}

function wfUpdateTaskSummary(tasks) {
  tasks = tasks || [];
  var pending = tasks.filter(function(t) { return t.status === 'pending'; }).length;
  var completed = tasks.filter(function(t) { return t.status === 'completed'; }).length;
  var overdue = tasks.filter(wfTaskIsOverdue).length;
  var values = {
    wfTaskTotal: tasks.length,
    wfTaskPending: pending,
    wfTaskOverdue: overdue,
    wfTaskDone: completed
  };
  Object.keys(values).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = values[id];
  });
}

function wfLoadTasks() {
  var filter = document.getElementById('wf-task-filter');
  var businessFilter = document.getElementById('wf-task-business-filter');
  var overdueFilter = document.getElementById('wf-task-overdue-filter');
  var search = document.getElementById('wf-task-search');
  var params = [];
  if (filter && filter.value) params.push('status=' + encodeURIComponent(filter.value));
  if (businessFilter && businessFilter.value) params.push('business_type=' + encodeURIComponent(businessFilter.value));
  if (overdueFilter && overdueFilter.value) params.push('overdue=' + encodeURIComponent(overdueFilter.value));
  if (search && search.value.trim()) params.push('search=' + encodeURIComponent(search.value.trim()));
  var url = '/tasks';
  if (params.length) url += '?' + params.join('&');

  wfApi(url).then(function(r) {
    var container = document.getElementById('wf-tasks-list');
    if (!container) return;
    wfUpdateTaskSummary(r.tasks || []);
    if (!r.tasks || r.tasks.length === 0) {
      container.innerHTML = '<p style="text-align:center;color:#999;padding:40px;">暂无任务</p>';
      return;
    }
    container.innerHTML = r.tasks.map(function(task) {
      var overdue = wfTaskIsOverdue(task);
      var canAct = task.status === 'pending';
      var title = esc(task.title || '未命名任务');
      return '<div class="wf-task-card' + (overdue ? ' overdue' : '') + '" data-task-id="' + task.id + '">'
        + '<div class="wf-task-title"><span>' + title + '</span><span>'
        + (overdue ? '<span class="wf-overdue-chip">逾期</span> ' : '')
        + '<span class="wf-badge wf-badge-' + esc(task.status) + '">' + wfTaskStatusLabel(task.status) + '</span></span></div>'
        + '<div class="wf-task-meta">流程: ' + esc(task.template_name || '-') + ' | '
        + '业务: ' + wfTaskBusinessLabel(task.business_type) + '#' + esc(task.business_id || '-') + ' | '
        + '节点: ' + esc(task.node_type || '-') + ' | '
        + (task.assignee_id ? '负责人ID: ' + esc(task.assignee_id) + ' | ' : '')
        + (task.due_at ? '截止: ' + esc(task.due_at) + ' | ' : '')
        + (task.created_at ? '创建: ' + esc(task.created_at) : '') + '</div>'
        + (task.description ? '<p style="font-size:13px;color:#555;margin-bottom:10px;">' + esc(task.description) + '</p>' : '')
        + '<div class="wf-task-actions">'
        + '<button class="wf-task-link" onclick="wfShowTaskDetail(' + task.id + ')">详情</button>'
        + (task.business_type === 'customer' ? '<button class="wf-task-link" onclick="wfOpenBusiness(' + task.id + ')">打开客户</button>' : '')
        + (canAct ? (task.node_type === 'approval'
          ? '<button class="btn-approve" onclick="wfHandleTask(' + task.id + ',\'approve\')">批准</button>'
            + '<button class="btn-reject" onclick="wfHandleTask(' + task.id + ',\'reject\')">驳回</button>'
          : '<button class="btn-complete" onclick="wfHandleTask(' + task.id + ',\'complete\')">完成</button>') : '')
        + (canAct ? '<input id="wf-task-comment-' + task.id + '" placeholder="处理备注..." style="flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;">' : '')
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

function wfOpenBusiness(taskId) {
  wfApi('/tasks/' + taskId).then(function(r) {
    if (!r.task || r.task.business_type !== 'customer' || !r.task.business_id) {
      alert('该任务没有可打开的客户记录');
      return;
    }
    switchPage('m0-detail');
    if (typeof openCustomerDetail === 'function') {
      setTimeout(function() { openCustomerDetail(r.task.business_id); }, 150);
    }
  });
}

function wfShowTaskDetail(taskId) {
  wfApi('/tasks/' + taskId).then(function(r) {
    if (!r.task) { alert('任务不存在'); return; }
    var task = r.task;
    var business = r.business || {};
    var logs = r.logs || [];
    var modal = document.getElementById('wf-instance-modal');
    var body = document.getElementById('wf-instance-modal-body');
    var title = document.getElementById('wf-instance-modal-title');
    if (!modal || !body) return;
    if (title) title.textContent = '待办详情 #' + task.id;
    var html = '<div class="wf-task-detail-grid">'
      + '<strong>任务</strong><div>' + esc(task.title || '-') + '</div>'
      + '<strong>状态</strong><div><span class="wf-badge wf-badge-' + esc(task.status) + '">' + wfTaskStatusLabel(task.status) + '</span></div>'
      + '<strong>业务</strong><div>' + wfTaskBusinessLabel(task.business_type) + '#' + esc(task.business_id || '-') + '</div>'
      + '<strong>流程</strong><div>' + esc(task.template_name || '-') + '</div>'
      + '<strong>截止时间</strong><div>' + esc(task.due_at || '-') + (wfTaskIsOverdue(task) ? ' <span class="wf-overdue-chip">逾期</span>' : '') + '</div>'
      + '<strong>描述</strong><div>' + esc(task.description || '-') + '</div>'
      + '<strong>备注</strong><div>' + esc(task.comment || '-') + '</div>'
      + '</div>';
    if (business && Object.keys(business).length) {
      html += '<h4 style="margin:18px 0 8px">业务记录</h4><div style="font-size:13px;background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px;">'
        + '<strong>' + esc(business.brand_name || business.name || business.title || ('#' + task.business_id)) + '</strong>'
        + (business.company_name ? '<div>公司: ' + esc(business.company_name) + '</div>' : '')
        + (business.stage ? '<div>阶段: ' + esc(business.stage) + '</div>' : '')
        + (business.industry ? '<div>行业: ' + esc(business.industry) + '</div>' : '')
        + '</div>';
    }
    if (logs.length) {
      html += '<h4 style="margin:18px 0 8px">处理日志</h4><table class="wf-table"><thead><tr><th>动作</th><th>用户</th><th>时间</th></tr></thead><tbody>'
        + logs.map(function(log) { return '<tr><td>' + esc(log.action) + '</td><td>' + esc(log.user_id || '-') + '</td><td>' + esc(log.created_at || '-') + '</td></tr>'; }).join('')
        + '</tbody></table>';
    }
    body.innerHTML = html;
    modal.style.display = 'flex';
  });
}











// ===== M1: BRAND INTELLIGENCE HUB (v8.0) =====
var brandSearchHistory = JSON.parse(localStorage.getItem('tm_brand_search_history') || '[]');
function toggleTreeNode(el) { el.classList.toggle('expanded'); var ch = el.nextElementSibling; if (ch) ch.classList.toggle('open'); }
function archiveBrandSearch(q) { if (!q) return; brandSearchHistory = brandSearchHistory.filter(function(s) { return s !== q; }); brandSearchHistory.unshift(q); if (brandSearchHistory.length > 20) brandSearchHistory = brandSearchHistory.slice(0, 20); localStorage.setItem('tm_brand_search_history', JSON.stringify(brandSearchHistory)); renderSearchHistory(); }
// ===== M1: BRAND INTELLIGENCE WORKSPACE (v0.2.5) =====
var activeTag = null;
var selectedBrandName = '';
var currentBrandResults = [];

function initM1() {
  buildBrandRelationCache();
  if (window.INDUSTRY_TREE) renderIndustryTree();
  currentBrandResults = BRANDS.slice();
  if (!selectedBrandName && currentBrandResults.length) selectedBrandName = currentBrandResults[0].name;
  renderBrandWorkspaceStats(currentBrandResults);
  renderBrands(currentBrandResults);
  renderSearchHistory();
  renderBrandDetail(getSelectedBrand());
}

function renderIndustryTree() {
  var tree = window.INDUSTRY_TREE || {};
  var container = document.getElementById('tagGroup');
  if (!container) return;
  var tagTotal = 0;
  var h = '<div class="tree-container">';
  Object.keys(tree).sort().forEach(function(cat) {
    var cd = tree[cat] || {};
    var subTags = cd.sub_tags || [];
    var bc = BRANDS.filter(function(b) {
      return brandTags(b).some(function(t) { return subTags.indexOf(t) >= 0; });
    }).length;
    var open = activeTag && subTags.indexOf(activeTag) >= 0;
    h += '<div class="tree-node"><div class="tree-parent' + (open ? ' expanded' : '') + '" onclick="toggleTreeNode(this)"><span class="tree-icon">&#9658;</span><span>' + esc(cat) + '</span><span style="font-size:10px;opacity:.4">(' + bc + ')</span></div>';
    h += '<div class="tree-children' + (open ? ' open' : '') + '">';
    subTags.forEach(function(tag) {
      tagTotal++;
      var cnt = BRANDS.filter(function(b) { return brandTags(b).indexOf(tag) >= 0; }).length;
      h += '<div class="tree-child' + (activeTag === tag ? ' active' : '') + '" data-tag="' + esc(tag) + '" onclick="filterByTreeTag(this.getAttribute(\'data-tag\'),this)">' + esc(tag) + '<span class="count">' + cnt + '</span></div>';
    });
    h += '</div></div>';
  });
  h += '</div>';
  container.innerHTML = h;
  var tagCount = document.getElementById('tagCount');
  if (tagCount) tagCount.textContent = tagTotal + ' tags';
}

function filterBrands() {
  var q = (document.getElementById('brandSearch')?.value || '').trim().toLowerCase();
  var f = BRANDS.slice();
  if (activeTag) f = f.filter(function(b) { return brandTags(b).indexOf(activeTag) >= 0; });
  if (q) {
    f = f.filter(function(b) {
      return [b.name, b.name_cn, b.company, b.market, b.description, brandTags(b).join(' ')].join(' ').toLowerCase().includes(q);
    });
    archiveBrandSearch(q);
  }
  f = sortBrandResults(f);
  currentBrandResults = f;
  if (!f.some(function(b) { return b.name === selectedBrandName; })) selectedBrandName = f[0] ? f[0].name : '';
  renderBrands(f);
  renderBrandWorkspaceStats(f);
  renderBrandDetail(getSelectedBrand());
  var bc = document.getElementById('brandCount');
  if (bc) bc.textContent = f.length + ' / ' + BRANDS.length + ' brands';
  var active = document.getElementById('brandActiveFilter');
  if (active) active.textContent = activeTag ? ('筛选：' + activeTag) : (q ? ('搜索：' + q) : '全部品牌');
}

function filterByTag(t) { filterByTreeTag(t); }
function filterByTreeTag(tag, el) {
  activeTag = activeTag === tag ? null : tag;
  document.querySelectorAll('.tree-child').forEach(function(c) { c.classList.remove('active'); });
  if (activeTag && el) el.classList.add('active');
  filterBrands();
}

function renderSearchHistory() {
  var c = document.getElementById('searchHistory');
  if (!c) return;
  if (!brandSearchHistory.length) { c.innerHTML = ''; return; }
  c.innerHTML = '<div style="font-size:11px;color:#999;margin-bottom:4px">最近搜索</div>' + brandSearchHistory.slice(0, 6).map(function(s) {
    return '<button onclick="document.getElementById(\'brandSearch\').value=' + inlineJsArg(s) + ';filterBrands()">' + esc(s) + '</button>';
  }).join('');
}

function renderBrands(brands) {
  brands = brands || BRANDS;
  currentBrandResults = brands.slice();
  var container = document.getElementById('brandResults') || document.getElementById('brandList');
  if (!container) return;
  if (!brands.length) {
    container.innerHTML = '<div class="brand-empty-state">没有匹配的品牌。可以调整筛选，或用 AI Search 补充新品牌。</div>';
    return;
  }
  var h = '';
  brands.forEach(function(b, idx) {
    var sf = brandFollowers(b);
    var tags = brandTags(b);
    var selected = b.name === selectedBrandName;
    h += '<div class="brand-result-item' + (selected ? ' active' : '') + '" onclick="selectBrand(' + idx + ')">';
    h += '<div class="brand-result-head"><div><div class="brand-result-name">' + esc(b.name || '-') + '</div>';
    h += '<div class="brand-result-sub">' + esc([b.name_cn, b.company, b.market].filter(Boolean).join(' · ') || '品牌资料待补充') + '</div></div>';
    h += '<span class="brand-chip dark" title="估算年营收，用于判断品牌规模">' + esc(b.estimated_annual_revenue || 'N/A') + '</span></div>';
    h += '<div class="brand-result-tags">' + tags.slice(0, 5).map(function(t) { return '<span class="brand-chip">' + esc(t) + '</span>'; }).join('') + '</div>';
    h += '<div class="brand-result-metrics">';
    h += '<div class="brand-mini-metric" title="YouTube 粉丝量"><strong>' + formatCompactNumber(sf.youtube || 0) + '</strong><span>YT</span></div>';
    h += '<div class="brand-mini-metric" title="Instagram 粉丝量"><strong>' + formatCompactNumber(sf.instagram || 0) + '</strong><span>IG</span></div>';
    h += '<div class="brand-mini-metric" title="TikTok 粉丝量"><strong>' + formatCompactNumber(sf.tiktok || 0) + '</strong><span>TT</span></div>';
    h += '</div></div>';
  });
  container.innerHTML = h;
  var bc = document.getElementById('brandCount');
  if (bc) bc.textContent = brands.length + ' / ' + BRANDS.length + ' brands';
}

function selectBrand(index) {
  var b = typeof index === 'number' ? currentBrandResults[index] : BRANDS.find(function(item) { return item.name === index; });
  if (!b) return;
  selectedBrandName = b.name;
  renderBrands(currentBrandResults.length ? currentBrandResults : BRANDS);
  renderBrandDetail(b);
}

function selectBrandByName(name) {
  var b = BRANDS.find(function(item) { return item.name === name; });
  if (!b) return;
  selectedBrandName = b.name;
  var input = document.getElementById('brandSearch');
  if (input) input.value = '';
  activeTag = null;
  filterBrands();
  renderBrandDetail(b);
}

function getSelectedBrand() {
  if (!selectedBrandName && BRANDS.length) selectedBrandName = BRANDS[0].name;
  return BRANDS.find(function(b) { return b.name === selectedBrandName; }) || currentBrandResults[0] || BRANDS[0] || null;
}

function renderBrandWorkspaceStats(results) {
  results = results || BRANDS;
  var el = document.getElementById('brandWorkspaceStats');
  if (!el) return;
  var tags = {};
  BRANDS.forEach(function(b) { brandTags(b).forEach(function(t) { tags[t] = true; }); });
  var kbReady = BRANDS.filter(function(b) { return isBrandKnowledgeReady(b); }).length;
  var topPlatform = results.length ? (brandContent(results[0]).last_12_months || {}).top_platform || 'YouTube' : '-';
  el.innerHTML =
    '<div class="brand-stat-tile"><strong>' + BRANDS.length + '</strong><span>品牌总量</span></div>' +
    '<div class="brand-stat-tile"><strong>' + Object.keys(tags).length + '</strong><span>行业标签</span></div>' +
    '<div class="brand-stat-tile"><strong>' + kbReady + '</strong><span>已具备知识库沉淀</span></div>' +
    '<div class="brand-stat-tile"><strong>' + results.length + '</strong><span>当前筛选 · Top ' + esc(topPlatform) + '</span></div>';
}

function renderBrandDetail(brand) {
  var panel = document.getElementById('brandDetailPanel');
  if (!panel) return;
  if (!brand) {
    panel.innerHTML = '<div class="brand-empty-state">选择一个品牌后查看情报详情。</div><div id="brandKnowledgeStatus" style="display:none"></div><div id="brandOpportunityPanel" style="display:none"></div><div id="brandSocialSources" style="display:none"></div>';
    return;
  }
  var sf = brandFollowers(brand);
  var content = brandContent(brand);
  var last = content.last_12_months || {};
  var contacts = brandContacts(brand);
  panel.innerHTML =
    '<div class="brand-detail-header">' +
      '<div class="brand-detail-name"><div><h3>' + esc(brand.name || '-') + '</h3><div class="brand-result-sub">' + esc([brand.name_cn, brand.company, brand.market].filter(Boolean).join(' · ')) + '</div></div>' +
      '<span class="brand-chip dark">' + esc(brand.estimated_annual_revenue || 'N/A') + '</span></div>' +
      '<div class="brand-chip-row">' + brandTags(brand).slice(0, 8).map(function(t) { return '<span class="brand-chip">' + esc(t) + '</span>'; }).join('') + '</div>' +
      '<div class="brand-action-row"><button class="btn btn-primary btn-sm" onclick="copyBrandBriefToDemand(' + inlineJsArg(brand.name) + ')">进入需求/方案</button><button class="btn btn-outline btn-sm" onclick="showRelatedBrands(' + inlineJsArg(brand.name) + ')">查看关系图</button></div>' +
    '</div>' +
    '<div class="brand-detail-section"><h4>核心指标</h4><div class="brand-kpi-grid">' +
      brandKpi('品牌规模', brand.estimated_annual_revenue || 'N/A', '估算年营收，辅助判断预算承载能力') +
      brandKpi('用户基础', brand.user_base || '待补充', '品牌公开用户或消费群体描述') +
      brandKpi('搜索量', formatCompactNumber((brand.overseas_presence || {}).brand_search_volume_monthly || brand.brand_search_volume_monthly || 0), '月度品牌搜索量或 AI 补充估算') +
      brandKpi('内容活跃', formatCompactNumber(content.total_posts || 0) + ' posts/mo', '品牌相关月度社媒内容量') +
      brandKpi('平均观看', formatCompactNumber(last.avg_views_per_post || 0), '近 12 个月内容平均观看') +
      brandKpi('互动率', last.avg_engagement_rate || '待补充', '近 12 个月内容平均互动率') +
    '</div></div>' +
    renderBrandKnowledgeStatus(brand) +
    renderBrandOpportunityPanel(brand) +
    renderBrandSocialSources(brand, sf, contacts) +
    renderBrandRelations(brand);
}

function renderBrandKnowledgeStatus(brand) {
  var ready = isBrandKnowledgeReady(brand);
  var source = String(brand.id || '').indexOf('db_') === 0 || String(brand.id || '').indexOf('cust_') === 0 ? '平台 AI Search / 手动补充' : '内置行业品牌样本';
  var text = ready ? '可被 AI 对话、方案生成和 PPT 大纲作为品牌知识引用。' : '资料可用，但建议通过 AI Search 刷新后写入后端知识库。';
  return '<div class="brand-detail-section" id="brandKnowledgeStatus"><h4>知识库状态</h4><div class="brand-chip-row"><span class="brand-chip dark">' + (ready ? '已沉淀' : '待增强') + '</span><span class="brand-chip">' + esc(source) + '</span><span class="brand-chip">最后更新 ' + esc(brand.last_updated || '待补充') + '</span></div><p style="font-size:12px;color:var(--text2);margin-top:8px">' + text + '</p></div>';
}

function renderBrandOpportunityPanel(brand) {
  var content = brandContent(brand);
  var angles = normalizeList(content.creative_angles);
  var products = normalizeList(content.top_products_featured || brand.top_products);
  if (!angles.length) angles = ['产品评测', '场景演示', '竞品对比', '真实用户体验'];
  return '<div class="brand-detail-section" id="brandOpportunityPanel"><h4>内容机会</h4>' +
    '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">可直接带入 M3 需求和后续 PPT 的品牌卖点素材。</div>' +
    '<div class="brand-chip-row">' + angles.slice(0, 8).map(function(a) { return '<span class="brand-chip">' + esc(a) + '</span>'; }).join('') + '</div>' +
    (products.length ? '<div style="font-size:12px;margin-top:10px"><strong>主推产品：</strong>' + esc(products.join(' / ')) + '</div>' : '') +
    '</div>';
}

function renderBrandSocialSources(brand, sf, contacts) {
  var platforms = [
    { key: 'youtube', label: 'YouTube', value: sf.youtube || 0 },
    { key: 'instagram', label: 'Instagram', value: sf.instagram || 0 },
    { key: 'tiktok', label: 'TikTok', value: sf.tiktok || 0 }
  ];
  var html = '<div class="brand-detail-section" id="brandSocialSources"><h4>社媒与外部来源</h4><div class="brand-source-grid">';
  platforms.forEach(function(p) {
    html += '<div class="brand-source-card"><strong>' + p.label + '</strong><span>' + formatCompactNumber(p.value) + ' followers</span><button class="btn btn-outline btn-sm" onclick="openBrandSocialSearch(' + inlineJsArg(brand.name) + ',' + inlineJsArg(p.key) + ')">打开搜索</button></div>';
  });
  html += '</div>';
  var site = brand.website || brand.amazon_store || brand.linkedin_url;
  if (site || contacts.length) {
    html += '<div class="brand-chip-row" style="margin-top:10px">';
    if (site) html += '<a class="brand-chip" target="_blank" href="' + esc(site) + '">官网/店铺</a>';
    contacts.slice(0, 3).forEach(function(mail) { html += '<button class="brand-chip" onclick="copyText(' + inlineJsArg(mail) + ')">' + esc(mail) + '</button>'; });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderBrandRelations(brand) {
  var related = findRelatedBrands(brand);
  var competitors = findCompetitorBrands(brand);
  var html = '<div class="brand-detail-section"><h4>竞品与关联品牌</h4>';
  html += '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">基于标签重叠和集团关系推断，用于竞品对标和方案论证。</div>';
  html += '<div class="brand-inline-list">';
  related.concat(competitors).slice(0, 12).forEach(function(b) {
    html += '<button onclick="selectBrandByName(' + inlineJsArg(b.name) + ')">' + esc(b.name) + '</button>';
  });
  if (!related.length && !competitors.length) html += '<span style="font-size:12px;color:var(--text2)">暂无足够关系数据</span>';
  html += '</div></div>';
  return html;
}

function brandKpi(label, value, tip) {
  return '<div class="brand-kpi"><span class="brand-data-tip" title="' + esc(tip || '') + '">' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
}

function openBrandSocialSearch(brandName, platform) {
  apiFetch('/brands/social-search?brand=' + encodeURIComponent(brandName) + '&platform=' + encodeURIComponent(platform || 'youtube'))
    .then(function(r) { return r.json(); })
    .then(function(d) { window.open(d.searchUrl || buildBrandSearchUrl(brandName, platform), '_blank'); })
    .catch(function() { window.open(buildBrandSearchUrl(brandName, platform), '_blank'); });
}

function loadSocialForBrand(bn, bid, pf) { openBrandSocialSearch(bn, pf || 'youtube'); }
function switchPlatformTab(el) { if (el) openBrandSocialSearch(selectedBrandName || '', el.getAttribute('data-plat') || 'youtube'); }
function toggleBrandSocial(el, bid) { if (selectedBrandName) renderBrandDetail(getSelectedBrand()); }

function copyBrandBriefToDemand(brandName) {
  var brand = BRANDS.find(function(b) { return b.name === brandName; });
  if (!brand) return;
  var tags = brandTags(brand);
  var content = brandContent(brand);
  var angles = normalizeList(content.creative_angles);
  var competitors = findCompetitorBrands(brand).slice(0, 5).map(function(b) { return b.name; });
  switchPage('m3');
  setTimeout(function() {
    setValueIfPresent('d_brand', brand.name || '');
    setValueIfPresent('d_company', brand.company || brand.name_cn || '');
    setValueIfPresent('d_category', tags[0] || '');
    setValueIfPresent('d_competitors', competitors.join(', '));
    setValueIfPresent('d_usp', angles.slice(0, 3).join(' / ') || brand.description || '');
    setValueIfPresent('d_notes', '来自品牌智库：' + (brand.name || '') + '，规模 ' + (brand.estimated_annual_revenue || '待补充') + '，用户基础 ' + (brand.user_base || '待补充') + '。');
    toast('已把品牌情报带入需求/方案页');
  }, 80);
}

function setValueIfPresent(id, value) { var el = document.getElementById(id); if (el) el.value = value || ''; }

function exportBrandCSV() {
  var rows = currentBrandResults && currentBrandResults.length ? currentBrandResults : BRANDS;
  if (!rows || !rows.length) { toast('没有可导出的品牌', 'error'); return; }
  var csv = 'Name,Chinese Name,Industry Tags,Market,Revenue,User Base,Search Volume,YouTube,Instagram,TikTok,Top Platform,Website,Contacts\n';
  rows.forEach(function(b) {
    var sf = brandFollowers(b);
    var content = brandContent(b);
    var last = content.last_12_months || {};
    csv += [
      csvCell(b.name),
      csvCell(b.name_cn),
      csvCell(brandTags(b).join(';')),
      csvCell(b.market),
      csvCell(b.estimated_annual_revenue),
      csvCell(b.user_base),
      csvCell((b.overseas_presence || {}).brand_search_volume_monthly || 0),
      csvCell(sf.youtube || 0),
      csvCell(sf.instagram || 0),
      csvCell(sf.tiktok || 0),
      csvCell(last.top_platform || ''),
      csvCell(b.website || b.amazon_store || b.linkedin_url || ''),
      csvCell(brandContacts(b).join(';'))
    ].join(',') + '\n';
  });
  dlFile('brands.csv', '\ufeff' + csv, 'text/csv');
}

function normalizeEnrichedBrand(bd, q) {
  bd = bd || {};
  return {
    id: 'cust_' + Date.now(),
    name: bd.name || q,
    name_cn: bd.name_cn || '',
    industry_tags: normalizeList(bd.industry_tags || ['Other']),
    market: bd.market || 'global',
    estimated_annual_revenue: bd.estimated_annual_revenue || '$100M+',
    user_base: bd.user_base || '',
    overseas_presence: {
      amazon_rating: bd.amazon_rating || 4.0,
      social_followers: {
        youtube: Number(bd.youtube_followers || 0),
        instagram: Number(bd.instagram_followers || 0),
        tiktok: Number(bd.tiktok_followers || 0)
      },
      brand_search_volume_monthly: Number(bd.brand_search_volume_monthly || 0)
    },
    social_content_monthly: {
      total_posts: Number(bd.total_posts || 0),
      creative_angles: normalizeList(bd.creative_angles),
      top_products_featured: normalizeList(bd.top_products_featured),
      last_12_months: {
        avg_engagement_rate: bd.avg_engagement_rate || '3.0%',
        avg_views_per_post: Number(bd.avg_views_per_post || 0),
        top_platform: bd.top_platform || 'YouTube'
      }
    },
    case_study_available: true,
    last_updated: new Date().toISOString().slice(0, 10)
  };
}

function upsertBrandRecord(brand) {
  var idx = BRANDS.findIndex(function(b) { return String(b.name || '').toLowerCase() === String(brand.name || '').toLowerCase(); });
  if (idx >= 0) BRANDS[idx] = Object.assign({}, BRANDS[idx], brand, { id: BRANDS[idx].id || brand.id });
  else BRANDS.unshift(brand);
}

function brandToApiPayload(b) {
  var sf = brandFollowers(b);
  var content = brandContent(b);
  var last = content.last_12_months || {};
  return {
    name: b.name,
    name_cn: b.name_cn,
    industry_tags: brandTags(b),
    market: b.market,
    estimated_annual_revenue: b.estimated_annual_revenue,
    user_base: b.user_base,
    amazon_rating: (b.overseas_presence || {}).amazon_rating,
    youtube_followers: sf.youtube || 0,
    instagram_followers: sf.instagram || 0,
    tiktok_followers: sf.tiktok || 0,
    search_volume_monthly: (b.overseas_presence || {}).brand_search_volume_monthly || 0,
    monthly_posts: content.total_posts || 0,
    avg_engagement: last.avg_engagement_rate || '',
    avg_views: last.avg_views_per_post || 0,
    top_platform: last.top_platform || '',
    creative_angles: normalizeList(content.creative_angles),
    top_products: normalizeList(content.top_products_featured)
  };
}

function brandTags(b) { return normalizeList(b && b.industry_tags); }
function brandFollowers(b) { return (b && (b.social_followers || (b.overseas_presence || {}).social_followers)) || {}; }
function brandContent(b) { return (b && (b.social_content_monthly || {})) || {}; }
function brandContacts(b) { return normalizeList((b && (b.contact_emails || b.contact_email || b.contacts)) || ''); }
function isBrandKnowledgeReady(b) { return !!(b && (b.case_study_available || b.last_updated || String(b.id || '').indexOf('db_') === 0 || String(b.id || '').indexOf('cust_') === 0)); }

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(function(v) { return String(v || '').trim(); }).filter(Boolean);
  return String(value || '').split(/[,;，、/]+/).map(function(v) { return v.trim(); }).filter(Boolean);
}

function sortBrandResults(rows) {
  var mode = document.getElementById('brandSort')?.value || 'relevance';
  if (mode === 'revenue') rows.sort(function(a, b) { return brandRevenueScore(b) - brandRevenueScore(a); });
  else if (mode === 'social') rows.sort(function(a, b) { return brandSocialScore(b) - brandSocialScore(a); });
  else if (mode === 'search') rows.sort(function(a, b) { return brandSearchScore(b) - brandSearchScore(a); });
  return rows;
}

function brandRevenueScore(b) {
  var raw = String((b && b.estimated_annual_revenue) || '').toUpperCase();
  var n = parseFloat((raw.match(/[\d.]+/) || [0])[0]) || 0;
  if (raw.indexOf('B') >= 0) return n * 1000;
  if (raw.indexOf('M') >= 0) return n;
  if (n > 1000000) return n / 1000000;
  return n;
}
function brandSocialScore(b) { var sf = brandFollowers(b); return Number(sf.youtube || 0) + Number(sf.instagram || 0) + Number(sf.tiktok || 0); }
function brandSearchScore(b) { return Number(((b || {}).overseas_presence || {}).brand_search_volume_monthly || (b || {}).brand_search_volume_monthly || 0); }

function formatCompactNumber(n) {
  n = Number(n || 0);
  if (n >= 100000000) return (n / 100000000).toFixed(n >= 1000000000 ? 1 : 0) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return String(n);
}

function inlineJsArg(v) { return esc(JSON.stringify(String(v || ''))); }
function csvCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
function buildBrandSearchUrl(brandName, platform) {
  if (platform === 'instagram') return 'https://www.instagram.com/explore/tags/' + encodeURIComponent(String(brandName || '').replace(/[^a-zA-Z0-9]/g, ''));
  if (platform === 'tiktok') return 'https://www.tiktok.com/search/video?q=' + encodeURIComponent(brandName || '');
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent((brandName || '') + ' review');
}
// ===== M3: DEMAND & PROPOSAL (v8.0) =====
var uploadedDemandContent = '';
var uploadedDemandFileName = '';
var demandAnalysisResult = '';
var lastDemandAnalysisAI = null;
var demandAnalysisRequestGeneration = 0;
var demandAnalysisInFlight = false;
function createDemandAnalysisOperationId(prefix) {
  prefix = String(prefix || 'demand-analysis-');
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return prefix + window.crypto.randomUUID();
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    var randomValues = new Uint32Array(2);
    window.crypto.getRandomValues(randomValues);
    return prefix + Date.now().toString(36) + '-' + randomValues[0].toString(36) + randomValues[1].toString(36);
  }
  return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function beginDemandAnalysisRequest() {
  if (demandAnalysisInFlight) return null;
  demandAnalysisInFlight = true;
  var campaignId = getActiveCampaignId();
  return {
    generation: ++demandAnalysisRequestGeneration,
    campaignId: campaignId,
    requestId: createDemandAnalysisOperationId('demand-analysis-request-'),
    idempotencyKey: campaignId === null ? '' : createDemandAnalysisOperationId('demand-analysis-')
  };
}
function isCurrentDemandAnalysisRequest(requestContext) {
  return !!requestContext && requestContext.generation === demandAnalysisRequestGeneration;
}
function finishDemandAnalysisRequest(requestContext) {
  if (!isCurrentDemandAnalysisRequest(requestContext)) return false;
  demandAnalysisInFlight = false;
  return true;
}
function invalidateDemandAnalysisRequests() {
  demandAnalysisRequestGeneration += 1;
  demandAnalysisInFlight = false;
  lastDemandAnalysisAI = null;
}
function buildDemandAnalysisRequestOptions(source, prompt, fileName, requestContext) {
  var body = {
    prompt: prompt,
    input: source,
    fileName: fileName,
    allow_web: false
  };
  var options = { method: 'POST' };
  if (requestContext && readPositiveInteger(requestContext.campaignId) !== null) {
    body.campaign_id = requestContext.campaignId;
    options.headers = {
      'Idempotency-Key': requestContext.idempotencyKey,
      'X-Request-Id': requestContext.requestId
    };
  }
  options.body = JSON.stringify(body);
  return options;
}
function normalizeDemandAnalysisAudit(ai, campaignId) {
  ai = ai && typeof ai === 'object' ? ai : {};
  var references = Array.isArray(ai.knowledge_references) ? ai.knowledge_references : [];
  var seen = {};
  var normalizedReferences = [];
  references.forEach(function(reference) {
    reference = reference && typeof reference === 'object' ? reference : {};
    var entryId = readPositiveInteger(reference.entry_id);
    if (entryId === null) entryId = readPositiveInteger(reference.id);
    if (entryId === null || seen[entryId]) return;
    seen[entryId] = true;
    normalizedReferences.push({
      entry_id: entryId,
      citation_label: String(reference.citation_label || ('KB-' + (normalizedReferences.length + 1))).slice(0, 32),
      title: String(reference.title || ('知识条目 #' + entryId)).slice(0, 160)
    });
  });
  return {
    campaign_id: readPositiveInteger(campaignId),
    conversation_id: readPositiveInteger(ai.conversation_id),
    message_id: readPositiveInteger(ai.message_id),
    knowledge_entry_ids: normalizedReferences.map(function(reference) { return reference.entry_id; }),
    knowledge_references: normalizedReferences
  };
}
function captureDemandAnalysisAudit(ai, campaignId) {
  lastDemandAnalysisAI = normalizeDemandAnalysisAudit(ai, campaignId);
  lastDemandAnalysisAI.knowledge_entry_ids.forEach(rememberKnowledgeEntryForChat);
  return lastDemandAnalysisAI;
}
function renderDemandAnalysisEvidence(audit) {
  audit = audit && typeof audit === 'object' ? audit : {};
  var references = Array.isArray(audit.knowledge_references) ? audit.knowledge_references : [];
  var auditParts = [];
  if (readPositiveInteger(audit.campaign_id) !== null) auditParts.push('活动 #' + audit.campaign_id);
  if (readPositiveInteger(audit.conversation_id) !== null) auditParts.push('对话 #' + audit.conversation_id);
  if (readPositiveInteger(audit.message_id) !== null) auditParts.push('消息 #' + audit.message_id);
  if (!auditParts.length && !references.length) return '';
  var html = '<div class="demand-ai-evidence" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">';
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">';
  html += '<strong style="font-size:13px">知识依据与 AI 审计</strong>';
  if (auditParts.length) html += '<span style="font-size:11px;color:var(--text2)">' + esc(auditParts.join(' · ')) + '</span>';
  html += '</div>';
  if (references.length) {
    html += '<div style="display:grid;gap:6px;margin-top:8px">';
    references.forEach(function(reference) {
      html += '<div style="display:flex;gap:8px;align-items:baseline;font-size:12px">'
        + '<span style="color:var(--primary);font-weight:600;white-space:nowrap">' + esc(reference.citation_label) + '</span>'
        + '<span style="min-width:0;overflow-wrap:anywhere">' + esc(reference.title) + '</span>'
        + '</div>';
    });
    html += '</div>';
  } else {
    html += '<div style="margin-top:8px;font-size:12px;color:var(--text2)">本次未命中可引用知识，分析结果仍已写入 AI 审计记录。</div>';
  }
  return html + '</div>';
}
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
  uploadedDemandFileName = file.name || '';
  renderDemandUploadState(file, 'reading', '已选择文件，正在读取...');
  status.innerHTML = 'Reading: ' + file.name + '...';
  document.getElementById('btnAnalyzeAI').disabled = true;
  var metadata = buildDemandFileMetadata(file);
  if (!isTextLikeDemandFile(file)) {
    uploadedDemandContent = metadata;
    renderDemandUploadState(file, 'parsing', '已选择文件，正在解析结构化内容...');
    status.innerHTML = '已读取文件信息，正在解析结构化内容...';
    document.getElementById('aiAnalyzeHint').textContent = 'Parsing file...';
    parseDemandFileOnServer(file, metadata);
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    uploadedDemandContent = metadata + '\n\nText content:\n' + String(e.target.result || '').slice(0, 12000);
    renderDemandUploadState(file, 'ready', '文本已读取，可以开始 AI 分析。');
    status.innerHTML = 'OK: ' + file.name + ' (' + (uploadedDemandContent.length / 1024).toFixed(1) + 'KB)';
    document.getElementById('btnAnalyzeAI').disabled = false;
    document.getElementById('aiAnalyzeHint').textContent = 'Ready to analyze';
  };
  reader.onerror = function() {
    renderDemandUploadState(file, 'error', '浏览器读取文件失败，请重新选择文件或换用文本格式。');
    status.innerHTML = '浏览器读取文件失败，请重新选择文件';
    document.getElementById('aiAnalyzeHint').textContent = 'Upload failed';
  };
  reader.readAsText(file);
}
async function parseDemandFileOnServer(file, fallbackMetadata) {
  var status = document.getElementById('demandFileStatus');
  var hint = document.getElementById('aiAnalyzeHint');
  if (status) status.innerHTML = '正在解析需求表内容: ' + file.name + '...';
  if (hint) hint.textContent = 'Parsing file...';
  try {
    var form = new FormData();
    form.append('file', file);
    var r = await apiFetch('/demand/parse-file', {
      method: 'POST',
      body: form
    });
    var d = await r.json().catch(function() { return {}; });
    if (!r.ok) throw new Error(r.status === 401 ? '登录状态已过期，请重新登录后再上传需求表。' : (d.error || ('文件解析失败: ' + r.status)));
    uploadedDemandContent = d.extractedText || fallbackMetadata;
    if (status) {
      var parseState = d.ocrUsed
        ? 'OCR 已提取'
        : (d.needsOcr ? '需要 OCR 服务，当前仅有文件信息' : (d.fallback ? '降级解析' : '已解析'));
      var warning = d.warning ? '<br><span style="color:#b45309">' + esc(d.warning) + '</span>' : '';
      renderDemandUploadState(file, d.needsOcr && !d.ocrUsed ? 'error' : 'ready', parseState + (d.warning ? '：' + d.warning : ''));
      status.innerHTML = 'OK: ' + file.name + ' (' + (uploadedDemandContent.length / 1024).toFixed(1) + 'KB · ' + parseState + ')' + warning;
    }
    if (hint) hint.textContent = d.needsOcr && !d.ocrUsed ? 'Ready with OCR fallback' : 'Ready to analyze';
  } catch (e) {
    uploadedDemandContent = fallbackMetadata;
    var errorMessage = String(e && e.message ? e.message : e);
    var fallbackMessage = /50[234]/.test(errorMessage)
      ? '解析服务暂时不可用，已保留文件名和元数据继续。请确认后端解析服务已重启后再试。'
      : '文件内容解析失败，已使用文件名和元数据继续：' + errorMessage;
    renderDemandUploadState(file, 'error', fallbackMessage);
    if (status) status.innerHTML = esc(fallbackMessage);
    if (hint) hint.textContent = 'Ready with fallback';
  } finally {
    var btn = document.getElementById('btnAnalyzeAI');
    if (btn) btn.disabled = false;
  }
}
function renderDemandUploadState(file, state, message) {
  var box = document.getElementById('demandDropZone');
  if (!box || !file) return;
  var isError = state === 'error';
  box.classList.add('has-file');
  box.classList.toggle('error', isError);
  box.innerHTML = ''
    + '<div class="upload-file-card">'
    + '<div class="upload-file-icon">' + (isError ? '⚠️' : '📄') + '</div>'
    + '<div style="flex:1;min-width:0">'
    + '<div class="upload-file-name">' + esc(file.name || '已选择文件') + '</div>'
    + '<div class="upload-file-meta">' + esc(getDemandFileExtension(file).toUpperCase() || 'FILE') + ' · ' + formatDemandFileSize(file.size || 0) + '</div>'
    + '<div class="upload-file-status">' + esc(message || '已选择文件') + '</div>'
    + '<div style="font-size:11px;color:var(--text2);margin-top:8px">点击此区域可重新选择文件</div>'
    + '</div></div>';
}
function formatDemandFileSize(size) {
  size = Number(size || 0);
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + 'MB';
  if (size >= 1024) return (size / 1024).toFixed(1) + 'KB';
  return size + 'B';
}
function resetDemandUploadState() {
  var box = document.getElementById('demandDropZone');
  if (!box) return;
  box.classList.remove('has-file', 'error');
  box.innerHTML = ''
    + '<div class="upload-icon">📄</div>'
    + '<div class="upload-text">拖拽需求文件到此处，或点击上传</div>'
    + '<div style="font-size:11px;opacity:.4;margin-top:4px">PDF · DOCX · XLSX · XLS · JPG · PNG</div>';
}
function getDemandFileExtension(file) {
  var name = String(file?.name || '');
  var match = name.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}
function isTextLikeDemandFile(file) {
  var ext = getDemandFileExtension(file);
  var type = String(file?.type || '').toLowerCase();
  return ['txt', 'csv', 'tsv', 'md', 'json'].includes(ext) || type.indexOf('text/') === 0 || type.indexOf('json') >= 0 || type.indexOf('csv') >= 0;
}
function buildDemandFileMetadata(file) {
  var ext = getDemandFileExtension(file);
  return [
    'File name: ' + (file?.name || ''),
    'File type: ' + (file?.type || ext || 'unknown'),
    'File size: ' + (file?.size || 0) + ' bytes',
    'Note: Structured or binary demand files such as XLSX, DOCX, PDF and images may need server-side parsing. Use the file name and any visible metadata to infer brand, product, industry and requirements; leave uncertain fields editable for human confirmation.'
  ].join('\n');
}
function normalizeDemandArray(value, splitter) {
  if (Array.isArray(value)) return value.map(function(v) { return String(v || '').trim(); }).filter(Boolean);
  return String(value || '').split(splitter || /[,，、/]+/).map(function(v) { return v.trim(); }).filter(Boolean);
}
function inferDemandFromText(source) {
  var text = String(source || '');
  function pick(regex) {
    var match = text.match(regex);
    return match ? String(match[1] || '').trim().slice(0, 120) : '';
  }
  var fileName = pick(/File name:\s*([^\n]+)/i) || uploadedDemandFileName || '';
  var baseName = fileName.replace(/\.[^.]+$/i, '').replace(/[_-]+/g, ' ');
  var combined = text + '\n' + baseName;
  var brand = pick(/(?:品牌名称|品牌|Brand)[:：\s]+([^\n,，;；]+)/i);
  if (!brand) {
    var brandMatch = baseName.match(/\b([A-Z][A-Z0-9]{1,})\b/);
    if (brandMatch) brand = brandMatch[1];
  }
  var product = pick(/(?:推广产品名|推广产品|产品名称|产品|Product)[:：\s]+([^\n,，;；]+)/i);
  if (!product) {
    var productMatch = baseName.match(/\b([A-Z][A-Za-z]+(?:\s*[A-Za-z])?\s*\d{2,}[A-Za-z0-9-]*)\b/);
    if (productMatch && productMatch[1] !== brand) product = productMatch[1].replace(/\s+/g, ' ').trim();
  }
  var industry = pick(/(?:行业|品类|Industry)[:：\s]+([^\n,，;；]+)/i);
  if (!industry) {
    industry = /储能|电源|电池|太阳能|户外|power\s*station|portable\s*power|elite|bluetti/i.test(combined) ? '储能'
      : /美妆|护肤|美容/i.test(combined) ? '美妆'
      : /宠物|猫|狗/i.test(combined) ? '宠物'
      : /3C|电子|手机|电脑/i.test(combined) ? '3C'
      : '';
  }
  var market = pick(/(?:目标市场|市场|Market)[:：\s]+([^\n,，;；]+)/i);
  if (!market) {
    market = /北美|美国|United States|North America|\bUS\b/i.test(combined) ? '北美/美国'
      : /欧洲|EU|Europe/i.test(combined) ? '欧洲'
      : '';
  }
  var budget = pick(/(?:预算范围|预算|Budget)[:：\s]+([^\n,，;；]+)/i);
  var platforms = /红人|达人|推广|需求|influencer|KOL|社媒|social|TuringMarket|\.xlsx/i.test(combined) ? ['YouTube', 'Instagram', 'TikTok'] : [];
  var requirements = [];
  if (/红人|达人|influencer|KOL/i.test(combined)) requirements.push('红人推广需求');
  if (/新品|new\s*product|launch/i.test(combined)) requirements.push('新品上市传播');
  if (fileName) requirements.push('已根据上传文件名预填，需人工确认字段');
  return {
    brand: brand || '',
    company: pick(/(?:公司名称|公司|Company)[:：\s]+([^\n,，;；]+)/i),
    product: product || '',
    usp: pick(/(?:核心USP|卖点|USP)[:：\s]+([^\n]+)/i),
    industry: industry || '',
    budget_range: budget || '',
    target_market: market || '',
    platforms: platforms,
    competitors: [],
    requirements: requirements
  };
}
function normalizeDemandAnalysis(analysis) {
  var parsed = analysis || {};
  parsed.platforms = normalizeDemandArray(parsed.platforms, /[,，、/]+/);
  parsed.competitors = normalizeDemandArray(parsed.competitors, /[,，、/]+/);
  parsed.requirements = normalizeDemandArray(parsed.requirements, /[;；\n]+/);
  return parsed;
}
function hasDemandAnalysisValue(parsed) {
  return !!(parsed && (parsed.brand || parsed.company || parsed.product || parsed.usp || parsed.industry || parsed.budget_range || parsed.target_market || (parsed.platforms || []).length || (parsed.competitors || []).length || (parsed.requirements || []).length));
}
function mergeDemandAnalysis(parsed, fallback) {
  parsed = normalizeDemandAnalysis(parsed || {});
  fallback = normalizeDemandAnalysis(fallback || {});
  ['brand', 'company', 'product', 'usp', 'industry', 'budget_range', 'target_market'].forEach(function(key) {
    if (!parsed[key] && fallback[key]) parsed[key] = fallback[key];
  });
  ['platforms', 'competitors', 'requirements'].forEach(function(key) {
    if (!parsed[key].length && fallback[key].length) parsed[key] = fallback[key];
  });
  return parsed;
}
async function analyzeDemandAI() {
  var status = document.getElementById('demandFileStatus');
  var out = document.getElementById('analysisOut');
  var hint = document.getElementById('aiAnalyzeHint');
  if (!uploadedDemandContent && !document.getElementById('d_brand')?.value) {
    toast('Upload a file or fill info', 'error');
    return;
  }
  if (!out || !hint) return;
  var requestContext = beginDemandAnalysisRequest();
  if (!requestContext) return;
  hint.textContent = 'Analyzing...';
  var analyzeButton = document.getElementById('btnAnalyzeAI');
  if (analyzeButton) analyzeButton.disabled = true;
  if (status) status.innerHTML = 'AI 正在分析需求...';
  var source = uploadedDemandContent || [
    'Brand: ' + (document.getElementById('d_brand')?.value || ''),
    'Product: ' + (document.getElementById('d_product')?.value || ''),
    'USP: ' + (document.getElementById('d_usp')?.value || ''),
    'Industry: ' + (document.getElementById('d_category')?.value || ''),
    'Market: ' + (document.getElementById('d_area')?.value || ''),
    'Budget: ' + (document.getElementById('d_budget')?.value || '')
  ].join('\n');
  if (uploadedDemandFileName && source.indexOf('File name:') < 0) source = 'File name: ' + uploadedDemandFileName + '\n' + source;
  var prompt = 'Analyze this demand and extract as JSON with: brand, company, product, usp, industry, budget_range, target_market, platforms(array), competitors(array), requirements(array). Content: ' + source;
  lastDemandAnalysisAI = null;
  try {
    var r = await apiFetch('/ai/demand-analysis', buildDemandAnalysisRequestOptions(source, prompt, uploadedDemandFileName, requestContext));
    if (!r.ok) {
      var errText = '';
      try { var errJson = await r.json(); errText = errJson.error || JSON.stringify(errJson); } catch(e0) {}
      if (r.status === 401) errText = '登录状态已过期，请重新登录后再分析需求。';
      throw new Error(errText || ('服务请求失败: ' + r.status));
    }
    var d = await r.json();
    if (!isCurrentDemandAnalysisRequest(requestContext)) return;
    var parsed = mergeDemandAnalysis(d.analysis || {}, inferDemandFromText(source));
    if (!hasDemandAnalysisValue(parsed)) {
      parsed.requirements = ['AI 未能识别有效字段，请在本页手动补充后继续生成方案'];
    }
    demandAnalysisResult = parsed;
    var notice = d.fallback
      ? '<div style="margin-bottom:12px;padding:10px 12px;border-radius:12px;background:#fff7ed;color:#c2410c;font-size:13px">AI 自动解析处于降级模式：' + esc(d.warning || '请检查服务器 AI 配置') + '</div>'
      : '';
    var h = notice + '<h3>AI Analysis</h3><div class="detail-section">';
    h += '<div class="detail-field"><span class="detail-field-label">Brand</span><span class="detail-field-value"><input id="edit_brand" value="' + esc(parsed.brand||'') + '"></span></div>';
    h += '<div class="detail-field"><span class="detail-field-label">Product</span><span class="detail-field-value"><input id="edit_product" value="' + esc(parsed.product||'') + '"></span></div>';
    h += '<div class="detail-field"><span class="detail-field-label">Industry</span><span class="detail-field-value"><input id="edit_industry" value="' + esc(parsed.industry||'') + '"></span></div>';
    h += '<div class="detail-field"><span class="detail-field-label">Budget</span><span class="detail-field-value"><input id="edit_budget" value="' + esc(parsed.budget_range||'') + '"></span></div>';
    h += '<div class="detail-field"><span class="detail-field-label">Market</span><span class="detail-field-value"><input id="edit_market" value="' + esc(parsed.target_market||'') + '"></span></div>';
    h += '<div class="detail-field"><span class="detail-field-label">Platforms</span><span class="detail-field-value"><input id="edit_platforms" value="' + esc(parsed.platforms.join(', ')) + '"></span></div>';
    if (parsed.competitors.length) h += '<div class="detail-field"><span class="detail-field-label">Competitors</span><span class="detail-field-value">' + esc(parsed.competitors.join(', ')) + '</span></div>';
    if (parsed.requirements.length) h += '<div class="detail-field"><span class="detail-field-label">Needs</span><span class="detail-field-value">' + esc(parsed.requirements.join('；')) + '</span></div>';
    h += '</div><p style="font-size:11px;color:#999">Edit fields above if needed. Then click Next to generate proposal.</p>';
    captureDemandAnalysisAudit(d.ai, requestContext.campaignId);
    h += renderDemandAnalysisEvidence(lastDemandAnalysisAI);
    out.innerHTML = h;
    hint.textContent = d.fallback ? 'Basic analysis generated' : 'OK';
    if (status) status.innerHTML = 'AI 分析完成';
    document.getElementById('m3s1').classList.add('hidden');
    document.getElementById('m3s2').classList.remove('hidden');
    updSteps(2);
  } catch(e) {
    if (!isCurrentDemandAnalysisRequest(requestContext)) return;
    hint.textContent = 'Failed';
    if (status) status.innerHTML = '<span style="color:#d94641">AI 分析失败：' + esc(e.message) + '</span>';
    out.innerHTML = '<p style="color:#d94641">AI 分析失败：' + esc(e.message) + '。请检查登录状态或联系管理员查看服务器 AI 配置。</p>';
  } finally {
    var releaseCurrentRequest = isCurrentDemandAnalysisRequest(requestContext);
    finishDemandAnalysisRequest(requestContext);
    if (releaseCurrentRequest && analyzeButton) analyzeButton.disabled = false;
  }
}
function getEditedDemand() {
  return {
    brand: document.getElementById('edit_brand')?.value || document.getElementById('d_brand')?.value || '',
    company: document.getElementById('d_company')?.value || '',
    product: document.getElementById('edit_product')?.value || document.getElementById('d_product')?.value || '',
    usp: document.getElementById('d_usp')?.value || '',
    industry: document.getElementById('edit_industry')?.value || document.getElementById('d_category')?.value || '',
    budget: document.getElementById('edit_budget')?.value || document.getElementById('d_budget')?.value || '',
    market: document.getElementById('edit_market')?.value || document.getElementById('d_area')?.value || '',
    platforms: document.getElementById('edit_platforms')?.value || ''
  };
}
function syncCurDemandFromAnalysis() {
  var demand = getEditedDemand();
  var demandAudit = lastDemandAnalysisAI || {};
  var campaignId = readPositiveInteger(demandAudit.campaign_id);
  if (campaignId === null) campaignId = getActiveCampaignId();
  curDemand = {
    campaign_id: campaignId || '',
    customer_id: activeWorkflowContext?.customer_id || '',
    brand: demand.brand || '',
    company: demand.company || '',
    product: demand.product || '',
    usp: demand.usp || '',
    budget: demand.budget || '',
    platform: demand.platforms || '',
    area: demand.market || '',
    category: demand.industry || '',
    industry: demand.industry || '',
    competitors: Array.isArray(demandAnalysisResult?.competitors) ? demandAnalysisResult.competitors.join(', ') : '',
    notes: Array.isArray(demandAnalysisResult?.requirements) ? demandAnalysisResult.requirements.join('；') : '',
    source_text: uploadedDemandContent || '',
    demand_analysis_conversation_id: demandAudit.conversation_id || '',
    demand_analysis_message_id: demandAudit.message_id || '',
    knowledge_entry_ids: Array.isArray(demandAudit.knowledge_entry_ids) ? demandAudit.knowledge_entry_ids.slice(0, 20) : []
  };
  return curDemand;
}
function goStep3() {
  syncCurDemandFromAnalysis();
  document.getElementById('m3s2').classList.add('hidden');
  document.getElementById('m3s3').classList.remove('hidden');
  updSteps(3);
  initM3();
}
function resetDemand() {
  invalidateDemandAnalysisRequests();
  invalidateProposalDraftRequests();
  resetCampaignPptArtifactState();
  uploadedDemandContent = '';
  uploadedDemandFileName = '';
  demandAnalysisResult = '';
  lastDemandAnalysisAI = null;
  curDemand = null;
  document.getElementById('m3s2').classList.add('hidden');
  document.getElementById('m3s3').classList.add('hidden');
  document.getElementById('m3s1').classList.remove('hidden');
  document.getElementById('demandFileStatus').innerHTML = '';
  resetDemandUploadState();
  document.getElementById('btnAnalyzeAI').disabled = true;
  document.getElementById('aiAnalyzeHint').textContent = 'Upload first';
  var proposalOutput = document.getElementById('proposalOutput');
  if (proposalOutput) proposalOutput.innerHTML = '';
  if (typeof clearPPTContext === 'function') clearPPTContext(true);
  updSteps(1);
}
// ===== M4: INFLUENCER WORKFLOW FIX (final override) =====
function dlFile(name, content, mime) {
  var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
function ensureM4TableStyles() {
  if (document.getElementById('m4TableStickyStyles')) return;
  var style = document.createElement('style');
  style.id = 'm4TableStickyStyles';
  style.textContent = '.m4-table{border-collapse:separate;border-spacing:0;min-width:1320px}.m4-table thead th{position:sticky;top:0;z-index:3;background:var(--surface);box-shadow:0 1px 0 var(--border)}.m4-table th:first-child,.m4-table td:first-child{width:42px;text-align:center}.m4-table input[type="checkbox"]{width:16px!important;height:16px!important;min-width:16px;margin:0;vertical-align:middle;accent-color:#1a1a1a}.m4-table tbody tr:hover{background:#fafaf9}';
  document.head.appendChild(style);
}
var m4Campaigns = [];
var m4CampaignContextId = null;
var lastCollabRows = [];
function getM4CampaignId() {
  if (m4CampaignContextId === 0) return null;
  if (readPositiveInteger(m4CampaignContextId) !== null) return readPositiveInteger(m4CampaignContextId);
  var select = document.getElementById('m4CampaignContext');
  var selected = select ? readPositiveInteger(select.value) : null;
  if (selected !== null) return selected;
  return readPositiveInteger(getActiveCampaignId());
}
function getM4CampaignById(campaignId) {
  campaignId = readPositiveInteger(campaignId);
  return campaignId === null ? null : m4Campaigns.find(function(campaign) {
    return readPositiveInteger(campaign && campaign.id) === campaignId;
  }) || null;
}
function m4CampaignLabel(campaign) {
  if (!campaign) return '';
  var id = readPositiveInteger(campaign.id);
  var parts = [campaign.name || (id === null ? '活动' : '活动 #' + id)];
  if (campaign.product_name) parts.push(campaign.product_name);
  return parts.join(' · ');
}
function renderM4CampaignContext() {
  var status = document.getElementById('m4CampaignContextStatus');
  if (!status) return;
  var campaignId = getM4CampaignId();
  var campaign = getM4CampaignById(campaignId);
  if (campaignId === null) {
    status.textContent = '当前会创建独立合作记录。选择活动后，下单、执行、发布和结算会自动沉淀到同一活动与知识库。';
    return;
  }
  var parts = ['已关联 ' + (campaign ? m4CampaignLabel(campaign) : ('活动 #' + campaignId))];
  if (campaign && campaign.lifecycle_state) parts.push('阶段：' + campaign.lifecycle_state);
  if (campaign && campaign.operational_status) parts.push('状态：' + campaign.operational_status);
  parts.push('订单、执行、发布和结算将写入活动审计链路。');
  status.textContent = parts.join(' · ');
}
async function loadM4Campaigns() {
  var select = document.getElementById('m4CampaignContext');
  if (!select) return [];
  var workflowCampaignId = readPositiveInteger(getActiveCampaignId());
  try {
    var response = await apiFetch('/campaigns?limit=100&operational_status=active');
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || '活动列表加载失败');
    var items = Array.isArray(data.items) ? data.items : [];
    var selectedId = getM4CampaignId();
    if (workflowCampaignId !== null && !items.some(function(campaign) {
      return readPositiveInteger(campaign && campaign.id) === workflowCampaignId;
    })) {
      try {
        var detailResponse = await apiFetch('/campaigns/' + workflowCampaignId);
        var detail = await detailResponse.json();
        if (detailResponse.ok && detail.campaign) items.unshift(detail.campaign);
      } catch (error) {}
    }
    m4Campaigns = items.filter(function(campaign, index, campaigns) {
      var id = readPositiveInteger(campaign && campaign.id);
      return id !== null && campaigns.findIndex(function(item) {
        return readPositiveInteger(item && item.id) === id;
      }) === index;
    });
    if (m4CampaignContextId === null && workflowCampaignId !== null) {
      m4CampaignContextId = workflowCampaignId;
      selectedId = workflowCampaignId;
    }
    select.innerHTML = '<option value="">未关联活动（独立合作记录）</option>' + m4Campaigns.map(function(campaign) {
      var id = readPositiveInteger(campaign.id);
      return '<option value="' + id + '">' + esc(m4CampaignLabel(campaign)) + '</option>';
    }).join('');
    if (selectedId !== null && getM4CampaignById(selectedId)) select.value = String(selectedId);
    renderM4CampaignContext();
    return m4Campaigns;
  } catch (error) {
    m4Campaigns = [];
    select.innerHTML = '<option value="">未关联活动（独立合作记录）</option>';
    renderM4CampaignContext();
    return [];
  }
}
function changeM4CampaignContext() {
  var select = document.getElementById('m4CampaignContext');
  m4CampaignContextId = select && select.value ? readPositiveInteger(select.value) : 0;
  renderM4CampaignContext();
  loadCollaborations();
  renderFeishuReconciliationPanel([], getM4CampaignId());
  renderFeishuRetryPanel([], getM4CampaignId());
  loadFeishuOutbox();
}
function syncM4CampaignContextFromWorkflow() {
  var campaignId = readPositiveInteger(getActiveCampaignId());
  if (campaignId !== null) m4CampaignContextId = campaignId;
  renderFeishuReconciliationPanel([], getM4CampaignId());
  renderFeishuRetryPanel([], getM4CampaignId());
  return loadM4Campaigns().then(function(campaigns) {
    loadFeishuOutbox();
    return campaigns;
  });
}
function initM4() {
  ensureM4TableStyles();
  Promise.all([loadInfluencersFromAPI(), loadM4Campaigns(), loadFeishuStatus()]).then(function() {
    loadCollaborations();
    loadFeishuOutbox();
  });
}
function m4Filters() {
  return {
    platform: document.getElementById('filt_platform')?.value || '',
    region: document.getElementById('filt_region')?.value || '',
    project_name: document.getElementById('filt_project')?.value || '',
    product_name: document.getElementById('filt_product')?.value || '',
    tags: document.getElementById('filt_tags')?.value || '',
    search: document.getElementById('filt_search')?.value || document.getElementById('filt_project')?.value || document.getElementById('filt_product')?.value || document.getElementById('filt_tags')?.value || ''
  };
}
function loadInfluencersFromAPI() {
  var filters = m4Filters();
  var qs = '?sort_by=followers';
  Object.keys(filters).forEach(function(key) {
    if (filters[key]) qs += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(filters[key]);
  });
  return apiFetch('/influencers' + qs).then(function(r) { return r.json(); }).then(function(d) {
    lastInfAPI = d.influencers || [];
    lastMatch = lastInfAPI;
    renderInfTable(lastInfAPI);
    return lastInfAPI;
  }).catch(function(e) {
    lastInfAPI = [];
    lastMatch = [];
    var c = document.getElementById('infTableContainer');
    if (c) c.innerHTML = '<p style="text-align:center;padding:30px;opacity:.5">Load failed: ' + esc(e.message) + '</p>';
    return [];
  });
}
function matchInfluencers() { return loadInfluencersFromAPI(); }
function fmtCount(n) {
  n = Number(n || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}
function renderInfTable(data) {
  ensureM4TableStyles();
  var c = document.getElementById('infTableContainer');
  if (!c) return;
  if (!data || !data.length) { c.innerHTML = '<p style="text-align:center;padding:30px;opacity:.5">No influencers</p>'; return; }
  var h = '<table class="m4-table"><thead><tr><th><label class="tm-checkbox-target"><input type="checkbox" id="selectAllInf" aria-label="全选网红" onchange="toggleAll(this)"></label></th><th>ID</th><th>KOL</th><th>Platform</th><th>Followers</th><th>Project</th><th>Product</th><th>Region</th><th>Type</th><th>Parent</th><th>Link</th><th>Deliverable</th><th>Cost</th><th>Action</th></tr></thead><tbody>';
  data.forEach(function(inf) {
    h += '<tr><td><label class="tm-checkbox-target"><input type="checkbox" class="infcb" aria-label="选择网红 ' + esc(inf.kol_handle || inf.id || '') + '" value="' + esc(inf.id || '') + '" onchange="syncInfluencerSelectionState()"></label></td>';
    h += '<td>#' + esc(inf.id || '') + '</td>';
    h += '<td><strong>' + esc(inf.kol_handle || '') + '</strong></td>';
    h += '<td>' + esc(inf.platform || '-') + '</td>';
    h += '<td>' + fmtCount(inf.followers) + '</td>';
    h += '<td>' + esc(inf.project_name || '-') + '</td>';
    h += '<td>' + esc(inf.product_name || '-') + '</td>';
    h += '<td>' + esc(inf.region || '-') + '</td>';
    h += '<td>' + esc(inf.influencer_type || inf.tags || inf.category || '-') + '</td>';
    h += '<td>' + esc(inf.parent_record || '-') + '</td>';
    h += '<td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(inf.profile_link || '-') + '</td>';
    h += '<td style="max-width:150px">' + esc(inf.content_deliverable || inf.collab_type || '-') + '</td>';
    h += '<td>$' + (inf.quoted_price || inf.cost_usd || 0) + '</td>';
    h += '<td><button class="btn btn-sm btn-primary" onclick="startCollab(' + Number(inf.id || 0) + ')">下单</button></td></tr>';
  });
  h += '</tbody></table>';
  c.innerHTML = h;
  syncInfluencerSelectionState();
  if (window.TMAccessibility) window.TMAccessibility.refresh();
}
function toggleAll(cb) {
  document.querySelectorAll('.infcb').forEach(function(item) { item.checked = cb.checked; });
  syncInfluencerSelectionState();
}
function syncInfluencerSelectionState() {
  var selectAll = document.getElementById('selectAllInf');
  if (!selectAll) return;
  var items = Array.prototype.slice.call(document.querySelectorAll('.infcb'));
  var selected = items.filter(function(item) { return item.checked; }).length;
  selectAll.checked = items.length > 0 && selected === items.length;
  selectAll.indeterminate = selected > 0 && selected < items.length;
}
function getSelectedInfIds() {
  var ids = [];
  document.querySelectorAll('.infcb:checked').forEach(function(cb) {
    var id = parseInt(cb.value, 10);
    if (!isNaN(id)) ids.push(id);
  });
  return ids;
}
function exportAll() { return exportInf('all'); }
function exportFiltered() { return exportInf('filtered'); }
function exportSelected() {
  var ids = getSelectedInfIds();
  if (!ids.length) { toast('Select influencers first', 'error'); return; }
  return exportInf('selected', ids);
}
function exportInf(mode, ids) {
  var body = { mode: mode };
  if (mode === 'selected' && ids) body.ids = ids;
  if (mode === 'filtered') body.filters = m4Filters();
  return apiFetch('/influencers/export', { method: 'POST', body: JSON.stringify(body) }).then(function(r) {
    if (!r.ok) throw new Error('Export failed');
    return r.blob();
  }).then(function(blob) {
    dlFile('influencers_export.csv', blob, 'text/csv;charset=utf-8');
    toast('Export done');
  }).catch(function(e) { toast(e.message || 'Export failed', 'error'); });
}
async function importInfluencerFile(file, statusEl) {
  if (!file) return;
  var ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['csv', 'json', 'xlsx', 'xls'].indexOf(ext) === -1) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#d94641">Unsupported file type: .' + esc(ext) + '</span>';
    return;
  }
  if (statusEl) statusEl.innerHTML = '<span>Uploading ' + esc(file.name) + '...</span>';
  var fd = new FormData();
  fd.append('file', file);
  fd.append('batch_id', file.name);
  try {
    var r = await apiFetch('/influencers/upload', { method: 'POST', body: fd });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Upload failed');
    if (statusEl) statusEl.innerHTML = '<span style="color:#0f7b3c">Imported ' + (d.imported || 0) + ', skipped ' + (d.skipped || 0) + '</span>';
    showInfPreview(d.sample || []);
    await loadInfluencersFromAPI();
    toast('Imported ' + (d.imported || 0));
  } catch (e) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#d94641">' + esc(e.message) + '</span>';
    toast(e.message, 'error');
  }
}
function handleUpload(e) {
  var file = e && e.target && e.target.files ? e.target.files[0] : null;
  importInfluencerFile(file, document.getElementById('uploadOK'));
  if (e && e.target) e.target.value = '';
}
function handleDrop(event) {
  var file = event && event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
  importInfluencerFile(file, document.getElementById('uploadOK'));
}
function openInfUploadModal() {
  var modal = document.getElementById('infUploadModal');
  if (modal) modal.style.display = 'flex';
}
function handleUploadModal(event) {
  var file = event && event.target && event.target.files ? event.target.files[0] : null;
  importInfluencerFile(file, document.getElementById('infModalStatus'));
  if (event && event.target) event.target.value = '';
}
function importInfluencers(rows) {
  if (!rows || !rows.length) return;
  apiFetch('/influencers/import', { method: 'POST', body: JSON.stringify({ rows: rows }) }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); }).then(function(result) {
    if (!result.ok) throw new Error(result.data.error || 'Import failed');
    toast('Imported ' + (result.data.imported || 0));
    loadInfluencersFromAPI();
  }).catch(function(e) { toast('Import: ' + e.message, 'error'); });
}
function showInfPreview(data) {
  var c = document.getElementById('infPreview');
  if (!c) return;
  if (!data || !data.length) { c.innerHTML = ''; return; }
  var keys = Object.keys(data[0] || {}).slice(0, 6);
  var h = '<table style="width:100%;font-size:10px;border-collapse:collapse"><thead><tr>';
  keys.forEach(function(k) { h += '<th style="text-align:left;padding:4px;opacity:.5">' + esc(k) + '</th>'; });
  h += '</tr></thead><tbody>';
  data.slice(0, 5).forEach(function(row) {
    h += '<tr>';
    keys.forEach(function(k) { h += '<td style="padding:4px;border-top:1px solid var(--border)">' + esc(row[k] || '') + '</td>'; });
    h += '</tr>';
  });
  h += '</tbody></table>';
  c.innerHTML = h;
}
async function downloadInfTemplate() {
  try {
    var r = await apiFetch('/influencers/template');
    if (!r.ok) throw new Error('Template download failed');
    var blob = await r.blob();
    dlFile('influencer_import_template.csv', blob, 'text/csv;charset=utf-8');
  } catch (e) {
    var csv = '\uFEFF日期,提报人,项目&客户,推广产品,是否重复,网红频道名称,网红粉丝量,网红频道链接,社媒平台,国家,网红类型,近10个视频均播,网红成本价格（折算美元）,网红交付物（植入-完播等信息）,Turing备注,对外商务报价（美元）,网红联系方式,CPM（自动计算）,CPV(自动计算),父记录\n';
    dlFile('influencer_import_template.csv', csv, 'text/csv;charset=utf-8');
  }
}
function feishuModeLabel(mode) {
  if (mode === 'webhook') return 'Webhook';
  if (mode === 'bitable') return '飞书多维表格';
  return '未配置';
}

function renderFeishuConnectionStatus(data) {
  var connection = document.getElementById('feishuConnectionStatus');
  var testButton = document.getElementById('feishuTestButton');
  var isAdmin = !!(CURRENT_USER && CURRENT_USER.role === 'admin');
  var configured = !!(data && data.configured);
  var syncAvailable = !!(data && data.sync_available);
  var testAvailable = !!(data && data.test_available);
  if (connection) {
    if (!configured) {
      connection.textContent = data && data.mode === 'bitable'
        ? '飞书多维表格配置尚未完整，推送会自动下载 CSV。'
        : '飞书尚未配置，推送会自动下载 CSV。';
      connection.style.color = 'var(--amber)';
    } else if (data.mode === 'bitable') {
      connection.textContent = syncAvailable
        ? '飞书多维表格写入已启用，可推送已选网红。'
        : '飞书多维表格连接已配置，可由管理员验证访问权限；当前推送仍会下载 CSV。';
      connection.style.color = syncAvailable ? 'var(--green)' : 'var(--text2)';
    } else {
      connection.textContent = '飞书 ' + feishuModeLabel(data.mode) + ' 已配置，可推送已选网红。';
      connection.style.color = syncAvailable ? 'var(--green)' : 'var(--text2)';
    }
  }
  if (testButton) {
    testButton.hidden = !isAdmin;
    testButton.disabled = !configured || !testAvailable;
    testButton.title = testAvailable
      ? '管理员测试服务器端飞书连接'
      : '需配置独立的飞书测试端点或多维表格访问权限';
  }
}

async function loadFeishuStatus() {
  var connection = document.getElementById('feishuConnectionStatus');
  if (connection) {
    connection.textContent = '正在检查飞书连接状态...';
    connection.style.color = 'var(--text2)';
  }
  try {
    var response = await apiFetch('/feishu/status');
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法读取飞书连接状态');
    renderFeishuConnectionStatus(data);
    return data;
  } catch (error) {
    if (connection) {
      connection.textContent = '暂时无法读取飞书连接状态。';
      connection.style.color = 'var(--red)';
    }
    return null;
  }
}

function renderFeishuDeliveryStatus(delivery, campaignId, errorMessage) {
  var status = document.getElementById('feishuDeliveryStatus');
  if (!status) return;
  if (campaignId === null) {
    status.textContent = '选择关联活动后，可查看最近一次飞书推送回执。';
    status.style.color = 'var(--text2)';
    return;
  }
  if (errorMessage) {
    status.textContent = '暂时无法读取活动的飞书推送回执。';
    status.style.color = 'var(--red)';
    return;
  }
  if (!delivery) {
    status.textContent = '当前活动暂未产生飞书推送记录。';
    status.style.color = 'var(--text2)';
    return;
  }
  if (delivery.status === 'succeeded') {
    status.textContent = '最近一次推送已成功写入 ' + (delivery.remote_record_count || delivery.record_count || 0) + ' 条网红记录。';
    status.style.color = 'var(--green)';
    return;
  }
  if (delivery.status === 'failed') {
    status.textContent = delivery.retry_available
      ? '最近一次推送失败（' + (delivery.last_error_code || 'FEISHU_SYNC_FAILED') + '），活动 Owner 或组织管理员可显式重试。'
      : '最近一次推送失败（' + (delivery.last_error_code || 'FEISHU_SYNC_FAILED') + '），请先处理失败原因或核对飞书记录。';
    status.style.color = 'var(--red)';
    return;
  }
  status.textContent = '最近一次推送结果待管理员与飞书记录核对，请勿重复提交。';
  status.style.color = 'var(--amber)';
}

var feishuOutboxLoadGeneration = 0;
var feishuReconciliationState = {
  campaignId: null,
  deliveries: [],
  deliveryId: null,
  inFlight: null
};
var feishuReconciliationInFlightByDelivery = {};
var feishuRetryState = {
  campaignId: null,
  deliveries: [],
  deliveryId: null,
  inFlight: null
};
var feishuRetryInFlightByDelivery = {};
var feishuRetryOperationIds = {};

function isM4FeishuReconciliationOperator(campaign) {
  var organization = typeof CURRENT_AUTH_CONTEXT !== 'undefined' && CURRENT_AUTH_CONTEXT
    ? CURRENT_AUTH_CONTEXT.organization
    : null;
  if (organization && organization.role_code === 'org_admin') return true;
  var ownerId = readPositiveInteger(campaign && campaign.owner && campaign.owner.id);
  var userId = readPositiveInteger(CURRENT_USER && CURRENT_USER.id);
  return ownerId !== null && userId !== null && ownerId === userId;
}

function pendingFeishuDeliveries(deliveries) {
  return Array.isArray(deliveries) ? deliveries.filter(function(delivery) {
    return delivery && delivery.status === 'pending' && readPositiveInteger(delivery.id) !== null;
  }) : [];
}

function retryableFeishuDeliveries(deliveries) {
  return Array.isArray(deliveries) ? deliveries.filter(function(delivery) {
    return delivery && delivery.status === 'failed' && delivery.retry_available === true &&
      readPositiveInteger(delivery.id) !== null;
  }) : [];
}

function selectedFeishuReconciliationDelivery() {
  var deliveryId = readPositiveInteger(feishuReconciliationState.deliveryId);
  if (deliveryId === null) return null;
  return feishuReconciliationState.deliveries.find(function(delivery) {
    return readPositiveInteger(delivery.id) === deliveryId;
  }) || null;
}

function normalizeFeishuReconciliationRecordIds(value) {
  return String(value || '').split(/\r?\n/).map(function(recordId) {
    return recordId.trim();
  }).filter(function(recordId) {
    return recordId.length > 0;
  });
}

function feishuReconciliationActionKey(campaignId, deliveryId) {
  var normalizedCampaignId = readPositiveInteger(campaignId);
  var normalizedDeliveryId = readPositiveInteger(deliveryId);
  return normalizedCampaignId === null || normalizedDeliveryId === null
    ? ''
    : String(normalizedCampaignId) + ':' + String(normalizedDeliveryId);
}

function renderFeishuReconciliationPanel(deliveries, campaignId, errorMessage) {
  var panel = document.getElementById('feishuReconciliationPanel');
  if (!panel) return;
  var normalizedCampaignId = readPositiveInteger(campaignId);
  var pending = pendingFeishuDeliveries(deliveries);
  var select = document.getElementById('feishuReconciliationDelivery');
  var meta = document.getElementById('feishuReconciliationMeta');
  var access = document.getElementById('feishuReconciliationAccess');
  var form = document.getElementById('feishuReconciliationForm');
  var input = document.getElementById('feishuReconciliationRecordIds');
  var submit = document.getElementById('feishuReconciliationSubmit');
  var status = document.getElementById('feishuReconciliationStatus');
  if (normalizedCampaignId === null || errorMessage || !pending.length) {
    var activeActionKey = feishuReconciliationActionKey(
      feishuReconciliationState.campaignId,
      feishuReconciliationState.deliveryId
    );
    var activeAction = activeActionKey ? feishuReconciliationInFlightByDelivery[activeActionKey] : null;
    var keepInFlightDelivery = Boolean(activeAction) &&
      feishuReconciliationState.campaignId === normalizedCampaignId;
    panel.hidden = true;
    if (!keepInFlightDelivery) {
      feishuReconciliationState.campaignId = normalizedCampaignId;
      feishuReconciliationState.deliveries = [];
      feishuReconciliationState.deliveryId = null;
      feishuReconciliationState.inFlight = null;
      if (input) input.value = '';
      if (status) status.textContent = '';
    } else {
      feishuReconciliationState.deliveries = [];
      feishuReconciliationState.inFlight = activeAction;
    }
    return;
  }
  var previousCampaignId = feishuReconciliationState.campaignId;
  var previousDeliveryId = feishuReconciliationState.deliveryId;
  var selected = previousCampaignId === normalizedCampaignId
    ? pending.find(function(delivery) {
      return readPositiveInteger(delivery.id) === readPositiveInteger(previousDeliveryId);
    })
    : null;
  if (!selected) selected = pending[0];
  feishuReconciliationState.campaignId = normalizedCampaignId;
  feishuReconciliationState.deliveries = pending;
  feishuReconciliationState.deliveryId = readPositiveInteger(selected.id);
  feishuReconciliationState.inFlight = feishuReconciliationInFlightByDelivery[
    feishuReconciliationActionKey(normalizedCampaignId, feishuReconciliationState.deliveryId)
  ] || null;
  panel.hidden = false;
  if (select) {
    select.innerHTML = pending.map(function(delivery) {
      var label = '批次 #' + Number(delivery.id) + ' · ' + Number(delivery.record_count || 0) + ' 条 · ' + (delivery.updated_at || '待核对');
      return '<option value="' + Number(delivery.id) + '">' + esc(label) + '</option>';
    }).join('');
    select.value = String(feishuReconciliationState.deliveryId);
    select.disabled = pending.length < 2 || Boolean(feishuReconciliationState.inFlight);
  }
  if (meta) {
    meta.textContent = '待核对批次 #' + feishuReconciliationState.deliveryId + '，需要 ' + Number(selected.record_count || 0) + ' 条唯一 Record ID。';
  }
  var canReconcile = isM4FeishuReconciliationOperator(getM4CampaignById(normalizedCampaignId));
  if (access) {
    access.textContent = canReconcile
      ? '确认后回执不可修改。'
      : '仅活动 Owner 或组织管理员可确认回执。';
    access.style.color = canReconcile ? 'var(--text2)' : 'var(--amber)';
  }
  if (form) form.hidden = !canReconcile;
  if (input) input.disabled = !canReconcile || Boolean(feishuReconciliationState.inFlight);
  if (submit) submit.disabled = !canReconcile || Boolean(feishuReconciliationState.inFlight);
  if (
    (previousCampaignId !== normalizedCampaignId || previousDeliveryId !== feishuReconciliationState.deliveryId) &&
    !feishuReconciliationState.inFlight
  ) {
    if (input) input.value = '';
    if (status) status.textContent = '';
  }
}

function selectFeishuReconciliationDelivery() {
  var select = document.getElementById('feishuReconciliationDelivery');
  var deliveryId = readPositiveInteger(select && select.value);
  if (deliveryId === null || !feishuReconciliationState.deliveries.some(function(delivery) {
    return readPositiveInteger(delivery.id) === deliveryId;
  })) return;
  feishuReconciliationState.deliveryId = deliveryId;
  var input = document.getElementById('feishuReconciliationRecordIds');
  var status = document.getElementById('feishuReconciliationStatus');
  if (input) input.value = '';
  if (status) status.textContent = '';
  renderFeishuReconciliationPanel(feishuReconciliationState.deliveries, feishuReconciliationState.campaignId);
}

function reconcileFeishuDelivery() {
  var campaignId = getM4CampaignId();
  var activeActionKey = feishuReconciliationActionKey(
    feishuReconciliationState.campaignId,
    feishuReconciliationState.deliveryId
  );
  if (
    feishuReconciliationState.campaignId === campaignId && activeActionKey &&
    feishuReconciliationInFlightByDelivery[activeActionKey]
  ) {
    return feishuReconciliationInFlightByDelivery[activeActionKey];
  }
  var delivery = selectedFeishuReconciliationDelivery();
  var campaign = getM4CampaignById(campaignId);
  var input = document.getElementById('feishuReconciliationRecordIds');
  var status = document.getElementById('feishuReconciliationStatus');
  var submit = document.getElementById('feishuReconciliationSubmit');
  if (
    campaignId === null || !delivery || delivery.status !== 'pending' ||
    feishuReconciliationState.campaignId !== campaignId
  ) {
    if (status) status.textContent = '没有可确认的待核对回执。';
    return null;
  }
  if (!isM4FeishuReconciliationOperator(campaign)) {
    if (status) status.textContent = '当前账号无权确认该回执。';
    toast('当前账号无权确认该回执', 'error');
    return null;
  }
  var actionCampaignId = campaignId;
  var actionDeliveryId = readPositiveInteger(delivery.id);
  var actionKey = feishuReconciliationActionKey(actionCampaignId, actionDeliveryId);
  if (actionKey && feishuReconciliationInFlightByDelivery[actionKey]) {
    return feishuReconciliationInFlightByDelivery[actionKey];
  }
  var remoteRecordIds = normalizeFeishuReconciliationRecordIds(input && input.value);
  var expectedCount = Number(delivery.record_count || 0);
  if (
    remoteRecordIds.length !== expectedCount ||
    remoteRecordIds.some(function(recordId) { return recordId.length > 255; }) ||
    new Set(remoteRecordIds).size !== expectedCount
  ) {
    if (status) status.textContent = '请录入 ' + expectedCount + ' 条不重复的 Record ID。';
    return null;
  }
  if (status) status.textContent = '正在确认飞书回执...';
  if (submit) submit.disabled = true;
  var action = (async function() {
    try {
      var response = await apiFetch(
        '/campaigns/' + encodeURIComponent(actionCampaignId) + '/feishu-deliveries/' + encodeURIComponent(actionDeliveryId) + '/reconcile',
        {
          method: 'POST',
          body: JSON.stringify({ remote_record_ids: remoteRecordIds })
        }
      );
      var data = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          await loadFeishuOutbox();
          if (getM4CampaignId() === actionCampaignId && status) {
            status.textContent = '回执状态已更新，请按最新结果处理。';
          }
          toast('回执状态已更新，请按最新结果处理');
          return null;
        }
        throw new Error(data.error || '飞书回执确认失败');
      }
      if (!data.delivery || data.delivery.status !== 'succeeded') {
        throw new Error('飞书回执确认结果无效');
      }
      if (
        getM4CampaignId() === actionCampaignId &&
        feishuReconciliationState.deliveryId === actionDeliveryId &&
        input
      ) input.value = '';
      if (getM4CampaignId() === actionCampaignId && status) {
        status.textContent = '飞书回执已确认。';
      }
      toast('飞书回执已确认');
      await loadFeishuOutbox();
      return data.delivery;
    } catch (error) {
      if (getM4CampaignId() === actionCampaignId && status) {
        status.textContent = error.message || '飞书回执确认失败。';
      }
      toast(error.message || '飞书回执确认失败', 'error');
      return null;
    }
  })();
  var settlement = action.finally(function() {
    if (actionKey && feishuReconciliationInFlightByDelivery[actionKey] === settlement) {
      delete feishuReconciliationInFlightByDelivery[actionKey];
    }
    if (feishuReconciliationState.inFlight === settlement) {
      feishuReconciliationState.inFlight = null;
      renderFeishuReconciliationPanel(
        feishuReconciliationState.deliveries,
        feishuReconciliationState.campaignId
      );
    }
  });
  if (actionKey) feishuReconciliationInFlightByDelivery[actionKey] = settlement;
  feishuReconciliationState.inFlight = settlement;
  return settlement;
}

function selectedFeishuRetryDelivery() {
  var deliveryId = readPositiveInteger(feishuRetryState.deliveryId);
  if (deliveryId === null) return null;
  return feishuRetryState.deliveries.find(function(delivery) {
    return readPositiveInteger(delivery.id) === deliveryId;
  }) || null;
}

function feishuRetryActionKey(campaignId, deliveryId) {
  var normalizedCampaignId = readPositiveInteger(campaignId);
  var normalizedDeliveryId = readPositiveInteger(deliveryId);
  return normalizedCampaignId === null || normalizedDeliveryId === null
    ? ''
    : String(normalizedCampaignId) + ':' + String(normalizedDeliveryId);
}

function renderFeishuRetryPanel(deliveries, campaignId, errorMessage) {
  var panel = document.getElementById('feishuRetryPanel');
  if (!panel) return;
  var normalizedCampaignId = readPositiveInteger(campaignId);
  var retryable = retryableFeishuDeliveries(deliveries);
  var select = document.getElementById('feishuRetryDelivery');
  var meta = document.getElementById('feishuRetryMeta');
  var access = document.getElementById('feishuRetryAccess');
  var form = document.getElementById('feishuRetryForm');
  var input = document.getElementById('feishuRetryReason');
  var submit = document.getElementById('feishuRetrySubmit');
  var status = document.getElementById('feishuRetryStatus');
  if (normalizedCampaignId === null || errorMessage || !retryable.length) {
    var activeActionKey = feishuRetryActionKey(feishuRetryState.campaignId, feishuRetryState.deliveryId);
    var activeAction = activeActionKey ? feishuRetryInFlightByDelivery[activeActionKey] : null;
    var keepInFlightDelivery = Boolean(activeAction) && feishuRetryState.campaignId === normalizedCampaignId;
    panel.hidden = true;
    if (!keepInFlightDelivery) {
      feishuRetryState.campaignId = normalizedCampaignId;
      feishuRetryState.deliveries = [];
      feishuRetryState.deliveryId = null;
      feishuRetryState.inFlight = null;
      if (input) input.value = '';
      if (status) status.textContent = '';
    } else {
      feishuRetryState.deliveries = [];
      feishuRetryState.inFlight = activeAction;
    }
    return;
  }
  var previousCampaignId = feishuRetryState.campaignId;
  var previousDeliveryId = feishuRetryState.deliveryId;
  var selected = previousCampaignId === normalizedCampaignId
    ? retryable.find(function(delivery) {
      return readPositiveInteger(delivery.id) === readPositiveInteger(previousDeliveryId);
    })
    : null;
  if (!selected) selected = retryable[0];
  feishuRetryState.campaignId = normalizedCampaignId;
  feishuRetryState.deliveries = retryable;
  feishuRetryState.deliveryId = readPositiveInteger(selected.id);
  feishuRetryState.inFlight = feishuRetryInFlightByDelivery[
    feishuRetryActionKey(normalizedCampaignId, feishuRetryState.deliveryId)
  ] || null;
  panel.hidden = false;
  if (select) {
    select.innerHTML = retryable.map(function(delivery) {
      var label = '失败批次 #' + Number(delivery.id) + ' · ' + Number(delivery.record_count || 0) + ' 条 · ' +
        (delivery.last_error_code || 'FEISHU_SYNC_FAILED');
      return '<option value="' + Number(delivery.id) + '">' + esc(label) + '</option>';
    }).join('');
    select.value = String(feishuRetryState.deliveryId);
    select.disabled = retryable.length < 2 || Boolean(feishuRetryState.inFlight);
  }
  if (meta) {
    meta.textContent = '失败批次 #' + feishuRetryState.deliveryId + '，将基于原始快照创建新的推送回执。';
  }
  var canRetry = isM4FeishuReconciliationOperator(getM4CampaignById(normalizedCampaignId));
  if (access) {
    access.textContent = canRetry
      ? '重试会创建新的不可变回执，原失败回执会保留。'
      : '仅活动 Owner 或组织管理员可显式重试。';
    access.style.color = canRetry ? 'var(--text2)' : 'var(--amber)';
  }
  if (form) form.hidden = !canRetry;
  if (input) input.disabled = !canRetry || Boolean(feishuRetryState.inFlight);
  if (submit) submit.disabled = !canRetry || Boolean(feishuRetryState.inFlight);
  if (
    (previousCampaignId !== normalizedCampaignId || previousDeliveryId !== feishuRetryState.deliveryId) &&
    !feishuRetryState.inFlight
  ) {
    if (input) input.value = '';
    if (status) status.textContent = '';
  }
}

function selectFeishuRetryDelivery() {
  var select = document.getElementById('feishuRetryDelivery');
  var deliveryId = readPositiveInteger(select && select.value);
  if (deliveryId === null || !feishuRetryState.deliveries.some(function(delivery) {
    return readPositiveInteger(delivery.id) === deliveryId;
  })) return;
  feishuRetryState.deliveryId = deliveryId;
  var input = document.getElementById('feishuRetryReason');
  var status = document.getElementById('feishuRetryStatus');
  if (input) input.value = '';
  if (status) status.textContent = '';
  renderFeishuRetryPanel(feishuRetryState.deliveries, feishuRetryState.campaignId);
}

function retryFeishuDelivery() {
  var campaignId = getM4CampaignId();
  var activeActionKey = feishuRetryActionKey(feishuRetryState.campaignId, feishuRetryState.deliveryId);
  if (
    feishuRetryState.campaignId === campaignId && activeActionKey &&
    feishuRetryInFlightByDelivery[activeActionKey]
  ) {
    return feishuRetryInFlightByDelivery[activeActionKey];
  }
  var delivery = selectedFeishuRetryDelivery();
  var campaign = getM4CampaignById(campaignId);
  var input = document.getElementById('feishuRetryReason');
  var status = document.getElementById('feishuRetryStatus');
  var submit = document.getElementById('feishuRetrySubmit');
  if (
    campaignId === null || !delivery || delivery.status !== 'failed' || delivery.retry_available !== true ||
    feishuRetryState.campaignId !== campaignId
  ) {
    if (status) status.textContent = '没有可安全重试的失败回执。';
    return null;
  }
  if (!isM4FeishuReconciliationOperator(campaign)) {
    if (status) status.textContent = '当前账号无权重试该回执。';
    toast('当前账号无权重试该回执', 'error');
    return null;
  }
  var reason = String(input && input.value || '').trim();
  if (!reason || reason.length > 280) {
    if (status) status.textContent = reason.length > 280
      ? 'Retry reason must not exceed 280 characters.'
      : 'A retry reason is required.';
    return null;
  }
  var actionCampaignId = campaignId;
  var actionDeliveryId = readPositiveInteger(delivery.id);
  var actionKey = feishuRetryActionKey(actionCampaignId, actionDeliveryId);
  if (actionKey && feishuRetryInFlightByDelivery[actionKey]) {
    return feishuRetryInFlightByDelivery[actionKey];
  }
  if (!feishuRetryOperationIds[actionKey]) {
    feishuRetryOperationIds[actionKey] = createFeishuBitableOperationId();
  }
  var operationId = feishuRetryOperationIds[actionKey];
  if (status) status.textContent = '正在基于原始快照重试飞书推送...';
  if (submit) submit.disabled = true;
  var action = (async function() {
    try {
      var response = await apiFetch(
        '/campaigns/' + encodeURIComponent(actionCampaignId) + '/feishu-deliveries/' + encodeURIComponent(actionDeliveryId) + '/retry',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': operationId },
          body: JSON.stringify({ reason: reason })
        }
      );
      var data = await response.json();
      if (data.delivery && data.delivery.status === 'pending') {
        await loadFeishuOutbox();
        if (getM4CampaignId() === actionCampaignId && status) {
          status.textContent = '重试已提交，等待飞书回执核对。';
        }
        toast('飞书重试已提交，等待回执核对');
        return data.delivery;
      }
      if (data.delivery && data.delivery.status === 'failed') {
        await loadFeishuOutbox();
        if (getM4CampaignId() === actionCampaignId && status) {
          status.textContent = '飞书重试未写入，失败回执已更新。';
        }
        toast('飞书重试未写入，失败回执已更新', 'error');
        return data.delivery;
      }
      if (!response.ok) {
        if (response.status === 409) {
          await loadFeishuOutbox();
          if (getM4CampaignId() === actionCampaignId && status) {
            status.textContent = '重试回执状态已更新，请按最新结果处理。';
          }
          toast('Feishu retry state was refreshed');
          return null;
        }
        throw new Error(data.error || '飞书重试失败');
      }
      if (!data.delivery || data.delivery.status !== 'succeeded') {
        throw new Error('飞书重试结果无效');
      }
      if (
        getM4CampaignId() === actionCampaignId &&
        feishuRetryState.deliveryId === actionDeliveryId &&
        input
      ) input.value = '';
      if (getM4CampaignId() === actionCampaignId && status) {
        status.textContent = '飞书推送已重试成功。';
      }
      toast('Feishu retry completed');
      await loadFeishuOutbox();
      return data.delivery;
    } catch (error) {
      if (getM4CampaignId() === actionCampaignId && status) {
        status.textContent = error.message || '飞书重试失败。';
      }
      toast(error.message || '飞书重试失败', 'error');
      return null;
    }
  })();
  var settlement = action.finally(function() {
    if (actionKey && feishuRetryInFlightByDelivery[actionKey] === settlement) {
      delete feishuRetryInFlightByDelivery[actionKey];
    }
    if (feishuRetryState.inFlight === settlement) {
      feishuRetryState.inFlight = null;
      renderFeishuRetryPanel(feishuRetryState.deliveries, feishuRetryState.campaignId);
    }
  });
  if (actionKey) feishuRetryInFlightByDelivery[actionKey] = settlement;
  feishuRetryState.inFlight = settlement;
  return settlement;
}

async function loadFeishuOutbox() {
  var campaignId = getM4CampaignId();
  var requestGeneration = ++feishuOutboxLoadGeneration;
  if (campaignId === null) {
    renderFeishuDeliveryStatus(null, null);
    renderFeishuReconciliationPanel([], null);
    renderFeishuRetryPanel([], null);
    return [];
  }
  var status = document.getElementById('feishuDeliveryStatus');
  if (status) {
    status.textContent = '正在读取最近一次飞书推送回执...';
    status.style.color = 'var(--text2)';
  }
  try {
    var response = await apiFetch('/campaigns/' + encodeURIComponent(campaignId) + '/feishu-deliveries?limit=20');
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法读取飞书推送回执');
    if (requestGeneration !== feishuOutboxLoadGeneration || campaignId !== getM4CampaignId()) return [];
    var deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
    renderFeishuDeliveryStatus(deliveries[0] || null, campaignId);
    renderFeishuReconciliationPanel(deliveries, campaignId);
    renderFeishuRetryPanel(deliveries, campaignId);
    return deliveries;
  } catch (error) {
    if (requestGeneration !== feishuOutboxLoadGeneration || campaignId !== getM4CampaignId()) return [];
    renderFeishuDeliveryStatus(null, campaignId, error);
    renderFeishuReconciliationPanel([], campaignId, error);
    renderFeishuRetryPanel([], campaignId, error);
    return [];
  }
}

async function testFeishuConnection() {
  var status = document.getElementById('feishuStatus');
  var button = document.getElementById('feishuTestButton');
  if (!(CURRENT_USER && CURRENT_USER.role === 'admin')) {
    toast('仅管理员可测试飞书连接', 'error');
    return;
  }
  if (button) button.disabled = true;
  if (status) status.textContent = '正在测试飞书连接...';
  try {
    var response = await apiFetch('/feishu/test', { method: 'POST', body: JSON.stringify({}) });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || '飞书连接测试失败');
    if (status) status.textContent = '飞书 ' + feishuModeLabel(data.mode) + ' 连接验证通过。';
    toast('飞书连接验证通过');
  } catch (error) {
    if (status) status.textContent = '飞书连接测试未通过：' + (error.message || '请检查服务器配置。');
    toast(error.message || '飞书连接测试失败', 'error');
  } finally {
    await loadFeishuStatus();
  }
}

var feishuBitableSyncState = { selectionKey: '', operationId: '', inFlight: null };
function createFeishuBitableOperationId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(character) {
    var random = Math.floor(Math.random() * 16);
    var value = character === 'x' ? random : ((random & 0x3) | 0x8);
    return value.toString(16);
  });
}
function feishuBitableSelectionSignature(ids, campaignId) {
  var scope = readPositiveInteger(campaignId);
  var selection = (ids || [])
    .map(function(id) { return Number(id); })
    .filter(function(id) { return Number.isInteger(id) && id > 0; })
    .sort(function(left, right) { return left - right; })
    .join(',');
  return String(scope === null ? 0 : scope) + ':' + selection;
}
function feishuBitableSyncStateFor(ids, campaignId) {
  var selectionKey = feishuBitableSelectionSignature(ids, campaignId);
  if (feishuBitableSyncState.selectionKey !== selectionKey) {
    feishuBitableSyncState = { selectionKey: selectionKey, operationId: '', inFlight: null };
  }
  if (!feishuBitableSyncState.operationId) {
    feishuBitableSyncState.operationId = createFeishuBitableOperationId();
  }
  return feishuBitableSyncState;
}
async function pushToFeishu() {
  var status = document.getElementById('feishuStatus');
  var ids = getSelectedInfIds();
  if (!ids.length) {
    if (status) status.innerHTML = '<span style="color:#d94641">Select influencers in Tab 1 first</span>';
    toast('Select influencers first', 'error');
    return;
  }
  var campaignId = getM4CampaignId();
  var syncState = feishuBitableSyncStateFor(ids, campaignId);
  if (syncState.inFlight) return syncState.inFlight;
  if (status) status.innerHTML = '<span>Syncing selected influencers...</span>';
  syncState.inFlight = (async function() {
    try {
      var r = await apiFetch('/influencers/feishu/sync', {
        method: 'POST',
        headers: { 'Idempotency-Key': syncState.operationId },
        body: JSON.stringify(campaignId === null ? { ids: ids } : { ids: ids, campaign_id: campaignId })
      });
      var d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Feishu sync failed');
      if (d.configured === false) {
        dlFile('feishu_influencers_fallback.csv', d.csv || '', 'text/csv;charset=utf-8');
        if (status) status.innerHTML = '<span style="color:#d49900">' + esc(d.message || 'CSV fallback downloaded.') + '</span>';
        toast('Feishu fallback CSV downloaded');
        syncState.operationId = '';
        return;
      }
      if (d.code === 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED') {
        if (status) status.innerHTML = '<span style="color:#d49900">Feishu delivery requires reconciliation before another write is attempted.</span>';
        toast('Feishu delivery requires reconciliation');
        return;
      }
      if (status) status.innerHTML = '<span style="color:#0f7b3c">Synced ' + (d.synced || d.records || ids.length) + ' influencers to Feishu</span>';
      toast('Synced to Feishu');
      syncState.operationId = '';
    } catch (e) {
      if (status) status.innerHTML = '<span style="color:#d94641">' + esc(e.message) + '</span>';
      toast(e.message, 'error');
    } finally {
      syncState.inFlight = null;
      loadFeishuStatus();
      loadFeishuOutbox();
    }
  })();
  return syncState.inFlight;
}
var pendingCollabInfId = null;
var pendingCollabCreateIntentId = null;
var pendingSettlementCollabId = null;
var m4CollabMutationOperations = {};
var m4CollabMutationInFlight = {};
function findInfluencerById(infId) {
  var id = Number(infId);
  return (lastInfAPI || lastMatch || []).find(function(inf) { return Number(inf.id) === id; }) || {};
}
function findCollaborationById(collabId) {
  var id = Number(collabId);
  return (lastCollabRows || []).find(function(collaboration) {
    return Number(collaboration.id) === id;
  }) || null;
}
function m4OperationId(prefix) {
  return createDemandAnalysisOperationId(prefix || 'm4-collaboration-');
}
function m4MutationHeaders(prefix, idempotencyKey) {
  var operationPrefix = prefix || 'm4-collaboration-';
  return {
    'Idempotency-Key': idempotencyKey || m4OperationId(operationPrefix),
    'X-Request-Id': m4OperationId(operationPrefix + 'request-')
  };
}
function m4CollabMutationSlot(collab, patch, action) {
  var stablePatch = {};
  Object.keys(patch || {}).sort().forEach(function(key) { stablePatch[key] = patch[key]; });
  return [
    Number(collab && collab.id) || 0,
    Number(collab && collab.campaign_id) || 0,
    Number(collab && collab.row_version) || 0,
    String(action || 'update'),
    JSON.stringify(stablePatch)
  ].join(':');
}
function m4CollabCreateMutationSlot(campaignId, body) {
  if (!pendingCollabCreateIntentId) pendingCollabCreateIntentId = m4OperationId('m4-collaboration-create-intent-');
  var stableBody = {};
  Object.keys(body || {}).sort().forEach(function(key) { stableBody[key] = body[key]; });
  return [
    'create',
    String(pendingCollabCreateIntentId),
    Number(campaignId) || 0,
    JSON.stringify(stableBody)
  ].join(':');
}
function m4CollabMutationOperationKey(slot, prefix) {
  if (!m4CollabMutationOperations[slot]) {
    m4CollabMutationOperations[slot] = m4OperationId(prefix || 'm4-collaboration-update-');
  }
  return m4CollabMutationOperations[slot];
}
function m4OrderCampaignText(campaignId) {
  var campaign = getM4CampaignById(campaignId);
  return campaign ? m4CampaignLabel(campaign) : '活动 #' + campaignId;
}
function startCollab(infId) {
  pendingCollabInfId = Number(infId);
  pendingCollabCreateIntentId = m4OperationId('m4-collaboration-create-intent-');
  var inf = findInfluencerById(infId);
  var campaignId = getM4CampaignId();
  var campaignContext = campaignId === null
    ? '未关联活动：本次会创建独立合作记录。'
    : '已关联 ' + m4OrderCampaignText(campaignId) + '：订单会进入活动审计和知识库。';
  var opener = document.activeElement;
  var existing = document.getElementById('collabOrderModal');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'collabOrderModal';
  overlay.className = 'modal-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) closeCollabOrderModal(); };
  overlay.innerHTML = '<div class="modal" id="collabOrderDialog" role="dialog" aria-modal="true" aria-labelledby="collabOrderDialogTitle" onclick="event.stopPropagation()">' +
    '<button type="button" class="modal-close" aria-label="关闭下单合作资源" title="关闭下单合作资源" onclick="closeCollabOrderModal()">&times;</button>' +
    '<h3 id="collabOrderDialogTitle">下单合作资源</h3>' +
    '<p style="font-size:12px;opacity:.6;margin-bottom:8px">' + esc(inf.kol_handle || '') + ' / ' + esc(inf.platform || '') + '</p>' +
    '<div style="font-size:11px;padding:8px 10px;background:var(--surface2);border-radius:var(--radius-sm);margin-bottom:12px">' + esc(campaignContext) + '</div>' +
    '<div class="grid grid-2">' +
    '<div><label>项目</label><input id="orderProject" value="' + esc(inf.project_name || '') + '"></div>' +
    '<div><label>推广产品</label><input id="orderProduct" value="' + esc(inf.product_name || '') + '"></div>' +
    '<div><label>资源类型</label><select id="orderType"><option value="paid">付费合作</option><option value="affiliate">联盟分佣</option><option value="gifting">寄样置换</option><option value="retainer">长期合作</option></select></div>' +
    '<div><label>合同 / PO 编号</label><input id="orderReference" placeholder="可选"></div>' +
    '<div><label>对外报价（整数）</label><input id="orderQuotedPrice" type="number" min="0" step="1" value="' + esc(inf.quoted_price || inf.cost_usd || '') + '"></div>' +
    '<div><label>初始状态</label><div style="padding:8px 0;font-size:12px">已确认下单</div></div>' +
    '<div><label>开始时间</label><input id="orderTimelineStart" type="date"></div>' +
    '<div><label>结束时间</label><input id="orderTimelineEnd" type="date"></div>' +
    '</div>' +
    '<div style="margin-top:10px"><label>交付物</label><textarea id="orderDeliverable" rows="3">' + esc(inf.content_deliverable || inf.collab_type || '') + '</textarea></div>' +
    '<div style="margin-top:10px"><label>备注</label><textarea id="orderNotes" rows="3"></textarea></div>' +
    '<div class="btn-group" style="justify-content:flex-end"><button type="button" class="btn btn-outline" onclick="closeCollabOrderModal()">取消</button><button type="button" class="btn btn-primary" onclick="submitCollabOrder()">确认下单</button></div>' +
    '</div>';
  document.body.appendChild(overlay);
  if (window.TMAccessibility) {
    window.TMAccessibility.openDialog(document.getElementById('collabOrderDialog'), opener, function() {
      closeCollabOrderModal(overlay);
    });
  }
}
function closeCollabOrderModal(targetOverlay) {
  var overlay = targetOverlay && targetOverlay.nodeType === 1 ? targetOverlay : document.getElementById('collabOrderModal');
  var dialog = overlay ? overlay.querySelector('#collabOrderDialog') : document.getElementById('collabOrderDialog');
  if (dialog && window.TMAccessibility) window.TMAccessibility.closeDialog(dialog);
  if (overlay) overlay.remove();
  pendingCollabInfId = null;
  pendingCollabCreateIntentId = null;
}
function m4ActiveDemandId(campaignId) {
  if (readPositiveInteger(getActiveCampaignId()) !== campaignId || typeof getActiveDemandId !== 'function') return null;
  return readPositiveInteger(getActiveDemandId());
}
async function submitCollabOrder() {
  if (!pendingCollabInfId) return;
  var campaignId = getM4CampaignId();
  var resource = {
    schema: 'turingmarket.collaboration-order.v1',
    project_name: document.getElementById('orderProject')?.value || '',
    product_name: document.getElementById('orderProduct')?.value || '',
    order_type: document.getElementById('orderType')?.value || 'paid',
    order_reference: document.getElementById('orderReference')?.value || '',
    deliverable: document.getElementById('orderDeliverable')?.value || '',
    quoted_price: Number(document.getElementById('orderQuotedPrice')?.value || 0)
  };
  if (!Number.isSafeInteger(resource.quoted_price) || resource.quoted_price < 0) {
    toast('对外报价必须是非负整数。', 'error');
    return;
  }
  var body = {
    influencer_id: pendingCollabInfId,
    status: 'confirmed',
    cost_quoted: resource.quoted_price,
    timeline_start: document.getElementById('orderTimelineStart')?.value || '',
    timeline_end: document.getElementById('orderTimelineEnd')?.value || '',
    notes: document.getElementById('orderNotes')?.value || ''
  };
  var options = { method: 'POST' };
  var createMutationSlot = null;
  var createIntentId = pendingCollabCreateIntentId;
  if (campaignId === null) {
    body.resource = resource;
  } else {
    body.campaign_id = campaignId;
    body.resource = resource;
    var demandId = m4ActiveDemandId(campaignId);
    if (demandId !== null) body.demand_id = demandId;
    createMutationSlot = m4CollabCreateMutationSlot(campaignId, body);
    createIntentId = pendingCollabCreateIntentId;
    if (m4CollabMutationInFlight[createMutationSlot]) {
      toast('活动订单正在创建，请勿重复点击。');
      return m4CollabMutationInFlight[createMutationSlot];
    }
    options.headers = m4MutationHeaders('m4-collaboration-create-', m4CollabMutationOperationKey(createMutationSlot, 'm4-collaboration-create-'));
  }
  options.body = JSON.stringify(body);
  var request = Promise.resolve().then(function() { return apiFetch('/collaborations', options); });
  if (createMutationSlot) m4CollabMutationInFlight[createMutationSlot] = request;
  try {
    var r = await request;
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Order failed');
    if (createIntentId && pendingCollabCreateIntentId !== createIntentId) return d;
    closeCollabOrderModal();
    toast((campaignId === null ? '独立合作记录已创建 #' : '活动订单已创建 #') + d.id);
    switchTab('tab2');
    loadCollaborations();
  } catch (e) {
    if (createIntentId && pendingCollabCreateIntentId !== createIntentId) return;
    toast(e.message, 'error');
  } finally {
    if (createMutationSlot && m4CollabMutationInFlight[createMutationSlot] === request) delete m4CollabMutationInFlight[createMutationSlot];
  }
}
var STATUS_LABELS = { proposed: '待提案', contacted: '已建联', negotiating: '谈判中', confirmed: '已确认', contract_sent: '合同已发', live: '执行中', content_review: '内容审核', completed: '已完成', cancelled: '已取消' };
var COLLAB_RELATION_LABELS = { order: '下单', execution: '执行', publication: '发布', settlement: '结算' };
var COLLAB_ORDER_TYPE_LABELS = { paid: '付费合作', affiliate: '联盟分佣', gifting: '寄样置换', retainer: '长期合作' };
async function loadCollaborations(status) {
  var filterEl = document.getElementById('collabFilter');
  var selectedStatus = status || (filterEl ? filterEl.value : '');
  var campaignId = getM4CampaignId();
  try {
    var query = ['include_campaign_context=1'];
    if (selectedStatus) query.push('status=' + encodeURIComponent(selectedStatus));
    if (campaignId !== null) query.push('campaign_id=' + encodeURIComponent(campaignId));
    var r = await apiFetch('/collaborations' + (query.length ? '?' + query.join('&') : ''));
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Load collaborations failed');
    var rows = Array.isArray(d.collaborations) ? d.collaborations : [];
    lastCollabRows = rows;
    renderCollabTable(rows);
    var stats = document.getElementById('collabStatsBar');
    if (stats) {
      var counts = {};
      rows.forEach(function(row) { counts[row.status] = (counts[row.status] || 0) + 1; });
      stats.innerHTML = Object.keys(counts).map(function(key) {
        return '<span style="font-size:11px;background:var(--surface2);padding:4px 10px;border-radius:20px">' + esc(STATUS_LABELS[key] || key) + ': <strong>' + counts[key] + '</strong></span>';
      }).join('');
    }
  } catch (e) {
    lastCollabRows = [];
    var c = document.getElementById('execTableContainer');
    if (c) c.innerHTML = '<p style="text-align:center;padding:30px;opacity:.5">Load failed: ' + esc(e.message) + '</p>';
  }
}
function collabResource(collab) {
  try { return collab.proposal_notes ? JSON.parse(collab.proposal_notes) : {}; } catch (e) { return {}; }
}
function collabRelations(collab) {
  return Array.isArray(collab && collab.active_relations) ? collab.active_relations : [];
}
function isCampaignCollaboration(collab) {
  return readPositiveInteger(collab && collab.campaign_id) !== null;
}
function renderCollabRelationTags(collab) {
  var relations = collabRelations(collab);
  if (!relations.length) return '<span style="font-size:10px;opacity:.55">未关联</span>';
  return relations.map(function(relation) {
    return '<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 6px;border:1px solid var(--border);border-radius:999px;font-size:10px">' + esc(COLLAB_RELATION_LABELS[relation] || relation) + '</span>';
  }).join('');
}
function renderCampaignCollabActions(collab) {
  var relationSet = {};
  collabRelations(collab).forEach(function(relation) { relationSet[relation] = true; });
  var actions = [];
  if (collab.status === 'confirmed') {
    actions.push('<button type="button" class="btn btn-sm" onclick="runCampaignCollabAction(' + collab.id + ',\'contract\')">合同已发</button>');
    actions.push('<button type="button" class="btn btn-sm btn-primary" onclick="runCampaignCollabAction(' + collab.id + ',\'execution\')">开始执行</button>');
  } else if (collab.status === 'contract_sent') {
    actions.push('<button type="button" class="btn btn-sm btn-primary" onclick="runCampaignCollabAction(' + collab.id + ',\'execution\')">开始执行</button>');
  } else if (collab.status === 'live') {
    actions.push('<button type="button" class="btn btn-sm btn-primary" onclick="runCampaignCollabAction(' + collab.id + ',\'review\')">进入内容审核</button>');
  } else if (collab.status === 'content_review') {
    actions.push('<button type="button" class="btn btn-sm btn-primary" onclick="runCampaignCollabAction(' + collab.id + ',\'publication\')">确认发布</button>');
  } else if (collab.status === 'completed' && relationSet.execution && !relationSet.publication) {
    actions.push('<button type="button" class="btn btn-sm btn-primary" onclick="runCampaignCollabAction(' + collab.id + ',\'publication\')">确认发布</button>');
  } else if (collab.status === 'completed' && relationSet.publication && !relationSet.settlement) {
    actions.push('<button type="button" class="btn btn-sm btn-primary" onclick="runCampaignCollabAction(' + collab.id + ',\'settlement\')">确认结算</button>');
  }
  return actions.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap">' + actions.join('') + '</div>' : '<span style="font-size:11px;opacity:.55">无需操作</span>';
}
function renderCollabTable(data) {
  var c = document.getElementById('execTableContainer');
  if (!c) return;
  if (!data || !data.length) { c.innerHTML = '<p style="text-align:center;padding:30px;opacity:.5">暂无合作记录</p>'; return; }
  var h = '<table class="m4-table"><thead><tr><th>KOL</th><th>活动 / 项目</th><th>合作资源</th><th>执行状态</th><th>阶段证据</th><th>报价</th><th>排期</th><th>合同 / PO</th><th>备注</th><th>操作</th></tr></thead><tbody>';
  data.forEach(function(collab) {
    var resource = collabResource(collab);
    var project = resource.project_name || collab.project_name || '-';
    var product = resource.product_name || collab.product_name || '-';
    var deliverable = resource.deliverable || collab.content_deliverable || '-';
    var resourceType = COLLAB_ORDER_TYPE_LABELS[resource.order_type] || resource.order_type || '未定义';
    var linked = isCampaignCollaboration(collab);
    var campaignText = linked ? (collab.campaign_name || ('活动 #' + collab.campaign_id)) : '独立合作记录';
    h += '<tr><td><strong>' + esc(collab.kol_handle || '') + '</strong><br><span style="font-size:10px;opacity:.55">' + esc(collab.platform || '') + ' / ' + fmtCount(collab.followers) + '</span></td>';
    h += '<td><strong>' + esc(campaignText) + '</strong><br><span style="font-size:10px;opacity:.6">' + esc(project) + ' / ' + esc(product) + '</span></td>';
    h += '<td style="min-width:180px"><strong>' + esc(resourceType) + '</strong><br><span style="font-size:10px;opacity:.6">' + esc(deliverable) + '</span></td>';
    if (linked) {
      h += '<td><strong>' + esc(STATUS_LABELS[collab.status] || collab.status || '-') + '</strong><br><span style="font-size:10px;opacity:.55">版本 ' + esc(collab.row_version || '-') + '</span></td>';
    } else {
      h += '<td><select id="st_' + collab.id + '" onchange="updateCollabStatus(' + collab.id + ')" style="width:auto;font-size:11px">';
      Object.keys(STATUS_LABELS).forEach(function(key) { h += '<option value="' + key + '"' + (collab.status === key ? ' selected' : '') + '>' + STATUS_LABELS[key] + '</option>'; });
      h += '</select></td>';
    }
    h += '<td style="min-width:160px">' + (linked ? renderCollabRelationTags(collab) : '<span style="font-size:10px;opacity:.55">未接入活动</span>') + '</td>';
    h += '<td>$' + (collab.cost_quoted || resource.quoted_price || 0) + '</td>';
    h += '<td style="font-size:10px">' + esc([collab.timeline_start || '', collab.timeline_end || ''].filter(Boolean).join(' -> ') || '-') + '</td>';
    h += '<td style="max-width:140px;font-size:10px">' + esc(resource.order_reference || '-') + '</td>';
    h += '<td style="max-width:140px;font-size:10px">' + esc(collab.notes || '-') + '</td>';
    h += '<td style="min-width:150px">' + (linked ? renderCampaignCollabActions(collab) : '<button type="button" class="btn btn-sm" onclick="updateCollabStatus(' + collab.id + ')">保存</button>') + '</td></tr>';
  });
  h += '</tbody></table>';
  c.innerHTML = h;
}
async function updateCollabStatus(collabId) {
  var collab = findCollaborationById(collabId);
  if (isCampaignCollaboration(collab)) {
    toast('活动订单请使用右侧的阶段操作，系统会保留审计和知识证据。', 'error');
    return;
  }
  var sel = document.getElementById('st_' + collabId);
  if (!sel) return;
  try {
    var r = await apiFetch('/collaborations/' + collabId, { method: 'PUT', body: JSON.stringify({ status: sel.value }) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Status update failed');
    toast('Status updated');
    loadCollaborations();
  } catch (e) {
    toast(e.message, 'error');
  }
}
async function submitCampaignCollabUpdate(collab, patch, action) {
  var campaignId = readPositiveInteger(collab && collab.campaign_id);
  var expectedVersion = readPositiveInteger(collab && collab.row_version);
  if (campaignId === null || expectedVersion === null) throw new Error('活动订单缺少版本上下文，请刷新后重试。');
  var body = Object.assign({
    campaign_id: campaignId,
    expected_version: expectedVersion
  }, patch || {});
  var mutationSlot = m4CollabMutationSlot(collab, patch, action);
  if (m4CollabMutationInFlight[mutationSlot]) return m4CollabMutationInFlight[mutationSlot];
  var request = Promise.resolve().then(function() {
    return apiFetch('/collaborations/' + collab.id, {
      method: 'PUT',
      headers: m4MutationHeaders('m4-collaboration-update-', m4CollabMutationOperationKey(mutationSlot)),
      body: JSON.stringify(body)
    });
  }).then(async function(response) {
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || '活动订单更新失败');
    return data;
  });
  m4CollabMutationInFlight[mutationSlot] = request;
  try {
    return await request;
  } finally {
    if (m4CollabMutationInFlight[mutationSlot] === request) delete m4CollabMutationInFlight[mutationSlot];
  }
}
async function runCampaignCollabAction(collabId, action) {
  var collab = findCollaborationById(collabId);
  if (!isCampaignCollaboration(collab)) {
    toast('请先刷新活动订单。', 'error');
    return;
  }
  if (action === 'settlement') {
    openCampaignSettlementModal(collab);
    return;
  }
  var actions = {
    contract: { status: 'contract_sent', reason: '从下单工作台确认合同已发' },
    execution: { status: 'live', campaign_relation: 'execution', reason: '从下单工作台确认开始执行' },
    review: { status: 'content_review', reason: '从下单工作台提交内容审核' },
    publication: { status: 'completed', campaign_relation: 'publication', reason: '从下单工作台确认内容发布' }
  };
  var patch = actions[action];
  if (!patch) return;
  var mutationSlot = m4CollabMutationSlot(collab, patch, action);
  if (m4CollabMutationInFlight[mutationSlot]) {
    toast('操作正在提交，请勿重复点击。');
    return m4CollabMutationInFlight[mutationSlot];
  }
  try {
    await submitCampaignCollabUpdate(collab, patch, action);
    toast('活动订单已更新');
    loadCollaborations();
  } catch (error) {
    toast(error.message, 'error');
    loadCollaborations();
  }
}
function openCampaignSettlementModal(collab) {
  pendingSettlementCollabId = Number(collab.id);
  var existing = document.getElementById('campaignSettlementModal');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'campaignSettlementModal';
  overlay.className = 'modal-overlay';
  overlay.onclick = function(event) { if (event.target === overlay) closeCampaignSettlementModal(); };
  var initialCost = collab.cost_actual || collab.cost_quoted || 0;
  overlay.innerHTML = '<div class="modal" id="campaignSettlementDialog" role="dialog" aria-modal="true" aria-labelledby="campaignSettlementDialogTitle" onclick="event.stopPropagation()">' +
    '<button type="button" class="modal-close" aria-label="关闭结算确认" title="关闭结算确认" onclick="closeCampaignSettlementModal()">&times;</button>' +
    '<h3 id="campaignSettlementDialogTitle">确认结算</h3>' +
    '<p style="font-size:12px;opacity:.65;margin-bottom:12px">' + esc(collab.kol_handle || '') + ' · ' + esc(collab.campaign_name || ('活动 #' + collab.campaign_id)) + '</p>' +
    '<div><label>实际结算成本（整数）</label><input id="settlementActualCost" type="number" min="0" step="1" value="' + esc(initialCost) + '"></div>' +
    '<label style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size:12px;text-transform:none;letter-spacing:0;opacity:1"><input id="settlementCostConfirmed" type="checkbox" style="width:16px;height:16px;min-width:16px">我已核对并确认实际结算成本</label>' +
    '<div class="btn-group" style="justify-content:flex-end"><button type="button" class="btn btn-outline" onclick="closeCampaignSettlementModal()">取消</button><button type="button" class="btn btn-primary" onclick="submitCampaignSettlement()">确认结算</button></div>' +
    '</div>';
  document.body.appendChild(overlay);
  if (window.TMAccessibility) window.TMAccessibility.openDialog(document.getElementById('campaignSettlementDialog'), document.activeElement, closeCampaignSettlementModal);
}
function closeCampaignSettlementModal() {
  var overlay = document.getElementById('campaignSettlementModal');
  var dialog = overlay ? overlay.querySelector('#campaignSettlementDialog') : null;
  if (dialog && window.TMAccessibility) window.TMAccessibility.closeDialog(dialog);
  if (overlay) overlay.remove();
  pendingSettlementCollabId = null;
}
async function submitCampaignSettlement() {
  var collab = findCollaborationById(pendingSettlementCollabId);
  var cost = Number(document.getElementById('settlementActualCost')?.value);
  var confirmed = document.getElementById('settlementCostConfirmed')?.checked === true;
  if (!Number.isSafeInteger(cost) || cost < 0) {
    toast('实际结算成本必须是非负整数。', 'error');
    return;
  }
  if (!confirmed) {
    toast('请先确认实际结算成本。', 'error');
    return;
  }
  if (!isCampaignCollaboration(collab)) {
    toast('活动订单已变化，请刷新后重试。', 'error');
    return;
  }
  var patch = {
    status: 'completed',
    campaign_relation: 'settlement',
    cost_actual: cost,
    confirm_cost_actual: true,
    reason: '从下单工作台确认结算成本'
  };
  var mutationSlot = m4CollabMutationSlot(collab, patch, 'settlement');
  if (m4CollabMutationInFlight[mutationSlot]) {
    toast('结算正在提交，请勿重复点击。');
    return;
  }
  try {
    await submitCampaignCollabUpdate(collab, patch, 'settlement');
    closeCampaignSettlementModal();
    toast('活动订单已完成结算');
    loadCollaborations();
  } catch (error) {
    toast(error.message, 'error');
    loadCollaborations();
  }
}
// ===== M5: AI ASSISTANT (v8.0) =====
var aiMemory = {};
try { aiMemory = JSON.parse(localStorage.getItem('tm_ai_memory') || '{}'); } catch(e) { aiMemory = {}; }
function saveAIMemory() { localStorage.setItem('tm_ai_memory', JSON.stringify(aiMemory)); }
function renderAIReferenceText(data) {
  var lines = [];
  var refs = (data && data.knowledge_references) || [];
  var web = (data && data.web_results) || [];
  if (refs.length) {
    lines.push('', '知识库引用:');
    refs.slice(0, 5).forEach(function(ref, idx) {
      lines.push((idx + 1) + '. ' + (ref.title || ('知识条目 #' + ref.id)));
    });
  }
  if (web.length) {
    lines.push('', '联网来源:');
    web.slice(0, 3).forEach(function(item, idx) {
      var cacheLabel = item.cached === true ? '（缓存）' : '';
      lines.push((idx + 1) + '. ' + cacheLabel + (item.title || item.url || 'Web source') + (item.url ? ' - ' + item.url : ''));
    });
  }
  if (data && data.summary_promotion && data.summary_promotion.status === 'promoted') {
    lines.push('', '知识沉淀：已自动沉淀为可复用知识');
  }
  return lines.length ? '\n\n' + lines.join('\n') : '';
}
function aiChatFingerprint(payload) {
  payload = payload && typeof payload === 'object' ? payload : {};
  var knowledgeIds = Array.isArray(payload.knowledge_entry_ids)
    ? payload.knowledge_entry_ids.map(readPositiveInteger).filter(function(id) { return id !== null; })
    : [];
  return JSON.stringify({
    auth_generation: AUTH_GENERATION,
    campaign_id: readPositiveInteger(payload.campaign_id),
    conversation_id: readPositiveInteger(payload.conversation_id),
    message: String(payload.message || ''),
    allow_web: payload.allow_web === true,
    knowledge_entry_ids: knowledgeIds
  });
}
function prepareAiChatRequest(payload) {
  var fingerprint = aiChatFingerprint(payload);
  var campaignId = readPositiveInteger(payload && payload.campaign_id);
  if (
    campaignId !== null &&
    (aiChatIdempotencyFingerprint !== fingerprint || !aiChatIdempotencyKey)
  ) {
    aiChatIdempotencyFingerprint = fingerprint;
    aiChatIdempotencyKey = createAiChatIdempotencyKey();
  }
  var headers = {
    'X-Request-Id': createDemandAnalysisOperationId('ai-chat-request-')
  };
  if (campaignId !== null) headers['Idempotency-Key'] = aiChatIdempotencyKey;
  return {
    fingerprint: fingerprint,
    idempotencyKey: campaignId === null ? '' : aiChatIdempotencyKey,
    requestId: headers['X-Request-Id'],
    headers: headers
  };
}
function setAiChatControlsBusy(busy) {
  var input = document.getElementById('chatInput');
  var button = document.querySelector('#page-m5 .chat-input-area button');
  if (input) input.disabled = !!busy;
  if (button) button.disabled = !!busy;
}
function beginAiChatRequest(prepared, payload) {
  if (activeAiChatRequest) return null;
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var requestContext = {
    generation: ++aiChatRequestSequence,
    authGeneration: AUTH_GENERATION,
    campaignId: readPositiveInteger(payload && payload.campaign_id),
    conversationId: readPositiveInteger(payload && payload.conversation_id),
    fingerprint: prepared.fingerprint,
    idempotencyKey: prepared.idempotencyKey,
    invalidated: false,
    abortController: controller,
    pendingNode: null,
    promise: null
  };
  activeAiChatRequest = requestContext;
  setAiChatControlsBusy(true);
  return requestContext;
}
function isAiChatRequestCurrent(requestContext) {
  if (
    !requestContext ||
    activeAiChatRequest !== requestContext ||
    requestContext.invalidated ||
    requestContext.generation !== aiChatRequestSequence ||
    requestContext.authGeneration !== AUTH_GENERATION
  ) return false;
  if (readPositiveInteger(getActiveCampaignId()) !== requestContext.campaignId) return false;
  return readPositiveInteger(currentAIConversationId) === requestContext.conversationId;
}
function invalidateAiChatRequests() {
  aiChatRequestSequence += 1;
  aiChatIdempotencyFingerprint = '';
  aiChatIdempotencyKey = '';
  if (activeAiChatRequest) {
    activeAiChatRequest.invalidated = true;
    if (activeAiChatRequest.abortController) activeAiChatRequest.abortController.abort();
    if (activeAiChatRequest.pendingNode && typeof activeAiChatRequest.pendingNode.remove === 'function') {
      activeAiChatRequest.pendingNode.remove();
    }
    activeAiChatRequest = null;
  }
  setAiChatControlsBusy(false);
}
function finishAiChatRequest(requestContext, rotateReplayKey) {
  if (
    rotateReplayKey &&
    aiChatIdempotencyFingerprint === requestContext.fingerprint &&
    aiChatIdempotencyKey === requestContext.idempotencyKey
  ) {
    aiChatIdempotencyFingerprint = '';
    aiChatIdempotencyKey = '';
  }
  requestContext.pendingNode = null;
  if (activeAiChatRequest === requestContext) {
    activeAiChatRequest = null;
    setAiChatControlsBusy(false);
  }
}
function renderAiChatError(target, message) {
  if (!target) return;
  target.innerHTML = '';
  var bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.color = '#f44336';
  bubble.textContent = 'Error: ' + String(message || 'AI request failed');
  target.appendChild(bubble);
}
async function promoteAIMessage(conversationId, messageId, button) {
  conversationId = readPositiveInteger(conversationId);
  messageId = readPositiveInteger(messageId);
  if (conversationId === null || messageId === null || !button || button.disabled) return null;
  var originalText = button.textContent;
  button.disabled = true;
  button.textContent = '沉淀中...';
  try {
    var response = await apiFetch(
      '/ai/conversations/' + conversationId + '/messages/' + messageId + '/promote',
      {
        method: 'POST',
        headers: { 'X-Request-Id': createDemandAnalysisOperationId('ai-promotion-request-') },
        body: JSON.stringify({ visibility: 'private' })
      }
    );
    var data = await response.json().catch(function() { return null; });
    if (!response.ok) {
      throw new Error((data && (data.error || data.message)) || ('API:' + response.status));
    }
    if (readPositiveInteger(data && data.knowledge_entry_id) === null) {
      throw new Error('知识沉淀结果无效，请重试。');
    }
    button.textContent = '已沉淀';
    button.title = '该回复已归档到知识库';
    return data;
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    toast(error.message || '知识沉淀失败', 'error');
    return null;
  }
}
function sendChat() {
  if (activeAiChatRequest && activeAiChatRequest.promise) return activeAiChatRequest.promise;
  var inp = document.getElementById('chatInput');
  var msg = inp ? inp.value.trim() : '';
  if (!msg) return Promise.resolve(null);
  var campaignId = readPositiveInteger(getActiveCampaignId());
  var webToggle = document.getElementById('webSearchToggle');
  var chatPayload = {
    message: msg,
    conversation_id: readPositiveInteger(currentAIConversationId),
    allow_web: !!(webToggle && webToggle.checked),
    source_module: 'assistant',
    summary_visibility: 'private',
    knowledge_limit: 8,
    max_tokens: 2048
  };
  if (campaignId !== null) {
    chatPayload.campaign_id = campaignId;
    chatPayload.knowledge_entry_ids = getSelectedKnowledgeEntryIds();
  }
  var prepared = prepareAiChatRequest(chatPayload);
  var requestContext = beginAiChatRequest(prepared, chatPayload);
  if (!requestContext) return activeAiChatRequest ? activeAiChatRequest.promise : Promise.resolve(null);
  addChatMsg('user', msg);
  inp.value = '';
  var memId = 'm' + Date.now();
  aiMemory[memId] = msg;
  saveAIMemory();
  var msgs = document.getElementById('chatMessages');
  var td = document.createElement('div');
  td.className = 'chat-msg assistant';
  td.innerHTML = '<div class="bubble">Thinking...</div>';
  msgs.appendChild(td);
  msgs.scrollTop = msgs.scrollHeight;
  requestContext.pendingNode = td;
  var rotateReplayKey = false;
  var operation = (async function() {
    try {
      var chatOptions = {
        method: 'POST',
        headers: prepared.headers,
        body: JSON.stringify(chatPayload)
      };
      if (requestContext.abortController) chatOptions.signal = requestContext.abortController.signal;
      var response = await apiFetch('/ai/chat', chatOptions);
      var data = await response.json().catch(function() { return null; });
      if (!response.ok) {
        rotateReplayKey = true;
        throw new Error((data && (data.error || data.message)) || ('API:' + response.status));
      }
      if (!isAiChatRequestCurrent(requestContext)) {
        td.remove();
        return null;
      }
      rotateReplayKey = true;
      var responseConversationId = readPositiveInteger(data && data.conversation_id);
      if (responseConversationId === null) throw new Error('AI 会话响应无效，请重试。');
      if (
        requestContext.conversationId !== null &&
        responseConversationId !== requestContext.conversationId
      ) {
        throw new Error('AI 会话已切换，已忽略不匹配的回复。');
      }
      if (
        requestContext.campaignId !== null &&
        readPositiveInteger(data && data.campaign_id) !== requestContext.campaignId
      ) {
        throw new Error('Campaign 已切换，已忽略不匹配的 AI 回复。');
      }
      td.remove();
      requestContext.pendingNode = null;
      currentAIConversationId = responseConversationId;
      var reply = data.answer || 'No response.';
      chatHistory.push({role:'assistant', content: reply});
      aiMemory[memId + '_r'] = reply.substring(0, 500);
      saveAIMemory();
      addChatMsg('assistant', reply + renderAIReferenceText(data), {
        conversationId: responseConversationId,
        messageId: readPositiveInteger(data && data.message_id),
        archivedSummaryId: readPositiveInteger(data && data.archived_summary_id)
      });
      return data;
    } catch (e) {
      if (!isAiChatRequestCurrent(requestContext)) {
        td.remove();
        return null;
      }
      renderAiChatError(td, e.message);
      return null;
    } finally {
      finishAiChatRequest(requestContext, rotateReplayKey);
    }
  })();
  requestContext.promise = operation;
  return operation;
}
function addChatMsg(role, text, options) {
  var msgs = document.getElementById('chatMessages');
  if (!msgs) return;
  options = options || {};
  var div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  var bubble = document.createElement('div');
  bubble.className = 'bubble';
  var formatted = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  bubble.innerHTML = formatted;
  var conversationId = readPositiveInteger(options.conversationId);
  var messageId = readPositiveInteger(options.messageId);
  if (role === 'assistant' && conversationId !== null && messageId !== null) {
    var action = document.createElement('button');
    action.type = 'button';
    action.className = 'ai-promote-action';
    action.title = '将这条 AI 回复归档到个人知识库';
    if (readPositiveInteger(options.archivedSummaryId) !== null) {
      action.disabled = true;
      action.textContent = '已沉淀';
      action.title = '该回复已归档到知识库';
    } else {
      action.textContent = '沉淀到知识库';
      action.onclick = function() { promoteAIMessage(conversationId, messageId, action); };
    }
    bubble.appendChild(action);
  }
  div.appendChild(bubble);
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}
function clearChat() {
  invalidateAiChatRequests();
  document.getElementById('chatMessages').innerHTML = '<div class="chat-msg assistant"><div class="bubble">Chat cleared</div></div>';
  chatHistory = [{role:'system', content:'You are TuringMarket AI assistant.'}];
  currentAIConversationId = null;
}
function clearAIMemory() { if (!confirm('Clear memory?')) return; aiMemory = {}; saveAIMemory(); toast('Memory cleared'); }
// ===== ADMIN (v8.0) =====
function switchAdminTab(tab, options) { options = options || {}; if (!options.skipHistory && window.TMNavigation) { window.TMNavigation.navigate('admin', { substate: { tab: tab }, user: CURRENT_USER }); return; }
  ['overview','users','knowledge','ai-audit','tokens'].forEach(function(t) { var el = document.getElementById('admin-tab-' + t); if (el) el.style.display = t === tab ? 'block' : 'none'; });
  if (tab === 'overview') loadAdminDashboard();
  if (tab === 'users') loadAdminUsers();
  if (tab === 'knowledge') loadKnowledgeBase();
  if (tab === 'ai-audit') { loadAdminAIAuditUsers(); loadAdminAIAudit(); }
  if (tab === 'tokens') loadAdminTokens();
}
function loadAdminDashboard() {
  apiFetch('/admin/overview').then(function(r) { return r.json(); }).then(function(d) {
    var s = d.stats || d;
    setText('ad_totalCustomers', s.totalCustomers || 0);
    setText('ad_activeCustomers', s.activeCustomers || 0);
    setText('ad_pipelineValue', formatMoney((s.totalOpportunityValue || 0) + (s.customerOpportunityValue || 0)));
    setText('ad_taskRate', (s.taskCompletionRate || 0) + '%');
    setText('ad_totalUsers', s.totalUsers || 0);
    setText('ad_totalDemands', s.totalDemands || 0);
    setText('ad_aiArtifacts', s.aiArtifacts || 0);
    setText('ad_totalTokens', ((s.totalTokens || 0) / 1000).toFixed(0) + 'K');
    renderAdminStageChart('ad_customerStageChart', s.customerStages || [], CUST_STAGES);
    renderAdminStageChart('ad_opportunityStageChart', s.opportunityStages || [], {
      discovery: '需求分析', qualification: '资格确认', proposal: '方案报价', 'negotiation': '谈判中', won: '已赢单', lost: '已输单'
    });
    renderAdminTaskHealth(s);
    renderAdminKnowledgeHealth(s);
    renderAdminTeamPerformance(s.teamPerformance || []);
    renderAdminRecentActivity(s.recentActivity || []);
  }).catch(function(e) {});
}

function setText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatMoney(value) {
  value = Number(value || 0);
  if (value >= 1000000) return '¥' + (value / 1000000).toFixed(1) + 'M';
  if (value >= 1000) return '¥' + (value / 1000).toFixed(0) + 'K';
  return '¥' + value.toLocaleString();
}

function renderAdminStageChart(id, rows, labels) {
  var el = document.getElementById(id);
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<p style="opacity:.5;font-size:12px">暂无数据</p>'; return; }
  var max = Math.max.apply(null, rows.map(function(r) { return r.count || 0; })) || 1;
  el.innerHTML = rows.map(function(r) {
    var pct = Math.max(4, Math.round(((r.count || 0) / max) * 100));
    return '<div style="margin-bottom:10px">'
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><strong>' + esc(labels[r.stage] || r.stage || '未分类') + '</strong><span>' + (r.count || 0) + ' · ' + formatMoney(r.value || 0) + '</span></div>'
      + '<div style="height:8px;background:#f1f5f9;border-radius:999px;overflow:hidden"><div style="width:' + pct + '%;height:100%;background:#111827;border-radius:999px"></div></div>'
      + '</div>';
  }).join('');
}

function renderAdminTaskHealth(s) {
  var el = document.getElementById('ad_taskHealth');
  if (!el) return;
  var rows = [
    ['全部待办', s.totalTasks || 0],
    ['待处理', s.pendingTasks || 0],
    ['已完成', s.completedTasks || 0],
    ['已逾期', s.overdueTasks || 0]
  ];
  el.innerHTML = '<div class="grid grid-4" style="gap:8px;margin-bottom:12px">' + rows.map(function(r) {
    return '<div style="background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px"><div style="font-size:18px;font-weight:700">' + r[1] + '</div><div style="font-size:11px;opacity:.6">' + r[0] + '</div></div>';
  }).join('') + '</div><div style="font-size:12px;opacity:.7">完成率 ' + (s.taskCompletionRate || 0) + '%，逾期任务 ' + (s.overdueTasks || 0) + ' 个。</div>';
}

function renderAdminKnowledgeHealth(s) {
  var el = document.getElementById('ad_knowledgeHealth');
  if (!el) return;
  var typeRows = s.knowledgeByType || [];
  var typeHtml = typeRows.length ? typeRows.map(function(r) {
    return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;font-size:12px"><span>' + esc(r.entry_type || 'note') + '</span><strong>' + (r.count || 0) + '</strong></div>';
  }).join('') : '<p style="opacity:.5;font-size:12px">暂无知识库数据</p>';
  el.innerHTML = '<div class="grid grid-2" style="gap:8px;margin-bottom:12px">'
    + '<div style="background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px"><div style="font-size:20px;font-weight:700">' + (s.totalKnowledgeEntries || 0) + '</div><div style="font-size:11px;opacity:.6">知识条目</div></div>'
    + '<div style="background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px"><div style="font-size:20px;font-weight:700">' + (s.aiArtifacts || 0) + '</div><div style="font-size:11px;opacity:.6">AI策略/方案</div></div>'
    + '</div>' + typeHtml;
}

var knowledgeBaseLoadTimer = null;
function scheduleKnowledgeBaseLoad() {
  if (knowledgeBaseLoadTimer) clearTimeout(knowledgeBaseLoadTimer);
  knowledgeBaseLoadTimer = setTimeout(loadKnowledgeBase, 220);
}

function knowledgeGovernanceLabel(governance) {
  if (!governance) return '未治理';
  if (!governance.is_current) return '历史版本';
  if (!governance.is_retrievable && governance.quality_state === 'rejected') return '已拒绝';
  if (!governance.is_retrievable) return '已到期';
  return governance.quality_state === 'confirmed' ? '已确认' : '候选';
}

function renderKnowledgeGovernanceActions(entry) {
  var governance = entry && entry.governance;
  if (!governance) return '';
  var id = readPositiveInteger(entry.id);
  var version = readPositiveInteger(governance.governance_version);
  if (id === null || version === null) return '';
  var buttons = [];
  if (governance.is_current && governance.quality_state === 'candidate') {
    buttons.push('<button type="button" class="btn btn-xs" onclick="adminGovernKnowledge(' + id + ',\'confirm\',' + version + ')">确认</button>');
    buttons.push('<button type="button" class="btn btn-xs" onclick="adminGovernKnowledge(' + id + ',\'reject\',' + version + ')">拒绝</button>');
  } else if (governance.is_current && governance.quality_state === 'confirmed') {
    buttons.push('<button type="button" class="btn btn-xs" onclick="adminGovernKnowledge(' + id + ',\'reject\',' + version + ')">撤回</button>');
  }
  if (governance.is_current) {
    buttons.push('<button type="button" class="btn btn-xs" onclick="adminGovernKnowledge(' + id + ',\'set_retention\',' + version + ')">保留期</button>');
    buttons.push('<button type="button" class="btn btn-xs" onclick="adminGovernKnowledge(' + id + ',\'supersede\',' + version + ')">替代版本</button>');
  }
  return buttons.length
    ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' + buttons.join('') + '</div>'
    : '';
}

function loadKnowledgeBase() {
  var container = document.getElementById('kbEntries');
  if (!container) return Promise.resolve([]);
  var search = document.getElementById('kbSearch');
  var quality = document.getElementById('kbQualityFilter');
  var retention = document.getElementById('kbRetentionFilter');
  var params = ['include_inactive=1', 'limit=100'];
  if (search && search.value.trim()) params.push('q=' + encodeURIComponent(search.value.trim()));
  if (quality && quality.value) params.push('quality_state=' + encodeURIComponent(quality.value));
  if (retention && retention.value) params.push('retention_class=' + encodeURIComponent(retention.value));
  container.innerHTML = '<p style="font-size:12px;opacity:.55">正在加载...</p>';
  return apiFetch('/knowledge?' + params.join('&')).then(function(response) {
    if (!response.ok) throw new Error('知识库加载失败 (' + response.status + ')');
    return response.json();
  }).then(function(data) {
    var entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) {
      container.innerHTML = '<p style="font-size:12px;opacity:.55">暂无匹配知识</p>';
      return entries;
    }
    container.innerHTML = entries.map(function(entry) {
      var governance = entry.governance || null;
      var status = knowledgeGovernanceLabel(governance);
      var version = governance ? 'v' + (governance.version_no || 1) : 'v1';
      var retentionText = governance && governance.retention_class === 'scheduled'
        ? '保留至 ' + esc(governance.retain_until || '-')
        : '长期保留';
      var tags = Array.isArray(entry.tags) && entry.tags.length
        ? entry.tags.slice(0, 8).map(function(tag) { return '<span class="brand-chip">' + esc(tag) + '</span>'; }).join('')
        : '';
      return '<div style="padding:12px 0;border-bottom:1px solid #e5e7eb">'
        + '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">'
        + '<div style="min-width:0"><strong>' + esc(entry.title || '未命名知识') + '</strong>'
        + '<div style="font-size:11px;opacity:.58;margin-top:3px">#' + entry.id + ' · ' + esc(entry.entry_type || 'note') + ' · ' + esc(entry.source_type || 'manual') + '</div></div>'
        + '<div style="font-size:11px;white-space:nowrap"><span class="brand-chip dark">' + esc(status) + '</span> <span class="brand-chip">' + esc(version) + '</span></div>'
        + '</div>'
        + '<p style="font-size:12px;line-height:1.55;margin:8px 0 0;color:var(--text2)">' + esc(entry.summary || entry.snippet || '') + '</p>'
        + (tags ? '<div class="brand-chip-row" style="margin-top:7px">' + tags + '</div>' : '')
        + '<div style="font-size:11px;opacity:.58;margin-top:7px">' + esc(entry.visibility || 'private') + ' · ' + esc(retentionText) + ' · 引用 ' + (entry.usage_count || 0) + '</div>'
        + renderKnowledgeGovernanceActions(entry)
        + '</div>';
    }).join('');
    return entries;
  }).catch(function(error) {
    container.innerHTML = '<p style="font-size:12px;color:#b42318">' + esc(error.message || '知识库加载失败') + '</p>';
    return [];
  });
}

async function adminGovernKnowledge(entryId, action, expectedVersion) {
  entryId = readPositiveInteger(entryId);
  expectedVersion = readPositiveInteger(expectedVersion);
  if (entryId === null || expectedVersion === null) return;
  var payload = { action: action, expected_version: expectedVersion };
  if (action === 'supersede') {
    var replacement = prompt('输入已确认的新知识条目 ID');
    var replacementId = readPositiveInteger(replacement);
    if (replacementId === null) return;
    payload.replacement_entry_id = replacementId;
  }
  if (action === 'set_retention') {
    var date = prompt('输入到期日 YYYY-MM-DD；留空表示长期保留');
    if (date === null) return;
    date = date.trim();
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        toast('到期日格式应为 YYYY-MM-DD');
        return;
      }
      payload.retention_class = 'scheduled';
      payload.retain_until = date + ' 23:59:59';
    } else {
      payload.retention_class = 'protected';
    }
  }
  var defaultReason = {
    confirm: '管理员确认可复用知识',
    reject: '管理员撤回不可复用知识',
    supersede: '管理员建立知识替代版本',
    set_retention: '管理员调整知识保留策略'
  }[action] || '管理员知识治理';
  var reason = prompt('填写治理原因', defaultReason);
  if (reason === null || !reason.trim()) return;
  payload.reason = reason.trim();
  try {
    var response = await apiFetch('/admin/knowledge/' + entryId + '/governance', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || '知识治理失败');
    toast('知识治理已更新');
    await loadKnowledgeBase();
  } catch (error) {
    toast(error.message || '知识治理失败');
  }
}

function renderAdminTeamPerformance(rows) {
  var el = document.getElementById('ad_teamPerformance');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<p style="opacity:.5;font-size:12px">暂无团队数据</p>'; return; }
  el.innerHTML = '<table><thead><tr><th>成员</th><th>部门</th><th>客户</th><th>商机</th><th>金额</th></tr></thead><tbody>'
    + rows.map(function(r) {
      return '<tr><td><strong>' + esc(r.display_name || '-') + '</strong></td><td>' + esc(r.department || '-') + '</td><td>' + (r.customers || 0) + '</td><td>' + (r.opportunities || 0) + '</td><td>' + formatMoney(r.opportunity_value || 0) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function renderAdminRecentActivity(rows) {
  var el = document.getElementById('ad_recentActivity');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<p style="opacity:.5;font-size:12px">暂无活动</p>'; return; }
  el.innerHTML = rows.slice(0, 12).map(function(a) {
    return '<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #eee;font-size:12px"><span><strong>' + esc(a.display_name || '-') + '</strong> ' + esc(a.action || '-') + ' <span style="opacity:.55">' + esc(a.module || '') + '</span></span><span style="opacity:.5;white-space:nowrap">' + esc((a.created_at || '').substring(0, 16)) + '</span></div>';
  }).join('');
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
var adminAIAuditUsersPromise = null;
function loadAdminAIAuditUsers() {
  var select = document.getElementById('ad_aiAuditUser');
  if (!select) return Promise.resolve([]);
  if (adminAIAuditUsersPromise) return adminAIAuditUsersPromise;
  var request = apiFetch('/admin/users').then(function(r) {
    if (!r.ok) throw new Error('API:' + r.status);
    return r.json();
  }).then(function(d) {
    var selected = select.value;
    var users = d.users || [];
    select.innerHTML = '<option value="">全部用户</option>' + users.map(function(u) {
      var label = u.display_name || u.username || ('User #' + u.id);
      return '<option value="' + esc(u.id) + '">' + esc(label) + '</option>';
    }).join('');
    if (users.some(function(u) { return String(u.id) === String(selected); })) {
      select.value = selected;
    }
    return users;
  }).catch(function() {
    return [];
  });
  adminAIAuditUsersPromise = request;
  request.then(function() {
    if (adminAIAuditUsersPromise === request) adminAIAuditUsersPromise = null;
  });
  return request;
}
function buildAdminAIAuditQuery() {
  function value(id) {
    var element = document.getElementById(id);
    return element ? String(element.value || '').trim() : '';
  }
  var fields = [
    ['q', value('ad_aiAuditSearch')],
    ['user_id', value('ad_aiAuditUser')],
    ['source_module', value('ad_aiAuditModule')],
    ['date_from', value('ad_aiAuditDateFrom')],
    ['date_to', value('ad_aiAuditDateTo')],
    ['reference_type', value('ad_aiAuditReference')],
    ['archive_status', value('ad_aiAuditArchive')]
  ];
  var dateFrom = fields[3][1];
  var dateTo = fields[4][1];
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error('Start date must not be later than end date.');
  }
  var query = ['limit=100'];
  fields.forEach(function(field) {
    if (field[1]) query.push(field[0] + '=' + encodeURIComponent(field[1]));
  });
  return '?' + query.join('&');
}
function renderAdminAIReference(reference) {
  reference = reference || {};
  var type = reference.reference_type === 'web' ? 'Web' : 'Knowledge';
  var label = reference.title || reference.reference_id || (type === 'Web' ? 'Web source' : 'Knowledge entry');
  var prefix = '<span style="opacity:.65">' + type + ':</span> ';
  if (type === 'Web' && reference.url) {
    try {
      var parsed = new URL(String(reference.url));
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return prefix + '<a href="' + esc(parsed.href) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
      }
    } catch (error) {}
  }
  return prefix + esc(label);
}
function adminAIRunStatusLabel(status) {
  var labels = {
    succeeded: '成功',
    degraded: '降级',
    failed: '失败',
    mixed: '混合',
    incomplete: '未完成',
    unknown: '未知',
    empty: '无运行'
  };
  return labels[String(status || '')] || labels.unknown;
}
function adminAIRunNumber(value) {
  var parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
function adminAICostText(cost) {
  cost = cost || {};
  var status = String(cost.status || 'unavailable');
  if (status === 'empty') return '投影成本 -';
  if (status === 'unavailable' || status === 'overflow') return '投影成本不可用';
  var amount = cost.total_cost_nano_usd;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return '投影成本不可用';
  var dollars = (amount / 1000000000).toFixed(9).replace(/\.?0+$/, '');
  return (status === 'partial' ? '部分投影成本 ' : '投影成本 ') + '$' + (dollars || '0');
}
function adminAIRunSummaryText(summary) {
  summary = summary || {};
  var text = adminAIRunNumber(summary.run_count) + ' 次 · '
    + adminAIRunStatusLabel(summary.status) + ' · '
    + adminAIRunNumber(summary.total_tokens) + ' tokens';
  var latency = Number(summary.average_latency_ms);
  if (Number.isSafeInteger(latency) && latency >= 0) text += ' · ' + latency + ' ms';
  if (summary.cost_summary && typeof summary.cost_summary === 'object') {
    text += ' · ' + adminAICostText(summary.cost_summary);
  }
  return text;
}
function adminAIMessageMetaText(message) {
  message = message || {};
  var role = String(message.role || '');
  var run = role === 'assistant' && message.run && typeof message.run === 'object'
    ? message.run
    : null;
  if (!run) {
    var legacy = role;
    if (message.model) legacy += ' · ' + String(message.model);
    if (message.total_tokens) legacy += ' · tokens ' + adminAIRunNumber(message.total_tokens);
    return legacy;
  }
  var text = role + ' · ' + String(run.model || '-') + ' · '
    + adminAIRunStatusLabel(run.status) + ' · P '
    + adminAIRunNumber(run.prompt_tokens) + ' / C '
    + adminAIRunNumber(run.completion_tokens) + ' / T '
    + adminAIRunNumber(run.total_tokens);
  var latency = Number(run.latency_ms);
  if (Number.isSafeInteger(latency) && latency >= 0) text += ' · ' + latency + ' ms';
  if (run.cost_projection && typeof run.cost_projection === 'object') {
    text += ' · ' + adminAICostText(run.cost_projection);
  }
  return text;
}
function loadAdminAIAudit() {
  var list = document.getElementById('ad_aiAuditList');
  if (!list) return Promise.resolve([]);
  list.innerHTML = '<p style="opacity:.5;font-size:12px">正在加载对话...</p>';
  var qs;
  try {
    qs = buildAdminAIAuditQuery();
  } catch (error) {
    list.innerHTML = '<p style="color:#d94641;font-size:12px">' + esc(error.message) + '</p>';
    return Promise.resolve([]);
  }
  return apiFetch('/ai/conversations' + qs).then(function(r) {
    if (!r.ok) throw new Error('API:' + r.status);
    return r.json();
  }).then(function(d) {
    var rows = d.conversations || [];
    if (!rows.length) {
      list.innerHTML = '<p style="opacity:.5;font-size:12px">没有符合条件的 AI 对话。</p>';
      return rows;
    }
    list.innerHTML = '<table><thead style="position:sticky;top:0;z-index:1;background:#fff"><tr><th>时间</th><th>用户</th><th>模块</th><th>Campaign</th><th>标题</th><th>消息</th><th>运行</th><th>引用</th><th>归档</th><th>最后回复</th><th>操作</th></tr></thead><tbody>'
      + rows.map(function(c) {
        var campaign = c.campaign_id ? ('Campaign #' + c.campaign_id) : '-';
        var references = 'KB ' + (c.knowledge_reference_count || 0) + ' / Web ' + (c.web_reference_count || 0);
        var archive = c.archived_summary_id
          ? '<span style="color:#0f7b3c">Archived</span>'
          : '<span style="opacity:.55">Unarchived</span>';
        return '<tr>'
          + '<td style="white-space:nowrap">' + esc((c.activity_at || c.updated_at || c.created_at || '').substring(0, 16)) + '</td>'
          + '<td>' + esc(c.display_name || c.username || '-') + '</td>'
          + '<td>' + esc(c.source_module || '-') + '</td>'
          + '<td style="white-space:nowrap">' + esc(campaign) + '</td>'
          + '<td><strong>' + esc(c.title || '-') + '</strong></td>'
          + '<td>' + (c.message_count || 0) + '</td>'
          + '<td style="white-space:nowrap">' + esc(adminAIRunSummaryText(c.run_summary)) + '</td>'
          + '<td style="white-space:nowrap">' + esc(references) + '</td>'
          + '<td style="white-space:nowrap">' + archive + '</td>'
          + '<td style="max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(c.last_answer || '') + '</td>'
          + '<td><button class="btn btn-xs" onclick="loadAdminAIConversation(' + c.id + ')">查看</button></td>'
          + '</tr>';
      }).join('') + '</tbody></table>';
    return rows;
  }).catch(function(e) {
    list.innerHTML = '<p style="color:#d94641;font-size:12px">加载失败：' + esc(e.message) + '</p>';
    return [];
  });
}
function loadAdminAIConversation(id) {
  var detail = document.getElementById('ad_aiAuditDetail');
  if (!detail) return;
  detail.innerHTML = '<div style="background:#fafafa;border:1px solid #eee;border-radius:8px;padding:16px"><p style="opacity:.5;font-size:12px">正在加载详情...</p></div>';
  apiFetch('/ai/conversations/' + id).then(function(r) {
    if (!r.ok) throw new Error('API:' + r.status);
    return r.json();
  }).then(function(d) {
    var c = d.conversation || {};
    var messages = c.messages || [];
    var campaign = c.campaign_id ? ('Campaign #' + c.campaign_id) : 'No Campaign';
    var archive = c.archived_summary_id ? ('Archived #' + c.archived_summary_id) : 'Unarchived';
    var html = '<div style="background:#fafafa;border:1px solid #eee;border-radius:8px;padding:16px">'
      + '<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:10px"><div><strong>' + esc(c.title || ('Conversation #' + id)) + '</strong><div style="font-size:12px;opacity:.6">' + esc(c.display_name || c.username || '-') + ' / ' + esc(c.source_module || '-') + ' / ' + esc(campaign) + ' / ' + esc(archive) + ' / ' + esc(c.created_at || '') + '</div><div style="font-size:11px;opacity:.65;margin-top:4px">运行：' + esc(adminAIRunSummaryText(c.run_summary)) + '</div></div><button class="btn btn-xs" aria-label="关闭详情" title="关闭详情" onclick="document.getElementById(&quot;ad_aiAuditDetail&quot;).innerHTML=&quot;&quot;">&times;</button></div>';
    html += messages.map(function(m) {
      var refs = m.references || [];
      var refHtml = refs.length ? '<div style="margin-top:8px;font-size:11px">引用：' + refs.map(function(r) {
        return renderAdminAIReference(r);
      }).join(' | ') + '</div>' : '';
      return '<div style="padding:10px;border:1px solid #eee;border-radius:8px;background:#fff;margin-bottom:8px">'
        + '<div style="font-size:11px;opacity:.55;margin-bottom:4px">' + esc(adminAIMessageMetaText(m)) + '</div>'
        + '<div style="font-size:12px;line-height:1.7;white-space:pre-wrap">' + esc(m.content || '') + '</div>'
        + refHtml
        + '</div>';
    }).join('');
    html += '</div>';
    detail.innerHTML = html;
  }).catch(function(e) {
    detail.innerHTML = '<p style="color:#d94641;font-size:12px">加载失败：' + esc(e.message) + '</p>';
  });
}
function toggleUserActive(id, active) { apiFetch('/admin/users/'+id, {method:'PUT', body:JSON.stringify({is_active:active})}).then(function() { loadAdminUsers(); toast(active?'Activated':'Deactivated'); }).catch(function(e) { toast('Failed','error'); }); }
function adminResetPw(id) { apiFetch('/admin/users/reset-password/'+id, {method:'POST'}).then(function(r) { return r.json(); }).then(function(d) { toast(d.temporary_password ? ('Temporary password: ' + d.temporary_password) : (d.message || 'Password reset')); }).catch(function(e) { toast('Failed','error'); }); }
function adminCreateInvite() { apiFetch('/admin/invites', {method:'POST'}).then(function(r){return r.json();}).then(function(d) { var el = document.getElementById('ad_inviteResult'); if (el) el.textContent = 'Code: ' + d.code; toast('Invite: '+d.code); }).catch(function(e) { toast('Failed','error'); }); }


// ===== BRAND RELATIONSHIP FUNCTIONS =====
var _brandRelationCache = null;
function buildBrandRelationCache() {
  if (_brandRelationCache) return;
  _brandRelationCache = {};
  for (var j = 0; j < BRANDS.length; j++) {
    var brand = BRANDS[j];
    var tags = brand.industry_tags || [];
    var related = [], competitors = [];
    for (var k = 0; k < BRANDS.length; k++) {
      if (j === k) continue;
      var other = BRANDS[k];
      if (brand.relation_group && other.relation_group && brand.relation_group === other.relation_group) { related.push(k); continue; }
      var otherTags = other.industry_tags || [];
      var overlap = 0;
      for (var t2 = 0; t2 < tags.length; t2++) { if (otherTags.indexOf(tags[t2]) >= 0) overlap++; }
      if (overlap >= 2) competitors.push(k);
    }
    _brandRelationCache[brand.name] = { related: related.slice(0, 6), competitors: competitors.slice(0, 8) };
  }
}
function findRelatedBrands(brand) {
  if (!brand || !_brandRelationCache) return [];
  var cached = _brandRelationCache[brand.name];
  return cached ? cached.related.map(function(i) { return BRANDS[i]; }).filter(Boolean) : [];
}
function findCompetitorBrands(brand) {
  if (!brand || !_brandRelationCache) return [];
  var cached = _brandRelationCache[brand.name];
  return cached ? cached.competitors.map(function(i) { return BRANDS[i]; }).filter(Boolean) : [];
}
function showRelatedBrands(brandName) {
  var brand = BRANDS.find(function(b) { return b.name === brandName; });
  if (!brand) { toast('品牌未找到', 'error'); return; }
  var opener = document.activeElement;
  var related = findRelatedBrands(brand);
  var competitors = findCompetitorBrands(brand);
  var html = '<div style="padding:4px"><h4 id="brandRelationTitle" style="margin:0 0 12px 0">' + esc(brand.name) + ' - 品牌概览</h4>';
  html += '<div style="font-size:12px;margin-bottom:12px;padding:10px;background:#f9f9f8;border-radius:8px">';
  if (brand.company) html += '<div><strong>公司:</strong> ' + esc(brand.company) + '</div>';
  if (brand.name_cn && brand.name_cn !== brand.name) html += '<div><strong>中文名:</strong> ' + esc(brand.name_cn) + '</div>';
  if (brand.headquarter) html += '<div><strong>总部:</strong> ' + esc(brand.headquarter) + '</div>';
  if (brand.relation_group) html += '<div><strong>所属集团:</strong> ' + esc(brand.relation_group) + '</div>';
  if (brand.description) html += '<div style="margin-top:4px;color:#666">' + esc(brand.description) + '</div>';
  if (brand.contact_email) html += '<div style="margin-top:4px"><strong>📧 红人合作:</strong> ' + esc(brand.contact_email) + ' <span style="color:#999">(' + esc(brand.contact_source || '') + ')</span></div>';
  html += '</div>';
  html += '<div style="margin-bottom:16px"><strong style="font-size:13px">🏢 关联品牌（同一集团/企业）</strong>';
  if (related.length) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">';
    related.forEach(function(b) { html += '<span class="brel-tag" data-bn="' + esc(b.name).replace(/'/g,"") + '">' + esc(b.name) + '</span>'; });
    html += '</div>';
  } else { html += '<p style="font-size:12px;color:#999;margin-top:4px">暂未发现同一集团的其他品牌</p>'; }
  html += '</div>';
  html += '<div><strong style="font-size:13px">⚔️ 竞品品牌</strong>';
  if (competitors.length) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">';
    competitors.forEach(function(b) { html += '<span class="brel-tag" data-bn="' + esc(b.name).replace(/'/g,"") + '">' + esc(b.name) + '</span>'; });
    html += '</div>';
  } else { html += '<p style="font-size:12px;color:#999;margin-top:4px">暂未发现竞品品牌</p>'; }
  html += '</div></div>';
  var overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "brandRelOverlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;z-index:9999";
  overlay.onclick = function(e) { if (e.target === overlay) closeBrandRelModal(); };
  var modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "brandRelationDialog";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "brandRelationTitle");
  modal.style.cssText = "background:#fff;border-radius:12px;padding:24px;max-width:500px;width:90%;max-height:70vh;overflow-y:auto";
  modal.innerHTML = html;
  modal.innerHTML += '<div style="margin-top:16px;text-align:center"><button type="button" class="btn btn-outline" aria-label="关闭品牌关系" onclick="closeBrandRelModal()">关闭</button></div>';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  if (window.TMAccessibility) {
    window.TMAccessibility.openDialog(modal, opener, function() { closeBrandRelModal(overlay); });
  }
}
function closeBrandRelModal(targetOverlay) {
  var el = targetOverlay && targetOverlay.nodeType === 1 ? targetOverlay : document.getElementById("brandRelOverlay");
  var dialog = el ? el.querySelector('#brandRelationDialog') : document.getElementById("brandRelationDialog");
  if (dialog && window.TMAccessibility) window.TMAccessibility.closeDialog(dialog);
  if (el) el.remove();
}
document.addEventListener("click", function(e) {
  var el = e.target;
  while (el) {
    if (el.classList && el.classList.contains("brel-tag")) {
      document.getElementById("brandSearch").value = el.getAttribute("data-bn") || "";
      filterBrands();
      closeBrandRelModal();
      break;
    }
    el = el.parentElement;
  }
});
// ===== PAGE NAVIGATION =====
const TM_NAVIGATION_APP = (function() {
  function activeM4Tab() {
    var active = document.querySelector('#tabBar .tab.active');
    return active ? active.getAttribute('data-tab') || 'tab1' : 'tab1';
  }

  function visibleAdminTab() {
    var tabs = ['overview','users','knowledge','ai-audit','tokens'];
    for (var i = 0; i < tabs.length; i++) {
      var el = document.getElementById('admin-tab-' + tabs[i]);
      if (el && el.style.display !== 'none') return tabs[i];
    }
    return 'overview';
  }

  function substateForPage(id) {
    if (id === 'm0-detail') return { view: curCrmView || 'pipeline' };
    if (id === 'm4') return { tab: activeM4Tab() };
    if (id === 'admin') return { tab: visibleAdminTab() };
    return null;
  }

  function applyAppSideEffects(state) {
    if (!state || !state.pageId) return;
    var id = state.pageId;
    var substate = state.substate || {};
    if (id === 'm0') { loadCustomerStats(); renderCrmCommandCenter(); }
    if (id === 'm0-detail') { switchCrmView(substate.view || curCrmView || 'pipeline', { skipHistory: true }); }
    if (id === 'm4') { switchTab(substate.tab || activeM4Tab(), { skipHistory: true }); }
    if (id === 'admin') { switchAdminTab(substate.tab || visibleAdminTab(), { skipHistory: true }); }
    if (id === 'workflow-designer') { setTimeout(function() { if (typeof initWorkflowDesigner === 'function') initWorkflowDesigner(); }, 200); }
    if (id === 'workflow-templates') { setTimeout(function() { if (typeof wfLoadTemplates === 'function') wfLoadTemplates(); }, 200); }
    if (id === 'workflow-instances') { setTimeout(function() { if (typeof wfLoadInstances === 'function') wfLoadInstances(); }, 200); }
    if (id === 'workflow-tasks') { setTimeout(function() { if (typeof wfLoadTasks === 'function') wfLoadTasks(); }, 200); }
  }

  document.addEventListener('tm:navigation-applied', function(event) {
    applyAppSideEffects(event.detail && event.detail.state);
  });

  return {
    substateForPage: substateForPage
  };
})();

function switchPage(id, options) {
  options = options || {};
  if (window.TMNavigation) {
    window.TMNavigation.navigate(id, {
      substate: options.substate || TM_NAVIGATION_APP.substateForPage(id),
      replace: options.replace,
      fromPopState: options.fromPopState,
      user: CURRENT_USER
    });
    return;
  }

  var navs = document.querySelectorAll('.nav-item');
  for (var i = 0; i < navs.length; i++) { navs[i].classList.remove('active'); }
  var ni = document.querySelector('[data-page="' + id + '"]');
  if (ni) ni.classList.add('active');
  var pages = document.querySelectorAll('.page');
  for (var j = 0; j < pages.length; j++) { pages[j].classList.remove('active'); pages[j].style.display = 'none'; }
  var pg = document.getElementById('page-' + id);
  if (pg) { pg.classList.add('active'); pg.style.display = 'block'; }
  if (id === 'm0') { loadCustomerStats(); renderCrmCommandCenter(); }
  if (id === 'm0-detail') { switchCrmView(curCrmView || 'pipeline', { skipHistory: true }); }
  if (id === 'admin') loadAdminDashboard();
  if (id === 'workflow-designer') { setTimeout(function() { if (typeof initWorkflowDesigner === 'function') initWorkflowDesigner(); }, 200); }
  if (id === 'workflow-templates') { setTimeout(function() { if (typeof wfLoadTemplates === 'function') wfLoadTemplates(); }, 200); }
  if (id === 'workflow-instances') { setTimeout(function() { if (typeof wfLoadInstances === 'function') wfLoadInstances(); }, 200); }
  if (id === 'workflow-tasks') { setTimeout(function() { if (typeof wfLoadTasks === 'function') wfLoadTasks(); }, 200); }
}

(function exposeInlineHandlers() {
  var names = [
    'doLogin', 'doLogout', 'switchPage', 'apiFetch', 'toast', 'esc',
    'openAddCustomer', 'showAddCustomer', 'closeCustModal', 'dismissDup', 'saveCustomer', 'filterCustomers', 'setCustomerScope', 'switchCrmView',
    'closeCustomerDetail', 'loadOpportunities', 'showOppModal', 'closeOppModal', 'saveOpportunity',
    'generateAIStrategy', 'updateStrategy', 'searchNewBrand', 'exportBrandCSV', 'filterBrands', 'filterByTreeTag',
    'selectBrand', 'selectBrandByName', 'openBrandSocialSearch', 'copyBrandBriefToDemand',
    'initM3', 'goAnalyze', 'goGenerate', 'goStep3', 'resetDemand', 'updSteps', 'selTmpl', 'updateTemplateSelectionUI',
    'generateProposal', 'updateProposalDraftFromEditor', 'getCurrentProposalDraft', 'downloadProposal', 'copyProposal', 'openProposalToInfluencers',
    'getEditedDemand', 'syncCurDemandFromAnalysis', 'handleDemandFile', 'analyzeDemandAI',
    'switchTab', 'matchInfluencers', 'smartMatch', 'handleUpload', 'handleDrop', 'openInfUploadModal', 'handleUploadModal', 'downloadInfTemplate', 'exportAll', 'exportFiltered', 'exportSelected',
    'toggleAll', 'syncInfluencerSelectionState', 'loadM4Campaigns', 'changeM4CampaignContext', 'startCollab', 'submitCollabOrder', 'closeCollabOrderModal', 'loadCollaborations', 'updateCollabStatus', 'runCampaignCollabAction', 'closeCampaignSettlementModal', 'submitCampaignSettlement',
    'sendChat', 'clearChat', 'clearAIMemory', 'pushToFeishu', 'loadFeishuStatus', 'loadFeishuOutbox', 'testFeishuConnection', 'selectFeishuReconciliationDelivery', 'reconcileFeishuDelivery', 'selectFeishuRetryDelivery', 'retryFeishuDelivery',
    'switchAdminTab', 'loadAdminDashboard', 'loadAdminUsers', 'adminAddUser', 'adminCreateInvite', 'adminResetPw',
    'wfUndo', 'wfRedo', 'wfClearCanvas', 'wfSaveTemplate', 'wfPublishTemplate', 'wfResetTaskFilters', 'wfLoadTasks', 'wfLoadInstances',
    'showRelatedBrands', 'closeBrandRelModal'
  ];
  names.forEach(function(name) {
    try {
      var fn = eval('typeof ' + name + ' !== "undefined" ? ' + name + ' : null');
      if (typeof fn === 'function') window[name] = fn;
    } catch(e) {}
  });
  window.tmAppBuild = '20260630-auth-upload-fix';
})();
