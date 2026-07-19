'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const platformRoot = path.join(__dirname, '..', '..');
const configPath = path.join(platformRoot, 'nginx', 'turingmarket.conf');

function readConfig() {
  return fs.readFileSync(configPath, 'utf8');
}

function bracedBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Nginx config must contain ${marker}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `${marker} must open a block`);
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const previous = index > 0 ? source[index - 1] : '';
    if (quote) {
      if (character === quote && previous !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${marker} must close its block`);
}

const API_LOCATION_MARKERS = Object.freeze([
  'location = /api/knowledge/upload {',
  'location = /api/influencers/upload {',
  'location = /api/demand/parse-file {',
  'location ~ ^/api/campaigns/[1-9][0-9]*/reviews$ {',
  'location ~ ^/api/campaigns(?:/|$) {',
  'location /api/ {'
]);

function assertStreamingApiLocation(block, marker) {
  assert.match(block, /\bproxy_request_buffering\s+off\s*;/, `${marker} must stream requests`);
  assert.match(block, /\bproxy_http_version\s+1\.1\s*;/, `${marker} must preserve chunked HTTP/1.1`);
  assert.match(block, /\bproxy_set_header\s+Connection\s+""\s*;/, `${marker} must clear hop-by-hop Connection`);
  assert.match(
    block,
    /\bproxy_set_header\s+X-Request-Id\s+\$tm_forward_request_id\s*;/,
    `${marker} must forward the validated/generated request ID`
  );
  assert.match(block, /\bclient_body_timeout\s+10s\s*;/, `${marker} must enforce the 10-second inter-read timeout`);
  assert.match(
    block,
    /if\s*\(\$tm_reject_expect\)\s*\{\s*return\s+417\s+""\s*;\s*\}/,
    `${marker} must reject non-empty Expect with a zero-byte 417`
  );
  assert.equal(
    block.indexOf('return 417 ""') < block.indexOf('proxy_pass '),
    true,
    `${marker} must reject Expect before choosing the upstream`
  );
}

test('Nginx maps non-empty Expect to a header-only 417 and maps exact request IDs for forwarding', () => {
  const config = readConfig();
  const expectMap = bracedBlock(config, 'map $http_expect $tm_reject_expect {');
  const requestIdMap = bracedBlock(config, 'map $http_x_request_id $tm_forward_request_id {');

  assert.match(expectMap, /""\s+0\s*;/);
  assert.match(expectMap, /\bdefault\s+1\s*;/);
  assert.match(requestIdMap, /~"\^\[\\x20-\\x7E\]\{8,120\}\$"\s+\$http_x_request_id\s*;/);
  assert.match(requestIdMap, /\bdefault\s+\$request_id\s*;/);
});

test('every API ingress path is unbuffered HTTP/1.1 with Connection cleared and request ID forwarded', () => {
  const config = readConfig();
  for (const marker of API_LOCATION_MARKERS) {
    assertStreamingApiLocation(bracedBlock(config, marker), marker);
  }

  assert.doesNotMatch(config, /\bproxy_request_buffering\s+on\s*;/);
  assert.doesNotMatch(config, /\bclient_body_temp_path\b/);
});

test('Nginx uses exact route-class byte ceilings for fixed-length and chunked request bodies', () => {
  const config = readConfig();
  const knowledgeUpload = bracedBlock(config, 'location = /api/knowledge/upload {');
  const influencerUpload = bracedBlock(config, 'location = /api/influencers/upload {');
  const demandUpload = bracedBlock(config, 'location = /api/demand/parse-file {');
  const review = bracedBlock(config, 'location ~ ^/api/campaigns/[1-9][0-9]*/reviews$ {');
  const campaignControl = bracedBlock(config, 'location ~ ^/api/campaigns(?:/|$) {');
  const existingDualMode = bracedBlock(config, 'location /api/ {');

  for (const block of [knowledgeUpload, influencerUpload, demandUpload]) {
    assert.match(block, /\bclient_max_body_size\s+22020096\s*;/);
  }
  assert.match(review, /\bclient_max_body_size\s+1048576\s*;/);
  assert.match(campaignControl, /\bclient_max_body_size\s+65536\s*;/);
  assert.match(existingDualMode, /\bclient_max_body_size\s+52428800\s*;/);

  assert.equal(
    config.indexOf('location ~ ^/api/campaigns/[1-9][0-9]*/reviews$ {')
      < config.indexOf('location ~ ^/api/campaigns(?:/|$) {'),
    true,
    'review-specific 1 MiB regex must precede the 64 KiB campaign-control regex'
  );
});

test('Nginx ingress directives cover fixed, chunked, slow, disconnect, and zero-temp-file behavior', () => {
  const config = readConfig();
  const api = bracedBlock(config, 'location /api/ {');

  assert.match(api, /\bproxy_request_buffering\s+off\s*;/, 'fixed bodies must not be pre-buffered');
  assert.match(api, /\bproxy_http_version\s+1\.1\s*;/, 'chunked bodies must stay HTTP/1.1 upstream');
  assert.match(api, /\bclient_body_timeout\s+10s\s*;/, 'slow bodies need a bounded inter-read timeout');
  assert.match(api, /\bproxy_set_header\s+Connection\s+""\s*;/, 'disconnect semantics must not forward a stale hop-by-hop header');
  assert.doesNotMatch(api, /\bproxy_buffering\s+off\s*;/, 'response buffering policy must remain independent');
  assert.doesNotMatch(config, /\bclient_body_in_file_only\b/, 'ingress must not force body temp files');
});
