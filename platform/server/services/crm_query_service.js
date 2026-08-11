'use strict';

const { types: utilTypes } = require('node:util');
const {
  CUSTOMER_LIFECYCLE_REGISTRY,
  OPPORTUNITY_STAGE_REGISTRY,
  CrmContractError,
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
const CUSTOMER_DETAIL_OPPORTUNITY_LIMIT = 100;

class CrmQueryError extends Error {
  constructor(cause) {
    super('CRM query failed');
    Object.defineProperties(this, {
      name: { value: 'CrmQueryError', enumerable: true },
      code: { value: 'CRM_QUERY_FAILED', enumerable: true },
      status: { value: 500, enumerable: true },
      reason: { value: 'query_failed', enumerable: true },
      cause: { value: cause, enumerable: false }
    });
  }
}

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

function customerNotFound() {
  return new CrmScopeError('CRM_CUSTOMER_NOT_FOUND', 404, 'not_found');
}

function opportunityNotFound() {
  return new CrmScopeError('CRM_CHILD_NOT_FOUND', 404, 'not_found');
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nowMarker() {
  const milliseconds = Math.floor(Date.now() / 1000) * 1000;
  return new Date(milliseconds).toISOString();
}

function sqliteTimestampFromIso(value) {
  const wholeSeconds = value.slice(0, 19).replace('T', ' ');
  const milliseconds = value.slice(19, 23);
  return milliseconds === '.000' ? wholeSeconds : `${wholeSeconds}${milliseconds}`;
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

function prepareQueryState(db, rawOptions, { decodeCursor = true } = {}) {
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
  const cursorKeys = !decodeCursor || effectiveFilter.cursor === null
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
    if (filter.scope === 'public_pool') {
      clauses.push('1=0');
    } else {
      clauses.push(`EXISTS (
        SELECT 1
        FROM opportunities crm_filter_opportunity
        WHERE crm_filter_opportunity.customer_id=c.id
          AND crm_filter_opportunity.org_id=c.org_id
          AND crm_filter_opportunity.stage IN (${placeholders(filter.opportunity_stage)})
      )`);
      params.push(...filter.opportunity_stage);
    }
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

function customerDetailProjection() {
  return `
    ${customerProjection()},
    c.notes,
    c.is_public
  `;
}

function mapCustomerDetailRow(row) {
  return {
    ...mapCustomerRow(row),
    assigned_to: row.owner_user_id,
    notes: row.notes,
    is_public: row.is_public
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

function opportunityDetailProjection() {
  return `
    ${opportunityProjection()},
    o.competitor_info,
    o.decision_chain,
    o.notes
  `;
}

function mapOpportunityDetailRow(row) {
  return {
    ...mapOpportunityRow(row),
    competitor_info: row.competitor_info,
    decision_chain: row.decision_chain,
    notes: row.notes
  };
}

function mapActivityRow(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    user_id: row.user_id,
    action: row.action,
    stage_from: row.stage_from,
    stage_to: row.stage_to,
    notes: row.notes,
    created_at: row.created_at,
    display_name: row.display_name
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

function isSqliteFailure(error) {
  return Boolean(error) && (
    error.name === 'SqliteError' ||
    (typeof error.code === 'string' && /^SQLITE_[A-Z0-9_]+$/.test(error.code))
  );
}

function runReadTransaction(db, callback) {
  try {
    return db.transaction(callback).deferred();
  } catch (error) {
    if (
      error instanceof CrmContractError ||
      error instanceof CrmScopeError ||
      error instanceof CrmQueryError
    ) {
      throw error;
    }
    if (isSqliteFailure(error)) throw new CrmQueryError(error);
    throw error;
  }
}

function listCustomers(db, options) {
  return runReadTransaction(db, () => {
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
  });
}

function listOpportunities(db, options) {
  return runReadTransaction(db, () => {
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
  });
}

function getCustomerDetail(db, rawOptions) {
  return runReadTransaction(db, () => {
    const options = snapshotPlainOptions(rawOptions, [
      'actorUserId',
      'organizationId',
      'organizationCode',
      'requestId',
      'customerId'
    ]);
    if (!options || !positiveSafeInteger(options.customerId)) throw invalidContext();

    const queryOptions = { actorUserId: options.actorUserId, filter: {} };
    for (const key of ['organizationId', 'organizationCode', 'requestId']) {
      if (Object.hasOwn(options, key)) queryOptions[key] = options[key];
    }
    const state = prepareQueryState(db, queryOptions, { decodeCursor: false });
    const detailScopes = state.context.is_org_admin ? ['organization'] : ['team', 'my'];
    let scope = null;
    let customerRow = null;
    for (const candidateScope of detailScopes) {
      const scopeCompilation = compileCustomerScope(state.context, candidateScope);
      customerRow = db.prepare(`
        SELECT ${customerDetailProjection()}
        FROM customers c
        WHERE (${scopeCompilation.where_sql}) AND c.id=?
        LIMIT 1
      `).get(...scopeCompilation.params, options.customerId);
      if (customerRow) {
        scope = candidateScope;
        break;
      }
    }
    if (!customerRow) throw customerNotFound();

    const opportunityRows = db.prepare(`
      SELECT ${opportunityDetailProjection()}
      FROM opportunities o
      JOIN customers c
        ON c.org_id=o.org_id
       AND c.id=o.customer_id
      WHERE o.org_id=? AND o.customer_id=?
      ORDER BY o.created_at DESC,o.id DESC
      LIMIT ?
    `).all(
      state.context.organization.id,
      options.customerId,
      CUSTOMER_DETAIL_OPPORTUNITY_LIMIT + 1
    );
    const opportunitiesHaveMore = opportunityRows.length > CUSTOMER_DETAIL_OPPORTUNITY_LIMIT;
    const opportunities = opportunityRows.slice(0, CUSTOMER_DETAIL_OPPORTUNITY_LIMIT);
    const activity = db.prepare(`
      SELECT
        a.id,
        a.customer_id,
        a.user_id,
        a.action,
        a.stage_from,
        a.stage_to,
        a.notes,
        a.created_at,
        u.display_name
      FROM customer_activity a
      LEFT JOIN organization_memberships membership
        ON membership.org_id=?
       AND membership.user_id=a.user_id
       AND membership.status='active'
      LEFT JOIN users u ON u.id=membership.user_id
      WHERE a.customer_id=?
      ORDER BY a.created_at DESC,a.id DESC
      LIMIT 50
    `).all(state.context.organization.id, options.customerId);

    return deepFreeze({
      customer: mapCustomerDetailRow(customerRow),
      opportunities: opportunities.map(mapOpportunityDetailRow),
      activity: activity.map(mapActivityRow),
      meta: {
        request_id: Object.hasOwn(options, 'requestId') ? options.requestId : null,
        scope,
        opportunities: {
          limit: CUSTOMER_DETAIL_OPPORTUNITY_LIMIT,
          has_more: opportunitiesHaveMore
        }
      }
    });
  });
}

function getOpportunityDetail(db, rawOptions) {
  return runReadTransaction(db, () => {
    const options = snapshotPlainOptions(rawOptions, [
      'actorUserId',
      'organizationId',
      'organizationCode',
      'requestId',
      'opportunityId'
    ]);
    if (!options || !positiveSafeInteger(options.opportunityId)) throw invalidContext();

    const queryOptions = { actorUserId: options.actorUserId, filter: {} };
    for (const key of ['organizationId', 'organizationCode', 'requestId']) {
      if (Object.hasOwn(options, key)) queryOptions[key] = options[key];
    }
    const state = prepareQueryState(db, queryOptions, { decodeCursor: false });
    const detailScopes = state.context.is_org_admin ? ['organization'] : ['team', 'my'];
    let scope = null;
    let opportunityRow = null;
    for (const candidateScope of detailScopes) {
      const scopeCompilation = compileCustomerScope(state.context, candidateScope);
      opportunityRow = db.prepare(`
        SELECT ${opportunityDetailProjection()}
        FROM opportunities o
        JOIN customers c
          ON c.org_id=o.org_id
         AND c.id=o.customer_id
        WHERE (${scopeCompilation.where_sql})
          AND o.org_id=?
          AND o.id=?
        LIMIT 1
      `).get(
        ...scopeCompilation.params,
        state.context.organization.id,
        options.opportunityId
      );
      if (opportunityRow) {
        scope = candidateScope;
        break;
      }
    }
    if (!opportunityRow) throw opportunityNotFound();

    return deepFreeze({
      opportunity: mapOpportunityDetailRow(opportunityRow),
      meta: {
        request_id: Object.hasOwn(options, 'requestId') ? options.requestId : null,
        scope
      }
    });
  });
}

function initialCustomerStageCounts() {
  const byStage = {};
  const byGroup = {};
  for (const entry of Object.values(CUSTOMER_LIFECYCLE_REGISTRY)) {
    byStage[entry.code] = 0;
    if (!Object.hasOwn(byGroup, entry.dashboard_group)) byGroup[entry.dashboard_group] = 0;
  }
  byStage.unclassified = 0;
  byGroup.unclassified = 0;
  return { byStage, byGroup };
}

function customerDashboard(db, state, plan) {
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE
        WHEN c.next_action_at IS NOT NULL AND c.next_action_at < ? THEN 1 ELSE 0
      END),0) AS overdue_next_action,
      COALESCE(SUM(CASE WHEN c.next_action_at IS NULL THEN 1 ELSE 0 END),0) AS no_next_action,
      COALESCE(SUM(CASE
        WHEN c.stalled_at IS NOT NULL AND c.stalled_at <= ? THEN 1 ELSE 0
      END),0) AS stalled,
      COALESCE(SUM(CASE
        WHEN (${CUSTOMER_CUSTODY_CASE_SQL})='quarantined' THEN 1 ELSE 0
      END),0) AS quarantined
    FROM customers c
    WHERE ${plan.whereSql}
  `).get(state.due.asOf, state.due.asOf, ...plan.params);
  const stageRows = db.prepare(`
    SELECT c.stage,COUNT(*) AS count
    FROM customers c
    WHERE ${plan.whereSql}
    GROUP BY c.stage
  `).all(...plan.params);
  const counts = initialCustomerStageCounts();
  for (const row of stageRows) {
    const count = Number(row.count);
    const entry = typeof row.stage === 'string'
      ? CUSTOMER_LIFECYCLE_REGISTRY[row.stage]
      : null;
    if (!entry) {
      counts.byStage.unclassified += count;
      counts.byGroup.unclassified += count;
      continue;
    }
    counts.byStage[entry.code] += count;
    counts.byGroup[entry.dashboard_group] += count;
  }

  return {
    total: Number(summary.total),
    by_stage: counts.byStage,
    by_group: counts.byGroup,
    overdue_next_action: Number(summary.overdue_next_action),
    no_next_action: Number(summary.no_next_action),
    stalled: Number(summary.stalled),
    quarantined: Number(summary.quarantined)
  };
}

function opportunityDashboard(db, plan) {
  const openStages = Object.values(OPPORTUNITY_STAGE_REGISTRY)
    .filter((entry) => entry.class === 'open')
    .map((entry) => entry.code);
  const openPlaceholders = placeholders(openStages);
  const values = db.prepare(`
    WITH crm_matching_opportunities AS (
      SELECT o.id,o.stage,o.value,o.win_probability
      FROM opportunities o
      JOIN customers c ON c.id=o.customer_id
      WHERE ${plan.whereSql}
    ), crm_classified_opportunities AS (
      SELECT
        id,stage,value,win_probability,
        CASE WHEN stage IN (${openPlaceholders}) THEN 1 ELSE 0 END AS is_open
      FROM crm_matching_opportunities
    )
    SELECT
      COALESCE(SUM(is_open),0) AS open_count,
      COALESCE(SUM(CASE
        WHEN is_open=1
          AND typeof(value) IN ('integer','real')
          AND value >= 0
          AND value <= 1.7976931348623157e308
        THEN value ELSE 0
      END),0) AS open_amount,
      COALESCE(SUM(CASE
        WHEN is_open=1
          AND typeof(value) IN ('integer','real')
          AND value >= 0
          AND value <= 1.7976931348623157e308
          AND typeof(win_probability) IN ('integer','real')
          AND win_probability >= 0
          AND win_probability <= 100
        THEN (value / 100.0) * win_probability ELSE 0
      END),0) AS weighted_forecast
    FROM crm_classified_opportunities
  `).get(...plan.params, ...openStages);
  return {
    open_count: Number(values.open_count),
    open_amount: Number(values.open_amount),
    weighted_forecast: Number(values.weighted_forecast)
  };
}

function getCrmDashboard(db, options) {
  return runReadTransaction(db, () => {
    const state = prepareQueryState(db, options, { decodeCursor: false });
    const customerPlan = buildCustomerPlan(state);
    const opportunityPlan = buildOpportunityPlan(state);
    return deepFreeze({
      customers: customerDashboard(db, state, customerPlan),
      opportunities: opportunityDashboard(db, opportunityPlan),
      meta: responseMeta(state)
    });
  });
}

module.exports = {
  CrmQueryError,
  listCustomers,
  listOpportunities,
  getCrmDashboard,
  getCustomerDetail,
  getOpportunityDetail
};
