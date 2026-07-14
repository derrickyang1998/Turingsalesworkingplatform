'use strict';

const path = require('node:path');
const { defineConfig } = require('playwright/test');
const baselineConfig = require('./browser-baseline.config');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

module.exports = defineConfig({
  ...baselineConfig,
  testMatch: /product-shell\.spec\.js/,
  outputDir: path.join(repoRoot, '.superpowers', 'sdd', 'product-shell-artifacts'),
  use: {
    ...baselineConfig.use,
    reducedMotion: 'no-preference'
  }
});
