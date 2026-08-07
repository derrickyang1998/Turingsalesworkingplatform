const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const EXPECTED_DEFINITION_VERSION = 'phase7b.1-kpi-v1';
const TOTAL_COST_SIGNATURE = [
  'creator_fee',
  'product_sample_cost',
  'logistics_cost',
  'paid_media_spend',
  'platform_agency_fee',
  'approved_other_cost'
].join('+');

const METRICS_SERVICE_PATH = path.resolve(
  __dirname,
  '../services/performance_metrics_service.js'
);
const NUMBER_FALLBACK_MUTANT_ENV = 'KPI_EXACT_NUMBER_FALLBACK_MUTANT';

function loadMetrics() {
  return require('../services/performance_metrics_service');
}

function loadNumberFallbackMutant() {
  const source = fs.readFileSync(METRICS_SERVICE_PATH, 'utf8');
  const exactValueFunction = /function metricExactValueString\(numerator, denominator, scale\) \{\r?\n[\s\S]*?\r?\n\}\r?\n\r?\nfunction metricValueFromExact/;
  const mutantSource = source.replace(exactValueFunction, [
    'function metricExactValueString(numerator, denominator, scale) {',
    '  return exactStringFromNumber(metricValueFromExact(numerator, denominator, scale));',
    '}',
    '',
    'function metricValueFromExact'
  ].join('\n'));
  assert.notEqual(mutantSource, source, 'Number-fallback mutant must replace exact generator');

  const mutant = new Module(METRICS_SERVICE_PATH + '.number-fallback-mutant', module);
  mutant.filename = METRICS_SERVICE_PATH;
  mutant.paths = Module._nodeModulePaths(path.dirname(METRICS_SERVICE_PATH));
  mutant._compile(mutantSource, METRICS_SERVICE_PATH);
  return mutant.exports;
}

function approvedMoney(amount, currency = 'USD') {
  return {
    amount,
    currency,
    approvalState: 'approved'
  };
}

function approvalProvenance(prefix) {
  return {
    approvalId: prefix + '-approval-1',
    approvedBy: prefix + '-actor-1',
    approvedAt: '2026-07-30T01:00:00Z',
    policyVersion: prefix + '-policy-v1'
  };
}

function approvedFxEvidence(fromCurrency, toCurrency, rate, source = 'approved_test_rate') {
  return Object.assign({
    fromCurrency,
    toCurrency,
    rate,
    source,
    effectiveAt: '2026-07-30T00:00:00Z',
    approvalState: 'approved'
  }, approvalProvenance('fx'));
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key], seen));
  return Object.freeze(value);
}

function happyInput(costBasis = 'total_campaign_cost') {
  return {
    observations: {
      views: 1000,
      impressions: 2000,
      likes: 80,
      comments: 20,
      saves: 10,
      shares: 10,
      clicks: 100,
      conversions: 20
    },
    engagementComponents: ['likes', 'comments', 'saves', 'shares'],
    costBasis,
    commercial: {
      baseCurrency: 'USD',
      costs: {
        creatorFee: approvedMoney(500),
        productSampleCost: approvedMoney(100),
        logisticsCost: approvedMoney(100),
        paidMediaSpend: approvedMoney(300),
        platformAgencyFee: approvedMoney(100),
        otherCost: approvedMoney(100)
      },
      attributedRevenue: approvedMoney(1800),
      clientCharge: approvedMoney(1500),
      attribution: Object.assign({
        model: 'last_touch',
        window: '30_days',
        approvalState: 'approved'
      }, approvalProvenance('attribution'))
    }
  };
}

function setTotalCampaignCost(input, amount) {
  const costs = input.commercial.costs;
  costs.creatorFee.amount = amount;
  costs.productSampleCost.amount = 0;
  costs.logisticsCost.amount = 0;
  costs.paidMediaSpend.amount = 0;
  costs.platformAgencyFee.amount = 0;
  costs.otherCost.amount = 0;
}

function exactRationalValues(metrics) {
  const thirdInput = happyInput();
  thirdInput.observations.views = 3;
  thirdInput.observations.likes = 1;
  thirdInput.observations.comments = 0;
  const oneThird = metrics.calculatePerformanceMetrics(thirdInput).coreViewEr;

  const weightedFirstInput = happyInput();
  weightedFirstInput.observations.views = 10;
  weightedFirstInput.observations.likes = 5;
  weightedFirstInput.observations.comments = 0;
  const weightedSecondInput = happyInput();
  weightedSecondInput.observations.views = 1000;
  weightedSecondInput.observations.likes = 10;
  weightedSecondInput.observations.comments = 0;
  const weighted = metrics.aggregateRatio([
    metrics.calculatePerformanceMetrics(weightedFirstInput).coreViewEr,
    metrics.calculatePerformanceMetrics(weightedSecondInput).coreViewEr
  ]);

  const scaledFirstInput = happyInput();
  setTotalCampaignCost(scaledFirstInput, 1);
  scaledFirstInput.observations.impressions = 3;
  const scaledFirst = metrics.calculatePerformanceMetrics(scaledFirstInput).cpm;
  const scaledSecondInput = happyInput();
  setTotalCampaignCost(scaledSecondInput, 2);
  scaledSecondInput.observations.impressions = 4;
  const scaledAggregate = metrics.aggregateRatio([
    scaledFirst,
    metrics.calculatePerformanceMetrics(scaledSecondInput).cpm
  ]);

  return {
    oneThird: oneThird.exactValue,
    reducedWeighted: weighted.exactValue,
    scaledNonTerminating: scaledFirst.exactValue,
    scaledAggregate: scaledAggregate.exactValue
  };
}

test('observed engagement totals exactly the declared component signature', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const result = calculatePerformanceMetrics(happyInput());

  assert.deepEqual(result.observedEngagement, {
    metric: 'observed_engagement_total',
    value: 120,
    available: true,
    reason: null,
    numerator: 120,
    denominator: null,
    unit: 'engagements',
    scale: 1,
    definitionVersion: EXPECTED_DEFINITION_VERSION,
    denominatorBasis: null,
    componentSignature: 'likes+comments+saves+shares',
    costBasis: null,
    costComponentSignature: null,
    currency: null,
    attributionModel: null,
    attributionWindow: null,
    attributionIdentity: null,
    exactValue: '120',
    exactNumerator: '120',
    exactDenominator: null,
    auditLineage: [],
    currencyEvidence: []
  });
});

test('observed engagement stays unknown when any declared component is missing', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  delete input.observations.saves;

  const result = calculatePerformanceMetrics(input);

  assert.equal(result.observedEngagement.value, null);
  assert.equal(result.observedEngagement.available, false);
  assert.deepEqual(result.observedEngagement.reason, {
    code: 'missing_input',
    field: 'observations.saves'
  });
  assert.equal(result.observedEngagement.componentSignature, 'likes+comments+saves+shares');
  assert.equal(result.coreViewEr.value, 0.1);
});

test('numeric observations reject strings, negatives, and non-finite values without coercion', () => {
  const { calculatePerformanceMetrics } = loadMetrics();

  const stringInput = happyInput();
  stringInput.observations.views = '1000';
  assert.deepEqual(calculatePerformanceMetrics(stringInput).coreViewEr.reason, {
    code: 'invalid_nonnegative_number',
    field: 'observations.views'
  });

  const negativeInput = happyInput();
  negativeInput.observations.likes = -1;
  assert.deepEqual(calculatePerformanceMetrics(negativeInput).coreViewEr.reason, {
    code: 'invalid_nonnegative_number',
    field: 'observations.likes'
  });

  const infiniteInput = happyInput();
  infiniteInput.observations.comments = Infinity;
  assert.deepEqual(calculatePerformanceMetrics(infiniteInput).coreViewEr.reason, {
    code: 'invalid_nonnegative_number',
    field: 'observations.comments'
  });
});

test('missing and zero view denominators stay unknown while an observed zero numerator remains zero', () => {
  const { calculatePerformanceMetrics } = loadMetrics();

  const missingInput = happyInput();
  delete missingInput.observations.views;
  const missing = calculatePerformanceMetrics(missingInput).coreViewEr;
  assert.equal(missing.value, null);
  assert.deepEqual(missing.reason, {
    code: 'missing_input',
    field: 'observations.views'
  });

  const zeroDenominatorInput = happyInput();
  zeroDenominatorInput.observations.views = 0;
  const zeroDenominator = calculatePerformanceMetrics(zeroDenominatorInput).coreViewEr;
  assert.equal(zeroDenominator.value, null);
  assert.deepEqual(zeroDenominator.reason, {
    code: 'non_positive_denominator',
    field: 'observations.views'
  });

  const zeroNumeratorInput = happyInput();
  zeroNumeratorInput.observations.likes = 0;
  zeroNumeratorInput.observations.comments = 0;
  const zeroNumerator = calculatePerformanceMetrics(zeroNumeratorInput).coreViewEr;
  assert.equal(zeroNumerator.value, 0);
  assert.equal(zeroNumerator.available, true);
  assert.equal(zeroNumerator.reason, null);
});

test('Core View ER requires both likes and comments', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  delete input.observations.comments;

  const metric = calculatePerformanceMetrics(input).coreViewEr;

  assert.equal(metric.value, null);
  assert.deepEqual(metric.reason, {
    code: 'missing_input',
    field: 'observations.comments'
  });
  assert.equal(metric.componentSignature, 'likes+comments');
  assert.equal(metric.denominatorBasis, 'views');
});

test('Extended View ER requires likes, comments, saves, and shares', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  delete input.observations.shares;

  const result = calculatePerformanceMetrics(input);

  assert.equal(result.extendedViewEr.value, null);
  assert.deepEqual(result.extendedViewEr.reason, {
    code: 'missing_input',
    field: 'observations.shares'
  });
  assert.equal(result.extendedViewEr.componentSignature, 'likes+comments+saves+shares');
  assert.equal(result.coreViewEr.value, 0.1);
});

test('Impression ER requires an explicit component signature and positive impressions', () => {
  const { calculatePerformanceMetrics } = loadMetrics();

  const available = calculatePerformanceMetrics(happyInput()).impressionEr;
  assert.equal(available.value, 0.06);
  assert.equal(available.numerator, 120);
  assert.equal(available.denominator, 2000);
  assert.equal(available.denominatorBasis, 'impressions');
  assert.equal(available.componentSignature, 'likes+comments+saves+shares');

  const noSignatureInput = happyInput();
  delete noSignatureInput.engagementComponents;
  const noSignature = calculatePerformanceMetrics(noSignatureInput).impressionEr;
  assert.equal(noSignature.value, null);
  assert.deepEqual(noSignature.reason, { code: 'missing_component_signature' });

  const zeroImpressionsInput = happyInput();
  zeroImpressionsInput.observations.impressions = 0;
  const zeroImpressions = calculatePerformanceMetrics(zeroImpressionsInput).impressionEr;
  assert.equal(zeroImpressions.value, null);
  assert.deepEqual(zeroImpressions.reason, {
    code: 'non_positive_denominator',
    field: 'observations.impressions'
  });
});

test('total-cost efficiency metrics use the complete approved campaign cost basis', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const result = calculatePerformanceMetrics(happyInput('total_campaign_cost'));

  assert.deepEqual(result.totalCampaignCost, {
    metric: 'total_campaign_cost',
    value: 1200,
    available: true,
    reason: null,
    numerator: 1200,
    denominator: null,
    unit: 'currency',
    scale: 1,
    definitionVersion: EXPECTED_DEFINITION_VERSION,
    denominatorBasis: null,
    componentSignature: null,
    costBasis: 'total_campaign_cost',
    costComponentSignature: TOTAL_COST_SIGNATURE,
    currency: 'USD',
    attributionModel: null,
    attributionWindow: null,
    attributionIdentity: null,
    exactValue: '1200',
    exactNumerator: '1200',
    exactDenominator: null,
    auditLineage: [],
    currencyEvidence: []
  });
  assert.equal(result.cpm.value, 600);
  assert.equal(result.cpv.value, 1.2);
  assert.equal(result.cpe.value, 10);
  assert.equal(result.ctr.value, 0.05);
  assert.equal(result.cpc.value, 12);
  assert.equal(result.cvr.value, 0.2);
  assert.equal(result.cpa.value, 60);
  assert.equal(result.cpm.costBasis, 'total_campaign_cost');
  assert.equal(result.cpe.componentSignature, 'likes+comments+saves+shares');
  assert.equal(result.cpm.costComponentSignature, TOTAL_COST_SIGNATURE);
  assert.equal(result.cpm.currency, 'USD');
});

test('paid-media efficiency metrics expose the distinct paid-media cost basis', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const result = calculatePerformanceMetrics(happyInput('paid_media_spend'));

  assert.equal(result.paidMediaSpend.value, 300);
  assert.equal(result.paidMediaSpend.costBasis, 'paid_media_spend');
  assert.equal(result.paidMediaSpend.costComponentSignature, 'paid_media_spend');
  assert.equal(result.cpm.value, 150);
  assert.equal(result.cpv.value, 0.3);
  assert.equal(result.cpe.value, 2.5);
  assert.equal(result.cpc.value, 3);
  assert.equal(result.cpa.value, 15);
  assert.equal(result.cpm.costBasis, 'paid_media_spend');
  assert.equal(result.roi.costBasis, 'total_campaign_cost');
  assert.equal(result.roas.costBasis, 'paid_media_spend');
});

test('an unapproved cost component makes total campaign cost unknown instead of summing a subset', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.commercial.costs.creatorFee.approvalState = 'pending';

  const result = calculatePerformanceMetrics(input);

  assert.equal(result.totalCampaignCost.value, null);
  assert.deepEqual(result.totalCampaignCost.reason, {
    code: 'unapproved_money',
    field: 'commercial.costs.creatorFee'
  });
  assert.equal(result.cpm.value, null);
  assert.deepEqual(result.cpm.reason, result.totalCampaignCost.reason);
  assert.equal(result.paidMediaSpend.value, 300);
});

test('a missing cost component makes total campaign cost unknown instead of treating it as zero', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  delete input.commercial.costs.otherCost;

  const result = calculatePerformanceMetrics(input);

  assert.equal(result.totalCampaignCost.value, null);
  assert.deepEqual(result.totalCampaignCost.reason, {
    code: 'missing_money',
    field: 'commercial.costs.otherCost'
  });
  assert.equal(result.roi.value, null);
});

test('foreign-currency costs require approved FX evidence before joining the base-currency total', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.commercial.costs.creatorFee = approvedMoney(250, 'EUR');

  const missingFx = calculatePerformanceMetrics(input).totalCampaignCost;
  assert.equal(missingFx.value, null);
  assert.deepEqual(missingFx.reason, {
    code: 'missing_fx_evidence',
    field: 'commercial.costs.creatorFee',
    fromCurrency: 'EUR',
    toCurrency: 'USD'
  });

  input.commercial.costs.creatorFee.fxEvidence = approvedFxEvidence('EUR', 'USD', 2);
  const converted = calculatePerformanceMetrics(input).totalCampaignCost;
  assert.equal(converted.value, 1200);
  assert.deepEqual(converted.currencyEvidence, [{
    field: 'commercial.costs.creatorFee',
    fromCurrency: 'EUR',
    toCurrency: 'USD',
    rate: 2,
    exactRate: '2',
    source: 'approved_test_rate',
    effectiveAt: '2026-07-30T00:00:00Z',
    approvalState: 'approved',
    approvalId: 'fx-approval-1',
    approvedBy: 'fx-actor-1',
    approvedAt: '2026-07-30T01:00:00Z',
    policyVersion: 'fx-policy-v1'
  }]);
});

test('ROI and ROAS use approved attributed revenue with their fixed cost bases', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const result = calculatePerformanceMetrics(happyInput());

  assert.equal(result.roi.value, 0.5);
  assert.equal(result.roi.numerator, 600);
  assert.equal(result.roi.denominator, 1200);
  assert.equal(result.roi.costBasis, 'total_campaign_cost');
  assert.equal(result.roi.revenueBasis, 'approved_attributed_revenue');
  assert.equal(result.roi.attributionModel, 'last_touch');
  assert.equal(result.roi.attributionWindow, '30_days');

  assert.equal(result.roas.value, 6);
  assert.equal(result.roas.numerator, 1800);
  assert.equal(result.roas.denominator, 300);
  assert.equal(result.roas.costBasis, 'paid_media_spend');
  assert.equal(result.roas.revenueBasis, 'approved_attributed_revenue');
  assert.equal(result.roas.attributionModel, 'last_touch');
  assert.equal(result.roas.attributionWindow, '30_days');
});

test('unapproved attributed revenue blocks ROI and ROAS', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.commercial.attributedRevenue.approvalState = 'pending';

  const result = calculatePerformanceMetrics(input);

  assert.equal(result.roi.value, null);
  assert.equal(result.roas.value, null);
  assert.deepEqual(result.roi.reason, {
    code: 'unapproved_money',
    field: 'commercial.attributedRevenue'
  });
  assert.deepEqual(result.roas.reason, result.roi.reason);
});

test('missing or unapproved attribution model and window evidence blocks ROI and ROAS', () => {
  const { calculatePerformanceMetrics } = loadMetrics();

  const missingModelInput = happyInput();
  delete missingModelInput.commercial.attribution.model;
  assert.deepEqual(calculatePerformanceMetrics(missingModelInput).roi.reason, {
    code: 'missing_attribution_model',
    field: 'commercial.attribution.model'
  });

  const missingWindowInput = happyInput();
  delete missingWindowInput.commercial.attribution.window;
  assert.deepEqual(calculatePerformanceMetrics(missingWindowInput).roas.reason, {
    code: 'missing_attribution_window',
    field: 'commercial.attribution.window'
  });

  const pendingInput = happyInput();
  pendingInput.commercial.attribution.approvalState = 'pending';
  const pending = calculatePerformanceMetrics(pendingInput);
  assert.deepEqual(pending.roi.reason, {
    code: 'unapproved_attribution',
    field: 'commercial.attribution'
  });
  assert.deepEqual(pending.roas.reason, pending.roi.reason);
});

test('foreign attributed revenue requires FX evidence for ROI and ROAS', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.commercial.attributedRevenue = approvedMoney(1500, 'EUR');

  const missingFx = calculatePerformanceMetrics(input);
  assert.equal(missingFx.roi.value, null);
  assert.equal(missingFx.roas.value, null);
  assert.equal(missingFx.roi.reason.code, 'missing_fx_evidence');

  input.commercial.attributedRevenue.fxEvidence = approvedFxEvidence('EUR', 'USD', 1.2);
  const converted = calculatePerformanceMetrics(input);
  assert.equal(converted.roi.value, 0.5);
  assert.equal(converted.roas.value, 6);
  assert.equal(converted.roi.currencyEvidence.length, 1);
  assert.equal(converted.roi.currencyEvidence[0].field, 'commercial.attributedRevenue');
});

test('gross margin uses approved client charge and never substitutes attributed revenue', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.commercial.attributedRevenue.amount = 3000;

  const result = calculatePerformanceMetrics(input);
  assert.equal(result.roi.value, 1.5);
  assert.equal(result.grossMarginRate.value, 0.2);
  assert.equal(result.grossMarginRate.numerator, 300);
  assert.equal(result.grossMarginRate.denominator, 1500);
  assert.equal(result.grossMarginRate.chargeBasis, 'approved_client_charge');

  delete input.commercial.clientCharge;
  const missingCharge = calculatePerformanceMetrics(input).grossMarginRate;
  assert.equal(missingCharge.value, null);
  assert.deepEqual(missingCharge.reason, {
    code: 'missing_money',
    field: 'commercial.clientCharge'
  });
});

test('efficiency ratios keep zero and missing denominators unknown rather than fabricating zero', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const zeroInput = happyInput();
  zeroInput.observations.views = 0;
  zeroInput.observations.impressions = 0;
  zeroInput.observations.likes = 0;
  zeroInput.observations.comments = 0;
  zeroInput.observations.saves = 0;
  zeroInput.observations.shares = 0;
  zeroInput.observations.clicks = 0;
  zeroInput.observations.conversions = 0;

  const zero = calculatePerformanceMetrics(zeroInput);
  ['cpm', 'cpv', 'cpe', 'ctr', 'cpc', 'cvr', 'cpa'].forEach((key) => {
    assert.equal(zero[key].value, null, key);
    assert.equal(zero[key].available, false, key);
  });

  const missingInput = happyInput();
  delete missingInput.observations.impressions;
  delete missingInput.observations.clicks;
  delete missingInput.observations.conversions;
  const missing = calculatePerformanceMetrics(missingInput);
  assert.equal(missing.cpm.value, null);
  assert.equal(missing.ctr.value, null);
  assert.equal(missing.cpc.value, null);
  assert.equal(missing.cvr.value, null);
  assert.equal(missing.cpa.value, null);
});

test('the engine returns full precision without rounding', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.observations.views = 3;
  input.observations.likes = 1;
  input.observations.comments = 0;

  const metric = calculatePerformanceMetrics(input).coreViewEr;

  assert.equal(metric.value, 0.3333333333333333);
  assert.equal(metric.numerator, 1);
  assert.equal(metric.denominator, 3);
});

test('aggregate ratios recompute weighted totals instead of averaging row rates', () => {
  const { calculatePerformanceMetrics, aggregateRatio } = loadMetrics();
  const firstInput = happyInput();
  firstInput.observations.views = 10;
  firstInput.observations.likes = 5;
  firstInput.observations.comments = 0;
  const secondInput = happyInput();
  secondInput.observations.views = 1000;
  secondInput.observations.likes = 10;
  secondInput.observations.comments = 0;

  const aggregate = aggregateRatio([
    calculatePerformanceMetrics(firstInput).coreViewEr,
    calculatePerformanceMetrics(secondInput).coreViewEr
  ]);

  assert.equal(aggregate.value, 0.01485148514851485);
  assert.equal(aggregate.numerator, 15);
  assert.equal(aggregate.denominator, 1010);
  assert.equal(aggregate.availableRecordCount, 2);
  assert.equal(aggregate.totalRecordCount, 2);
  assert.equal(aggregate.coverage, 1);
  assert.notEqual(aggregate.value, 0.255);
});

test('aggregate ratios retain unknown rows in coverage without treating them as zero', () => {
  const { calculatePerformanceMetrics, aggregateRatio } = loadMetrics();
  const availableInput = happyInput();
  const unknownInput = happyInput();
  delete unknownInput.observations.views;

  const aggregate = aggregateRatio([
    calculatePerformanceMetrics(availableInput).coreViewEr,
    calculatePerformanceMetrics(unknownInput).coreViewEr
  ]);

  assert.equal(aggregate.value, 0.1);
  assert.equal(aggregate.numerator, 100);
  assert.equal(aggregate.denominator, 1000);
  assert.equal(aggregate.availableRecordCount, 1);
  assert.equal(aggregate.totalRecordCount, 2);
  assert.equal(aggregate.coverage, 0.5);
});

test('comparison eligibility includes the exact 80 percent coverage boundary', () => {
  const { calculatePerformanceMetrics, assessComparisonEligibility } = loadMetrics();
  const available = calculatePerformanceMetrics(happyInput()).coreViewEr;
  const unknownInput = happyInput();
  unknownInput.observations.views = 0;
  const unknown = calculatePerformanceMetrics(unknownInput).coreViewEr;

  const result = assessComparisonEligibility([
    available,
    available,
    available,
    available,
    unknown
  ]);

  assert.deepEqual(result, {
    eligible: true,
    reason: null,
    coverage: 0.8,
    minimumCoverage: 0.8,
    comparableRecordCount: 4,
    excludedRecordCount: 1,
    totalRecordCount: 5,
    definitionVersion: EXPECTED_DEFINITION_VERSION,
    signature: {
      metric: 'core_view_er',
      denominatorBasis: 'views',
      componentSignature: 'likes+comments',
      costBasis: null,
      costComponentSignature: null,
      currency: null,
      attributionModel: null,
      attributionWindow: null,
      attributionIdentity: null,
      unit: 'ratio',
      scale: 1,
      definitionVersion: EXPECTED_DEFINITION_VERSION
    }
  });
});

test('comparison eligibility rejects coverage below 80 percent', () => {
  const { calculatePerformanceMetrics, assessComparisonEligibility } = loadMetrics();
  const available = calculatePerformanceMetrics(happyInput()).coreViewEr;
  const unknownInput = happyInput();
  delete unknownInput.observations.views;
  const unknown = calculatePerformanceMetrics(unknownInput).coreViewEr;

  const result = assessComparisonEligibility([available, available, available, unknown]);

  assert.equal(result.eligible, false);
  assert.equal(result.coverage, 0.75);
  assert.deepEqual(result.reason, {
    code: 'insufficient_metric_coverage',
    minimumCoverage: 0.8,
    actualCoverage: 0.75
  });
});

test('comparison eligibility rejects denominator, component, cost, and attribution signature mismatches', () => {
  const { calculatePerformanceMetrics, assessComparisonEligibility } = loadMetrics();
  const result = calculatePerformanceMetrics(happyInput());

  const denominatorMismatch = Object.assign({}, result.coreViewEr, {
    denominatorBasis: 'impressions'
  });
  assert.deepEqual(
    assessComparisonEligibility([result.coreViewEr, denominatorMismatch]).reason,
    {
      code: 'comparison_signature_mismatch',
      field: 'denominatorBasis',
      expected: 'views',
      actual: 'impressions'
    }
  );

  const componentMismatch = Object.assign({}, result.coreViewEr, {
    componentSignature: 'likes+comments+saves+shares'
  });
  assert.equal(
    assessComparisonEligibility([result.coreViewEr, componentMismatch]).reason.field,
    'componentSignature'
  );

  const costMismatch = Object.assign({}, result.roi, {
    costBasis: 'paid_media_spend'
  });
  assert.equal(
    assessComparisonEligibility([result.roi, costMismatch]).reason.field,
    'costBasis'
  );

  const modelMismatch = Object.assign({}, result.roi, {
    attributionModel: 'first_touch'
  });
  assert.equal(
    assessComparisonEligibility([result.roi, modelMismatch]).reason.field,
    'attributionModel'
  );

  const windowMismatch = Object.assign({}, result.roi, {
    attributionWindow: '7_days'
  });
  assert.equal(
    assessComparisonEligibility([result.roi, windowMismatch]).reason.field,
    'attributionWindow'
  );
});

test('calculation is deterministic and does not mutate its input', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  const before = structuredClone(input);

  const first = calculatePerformanceMetrics(input);
  const second = calculatePerformanceMetrics(input);

  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
});

test('absent and null cost basis default to total campaign cost while explicit unknown values fail', () => {
  const { calculatePerformanceMetrics } = loadMetrics();

  const absentInput = happyInput();
  delete absentInput.costBasis;
  const absent = calculatePerformanceMetrics(absentInput);
  assert.equal(absent.cpm.value, 600);
  assert.equal(absent.cpm.costBasis, 'total_campaign_cost');

  const nullInput = happyInput();
  nullInput.costBasis = null;
  const nullBasis = calculatePerformanceMetrics(nullInput);
  assert.equal(nullBasis.cpv.value, 1.2);
  assert.equal(nullBasis.cpv.costBasis, 'total_campaign_cost');

  const unknownInput = happyInput('blended_cost');
  const unknown = calculatePerformanceMetrics(unknownInput).cpm;
  assert.equal(unknown.value, null);
  assert.deepEqual(unknown.reason, { code: 'invalid_cost_basis', field: 'costBasis' });
});

test('all count observations require nonnegative safe integers while decimal money remains valid', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const reproductions = [
    ['views', 1.5, 'coreViewEr'],
    ['impressions', Number.MAX_SAFE_INTEGER + 1, 'impressionEr'],
    ['likes', 0.25, 'coreViewEr'],
    ['comments', Number.MAX_SAFE_INTEGER + 1, 'coreViewEr'],
    ['saves', 0.5, 'extendedViewEr'],
    ['shares', Number.MAX_SAFE_INTEGER + 1, 'extendedViewEr'],
    ['clicks', 1.5, 'ctr'],
    ['conversions', Number.MAX_SAFE_INTEGER + 1, 'cvr']
  ];

  reproductions.forEach(([field, value, metricKey]) => {
    const input = happyInput();
    input.observations[field] = value;
    const metric = calculatePerformanceMetrics(input)[metricKey];
    assert.equal(metric.value, null, field);
    assert.deepEqual(metric.reason, {
      code: 'invalid_nonnegative_safe_integer',
      field: 'observations.' + field
    }, field);
  });

  const decimalMoney = happyInput();
  decimalMoney.commercial.costs.creatorFee.amount = 500.25;
  assert.equal(calculatePerformanceMetrics(decimalMoney).totalCampaignCost.value, 1200.25);
});

test('financial arithmetic exposes exact decimal audit values instead of binary-float totals', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.commercial.costs.creatorFee.amount = 0.1;
  input.commercial.costs.productSampleCost.amount = 0.2;
  input.commercial.costs.logisticsCost.amount = 0;
  input.commercial.costs.paidMediaSpend.amount = 0.3;
  input.commercial.costs.platformAgencyFee.amount = 0;
  input.commercial.costs.otherCost.amount = 0;
  input.commercial.attributedRevenue.amount = 0.6;
  input.commercial.clientCharge.amount = 0.5;

  const result = calculatePerformanceMetrics(input);

  assert.equal(result.totalCampaignCost.value, 0.6);
  assert.equal(result.totalCampaignCost.exactValue, '0.6');
  assert.equal(result.totalCampaignCost.exactNumerator, '0.6');
  assert.equal(result.cpm.value, 0.3);
  assert.equal(result.cpm.exactValue, '0.3');
  assert.equal(result.roi.value, 0);
  assert.equal(result.roi.exactValue, '0');
  assert.equal(result.roas.value, 2);
  assert.equal(result.roas.exactValue, '2');
  assert.equal(result.grossMarginRate.value, -0.2);
  assert.equal(result.grossMarginRate.exactValue, '-0.2');
});

test('comparison binds metric, unit, scale, definition, and all basis identities', () => {
  const { calculatePerformanceMetrics, assessComparisonEligibility } = loadMetrics();
  const metric = calculatePerformanceMetrics(happyInput()).roi;

  const unitMismatch = structuredClone(metric);
  unitMismatch.unit = 'percent';
  assert.deepEqual(
    assessComparisonEligibility([metric, unitMismatch]).reason,
    {
      code: 'comparison_signature_mismatch',
      field: 'unit',
      expected: 'ratio',
      actual: 'percent'
    }
  );

  const scaleMismatch = structuredClone(metric);
  scaleMismatch.scale = 100;
  assert.deepEqual(
    assessComparisonEligibility([metric, scaleMismatch]).reason,
    {
      code: 'comparison_signature_mismatch',
      field: 'scale',
      expected: 1,
      actual: 100
    }
  );

  const metricMismatch = structuredClone(metric);
  metricMismatch.metric = 'roas';
  assert.deepEqual(
    assessComparisonEligibility([metric, metricMismatch]).reason,
    {
      code: 'comparison_signature_mismatch',
      field: 'metric',
      expected: 'roi',
      actual: 'roas'
    }
  );

  const attributionMismatch = structuredClone(metric);
  attributionMismatch.attributionIdentity = 'last_touch|30_days|attribution-policy-v2';
  assert.deepEqual(
    assessComparisonEligibility([metric, attributionMismatch]).reason,
    {
      code: 'comparison_signature_mismatch',
      field: 'attributionIdentity',
      expected: 'last_touch|30_days|attribution-policy-v1',
      actual: 'last_touch|30_days|attribution-policy-v2'
    }
  );
});

test('comparison fails closed on malformed metrics and rejects non-current definitions', () => {
  const { calculatePerformanceMetrics, assessComparisonEligibility } = loadMetrics();
  const metric = calculatePerformanceMetrics(happyInput()).coreViewEr;

  const malformed = structuredClone(metric);
  delete malformed.unit;
  const malformedResult = assessComparisonEligibility([malformed]);
  assert.equal(malformedResult.eligible, false);
  assert.deepEqual(malformedResult.reason, {
    code: 'malformed_metric_shape',
    index: 0,
    field: 'unit'
  });

  const stale = structuredClone(metric);
  stale.definitionVersion = 'phase7b.1-kpi-v0';
  const staleResult = assessComparisonEligibility([stale]);
  assert.equal(staleResult.eligible, false);
  assert.deepEqual(staleResult.reason, {
    code: 'non_current_definition_version',
    index: 0,
    expected: EXPECTED_DEFINITION_VERSION,
    actual: 'phase7b.1-kpi-v0'
  });
  assert.equal(staleResult.definitionVersion, 'phase7b.1-kpi-v0');
});

test('aggregation fails closed on malformed metrics and never relabels stale definitions', () => {
  const { calculatePerformanceMetrics, aggregateRatio } = loadMetrics();
  const metric = calculatePerformanceMetrics(happyInput()).coreViewEr;

  const malformed = structuredClone(metric);
  delete malformed.exactNumerator;
  const malformedResult = aggregateRatio([malformed]);
  assert.equal(malformedResult.value, null);
  assert.deepEqual(malformedResult.reason, {
    code: 'malformed_metric_shape',
    index: 0,
    field: 'exactNumerator'
  });

  const stale = structuredClone(metric);
  stale.definitionVersion = 'phase7b.1-kpi-v0';
  const staleResult = aggregateRatio([stale]);
  assert.equal(staleResult.value, null);
  assert.equal(staleResult.reason.code, 'non_current_definition_version');
  assert.equal(staleResult.definitionVersion, 'phase7b.1-kpi-v0');
  assert.notEqual(staleResult.definitionVersion, EXPECTED_DEFINITION_VERSION);
});

test('aggregate ratios collect cloned deduplicated lineage and currency evidence from every available row', () => {
  const { calculatePerformanceMetrics, aggregateRatio } = loadMetrics();
  const firstInput = happyInput();
  firstInput.auditLineage = [
    { sourceSystem: 'provider', sourceRecordId: 'shared' },
    { sourceSystem: 'provider', sourceRecordId: 'row-1' }
  ];
  firstInput.commercial.costs.creatorFee = approvedMoney(250, 'EUR');
  firstInput.commercial.costs.creatorFee.fxEvidence = approvedFxEvidence(
    'EUR',
    'USD',
    2,
    'fx_source_eur'
  );

  const secondInput = happyInput();
  secondInput.auditLineage = [
    { sourceSystem: 'provider', sourceRecordId: 'shared' },
    { sourceSystem: 'provider', sourceRecordId: 'row-2' }
  ];
  secondInput.commercial.costs.creatorFee = approvedMoney(400, 'GBP');
  secondInput.commercial.costs.creatorFee.fxEvidence = Object.assign(
    approvedFxEvidence('GBP', 'USD', 1.25, 'fx_source_gbp'),
    { approvalId: 'fx-approval-2' }
  );

  deepFreeze(firstInput);
  deepFreeze(secondInput);
  const firstMetric = calculatePerformanceMetrics(firstInput).cpm;
  const secondMetric = calculatePerformanceMetrics(secondInput).cpm;
  deepFreeze(firstMetric);
  deepFreeze(secondMetric);

  const aggregate = aggregateRatio([firstMetric, secondMetric]);

  assert.equal(aggregate.value, 600);
  assert.deepEqual(aggregate.auditLineage, [
    { sourceSystem: 'provider', sourceRecordId: 'shared' },
    { sourceSystem: 'provider', sourceRecordId: 'row-1' },
    { sourceSystem: 'provider', sourceRecordId: 'row-2' }
  ]);
  assert.equal(aggregate.currencyEvidence.length, 2);
  assert.deepEqual(
    aggregate.currencyEvidence.map((evidence) => evidence.source),
    ['fx_source_eur', 'fx_source_gbp']
  );
  assert.notStrictEqual(aggregate.auditLineage[0], firstMetric.auditLineage[0]);
  assert.notStrictEqual(aggregate.currencyEvidence[0], firstMetric.currencyEvidence[0]);

  aggregate.auditLineage[0].sourceRecordId = 'mutated';
  aggregate.currencyEvidence[0].source = 'mutated';
  assert.equal(firstMetric.auditLineage[0].sourceRecordId, 'shared');
  assert.equal(firstMetric.currencyEvidence[0].source, 'fx_source_eur');
});

test('FX evidence requires canonical effective and approval timestamps plus approval provenance', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.commercial.costs.creatorFee = approvedMoney(250, 'EUR');
  input.commercial.costs.creatorFee.fxEvidence = approvedFxEvidence('EUR', 'USD', 2);

  input.commercial.costs.creatorFee.fxEvidence.effectiveAt = '2026-02-30T00:00:00Z';
  let metric = calculatePerformanceMetrics(input).totalCampaignCost;
  assert.equal(metric.value, null);
  assert.deepEqual(metric.reason, {
    code: 'invalid_canonical_timestamp',
    field: 'commercial.costs.creatorFee.fxEvidence.effectiveAt'
  });

  input.commercial.costs.creatorFee.fxEvidence = approvedFxEvidence('EUR', 'USD', 2);
  input.commercial.costs.creatorFee.fxEvidence.approvedAt = '2026-07-30T09:00:00+08:00';
  metric = calculatePerformanceMetrics(input).totalCampaignCost;
  assert.equal(metric.value, null);
  assert.deepEqual(metric.reason, {
    code: 'invalid_canonical_timestamp',
    field: 'commercial.costs.creatorFee.fxEvidence.approvedAt'
  });

  input.commercial.costs.creatorFee.fxEvidence = approvedFxEvidence('EUR', 'USD', 2);
  delete input.commercial.costs.creatorFee.fxEvidence.approvalId;
  metric = calculatePerformanceMetrics(input).totalCampaignCost;
  assert.equal(metric.value, null);
  assert.deepEqual(metric.reason, {
    code: 'missing_approval_provenance',
    field: 'commercial.costs.creatorFee.fxEvidence.approvalId'
  });
});

test('attribution validates and retains model window and approval provenance', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const available = calculatePerformanceMetrics(happyInput()).roi;

  assert.equal(available.attributionIdentity, 'last_touch|30_days|attribution-policy-v1');
  assert.deepEqual(available.attributionEvidence, {
    model: 'last_touch',
    window: '30_days',
    approvalState: 'approved',
    approvalId: 'attribution-approval-1',
    approvedBy: 'attribution-actor-1',
    approvedAt: '2026-07-30T01:00:00Z',
    policyVersion: 'attribution-policy-v1'
  });

  const invalidInput = happyInput();
  invalidInput.commercial.attribution.approvedAt = '2026-02-30T00:00:00Z';
  const invalid = calculatePerformanceMetrics(invalidInput);
  assert.equal(invalid.roi.value, null);
  assert.equal(invalid.roas.value, null);
  assert.deepEqual(invalid.roi.reason, {
    code: 'invalid_canonical_timestamp',
    field: 'commercial.attribution.approvedAt'
  });
});

test('gross margin is explicitly internal restricted-financial output', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const metric = calculatePerformanceMetrics(happyInput()).grossMarginRate;

  assert.deepEqual(metric.visibility, {
    scope: 'internal',
    classification: 'restricted_financial',
    customerSafe: false
  });
});

test('exported helpers accept deep-frozen inputs and never alias nested caller metadata', () => {
  const metrics = loadMetrics();
  const input = happyInput();
  input.auditLineage = [{ sourceSystem: 'provider', sourceRecordId: 'frozen-row' }];
  input.commercial.costs.creatorFee = approvedMoney(250, 'EUR');
  input.commercial.costs.creatorFee.fxEvidence = approvedFxEvidence('EUR', 'USD', 2);
  deepFreeze(input);

  const result = metrics.calculatePerformanceMetrics(input);
  const observed = metrics.calculateObservedEngagement(
    input.observations,
    deepFreeze(['likes', 'comments'])
  );
  const frozenMetrics = deepFreeze([result.coreViewEr, result.coreViewEr]);
  const aggregate = metrics.aggregateRatio(frozenMetrics);
  const eligibility = metrics.assessComparisonEligibility(frozenMetrics);

  assert.equal(observed.value, 100);
  assert.equal(aggregate.value, 0.1);
  assert.equal(eligibility.eligible, true);
  assert.equal(Object.isFrozen(metrics.INTERACTION_COMPONENTS), true);
  assert.equal(Object.isFrozen(metrics.COST_BASES), true);
  assert.deepEqual(result.cpm.auditLineage, input.auditLineage);
  assert.equal(result.cpm.currencyEvidence.length, 1);
  assert.equal(typeof result.roi.attributionEvidence, 'object');
  assert.notStrictEqual(result.cpm.auditLineage[0], input.auditLineage[0]);
  assert.notStrictEqual(
    result.cpm.currencyEvidence[0],
    input.commercial.costs.creatorFee.fxEvidence
  );
  assert.notStrictEqual(result.roi.attributionEvidence, input.commercial.attribution);

  result.cpm.auditLineage[0].sourceRecordId = 'mutated-output';
  result.cpm.currencyEvidence[0].source = 'mutated-output';
  result.roi.attributionEvidence.model = 'mutated-output';
  assert.equal(input.auditLineage[0].sourceRecordId, 'frozen-row');
  assert.equal(input.commercial.costs.creatorFee.fxEvidence.source, 'approved_test_rate');
  assert.equal(input.commercial.attribution.model, 'last_touch');
});

test('amount exactValue preserves decimal precision above safe-integer granularity', () => {
  const { calculatePerformanceMetrics } = loadMetrics();
  const input = happyInput();
  input.commercial.costs.creatorFee.amount = Number.MAX_SAFE_INTEGER;
  input.commercial.costs.productSampleCost.amount = 0.1;
  input.commercial.costs.logisticsCost.amount = 0;
  input.commercial.costs.paidMediaSpend.amount = 0;
  input.commercial.costs.platformAgencyFee.amount = 0;
  input.commercial.costs.otherCost.amount = 0;

  const metric = calculatePerformanceMetrics(input).totalCampaignCost;

  assert.equal(metric.value, Number.MAX_SAFE_INTEGER);
  assert.equal(metric.exactNumerator, '9007199254740991.1');
  assert.equal(metric.exactValue, '9007199254740991.1');
});

test('ratio consumers reject every numeric or exact field when it is independently tampered', () => {
  const { calculatePerformanceMetrics, aggregateRatio, assessComparisonEligibility } = loadMetrics();
  const metric = calculatePerformanceMetrics(happyInput()).coreViewEr;
  const mutations = [
    ['value', (candidate) => { candidate.value = 0.2; }],
    ['exactValue', (candidate) => { candidate.exactValue = '1/11'; }],
    ['numerator', (candidate) => { candidate.numerator = 101; }],
    ['exactNumerator', (candidate) => { candidate.exactNumerator = '101'; }],
    ['denominator', (candidate) => { candidate.denominator = 1001; }],
    ['exactDenominator', (candidate) => { candidate.exactDenominator = '1001'; }]
  ];

  mutations.forEach(([field, mutate]) => {
    const candidate = structuredClone(metric);
    mutate(candidate);

    const aggregate = aggregateRatio([candidate]);
    assert.equal(aggregate.value, null, field + ' aggregate');
    assert.equal(aggregate.reason.code, 'malformed_metric_shape', field + ' aggregate reason');
    assert.equal(aggregate.reason.field, field, field + ' aggregate field');

    const comparison = assessComparisonEligibility([candidate]);
    assert.equal(comparison.eligible, false, field + ' comparison');
    assert.equal(comparison.reason.code, 'malformed_metric_shape', field + ' comparison reason');
    assert.equal(comparison.reason.field, field, field + ' comparison field');
  });
});

test('amount consumers reject independently tampered value and exact numerator fields', () => {
  const { calculatePerformanceMetrics, assessComparisonEligibility } = loadMetrics();
  const metric = calculatePerformanceMetrics(happyInput()).totalCampaignCost;
  const mutations = [
    ['value', (candidate) => { candidate.value = 1201; }],
    ['exactValue', (candidate) => { candidate.exactValue = '1201'; }],
    ['numerator', (candidate) => { candidate.numerator = 1201; }],
    ['exactNumerator', (candidate) => { candidate.exactNumerator = '1201'; }]
  ];

  mutations.forEach(([field, mutate]) => {
    const candidate = structuredClone(metric);
    mutate(candidate);
    const result = assessComparisonEligibility([candidate]);
    assert.equal(result.eligible, false, field);
    assert.equal(result.reason.code, 'malformed_metric_shape', field + ' reason');
    assert.equal(result.reason.field, field, field + ' field');
  });
});

test('metric contracts reject coherent ratio-to-amount and amount-to-ratio shape changes', () => {
  const { calculatePerformanceMetrics, assessComparisonEligibility } = loadMetrics();
  const metrics = calculatePerformanceMetrics(happyInput());

  const ratioAsAmount = structuredClone(metrics.coreViewEr);
  ratioAsAmount.denominator = null;
  ratioAsAmount.exactDenominator = null;
  ratioAsAmount.value = ratioAsAmount.numerator;
  ratioAsAmount.exactValue = ratioAsAmount.exactNumerator;
  const ratioResult = assessComparisonEligibility([ratioAsAmount]);
  assert.equal(ratioResult.eligible, false);
  assert.equal(ratioResult.reason.field, 'denominator');

  const amountAsRatio = structuredClone(metrics.totalCampaignCost);
  amountAsRatio.denominator = 1;
  amountAsRatio.exactDenominator = '1';
  const amountResult = assessComparisonEligibility([amountAsRatio]);
  assert.equal(amountResult.eligible, false);
  assert.equal(amountResult.reason.field, 'denominator');
});

test('heterogeneous unavailable records fail closed instead of entering another KPI coverage group', () => {
  const { calculatePerformanceMetrics, aggregateRatio, assessComparisonEligibility } = loadMetrics();
  const coreInput = happyInput();
  coreInput.auditLineage = [{ sourceRecordId: 'core-row' }];
  const core = calculatePerformanceMetrics(coreInput).coreViewEr;
  const unavailableInput = happyInput();
  unavailableInput.auditLineage = [{ sourceRecordId: 'roas-unavailable-row' }];
  unavailableInput.commercial.attributedRevenue.approvalState = 'pending';
  const unavailableRoas = calculatePerformanceMetrics(unavailableInput).roas;

  const comparison = assessComparisonEligibility([core, core, core, core, unavailableRoas]);
  assert.equal(comparison.eligible, false);
  assert.equal(comparison.coverage, 0);
  assert.equal(comparison.comparableRecordCount, 0);
  assert.deepEqual(comparison.reason, {
    code: 'comparison_signature_mismatch',
    field: 'metric',
    expected: 'core_view_er',
    actual: 'roas'
  });

  const aggregate = aggregateRatio([core, unavailableRoas]);
  assert.equal(aggregate.value, null);
  assert.equal(aggregate.coverage, 0);
  assert.equal(aggregate.availableRecordCount, 0);
  assert.equal(aggregate.reason.code, 'comparison_signature_mismatch');
  assert.equal(aggregate.reason.field, 'metric');
  assert.deepEqual(aggregate.auditLineage, [
    { sourceRecordId: 'core-row' },
    { sourceRecordId: 'roas-unavailable-row' }
  ]);
});

test('financial aggregates enforce intrinsic cost, revenue, charge, and visibility identities', () => {
  const { calculatePerformanceMetrics, aggregateRatio } = loadMetrics();
  const metrics = calculatePerformanceMetrics(happyInput());
  const mutations = [
    ['costComponentSignature', metrics.roi, (candidate) => {
      candidate.costComponentSignature = 'paid_media_spend';
    }],
    ['revenueBasis', metrics.roi, (candidate) => {
      candidate.revenueBasis = 'unapproved_revenue';
    }],
    ['chargeBasis', metrics.grossMarginRate, (candidate) => {
      candidate.chargeBasis = 'approved_attributed_revenue';
    }],
    ['visibility.scope', metrics.grossMarginRate, (candidate) => {
      candidate.visibility.scope = 'customer';
    }],
    ['visibility.classification', metrics.grossMarginRate, (candidate) => {
      candidate.visibility.classification = 'public';
    }],
    ['visibility.customerSafe', metrics.grossMarginRate, (candidate) => {
      candidate.visibility.customerSafe = true;
    }]
  ];

  mutations.forEach(([field, source, mutate]) => {
    const candidate = structuredClone(source);
    mutate(candidate);
    const aggregate = aggregateRatio([candidate]);
    assert.equal(aggregate.value, null, field);
    assert.equal(aggregate.reason.code, 'malformed_metric_shape', field + ' reason');
    assert.equal(aggregate.reason.field, field, field + ' field');
  });
});

test('ROI and ROAS aggregates revalidate complete approved attribution evidence on every row', () => {
  const { calculatePerformanceMetrics, aggregateRatio } = loadMetrics();
  const roi = calculatePerformanceMetrics(happyInput()).roi;
  const mutations = [
    ['attributionEvidence', (candidate) => { delete candidate.attributionEvidence; }],
    ['attributionEvidence.approvalState', (candidate) => {
      candidate.attributionEvidence.approvalState = 'pending';
    }],
    ['attributionEvidence.approvedBy', (candidate) => {
      delete candidate.attributionEvidence.approvedBy;
    }],
    ['attributionEvidence.approvedAt', (candidate) => {
      candidate.attributionEvidence.approvedAt = '2026-02-30T00:00:00Z';
    }],
    ['attributionEvidence.model', (candidate) => {
      candidate.attributionEvidence.model = 'first_touch';
    }],
    ['attributionEvidence.policyVersion', (candidate) => {
      candidate.attributionEvidence.policyVersion = 'attribution-policy-v2';
    }]
  ];

  mutations.forEach(([field, mutate]) => {
    const candidate = structuredClone(roi);
    mutate(candidate);
    const aggregate = aggregateRatio([roi, candidate]);
    assert.equal(aggregate.value, null, field);
    assert.equal(aggregate.reason.code, 'malformed_metric_shape', field + ' reason');
    assert.equal(aggregate.reason.field, field, field + ' field');
  });
});

test('currency evidence is validated item by item and cannot be replaced by a trusted row label', () => {
  const { calculatePerformanceMetrics, aggregateRatio, assessComparisonEligibility } = loadMetrics();
  const input = happyInput();
  input.commercial.costs.creatorFee = approvedMoney(250, 'EUR');
  input.commercial.costs.creatorFee.fxEvidence = approvedFxEvidence('EUR', 'USD', 2);
  const metric = calculatePerformanceMetrics(input).cpm;
  const mutations = [
    ['currencyEvidence[0].rate', (candidate) => { candidate.currencyEvidence[0].rate = 3; }],
    ['currencyEvidence[0].exactRate', (candidate) => {
      candidate.currencyEvidence[0].exactRate = '3';
    }],
    ['currencyEvidence[0].toCurrency', (candidate) => {
      candidate.currencyEvidence[0].toCurrency = 'EUR';
    }],
    ['currencyEvidence[0].approvalState', (candidate) => {
      candidate.currencyEvidence[0].approvalState = 'pending';
    }],
    ['currencyEvidence[0].source', (candidate) => { candidate.currencyEvidence[0].source = ''; }],
    ['currencyEvidence[0].approvedAt', (candidate) => {
      candidate.currencyEvidence[0].approvedAt = '2026-02-30T00:00:00Z';
    }],
    ['currencyEvidence[0].approvalId', (candidate) => {
      delete candidate.currencyEvidence[0].approvalId;
    }]
  ];

  mutations.forEach(([field, mutate]) => {
    const candidate = structuredClone(metric);
    mutate(candidate);
    const aggregate = aggregateRatio([metric, candidate]);
    assert.equal(aggregate.value, null, field);
    assert.equal(aggregate.reason.code, 'malformed_metric_shape', field + ' reason');
    assert.match(aggregate.reason.field, /^currencyEvidence\[0\]/, field + ' field');
  });

  const relabeled = structuredClone(metric);
  relabeled.currency = 'EUR';
  const relabeledResult = assessComparisonEligibility([relabeled]);
  assert.equal(relabeledResult.eligible, false);
  assert.equal(relabeledResult.reason.field, 'currencyEvidence[0].toCurrency');
});

test('aggregate audit and currency evidence include unavailable rows and deeply clone nested metadata', () => {
  const { calculatePerformanceMetrics, aggregateRatio } = loadMetrics();
  const firstInput = happyInput();
  firstInput.auditLineage = [{
    sourceRecordId: 'available-row',
    metadata: { batch: { id: 'batch-1', tags: [{ name: 'verified' }] } }
  }];
  firstInput.commercial.costs.creatorFee = approvedMoney(250, 'EUR');
  firstInput.commercial.costs.creatorFee.fxEvidence = approvedFxEvidence(
    'EUR',
    'USD',
    2,
    'available_fx'
  );

  const secondInput = happyInput();
  secondInput.auditLineage = [{
    sourceRecordId: 'unavailable-row',
    metadata: { batch: { id: 'batch-2', tags: [{ name: 'missing-impressions' }] } }
  }];
  secondInput.commercial.costs.creatorFee = approvedMoney(400, 'GBP');
  secondInput.commercial.costs.creatorFee.fxEvidence = Object.assign(
    approvedFxEvidence('GBP', 'USD', 1.25, 'unavailable_fx'),
    { approvalId: 'fx-approval-2' }
  );
  delete secondInput.observations.impressions;

  const firstMetric = calculatePerformanceMetrics(firstInput).cpm;
  const secondMetric = calculatePerformanceMetrics(secondInput).cpm;
  firstMetric.currencyEvidence[0].metadata = { provider: { request: { id: 'fx-request-1' } } };
  secondMetric.currencyEvidence[0].metadata = { provider: { request: { id: 'fx-request-2' } } };
  deepFreeze(firstMetric);
  deepFreeze(secondMetric);

  const aggregate = aggregateRatio([firstMetric, secondMetric]);

  assert.equal(aggregate.value, 600);
  assert.equal(aggregate.coverage, 0.5);
  assert.deepEqual(
    aggregate.auditLineage.map((lineage) => lineage.sourceRecordId),
    ['available-row', 'unavailable-row']
  );
  assert.deepEqual(
    aggregate.currencyEvidence.map((evidence) => evidence.source),
    ['available_fx', 'unavailable_fx']
  );
  assert.notStrictEqual(
    aggregate.auditLineage[0].metadata.batch.tags[0],
    firstMetric.auditLineage[0].metadata.batch.tags[0]
  );
  assert.notStrictEqual(
    aggregate.currencyEvidence[1].metadata.provider.request,
    secondMetric.currencyEvidence[0].metadata.provider.request
  );

  aggregate.auditLineage[0].metadata.batch.tags[0].name = 'mutated';
  aggregate.currencyEvidence[1].metadata.provider.request.id = 'mutated';
  assert.equal(firstMetric.auditLineage[0].metadata.batch.tags[0].name, 'verified');
  assert.equal(secondMetric.currencyEvidence[0].metadata.provider.request.id, 'fx-request-2');
});

test('all-unavailable same-KPI aggregates retain identity, lineage, and explicit grouping', () => {
  const { calculatePerformanceMetrics, aggregateRatio, assessComparisonEligibility } = loadMetrics();
  const firstInput = happyInput();
  firstInput.auditLineage = [{ sourceRecordId: 'unknown-1' }];
  delete firstInput.observations.views;
  const secondInput = happyInput();
  secondInput.auditLineage = [{ sourceRecordId: 'unknown-2' }];
  secondInput.observations.views = 0;
  const first = calculatePerformanceMetrics(firstInput).coreViewEr;
  const second = calculatePerformanceMetrics(secondInput).coreViewEr;

  const aggregate = aggregateRatio([first, second]);
  assert.equal(aggregate.value, null);
  assert.equal(aggregate.metric, 'core_view_er');
  assert.equal(aggregate.denominatorBasis, 'views');
  assert.equal(aggregate.componentSignature, 'likes+comments');
  assert.deepEqual(aggregate.auditLineage, [
    { sourceRecordId: 'unknown-1' },
    { sourceRecordId: 'unknown-2' }
  ]);

  const comparison = assessComparisonEligibility([first, second]);
  assert.equal(comparison.eligible, false);
  assert.equal(comparison.signature.metric, 'core_view_er');
  assert.equal(comparison.signature.denominatorBasis, 'views');
  assert.equal(comparison.comparableRecordCount, 0);
});

[
  ['an empty reason object', () => ({})],
  ['a reason missing code', () => ({ detail: 'missing-code' })],
  ['an inherited reason code', () => Object.create({ code: 'inherited_code' })],
  ['an empty-string reason code', () => ({ code: '   ' })],
  ['a non-string reason code', () => ({ code: 42 })]
].forEach(([caseName, reasonFactory]) => {
  test('unavailable metric consumers reject ' + caseName, () => {
    const { calculatePerformanceMetrics, aggregateRatio, assessComparisonEligibility } = loadMetrics();
    const input = happyInput();
    input.observations.views = 0;
    const candidate = calculatePerformanceMetrics(input).coreViewEr;
    candidate.reason = reasonFactory();

    const aggregate = aggregateRatio([candidate]);
    assert.equal(aggregate.value, null);
    assert.deepEqual(aggregate.reason, {
      code: 'malformed_metric_shape',
      index: 0,
      field: 'reason.code'
    });

    const comparison = assessComparisonEligibility([candidate]);
    assert.equal(comparison.eligible, false);
    assert.deepEqual(comparison.reason, aggregate.reason);
  });
});

test('an available metric flipped to unavailable cannot use an empty reason', () => {
  const { calculatePerformanceMetrics, aggregateRatio, assessComparisonEligibility } = loadMetrics();
  const candidate = calculatePerformanceMetrics(happyInput()).coreViewEr;
  candidate.available = false;
  candidate.value = null;
  candidate.exactValue = null;
  candidate.reason = {};

  const aggregate = aggregateRatio([candidate]);
  assert.equal(aggregate.value, null);
  assert.deepEqual(aggregate.reason, {
    code: 'malformed_metric_shape',
    index: 0,
    field: 'reason.code'
  });
  const comparison = assessComparisonEligibility([candidate]);
  assert.equal(comparison.eligible, false);
  assert.deepEqual(comparison.reason, aggregate.reason);
});

test('unavailable reason accepts additional nested audit details', () => {
  const { calculatePerformanceMetrics, aggregateRatio, assessComparisonEligibility } = loadMetrics();
  const available = calculatePerformanceMetrics(happyInput()).coreViewEr;
  const input = happyInput();
  input.observations.views = 0;
  const unavailable = calculatePerformanceMetrics(input).coreViewEr;
  unavailable.reason.details = {
    source: { system: 'provider', checks: [{ name: 'views', passed: false }] }
  };

  const aggregate = aggregateRatio([available, unavailable]);
  assert.equal(aggregate.value, 0.1);
  assert.equal(aggregate.coverage, 0.5);
  const comparison = assessComparisonEligibility([
    available,
    available,
    available,
    available,
    unavailable
  ]);
  assert.equal(comparison.eligible, true);
  assert.equal(comparison.coverage, 0.8);
});

test('exact rational outputs stay reduced for rows, scales, and aggregates', () => {
  const metrics = process.env[NUMBER_FALLBACK_MUTANT_ENV] === '1'
    ? loadNumberFallbackMutant()
    : loadMetrics();

  assert.deepEqual(exactRationalValues(metrics), {
    oneThird: '1/3',
    reducedWeighted: '3/202',
    scaledNonTerminating: '1000/3',
    scaledAggregate: '3000/7'
  });
});

test('the in-memory Number fallback mutant violates every exact rational output', () => {
  const actual = exactRationalValues(loadNumberFallbackMutant());
  const expected = {
    oneThird: '1/3',
    reducedWeighted: '3/202',
    scaledNonTerminating: '1000/3',
    scaledAggregate: '3000/7'
  };

  Object.keys(expected).forEach((field) => {
    assert.notEqual(actual[field], expected[field], field);
  });
});
