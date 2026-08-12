const path = require('path');

// Candidate only: enforcement stays parked until index.html and app.js no longer depend on inline execution.
const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'";

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
  '/client/core/navigation.js',
  '/client/core/accessibility.js',
  '/client/core/shell.js',
  '/client/core/csp_compat.js',
  '/client/features/ppt_preview_runtime.js',
  '/client/styles/tokens.css',
  '/client/styles/components.css',
  '/client/styles/layout.css'
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
    res.sendFile(filename, {
      root: publicRoot,
      dotfiles: 'deny',
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
  app.get('/client/core/navigation.js', sendPublicFile(publicRoot, 'client/core/navigation.js'));
  app.get('/client/core/accessibility.js', sendPublicFile(publicRoot, 'client/core/accessibility.js'));
  app.get('/client/core/shell.js', sendPublicFile(publicRoot, 'client/core/shell.js'));
  app.get('/client/core/csp_compat.js', sendPublicFile(publicRoot, 'client/core/csp_compat.js'));
  app.get('/client/features/ppt_preview_runtime.js', sendPublicFile(publicRoot, 'client/features/ppt_preview_runtime.js'));
  app.get('/client/styles/tokens.css', sendPublicFile(publicRoot, 'client/styles/tokens.css'));
  app.get('/client/styles/components.css', sendPublicFile(publicRoot, 'client/styles/components.css'));
  app.get('/client/styles/layout.css', sendPublicFile(publicRoot, 'client/styles/layout.css'));

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
  CONTENT_SECURITY_POLICY,
  isPrivateRequestPath,
  registerPublicAssets
};
