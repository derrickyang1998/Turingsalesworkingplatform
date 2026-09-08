'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLLABORATION_ORDER_SCHEMA,
  COLLABORATION_ORDER_V2_SCHEMA,
  normalizeCollaborationResource,
  serializeCollaborationResource,
  resolveResourceQuotedPrice
} = require('../services/collaboration_resource_contract');

test('normalizes a collaboration resource into the v1 order contract', () => {
  const resource = normalizeCollaborationResource({
    schema: COLLABORATION_ORDER_SCHEMA,
    project_name: '  Autumn launch  ',
    product_name: ' Portable power station ',
    order_type: 'affiliate',
    order_reference: ' PO-501 ',
    deliverable: ' 1 short video + 1 story ',
    quoted_price: '1200'
  });

  assert.deepEqual(resource, {
    schema: COLLABORATION_ORDER_SCHEMA,
    project_name: 'Autumn launch',
    product_name: 'Portable power station',
    order_type: 'affiliate',
    order_reference: 'PO-501',
    deliverable: '1 short video + 1 story',
    quoted_price: 1200
  });
  assert.equal(serializeCollaborationResource(resource), JSON.stringify(resource));
});

test('resource contract keeps bounded v1 scalar extension fields', () => {
  assert.deepEqual(normalizeCollaborationResource({
    schema: COLLABORATION_ORDER_SCHEMA,
    owner: 'Derrick',
    price: '3200'
  }), {
    schema: COLLABORATION_ORDER_SCHEMA,
    project_name: '',
    product_name: '',
    order_type: 'paid',
    order_reference: '',
    deliverable: '',
    quoted_price: 3200,
    extensions: { owner: 'Derrick' }
  });
});

test('resource contract rejects an invalid type, nested extension, and unsafe price', () => {
  assert.throws(
    () => normalizeCollaborationResource({ schema: COLLABORATION_ORDER_SCHEMA, order_type: 'barter' }),
    (error) => error && error.code === 'INVALID_RESOURCE_TYPE'
  );
  assert.throws(
    () => normalizeCollaborationResource({ schema: COLLABORATION_ORDER_SCHEMA, owner: { name: 'Derrick' } }),
    (error) => error && error.code === 'INVALID_RESOURCE_FIELD'
  );
  assert.throws(
    () => normalizeCollaborationResource({ schema: COLLABORATION_ORDER_SCHEMA, quoted_price: -1 }),
    (error) => error && error.code === 'INVALID_RESOURCE_PRICE'
  );
});

test('resource quote remains authoritative and rejects a conflicting top-level quote', () => {
  const resource = normalizeCollaborationResource({ schema: COLLABORATION_ORDER_SCHEMA, quoted_price: 3200 });
  assert.equal(resolveResourceQuotedPrice(resource, undefined), 3200);
  assert.equal(resolveResourceQuotedPrice(resource, '3200'), 3200);
  assert.throws(
    () => resolveResourceQuotedPrice(resource, 2800),
    (error) => error && error.code === 'RESOURCE_PRICE_MISMATCH'
  );
});

test('resource quote accepts whole amounts and rejects booleans, blanks, and fractional values', () => {
  assert.equal(normalizeCollaborationResource({ schema: COLLABORATION_ORDER_SCHEMA, quoted_price: '1200' }).quoted_price, 1200);
  for (const quotedPrice of [true, '', '12.345', 1200.5, 0.0000000005]) {
    assert.throws(
      () => normalizeCollaborationResource({ schema: COLLABORATION_ORDER_SCHEMA, quoted_price: quotedPrice }),
      (error) => error && error.code === 'INVALID_RESOURCE_PRICE'
    );
  }
});

test('resource quote accepts the same safe whole-number range as settlement costs', () => {
  const quotedPrice = Number.MAX_SAFE_INTEGER;
  assert.equal(
    normalizeCollaborationResource({
      schema: COLLABORATION_ORDER_SCHEMA,
      quoted_price: quotedPrice
    }).quoted_price,
    quotedPrice
  );
});

test('resource contract requires its explicit v1 schema', () => {
  assert.throws(
    () => normalizeCollaborationResource({ quoted_price: 1200 }),
    (error) => error && error.code === 'INVALID_RESOURCE_SCHEMA'
  );
});

test('normalizes a v2 commercial order and derives its positive margin', () => {
  const resource = normalizeCollaborationResource({
    schema: COLLABORATION_ORDER_V2_SCHEMA,
    project_name: '  Autumn launch  ',
    product_name: ' Portable power station ',
    order_type: 'retainer',
    order_reference: ' PO-502 ',
    deliverable: ' Four short videos per month ',
    creator_cost: '1200',
    client_quote: '1800',
    currency: 'USD',
    payment_terms: 'net_30'
  });

  assert.deepEqual(resource, {
    schema: COLLABORATION_ORDER_V2_SCHEMA,
    project_name: 'Autumn launch',
    product_name: 'Portable power station',
    order_type: 'retainer',
    order_reference: 'PO-502',
    deliverable: 'Four short videos per month',
    creator_cost: 1200,
    client_quote: 1800,
    currency: 'USD',
    margin_amount: 600,
    payment_terms: 'net_30'
  });
  assert.equal(resolveResourceQuotedPrice(resource, '1200'), 1200);
});

test('v2 commercial orders default required terms and retain a negative derived margin', () => {
  assert.deepEqual(normalizeCollaborationResource({
    schema: COLLABORATION_ORDER_V2_SCHEMA,
    creator_cost: 1800,
    client_quote: 1200
  }), {
    schema: COLLABORATION_ORDER_V2_SCHEMA,
    project_name: '',
    product_name: '',
    order_type: 'paid',
    order_reference: '',
    deliverable: '',
    creator_cost: 1800,
    client_quote: 1200,
    currency: 'CNY',
    margin_amount: -600,
    payment_terms: 'prepay_80_balance_20'
  });
});

test('v2 commercial orders reject invalid terms, conflicting margin, and unsafe amounts', () => {
  assert.throws(
    () => normalizeCollaborationResource({
      schema: COLLABORATION_ORDER_V2_SCHEMA,
      creator_cost: 1,
      client_quote: 2,
      currency: 'usd'
    }),
    (error) => error && error.code === 'INVALID_RESOURCE_CURRENCY'
  );
  assert.throws(
    () => normalizeCollaborationResource({
      schema: COLLABORATION_ORDER_V2_SCHEMA,
      creator_cost: 1,
      client_quote: 2,
      payment_terms: 'net_90'
    }),
    (error) => error && error.code === 'INVALID_RESOURCE_PAYMENT_TERMS'
  );
  assert.throws(
    () => normalizeCollaborationResource({
      schema: COLLABORATION_ORDER_V2_SCHEMA,
      creator_cost: 1,
      client_quote: 2,
      margin_amount: 2
    }),
    (error) => error && error.code === 'RESOURCE_MARGIN_MISMATCH'
  );
  assert.throws(
    () => normalizeCollaborationResource({
      schema: COLLABORATION_ORDER_V2_SCHEMA,
      creator_cost: Number.MAX_SAFE_INTEGER + 1,
      client_quote: 0
    }),
    (error) => error && error.code === 'INVALID_RESOURCE_PRICE'
  );
});

test('v2 commercial orders accept JavaScript-safe creator and client amounts', () => {
  const resource = normalizeCollaborationResource({
    schema: COLLABORATION_ORDER_V2_SCHEMA,
    creator_cost: 0,
    client_quote: Number.MAX_SAFE_INTEGER
  });
  assert.equal(resource.client_quote, Number.MAX_SAFE_INTEGER);
  assert.equal(resource.margin_amount, Number.MAX_SAFE_INTEGER);
});
