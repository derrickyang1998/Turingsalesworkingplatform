'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

const defaultEnvPath = path.resolve(__dirname, '..', '..', '.env');
const supportedNodeEnvironments = new Set(['development', 'test', 'production']);
const pythonChildEnvironmentAllowlist = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir',
  'TEMP', 'TMP', 'TMPDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
  'HOME', 'USERPROFILE', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'SystemDrive', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ'
]);
const knownJwtSecrets = new Set([
  'turingmarket-platform-jwt-secret-2026'
]);
const canonicalJwtSecretPattern = /^[A-Za-z0-9_-]{43}$/;
const jwtSecretDecodedByteLength = 32;
const minimumDistinctJwtSecretBytes = 16;

function loadPlatformEnvironment(options = {}) {
  const environment = options.environment || process.env;
  const envPath = options.envPath || environment.TM_ENV_FILE || defaultEnvPath;
  if (environment.NODE_ENV === 'test' && environment.TM_DISABLE_DOTENV === '1') {
    return { skipped: true };
  }
  const result = dotenv.config({ path: envPath, processEnv: environment, quiet: true });
  return { skipped: false, ...result };
}

function invalidRuntimeConfiguration(requirement) {
  const error = new Error(`Invalid runtime configuration: ${requirement}`);
  error.code = 'INVALID_RUNTIME_CONFIGURATION';
  return error;
}

function decodeCanonicalJwtSecret(secret) {
  if (!canonicalJwtSecretPattern.test(secret)) return null;

  const decodedSecret = Buffer.from(secret, 'base64url');
  if (
    decodedSecret.length !== jwtSecretDecodedByteLength ||
    decodedSecret.toString('base64url') !== secret
  ) {
    return null;
  }

  return decodedSecret;
}

function hasRepeatingPeriod(bytes) {
  for (let period = 1; period <= bytes.length / 2; period += 1) {
    let repeats = true;
    for (let index = period; index < bytes.length; index += 1) {
      if (bytes[index] !== bytes[index % period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

function hasConstantByteDelta(bytes) {
  const delta = (bytes[1] - bytes[0] + 256) % 256;
  for (let index = 2; index < bytes.length; index += 1) {
    if ((bytes[index] - bytes[index - 1] + 256) % 256 !== delta) return false;
  }
  return true;
}

function isStructurallyWeakJwtSecret(bytes) {
  return new Set(bytes).size < minimumDistinctJwtSecretBytes ||
    hasRepeatingPeriod(bytes) ||
    hasConstantByteDelta(bytes);
}

function validateNetworkRuntimeConfig(environment = process.env) {
  const nodeEnv = environment.NODE_ENV;
  if (typeof nodeEnv !== 'string' || !supportedNodeEnvironments.has(nodeEnv)) {
    throw invalidRuntimeConfiguration(
      'NODE_ENV must be exactly one of development, test, or production'
    );
  }

  const jwtSecret = environment.JWT_SECRET;
  if (typeof jwtSecret !== 'string' || jwtSecret.length === 0) {
    throw invalidRuntimeConfiguration('JWT_SECRET must be externally configured');
  }
  if (knownJwtSecrets.has(jwtSecret)) {
    throw invalidRuntimeConfiguration(
      'JWT_SECRET must not use a known default'
    );
  }
  const decodedJwtSecret = decodeCanonicalJwtSecret(jwtSecret);
  if (!decodedJwtSecret) {
    throw invalidRuntimeConfiguration(
      'JWT_SECRET must be canonical unpadded base64url encoding of exactly 32 bytes'
    );
  }
  if (isStructurallyWeakJwtSecret(decodedJwtSecret)) {
    throw invalidRuntimeConfiguration(
      'JWT_SECRET must not contain a structurally weak decoded byte pattern'
    );
  }

  return { nodeEnv, jwtSecret };
}

function serverListenArgs(port, environment = process.env) {
  if (environment.SERVER_HOST !== '127.0.0.1') {
    throw invalidRuntimeConfiguration('SERVER_HOST must be exactly 127.0.0.1');
  }
  return [port, '127.0.0.1'];
}

function pythonChildEnvironment(environment = process.env) {
  const childEnvironment = {};
  for (const key of pythonChildEnvironmentAllowlist) {
    if (Object.prototype.hasOwnProperty.call(environment, key)) {
      childEnvironment[key] = environment[key];
    }
  }
  childEnvironment.PYTHONUTF8 = '1';
  childEnvironment.PYTHONDONTWRITEBYTECODE = '1';
  return childEnvironment;
}

module.exports = {
  loadPlatformEnvironment,
  pythonChildEnvironment,
  serverListenArgs,
  validateNetworkRuntimeConfig
};
