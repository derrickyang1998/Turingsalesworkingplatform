'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLLABORATION_ORDER_SCHEMA,
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
