const fs = require('fs');
const path = require('path');
const pathPolicy = require('./path_policy_service');

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map(function(tag) { return tag.trim(); }).filter(Boolean);
  return String(value || '').split(/[,\n;|]/).map(function(tag) { return tag.trim(); }).filter(Boolean);
}

function sanitizeSegment(value, fallback) {
  const text = String(value || fallback || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return text || fallback || 'untitled';
}

function yamlString(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"';
}

function frontmatter(entry) {
  const tags = normalizeTags(entry.tags_json || entry.key_terms || []);
  const lines = [
    '---',
    'id: ' + entry.id,
    'title: ' + yamlString(entry.title || entry.entry_type || 'Knowledge'),
    'entry_type: ' + (entry.entry_type || 'note'),
    'source_type: ' + (entry.source_type || ''),
    'source_id: ' + yamlString(entry.source_id || ''),
    'visibility: ' + (entry.visibility || (entry.is_public ? 'team' : 'private')),
    'business_type: ' + (entry.business_type || ''),
    'business_id: ' + yamlString(entry.business_id || ''),
    'created_by: ' + (entry.created_by || ''),
    'created_at: ' + yamlString(entry.created_at || ''),
    'updated_at: ' + yamlString(entry.updated_at || ''),
    'usage_count: ' + (entry.usage_count || 0),
    'tags: [' + tags.map(yamlString).join(', ') + ']',
    '---'
  ];
  return lines.join('\n');
}

function markdownTags(entry) {
  return normalizeTags(entry.tags_json || entry.key_terms || []).map(function(tag) {
    return '#' + String(tag).replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5-]/g, '');
  }).filter(function(tag) { return tag.length > 1; }).join(' ');
}

function relatedLinks(entry) {
  const links = [];
  if (entry.business_type) links.push('业务类型:: [[' + entry.business_type + ']]');
  if (entry.business_id) links.push('业务对象:: [[' + entry.business_type + '-' + entry.business_id + ']]');
  if (entry.source_type) links.push('来源:: [[' + entry.source_type + ']]');
  return links;
}

function entryToMarkdown(entry) {
  const title = entry.title || entry.entry_type || 'Knowledge';
  const content = String(entry.content || '').trim();
  const tags = markdownTags(entry);
  const sections = [
    frontmatter(entry),
    '',
    '# ' + title,
    '',
    entry.summary ? '## 摘要\n' + entry.summary : '',
    tags ? '## 标签\n' + tags : '',
    '## 内容\n' + (content || entry.summary || ''),
    relatedLinks(entry).length ? '## 关联\n' + relatedLinks(entry).join('\n') : ''
  ];
  return sections.filter(function(section) { return section !== ''; }).join('\n\n') + '\n';
}

function entryPath(rootPath, entry) {
  const type = sanitizeSegment(entry.entry_type || 'note');
  const source = sanitizeSegment(entry.source_type || 'manual');
  const file = sanitizeSegment(String(entry.id) + '-' + (entry.title || type)) + '.md';
  return path.join(rootPath, '知识库', type, source, file);
}

function listEntries(db, user, opts) {
  opts = opts || {};
  const limit = Math.min(parseInt(opts.limit || 5000, 10) || 5000, 10000);
  const where = ['1=1'];
  const params = [];
  if (opts.entry_type) { where.push('entry_type = ?'); params.push(opts.entry_type); }
  if (opts.source_type) { where.push('source_type = ?'); params.push(opts.source_type); }
  if (opts.visibility) { where.push('visibility = ?'); params.push(opts.visibility); }
  if (!user || user.role !== 'admin') {
    where.push('(created_by = ? OR visibility IN (\'team\', \'public\', \'shared\') OR is_public = 1)');
    params.push(user && user.id ? user.id : -1);
  }
  params.push(limit);
  return db.prepare(`
    SELECT *
    FROM knowledge_entries
    WHERE ${where.join(' AND ')}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(...params);
}

function writeIndex(rootPath, entries, files) {
  const indexPath = path.join(rootPath, '知识库索引.md');
  const grouped = {};
  entries.forEach(function(entry, index) {
    const type = entry.entry_type || 'note';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push({ entry: entry, file: files[index] });
  });
  const lines = [
    '---',
    'title: "知识库索引"',
    'generated_by: "TuringMarket"',
    '---',
    '',
    '# 知识库索引',
    '',
    '生成时间：' + new Date().toISOString(),
    ''
  ];
  Object.keys(grouped).sort().forEach(function(type) {
    lines.push('## ' + type);
    grouped[type].forEach(function(item) {
      const relative = path.relative(rootPath, item.file.path).replace(/\\/g, '/');
      lines.push('- [[' + item.entry.title + ']] - `' + relative + '`');
    });
    lines.push('');
  });
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(indexPath, lines.join('\n'), 'utf8');
  return indexPath;
}

function exportKnowledgeVault(db, opts) {
  opts = opts || {};
  const validated = pathPolicy.validateRoot({
    kind: 'export',
    requestedPath: opts.rootPath || opts.root_path || process.env.PLATFORM_KB_VAULT_ROOT || pathPolicy.defaultVaultRoot()
  });
  const rootPath = validated.rootPath;
  const user = opts.user || {};
  const entries = listEntries(db, user, opts);
  const files = [];
  entries.forEach(function(entry) {
    const outPath = entryPath(rootPath, entry);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, entryToMarkdown(entry), 'utf8');
    files.push({ entry_id: entry.id, path: outPath });
  });
  const indexPath = writeIndex(rootPath, entries, files);
  return {
    rootPath: rootPath,
    allowedRoot: validated.allowedRoot,
    exported: files.length,
    files: files,
    indexPath: indexPath
  };
}

module.exports = {
  exportKnowledgeVault,
  entryToMarkdown,
  entryPath
};
