'use strict';

const crypto = require('node:crypto');

const FORMULA_VERSION = 'tm-billing-v1';
const CURRENCY = 'USD';
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

class OrganizationBillingServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OrganizationBillingServiceError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function serviceError(status, code, message) {
  return new OrganizationBillingServiceError(status, code, message);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw serviceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is invalid.`);
  }
  return parsed;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw serviceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is invalid.`);
  }
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw serviceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is invalid.`);
  }
  return value;
}

function boundedText(value, label, maximum, required = true) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw serviceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is required.`);
  }
  if (typeof value !== 'string') {
    throw serviceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is invalid.`);
  }
  const text = value.trim();
  if ((required && !text) || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw serviceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is invalid.`);
  }
  return text || null;
}

function monthParts(value, label = 'month') {
  if (typeof value !== 'string') {
    throw serviceError(400, 'ORGANIZATION_BILLING_MONTH_INVALID', `${label} is invalid.`);
  }
  const match = MONTH_PATTERN.exec(value);
  if (!match) {
    throw serviceError(400, 'ORGANIZATION_BILLING_MONTH_INVALID', `${label} is invalid.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1970 || year > 9998) {
    throw serviceError(400, 'ORGANIZATION_BILLING_MONTH_INVALID', `${label} is invalid.`);
  }
  return { key: value, year, month };
}

function monthKey(date) {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(parts, amount) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + amount, 1));
  return monthKey(date);
}

function boundaries(parts) {
  return {
    start: `${parts.key}-01 00:00:00`,
    end: `${shiftMonth(parts, 1)}-01 00:00:00`
  };
}

function ledgerTime(date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('.000Z', '');
}

function apiTime(value) {
  return value ? `${String(value).replace(' ', 'T')}Z` : null;
}

function safeNumber(value, code = 'ORGANIZATION_BILLING_CALCULATION_UNSAFE') {
  let big;
  try {
    big = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw serviceError(503, code, 'Organization billing calculation is outside the supported safe integer range.');
  }
  if (big < 0n || big > MAX_SAFE_BIGINT) {
    throw serviceError(503, code, 'Organization billing calculation is outside the supported safe integer range.');
  }
  return Number(big);
}

function ledgerInteger(value, code = 'ORGANIZATION_BILLING_USAGE_UNSAFE') {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw serviceError(503, code, 'Organization billing ledger contains an invalid integer.');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_BIGINT) {
    throw serviceError(503, code, 'Organization billing ledger exceeds the supported safe integer range.');
  }
  return parsed;
}

function normalizePolicy(row) {
  if (!row) {
    throw serviceError(503, 'ORGANIZATION_BILLING_POLICY_UNAVAILABLE', 'Organization billing policy is unavailable.');
  }
  const result = {
    policy_version: Number(row.policy_version),
    effective_month: row.effective_month,
    billing_enabled: row.billing_enabled === 1,
    currency: row.currency,
    base_fee_cents: Number(row.base_fee_cents),
    included_tokens: Number(row.included_tokens),
    overage_cents_per_million_tokens: Number(row.overage_cents_per_million_tokens)
  };
  if (
    !Number.isSafeInteger(result.policy_version) || result.policy_version < 1 ||
    !/^\d{4}-\d{2}-01$/.test(result.effective_month) || result.currency !== CURRENCY
  ) {
    throw serviceError(503, 'ORGANIZATION_BILLING_POLICY_UNAVAILABLE', 'Organization billing policy is invalid.');
  }
  for (const key of ['base_fee_cents', 'included_tokens', 'overage_cents_per_million_tokens']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) {
      throw serviceError(503, 'ORGANIZATION_BILLING_POLICY_UNAVAILABLE', 'Organization billing policy is invalid.');
    }
  }
  return result;
}

function normalizeStatement(row) {
  if (!row) return null;
  const statement = {
    id: Number(row.id),
    organization_id: Number(row.org_id),
    period: row.period_key,
    period_start: apiTime(row.period_start),
    period_end: apiTime(row.period_end),
    policy_version: Number(row.policy_version),
    billing_enabled: row.billing_enabled === 1,
    currency: row.currency,
    usage_tokens: Number(row.usage_tokens),
    usage_record_count: Number(row.usage_record_count),
    usage_max_id: row.usage_max_id === null ? null : Number(row.usage_max_id),
    included_tokens: Number(row.included_tokens),
    billable_tokens: Number(row.billable_tokens),
    base_fee_cents: Number(row.base_fee_cents),
    overage_cents_per_million_tokens: Number(row.overage_cents_per_million_tokens),
    overage_fee_cents: Number(row.overage_fee_cents),
    total_cents: Number(row.total_cents),
    formula_version: row.formula_version,
    statement_sha256: row.statement_sha256,
    closed_by: Number(row.closed_by),
    reason: row.reason,
    created_at: apiTime(row.created_at)
  };
  const requiredPositive = ['id', 'organization_id', 'policy_version', 'closed_by'];
  const requiredNonnegative = [
    'usage_tokens',
    'usage_record_count',
    'included_tokens',
    'billable_tokens',
    'base_fee_cents',
    'overage_cents_per_million_tokens',
    'overage_fee_cents',
    'total_cents'
  ];
  if (
    requiredPositive.some((key) => !Number.isSafeInteger(statement[key]) || statement[key] < 1) ||
    requiredNonnegative.some((key) => !Number.isSafeInteger(statement[key]) || statement[key] < 0) ||
    (statement.usage_max_id !== null && (!Number.isSafeInteger(statement.usage_max_id) || statement.usage_max_id < 1)) ||
    (statement.usage_record_count === 0) !== (statement.usage_max_id === null) ||
    statement.currency !== CURRENCY || statement.billing_enabled !== true ||
    statement.formula_version !== FORMULA_VERSION ||
    !/^[a-f0-9]{64}$/.test(String(statement.statement_sha256 || ''))
  ) {
    throw serviceError(503, 'ORGANIZATION_BILLING_STATEMENT_CORRUPT', 'Organization billing statement integrity check failed.');
  }
  return statement;
}

function organizationBillingStatementDigestPayload(input) {
  return {
    formula_version: FORMULA_VERSION,
    organization_id: input.organizationId,
    period: input.periodKey,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    policy: input.policy,
    usage: input.usage,
    charges: input.charges,
    closed_by: input.closedBy,
    reason: input.reason,
    created_at: input.createdAt
  };
}

function computeOrganizationBillingStatementDigest(input) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(organizationBillingStatementDigestPayload(input)))
    .digest('hex');
}

function createOrganizationBillingService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A better-sqlite3 database is required.');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function clock() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw serviceError(503, 'ORGANIZATION_BILLING_CLOCK_UNAVAILABLE', 'Organization billing clock is unavailable.');
    }
    return date;
  }

  function requireOrganization(organizationId) {
    const row = db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId);
    if (!row) throw serviceError(404, 'ORGANIZATION_BILLING_ORGANIZATION_NOT_FOUND', 'Organization was not found.');
  }

  function activeUser(userId) {
    const row = db.prepare('SELECT id,role,is_active FROM users WHERE id=?').get(userId);
    if (!row || row.is_active !== 1) {
      throw serviceError(403, 'ORGANIZATION_BILLING_FORBIDDEN', 'Organization billing access is forbidden.');
    }
    return row;
  }

  function requirePlatformAdmin(userId) {
    const user = activeUser(userId);
    if (user.role !== 'admin') {
      throw serviceError(403, 'ORGANIZATION_BILLING_ADMIN_FORBIDDEN', 'Platform administrator access is required.');
    }
    return user;
  }

  function requireOwnBillingReader(userId, organizationId) {
    const user = activeUser(userId);
    const row = db.prepare(`
      SELECT membership.role_code,membership.status,authority.owner_user_id,policy.access_mode
      FROM organization_memberships membership
      JOIN organization_member_policy policy
        ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
      LEFT JOIN organization_authority authority ON authority.org_id=membership.org_id
      WHERE membership.org_id=? AND membership.user_id=?
    `).get(organizationId, user.id);
    if (
      !row || row.status !== 'active' || row.access_mode !== 'read_write' ||
      (row.owner_user_id !== user.id && row.role_code !== 'org_admin')
    ) {
      throw serviceError(403, 'ORGANIZATION_BILLING_FORBIDDEN', 'Organization billing access is forbidden.');
    }
    return user;
  }

  function resolvePolicy(organizationId, parts) {
    return normalizePolicy(db.prepare(`
      SELECT policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens
      FROM organization_billing_policies
      WHERE org_id=? AND effective_month<=?
      ORDER BY effective_month DESC,policy_version DESC LIMIT 1
    `).get(organizationId, `${parts.key}-01`));
  }

  function resolvePolicyVersion(organizationId, policyVersion) {
    try {
      return normalizePolicy(db.prepare(`
        SELECT policy_version,effective_month,billing_enabled,currency,base_fee_cents,
          included_tokens,overage_cents_per_million_tokens
        FROM organization_billing_policies
        WHERE org_id=? AND policy_version=?
      `).get(organizationId, policyVersion));
    } catch {
      throw serviceError(503, 'ORGANIZATION_BILLING_STATEMENT_CORRUPT', 'Organization billing statement policy is unavailable.');
    }
  }

  function policyHeadVersion(organizationId) {
    const row = db.prepare(`
      SELECT MAX(policy_version) AS policy_version
      FROM organization_billing_policies WHERE org_id=?
    `).get(organizationId);
    const version = Number(row && row.policy_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw serviceError(503, 'ORGANIZATION_BILLING_POLICY_UNAVAILABLE', 'Organization billing policy history is unavailable.');
    }
    return version;
  }

  function usageSnapshot(organizationId, period) {
    let total = 0n;
    let count = 0n;
    let maxId = null;
    const rows = db.prepare(`
      SELECT CAST(id AS TEXT) AS id,
        CAST(prompt_tokens AS TEXT) AS prompt_tokens,
        CAST(completion_tokens AS TEXT) AS completion_tokens,
        CAST(total_tokens AS TEXT) AS total_tokens
      FROM token_usage
      WHERE org_id=? AND created_at>=? AND created_at<?
      ORDER BY id
    `).iterate(organizationId, period.start, period.end);
    for (const row of rows) {
      const id = ledgerInteger(row.id);
      const prompt = ledgerInteger(row.prompt_tokens);
      const completion = ledgerInteger(row.completion_tokens);
      const rowTotal = ledgerInteger(row.total_tokens);
      if (rowTotal !== prompt + completion) {
        throw serviceError(503, 'ORGANIZATION_BILLING_USAGE_UNSAFE', 'Organization Token usage is invalid.');
      }
      total += rowTotal;
      count += 1n;
      maxId = id;
      if (total > MAX_SAFE_BIGINT || count > MAX_SAFE_BIGINT) {
        throw serviceError(503, 'ORGANIZATION_BILLING_USAGE_UNSAFE', 'Organization Token usage exceeds the supported safe integer range.');
      }
    }
    return {
      total,
      count: safeNumber(count, 'ORGANIZATION_BILLING_USAGE_UNSAFE'),
      maxId: maxId === null ? null : safeNumber(maxId, 'ORGANIZATION_BILLING_USAGE_UNSAFE')
    };
  }

  function calculate(policy, totalTokens) {
    if (!policy.billing_enabled) {
      return {
        totalTokens: safeNumber(totalTokens, 'ORGANIZATION_BILLING_USAGE_UNSAFE'),
        billableTokens: 0,
        baseFeeCents: 0,
        overageFeeCents: 0,
        totalCents: 0
      };
    }
    const included = BigInt(policy.included_tokens);
    const billable = totalTokens > included ? totalTokens - included : 0n;
    const numerator = billable * BigInt(policy.overage_cents_per_million_tokens);
    const overage = (numerator + 500000n) / 1000000n;
    const total = BigInt(policy.base_fee_cents) + overage;
    return {
      totalTokens: safeNumber(totalTokens, 'ORGANIZATION_BILLING_USAGE_UNSAFE'),
      billableTokens: safeNumber(billable),
      baseFeeCents: policy.base_fee_cents,
      overageFeeCents: safeNumber(overage),
      totalCents: safeNumber(total)
    };
  }

  function verifyStatementDigest(row, policy, statement, usage, charges) {
    if (
      policy.policy_version !== statement.policy_version ||
      policy.billing_enabled !== statement.billing_enabled ||
      policy.currency !== statement.currency ||
      policy.base_fee_cents !== statement.base_fee_cents ||
      policy.included_tokens !== statement.included_tokens ||
      policy.overage_cents_per_million_tokens !== statement.overage_cents_per_million_tokens
    ) {
      throw serviceError(503, 'ORGANIZATION_BILLING_STATEMENT_CORRUPT', 'Organization billing statement policy snapshot is inconsistent.');
    }
    const expected = computeOrganizationBillingStatementDigest({
      organizationId: statement.organization_id,
      periodKey: statement.period,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      policy,
      usage,
      charges,
      closedBy: statement.closed_by,
      reason: statement.reason,
      createdAt: row.created_at
    });
    const actualBuffer = Buffer.from(statement.statement_sha256, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw serviceError(503, 'ORGANIZATION_BILLING_STATEMENT_CORRUPT', 'Organization billing statement digest is invalid.');
    }
  }

  function closedProjection(organizationId, parts, row, headVersion) {
    const statement = normalizeStatement(row);
    if (statement.organization_id !== organizationId || statement.period !== parts.key) {
      throw serviceError(503, 'ORGANIZATION_BILLING_STATEMENT_CORRUPT', 'Organization billing statement identity is invalid.');
    }
    const policy = resolvePolicyVersion(organizationId, statement.policy_version);
    const usage = {
      total_tokens: statement.usage_tokens,
      usage_record_count: statement.usage_record_count,
      usage_max_id: statement.usage_max_id,
      billable_tokens: statement.billable_tokens
    };
    const charges = {
      base_fee_cents: statement.base_fee_cents,
      overage_fee_cents: statement.overage_fee_cents,
      total_cents: statement.total_cents
    };
    verifyStatementDigest(row, policy, statement, usage, charges);
    return {
      organization_id: organizationId,
      month: parts.key,
      period_start: statement.period_start,
      period_end: statement.period_end,
      status: 'closed',
      policy,
      policy_head_version: headVersion,
      usage,
      charges,
      statement
    };
  }

  function projectOrganizationBilling(input) {
    const organizationId = positiveInteger(input && input.organizationId, 'organizationId');
    requireOrganization(organizationId);
    const parts = monthParts(input && input.month || monthKey(clock()));
    const period = boundaries(parts);
    const headVersion = policyHeadVersion(organizationId);
    const statementRow = db.prepare(`
      SELECT * FROM organization_billing_statements WHERE org_id=? AND period_key=?
    `).get(organizationId, parts.key);
    if (statementRow) return closedProjection(organizationId, parts, statementRow, headVersion);

    const policy = resolvePolicy(organizationId, parts);
    const ledger = usageSnapshot(organizationId, period);
    const calculated = calculate(policy, ledger.total);
    const currentMonth = monthKey(clock());
    let status;
    if (!policy.billing_enabled) status = 'disabled';
    else if (parts.key < currentMonth) status = 'closable';
    else if (parts.key > currentMonth) status = 'scheduled';
    else status = 'estimated';
    return {
      organization_id: organizationId,
      month: parts.key,
      period_start: apiTime(period.start),
      period_end: apiTime(period.end),
      status,
      policy,
      policy_head_version: headVersion,
      usage: {
        total_tokens: calculated.totalTokens,
        usage_record_count: ledger.count,
        usage_max_id: ledger.maxId,
        billable_tokens: calculated.billableTokens
      },
      charges: {
        base_fee_cents: calculated.baseFeeCents,
        overage_fee_cents: calculated.overageFeeCents,
        total_cents: calculated.totalCents
      },
      statement: null
    };
  }

  function projectOrganizationBillingSummary(input) {
    const organizationId = positiveInteger(input && input.organizationId, 'organizationId');
    requireOrganization(organizationId);
    const parts = monthParts(input && input.month || monthKey(clock()));
    const policy = resolvePolicy(organizationId, parts);
    const headVersion = policyHeadVersion(organizationId);
    const statement = db.prepare(`
      SELECT id FROM organization_billing_statements WHERE org_id=? AND period_key=?
    `).get(organizationId, parts.key);
    const currentMonth = monthKey(clock());
    let status;
    if (statement) status = 'closed';
    else if (!policy.billing_enabled) status = 'disabled';
    else if (parts.key < currentMonth) status = 'closable';
    else if (parts.key > currentMonth) status = 'scheduled';
    else status = 'estimated';
    return {
      organization_id: organizationId,
      month: parts.key,
      status,
      policy,
      policy_head_version: headVersion,
      statement_id: statement ? Number(statement.id) : null
    };
  }

  function writeAudit(input) {
    try {
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details,ip_address)
        VALUES (?,?,?,?,?)
      `).run(
        input.actorUserId,
        input.action,
        'organization_billing',
        JSON.stringify(input.details),
        input.ipAddress || null
      );
    } catch {
      throw serviceError(503, 'ORGANIZATION_BILLING_AUDIT_FAILED', 'Organization billing audit could not be persisted.');
    }
  }

  function currentOrganizationBilling(input) {
    const actorUserId = positiveInteger(input && input.actorUserId, 'actorUserId');
    const organizationId = positiveInteger(input && input.organizationId, 'organizationId');
    requireOrganization(organizationId);
    const requestedMonth = monthParts(input && input.month).key;
    if (input && input.adminAuditGlobal === true) {
      requirePlatformAdmin(actorUserId);
      const projection = projectOrganizationBilling({ organizationId, month: requestedMonth });
      writeAudit({
        actorUserId,
        action: 'admin_view_organization_billing',
        ipAddress: input.ipAddress,
        details: {
          schema_version: 1,
          actor_user_id: actorUserId,
          organization_id: organizationId,
          month: requestedMonth,
          request_id: boundedText(input.requestId, 'requestId', 160, false)
        }
      });
      return projection;
    }
    requireOwnBillingReader(actorUserId, organizationId);
    return projectOrganizationBilling({ organizationId, month: requestedMonth });
  }

  const updatePolicyTransaction = db.transaction((input) => {
    const actorUserId = positiveInteger(input && input.actorUserId, 'actorUserId');
    const organizationId = positiveInteger(input && input.organizationId, 'organizationId');
    requirePlatformAdmin(actorUserId);
    requireOrganization(organizationId);
    const enabled = requiredBoolean(input.billingEnabled, 'billingEnabled');
    const baseFeeCents = nonnegativeInteger(input.baseFeeCents, 'baseFeeCents');
    const includedTokens = nonnegativeInteger(input.includedTokens, 'includedTokens');
    const rate = nonnegativeInteger(input.overageCentsPerMillionTokens, 'overageCentsPerMillionTokens');
    const effective = monthParts(input.effectiveMonth, 'effectiveMonth');
    const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion');
    const reason = boundedText(input.reason, 'reason', 500);
    const nextMonth = shiftMonth(monthParts(monthKey(clock())), 1);
    if (effective.key < nextMonth) {
      throw serviceError(
        400,
        'ORGANIZATION_BILLING_EFFECTIVE_MONTH_INVALID',
        'Billing policy must become effective in the next UTC month or later.'
      );
    }
    if (!enabled && (baseFeeCents !== 0 || includedTokens !== 0 || rate !== 0)) {
      throw serviceError(400, 'ORGANIZATION_BILLING_INVALID', 'Disabled billing policy amounts must be zero.');
    }
    const current = normalizePolicy(db.prepare(`
      SELECT policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens
      FROM organization_billing_policies WHERE org_id=? ORDER BY policy_version DESC LIMIT 1
    `).get(organizationId));
    if (current.policy_version !== expectedVersion) {
      throw serviceError(409, 'ORGANIZATION_BILLING_VERSION_CONFLICT', 'Organization billing policy changed; refresh and retry.');
    }
    if (
      current.effective_month === `${effective.key}-01` && current.billing_enabled === enabled &&
      current.base_fee_cents === baseFeeCents && current.included_tokens === includedTokens &&
      current.overage_cents_per_million_tokens === rate
    ) {
      throw serviceError(409, 'ORGANIZATION_BILLING_POLICY_UNCHANGED', 'Organization billing policy is unchanged.');
    }
    const nextVersion = current.policy_version + 1;
    db.prepare(`
      INSERT INTO organization_billing_policies (
        org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'admin_update')
    `).run(
      organizationId, nextVersion, `${effective.key}-01`, enabled ? 1 : 0, CURRENCY,
      baseFeeCents, includedTokens, rate, actorUserId, reason
    );
    const policy = normalizePolicy(db.prepare(`
      SELECT policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens
      FROM organization_billing_policies WHERE org_id=? AND policy_version=?
    `).get(organizationId, nextVersion));
    writeAudit({
      actorUserId,
      action: 'organization_billing_policy_changed',
      ipAddress: input.ipAddress,
      details: {
        schema_version: 1,
        actor_user_id: actorUserId,
        organization_id: organizationId,
        reason,
        request_id: boundedText(input.requestId, 'requestId', 160, false),
        before: current,
        after: policy
      }
    });
    return {
      changed: true,
      organization_id: organizationId,
      policy,
      policy_head_version: nextVersion
    };
  });

  function updateOrganizationBillingPolicy(input) {
    try {
      return updatePolicyTransaction.immediate(input || {});
    } catch (error) {
      if (error instanceof OrganizationBillingServiceError) throw error;
      throw serviceError(503, 'ORGANIZATION_BILLING_POLICY_UNAVAILABLE', 'Organization billing policy could not be updated.');
    }
  }

  const closeStatementTransaction = db.transaction((input) => {
    const actorUserId = positiveInteger(input && input.actorUserId, 'actorUserId');
    const organizationId = positiveInteger(input && input.organizationId, 'organizationId');
    requirePlatformAdmin(actorUserId);
    requireOrganization(organizationId);
    const periodParts = monthParts(input.period, 'period');
    const expectedPolicyVersion = positiveInteger(input.expectedPolicyVersion, 'expectedPolicyVersion');
    const reason = boundedText(input.reason, 'reason', 500);
    const currentMonth = monthKey(clock());
    if (periodParts.key >= currentMonth) {
      throw serviceError(409, 'ORGANIZATION_BILLING_PERIOD_OPEN', 'Only an ended UTC month can be closed.');
    }
    const existing = db.prepare(`
      SELECT * FROM organization_billing_statements WHERE org_id=? AND period_key=?
    `).get(organizationId, periodParts.key);
    if (existing) {
      const projection = projectOrganizationBilling({ organizationId, month: periodParts.key });
      if (
        Number(existing.policy_version) !== expectedPolicyVersion ||
        Number(existing.closed_by) !== actorUserId || existing.reason !== reason
      ) {
        throw serviceError(409, 'ORGANIZATION_BILLING_STATEMENT_CONFLICT', 'Organization billing statement is already closed.');
      }
      return {
        ...projection,
        idempotent_replay: true
      };
    }
    const projection = projectOrganizationBilling({ organizationId, month: periodParts.key });
    if (!projection.policy.billing_enabled) {
      throw serviceError(409, 'ORGANIZATION_BILLING_DISABLED', 'Billing is disabled for this period.');
    }
    if (projection.policy.policy_version !== expectedPolicyVersion) {
      throw serviceError(409, 'ORGANIZATION_BILLING_VERSION_CONFLICT', 'Organization billing policy changed; refresh and retry.');
    }
    const period = boundaries(periodParts);
    const createdAt = ledgerTime(clock());
    const digest = computeOrganizationBillingStatementDigest({
      organizationId,
      periodKey: periodParts.key,
      periodStart: period.start,
      periodEnd: period.end,
      policy: projection.policy,
      usage: projection.usage,
      charges: projection.charges,
      closedBy: actorUserId,
      reason,
      createdAt
    });
    const result = db.prepare(`
      INSERT INTO organization_billing_statements (
        org_id,period_key,period_start,period_end,policy_version,billing_enabled,currency,
        usage_tokens,usage_record_count,usage_max_id,included_tokens,billable_tokens,base_fee_cents,
        overage_cents_per_million_tokens,overage_fee_cents,total_cents,formula_version,
        statement_sha256,closed_by,reason,created_at
      ) VALUES (
        @org_id,@period_key,@period_start,@period_end,@policy_version,1,@currency,
        @usage_tokens,@usage_record_count,@usage_max_id,@included_tokens,@billable_tokens,@base_fee_cents,
        @overage_rate,@overage_fee_cents,@total_cents,@formula_version,
        @statement_sha256,@closed_by,@reason,@created_at
      )
    `).run({
      org_id: organizationId,
      period_key: periodParts.key,
      period_start: period.start,
      period_end: period.end,
      policy_version: projection.policy.policy_version,
      currency: CURRENCY,
      usage_tokens: projection.usage.total_tokens,
      usage_record_count: projection.usage.usage_record_count,
      usage_max_id: projection.usage.usage_max_id,
      included_tokens: projection.policy.included_tokens,
      billable_tokens: projection.usage.billable_tokens,
      base_fee_cents: projection.charges.base_fee_cents,
      overage_rate: projection.policy.overage_cents_per_million_tokens,
      overage_fee_cents: projection.charges.overage_fee_cents,
      total_cents: projection.charges.total_cents,
      formula_version: FORMULA_VERSION,
      statement_sha256: digest,
      closed_by: actorUserId,
      reason,
      created_at: createdAt
    });
    writeAudit({
      actorUserId,
      action: 'organization_billing_statement_closed',
      ipAddress: input.ipAddress,
      details: {
        schema_version: 1,
        actor_user_id: actorUserId,
        organization_id: organizationId,
        period: periodParts.key,
        policy_version: projection.policy.policy_version,
        statement_sha256: digest,
        total_cents: projection.charges.total_cents,
        currency: CURRENCY,
        reason,
        request_id: boundedText(input.requestId, 'requestId', 160, false)
      }
    });
    const closed = projectOrganizationBilling({ organizationId, month: periodParts.key });
    return {
      ...closed,
      idempotent_replay: false
    };
  });

  function closeOrganizationBillingStatement(input) {
    try {
      return closeStatementTransaction.immediate(input || {});
    } catch (error) {
      if (error instanceof OrganizationBillingServiceError) throw error;
      throw serviceError(503, 'ORGANIZATION_BILLING_STATEMENT_UNAVAILABLE', 'Organization billing statement could not be closed.');
    }
  }

  return {
    projectOrganizationBilling,
    projectOrganizationBillingSummary,
    currentOrganizationBilling,
    updateOrganizationBillingPolicy,
    closeOrganizationBillingStatement
  };
}

module.exports = {
  CURRENCY,
  FORMULA_VERSION,
  OrganizationBillingServiceError,
  computeOrganizationBillingStatementDigest,
  createOrganizationBillingService
};
