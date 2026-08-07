'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

function loadService() {
  try {
    return require('../services/publication_identity_service');
  } catch (error) {
    if (
      error &&
      error.code === 'MODULE_NOT_FOUND' &&
      String(error.message).includes('publication_identity_service')
    ) {
      assert.fail('publication identity service has not been implemented');
    }
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      assertDeepFrozen(descriptor.value, seen);
    }
  });
}

function expectServiceError(fn, expectedCode, expectedStatus, message) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'PublicationIdentityServiceError');
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, expectedStatus);
    assert.equal(error.statusCode, expectedStatus);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    assert.equal(typeof error.details, 'object');
    assertDeepFrozen(error.details);
    return true;
  }, message);
}

test('acceptance scenario 1 imports ten mixed links with stable row outcomes and first-index lineage', () => {
  const { admitPublicationBatch } = loadService();
  const input = [
    'https://www.tiktok.com/@Creator/video/7351234567890123456?utm_source=share',
    'https://instagram.com/reels/CODE_123/?igsh=tracking-value',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=social&t=43&list=PL123',
    'https://youtu.be/dQw4w9WgXcQ?list=PL123&t=43&si=share-token',
    'https://m.facebook.com/reel/123456789012345/?mibextid=share',
    'https://twitter.com/Alice/status/1781234567890123456?s=20',
    'https://x.com/i/web/status/1781234567890123456?t=share',
    'https://news.example.com/story?id=42&utm_medium=social',
    'not a url',
    'https://user:secret@www.instagram.com/p/CODE_999/'
  ];

  const result = admitPublicationBatch(input);

  assert.deepEqual(
    {
      total_count: result.total_count,
      accepted_count: result.accepted_count,
      rejected_count: result.rejected_count,
      duplicate_count: result.duplicate_count
    },
    { total_count: 10, accepted_count: 6, rejected_count: 2, duplicate_count: 2 }
  );
  assert.deepEqual(
    result.rows.map((row) => row.outcome),
    [
      'accepted',
      'accepted',
      'accepted',
      'duplicate',
      'accepted',
      'accepted',
      'duplicate',
      'accepted',
      'rejected',
      'rejected'
    ]
  );
  assert.deepEqual(
    result.rows.map((row) => row.first_index),
    [0, 1, 2, 2, 4, 5, 5, 7, null, null]
  );
  assert.deepEqual(
    result.rows.slice(0, 8).map((row) => row.platform),
    ['tiktok', 'instagram', 'youtube', 'youtube', 'facebook', 'x', 'x', 'custom_manual']
  );
  assert.equal(result.rows[0].canonical_url, 'https://www.tiktok.com/@creator/video/7351234567890123456');
  assert.equal(result.rows[1].canonical_url, 'https://www.instagram.com/reel/CODE_123/');
  assert.equal(
    result.rows[2].canonical_url,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=43'
  );
  assert.equal(result.rows[3].canonical_url, result.rows[2].canonical_url);
  assert.equal(result.rows[4].canonical_url, 'https://www.facebook.com/reel/123456789012345/');
  assert.equal(result.rows[5].canonical_url, 'https://x.com/i/web/status/1781234567890123456');
  assert.equal(result.rows[6].canonical_url, result.rows[5].canonical_url);
  assert.equal(result.rows[7].canonical_url, 'https://news.example.com/story?id=42');
  assert.equal(result.rows[3].original_url, input[3]);
  assert.equal(result.rows[6].original_url, input[6]);
  assert.equal(result.rows[8].error.code, 'PUBLICATION_URL_HTTPS_REQUIRED');
  assert.equal(result.rows[8].error.status, 400);
  assert.equal(result.rows[8].error.details.index, 8);
  assert.equal(result.rows[9].error.code, 'PUBLICATION_URL_CREDENTIALS_FORBIDDEN');
  assertDeepFrozen(result);
});

test('single admission exposes provable platform IDs and canonical platform identities', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    {
      url: 'https://m.tiktok.com/@Some.User/video/7351234567890123456/?lang=en',
      platform: 'tiktok',
      id: '7351234567890123456',
      canonical: 'https://www.tiktok.com/@some.user/video/7351234567890123456?lang=en'
    },
    {
      url: 'https://www.instagram.com/p/C0DE-abc_12/?locale=en',
      platform: 'instagram',
      id: 'C0DE-abc_12',
      canonical: 'https://www.instagram.com/p/C0DE-abc_12/?locale=en'
    },
    {
      url: 'https://youtu.be/dQw4w9WgXcQ?start=10',
      platform: 'youtube',
      id: 'dQw4w9WgXcQ',
      canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=10'
    },
    {
      url: 'https://www.facebook.com/watch/?v=123456789012345',
      platform: 'facebook',
      id: '123456789012345',
      canonical: 'https://www.facebook.com/watch/?v=123456789012345'
    },
    {
      url: 'https://mobile.twitter.com/person/statuses/1781234567890123456',
      platform: 'x',
      id: '1781234567890123456',
      canonical: 'https://x.com/i/web/status/1781234567890123456'
    }
  ];

  cases.forEach(({ url, platform, id, canonical }) => {
    const admitted = admitPublicationUrl(url);
    assert.deepEqual(admitted, {
      platform,
      platform_content_id: id,
      canonical_url: canonical,
      canonical_identity: platform + ':' + id,
      fingerprint: platform + ':' + id,
      identity_kind: 'platform_content_id',
      original_url: url
    });
    assertDeepFrozen(admitted);
  });
});

test('known YouTube, X, and Instagram equivalents normalize to the same identity', () => {
  const { admitPublicationUrl } = loadService();
  const youtube = [
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ'
  ].map(admitPublicationUrl);
  const instagram = [
    'https://instagram.com/reels/CODE_123',
    'https://www.instagram.com/reel/CODE_123/'
  ].map(admitPublicationUrl);
  const x = [
    'https://twitter.com/alice/status/1781234567890123456',
    'https://www.x.com/alice/statuses/1781234567890123456/photo/1',
    'https://x.com/i/web/status/1781234567890123456'
  ].map(admitPublicationUrl);

  assert.deepEqual(new Set(youtube.map((item) => item.canonical_url)), new Set([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  ]));
  assert.deepEqual(new Set(instagram.map((item) => item.canonical_url)), new Set([
    'https://www.instagram.com/reel/CODE_123/'
  ]));
  assert.deepEqual(new Set(x.map((item) => item.canonical_url)), new Set([
    'https://x.com/i/web/status/1781234567890123456'
  ]));
  assert.equal(new Set(youtube.map((item) => item.canonical_identity)).size, 1);
  assert.equal(new Set(instagram.map((item) => item.canonical_identity)).size, 1);
  assert.equal(new Set(x.map((item) => item.canonical_identity)).size, 1);
});

test('tracking removal is allowlisted while custom semantic query-pair order is retained', () => {
  const { admitPublicationUrl } = loadService();
  const original = [
    'https://news.example.com/item',
    '?sku=red',
    '&UtM_SoUrCe=creator',
    '&ref=affiliate',
    '&GCLID=click-id',
    '&MsClKiD=ad-click-id',
    '&sku=blue+large',
    '&tracking=keep-me',
    '&z=last',
    '&a=first'
  ].join('');

  const admitted = admitPublicationUrl(original);

  assert.equal(admitted.original_url, original);
  assert.equal(
    admitted.canonical_url,
    'https://news.example.com/item?sku=red&ref=affiliate&sku=blue+large&tracking=keep-me&z=last&a=first'
  );
  const digest = sha256(admitted.canonical_url);
  assert.equal(admitted.canonical_identity, 'sha256:' + digest);
  assert.equal(admitted.fingerprint, 'sha256:' + digest);
  assert.equal(admitted.identity_kind, 'canonical_url_sha256');
  assert.equal(admitted.platform, 'custom_manual');
  assert.equal(admitted.platform_content_id, null);
});

test('platform-specific tracking parameters do not erase YouTube semantic time and playlist values', () => {
  const { admitPublicationUrl } = loadService();
  const youtube = admitPublicationUrl(
    'https://www.youtube.com/watch?si=share&v=dQw4w9WgXcQ&t=43&s=semantic&list=PL123&feature=share'
  );
  const x = admitPublicationUrl(
    'https://x.com/alice/status/1781234567890123456?t=share&s=20&lang=zh-CN'
  );

  assert.equal(
    youtube.canonical_url,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&s=semantic&t=43'
  );
  assert.equal(
    x.canonical_url,
    'https://x.com/i/web/status/1781234567890123456?lang=zh-CN'
  );
});

test('platform query canonicalization preserves source order within repeated semantic names', () => {
  const { admitPublicationUrl } = loadService();
  const first = admitPublicationUrl(
    'https://www.youtube.com/watch?z=last&list=Z&utm_source=drop' +
      '&v=dQw4w9WgXcQ&a=second&list=A&feature=share&a=first&z=first'
  );
  const reorderedNamesAndTracking = admitPublicationUrl(
    'https://www.youtube.com/watch?feature=share&a=second&z=last&list=Z' +
      '&v=dQw4w9WgXcQ&utm_medium=drop&list=A&z=first&a=first'
  );
  const reversedListValues = admitPublicationUrl(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&a=second&a=first' +
      '&list=A&list=Z&z=last&z=first'
  );

  assert.equal(
    first.canonical_url,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ' +
      '&a=second&a=first&list=Z&list=A&z=last&z=first'
  );
  assert.equal(reorderedNamesAndTracking.canonical_url, first.canonical_url);
  assert.equal(reorderedNamesAndTracking.canonical_identity, first.canonical_identity);
  assert.equal(
    reversedListValues.canonical_url,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ' +
      '&a=second&a=first&list=A&list=Z&z=last&z=first'
  );
  assert.notEqual(reversedListValues.canonical_url, first.canonical_url);
  assert.equal(reversedListValues.canonical_identity, first.canonical_identity);
});

test('null-ID platform URL hashes preserve retained query-pair source order', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    ['https://vm.tiktok.com/ABC/', 'https://vm.tiktok.com/ABC/'],
    ['https://www.tiktok.com/t/ABC/', 'https://www.tiktok.com/t/ABC/'],
    [
      'https://www.instagram.com/share/reel/ABC/',
      'https://www.instagram.com/share/reel/ABC/'
    ],
    ['https://fb.watch/ABC/', 'https://fb.watch/ABC/'],
    [
      'https://www.facebook.com/share/p/ABC/',
      'https://www.facebook.com/share/p/ABC/'
    ]
  ];

  cases.forEach(([inputBase, canonicalBase]) => {
    const first = admitPublicationUrl(inputBase + '?a=1&utm_source=drop&b=2');
    const reordered = admitPublicationUrl(inputBase + '?b=2&utm_medium=drop&a=1');

    assert.equal(first.platform_content_id, null);
    assert.equal(reordered.platform_content_id, null);
    assert.equal(first.identity_kind, 'canonical_url_sha256');
    assert.equal(reordered.identity_kind, 'canonical_url_sha256');
    assert.equal(first.canonical_url, canonicalBase + '?a=1&b=2');
    assert.equal(reordered.canonical_url, canonicalBase + '?b=2&a=1');
    assert.notEqual(reordered.canonical_identity, first.canonical_identity);
  });
});

test('Facebook indexed __cft__ tracking is stripped exactly before null-ID hashing', () => {
  const { admitPublicationBatch } = loadService();
  const baseUrl = 'https://www.facebook.com/share/v/ABC_TOKEN/';
  const result = admitPublicationBatch([
    baseUrl,
    baseUrl + '?__cft__[0]=first-tracking-value',
    baseUrl + '?__cft__[0]=different&__cft__[12]=another&__cft__=bare',
    baseUrl + '?prefix__cft__[0]=keep',
    baseUrl + '?__cft__[x]=keep',
    baseUrl + '?__cft__[0]suffix=keep'
  ]);

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'duplicate', 'duplicate', 'accepted', 'accepted', 'accepted'
  ]);
  assert.deepEqual(result.rows.map((row) => row.first_index), [0, 0, 0, 3, 4, 5]);
  assert.deepEqual(result.rows.map((row) => row.canonical_url), [
    baseUrl,
    baseUrl,
    baseUrl,
    baseUrl + '?prefix__cft__%5B0%5D=keep',
    baseUrl + '?__cft__%5Bx%5D=keep',
    baseUrl + '?__cft__%5B0%5Dsuffix=keep'
  ]);
  result.rows.forEach((row) => {
    assert.equal(row.platform_content_id, null);
    assert.equal(row.identity_kind, 'canonical_url_sha256');
  });
  result.rows.slice(1, 3).forEach((row) => {
    assert.equal(row.canonical_identity, result.rows[0].canonical_identity);
  });
  result.rows.slice(3).forEach((row) => {
    assert.notEqual(row.canonical_identity, result.rows[0].canonical_identity);
  });
});

test('literal U+212A in a tracker-like name remains semantic for null-ID URLs', () => {
  const { admitPublicationUrl } = loadService();
  const baseUrl = 'https://fb.watch/ABC/';
  const noQuery = admitPublicationUrl(baseUrl);
  const routeA = admitPublicationUrl(baseUrl + '?mscl\u212Aid=route-A');
  const routeB = admitPublicationUrl(baseUrl + '?mscl\u212Aid=route-B');

  assert.equal(routeA.platform_content_id, null);
  assert.equal(routeA.identity_kind, 'canonical_url_sha256');
  assert.equal(routeA.canonical_url, baseUrl + '?mscl%E2%84%AAid=route-A');
  assert.equal(routeB.canonical_url, baseUrl + '?mscl%E2%84%AAid=route-B');
  assert.equal(new Set([
    noQuery.canonical_identity,
    routeA.canonical_identity,
    routeB.canonical_identity
  ]).size, 3);
});

test('percent-encoded U+212A in a tracker-like name remains semantic for null-ID URLs', () => {
  const { admitPublicationUrl } = loadService();
  const baseUrl = 'https://fb.watch/ABC/';
  const noQuery = admitPublicationUrl(baseUrl);
  const routeA = admitPublicationUrl(baseUrl + '?mscl%E2%84%AAid=route-A');
  const routeB = admitPublicationUrl(baseUrl + '?mscl%E2%84%AAid=route-B');

  assert.equal(routeA.platform_content_id, null);
  assert.equal(routeA.identity_kind, 'canonical_url_sha256');
  assert.equal(routeA.canonical_url, baseUrl + '?mscl%E2%84%AAid=route-A');
  assert.equal(routeB.canonical_url, baseUrl + '?mscl%E2%84%AAid=route-B');
  assert.equal(new Set([
    noQuery.canonical_identity,
    routeA.canonical_identity,
    routeB.canonical_identity
  ]).size, 3);
});

test('custom manual admission requires a public-DNS-shaped host and labels URL-hash identity clearly', () => {
  const { admitPublicationUrl } = loadService();
  const first = admitPublicationUrl(
    'https://PUBLIC.example.com:443/a/../story/?a=1&utm_source=drop&b=2'
  );
  const second = admitPublicationUrl('https://public.example.com/story/?a=1&b=2');

  assert.equal(first.platform, 'custom_manual');
  assert.equal(first.platform_content_id, null);
  assert.equal(first.canonical_url, 'https://public.example.com/story/?a=1&b=2');
  assert.equal(first.canonical_identity, second.canonical_identity);
  assert.equal(first.identity_kind, 'canonical_url_sha256');
});

test('parser-repaired extra HTTPS authority slashes are rejected', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    'https:///www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https:////www.youtube.com/watch?v=dQw4w9WgXcQ',
    'HTTPS://///www.youtube.com/watch?v=dQw4w9WgXcQ'
  ];

  cases.forEach((url) => {
    expectServiceError(() => admitPublicationUrl(url), 'PUBLICATION_URL_MALFORMED', 400);
  });
});

test('Unicode authority spellings that normalize to allowlisted ASCII hosts are rejected', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    'https://ｗｗｗ.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www．youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube。com/watch?v=dQw4w9WgXcQ',
    'https://%EF%BD%97%EF%BD%97%EF%BD%97.youtube.com/watch?v=dQw4w9WgXcQ'
  ];

  cases.forEach((url) => {
    expectServiceError(() => admitPublicationUrl(url), 'PUBLICATION_URL_IDN_AMBIGUOUS', 400);
  });
});

test('empty raw userinfo delimiters are rejected before URL normalization', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    'https://@example.com/story',
    'https://:@www.youtube.com/watch?v=dQw4w9WgXcQ'
  ];

  cases.forEach((url) => {
    expectServiceError(
      () => admitPublicationUrl(url),
      'PUBLICATION_URL_CREDENTIALS_FORBIDDEN',
      400
    );
  });
});

test('at signs in paths and queries are not treated as authority userinfo', () => {
  const { admitPublicationUrl } = loadService();
  const admitted = admitPublicationUrl(
    'https://example.com/@creator?contact=user@example.com'
  );

  assert.equal(admitted.platform, 'custom_manual');
  assert.equal(
    admitted.canonical_url,
    'https://example.com/@creator?contact=user%40example.com'
  );
});

test('invalid UTF-8 query escapes are rejected before replacement decoding', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    '%FF',
    '%FE',
    '%C0%AF',
    '%E0%80%AF',
    '%E2%28%A1',
    '%E2%82',
    '%ED%A0%80',
    '%F4%90%80%80'
  ];

  cases.forEach((value) => {
    expectServiceError(
      () => admitPublicationUrl('https://example.com/?x=' + value),
      'PUBLICATION_URL_MALFORMED',
      400
    );
  });
});

test('valid literal and encoded U+FFFD query values preserve pair order and identity', () => {
  const { admitPublicationUrl } = loadService();
  const literal = admitPublicationUrl(
    'https://example.com/?first=1&x=\uFFFD&first=2'
  );
  const encoded = admitPublicationUrl(
    'https://example.com/?first=1&x=%EF%BF%BD&first=2'
  );

  assert.equal(
    literal.canonical_url,
    'https://example.com/?first=1&x=%EF%BF%BD&first=2'
  );
  assert.equal(encoded.canonical_url, literal.canonical_url);
  assert.equal(encoded.canonical_identity, literal.canonical_identity);
});

[
  {
    label: 'a standalone invalid byte',
    encodedBytes: '%FF',
    secret: 'APPSEC_PATH_UTF8_FF_SECRET'
  },
  {
    label: 'an overlong scalar encoding',
    encodedBytes: '%C0%AF',
    secret: 'APPSEC_PATH_UTF8_OVERLONG_SECRET'
  },
  {
    label: 'a surrogate scalar encoding',
    encodedBytes: '%ED%A0%80',
    secret: 'APPSEC_PATH_UTF8_SURROGATE_SECRET'
  },
  {
    label: 'an out-of-range scalar encoding',
    encodedBytes: '%F4%90%80%80',
    secret: 'APPSEC_PATH_UTF8_OUT_OF_RANGE_SECRET'
  }
].forEach(({ label, encodedBytes, secret }) => {
  test('path UTF-8 validation rejects ' + label + ' for custom and known-platform paths', () => {
    const { admitPublicationBatch } = loadService();
    const result = admitPublicationBatch([
      'https://example.com/' + secret + encodedBytes,
      'https://www.facebook.com/' + secret + encodedBytes + '/videos/123'
    ]);

    assert.deepEqual(result.rows.map((row) => row.outcome), ['rejected', 'rejected']);
    assert.deepEqual(result.rows.map((row) => ({
      code: row.error.code,
      status: row.error.status,
      field: row.error.details.field,
      reason: row.error.details.reason
    })), [
      {
        code: 'PUBLICATION_URL_MALFORMED',
        status: 400,
        field: 'path',
        reason: 'invalid_utf8_path_escape'
      },
      {
        code: 'PUBLICATION_URL_MALFORMED',
        status: 400,
        field: 'path',
        reason: 'invalid_utf8_path_escape'
      }
    ]);
    result.rows.forEach((row, index) => {
      assert.equal(row.original_url, null);
      assert.equal(row.original_url_disclosure, 'withheld_rejected_input');
      assert.equal(row.error.details.index, index);
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assertDeepFrozen(result);
  });
});

test('malformed percent syntax in custom and known-platform paths stays deterministically secret-safe', () => {
  const { admitPublicationBatch } = loadService();
  const secrets = [
    'APPSEC_PATH_PERCENT_CUSTOM_SECRET',
    'APPSEC_PATH_PERCENT_PLATFORM_SECRET'
  ];
  const result = admitPublicationBatch([
    'https://example.com/' + secrets[0] + '%',
    'https://www.facebook.com/' + secrets[1] + '%GG/videos/123'
  ]);

  assert.deepEqual(result.rows.map((row) => row.outcome), ['rejected', 'rejected']);
  assert.deepEqual(result.rows.map((row) => ({
    code: row.error.code,
    status: row.error.status,
    field: row.error.details.field,
    reason: row.error.details.reason
  })), [
    {
      code: 'PUBLICATION_URL_MALFORMED',
      status: 400,
      field: 'url',
      reason: 'malformed_escape'
    },
    {
      code: 'PUBLICATION_URL_MALFORMED',
      status: 400,
      field: 'url',
      reason: 'malformed_escape'
    }
  ]);
  const serialized = JSON.stringify(result);
  secrets.forEach((secret) => assert.equal(serialized.includes(secret), false));
  assertDeepFrozen(result);
});

test('path UTF-8 validation preserves valid encoded Unicode and reserved escapes', () => {
  const { admitPublicationUrl } = loadService();
  const custom = admitPublicationUrl(
    'https://example.com/caf%c3%a9/%e2%98%83/%f4%8f%bf%bf/a%2fb%3fc%23d'
  );
  const knownPlatform = admitPublicationUrl(
    'https://www.facebook.com/caf%C3%A9-%E2%98%83-%F4%8F%BF%BF-%2F/videos/123' +
      '?utm_source=drop'
  );

  assert.equal(
    custom.canonical_url,
    'https://example.com/caf%C3%A9/%E2%98%83/%F4%8F%BF%BF/a%2Fb%3Fc%23d'
  );
  assert.equal(custom.platform, 'custom_manual');
  assert.equal(custom.platform_content_id, null);
  assert.equal(knownPlatform.canonical_url, 'https://www.facebook.com/watch/?v=123');
  assert.equal(knownPlatform.platform, 'facebook');
  assert.equal(knownPlatform.platform_content_id, '123');
  assertDeepFrozen(custom);
  assertDeepFrozen(knownPlatform);
});

test('HTTPS, credentials, fragments, controls, malformed escapes, backslashes, and size bounds fail closed', () => {
  const { admitPublicationUrl, MAX_URL_BYTES } = loadService();
  const cases = [
    ['http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'PUBLICATION_URL_HTTPS_REQUIRED', 400],
    ['//www.youtube.com/watch?v=dQw4w9WgXcQ', 'PUBLICATION_URL_HTTPS_REQUIRED', 400],
    ['not a url', 'PUBLICATION_URL_HTTPS_REQUIRED', 400],
    ['https://user@example.com/story', 'PUBLICATION_URL_CREDENTIALS_FORBIDDEN', 400],
    ['https://:secret@example.com/story', 'PUBLICATION_URL_CREDENTIALS_FORBIDDEN', 400],
    ['https://example.com/story#section', 'PUBLICATION_URL_FRAGMENT_FORBIDDEN', 400],
    ['https://example.com/story#', 'PUBLICATION_URL_FRAGMENT_FORBIDDEN', 400],
    ['https://example.com/a\npath', 'PUBLICATION_URL_CONTROL_CHARACTER', 400],
    ['https://example.com/a path', 'PUBLICATION_URL_CONTROL_CHARACTER', 400],
    ['https:\\example.com\story', 'PUBLICATION_URL_MALFORMED', 400],
    ['https://example.com/%ZZ', 'PUBLICATION_URL_MALFORMED', 400],
    ['https://', 'PUBLICATION_URL_MALFORMED', 400]
  ];

  cases.forEach(([url, code, status]) => {
    expectServiceError(() => admitPublicationUrl(url), code, status);
  });
  expectServiceError(() => admitPublicationUrl(null), 'PUBLICATION_URL_TYPE_INVALID', 400);
  expectServiceError(() => admitPublicationUrl(new String('https://example.com')), 'PUBLICATION_URL_TYPE_INVALID', 400);
  expectServiceError(
    () => admitPublicationUrl('https://example.com/' + 'a'.repeat(MAX_URL_BYTES)),
    'PUBLICATION_URL_TOO_LARGE',
    413
  );
});

test('IPv4, IPv6, decimal, octal, localhost, private suffixes, single labels, and IDN ambiguity are rejected', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    ['https://127.0.0.1/story', 'PUBLICATION_URL_IP_HOST_FORBIDDEN'],
    ['https://8.8.8.8/story', 'PUBLICATION_URL_IP_HOST_FORBIDDEN'],
    ['https://[::1]/story', 'PUBLICATION_URL_IP_HOST_FORBIDDEN'],
    ['https://2130706433/story', 'PUBLICATION_URL_IP_HOST_FORBIDDEN'],
    ['https://0177.0.0.1/story', 'PUBLICATION_URL_IP_HOST_FORBIDDEN'],
    ['https://0x7f000001/story', 'PUBLICATION_URL_IP_HOST_FORBIDDEN'],
    ['https://localhost/story', 'PUBLICATION_URL_HOST_NOT_PUBLIC'],
    ['https://api.localhost/story', 'PUBLICATION_URL_HOST_NOT_PUBLIC'],
    ['https://metadata.google.internal/story', 'PUBLICATION_URL_HOST_NOT_PUBLIC'],
    ['https://printer.local/story', 'PUBLICATION_URL_HOST_NOT_PUBLIC'],
    ['https://intranet/story', 'PUBLICATION_URL_HOST_NOT_PUBLIC'],
    ['https://例子.测试/story', 'PUBLICATION_URL_IDN_AMBIGUOUS'],
    ['https://xn--fsqu00a.xn--0zwm56d/story', 'PUBLICATION_URL_IDN_AMBIGUOUS'],
    ['https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'PUBLICATION_URL_HOST_AMBIGUOUS'],
    ['https://evil.youtube.com/watch?v=dQw4w9WgXcQ', 'PUBLICATION_URL_HOST_AMBIGUOUS']
  ];

  cases.forEach(([url, code]) => {
    expectServiceError(() => admitPublicationUrl(url), code, 400);
  });
});

test('standardized non-public .example and .alt suffixes are rejected at DNS-label boundaries', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    'https://publisher.example/story',
    'https://deep.publisher.example/story',
    'https://publisher.alt/story',
    'https://deep.publisher.alt/story'
  ];

  cases.forEach((url) => {
    expectServiceError(() => admitPublicationUrl(url), 'PUBLICATION_URL_HOST_NOT_PUBLIC', 400);
  });
});

test('the entire .arpa namespace is rejected at DNS-label boundaries without blocking arpa substrings', () => {
  const { admitPublicationUrl } = loadService();
  const rejected = [
    'https://resolver.arpa/story',
    'https://deep.resolver.arpa/story',
    'https://in-addr.arpa/story',
    'https://1.0.0.127.in-addr.arpa/story',
    'https://home.arpa/story',
    'https://device.home.arpa/story'
  ];

  rejected.forEach((url) => {
    expectServiceError(() => admitPublicationUrl(url), 'PUBLICATION_URL_HOST_NOT_PUBLIC', 400);
  });

  const admitted = admitPublicationUrl('https://publicarpa.com/story');
  assert.equal(admitted.platform, 'custom_manual');
  assert.equal(admitted.canonical_url, 'https://publicarpa.com/story');
});

test('platform-host ambiguity honors exact DNS label boundaries', () => {
  const { admitPublicationUrl } = loadService();
  const admittedCustomHosts = [
    'https://box.com.au/story',
    'https://myyoutube.com.au/watch?v=dQw4w9WgXcQ'
  ].map(admitPublicationUrl);
  const platformBaseDomains = [
    'tiktok.com',
    'instagram.com',
    'instagr.am',
    'youtube.com',
    'youtu.be',
    'facebook.com',
    'fb.com',
    'fb.watch',
    'x.com',
    'twitter.com'
  ];

  assert.deepEqual(admittedCustomHosts.map((item) => item.platform), [
    'custom_manual', 'custom_manual'
  ]);
  assert.deepEqual(admittedCustomHosts.map((item) => item.canonical_url), [
    'https://box.com.au/story',
    'https://myyoutube.com.au/watch?v=dQw4w9WgXcQ'
  ]);
  platformBaseDomains.forEach((baseDomain) => {
    expectServiceError(
      () => admitPublicationUrl('https://' + baseDomain + '.evil.com/story'),
      'PUBLICATION_URL_HOST_AMBIGUOUS',
      400
    );
    expectServiceError(
      () => admitPublicationUrl('https://evil.' + baseDomain + '/story'),
      'PUBLICATION_URL_HOST_AMBIGUOUS',
      400
    );
  });
});

test('short links stay offline, retain null IDs, and never fabricate a zero identity', () => {
  const servicePath = require.resolve('../services/publication_identity_service');
  const moduleCacheSnapshot = new Map(Object.entries(require.cache));
  const moduleChildrenSnapshot = module.children.slice();
  const patchedBindings = [];
  const patchedNamesByTarget = new WeakMap();
  const networkCalls = [];
  let networkStage = 'setup';
  let results;

  function patchCallable(target, name, surface) {
    if (
      target === null ||
      (typeof target !== 'object' && typeof target !== 'function')
    ) {
      return;
    }
    let patchedNames = patchedNamesByTarget.get(target);
    if (!patchedNames) {
      patchedNames = new Set();
      patchedNamesByTarget.set(target, patchedNames);
    }
    if (patchedNames.has(name)) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'function'
    ) {
      return;
    }
    Object.defineProperty(target, name, Object.assign({}, descriptor, {
      value: function forbiddenNetworkCall() {
        networkCalls.push(networkStage + ':' + surface + '.' + name);
        throw new Error('network access is forbidden');
      }
    }));
    patchedNames.add(name);
    patchedBindings.push({ target, name, descriptor });
  }

  function patchCallables(target, names, surface) {
    names.forEach((name) => patchCallable(target, name, surface));
  }

  function patchUndici(undici, surface) {
    patchCallables(
      undici,
      ['fetch', 'request', 'stream', 'pipeline', 'connect', 'upgrade'],
      surface
    );
    if (typeof undici.getGlobalDispatcher === 'function') {
      patchCallable(undici.getGlobalDispatcher(), 'dispatch', surface + '.globalDispatcher');
    }
    [
      'Dispatcher',
      'Client',
      'Pool',
      'BalancedPool',
      'Agent',
      'ProxyAgent',
      'EnvHttpProxyAgent',
      'RetryAgent'
    ].forEach((constructorName) => {
      const Constructor = undici[constructorName];
      if (typeof Constructor !== 'function') return;
      patchCallables(
        Constructor.prototype,
        ['dispatch', 'request', 'stream', 'pipeline', 'connect', 'upgrade'],
        surface + '.' + constructorName
      );
    });
  }

  try {
    const dnsMethods = [
      'lookup',
      'lookupService',
      'resolve',
      'resolve4',
      'resolve6',
      'resolveAny',
      'resolveCaa',
      'resolveCname',
      'resolveMx',
      'resolveNaptr',
      'resolveNs',
      'resolvePtr',
      'resolveSoa',
      'resolveSrv',
      'resolveTxt',
      'reverse'
    ];
    patchCallables(dns, dnsMethods, 'dns');
    patchCallables(dnsPromises, dnsMethods, 'dns.promises');
    patchCallables(dns.Resolver && dns.Resolver.prototype, dnsMethods, 'dns.Resolver');
    patchCallables(
      dnsPromises.Resolver && dnsPromises.Resolver.prototype,
      dnsMethods,
      'dns.promises.Resolver'
    );
    patchCallables(net, ['connect', 'createConnection'], 'net');
    patchCallable(net.Socket && net.Socket.prototype, 'connect', 'net.Socket');
    patchCallable(tls, 'connect', 'tls');
    patchCallables(http, ['get', 'request'], 'http');
    patchCallable(http.Agent && http.Agent.prototype, 'createConnection', 'http.Agent');
    patchCallables(https, ['get', 'request'], 'https');
    patchCallable(https.Agent && https.Agent.prototype, 'createConnection', 'https.Agent');
    patchCallable(http2, 'connect', 'http2');
    patchCallable(globalThis, 'fetch', 'globalThis');

    ['undici', 'node:undici'].forEach((moduleId) => {
      let resolved;
      try {
        resolved = require.resolve(moduleId);
      } catch (error) {
        if (error && ['MODULE_NOT_FOUND', 'ERR_UNKNOWN_BUILTIN_MODULE'].includes(error.code)) {
          return;
        }
        throw error;
      }
      patchUndici(require(resolved), moduleId);
    });

    delete require.cache[servicePath];
    networkStage = 'import';
    const { admitPublicationUrl } = require(servicePath);
    assert.deepEqual(networkCalls, [], 'fresh service import must remain offline');

    networkStage = 'runtime';
    results = [
      admitPublicationUrl('https://vm.tiktok.com/ZMshortToken/?utm_source=share'),
      admitPublicationUrl('https://fb.watch/short_TOKEN-1/'),
      admitPublicationUrl('https://www.instagram.com/share/reel/short_TOKEN-2/')
    ];
    assert.deepEqual(networkCalls, [], 'short-link admission must remain offline');
  } finally {
    patchedBindings.slice().reverse().forEach(({ target, name, descriptor }) => {
      Object.defineProperty(target, name, descriptor);
    });
    Object.keys(require.cache).forEach((cacheKey) => {
      if (!moduleCacheSnapshot.has(cacheKey)) delete require.cache[cacheKey];
    });
    moduleCacheSnapshot.forEach((cachedModule, cacheKey) => {
      require.cache[cacheKey] = cachedModule;
    });
    module.children.splice(0, module.children.length, ...moduleChildrenSnapshot);
  }

  patchedBindings.forEach(({ target, name, descriptor }) => {
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, name), descriptor);
  });
  assert.deepEqual(Object.keys(require.cache).sort(), [...moduleCacheSnapshot.keys()].sort());
  moduleCacheSnapshot.forEach((cachedModule, cacheKey) => {
    assert.strictEqual(require.cache[cacheKey], cachedModule);
  });
  assert.deepEqual(module.children, moduleChildrenSnapshot);
  assert.deepEqual(networkCalls, []);
  assert.deepEqual(results.map((item) => item.platform), ['tiktok', 'facebook', 'instagram']);
  results.forEach((item) => {
    assert.equal(item.platform_content_id, null);
    assert.notEqual(item.platform_content_id, 0);
    assert.match(item.canonical_identity, /^sha256:[0-9a-f]{64}$/);
    assert.equal(item.identity_kind, 'canonical_url_sha256');
  });
});

test('known platform URLs reject missing, malformed, conflicting, and zero content IDs instead of coercing them', () => {
  const { admitPublicationUrl } = loadService();
  const cases = [
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=aaaaaaaaaaa',
    'https://x.com/alice/status/0',
    'https://www.facebook.com/watch/?v=0',
    'https://www.tiktok.com/@alice/video/0',
    'https://www.instagram.com/alice/'
  ];

  cases.forEach((url) => {
    expectServiceError(() => admitPublicationUrl(url), 'PUBLICATION_URL_PLATFORM_PATTERN_INVALID', 400);
  });
});

test('recognized query IDs cannot contradict path-derived YouTube and Facebook identities', () => {
  const { admitPublicationUrl } = loadService();
  const accepted = [
    {
      label: 'YouTube short matching ID',
      url: 'https://youtu.be/dQw4w9WgXcQ?v=dQw4w9WgXcQ',
      canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    },
    {
      label: 'YouTube short repeated matching ID',
      url: 'https://youtu.be/dQw4w9WgXcQ?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ',
      canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    },
    {
      label: 'YouTube embed repeated matching ID',
      url: 'https://www.youtube.com/embed/dQw4w9WgXcQ?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ',
      canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    },
    {
      label: 'YouTube shorts repeated matching ID',
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ',
      canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    },
    {
      label: 'YouTube live repeated matching ID',
      url: 'https://www.youtube.com/live/dQw4w9WgXcQ?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ',
      canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    },
    {
      label: 'YouTube legacy path repeated matching ID',
      url: 'https://www.youtube.com/v/dQw4w9WgXcQ?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ',
      canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    },
    {
      label: 'Facebook videos path matching ID',
      url: 'https://www.facebook.com/page/videos/123?v=123',
      canonical: 'https://www.facebook.com/watch/?v=123'
    }
  ];
  const rejected = [
    ['YouTube short conflicting ID', 'https://youtu.be/dQw4w9WgXcQ?v=aaaaaaaaaaa'],
    ['YouTube short malformed ID', 'https://youtu.be/dQw4w9WgXcQ?v=short'],
    ['YouTube short zero ID', 'https://youtu.be/dQw4w9WgXcQ?v=0'],
    [
      'YouTube embed conflicting ID',
      'https://www.youtube.com/embed/dQw4w9WgXcQ?v=aaaaaaaaaaa'
    ],
    [
      'YouTube embed malformed repeated ID',
      'https://www.youtube.com/embed/dQw4w9WgXcQ?v=dQw4w9WgXcQ&v=short'
    ],
    [
      'YouTube shorts conflicting ID',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ?v=aaaaaaaaaaa'
    ],
    [
      'YouTube live conflicting ID',
      'https://www.youtube.com/live/dQw4w9WgXcQ?v=aaaaaaaaaaa'
    ],
    [
      'YouTube legacy path conflicting ID',
      'https://www.youtube.com/v/dQw4w9WgXcQ?v=aaaaaaaaaaa'
    ],
    [
      'YouTube watch repeated matching ID',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ'
    ],
    ['Facebook videos path conflicting ID', 'https://www.facebook.com/page/videos/123?v=456'],
    ['Facebook videos path malformed ID', 'https://www.facebook.com/page/videos/123?v=bad'],
    ['Facebook videos path zero ID', 'https://www.facebook.com/page/videos/123?v=0'],
    [
      'Facebook videos path repeated matching ID',
      'https://www.facebook.com/page/videos/123?v=123&v=123'
    ],
    [
      'Facebook watch repeated matching ID',
      'https://www.facebook.com/watch/?v=123&v=123'
    ],
    [
      'Facebook video.php conflicting IDs',
      'https://www.facebook.com/video.php?v=123&v=456'
    ]
  ];

  accepted.forEach(({ label, url, canonical }) => {
    const admitted = admitPublicationUrl(url);
    assert.equal(admitted.canonical_url, canonical, label);
  });
  rejected.forEach(([label, url]) => {
    expectServiceError(
      () => admitPublicationUrl(url),
      'PUBLICATION_URL_PLATFORM_PATTERN_INVALID',
      400,
      label
    );
  });
});

test('Facebook path-derived IDs reject every ambiguous recognized query-ID form', () => {
  const { admitPublicationUrl } = loadService();
  const pathForms = [
    ['reel', 'https://www.facebook.com/reel/123'],
    ['videos', 'https://www.facebook.com/page/videos/123']
  ];
  const rejectedQueries = [
    ['zero', 'v=0'],
    ['malformed', 'v=bad'],
    ['conflicting', 'v=456'],
    ['repeated matching', 'v=123&v=123'],
    ['matching then conflicting', 'v=123&v=456'],
    ['conflicting then matching', 'v=456&v=123']
  ];

  pathForms.forEach(([pathLabel, baseUrl]) => {
    rejectedQueries.forEach(([queryLabel, query]) => {
      expectServiceError(
        () => admitPublicationUrl(baseUrl + '?' + query),
        'PUBLICATION_URL_PLATFORM_PATTERN_INVALID',
        400,
        pathLabel + ' path with ' + queryLabel + ' query ID'
      );
    });
  });
});

test('Facebook path-derived IDs consume one matching recognized query ID', () => {
  const { admitPublicationUrl } = loadService();
  const pathForms = [
    {
      label: 'reel',
      url: 'https://www.facebook.com/reel/123',
      canonical: 'https://www.facebook.com/reel/123/'
    },
    {
      label: 'videos',
      url: 'https://www.facebook.com/page/videos/123',
      canonical: 'https://www.facebook.com/watch/?v=123'
    }
  ];

  pathForms.forEach(({ label, url, canonical }) => {
    const pathOnly = admitPublicationUrl(url);
    const matchingQuery = admitPublicationUrl(url + '?v=123');

    assert.equal(pathOnly.canonical_url, canonical, label + ' path-only canonical URL');
    assert.equal(matchingQuery.canonical_url, canonical, label + ' matching-query canonical URL');
    assert.equal(matchingQuery.platform_content_id, '123', label + ' content ID');
    assert.equal(
      matchingQuery.canonical_identity,
      pathOnly.canonical_identity,
      label + ' canonical identity'
    );
  });
});

test('batch keeps malformed cells as stable rejected rows without aborting valid neighbors', () => {
  const { admitPublicationBatch } = loadService();
  const input = [
    'https://example.com/one',
    null,
    '',
    { url: 'https://example.com/object' },
    'https://example.com/five'
  ];

  const result = admitPublicationBatch(input);

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'rejected', 'rejected', 'rejected', 'accepted'
  ]);
  assert.deepEqual(result.rows.slice(1, 4).map((row) => row.error.code), [
    'PUBLICATION_URL_TYPE_INVALID',
    'PUBLICATION_URL_EMPTY',
    'PUBLICATION_URL_TYPE_INVALID'
  ]);
  assert.deepEqual(result.rows.slice(1, 4).map((row) => row.error.details.index), [1, 2, 3]);
  assert.equal(result.rows[1].original_url, null);
  assert.equal(result.rows[2].original_url, null);
  assert.equal(result.rows[3].original_url, null);
  assert.deepEqual(result.rows.slice(1, 4).map((row) => row.original_url_disclosure), [
    'withheld_rejected_input',
    'withheld_rejected_input',
    'withheld_rejected_input'
  ]);
  assert.equal(result.accepted_count, 2);
  assert.equal(result.rejected_count, 3);
});

test('batch container validation rejects non-arrays, empties, sparse arrays, extra keys, subclasses, and oversize before rows run', () => {
  const { admitPublicationBatch, MAX_BATCH_SIZE } = loadService();
  const valid = 'https://example.com/story';
  const sparse = new Array(3);
  sparse[0] = valid;
  sparse[2] = valid;
  const extraKey = [valid];
  extraKey.note = 'not a row';
  class UrlBatch extends Array {}
  const subclass = new UrlBatch(valid);

  expectServiceError(() => admitPublicationBatch(null), 'PUBLICATION_BATCH_TYPE_INVALID', 400);
  expectServiceError(() => admitPublicationBatch({ 0: valid, length: 1 }), 'PUBLICATION_BATCH_TYPE_INVALID', 400);
  expectServiceError(() => admitPublicationBatch([]), 'PUBLICATION_BATCH_EMPTY', 400);
  expectServiceError(() => admitPublicationBatch(sparse), 'PUBLICATION_BATCH_MUST_BE_DENSE', 400);
  expectServiceError(() => admitPublicationBatch(extraKey), 'PUBLICATION_BATCH_CONTAINER_INVALID', 400);
  expectServiceError(() => admitPublicationBatch(subclass), 'PUBLICATION_BATCH_CONTAINER_INVALID', 400);
  expectServiceError(
    () => admitPublicationBatch(new Array(MAX_BATCH_SIZE + 1).fill(valid)),
    'PUBLICATION_BATCH_TOO_LARGE',
    413
  );
});

test('Proxy and accessor batch traps are rejected before any trap or row getter can execute', () => {
  const { admitPublicationBatch } = loadService();
  let proxyTrapCalls = 0;
  const proxy = new Proxy(['https://example.com/story'], {
    get() {
      proxyTrapCalls += 1;
      throw new Error('get trap executed');
    },
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error('descriptor trap executed');
    },
    ownKeys() {
      proxyTrapCalls += 1;
      throw new Error('ownKeys trap executed');
    },
    getPrototypeOf() {
      proxyTrapCalls += 1;
      throw new Error('prototype trap executed');
    }
  });
  let getterCalls = 0;
  const accessor = ['https://example.com/one', 'https://example.com/two'];
  Object.defineProperty(accessor, 1, {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'https://example.com/trapped';
    }
  });

  expectServiceError(() => admitPublicationBatch(proxy), 'PUBLICATION_BATCH_CONTAINER_UNSAFE', 400);
  expectServiceError(() => admitPublicationBatch(accessor), 'PUBLICATION_BATCH_ACCESSOR_FORBIDDEN', 400);
  assert.equal(proxyTrapCalls, 0);
  assert.equal(getterCalls, 0);
});

test('batch snapshots input values and all returned nested structures resist mutation', () => {
  const { admitPublicationBatch } = loadService();
  const input = [
    'https://example.com/story?b=2&a=1',
    'https://example.com/story?a=1&b=2',
    'bad-cell'
  ];
  const result = admitPublicationBatch(input);
  const snapshot = structuredClone(result);

  input[0] = 'https://example.com/changed';
  input[1] = 'https://example.com/changed-again';
  input.push('https://example.com/new');

  assert.deepEqual(result, snapshot);
  assertDeepFrozen(result);
  assert.throws(() => {
    result.rows[0].canonical_url = 'https://mutated.example.com';
  }, TypeError);
  assert.throws(() => {
    result.rows[2].error.details.index = 999;
  }, TypeError);
  assert.throws(() => {
    result.rows.push({ outcome: 'accepted' });
  }, TypeError);
});

test('canonical output and duplicate selection are deterministic across tracking placement and repeated runs', () => {
  const { admitPublicationBatch, admitPublicationUrl } = loadService();
  const firstUrl = 'https://example.com/story?z=3&a=2&utm_campaign=drop&a=1';
  const secondUrl = 'https://example.com/story?z=3&utm_campaign=drop&a=2&a=1';
  const first = admitPublicationUrl(firstUrl);
  const second = admitPublicationUrl(secondUrl);
  const input = [firstUrl, secondUrl, firstUrl];

  assert.equal(first.canonical_url, 'https://example.com/story?z=3&a=2&a=1');
  assert.equal(second.canonical_url, first.canonical_url);
  assert.equal(second.canonical_identity, first.canonical_identity);
  assert.deepEqual(admitPublicationBatch(input), admitPublicationBatch(input));
  assert.deepEqual(
    admitPublicationBatch(input).rows.map((row) => [row.outcome, row.first_index]),
    [['accepted', 0], ['duplicate', 0], ['duplicate', 0]]
  );
});

test('tracking allowlist and platform extractors are mutation-sensitive at their boundaries', () => {
  const { admitPublicationUrl } = loadService();
  const retained = admitPublicationUrl(
    'https://example.com/story?utm_sourceful=keep&utm_source=drop&fbclidish=keep&fbclid=drop'
  );
  assert.equal(
    retained.canonical_url,
    'https://example.com/story?utm_sourceful=keep&fbclidish=keep'
  );

  const facebookForms = [
    'https://facebook.com/video.php?v=123456789012345',
    'https://www.facebook.com/page/videos/123456789012345/',
    'https://m.facebook.com/watch/?v=123456789012345'
  ].map(admitPublicationUrl);
  assert.equal(new Set(facebookForms.map((item) => item.canonical_identity)).size, 1);
  assert.deepEqual(facebookForms.map((item) => item.platform_content_id), [
    '123456789012345', '123456789012345', '123456789012345'
  ]);
});

test('rejected URL disclosure withholds credential, control, malformed, and path-pattern secrets', () => {
  const { admitPublicationBatch } = loadService();
  const secrets = [
    'APPSEC_CREDENTIAL_SECRET',
    'APPSEC_CONTROL_SECRET',
    'APPSEC_ESCAPE_SECRET',
    'APPSEC_PATTERN_SECRET'
  ];
  const result = admitPublicationBatch([
    'https://user:' + secrets[0] + '@example.com/story',
    'https://example.com/story?token=' + secrets[1] + '\n',
    'https://example.com/' + secrets[2] + '%ZZ',
    'https://www.instagram.com/' + secrets[3] + '/'
  ]);
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.rows.map((row) => row.error.code), [
    'PUBLICATION_URL_CREDENTIALS_FORBIDDEN',
    'PUBLICATION_URL_CONTROL_CHARACTER',
    'PUBLICATION_URL_MALFORMED',
    'PUBLICATION_URL_PLATFORM_PATTERN_INVALID'
  ]);
  result.rows.forEach((row) => {
    assert.equal(row.outcome, 'rejected');
    assert.equal(row.original_url, null);
    assert.equal(row.original_url_disclosure, 'withheld_rejected_input');
    assertDeepFrozen(row.error);
  });
  secrets.forEach((secret) => {
    assert.equal(serialized.includes(secret), false, secret);
  });
});

test('offline Instagram and Facebook share discriminators never fabricate cross-type equivalence', () => {
  const { admitPublicationBatch } = loadService();
  const result = admitPublicationBatch([
    'https://www.instagram.com/share/p/SAME_TOKEN/',
    'https://www.instagram.com/share/reel/SAME_TOKEN/',
    'https://m.instagram.com/share/p/SAME_TOKEN/?igsh=drop',
    'https://www.facebook.com/share/p/SAME_TOKEN/',
    'https://www.facebook.com/share/r/SAME_TOKEN/',
    'https://www.facebook.com/share/v/SAME_TOKEN/',
    'https://m.facebook.com/share/p/SAME_TOKEN/?mibextid=drop'
  ]);

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted',
    'accepted',
    'duplicate',
    'accepted',
    'accepted',
    'accepted',
    'duplicate'
  ]);
  assert.deepEqual(result.rows.map((row) => row.first_index), [0, 1, 0, 3, 4, 5, 3]);
  assert.deepEqual(result.rows.map((row) => row.canonical_url), [
    'https://www.instagram.com/share/p/SAME_TOKEN/',
    'https://www.instagram.com/share/reel/SAME_TOKEN/',
    'https://www.instagram.com/share/p/SAME_TOKEN/',
    'https://www.facebook.com/share/p/SAME_TOKEN/',
    'https://www.facebook.com/share/r/SAME_TOKEN/',
    'https://www.facebook.com/share/v/SAME_TOKEN/',
    'https://www.facebook.com/share/p/SAME_TOKEN/'
  ]);
  result.rows.forEach((row) => {
    assert.equal(row.platform_content_id, null);
    assert.equal(row.identity_kind, 'canonical_url_sha256');
  });
  assert.equal(result.rows[0].canonical_identity === result.rows[1].canonical_identity, false);
  assert.equal(result.rows[3].canonical_identity === result.rows[4].canonical_identity, false);
  assert.equal(result.rows[4].canonical_identity === result.rows[5].canonical_identity, false);
});

test('custom manual dedup preserves retained query-pair order while ignoring tracking placement', () => {
  const { admitPublicationBatch } = loadService();
  const result = admitPublicationBatch([
    'https://example.com/run?step=1&utm_source=drop&step=2&mode=run',
    'https://example.com/run?step=1&step=2&utm_medium=drop&mode=run',
    'https://example.com/run?step=2&step=1&mode=run'
  ]);

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'duplicate', 'accepted'
  ]);
  assert.deepEqual(result.rows.map((row) => row.first_index), [0, 0, 2]);
  assert.deepEqual(result.rows.map((row) => row.canonical_url), [
    'https://example.com/run?step=1&step=2&mode=run',
    'https://example.com/run?step=1&step=2&mode=run',
    'https://example.com/run?step=2&step=1&mode=run'
  ]);
  assert.notEqual(result.rows[0].canonical_identity, result.rows[2].canonical_identity);
});

test('custom paths decode only percent-encoded unreserved ASCII and preserve reserved encodings', () => {
  const { admitPublicationBatch } = loadService();
  const result = admitPublicationBatch([
    'https://example.com/%7euser/%41%62%63-%5f?mode=1',
    'https://example.com/~user/Abc-_?mode=1',
    'https://example.com/a%2fb%5cc%23d',
    'https://example.com/a/b%5Cc%23d',
    'https://example.com/a%2Fb%5Cc%23d'
  ]);

  assert.deepEqual(result.rows.map((row) => row.outcome), [
    'accepted', 'duplicate', 'accepted', 'accepted', 'duplicate'
  ]);
  assert.deepEqual(result.rows.map((row) => row.first_index), [0, 0, 2, 3, 2]);
  assert.equal(result.rows[0].canonical_url, 'https://example.com/~user/Abc-_?mode=1');
  assert.equal(result.rows[1].canonical_url, result.rows[0].canonical_url);
  assert.equal(result.rows[2].canonical_url, 'https://example.com/a%2Fb%5Cc%23d');
  assert.equal(result.rows[4].canonical_url, result.rows[2].canonical_url);
  assert.notEqual(result.rows[2].canonical_identity, result.rows[3].canonical_identity);
});

test('oversized primitive rows reject before Unicode and byte-length scans', () => {
  const { admitPublicationBatch, MAX_URL_BYTES } = loadService();
  const oversized = 'https://example.com/' + 'x'.repeat(MAX_URL_BYTES + 1);
  const originalCharCodeAt = String.prototype.charCodeAt;
  const originalByteLength = Buffer.byteLength;
  let unicodeScanCalls = 0;
  let byteLengthCalls = 0;
  String.prototype.charCodeAt = function forbiddenUnicodeScan() {
    unicodeScanCalls += 1;
    throw new Error('oversized input reached Unicode scan');
  };
  Buffer.byteLength = function forbiddenByteLength() {
    byteLengthCalls += 1;
    throw new Error('oversized input reached Buffer.byteLength');
  };

  let result;
  try {
    result = admitPublicationBatch([oversized]);
  } finally {
    String.prototype.charCodeAt = originalCharCodeAt;
    Buffer.byteLength = originalByteLength;
  }

  assert.equal(unicodeScanCalls, 0);
  assert.equal(byteLengthCalls, 0);
  assert.equal(result.rows[0].outcome, 'rejected');
  assert.equal(result.rows[0].error.code, 'PUBLICATION_URL_TOO_LARGE');
  assert.equal(result.rows[0].error.status, 413);
  assert.equal(result.rows[0].original_url, null);
  assert.equal(result.rows[0].original_url_disclosure, 'withheld_rejected_input');
});
