const fs = require('fs');
const path = require('path');

function splitList(value) {
  return String(value || '').split(/[;\n|]/).map(function(item) {
    return item.trim();
  }).filter(Boolean);
}

function defaultObsidianRoot() {
  return process.env.OBSIDIAN_KB_ROOT || 'D:\\主盘\\图灵集市';
}

function defaultVaultRoot() {
  return process.env.PLATFORM_KB_VAULT_ROOT || 'D:\\图灵商务在线平台';
}

function configuredRoots(kind) {
  const envName = kind === 'export' ? 'PLATFORM_KB_EXPORT_ALLOWLIST' : 'OBSIDIAN_KB_IMPORT_ALLOWLIST';
  const primary = kind === 'export' ? defaultVaultRoot() : defaultObsidianRoot();
  return [primary].concat(splitList(process.env[envName]));
}

function resolveExistingPath(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) return resolved;
  return fs.realpathSync(resolved);
}

function ensureDirectoryForExport(inputPath) {
  const resolved = path.resolve(inputPath);
  fs.mkdirSync(resolved, { recursive: true });
  return fs.realpathSync(resolved);
}

function isInsideOrSame(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  return childResolved === parentResolved || childResolved.startsWith(parentResolved + path.sep);
}

function validateRoot(opts) {
  opts = opts || {};
  const kind = opts.kind || 'import';
  const requested = opts.requestedPath || opts.rootPath || (kind === 'export' ? defaultVaultRoot() : defaultObsidianRoot());
  const allowed = configuredRoots(kind)
    .map(function(root) { return path.resolve(root); })
    .filter(Boolean);
  if (!allowed.length) throw new Error('No allowed knowledge root configured');

  const requestedReal = kind === 'export' ? ensureDirectoryForExport(requested) : resolveExistingPath(requested);
  const allowedReal = allowed.map(function(root) {
    if (kind === 'export') return ensureDirectoryForExport(root);
    return resolveExistingPath(root);
  });

  const match = allowedReal.find(function(root) {
    return isInsideOrSame(root, requestedReal);
  });
  if (!match) {
    const err = new Error('Knowledge root is not in the configured allowlist');
    err.code = 'ROOT_NOT_ALLOWED';
    throw err;
  }
  return {
    rootPath: requestedReal,
    allowedRoot: match
  };
}

module.exports = {
  validateRoot,
  defaultObsidianRoot,
  defaultVaultRoot
};
