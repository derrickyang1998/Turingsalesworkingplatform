'use strict';

const COLLABORATION_ORDER_SCHEMA = 'turingmarket.collaboration-order.v1';
const COLLABORATION_ORDER_V2_SCHEMA = 'turingmarket.collaboration-order.v2';
const ORDER_TYPES = new Set(['paid', 'affiliate', 'gifting', 'retainer']);
const PAYMENT_TERMS = new Set([
  'prepay_80_balance_20',
  'full_prepayment',
  'net_7',
  'net_30'
]);
const V1_CORE_RESOURCE_FIELDS = new Set([
  'schema',
  'project_name',
  'product_name',
  'order_type',
  'order_reference',
  'deliverable',
  'quoted_price'
]);
const V2_CORE_RESOURCE_FIELDS = new Set([
  'schema',
  'project_name',
  'product_name',
  'order_type',
  'order_reference',
  'deliverable',
  'creator_cost',
  'client_quote',
  'currency',
  'margin_amount',
  'payment_terms'
]);
const TEXT_LIMITS = Object.freeze({
  project_name: 160,
  product_name: 160,
  order_reference: 160,
  deliverable: 2000
});
const MAX_EXTENSION_FIELDS = 20;
const MAX_EXTENSION_NAME_LENGTH = 80;
const MAX_EXTENSION_TEXT_LENGTH = 500;
const UNSAFE_EXTENSION_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

class CollaborationResourceContractError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CollaborationResourceContractError';
    this.code = code;
    this.statusCode = 400;
    if (details !== undefined) this.details = details;
  }
}

function contractError(code, message, details) {
  return new CollaborationResourceContractError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeText(value, field, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw contractError('INVALID_RESOURCE_FIELD', `${field} must be a string.`, { field });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw contractError('INVALID_RESOURCE_FIELD', `${field} is too long.`, { field, max_length: maxLength });
  }
  return normalized;
}

function normalizeAmount(value, field, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  let amount = value;
  if (typeof amount === 'string') {
    const normalized = amount.trim();
    if (!/^\d+$/.test(normalized)) {
      throw contractError('INVALID_RESOURCE_PRICE', `${field} must be a non-negative whole amount.`, { field });
    }
    amount = Number(normalized);
  } else if (typeof amount !== 'number') {
    throw contractError('INVALID_RESOURCE_PRICE', `${field} must be a non-negative whole amount.`, { field });
  }
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw contractError('INVALID_RESOURCE_PRICE', `${field} must be a non-negative whole amount.`, { field });
  }
  return amount;
}

function normalizeSignedAmount(value, field) {
  let amount = value;
  if (typeof amount === 'string') {
    const normalized = amount.trim();
    if (!/^-?\d+$/.test(normalized)) {
      throw contractError('INVALID_RESOURCE_PRICE', `${field} must be a whole amount.`, { field });
    }
    amount = Number(normalized);
  } else if (typeof amount !== 'number') {
    throw contractError('INVALID_RESOURCE_PRICE', `${field} must be a whole amount.`, { field });
  }
  if (!Number.isSafeInteger(amount)) {
    throw contractError('INVALID_RESOURCE_PRICE', `${field} must be a whole amount.`, { field });
  }
  return amount;
}

function isV1CollaborationResourceInput(value) {
  return isPlainObject(value) && typeof value.schema === 'string' &&
    value.schema.trim() === COLLABORATION_ORDER_SCHEMA;
}

function isV2CollaborationResourceInput(value) {
  return isPlainObject(value) && typeof value.schema === 'string' &&
    value.schema.trim() === COLLABORATION_ORDER_V2_SCHEMA;
}

function isVersionedCollaborationResourceInput(value) {
  return isV1CollaborationResourceInput(value) || isV2CollaborationResourceInput(value);
}

function isReservedV2ProposalNotes(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) && parsed.schema === COLLABORATION_ORDER_V2_SCHEMA;
  } catch (error) {
    return false;
  }
}

function normalizeExtensionValue(value, field) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length > MAX_EXTENSION_TEXT_LENGTH) {
      throw contractError('INVALID_RESOURCE_FIELD', `${field} is too long.`, { field, max_length: MAX_EXTENSION_TEXT_LENGTH });
    }
    return normalized;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw contractError('INVALID_RESOURCE_FIELD', `${field} must be a finite scalar value.`, { field });
    }
    return value;
  }
  if (typeof value === 'boolean' || value === null) return value;
  throw contractError('INVALID_RESOURCE_FIELD', `${field} must be a scalar value.`, { field });
}

function normalizeExtensions(input, coreResourceFields, ignoredFields) {
  const extensionsInput = input.extensions === undefined ? {} : input.extensions;
  if (!isPlainObject(extensionsInput)) {
    throw contractError('INVALID_RESOURCE_FIELD', 'resource.extensions must be an object.', { field: 'extensions' });
  }
  const entries = Object.entries(extensionsInput);
  Object.keys(input).forEach((field) => {
    if (!coreResourceFields.has(field) && !ignoredFields.has(field) && field !== 'extensions') {
      entries.push([field, input[field]]);
    }
  });
  if (entries.length > MAX_EXTENSION_FIELDS) {
    throw contractError('INVALID_RESOURCE_FIELD', 'resource has too many extension fields.', { max_fields: MAX_EXTENSION_FIELDS });
  }

  const normalized = {};
  entries.forEach(([field, value]) => {
    if (typeof field !== 'string' || !field || field.length > MAX_EXTENSION_NAME_LENGTH || UNSAFE_EXTENSION_FIELDS.has(field)) {
      throw contractError('INVALID_RESOURCE_FIELD', 'resource extension field is not supported.', { field });
    }
    if (Object.hasOwn(normalized, field)) {
      throw contractError('INVALID_RESOURCE_FIELD', 'resource extension field is duplicated.', { field });
    }
    normalized[field] = normalizeExtensionValue(value, field);
  });
  return normalized;
}

function normalizeOrderFields(input, schema) {
  const orderType = normalizeText(input.order_type, 'order_type', 40) || 'paid';
  if (!ORDER_TYPES.has(orderType)) {
    throw contractError('INVALID_RESOURCE_TYPE', 'resource order_type is not supported.', { order_type: orderType });
  }
  return {
    schema,
    project_name: normalizeText(input.project_name, 'project_name', TEXT_LIMITS.project_name),
    product_name: normalizeText(input.product_name, 'product_name', TEXT_LIMITS.product_name),
    order_type: orderType,
    order_reference: normalizeText(input.order_reference, 'order_reference', TEXT_LIMITS.order_reference),
    deliverable: normalizeText(input.deliverable, 'deliverable', TEXT_LIMITS.deliverable)
  };
}

function normalizeV1CollaborationResource(input) {
  const orderFields = normalizeOrderFields(input, COLLABORATION_ORDER_SCHEMA);
  const quotedPrice = normalizeAmount(
    input.quoted_price === undefined ? input.price : input.quoted_price,
    input.quoted_price === undefined ? 'price' : 'quoted_price',
    0
  );
  if (input.quoted_price !== undefined && input.price !== undefined) {
    const legacyPrice = normalizeAmount(input.price, 'price', 0);
    if (quotedPrice !== legacyPrice) {
      throw contractError('RESOURCE_PRICE_MISMATCH', 'quoted_price must match legacy resource price.', {
        quoted_price: quotedPrice,
        price: legacyPrice
      });
    }
  }

  const resource = {
    ...orderFields,
    quoted_price: quotedPrice
  };
  const extensions = normalizeExtensions(input, V1_CORE_RESOURCE_FIELDS, new Set(['price']));
  if (Object.keys(extensions).length) resource.extensions = extensions;
  return resource;
}

function normalizeV2CollaborationResource(input) {
  const creatorCost = normalizeAmount(input.creator_cost, 'creator_cost', 0);
  const clientQuote = normalizeAmount(input.client_quote, 'client_quote', 0);
  const derivedMargin = clientQuote - creatorCost;
  if (input.margin_amount !== undefined) {
    const suppliedMargin = normalizeSignedAmount(input.margin_amount, 'margin_amount');
    if (suppliedMargin !== derivedMargin) {
      throw contractError('RESOURCE_MARGIN_MISMATCH', 'margin_amount must match client_quote minus creator_cost.', {
        margin_amount: suppliedMargin,
        derived_margin_amount: derivedMargin
      });
    }
  }
  const currency = normalizeText(input.currency, 'currency', 3) || 'CNY';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw contractError('INVALID_RESOURCE_CURRENCY', 'currency must be an uppercase three-letter code.', { currency });
  }
  const paymentTerms = normalizeText(input.payment_terms, 'payment_terms', 80) || 'prepay_80_balance_20';
  if (!PAYMENT_TERMS.has(paymentTerms)) {
    throw contractError('INVALID_RESOURCE_PAYMENT_TERMS', 'payment_terms is not supported.', { payment_terms: paymentTerms });
  }
  const resource = {
    ...normalizeOrderFields(input, COLLABORATION_ORDER_V2_SCHEMA),
    creator_cost: creatorCost,
    client_quote: clientQuote,
    currency,
    margin_amount: derivedMargin,
    payment_terms: paymentTerms
  };
  const extensions = normalizeExtensions(input, V2_CORE_RESOURCE_FIELDS, new Set(['price', 'quoted_price']));
  if (Object.keys(extensions).length) resource.extensions = extensions;
  return resource;
}

function normalizeCollaborationResource(input) {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) {
    throw contractError('INVALID_RESOURCE_INPUT', 'resource must be an object.');
  }

  const suppliedSchema = normalizeText(input.schema, 'schema', 80);
  if (suppliedSchema === COLLABORATION_ORDER_SCHEMA) return normalizeV1CollaborationResource(input);
  if (suppliedSchema === COLLABORATION_ORDER_V2_SCHEMA) return normalizeV2CollaborationResource(input);
  throw contractError('INVALID_RESOURCE_SCHEMA', 'resource schema is not supported.', { schema: suppliedSchema });
}

function resolveResourceQuotedPrice(resource, costQuoted) {
  const topLevelQuote = normalizeAmount(costQuoted, 'cost_quoted', null);
  const projectedCreatorCost = resource.schema === COLLABORATION_ORDER_V2_SCHEMA
    ? resource.creator_cost
    : resource.quoted_price;
  if (topLevelQuote !== null && topLevelQuote !== projectedCreatorCost) {
    throw contractError('RESOURCE_PRICE_MISMATCH', 'cost_quoted must match the resource creator cost.', {
      cost_quoted: topLevelQuote,
      creator_cost: projectedCreatorCost
    });
  }
  return projectedCreatorCost;
}

function serializeCollaborationResource(resource) {
  return JSON.stringify(resource);
}

function isCanonicalCollaborationResource(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value);
    return isVersionedCollaborationResourceInput(parsed) &&
      normalizeCollaborationResource(parsed)?.schema === parsed.schema;
  } catch (error) {
    return false;
  }
}

module.exports = {
  COLLABORATION_ORDER_SCHEMA,
  COLLABORATION_ORDER_V2_SCHEMA,
  CollaborationResourceContractError,
  isV1CollaborationResourceInput,
  isV2CollaborationResourceInput,
  isVersionedCollaborationResourceInput,
  isReservedV2ProposalNotes,
  normalizeCollaborationResource,
  resolveResourceQuotedPrice,
  serializeCollaborationResource,
  isCanonicalCollaborationResource
};
