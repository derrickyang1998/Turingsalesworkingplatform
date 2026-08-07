'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const FILE_HASH = 'a'.repeat(64);

function loadService() {
  return require('../services/performance_content_import_service');
}

function parsedRow(sourceRowNumber, url, extra = {}) {
  return Object.assign({
    source_row_number: sourceRowNumber,
    'Video URL': url
  }, extra);
}

function importRequest(rows, overrides = {}) {
  return Object.assign({
    campaign_id: 'campaign-7b1',
    rows,
    column_mapping: {
      content_url: 'Video URL'
    },
    mapping_version: 'mapping-v1',
    provenance: {
      source_mode: 'csv_xlsx',
      file_hash: FILE_HASH
    }
  }, overrides);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      assertDeepFrozen(descriptor.value, seen);
    }
  });
}

function expectServiceError(fn, expectedCode, expectedStatus = 400, expectedDetails = {}) {
  let capturedError;
  assert.throws(fn, (error) => {
    capturedError = error;
    assert.equal(error.name, 'PerformanceContentImportServiceError');
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, expectedStatus);
    assert.equal(error.statusCode, expectedStatus);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    Object.entries(expectedDetails).forEach(([key, value]) => {
      assert.equal(error.details[key], value);
    });
    assertDeepFrozen(error.details);
    return true;
  });
  return capturedError;
}

function assertBoundedSecretFreeError(error, secrets) {
  const disclosure = JSON.stringify({
    code: error.code,
    status: error.status,
    message: error.message,
    details: error.details
  });
  assert.ok(disclosure.length < 1024);
  secrets.forEach((secret) => {
    assert.equal(disclosure.includes(secret), false);
  });
}

function revokedProxy(target = {}) {
  const revocable = Proxy.revocable(target, {});
  revocable.revoke();
  return revocable.proxy;
}

const FULL_CELL = 'x'.repeat(8192);

function rowAtByteLimit(extraByte = false) {
  const row = parsedRow(2, 'https://example.com/row-limit');
  for (let index = 0; index < 7; index += 1) {
    row['P' + index] = FULL_CELL;
  }
  // 56 base bytes + 16 padding-key bytes + 57,344 full-cell bytes + tail.
  row.P7 = 'y'.repeat(extraByte ? 8121 : 8120);
  return row;
}

function aggregateBoundaryRows(limitPlusOne = false) {
  return Array.from({ length: 128 }, (_, index) => {
    const row = {
      source_row_number: 100000 + index,
      'Video URL': 'https://example.com/aggregate/' + String(index).padStart(3, '0')
    };
    for (let paddingIndex = 0; paddingIndex < 7; paddingIndex += 1) {
      row['P' + paddingIndex] = FULL_CELL;
    }
    // Every ordinary row is exactly 65,536 bytes under the scalar-byte contract.
    row.P7 = 'y'.repeat(8111);
    if (limitPlusOne && index === 127) {
      // The extra keys/value and 18-byte-shorter tail make this rejected row 65,537 bytes.
      row['A Invalid'] = { nested: true };
      row.P7 = 'y'.repeat(8093);
    }
    return row;
  });
}

function structurallyRejectedAggregateRows() {
  const paddingA = 'a'.repeat(6000);
  const paddingB = 'b'.repeat(6000);
  const paddingCLong = 'c'.repeat(5980);
  const paddingCShort = 'c'.repeat(5979);
  return Array.from({ length: 500 }, (_, index) => {
    const row = {
      source_row_number: 100000 + index,
      'Video URL': 'https://example.com/rejected/' + String(index).padStart(3, '0'),
      'Padding A': paddingA,
      'Padding B': paddingB,
      'Padding C': index < 284 ? paddingCLong : paddingCShort
    };
    Object.defineProperty(row, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'blocked',
      writable: true
    });
    return row;
  });
}

function mixedAggregateRows() {
  const acceptedPadding = 'a'.repeat(6000);
  const oversizedPadding = 'a'.repeat(8193);
  const rejectedTail = 'c'.repeat(3807);
  return Array.from({ length: 500 }, (_, index) => parsedRow(
    200000 + index,
    'https://example.com/mixed/' + String(index).padStart(3, '0'),
    index % 2 === 0
      ? {
          'Padding A': acceptedPadding,
          'Padding B': acceptedPadding,
          'Padding C': acceptedPadding
        }
      : {
          'Padding A': oversizedPadding,
          'Padding B': acceptedPadding,
          'Padding C': rejectedTail
        }
  ));
}

const INVALID_AGGREGATE_BOUNDARY_CASES = [
  {
    name: 'primitive row',
    rowsAtBoundary(limitPlusOne) {
      return ['x'.repeat(8388608 + (limitPlusOne ? 1 : 0))];
    }
  },
  {
    name: 'array row',
    rowsAtBoundary(limitPlusOne) {
      return [['x'.repeat(8388608 + (limitPlusOne ? 1 : 0))]];
    }
  },
  {
    name: 'nested ordinary cell',
    rowsAtBoundary(limitPlusOne) {
      // "Extra" + "payload" contribute 12 bytes to the aggregate contract.
      return [{
        Extra: {
          payload: 'x'.repeat(8388596 + (limitPlusOne ? 1 : 0))
        }
      }];
    }
  }
];

function sharedBinaryDag(depth, leafPayloadBytes = 16) {
  const containers = new WeakSet();
  let root = { payload: 'x'.repeat(leafPayloadBytes) };
  containers.add(root);
  for (let level = 0; level < depth; level += 1) {
    root = { left: root, right: root };
    containers.add(root);
  }
  return { containers, root };
}

const SHARED_CYCLE_VARIANTS = Object.freeze([
  { entryPoint: 'a', keyOrder: Object.freeze(['aa', 'bb']) },
  { entryPoint: 'b', keyOrder: Object.freeze(['aa', 'bb']) },
  { entryPoint: 'a', keyOrder: Object.freeze(['bb', 'aa']) },
  { entryPoint: 'b', keyOrder: Object.freeze(['bb', 'aa']) }
]);

function sharedTwoNodeCycleRoot(keyOrder, entryPoint, calls, secret) {
  const trappedProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      calls.proxy += 1;
      throw new Error('cycle Proxy descriptor trap executed');
    },
    ownKeys() {
      calls.proxy += 1;
      throw new Error('cycle Proxy ownKeys trap executed');
    }
  });
  const a = { payload: secret + 'x'.repeat(5 * 1024 * 1024) };
  const b = { marker: 'b' };

  [a, b].forEach((node) => {
    Object.defineProperty(node, 'accessor', {
      configurable: true,
      enumerable: true,
      get() {
        calls.accessor += 1;
        throw new Error('cycle accessor executed');
      }
    });
    Object.defineProperty(node, Symbol.iterator, {
      configurable: true,
      enumerable: true,
      get() {
        calls.iterator += 1;
        throw new Error('cycle iterator getter executed');
      }
    });
    Object.defineProperty(node, Symbol.toPrimitive, {
      configurable: true,
      enumerable: true,
      get() {
        calls.coercion += 1;
        throw new Error('cycle coercion getter executed');
      }
    });
    node.trappedProxy = trappedProxy;
  });
  a.peer = b;
  b.peer = a;

  const entries = entryPoint === 'a'
    ? { aa: a, bb: b }
    : { aa: b, bb: a };
  const root = {};
  keyOrder.forEach((key) => {
    root[key] = entries[key];
  });
  return root;
}

function nestedContainerChain(containerCount) {
  let root = {};
  for (let index = 1; index < containerCount; index += 1) {
    root = { next: root };
  }
  return root;
}

function uniqueContainerBudgetGraph() {
  const root = {};
  for (let index = 0; index < 4095; index += 1) {
    root['child_' + index] = {};
  }
  return root;
}

function descriptorBudgetGraph() {
  const root = {};
  for (let containerIndex = 0; containerIndex < 1000; containerIndex += 1) {
    const child = {};
    const descriptorCount = containerIndex < 998 ? 79 : 78;
    for (let descriptorIndex = 0; descriptorIndex < descriptorCount; descriptorIndex += 1) {
      child['value_' + descriptorIndex] = null;
    }
    root['child_' + containerIndex] = child;
  }
  return root;
}

function wideSharedDagGraph() {
  const shared = {};
  const root = {};
  for (let index = 0; index < 8191; index += 1) {
    root['occurrence_' + index] = shared;
  }
  return root;
}

function descriptorProbeRow(descriptorCount, finalValue = null) {
  const row = {};
  for (let index = 0; index < descriptorCount; index += 1) {
    const key = 'probe_' + String(index).padStart(6, '0');
    row[key] = index === descriptorCount - 1 ? finalValue : null;
  }
  return row;
}

function overWideSelfCycleRow(selfPosition) {
  const row = {};
  if (selfPosition === 'first') row.self = row;
  for (let index = 0; index < 80000; index += 1) {
    row['probe_' + String(index).padStart(6, '0')] = null;
  }
  if (selfPosition === 'last') row.self = row;
  return row;
}

function observeDescriptorInspection(target, action) {
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const originalOwnKeys = Reflect.ownKeys;
  const counts = {
    bulkDescriptorSnapshots: 0,
    individualDescriptorReads: 0,
    ownKeyEnumerations: 0
  };

  Object.getOwnPropertyDescriptors = function forbiddenBulkDescriptorSnapshot(value) {
    if (value === target) {
      counts.bulkDescriptorSnapshots += 1;
      throw new Error('bulk descriptor snapshot attempted for aggregate probe');
    }
    return Reflect.apply(originalGetOwnPropertyDescriptors, Object, [value]);
  };
  Object.getOwnPropertyDescriptor = function countedDescriptorRead(value, key) {
    if (value === target) counts.individualDescriptorReads += 1;
    return Reflect.apply(originalGetOwnPropertyDescriptor, Object, [value, key]);
  };
  Reflect.ownKeys = function countedOwnKeys(value) {
    if (value === target) counts.ownKeyEnumerations += 1;
    return Reflect.apply(originalOwnKeys, Reflect, [value]);
  };

  let result;
  try {
    result = action();
  } finally {
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
    Reflect.ownKeys = originalOwnKeys;
  }
  return { counts, result };
}

function observeNamedDescriptorInspection(targets, action) {
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const originalOwnKeys = Reflect.ownKeys;
  const namesByTarget = new Map(
    Object.entries(targets).map(([name, target]) => [target, name])
  );
  const counts = {
    bulkDescriptorSnapshots: {},
    individualDescriptorReads: {},
    ownKeyEnumerations: {}
  };

  Object.keys(targets).forEach((name) => {
    counts.bulkDescriptorSnapshots[name] = 0;
    counts.individualDescriptorReads[name] = 0;
    counts.ownKeyEnumerations[name] = 0;
  });

  Object.getOwnPropertyDescriptors = function forbiddenBulkDescriptorSnapshot(value) {
    const name = namesByTarget.get(value);
    if (name !== undefined) {
      counts.bulkDescriptorSnapshots[name] += 1;
      throw new Error('bulk descriptor snapshot attempted for aggregate probe');
    }
    return Reflect.apply(originalGetOwnPropertyDescriptors, Object, [value]);
  };
  Object.getOwnPropertyDescriptor = function countedDescriptorRead(value, key) {
    const name = namesByTarget.get(value);
    if (name !== undefined) counts.individualDescriptorReads[name] += 1;
    return Reflect.apply(originalGetOwnPropertyDescriptor, Object, [value, key]);
  };
  Reflect.ownKeys = function countedOwnKeys(value) {
    const name = namesByTarget.get(value);
    if (name !== undefined) counts.ownKeyEnumerations[name] += 1;
    return Reflect.apply(originalOwnKeys, Reflect, [value]);
  };

  let result;
  try {
    result = action();
  } finally {
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
    Reflect.ownKeys = originalOwnKeys;
  }
  return { counts, result };
}

function exactFillCompetingRoot(fillerCount, branches, branchOrder) {
  const root = {};
  for (let index = 0; index < fillerCount; index += 1) {
    root['filler_' + String(index).padStart(6, '0')] = null;
  }
  branchOrder.forEach((name) => {
    root[name] = branches[name];
  });
  return root;
}

function exactFillCycleFixture(branchOrder) {
  const hooks = { accessor: 0, proxy: 0 };
  const trappedProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      hooks.proxy += 1;
      throw new Error('exact-fill Proxy descriptor trap executed');
    },
    ownKeys() {
      hooks.proxy += 1;
      throw new Error('exact-fill Proxy ownKeys trap executed');
    }
  });
  const acyclic = {};
  Object.defineProperty(acyclic, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      hooks.accessor += 1;
      return trappedProxy;
    }
  });
  const cycle = {};
  cycle.self = cycle;
  const root = exactFillCompetingRoot(
    199997,
    { acyclic, cycle },
    branchOrder
  );
  return { acyclic, cycle, hooks, root };
}

function exactFillMutualCycleFixture(branchOrder) {
  const a = {};
  const b = {};
  a.peer = b;
  b.peer = a;
  const root = exactFillCompetingRoot(
    199997,
    { a, b },
    branchOrder
  );
  return { a, b, root };
}

function mixedWidthExactFillMutualCycleFixture(branchOrder) {
  const a = {};
  const b = {};
  a.peer = b;
  a.scalar_1 = null;
  a.scalar_2 = null;
  a.scalar_3 = null;
  b.peer = a;
  const root = exactFillCompetingRoot(
    199994,
    { a, b },
    branchOrder
  );
  return { a, b, root };
}

function exactFillSymbolFixture(branchOrder) {
  const hooks = { accessor: 0, proxy: 0, symbolDescription: 0, symbolToString: 0 };
  const trappedProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      hooks.proxy += 1;
      throw new Error('exact-fill symbol Proxy descriptor trap executed');
    },
    ownKeys() {
      hooks.proxy += 1;
      throw new Error('exact-fill symbol Proxy ownKeys trap executed');
    }
  });
  const acyclic = {};
  ['first', 'second'].forEach((key) => {
    Object.defineProperty(acyclic, key, {
      configurable: true,
      enumerable: true,
      get() {
        hooks.accessor += 1;
        return trappedProxy;
      }
    });
  });
  const symbols = {};
  [Symbol('first'), Symbol('second')].forEach((key) => {
    Object.defineProperty(symbols, key, {
      configurable: true,
      enumerable: true,
      get() {
        hooks.accessor += 1;
        return trappedProxy;
      }
    });
  });
  const root = exactFillCompetingRoot(
    199996,
    { acyclic, symbols },
    branchOrder
  );
  return { acyclic, hooks, root, symbols };
}

function saturatedDeferredFrontierCycleFixture(cyclePosition) {
  const shared = { value: null };
  const cycle = {};
  cycle.self = cycle;
  const root = {};
  for (let index = 0; index < 191806; index += 1) {
    root['filler_' + String(index).padStart(6, '0')] = null;
  }
  if (cyclePosition === 'before-aliases') root.cycle = cycle;
  for (let index = 0; index < 8192; index += 1) {
    root['alias_' + String(index).padStart(4, '0')] = shared;
  }
  if (cyclePosition === 'after-aliases') root.cycle = cycle;
  return { cycle, root, shared };
}

function wideSharedExactFillFixture() {
  const shared = descriptorProbeRow(199984);
  const root = {};
  for (let index = 0; index < 16; index += 1) {
    root['alias_' + String(index).padStart(2, '0')] = shared;
  }
  return { root, shared };
}

function captureThrownError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected action to throw');
}

function addWideDecorations(target, prefix, count = 200000) {
  for (let index = 0; index < count; index += 1) {
    target[prefix + index] = null;
  }
  return target;
}

test('prepares a campaign-scoped CSV/XLSX row as an immutable import draft', () => {
  const { preparePerformanceContentImport } = loadService();
  const result = preparePerformanceContentImport(importRequest([{
    source_row_number: 2,
    'Video URL': 'https://youtu.be/dQw4w9WgXcQ?utm_source=sheet',
    Creator: 'creator-1'
  }], {
    column_mapping: {
      content_url: 'Video URL',
      creator_id: 'Creator'
    }
  }));

  assert.equal(result.contract_version, 'phase7b.1-content-import-v1');
  assert.equal(result.total_count, 1);
  assert.equal(result.accepted_count, 1);
  assert.equal(result.duplicate_count, 0);
  assert.equal(result.rejected_count, 0);
  assert.equal(result.drafts[0].campaign_id, 'campaign-7b1');
  assert.equal(result.drafts[0].source_row_number, 2);
  assert.equal(result.drafts[0].source_mode, 'csv_xlsx');
  assert.equal(result.drafts[0].file_hash, FILE_HASH);
  assert.equal(result.drafts[0].mapping_version, 'mapping-v1');
  assert.equal(result.drafts[0].original_url, 'https://youtu.be/dQw4w9WgXcQ?utm_source=sheet');
  assert.equal(result.drafts[0].canonical_identity, 'youtube:dQw4w9WgXcQ');
  assert.equal(result.drafts[0].creator_id, 'creator-1');
  assert.equal(result.drafts[0].creator_name, null);
  assert.deepEqual(result.drafts[0].tags, []);
  assert.equal(result.drafts[0].product, null);
  assert.equal(result.drafts[0].published_at, null);
  assert.deepEqual(result.drafts[0].custom_fields, {});
  assert.strictEqual(result.rows[0].draft, result.drafts[0]);
  assertDeepFrozen(result);
});

test('imports ten mixed-platform rows while isolating malformed and secret-bearing links', () => {
  const { preparePerformanceContentImport } = loadService();
  const credentialSecret = 'CSV_IMPORT_CREDENTIAL_SECRET';
  const rows = [
    parsedRow(2, 'https://www.tiktok.com/@Creator/video/7351234567890123456?utm_source=share'),
    parsedRow(3, 'https://instagram.com/reels/CODE_123/?igsh=tracking-value'),
    parsedRow(4, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=social'),
    parsedRow(5, 'https://youtu.be/dQw4w9WgXcQ?si=share-token'),
    parsedRow(6, 'https://m.facebook.com/reel/123456789012345/?mibextid=share'),
    parsedRow(7, 'https://twitter.com/Alice/status/1781234567890123456?s=20'),
    parsedRow(8, 'https://x.com/i/web/status/1781234567890123456?t=share'),
    parsedRow(9, 'https://news.example.com/story?id=42&utm_medium=social'),
    parsedRow(10, 'not a url'),
    parsedRow(11, 'https://user:' + credentialSecret + '@www.instagram.com/p/CODE_999/')
  ];

  const result = preparePerformanceContentImport(importRequest(rows));

  assert.deepEqual({
    total_count: result.total_count,
    accepted_count: result.accepted_count,
    duplicate_count: result.duplicate_count,
    rejected_count: result.rejected_count
  }, {
    total_count: 10,
    accepted_count: 6,
    duplicate_count: 2,
    rejected_count: 2
  });
  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted',
    'accepted',
    'accepted',
    'duplicate',
    'accepted',
    'accepted',
    'duplicate',
    'accepted',
    'rejected',
    'rejected'
  ]);
  assert.deepEqual(result.rows.slice(0, 8).map((row) => row.platform), [
    'tiktok',
    'instagram',
    'youtube',
    'youtube',
    'facebook',
    'x',
    'x',
    'custom_manual'
  ]);
  assert.equal(result.rows[3].original_url, rows[3]['Video URL']);
  assert.equal(result.rows[6].original_url, rows[6]['Video URL']);
  assert.equal(result.rows[8].original_url, null);
  assert.equal(result.rows[9].original_url, null);
  assert.equal(result.rows[8].error.code, 'PUBLICATION_URL_HTTPS_REQUIRED');
  assert.equal(result.rows[9].error.code, 'PUBLICATION_URL_CREDENTIALS_FORBIDDEN');
  assert.equal(JSON.stringify(result).includes(credentialSecret), false);
  assert.equal(result.drafts.length, 6);
});

test('canonical duplicates keep deterministic first-row and source-row lineage without extra drafts', () => {
  const { preparePerformanceContentImport } = loadService();
  const urls = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=first',
    'https://youtu.be/dQw4w9WgXcQ?si=second',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=third'
  ];
  const result = preparePerformanceContentImport(importRequest([
    parsedRow(7, urls[0], { Creator: 'first-creator' }),
    parsedRow(42, urls[1], { Creator: 'second-creator' }),
    parsedRow(99, urls[2], { Creator: 'third-creator' })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      creator_name: 'Creator'
    }
  }));

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'duplicate', 'duplicate'
  ]);
  assert.deepEqual(result.rows.map((row) => row.first_index), [0, 0, 0]);
  assert.deepEqual(result.rows.map((row) => row.first_source_row_number), [7, 7, 7]);
  assert.deepEqual(result.rows.map((row) => row.duplicate_of_source_row_number), [
    null, 7, 7
  ]);
  assert.equal(result.rows[1].original_url, urls[1]);
  assert.equal(result.rows[2].original_url, urls[2]);
  assert.equal(result.rows[1].draft, null);
  assert.equal(result.rows[2].draft, null);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].creator_name, 'first-creator');
});

test('duplicate source row numbers fail deterministically before canonical URL deduplication', () => {
  const { preparePerformanceContentImport } = loadService();
  const request = importRequest([
    parsedRow(2, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=first'),
    parsedRow(2, 'https://youtu.be/dQw4w9WgXcQ?si=duplicate-source-row')
  ]);

  assert.throws(() => preparePerformanceContentImport(request), (error) => {
    assert.equal(error.name, 'PerformanceContentImportServiceError');
    assert.equal(error.code, 'PERFORMANCE_CONTENT_IMPORT_SOURCE_ROW_NUMBER_DUPLICATE');
    assert.equal(error.status, 400);
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.details, {
      field: 'rows',
      index: 1,
      reason: 'duplicate_source_row_number',
      source_row_number: 2
    });
    assertDeepFrozen(error.details);
    return true;
  });
});

test('preserves mapping provenance and builds a stable custom-field search payload', () => {
  const { preparePerformanceContentImport } = loadService();
  const tags = ['launch', 'how-to'];
  const sourceRow = {
    source_row_number: 17,
    '视频链接': 'https://www.instagram.com/reel/CODE_123/?igsh=drop',
    '达人 ID': 'creator-17',
    '达人名称': 'Alice Example',
    '标签': tags,
    '产品': 'Widget Pro',
    '发布时间': '2026-07-30T08:15:30+08:00',
    '内容角度': 'problem-solution',
    Priority: 2,
    Approved: true
  };
  const customFields = {
    priority: 'Priority',
    creative_angle: '内容角度',
    approved: 'Approved',
    missing_note: 'Missing Note'
  };
  const mapping = {
    video_url: '视频链接',
    creator_id: '达人 ID',
    creator_name: '达人名称',
    tags: '标签',
    product: '产品',
    published_at: '发布时间',
    custom_fields: customFields
  };

  const result = preparePerformanceContentImport(importRequest([sourceRow], {
    column_mapping: mapping,
    mapping_version: 'mapping-2026-07-v3',
    provenance: {
      source_mode: 'csv_xlsx',
      file_hash: 'b'.repeat(64)
    }
  }));
  const draft = result.drafts[0];

  assert.deepEqual(result.column_mapping, {
    content_url: '视频链接',
    creator_id: '达人 ID',
    creator_name: '达人名称',
    tags: '标签',
    product: '产品',
    published_at: '发布时间',
    custom_fields: {
      approved: 'Approved',
      creative_angle: '内容角度',
      missing_note: 'Missing Note',
      priority: 'Priority'
    }
  });
  assert.equal(draft.source_row_number, 17);
  assert.equal(draft.source_mode, 'csv_xlsx');
  assert.equal(draft.file_hash, 'b'.repeat(64));
  assert.equal(draft.mapping_version, 'mapping-2026-07-v3');
  assert.equal(draft.published_at, '2026-07-30T08:15:30+08:00');
  assert.deepEqual(draft.tags, ['launch', 'how-to']);
  assert.deepEqual(draft.custom_fields, {
    approved: true,
    creative_angle: 'problem-solution',
    missing_note: null,
    priority: 2
  });
  assert.deepEqual(draft.search_payload, {
    creator_id: 'creator-17',
    creator_name: 'Alice Example',
    original_url: 'https://www.instagram.com/reel/CODE_123/?igsh=drop',
    canonical_url: 'https://www.instagram.com/reel/CODE_123/',
    canonical_identity: 'instagram:CODE_123',
    platform_content_id: 'CODE_123',
    tags: ['launch', 'how-to'],
    product: 'Widget Pro',
    custom_fields: {
      approved: true,
      creative_angle: 'problem-solution',
      missing_note: null,
      priority: 2
    }
  });

  sourceRow['达人名称'] = 'mutated';
  tags.push('mutated');
  customFields.priority = 'Changed';
  mapping.product = 'Changed';
  assert.equal(draft.creator_name, 'Alice Example');
  assert.deepEqual(draft.tags, ['launch', 'how-to']);
  assert.equal(draft.custom_fields.priority, 2);
  assert.equal(result.column_mapping.product, '产品');
  assertDeepFrozen(result);
});

test('invalid row metadata and malformed URLs become safe row errors without aborting neighbors', () => {
  const { preparePerformanceContentImport } = loadService();
  const malformedSecret = 'MALFORMED_LINK_SECRET';
  const metadataSecret = 'METADATA_ROW_URL_SECRET';
  const invalidMetadata = { nested: true };
  const result = preparePerformanceContentImport(importRequest([
    parsedRow(2, 'https://example.com/valid'),
    parsedRow(3, 'not-a-url?' + malformedSecret),
    parsedRow(4, 'https://example.com/' + metadataSecret, { Notes: invalidMetadata })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      custom_fields: { notes: 'Notes' }
    }
  }));
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'rejected', 'rejected'
  ]);
  assert.equal(result.rows[1].error.code, 'PUBLICATION_URL_HTTPS_REQUIRED');
  assert.equal(result.rows[2].error.code, 'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID');
  assert.equal(result.rows[1].original_url_disclosure, 'withheld_rejected_input');
  assert.equal(result.rows[2].original_url_disclosure, 'withheld_rejected_input');
  assert.equal(serialized.includes(malformedSecret), false);
  assert.equal(serialized.includes(metadataSecret), false);
  assert.equal(result.accepted_count, 1);
  assert.equal(result.rejected_count, 2);
});

test('rejects sparse, accessor-backed, Proxy, and decorated rows arrays before row access', () => {
  const { preparePerformanceContentImport } = loadService();
  const sparse = new Array(2);
  sparse[0] = parsedRow(2, 'https://example.com/one');
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(sparse)),
    'PERFORMANCE_CONTENT_IMPORT_ROWS_MUST_BE_DENSE'
  );

  let getterCalls = 0;
  const accessorRows = [];
  Object.defineProperty(accessorRows, '0', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error('row getter executed');
    }
  });
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(accessorRows)),
    'PERFORMANCE_CONTENT_IMPORT_ROWS_ACCESSOR_FORBIDDEN'
  );
  assert.equal(getterCalls, 0);

  const proxyRows = new Proxy([], {
    getOwnPropertyDescriptor() {
      throw new Error('rows Proxy trap executed');
    }
  });
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(proxyRows)),
    'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_UNSAFE'
  );

  const decorated = [parsedRow(2, 'https://example.com/one')];
  decorated.metadata = 'unexpected';
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(decorated)),
    'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_INVALID'
  );
});

[
  {
    name: 'request',
    expectedCode: 'PERFORMANCE_CONTENT_IMPORT_REQUEST_FIELD_UNKNOWN',
    expectedDescriptorReads: 0,
    build() {
      const request = addWideDecorations(
        importRequest([parsedRow(2, 'https://example.com/wide-request')]),
        'unexpected_request_'
      );
      return { request, target: request };
    }
  },
  {
    name: 'mapping',
    expectedCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_FIELD_UNKNOWN',
    expectedDescriptorReads: 0,
    build() {
      const mapping = addWideDecorations(
        { content_url: 'Video URL' },
        'unexpected_mapping_'
      );
      return {
        request: importRequest([parsedRow(2, 'https://example.com/wide-mapping')], {
          column_mapping: mapping
        }),
        target: mapping
      };
    }
  },
  {
    name: 'decorated rows',
    expectedCode: 'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_INVALID',
    expectedDescriptorReads: 1,
    build() {
      const rows = addWideDecorations(
        [parsedRow(2, 'https://example.com/wide-rows')],
        'unexpected_rows_'
      );
      return { request: importRequest(rows), target: rows };
    }
  }
].forEach((contractCase) => {
  test(
    'rejects a 200,000-property ' + contractCase.name +
      ' container before bulk or unbounded descriptor reads',
    () => {
      const { preparePerformanceContentImport } = loadService();
      const probe = contractCase.build();
      const observed = observeDescriptorInspection(
        probe.target,
        () => captureThrownError(() => preparePerformanceContentImport(probe.request))
      );

      assert.deepEqual(observed.counts, {
        bulkDescriptorSnapshots: 0,
        individualDescriptorReads: contractCase.expectedDescriptorReads,
        ownKeyEnumerations: 1
      });
      assert.equal(observed.result.name, 'PerformanceContentImportServiceError');
      assert.equal(observed.result.code, contractCase.expectedCode);
      assert.equal(observed.result.status, 400);
      assertDeepFrozen(observed.result.details);
    }
  );
});

test('unsafe row objects and cell accessors are rejected per row without invoking traps', () => {
  const { preparePerformanceContentImport } = loadService();
  let rowProxyCalls = 0;
  const rowProxy = new Proxy({}, {
    ownKeys() {
      rowProxyCalls += 1;
      throw new Error('row Proxy trap executed');
    }
  });
  let urlGetterCalls = 0;
  const accessorRow = { source_row_number: 3 };
  Object.defineProperty(accessorRow, 'Video URL', {
    enumerable: true,
    get() {
      urlGetterCalls += 1;
      throw new Error('URL getter executed');
    }
  });

  const result = preparePerformanceContentImport(importRequest([
    rowProxy,
    accessorRow,
    parsedRow(4, 'https://example.com/valid')
  ]));

  assert.equal(rowProxyCalls, 0);
  assert.equal(urlGetterCalls, 0);
  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'rejected', 'rejected', 'accepted'
  ]);
  assert.equal(result.rows[0].error.code, 'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_UNSAFE');
  assert.equal(result.rows[1].error.code, 'PERFORMANCE_CONTENT_IMPORT_ROW_ACCESSOR_FORBIDDEN');
});

test('revoked Proxy request scalar fields return documented service errors instead of TypeError', () => {
  const { preparePerformanceContentImport } = loadService();
  const rows = [parsedRow(2, 'https://example.com/valid')];

  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      campaign_id: revokedProxy()
    })),
    'PERFORMANCE_CONTENT_IMPORT_CAMPAIGN_ID_INVALID'
  );
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      mapping_version: revokedProxy()
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_VERSION_INVALID'
  );
});

test('revoked Proxy mapping containers and source-column values fail with mapping service errors', () => {
  const { preparePerformanceContentImport } = loadService();
  const rows = [parsedRow(2, 'https://example.com/valid')];

  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: revokedProxy()
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_CONTAINER_UNSAFE'
  );
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: { content_url: revokedProxy() }
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_COLUMN_INVALID'
  );
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: {
        content_url: 'Video URL',
        custom_fields: revokedProxy()
      }
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_CONTAINER_UNSAFE'
  );
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      provenance: revokedProxy()
    })),
    'PERFORMANCE_CONTENT_IMPORT_PROVENANCE_CONTAINER_UNSAFE'
  );
});

test('revoked Proxy row cells become safe row errors without aborting valid neighbors', () => {
  const { preparePerformanceContentImport } = loadService();
  const secrets = [
    'REVOKED_EXTRA_CELL_SECRET',
    'REVOKED_CREATOR_CELL_SECRET',
    'REVOKED_CUSTOM_CELL_SECRET',
    'REVOKED_TAGS_CELL_SECRET'
  ];
  const result = preparePerformanceContentImport(importRequest([
    parsedRow(2, 'https://example.com/valid-first'),
    parsedRow(3, 'https://example.com/' + secrets[0], { Extra: revokedProxy() }),
    parsedRow(4, 'https://example.com/' + secrets[1], { Creator: revokedProxy() }),
    parsedRow(5, 'https://example.com/' + secrets[2], { Custom: revokedProxy() }),
    parsedRow(6, 'https://example.com/' + secrets[3], { Tags: revokedProxy([]) }),
    parsedRow(7, 'https://example.com/valid-last')
  ], {
    column_mapping: {
      content_url: 'Video URL',
      creator_name: 'Creator',
      tags: 'Tags',
      custom_fields: { custom: 'Custom' }
    }
  }));
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'rejected', 'rejected', 'rejected', 'rejected', 'accepted'
  ]);
  assert.deepEqual(result.rows.slice(1, 5).map((row) => row.error.code), [
    'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
    'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
    'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
    'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID'
  ]);
  assert.equal(result.accepted_count, 2);
  assert.equal(result.rejected_count, 4);
  secrets.forEach((secret) => {
    assert.equal(serialized.includes(secret), false);
  });
});

test('mapping validation rejects unknown system fields, deliverables, ambiguity, and dangerous keys', () => {
  const { preparePerformanceContentImport } = loadService();
  const rows = [parsedRow(2, 'https://example.com/valid')];

  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: { content_url: 'Video URL', owner: 'Owner' }
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_FIELD_UNKNOWN'
  );
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: { content_url: 'Video URL', deliverable_id: 'Deliverable' }
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_FIELD_UNKNOWN'
  );
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: { creator_id: 'Creator' }
    })),
    'PERFORMANCE_CONTENT_IMPORT_URL_MAPPING_REQUIRED'
  );
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: { content_url: 'Video URL', video_url: 'Other URL' }
    })),
    'PERFORMANCE_CONTENT_IMPORT_URL_MAPPING_AMBIGUOUS'
  );

  const dangerousCustomFields = JSON.parse('{"__proto__":"Dangerous Column"}');
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: {
        content_url: 'Video URL',
        custom_fields: dangerousCustomFields
      }
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_DANGEROUS_KEY'
  );

  let mappingGetterCalls = 0;
  const accessorMapping = { content_url: 'Video URL' };
  Object.defineProperty(accessorMapping, 'creator_name', {
    enumerable: true,
    get() {
      mappingGetterCalls += 1;
      throw new Error('mapping getter executed');
    }
  });
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: accessorMapping
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_ACCESSOR_FORBIDDEN'
  );
  assert.equal(mappingGetterCalls, 0);
});

test('custom mapping errors disclose only the fixed custom_fields identifier', () => {
  const { preparePerformanceContentImport } = loadService();
  const secret = 'CUSTOM_MAPPING_NAME_SECRET_SENTINEL';
  const error = expectServiceError(
    () => preparePerformanceContentImport(importRequest([
      parsedRow(2, 'https://example.com/custom-mapping-redaction')
    ], {
      column_mapping: {
        content_url: 'Video URL',
        custom_fields: { [secret]: 'source_row_number' }
      }
    })),
    'PERFORMANCE_CONTENT_IMPORT_MAPPING_DANGEROUS_KEY',
    400,
    {
      field: 'column_mapping',
      system_field: 'custom_fields',
      reason: 'reserved_or_dangerous'
    }
  );

  assertBoundedSecretFreeError(error, [secret]);
});

test('campaign, mapping version, and CSV/XLSX provenance fail closed when malformed', () => {
  const { preparePerformanceContentImport } = loadService();
  const rows = [parsedRow(2, 'https://example.com/valid')];
  const cases = [
    [
      importRequest(rows, { campaign_id: '' }),
      'PERFORMANCE_CONTENT_IMPORT_CAMPAIGN_ID_INVALID'
    ],
    [
      importRequest(rows, { mapping_version: '' }),
      'PERFORMANCE_CONTENT_IMPORT_MAPPING_VERSION_INVALID'
    ],
    [
      importRequest(rows, {
        provenance: { source_mode: 'provider_api', file_hash: FILE_HASH }
      }),
      'PERFORMANCE_CONTENT_IMPORT_SOURCE_MODE_INVALID'
    ],
    [
      importRequest(rows, {
        provenance: { source_mode: 'csv_xlsx', file_hash: 'A'.repeat(64) }
      }),
      'PERFORMANCE_CONTENT_IMPORT_FILE_HASH_INVALID'
    ],
    [
      importRequest(rows, {
        provenance: { source_mode: 'csv_xlsx', file_hash: 'a'.repeat(63) }
      }),
      'PERFORMANCE_CONTENT_IMPORT_FILE_HASH_INVALID'
    ]
  ];

  cases.forEach(([request, code]) => {
    expectServiceError(() => preparePerformanceContentImport(request), code);
  });

  const requestProxy = new Proxy({}, {
    ownKeys() {
      throw new Error('request Proxy trap executed');
    }
  });
  expectServiceError(
    () => preparePerformanceContentImport(requestProxy),
    'PERFORMANCE_CONTENT_IMPORT_REQUEST_CONTAINER_UNSAFE'
  );
});

test('rejects dangerous row keys and nested, oversized, or non-scalar metadata safely', () => {
  const { preparePerformanceContentImport } = loadService();
  const dangerous = JSON.parse([
    '{',
    '"source_row_number":2,',
    '"Video URL":"https://example.com/DANGEROUS_ROW_SECRET",',
    '"__proto__":"pollute"',
    '}'
  ].join(''));
  const nested = { detail: { value: 'nested' } };
  const nonScalar = new Date(0);
  const oversizedRow = parsedRow(6, 'https://example.com/oversized-row');
  for (let index = 0; index < 70; index += 1) {
    oversizedRow['Extra ' + index] = 'x'.repeat(1000);
  }

  const result = preparePerformanceContentImport(importRequest([
    dangerous,
    parsedRow(3, 'https://example.com/nested', { Notes: nested }),
    parsedRow(4, 'https://example.com/non-scalar', { Notes: nonScalar }),
    parsedRow(5, 'https://example.com/long', { Notes: 'x'.repeat(2049) }),
    oversizedRow,
    parsedRow(7, 'https://example.com/creator', { Creator: 'x'.repeat(257) })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      creator_name: 'Creator',
      custom_fields: { notes: 'Notes' }
    }
  }));

  assert.deepEqual(result.rows.map((row) => row.error.code), [
    'PERFORMANCE_CONTENT_IMPORT_ROW_DANGEROUS_KEY',
    'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
    'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
    'PERFORMANCE_CONTENT_IMPORT_ROW_CUSTOM_FIELD_TOO_LARGE',
    'PERFORMANCE_CONTENT_IMPORT_ROW_TOO_LARGE',
    'PERFORMANCE_CONTENT_IMPORT_ROW_FIELD_TOO_LARGE'
  ]);
  assert.equal(JSON.stringify(result).includes('DANGEROUS_ROW_SECRET'), false);
  assert.equal(result.rejected_count, 6);
});

test('published timestamps must be strict real RFC3339 instants and remain unmodified', () => {
  const { preparePerformanceContentImport } = loadService();
  const result = preparePerformanceContentImport(importRequest([
    parsedRow(2, 'https://example.com/leap-day', {
      Published: '2024-02-29T23:59:59+08:00'
    }),
    parsedRow(3, 'https://example.com/impossible-day', {
      Published: '2026-02-30T00:00:00Z'
    }),
    parsedRow(4, 'https://example.com/no-zone', {
      Published: '2026-07-30 08:00:00'
    })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      published_at: 'Published'
    }
  }));

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'rejected', 'rejected'
  ]);
  assert.equal(result.drafts[0].published_at, '2024-02-29T23:59:59+08:00');
  assert.equal(result.rows[1].error.code, 'PERFORMANCE_CONTENT_IMPORT_ROW_TIMESTAMP_INVALID');
  assert.equal(result.rows[2].error.code, 'PERFORMANCE_CONTENT_IMPORT_ROW_TIMESTAMP_INVALID');
});

test('tags accept bounded arrays or comma cells and reject malformed collections', () => {
  const { preparePerformanceContentImport } = loadService();
  const sparseTags = new Array(2);
  sparseTags[0] = 'first';
  let tagGetterCalls = 0;
  const accessorTags = [];
  Object.defineProperty(accessorTags, '0', {
    enumerable: true,
    get() {
      tagGetterCalls += 1;
      throw new Error('tag getter executed');
    }
  });
  const result = preparePerformanceContentImport(importRequest([
    parsedRow(2, 'https://example.com/array-tags', { Tags: ['launch', 'review'] }),
    parsedRow(3, 'https://example.com/cell-tags', { Tags: 'launch, review' }),
    parsedRow(4, 'https://example.com/empty-tag', { Tags: 'launch,,review' }),
    parsedRow(5, 'https://example.com/duplicate-tag', { Tags: ['launch', 'launch'] }),
    parsedRow(6, 'https://example.com/many-tags', {
      Tags: Array.from({ length: 21 }, (_, index) => 'tag-' + index)
    }),
    parsedRow(7, 'https://example.com/sparse-tags', { Tags: sparseTags }),
    parsedRow(8, 'https://example.com/accessor-tags', { Tags: accessorTags })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      tags: 'Tags'
    }
  }));

  assert.equal(tagGetterCalls, 0);
  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'accepted', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected'
  ]);
  assert.deepEqual(result.drafts.map((draft) => draft.tags), [
    ['launch', 'review'],
    ['launch', 'review']
  ]);
  result.rows.slice(2).forEach((row) => {
    assert.equal(row.error.code, 'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID');
  });
});

test('enforces non-empty dense batches with an inclusive 500-row limit', () => {
  const { preparePerformanceContentImport } = loadService();
  const rows = Array.from({ length: 500 }, (_, index) => (
    parsedRow(index + 2, 'https://example.com/content/' + index)
  ));

  const result = preparePerformanceContentImport(importRequest(rows));
  assert.equal(result.total_count, 500);
  assert.equal(result.accepted_count, 500);

  expectServiceError(
    () => preparePerformanceContentImport(importRequest([])),
    'PERFORMANCE_CONTENT_IMPORT_ROWS_EMPTY'
  );
  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows.concat(
      parsedRow(502, 'https://example.com/content/500')
    ))),
    'PERFORMANCE_CONTENT_IMPORT_ROWS_TOO_LARGE',
    413
  );
});

test('enforces table-driven exact-limit and limit+1 byte and cardinality contracts', () => {
  const { preparePerformanceContentImport } = loadService();
  const customFieldMapping = (count) => Object.fromEntries(
    Array.from({ length: count }, (_, index) => (
      ['custom_' + String(index).padStart(2, '0'), 'Custom ' + String(index).padStart(2, '0')]
    ))
  );
  const rowWithColumns = (count) => {
    const row = parsedRow(2, 'https://example.com/column-limit');
    for (let index = 0; index < count - 2; index += 1) {
      row['Column ' + String(index).padStart(3, '0')] = null;
    }
    return row;
  };
  const batchRows = (count) => Array.from({ length: count }, (_, index) => (
    parsedRow(index + 2, 'https://example.com/batch/' + String(index).padStart(3, '0'))
  ));
  const sourceColumnRequest = (bytes) => {
    const sourceColumn = 'u'.repeat(bytes);
    return importRequest([{
      source_row_number: 2,
      [sourceColumn]: 'https://example.com/source-column-limit'
    }], {
      column_mapping: { content_url: sourceColumn }
    });
  };
  const customFieldNameRequest = (bytes) => importRequest([
    parsedRow(2, 'https://example.com/custom-field-name', { 'Custom Value': 'ok' })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      custom_fields: { ['f'.repeat(bytes)]: 'Custom Value' }
    }
  });
  const customFieldValueRequest = (value) => importRequest([
    parsedRow(2, 'https://example.com/custom-field-value', { Custom: value })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      custom_fields: { custom: 'Custom' }
    }
  });
  const optionalMetadataRequest = (value) => importRequest([
    parsedRow(2, 'https://example.com/optional-metadata', { Creator: value })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      creator_name: 'Creator'
    }
  });
  const tagsRequest = (tags) => importRequest([
    parsedRow(2, 'https://example.com/tag-boundary', { Tags: tags })
  ], {
    column_mapping: {
      content_url: 'Video URL',
      tags: 'Tags'
    }
  });

  const cases = [
    {
      name: 'campaign ID bytes',
      exactRequest: () => importRequest([
        parsedRow(2, 'https://example.com/campaign-limit')
      ], { campaign_id: 'c'.repeat(256) }),
      limitPlusOneRequest: () => importRequest([
        parsedRow(2, 'https://example.com/campaign-limit')
      ], { campaign_id: 'c'.repeat(257) }),
      exactAccepted: 1,
      overKind: 'service',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_CAMPAIGN_ID_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'mapping version bytes',
      exactRequest: () => importRequest([
        parsedRow(2, 'https://example.com/mapping-version-limit')
      ], { mapping_version: 'm'.repeat(128) }),
      limitPlusOneRequest: () => importRequest([
        parsedRow(2, 'https://example.com/mapping-version-limit')
      ], { mapping_version: 'm'.repeat(129) }),
      exactAccepted: 1,
      overKind: 'service',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_VERSION_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'mapped source column bytes',
      exactRequest: () => sourceColumnRequest(256),
      limitPlusOneRequest: () => sourceColumnRequest(257),
      exactAccepted: 1,
      overKind: 'service',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_COLUMN_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'custom-field count',
      exactRequest: () => importRequest([
        parsedRow(2, 'https://example.com/custom-field-count')
      ], {
        column_mapping: {
          content_url: 'Video URL',
          custom_fields: customFieldMapping(20)
        }
      }),
      limitPlusOneRequest: () => importRequest([
        parsedRow(2, 'https://example.com/custom-field-count')
      ], {
        column_mapping: {
          content_url: 'Video URL',
          custom_fields: customFieldMapping(21)
        }
      }),
      exactAccepted: 1,
      overKind: 'service',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_CUSTOM_FIELDS_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'custom-field name bytes',
      exactRequest: () => customFieldNameRequest(64),
      limitPlusOneRequest: () => customFieldNameRequest(65),
      exactAccepted: 1,
      overKind: 'service',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_CUSTOM_FIELD_NAME_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'custom-field value bytes',
      exactRequest: () => customFieldValueRequest('x'.repeat(2048)),
      limitPlusOneRequest: () => customFieldValueRequest('x'.repeat(2049)),
      exactAccepted: 1,
      overKind: 'row',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_ROW_CUSTOM_FIELD_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'optional metadata bytes',
      exactRequest: () => optionalMetadataRequest('x'.repeat(256)),
      limitPlusOneRequest: () => optionalMetadataRequest('x'.repeat(257)),
      exactAccepted: 1,
      overKind: 'row',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_ROW_FIELD_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'tag count',
      exactRequest: () => tagsRequest(
        Array.from({ length: 20 }, (_, index) => 'tag-' + String(index).padStart(2, '0'))
      ),
      limitPlusOneRequest: () => tagsRequest(
        Array.from({ length: 21 }, (_, index) => 'tag-' + String(index).padStart(2, '0'))
      ),
      exactAccepted: 1,
      overKind: 'row',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      overStatus: 400
    },
    {
      name: 'Unicode tag bytes',
      exactRequest: () => tagsRequest(['界'.repeat(21) + 'a']),
      limitPlusOneRequest: () => tagsRequest(['界'.repeat(21) + 'ab']),
      exactAccepted: 1,
      overKind: 'row',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      overStatus: 400
    },
    {
      name: 'row column count',
      exactRequest: () => importRequest([rowWithColumns(128)]),
      limitPlusOneRequest: () => importRequest([rowWithColumns(129)]),
      exactAccepted: 1,
      overKind: 'row',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_ROW_TOO_MANY_COLUMNS',
      overStatus: 413
    },
    {
      name: 'cell bytes',
      exactRequest: () => importRequest([
        parsedRow(2, 'https://example.com/cell-limit', { Padding: 'x'.repeat(8192) })
      ]),
      limitPlusOneRequest: () => importRequest([
        parsedRow(2, 'https://example.com/cell-limit', { Padding: 'x'.repeat(8193) })
      ]),
      exactAccepted: 1,
      overKind: 'row',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_ROW_FIELD_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'row bytes',
      exactRequest: () => importRequest([rowAtByteLimit(false)]),
      limitPlusOneRequest: () => importRequest([rowAtByteLimit(true)]),
      exactAccepted: 1,
      overKind: 'row',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_ROW_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'batch row count',
      exactRequest: () => importRequest(batchRows(500)),
      limitPlusOneRequest: () => importRequest(batchRows(501)),
      exactAccepted: 500,
      overKind: 'service',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_ROWS_TOO_LARGE',
      overStatus: 413
    },
    {
      name: 'aggregate bytes',
      exactRequest: () => importRequest(aggregateBoundaryRows(false)),
      limitPlusOneRequest: () => importRequest(aggregateBoundaryRows(true)),
      exactAccepted: 128,
      overKind: 'service',
      overCode: 'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      overStatus: 413,
      overDetails: {
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    }
  ];

  cases.forEach((contractCase) => {
    const exact = preparePerformanceContentImport(contractCase.exactRequest());
    assert.equal(
      exact.accepted_count,
      contractCase.exactAccepted,
      contractCase.name + ' must accept the exact limit'
    );
    assert.equal(
      exact.rejected_count,
      0,
      contractCase.name + ' must not reject the exact limit'
    );

    if (contractCase.overKind === 'service') {
      expectServiceError(
        () => preparePerformanceContentImport(contractCase.limitPlusOneRequest()),
        contractCase.overCode,
        contractCase.overStatus,
        contractCase.overDetails
      );
      return;
    }

    const over = preparePerformanceContentImport(contractCase.limitPlusOneRequest());
    assert.equal(over.accepted_count, 0, contractCase.name + ' limit+1 must not be accepted');
    assert.equal(over.rejected_count, 1, contractCase.name + ' limit+1 must be rejected');
    assert.equal(over.rows[0].error.code, contractCase.overCode);
    assert.equal(over.rows[0].error.status, contractCase.overStatus);
    assert.equal(over.rows[0].error.statusCode, contractCase.overStatus);
  });
});

INVALID_AGGREGATE_BOUNDARY_CASES.forEach((contractCase) => {
  test('aggregate preflight counts exact/+1 bytes for invalid ' + contractCase.name, () => {
    const { preparePerformanceContentImport } = loadService();
    const exact = preparePerformanceContentImport(importRequest(
      contractCase.rowsAtBoundary(false)
    ));

    assert.equal(exact.total_count, 1);
    assert.equal(exact.accepted_count, 0);
    assert.equal(exact.rejected_count, 1);
    expectServiceError(
      () => preparePerformanceContentImport(importRequest(
        contractCase.rowsAtBoundary(true)
      )),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    );
  });
});

test('aggregate preflight stops before a depth-18 shared DAG after an earlier oversized row', () => {
  const { preparePerformanceContentImport } = loadService();
  const dag = sharedBinaryDag(18);
  const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  let dagDescriptorSnapshots = 0;
  Object.getOwnPropertyDescriptors = function countedGetOwnPropertyDescriptors(value) {
    if (dag.containers.has(value)) dagDescriptorSnapshots += 1;
    return Reflect.apply(originalGetOwnPropertyDescriptors, Object, [value]);
  };

  try {
    expectServiceError(
      () => preparePerformanceContentImport(importRequest([
        'x'.repeat(8388609),
        dag.root
      ])),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413
    );
  } finally {
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
  }

  assert.equal(
    dagDescriptorSnapshots,
    0,
    'the later shared DAG must not be snapshotted after the aggregate cap is exceeded'
  );
});

test('aggregate preflight memoizes shared DAG bytes while preserving occurrence semantics', () => {
  const { preparePerformanceContentImport } = loadService();

  const exactDag = sharedBinaryDag(18);
  Object.defineProperty(exactDag.root, 'tail', {
    configurable: true,
    enumerable: true,
    value: 'z'.repeat(5),
    writable: true
  });
  const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  let exactDescriptorSnapshots = 0;
  let exactDescriptorReads = 0;
  Object.getOwnPropertyDescriptors = function countedGetOwnPropertyDescriptors(value) {
    if (exactDag.containers.has(value)) exactDescriptorSnapshots += 1;
    return Reflect.apply(originalGetOwnPropertyDescriptors, Object, [value]);
  };
  Object.getOwnPropertyDescriptor = function countedGetOwnPropertyDescriptor(value, key) {
    if (exactDag.containers.has(value)) exactDescriptorReads += 1;
    return Reflect.apply(originalGetOwnPropertyDescriptor, Object, [value, key]);
  };

  let exact;
  try {
    exact = preparePerformanceContentImport(importRequest([exactDag.root]));
  } finally {
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
  }
  assert.equal(exact.total_count, 1);
  assert.equal(exact.rejected_count, 1);
  assert.equal(
    exactDescriptorSnapshots,
    0,
    'semantic row inspection must not use the bulk descriptor API'
  );
  assert.equal(
    exactDescriptorReads,
    40,
    '38 aggregate, one lineage, and one bounded semantic read before rejection are expected'
  );

  const overDag = sharedBinaryDag(18);
  Object.defineProperty(overDag.root, 'tail', {
    configurable: true,
    enumerable: true,
    value: 'z'.repeat(6),
    writable: true
  });
  let overDescriptorSnapshots = 0;
  let overDescriptorReads = 0;
  Object.getOwnPropertyDescriptors = function countedGetOwnPropertyDescriptors(value) {
    if (overDag.containers.has(value)) overDescriptorSnapshots += 1;
    return Reflect.apply(originalGetOwnPropertyDescriptors, Object, [value]);
  };
  Object.getOwnPropertyDescriptor = function countedGetOwnPropertyDescriptor(value, key) {
    if (overDag.containers.has(value)) overDescriptorReads += 1;
    return Reflect.apply(originalGetOwnPropertyDescriptor, Object, [value, key]);
  };
  try {
    expectServiceError(
      () => preparePerformanceContentImport(importRequest([overDag.root])),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    );
  } finally {
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
  }
  assert.equal(overDescriptorSnapshots, 0);
  assert.equal(overDescriptorReads, 38);
});

test('aggregate preflight fail-closes a shared a<->b SCC independent of key order and entry point', () => {
  const { preparePerformanceContentImport } = loadService();
  const calls = { accessor: 0, coercion: 0, iterator: 0, proxy: 0 };
  const fingerprints = [];

  SHARED_CYCLE_VARIANTS.forEach(({ entryPoint, keyOrder }) => {
    const secret = 'SHARED_CYCLE_SINGLE_SECRET_' + keyOrder.join('_') + '_' + entryPoint;
    const root = sharedTwoNodeCycleRoot(keyOrder, entryPoint, calls, secret);
    const error = expectServiceError(
      () => preparePerformanceContentImport(importRequest([
        parsedRow(2, 'https://example.com/shared-cycle-single', { Extra: root })
      ])),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        field: 'rows',
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    );

    assertBoundedSecretFreeError(error, [secret]);
    fingerprints.push({
      code: error.code,
      status: error.status,
      details: error.details
    });
  });

  assert.deepEqual(fingerprints, SHARED_CYCLE_VARIANTS.map(() => ({
    code: 'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    status: 413,
    details: {
      actual_bytes: 8388609,
      field: 'rows',
      max_bytes: 8388608
    }
  })));
  assert.deepEqual(calls, { accessor: 0, coercion: 0, iterator: 0, proxy: 0 });
});

test('aggregate cyclic SCC saturation precedes duplicate lineage for every key order and entry point', () => {
  const { preparePerformanceContentImport } = loadService();
  const calls = { accessor: 0, coercion: 0, iterator: 0, proxy: 0 };
  const fingerprints = [];

  SHARED_CYCLE_VARIANTS.forEach(({ entryPoint, keyOrder }) => {
    const secret = 'SHARED_CYCLE_LINEAGE_SECRET_' + keyOrder.join('_') + '_' + entryPoint;
    const root = sharedTwoNodeCycleRoot(keyOrder, entryPoint, calls, secret);
    const error = expectServiceError(
      () => preparePerformanceContentImport(importRequest([
        parsedRow(2, 'https://example.com/shared-cycle-first', { Extra: root }),
        parsedRow(2, 'https://example.com/shared-cycle-duplicate')
      ])),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        field: 'rows',
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    );

    assertBoundedSecretFreeError(error, [secret]);
    fingerprints.push({
      code: error.code,
      status: error.status,
      details: error.details
    });
  });

  assert.deepEqual(fingerprints, SHARED_CYCLE_VARIANTS.map(() => ({
    code: 'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    status: 413,
    details: {
      actual_bytes: 8388609,
      field: 'rows',
      max_bytes: 8388608
    }
  })));
  assert.deepEqual(calls, { accessor: 0, coercion: 0, iterator: 0, proxy: 0 });
});

[
  {
    name: 'depth',
    graph: () => nestedContainerChain(64)
  },
  {
    name: 'unique-container',
    graph: uniqueContainerBudgetGraph
  },
  {
    name: 'descriptor',
    graph: descriptorBudgetGraph
  }
].forEach((contractCase) => {
  test(
    'aggregate cycle saturation precedes a competing ' + contractCase.name +
      ' violation for every sibling order and SCC entry point',
    () => {
      const { preparePerformanceContentImport } = loadService();
      const calls = { accessor: 0, coercion: 0, iterator: 0, proxy: 0 };
      const siblingOrders = [
        ['budget', 'cycle'],
        ['cycle', 'budget']
      ];

      siblingOrders.forEach((siblingOrder) => {
        SHARED_CYCLE_VARIANTS.forEach(({ entryPoint, keyOrder }) => {
          const secret = [
            'COMPETING_CYCLE',
            contractCase.name,
            siblingOrder.join('_'),
            keyOrder.join('_'),
            entryPoint
          ].join('_');
          const branches = {
            budget: contractCase.graph(),
            cycle: sharedTwoNodeCycleRoot(keyOrder, entryPoint, calls, secret)
          };
          const competingRoot = {};
          siblingOrder.forEach((key) => {
            competingRoot[key] = branches[key];
          });

          const error = expectServiceError(
            () => preparePerformanceContentImport(importRequest([
              parsedRow(2, 'https://example.com/competing-cycle-first', {
                Extra: competingRoot
              }),
              parsedRow(2, 'https://example.com/competing-cycle-duplicate')
            ])),
            'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
            413,
            {
              field: 'rows',
              max_bytes: 8388608,
              actual_bytes: 8388609
            }
          );
          assertBoundedSecretFreeError(error, [secret]);
        });
      });

      assert.deepEqual(calls, { accessor: 0, coercion: 0, iterator: 0, proxy: 0 });
    }
  );
});

test('aggregate depth budget deterministically precedes descriptor budget across key permutations', () => {
  const { preparePerformanceContentImport } = loadService();
  const branches = {
    depth: nestedContainerChain(64),
    descriptor: descriptorBudgetGraph()
  };
  const fingerprints = [
    ['depth', 'descriptor'],
    ['descriptor', 'depth']
  ].map((keyOrder) => {
    const competingRoot = {};
    keyOrder.forEach((key) => {
      competingRoot[key] = branches[key];
    });
    const error = expectServiceError(
      () => preparePerformanceContentImport(importRequest([
        parsedRow(2, 'https://example.com/deterministic-budget', { Extra: competingRoot })
      ])),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        field: 'rows',
        reason: 'aggregate_depth_limit_exceeded',
        max_items: 64,
        actual_items: 65
      }
    );
    return { code: error.code, status: error.status, details: error.details };
  });

  assert.deepEqual(fingerprints[0], fingerprints[1]);
});

test('20,000-container acyclic chain reports a depth budget instead of a cycle byte sentinel', () => {
  const { preparePerformanceContentImport } = loadService();
  const error = expectServiceError(
    () => preparePerformanceContentImport(importRequest([
      parsedRow(2, 'https://example.com/deep-acyclic', {
        Extra: nestedContainerChain(20000)
      })
    ])),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413,
    {
      field: 'rows',
      reason: 'aggregate_depth_limit_exceeded',
      max_items: 64,
      actual_items: 65
    }
  );

  assert.equal(Object.hasOwn(error.details, 'actual_bytes'), false);
});

test('aggregate descriptor admission reads exactly 80,000 descriptors without bulk materialization', () => {
  const { preparePerformanceContentImport } = loadService();
  const secret = 'EXACT_DESCRIPTOR_PROBE_SECRET';
  const row = descriptorProbeRow(80000, secret + 'x'.repeat(8388609));
  const observed = observeDescriptorInspection(row, () => expectServiceError(
    () => preparePerformanceContentImport(importRequest([row])),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413,
    {
      field: 'rows',
      max_bytes: 8388608,
      actual_bytes: 8388609
    }
  ));

  assertBoundedSecretFreeError(observed.result, [secret]);
  assert.deepEqual(observed.counts, {
    bulkDescriptorSnapshots: 0,
    individualDescriptorReads: 80000,
    ownKeyEnumerations: 1
  });
});

[
  { selfPosition: 'first', expectedDescriptorReads: 1 },
  { selfPosition: 'last', expectedDescriptorReads: 80001 }
].forEach((probeCase) => {
  test(
    'aggregate preflight saturates an over-wide self-cycle when its data property is ' +
      probeCase.selfPosition,
    () => {
      const { preparePerformanceContentImport } = loadService();
      const row = overWideSelfCycleRow(probeCase.selfPosition);
      const observed = observeDescriptorInspection(row, () => expectServiceError(
        () => preparePerformanceContentImport(importRequest([row])),
        'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
        413,
        {
          field: 'rows',
          max_bytes: 8388608,
          actual_bytes: 8388609
        }
      ));

      assert.deepEqual(observed.counts, {
        bulkDescriptorSnapshots: 0,
        individualDescriptorReads: probeCase.expectedDescriptorReads,
        ownKeyEnumerations: 2
      });
    }
  );
});

test('semantic row admission rejects exactly 80,000 null descriptors before any bulk snapshot', () => {
  const { preparePerformanceContentImport } = loadService();
  const row = descriptorProbeRow(80000);
  const observed = observeDescriptorInspection(
    row,
    () => preparePerformanceContentImport(importRequest([row]))
  );

  assert.equal(observed.result.total_count, 1);
  assert.equal(observed.result.accepted_count, 0);
  assert.equal(observed.result.rejected_count, 1);
  assert.equal(
    observed.result.rows[0].error.code,
    'PERFORMANCE_CONTENT_IMPORT_ROW_TOO_MANY_COLUMNS'
  );
  assert.equal(observed.result.rows[0].error.details.reason, 'column_limit_exceeded');
  assert.deepEqual(observed.counts, {
    bulkDescriptorSnapshots: 0,
    individualDescriptorReads: 80001,
    ownKeyEnumerations: 2
  });
});

[
  { descriptorCount: 80001, name: '80,001', expectedDescriptorReads: 80001 },
  { descriptorCount: 200000, name: '200,000', expectedDescriptorReads: 200000 }
].forEach((probeCase) => {
  test(
    'aggregate descriptor admission rejects a ' + probeCase.name +
      '-descriptor probe after a bounded individual cycle scan',
    () => {
      const { preparePerformanceContentImport } = loadService();
      const secret = 'OVERFLOW_DESCRIPTOR_PROBE_SECRET_' + probeCase.name;
      const row = descriptorProbeRow(probeCase.descriptorCount, secret);
      const observed = observeDescriptorInspection(row, () => expectServiceError(
        () => preparePerformanceContentImport(importRequest([row])),
        'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
        413,
        {
          field: 'rows',
          reason: 'aggregate_descriptor_limit_exceeded',
          max_items: 80000,
          actual_items: 80001
        }
      ));

      assertBoundedSecretFreeError(observed.result, [secret]);
      assert.deepEqual(observed.counts, {
        bulkDescriptorSnapshots: 0,
        individualDescriptorReads: probeCase.expectedDescriptorReads,
        ownKeyEnumerations: 2
      });
      if (probeCase.descriptorCount > 80001) {
        assert.notEqual(observed.result.details.actual_items, probeCase.descriptorCount);
      }
    }
  );
});

test('aggregate cycle precedence survives a competing 200,000-wide branch in every order and entry point', () => {
  const { preparePerformanceContentImport } = loadService();
  const wideBranch = descriptorProbeRow(200000);
  const cycleA = {};
  const cycleB = {};
  cycleA.peer = cycleB;
  cycleB.peer = cycleA;

  [
    { entryPoint: cycleA, keyOrder: ['acyclic', 'cycle'] },
    { entryPoint: cycleB, keyOrder: ['acyclic', 'cycle'] },
    { entryPoint: cycleA, keyOrder: ['cycle', 'acyclic'] },
    { entryPoint: cycleB, keyOrder: ['cycle', 'acyclic'] }
  ].forEach(({ entryPoint, keyOrder }, index) => {
    const branches = { acyclic: wideBranch, cycle: entryPoint };
    const competingRoot = {};
    keyOrder.forEach((key) => {
      competingRoot[key] = branches[key];
    });
    const observed = observeDescriptorInspection(wideBranch, () => expectServiceError(
      () => preparePerformanceContentImport(importRequest([
        parsedRow(index + 2, 'https://example.com/wide-cycle/' + index, {
          Extra: competingRoot
        })
      ])),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        field: 'rows',
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    ));

    assert.equal(observed.counts.bulkDescriptorSnapshots, 0);
    assert.equal(observed.counts.individualDescriptorReads, 0);
    assert.ok(observed.counts.ownKeyEnumerations <= 2);
  });
});

[
  { exportName: 'preparePerformanceContentImport', name: 'prepare entry point' },
  { exportName: 'buildPerformanceContentImportDrafts', name: 'draft entry point' }
].forEach(({ exportName, name }) => {
  [
    ['acyclic', 'cycle'],
    ['cycle', 'acyclic']
  ].forEach((branchOrder) => {
    test(
      'exact 200,000-descriptor fill preserves cycle precedence for the ' + name +
        ' with ' + branchOrder.join('-first/'),
      () => {
        const service = loadService()[exportName];
        const fixture = exactFillCycleFixture(branchOrder);
        const observed = observeNamedDescriptorInspection({
          root: fixture.root,
          acyclic: fixture.acyclic,
          cycle: fixture.cycle
        }, () => expectServiceError(
          () => service(importRequest([fixture.root])),
          'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
          413,
          {
            field: 'rows',
            max_bytes: 8388608,
            actual_bytes: 8388609
          }
        ));

        assert.deepEqual(observed.counts, {
          bulkDescriptorSnapshots: { root: 0, acyclic: 0, cycle: 0 },
          individualDescriptorReads: { root: 199999, acyclic: 1, cycle: 1 },
          ownKeyEnumerations: { root: 2, acyclic: 1, cycle: 1 }
        });
        assert.deepEqual(fixture.hooks, { accessor: 0, proxy: 0 });
      }
    );
  });
});

[
  { branchOrder: ['a', 'b'], name: 'a-before-b' },
  { branchOrder: ['b', 'a'], name: 'b-before-a' }
].forEach(({ branchOrder, name }) => {
  test('exact deferred fill detects an a<->b SCC with ' + name + ' root insertion', () => {
    const { preparePerformanceContentImport } = loadService();
    const fixture = exactFillMutualCycleFixture(branchOrder);
    const observed = observeNamedDescriptorInspection({
      root: fixture.root,
      a: fixture.a,
      b: fixture.b
    }, () => captureThrownError(
      () => preparePerformanceContentImport(importRequest([fixture.root]))
    ));

    assert.deepEqual(observed.counts, {
      bulkDescriptorSnapshots: { root: 0, a: 0, b: 0 },
      individualDescriptorReads: { root: 199999, a: 1, b: 1 },
      ownKeyEnumerations: { root: 2, a: 1, b: 1 }
    });
    assert.equal(observed.result.name, 'PerformanceContentImportServiceError');
    assert.equal(observed.result.code, 'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE');
    assert.equal(observed.result.status, 413);
    assert.deepEqual(observed.result.details, {
      field: 'rows',
      max_bytes: 8388608,
      actual_bytes: 8388609
    });
    assertDeepFrozen(observed.result.details);
  });
});

[
  {
    branchOrder: ['a', 'b'],
    name: 'four-key-a-before-one-key-b',
    expectedRootDescriptorReads: 199996
  },
  {
    branchOrder: ['b', 'a'],
    name: 'one-key-b-before-four-key-a',
    expectedRootDescriptorReads: 199995
  }
].forEach(({ branchOrder, name, expectedRootDescriptorReads }) => {
  test('mixed-width deferred fill detects an a<->b SCC with ' + name, () => {
    const { preparePerformanceContentImport } = loadService();
    const fixture = mixedWidthExactFillMutualCycleFixture(branchOrder);
    const observed = observeNamedDescriptorInspection({
      root: fixture.root,
      a: fixture.a,
      b: fixture.b
    }, () => captureThrownError(
      () => preparePerformanceContentImport(importRequest([fixture.root]))
    ));

    assert.deepEqual(observed.counts, {
      bulkDescriptorSnapshots: { root: 0, a: 0, b: 0 },
      individualDescriptorReads: {
        root: expectedRootDescriptorReads,
        a: 1,
        b: 1
      },
      ownKeyEnumerations: { root: 2, a: 1, b: 1 }
    });
    assert.equal(observed.result.name, 'PerformanceContentImportServiceError');
    assert.equal(observed.result.code, 'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE');
    assert.equal(observed.result.status, 413);
    assert.deepEqual(observed.result.details, {
      field: 'rows',
      max_bytes: 8388608,
      actual_bytes: 8388609
    });
    assertDeepFrozen(observed.result.details);
  });
});

[
  { cyclePosition: 'before-aliases', name: 'before' },
  { cyclePosition: 'after-aliases', name: 'after' }
].forEach(({ cyclePosition, name }) => {
  test(
    'saturated deferred exact-fill frontier inspects a cycle inserted ' + name +
      ' 8,192 aliases',
    () => {
      const { preparePerformanceContentImport } = loadService();
      const fixture = saturatedDeferredFrontierCycleFixture(cyclePosition);
      const observed = observeNamedDescriptorInspection({
        cycle: fixture.cycle,
        shared: fixture.shared
      }, () => captureThrownError(
        () => preparePerformanceContentImport(importRequest([fixture.root]))
      ));

      assert.equal(observed.counts.individualDescriptorReads.cycle, 1);
      assert.deepEqual(observed.counts, {
        bulkDescriptorSnapshots: { cycle: 0, shared: 0 },
        individualDescriptorReads: { cycle: 1, shared: 1 },
        ownKeyEnumerations: { cycle: 1, shared: 1 }
      });
      assert.equal(observed.result.code, 'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE');
      assert.equal(observed.result.status, 413);
      assert.deepEqual(observed.result.details, {
        field: 'rows',
        max_bytes: 8388608,
        actual_bytes: 8388609
      });
    }
  );
});

test('wide shared exact-fill aliases retain one bounded key list per scan', () => {
  const { preparePerformanceContentImport } = loadService();
  const fixture = wideSharedExactFillFixture();
  const observed = observeDescriptorInspection(fixture.shared, () => captureThrownError(
    () => preparePerformanceContentImport(importRequest([fixture.root]))
  ));

  assert.equal(observed.counts.ownKeyEnumerations, 2);
  assert.deepEqual(observed.counts, {
    bulkDescriptorSnapshots: 0,
    individualDescriptorReads: 199984,
    ownKeyEnumerations: 2
  });
  assert.equal(observed.result.code, 'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE');
  assert.equal(observed.result.status, 413);
  assert.deepEqual(observed.result.details, {
    field: 'rows',
    reason: 'aggregate_descriptor_limit_exceeded',
    max_items: 80000,
    actual_items: 80001
  });
});

[
  { exportName: 'preparePerformanceContentImport', name: 'prepare entry point' },
  { exportName: 'buildPerformanceContentImportDrafts', name: 'draft entry point' }
].forEach(({ exportName, name }) => {
  [
    ['acyclic', 'symbols'],
    ['symbols', 'acyclic']
  ].forEach((branchOrder) => {
    test(
      'exact 200,000-descriptor fill preserves multi-symbol rejection for the ' + name +
        ' with ' + branchOrder.join('-first/'),
      () => {
        const service = loadService()[exportName];
        const fixture = exactFillSymbolFixture(branchOrder);
        const originalDescription = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description');
        const originalToString = Object.getOwnPropertyDescriptor(Symbol.prototype, 'toString');
        Object.defineProperty(Symbol.prototype, 'description', {
          configurable: true,
          get() {
            fixture.hooks.symbolDescription += 1;
            throw new Error('exact-fill Symbol description getter executed');
          }
        });
        Object.defineProperty(Symbol.prototype, 'toString', {
          configurable: true,
          value() {
            fixture.hooks.symbolToString += 1;
            throw new Error('exact-fill Symbol toString executed');
          }
        });

        let observed;
        try {
          observed = observeNamedDescriptorInspection({
            root: fixture.root,
            acyclic: fixture.acyclic,
            symbols: fixture.symbols
          }, () => expectServiceError(
            () => service(importRequest([fixture.root])),
            'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
            413,
            {
              field: 'rows',
              reason: 'aggregate_symbol_key_order_unsupported',
              max_items: 1,
              actual_items: 2
            }
          ));
        } finally {
          Object.defineProperty(Symbol.prototype, 'description', originalDescription);
          Object.defineProperty(Symbol.prototype, 'toString', originalToString);
        }

        assert.deepEqual(observed.counts, {
          bulkDescriptorSnapshots: { root: 0, acyclic: 0, symbols: 0 },
          individualDescriptorReads: { root: 199998, acyclic: 2, symbols: 0 },
          ownKeyEnumerations: { root: 2, acyclic: 1, symbols: 1 }
        });
        assert.deepEqual(fixture.hooks, {
          accessor: 0,
          proxy: 0,
          symbolDescription: 0,
          symbolToString: 0
        });
      }
    );
  });
});

[
  {
    name: 'depth',
    reason: 'aggregate_depth_limit_exceeded',
    maxItems: 64,
    graph: () => nestedContainerChain(64)
  },
  {
    name: 'unique-container',
    reason: 'aggregate_unique_container_limit_exceeded',
    maxItems: 4096,
    graph: uniqueContainerBudgetGraph
  },
  {
    name: 'descriptor',
    reason: 'aggregate_descriptor_limit_exceeded',
    maxItems: 80000,
    graph: descriptorBudgetGraph
  }
].forEach((contractCase) => {
  test(
    'aggregate ' + contractCase.name + ' budget fails closed before duplicate lineage',
    () => {
      const { preparePerformanceContentImport } = loadService();
      const rows = [
        parsedRow(2, 'https://example.com/budget/first', {
          Extra: contractCase.graph()
        }),
        parsedRow(2, 'https://example.com/budget/duplicate')
      ];

      expectServiceError(
        () => preparePerformanceContentImport(importRequest(rows)),
        'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
        413,
        {
          reason: contractCase.reason,
          max_items: contractCase.maxItems,
          actual_items: contractCase.maxItems + 1
        }
      );
    }
  );
});

test('aggregate traversal keeps an 8,191-key shared DAG off the work stack before lineage', () => {
  const { preparePerformanceContentImport } = loadService();
  const rows = [
    parsedRow(2, 'https://example.com/wide-dag-first', {
      Extra: wideSharedDagGraph()
    }),
    parsedRow(2, 'https://example.com/wide-dag-duplicate')
  ];

  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows)),
    'PERFORMANCE_CONTENT_IMPORT_SOURCE_ROW_NUMBER_DUPLICATE',
    400,
    {
      field: 'rows',
      index: 1,
      source_row_number: 2,
      reason: 'duplicate_source_row_number'
    }
  );
});

test('aggregate preflight rejects ambiguous symbol-key order before competing branch budgets', () => {
  const { preparePerformanceContentImport } = loadService();
  const depthKey = Symbol('depth-branch');
  const descriptorKey = Symbol('descriptor-branch');
  const values = new Map([
    [depthKey, nestedContainerChain(64)],
    [descriptorKey, descriptorBudgetGraph()]
  ]);
  const originalDescription = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description');
  const originalToString = Object.getOwnPropertyDescriptor(Symbol.prototype, 'toString');
  const calls = { description: 0, toString: 0 };

  Object.defineProperty(Symbol.prototype, 'description', {
    configurable: true,
    get() {
      calls.description += 1;
      throw new Error('Symbol description getter executed');
    }
  });
  Object.defineProperty(Symbol.prototype, 'toString', {
    configurable: true,
    value() {
      calls.toString += 1;
      throw new Error('Symbol toString executed');
    }
  });

  const fingerprints = [];
  try {
    [
      [depthKey, descriptorKey],
      [descriptorKey, depthKey]
    ].forEach((keyOrder) => {
      const row = {};
      keyOrder.forEach((key) => {
        Object.defineProperty(row, key, {
          configurable: true,
          enumerable: true,
          value: values.get(key),
          writable: true
        });
      });
      const error = expectServiceError(
        () => preparePerformanceContentImport(importRequest([row])),
        'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
        413,
        {
          field: 'rows',
          reason: 'aggregate_symbol_key_order_unsupported',
          max_items: 1,
          actual_items: 2
        }
      );
      fingerprints.push({ code: error.code, status: error.status, details: error.details });
    });
  } finally {
    Object.defineProperty(Symbol.prototype, 'description', originalDescription);
    Object.defineProperty(Symbol.prototype, 'toString', originalToString);
  }

  assert.deepEqual(fingerprints[0], fingerprints[1]);
  assert.deepEqual(calls, { description: 0, toString: 0 });
});

test('aggregate preflight counts symbol-keyed data values at exact/+1 bytes', () => {
  const { preparePerformanceContentImport } = loadService();
  const symbolRow = (payloadBytes) => {
    const row = {};
    Object.defineProperty(row, Symbol('visible-payload'), {
      configurable: true,
      enumerable: true,
      value: 'x'.repeat(payloadBytes),
      writable: true
    });
    return row;
  };

  const exact = preparePerformanceContentImport(importRequest([symbolRow(8388608)]));
  assert.equal(exact.total_count, 1);
  assert.equal(exact.accepted_count, 0);
  assert.equal(exact.rejected_count, 1);
  assert.equal(
    exact.rows[0].error.code,
    'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_INVALID'
  );

  expectServiceError(
    () => preparePerformanceContentImport(importRequest([symbolRow(8388609)])),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413,
    {
      max_bytes: 8388608,
      actual_bytes: 8388609
    }
  );
});

[
  {
    name: 'direct class-instance row',
    rows(secret) {
      class OversizedRow {
        constructor() {
          this.source_row_number = 2;
          this.payload = secret + 'x'.repeat(10 * 1024 * 1024);
        }
      }
      return [
        new OversizedRow(),
        parsedRow(2, 'https://example.com/class-row-duplicate')
      ];
    }
  },
  {
    name: 'nested class-instance cell',
    rows(secret) {
      class OversizedCell {
        constructor() {
          this.payload = secret + 'x'.repeat(10 * 1024 * 1024);
        }
      }
      return [
        parsedRow(2, 'https://example.com/class-cell-first', {
          Extra: new OversizedCell()
        }),
        parsedRow(2, 'https://example.com/class-cell-duplicate')
      ];
    }
  }
].forEach((contractCase) => {
  test('aggregate preflight measures a 10 MiB ' + contractCase.name + ' before lineage', () => {
    const { preparePerformanceContentImport } = loadService();
    const secret = 'CLASS_VISIBLE_PAYLOAD_SECRET_' + contractCase.name;
    const error = expectServiceError(
      () => preparePerformanceContentImport(importRequest(contractCase.rows(secret))),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    );

    assertBoundedSecretFreeError(error, [secret]);
  });
});

[
  {
    name: 'function',
    value(secret) {
      function visiblePayloadFunction() {}
      Object.defineProperty(visiblePayloadFunction, 'payload', {
        configurable: true,
        enumerable: true,
        value: secret + 'x'.repeat(10 * 1024 * 1024),
        writable: true
      });
      return visiblePayloadFunction;
    }
  },
  {
    name: 'Date exotic',
    value(secret) {
      const value = new Date(0);
      value.payload = secret + 'x'.repeat(10 * 1024 * 1024);
      return value;
    }
  }
].forEach((contractCase) => {
  test('aggregate preflight measures visible ' + contractCase.name + ' data before lineage', () => {
    const { preparePerformanceContentImport } = loadService();
    const secret = 'VISIBLE_' + contractCase.name.toUpperCase().replaceAll(' ', '_') + '_SECRET';
    const rows = [
      parsedRow(2, 'https://example.com/visible-value-first', {
        Extra: contractCase.value(secret)
      }),
      parsedRow(2, 'https://example.com/visible-value-duplicate')
    ];
    const error = expectServiceError(
      () => preparePerformanceContentImport(importRequest(rows)),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    );

    assertBoundedSecretFreeError(error, [secret]);
  });
});

test('aggregate descriptor traversal fail-closes cycles without invoking user hooks or Proxy traps', () => {
  const { preparePerformanceContentImport } = loadService();
  const calls = {
    getter: 0,
    iterator: 0,
    proxy: 0,
    revokedProxy: 0,
    symbolToPrimitive: 0,
    toJSON: 0,
    toString: 0,
    valueOf: 0
  };
  const trackedContainers = new WeakSet();
  class VisibleClass {
    constructor() {
      this.visible = 'class-data';
    }

    get inheritedValue() {
      calls.getter += 1;
      throw new Error('class getter executed');
    }
  }
  const classValue = new VisibleClass();
  function functionValue() {}
  functionValue.visible = 'function-data';
  const exoticValue = new Date(0);
  exoticValue.visible = 'date-data';
  trackedContainers.add(classValue);
  trackedContainers.add(functionValue);
  trackedContainers.add(exoticValue);

  const trappedProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      calls.proxy += 1;
      throw new Error('Proxy descriptor trap executed');
    },
    ownKeys() {
      calls.proxy += 1;
      throw new Error('Proxy ownKeys trap executed');
    }
  });
  const revoked = Proxy.revocable({}, {
    getOwnPropertyDescriptor() {
      calls.revokedProxy += 1;
      throw new Error('revoked Proxy descriptor trap executed');
    },
    ownKeys() {
      calls.revokedProxy += 1;
      throw new Error('revoked Proxy ownKeys trap executed');
    }
  });
  revoked.revoke();
  const shared = { visible: 'shared-data' };
  const nested = {
    classValue,
    exoticValue,
    functionValue,
    iterator() {
      calls.iterator += 1;
      throw new Error('iterator method executed');
    },
    left: shared,
    revokedProxy: revoked.proxy,
    right: shared,
    toJSON() {
      calls.toJSON += 1;
      throw new Error('toJSON executed');
    },
    toString() {
      calls.toString += 1;
      throw new Error('toString executed');
    },
    trappedProxy,
    valueOf() {
      calls.valueOf += 1;
      throw new Error('valueOf executed');
    },
    [Symbol.iterator]() {
      calls.iterator += 1;
      throw new Error('Symbol.iterator executed');
    },
    [Symbol.toPrimitive]() {
      calls.symbolToPrimitive += 1;
      throw new Error('Symbol.toPrimitive executed');
    }
  };
  nested.self = nested;
  Object.defineProperty(nested, 'accessor', {
    configurable: true,
    enumerable: true,
    get() {
      calls.getter += 1;
      throw new Error('own getter executed');
    }
  });

  const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  let trackedDescriptorSnapshots = 0;
  Object.getOwnPropertyDescriptors = function countedGetOwnPropertyDescriptors(value) {
    if (trackedContainers.has(value)) trackedDescriptorSnapshots += 1;
    return Reflect.apply(originalGetOwnPropertyDescriptors, Object, [value]);
  };
  let first;
  try {
    first = expectServiceError(
      () => preparePerformanceContentImport(importRequest([{ Extra: nested }])),
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      413,
      {
        field: 'rows',
        max_bytes: 8388608,
        actual_bytes: 8388609
      }
    );
  } finally {
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
  }
  const second = expectServiceError(
    () => preparePerformanceContentImport(importRequest([{ Extra: nested }])),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413,
    {
      field: 'rows',
      max_bytes: 8388608,
      actual_bytes: 8388609
    }
  );

  assert.equal(trackedDescriptorSnapshots, 0);
  assert.deepEqual(
    { code: first.code, status: first.status, details: first.details },
    { code: second.code, status: second.status, details: second.details }
  );
  assert.deepEqual(calls, {
    getter: 0,
    iterator: 0,
    proxy: 0,
    revokedProxy: 0,
    symbolToPrimitive: 0,
    toJSON: 0,
    toString: 0,
    valueOf: 0
  });
});

test('aggregate preflight measures ordinary invalid containers without invoking hooks', () => {
  const { preparePerformanceContentImport } = loadService();
  let hookCalls = 0;
  const trappedProxy = new Proxy({}, {
    ownKeys() {
      hookCalls += 1;
      throw new Error('nested Proxy trap executed');
    }
  });
  const nested = {
    payload: 'x'.repeat(8388609),
    trappedProxy,
    toJSON() {
      hookCalls += 1;
      throw new Error('toJSON executed');
    },
    valueOf() {
      hookCalls += 1;
      throw new Error('valueOf executed');
    },
    toString() {
      hookCalls += 1;
      throw new Error('toString executed');
    },
    [Symbol.iterator]() {
      hookCalls += 1;
      throw new Error('iterator executed');
    }
  };
  Object.defineProperty(nested, 'hidden', {
    enumerable: true,
    get() {
      hookCalls += 1;
      throw new Error('nested getter executed');
    }
  });

  expectServiceError(
    () => preparePerformanceContentImport(importRequest([{ Extra: nested }])),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413
  );
  assert.equal(hookCalls, 0);
});

test('aggregate byte limit counts every inspected row even when semantic validation rejects it', () => {
  const { preparePerformanceContentImport } = loadService();
  const padding = 'x'.repeat(6000);
  const rows = Array.from({ length: 500 }, (_, index) => ({
    source_row_number: index + 2,
    'Video URL': 'https://example.com/rejected-content/' + index,
    Published: 'not-rfc3339',
    'Padding A': padding,
    'Padding B': padding,
    'Padding C': padding
  }));

  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows, {
      column_mapping: {
        content_url: 'Video URL',
        published_at: 'Published'
      }
    })),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413
  );
});

test('aggregate preflight saturates structurally rejected rows at limit+1 bytes', () => {
  const { preparePerformanceContentImport } = loadService();

  expectServiceError(
    () => preparePerformanceContentImport(importRequest(structurallyRejectedAggregateRows())),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413,
    {
      max_bytes: 8388608,
      actual_bytes: 8388609
    }
  );
});

test('aggregate preflight saturates mixed oversized cells at limit+1 bytes', () => {
  const { preparePerformanceContentImport } = loadService();

  expectServiceError(
    () => preparePerformanceContentImport(importRequest(mixedAggregateRows())),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413,
    {
      max_bytes: 8388608,
      actual_bytes: 8388609
    }
  );
});

test('aggregate resource enforcement precedes duplicate source-row lineage validation', () => {
  const { preparePerformanceContentImport } = loadService();
  const rows = mixedAggregateRows();
  rows[499].source_row_number = rows[0].source_row_number;

  expectServiceError(
    () => preparePerformanceContentImport(importRequest(rows)),
    'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
    413,
    {
      max_bytes: 8388608,
      actual_bytes: 8388609
    }
  );
});

test('semantically identical requests return identical deeply frozen snapshots', () => {
  const { preparePerformanceContentImport } = loadService();
  const first = preparePerformanceContentImport(importRequest([{
    source_row_number: 2,
    Notes: 'stable',
    Tags: ['b', 'a'],
    'Video URL': 'https://example.com/stable?utm_source=one'
  }], {
    column_mapping: {
      content_url: 'Video URL',
      tags: 'Tags',
      custom_fields: { notes: 'Notes', missing: 'Missing' }
    }
  }));
  const second = preparePerformanceContentImport(importRequest([{
    'Video URL': 'https://example.com/stable?utm_source=one',
    Tags: ['b', 'a'],
    Notes: 'stable',
    source_row_number: 2
  }], {
    column_mapping: {
      custom_fields: { missing: 'Missing', notes: 'Notes' },
      tags: 'Tags',
      content_url: 'Video URL'
    }
  }));

  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  assert.throws(() => {
    first.drafts[0].tags.push('mutation');
  }, TypeError);
  assert.throws(() => {
    first.drafts[0].custom_fields.notes = 'mutation';
  }, TypeError);
});

test('preparation performs no network calls and makes no provider or metric claims', () => {
  const servicePath = path.resolve(
    __dirname,
    '../services/performance_content_import_service.js'
  );
  const probe = String.raw`
    'use strict';
    const assert = require('node:assert/strict');
    const dns = require('node:dns');
    const http = require('node:http');
    const http2 = require('node:http2');
    const https = require('node:https');
    const net = require('node:net');
    const tls = require('node:tls');

    let networkCalls = 0;
    const patched = Object.create(null);
    const forbidden = () => {
      networkCalls += 1;
      throw new Error('network access attempted');
    };
    const patch = (family, target, key) => {
      if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
        return;
      }
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.value !== 'function') return;
      Object.defineProperty(target, key, { ...descriptor, value: forbidden });
      patched[family] = (patched[family] || 0) + 1;
    };
    const patchMethods = (family, target, methods) => {
      methods.forEach((method) => patch(family, target, method));
    };

    const dnsMethods = [
      'lookup', 'lookupService', 'resolve', 'resolveAny', 'resolve4', 'resolve6',
      'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
      'resolvePtr', 'resolveSoa', 'resolveSrv', 'reverse'
    ];
    patchMethods('dns', dns, dnsMethods);
    patchMethods('dns', dns.promises, dnsMethods);
    patchMethods('dns', dns.Resolver && dns.Resolver.prototype, dnsMethods);
    patchMethods(
      'dns',
      dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype,
      dnsMethods
    );
    patchMethods('net', net, ['connect', 'createConnection']);
    patchMethods('net', net.Socket && net.Socket.prototype, ['connect']);
    patchMethods('tls', tls, ['connect']);
    patchMethods('tls', tls.TLSSocket && tls.TLSSocket.prototype, ['connect']);
    patchMethods('http', http, ['request', 'get']);
    patchMethods('http', http.Agent && http.Agent.prototype, ['createConnection']);
    patchMethods('https', https, ['request', 'get']);
    patchMethods('https', https.Agent && https.Agent.prototype, ['createConnection']);
    patchMethods('http2', http2, ['connect']);
    patch('fetch', globalThis, 'fetch');

    let undiciAvailable = false;
    try {
      const undici = require('undici');
      undiciAvailable = true;
      patchMethods(
        'undici',
        undici,
        ['fetch', 'request', 'stream', 'pipeline', 'connect', 'upgrade']
      );
      [
        undici.Dispatcher,
        undici.Client,
        undici.Pool,
        undici.Agent,
        undici.BalancedPool
      ].forEach((Constructor) => {
        patchMethods('undici', Constructor && Constructor.prototype, ['dispatch', 'connect']);
      });
    } catch (error) {
      if (!error || error.code !== 'MODULE_NOT_FOUND') throw error;
    }

    ['dns', 'net', 'tls', 'http', 'https', 'http2', 'fetch'].forEach((family) => {
      assert.ok(patched[family] > 0, family + ' network API was not patched');
    });
    if (undiciAvailable) {
      assert.ok(patched.undici > 0, 'undici was available but no API was patched');
    }

    const { preparePerformanceContentImport } = require(process.argv[1]);
    const result = preparePerformanceContentImport({
      campaign_id: 'campaign-7b1',
      rows: [{
        source_row_number: 2,
        'Video URL': 'https://www.tiktok.com/@creator/video/7351234567890123456'
      }],
      column_mapping: { content_url: 'Video URL' },
      mapping_version: 'mapping-v1',
      provenance: {
        source_mode: 'csv_xlsx',
        file_hash: 'a'.repeat(64)
      }
    });
    const draft = result.drafts[0];

    assert.equal(result.accepted_count, 1);
    assert.equal(Object.hasOwn(draft, 'provider'), false);
    assert.equal(Object.hasOwn(draft, 'provider_status'), false);
    assert.equal(Object.hasOwn(draft, 'metrics'), false);
    assert.equal(Object.hasOwn(draft, 'deliverable_id'), false);
    assert.equal(networkCalls, 0);
    process.stdout.write(JSON.stringify({
      network_calls: networkCalls,
      patched,
      undici_available: undiciAvailable
    }));
  `;
  const child = spawnSync(process.execPath, ['-e', probe, servicePath], {
    encoding: 'utf8',
    windowsHide: true
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const observation = JSON.parse(child.stdout);
  assert.equal(observation.network_calls, 0);
  ['dns', 'net', 'tls', 'http', 'https', 'http2', 'fetch'].forEach((family) => {
    assert.ok(observation.patched[family] > 0);
  });
  if (observation.undici_available) {
    assert.ok(observation.patched.undici > 0);
  }
});
