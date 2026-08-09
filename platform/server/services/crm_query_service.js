'use strict';

const { types: utilTypes } = require('node:util');
const {
  CUSTOMER_LIFECYCLE_REGISTRY,
  canonicalizeCrmFilter,
  fingerprintCrmFilter,
  encodeCrmCursor,
  decodeCrmCursor
} = require('./crm_contract');
const {
  CrmScopeError,
  resolveCrmAccessContext,
  compileCustomerScope,
  compileOpportunityScope,
  CUSTOMER_CUSTODY_CASE_SQL
} = require('./crm_scope_service');

const APPLIED_FILTER_KEYS = Object.freeze([
  'scope',
  'owner_id',
  'team_id',
  'customer_stage',
  'opportunity_stage',
  'priority',
  'industry',
  'country',
  'tag',
  'source',
  'next_action_due',
  'stalled',
  'keyword',
  'as_of'
]);

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function snapshotPlainOptions(value, recognizedKeys) {
  if (utilTypes.isProxy(value)) return null;
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const snapshot = {};
    for (const key of recognizedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function invalidContext() {
  return new CrmScopeError('CRM_SCOPE_INVALID', 400, 'invalid_context');
}

function nowMarker() {
  const milliseconds = Math.floor(Date.now() / 1000) * 1000;
  return new Date(milliseconds).toISOString();
}

function sqliteTimestampFromIso(value) {
  return value.slice(0, 19).replace('T', ' ');
}

function localDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.create(null);
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day };
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.create(null);
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

function addCalendarDays(parts, days) {
  const marker = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: marker.getUTCFullYear(),
    month: marker.getUTCMonth() + 1,
    day: marker.getUTCDate()
  };
}

function localMidnightUtc(localDate, timeZone) {
  const targetAsUtc = Date.UTC(localDate.year, localDate.month - 1, localDate.day, 0, 0, 0);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = zonedParts(new Date(candidate), timeZone);
    const representedAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second
    );
    const adjustment = targetAsUtc - representedAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return sqliteTimestampFromIso(new Date(candidate).toISOString());
}

function dueBoundaries(asOf, timeZone) {
  const marker = new Date(asOf);
  const localDate = localDateParts(marker, timeZone);
  return Object.freeze({
    asOf: sqliteTimestampFromIso(asOf),
    nextMidnight: localMidnightUtc(addCalendarDays(localDate, 1), timeZone),
    dayEight: localMidnightUtc(addCalendarDays(localDate, 8), timeZone)
  });
}

function prepareQueryState(db, rawOptions) {
  const options = snapshotPlainOptions(rawOptions, [
    'actorUserId',
    'organizationId',
    'organizationCode',
    'requestId',
    'filter'
  ]);
  if (!options) throw invalidContext();
  const contextOptions = { actorUserId: options.actorUserId };
  for (const key of ['organizationId', 'organizationCode', 'requestId']) {
    if (Object.hasOwn(options, key)) contextOptions[key] = options[key];
  }
  const context = resolveCrmAccessContext(db, contextOptions);
  const rawFilter = Object.hasOwn(options, 'filter') ? options.filter : {};
  const canonical = canonicalizeCrmFilter(rawFilter);
  const scopeCompilation = compileCustomerScope(context, canonical.scope);
  const asOf = canonical.as_of || nowMarker();
  const effectiveFilter = canonicalizeCrmFilter({
    ...canonical,
    scope: scopeCompilation.scope,
    as_of: asOf
  });
  const queryFingerprint = fingerprintCrmFilter(effectiveFilter);
  const cursorKeys = effectiveFilter.cursor === null
    ? null
    : decodeCrmCursor(effectiveFilter.cursor, queryFingerprint);
  const appliedFilters = {};
  for (const key of APPLIED_FILTER_KEYS) appliedFilters[key] = effectiveFilter[key];

  return {
    context,
    filter: effectiveFilter,
    scopeCompilation,
    opportunityScopeCompilation: compileOpportunityScope(context, effectiveFilter.scope),
    queryFingerprint,
    cursorKeys,
    appliedFilters: deepFreeze(appliedFilters),
    due: dueBoundaries(asOf, context.time_zone)
  };
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function escapeLike(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function appendDuePredicate(clauses, params, column, due, boundaries) {
  if (due === null) return;
  if (due === 'overdue') {
    clauses.push(`${column} IS NOT NULL AND ${column} < ?`);
    params.push(boundaries.asOf);
  } else if (due === 'today') {
    clauses.push(`${column} >= ? AND ${column} < ?`);
    params.push(boundaries.asOf, boundaries.nextMidnight);
  } else if (due === 'next_7_days') {
    clauses.push(`${column} >= ? AND ${column} < ?`);
    params.push(boundaries.nextMidnight, boundaries.dayEight);
  } else if (due === 'later') {
    clauses.push(`${column} >= ?`);
    params.push(boundaries.dayEight);
  } else if (due === 'none') {
    clauses.push(`${column} IS NULL`);
  }
}

function buildCustomerPlan(state) {
  const filter = state.filter;
  const clauses = [state.scopeCompilation.where_sql];
  const params = [...state.scopeCompilation.params];

  if (filter.owner_id !== null) {
    clauses.push('c.assigned_to=?');
    params.push(filter.owner_id);
  }
  if (filter.team_id !== null) {
    clauses.push('c.team_id=?');
    params.push(filter.team_id);
  }
  if (filter.customer_stage.length > 0) {
    clauses.push(`c.stage IN (${placeholders(filter.customer_stage)})`);
    params.push(...filter.customer_stage);
  }
  if (filter.opportunity_stage.length > 0) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM opportunities crm_filter_opportunity
      WHERE crm_filter_opportunity.customer_id=c.id
        AND crm_filter_opportunity.org_id=c.org_id
        AND crm_filter_opportunity.stage IN (${placeholders(filter.opportunity_stage)})
    )`);
    params.push(...filter.opportunity_stage);
  }
  if (filter.priority.length > 0) {
    clauses.push(`c.priority IN (${placeholders(filter.priority)})`);
    params.push(...filter.priority);
  }
  for (const [key, column] of [
    ['industry', 'c.industry'],
    ['country', 'c.country'],
    ['source', 'c.source']
  ]) {
    if (filter[key] !== null) {
      clauses.push(`LOWER(TRIM(${column}))=?`);
      params.push(filter[key]);
    }
  }
  if (filter.tag !== null) {
    clauses.push(`EXISTS (
      WITH RECURSIVE crm_tag_tokens(rest,token) AS (
        SELECT COALESCE(c.tags,'') || ',', ''
        UNION ALL
        SELECT
          SUBSTR(rest,INSTR(rest,',') + 1),
          SUBSTR(rest,1,INSTR(rest,',') - 1)
        FROM crm_tag_tokens
        WHERE rest <> ''
      )
      SELECT 1
      FROM crm_tag_tokens
      WHERE LOWER(TRIM(token))=?
    )`);
    params.push(filter.tag);
  }
  appendDuePredicate(clauses, params, 'c.next_action_at', filter.next_action_due, state.due);
  if (filter.stalled === true) {
    clauses.push('c.stalled_at IS NOT NULL AND c.stalled_at <= ?');
    params.push(state.due.asOf);
  } else if (filter.stalled === false) {
    clauses.push('(c.stalled_at IS NULL OR c.stalled_at > ?)');
    params.push(state.due.asOf);
  }
  if (filter.keyword !== null) {
    const keyword = `%${escapeLike(filter.keyword)}%`;
    clauses.push(`(
      LOWER(TRIM(COALESCE(c.brand_name,''))) LIKE ? ESCAPE '\\'
      OR LOWER(TRIM(COALESCE(c.company_name,''))) LIKE ? ESCAPE '\\'
    )`);
    params.push(keyword, keyword);
  }

  return {
    whereSql: clauses.map((clause) => `(${clause})`).join(' AND '),
    params
  };
}

function buildOpportunityPlan(state) {
  const filter = state.filter;
  const clauses = [state.opportunityScopeCompilation.where_sql];
  const params = [...state.opportunityScopeCompilation.params];

  if (filter.owner_id !== null) {
    clauses.push('o.owner_user_id=?');
    params.push(filter.owner_id);
  }
  if (filter.team_id !== null) {
    clauses.push('o.team_id=?');
    params.push(filter.team_id);
  }
  if (filter.customer_stage.length > 0) {
    clauses.push(`c.stage IN (${placeholders(filter.customer_stage)})`);
    params.push(...filter.customer_stage);
  }
  if (filter.opportunity_stage.length > 0) {
    clauses.push(`o.stage IN (${placeholders(filter.opportunity_stage)})`);
    params.push(...filter.opportunity_stage);
  }
  if (filter.priority.length > 0) {
    clauses.push(`c.priority IN (${placeholders(filter.priority)})`);
    params.push(...filter.priority);
  }
  for (const [key, column] of [
    ['industry', 'c.industry'],
    ['country', 'c.country'],
    ['source', 'c.source']
  ]) {
    if (filter[key] !== null) {
      clauses.push(`LOWER(TRIM(${column}))=?`);
      params.push(filter[key]);
    }
  }
  if (filter.tag !== null) {
    clauses.push(`EXISTS (
      WITH RECURSIVE crm_tag_tokens(rest,token) AS (
        SELECT COALESCE(c.tags,'') || ',', ''
        UNION ALL
        SELECT
          SUBSTR(rest,INSTR(rest,',') + 1),
          SUBSTR(rest,1,INSTR(rest,',') - 1)
        FROM crm_tag_tokens
        WHERE rest <> ''
      )
      SELECT 1
      FROM crm_tag_tokens
      WHERE LOWER(TRIM(token))=?
    )`);
    params.push(filter.tag);
  }
  appendDuePredicate(clauses, params, 'o.next_action_at', filter.next_action_due, state.due);
  if (filter.stalled === true) {
    clauses.push('c.stalled_at IS NOT NULL AND c.stalled_at <= ?');
    params.push(state.due.asOf);
  } else if (filter.stalled === false) {
    clauses.push('(c.stalled_at IS NULL OR c.stalled_at > ?)');
    params.push(state.due.asOf);
  }
  if (filter.keyword !== null) {
    const keyword = `%${escapeLike(filter.keyword)}%`;
    clauses.push(`(
      LOWER(TRIM(COALESCE(c.brand_name,''))) LIKE ? ESCAPE '\\'
      OR LOWER(TRIM(COALESCE(c.company_name,''))) LIKE ? ESCAPE '\\'
    )`);
    params.push(keyword, keyword);
  }

  return {
    whereSql: clauses.map((clause) => `(${clause})`).join(' AND '),
    params
  };
}

function paginatedPlan(plan, alias, cursorKeys) {
  if (cursorKeys === null) return { whereSql: plan.whereSql, params: [...plan.params] };
  return {
    whereSql: `${plan.whereSql} AND (${alias}.updated_at < ? OR (${alias}.updated_at = ? AND ${alias}.id < ?))`,
    params: [...plan.params, cursorKeys.updated_at, cursorKeys.updated_at, cursorKeys.id]
  };
}

function pageFor(rows, limit, queryFingerprint) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = hasMore ? items[items.length - 1] : null;
  return {
    rows: items,
    page: {
      limit,
      next_cursor: hasMore
        ? encodeCrmCursor({ updated_at: last.updated_at, id: last.id }, queryFingerprint)
        : null,
      has_more: hasMore
    }
  };
}

function customerProjection() {
  return `
    c.id,
    c.brand_name,
    c.company_name,
    c.industry,
    c.stage,
    c.source,
    c.budget_estimate,
    c.contact_person,
    c.contact_info,
    c.assigned_to AS owner_user_id,
    c.team_id,
    c.country,
    c.next_action_at,
    c.stalled_at,
    c.priority,
    c.tags,
    c.created_at,
    c.updated_at,
    ${CUSTOMER_CUSTODY_CASE_SQL} AS custody
  `;
}

function mapCustomerRow(row) {
  return {
    id: row.id,
    brand_name: row.brand_name,
    company_name: row.company_name,
    industry: row.industry,
    stage: row.stage,
    lifecycle_group: Object.hasOwn(CUSTOMER_LIFECYCLE_REGISTRY, row.stage)
      ? CUSTOMER_LIFECYCLE_REGISTRY[row.stage].dashboard_group
      : null,
    source: row.source,
    budget_estimate: row.budget_estimate,
    contact_person: row.contact_person,
    contact_info: row.contact_info,
    owner_user_id: row.owner_user_id,
    team_id: row.team_id,
    country: row.country,
    next_action_at: row.next_action_at,
    stalled_at: row.stalled_at,
    priority: row.priority,
    tags: row.tags,
    created_at: row.created_at,
    updated_at: row.updated_at,
    custody: row.custody
  };
}

function opportunityProjection() {
  return `
    o.id,
    o.customer_id,
    o.name,
    o.stage,
    o.value,
    o.win_probability,
    o.product_name,
    o.channel_type,
    o.expected_close_date,
    o.owner_user_id,
    o.team_id,
    o.next_action_at,
    o.loss_reason,
    o.closed_at,
    o.campaign_id,
    o.created_at,
    o.updated_at,
    c.brand_name AS customer_brand_name,
    c.company_name AS customer_company_name,
    c.stage AS customer_stage,
    c.priority AS customer_priority,
    ${CUSTOMER_CUSTODY_CASE_SQL} AS customer_custody
  `;
}

function mapOpportunityRow(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    name: row.name,
    stage: row.stage,
    value: row.value,
    win_probability: row.win_probability,
    product_name: row.product_name,
    channel_type: row.channel_type,
    expected_close_date: row.expected_close_date,
    owner_user_id: row.owner_user_id,
    team_id: row.team_id,
    next_action_at: row.next_action_at,
    loss_reason: row.loss_reason,
    closed_at: row.closed_at,
    campaign_id: row.campaign_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    customer_brand_name: row.customer_brand_name,
    customer_company_name: row.customer_company_name,
    customer_stage: row.customer_stage,
    customer_priority: row.customer_priority,
    customer_custody: row.customer_custody
  };
}

function responseMeta(state) {
  return {
    applied_filters: state.appliedFilters,
    scope: state.filter.scope,
    query_fingerprint: state.queryFingerprint,
    as_of: state.filter.as_of
  };
}

function listCustomers(db, options) {
  return db.transaction(() => {
    const state = prepareQueryState(db, options);
    const plan = buildCustomerPlan(state);
    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM customers c
      WHERE ${plan.whereSql}
    `).get(...plan.params).count;
    const itemPlan = paginatedPlan(plan, 'c', state.cursorKeys);
    const rows = db.prepare(`
      SELECT ${customerProjection()}
      FROM customers c
      WHERE ${itemPlan.whereSql}
      ORDER BY c.updated_at DESC,c.id DESC
      LIMIT ?
    `).all(...itemPlan.params, state.filter.limit + 1);
    const paged = pageFor(rows, state.filter.limit, state.queryFingerprint);

    return deepFreeze({
      items: paged.rows.map(mapCustomerRow),
      total,
      page: paged.page,
      meta: responseMeta(state)
    });
  }).deferred();
}

function listOpportunities(db, options) {
  return db.transaction(() => {
    const state = prepareQueryState(db, options);
    const plan = buildOpportunityPlan(state);
    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM opportunities o
      JOIN customers c ON c.id=o.customer_id
      WHERE ${plan.whereSql}
    `).get(...plan.params).count;
    const itemPlan = paginatedPlan(plan, 'o', state.cursorKeys);
    const rows = db.prepare(`
      SELECT ${opportunityProjection()}
      FROM opportunities o
      JOIN customers c ON c.id=o.customer_id
      WHERE ${itemPlan.whereSql}
      ORDER BY o.updated_at DESC,o.id DESC
      LIMIT ?
    `).all(...itemPlan.params, state.filter.limit + 1);
    const paged = pageFor(rows, state.filter.limit, state.queryFingerprint);

    return deepFreeze({
      items: paged.rows.map(mapOpportunityRow),
      total,
      page: paged.page,
      meta: responseMeta(state)
    });
  }).deferred();
}

module.exports = {
  listCustomers,
  listOpportunities
};
