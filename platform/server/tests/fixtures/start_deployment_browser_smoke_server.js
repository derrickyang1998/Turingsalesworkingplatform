#!/usr/bin/env node
'use strict';

const express = require('express');
const path = require('node:path');
const publicAssets = require('../../services/public_assets_service');

const platformRoot = path.resolve(__dirname, '..', '..', '..');
const portText = process.env.TM_DEPLOYMENT_SMOKE_PORT || '43188';
if (!/^[1-9][0-9]{0,4}$/.test(portText)) {
  throw new Error('Invalid deployment browser smoke port');
}
const port = Number(portText);
if (port > 65535 || port === 3002) {
  throw new Error('Invalid deployment browser smoke port');
}

const app = express();
app.disable('x-powered-by');
app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', fixture: 'deployment-browser-smoke' });
});
publicAssets.registerPublicAssets(app, express, platformRoot);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
app.use((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  res.sendFile('index.html', {
    root: platformRoot,
    dotfiles: 'deny',
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0'
    }
  });
});

const server = app.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Deployment browser smoke server ready on http://127.0.0.1:${port}\n`);
});

let shutdownStarted = false;
function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 2_000).unref();
}

server.on('error', (error) => {
  process.stderr.write(`Deployment browser smoke server failed: ${error.message}\n`);
  process.exitCode = 1;
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
