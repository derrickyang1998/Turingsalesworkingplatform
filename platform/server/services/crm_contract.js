const { createHash } = require('node:crypto');

function deepFreeze(value, seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function registry(entries) {
  return deepFreeze(Object.fromEntries(entries.map((entry) => [entry.code, entry])));
}

const CUSTOMER_LIFECYCLE_REGISTRY = registry([
  { kind: 'canonical', code: 'lead', order: 10, class: 'active', dashboard_group: 'development', label_detail: '1.客户获取/客户开发', label_compact: '开发中' },
  { kind: 'canonical', code: 'info_confirmed', order: 20, class: 'active', dashboard_group: 'development', label_detail: '2.客户信息确认', label_compact: '信息确认' },
  { kind: 'canonical', code: 'advantage_shared', order: 30, class: 'active', dashboard_group: 'development', label_detail: '3.企业优势同步', label_compact: '优势同步' },
  { kind: 'canonical', code: 'needs_confirmed', order: 40, class: 'active', dashboard_group: 'qualification', label_detail: '4.海外营销需求确认', label_compact: '需求确认' },
  { kind: 'canonical', code: 'analysis', order: 50, class: 'active', dashboard_group: 'qualification', label_detail: '5.行业/竞品数据分析', label_compact: '数据分析' },
  { kind: 'canonical', code: 'proposal', order: 60, class: 'active', dashboard_group: 'proposal_negotiation', label_detail: '6.红人营销方案生成', label_compact: '方案中' },
  { kind: 'canonical', code: 'kol_matching', order: 70, class: 'active', dashboard_group: 'proposal_negotiation', label_detail: '7.网红匹配提报', label_compact: '红人匹配' },
  { kind: 'canonical', code: 'cooperation', order: 80, class: 'active', dashboard_group: 'proposal_negotiation', label_detail: '8.合作落地跟踪', label_compact: '合作落地' },
  { kind: 'canonical', code: 'paused', order: 90, class: 'terminal', dashboard_group: 'closed', label_detail: '暂停/延后', label_compact: '暂停' },
  { kind: 'canonical', code: 'won', order: 100, class: 'terminal', dashboard_group: 'closed', label_detail: '成交', label_compact: '成交' },
  { kind: 'canonical', code: 'lost', order: 110, class: 'terminal', dashboard_group: 'closed', label_detail: '丢失', label_compact: '丢失' }
]);

const OPPORTUNITY_STAGE_REGISTRY = registry([
  { kind: 'canonical', code: 'discovery', order: 10, class: 'open', label: '需求分析' },
  { kind: 'canonical', code: 'qualification', order: 20, class: 'open', label: '资格确认' },
  { kind: 'canonical', code: 'proposal', order: 30, class: 'open', label: '方案报价' },
  { kind: 'canonical', code: 'negotiation', order: 40, class: 'open', label: '谈判中' },
  { kind: 'canonical', code: 'won', order: 50, class: 'terminal', label: '已赢单' },
  { kind: 'canonical', code: 'lost', order: 60, class: 'terminal', label: '已输单' }
]);

const CUSTOMER_PRIORITY_REGISTRY = registry([
  { kind: 'canonical', code: 'high', order: 10, label_zh: '高', label_en: 'High' },
  { kind: 'canonical', code: 'medium', order: 20, label_zh: '中', label_en: 'Medium' },
  { kind: 'canonical', code: 'low', order: 30, label_zh: '低', label_en: 'Low' }
]);

class CrmContractError extends Error {
  constructor(code, field, reason) {
    super('Invalid CRM contract');
    this.name = 'CrmContractError';
    this.code = code;
    this.field = field;
    this.reason = reason;
    this.status = 400;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      field: this.field,
      reason: this.reason,
      status: this.status
    };
  }
}

function assertRegistryValue(value, field, values) {
  if (typeof value !== 'string') {
    throw new CrmContractError('CRM_CONTRACT_INVALID', field, 'invalid_type');
  }
  if (!Object.prototype.hasOwnProperty.call(values, value)) {
    throw new CrmContractError('CRM_CONTRACT_INVALID', field, 'unsupported_value');
  }
  return value;
}

function assertCustomerLifecycle(value) {
  return assertRegistryValue(value, 'customer_stage', CUSTOMER_LIFECYCLE_REGISTRY);
}

function classifyCustomerLifecycle(value) {
  if (typeof value !== 'string') {
    throw new CrmContractError('CRM_CONTRACT_INVALID', 'customer_stage', 'invalid_type');
  }
  if (Object.prototype.hasOwnProperty.call(CUSTOMER_LIFECYCLE_REGISTRY, value)) {
    return CUSTOMER_LIFECYCLE_REGISTRY[value];
  }
  return Object.freeze({ kind: 'legacy', source_value: value });
}

function customerLifecycleGroup(value) {
  return CUSTOMER_LIFECYCLE_REGISTRY[assertCustomerLifecycle(value)].dashboard_group;
}

function assertOpportunityStage(value) {
  return assertRegistryValue(value, 'opportunity_stage', OPPORTUNITY_STAGE_REGISTRY);
}

function assertCustomerPriority(value) {
  return assertRegistryValue(value, 'priority', CUSTOMER_PRIORITY_REGISTRY);
}

function identityError(field, reason) {
  return new CrmContractError('CRM_IDENTITY_INVALID', field, reason);
}

function ownDataValue(input, field, required) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, field);
  } catch (_error) {
    throw identityError(field, 'invalid_type');
  }
  if (!descriptor) {
    if (required) throw identityError(field, 'required');
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw identityError(field, 'invalid_type');
  }
  return descriptor.value;
}

function normalizeComparisonText(value) {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim()
    .toLowerCase();
}

function normalizeIdentityText(value, field) {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      if (index + 1 >= value.length) throw identityError(field, 'invalid_format');
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw identityError(field, 'invalid_format');
      index += 1;
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      throw identityError(field, 'invalid_format');
    }
  }
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\p{White_Space}\uFEFF]+/gu, ' ')
    .replace(/^ +| +$/g, '')
    .toLowerCase();
}

function lengthFrame(byteLength) {
  const frame = Buffer.allocUnsafe(4);
  frame.writeUInt32BE(byteLength, 0);
  return frame;
}

function buildCustomerIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw identityError('identity', 'invalid_type');
  }

  const brandValue = ownDataValue(input, 'brand_name', true);
  if (typeof brandValue !== 'string') throw identityError('brand_name', 'invalid_type');
  const brand = normalizeIdentityText(brandValue, 'brand_name');
  if (!brand) throw identityError('brand_name', 'invalid_format');

  const companyValue = ownDataValue(input, 'company_name', false);
  if (companyValue !== undefined && companyValue !== null && typeof companyValue !== 'string') {
    throw identityError('company_name', 'invalid_type');
  }
  const company = normalizeIdentityText(companyValue == null ? '' : companyValue, 'company_name');
  const brandBytes = Buffer.from(brand, 'utf8');
  const companyBytes = Buffer.from(company, 'utf8');
  if (brandBytes.length > 0xffffffff || companyBytes.length > 0xffffffff) {
    throw identityError('identity', 'invalid_format');
  }

  const material = Buffer.concat([
    Buffer.from('crm-customer-identity:v1\0', 'utf8'),
    lengthFrame(brandBytes.length),
    brandBytes,
    lengthFrame(companyBytes.length),
    companyBytes
  ]);
  return Object.freeze({
    version: 1,
    algorithm: 'sha256',
    key: createHash('sha256').update(material).digest('hex')
  });
}

const FILTER_KEYS = Object.freeze([
  'scope', 'owner_id', 'team_id', 'customer_stage', 'opportunity_stage', 'priority',
  'industry', 'country', 'tag', 'source', 'next_action_due', 'stalled', 'keyword',
  'as_of', 'limit', 'cursor'
]);
const FILTER_KEY_SET = new Set(FILTER_KEYS);
const FILTER_TEXT_LIMITS = Object.freeze({ industry: 160, country: 120, tag: 120, source: 160, keyword: 240 });
const CRM_SCOPES = new Set(['my', 'team', 'organization', 'public_pool']);
const NEXT_ACTION_DUE_VALUES = new Set(['overdue', 'today', 'next_7_days', 'later', 'none']);
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RFC3339_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function filterError(field, reason) {
  return new CrmContractError('CRM_CONTRACT_INVALID', field, reason);
}

function cursorError(field = 'cursor', reason = 'invalid_format', code = 'CRM_CURSOR_INVALID') {
  return new CrmContractError(code, field, reason);
}

function assertPlainRecord(input, errorFactory) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw errorFactory('invalid_type');
  let prototype;
  try {
    prototype = Object.getPrototypeOf(input);
  } catch (_error) {
    throw errorFactory('invalid_type');
  }
  if (prototype !== Object.prototype && prototype !== null) throw errorFactory('invalid_type');
}

function readFilterInput(input) {
  assertPlainRecord(input, (reason) => filterError('filter', reason));
  let keys;
  try {
    keys = Reflect.ownKeys(input);
  } catch (_error) {
    throw filterError('filter', 'invalid_type');
  }
  if (keys.some((key) => typeof key !== 'string' || !FILTER_KEY_SET.has(key))) {
    throw filterError('filter', 'unknown_field');
  }
  const result = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch (_error) {
      throw filterError(key, 'invalid_type');
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw filterError(key, 'invalid_type');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function optionalEnum(value, field, allowed) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw filterError(field, 'invalid_type');
  if (!allowed.has(value)) throw filterError(field, 'unsupported_value');
  return value;
}

function optionalId(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw filterError(field, 'invalid_type');
  if (value < 1) throw filterError(field, 'invalid_format');
  return value;
}

function canonicalRegistryArray(value, field, registryValue, assertion) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw filterError(field, 'invalid_type');
  const unique = new Set();
  try {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw filterError(field, 'invalid_type');
      unique.add(assertion(value[index]));
    }
  } catch (error) {
    if (error instanceof CrmContractError) throw error;
    throw filterError(field, 'invalid_type');
  }
  return Object.freeze([...unique].sort((left, right) => registryValue[left].order - registryValue[right].order));
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw filterError(field, 'invalid_type');
  const normalized = normalizeComparisonText(value);
  if (!normalized || [...normalized].length > FILTER_TEXT_LIMITS[field]) throw filterError(field, 'invalid_format');
  return normalized;
}

function isCanonicalRfc3339(value) {
  if (typeof value !== 'string' || !RFC3339_UTC_MILLIS.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCanonicalSqliteTimestamp(value) {
  if (typeof value !== 'string' || !SQLITE_TIMESTAMP.test(value)) return false;
  const iso = `${value.slice(0, 10)}T${value.slice(11)}.000Z`;
  const milliseconds = Date.parse(iso);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === iso;
}

function optionalAsOf(value) {
  if (value === undefined || value === null) return null;
  if (!isCanonicalRfc3339(value)) throw filterError('as_of', 'invalid_format');
  return value;
}

function canonicalLimit(value) {
  if (value === undefined) return 25;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw filterError('limit', 'invalid_type');
  if (value < 1 || value > 100) throw filterError('limit', 'invalid_format');
  return value;
}

function optionalCursor(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw filterError('cursor', 'invalid_type');
  if (!value || value.length > 512 || !BASE64URL.test(value)) throw filterError('cursor', 'invalid_format');
  return value;
}

function canonicalizeCrmFilter(input) {
  const source = readFilterInput(input);
  const stalled = source.stalled === undefined || source.stalled === null ? null : source.stalled;
  if (stalled !== null && typeof stalled !== 'boolean') throw filterError('stalled', 'invalid_type');

  return deepFreeze({
    scope: optionalEnum(source.scope, 'scope', CRM_SCOPES),
    owner_id: optionalId(source.owner_id, 'owner_id'),
    team_id: optionalId(source.team_id, 'team_id'),
    customer_stage: canonicalRegistryArray(source.customer_stage, 'customer_stage', CUSTOMER_LIFECYCLE_REGISTRY, assertCustomerLifecycle),
    opportunity_stage: canonicalRegistryArray(source.opportunity_stage, 'opportunity_stage', OPPORTUNITY_STAGE_REGISTRY, assertOpportunityStage),
    priority: canonicalRegistryArray(source.priority, 'priority', CUSTOMER_PRIORITY_REGISTRY, assertCustomerPriority),
    industry: optionalText(source.industry, 'industry'),
    country: optionalText(source.country, 'country'),
    tag: optionalText(source.tag, 'tag'),
    source: optionalText(source.source, 'source'),
    next_action_due: optionalEnum(source.next_action_due, 'next_action_due', NEXT_ACTION_DUE_VALUES),
    stalled,
    keyword: optionalText(source.keyword, 'keyword'),
    as_of: optionalAsOf(source.as_of),
    limit: canonicalLimit(source.limit),
    cursor: optionalCursor(source.cursor)
  });
}

function fingerprintCrmFilter(input) {
  const filter = canonicalizeCrmFilter(input);
  const material = {
    scope: filter.scope,
    owner_id: filter.owner_id,
    team_id: filter.team_id,
    customer_stage: filter.customer_stage,
    opportunity_stage: filter.opportunity_stage,
    priority: filter.priority,
    industry: filter.industry,
    country: filter.country,
    tag: filter.tag,
    source: filter.source,
    next_action_due: filter.next_action_due,
    stalled: filter.stalled,
    keyword: filter.keyword,
    as_of: filter.as_of
  };
  return createHash('sha256')
    .update(Buffer.from(`crm-filter:v1\0${JSON.stringify(material)}`, 'utf8'))
    .digest('hex');
}

function assertFingerprint(value) {
  if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) {
    throw cursorError('fingerprint', 'invalid_format');
  }
  return value;
}

function readCursorSortKeys(input) {
  assertPlainRecord(input, (reason) => cursorError('sort_keys', reason));
  let keys;
  try {
    keys = Reflect.ownKeys(input);
  } catch (_error) {
    throw cursorError('sort_keys', 'invalid_type');
  }
  if (keys.length !== 2 || !keys.includes('updated_at') || !keys.includes('id')) {
    throw cursorError('sort_keys', 'invalid_format');
  }
  const values = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch (_error) {
      throw cursorError('sort_keys', 'invalid_type');
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw cursorError('sort_keys', 'invalid_type');
    }
    values[key] = descriptor.value;
  }
  if (!isCanonicalSqliteTimestamp(values.updated_at)) throw cursorError('updated_at', 'invalid_format');
  if (typeof values.id !== 'number' || !Number.isSafeInteger(values.id) || values.id < 1) {
    throw cursorError('id', typeof values.id === 'number' ? 'invalid_format' : 'invalid_type');
  }
  return values;
}

function encodeCrmCursor(sortKeys, fingerprint) {
  const keys = readCursorSortKeys(sortKeys);
  const queryFingerprint = assertFingerprint(fingerprint);
  const payload = JSON.stringify({ v: 1, q: queryFingerprint, u: keys.updated_at, i: keys.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCrmCursor(token, expectedFingerprint) {
  const queryFingerprint = assertFingerprint(expectedFingerprint);
  if (typeof token !== 'string' || !token || token.length > 512 || !BASE64URL.test(token)) {
    throw cursorError();
  }

  let bytes;
  let text;
  try {
    bytes = Buffer.from(token, 'base64url');
    if (!bytes.length || bytes.toString('base64url') !== token) throw new Error('noncanonical');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_error) {
    throw cursorError();
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    throw cursorError();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw cursorError();
  const keys = Object.keys(payload);
  if (keys.length !== 4 || keys[0] !== 'v' || keys[1] !== 'q' || keys[2] !== 'u' || keys[3] !== 'i') {
    throw cursorError();
  }
  if (JSON.stringify({ v: payload.v, q: payload.q, u: payload.u, i: payload.i }) !== text) throw cursorError();
  if (payload.v !== 1) throw cursorError('cursor', 'version_mismatch');
  if (typeof payload.q !== 'string' || !LOWER_HEX_64.test(payload.q)) throw cursorError();
  if (payload.q !== queryFingerprint) throw cursorError('cursor', 'fingerprint_mismatch', 'CRM_CURSOR_FILTER_MISMATCH');
  if (!isCanonicalSqliteTimestamp(payload.u)) throw cursorError();
  if (typeof payload.i !== 'number' || !Number.isSafeInteger(payload.i) || payload.i < 1) throw cursorError();
  return Object.freeze({ updated_at: payload.u, id: payload.i });
}

module.exports = {
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
};
