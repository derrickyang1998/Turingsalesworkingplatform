'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

const defaultEnvPath = path.resolve(__dirname, '..', '..', '.env');

function loadPlatformEnvironment(options = {}) {
  const environment = options.environment || process.env;
  const envPath = options.envPath || defaultEnvPath;
  if (environment.NODE_ENV === 'test' && environment.TM_DISABLE_DOTENV === '1') {
    return { skipped: true };
  }
  const result = dotenv.config({ path: envPath, processEnv: environment, quiet: true });
  return { skipped: false, ...result };
}

function serverListenArgs(port, environment = process.env) {
  const host = String(environment.SERVER_HOST || '').trim();
  return host ? [port, host] : [port];
}

module.exports = {
  loadPlatformEnvironment,
  serverListenArgs
};
