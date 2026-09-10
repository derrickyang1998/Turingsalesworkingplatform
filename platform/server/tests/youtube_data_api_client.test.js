'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  YouTubeDataApiClientError,
  createYouTubeDataApiClient
} = require('../services/youtube_data_api_client');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test('reads only supported public YouTube metrics and marks saves and shares unavailable', async () => {
  let requestedUrl = null;
  const client = createYouTubeDataApiClient({
    apiKey: 'test-youtube-key',
    now: () => new Date('2026-09-11T03:00:00.000Z'),
    async fetchImpl(url) {
      requestedUrl = new URL(url);
      return response(200, {
        items: [{
          id: 'abcDEF_1234',
          statistics: {
            viewCount: '12000',
            likeCount: '340',
            commentCount: '18',
            favoriteCount: '0'
          }
        }]
      });
    }
  });

  const result = await client.fetchStatistics({ videoId: 'abcDEF_1234' });

  assert.equal(requestedUrl.origin, 'https://www.googleapis.com');
  assert.equal(requestedUrl.pathname, '/youtube/v3/videos');
  assert.equal(requestedUrl.searchParams.get('part'), 'statistics');
  assert.equal(requestedUrl.searchParams.get('id'), 'abcDEF_1234');
  assert.equal(requestedUrl.searchParams.get('key'), 'test-youtube-key');
  assert.deepEqual(result.metrics, { views: 12000, likes: 340, comments: 18 });
  assert.equal(result.availability.saves.available, false);
  assert.equal(result.availability.saves.reason_code, 'provider_metric_unavailable');
  assert.equal(result.availability.shares.available, false);
  assert.equal(result.observed_at, '2026-09-11T03:00:00.000Z');
  assert.equal(result.attempts, 1);
  assert.doesNotMatch(JSON.stringify(result), /test-youtube-key/);
});

test('retries a rate-limited request with bounded backoff and returns safe attempt evidence', async () => {
  const sleeps = [];
  let calls = 0;
  const client = createYouTubeDataApiClient({
    apiKey: 'test-key',
    maxAttempts: 3,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    async fetchImpl() {
      calls += 1;
      if (calls === 1) {
        return response(429, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
      }
      return response(200, {
        items: [{ id: 'abcDEF_1234', statistics: { viewCount: '5' } }]
      });
    }
  });

  const result = await client.fetchStatistics({ videoId: 'abcDEF_1234' });

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.metrics, { views: 5 });
});

test('fails closed without a key and never attempts a provider request', async () => {
  let calls = 0;
  const client = createYouTubeDataApiClient({
    apiKey: '',
    async fetchImpl() { calls += 1; }
  });

  assert.deepEqual(client.getStatus(), {
    provider: 'youtube',
    configured: false,
    status: 'not_configured'
  });
  await assert.rejects(
    () => client.fetchStatistics({ videoId: 'abcDEF_1234' }),
    (error) => error instanceof YouTubeDataApiClientError &&
      error.code === 'YOUTUBE_DATA_API_NOT_CONFIGURED' && error.statusCode === 503
  );
  assert.equal(calls, 0);
});
