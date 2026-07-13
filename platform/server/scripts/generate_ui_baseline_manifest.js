#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASELINE_VERSION = 'v0.2.9';
const RELEASE_NAME = 'v0.3.0-baseline-consolidation';
const BASE_COMMIT = '9a591aa92e039f53a12ad7d5f098a26d0818bf08';
const SECURITY_BASE_RELEASE = 'v0.2.10-security-credential-rotation';
const SEED_FIXTURE_VERSION = 'v0.2.9-ui-fixture-1';
const MASK_VERSION = 'v0.2.9-mask-1';
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const VIEWPORTS = Object.freeze([
  { name: 'fixture-1440', width: 1440, height: 900, deviceScaleFactor: 1 },
  { name: 'fixture-1920', width: 1920, height: 1080, deviceScaleFactor: 1 },
  { name: 'fixture-mobile', width: 390, height: 844, deviceScaleFactor: 1 }
]);

const SCREENSHOT_JOURNEYS = Object.freeze([
  { role: 'public', journey: 'public-login', pageId: 'login', substate: null },
  { role: 'admin', journey: 'admin-crm-board', pageId: 'm0', substate: null },
  { role: 'admin', journey: 'admin-crm-detail-pipeline', pageId: 'm0-detail', substate: { view: 'pipeline' } },
  { role: 'admin', journey: 'admin-crm-detail-seapool', pageId: 'm0-detail', substate: { view: 'seapool' } },
  { role: 'admin', journey: 'admin-crm-detail-opportunities', pageId: 'm0-detail', substate: { view: 'opportunities' } },
  { role: 'admin', journey: 'admin-brand', pageId: 'm1', substate: null },
  { role: 'admin', journey: 'admin-strategy', pageId: 'm2', substate: null },
  { role: 'admin', journey: 'admin-demand-ppt', pageId: 'm3', substate: { surface: 'ppt' } },
  { role: 'admin', journey: 'admin-m4-tab1', pageId: 'm4', substate: { tab: 'tab1' } },
  { role: 'admin', journey: 'admin-m4-tab2', pageId: 'm4', substate: { tab: 'tab2' } },
  { role: 'admin', journey: 'admin-m4-tab3', pageId: 'm4', substate: { tab: 'tab3' } },
  { role: 'admin', journey: 'admin-ai', pageId: 'm5', substate: null },
  { role: 'admin', journey: 'admin-workflow-designer', pageId: 'workflow-designer', substate: null },
  { role: 'admin', journey: 'admin-workflow-templates', pageId: 'workflow-templates', substate: null },
  { role: 'admin', journey: 'admin-workflow-instances', pageId: 'workflow-instances', substate: null },
  { role: 'admin', journey: 'admin-workflow-tasks', pageId: 'workflow-tasks', substate: null },
  { role: 'admin', journey: 'admin-admin-overview', pageId: 'admin', substate: { tab: 'overview' } },
  { role: 'admin', journey: 'admin-admin-users', pageId: 'admin', substate: { tab: 'users' } },
  { role: 'admin', journey: 'admin-admin-knowledge', pageId: 'admin', substate: { tab: 'knowledge' } },
  { role: 'admin', journey: 'admin-admin-ai-audit', pageId: 'admin', substate: { tab: 'ai-audit' } },
  { role: 'admin', journey: 'admin-admin-tokens', pageId: 'admin', substate: { tab: 'tokens' } },
  { role: 'user', journey: 'user-crm-board', pageId: 'm0', substate: null },
  { role: 'user', journey: 'user-crm-detail', pageId: 'm0-detail', substate: { view: 'pipeline' } },
  { role: 'user', journey: 'user-ai', pageId: 'm5', substate: null }
]);

const MASK_SELECTORS = Object.freeze([
  '[data-baseline-mask]',
  '.timestamp',
  '.user-email',
  '.customer-contact',
  '.ai-response',
  '.kb-reference',
  '.workflow-runtime',
  'a[href^="http"]'
]);

const ROUTE_CONTRACT_SOURCES = Object.freeze([
  ['platform', 'server', 'server.js'],
  ['platform', 'server', 'routes.js'],
  ['platform', 'server', 'routes_customers.js'],
  ['platform', 'server', 'routes_brands.js'],
  ['platform', 'server', 'routes_workflow.js'],
  ['platform', 'server', 'services', 'public_assets_service.js']
]);

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function assertInsideRepo(repoRoot, filePath) {
  const relative = path.relative(repoRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the repository: ${filePath}`);
  }
  return toPosix(relative);
}

function assertPublicPath(relativePath) {
  if (/^[A-Za-z]:/.test(relativePath) || relativePath.includes('\\')) {
    throw new Error(`Manifest path must be repository-relative: ${relativePath}`);
  }
  if (/(^|\/)(?:\.git|node_modules)(?:\/|$)/.test(relativePath)) {
    throw new Error(`Manifest path must not reference private cache paths: ${relativePath}`);
  }
  if (/TM_PRIVATE|PRIVATE_EVIDENCE|TURINGMARKET_SERVER|\.env/i.test(relativePath)) {
    throw new Error(`Manifest path must not reference private configuration: ${relativePath}`);
  }
  return relativePath;
}

function validateBaselineVersion(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 64
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    || value === '..'
  ) {
    throw new Error(`Invalid baseline version: ${JSON.stringify(value)}`);
  }
  return value;
}

function repoRelative(repoRoot, filePath) {
  return assertPublicPath(assertInsideRepo(repoRoot, path.resolve(filePath)));
}

function sha256(bufferOrString) {
  return crypto.createHash('sha256').update(bufferOrString).digest('hex');
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function fileRecord(repoRoot, filePath) {
  const stat = fs.statSync(filePath);
  return {
    source: repoRelative(repoRoot, filePath),
    sha256: hashFile(filePath),
    bytes: stat.size
  };
}

function blankRange(chars, start, end) {
  for (let i = start; i < end; i += 1) {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
}

function maskSource(source) {
  const chars = source.split('');
  let i = 0;

  while (i < chars.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      blankRange(chars, start, i);
      continue;
    }

    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(source.length, i + 2);
      blankRange(chars, start, i);
      continue;
    }

    if (ch === '/' && isRegexLiteralStart(source, i)) {
      const start = i;
      let inClass = false;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (!inClass && source[i] === '/') {
          i += 1;
          while (/[A-Za-z]/.test(source[i] || '')) i += 1;
          break;
        } else if (source[i] === '\n') {
          break;
        }
        i += 1;
      }
      blankRange(chars, start, i);
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      blankRange(chars, start, i);
      continue;
    }

    i += 1;
  }

  return chars.join('');
}

function isRegexLiteralStart(source, slashIndex) {
  let i = slashIndex - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return true;
  return /[\(\{\[=,:;!&|?+\-*%^~<>]/.test(source[i]);
}

function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineColumnAt(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: index - lineStarts[lineIndex] + 1
  };
}

function compareNames(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function normalizeScriptEntries(scriptFiles) {
  return scriptFiles.map((entry, index) => {
    const filePath = typeof entry === 'string' ? entry : entry.path;
    if (!filePath) throw new Error('scanClassicScripts requires every entry to include a path');
    return {
      path: path.resolve(filePath),
      loadOrder: Number(entry.loadOrder || index + 1),
      inputIndex: index
    };
  }).sort((a, b) => (a.loadOrder - b.loadOrder) || (a.inputIndex - b.inputIndex));
}

function scanClassicScripts(scriptFiles, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const declarations = [];
  const occurrenceCounts = new Map();

  for (const script of normalizeScriptEntries(scriptFiles)) {
    const sourceText = fs.readFileSync(script.path, 'utf8');
    const masked = maskSource(sourceText);
    const lineStarts = buildLineStarts(sourceText);
    const source = repoRelative(repoRoot, script.path);
    const declarationRegex = /^([ \t]*)(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
    let braceDepth = 0;

    for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex += 1) {
      const lineStart = lineStarts[lineIndex];
      const lineEnd = lineStarts[lineIndex + 1] || masked.length;
      const line = masked.slice(lineStart, lineEnd);
      const match = braceDepth === 0 ? line.match(declarationRegex) : null;

      if (match) {
        const name = match[3];
        const occurrenceIndex = (occurrenceCounts.get(name) || 0) + 1;
        occurrenceCounts.set(name, occurrenceIndex);
        declarations.push({
          name,
          source,
          kind: 'function',
          async: Boolean(match[2]),
          line: lineIndex + 1,
          column: match[1].length + 1,
          loadOrder: script.loadOrder,
          occurrenceIndex,
          globalIndex: declarations.length + 1
        });
      }

      for (const ch of line) {
        if (ch === '{') braceDepth += 1;
        else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      }
    }
  }

  const byName = new Map();
  const activeDefinitions = {};
  for (const declaration of declarations) {
    if (!byName.has(declaration.name)) byName.set(declaration.name, []);
    byName.get(declaration.name).push(declaration);
    activeDefinitions[declaration.name] = declaration;
  }

  const duplicates = Array.from(byName.entries())
    .filter(([, occurrences]) => occurrences.length > 1)
    .sort(([left], [right]) => compareNames(left, right))
    .map(([name, occurrences]) => ({
      name,
      count: occurrences.length,
      occurrences,
      activeDefinition: occurrences[occurrences.length - 1]
    }));

  return {
    declarations,
    duplicates,
    activeDefinitions
  };
}

function readStringLiteral(source, startIndex) {
  let i = startIndex;
  while (/\s/.test(source[i] || '')) i += 1;
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  i += 1;
  let value = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      value += source[i + 1] || '';
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { value, endIndex: i + 1 };
    }
    value += ch;
    i += 1;
  }
  return null;
}

function collectRouteContracts(serverFiles, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const contracts = [];

  for (const serverFile of serverFiles) {
    const filePath = path.resolve(typeof serverFile === 'string' ? serverFile : serverFile.path);
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const masked = maskSource(sourceText);
    const lineStarts = buildLineStarts(sourceText);
    const source = repoRelative(repoRoot, filePath);
    const routeRegex = /\bapp\.(get|post|put|delete|patch|head|options)\s*\(/g;
    let match;

    while ((match = routeRegex.exec(masked)) !== null) {
      const literal = readStringLiteral(sourceText, routeRegex.lastIndex);
      if (!literal) continue;
      const position = lineColumnAt(lineStarts, match.index);
      contracts.push({
        method: match[1].toUpperCase(),
        path: literal.value,
        source,
        line: position.line
      });
    }
  }

  return contracts;
}

function matchSingle(source, regex, label) {
  const match = source.match(regex);
  if (!match) throw new Error(`Unable to find ${label}`);
  return match[1];
}

function collectBuildMarkers(indexHtml, buildInfoJs, pptJs) {
  return {
    buildMarkers: {
      app: matchSingle(
        buildInfoJs,
        /window\.TMBuild\s*=\s*Object\.freeze\(\{\s*app:\s*['"]([^'"]+)['"]/,
        'window.TMBuild.app'
      ),
      ppt: matchSingle(pptJs, /window\.tmPPTBuild\s*=\s*['"]([^'"]+)['"]/, 'window.tmPPTBuild')
    },
    scriptCacheKeys: {
      app: matchSingle(indexHtml, /<script\s+src=["']app\.js\?v=([^"']+)["']\s*><\/script>/, 'app.js cache key'),
      ppt: matchSingle(indexHtml, /<script\s+src=["']ppt\.js\?v=([^"']+)["']\s*><\/script>/, 'ppt.js cache key')
    }
  };
}

function optionalFixtureRecord(repoRoot, fixturePath, version) {
  const source = repoRelative(repoRoot, fixturePath);
  const exists = fs.existsSync(fixturePath);
  return {
    source,
    version,
    exists,
    sha256: exists ? hashFile(fixturePath) : null
  };
}

function activeDuplicateDefinitions(scanResult) {
  const definitions = {};
  for (const duplicate of scanResult.duplicates) {
    const active = duplicate.activeDefinition;
    definitions[duplicate.name] = {
      name: active.name,
      source: active.source,
      kind: active.kind,
      async: active.async,
      line: active.line,
      column: active.column,
      loadOrder: active.loadOrder,
      occurrenceIndex: active.occurrenceIndex,
      globalIndex: active.globalIndex
    };
  }
  return definitions;
}

function readDuplicateFixture(repoRoot, fixturePath, scanResult) {
  const source = repoRelative(repoRoot, fixturePath);
  if (!fs.existsSync(fixturePath)) {
    return {
      source,
      exists: false,
      reviewedDuplicateCount: scanResult.duplicates.length,
      duplicates: scanResult.duplicates.map((entry) => entry.name),
      activeDefinitions: activeDuplicateDefinitions(scanResult),
      sha256: null
    };
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  return {
    source,
    exists: true,
    reviewedDuplicateCount: fixture.metadata.reviewedDuplicateCount,
    duplicates: fixture.duplicates,
    activeDefinitions: fixture.activeDefinitions,
    sha256: hashFile(fixturePath)
  };
}

function buildScreenshotSlots(repoRoot, baselineVersion) {
  const slots = [];
  for (const viewport of VIEWPORTS) {
    for (const journey of SCREENSHOT_JOURNEYS) {
      const relativePath = assertPublicPath(
        `docs/baselines/${baselineVersion}/screenshots/${journey.role}/${viewport.name}/${journey.journey}.png`
      );
      const absolutePath = path.join(repoRoot, relativePath);
      const exists = fs.existsSync(absolutePath);
      slots.push({
        role: journey.role,
        viewport: viewport.name,
        journey: journey.journey,
        pageId: journey.pageId,
        substate: journey.substate ? { ...journey.substate } : null,
        path: relativePath,
        exists,
        sha256: exists ? hashFile(absolutePath) : null
      });
    }
  }
  return slots;
}

function generateManifest(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const baselineVersion = validateBaselineVersion(
    options.baselineVersion === undefined ? DEFAULT_BASELINE_VERSION : options.baselineVersion
  );
  const indexPath = path.join(repoRoot, 'platform', 'index.html');
  const appPath = path.join(repoRoot, 'platform', 'app.js');
  const buildInfoPath = path.join(repoRoot, 'platform', 'client', 'shared', 'build_info.js');
  const pptPath = path.join(repoRoot, 'platform', 'ppt.js');
  const routeContractPaths = ROUTE_CONTRACT_SOURCES.map((segments) => path.join(repoRoot, ...segments));
  const duplicateFixturePath = path.resolve(
    options.duplicateFixturePath || path.join(repoRoot, 'platform', 'server', 'tests', 'fixtures', 'frontend-active-definitions.json')
  );
  const seedFixturePath = path.resolve(
    options.seedFixturePath || path.join(repoRoot, 'platform', 'server', 'tests', 'fixtures', 'browser-baseline-data.json')
  );

  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  const appJs = fs.readFileSync(appPath, 'utf8');
  const buildInfoJs = fs.readFileSync(buildInfoPath, 'utf8');
  const pptJs = fs.readFileSync(pptPath, 'utf8');
  const markerData = collectBuildMarkers(indexHtml, buildInfoJs, pptJs);
  const scriptScan = scanClassicScripts([
    { path: appPath, loadOrder: 1 },
    { path: pptPath, loadOrder: 2 }
  ], { repoRoot });
  const duplicateFixture = readDuplicateFixture(repoRoot, duplicateFixturePath, scriptScan);

  return {
    schemaVersion: 1,
    baseline: {
      version: baselineVersion,
      release: RELEASE_NAME,
      baseCommit: BASE_COMMIT,
      securityBase: {
        release: SECURITY_BASE_RELEASE,
        baseCommit: BASE_COMMIT
      }
    },
    files: {
      indexHtml: fileRecord(repoRoot, indexPath),
      appJs: fileRecord(repoRoot, appPath),
      pptJs: fileRecord(repoRoot, pptPath)
    },
    buildMarkers: markerData.buildMarkers,
    scriptCacheKeys: markerData.scriptCacheKeys,
    routeContracts: collectRouteContracts(routeContractPaths, { repoRoot }),
    seedFixture: optionalFixtureRecord(repoRoot, seedFixturePath, SEED_FIXTURE_VERSION),
    viewports: VIEWPORTS.map((viewport) => ({ ...viewport })),
    mask: {
      version: MASK_VERSION,
      selectors: MASK_SELECTORS.slice()
    },
    screenshotSlots: buildScreenshotSlots(repoRoot, baselineVersion),
    duplicateInventory: duplicateFixture
  };
}

function parseArgs(argv) {
  const args = {
    baselineVersion: DEFAULT_BASELINE_VERSION,
    output: null,
    repoRoot: DEFAULT_REPO_ROOT
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline-version') {
      args.baselineVersion = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--repo-root') {
      args.repoRoot = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.output) throw new Error('Missing required --output <path>');
  if (!args.baselineVersion) throw new Error('Missing value for --baseline-version');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = generateManifest({
    repoRoot: args.repoRoot,
    baselineVersion: args.baselineVersion
  });
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  scanClassicScripts,
  collectRouteContracts,
  generateManifest,
  maskSource
};
