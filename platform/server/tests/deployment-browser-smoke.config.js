'use strict';

const path = require('node:path');
const { defineConfig, devices } = require('playwright/test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const port = Number(process.env.TM_DEPLOYMENT_SMOKE_PORT || 43188);
process.env.TM_BROWSER_FIXTURE_PORT = String(port);

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /deployment-browser-smoke\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: path.join(repoRoot, '.superpowers', 'sdd', 'deployment-smoke-artifacts'),
  webServer: {
    command: 'node server/tests/fixtures/start_browser_fixture_server.js',
    cwd: platformRoot,
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { TM_BROWSER_FIXTURE_PORT: String(port) }
  },
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off'
  },
  projects: [{ name: 'deployment-chromium' }]
});
