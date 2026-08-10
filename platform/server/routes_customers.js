'use strict';

module.exports = function registerCustomerRoutes(app, db, authMiddleware, dependencies) {
  const { randomUUID } = require('node:crypto');
  const options = dependencies || {};
  const crmQueryService = options.crmQueryService || require('./services/crm_query_service');
  const crmCustomerService = options.crmCustomerService || require('./services/crm_customer_service');
  const businessKnowledge = require('./services/business_knowledge_service');
  const crmAccess = require('./services/crm_access_service');
  const { CUSTOMER_LIFECYCLE_REGISTRY } = require('./services/crm_contract');

  const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]+$/;
  const CUSTOMER_PROFILE_FIELDS = Object.freeze([
    'brand_name',
    'company_name',
    'contact_person',
    'contact_info',
    'industry',
    'country',
    'source',
    'budget_estimate',
    'notes',
    'tags',
    'priority',
    'next_action_at'
  ]);
  const OPPORTUNITY_VALUE_FIELDS = Object.freeze([
    'name',
    'value',
    'win_probability',
    'product_name',
    'channel_type',
    'expected_close_date',
    'competitor_info',
    'decision_chain',
    'notes',
    'next_action_at',
    'loss_reason',
    'campaign_id'
  ]);
  const CONTACT_VALUE_FIELDS = Object.freeze(['name', 'role', 'email', 'phone', 'is_preferred']);
  const TASK_VALUE_FIELDS = Object.freeze([
    'opportunity_id',
    'owner_user_id',
    'team_id',
    'title',
    'description',
    'due_at',
    'source',
    'completion_note'
  ]);
  const CANONICAL_FILTER_FIELDS = Object.freeze([
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
    'as_of',
    'limit',
    'cursor'
  ]);
  const ACTIVE_CUSTOMER_STAGES = Object.values(CUSTOMER_LIFECYCLE_REGISTRY)
    .filter((entry) => entry.class === 'active')
    .map((entry) => entry.code);
  const TERMINAL_CUSTOMER_STAGES = Object.values(CUSTOMER_LIFECYCLE_REGISTRY)
    .filter((entry) => entry.class === 'terminal')
    .map((entry) => entry.code);
  const STAGE_LABELS = Object.freeze(Object.fromEntries(
    Object.values(CUSTOMER_LIFECYCLE_REGISTRY).map((entry) => [entry.code, entry.label_detail])
  ));
  const KNOWN_ERROR_CODES = new Set([
    'CRM_HTTP_INVALID',
    'CRM_CONTRACT_INVALID',
    'CRM_FILTER_INVALID',
    'CRM_CURSOR_INVALID',
    'CRM_IDENTITY_INVALID',
    'CRM_SCOPE_INVALID',
    'CRM_SCOPE_FORBIDDEN',
    'CRM_SCOPE_NOT_FOUND',
    'CRM_MUTATION_INVALID',
    'CRM_CUSTOMER_NOT_FOUND',
    'CRM_CHILD_NOT_FOUND',
    'CRM_CUSTOMER_FORBIDDEN',
    'CRM_CUSTOMER_DUPLICATE',
    'CRM_PUBLIC_POOL_UNAVAILABLE',
    'CRM_CUSTODY_CONFLICT',
    'CRM_TRANSITION_INVALID',
    'CRM_STORAGE_BUSY',
    'CRM_MUTATION_FAILED',
    'CRM_QUERY_FAILED',
    'CRM_HARD_DELETE_UNAVAILABLE',
    'CRM_SALES_SCOPE_UNAVAILABLE'
  ]);
  const ERROR_TITLES = Object.freeze({
    CRM_HTTP_INVALID: 'CRM request is not valid',
    CRM_CONTRACT_INVALID: 'CRM request contract is not valid',
    CRM_FILTER_INVALID: 'CRM filter is not valid',
    CRM_CURSOR_INVALID: 'CRM cursor is not valid',
    CRM_IDENTITY_INVALID: 'CRM customer identity is not valid',
    CRM_SCOPE_INVALID: 'CRM organization context is not valid',
    CRM_SCOPE_FORBIDDEN: 'CRM scope is not allowed',
    CRM_SCOPE_NOT_FOUND: 'CRM organization context was not found',
    CRM_MUTATION_INVALID: 'CRM mutation command is not valid',
    CRM_CUSTOMER_NOT_FOUND: 'CRM customer was not found',
    CRM_CHILD_NOT_FOUND: 'CRM child record was not found',
    CRM_CUSTOMER_FORBIDDEN: 'CRM customer mutation is not allowed',
    CRM_CUSTOMER_DUPLICATE: 'Customer identity conflicts with an existing record',
    CRM_PUBLIC_POOL_UNAVAILABLE: 'CRM public-pool customer is unavailable',
    CRM_CUSTODY_CONFLICT: 'CRM customer custody changed',
    CRM_TRANSITION_INVALID: 'CRM transition is not allowed',
    CRM_STORAGE_BUSY: 'CRM storage is temporarily unavailable',
    CRM_MUTATION_FAILED: 'CRM mutation failed',
    CRM_QUERY_FAILED: 'CRM query failed',
    CRM_HARD_DELETE_UNAVAILABLE: 'CRM hard delete is unavailable',
    CRM_SALES_SCOPE_UNAVAILABLE: 'CRM sales reporting requires organization-scoped data',
    CRM_HTTP_FAILED: 'CRM request failed'
  });

  class CrmHttpError extends Error {
    constructor(code, status) {
      super(ERROR_TITLES[code] || ERROR_TITLES.CRM_HTTP_FAILED);
      this.name = 'CrmHttpError';
      this.code = code;
      this.status = status;
      this.title = ERROR_TITLES[code] || ERROR_TITLES.CRM_HTTP_FAILED;
    }
  }

  function invalidHttp() {
    return new CrmHttpError('CRM_HTTP_INVALID', 400);
  }

  function positiveInteger(value) {
    if (Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw invalidHttp();
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalidHttp();
    return parsed;
  }

  function plainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidHttp();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidHttp();
    return value;
  }

  function ownValue(record, key) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false };
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw invalidHttp();
    return { present: true, value: descriptor.value };
  }

  function projectValues(record, fields, transforms) {
    const result = {};
    for (const field of fields) {
      const property = ownValue(record, field);
      if (!property.present) continue;
      const transform = transforms && transforms[field];
      result[field] = transform ? transform(property.value) : property.value;
    }
    return result;
  }

  function compatibleTimestamp(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `${value} 00:00:00`;
    }
    return value;
  }

  function safeRequestIdentifier(value, maximum) {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum && SAFE_IDENTIFIER.test(value)
      ? value
      : null;
  }

  function requestId(req) {
    return safeRequestIdentifier(req.requestId, 120) ||
      safeRequestIdentifier(req.phase4Request && req.phase4Request.requestId, 120) ||
      `crm-${randomUUID()}`;
  }

  function serviceContext(req) {
    const actorUserId = positiveInteger(req.user && req.user.id);
    const authContext = plainRecord(req.authContext);
    const organization = plainRecord(authContext.organization);
    const organizationId = positiveInteger(organization.id);
    const currentRequestId = requestId(req);
    const headerCorrelationId = safeRequestIdentifier(
      req.headers && req.headers['x-correlation-id'],
      128
    );
    return {
      actorUserId,
      organizationId,
      requestId: currentRequestId,
      correlationId: headerCorrelationId || currentRequestId
    };
  }

  function teamIds(req) {
    const authContext = plainRecord(req.authContext);
    if (!Array.isArray(authContext.teams) || authContext.teams.length === 0) throw invalidHttp();
    const result = [];
    for (const team of authContext.teams) {
      const id = positiveInteger(plainRecord(team).id);
      if (result.includes(id)) throw invalidHttp();
      result.push(id);
    }
    return result;
  }

  function selectedTeamId(req, requested) {
    const available = teamIds(req);
    if (requested !== undefined && requested !== null && requested !== '') {
      const requestedId = positiveInteger(requested);
      if (!available.includes(requestedId)) throw invalidHttp();
      return requestedId;
    }
    if (available.length !== 1) throw invalidHttp();
    return available[0];
  }

  function isOrganizationAdmin(req) {
    const context = plainRecord(req.authContext);
    const organization = plainRecord(context.organization);
    return organization.role_code === 'org_admin';
  }

  function normalizeTextAlias(value) {
    if (typeof value !== 'string') throw invalidHttp();
    const normalized = value.trim();
    if (!normalized) throw invalidHttp();
    return normalized;
  }

  function normalizeArray(value) {
    const input = Array.isArray(value) ? value : [value];
    const result = [];
    for (const item of input) {
      if (typeof item !== 'string') throw invalidHttp();
      for (const part of item.split(',')) {
        const normalized = part.trim();
        if (!normalized) throw invalidHttp();
        if (!result.includes(normalized)) result.push(normalized);
      }
    }
    return result;
  }

  function booleanQuery(value) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw invalidHttp();
  }

  function normalizeScope(value) {
    if (value === 'all') return 'organization';
    return value;
  }

  function readCanonicalFilter(query, kind) {
    const source = plainRecord(query || {});
    const filter = {};
    for (const field of CANONICAL_FILTER_FIELDS) {
      const property = ownValue(source, field);
      if (!property.present) continue;
      if (field === 'scope') filter.scope = normalizeScope(property.value);
      else if (field === 'owner_id' || field === 'team_id' || field === 'limit') {
        filter[field] = positiveInteger(property.value);
      } else if (field === 'stalled') filter.stalled = booleanQuery(property.value);
      else if (field === 'customer_stage' || field === 'opportunity_stage' || field === 'priority') {
        filter[field] = normalizeArray(property.value);
      } else filter[field] = property.value;
    }

    const pageSize = ownValue(source, 'pageSize');
    if (pageSize.present) {
      if (Object.prototype.hasOwnProperty.call(filter, 'limit')) throw invalidHttp();
      filter.limit = Math.min(positiveInteger(pageSize.value), 100);
    }
    const search = ownValue(source, 'search');
    if (search.present) {
      if (Object.prototype.hasOwnProperty.call(filter, 'keyword')) throw invalidHttp();
      filter.keyword = normalizeTextAlias(search.value);
    }
    const stage = ownValue(source, 'stage');
    if (stage.present) {
      const target = kind === 'opportunity' ? 'opportunity_stage' : 'customer_stage';
      if (Object.prototype.hasOwnProperty.call(filter, target)) throw invalidHttp();
      filter[target] = normalizeArray(stage.value);
    }
    const status = ownValue(source, 'status');
    if (status.present) {
      if (kind !== 'customer' || Object.prototype.hasOwnProperty.call(filter, 'customer_stage')) {
        throw invalidHttp();
      }
      if (status.value === 'active') filter.customer_stage = ACTIVE_CUSTOMER_STAGES.slice();
      else if (status.value === 'terminal') filter.customer_stage = TERMINAL_CUSTOMER_STAGES.slice();
      else throw invalidHttp();
    }
    const isPublic = ownValue(source, 'is_public');
    if (isPublic.present) {
      if (isPublic.value !== '1' && isPublic.value !== 1 && isPublic.value !== true) throw invalidHttp();
      if (Object.prototype.hasOwnProperty.call(filter, 'scope') && filter.scope !== 'public_pool') {
        throw invalidHttp();
      }
      filter.scope = 'public_pool';
    }
    if (kind === 'opportunity' && ownValue(source, 'customer_id').present) throw invalidHttp();
    return filter;
  }

  function customerTransition(body) {
    const nested = ownValue(body, 'transition');
    const stage = ownValue(body, 'stage');
    if (nested.present && stage.present) throw invalidHttp();
    if (nested.present) {
      const source = plainRecord(nested.value);
      return projectValues(source, [
        'to_stage', 'reason_code', 'next_action_at', 'no_opportunity_exception'
      ], { next_action_at: compatibleTimestamp });
    }
    if (!stage.present) {
      for (const field of ['reason_code', 'no_opportunity_exception']) {
        if (ownValue(body, field).present) throw invalidHttp();
      }
      return null;
    }
    const transition = { to_stage: stage.value };
    for (const field of ['reason_code', 'next_action_at', 'no_opportunity_exception']) {
      const property = ownValue(body, field);
      if (property.present) {
        transition[field] = field === 'next_action_at'
          ? compatibleTimestamp(property.value)
          : property.value;
      }
    }
    return transition;
  }

  function opportunityTransition(body) {
    const nested = ownValue(body, 'transition');
    const stage = ownValue(body, 'stage');
    if (nested.present && stage.present) throw invalidHttp();
    if (nested.present) {
      return projectValues(plainRecord(nested.value), [
        'to_stage', 'reason_code', 'campaign_disposition'
      ]);
    }
    if (!stage.present) {
      for (const field of ['reason_code', 'campaign_disposition']) {
        if (ownValue(body, field).present) throw invalidHttp();
      }
      return null;
    }
    const transition = { to_stage: stage.value };
    for (const field of ['reason_code', 'campaign_disposition']) {
      const property = ownValue(body, field);
      if (property.present) transition[field] = property.value;
    }
    return transition;
  }

  function problemStatus(code) {
    if (code === 'CRM_HTTP_INVALID' || code === 'CRM_CONTRACT_INVALID' ||
        code === 'CRM_FILTER_INVALID' || code === 'CRM_CURSOR_INVALID' ||
        code === 'CRM_IDENTITY_INVALID' || code === 'CRM_SCOPE_INVALID' ||
        code === 'CRM_MUTATION_INVALID') return 400;
    if (code === 'CRM_SCOPE_FORBIDDEN' || code === 'CRM_CUSTOMER_FORBIDDEN') return 403;
    if (code === 'CRM_SCOPE_NOT_FOUND' || code === 'CRM_CUSTOMER_NOT_FOUND' ||
        code === 'CRM_CHILD_NOT_FOUND') return 404;
    if (code === 'CRM_CUSTOMER_DUPLICATE' || code === 'CRM_PUBLIC_POOL_UNAVAILABLE' ||
        code === 'CRM_CUSTODY_CONFLICT' || code === 'CRM_TRANSITION_INVALID' ||
        code === 'CRM_HARD_DELETE_UNAVAILABLE' || code === 'CRM_SALES_SCOPE_UNAVAILABLE') return 409;
    if (code === 'CRM_STORAGE_BUSY') return 503;
    if (code === 'CRM_MUTATION_FAILED' || code === 'CRM_QUERY_FAILED') return 500;
    return 500;
  }

  function safeConflict(error) {
    const details = error && error.details;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    const conflict = details.conflict;
    if (!conflict || typeof conflict !== 'object' || Array.isArray(conflict)) return null;
    const result = {};
    if (['readable', 'public_pool', 'restricted'].includes(conflict.visibility)) {
      result.visibility = conflict.visibility;
    }
    if (conflict.action === 'review_public_pool') result.action = conflict.action;
    if (
      result.visibility === 'readable' &&
      conflict.customer && typeof conflict.customer === 'object' && !Array.isArray(conflict.customer)
    ) {
      const customer = {};
      if (Number.isSafeInteger(conflict.customer.id) && conflict.customer.id > 0) customer.id = conflict.customer.id;
      if (typeof conflict.customer.display_name === 'string' && conflict.customer.display_name.length <= 1000) {
        customer.display_name = conflict.customer.display_name;
      }
      if (typeof conflict.customer.stage === 'string' && conflict.customer.stage.length <= 120) {
        customer.stage = conflict.customer.stage;
      }
      result.customer = customer;
    }
    return Object.keys(result).length ? result : null;
  }

  function sendProblem(res, req, error) {
    const candidateCode = error && typeof error.code === 'string' ? error.code : 'CRM_HTTP_FAILED';
    const code = KNOWN_ERROR_CODES.has(candidateCode) ? candidateCode : 'CRM_HTTP_FAILED';
    const status = problemStatus(code);
    const currentRequestId = requestId(req);
    const title = ERROR_TITLES[code] || ERROR_TITLES.CRM_HTTP_FAILED;
    const body = {
      type: `https://api.turingmarket.example/problems/${code.toLowerCase().replace(/_/g, '-')}`,
      title,
      status,
      code,
      request_id: currentRequestId,
      instance: `urn:turingmarket:request:${currentRequestId}`
    };
    const conflict = code === 'CRM_CUSTOMER_DUPLICATE' ? safeConflict(error) : null;
    if (conflict) body.conflict = conflict;
    if (code === 'CRM_STORAGE_BUSY' && error && error.retryable === true) body.retryable = true;
    if (typeof res.type === 'function') res.type('application/problem+json');
    return res.status(status).json(body);
  }

  function crmHandler(handler) {
    return function boundedCrmHandler(req, res) {
      try {
        return handler(req, res);
      } catch (error) {
        return sendProblem(res, req, error);
      }
    };
  }

  function callMutation(serviceMethod, req, command) {
    return crmCustomerService[serviceMethod](db, {
      ...serviceContext(req),
      command
    });
  }

  function callQuery(serviceMethod, req, filter) {
    const context = serviceContext(req);
    delete context.correlationId;
    return crmQueryService[serviceMethod](db, { ...context, filter });
  }

  function customerCreateCommand(req) {
    const body = plainRecord(req.body || {});
    const stage = ownValue(body, 'stage');
    if (stage.present && stage.value !== 'lead') throw invalidHttp();
    const values = projectValues(body, CUSTOMER_PROFILE_FIELDS, {
      next_action_at: compatibleTimestamp
    });
    const requestedOwner = ownValue(body, 'assigned_to');
    const requestedTeam = ownValue(body, 'team_id');
    values.assigned_to = isOrganizationAdmin(req) && requestedOwner.present
      ? positiveInteger(requestedOwner.value)
      : positiveInteger(req.user.id);
    values.team_id = selectedTeamId(req, requestedTeam.present ? requestedTeam.value : undefined);
    return { mode: 'create', values };
  }

  function customerUpdateCommand(req) {
    const body = plainRecord(req.body || {});
    if (ownValue(body, 'assigned_to').present || ownValue(body, 'team_id').present ||
        ownValue(body, 'opportunity_value').present || ownValue(body, 'win_probability').present) {
      throw invalidHttp();
    }
    const command = {
      mode: 'update',
      customerId: positiveInteger(req.params.id),
      values: projectValues(body, CUSTOMER_PROFILE_FIELDS, {
        next_action_at: compatibleTimestamp
      })
    };
    const transition = customerTransition(body);
    if (transition) {
      command.transition = transition;
      if (ownValue(body, 'stage').present && ownValue(body, 'next_action_at').present) {
        delete command.values.next_action_at;
      }
    }
    return command;
  }

  function opportunityCreateCommand(req) {
    const body = plainRecord(req.body || {});
    const stage = ownValue(body, 'stage');
    if (stage.present && stage.value !== 'discovery') throw invalidHttp();
    if (ownValue(body, 'transition').present || ownValue(body, 'reason_code').present ||
        ownValue(body, 'campaign_disposition').present) throw invalidHttp();
    return {
      mode: 'create',
      customerId: positiveInteger(ownValue(body, 'customer_id').value),
      values: projectValues(body, OPPORTUNITY_VALUE_FIELDS, {
        expected_close_date: compatibleTimestamp,
        next_action_at: compatibleTimestamp
      })
    };
  }

  function opportunityUpdateCommand(req) {
    const body = plainRecord(req.body || {});
    const command = {
      mode: 'update',
      customerId: positiveInteger(ownValue(body, 'customer_id').value),
      opportunityId: positiveInteger(req.params.id),
      values: projectValues(body, OPPORTUNITY_VALUE_FIELDS, {
        expected_close_date: compatibleTimestamp,
        next_action_at: compatibleTimestamp
      })
    };
    const transition = opportunityTransition(body);
    if (transition) command.transition = transition;
    return command;
  }

  function releaseCommand(req) {
    const body = plainRecord(req.body || {});
    const command = { action: 'release', customerId: positiveInteger(req.params.id) };
    const reason = ownValue(body, 'reason_code');
    if (reason.present) command.reason_code = reason.value;
    return command;
  }

  function statsResponse(req, filter) {
    const dashboard = callQuery('getCrmDashboard', req, filter);
    const poolFilter = { scope: 'public_pool', limit: 1 };
    if (Object.prototype.hasOwnProperty.call(filter, 'as_of')) poolFilter.as_of = filter.as_of;
    const pool = callQuery('listCustomers', req, poolFilter);
    const byStage = dashboard.customers.by_stage;
    const active = ACTIVE_CUSTOMER_STAGES.reduce((total, stage) => total + Number(byStage[stage] || 0), 0);
    return {
      ...dashboard,
      byStage,
      total: dashboard.customers.total,
      active,
      paused: Number(byStage.paused || 0),
      won: Number(byStage.won || 0),
      publicPool: Number(pool.total || 0),
      totalOppValue: Number(dashboard.opportunities.open_amount || 0),
      stages: STAGE_LABELS
    };
  }

  // Lead management remains a legacy compatibility surface; conversion is routed through S4 below.
  app.get('/api/leads', authMiddleware, (req, res) => {
    try {
      const { status, search } = req.query;
      let sql = 'SELECT * FROM leads';
      const params = [];
      const conditions = [];
      if (status) { conditions.push('status = ?'); params.push(status); }
      if (search) {
        conditions.push('(brand_name LIKE ? OR company_name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      if (req.user.role !== 'admin') { conditions.push('assigned_to = ?'); params.push(req.user.id); }
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      sql += ' ORDER BY created_at DESC LIMIT 200';
      return res.json({ leads: db.prepare(sql).all(...params) });
    } catch (_error) {
      return res.status(500).json({ error: 'Lead query failed' });
    }
  });

  app.post('/api/leads', authMiddleware, (req, res) => {
    try {
      const body = req.body || {};
      const result = db.prepare(`
        INSERT INTO leads (
          brand_name,company_name,contact_person,contact_info,source,
          industry,notes,assigned_to,lead_score
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        body.brand_name,
        body.company_name,
        body.contact_person,
        body.contact_info,
        body.source || 'manual',
        body.industry,
        body.notes,
        req.user.id,
        10
      );
      businessKnowledge.archiveLead(
        db,
        db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid),
        req.user
      );
      return res.json({ id: result.lastInsertRowid });
    } catch (_error) {
      return res.status(500).json({ error: 'Lead creation failed' });
    }
  });

  app.put('/api/leads/:id', authMiddleware, (req, res) => {
    try {
      const lead = crmAccess.getLead(db, req.params.id);
      if (!lead) return crmAccess.notFound(res, 'Lead');
      if (!crmAccess.canAccessLead(req.user, lead)) return crmAccess.forbidden(res);
      const body = req.body || {};
      db.prepare(`
        UPDATE leads SET
          brand_name=COALESCE(?,brand_name),company_name=COALESCE(?,company_name),
          contact_person=COALESCE(?,contact_person),contact_info=COALESCE(?,contact_info),
          source=COALESCE(?,source),industry=COALESCE(?,industry),notes=COALESCE(?,notes),
          status=COALESCE(?,status),lead_score=COALESCE(?,lead_score),updated_at=datetime('now')
        WHERE id=?
      `).run(
        body.brand_name,
        body.company_name,
        body.contact_person,
        body.contact_info,
        body.source,
        body.industry,
        body.notes,
        body.status,
        body.lead_score,
        req.params.id
      );
      businessKnowledge.archiveLead(db, db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id), req.user);
      return res.json({ success: true });
    } catch (_error) {
      return res.status(500).json({ error: 'Lead update failed' });
    }
  });

  app.post('/api/leads/:id/convert', authMiddleware, crmHandler((req, res) => {
    const body = plainRecord(req.body || {});
    const requestedOwner = ownValue(body, 'assigned_to');
    const requestedTeam = ownValue(body, 'team_id');
    const command = {
      mode: 'create',
      sourceLeadId: positiveInteger(req.params.id),
      values: {
        assigned_to: isOrganizationAdmin(req) && requestedOwner.present
          ? positiveInteger(requestedOwner.value)
          : positiveInteger(req.user.id),
        team_id: selectedTeamId(req, requestedTeam.present ? requestedTeam.value : undefined)
      }
    };
    return res.json(callMutation('createOrUpdateCustomer', req, command));
  }));

  app.get('/api/customers', authMiddleware, crmHandler((req, res) => {
    const result = callQuery('listCustomers', req, readCanonicalFilter(req.query, 'customer'));
    return res.json({ ...result, customers: result.items, stages: STAGE_LABELS });
  }));

  app.get('/api/customers/stats', authMiddleware, crmHandler((req, res) => {
    return res.json(statsResponse(req, readCanonicalFilter(req.query, 'customer')));
  }));

  app.get('/api/customers/:id/detail', authMiddleware, (req, res) => {
    try {
      const customer = crmAccess.getCustomer(db, req.params.id);
      if (!customer) return crmAccess.notFound(res, 'Customer');
      if (!crmAccess.canAccessCustomer(req.user, customer)) return crmAccess.forbidden(res);
      const opportunities = db.prepare(
        'SELECT * FROM opportunities WHERE customer_id = ? ORDER BY created_at DESC'
      ).all(req.params.id);
      const activity = db.prepare(`
        SELECT a.*,u.display_name
        FROM customer_activity a
        LEFT JOIN users u ON a.user_id=u.id
        WHERE a.customer_id=?
        ORDER BY a.created_at DESC
        LIMIT 50
      `).all(req.params.id);
      return res.json({ customer, opportunities, activity });
    } catch (_error) {
      return res.status(500).json({ error: 'Customer detail query failed' });
    }
  });

  app.post('/api/customers', authMiddleware, crmHandler((req, res) => {
    return res.json(callMutation('createOrUpdateCustomer', req, customerCreateCommand(req)));
  }));

  app.post('/api/customers/:id/archive-result', authMiddleware, crmHandler((req, res) => {
    const body = plainRecord(req.body || {});
    const command = {
      customerId: positiveInteger(req.params.id),
      ...projectValues(body, ['artifact_type', 'title', 'content', 'tags', 'source_type'])
    };
    return res.json(callMutation('archiveCustomerResult', req, command));
  }));

  app.put('/api/customers/:id', authMiddleware, crmHandler((req, res) => {
    return res.json(callMutation('createOrUpdateCustomer', req, customerUpdateCommand(req)));
  }));

  app.delete('/api/customers/:id', authMiddleware, (req, res) => {
    return sendProblem(res, req, new CrmHttpError('CRM_HARD_DELETE_UNAVAILABLE', 409));
  });

  app.post('/api/customers/:id/assign', authMiddleware, crmHandler((req, res) => {
    const body = plainRecord(req.body || {});
    const action = ownValue(body, 'action');
    if (action.present && action.value === 'claim') {
      const requestedTeam = ownValue(body, 'team_id');
      return res.json(callMutation('mutateCustomerCustody', req, {
        action: 'claim',
        customerId: positiveInteger(req.params.id),
        team_id: selectedTeamId(req, requestedTeam.present ? requestedTeam.value : undefined)
      }));
    }
    if (action.present && action.value !== 'transfer') throw invalidHttp();
    const assignedTo = ownValue(body, 'assigned_to');
    const legacyUserId = ownValue(body, 'user_id');
    if (assignedTo.present && legacyUserId.present) throw invalidHttp();
    const ownerValue = assignedTo.present ? assignedTo.value : legacyUserId.value;
    const requestedTeam = ownValue(body, 'team_id');
    const command = {
      action: 'transfer',
      customerId: positiveInteger(req.params.id),
      assigned_to: positiveInteger(ownerValue),
      team_id: selectedTeamId(req, requestedTeam.present ? requestedTeam.value : undefined)
    };
    const reason = ownValue(body, 'reason_code');
    if (reason.present) command.reason_code = reason.value;
    return res.json(callMutation('mutateCustomerCustody', req, command));
  }));

  app.post('/api/customers/:id/return-pool', authMiddleware, crmHandler((req, res) => {
    return res.json(callMutation('mutateCustomerCustody', req, releaseCommand(req)));
  }));

  app.post('/api/customers/:id/return', authMiddleware, crmHandler((req, res) => {
    return res.json(callMutation('mutateCustomerCustody', req, releaseCommand(req)));
  }));

  app.get('/api/opportunities', authMiddleware, crmHandler((req, res) => {
    const result = callQuery('listOpportunities', req, readCanonicalFilter(req.query, 'opportunity'));
    const rows = result.items.map((item) => ({ ...item, brand_name: item.customer_brand_name }));
    return res.json({ ...result, opportunities: rows, rows });
  }));

  app.post('/api/opportunities', authMiddleware, crmHandler((req, res) => {
    return res.json(callMutation('createOrUpdateOpportunity', req, opportunityCreateCommand(req)));
  }));

  app.put('/api/opportunities/:id', authMiddleware, crmHandler((req, res) => {
    return res.json(callMutation('createOrUpdateOpportunity', req, opportunityUpdateCommand(req)));
  }));

  app.delete('/api/opportunities/:id', authMiddleware, (req, res) => {
    return sendProblem(res, req, new CrmHttpError('CRM_HARD_DELETE_UNAVAILABLE', 409));
  });

  function unavailableSalesScope(req, res) {
    return sendProblem(res, req, new CrmHttpError('CRM_SALES_SCOPE_UNAVAILABLE', 409));
  }

  app.get('/api/sales-targets', authMiddleware, unavailableSalesScope);
  app.post('/api/sales-targets', authMiddleware, unavailableSalesScope);
  app.get('/api/sales-performance', authMiddleware, unavailableSalesScope);

  app.get('/api/customers/sea-pool', authMiddleware, crmHandler((req, res) => {
    const filter = readCanonicalFilter(req.query, 'customer');
    if (Object.prototype.hasOwnProperty.call(filter, 'scope') && filter.scope !== 'public_pool') {
      throw invalidHttp();
    }
    filter.scope = 'public_pool';
    const result = callQuery('listCustomers', req, filter);
    return res.json({ ...result, customers: result.items });
  }));

  app.post('/api/customers/:id/claim', authMiddleware, crmHandler((req, res) => {
    const body = plainRecord(req.body || {});
    const requestedTeam = ownValue(body, 'team_id');
    const command = {
      action: 'claim',
      customerId: positiveInteger(req.params.id),
      team_id: selectedTeamId(req, requestedTeam.present ? requestedTeam.value : undefined)
    };
    return res.json(callMutation('mutateCustomerCustody', req, command));
  }));

  app.get('/api/customers/dashboard', authMiddleware, crmHandler((req, res) => {
    const result = callQuery('getCrmDashboard', req, readCanonicalFilter(req.query, 'customer'));
    return res.json({ ...result, stages: STAGE_LABELS });
  }));

  function legacyDashboardAlias(req, res) {
    const result = callQuery('getCrmDashboard', req, readCanonicalFilter(req.query, 'customer'));
    return res.json(result);
  }

  app.get('/api/dashboard/sales', authMiddleware, crmHandler(legacyDashboardAlias));
  app.get('/api/dashboard/stats', authMiddleware, crmHandler(legacyDashboardAlias));

  app.post('/api/customers/:customerId/contacts', authMiddleware, crmHandler((req, res) => {
    const body = plainRecord(req.body || {});
    const command = {
      action: 'create',
      customerId: positiveInteger(req.params.customerId),
      values: projectValues(body, CONTACT_VALUE_FIELDS)
    };
    return res.json(callMutation('mutateCustomerContact', req, command));
  }));

  app.put('/api/customers/:customerId/contacts/:contactId', authMiddleware, crmHandler((req, res) => {
    const body = plainRecord(req.body || {});
    const command = {
      action: 'update',
      customerId: positiveInteger(req.params.customerId),
      contactId: positiveInteger(req.params.contactId),
      values: projectValues(body, CONTACT_VALUE_FIELDS)
    };
    return res.json(callMutation('mutateCustomerContact', req, command));
  }));

  app.post('/api/customers/:customerId/contacts/:contactId/archive', authMiddleware, crmHandler((req, res) => {
    const command = {
      action: 'archive',
      customerId: positiveInteger(req.params.customerId),
      contactId: positiveInteger(req.params.contactId)
    };
    return res.json(callMutation('mutateCustomerContact', req, command));
  }));

  app.post('/api/customers/:customerId/tasks', authMiddleware, crmHandler((req, res) => {
    const body = plainRecord(req.body || {});
    const command = {
      action: 'create',
      customerId: positiveInteger(req.params.customerId),
      values: projectValues(body, TASK_VALUE_FIELDS, { due_at: compatibleTimestamp })
    };
    return res.json(callMutation('mutateCrmTask', req, command));
  }));

  function taskCloseCommand(req, action) {
    const body = plainRecord(req.body || {});
    const values = projectValues(body, ['completion_note']);
    const command = {
      action,
      customerId: positiveInteger(req.params.customerId),
      taskId: positiveInteger(req.params.taskId)
    };
    if (Object.keys(values).length) command.values = values;
    return command;
  }

  app.post('/api/customers/:customerId/tasks/:taskId/complete', authMiddleware, crmHandler((req, res) => {
    return res.json(callMutation('mutateCrmTask', req, taskCloseCommand(req, 'complete')));
  }));

  app.post('/api/customers/:customerId/tasks/:taskId/cancel', authMiddleware, crmHandler((req, res) => {
    return res.json(callMutation('mutateCrmTask', req, taskCloseCommand(req, 'cancel')));
  }));

  app.post('/api/customers/:id/activity', authMiddleware, crmHandler((req, res) => {
    const body = plainRecord(req.body || {});
    const command = {
      customerId: positiveInteger(req.params.id),
      ...projectValues(body, ['action', 'reference_type'])
    };
    const reference = ownValue(body, 'reference_id');
    if (reference.present) command.reference_id = positiveInteger(reference.value);
    return res.json(callMutation('recordCustomerActivity', req, command));
  }));
};
