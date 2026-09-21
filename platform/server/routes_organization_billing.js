'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');
const {
  OrganizationBillingServiceError,
  createOrganizationBillingService
} = require('./services/organization_billing_service');

function requestId(request) {
  const value = request && request.requestId;
  if (
    typeof value === 'string' && value.length >= 1 && value.length <= 160 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) return value;
  return crypto.randomUUID();
}

function plainObject(value, label) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
  ) {
    throw new OrganizationBillingServiceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is invalid.`);
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new OrganizationBillingServiceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is invalid.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OrganizationBillingServiceError(400, 'ORGANIZATION_BILLING_INVALID', `${label} is invalid.`);
  }
}

function exactDataProperties(value, expected, label) {
  plainObject(value, label);
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new OrganizationBillingServiceError(
      400,
      'ORGANIZATION_BILLING_INVALID',
      `${label} must contain only ${expected.join(', ')}.`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (expected.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new OrganizationBillingServiceError(
      400,
      'ORGANIZATION_BILLING_INVALID',
      `${label} accessors are not supported.`
    );
  }
  return descriptors;
}

function exactPolicyBody(value) {
  const expected = [
    'base_fee_cents',
    'billing_enabled',
    'effective_month',
    'expected_version',
    'included_tokens',
    'overage_cents_per_million_tokens',
    'reason'
  ];
  const descriptors = exactDataProperties(value, expected, 'Request body');
  const billingEnabled = descriptors.billing_enabled.value;
  const baseFeeCents = descriptors.base_fee_cents.value;
  const includedTokens = descriptors.included_tokens.value;
  const overageRate = descriptors.overage_cents_per_million_tokens.value;
  const expectedVersion = descriptors.expected_version.value;
  if (
    typeof billingEnabled !== 'boolean' ||
    !Number.isSafeInteger(baseFeeCents) || baseFeeCents < 0 ||
    !Number.isSafeInteger(includedTokens) || includedTokens < 0 ||
    !Number.isSafeInteger(overageRate) || overageRate < 0 ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
  ) {
    throw new OrganizationBillingServiceError(400, 'ORGANIZATION_BILLING_INVALID', 'Billing policy values are invalid.');
  }
  return {
    billingEnabled,
    baseFeeCents,
    includedTokens,
    overageCentsPerMillionTokens: overageRate,
    effectiveMonth: descriptors.effective_month.value,
    expectedVersion,
    reason: descriptors.reason.value
  };
}

function exactCloseBody(value) {
  const expected = ['expected_policy_version', 'period', 'reason'];
  const descriptors = exactDataProperties(value, expected, 'Request body');
  const expectedPolicyVersion = descriptors.expected_policy_version.value;
  if (!Number.isSafeInteger(expectedPolicyVersion) || expectedPolicyVersion < 1) {
    throw new OrganizationBillingServiceError(400, 'ORGANIZATION_BILLING_INVALID', 'expected_policy_version is invalid.');
  }
  return {
    period: descriptors.period.value,
    expectedPolicyVersion,
    reason: descriptors.reason.value
  };
}

function exactMonthQuery(value) {
  plainObject(value || {}, 'Request query');
  const keys = Object.keys(value || {}).sort();
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'month')) {
    throw new OrganizationBillingServiceError(
      400,
      'ORGANIZATION_BILLING_INVALID',
      'Request query may contain only month.'
    );
  }
  if (keys.length === 0) {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'month');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new OrganizationBillingServiceError(400, 'ORGANIZATION_BILLING_INVALID', 'Request query accessors are not supported.');
  }
  return descriptor.value;
}

function sendError(response, id, error) {
  response.setHeader('Cache-Control', 'private, no-store');
  const status = Number.isSafeInteger(error && (error.statusCode || error.status))
    ? error.statusCode || error.status
    : 500;
  return response.status(status).json({
    error: error && error.message || 'Organization billing request failed.',
    code: error && error.code || 'ORGANIZATION_BILLING_REQUEST_FAILED',
    request_id: id
  });
}

function auditContext(request, id) {
  return {
    actorUserId: request.user && request.user.id,
    requestId: id,
    ipAddress: request.ip
  };
}

function registerOrganizationBillingRoutes(app, db, options = {}) {
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  if (typeof authMiddleware !== 'function' || typeof adminOnly !== 'function') {
    throw new TypeError('authMiddleware and adminOnly are required');
  }
  const service = options.service || createOrganizationBillingService(db);

  app.get('/api/organization-billing', authMiddleware, (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store');
    const id = requestId(request);
    try {
      const billing = service.currentOrganizationBilling({
        ...auditContext(request, id),
        organizationId: request.authContext && request.authContext.organization &&
          request.authContext.organization.id,
        month: exactMonthQuery(request.query),
        adminAuditGlobal: false
      });
      return response.json({ billing, request_id: id });
    } catch (error) {
      return sendError(response, id, error);
    }
  });

  app.get(
    '/api/admin/organizations/:organizationId/billing',
    authMiddleware,
    adminOnly,
    (request, response) => {
      response.setHeader('Cache-Control', 'private, no-store');
      const id = requestId(request);
      try {
        const billing = service.currentOrganizationBilling({
          ...auditContext(request, id),
          organizationId: Number(request.params.organizationId),
          month: exactMonthQuery(request.query),
          adminAuditGlobal: true
        });
        return response.json({ billing, request_id: id });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );

  app.put(
    '/api/admin/organizations/:organizationId/billing-policy',
    authMiddleware,
    adminOnly,
    (request, response) => {
      response.setHeader('Cache-Control', 'private, no-store');
      const id = requestId(request);
      try {
        const billing = service.updateOrganizationBillingPolicy({
          ...auditContext(request, id),
          organizationId: Number(request.params.organizationId),
          ...exactPolicyBody(request.body)
        });
        return response.json({ success: true, billing, request_id: id });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );

  app.post(
    '/api/admin/organizations/:organizationId/billing-statements/close',
    authMiddleware,
    adminOnly,
    (request, response) => {
      response.setHeader('Cache-Control', 'private, no-store');
      const id = requestId(request);
      try {
        const billing = service.closeOrganizationBillingStatement({
          ...auditContext(request, id),
          organizationId: Number(request.params.organizationId),
          ...exactCloseBody(request.body)
        });
        return response.json({ success: true, billing, request_id: id });
      } catch (error) {
        return sendError(response, id, error);
      }
    }
  );
}

module.exports = registerOrganizationBillingRoutes;
module.exports.exactCloseBody = exactCloseBody;
module.exports.exactMonthQuery = exactMonthQuery;
module.exports.exactPolicyBody = exactPolicyBody;
