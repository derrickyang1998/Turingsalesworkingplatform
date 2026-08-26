'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

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

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

test('admin AI audit exposes bounded evidence filters in one scrollable work surface', () => {
  for (const id of [
    'ad_aiAuditSearch',
    'ad_aiAuditUser',
    'ad_aiAuditModule',
    'ad_aiAuditDateFrom',
    'ad_aiAuditDateTo',
    'ad_aiAuditReference',
    'ad_aiAuditArchive'
  ]) {
    assert.match(indexSource, new RegExp(`id=["']${id}["']`));
  }
  assert.match(
    indexSource,
    /id=["']ad_aiAuditList["'][^>]*style=["'][^"']*overflow\s*:\s*auto/i
  );
});

test('admin AI audit query includes every selected filter and blocks reversed dates', () => {
  const values = {
    ad_aiAuditSearch: 'source evidence',
    ad_aiAuditUser: '22',
    ad_aiAuditModule: 'assistant',
    ad_aiAuditDateFrom: '2026-07-01',
    ad_aiAuditDateTo: '2026-07-31',
    ad_aiAuditReference: 'web',
    ad_aiAuditArchive: 'archived'
  };
  const context = loadFunctions({
    document: {
      getElementById(id) { return { value: values[id] || '' }; }
    },
    encodeURIComponent,
    Error
  }, ['buildAdminAIAuditQuery']);

  const query = context.buildAdminAIAuditQuery();
  const params = new URLSearchParams(query);
  assert.equal(params.get('limit'), '100');
  assert.equal(params.get('q'), 'source evidence');
  assert.equal(params.get('user_id'), '22');
  assert.equal(params.get('source_module'), 'assistant');
  assert.equal(params.get('date_from'), '2026-07-01');
  assert.equal(params.get('date_to'), '2026-07-31');
  assert.equal(params.get('reference_type'), 'web');
  assert.equal(params.get('archive_status'), 'archived');

  values.ad_aiAuditDateFrom = '2026-08-01';
  assert.throws(
    () => context.buildAdminAIAuditQuery(),
    /Start date must not be later than end date/
  );
});

test('admin AI audit renders only absolute HTTP sources as external links', () => {
  const context = loadFunctions({
    esc: escapeHtml,
    URL
  }, ['renderAdminAIReference']);

  const safe = context.renderAdminAIReference({
    reference_type: 'web',
    title: 'Verified <source>',
    url: 'https://example.com/report?q=1&lang=en'
  });
  assert.match(safe, /href="https:\/\/example\.com\/report\?q=1&amp;lang=en"/);
  assert.match(safe, /target="_blank"/);
  assert.match(safe, /rel="noopener noreferrer"/);
  assert.match(safe, /Verified &lt;source&gt;/);

  const unsafe = context.renderAdminAIReference({
    reference_type: 'web',
    title: 'Unsafe source',
    url: 'javascript:alert(1)'
  });
  assert.doesNotMatch(unsafe, /href=|javascript:/i);
  assert.match(unsafe, /Unsafe source/);

  const knowledge = context.renderAdminAIReference({
    reference_type: 'knowledge',
    title: 'Internal method'
  });
  assert.doesNotMatch(knowledge, /href=/i);
  assert.match(knowledge, /Internal method/);
});

test('admin AI audit loads the user directory and renders campaign, reference, and archive evidence', async () => {
  const elements = {
    ad_aiAuditSearch: { value: 'source evidence' },
    ad_aiAuditUser: { value: '', innerHTML: '' },
    ad_aiAuditModule: { value: 'assistant' },
    ad_aiAuditDateFrom: { value: '2026-07-01' },
    ad_aiAuditDateTo: { value: '2026-07-31' },
    ad_aiAuditReference: { value: 'web' },
    ad_aiAuditArchive: { value: 'archived' },
    ad_aiAuditList: { innerHTML: '' }
  };
  const calls = [];
  const context = loadFunctions({
    adminAIAuditUsersPromise: null,
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    esc: escapeHtml,
    encodeURIComponent,
    Error,
    Promise,
    async apiFetch(url) {
      calls.push(url);
      if (url === '/admin/users') {
        return response(200, {
          users: [{ id: 22, username: 'owner', display_name: 'Owner <One>' }]
        });
      }
      return response(200, {
        conversations: [{
          id: 41,
          campaign_id: 12,
          username: 'owner',
          display_name: 'Owner One',
          source_module: 'assistant',
          title: 'Evidence review',
          message_count: 3,
          run_summary: {
            status: 'degraded',
            run_count: 2,
            succeeded_count: 1,
            degraded_count: 1,
            failed_count: 0,
            unknown_count: 0,
            prompt_tokens: 20,
            completion_tokens: 12,
            total_tokens: 32,
            average_latency_ms: 540,
            latest_model: 'deepseek-chat',
            knowledge_reference_count: 2,
            web_reference_count: 1,
            cost_summary: {
              status: 'partial',
              currency: 'USD',
              priced_run_count: 1,
              unavailable_run_count: 1,
              total_cost_nano_usd: 6628
            }
          },
          knowledge_reference_count: 2,
          web_reference_count: 1,
          archived_summary_id: 91,
          last_answer: 'Verified answer',
          activity_at: '2026-07-11 08:45:00',
          updated_at: '2026-07-10 11:20:00'
        }]
      });
    }
  }, [
    'loadAdminAIAuditUsers',
    'buildAdminAIAuditQuery',
    'adminAIRunStatusLabel',
    'adminAIRunNumber',
    'adminAICostText',
    'adminAIRunSummaryText',
    'loadAdminAIAudit'
  ]);

  await context.loadAdminAIAuditUsers();
  elements.ad_aiAuditUser.value = '22';
  await context.loadAdminAIAudit();

  assert.match(elements.ad_aiAuditUser.innerHTML, /Owner &lt;One&gt;/);
  assert.equal(calls[0], '/admin/users');
  assert.match(calls[1], /^\/ai\/conversations\?/);
  const params = new URLSearchParams(calls[1].split('?')[1]);
  assert.equal(params.get('user_id'), '22');
  assert.match(elements.ad_aiAuditList.innerHTML, /Campaign #12/);
  assert.match(elements.ad_aiAuditList.innerHTML, /KB 2 \/ Web 1/);
  assert.match(elements.ad_aiAuditList.innerHTML, /2 次/);
  assert.match(elements.ad_aiAuditList.innerHTML, /降级/);
  assert.match(elements.ad_aiAuditList.innerHTML, /32 tokens/);
  assert.match(elements.ad_aiAuditList.innerHTML, /540 ms/);
  assert.match(elements.ad_aiAuditList.innerHTML, /部分投影成本 \$0\.000006628/);
  assert.match(elements.ad_aiAuditList.innerHTML, /Archived/);
  assert.match(elements.ad_aiAuditList.innerHTML, /2026-07-11 08:45/);
  assert.doesNotMatch(elements.ad_aiAuditList.innerHTML, /2026-07-10 11:20/);
});

test('admin AI audit detail renders the backend run projection without trusting metadata markup', async () => {
  const detail = { innerHTML: '' };
  const context = loadFunctions({
    document: {
      getElementById(id) { return id === 'ad_aiAuditDetail' ? detail : null; }
    },
    esc: escapeHtml,
    Promise,
    async apiFetch(url) {
      assert.equal(url, '/ai/conversations/41');
      return response(200, {
        conversation: {
          id: 41,
          title: 'Run <audit>',
          display_name: 'Owner',
          source_module: 'assistant',
          created_at: '2026-07-11 08:45:00',
          run_summary: {
            status: 'succeeded',
            run_count: 1,
            succeeded_count: 1,
            degraded_count: 0,
            failed_count: 0,
            unknown_count: 0,
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18,
            average_latency_ms: 420,
            latest_model: 'deepseek-chat',
            knowledge_reference_count: 1,
            web_reference_count: 0,
            cost_summary: {
              status: 'priced',
              currency: 'USD',
              priced_run_count: 1,
              unavailable_run_count: 0,
              total_cost_nano_usd: 6628
            }
          },
          messages: [{
            id: 91,
            role: 'assistant',
            model: 'ignored-model<script>',
            total_tokens: 999999,
            content: 'Safe <answer>',
            run: {
              run_id: 91,
              status: 'succeeded',
              model: 'deepseek-chat<script>',
              prompt_tokens: 10,
              completion_tokens: 8,
              total_tokens: 18,
              latency_ms: 420,
              knowledge_reference_count: 1,
              web_reference_count: 0,
              created_at: '2026-07-11 08:45:01',
              cost_projection: {
                status: 'priced',
                currency: 'USD',
                total_cost_nano_usd: 6628,
                policy_version: 'deepseek-v4-usd-2026-08-13-v1',
                rate_period: 'off_peak',
                reason: null
              }
            },
            references: []
          }]
        }
      });
    }
  }, [
    'adminAIRunStatusLabel',
    'adminAIRunNumber',
    'adminAICostText',
    'adminAIRunSummaryText',
    'adminAIMessageMetaText',
    'loadAdminAIConversation'
  ]);

  context.loadAdminAIConversation(41);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(detail.innerHTML, /1 次/);
  assert.match(detail.innerHTML, /成功/);
  assert.match(detail.innerHTML, /18 tokens/);
  assert.match(detail.innerHTML, /420 ms/);
  assert.match(detail.innerHTML, /P 10 \/ C 8 \/ T 18/);
  assert.match(detail.innerHTML, /投影成本 \$0\.000006628/);
  assert.match(detail.innerHTML, /deepseek-chat&lt;script&gt;/);
  assert.doesNotMatch(detail.innerHTML, /ignored-model|999999|<script>/);
  assert.match(detail.innerHTML, /Safe &lt;answer&gt;/);
});

test('admin AI audit labels unavailable cost without presenting it as zero', () => {
  const context = loadFunctions({}, [
    'adminAIRunNumber',
    'adminAICostText'
  ]);

  assert.equal(context.adminAICostText({ status: 'unavailable', total_cost_nano_usd: null }), '投影成本不可用');
  assert.equal(context.adminAICostText({ status: 'overflow', total_cost_nano_usd: null }), '投影成本不可用');
  assert.equal(context.adminAICostText({ status: 'empty', total_cost_nano_usd: null }), '投影成本 -');
  assert.equal(context.adminAICostText({ status: 'priced', total_cost_nano_usd: 1000000000 }), '投影成本 $1');
});

test('admin AI audit refreshes its user directory after in-app user changes', async () => {
  const select = { value: '', innerHTML: '' };
  let calls = 0;
  const context = loadFunctions({
    adminAIAuditUsersPromise: null,
    document: {
      getElementById(id) { return id === 'ad_aiAuditUser' ? select : null; }
    },
    esc: escapeHtml,
    Promise,
    async apiFetch(url) {
      assert.equal(url, '/admin/users');
      calls += 1;
      return response(200, {
        users: calls === 1
          ? [{ id: 22, username: 'first', display_name: 'First user' }]
          : [{ id: 23, username: 'second', display_name: 'Second user' }]
      });
    }
  }, ['loadAdminAIAuditUsers']);

  await context.loadAdminAIAuditUsers();
  await context.loadAdminAIAuditUsers();

  assert.equal(calls, 2);
  assert.doesNotMatch(select.innerHTML, /First user/);
  assert.match(select.innerHTML, /Second user/);
});
