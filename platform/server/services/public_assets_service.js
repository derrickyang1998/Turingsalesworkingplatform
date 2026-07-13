const path = require('path');

const PRIVATE_DIRECTORY_NAMES = new Set([
  'server',
  'uploads',
  'tmp',
  'backups',
  'node_modules',
  'docs',
  'nginx'
]);

const PUBLIC_ROOT_FILES = new Set([
  '/index.html',
  '/app.js',
  '/ppt.js'
]);

const PUBLIC_CLIENT_FILES = new Set([
  '/client/shared/build_info.js',
  '/client/core/navigation.js'
]);

const PUBLIC_SPA_PATHS = new Set([
  '/',
  '/m0',
  '/m0-detail',
  '/m1',
  '/m2',
  '/m3',
  '/m4',
  '/m5',
  '/kb',
  '/workflow',
  '/workflow-templates',
  '/workflow-instances',
  '/tasks',
  '/admin'
]);

function rawRequestPath(requestPath) {
  return String(requestPath || '/').split('?')[0];
}

function decodeRequestPath(requestPath) {
  let decoded = rawRequestPath(requestPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (_error) {
      return null;
    }
  }
  if (decoded.includes('\0')) return null;
  return path.posix.normalize('/' + decoded.replace(/\\/g, '/').replace(/^\/+/, ''));
}

function isPrivateRequestPath(requestPath) {
  if (PUBLIC_CLIENT_FILES.has(rawRequestPath(requestPath))) return false;
  const normalized = decodeRequestPath(requestPath);
  if (!normalized) return true;
  if (normalized === '/api' || normalized.startsWith('/api/')) return false;
  if (normalized === '/data' || normalized.startsWith('/data/')) return false;
  if (PUBLIC_ROOT_FILES.has(normalized)) return false;
  if (PUBLIC_SPA_PATHS.has(normalized)) return false;

  const firstSegment = normalized.split('/')[1].toLowerCase();
  if (PRIVATE_DIRECTORY_NAMES.has(firstSegment)) return true;
  return true;
}

function noStoreHeaders(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function sendPublicFile(publicRoot, filename) {
  return function sendFile(_req, res) {
    res.sendFile(path.join(publicRoot, filename), {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      }
    });
  };
}

function registerPublicAssets(app, express, publicRoot) {
  app.use(function denyPrivatePlatformFiles(req, res, next) {
    if (!isPrivateRequestPath(req.originalUrl || req.url)) return next();
    noStoreHeaders(res);
    return res.status(404).type('text/plain').send('Not found');
  });

  app.get('/index.html', sendPublicFile(publicRoot, 'index.html'));
  app.get('/app.js', sendPublicFile(publicRoot, 'app.js'));
  app.get('/ppt.js', sendPublicFile(publicRoot, 'ppt.js'));
  app.get('/client/shared/build_info.js', sendPublicFile(publicRoot, 'client/shared/build_info.js'));
  app.get(/^\/client\/core\/navigation\.js$/, sendPublicFile(publicRoot, 'client/core/navigation.js'));

  app.use('/data', express.static(path.join(publicRoot, 'data'), {
    dotfiles: 'deny',
    etag: false,
    fallthrough: true,
    lastModified: false,
    redirect: false,
    setHeaders: noStoreHeaders
  }));
  app.use('/data', function missingPublicData(_req, res) {
    noStoreHeaders(res);
    res.status(404).type('text/plain').send('Not found');
  });
}

module.exports = {
  isPrivateRequestPath,
  registerPublicAssets
};
