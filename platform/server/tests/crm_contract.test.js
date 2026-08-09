const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CUSTOMER_LIFECYCLE_REGISTRY,
  OPPORTUNITY_STAGE_REGISTRY,
  CUSTOMER_PRIORITY_REGISTRY,
  CrmContractError,
  assertCustomerLifecycle,
  classifyCustomerLifecycle,
  customerLifecycleGroup,
  assertOpportunityStage,
  assertCustomerPriority,
  buildCustomerIdentity,
  canonicalizeCrmFilter,
  fingerprintCrmFilter,
  encodeCrmCursor,
  decodeCrmCursor
} = require('../services/crm_contract');

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('CRM registries expose the frozen approved lifecycle, opportunity, and priority order', () => {
  assert.deepEqual(Object.keys(CUSTOMER_LIFECYCLE_REGISTRY), [
    'lead', 'info_confirmed', 'advantage_shared', 'needs_confirmed', 'analysis',
    'proposal', 'kol_matching', 'cooperation', 'paused', 'won', 'lost'
  ]);
  assert.deepEqual(Object.values(CUSTOMER_LIFECYCLE_REGISTRY).map((entry) => entry.order), [
    10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110
  ]);
  assert.deepEqual(Object.keys(OPPORTUNITY_STAGE_REGISTRY), [
    'discovery', 'qualification', 'proposal', 'negotiation', 'won', 'lost'
  ]);
  assert.deepEqual(Object.keys(CUSTOMER_PRIORITY_REGISTRY), ['high', 'medium', 'low']);
  assert.deepEqual(Object.values(CUSTOMER_PRIORITY_REGISTRY).map((entry) => [entry.order, entry.label_zh, entry.label_en]), [
    [10, '高', 'High'], [20, '中', 'Medium'], [30, '低', 'Low']
  ]);
  assertDeepFrozen(CUSTOMER_LIFECYCLE_REGISTRY);
  assertDeepFrozen(OPPORTUNITY_STAGE_REGISTRY);
  assertDeepFrozen(CUSTOMER_PRIORITY_REGISTRY);
});

test('customer lifecycle metadata preserves approved grouping and display copy', () => {
  assert.deepEqual(CUSTOMER_LIFECYCLE_REGISTRY.lead, {
    kind: 'canonical', code: 'lead', order: 10, class: 'active', dashboard_group: 'development',
    label_detail: '1.客户获取/客户开发', label_compact: '开发中'
  });
  assert.equal(CUSTOMER_LIFECYCLE_REGISTRY.needs_confirmed.dashboard_group, 'qualification');
  assert.equal(CUSTOMER_LIFECYCLE_REGISTRY.cooperation.dashboard_group, 'proposal_negotiation');
  assert.equal(CUSTOMER_LIFECYCLE_REGISTRY.won.dashboard_group, 'closed');
  assert.equal(OPPORTUNITY_STAGE_REGISTRY.negotiation.label, '谈判中');
});

test('strict enum validators accept exact canonical values and reject repaired aliases', () => {
  assert.equal(assertCustomerLifecycle('lead'), 'lead');
  assert.equal(assertOpportunityStage('negotiation'), 'negotiation');
  assert.equal(assertCustomerPriority('medium'), 'medium');

  for (const [fn, value] of [
    [assertCustomerLifecycle, ' Lead'],
    [assertCustomerLifecycle, 'maintenance'],
    [assertOpportunityStage, 'WON'],
    [assertCustomerPriority, 'normal'],
    [assertCustomerPriority, 1]
  ]) {
    assert.throws(() => fn(value), (error) => {
      assert.equal(error instanceof CrmContractError, true);
      assert.equal(error.code, 'CRM_CONTRACT_INVALID');
      assert.equal(error.status, 400);
      assert.equal(Object.values(error).includes(value), false);
      return true;
    });
  }
});

test('lifecycle classification keeps unknown historical strings without guessing a mapping', () => {
  assert.equal(classifyCustomerLifecycle('lead'), CUSTOMER_LIFECYCLE_REGISTRY.lead);
  for (const source of ['negotiation', 'maintenance', '', 'legacy value']) {
    const result = classifyCustomerLifecycle(source);
    assert.deepEqual(result, { kind: 'legacy', source_value: source });
    assert.equal(Object.isFrozen(result), true);
  }
  assert.throws(() => classifyCustomerLifecycle(null), (error) => {
    assert.equal(error.code, 'CRM_CONTRACT_INVALID');
    assert.equal(error.field, 'customer_stage');
    assert.equal(error.reason, 'invalid_type');
    return true;
  });
});

test('lifecycle group only accepts canonical values', () => {
  assert.equal(customerLifecycleGroup('analysis'), 'qualification');
  assert.equal(customerLifecycleGroup('lost'), 'closed');
  assert.throws(() => customerLifecycleGroup('maintenance'), CrmContractError);
});

test('identity v1 matches every approved UTF-8 golden vector', () => {
  const vectors = [
    ['Acme', null, '52c230ae7e41d3c495a97ade651c3efd17af8be3ee3b6b78de53818f7d218b43'],
    ['\uff21\uff23\uff2d\uff25', '  Turing\t LLC ', 'f75bfca8995cc6ccfb89a1d24762d91c6897506642313d6173ea0b46d3d1baa4'],
    ['acme', 'turing llc', 'f75bfca8995cc6ccfb89a1d24762d91c6897506642313d6173ea0b46d3d1baa4'],
    ['\u56fe\u7075\u3000\u5e02\u573a', '\u56fe\u7075\uff08\u4e0a\u6d77\uff09\u6709\u9650\u516c\u53f8', '8a4df2209be26d0faabb531aaab977ef23e967f8f218f276ea6e57b2081cade5'],
    ['A\u0000cME', '', '52c230ae7e41d3c495a97ade651c3efd17af8be3ee3b6b78de53818f7d218b43'],
    ['ACME, Inc.', '', 'a8c31d1436c72ee97325e2ccb7d765e391355cad34a1ed5d0a85fc318eb6acb0'],
    ['ACME Inc', '', 'fb3ef74c6bea3c59527c15da431b10f6bc638b6bfae5eeb99af9521a767db4bf'],
    ['Stra\u00dfe', '', '20b427c46337ad78752d668c9f3ef6c8f40aa49db5e9b46d380a94f811708331']
  ];

  for (const [brand_name, company_name, expected] of vectors) {
    const result = buildCustomerIdentity({ brand_name, company_name });
    assert.deepEqual(result, { version: 1, algorithm: 'sha256', key: expected });
    assert.equal(Object.isFrozen(result), true);
  }
});

test('identity treats missing, null, and empty company as equivalent without exposing normalized text', () => {
  const missing = buildCustomerIdentity({ brand_name: 'Acme' });
  const nil = buildCustomerIdentity({ brand_name: 'Acme', company_name: null });
  const empty = buildCustomerIdentity({ brand_name: 'Acme', company_name: '' });
  assert.equal(missing.key, nil.key);
  assert.equal(nil.key, empty.key);
  assert.deepEqual(Object.keys(missing), ['version', 'algorithm', 'key']);
  assert.equal(JSON.stringify(missing).includes('acme'), false);
});

test('identity does not mutate input or include contact, country, and tags in key material', () => {
  const input = {
    brand_name: ' ACME ',
    company_name: 'Turing LLC',
    contact_info: 'private@example.com',
    country: 'US',
    tags: ['fitness']
  };
  const before = structuredClone(input);
  const result = buildCustomerIdentity(input);
  assert.deepEqual(input, before);
  assert.equal(result.key, buildCustomerIdentity({ brand_name: 'acme', company_name: 'turing llc' }).key);
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
});

test('identity rejects invalid brand and company types with bounded errors', () => {
  for (const input of [
    {},
    { brand_name: null },
    { brand_name: 1 },
    { brand_name: ' \t\n ' },
    { brand_name: 'Acme', company_name: {} },
    { brand_name: 'Acme', company_name: [] },
    { brand_name: 'Acme', company_name: 5 }
  ]) {
    assert.throws(() => buildCustomerIdentity(input), (error) => {
      assert.equal(error instanceof CrmContractError, true);
      assert.equal(error.code, 'CRM_IDENTITY_INVALID');
      assert.equal(error.status, 400);
      assert.equal(JSON.stringify(error).includes('Acme'), false);
      return true;
    });
  }
});

function completeFilter(overrides = {}) {
  return {
    scope: 'my',
    owner_id: null,
    team_id: null,
    customer_stage: ['won', 'lead', 'lead'],
    opportunity_stage: ['proposal'],
    priority: ['low', 'high'],
    industry: '  Consumer\t Electronics ',
    country: 'USA',
    tag: 'Fitness\u3000Creator',
    source: 'Referral',
    next_action_due: 'today',
    stalled: false,
    keyword: ' ACME ',
    as_of: '2026-08-09T02:30:00.000Z',
    limit: 25,
    cursor: null,
    ...overrides
  };
}

test('filter canonicalization returns one fixed, deeply frozen shape', () => {
  const result = canonicalizeCrmFilter(completeFilter());
  assert.deepEqual(result, {
    scope: 'my',
    owner_id: null,
    team_id: null,
    customer_stage: ['lead', 'won'],
    opportunity_stage: ['proposal'],
    priority: ['high', 'low'],
    industry: 'consumer electronics',
    country: 'usa',
    tag: 'fitness creator',
    source: 'referral',
    next_action_due: 'today',
    stalled: false,
    keyword: 'acme',
    as_of: '2026-08-09T02:30:00.000Z',
    limit: 25,
    cursor: null
  });
  assertDeepFrozen(result);
});

test('missing optional filters canonicalize deterministically without inventing authorization', () => {
  assert.deepEqual(canonicalizeCrmFilter({}), {
    scope: null,
    owner_id: null,
    team_id: null,
    customer_stage: [],
    opportunity_stage: [],
    priority: [],
    industry: null,
    country: null,
    tag: null,
    source: null,
    next_action_due: null,
    stalled: null,
    keyword: null,
    as_of: null,
    limit: 25,
    cursor: null
  });
});

test('filter parser rejects unknown keys, aliases, coercion, bad dates, and overlong text', () => {
  const cases = [
    [{ search: 'acme' }, 'filter', 'unknown_field'],
    [{ scope: 'all' }, 'scope', 'unsupported_value'],
    [{ owner_id: '7' }, 'owner_id', 'invalid_type'],
    [{ team_id: 0 }, 'team_id', 'invalid_format'],
    [{ customer_stage: 'lead' }, 'customer_stage', 'invalid_type'],
    [{ customer_stage: ['Lead'] }, 'customer_stage', 'unsupported_value'],
    [{ opportunity_stage: [null] }, 'opportunity_stage', 'invalid_type'],
    [{ priority: ['normal'] }, 'priority', 'unsupported_value'],
    [{ next_action_due: 'week' }, 'next_action_due', 'unsupported_value'],
    [{ stalled: 1 }, 'stalled', 'invalid_type'],
    [{ as_of: '2026-08-09T02:30:00Z' }, 'as_of', 'invalid_format'],
    [{ as_of: '2026-02-30T02:30:00.000Z' }, 'as_of', 'invalid_format'],
    [{ limit: null }, 'limit', 'invalid_type'],
    [{ limit: 101 }, 'limit', 'invalid_format'],
    [{ cursor: 'abc=' }, 'cursor', 'invalid_format'],
    [{ keyword: ' '.repeat(5) }, 'keyword', 'invalid_format'],
    [{ keyword: 'x'.repeat(241) }, 'keyword', 'invalid_format']
  ];

  for (const [input, field, reason] of cases) {
    assert.throws(() => canonicalizeCrmFilter(input), (error) => {
      assert.equal(error instanceof CrmContractError, true);
      assert.equal(error.code, 'CRM_CONTRACT_INVALID');
      assert.equal(error.field, field);
      assert.equal(error.reason, reason);
      assert.equal(error.status, 400);
      assert.equal(JSON.stringify(error).includes('x'.repeat(20)), false);
      return true;
    });
  }
});

test('all approved next-action buckets are exact and null means no due filter', () => {
  for (const value of ['overdue', 'today', 'next_7_days', 'later', 'none']) {
    assert.equal(canonicalizeCrmFilter({ next_action_due: value }).next_action_due, value);
  }
  assert.equal(canonicalizeCrmFilter({ next_action_due: null }).next_action_due, null);
});

test('filter fingerprint has a fixed golden vector and excludes pagination fields', () => {
  const canonical = canonicalizeCrmFilter(completeFilter());
  const expected = '27b9179954a3161344ecdeeeda6d6ecdd114d040c78600ba17ce4ab6aafcc36a';
  assert.equal(fingerprintCrmFilter(canonical), expected);
  assert.equal(fingerprintCrmFilter(completeFilter({ limit: 100, cursor: 'YWJj' })), expected);
  assert.equal(fingerprintCrmFilter(completeFilter({ customer_stage: ['lead', 'won'] })), expected);
  assert.notEqual(fingerprintCrmFilter(completeFilter({ scope: 'team' })), expected);
  assert.notEqual(fingerprintCrmFilter(completeFilter({ as_of: '2026-08-09T02:30:01.000Z' })), expected);
});

test('cursor v1 matches the fixed token and round-trips only sort keys', () => {
  const fingerprint = '27b9179954a3161344ecdeeeda6d6ecdd114d040c78600ba17ce4ab6aafcc36a';
  const token = encodeCrmCursor({ updated_at: '2026-08-09 10:30:00', id: 123 }, fingerprint);
  assert.equal(token, 'eyJ2IjoxLCJxIjoiMjdiOTE3OTk1NGEzMTYxMzQ0ZWNkZWVlZGE2ZDZlY2RkMTE0ZDA0MGM3ODYwMGJhMTdjZTRhYjZhYWZjYzM2YSIsInUiOiIyMDI2LTA4LTA5IDEwOjMwOjAwIiwiaSI6MTIzfQ');
  const decoded = decodeCrmCursor(token, fingerprint);
  assert.deepEqual(decoded, { updated_at: '2026-08-09 10:30:00', id: 123 });
  assert.equal(Object.isFrozen(decoded), true);
});

test('cursor decoder rejects malformed, noncanonical, tampered, and mismatched tokens', () => {
  const fingerprint = '27b9179954a3161344ecdeeeda6d6ecdd114d040c78600ba17ce4ab6aafcc36a';
  const other = 'a'.repeat(64);
  const encodePayload = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const base = { v: 1, q: fingerprint, u: '2026-08-09 10:30:00', i: 123 };
  const malformed = [
    '',
    'abc=',
    encodePayload({ ...base, v: 2 }),
    encodePayload({ ...base, q: fingerprint.toUpperCase() }),
    encodePayload({ ...base, u: '2026-02-30 10:30:00' }),
    encodePayload({ ...base, i: 0 }),
    encodePayload({ ...base, extra: true }),
    Buffer.from('{ "v":1,"q":"' + fingerprint + '","u":"2026-08-09 10:30:00","i":123}', 'utf8').toString('base64url'),
    Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')
  ];
  for (const token of malformed) {
    assert.throws(() => decodeCrmCursor(token, fingerprint), (error) => {
      assert.equal(error instanceof CrmContractError, true);
      assert.equal(error.code, 'CRM_CURSOR_INVALID');
      if (token) assert.equal(JSON.stringify(error).includes(token), false);
      return true;
    });
  }

  const validOther = encodePayload({ ...base, q: other });
  assert.throws(() => decodeCrmCursor(validOther, fingerprint), (error) => {
    assert.equal(error.code, 'CRM_CURSOR_FILTER_MISMATCH');
    assert.equal(error.field, 'cursor');
    assert.equal(error.reason, 'fingerprint_mismatch');
    return true;
  });
});

test('cursor encoder validates exact sort shape without coercion', () => {
  const fingerprint = '27b9179954a3161344ecdeeeda6d6ecdd114d040c78600ba17ce4ab6aafcc36a';
  for (const value of [
    null,
    { updated_at: '2026-08-09 10:30:00', id: '123' },
    { updated_at: '2026-02-30 10:30:00', id: 123 },
    { updated_at: '2026-08-09 10:30:00', id: 123, scope: 'organization' }
  ]) {
    assert.throws(() => encodeCrmCursor(value, fingerprint), (error) => {
      assert.equal(error.code, 'CRM_CURSOR_INVALID');
      return true;
    });
  }
});

test('contract errors serialize only the fixed public shape', () => {
  assert.throws(() => assertCustomerPriority('urgent'), (error) => {
    assert.deepEqual(JSON.parse(JSON.stringify(error)), {
      name: 'CrmContractError',
      code: 'CRM_CONTRACT_INVALID',
      field: 'priority',
      reason: 'unsupported_value',
      status: 400
    });
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'stack'), false);
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'message'), false);
    return true;
  });
});

test('filter and identity readers reject accessors, sparse arrays, symbols, and hostile containers without invoking getters', () => {
  let invoked = false;
  const filterAccessor = {};
  Object.defineProperty(filterAccessor, 'keyword', {
    enumerable: true,
    get() {
      invoked = true;
      return 'secret';
    }
  });
  assert.throws(() => canonicalizeCrmFilter(filterAccessor), CrmContractError);
  assert.equal(invoked, false);

  const identityAccessor = {};
  Object.defineProperty(identityAccessor, 'brand_name', {
    enumerable: true,
    get() {
      invoked = true;
      return 'Acme';
    }
  });
  assert.throws(() => buildCustomerIdentity(identityAccessor), CrmContractError);
  assert.equal(invoked, false);

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicalizeCrmFilter({ customer_stage: sparse }), CrmContractError);
  assert.throws(() => canonicalizeCrmFilter({ [Symbol('scope')]: 'my' }), CrmContractError);
  assert.throws(() => canonicalizeCrmFilter(new Proxy({}, {
    ownKeys() {
      throw new Error('hostile');
    }
  })), CrmContractError);
  assert.deepEqual(canonicalizeCrmFilter(Object.create(null)).customer_stage, []);
});

test('cursor APIs reject invalid fingerprints and bounded-token violations without reflecting input', () => {
  const validSort = { updated_at: '2026-08-09 10:30:00', id: 123 };
  for (const fingerprint of ['', 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(63)]) {
    assert.throws(() => encodeCrmCursor(validSort, fingerprint), (error) => {
      assert.equal(error.code, 'CRM_CURSOR_INVALID');
      assert.equal(error.field, 'fingerprint');
      assert.equal(JSON.stringify(error).includes(fingerprint || 'not-present'), false);
      return true;
    });
  }
  assert.throws(() => decodeCrmCursor('a'.repeat(513), '0'.repeat(64)), (error) => {
    assert.equal(error.code, 'CRM_CURSOR_INVALID');
    assert.equal(JSON.stringify(error).includes('a'.repeat(20)), false);
    return true;
  });
});
