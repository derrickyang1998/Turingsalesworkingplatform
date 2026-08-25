'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UPLOAD_SANDBOX_MANIFEST_PATH = path.join(
  __dirname,
  '..',
  'systemd',
  'turingmarket-parser.manifest.json'
);
const UPLOAD_SANDBOX_RUNTIME_SERVER_ROOT =
  '/var/lib/turingmarket-parser/runtime-root/opt/turingmarket-parser/app';
const INSTALLED_CONTROL_ARTIFACTS = Object.freeze({
  'systemd/turingmarket-parser@.service': Object.freeze({
    path: '/etc/systemd/system/turingmarket-parser@.service',
    mode: 0o644
  }),
  'systemd/turingmarket-parser.slice': Object.freeze({
    path: '/etc/systemd/system/turingmarket-parser.slice',
    mode: 0o644
  })
});

function productionSelfTestEnvironment() {
  return Object.freeze({
    HOME: '/root',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: '/tmp',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    TM_UPLOAD_SANDBOX_MANIFEST_PATH: UPLOAD_SANDBOX_MANIFEST_PATH,
    TM_UPLOAD_SANDBOX_SERVER_ROOT: UPLOAD_SANDBOX_RUNTIME_SERVER_ROOT
  });
}

function verifyInstalledControlArtifacts(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || !manifest.artifacts) {
    throw new Error('Upload sandbox runtime manifest is invalid');
  }
  const fileSystem = options.fileSystem || fs;
  const createHash = options.createHash || crypto.createHash;
  const artifacts = options.artifacts || INSTALLED_CONTROL_ARTIFACTS;
  for (const [relativePath, installed] of Object.entries(artifacts)) {
    let descriptor;
    try {
      descriptor = fileSystem.openSync(
        installed.path,
        fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0)
      );
      const stat = fileSystem.fstatSync(descriptor);
      if (
        !stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || stat.gid !== 0 ||
        (stat.mode & 0o777) !== installed.mode || stat.size < 1 || stat.size > 1024 * 1024
      ) {
        throw new Error('Installed upload sandbox control artifact is unsafe');
      }
      const sha256 = createHash('sha256')
        .update(fileSystem.readFileSync(descriptor))
        .digest('hex');
      if (sha256 !== manifest.artifacts[relativePath]) {
        throw new Error('Installed upload sandbox control artifact drift');
      }
    } finally {
      if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    }
  }
  return true;
}

module.exports = {
  INSTALLED_CONTROL_ARTIFACTS,
  productionSelfTestEnvironment,
  verifyInstalledControlArtifacts
};
