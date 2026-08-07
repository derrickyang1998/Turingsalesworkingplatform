'use strict';

const DEFINITION_VERSION = 'phase7b.1-kpi-v1';
const MINIMUM_COMPARISON_COVERAGE = 0.8;

const INTERACTION_COMPONENTS = Object.freeze([
  'likes',
  'comments',
  'saves',
  'shares'
]);

const CORE_COMPONENTS = Object.freeze(['likes', 'comments']);
const EXTENDED_COMPONENTS = INTERACTION_COMPONENTS;

const COST_BASES = Object.freeze({
  TOTAL_CAMPAIGN_COST: 'total_campaign_cost',
  PAID_MEDIA_SPEND: 'paid_media_spend'
});

const TOTAL_COST_COMPONENTS = Object.freeze([
  Object.freeze({ inputKey: 'creatorFee', signature: 'creator_fee' }),
  Object.freeze({ inputKey: 'productSampleCost', signature: 'product_sample_cost' }),
  Object.freeze({ inputKey: 'logisticsCost', signature: 'logistics_cost' }),
  Object.freeze({ inputKey: 'paidMediaSpend', signature: 'paid_media_spend' }),
  Object.freeze({ inputKey: 'platformAgencyFee', signature: 'platform_agency_fee' }),
  Object.freeze({ inputKey: 'otherCost', signature: 'approved_other_cost' })
]);

const TOTAL_COST_SIGNATURE = TOTAL_COST_COMPONENTS
  .map(function(component) { return component.signature; })
  .join('+');

const COMPARISON_SIGNATURE_FIELDS = Object.freeze([
  'metric',
  'denominatorBasis',
  'componentSignature',
  'costBasis',
  'costComponentSignature',
  'currency',
  'attributionModel',
  'attributionWindow',
  'attributionIdentity',
  'unit',
  'scale',
  'definitionVersion'
]);

const METRIC_IDENTITY_FIELDS = Object.freeze([
  'denominatorBasis',
  'componentSignature',
  'costBasis',
  'costComponentSignature',
  'currency',
  'attributionModel',
  'attributionWindow',
  'attributionIdentity'
]);

const REQUIRED_METRIC_FIELDS = Object.freeze([
  'metric',
  'value',
  'available',
  'reason',
  'numerator',
  'denominator',
  'unit',
  'scale',
  'definitionVersion',
  'denominatorBasis',
  'componentSignature',
  'costBasis',
  'costComponentSignature',
  'currency',
  'attributionModel',
  'attributionWindow',
  'attributionIdentity',
  'exactValue',
  'exactNumerator',
  'exactDenominator',
  'auditLineage',
  'currencyEvidence'
]);

const RESTRICTED_FINANCIAL_VISIBILITY = Object.freeze({
  scope: 'internal',
  classification: 'restricted_financial',
  customerSafe: false
});

const TOTAL_COST_EVIDENCE_FIELDS = Object.freeze(TOTAL_COST_COMPONENTS.map(function(component) {
  return 'commercial.costs.' + component.inputKey;
}));

const METRIC_CONTRACTS = Object.freeze({
  observed_engagement_total: Object.freeze({
    unit: 'engagements', scale: 1, denominatorBasis: null,
    componentSignatureRequired: true, costBasis: null, costComponentSignature: null,
    amountShape: true
  }),
  core_view_er: Object.freeze({
    unit: 'ratio', scale: 1, denominatorBasis: 'views',
    componentSignature: 'likes+comments', costBasis: null, costComponentSignature: null
  }),
  extended_view_er: Object.freeze({
    unit: 'ratio', scale: 1, denominatorBasis: 'views',
    componentSignature: 'likes+comments+saves+shares', costBasis: null,
    costComponentSignature: null
  }),
  impression_er: Object.freeze({
    unit: 'ratio', scale: 1, denominatorBasis: 'impressions',
    componentSignatureRequired: true, costBasis: null, costComponentSignature: null
  }),
  total_campaign_cost: Object.freeze({
    unit: 'currency', scale: 1, denominatorBasis: null, componentSignature: null,
    costBasis: COST_BASES.TOTAL_CAMPAIGN_COST,
    costComponentSignature: TOTAL_COST_SIGNATURE, currencyRequired: true, amountShape: true
  }),
  paid_media_spend: Object.freeze({
    unit: 'currency', scale: 1, denominatorBasis: null, componentSignature: null,
    costBasis: COST_BASES.PAID_MEDIA_SPEND,
    costComponentSignature: 'paid_media_spend', currencyRequired: true, amountShape: true
  }),
  cpm: Object.freeze({
    unit: 'currency_per_1000_impressions', scale: 1000,
    denominatorBasis: 'impressions', componentSignature: null,
    selectedCostBasis: true, currencyRequired: true
  }),
  cpv: Object.freeze({
    unit: 'currency_per_view', scale: 1, denominatorBasis: 'views',
    componentSignature: null, selectedCostBasis: true, currencyRequired: true
  }),
  cpe: Object.freeze({
    unit: 'currency_per_engagement', scale: 1,
    denominatorBasis: 'observed_engagement_total', componentSignatureRequired: true,
    selectedCostBasis: true, currencyRequired: true
  }),
  ctr: Object.freeze({
    unit: 'ratio', scale: 1, denominatorBasis: 'impressions',
    componentSignature: null, costBasis: null, costComponentSignature: null
  }),
  cpc: Object.freeze({
    unit: 'currency_per_click', scale: 1, denominatorBasis: 'clicks',
    componentSignature: null, selectedCostBasis: true, currencyRequired: true
  }),
  cvr: Object.freeze({
    unit: 'ratio', scale: 1, denominatorBasis: 'clicks',
    componentSignature: null, costBasis: null, costComponentSignature: null
  }),
  cpa: Object.freeze({
    unit: 'currency_per_conversion', scale: 1, denominatorBasis: 'conversions',
    componentSignature: null, selectedCostBasis: true, currencyRequired: true
  }),
  roi: Object.freeze({
    unit: 'ratio', scale: 1, denominatorBasis: COST_BASES.TOTAL_CAMPAIGN_COST,
    componentSignature: null, costBasis: COST_BASES.TOTAL_CAMPAIGN_COST,
    costComponentSignature: TOTAL_COST_SIGNATURE, currencyRequired: true,
    revenueBasis: 'approved_attributed_revenue', attributionRequired: true
  }),
  roas: Object.freeze({
    unit: 'ratio', scale: 1, denominatorBasis: COST_BASES.PAID_MEDIA_SPEND,
    componentSignature: null, costBasis: COST_BASES.PAID_MEDIA_SPEND,
    costComponentSignature: 'paid_media_spend', currencyRequired: true,
    revenueBasis: 'approved_attributed_revenue', attributionRequired: true
  }),
  gross_margin_rate: Object.freeze({
    unit: 'ratio', scale: 1, denominatorBasis: 'client_charge',
    componentSignature: null, costBasis: COST_BASES.TOTAL_CAMPAIGN_COST,
    costComponentSignature: TOTAL_COST_SIGNATURE, currencyRequired: true,
    chargeBasis: 'approved_client_charge', restrictedVisibility: true
  })
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneMetadata(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  const references = seen || new Map();
  if (references.has(value)) return references.get(value);
  if (Array.isArray(value)) {
    const arrayClone = [];
    references.set(value, arrayClone);
    value.forEach(function(item) {
      arrayClone.push(cloneMetadata(item, references));
    });
    return arrayClone;
  }
  const objectClone = {};
  references.set(value, objectClone);
  Object.keys(value).forEach(function(key) {
    objectClone[key] = cloneMetadata(value[key], references);
  });
  return objectClone;
}

function stableSerialize(value, seen) {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  const references = seen || new Set();
  if (references.has(value)) return '"[Circular]"';
  references.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = '[' + value.map(function(item) {
      return stableSerialize(item, references);
    }).join(',') + ']';
  } else {
    serialized = '{' + Object.keys(value).sort().map(function(key) {
      return JSON.stringify(key) + ':' + stableSerialize(value[key], references);
    }).join(',') + '}';
  }
  references.delete(value);
  return serialized;
}

function cloneAndDedupeMetadata(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const result = [];
  items.forEach(function(item) {
    const cloned = cloneMetadata(item);
    const identity = stableSerialize(cloned);
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(cloned);
    }
  });
  return result;
}

function powerOfTen(exponent) {
  return 10n ** BigInt(exponent);
}

function normalizeDecimal(coefficient, scale) {
  let normalizedCoefficient = coefficient;
  let normalizedScale = scale;
  if (normalizedCoefficient === 0n) return { coefficient: 0n, scale: 0 };
  while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedScale -= 1;
  }
  return { coefficient: normalizedCoefficient, scale: normalizedScale };
}

function decimalFromString(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) return null;
  const exponent = match[4] ? Number(match[4]) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const fraction = match[3] || '';
  let coefficient = BigInt((match[2] + fraction).replace(/^0+(?=\d)/, ''));
  if (match[1] === '-') coefficient = -coefficient;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= powerOfTen(-scale);
    scale = 0;
  }
  return normalizeDecimal(coefficient, scale);
}

function decimalFromNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return decimalFromString(String(value));
}

function decimalFromSafeInteger(value) {
  return { coefficient: BigInt(value), scale: 0 };
}

function decimalToString(decimal) {
  if (!decimal) return null;
  const negative = decimal.coefficient < 0n;
  const absolute = negative ? -decimal.coefficient : decimal.coefficient;
  let digits = absolute.toString();
  if (decimal.scale > 0) {
    if (digits.length <= decimal.scale) {
      digits = '0'.repeat(decimal.scale - digits.length + 1) + digits;
    }
    const split = digits.length - decimal.scale;
    digits = digits.slice(0, split) + '.' + digits.slice(split);
  }
  return (negative ? '-' : '') + digits;
}

function decimalToNumber(decimal) {
  const value = Number(decimalToString(decimal));
  return Number.isFinite(value) ? value : null;
}

function alignDecimals(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * powerOfTen(scale - left.scale),
    right: right.coefficient * powerOfTen(scale - right.scale),
    scale
  };
}

function addDecimals(left, right) {
  const aligned = alignDecimals(left, right);
  return normalizeDecimal(aligned.left + aligned.right, aligned.scale);
}

function subtractDecimals(left, right) {
  const aligned = alignDecimals(left, right);
  return normalizeDecimal(aligned.left - aligned.right, aligned.scale);
}

function multiplyDecimals(left, right) {
  return normalizeDecimal(
    left.coefficient * right.coefficient,
    left.scale + right.scale
  );
}

function absoluteBigInt(value) {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor(left, right) {
  let a = absoluteBigInt(left);
  let b = absoluteBigInt(right);
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function exactRatioString(numerator, denominator, scale) {
  const scaledNumerator = multiplyDecimals(
    numerator,
    decimalFromNumber(scale === undefined ? 1 : scale)
  );
  let fractionNumerator = scaledNumerator.coefficient * powerOfTen(denominator.scale);
  let fractionDenominator = denominator.coefficient * powerOfTen(scaledNumerator.scale);
  if (fractionDenominator < 0n) {
    fractionNumerator = -fractionNumerator;
    fractionDenominator = -fractionDenominator;
  }
  const divisor = greatestCommonDivisor(fractionNumerator, fractionDenominator);
  fractionNumerator /= divisor;
  fractionDenominator /= divisor;
  if (fractionNumerator === 0n) return '0';

  let remaining = fractionDenominator;
  let powersOfTwo = 0;
  let powersOfFive = 0;
  while (remaining % 2n === 0n) {
    remaining /= 2n;
    powersOfTwo += 1;
  }
  while (remaining % 5n === 0n) {
    remaining /= 5n;
    powersOfFive += 1;
  }
  if (remaining === 1n) {
    const decimalScale = Math.max(powersOfTwo, powersOfFive);
    const multiplier = (2n ** BigInt(decimalScale - powersOfTwo)) *
      (5n ** BigInt(decimalScale - powersOfFive));
    return decimalToString(normalizeDecimal(fractionNumerator * multiplier, decimalScale));
  }
  return fractionNumerator.toString() + '/' + fractionDenominator.toString();
}

function exactStringFromNumber(value) {
  const decimal = decimalFromNumber(value);
  return decimal ? decimalToString(decimal) : null;
}

function canonicalDecimalFromString(value) {
  const decimal = decimalFromString(value);
  return decimal && decimalToString(decimal) === value ? decimal : null;
}

function metricExactValueString(numerator, denominator, scale) {
  if (!numerator) return null;
  return exactRatioString(
    numerator,
    denominator || decimalFromSafeInteger(1),
    scale
  );
}

function metricValueFromExact(numerator, denominator, scale) {
  if (!numerator) return null;
  const numeratorValue = decimalToNumber(numerator);
  const denominatorValue = decimalToNumber(denominator || decimalFromSafeInteger(1));
  if (numeratorValue === null || denominatorValue === null || denominatorValue === 0) return null;
  const value = (numeratorValue / denominatorValue) * scale;
  return Number.isFinite(value) ? value : null;
}

function sameNumber(left, right) {
  return typeof left === 'number' && Number.isFinite(left) && Object.is(left, right);
}

function createMetricResult(metric, options) {
  const available = options.available === true;
  const definitionVersion = hasOwn(options, 'definitionVersion')
    ? options.definitionVersion
    : DEFINITION_VERSION;
  const numeratorExact = options.numeratorExact ||
    (typeof options.numerator === 'number' ? decimalFromNumber(options.numerator) : null);
  const denominatorExact = options.denominatorExact ||
    (typeof options.denominator === 'number' ? decimalFromNumber(options.denominator) : null);
  const scale = options.scale === undefined ? 1 : options.scale;
  const exactValue = available
    ? metricExactValueString(numeratorExact, denominatorExact, scale)
    : null;
  const result = {
    metric,
    value: available ? options.value : null,
    available,
    reason: available ? null : options.reason,
    numerator: options.numerator === undefined ? null : options.numerator,
    denominator: options.denominator === undefined ? null : options.denominator,
    unit: options.unit,
    scale,
    definitionVersion,
    denominatorBasis: options.denominatorBasis === undefined ? null : options.denominatorBasis,
    componentSignature: options.componentSignature === undefined ? null : options.componentSignature,
    costBasis: options.costBasis === undefined ? null : options.costBasis,
    costComponentSignature: options.costComponentSignature === undefined
      ? null
      : options.costComponentSignature,
    currency: options.currency === undefined ? null : options.currency,
    attributionModel: options.attributionModel === undefined ? null : options.attributionModel,
    attributionWindow: options.attributionWindow === undefined ? null : options.attributionWindow,
    attributionIdentity: options.attributionIdentity === undefined
      ? null
      : options.attributionIdentity,
    exactValue,
    exactNumerator: numeratorExact ? decimalToString(numeratorExact) : null,
    exactDenominator: denominatorExact ? decimalToString(denominatorExact) : null,
    auditLineage: cloneAndDedupeMetadata(options.auditLineage),
    currencyEvidence: cloneAndDedupeMetadata(options.currencyEvidence)
  };
  if (hasOwn(options, 'revenueBasis')) result.revenueBasis = options.revenueBasis;
  if (hasOwn(options, 'chargeBasis')) result.chargeBasis = options.chargeBasis;
  if (hasOwn(options, 'attributionEvidence')) {
    result.attributionEvidence = options.attributionEvidence === null
      ? null
      : cloneMetadata(options.attributionEvidence);
  }
  if (hasOwn(options, 'visibility')) result.visibility = cloneMetadata(options.visibility);
  return result;
}

function readNonNegativeNumber(source, key, field) {
  if (!isObject(source) || !hasOwn(source, key) || source[key] === null || source[key] === undefined) {
    return {
      ok: false,
      value: null,
      reason: { code: 'missing_input', field }
    };
  }
  if (!isNonNegativeFiniteNumber(source[key])) {
    return {
      ok: false,
      value: null,
      reason: { code: 'invalid_nonnegative_number', field }
    };
  }
  if (!Number.isSafeInteger(source[key])) {
    return {
      ok: false,
      value: null,
      reason: { code: 'invalid_nonnegative_safe_integer', field }
    };
  }
  return {
    ok: true,
    value: source[key],
    exact: decimalFromSafeInteger(source[key]),
    reason: null
  };
}

function normalizeComponentSignature(components) {
  if (components === undefined || components === null) {
    return {
      ok: false,
      components: [],
      signature: null,
      reason: { code: 'missing_component_signature' }
    };
  }
  if (!Array.isArray(components) || components.length === 0) {
    return {
      ok: false,
      components: [],
      signature: null,
      reason: { code: 'invalid_component_signature' }
    };
  }

  const declared = new Set();
  for (const component of components) {
    if (typeof component !== 'string' || !INTERACTION_COMPONENTS.includes(component) || declared.has(component)) {
      return {
        ok: false,
        components: [],
        signature: null,
        reason: { code: 'invalid_component_signature' }
      };
    }
    declared.add(component);
  }

  const normalized = INTERACTION_COMPONENTS.filter(function(component) {
    return declared.has(component);
  });
  return {
    ok: true,
    components: normalized,
    signature: normalized.join('+'),
    reason: null
  };
}

function componentTotalState(observations, components) {
  const signatureState = normalizeComponentSignature(components);
  if (!signatureState.ok) return signatureState;

  let totalExact = decimalFromSafeInteger(0);
  for (const component of signatureState.components) {
    const state = readNonNegativeNumber(
      observations,
      component,
      'observations.' + component
    );
    if (!state.ok) {
      return {
        ok: false,
        value: null,
        components: signatureState.components,
        signature: signatureState.signature,
        reason: state.reason
      };
    }
    totalExact = addDecimals(totalExact, state.exact);
    const total = decimalToNumber(totalExact);
    if (total === null) {
      return {
        ok: false,
        value: null,
        components: signatureState.components,
        signature: signatureState.signature,
        reason: { code: 'numeric_overflow', field: 'observed_engagement_total' }
      };
    }
  }

  return {
    ok: true,
    value: decimalToNumber(totalExact),
    exact: totalExact,
    components: signatureState.components,
    signature: signatureState.signature,
    reason: null
  };
}

function observedEngagementMetric(observations, engagementComponents) {
  const total = componentTotalState(observations, engagementComponents);
  return createMetricResult('observed_engagement_total', {
    available: total.ok,
    value: total.value,
    reason: total.reason,
    numerator: total.ok ? total.value : null,
    numeratorExact: total.ok ? total.exact : null,
    denominator: null,
    unit: 'engagements',
    componentSignature: total.signature
  });
}

function ratioMetric(options) {
  const metadata = options.metadata || {};
  const numerator = options.numerator;
  const denominator = options.denominator;

  if (!numerator.ok) {
    return createMetricResult(options.metric, Object.assign({
      available: false,
      reason: numerator.reason,
      numerator: null,
      denominator: denominator.ok ? denominator.value : null,
      denominatorExact: denominator.ok ? denominator.exact : null,
      unit: options.unit
    }, metadata));
  }
  if (!denominator.ok) {
    return createMetricResult(options.metric, Object.assign({
      available: false,
      reason: denominator.reason,
      numerator: numerator.value,
      numeratorExact: numerator.exact,
      denominator: null,
      unit: options.unit
    }, metadata));
  }
  if (denominator.value <= 0) {
    return createMetricResult(options.metric, Object.assign({
      available: false,
      reason: {
        code: 'non_positive_denominator',
        field: options.denominatorField
      },
      numerator: numerator.value,
      denominator: denominator.value,
      numeratorExact: numerator.exact,
      denominatorExact: denominator.exact,
      unit: options.unit
    }, metadata));
  }

  const scale = options.scale === undefined ? 1 : options.scale;
  const value = (decimalToNumber(numerator.exact) / decimalToNumber(denominator.exact)) * scale;
  if (!Number.isFinite(value)) {
    return createMetricResult(options.metric, Object.assign({
      available: false,
      reason: { code: 'numeric_overflow', field: options.metric },
      numerator: numerator.value,
      denominator: denominator.value,
      numeratorExact: numerator.exact,
      denominatorExact: denominator.exact,
      unit: options.unit
    }, metadata));
  }

  return createMetricResult(options.metric, Object.assign({
    available: true,
    value,
    reason: null,
    numerator: numerator.value,
    denominator: denominator.value,
    numeratorExact: numerator.exact,
    denominatorExact: denominator.exact,
    unit: options.unit,
    scale
  }, metadata));
}

function interactionRateMetric(metric, observations, components, denominatorKey) {
  const numerator = componentTotalState(observations, components);
  const denominator = readNonNegativeNumber(
    observations,
    denominatorKey,
    'observations.' + denominatorKey
  );
  return ratioMetric({
    metric,
    numerator,
    denominator,
    denominatorField: 'observations.' + denominatorKey,
    unit: 'ratio',
    metadata: {
      denominatorBasis: denominatorKey,
      componentSignature: numerator.signature
    }
  });
}

function baseCurrencyState(commercial) {
  if (!isObject(commercial) || !hasOwn(commercial, 'baseCurrency')) {
    return {
      ok: false,
      value: null,
      reason: { code: 'missing_base_currency', field: 'commercial.baseCurrency' }
    };
  }
  if (typeof commercial.baseCurrency !== 'string' || !/^[A-Z]{3}$/.test(commercial.baseCurrency)) {
    return {
      ok: false,
      value: null,
      reason: { code: 'invalid_currency', field: 'commercial.baseCurrency' }
    };
  }
  return { ok: true, value: commercial.baseCurrency, reason: null };
}

function moneyAmountState(entry, field) {
  if (!isObject(entry)) {
    return {
      ok: false,
      value: null,
      reason: { code: 'missing_money', field }
    };
  }
  if (entry.approvalState !== 'approved') {
    return {
      ok: false,
      value: null,
      reason: { code: 'unapproved_money', field }
    };
  }
  if (!hasOwn(entry, 'amount') || !isNonNegativeFiniteNumber(entry.amount)) {
    return {
      ok: false,
      value: null,
      reason: { code: 'invalid_nonnegative_number', field: field + '.amount' }
    };
  }
  if (typeof entry.currency !== 'string' || !/^[A-Z]{3}$/.test(entry.currency)) {
    return {
      ok: false,
      value: null,
      reason: { code: 'invalid_currency', field: field + '.currency' }
    };
  }
  return {
    ok: true,
    value: entry.amount,
    exact: decimalFromNumber(entry.amount),
    currency: entry.currency,
    reason: null
  };
}

function isCanonicalIsoTimestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  const canonical = new Date(epoch).toISOString();
  return value.includes('.')
    ? canonical === value
    : canonical.replace('.000Z', 'Z') === value;
}

function validateApprovalProvenance(value, fieldPrefix) {
  for (const field of ['approvalId', 'approvedBy', 'policyVersion']) {
    if (!isNonEmptyString(value[field])) {
      return {
        ok: false,
        reason: {
          code: 'missing_approval_provenance',
          field: fieldPrefix + '.' + field
        }
      };
    }
  }
  if (!isCanonicalIsoTimestamp(value.approvedAt)) {
    return {
      ok: false,
      reason: {
        code: 'invalid_canonical_timestamp',
        field: fieldPrefix + '.approvedAt'
      }
    };
  }
  return {
    ok: true,
    reason: null,
    approval: {
      approvalId: value.approvalId,
      approvedBy: value.approvedBy,
      approvedAt: value.approvedAt,
      policyVersion: value.policyVersion
    }
  };
}

function validateFxEvidence(fxEvidence, field, fromCurrency, toCurrency) {
  const missingReason = {
    code: 'missing_fx_evidence',
    field,
    fromCurrency,
    toCurrency
  };
  if (!isObject(fxEvidence)) {
    return { ok: false, reason: missingReason };
  }
  if (fxEvidence.approvalState !== 'approved') {
    return {
      ok: false,
      reason: {
        code: 'unapproved_fx_evidence',
        field,
        fromCurrency,
        toCurrency
      }
    };
  }
  const rateExact = decimalFromNumber(fxEvidence.rate);
  if (
    fxEvidence.fromCurrency !== fromCurrency ||
    fxEvidence.toCurrency !== toCurrency ||
    !isPositiveFiniteNumber(fxEvidence.rate) ||
    !rateExact ||
    !isNonEmptyString(fxEvidence.source)
  ) {
    return {
      ok: false,
      reason: {
        code: 'invalid_fx_evidence',
        field,
        fromCurrency,
        toCurrency
      }
    };
  }
  const evidencePrefix = field + '.fxEvidence';
  if (!isCanonicalIsoTimestamp(fxEvidence.effectiveAt)) {
    return {
      ok: false,
      reason: {
        code: 'invalid_canonical_timestamp',
        field: evidencePrefix + '.effectiveAt'
      }
    };
  }
  const approval = validateApprovalProvenance(fxEvidence, evidencePrefix);
  if (!approval.ok) return approval;
  return {
    ok: true,
    reason: null,
    rateExact,
    evidence: {
      field,
      fromCurrency,
      toCurrency,
      rate: fxEvidence.rate,
      exactRate: decimalToString(rateExact),
      source: fxEvidence.source,
      effectiveAt: fxEvidence.effectiveAt,
      approvalState: 'approved',
      approvalId: approval.approval.approvalId,
      approvedBy: approval.approval.approvedBy,
      approvedAt: approval.approval.approvedAt,
      policyVersion: approval.approval.policyVersion
    }
  };
}

function normalizeMoney(entry, field, baseCurrency) {
  const amount = moneyAmountState(entry, field);
  if (!amount.ok) return amount;

  if (amount.currency === baseCurrency) {
    return {
      ok: true,
      value: amount.value,
      exact: amount.exact,
      currency: baseCurrency,
      evidence: null,
      reason: null
    };
  }

  const fx = validateFxEvidence(
    entry.fxEvidence,
    field,
    amount.currency,
    baseCurrency
  );
  if (!fx.ok) {
    return {
      ok: false,
      value: null,
      currency: baseCurrency,
      evidence: null,
      reason: fx.reason
    };
  }

  const convertedExact = multiplyDecimals(amount.exact, fx.rateExact);
  const converted = decimalToNumber(convertedExact);
  if (converted === null || converted < 0) {
    return {
      ok: false,
      value: null,
      currency: baseCurrency,
      evidence: fx.evidence,
      reason: { code: 'numeric_overflow', field }
    };
  }
  return {
    ok: true,
    value: converted,
    exact: convertedExact,
    currency: baseCurrency,
    evidence: fx.evidence,
    reason: null
  };
}

function unavailableCostState(reason, costBasis, componentSignature, currency, evidence) {
  return {
    ok: false,
    value: null,
    exact: null,
    reason,
    costBasis,
    componentSignature,
    currency: currency || null,
    evidence: evidence || []
  };
}

function totalCampaignCostState(commercial, currencyState) {
  if (!currencyState.ok) {
    return unavailableCostState(
      currencyState.reason,
      COST_BASES.TOTAL_CAMPAIGN_COST,
      TOTAL_COST_SIGNATURE,
      null,
      []
    );
  }

  const costs = isObject(commercial) && isObject(commercial.costs)
    ? commercial.costs
    : {};
  const evidence = [];
  let totalExact = decimalFromSafeInteger(0);

  for (const component of TOTAL_COST_COMPONENTS) {
    const field = 'commercial.costs.' + component.inputKey;
    const normalized = normalizeMoney(costs[component.inputKey], field, currencyState.value);
    if (!normalized.ok) {
      return unavailableCostState(
        normalized.reason,
        COST_BASES.TOTAL_CAMPAIGN_COST,
        TOTAL_COST_SIGNATURE,
        currencyState.value,
        evidence
      );
    }
    totalExact = addDecimals(totalExact, normalized.exact);
    if (decimalToNumber(totalExact) === null) {
      return unavailableCostState(
        { code: 'numeric_overflow', field: 'total_campaign_cost' },
        COST_BASES.TOTAL_CAMPAIGN_COST,
        TOTAL_COST_SIGNATURE,
        currencyState.value,
        evidence
      );
    }
    if (normalized.evidence) evidence.push(normalized.evidence);
  }

  return {
    ok: true,
    value: decimalToNumber(totalExact),
    exact: totalExact,
    reason: null,
    costBasis: COST_BASES.TOTAL_CAMPAIGN_COST,
    componentSignature: TOTAL_COST_SIGNATURE,
    currency: currencyState.value,
    evidence
  };
}

function paidMediaSpendState(commercial, currencyState) {
  if (!currencyState.ok) {
    return unavailableCostState(
      currencyState.reason,
      COST_BASES.PAID_MEDIA_SPEND,
      'paid_media_spend',
      null,
      []
    );
  }
  const entry = isObject(commercial) && isObject(commercial.costs)
    ? commercial.costs.paidMediaSpend
    : undefined;
  const normalized = normalizeMoney(
    entry,
    'commercial.costs.paidMediaSpend',
    currencyState.value
  );
  if (!normalized.ok) {
    return unavailableCostState(
      normalized.reason,
      COST_BASES.PAID_MEDIA_SPEND,
      'paid_media_spend',
      currencyState.value,
      []
    );
  }
  return {
    ok: true,
    value: normalized.value,
    exact: normalized.exact,
    reason: null,
    costBasis: COST_BASES.PAID_MEDIA_SPEND,
    componentSignature: 'paid_media_spend',
    currency: currencyState.value,
    evidence: normalized.evidence ? [normalized.evidence] : []
  };
}

function costMetric(metric, state) {
  return createMetricResult(metric, {
    available: state.ok,
    value: state.value,
    reason: state.reason,
    numerator: state.ok ? state.value : null,
    numeratorExact: state.ok ? state.exact : null,
    denominator: null,
    unit: 'currency',
    costBasis: state.costBasis,
    costComponentSignature: state.componentSignature,
    currency: state.currency,
    currencyEvidence: state.evidence
  });
}

function selectedCostState(costBasis, totalCost, paidMediaSpend) {
  if (costBasis === undefined || costBasis === null) {
    return totalCost;
  }
  if (costBasis === COST_BASES.TOTAL_CAMPAIGN_COST) return totalCost;
  if (costBasis === COST_BASES.PAID_MEDIA_SPEND) return paidMediaSpend;
  return unavailableCostState(
    { code: 'invalid_cost_basis', field: 'costBasis' },
    null,
    null,
    null,
    []
  );
}

function costRatioMetric(options) {
  const cost = options.cost;
  const metadata = {
    denominatorBasis: options.denominatorBasis,
    costBasis: cost.costBasis,
    costComponentSignature: cost.componentSignature,
    currency: cost.currency,
    currencyEvidence: cost.evidence
  };
  if (options.componentSignature !== undefined) {
    metadata.componentSignature = options.componentSignature;
  }
  if (options.scale !== undefined) metadata.scale = options.scale;

  return ratioMetric({
    metric: options.metric,
    numerator: cost,
    denominator: options.denominator,
    denominatorField: options.denominatorField,
    unit: options.unit,
    scale: options.scale,
    metadata
  });
}

function attributionState(commercial) {
  const attribution = isObject(commercial) ? commercial.attribution : null;
  if (!isObject(attribution)) {
    return {
      ok: false,
      model: null,
      window: null,
      identity: null,
      evidence: null,
      reason: { code: 'missing_attribution', field: 'commercial.attribution' }
    };
  }
  if (!isNonEmptyString(attribution.model)) {
    return {
      ok: false,
      model: null,
      window: isNonEmptyString(attribution.window) ? attribution.window : null,
      identity: null,
      evidence: null,
      reason: {
        code: 'missing_attribution_model',
        field: 'commercial.attribution.model'
      }
    };
  }
  if (!isNonEmptyString(attribution.window)) {
    return {
      ok: false,
      model: attribution.model,
      window: null,
      identity: null,
      evidence: null,
      reason: {
        code: 'missing_attribution_window',
        field: 'commercial.attribution.window'
      }
    };
  }
  if (attribution.approvalState !== 'approved') {
    return {
      ok: false,
      model: attribution.model,
      window: attribution.window,
      identity: null,
      evidence: null,
      reason: {
        code: 'unapproved_attribution',
        field: 'commercial.attribution'
      }
    };
  }
  const approval = validateApprovalProvenance(attribution, 'commercial.attribution');
  if (!approval.ok) {
    return {
      ok: false,
      model: attribution.model,
      window: attribution.window,
      identity: null,
      evidence: null,
      reason: approval.reason
    };
  }
  const identity = [
    attribution.model,
    attribution.window,
    approval.approval.policyVersion
  ].join('|');
  return {
    ok: true,
    model: attribution.model,
    window: attribution.window,
    identity,
    evidence: {
      model: attribution.model,
      window: attribution.window,
      approvalState: 'approved',
      approvalId: approval.approval.approvalId,
      approvedBy: approval.approval.approvedBy,
      approvedAt: approval.approval.approvedAt,
      policyVersion: approval.approval.policyVersion
    },
    reason: null
  };
}

function commercialMoneyState(commercial, key, currencyState) {
  const field = 'commercial.' + key;
  if (!currencyState.ok) {
    return {
      ok: false,
      value: null,
      exact: null,
      currency: null,
      evidence: [],
      reason: currencyState.reason
    };
  }
  const entry = isObject(commercial) ? commercial[key] : undefined;
  const normalized = normalizeMoney(entry, field, currencyState.value);
  return {
    ok: normalized.ok,
    value: normalized.value,
    exact: normalized.exact || null,
    currency: normalized.currency || currencyState.value,
    evidence: normalized.evidence ? [normalized.evidence] : [],
    reason: normalized.reason
  };
}

function outcomeMetric(options) {
  const revenue = options.revenue;
  const cost = options.cost;
  const attribution = options.attribution;
  const metadata = {
    denominatorBasis: cost.costBasis,
    costBasis: cost.costBasis,
    costComponentSignature: cost.componentSignature,
    currency: cost.currency || revenue.currency,
    currencyEvidence: (cost.evidence || []).concat(revenue.evidence || []),
    revenueBasis: 'approved_attributed_revenue',
    attributionModel: attribution.model,
    attributionWindow: attribution.window,
    attributionIdentity: attribution.identity,
    attributionEvidence: attribution.evidence
  };

  if (!revenue.ok) {
    return createMetricResult(options.metric, Object.assign({
      available: false,
      reason: revenue.reason,
      numerator: null,
      denominator: cost.ok ? cost.value : null,
      denominatorExact: cost.ok ? cost.exact : null,
      unit: 'ratio'
    }, metadata));
  }
  if (!attribution.ok) {
    return createMetricResult(options.metric, Object.assign({
      available: false,
      reason: attribution.reason,
      numerator: null,
      denominator: cost.ok ? cost.value : null,
      denominatorExact: cost.ok ? cost.exact : null,
      unit: 'ratio'
    }, metadata));
  }
  if (!cost.ok) {
    return createMetricResult(options.metric, Object.assign({
      available: false,
      reason: cost.reason,
      numerator: null,
      denominator: null,
      unit: 'ratio'
    }, metadata));
  }
  const numeratorExact = options.metric === 'roi'
    ? subtractDecimals(revenue.exact, cost.exact)
    : revenue.exact;
  const numerator = decimalToNumber(numeratorExact);
  if (numerator === null) {
    return createMetricResult(options.metric, Object.assign({
      available: false,
      reason: { code: 'numeric_overflow', field: options.metric },
      numerator: null,
      denominator: cost.value,
      denominatorExact: cost.exact,
      unit: 'ratio'
    }, metadata));
  }
  return ratioMetric({
    metric: options.metric,
    numerator: { ok: true, value: numerator, exact: numeratorExact, reason: null },
    denominator: cost,
    denominatorField: cost.costBasis,
    unit: 'ratio',
    metadata
  });
}

function grossMarginMetric(clientCharge, totalCost) {
  const metadata = {
    denominatorBasis: 'client_charge',
    costBasis: totalCost.costBasis,
    costComponentSignature: totalCost.componentSignature,
    currency: totalCost.currency || clientCharge.currency,
    currencyEvidence: (totalCost.evidence || []).concat(clientCharge.evidence || []),
    chargeBasis: 'approved_client_charge',
    visibility: RESTRICTED_FINANCIAL_VISIBILITY
  };

  if (!clientCharge.ok) {
    return createMetricResult('gross_margin_rate', Object.assign({
      available: false,
      reason: clientCharge.reason,
      numerator: null,
      denominator: null,
      unit: 'ratio'
    }, metadata));
  }
  if (!totalCost.ok) {
    return createMetricResult('gross_margin_rate', Object.assign({
      available: false,
      reason: totalCost.reason,
      numerator: null,
      denominator: clientCharge.value,
      denominatorExact: clientCharge.exact,
      unit: 'ratio'
    }, metadata));
  }
  const numeratorExact = subtractDecimals(clientCharge.exact, totalCost.exact);
  const numerator = decimalToNumber(numeratorExact);
  if (numerator === null) {
    return createMetricResult('gross_margin_rate', Object.assign({
      available: false,
      reason: { code: 'numeric_overflow', field: 'gross_margin_rate' },
      numerator: null,
      denominator: clientCharge.value,
      denominatorExact: clientCharge.exact,
      unit: 'ratio'
    }, metadata));
  }
  return ratioMetric({
    metric: 'gross_margin_rate',
    numerator: { ok: true, value: numerator, exact: numeratorExact, reason: null },
    denominator: clientCharge,
    denominatorField: 'client_charge',
    unit: 'ratio',
    metadata
  });
}

function calculatePerformanceMetrics(input) {
  const source = isObject(input) ? input : {};
  const observations = isObject(source.observations) ? source.observations : {};
  const commercial = isObject(source.commercial) ? source.commercial : {};

  const observedState = componentTotalState(observations, source.engagementComponents);
  const observedEngagement = createMetricResult('observed_engagement_total', {
    available: observedState.ok,
    value: observedState.value,
    reason: observedState.reason,
    numerator: observedState.ok ? observedState.value : null,
    numeratorExact: observedState.ok ? observedState.exact : null,
    denominator: null,
    unit: 'engagements',
    componentSignature: observedState.signature
  });
  const coreViewEr = interactionRateMetric(
    'core_view_er',
    observations,
    CORE_COMPONENTS,
    'views'
  );
  const extendedViewEr = interactionRateMetric(
    'extended_view_er',
    observations,
    EXTENDED_COMPONENTS,
    'views'
  );
  const impressionEr = interactionRateMetric(
    'impression_er',
    observations,
    source.engagementComponents,
    'impressions'
  );

  const currency = baseCurrencyState(commercial);
  const totalCostState = totalCampaignCostState(commercial, currency);
  const paidMediaState = paidMediaSpendState(commercial, currency);
  const selectedCost = selectedCostState(source.costBasis, totalCostState, paidMediaState);
  const totalCampaignCost = costMetric('total_campaign_cost', totalCostState);
  const paidMediaSpend = costMetric('paid_media_spend', paidMediaState);

  const views = readNonNegativeNumber(observations, 'views', 'observations.views');
  const impressions = readNonNegativeNumber(
    observations,
    'impressions',
    'observations.impressions'
  );
  const clicks = readNonNegativeNumber(observations, 'clicks', 'observations.clicks');
  const conversions = readNonNegativeNumber(
    observations,
    'conversions',
    'observations.conversions'
  );

  const cpm = costRatioMetric({
    metric: 'cpm',
    cost: selectedCost,
    denominator: impressions,
    denominatorField: 'observations.impressions',
    denominatorBasis: 'impressions',
    unit: 'currency_per_1000_impressions',
    scale: 1000
  });
  const cpv = costRatioMetric({
    metric: 'cpv',
    cost: selectedCost,
    denominator: views,
    denominatorField: 'observations.views',
    denominatorBasis: 'views',
    unit: 'currency_per_view'
  });
  const cpe = costRatioMetric({
    metric: 'cpe',
    cost: selectedCost,
    denominator: observedState,
    denominatorField: 'observed_engagement_total',
    denominatorBasis: 'observed_engagement_total',
    componentSignature: observedState.signature,
    unit: 'currency_per_engagement'
  });
  const ctr = ratioMetric({
    metric: 'ctr',
    numerator: clicks,
    denominator: impressions,
    denominatorField: 'observations.impressions',
    unit: 'ratio',
    metadata: { denominatorBasis: 'impressions' }
  });
  const cpc = costRatioMetric({
    metric: 'cpc',
    cost: selectedCost,
    denominator: clicks,
    denominatorField: 'observations.clicks',
    denominatorBasis: 'clicks',
    unit: 'currency_per_click'
  });
  const cvr = ratioMetric({
    metric: 'cvr',
    numerator: conversions,
    denominator: clicks,
    denominatorField: 'observations.clicks',
    unit: 'ratio',
    metadata: { denominatorBasis: 'clicks' }
  });
  const cpa = costRatioMetric({
    metric: 'cpa',
    cost: selectedCost,
    denominator: conversions,
    denominatorField: 'observations.conversions',
    denominatorBasis: 'conversions',
    unit: 'currency_per_conversion'
  });

  const revenue = commercialMoneyState(commercial, 'attributedRevenue', currency);
  const clientCharge = commercialMoneyState(commercial, 'clientCharge', currency);
  const attribution = attributionState(commercial);
  const roi = outcomeMetric({
    metric: 'roi',
    revenue,
    cost: totalCostState,
    attribution
  });
  const roas = outcomeMetric({
    metric: 'roas',
    revenue,
    cost: paidMediaState,
    attribution
  });
  const grossMarginRate = grossMarginMetric(clientCharge, totalCostState);

  const result = {
    observedEngagement,
    coreViewEr,
    extendedViewEr,
    impressionEr,
    totalCampaignCost,
    paidMediaSpend,
    cpm,
    cpv,
    cpe,
    ctr,
    cpc,
    cvr,
    cpa,
    roi,
    roas,
    grossMarginRate
  };
  Object.keys(result).forEach(function(key) {
    result[key].auditLineage = cloneAndDedupeMetadata(source.auditLineage);
  });
  return result;
}

function signatureValue(metric, field) {
  return hasOwn(metric, field) ? metric[field] : null;
}

function comparisonSignature(metric) {
  const signature = {};
  COMPARISON_SIGNATURE_FIELDS.forEach(function(field) {
    signature[field] = signatureValue(metric, field);
  });
  return signature;
}

function hasComparableSignatureShape(metric) {
  return isObject(metric) &&
    metric.definitionVersion === DEFINITION_VERSION &&
    REQUIRED_METRIC_FIELDS.every(function(field) { return hasOwn(metric, field); });
}

function findSignatureMismatch(reference, candidate, fields) {
  for (const field of fields) {
    const expected = signatureValue(reference, field);
    const actual = signatureValue(candidate, field);
    if (!Object.is(expected, actual)) {
      return {
        code: 'comparison_signature_mismatch',
        field,
        expected,
        actual
      };
    }
  }
  return null;
}

function isAvailableMetric(metric) {
  return isObject(metric) &&
    metric.available === true &&
    typeof metric.value === 'number' &&
    Number.isFinite(metric.value);
}

function malformedMetricReason(index, field) {
  return {
    code: 'malformed_metric_shape',
    index,
    field
  };
}

function metricShapeFailure(index, field) {
  return { ok: false, reason: malformedMetricReason(index, field) };
}

function isCanonicalComponentSignature(value) {
  if (!isNonEmptyString(value)) return false;
  const normalized = normalizeComponentSignature(value.split('+'));
  return normalized.ok && normalized.signature === value;
}

function validateAttributionEvidenceShape(metric, index) {
  if (!hasOwn(metric, 'attributionEvidence') || !isObject(metric.attributionEvidence)) {
    return metricShapeFailure(index, 'attributionEvidence');
  }
  const evidence = metric.attributionEvidence;
  if (evidence.approvalState !== 'approved') {
    return metricShapeFailure(index, 'attributionEvidence.approvalState');
  }
  for (const field of ['model', 'window', 'approvalId', 'approvedBy', 'policyVersion']) {
    if (!isNonEmptyString(evidence[field])) {
      return metricShapeFailure(index, 'attributionEvidence.' + field);
    }
  }
  if (!isCanonicalIsoTimestamp(evidence.approvedAt)) {
    return metricShapeFailure(index, 'attributionEvidence.approvedAt');
  }
  if (evidence.model !== metric.attributionModel) {
    return metricShapeFailure(index, 'attributionEvidence.model');
  }
  if (evidence.window !== metric.attributionWindow) {
    return metricShapeFailure(index, 'attributionEvidence.window');
  }
  if (
    evidence.model.includes('|') ||
    evidence.window.includes('|') ||
    evidence.policyVersion.includes('|')
  ) {
    return metricShapeFailure(index, 'attributionEvidence.policyVersion');
  }
  const identity = [evidence.model, evidence.window, evidence.policyVersion].join('|');
  if (metric.attributionIdentity !== identity) {
    return metricShapeFailure(index, 'attributionEvidence.policyVersion');
  }
  return { ok: true, reason: null };
}

function allowedCurrencyEvidenceFields(metric) {
  const allowed = [];
  if (metric.costBasis === COST_BASES.TOTAL_CAMPAIGN_COST) {
    allowed.push.apply(allowed, TOTAL_COST_EVIDENCE_FIELDS);
  } else if (metric.costBasis === COST_BASES.PAID_MEDIA_SPEND) {
    allowed.push('commercial.costs.paidMediaSpend');
  }
  if (metric.revenueBasis === 'approved_attributed_revenue') {
    allowed.push('commercial.attributedRevenue');
  }
  if (metric.chargeBasis === 'approved_client_charge') {
    allowed.push('commercial.clientCharge');
  }
  return new Set(allowed);
}

function validateCurrencyEvidenceShape(metric, index) {
  if (metric.currencyEvidence.length === 0) return { ok: true, reason: null };
  if (!isNonEmptyString(metric.currency) || !/^[A-Z]{3}$/.test(metric.currency)) {
    return metricShapeFailure(index, 'currency');
  }

  const allowedFields = allowedCurrencyEvidenceFields(metric);
  for (let evidenceIndex = 0; evidenceIndex < metric.currencyEvidence.length; evidenceIndex += 1) {
    const evidence = metric.currencyEvidence[evidenceIndex];
    const prefix = 'currencyEvidence[' + evidenceIndex + ']';
    if (!isObject(evidence)) return metricShapeFailure(index, prefix);
    if (!isNonEmptyString(evidence.field) || !allowedFields.has(evidence.field)) {
      return metricShapeFailure(index, prefix + '.field');
    }
    if (typeof evidence.fromCurrency !== 'string' || !/^[A-Z]{3}$/.test(evidence.fromCurrency)) {
      return metricShapeFailure(index, prefix + '.fromCurrency');
    }
    if (typeof evidence.toCurrency !== 'string' || !/^[A-Z]{3}$/.test(evidence.toCurrency)) {
      return metricShapeFailure(index, prefix + '.toCurrency');
    }
    if (evidence.toCurrency !== metric.currency || evidence.fromCurrency === evidence.toCurrency) {
      return metricShapeFailure(index, prefix + '.toCurrency');
    }
    if (!isPositiveFiniteNumber(evidence.rate)) {
      return metricShapeFailure(index, prefix + '.rate');
    }
    const exactRate = canonicalDecimalFromString(evidence.exactRate);
    if (!exactRate || exactRate.coefficient <= 0n) {
      return metricShapeFailure(index, prefix + '.exactRate');
    }
    if (evidence.exactRate !== exactStringFromNumber(evidence.rate)) {
      return metricShapeFailure(index, prefix + '.exactRate');
    }
    if (!isNonEmptyString(evidence.source)) {
      return metricShapeFailure(index, prefix + '.source');
    }
    if (!isCanonicalIsoTimestamp(evidence.effectiveAt)) {
      return metricShapeFailure(index, prefix + '.effectiveAt');
    }
    if (evidence.approvalState !== 'approved') {
      return metricShapeFailure(index, prefix + '.approvalState');
    }
    for (const field of ['approvalId', 'approvedBy', 'policyVersion']) {
      if (!isNonEmptyString(evidence[field])) {
        return metricShapeFailure(index, prefix + '.' + field);
      }
    }
    if (!isCanonicalIsoTimestamp(evidence.approvedAt)) {
      return metricShapeFailure(index, prefix + '.approvedAt');
    }
  }
  return { ok: true, reason: null };
}

function validateMetricIdentity(metric, index) {
  const contract = METRIC_CONTRACTS[metric.metric];
  if (!contract) return metricShapeFailure(index, 'metric');

  for (const field of ['unit', 'scale', 'denominatorBasis']) {
    if (!Object.is(metric[field], contract[field])) {
      return metricShapeFailure(index, field);
    }
  }
  if (contract.amountShape) {
    if (metric.denominator !== null || metric.exactDenominator !== null) {
      return metricShapeFailure(index, 'denominator');
    }
  } else if (metric.available && metric.denominator === null) {
    return metricShapeFailure(index, 'denominator');
  }

  if (contract.componentSignatureRequired) {
    if (!isCanonicalComponentSignature(metric.componentSignature)) {
      return metricShapeFailure(index, 'componentSignature');
    }
  } else if (!Object.is(metric.componentSignature, contract.componentSignature)) {
    return metricShapeFailure(index, 'componentSignature');
  }

  if (contract.selectedCostBasis) {
    if (
      metric.costBasis !== COST_BASES.TOTAL_CAMPAIGN_COST &&
      metric.costBasis !== COST_BASES.PAID_MEDIA_SPEND
    ) {
      return metricShapeFailure(index, 'costBasis');
    }
    const expectedSignature = metric.costBasis === COST_BASES.TOTAL_CAMPAIGN_COST
      ? TOTAL_COST_SIGNATURE
      : 'paid_media_spend';
    if (metric.costComponentSignature !== expectedSignature) {
      return metricShapeFailure(index, 'costComponentSignature');
    }
  } else {
    if (!Object.is(metric.costBasis, contract.costBasis)) {
      return metricShapeFailure(index, 'costBasis');
    }
    if (!Object.is(metric.costComponentSignature, contract.costComponentSignature)) {
      return metricShapeFailure(index, 'costComponentSignature');
    }
  }

  if (contract.currencyRequired) {
    if (typeof metric.currency !== 'string' || !/^[A-Z]{3}$/.test(metric.currency)) {
      return metricShapeFailure(index, 'currency');
    }
  } else if (metric.currency !== null) {
    return metricShapeFailure(index, 'currency');
  }

  if (contract.revenueBasis) {
    if (!hasOwn(metric, 'revenueBasis') || metric.revenueBasis !== contract.revenueBasis) {
      return metricShapeFailure(index, 'revenueBasis');
    }
  } else if (hasOwn(metric, 'revenueBasis')) {
    return metricShapeFailure(index, 'revenueBasis');
  }

  if (contract.chargeBasis) {
    if (!hasOwn(metric, 'chargeBasis') || metric.chargeBasis !== contract.chargeBasis) {
      return metricShapeFailure(index, 'chargeBasis');
    }
  } else if (hasOwn(metric, 'chargeBasis')) {
    return metricShapeFailure(index, 'chargeBasis');
  }

  if (contract.restrictedVisibility) {
    if (!hasOwn(metric, 'visibility') || !isObject(metric.visibility)) {
      return metricShapeFailure(index, 'visibility');
    }
    for (const field of ['scope', 'classification', 'customerSafe']) {
      if (!Object.is(metric.visibility[field], RESTRICTED_FINANCIAL_VISIBILITY[field])) {
        return metricShapeFailure(index, 'visibility.' + field);
      }
    }
  } else if (hasOwn(metric, 'visibility')) {
    return metricShapeFailure(index, 'visibility');
  }

  if (contract.attributionRequired) {
    for (const field of ['attributionModel', 'attributionWindow', 'attributionIdentity']) {
      if (!isNonEmptyString(metric[field])) return metricShapeFailure(index, field);
    }
    const attributionValidation = validateAttributionEvidenceShape(metric, index);
    if (!attributionValidation.ok) return attributionValidation;
  } else {
    for (const field of ['attributionModel', 'attributionWindow', 'attributionIdentity']) {
      if (metric[field] !== null) return metricShapeFailure(index, field);
    }
    if (hasOwn(metric, 'attributionEvidence')) {
      return metricShapeFailure(index, 'attributionEvidence');
    }
  }

  return validateCurrencyEvidenceShape(metric, index);
}

function validateMetricShape(metric, index, requireRatio) {
  if (!isObject(metric)) {
    return { ok: false, reason: malformedMetricReason(index, 'metric') };
  }
  for (const field of REQUIRED_METRIC_FIELDS) {
    if (!hasOwn(metric, field)) {
      return { ok: false, reason: malformedMetricReason(index, field) };
    }
  }
  if (!isNonEmptyString(metric.metric)) {
    return { ok: false, reason: malformedMetricReason(index, 'metric') };
  }
  if (typeof metric.available !== 'boolean') {
    return { ok: false, reason: malformedMetricReason(index, 'available') };
  }
  if (!isNonEmptyString(metric.unit)) {
    return { ok: false, reason: malformedMetricReason(index, 'unit') };
  }
  if (!isPositiveFiniteNumber(metric.scale)) {
    return { ok: false, reason: malformedMetricReason(index, 'scale') };
  }
  if (!isNonEmptyString(metric.definitionVersion)) {
    return { ok: false, reason: malformedMetricReason(index, 'definitionVersion') };
  }
  for (const field of METRIC_IDENTITY_FIELDS) {
    if (metric[field] !== null && !isNonEmptyString(metric[field])) {
      return { ok: false, reason: malformedMetricReason(index, field) };
    }
  }
  if (!Array.isArray(metric.auditLineage)) {
    return { ok: false, reason: malformedMetricReason(index, 'auditLineage') };
  }
  if (!Array.isArray(metric.currencyEvidence)) {
    return { ok: false, reason: malformedMetricReason(index, 'currencyEvidence') };
  }
  if (metric.available) {
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) {
      return { ok: false, reason: malformedMetricReason(index, 'value') };
    }
    if (!isNonEmptyString(metric.exactValue)) {
      return { ok: false, reason: malformedMetricReason(index, 'exactValue') };
    }
    if (metric.reason !== null) {
      return { ok: false, reason: malformedMetricReason(index, 'reason') };
    }
  } else if (metric.value !== null || metric.exactValue !== null) {
    return { ok: false, reason: malformedMetricReason(index, 'value') };
  } else if (!isObject(metric.reason)) {
    return { ok: false, reason: malformedMetricReason(index, 'reason') };
  } else if (!hasOwn(metric.reason, 'code') || !isNonEmptyString(metric.reason.code)) {
    return { ok: false, reason: malformedMetricReason(index, 'reason.code') };
  }

  const numericPairs = [
    ['numerator', 'exactNumerator'],
    ['denominator', 'exactDenominator']
  ];
  const exactDecimals = {};
  for (const pair of numericPairs) {
    const numericField = pair[0];
    const exactField = pair[1];
    if (metric[numericField] === null) {
      if (metric[exactField] !== null) {
        return { ok: false, reason: malformedMetricReason(index, exactField) };
      }
      exactDecimals[exactField] = null;
      continue;
    }
    if (typeof metric[numericField] !== 'number' || !Number.isFinite(metric[numericField])) {
      return { ok: false, reason: malformedMetricReason(index, numericField) };
    }
    const exact = canonicalDecimalFromString(metric[exactField]);
    if (!exact) {
      return { ok: false, reason: malformedMetricReason(index, exactField) };
    }
    exactDecimals[exactField] = exact;
  }

  const numeratorExact = exactDecimals.exactNumerator;
  const denominatorExact = exactDecimals.exactDenominator;
  if (metric.available && !numeratorExact) {
    return { ok: false, reason: malformedMetricReason(index, 'numerator') };
  }
  if (metric.available && metric.denominator !== null) {
    if (!isPositiveFiniteNumber(metric.denominator) || !denominatorExact || denominatorExact.coefficient <= 0n) {
      return { ok: false, reason: malformedMetricReason(index, 'denominator') };
    }
  }
  if (requireRatio && metric.available && metric.denominator === null) {
    return { ok: false, reason: malformedMetricReason(index, 'denominator') };
  }

  const expectedExactValue = metric.available
    ? metricExactValueString(numeratorExact, denominatorExact, metric.scale)
    : null;
  const expectedNumericValue = metric.available
    ? metricValueFromExact(numeratorExact, denominatorExact, metric.scale)
    : null;
  for (const pair of numericPairs) {
    const numericField = pair[0];
    const exactField = pair[1];
    if (metric[numericField] === null) continue;
    const exactNumericValue = decimalToNumber(exactDecimals[exactField]);
    if (!sameNumber(metric[numericField], exactNumericValue)) {
      const exactSideCoherent = metric.available &&
        metric.exactValue === expectedExactValue &&
        sameNumber(metric.value, expectedNumericValue);
      return {
        ok: false,
        reason: malformedMetricReason(index, exactSideCoherent ? numericField : exactField)
      };
    }
  }
  if (metric.available && metric.exactValue !== expectedExactValue) {
    return { ok: false, reason: malformedMetricReason(index, 'exactValue') };
  }
  if (metric.available && !sameNumber(metric.value, expectedNumericValue)) {
    return { ok: false, reason: malformedMetricReason(index, 'value') };
  }
  if (metric.definitionVersion !== DEFINITION_VERSION) {
    return {
      ok: false,
      reason: {
        code: 'non_current_definition_version',
        index,
        expected: DEFINITION_VERSION,
        actual: metric.definitionVersion
      },
      actualDefinitionVersion: metric.definitionVersion
    };
  }
  const identityValidation = validateMetricIdentity(metric, index);
  if (!identityValidation.ok) return identityValidation;
  return { ok: true, reason: null, actualDefinitionVersion: metric.definitionVersion };
}

function identityOptions(metric) {
  const options = {
    unit: metric && isNonEmptyString(metric.unit) ? metric.unit : 'ratio',
    scale: metric && isPositiveFiniteNumber(metric.scale) ? metric.scale : 1,
    definitionVersion: metric && hasOwn(metric, 'definitionVersion')
      ? metric.definitionVersion
      : null
  };
  METRIC_IDENTITY_FIELDS.forEach(function(field) {
    options[field] = metric && hasOwn(metric, field) ? metric[field] : null;
  });
  if (metric && hasOwn(metric, 'revenueBasis')) options.revenueBasis = metric.revenueBasis;
  if (metric && hasOwn(metric, 'chargeBasis')) options.chargeBasis = metric.chargeBasis;
  if (metric && hasOwn(metric, 'attributionEvidence')) {
    options.attributionEvidence = metric.attributionEvidence;
  }
  if (metric && hasOwn(metric, 'visibility')) options.visibility = metric.visibility;
  return options;
}

function aggregateResult(result, availableRecordCount, totalRecordCount) {
  return Object.assign(result, {
    aggregate: true,
    availableRecordCount,
    totalRecordCount,
    coverage: totalRecordCount === 0 ? 0 : availableRecordCount / totalRecordCount
  });
}

function collectAggregateMetadata(records) {
  const auditLineage = [];
  const currencyEvidence = [];
  records.forEach(function(metric) {
    if (!isObject(metric)) return;
    if (Array.isArray(metric.auditLineage)) auditLineage.push.apply(auditLineage, metric.auditLineage);
    if (Array.isArray(metric.currencyEvidence)) {
      currencyEvidence.push.apply(currencyEvidence, metric.currencyEvidence);
    }
  });
  return {
    auditLineage: cloneAndDedupeMetadata(auditLineage),
    currencyEvidence: cloneAndDedupeMetadata(currencyEvidence)
  };
}

function invalidAggregateMetric(
  metric,
  reason,
  availableRecordCount,
  totalRecordCount,
  metadata
) {
  const name = metric && isNonEmptyString(metric.metric) ? metric.metric : 'aggregate_ratio';
  return aggregateResult(createMetricResult(name, Object.assign({
    available: false,
    reason,
    numerator: null,
    denominator: null,
    unit: metric && isNonEmptyString(metric.unit) ? metric.unit : 'ratio',
    definitionVersion: metric && hasOwn(metric, 'definitionVersion')
      ? metric.definitionVersion
      : null,
    auditLineage: metadata ? metadata.auditLineage : [],
    currencyEvidence: metadata ? metadata.currencyEvidence : []
  }, identityOptions(metric))), availableRecordCount, totalRecordCount);
}

function aggregateRatio(metrics) {
  const records = Array.isArray(metrics) ? metrics : [];
  const totalRecordCount = records.length;
  const metadata = collectAggregateMetadata(records);
  const reference = records[0];
  if (reference) {
    const validation = validateMetricShape(reference, 0, true);
    if (!validation.ok) {
      return invalidAggregateMetric(
        reference,
        validation.reason,
        0,
        totalRecordCount,
        metadata
      );
    }
  }
  for (let index = 1; index < records.length; index += 1) {
    const mismatch = hasComparableSignatureShape(records[index])
      ? findSignatureMismatch(reference, records[index], COMPARISON_SIGNATURE_FIELDS)
      : null;
    if (mismatch) {
      return invalidAggregateMetric(
        reference,
        mismatch,
        0,
        totalRecordCount,
        metadata
      );
    }
    const validation = validateMetricShape(records[index], index, true);
    if (!validation.ok) {
      return invalidAggregateMetric(
        reference,
        validation.reason,
        0,
        totalRecordCount,
        metadata
      );
    }
  }

  const available = records.filter(isAvailableMetric);
  const availableRecordCount = available.length;

  if (available.length === 0) {
    const noAvailableMetric = reference || null;
    return aggregateResult(createMetricResult(
      noAvailableMetric ? noAvailableMetric.metric : 'aggregate_ratio',
      Object.assign({
        available: false,
        reason: { code: 'no_available_ratio_records' },
        numerator: null,
        denominator: null,
        unit: noAvailableMetric ? noAvailableMetric.unit : 'ratio',
        definitionVersion: noAvailableMetric
          ? noAvailableMetric.definitionVersion
          : DEFINITION_VERSION,
        auditLineage: metadata.auditLineage,
        currencyEvidence: metadata.currencyEvidence
      }, identityOptions(noAvailableMetric))), availableRecordCount, totalRecordCount);
  }

  let numeratorExact = decimalFromSafeInteger(0);
  let denominatorExact = decimalFromSafeInteger(0);
  for (const metric of available) {
    numeratorExact = addDecimals(numeratorExact, decimalFromString(metric.exactNumerator));
    denominatorExact = addDecimals(denominatorExact, decimalFromString(metric.exactDenominator));
  }

  const numerator = decimalToNumber(numeratorExact);
  const denominator = decimalToNumber(denominatorExact);
  const value = metricValueFromExact(numeratorExact, denominatorExact, reference.scale);
  if (value === null || !Number.isFinite(value)) {
    return invalidAggregateMetric(
      reference,
      { code: 'numeric_overflow', field: 'aggregate_ratio' },
      availableRecordCount,
      totalRecordCount,
      metadata
    );
  }
  const result = createMetricResult(reference.metric, Object.assign({
    available: Number.isFinite(value),
    value,
    reason: null,
    numerator,
    denominator,
    numeratorExact,
    denominatorExact,
    unit: reference.unit,
    auditLineage: metadata.auditLineage,
    currencyEvidence: metadata.currencyEvidence
  }, identityOptions(reference)));
  return aggregateResult(result, availableRecordCount, totalRecordCount);
}

function comparisonResult(options) {
  return {
    eligible: options.eligible,
    reason: options.reason,
    coverage: options.coverage,
    minimumCoverage: MINIMUM_COMPARISON_COVERAGE,
    comparableRecordCount: options.comparableRecordCount,
    excludedRecordCount: options.totalRecordCount - options.comparableRecordCount,
    totalRecordCount: options.totalRecordCount,
    definitionVersion: hasOwn(options, 'definitionVersion')
      ? options.definitionVersion
      : DEFINITION_VERSION,
    signature: options.signature
  };
}

function assessComparisonEligibility(metrics) {
  const records = Array.isArray(metrics) ? metrics : [];
  const reference = records[0];
  if (reference) {
    const validation = validateMetricShape(reference, 0, false);
    if (!validation.ok) {
      return comparisonResult({
        eligible: false,
        reason: validation.reason,
        coverage: 0,
        comparableRecordCount: 0,
        totalRecordCount: records.length,
        definitionVersion: hasOwn(reference, 'definitionVersion')
          ? reference.definitionVersion
          : null,
        signature: null
      });
    }
  }
  const signature = reference ? comparisonSignature(reference) : null;
  for (let index = 1; index < records.length; index += 1) {
    const mismatch = hasComparableSignatureShape(records[index])
      ? findSignatureMismatch(reference, records[index], COMPARISON_SIGNATURE_FIELDS)
      : null;
    if (mismatch) {
      return comparisonResult({
        eligible: false,
        reason: mismatch,
        coverage: 0,
        comparableRecordCount: 0,
        totalRecordCount: records.length,
        signature
      });
    }
    const validation = validateMetricShape(records[index], index, false);
    if (!validation.ok) {
      return comparisonResult({
        eligible: false,
        reason: validation.reason,
        coverage: 0,
        comparableRecordCount: 0,
        totalRecordCount: records.length,
        definitionVersion: records[index] && hasOwn(records[index], 'definitionVersion')
          ? records[index].definitionVersion
          : null,
        signature: null
      });
    }
  }

  const available = records.filter(isAvailableMetric);
  const totalRecordCount = records.length;
  const comparableRecordCount = available.length;
  const coverage = totalRecordCount === 0 ? 0 : comparableRecordCount / totalRecordCount;

  if (coverage < MINIMUM_COMPARISON_COVERAGE) {
    return comparisonResult({
      eligible: false,
      reason: {
        code: 'insufficient_metric_coverage',
        minimumCoverage: MINIMUM_COMPARISON_COVERAGE,
        actualCoverage: coverage
      },
      coverage,
      comparableRecordCount,
      totalRecordCount,
      signature
    });
  }

  return comparisonResult({
    eligible: true,
    reason: null,
    coverage,
    comparableRecordCount,
    totalRecordCount,
    signature
  });
}

module.exports = {
  DEFINITION_VERSION,
  MINIMUM_COMPARISON_COVERAGE,
  INTERACTION_COMPONENTS,
  COST_BASES,
  calculateObservedEngagement: observedEngagementMetric,
  calculatePerformanceMetrics,
  aggregateRatio,
  assessComparisonEligibility
};
