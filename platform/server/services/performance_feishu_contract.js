'use strict';

const { types: utilTypes } = require('node:util');

const DELIVERY_CONTEXT_FIELD = '__turingmarket_feishu_performance_context';
const TARGET_KINDS = Object.freeze(['current_state', 'daily_snapshot']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class PerformanceFeishuContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PerformanceFeishuContractError';
    this.code = code;
    this.statusCode = 422;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function positiveInteger(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value) return parsed;
  }
  return null;
}

function normalizedContext(context) {
  if (!plainObject(context) ||
      context.schema_version !== 1 ||
      positiveInteger(context.configuration_id) === null ||
      positiveInteger(context.configuration_version) === null ||
      !TARGET_KINDS.includes(context.target_kind)) {
    throw new PerformanceFeishuContractError(
      'PERFORMANCE_FEISHU_DELIVERY_CONTEXT_INVALID',
      'The performance Feishu delivery context is invalid.'
    );
  }
  return {
    schema_version: 1,
    configuration_id: positiveInteger(context.configuration_id),
    configuration_version: positiveInteger(context.configuration_version),
    target_kind: context.target_kind
  };
}

function decorateRecords(records, context) {
  if (!Array.isArray(records) || records.length < 1) {
    throw new PerformanceFeishuContractError(
      'PERFORMANCE_FEISHU_RECORDS_INVALID',
      'Performance Feishu delivery records are invalid.'
    );
  }
  const normalized = normalizedContext(context);
  const serialized = JSON.stringify(normalized);
  return records.map((record) => {
    if (!plainObject(record) || !plainObject(record.fields)) {
      throw new PerformanceFeishuContractError(
        'PERFORMANCE_FEISHU_RECORDS_INVALID',
        'Performance Feishu delivery records are invalid.'
      );
    }
    if (Object.hasOwn(record.fields, DELIVERY_CONTEXT_FIELD)) {
      throw new PerformanceFeishuContractError(
        'PERFORMANCE_FEISHU_RECORDS_INVALID',
        'Performance Feishu delivery records contain a reserved field.'
      );
    }
    return { fields: { ...record.fields, [DELIVERY_CONTEXT_FIELD]: serialized } };
  });
}

function readContext(records) {
  if (!Array.isArray(records) || records.length < 1) {
    throw new PerformanceFeishuContractError(
      'PERFORMANCE_FEISHU_RECORDS_INVALID',
      'Performance Feishu delivery records are invalid.'
    );
  }
  let expected = null;
  for (const record of records) {
    if (!plainObject(record) || !plainObject(record.fields) ||
        typeof record.fields[DELIVERY_CONTEXT_FIELD] !== 'string') {
      throw new PerformanceFeishuContractError(
        'PERFORMANCE_FEISHU_DELIVERY_CONTEXT_INVALID',
        'The performance Feishu delivery context is invalid.'
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(record.fields[DELIVERY_CONTEXT_FIELD]);
    } catch {
      throw new PerformanceFeishuContractError(
        'PERFORMANCE_FEISHU_DELIVERY_CONTEXT_INVALID',
        'The performance Feishu delivery context is invalid.'
      );
    }
    const current = normalizedContext(parsed);
    if (expected === null) expected = current;
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new PerformanceFeishuContractError(
        'PERFORMANCE_FEISHU_DELIVERY_CONTEXT_INVALID',
        'Performance Feishu delivery records contain mixed configuration versions.'
      );
    }
  }
  return expected;
}

function stripContext(record) {
  if (!plainObject(record) || !plainObject(record.fields)) {
    throw new PerformanceFeishuContractError(
      'PERFORMANCE_FEISHU_RECORDS_INVALID',
      'Performance Feishu delivery records are invalid.'
    );
  }
  const fields = { ...record.fields };
  delete fields[DELIVERY_CONTEXT_FIELD];
  return { fields };
}

module.exports = {
  DELIVERY_CONTEXT_FIELD,
  TARGET_KINDS,
  UUID_PATTERN,
  PerformanceFeishuContractError,
  decorateRecords,
  readContext,
  stripContext
};
