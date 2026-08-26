'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const llm = require('../services/llm_service');

test('DeepSeek provider defaults to the current V4 Flash model', async () => {
  let requestBody;
  const provider = llm.createDeepSeekProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
            prompt_cache_hit_tokens: 1,
            prompt_cache_miss_tokens: 2
          }
        })
      };
    }
  });

  const completion = await provider.complete({
    messages: [{ role: 'user', content: 'hello' }]
  });

  assert.equal(requestBody.model, 'deepseek-v4-flash');
  assert.deepEqual(requestBody.thinking, { type: 'disabled' });
  assert.equal(completion.model, 'deepseek-v4-flash');
  assert.equal(completion.provider, 'deepseek');
  assert.match(completion.completed_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('DeepSeek cost snapshot prices cache hit, cache miss and output tokens exactly off peak', () => {
  assert.equal(typeof llm.createDeepSeekCostSnapshot, 'function');
  const snapshot = llm.createDeepSeekCostSnapshot({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    occurredAt: '2026-08-23T12:00:00.000Z',
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_cache_hit_tokens: 600,
      prompt_cache_miss_tokens: 400
    }
  });

  assert.deepEqual(snapshot, {
    status: 'priced',
    provider: 'deepseek',
    policy_version: 'deepseek-v4-usd-2026-08-13-v1',
    source_url: 'https://api-docs.deepseek.com/quick_start/pricing',
    currency: 'USD',
    unit: 'nano_usd',
    model: 'deepseek-v4-flash',
    model_version: 'DeepSeek-V4-Flash-0731',
    rate_period: 'off_peak',
    priced_at: '2026-08-23T12:00:00.000Z',
    token_basis: {
      prompt_cache_hit_tokens: 600,
      prompt_cache_miss_tokens: 400,
      completion_tokens: 200
    },
    rates_nano_usd_per_token: {
      prompt_cache_hit: 7,
      prompt_cache_miss: 220,
      completion: 660
    },
    total_cost_nano_usd: 224200
  });
});

test('DeepSeek cost snapshot applies weekday peak pricing to V4 Pro', () => {
  const snapshot = llm.createDeepSeekCostSnapshot({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    occurredAt: '2026-08-24T01:30:00.000Z',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_cache_hit_tokens: 40,
      prompt_cache_miss_tokens: 60
    }
  });

  assert.equal(snapshot.status, 'priced');
  assert.equal(snapshot.rate_period, 'peak');
  assert.deepEqual(snapshot.rates_nano_usd_per_token, {
    prompt_cache_hit: 44,
    prompt_cache_miss: 1320,
    completion: 3960
  });
  assert.equal(snapshot.total_cost_nano_usd, 120560);
});

test('DeepSeek cost snapshot refuses unsupported models and incomplete cache usage', () => {
  const unsupported = llm.createDeepSeekCostSnapshot({
    provider: 'deepseek',
    model: 'deepseek-chat',
    occurredAt: '2026-08-24T12:00:00.000Z',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10
    }
  });
  assert.equal(unsupported.status, 'unavailable');
  assert.equal(unsupported.reason, 'unsupported_model');
  assert.equal(unsupported.total_cost_nano_usd, null);

  const incomplete = llm.createDeepSeekCostSnapshot({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    occurredAt: '2026-08-24T12:00:00.000Z',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  });
  assert.equal(incomplete.status, 'unavailable');
  assert.equal(incomplete.reason, 'cache_usage_missing');
  assert.equal(incomplete.total_cost_nano_usd, null);

  for (const inheritedName of ['constructor', 'toString', '__proto__']) {
    const inherited = llm.createDeepSeekCostSnapshot({
      provider: 'deepseek',
      model: inheritedName,
      occurredAt: '2026-08-24T12:00:00.000Z',
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 1
      }
    });
    assert.equal(inherited.status, 'unavailable');
    assert.equal(inherited.reason, 'unsupported_model');
  }
});

test('DeepSeek cost snapshot refuses inconsistent or unsafe token usage', () => {
  const inconsistent = llm.createDeepSeekCostSnapshot({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    occurredAt: '2026-08-24T12:00:00.000Z',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_cache_hit_tokens: 4,
      prompt_cache_miss_tokens: 5
    }
  });
  assert.equal(inconsistent.status, 'unavailable');
  assert.equal(inconsistent.reason, 'usage_inconsistent');

  const unsafe = llm.createDeepSeekCostSnapshot({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    occurredAt: '2026-08-24T01:30:00.000Z',
    usage: {
      prompt_tokens: Number.MAX_SAFE_INTEGER,
      completion_tokens: Number.MAX_SAFE_INTEGER,
      total_tokens: Number.MAX_SAFE_INTEGER,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: Number.MAX_SAFE_INTEGER
    }
  });
  assert.equal(unsafe.status, 'unavailable');
  assert.equal(unsafe.reason, 'usage_inconsistent');

  const overflowTokens = Math.floor(Number.MAX_SAFE_INTEGER / 3960) + 1;
  const overflow = llm.createDeepSeekCostSnapshot({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    occurredAt: '2026-08-24T01:30:00.000Z',
    usage: {
      prompt_tokens: 0,
      completion_tokens: overflowTokens,
      total_tokens: overflowTokens,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 0
    }
  });
  assert.equal(overflow.status, 'unavailable');
  assert.equal(overflow.reason, 'cost_overflow');
});

test('DeepSeek read projection rejects incomplete priced snapshots', () => {
  const incomplete = llm.projectDeepSeekCostSnapshot({
    status: 'priced',
    currency: 'USD',
    unit: 'nano_usd',
    policy_version: 'deepseek-v4-usd-2026-08-13-v1',
    rate_period: 'off_peak',
    total_cost_nano_usd: 6628
  });
  assert.deepEqual(incomplete, {
    status: 'unavailable',
    currency: 'USD',
    total_cost_nano_usd: null,
    policy_version: null,
    rate_period: null,
    reason: 'invalid_snapshot'
  });

  const validSnapshot = llm.createDeepSeekCostSnapshot({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    occurredAt: '2026-08-23T12:00:00.000Z',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18,
      prompt_cache_hit_tokens: 4,
      prompt_cache_miss_tokens: 6
    }
  });
  assert.equal(llm.projectDeepSeekCostSnapshot(validSnapshot).status, 'priced');
  assert.equal(llm.projectDeepSeekCostSnapshot(null).reason, 'invalid_snapshot');
  assert.equal(llm.projectDeepSeekCostSnapshot(undefined).reason, 'historical_snapshot_missing');
});
