'use strict';

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/videos';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_MS = Object.freeze([250, 750]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

class YouTubeDataApiClientError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'YouTubeDataApiClientError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace(this, YouTubeDataApiClientError);
  }
}

function clientError(statusCode, code, message, details) {
  return new YouTubeDataApiClientError(statusCode, code, message, details);
}

function safeCount(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function providerReason(body) {
  const reason = body && body.error && Array.isArray(body.error.errors) &&
    body.error.errors[0] && body.error.errors[0].reason;
  return typeof reason === 'string' ? reason : '';
}

function responseFailure(response, body) {
  const reason = providerReason(body);
  if (response.status === 429 || /rateLimitExceeded/i.test(reason)) {
    return { code: 'YOUTUBE_DATA_API_RATE_LIMITED', statusCode: 429, retryable: true };
  }
  if (response.status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(reason)) {
    return { code: 'YOUTUBE_DATA_API_QUOTA_EXCEEDED', statusCode: 503, retryable: false };
  }
  if (response.status === 403) {
    return { code: 'YOUTUBE_DATA_API_FORBIDDEN', statusCode: 503, retryable: false };
  }
  if ([500, 502, 503, 504].includes(response.status)) {
    return { code: 'YOUTUBE_DATA_API_UNAVAILABLE', statusCode: 503, retryable: true };
  }
  return { code: 'YOUTUBE_DATA_API_REQUEST_REJECTED', statusCode: 502, retryable: false };
}

function createYouTubeDataApiClient(options = {}) {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) && options.maxAttempts >= 1 && options.maxAttempts <= 3
    ? options.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;

  function getStatus() {
    return {
      provider: 'youtube',
      configured: Boolean(apiKey),
      status: apiKey ? 'ready' : 'not_configured'
    };
  }

  async function request(videoId, attempt) {
    const url = new URL(YOUTUBE_API_URL);
    url.searchParams.set('part', 'statistics');
    url.searchParams.set('id', videoId);
    url.searchParams.set('key', apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (timeout && typeof timeout.unref === 'function') timeout.unref();
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      let body = null;
      try { body = await response.json(); } catch (_error) {}
      if (!response.ok) {
        const failure = responseFailure(response, body);
        if (failure.retryable && attempt < maxAttempts) return { retry: failure };
        throw clientError(failure.statusCode, failure.code, 'YouTube data collection failed.', {
          retryable: failure.retryable,
          attempts: attempt
        });
      }
      const item = body && Array.isArray(body.items) && body.items.find((candidate) => candidate && candidate.id === videoId);
      if (!item || !item.statistics || typeof item.statistics !== 'object') {
        throw clientError(404, 'YOUTUBE_VIDEO_NOT_FOUND', 'The YouTube video is unavailable.', {
          retryable: false,
          attempts: attempt
        });
      }
      return { item };
    } catch (error) {
      if (error instanceof YouTubeDataApiClientError) throw error;
      const timedOut = controller.signal.aborted;
      if (attempt < maxAttempts) {
        return { retry: { code: timedOut ? 'YOUTUBE_DATA_API_TIMEOUT' : 'YOUTUBE_DATA_API_UNAVAILABLE' } };
      }
      throw clientError(503, timedOut ? 'YOUTUBE_DATA_API_TIMEOUT' : 'YOUTUBE_DATA_API_UNAVAILABLE',
        'YouTube data collection failed.', { retryable: true, attempts: attempt });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchStatistics(input = {}) {
    if (!apiKey) {
      throw clientError(503, 'YOUTUBE_DATA_API_NOT_CONFIGURED', 'YouTube data collection is not configured.');
    }
    if (typeof fetchImpl !== 'function') {
      throw clientError(503, 'YOUTUBE_DATA_API_UNAVAILABLE', 'YouTube data collection is unavailable.');
    }
    const videoId = input && input.videoId;
    if (typeof videoId !== 'string' || !VIDEO_ID_PATTERN.test(videoId)) {
      throw clientError(400, 'YOUTUBE_VIDEO_ID_INVALID', 'The YouTube video id is invalid.');
    }
    let result;
    let attempt = 1;
    for (; attempt <= maxAttempts; attempt += 1) {
      result = await request(videoId, attempt);
      if (!result.retry) break;
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
    const statistics = result.item.statistics;
    const metrics = {};
    const availability = {};
    for (const [apiField, metric] of [
      ['viewCount', 'views'],
      ['likeCount', 'likes'],
      ['commentCount', 'comments']
    ]) {
      const value = safeCount(statistics[apiField]);
      if (value === null) {
        availability[metric] = { available: false, reason_code: 'provider_field_missing' };
      } else {
        metrics[metric] = value;
        availability[metric] = { available: true };
      }
    }
    availability.saves = { available: false, reason_code: 'provider_metric_unavailable' };
    availability.shares = { available: false, reason_code: 'provider_metric_unavailable' };
    return {
      provider: 'youtube',
      provider_content_id: videoId,
      observed_at: new Date(now()).toISOString(),
      metrics,
      availability,
      attempts: attempt
    };
  }

  return Object.freeze({ getStatus, fetchStatistics });
}

module.exports = {
  YouTubeDataApiClientError,
  createYouTubeDataApiClient
};
