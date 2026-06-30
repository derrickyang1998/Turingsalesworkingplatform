const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const knowledgeService = require('./knowledge_service');
const fileIngestService = require('./file_ingest_service');
const pathPolicy = require('./path_policy_service');

const DEFAULT_ALLOWED_EXTS = new Set(['.md', '.txt', '.csv', '.json', '.xlsx']);
const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const SKIP_DIR_PATTERNS = [
  /(^|[\\/])\.obsidian([\\/]|$)/i,
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /(^|[\\/])99-private([\\/]|$)/i,
  /(^|[\\/])private([\\/]|$)/i,
  /(^|[\\/])secrets?([\\/]|$)/i,
  /(^|[\\/])密钥([\\/]|$)/i,
  /(^|[\\/])密码([\\/]|$)/i
];
const SKIP_FILE_PATTERNS = [
  /(^|[\\/])(.*)(secret|token|password|passwd|credential|private[-_ ]?key|api[-_ ]?key)(.*)$/i,
  /(^|[\\/])(.*)(密钥|密码|口令|凭证)(.*)$/i
];
const SECRET_CONTENT_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(DEEPSEEK|OPENAI|TAVILY|API|JWT|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_ -]*[:=]\s*["']?[^"'\s]{8,}/i,
  /\b(password|secret|token|api_key|apikey)\s*[:=]\s*["']?[^"'\s]{8,}/i
];

function normalizePathForSource(value) {
  return String(value || '').replace(/\\/g, '/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function isInsideRoot(rootPath, candidate) {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function shouldSkipPath(rootPath, filePath) {
  const relative = normalizePathForSource(path.relative(rootPath, filePath));
  const normalized = '/' + relative;
  if (SKIP_DIR_PATTERNS.some(function(pattern) { return pattern.test(normalized); })) {
    return { skip: true, reason: 'private_path' };
  }
  if (SKIP_FILE_PATTERNS.some(function(pattern) { return pattern.test(normalized); })) {
    return { skip: true, reason: 'sensitive_filename' };
  }
  return { skip: false, reason: '' };
}

function looksSensitive(content) {
  return SECRET_CONTENT_PATTERNS.some(function(pattern) { return pattern.test(String(content || '')); });
}

function listFiles(rootPath, allowedExts, limits) {
  limits = limits || {};
  const maxFiles = parseInt(limits.maxFiles || DEFAULT_MAX_FILES, 10);
  const maxDepth = parseInt(limits.maxDepth || DEFAULT_MAX_DEPTH, 10);
  const maxTotalBytes = parseInt(limits.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES, 10);
  const maxFileBytes = parseInt(limits.maxFileBytes || DEFAULT_MAX_FILE_BYTES, 10);
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  function walk(dir, depth) {
    const skip = shouldSkipPath(rootPath, dir);
    if (skip.skip) {
      if (path.resolve(dir) !== path.resolve(rootPath)) {
        skipped.push({ relativePath: normalizePathForSource(path.relative(rootPath, dir)), reason: skip.reason });
      }
      return;
    }
    if (depth > maxDepth) {
      skipped.push({ relativePath: normalizePathForSource(path.relative(rootPath, dir)), reason: 'max_depth' });
      return;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach(function(entry) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        return;
      }
      if (!entry.isFile()) return;
      const fileSkip = shouldSkipPath(rootPath, full);
      if (fileSkip.skip) {
        skipped.push({ relativePath: normalizePathForSource(path.relative(rootPath, full)), reason: fileSkip.reason });
        return;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExts.has(ext)) return;
      if (files.length >= maxFiles) {
        skipped.push({ relativePath: normalizePathForSource(path.relative(rootPath, full)), reason: 'max_files' });
        return;
      }
      const stat = fs.statSync(full);
      if (stat.size > maxFileBytes) {
        skipped.push({ relativePath: normalizePathForSource(path.relative(rootPath, full)), reason: 'max_file_bytes' });
        return;
      }
      if (totalBytes + stat.size > maxTotalBytes) {
        skipped.push({ relativePath: normalizePathForSource(path.relative(rootPath, full)), reason: 'max_total_bytes' });
        return;
      }
      totalBytes += stat.size;
      files.push(full);
    });
  }
  walk(rootPath, 0);
  return { files: files, skipped: skipped, totalBytes: totalBytes };
}

function parseFrontmatter(text) {
  const raw = String(text || '');
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { metadata: {}, body: raw };
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { metadata: {}, body: raw };
  const metadata = {};
  match[1].split(/\r?\n/).forEach(function(line) {
    const idx = line.indexOf(':');
    if (idx <= 0) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) return;
    if (/^\[.*\]$/.test(value)) {
      metadata[key] = value.replace(/^\[|\]$/g, '').split(',').map(function(item) {
        return item.trim().replace(/^["']|["']$/g, '');
      }).filter(Boolean);
    } else {
      metadata[key] = value.replace(/^["']|["']$/g, '');
    }
  });
  return { metadata: metadata, body: raw.slice(match[0].length) };
}

function titleFromContent(filePath, content) {
  const text = String(content || '');
  const heading = text.split(/\r?\n/).map(function(line) { return line.trim(); }).find(function(line) {
    return /^#\s+/.test(line);
  });
  if (heading) return heading.replace(/^#\s+/, '').trim().slice(0, 120);
  return path.basename(filePath, path.extname(filePath));
}

function tagsFromPath(relativePath, frontmatter) {
  const tags = normalizePathForSource(relativePath).split('/').slice(0, -1).filter(Boolean);
  if (frontmatter && frontmatter.tags) {
    const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : String(frontmatter.tags).split(/[,\s]+/);
    tags.push.apply(tags, fmTags);
  }
  tags.push('obsidian');
  return Array.from(new Set(tags.map(function(tag) { return String(tag || '').replace(/^#/, '').trim(); }).filter(Boolean)));
}

async function readKnowledgeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx') {
    const parsed = await fileIngestService.readUploadedFile({ path: filePath, originalname: filePath });
    return { content: parsed.content, kind: parsed.kind, rows: parsed.rows || [], metadata: {} };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (ext === '.md') {
    const parsed = parseFrontmatter(raw);
    return { content: parsed.body, kind: 'document', rows: [], metadata: parsed.metadata };
  }
  if (ext === '.csv') {
    const rows = fileIngestService.parseCsv(raw);
    return { content: fileIngestService.tableSummary(rows), kind: 'table', rows: rows, metadata: {} };
  }
  if (ext === '.json') {
    try {
      const data = JSON.parse(raw);
      const rows = Array.isArray(data) ? data : (data && Array.isArray(data.rows) ? data.rows : []);
      return {
        content: rows.length ? fileIngestService.tableSummary(rows) : JSON.stringify(data, null, 2),
        kind: rows.length ? 'table' : 'json',
        rows: rows,
        metadata: {}
      };
    } catch (e) {
      return { content: raw, kind: 'document', rows: [], metadata: {} };
    }
  }
  return { content: raw, kind: 'document', rows: [], metadata: {} };
}

async function buildCandidate(rootPath, filePath) {
  const relativePath = normalizePathForSource(path.relative(rootPath, filePath));
  const stat = fs.statSync(filePath);
  const parsed = await readKnowledgeFile(filePath);
  if (looksSensitive(parsed.content)) {
    return { skipped: true, reason: 'sensitive_content', relativePath: relativePath };
  }
  const title = parsed.metadata.title || titleFromContent(filePath, parsed.content);
  const summary = String(parsed.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    skipped: false,
    filePath: filePath,
    relativePath: relativePath,
    title: title,
    summary: summary,
    content: parsed.content,
    kind: parsed.kind,
    row_count: parsed.rows.length,
    tags: tagsFromPath(relativePath, parsed.metadata),
    metadata: Object.assign({}, parsed.metadata, {
      relative_path: relativePath,
      absolute_path_hash: sha256(filePath),
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      kind: parsed.kind,
      row_count: parsed.rows.length
    })
  };
}

async function scanObsidianFolder(opts) {
  opts = opts || {};
  const validated = pathPolicy.validateRoot({
    kind: 'import',
    requestedPath: opts.rootPath || process.env.OBSIDIAN_KB_ROOT || pathPolicy.defaultObsidianRoot()
  });
  const rootPath = validated.rootPath;
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error('Obsidian root path does not exist or is not a directory');
  }
  const allowedExts = new Set((opts.allowedExts || Array.from(DEFAULT_ALLOWED_EXTS)).map(function(ext) {
    return String(ext || '').toLowerCase().replace(/^\./, '.');
  }));
  const listed = listFiles(rootPath, allowedExts, {
    maxFiles: opts.maxFiles,
    maxDepth: opts.maxDepth,
    maxTotalBytes: opts.maxTotalBytes,
    maxFileBytes: opts.maxFileBytes
  });
  const allFiles = listed.files;
  const candidates = [];
  const skipped = listed.skipped.slice();
  for (const filePath of allFiles) {
    if (!isInsideRoot(rootPath, filePath)) {
      skipped.push({ relativePath: filePath, reason: 'outside_root' });
      continue;
    }
    const skip = shouldSkipPath(rootPath, filePath);
    if (skip.skip) {
      skipped.push({ relativePath: normalizePathForSource(path.relative(rootPath, filePath)), reason: skip.reason });
      continue;
    }
    try {
      const candidate = await buildCandidate(rootPath, filePath);
      if (candidate.skipped) {
        skipped.push({ relativePath: candidate.relativePath, reason: candidate.reason });
      } else {
        candidates.push(candidate);
      }
    } catch (e) {
      skipped.push({ relativePath: normalizePathForSource(path.relative(rootPath, filePath)), reason: 'parse_error', error: e.message });
    }
  }

  return {
    rootPath: rootPath,
    allowedRoot: validated.allowedRoot,
    eligible: candidates.length,
    skipped: skipped.length,
    totalBytes: listed.totalBytes,
    candidates: candidates,
    skippedFiles: skipped
  };
}

async function syncObsidianFolder(db, opts) {
  opts = opts || {};
  const user = opts.user || { id: opts.created_by || null, role: opts.actor_role || 'user' };
  if (user.role !== 'admin') throw new Error('Admin only');
  const scan = await scanObsidianFolder(opts);
  const dryRun = opts.dryRun === true || opts.dry_run === true;
  const visibility = opts.visibility || 'team';
  const importedEntries = [];

  if (!dryRun) {
    for (const candidate of scan.candidates) {
      const entry = knowledgeService.ingestKnowledge(db, {
        title: candidate.title,
        summary: candidate.summary,
        content: candidate.content,
        entry_type: candidate.kind === 'table' ? 'obsidian_table' : 'obsidian_note',
        source_type: 'obsidian',
        source_id: candidate.relativePath,
        visibility: visibility,
        tags: candidate.tags,
        business_type: 'obsidian',
        business_id: candidate.relativePath,
        created_by: user.id,
        actor_role: user.role,
        metadata: candidate.metadata
      });
      importedEntries.push(entry);
    }
  }

  return {
    rootPath: scan.rootPath,
    dryRun: dryRun,
    eligible: scan.eligible,
    imported: dryRun ? 0 : importedEntries.length,
    skipped: scan.skipped,
    totalBytes: scan.totalBytes,
    skippedFiles: scan.skippedFiles.slice(0, 100),
    entries: importedEntries.slice(0, 20).map(function(entry) {
      return {
        id: entry.id,
        title: entry.title,
        entry_type: entry.entry_type,
        source_type: entry.source_type,
        source_id: entry.source_id,
        visibility: entry.visibility
      };
    })
  };
}

module.exports = {
  scanObsidianFolder,
  syncObsidianFolder,
  shouldSkipPath,
  looksSensitive
};
