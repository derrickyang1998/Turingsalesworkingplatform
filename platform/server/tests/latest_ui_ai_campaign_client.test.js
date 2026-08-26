'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', '..', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');

function extractFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const matches = Array.from(source.matchAll(declaration));
  assert.ok(matches.length, `${name} must exist`);
  const match = matches[matches.length - 1];
  const openingBrace = source.indexOf('{', match.index);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  assert.fail(`${name} must have a balanced function body`);
}

function loadFunctions(context, names) {
  context.window = context.window || context;
  context.globalThis = context;
  vm.createContext(context);
  for (const name of names) vm.runInContext(extractFunction(appSource, name), context);
  return context;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function baseContext(overrides = {}) {
  const elements = {
    chatInput: { value: '请给出这个项目的达人策略', disabled: false },
    chatMessages: {
      children: [],
      scrollTop: 0,
      scrollHeight: 10,
      appendChild(node) { this.children.push(node); }
    },
    webSearchToggle: { checked: false },
    sendButton: { disabled: false }
  };
  const rendered = [];
  let generatedId = 0;
  const context = {
    AUTH_GENERATION: 4,
    currentAIConversationId: null,
    selectedKnowledgeEntryIds: [7, 8],
    selectedKnowledgeCampaignId: 12,
    aiChatIdempotencyFingerprint: '',
    aiChatIdempotencyKey: '',
    aiChatRequestSequence: 0,
    activeAiChatRequest: null,
    aiMemory: {},
    BRANDS: [{ id: 1 }],
    chatHistory: [],
    activeWorkflowContext: { campaign_id: 12 },
    curDemand: null,
    document: {
      getElementById(id) { return elements[id] || null; },
      querySelector(selector) {
        return selector === '#page-m5 .chat-input-area button' ? elements.sendButton : null;
      },
      createElement() {
        return {
          className: '',
          innerHTML: '',
          textContent: '',
          style: {},
          children: [],
          removed: false,
          appendChild(node) { this.children.push(node); },
          remove() { this.removed = true; }
        };
      }
    },
    getActiveCampaignId() { return Number(context.activeWorkflowContext.campaign_id); },
    getSelectedKnowledgeEntryIds() { return context.selectedKnowledgeEntryIds.slice(); },
    createAiChatIdempotencyKey() { generatedId += 1; return `ai-chat-key-${generatedId}`; },
    createDemandAnalysisOperationId(prefix) { generatedId += 1; return `${prefix}${generatedId}`; },
    addChatMsg(role, text) { rendered.push({ role, text }); },
    renderAIReferenceText(data) { return data.archived_summary_id ? '\nARCHIVED' : ''; },
    saveAIMemory() {},
    toast() {},
    invalidateDemandAnalysisRequests() {},
    invalidateProposalDraftRequests() {},
    invalidateCampaignPptGeneration() {},
    resetCampaignPptArtifactState() {},
    AbortController,
    Promise,
    JSON,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    elements,
    rendered,
    ...overrides
  };
  return context;
}

const aiClientFunctions = [
  'readPositiveInteger',
  'aiChatFingerprint',
  'prepareAiChatRequest',
  'setAiChatControlsBusy',
  'beginAiChatRequest',
  'isAiChatRequestCurrent',
  'invalidateAiChatRequests',
  'finishAiChatRequest',
  'renderAiChatError',
  'sendChat'
];

test('M5 sends the exact user prompt and honors the existing web-search toggle', async () => {
  const calls = [];
  const context = baseContext({
    async apiFetch(url, options) {
      calls.push({ url, options });
      return response(200, {
        conversation_id: 41,
        message_id: 81,
        campaign_id: 12,
        answer: '策略回复',
        knowledge_references: [{ id: 7, title: '项目方法论' }],
        web_results: [],
        archived_summary_id: 91
      });
    }
  });
  loadFunctions(context, aiClientFunctions);

  await context.sendChat();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/ai/chat');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.message, '请给出这个项目的达人策略');
  assert.equal(body.allow_web, false);
  assert.equal(body.campaign_id, 12);
  assert.equal(body.conversation_id, null);
  assert.deepEqual(Array.from(body.knowledge_entry_ids), [7, 8]);
  assert.equal(body.source_module, 'assistant');
  assert.match(calls[0].options.headers['Idempotency-Key'], /^ai-chat-key-/);
  assert.match(calls[0].options.headers['X-Request-Id'], /^ai-chat-request-/);
  assert.equal(context.currentAIConversationId, 41);
  assert.deepEqual(context.rendered.map((row) => row.role), ['user', 'assistant']);
  assert.match(context.rendered[1].text, /策略回复/);
  assert.equal(context.elements.chatInput.disabled, false);
  assert.equal(context.elements.sendButton.disabled, false);
});

test('M5 keeps one request in flight so simultaneous first messages cannot split conversations', async () => {
  const pending = deferred();
  let calls = 0;
  const context = baseContext({
    apiFetch() { calls += 1; return pending.promise; }
  });
  loadFunctions(context, aiClientFunctions);

  const first = context.sendChat();
  context.elements.chatInput.value = '第二条并发消息';
  const second = context.sendChat();

  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(context.rendered.filter((row) => row.role === 'user').length, 1);
  assert.equal(context.elements.chatInput.value, '第二条并发消息');
  assert.equal(context.elements.chatInput.disabled, true);

  pending.resolve(response(200, {
    conversation_id: 42,
    message_id: 82,
    campaign_id: 12,
    answer: '唯一回复',
    knowledge_references: [],
    web_results: []
  }));
  await first;
  assert.equal(context.currentAIConversationId, 42);
  assert.equal(context.elements.chatInput.disabled, false);
});

test('an ambiguous transport retry reuses the key, refreshes request ID, then rotates after success', async () => {
  const calls = [];
  const context = baseContext({
    async apiFetch(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) throw new TypeError('network interrupted');
      return response(200, {
        conversation_id: calls.length === 2 ? 43 : 44,
        message_id: calls.length === 2 ? 83 : 84,
        campaign_id: 12,
        answer: `回复 ${calls.length}`,
        knowledge_references: [],
        web_results: []
      });
    }
  });
  loadFunctions(context, aiClientFunctions);

  await context.sendChat();
  context.elements.chatInput.value = '请给出这个项目的达人策略';
  await context.sendChat();
  context.currentAIConversationId = null;
  context.elements.chatInput.value = '请给出这个项目的达人策略';
  await context.sendChat();

  const keys = calls.map((call) => call.options.headers['Idempotency-Key']);
  const requestIds = calls.map((call) => call.options.headers['X-Request-Id']);
  assert.equal(keys[0], keys[1], 'ambiguous retry must replay the same linked operation');
  assert.notEqual(requestIds[0], requestIds[1], 'every transport attempt needs a fresh request ID');
  assert.notEqual(keys[1], keys[2], 'a completed interaction must not swallow an intentional repeat');
});

test('an explicit HTTP failure rotates the retry key instead of replaying a completed error forever', async () => {
  const calls = [];
  const context = baseContext({
    async apiFetch(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) return response(503, { error: 'AI provider unavailable' });
      return response(200, {
        conversation_id: 45,
        message_id: 85,
        campaign_id: 12,
        answer: '恢复后的回复',
        knowledge_references: [],
        web_results: []
      });
    }
  });
  loadFunctions(context, aiClientFunctions);

  await context.sendChat();
  context.elements.chatInput.value = '请给出这个项目的达人策略';
  await context.sendChat();

  assert.notEqual(
    calls[0].options.headers['Idempotency-Key'],
    calls[1].options.headers['Idempotency-Key']
  );
});

test('leaving and reopening a Campaign starts a new AI chat operation', async () => {
  const calls = [];
  const context = baseContext({
    async apiFetch(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) throw new TypeError('network interrupted');
      return response(200, {
        conversation_id: 48,
        message_id: 88,
        campaign_id: 12,
        answer: '重新进入项目后的回复',
        knowledge_references: [],
        web_results: []
      });
    }
  });
  loadFunctions(context, aiClientFunctions.concat(['readExplicitCampaignId', 'setWorkflowContext']));

  await context.sendChat();
  context.setWorkflowContext({ campaign_id: 13 });
  context.setWorkflowContext({ campaign_id: 12 });
  context.selectedKnowledgeEntryIds = [7, 8];
  context.selectedKnowledgeCampaignId = 12;
  context.elements.chatInput.value = '请给出这个项目的达人策略';
  await context.sendChat();

  assert.notEqual(
    calls[0].options.headers['Idempotency-Key'],
    calls[1].options.headers['Idempotency-Key']
  );
});

test('M5 renders backend error text without interpreting markup', async () => {
  const context = baseContext({
    async apiFetch() {
      return response(503, { error: '<img src=x onerror=alert(1)> provider unavailable' });
    }
  });
  loadFunctions(context, aiClientFunctions);

  await context.sendChat();

  const pendingNode = context.elements.chatMessages.children[0];
  assert.doesNotMatch(pendingNode.innerHTML, /<img|onerror/i);
  assert.equal(pendingNode.children.length, 1);
  assert.equal(
    pendingNode.children[0].textContent,
    'Error: <img src=x onerror=alert(1)> provider unavailable'
  );
});

test('Campaign changes abort and suppress an older AI response', async () => {
  const pending = deferred();
  const context = baseContext({
    apiFetch() { return pending.promise; }
  });
  loadFunctions(context, aiClientFunctions.concat(['readPositiveInteger', 'readExplicitCampaignId', 'setWorkflowContext']));

  const operation = context.sendChat();
  context.setWorkflowContext({ campaign_id: 13 });
  pending.resolve(response(200, {
    conversation_id: 46,
    message_id: 86,
    campaign_id: 12,
    answer: '不应渲染的旧回复',
    knowledge_references: [],
    web_results: []
  }));
  await operation;

  assert.equal(context.currentAIConversationId, null);
  assert.equal(context.rendered.some((row) => /不应渲染/.test(row.text)), false);
  assert.equal(context.activeAiChatRequest, null);
  assert.equal(context.elements.chatInput.disabled, false);
});

test('auth-generation and continuation mismatches cannot mutate the active conversation', async () => {
  const pending = deferred();
  const context = baseContext({
    currentAIConversationId: 47,
    apiFetch() { return pending.promise; }
  });
  loadFunctions(context, aiClientFunctions);

  const operation = context.sendChat();
  context.AUTH_GENERATION += 1;
  pending.resolve(response(200, {
    conversation_id: 99,
    message_id: 87,
    campaign_id: 12,
    answer: '不应进入新登录态',
    knowledge_references: [],
    web_results: []
  }));
  await operation;

  assert.equal(context.currentAIConversationId, 47);
  assert.equal(context.rendered.some((row) => /不应进入/.test(row.text)), false);
});
