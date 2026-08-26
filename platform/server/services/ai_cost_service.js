'use strict';

const POLICY_VERSION = 'deepseek-v4-usd-2026-08-13-v1';
const SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing';
const CURRENCY = 'USD';
const UNIT = 'nano_usd';

const MODEL_PRICING = Object.freeze({
  'deepseek-v4-flash': Object.freeze({
    modelVersion: 'DeepSeek-V4-Flash-0731',
    off_peak: Object.freeze({ cacheHit: 7, cacheMiss: 220, completion: 660 }),
    peak: Object.freeze({ cacheHit: 14, cacheMiss: 440, completion: 1320 })
  }),
  'deepseek-v4-pro': Object.freeze({
    modelVersion: 'DeepSeek-V4-Pro-0813',
    off_peak: Object.freeze({ cacheHit: 22, cacheMiss: 660, completion: 1980 }),
    peak: Object.freeze({ cacheHit: 44, cacheMiss: 1320, completion: 3960 })
  })
});

function safeToken(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeAdd(left, right) {
  if (left === null || right === null || left > Number.MAX_SAFE_INTEGER - right) return null;
  return left + right;
}

function pricingDate(value) {
  const date = value === undefined || value === null ? new Date() : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ratePeriod(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return 'off_peak';
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
    ? 'peak'
    : 'off_peak';
}

function unavailableSnapshot(input, reason, date, modelPricing) {
  return {
    status: 'unavailable',
    provider: String(input.provider || 'deepseek'),
    policy_version: POLICY_VERSION,
    source_url: SOURCE_URL,
    currency: CURRENCY,
    unit: UNIT,
    model: typeof input.model === 'string' && input.model ? input.model : null,
    model_version: modelPricing ? modelPricing.modelVersion : null,
    rate_period: date ? ratePeriod(date) : null,
    priced_at: date ? date.toISOString() : null,
    reason,
    total_cost_nano_usd: null
  };
}

function createDeepSeekCostSnapshot(input) {
  input = input || {};
  const date = pricingDate(input.occurredAt);
  const modelPricing = Object.hasOwn(MODEL_PRICING, input.model)
    ? MODEL_PRICING[input.model]
    : null;
  if (input.degraded === true) return unavailableSnapshot(input, 'degraded_response', date, modelPricing);
  if (input.provider && input.provider !== 'deepseek') {
    return unavailableSnapshot(input, 'unsupported_provider', date, modelPricing);
  }
  if (!modelPricing) return unavailableSnapshot(input, 'unsupported_model', date, null);
  if (!date) return unavailableSnapshot(input, 'pricing_time_invalid', null, modelPricing);

  const usage = input.usage || {};
  const promptTokens = safeToken(usage.prompt_tokens);
  const completionTokens = safeToken(usage.completion_tokens);
  const totalTokens = safeToken(usage.total_tokens);
  const cacheHitTokens = safeToken(usage.prompt_cache_hit_tokens);
  const cacheMissTokens = safeToken(usage.prompt_cache_miss_tokens);
  if (cacheHitTokens === null || cacheMissTokens === null) {
    return unavailableSnapshot(input, 'cache_usage_missing', date, modelPricing);
  }
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return unavailableSnapshot(input, 'usage_invalid', date, modelPricing);
  }
  if (
    safeAdd(cacheHitTokens, cacheMissTokens) !== promptTokens ||
    safeAdd(promptTokens, completionTokens) !== totalTokens
  ) {
    return unavailableSnapshot(input, 'usage_inconsistent', date, modelPricing);
  }

  const period = ratePeriod(date);
  const rates = modelPricing[period];
  const totalCost = BigInt(cacheHitTokens) * BigInt(rates.cacheHit)
    + BigInt(cacheMissTokens) * BigInt(rates.cacheMiss)
    + BigInt(completionTokens) * BigInt(rates.completion);
  if (totalCost > BigInt(Number.MAX_SAFE_INTEGER)) {
    return unavailableSnapshot(input, 'cost_overflow', date, modelPricing);
  }

  return {
    status: 'priced',
    provider: 'deepseek',
    policy_version: POLICY_VERSION,
    source_url: SOURCE_URL,
    currency: CURRENCY,
    unit: UNIT,
    model: input.model,
    model_version: modelPricing.modelVersion,
    rate_period: period,
    priced_at: date.toISOString(),
    token_basis: {
      prompt_cache_hit_tokens: cacheHitTokens,
      prompt_cache_miss_tokens: cacheMissTokens,
      completion_tokens: completionTokens
    },
    rates_nano_usd_per_token: {
      prompt_cache_hit: rates.cacheHit,
      prompt_cache_miss: rates.cacheMiss,
      completion: rates.completion
    },
    total_cost_nano_usd: Number(totalCost)
  };
}

function unavailableProjection(reason) {
  return {
    status: 'unavailable',
    currency: CURRENCY,
    total_cost_nano_usd: null,
    policy_version: null,
    rate_period: null,
    reason
  };
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const required = expected.slice().sort();
  return actual.length === required.length && actual.every(function(key, index) {
    return key === required[index];
  });
}

function isValidPricedSnapshot(value) {
  if (
    value.provider !== 'deepseek' ||
    value.policy_version !== POLICY_VERSION ||
    value.source_url !== SOURCE_URL ||
    value.currency !== CURRENCY ||
    value.unit !== UNIT ||
    !Object.hasOwn(MODEL_PRICING, value.model) ||
    (value.rate_period !== 'peak' && value.rate_period !== 'off_peak') ||
    typeof value.priced_at !== 'string' ||
    safeToken(value.total_cost_nano_usd) === null
  ) {
    return false;
  }
  const modelPricing = MODEL_PRICING[value.model];
  const date = pricingDate(value.priced_at);
  if (
    value.model_version !== modelPricing.modelVersion ||
    !date ||
    date.toISOString() !== value.priced_at ||
    ratePeriod(date) !== value.rate_period ||
    !hasExactKeys(value.token_basis, [
      'prompt_cache_hit_tokens',
      'prompt_cache_miss_tokens',
      'completion_tokens'
    ]) ||
    !hasExactKeys(value.rates_nano_usd_per_token, [
      'prompt_cache_hit',
      'prompt_cache_miss',
      'completion'
    ])
  ) {
    return false;
  }
  const hitTokens = safeToken(value.token_basis.prompt_cache_hit_tokens);
  const missTokens = safeToken(value.token_basis.prompt_cache_miss_tokens);
  const completionTokens = safeToken(value.token_basis.completion_tokens);
  if (hitTokens === null || missTokens === null || completionTokens === null) return false;
  const rates = modelPricing[value.rate_period];
  if (
    value.rates_nano_usd_per_token.prompt_cache_hit !== rates.cacheHit ||
    value.rates_nano_usd_per_token.prompt_cache_miss !== rates.cacheMiss ||
    value.rates_nano_usd_per_token.completion !== rates.completion
  ) {
    return false;
  }
  const expectedCost = BigInt(hitTokens) * BigInt(rates.cacheHit)
    + BigInt(missTokens) * BigInt(rates.cacheMiss)
    + BigInt(completionTokens) * BigInt(rates.completion);
  return expectedCost <= BigInt(Number.MAX_SAFE_INTEGER)
    && Number(expectedCost) === value.total_cost_nano_usd;
}

function projectDeepSeekCostSnapshot(value, options) {
  const opts = options || {};
  if (opts.metadataValid === false) return unavailableProjection('invalid_snapshot');
  if (value === undefined) return unavailableProjection('historical_snapshot_missing');
  if (value === null) return unavailableProjection('invalid_snapshot');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return unavailableProjection('invalid_snapshot');
  }
  if (value.status === 'unavailable') {
    const reason = typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 64
      ? value.reason
      : 'invalid_snapshot';
    return {
      status: 'unavailable',
      currency: CURRENCY,
      total_cost_nano_usd: null,
      policy_version: typeof value.policy_version === 'string' && value.policy_version ? value.policy_version : null,
      rate_period: value.rate_period === 'peak' || value.rate_period === 'off_peak' ? value.rate_period : null,
      reason
    };
  }
  if (value.status !== 'priced' || !isValidPricedSnapshot(value)) {
    return unavailableProjection('invalid_snapshot');
  }
  return {
    status: 'priced',
    currency: CURRENCY,
    total_cost_nano_usd: value.total_cost_nano_usd,
    policy_version: value.policy_version,
    rate_period: value.rate_period,
    reason: null
  };
}

module.exports = {
  POLICY_VERSION,
  SOURCE_URL,
  createDeepSeekCostSnapshot,
  projectDeepSeekCostSnapshot
};
