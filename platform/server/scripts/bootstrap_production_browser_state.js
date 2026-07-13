#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  EvidenceError,
  destroySession,
  failureSummary,
  parseCredentialManifest,
  rejectLinksInExistingAncestors,
  removePrivateFile,
  storageStateFor,
  validateCredentialManifestPath,
  validateProductionBaseUrl,
  validateStorageStatePath,
  writePrivateJson
} = require('./lib/production_browser_evidence');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const storageRoot = path.join(repoRoot, '.superpowers', 'sdd');

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (!value) throw new EvidenceError('MISSING_PRIVATE_ENVIRONMENT', `Missing required environment variable ${name}`);
  return value;
}

async function bootstrapProductionBrowserState(options = {}) {
  const environment = options.environment || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = validateProductionBaseUrl(requiredEnvironment(environment, 'TM_PRODUCTION_BASE_URL'));
  const manifestPath = validateCredentialManifestPath(
    requiredEnvironment(environment, 'TM_PRIVATE_CREDENTIAL_MANIFEST'),
    { repoRoot }
  );
  const statePath = validateStorageStatePath(
    requiredEnvironment(environment, 'TM_PRODUCTION_STORAGE_STATE'),
    { repoRoot }
  );

  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  rejectLinksInExistingAncestors(storageRoot, 'production storage root');
  removePrivateFile(statePath, { allowedRoot: storageRoot });

  let credential = parseCredentialManifest(fs.readFileSync(manifestPath, 'utf8'));
  let token = '';
  try {
    let response;
    try {
      response = await fetchImpl(new URL('/api/auth/login', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credential)
      });
    } catch (error) {
      throw new EvidenceError('PRODUCTION_LOGIN_UNREACHABLE', 'Production login request failed', { cause: error });
    }
    if (!response.ok) throw new EvidenceError('PRODUCTION_LOGIN_REJECTED', 'Production login rejected the private credential');

    let payload;
    try { payload = await response.json(); } catch (error) {
      throw new EvidenceError('PRODUCTION_LOGIN_INVALID', 'Production login returned invalid JSON', { cause: error });
    }
    token = String(payload && payload.token || '');
    const user = payload && payload.user;
    if (!token || !user || user.role !== 'admin') {
      throw new EvidenceError('PRODUCTION_ROLE_MISMATCH', 'Production login did not return an administrator session');
    }
    writePrivateJson(statePath, storageStateFor(baseUrl, token, user), { allowedRoot: storageRoot });
    return { ready: true, role: 'admin' };
  } catch (error) {
    let cleanupError = null;
    if (token) {
      try { await destroySession({ baseUrl, token, fetchImpl }); } catch (sessionError) { cleanupError = sessionError; }
    }
    try { removePrivateFile(statePath, { allowedRoot: storageRoot }); } catch (stateError) {
      if (!cleanupError) cleanupError = stateError;
    }
    if (cleanupError) throw cleanupError;
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('PRODUCTION_BOOTSTRAP_FAILED', 'Production browser bootstrap failed', { cause: error });
  } finally {
    credential = null;
  }
}

if (require.main === module) {
  bootstrapProductionBrowserState().then(() => {
    console.log('PRODUCTION_BROWSER_STATE_READY=1');
  }).catch((error) => {
    console.error(failureSummary('BOOTSTRAP', error));
    process.exitCode = 1;
  });
}

module.exports = { bootstrapProductionBrowserState };
