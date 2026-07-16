const MIGRATION_SYNTHETIC = {
  engineVersion: 1,
  files: [
    { path: 'migrations/001.js', bytes: Buffer.from('one\n', 'utf8') },
    { path: 'migrations/engines/v1.js', bytes: Buffer.from('engine\n', 'utf8') }
  ],
  sha256: '2298da2cb6311ed6abf5afeb7463c31455a8a787cd5573cae558829540efc515'
};

const SQLITE_PRIMITIVES = {
  item: {
    label: 'x',
    payloadHex: '00ff',
    hex: '000178000000000000000200ff',
    sha256: '21c844be7352193e5feac7b34608234edfa4c09814657209c1fb1863d9b37a26'
  },
  row: {
    values: [null, 42n, -0, 'A', Buffer.from('00ff', 'hex')],
    hex: '000000000000003000000000000000054e49000000000000002a5280000000000000005400000000000000014142000000000000000200ff',
    sha256: '3af5ba80537e12943b9437d1522acb3e76b6915f3c7011c1cf2f78deba7a58c9'
  },
  fts: {
    manifest: {
      virtualName: 'demo_fts',
      projectionName: 'demo',
      tokenizerOptions: 'unicode61',
      keyColumnCsv: 'id',
      indexedColumnCsv: 'content'
    },
    rows: [[7n, 'hello']],
    sha256: '7d03905606fb63de02a7b3f07928268710e45c9a79b41f588e51b0455cccfbfe'
  },
  topologyFormatOnlySha256: '4a6620acacecfc9d9647e099a75d3b84560eb809a3f8c8abda02e506c2f7c57c'
};

const REQUEST_HASH_VECTORS = {
  json: {
    method: 'POST',
    path: '/api/campaigns/42/transitions',
    campaignId: 42,
    kind: 'json',
    payload: {
      expected_state: 'qualified',
      expected_version: 2,
      next_state: 'demand_confirmed',
      reason: 'Approved'
    },
    sha256: 'aea77f7479367197773322de619401340afed782ad5adc3d1a7c6645fa002d77'
  },
  empty: {
    method: 'POST',
    path: '/api/knowledge/88/use',
    campaignId: 42,
    kind: 'empty',
    payload: null,
    sha256: '4a4a49d347a01447646859fe9dc12ea863260832f6418336a40e32f58dcfa9de'
  },
  multipart: {
    method: 'POST',
    path: '/api/knowledge/upload',
    campaignId: 42,
    kind: 'multipart',
    payload: {
      parts: [
        { kind: 'text', fieldName: 'campaign_id', value: '42' },
        {
          kind: 'file',
          fieldName: 'file',
          basename: 'brief.csv',
          mime: 'text/csv',
          bytes: Buffer.from('a,b\n', 'utf8')
        }
      ]
    },
    sha256: '535cada37d03ecd97abf9536b5a92ea7829b7b5d978db57fe1225da98037858b'
  }
};

const AUDIT_FINGERPRINT_VECTOR = {
  organizationId: 1,
  actorUserId: 3,
  scope: 'campaign.transition',
  key: 'phase4-golden-key',
  requestHash: 'a'.repeat(64),
  reservationNonce: 'b'.repeat(64),
  sha256: '6b17b5d231db1cdda0f6ced85332497cd1d080683884380ac908031c192748e6'
};

module.exports = {
  MIGRATION_SYNTHETIC,
  SQLITE_PRIMITIVES,
  REQUEST_HASH_VECTORS,
  AUDIT_FINGERPRINT_VECTOR
};
