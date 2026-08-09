const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const appPath = path.join(repoRoot, 'platform', 'app.js');
const appJs = fs.readFileSync(appPath, 'utf8');

function extractFunction(name) {
  const signatures = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  for (const signature of signatures) {
    start = appJs.indexOf(signature);
    if (start !== -1) break;
  }
  if (start === -1) return null;

  const braceStart = appJs.indexOf('{', start);
  if (braceStart === -1) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = braceStart; index < appJs.length; index += 1) {
    const char = appJs[index];
    const next = appJs[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return appJs.slice(start, index + 1);
    }
  }
  return null;
}

function responseFixture({ ok, status, payload, jsonError }) {
  const state = { jsonCalls: 0 };
  return {
    ok,
    status,
    state,
    async json() {
      state.jsonCalls += 1;
      if (jsonError) throw jsonError;
      return payload;
    }
  };
}

function createElement(value = '') {
  const attributes = new Map();
  return {
    value,
    style: { display: 'flex' },
    dataset: {},
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    setAttribute(name, nextValue) {
      attributes.set(name, String(nextValue));
    }
  };
}

function createHarness(response) {
  const elements = new Map();
  const values = {
    custBrand: 'Acme',
    custCompany: 'Acme Ltd',
    custIndustry: 'Retail',
    custContact: 'Derrick',
    custContactInfo: 'derrick@example.com',
    custSource: 'Referral',
    custBudget: '12000',
    custNotes: 'Keep this draft',
    custStage: 'lead',
    custEditId: ''
  };
  Object.entries(values).forEach(([id, value]) => elements.set(id, createElement(value)));

  const state = {
    apiCalls: [],
    toasts: [],
    modalCloses: 0,
    detailCloses: 0,
    customerLoads: 0,
    statsLoads: 0
  };
  const context = {
    console,
    CUST_STAGES: { lead: 'Lead', negotiation: 'Negotiation' },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement());
        return elements.get(id);
      }
    },
    async apiFetch(url, options) {
      state.apiCalls.push({ url, options });
      return response;
    },
    toast(message, type) {
      state.toasts.push({ message, type });
    },
    closeCustModal() {
      state.modalCloses += 1;
    },
    closeCustomerDetail() {
      state.detailCloses += 1;
    },
    async loadCustomers() {
      state.customerLoads += 1;
    },
    loadCustomerStats() {
      state.statsLoads += 1;
    }
  };

  const functionNames = [
    'requireSuccessfulCustomerMutation',
    'saveCustomer',
    'changeCustomerStage',
    'claimCustomer',
    'returnToPool'
  ];
  const sources = functionNames.map((name) => {
    const source = extractFunction(name);
    assert.ok(source, `app.js must define ${name}`);
    return source;
  });
  vm.createContext(context);
  vm.runInContext(sources.join('\n\n'), context, { filename: 'customer-mutation-functions.js' });
  return { context, elements, state };
}

function successToasts(state) {
  return state.toasts.filter((entry) => entry.type !== 'error');
}

function errorToasts(state) {
  return state.toasts.filter((entry) => entry.type === 'error');
}

test('CRM mutations use a private response guard without changing apiFetch', () => {
  const guard = extractFunction('requireSuccessfulCustomerMutation');
  assert.ok(guard, 'missing CRM response guard');
  assert.doesNotMatch(extractFunction('apiFetch'), /requireSuccessfulCustomerMutation/);
});

test('stage and detail entry points preserve rollback and delayed-close context', () => {
  assert.match(
    appJs,
    /data-previous-value="[\s\S]*?onchange="changeCustomerStage\([^\n]*?this\)"/,
    'stage select must retain its prior value and pass itself to the mutation handler'
  );
  assert.ok(appJs.includes("claimCustomer(' + c.id + ', true)"));
  assert.ok(appJs.includes("returnToPool(' + c.id + ', true)"));
  assert.ok(!appJs.includes("claimCustomer(' + c.id + ');closeCustomerDetail()"));
  assert.ok(!appJs.includes("returnToPool(' + c.id + ');closeCustomerDetail()"));
});

test('response guard extracts bounded server messages and ignores object values', async (t) => {
  const { context } = createHarness(responseFixture({ ok: true, status: 200 }));
  for (const [field, value] of [
    ['error', 'duplicate'],
    ['message', 'forbidden'],
    ['title', 'server unavailable'],
    ['code', 'CRM_CONFLICT']
  ]) {
    await t.test(field, async () => {
      const response = responseFixture({ ok: false, status: 409, payload: { [field]: value } });
      await assert.rejects(
        context.requireSuccessfulCustomerMutation(response, 'fallback'),
        (error) => error.message.includes(value) && error.message.length <= 340
      );
      assert.equal(response.state.jsonCalls, 1);
    });
  }

  const response = responseFixture({ ok: false, status: 500, payload: { error: { nested: true } } });
  await assert.rejects(
    context.requireSuccessfulCustomerMutation(response, 'fallback'),
    (error) => error.message.includes('fallback') && !error.message.includes('[object Object]')
  );
});

test('response guard returns successful responses without consuming their body', async () => {
  const response = responseFixture({ ok: true, status: 204, payload: { unused: true } });
  const { context } = createHarness(response);
  assert.equal(await context.requireSuccessfulCustomerMutation(response, 'fallback'), response);
  assert.equal(response.state.jsonCalls, 0);
});

for (const scenario of [
  { label: 'create 409', editId: '', status: 409 },
  { label: 'update 403', editId: '42', status: 403 }
]) {
  test(`${scenario.label} keeps the customer draft open and unchanged`, async () => {
    const response = responseFixture({
      ok: false,
      status: scenario.status,
      payload: { error: 'mutation rejected' }
    });
    const { context, elements, state } = createHarness(response);
    elements.get('custEditId').value = scenario.editId;
    const before = Object.fromEntries([...elements].map(([id, element]) => [id, element.value]));

    await context.saveCustomer();

    assert.equal(state.modalCloses, 0);
    assert.equal(state.customerLoads, 0);
    assert.equal(successToasts(state).length, 0);
    assert.equal(errorToasts(state).length, 1);
    assert.deepEqual(
      Object.fromEntries([...elements].map(([id, element]) => [id, element.value])),
      before
    );
  });
}

test('failed stage update restores the previous select value and skips stats refresh', async () => {
  const response = responseFixture({ ok: false, status: 500, payload: { message: 'stage rejected' } });
  const { context, state } = createHarness(response);
  const select = createElement('negotiation');
  select.setAttribute('data-previous-value', 'lead');

  await context.changeCustomerStage(7, 'negotiation', select);

  assert.equal(select.value, 'lead');
  assert.equal(select.getAttribute('data-previous-value'), 'lead');
  assert.equal(state.statsLoads, 0);
  assert.equal(successToasts(state).length, 0);
  assert.equal(errorToasts(state).length, 1);
});

test('failed detail claim and return leave the sidebar open and skip refresh', async (t) => {
  for (const scenario of [
    { name: 'claimCustomer', status: 500, payload: { title: 'claim failed' } },
    { name: 'returnToPool', status: 409, jsonError: new Error('bad json') }
  ]) {
    await t.test(scenario.name, async () => {
      const response = responseFixture({
        ok: false,
        status: scenario.status,
        payload: scenario.payload,
        jsonError: scenario.jsonError
      });
      const { context, state } = createHarness(response);

      await context[scenario.name](7, true);

      assert.equal(state.detailCloses, 0);
      assert.equal(state.customerLoads, 0);
      assert.equal(successToasts(state).length, 0);
      assert.equal(errorToasts(state).length, 1);
      assert.ok(!String(errorToasts(state)[0].message).includes('[object Object]'));
    });
  }
});

test('successful create and update keep the existing close and reload behavior', async (t) => {
  for (const editId of ['', '42']) {
    await t.test(editId ? 'update' : 'create', async () => {
      const response = responseFixture({ ok: true, status: editId ? 200 : 201 });
      const { context, elements, state } = createHarness(response);
      elements.get('custEditId').value = editId;

      await context.saveCustomer();

      assert.equal(state.modalCloses, 1);
      assert.equal(state.customerLoads, 1);
      assert.equal(successToasts(state).length, 1);
      assert.equal(errorToasts(state).length, 0);
      assert.equal(response.state.jsonCalls, 0);
    });
  }
});

test('successful stage update records the new rollback point and reloads stats once', async () => {
  const response = responseFixture({ ok: true, status: 200 });
  const { context, state } = createHarness(response);
  const select = createElement('negotiation');
  select.setAttribute('data-previous-value', 'lead');

  await context.changeCustomerStage(7, 'negotiation', select);

  assert.equal(select.value, 'negotiation');
  assert.equal(select.getAttribute('data-previous-value'), 'negotiation');
  assert.equal(state.statsLoads, 1);
  assert.equal(successToasts(state).length, 1);
  assert.equal(errorToasts(state).length, 0);
});

test('successful detail claim and return close once and reload customers once', async (t) => {
  for (const name of ['claimCustomer', 'returnToPool']) {
    await t.test(name, async () => {
      const response = responseFixture({ ok: true, status: 200 });
      const { context, state } = createHarness(response);

      await context[name](7, true);

      assert.equal(state.detailCloses, 1);
      assert.equal(state.customerLoads, 1);
      assert.equal(successToasts(state).length, 1);
      assert.equal(errorToasts(state).length, 0);
    });
  }
});

test('successful public-pool claim does not close a detail sidebar', async () => {
  const response = responseFixture({ ok: true, status: 200 });
  const { context, state } = createHarness(response);

  await context.claimCustomer(7);

  assert.equal(state.detailCloses, 0);
  assert.equal(state.customerLoads, 1);
});
