const knowledgeService = require('./knowledge_service');

const TEMPLATE_HEADERS = [
  'No.',
  'Date',
  'Submitter',
  'Project',
  'Product',
  'Duplicate',
  'KOL Handle',
  'Followers',
  'Link',
  'Platform',
  'Country',
  'Tag',
  'AvgViews10',
  'Cost',
  'Deliverable',
  'TuringNote',
  'Price',
  'Email',
  'CPM',
  'CPV'
];

const FIELD_ALIASES = {
  platform: ['Platform', 'platform', '社媒平台', '平台', 'Social Platform'],
  kol_handle: ['KOL Handle', 'kol_handle', 'name', 'Name', 'KOL', '网红频道名称', '网红名称', '达人名称', '频道名称'],
  profile_link: ['Link', 'Profile Link', 'profile_link', 'url', 'URL', '网红频道链接', '链接', '主页链接'],
  followers: ['Followers', 'followers', '网红粉丝量', '粉丝量', 'Fans'],
  avg_views_10: ['AvgViews10', 'Avg Views 10', 'avg_views_10', '近10个视频均播', '近10个视频平均播放', '均播'],
  avg_engagement: ['Engagement', 'avg_engagement', '互动率', 'engagement_rate'],
  category: ['Category', 'category', 'Tag', 'tags', '标签', '类目'],
  tags: ['Tag', 'Tags', 'tags', '标签'],
  region: ['Country', 'country', 'region', '国家', '地区', 'Region'],
  language: ['Language', 'language', '语言'],
  content_style: ['Content Style', 'content_style', '内容风格'],
  collab_type: ['Collab Type', 'collab_type', '合作形式'],
  cost_usd: ['Cost', 'Cost(USD)', 'cost_usd', '成本价', '报价成本'],
  cpm: ['CPM', 'cpm'],
  brand_collab_history: ['TuringNote', 'Brand History', 'brand_collab_history', 'Turing备注', '备注', '历史合作品牌'],
  contact_email: ['Email', 'email', 'contact_email', '邮箱'],
  project_name: ['Project', 'project_name', '项目'],
  product_name: ['Product', 'product_name', '推广产品', '产品'],
  reporter: ['Submitter', 'reporter', '提报人'],
  quoted_price: ['Price', 'quoted_price', '对外商务报价', '商务报价'],
  content_deliverable: ['Deliverable', 'content_deliverable', '网红交付物', '交付物'],
  is_duplicate: ['Duplicate', 'is_duplicate', '是否重复'],
  cpv: ['CPV', 'cpv']
};

function normalizeKey(key) {
  return String(key || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s._\-()/（）]+/g, '');
}

function buildKeyMap(row) {
  const map = {};
  Object.keys(row || {}).forEach(function(key) {
    map[normalizeKey(key)] = key;
  });
  return map;
}

function firstValue(row, aliases, fallback) {
  const keyMap = buildKeyMap(row);
  for (const alias of aliases || []) {
    if (Object.prototype.hasOwnProperty.call(row, alias) && row[alias] !== undefined && row[alias] !== null && row[alias] !== '') {
      return row[alias];
    }
    const actual = keyMap[normalizeKey(alias)];
    if (actual && row[actual] !== undefined && row[actual] !== null && row[actual] !== '') {
      return row[actual];
    }
  }
  return fallback === undefined ? '' : fallback;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  const upper = raw.toUpperCase();
  const match = upper.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) return 0;
  let n = Number(match[0]);
  if (!Number.isFinite(n)) return 0;
  if (/\d\s*K\b/i.test(upper)) n *= 1000;
  if (/\d\s*M\b/i.test(upper)) n *= 1000000;
  return n;
}

function parseBoolean(value) {
  const s = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', '是', '重复', 'duplicate'].indexOf(s) !== -1 ? 1 : 0;
}

function normalizeInfluencerRow(row) {
  row = row || {};
  const normalized = {};
  Object.keys(FIELD_ALIASES).forEach(function(field) {
    normalized[field] = firstValue(row, FIELD_ALIASES[field], '');
  });
  const cpv = normalized.cpv;
  normalized.platform = String(normalized.platform || '').trim();
  normalized.kol_handle = String(normalized.kol_handle || '').trim();
  normalized.profile_link = String(normalized.profile_link || '').trim();
  normalized.followers = Math.round(parseNumber(normalized.followers));
  normalized.avg_views_10 = Math.round(parseNumber(normalized.avg_views_10));
  normalized.avg_engagement = parseNumber(normalized.avg_engagement);
  normalized.category = String(normalized.category || normalized.tags || '').trim();
  normalized.tags = String(normalized.tags || normalized.category || '').trim();
  normalized.region = String(normalized.region || '').trim();
  normalized.language = String(normalized.language || '').trim();
  normalized.content_style = String(normalized.content_style || '').trim();
  normalized.collab_type = String(normalized.collab_type || 'Dedicated').trim();
  normalized.cost_usd = Math.round(parseNumber(normalized.cost_usd));
  normalized.cpm = parseNumber(normalized.cpm);
  normalized.brand_collab_history = String(normalized.brand_collab_history || '').trim();
  if (cpv) {
    normalized.brand_collab_history = [normalized.brand_collab_history, 'CPV: ' + cpv].filter(Boolean).join(' | ');
  }
  normalized.contact_email = String(normalized.contact_email || '').trim();
  normalized.project_name = String(normalized.project_name || '').trim();
  normalized.product_name = String(normalized.product_name || '').trim();
  normalized.reporter = String(normalized.reporter || '').trim();
  normalized.quoted_price = Math.round(parseNumber(normalized.quoted_price));
  normalized.content_deliverable = String(normalized.content_deliverable || '').trim();
  normalized.is_duplicate = parseBoolean(normalized.is_duplicate);
  return normalized;
}

function archiveImportKnowledge(db, rows, stats, batch, user) {
  try {
    const sample = (rows || []).slice(0, 20);
    const projectNames = Array.from(new Set(rows.map(function(row) { return row.project_name || ''; }).filter(Boolean))).slice(0, 20);
    const productNames = Array.from(new Set(rows.map(function(row) { return row.product_name || ''; }).filter(Boolean))).slice(0, 20);
    const importedTags = Array.from(new Set(rows.map(function(row) { return row.tags || row.category || ''; }).filter(Boolean))).slice(0, 30);
    return knowledgeService.ingestKnowledge(db, {
      title: '网红导入批次：' + batch,
      summary: '导入 ' + stats.imported + ' 条网红数据，跳过 ' + stats.skipped + ' 条。项目：' + (projectNames.join('、') || '-'),
      content: [
        'Batch: ' + batch,
        'Imported: ' + stats.imported,
        'Skipped: ' + stats.skipped,
        'Projects: ' + (projectNames.join(', ') || '-'),
        'Products: ' + (productNames.join(', ') || '-'),
        'Tags: ' + (importedTags.join(', ') || '-'),
        '',
        'Sample rows:',
        JSON.stringify(sample, null, 2)
      ].join('\n'),
      entry_type: 'influencer_batch',
      source_type: 'influencer_import',
      source_id: batch,
      visibility: 'team',
      tags: ['influencer', 'import'].concat(importedTags.slice(0, 10)),
      business_type: 'influencer',
      business_id: batch,
      created_by: user && user.id,
      actor_role: user && user.role,
      metadata: { imported: stats.imported, skipped: stats.skipped, total: stats.total, projectNames, productNames }
    });
  } catch (e) {
    return null;
  }
}

function importInfluencerRows(db, rows, opts) {
  opts = opts || {};
  rows = Array.isArray(rows) ? rows : [];
  if (!rows.length) {
    const err = new Error('No rows provided');
    err.statusCode = 400;
    throw err;
  }
  const insert = db.prepare(`INSERT INTO influencers (platform, kol_handle, profile_link, followers, avg_views_10, avg_engagement, category, sub_category, region, language, content_style, collab_type, cost_usd, cpm, brand_collab_history, contact_email, project_name, product_name, reporter, tags, quoted_price, content_deliverable, is_duplicate, import_batch, data_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let imported = 0;
  let skipped = 0;
  const normalizedRows = [];
  const skippedRows = [];
  const batch = opts.batch_id || opts.batch || 'import_' + Date.now();
  const doImport = db.transaction(function() {
    for (let index = 0; index < rows.length; index++) {
      const normalized = normalizeInfluencerRow(rows[index]);
      if (!normalized.kol_handle) {
        skipped++;
        skippedRows.push({ index: index + 1, reason: 'missing_kol_handle' });
        continue;
      }
      insert.run(
        normalized.platform,
        normalized.kol_handle,
        normalized.profile_link,
        normalized.followers,
        normalized.avg_views_10,
        normalized.avg_engagement,
        normalized.category,
        '',
        normalized.region,
        normalized.language,
        normalized.content_style,
        normalized.collab_type,
        normalized.cost_usd,
        normalized.cpm,
        normalized.brand_collab_history,
        normalized.contact_email,
        normalized.project_name,
        normalized.product_name,
        normalized.reporter,
        normalized.tags,
        normalized.quoted_price,
        normalized.content_deliverable,
        normalized.is_duplicate,
        batch,
        opts.data_source || 'import'
      );
      imported++;
      normalizedRows.push(normalized);
    }
  });
  doImport();
  const stats = { imported, skipped, total: rows.length, batch };
  const knowledgeEntry = archiveImportKnowledge(db, normalizedRows, stats, batch, opts.user || {});
  return {
    imported,
    skipped,
    total: rows.length,
    batch,
    skipped_rows: skippedRows,
    sample: normalizedRows.slice(0, 10),
    knowledge_entry_id: knowledgeEntry && knowledgeEntry.id
  };
}

function csvCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvLine(values) {
  return values.map(csvCell).join(',');
}

function influencerToTemplateRow(inf, index) {
  inf = inf || {};
  return [
    index + 1,
    (inf.created_at || '').substring(0, 10),
    inf.reporter || '',
    inf.project_name || '',
    inf.product_name || '',
    inf.is_duplicate ? 'Yes' : 'No',
    inf.kol_handle || '',
    inf.followers || 0,
    inf.profile_link || '',
    inf.platform || '',
    inf.region || '',
    inf.tags || inf.category || '',
    inf.avg_views_10 || 0,
    inf.cost_usd || 0,
    inf.content_deliverable || inf.collab_type || '',
    inf.brand_collab_history || '',
    inf.quoted_price || 0,
    inf.contact_email || '',
    inf.cpm || 0,
    ''
  ];
}

function buildInfluencerCsv(influencers, opts) {
  opts = opts || {};
  const lines = [];
  lines.push(csvLine(TEMPLATE_HEADERS));
  if (opts.includeAliasHint) {
    lines.push(csvLine(['# aliases: 网红频道名称 / 社媒平台 / 项目 / 推广产品 / 网红粉丝量 / 网红频道链接 are accepted']));
  }
  (influencers || []).forEach(function(inf, index) {
    lines.push(csvLine(influencerToTemplateRow(inf, index)));
  });
  return '\uFEFF' + lines.join('\n') + '\n';
}

function buildTemplateCsv() {
  return buildInfluencerCsv([{
    created_at: '2026-07-03',
    reporter: 'Derrick',
    project_name: 'Sample Launch',
    product_name: 'Sample Product',
    is_duplicate: 0,
    kol_handle: '@sample_creator',
    followers: 120000,
    profile_link: 'https://example.com/@sample_creator',
    platform: 'TikTok',
    region: 'US',
    tags: 'outdoor, tech',
    avg_views_10: 45000,
    cost_usd: 1500,
    content_deliverable: '1 short video',
    brand_collab_history: 'TuringNote sample',
    quoted_price: 2500,
    contact_email: 'creator@example.com',
    cpm: 33
  }], { includeAliasHint: true });
}

function queryInfluencers(db, opts) {
  opts = opts || {};
  let sql = 'SELECT * FROM influencers WHERE is_active = 1';
  const params = [];
  if (opts.ids && opts.ids.length) {
    sql += ' AND id IN (' + opts.ids.map(function() { return '?'; }).join(',') + ')';
    params.push.apply(params, opts.ids);
  }
  sql += ' ORDER BY followers DESC';
  return db.prepare(sql).all(...params);
}

module.exports = {
  TEMPLATE_HEADERS,
  normalizeInfluencerRow,
  importInfluencerRows,
  buildInfluencerCsv,
  buildTemplateCsv,
  queryInfluencers,
  influencerToTemplateRow
};
