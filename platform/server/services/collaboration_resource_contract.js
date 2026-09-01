'use strict';

const COLLABORATION_ORDER_SCHEMA = 'turingmarket.collaboration-order.v1';
const ORDER_TYPES = new Set(['paid', 'affiliate', 'gifting', 'retainer']);
const CORE_RESOURCE_FIELDS = new Set([
  'schema',
  'project_name',
  'product_name',
  'order_type',
  'order_reference',
  'deliverable',
  'quoted_price'
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

function isV1CollaborationResourceInput(value) {
  return isPlainObject(value) && typeof value.schema === 'string' &&
    value.schema.trim() === COLLABORATION_ORDER_SCHEMA;
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

function normalizeExtensions(input) {
  const extensionsInput = input.extensions === undefined ? {} : input.extensions;
  if (!isPlainObject(extensionsInput)) {
    throw contractError('INVALID_RESOURCE_FIELD', 'resource.extensions must be an object.', { field: 'extensions' });
  }
  const entries = Object.entries(extensionsInput);
  Object.keys(input).forEach((field) => {
    if (!CORE_RESOURCE_FIELDS.has(field) && field !== 'price' && field !== 'extensions') {
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

function normalizeCollaborationResource(input) {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) {
    throw contractError('INVALID_RESOURCE_INPUT', 'resource must be an object.');
  }

  const suppliedSchema = normalizeText(input.schema, 'schema', 80);
  if (suppliedSchema !== COLLABORATION_ORDER_SCHEMA) {
    throw contractError('INVALID_RESOURCE_SCHEMA', 'resource schema is not supported.', { schema: suppliedSchema });
  }
  const orderType = normalizeText(input.order_type, 'order_type', 40) || 'paid';
  if (!ORDER_TYPES.has(orderType)) {
    throw contractError('INVALID_RESOURCE_TYPE', 'resource order_type is not supported.', { order_type: orderType });
  }
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
    schema: COLLABORATION_ORDER_SCHEMA,
    project_name: normalizeText(input.project_name, 'project_name', TEXT_LIMITS.project_name),
    product_name: normalizeText(input.product_name, 'product_name', TEXT_LIMITS.product_name),
    order_type: orderType,
    order_reference: normalizeText(input.order_reference, 'order_reference', TEXT_LIMITS.order_reference),
    deliverable: normalizeText(input.deliverable, 'deliverable', TEXT_LIMITS.deliverable),
    quoted_price: quotedPrice
  };
  const extensions = normalizeExtensions(input);
  if (Object.keys(extensions).length) resource.extensions = extensions;
  return resource;
}

function resolveResourceQuotedPrice(resource, costQuoted) {
  const topLevelQuote = normalizeAmount(costQuoted, 'cost_quoted', null);
  if (topLevelQuote !== null && topLevelQuote !== resource.quoted_price) {
    throw contractError('RESOURCE_PRICE_MISMATCH', 'cost_quoted must match resource.quoted_price.', {
      cost_quoted: topLevelQuote,
      quoted_price: resource.quoted_price
    });
  }
  return resource.quoted_price;
}

function serializeCollaborationResource(resource) {
  return JSON.stringify(resource);
}

function isCanonicalCollaborationResource(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) && parsed.schema === COLLABORATION_ORDER_SCHEMA &&
      normalizeCollaborationResource(parsed)?.schema === COLLABORATION_ORDER_SCHEMA;
  } catch (error) {
    return false;
  }
}

module.exports = {
  COLLABORATION_ORDER_SCHEMA,
  CollaborationResourceContractError,
  isV1CollaborationResourceInput,
  normalizeCollaborationResource,
  resolveResourceQuotedPrice,
  serializeCollaborationResource,
  isCanonicalCollaborationResource
};
