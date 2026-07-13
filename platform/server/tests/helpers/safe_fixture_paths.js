'use strict';

const fs = require('node:fs');
const path = require('node:path');

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes allowed fixture root: ${child}`);
  }
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNotLink(filePath, label, stat = fs.lstatSync(filePath)) {
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} contains a symbolic link, junction, or reparse point: ${filePath}`);
  }
}

function resolveSafeFixturePath(rootPath, targetPath, label = 'fixture path') {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const rootStat = lstatIfPresent(root);
  if (!rootStat) throw new Error(`Missing fixture root: ${root}`);
  assertNotLink(root, label, rootStat);
  assertInside(root, target, label);

  let current = target;
  let nearestExisting = null;
  while (true) {
    const stat = lstatIfPresent(current);
    if (stat) {
      assertNotLink(current, label, stat);
      if (!nearestExisting) nearestExisting = current;
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`${label} escapes allowed fixture root: ${target}`);
    current = parent;
  }

  const realRoot = fs.realpathSync.native(root);
  const realExisting = fs.realpathSync.native(nearestExisting || root);
  assertInside(realRoot, realExisting, label);
  return target;
}

function ensureSafeFixtureDirectory(rootPath, targetPath, label = 'fixture directory') {
  const target = resolveSafeFixturePath(rootPath, targetPath, label);
  fs.mkdirSync(target, { recursive: true });
  resolveSafeFixturePath(rootPath, target, label);
  return target;
}

function removeSafeFixtureDirectory(rootPath, targetPath, label = 'fixture directory') {
  const root = path.resolve(rootPath);
  const target = resolveSafeFixturePath(root, targetPath, label);
  if (target === root) throw new Error(`Refusing to remove fixture root: ${root}`);
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = {
  ensureSafeFixtureDirectory,
  removeSafeFixtureDirectory,
  resolveSafeFixturePath
};
