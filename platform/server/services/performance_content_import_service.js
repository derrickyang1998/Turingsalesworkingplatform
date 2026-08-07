'use strict';

const { types: utilTypes } = require('node:util');
const {
  MAX_BATCH_SIZE: PUBLICATION_IDENTITY_MAX_BATCH_SIZE,
  REJECTED_ORIGINAL_URL_DISCLOSURE,
  admitPublicationBatch
} = require('./publication_identity_service');

const CONTRACT_VERSION = 'phase7b.1-content-import-v1';
const SOURCE_MODE = 'csv_xlsx';
const MAX_IMPORT_ROWS = 500;

const IMPORT_LIMITS = deepFreeze({
  MAX_ROWS: MAX_IMPORT_ROWS,
  MAX_CAMPAIGN_ID_BYTES: 256,
  MAX_MAPPING_VERSION_BYTES: 128,
  MAX_SOURCE_COLUMN_BYTES: 256,
  MAX_CUSTOM_FIELDS: 20,
  MAX_CUSTOM_FIELD_NAME_BYTES: 64,
  MAX_CUSTOM_FIELD_VALUE_BYTES: 2048,
  MAX_METADATA_FIELD_BYTES: 256,
  MAX_TIMESTAMP_BYTES: 64,
  MAX_TAGS: 20,
  MAX_TAG_BYTES: 64,
  MAX_ROW_COLUMNS: 128,
  MAX_CELL_BYTES: 8192,
  MAX_ROW_BYTES: 64 * 1024,
  MAX_BATCH_BYTES: 8 * 1024 * 1024
});

const AGGREGATE_MEASUREMENT_LIMITS = deepFreeze({
  MAX_DEPTH: 64,
  MAX_UNIQUE_CONTAINERS: 4096,
  MAX_DESCRIPTORS: 80000,
  MAX_CYCLE_SCAN_UNIQUE_CONTAINERS: 200000,
  MAX_CYCLE_SCAN_DESCRIPTORS: 200000,
  MAX_WORK_STACK: 8192
});

const DESCRIPTOR_GRAPH_SCAN_OUTCOME = Object.freeze({
  ACYCLIC: 'acyclic',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  CYCLE: 'cycle',
  SYMBOL_ORDER_UNSUPPORTED: 'symbol_order_unsupported'
});

const OPTIONAL_SYSTEM_FIELDS = Object.freeze([
  'creator_id',
  'creator_name',
  'tags',
  'product',
  'published_at'
]);

const ALLOWED_MAPPING_FIELDS = new Set([
  'content_url',
  'video_url',
  ...OPTIONAL_SYSTEM_FIELDS,
  'custom_fields'
]);

const SAFE_ERROR_DETAIL_KEYS = Object.freeze([
  'actual_bytes',
  'actual_code_units',
  'actual_columns',
  'actual_items',
  'actual_type',
  'field',
  'index',
  'max_bytes',
  'max_columns',
  'max_items',
  'min_items',
  'reason',
  'source_row_number',
  'system_field'
]);

const DANGEROUS_KEY_SEGMENTS = new Set([
  '__proto__',
  'prototype',
  'constructor'
]);

function deepFreeze(value, seen = new Set()) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      deepFreeze(descriptor.value, seen);
    }
  });
  return Object.freeze(value);
}

function primitiveType(value) {
  if (value === null) return 'null';
  if (utilTypes.isProxy(value)) return 'proxy';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function disclosedErrorDetails(details) {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {};
  const disclosed = {};
  SAFE_ERROR_DETAIL_KEYS.forEach((key) => {
    if (!Object.hasOwn(details, key)) return;
    const value = details[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      disclosed[key] = value;
    }
  });
  return disclosed;
}

class PerformanceContentImportServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceContentImportServiceError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    this.details = deepFreeze(disclosedErrorDetails(details));
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PerformanceContentImportServiceError);
    }
  }
}

function serviceError(statusCode, code, message, details) {
  return new PerformanceContentImportServiceError(statusCode, code, message, details);
}

function isDangerousKey(key) {
  if (typeof key !== 'string') return true;
  return key
    .trim()
    .toLowerCase()
    .split(/[.\[\]]+/u)
    .some((segment) => DANGEROUS_KEY_SEGMENTS.has(segment));
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareAggregateOwnKeys(left, right) {
  const leftIsString = typeof left === 'string';
  const rightIsString = typeof right === 'string';
  if (leftIsString && rightIsString) return compareText(left, right);
  if (leftIsString) return -1;
  if (rightIsString) return 1;
  // Multi-symbol containers fail closed before symbol-keyed values are traversed.
  return 0;
}

function aggregateSymbolKeyCount(keys) {
  let index = keys.length;
  while (index > 0 && typeof keys[index - 1] === 'symbol') index -= 1;
  return keys.length - index;
}

function hasWellFormedSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function measuredUtf8Bytes(value, maxBytes) {
  if (value.length > maxBytes) return null;
  if (!hasWellFormedSurrogates(value)) return -1;
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes > maxBytes ? null : bytes;
}

function saturatedLimitPlusOne(limit) {
  return limit >= Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : limit + 1;
}

function addMeasuredBytes(total, increment, limit = Number.MAX_SAFE_INTEGER) {
  const ceiling = saturatedLimitPlusOne(limit);
  if (total >= ceiling || increment >= ceiling - total) return ceiling;
  return total + increment;
}

function safelyMeasurableScalarBytes(value) {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8');
  }
  if (typeof value === 'number') {
    // Number string representations are intrinsically bounded and require no row-sized copy.
    return String(value).length;
  }
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (value === null || value === undefined) return 0;
  return null;
}

function isCanonicalArrayIndex(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  const numericIndex = Number(key);
  return (
    Number.isInteger(numericIndex) &&
    numericIndex >= 0 &&
    numericIndex < 0xffffffff &&
    String(numericIndex) === key
  );
}

function safelyInspectMeasurableContainer(value) {
  if (
    utilTypes.isProxy(value) ||
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return null;
  }

  let isArray;
  let keys;
  try {
    isArray = Array.isArray(value);
    // Residual boundary: Reflect.ownKeys is necessarily O(N) and allocates one
    // bounded key list. Callers must retain body-size admission before constructing
    // this in-memory request; descriptor values are materialized only after the
    // aggregate descriptor count is admitted below.
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }

  return {
    isArray,
    keys,
    value
  };
}

function scanReachableDescriptorGraph(values) {
  const states = new WeakMap();
  const deferredCandidates = new WeakMap();
  let inspectedContainers = 0;
  let inspectedDescriptors = 0;
  let descriptorLimit = AGGREGATE_MEASUREMENT_LIMITS.MAX_CYCLE_SCAN_DESCRIPTORS;
  let exactArbitrationDescriptors = 0;
  let budgetExhausted = false;
  let symbolOrderUnsupported = false;

  function isInspectableContainer(value) {
    return (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      !utilTypes.isProxy(value)
    );
  }

  function pushCycleWork(work, item) {
    if (work.length >= AGGREGATE_MEASUREMENT_LIMITS.MAX_WORK_STACK) return false;
    work.push(item);
    return true;
  }

  function markExactCandidatesDone(candidates) {
    candidates.forEach((candidate) => {
      states.set(candidate.container.value, 'done');
    });
  }

  function compareExactCandidates(left, right) {
    return compareAggregateOwnKeys(left.parentKey, right.parentKey);
  }

  for (let rootIndex = 0; rootIndex < values.length; rootIndex += 1) {
    const root = values[rootIndex];
    if (!isInspectableContainer(root) || states.get(root) === 'done') continue;
    const work = [{ kind: 'enter', value: root, parentFrame: null }];

    while (work.length > 0) {
      const item = work.pop();
      if (item.kind === 'finish') {
        const candidates = item.frame.exactCandidates;
        if (!item.arbitrationComplete && (candidates.length > 0 || item.frame.overflow)) {
          if (item.frame.overflow) {
            budgetExhausted = true;
            markExactCandidatesDone(candidates);
            states.set(item.value, 'done');
            continue;
          }

          const remainingDescriptors = descriptorLimit - inspectedDescriptors;
          const remainingArbitrationDescriptors =
            AGGREGATE_MEASUREMENT_LIMITS.MAX_WORK_STACK - exactArbitrationDescriptors;
          const arbitrationCeiling =
            remainingDescriptors + remainingArbitrationDescriptors;
          let candidateDescriptors = 0;
          let arbitrationFits = true;
          for (let index = 0; index < candidates.length; index += 1) {
            const candidateCount = candidates[index].container.keys.length;
            if (candidateCount > arbitrationCeiling - candidateDescriptors) {
              arbitrationFits = false;
              break;
            }
            candidateDescriptors += candidateCount;
          }
          if (
            !arbitrationFits ||
            work.length + candidates.length + 1 >
              AGGREGATE_MEASUREMENT_LIMITS.MAX_WORK_STACK
          ) {
            budgetExhausted = true;
            markExactCandidatesDone(candidates);
            states.set(item.value, 'done');
            continue;
          }

          // Exact exhaustion is resolved as cycle, then multi-symbol, then
          // descriptor budget. Only this capped frontier is canonicalized;
          // arbitrary containers wider than 80,000 keys remain unsorted.
          const requiredExtra = Math.max(
            0,
            candidateDescriptors - remainingDescriptors
          );
          exactArbitrationDescriptors += requiredExtra;
          descriptorLimit += requiredExtra;
          candidates.sort(compareExactCandidates);
          if (!pushCycleWork(work, {
            kind: 'finish',
            value: item.value,
            frame: item.frame,
            arbitrationComplete: true
          })) return DESCRIPTOR_GRAPH_SCAN_OUTCOME.BUDGET_EXHAUSTED;
          for (let index = candidates.length - 1; index >= 0; index -= 1) {
            if (!pushCycleWork(work, {
              kind: 'enter',
              value: candidates[index].container.value,
              container: candidates[index].container,
              parentFrame: null,
              resumeExactFill: true
            })) return DESCRIPTOR_GRAPH_SCAN_OUTCOME.BUDGET_EXHAUSTED;
          }
          continue;
        }
        states.set(item.value, 'done');
        continue;
      }
      if (item.kind === 'cursor') {
        const key = item.container.keys[item.keyIndex];
        const hasFollowingSibling = item.keyIndex + 1 < item.keyCount;
        if (hasFollowingSibling) {
          if (!pushCycleWork(work, {
            kind: 'cursor',
            container: item.container,
            keyIndex: item.keyIndex + 1,
            keyCount: item.keyCount,
            frame: item.frame
          })) return DESCRIPTOR_GRAPH_SCAN_OUTCOME.BUDGET_EXHAUSTED;
        }
        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(item.container.value, key);
        } catch {
          continue;
        }
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
        const child = descriptor.value;
        if (!isInspectableContainer(child)) continue;
        const childState = states.get(child);
        const deferredCandidate = deferredCandidates.get(child);
        if (childState === 'visiting') return DESCRIPTOR_GRAPH_SCAN_OUTCOME.CYCLE;
        if (
          childState !== 'done' &&
          (
            !deferredCandidate ||
            deferredCandidate.ownerFrame !== item.frame
          ) &&
          !pushCycleWork(work, {
            kind: 'enter',
            value: child,
            container: deferredCandidate && deferredCandidate.container,
            parentFrame: item.frame,
            parentKey: key,
            deferExactFill: hasFollowingSibling,
            resumeExactFill: Boolean(deferredCandidate)
          })
        ) return DESCRIPTOR_GRAPH_SCAN_OUTCOME.BUDGET_EXHAUSTED;
        continue;
      }

      const state = states.get(item.value);
      if (state === 'visiting') return DESCRIPTOR_GRAPH_SCAN_OUTCOME.CYCLE;
      if (state === 'done' || !isInspectableContainer(item.value)) continue;
      const container = item.container || safelyInspectMeasurableContainer(item.value);
      if (!container) {
        states.set(item.value, 'done');
        continue;
      }
      if (!item.resumeExactFill) {
        inspectedContainers += 1;
        if (
          inspectedContainers >
          AGGREGATE_MEASUREMENT_LIMITS.MAX_CYCLE_SCAN_UNIQUE_CONTAINERS
        ) return DESCRIPTOR_GRAPH_SCAN_OUTCOME.BUDGET_EXHAUSTED;
      }

      const symbolKeyCount = aggregateSymbolKeyCount(container.keys);
      const traversedKeyCount = symbolKeyCount > 1
        ? container.keys.length - symbolKeyCount
        : container.keys.length;
      if (symbolKeyCount > 1) symbolOrderUnsupported = true;

      const remainingDescriptors = descriptorLimit - inspectedDescriptors;
      if (container.keys.length > remainingDescriptors) {
        // This branch cannot be admitted, but already-scheduled siblings may
        // still provide bounded cycle evidence that outranks the budget error.
        budgetExhausted = true;
        const remainingArbitrationDescriptors =
          AGGREGATE_MEASUREMENT_LIMITS.MAX_WORK_STACK - exactArbitrationDescriptors;
        if (
          item.parentFrame &&
          !item.parentFrame.overflow &&
          item.parentFrame.exactCandidates.length <
            AGGREGATE_MEASUREMENT_LIMITS.MAX_WORK_STACK &&
          container.keys.length <=
            remainingDescriptors + remainingArbitrationDescriptors
        ) {
          const candidate = {
            container,
            ownerFrame: item.parentFrame,
            parentKey: item.parentKey
          };
          deferredCandidates.set(item.value, candidate);
          item.parentFrame.exactCandidates.push(candidate);
          continue;
        }
        states.set(item.value, 'done');
        continue;
      }

      if (
        !item.resumeExactFill &&
        item.parentFrame &&
        container.keys.length > 0 &&
        container.keys.length === remainingDescriptors &&
        (
          item.deferExactFill ||
          item.parentFrame.exactCandidates.length > 0 ||
          item.parentFrame.overflow
        )
      ) {
        if (
          item.parentFrame.overflow ||
          item.parentFrame.exactCandidates.length >=
            AGGREGATE_MEASUREMENT_LIMITS.MAX_WORK_STACK
        ) {
          item.parentFrame.overflow = true;
          budgetExhausted = true;
          markExactCandidatesDone(item.parentFrame.exactCandidates);
          item.parentFrame.exactCandidates.length = 0;
          states.set(item.value, 'done');
        } else {
          const candidate = {
            container,
            ownerFrame: item.parentFrame,
            parentKey: item.parentKey
          };
          deferredCandidates.set(item.value, candidate);
          item.parentFrame.exactCandidates.push(candidate);
        }
        continue;
      }

      inspectedDescriptors += container.keys.length;
      if (container.keys.length <= AGGREGATE_MEASUREMENT_LIMITS.MAX_DESCRIPTORS) {
        container.keys.sort(compareAggregateOwnKeys);
      }

      states.set(item.value, 'visiting');
      const frame = { exactCandidates: [], overflow: false };
      if (!pushCycleWork(work, {
        kind: 'finish',
        value: item.value,
        frame,
        arbitrationComplete: false
      })) {
        return DESCRIPTOR_GRAPH_SCAN_OUTCOME.BUDGET_EXHAUSTED;
      }
      if (traversedKeyCount > 0) {
        if (!pushCycleWork(work, {
          kind: 'cursor',
          container,
          keyIndex: 0,
          keyCount: traversedKeyCount,
          frame
        })) {
          return DESCRIPTOR_GRAPH_SCAN_OUTCOME.BUDGET_EXHAUSTED;
        }
      }
    }
  }
  if (symbolOrderUnsupported) {
    return DESCRIPTOR_GRAPH_SCAN_OUTCOME.SYMBOL_ORDER_UNSUPPORTED;
  }
  return budgetExhausted
    ? DESCRIPTOR_GRAPH_SCAN_OUTCOME.BUDGET_EXHAUSTED
    : DESCRIPTOR_GRAPH_SCAN_OUTCOME.ACYCLIC;
}

function safelyMeasurableBatchBytes(rows) {
  const memo = new WeakMap();
  const aggregate = { bytes: 0 };
  let uniqueContainers = 0;
  let descriptors = 0;

  function failBudget(reason, maxItems) {
    const graphScanOutcome = scanReachableDescriptorGraph(rows);
    if (graphScanOutcome === DESCRIPTOR_GRAPH_SCAN_OUTCOME.CYCLE) {
      throw serviceError(
        413,
        'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
        'Content import exceeds the aggregate byte limit.',
        {
          field: 'rows',
          max_bytes: IMPORT_LIMITS.MAX_BATCH_BYTES,
          actual_bytes: saturatedLimitPlusOne(IMPORT_LIMITS.MAX_BATCH_BYTES)
        }
      );
    }
    if (graphScanOutcome === DESCRIPTOR_GRAPH_SCAN_OUTCOME.SYMBOL_ORDER_UNSUPPORTED) {
      reason = 'aggregate_symbol_key_order_unsupported';
      maxItems = 1;
    }
    // Cycle evidence outranks every measurement budget. A bounded scan that
    // exhausts its own budget is not cycle evidence, so the already-established
    // deterministic measurement failure remains the disclosed contract.
    throw serviceError(
      413,
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      'Content import exceeds a bounded aggregate measurement budget.',
      {
        field: 'rows',
        reason,
        max_items: maxItems,
        actual_items: saturatedLimitPlusOne(maxItems)
      }
    );
  }

  function pushWork(work, item) {
    if (work.length >= AGGREGATE_MEASUREMENT_LIMITS.MAX_WORK_STACK) {
      failBudget(
        'aggregate_work_stack_limit_exceeded',
        AGGREGATE_MEASUREMENT_LIMITS.MAX_WORK_STACK
      );
    }
    work.push(item);
  }

  function addToTarget(target, increment) {
    target.bytes = addMeasuredBytes(
      target.bytes,
      increment,
      IMPORT_LIMITS.MAX_BATCH_BYTES
    );
    return target.bytes > IMPORT_LIMITS.MAX_BATCH_BYTES;
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const work = [];
    pushWork(work, {
      kind: 'value',
      value: rows[rowIndex],
      target: aggregate,
      depth: 1
    });

    while (work.length > 0) {
      const item = work.pop();
      if (item.kind === 'finish') {
        item.node.state = 'done';
        if (item.target !== aggregate) {
          item.target.height = Math.max(item.target.height, item.node.height + 1);
        }
        if (addToTarget(item.target, item.node.bytes)) {
          return saturatedLimitPlusOne(IMPORT_LIMITS.MAX_BATCH_BYTES);
        }
        continue;
      }

      if (item.kind === 'descriptor_cursor') {
        const { container, keyIndex, node } = item;
        const key = container.keys[keyIndex];
        if (keyIndex + 1 < container.keys.length) {
          pushWork(work, {
            kind: 'descriptor_cursor',
            container,
            keyIndex: keyIndex + 1,
            node,
            depth: item.depth
          });
        }

        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(container.value, key);
        } catch {
          continue;
        }
        if (!descriptor) continue;
        if (node.isArray && key === 'length') {
          continue;
        }
        if (
          typeof key === 'string' &&
          !(node.isArray && isCanonicalArrayIndex(key)) &&
          addToTarget(node, Buffer.byteLength(key, 'utf8'))
        ) {
          return saturatedLimitPlusOne(IMPORT_LIMITS.MAX_BATCH_BYTES);
        }
        if (Object.hasOwn(descriptor, 'value')) {
          pushWork(work, {
            kind: 'value',
            value: descriptor.value,
            target: node,
            depth: item.depth + 1
          });
        }
        // Accessors have no trap-free measurable value and are rejected later.
        continue;
      }

      const scalarBytes = safelyMeasurableScalarBytes(item.value);
      if (scalarBytes !== null) {
        if (addToTarget(item.target, scalarBytes)) {
          return saturatedLimitPlusOne(IMPORT_LIMITS.MAX_BATCH_BYTES);
        }
        continue;
      }

      const known = (
        item.value !== null &&
        (typeof item.value === 'object' || typeof item.value === 'function')
      )
        ? memo.get(item.value)
        : null;
      if (known) {
        if (known.state === 'visiting') {
          // Cyclic descriptor graphs have no finite occurrence semantics. Fail closed
          // before a traversal-context-dependent subtotal can enter the shared memo.
          return saturatedLimitPlusOne(IMPORT_LIMITS.MAX_BATCH_BYTES);
        }
        if (item.depth + known.height - 1 > AGGREGATE_MEASUREMENT_LIMITS.MAX_DEPTH) {
          failBudget(
            'aggregate_depth_limit_exceeded',
            AGGREGATE_MEASUREMENT_LIMITS.MAX_DEPTH
          );
        }
        if (item.target !== aggregate) {
          item.target.height = Math.max(item.target.height, known.height + 1);
        }
        if (addToTarget(item.target, known.bytes)) {
          return saturatedLimitPlusOne(IMPORT_LIMITS.MAX_BATCH_BYTES);
        }
        continue;
      }

      if (
        item.value === null ||
        (typeof item.value !== 'object' && typeof item.value !== 'function') ||
        utilTypes.isProxy(item.value)
      ) {
        // Unsafe or structurally unsupported values are rejected later without coercion.
        continue;
      }
      if (item.depth > AGGREGATE_MEASUREMENT_LIMITS.MAX_DEPTH) {
        failBudget(
          'aggregate_depth_limit_exceeded',
          AGGREGATE_MEASUREMENT_LIMITS.MAX_DEPTH
        );
      }
      uniqueContainers = addMeasuredBytes(
        uniqueContainers,
        1,
        AGGREGATE_MEASUREMENT_LIMITS.MAX_UNIQUE_CONTAINERS
      );
      if (uniqueContainers > AGGREGATE_MEASUREMENT_LIMITS.MAX_UNIQUE_CONTAINERS) {
        failBudget(
          'aggregate_unique_container_limit_exceeded',
          AGGREGATE_MEASUREMENT_LIMITS.MAX_UNIQUE_CONTAINERS
        );
      }
      const container = safelyInspectMeasurableContainer(item.value);
      if (!container) continue;

      const remainingDescriptors = AGGREGATE_MEASUREMENT_LIMITS.MAX_DESCRIPTORS - descriptors;
      if (container.keys.length > remainingDescriptors) {
        failBudget(
          'aggregate_descriptor_limit_exceeded',
          AGGREGATE_MEASUREMENT_LIMITS.MAX_DESCRIPTORS
        );
      }
      descriptors += container.keys.length;

      if (aggregateSymbolKeyCount(container.keys) > 1) {
        failBudget('aggregate_symbol_key_order_unsupported', 1);
      }

      // Deterministic budget precedence for admitted containers is canonical
      // string-key DFS, with per-node depth, unique-container, then descriptor
      // checks. Sorting occurs only after the 80,000-descriptor admission gate;
      // over-wide cycle probes retain their bounded raw-order scan semantics.
      container.keys.sort(compareAggregateOwnKeys);

      const node = {
        state: 'visiting',
        bytes: 0,
        height: 1,
        isArray: container.isArray
      };
      memo.set(item.value, node);
      pushWork(work, {
        kind: 'finish',
        node,
        target: item.target
      });
      if (container.keys.length > 0) {
        pushWork(work, {
          kind: 'descriptor_cursor',
          container,
          keyIndex: 0,
          node,
          depth: item.depth
        });
      }
    }
  }
  return aggregate.bytes;
}

function plainRecordSnapshot(value, rules) {
  if (utilTypes.isProxy(value)) {
    throw serviceError(400, rules.unsafeCode, rules.unsafeMessage, {
      field: rules.field,
      reason: 'proxy_forbidden'
    });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(400, rules.typeCode, rules.typeMessage, {
      field: rules.field,
      actual_type: primitiveType(value)
    });
  }

  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    // Residual boundary: request middleware must admit raw body bytes before
    // parsing. Reflect.ownKeys necessarily allocates one key list, so reject an
    // over-wide parsed shape before sorting keys or reading any descriptors.
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw serviceError(400, rules.unsafeCode, rules.unsafeMessage, {
      field: rules.field,
      reason: 'inspection_failed'
    });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw serviceError(400, rules.containerCode, rules.containerMessage, {
      field: rules.field,
      reason: 'non_plain_object'
    });
  }
  if (rules.admitKeyCount) rules.admitKeyCount(ownKeys.length);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw serviceError(400, rules.containerCode, rules.containerMessage, {
      field: rules.field,
      reason: 'symbol_key_forbidden'
    });
  }

  const keys = ownKeys.slice().sort(compareText);
  keys.forEach((key) => {
    if (isDangerousKey(key)) {
      throw serviceError(400, rules.dangerousCode, rules.dangerousMessage, {
        field: rules.field,
        reason: 'dangerous_key'
      });
    }
  });
  if (rules.admitKeys) rules.admitKeys(keys);

  const snapshot = Object.create(null);
  keys.forEach((key) => {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw serviceError(400, rules.unsafeCode, rules.unsafeMessage, {
        field: rules.field,
        reason: 'inspection_failed'
      });
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw serviceError(400, rules.accessorCode, rules.accessorMessage, {
        field: rules.field,
        reason: 'accessor_forbidden'
      });
    }
    if (!descriptor.enumerable) {
      throw serviceError(400, rules.containerCode, rules.containerMessage, {
        field: rules.field,
        reason: 'non_enumerable_property'
      });
    }
    snapshot[key] = descriptor.value;
  });
  return { snapshot, keys };
}

function requestSnapshot(request) {
  const allowed = new Set([
    'campaign_id',
    'rows',
    'column_mapping',
    'mapping_version',
    'provenance'
  ]);
  function rejectUnknownField() {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_REQUEST_FIELD_UNKNOWN',
      'Content import request contains an unknown field.',
      { field: 'request', reason: 'unknown_field' }
    );
  }
  const inspected = plainRecordSnapshot(request, {
    field: 'request',
    unsafeCode: 'PERFORMANCE_CONTENT_IMPORT_REQUEST_CONTAINER_UNSAFE',
    unsafeMessage: 'Content import request cannot be inspected safely.',
    typeCode: 'PERFORMANCE_CONTENT_IMPORT_REQUEST_TYPE_INVALID',
    typeMessage: 'Content import request must be a plain object.',
    containerCode: 'PERFORMANCE_CONTENT_IMPORT_REQUEST_CONTAINER_INVALID',
    containerMessage: 'Content import request must be an ordinary plain object.',
    accessorCode: 'PERFORMANCE_CONTENT_IMPORT_REQUEST_ACCESSOR_FORBIDDEN',
    accessorMessage: 'Content import request accessors are forbidden.',
    dangerousCode: 'PERFORMANCE_CONTENT_IMPORT_REQUEST_DANGEROUS_KEY',
    dangerousMessage: 'Content import request contains a dangerous key.',
    admitKeyCount(keyCount) {
      if (keyCount > allowed.size) rejectUnknownField();
    },
    admitKeys(keys) {
      if (keys.some((key) => !allowed.has(key))) rejectUnknownField();
    }
  });
  return inspected.snapshot;
}

function requireBoundedContractString(value, options) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw serviceError(400, options.invalidCode, options.invalidMessage, {
      field: options.field,
      actual_type: primitiveType(value)
    });
  }
  const byteLength = measuredUtf8Bytes(value, options.maxBytes);
  if (byteLength === -1 || /[\x00-\x1f\x7f]/u.test(value)) {
    throw serviceError(400, options.invalidCode, options.invalidMessage, {
      field: options.field,
      reason: byteLength === -1 ? 'malformed_unicode' : 'control_character'
    });
  }
  if (byteLength === null) {
    throw serviceError(413, options.tooLargeCode, options.tooLargeMessage, {
      field: options.field,
      max_bytes: options.maxBytes,
      actual_code_units: value.length
    });
  }
  return value;
}

function validateCampaignId(value) {
  return requireBoundedContractString(value, {
    field: 'campaign_id',
    maxBytes: IMPORT_LIMITS.MAX_CAMPAIGN_ID_BYTES,
    invalidCode: 'PERFORMANCE_CONTENT_IMPORT_CAMPAIGN_ID_INVALID',
    invalidMessage: 'Campaign ID must be a non-empty primitive string.',
    tooLargeCode: 'PERFORMANCE_CONTENT_IMPORT_CAMPAIGN_ID_TOO_LARGE',
    tooLargeMessage: 'Campaign ID exceeds the import contract limit.'
  });
}

function validateMappingVersion(value) {
  return requireBoundedContractString(value, {
    field: 'mapping_version',
    maxBytes: IMPORT_LIMITS.MAX_MAPPING_VERSION_BYTES,
    invalidCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_VERSION_INVALID',
    invalidMessage: 'Mapping version must be a non-empty primitive string.',
    tooLargeCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_VERSION_TOO_LARGE',
    tooLargeMessage: 'Mapping version exceeds the import contract limit.'
  });
}

function validateSourceColumn(value, systemField) {
  const sourceColumn = requireBoundedContractString(value, {
    field: 'column_mapping',
    maxBytes: IMPORT_LIMITS.MAX_SOURCE_COLUMN_BYTES,
    invalidCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_COLUMN_INVALID',
    invalidMessage: 'Mapped source columns must be non-empty primitive strings.',
    tooLargeCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_COLUMN_TOO_LARGE',
    tooLargeMessage: 'Mapped source column exceeds the import contract limit.'
  });
  if (sourceColumn === 'source_row_number' || isDangerousKey(sourceColumn)) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_MAPPING_DANGEROUS_KEY',
      'Mapped source column is reserved or dangerous.',
      { field: 'column_mapping', system_field: systemField, reason: 'reserved_or_dangerous' }
    );
  }
  return sourceColumn;
}

function validateCustomFieldName(value) {
  if (isDangerousKey(value)) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_MAPPING_DANGEROUS_KEY',
      'Custom field mapping contains a dangerous key.',
      { field: 'column_mapping.custom_fields', reason: 'dangerous_key' }
    );
  }
  return requireBoundedContractString(value, {
    field: 'column_mapping.custom_fields',
    maxBytes: IMPORT_LIMITS.MAX_CUSTOM_FIELD_NAME_BYTES,
    invalidCode: 'PERFORMANCE_CONTENT_IMPORT_CUSTOM_FIELD_NAME_INVALID',
    invalidMessage: 'Custom field names must be non-empty primitive strings.',
    tooLargeCode: 'PERFORMANCE_CONTENT_IMPORT_CUSTOM_FIELD_NAME_TOO_LARGE',
    tooLargeMessage: 'Custom field name exceeds the import contract limit.'
  });
}

function validateColumnMapping(value) {
  function rejectUnknownSystemField() {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_MAPPING_FIELD_UNKNOWN',
      'Column mapping contains an unknown system field.',
      { field: 'column_mapping', reason: 'unknown_system_field' }
    );
  }
  const inspected = plainRecordSnapshot(value, {
    field: 'column_mapping',
    unsafeCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_CONTAINER_UNSAFE',
    unsafeMessage: 'Column mapping cannot be inspected safely.',
    typeCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_TYPE_INVALID',
    typeMessage: 'Column mapping must be a plain object.',
    containerCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_CONTAINER_INVALID',
    containerMessage: 'Column mapping must be an ordinary plain object.',
    accessorCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_ACCESSOR_FORBIDDEN',
    accessorMessage: 'Column mapping accessors are forbidden.',
    dangerousCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_DANGEROUS_KEY',
    dangerousMessage: 'Column mapping contains a dangerous key.',
    admitKeyCount(keyCount) {
      if (keyCount > ALLOWED_MAPPING_FIELDS.size) rejectUnknownSystemField();
    },
    admitKeys(keys) {
      if (keys.some((key) => !ALLOWED_MAPPING_FIELDS.has(key))) {
        rejectUnknownSystemField();
      }
    }
  });
  const values = inspected.snapshot;

  const hasContentUrl = Object.hasOwn(values, 'content_url');
  const hasVideoUrl = Object.hasOwn(values, 'video_url');
  if (!hasContentUrl && !hasVideoUrl) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_URL_MAPPING_REQUIRED',
      'Column mapping must map a content or video URL.',
      { field: 'column_mapping.content_url' }
    );
  }
  if (hasContentUrl && hasVideoUrl) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_URL_MAPPING_AMBIGUOUS',
      'Column mapping must map exactly one content or video URL field.',
      { field: 'column_mapping', reason: 'multiple_url_mappings' }
    );
  }

  const usedSourceColumns = new Set();
  function registerSourceColumn(sourceColumn, systemField) {
    if (usedSourceColumns.has(sourceColumn)) {
      throw serviceError(
        400,
        'PERFORMANCE_CONTENT_IMPORT_MAPPING_COLUMN_DUPLICATE',
        'Each mapped system or custom field must use a distinct source column.',
        { field: 'column_mapping', system_field: systemField, reason: 'duplicate_source_column' }
      );
    }
    usedSourceColumns.add(sourceColumn);
    return sourceColumn;
  }

  const urlKey = hasContentUrl ? 'content_url' : 'video_url';
  const normalized = {
    content_url: registerSourceColumn(
      validateSourceColumn(values[urlKey], 'content_url'),
      'content_url'
    )
  };
  OPTIONAL_SYSTEM_FIELDS.forEach((field) => {
    if (!Object.hasOwn(values, field)) return;
    normalized[field] = registerSourceColumn(
      validateSourceColumn(values[field], field),
      field
    );
  });

  const customFields = {};
  if (Object.hasOwn(values, 'custom_fields')) {
    const custom = plainRecordSnapshot(values.custom_fields, {
      field: 'column_mapping.custom_fields',
      unsafeCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_CONTAINER_UNSAFE',
      unsafeMessage: 'Custom field mapping cannot be inspected safely.',
      typeCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_TYPE_INVALID',
      typeMessage: 'Custom field mapping must be a plain object.',
      containerCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_CONTAINER_INVALID',
      containerMessage: 'Custom field mapping must be an ordinary plain object.',
      accessorCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_ACCESSOR_FORBIDDEN',
      accessorMessage: 'Custom field mapping accessors are forbidden.',
      dangerousCode: 'PERFORMANCE_CONTENT_IMPORT_MAPPING_DANGEROUS_KEY',
      dangerousMessage: 'Custom field mapping contains a dangerous key.',
      admitKeyCount(keyCount) {
        if (keyCount <= IMPORT_LIMITS.MAX_CUSTOM_FIELDS) return;
        throw serviceError(
          413,
          'PERFORMANCE_CONTENT_IMPORT_CUSTOM_FIELDS_TOO_LARGE',
          'Custom field mapping exceeds the import contract limit.',
          {
            field: 'column_mapping.custom_fields',
            max_items: IMPORT_LIMITS.MAX_CUSTOM_FIELDS,
            actual_items: keyCount
          }
        );
      }
    });
    custom.keys.forEach((fieldName) => {
      const normalizedName = validateCustomFieldName(fieldName);
      customFields[normalizedName] = registerSourceColumn(
        validateSourceColumn(custom.snapshot[fieldName], 'custom_fields'),
        'custom_fields'
      );
    });
  }
  normalized.custom_fields = customFields;
  return normalized;
}

function validateProvenance(value) {
  function rejectShape() {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_PROVENANCE_INVALID',
      'Import provenance must contain only source_mode and file_hash.',
      { field: 'provenance', reason: 'shape_invalid' }
    );
  }
  const inspected = plainRecordSnapshot(value, {
    field: 'provenance',
    unsafeCode: 'PERFORMANCE_CONTENT_IMPORT_PROVENANCE_CONTAINER_UNSAFE',
    unsafeMessage: 'Import provenance cannot be inspected safely.',
    typeCode: 'PERFORMANCE_CONTENT_IMPORT_PROVENANCE_TYPE_INVALID',
    typeMessage: 'Import provenance must be a plain object.',
    containerCode: 'PERFORMANCE_CONTENT_IMPORT_PROVENANCE_CONTAINER_INVALID',
    containerMessage: 'Import provenance must be an ordinary plain object.',
    accessorCode: 'PERFORMANCE_CONTENT_IMPORT_PROVENANCE_ACCESSOR_FORBIDDEN',
    accessorMessage: 'Import provenance accessors are forbidden.',
    dangerousCode: 'PERFORMANCE_CONTENT_IMPORT_PROVENANCE_DANGEROUS_KEY',
    dangerousMessage: 'Import provenance contains a dangerous key.',
    admitKeyCount(keyCount) {
      if (keyCount !== 2) rejectShape();
    },
    admitKeys(keys) {
      if (keys.some((key) => key !== 'source_mode' && key !== 'file_hash')) {
        rejectShape();
      }
    }
  });
  if (inspected.snapshot.source_mode !== SOURCE_MODE) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_SOURCE_MODE_INVALID',
      'Content import source mode must be csv_xlsx.',
      { field: 'provenance.source_mode' }
    );
  }
  if (
    typeof inspected.snapshot.file_hash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(inspected.snapshot.file_hash)
  ) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_FILE_HASH_INVALID',
      'Content import file hash must be a lowercase SHA-256 hexadecimal digest.',
      { field: 'provenance.file_hash' }
    );
  }
  return {
    source_mode: SOURCE_MODE,
    file_hash: inspected.snapshot.file_hash
  };
}

function snapshotDenseRows(rows) {
  if (utilTypes.isProxy(rows)) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_UNSAFE',
      'Content import rows Proxy containers are forbidden.',
      { field: 'rows', reason: 'proxy_forbidden' }
    );
  }
  if (!Array.isArray(rows)) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_TYPE_INVALID',
      'Content import rows must be an Array.',
      { field: 'rows', actual_type: primitiveType(rows) }
    );
  }
  if (Object.getPrototypeOf(rows) !== Array.prototype) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_INVALID',
      'Content import rows must be a plain Array.',
      { field: 'rows', reason: 'non_plain_array' }
    );
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(rows, 'length');
  const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value')
    ? lengthDescriptor.value
    : null;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_INVALID',
      'Content import rows have an invalid length descriptor.',
      { field: 'rows.length' }
    );
  }
  if (length === 0) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_EMPTY',
      'Content import must contain at least one row.',
      { field: 'rows', min_items: 1 }
    );
  }
  if (length > MAX_IMPORT_ROWS || length > PUBLICATION_IDENTITY_MAX_BATCH_SIZE) {
    throw serviceError(
      413,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_TOO_LARGE',
      'Content import exceeds the 500-row admission limit.',
      { field: 'rows', max_items: MAX_IMPORT_ROWS, actual_items: length }
    );
  }

  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(rows);
  } catch {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_UNSAFE',
      'Content import rows cannot be inspected safely.',
      { field: 'rows', reason: 'inspection_failed' }
    );
  }

  const expectedKeyCount = length + 1;
  if (ownKeys.length > expectedKeyCount) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_INVALID',
      'Content import rows must not contain non-row properties.',
      { field: 'rows', reason: 'unexpected_own_property' }
    );
  }
  const allowedKeys = new Set(['length']);
  for (let index = 0; index < length; index += 1) allowedKeys.add(String(index));
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_INVALID',
      'Content import rows must not contain non-row properties.',
      { field: 'rows', reason: 'unexpected_own_property' }
    );
  }

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
    } catch {
      throw serviceError(
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_UNSAFE',
        'Content import rows cannot be inspected safely.',
        { field: 'rows', reason: 'inspection_failed' }
      );
    }
    if (!descriptor) {
      throw serviceError(
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROWS_MUST_BE_DENSE',
        'Content import rows must not contain sparse entries.',
        { field: 'rows', index }
      );
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw serviceError(
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROWS_ACCESSOR_FORBIDDEN',
        'Content import row accessors are forbidden.',
        { field: 'rows', index }
      );
    }
    if (!descriptor.enumerable) {
      throw serviceError(
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROWS_CONTAINER_INVALID',
        'Content import row descriptors must be ordinary enumerable values.',
        { field: 'rows', index, reason: 'non_enumerable_row' }
      );
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function safeSourceRowNumber(descriptors) {
  const descriptor = descriptors && descriptors.source_row_number;
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
  const value = descriptor.value;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function inspectableSourceRowNumber(value) {
  if (
    utilTypes.isProxy(value) ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return null;
  }
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, 'source_row_number');
  } catch {
    return null;
  }
  return safeSourceRowNumber({ source_row_number: descriptor });
}

function validateUniqueSourceRowNumbers(rows) {
  const firstIndexBySourceRowNumber = new Map();
  rows.forEach((row, index) => {
    const sourceRowNumber = inspectableSourceRowNumber(row);
    if (sourceRowNumber === null) return;
    if (firstIndexBySourceRowNumber.has(sourceRowNumber)) {
      throw serviceError(
        400,
        'PERFORMANCE_CONTENT_IMPORT_SOURCE_ROW_NUMBER_DUPLICATE',
        'Content import source_row_number values must be unique within the batch.',
        {
          field: 'rows',
          index,
          source_row_number: sourceRowNumber,
          reason: 'duplicate_source_row_number'
        }
      );
    }
    firstIndexBySourceRowNumber.set(sourceRowNumber, index);
  });
}

function rowError(index, sourceRowNumber, statusCode, code, message, reason) {
  return serviceError(statusCode, code, message, {
    field: 'rows[' + index + ']',
    index,
    source_row_number: sourceRowNumber,
    reason
  });
}

function snapshotTagArray(value, index, sourceRowNumber) {
  if (utilTypes.isProxy(value)) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      'Mapped tags must use a safe dense Array or a comma-delimited string.',
      'proxy_forbidden'
    );
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      'Mapped tags must use a safe dense Array or a comma-delimited string.',
      'non_plain_array'
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value')
    ? lengthDescriptor.value
    : null;
  if (!Number.isSafeInteger(length) || length < 0 || length > IMPORT_LIMITS.MAX_TAGS) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      'Mapped tags exceed the tag count limit or have an invalid length.',
      'tag_count_invalid'
    );
  }
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      'Mapped tags cannot be inspected safely.',
      'inspection_failed'
    );
  }
  const expectedKeyCount = length + 1;
  if (ownKeys.length > expectedKeyCount) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      'Mapped tags must not contain non-tag properties.',
      'unexpected_own_property'
    );
  }
  const allowedKeys = new Set(['length']);
  for (let tagIndex = 0; tagIndex < length; tagIndex += 1) {
    allowedKeys.add(String(tagIndex));
  }
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      'Mapped tags must not contain non-tag properties.',
      'unexpected_own_property'
    );
  }
  const snapshot = [];
  for (let tagIndex = 0; tagIndex < length; tagIndex += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(tagIndex));
    } catch {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
        'Mapped tags cannot be inspected safely.',
        'inspection_failed'
      );
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
        'Mapped tags must be a dense Array of ordinary values.',
        descriptor ? 'accessor_or_descriptor_forbidden' : 'sparse_tags'
      );
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function inspectRowRecord(value, mapping, index) {
  if (utilTypes.isProxy(value)) {
    throw rowError(
      index,
      null,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_UNSAFE',
      'Parsed import row Proxy containers are forbidden.',
      'proxy_forbidden'
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw rowError(
      index,
      null,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TYPE_INVALID',
      'Parsed import rows must be plain objects.',
      'non_object_row'
    );
  }

  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw rowError(
      index,
      null,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_UNSAFE',
      'Parsed import row cannot be inspected safely.',
      'inspection_failed'
    );
  }
  if (ownKeys.length > IMPORT_LIMITS.MAX_ROW_COLUMNS) {
    throw rowError(
      index,
      null,
      413,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TOO_MANY_COLUMNS',
      'Parsed import row exceeds the column limit.',
      'column_limit_exceeded'
    );
  }

  let sourceRowDescriptor;
  try {
    if (ownKeys.includes('source_row_number')) {
      sourceRowDescriptor = Object.getOwnPropertyDescriptor(value, 'source_row_number');
    }
  } catch {
    throw rowError(
      index,
      null,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_UNSAFE',
      'Parsed import row cannot be inspected safely.',
      'inspection_failed'
    );
  }
  const sourceRowNumber = safeSourceRowNumber({
    source_row_number: sourceRowDescriptor
  });
  if (prototype !== Object.prototype && prototype !== null) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_INVALID',
      'Parsed import row must be an ordinary plain object.',
      'non_plain_object'
    );
  }
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_INVALID',
      'Parsed import rows cannot contain symbol keys.',
      'symbol_key_forbidden'
    );
  }
  const keys = ownKeys.slice().sort(compareText);
  const snapshot = Object.create(null);
  let rowBytes = 0;
  keys.forEach((key) => {
    if (isDangerousKey(key)) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_DANGEROUS_KEY',
        'Parsed import row contains a dangerous key.',
        'dangerous_key'
      );
    }
    let descriptor;
    try {
      descriptor = key === 'source_row_number'
        ? sourceRowDescriptor
        : Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_UNSAFE',
        'Parsed import row cannot be inspected safely.',
        'inspection_failed'
      );
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_ACCESSOR_FORBIDDEN',
        'Parsed import row accessors are forbidden.',
        'accessor_forbidden'
      );
    }
    if (!descriptor.enumerable) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_CONTAINER_INVALID',
        'Parsed import row properties must be ordinary enumerable values.',
        'non_enumerable_property'
      );
    }

    const keyBytes = measuredUtf8Bytes(key, IMPORT_LIMITS.MAX_SOURCE_COLUMN_BYTES);
    if (keyBytes === null) {
      throw rowError(
        index,
        sourceRowNumber,
        413,
        'PERFORMANCE_CONTENT_IMPORT_ROW_FIELD_TOO_LARGE',
        'Parsed import row contains an oversized column name.',
        'column_name_too_large'
      );
    }
    if (keyBytes === -1 || /[\x00-\x1f\x7f]/u.test(key)) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
        'Parsed import row contains malformed column metadata.',
        'column_name_invalid'
      );
    }
    rowBytes += keyBytes;

    let cell = descriptor.value;
    if (utilTypes.isProxy(cell) || Array.isArray(cell)) {
      if (key !== mapping.tags) {
        throw rowError(
          index,
          sourceRowNumber,
          400,
          'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
          'Parsed import metadata must use bounded scalar cells.',
          'nested_metadata_forbidden'
        );
      }
      cell = snapshotTagArray(cell, index, sourceRowNumber);
      cell.forEach((tag) => {
        if (typeof tag !== 'string') {
          throw rowError(
            index,
            sourceRowNumber,
            400,
            'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
            'Mapped tags must contain only primitive strings.',
            'tag_type_invalid'
          );
        }
        const tagBytes = measuredUtf8Bytes(tag, IMPORT_LIMITS.MAX_CELL_BYTES);
        if (tagBytes === null || tagBytes === -1) {
          throw rowError(
            index,
            sourceRowNumber,
            400,
            'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
            'Mapped tags contain malformed or oversized text.',
            'tag_text_invalid'
          );
        }
        rowBytes += tagBytes;
      });
    } else if (typeof cell === 'string') {
      const cellBytes = measuredUtf8Bytes(cell, IMPORT_LIMITS.MAX_CELL_BYTES);
      if (cellBytes === null) {
        throw rowError(
          index,
          sourceRowNumber,
          413,
          'PERFORMANCE_CONTENT_IMPORT_ROW_FIELD_TOO_LARGE',
          'Parsed import row contains an oversized string cell.',
          'cell_too_large'
        );
      }
      if (cellBytes === -1) {
        throw rowError(
          index,
          sourceRowNumber,
          400,
          'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
          'Parsed import row contains malformed Unicode metadata.',
          'malformed_unicode'
        );
      }
      rowBytes += cellBytes;
    } else if (cell === null || cell === undefined) {
      // Missing parsed cells are preserved as null/empty contract values later.
    } else if (typeof cell === 'number') {
      if (!Number.isFinite(cell)) {
        throw rowError(
          index,
          sourceRowNumber,
          400,
          'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
          'Parsed numeric metadata must be finite.',
          'non_finite_number'
        );
      }
      rowBytes += String(cell).length;
    } else if (typeof cell === 'boolean') {
      rowBytes += cell ? 4 : 5;
    } else {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
        'Parsed import metadata must use bounded scalar cells.',
        'nested_or_unsupported_metadata'
      );
    }
    snapshot[key] = cell;

    if (rowBytes > IMPORT_LIMITS.MAX_ROW_BYTES) {
      throw rowError(
        index,
        sourceRowNumber,
        413,
        'PERFORMANCE_CONTENT_IMPORT_ROW_TOO_LARGE',
        'Parsed import row exceeds the byte limit.',
        'row_byte_limit_exceeded'
      );
    }
  });

  if (!Number.isSafeInteger(snapshot.source_row_number) || snapshot.source_row_number <= 0) {
    throw rowError(
      index,
      null,
      400,
      'PERFORMANCE_CONTENT_IMPORT_SOURCE_ROW_NUMBER_INVALID',
      'Parsed import row must include a positive safe source_row_number.',
      'source_row_number_invalid'
    );
  }
  return {
    snapshot,
    sourceRowNumber: snapshot.source_row_number,
    rowBytes
  };
}

function mappedCell(row, sourceColumn) {
  if (!sourceColumn || !Object.hasOwn(row, sourceColumn)) return undefined;
  return row[sourceColumn];
}

function optionalMetadataString(value, field, index, sourceRowNumber, maxBytes) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
      'Mapped optional metadata must be a primitive string when present.',
      field + '_type_invalid'
    );
  }
  if (value.trim().length === 0) return null;
  const byteLength = measuredUtf8Bytes(value, maxBytes);
  if (byteLength === null) {
    throw rowError(
      index,
      sourceRowNumber,
      413,
      'PERFORMANCE_CONTENT_IMPORT_ROW_FIELD_TOO_LARGE',
      'Mapped optional metadata exceeds the field limit.',
      field + '_too_large'
    );
  }
  if (byteLength === -1 || /[\x00-\x1f\x7f]/u.test(value)) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
      'Mapped optional metadata contains malformed text.',
      field + '_text_invalid'
    );
  }
  return value;
}

function normalizeTags(value, index, sourceRowNumber) {
  if (value === undefined || value === null) return [];
  let tags;
  if (typeof value === 'string') {
    if (value.trim().length === 0) return [];
    tags = value.split(',');
    if (tags.length > IMPORT_LIMITS.MAX_TAGS) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
        'Mapped tags exceed the tag count limit.',
        'tag_count_invalid'
      );
    }
  } else if (utilTypes.isProxy(value) || Array.isArray(value)) {
    tags = snapshotTagArray(value, index, sourceRowNumber);
  } else {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
      'Mapped tags must use a safe dense Array or a comma-delimited string.',
      'tag_container_invalid'
    );
  }

  const seen = new Set();
  return tags.map((tag) => {
    if (typeof tag !== 'string') {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
        'Mapped tags must contain only primitive strings.',
        'tag_type_invalid'
      );
    }
    const normalized = tag.trim();
    if (normalized.length === 0) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
        'Mapped tags must not contain empty values.',
        'empty_tag'
      );
    }
    const byteLength = measuredUtf8Bytes(normalized, IMPORT_LIMITS.MAX_TAG_BYTES);
    if (byteLength === null || byteLength === -1 || /[\x00-\x1f\x7f]/u.test(normalized)) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
        'Mapped tag text is malformed or oversized.',
        'tag_text_invalid'
      );
    }
    if (seen.has(normalized)) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_TAGS_INVALID',
        'Mapped tags must not contain duplicates.',
        'duplicate_tag'
      );
    }
    seen.add(normalized);
    return normalized;
  });
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] || 0;
}

function isStrictRfc3339Timestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  if (match[7]) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return false;
    }
  }
  return true;
}

function normalizeTimestamp(value, index, sourceRowNumber) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  if (typeof value !== 'string') {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TIMESTAMP_INVALID',
      'Mapped published_at must be a strict RFC3339 primitive string.',
      'timestamp_type_invalid'
    );
  }
  const byteLength = measuredUtf8Bytes(value, IMPORT_LIMITS.MAX_TIMESTAMP_BYTES);
  if (byteLength === null || byteLength === -1 || !isStrictRfc3339Timestamp(value)) {
    throw rowError(
      index,
      sourceRowNumber,
      400,
      'PERFORMANCE_CONTENT_IMPORT_ROW_TIMESTAMP_INVALID',
      'Mapped published_at must be a real RFC3339 instant with an explicit timezone.',
      'timestamp_malformed'
    );
  }
  return value;
}

function normalizeCustomValue(value, index, sourceRowNumber) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    if (value.trim().length === 0) return null;
    const byteLength = measuredUtf8Bytes(value, IMPORT_LIMITS.MAX_CUSTOM_FIELD_VALUE_BYTES);
    if (byteLength === null) {
      throw rowError(
        index,
        sourceRowNumber,
        413,
        'PERFORMANCE_CONTENT_IMPORT_ROW_CUSTOM_FIELD_TOO_LARGE',
        'Mapped custom field exceeds the value limit.',
        'custom_field_too_large'
      );
    }
    if (byteLength === -1 || value.includes('\u0000')) {
      throw rowError(
        index,
        sourceRowNumber,
        400,
        'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
        'Mapped custom field contains malformed text.',
        'custom_field_text_invalid'
      );
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  throw rowError(
    index,
    sourceRowNumber,
    400,
    'PERFORMANCE_CONTENT_IMPORT_ROW_METADATA_INVALID',
    'Mapped custom fields must be bounded scalar values.',
    'custom_field_type_invalid'
  );
}

function validateInspectedRow(inspected, mapping, index) {
  const row = inspected.snapshot;
  const sourceRowNumber = inspected.sourceRowNumber;
  const customFields = {};
  Object.keys(mapping.custom_fields).sort(compareText).forEach((fieldName) => {
    customFields[fieldName] = normalizeCustomValue(
      mappedCell(row, mapping.custom_fields[fieldName]),
      index,
      sourceRowNumber
    );
  });
  return {
    index,
    sourceRowNumber,
    rowBytes: inspected.rowBytes,
    url: mappedCell(row, mapping.content_url),
    creatorId: optionalMetadataString(
      mappedCell(row, mapping.creator_id),
      'creator_id',
      index,
      sourceRowNumber,
      IMPORT_LIMITS.MAX_METADATA_FIELD_BYTES
    ),
    creatorName: optionalMetadataString(
      mappedCell(row, mapping.creator_name),
      'creator_name',
      index,
      sourceRowNumber,
      IMPORT_LIMITS.MAX_METADATA_FIELD_BYTES
    ),
    tags: normalizeTags(mappedCell(row, mapping.tags), index, sourceRowNumber),
    product: optionalMetadataString(
      mappedCell(row, mapping.product),
      'product',
      index,
      sourceRowNumber,
      IMPORT_LIMITS.MAX_METADATA_FIELD_BYTES
    ),
    publishedAt: normalizeTimestamp(
      mappedCell(row, mapping.published_at),
      index,
      sourceRowNumber
    ),
    customFields
  };
}

function errorSnapshot(error, index, sourceRowNumber) {
  const details = disclosedErrorDetails(error && error.details);
  details.index = index;
  if (sourceRowNumber !== null) details.source_row_number = sourceRowNumber;
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    code: typeof error.code === 'string' ? error.code : 'PERFORMANCE_CONTENT_IMPORT_ROW_INVALID',
    status: Number.isInteger(error.status) ? error.status : 400,
    statusCode: Number.isInteger(error.statusCode) ? error.statusCode : 400,
    message: typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : 'Content import row was rejected.',
    details
  };
}

function rejectedRow(index, sourceRowNumber, error) {
  return {
    index,
    source_row_number: sourceRowNumber,
    outcome: 'rejected',
    status: 'rejected',
    first_index: null,
    first_source_row_number: null,
    duplicate_of_source_row_number: null,
    platform: null,
    platform_content_id: null,
    canonical_url: null,
    canonical_identity: null,
    fingerprint: null,
    identity_kind: null,
    original_url: null,
    original_url_disclosure: REJECTED_ORIGINAL_URL_DISCLOSURE,
    draft: null,
    error: errorSnapshot(error, index, sourceRowNumber)
  };
}

function cloneSortedRecord(value) {
  const clone = {};
  Object.keys(value).sort(compareText).forEach((key) => {
    clone[key] = value[key];
  });
  return clone;
}

function buildDraft(context, candidate, admitted) {
  const customFields = cloneSortedRecord(candidate.customFields);
  const searchCustomFields = cloneSortedRecord(candidate.customFields);
  return {
    campaign_id: context.campaignId,
    source_row_number: candidate.sourceRowNumber,
    source_mode: context.provenance.source_mode,
    file_hash: context.provenance.file_hash,
    mapping_version: context.mappingVersion,
    original_url: admitted.original_url,
    canonical_url: admitted.canonical_url,
    canonical_identity: admitted.canonical_identity,
    fingerprint: admitted.fingerprint,
    identity_kind: admitted.identity_kind,
    platform: admitted.platform,
    platform_content_id: admitted.platform_content_id,
    creator_id: candidate.creatorId,
    creator_name: candidate.creatorName,
    tags: candidate.tags.slice(),
    product: candidate.product,
    published_at: candidate.publishedAt,
    custom_fields: customFields,
    search_payload: {
      creator_id: candidate.creatorId,
      creator_name: candidate.creatorName,
      original_url: admitted.original_url,
      canonical_url: admitted.canonical_url,
      canonical_identity: admitted.canonical_identity,
      platform_content_id: admitted.platform_content_id,
      tags: candidate.tags.slice(),
      product: candidate.product,
      custom_fields: searchCustomFields
    }
  };
}

function admittedRow(candidate, admitted, firstCandidate, draft) {
  const duplicate = admitted.outcome === 'duplicate';
  return {
    index: candidate.index,
    source_row_number: candidate.sourceRowNumber,
    outcome: admitted.outcome,
    status: admitted.outcome,
    first_index: firstCandidate.index,
    first_source_row_number: firstCandidate.sourceRowNumber,
    duplicate_of_source_row_number: duplicate ? firstCandidate.sourceRowNumber : null,
    platform: admitted.platform,
    platform_content_id: admitted.platform_content_id,
    canonical_url: admitted.canonical_url,
    canonical_identity: admitted.canonical_identity,
    fingerprint: admitted.fingerprint,
    identity_kind: admitted.identity_kind,
    original_url: admitted.original_url,
    original_url_disclosure: null,
    draft,
    error: null
  };
}

/**
 * Prepare immutable, provider-independent publication drafts from already parsed
 * CSV/XLSX rows. The column mapping maps supported system fields to source
 * column names; source_row_number is required directly on every parsed row.
 * This function performs no persistence, routing, networking, provider access,
 * deliverable resolution, or metric calculation.
 */
function preparePerformanceContentImport(request) {
  const input = requestSnapshot(request);
  const campaignId = validateCampaignId(input.campaign_id);
  const mappingVersion = validateMappingVersion(input.mapping_version);
  const provenance = validateProvenance(input.provenance);
  const mapping = validateColumnMapping(input.column_mapping);
  const rows = snapshotDenseRows(input.rows);
  const totalBatchBytes = safelyMeasurableBatchBytes(rows);
  if (totalBatchBytes > IMPORT_LIMITS.MAX_BATCH_BYTES) {
    throw serviceError(
      413,
      'PERFORMANCE_CONTENT_IMPORT_BATCH_TOO_LARGE',
      'Content import exceeds the aggregate byte limit.',
      {
        field: 'rows',
        max_bytes: IMPORT_LIMITS.MAX_BATCH_BYTES,
        actual_bytes: totalBatchBytes
      }
    );
  }
  validateUniqueSourceRowNumbers(rows);
  const outputRows = new Array(rows.length);
  const candidates = [];
  let rejectedCount = 0;

  rows.forEach((row, index) => {
    try {
      const inspected = inspectRowRecord(row, mapping, index);
      const candidate = validateInspectedRow(inspected, mapping, index);
      candidates.push(candidate);
    } catch (error) {
      if (!(error instanceof PerformanceContentImportServiceError)) throw error;
      const sourceRowNumber = error.details.source_row_number === undefined
        ? null
        : error.details.source_row_number;
      outputRows[index] = rejectedRow(index, sourceRowNumber, error);
      rejectedCount += 1;
    }
  });

  const drafts = [];
  let acceptedCount = 0;
  let duplicateCount = 0;
  if (candidates.length > 0) {
    const identityResult = admitPublicationBatch(candidates.map((candidate) => candidate.url));
    identityResult.rows.forEach((admitted, candidateIndex) => {
      const candidate = candidates[candidateIndex];
      if (admitted.outcome === 'rejected') {
        outputRows[candidate.index] = rejectedRow(
          candidate.index,
          candidate.sourceRowNumber,
          admitted.error
        );
        rejectedCount += 1;
        return;
      }

      const firstCandidate = candidates[admitted.first_index];
      if (admitted.outcome === 'duplicate') {
        duplicateCount += 1;
        outputRows[candidate.index] = admittedRow(candidate, admitted, firstCandidate, null);
        return;
      }

      acceptedCount += 1;
      const draft = buildDraft({
        campaignId,
        mappingVersion,
        provenance
      }, candidate, admitted);
      drafts.push(draft);
      outputRows[candidate.index] = admittedRow(candidate, admitted, firstCandidate, draft);
    });
  }

  return deepFreeze({
    contract_version: CONTRACT_VERSION,
    campaign_id: campaignId,
    source_mode: provenance.source_mode,
    file_hash: provenance.file_hash,
    mapping_version: mappingVersion,
    column_mapping: mapping,
    total_count: rows.length,
    accepted_count: acceptedCount,
    duplicate_count: duplicateCount,
    rejected_count: rejectedCount,
    drafts,
    rows: outputRows
  });
}

module.exports = {
  CONTRACT_VERSION,
  SOURCE_MODE,
  MAX_IMPORT_ROWS,
  IMPORT_LIMITS,
  PerformanceContentImportServiceError,
  preparePerformanceContentImport,
  buildPerformanceContentImportDrafts: preparePerformanceContentImport
};
