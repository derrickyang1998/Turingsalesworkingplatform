'use strict';

const path = require('node:path');
const { defineConfig, devices } = require('playwright/test');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const port = Number(process.env.TM_BROWSER_FIXTURE_PORT || 43187);

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /browser-baseline\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  expect: {
    timeout: 10_000
  },
  outputDir: path.join(repoRoot, '.superpowers', 'sdd', 'playwright-artifacts'),
  webServer: {
    command: 'node server/tests/fixtures/start_browser_fixture_server.js',
    cwd: platformRoot,
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      TM_BROWSER_FIXTURE_PORT: String(port)
    }
  },
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off'
  },
  projects: [
    {
      name: 'fixture-1440',
      use: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1
      }
    },
    {
      name: 'fixture-1920',
      use: {
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1
      }
    },
    {
      name: 'fixture-mobile',
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true
      }
    }
  ]
});
