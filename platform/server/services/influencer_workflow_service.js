const crypto = require('node:crypto');
const knowledgeService = require('./knowledge_service');

const IMPORT_MAPPING_VERSION = 'influencer-guided-v1';
const ERROR_REPORT_MAX_BYTES = 16 * 1024 * 1024;

const TEMPLATE_HEADERS = [
  '日期',
  '提报人',
  '项目&客户',
  '推广产品',
  '是否重复',
  '网红频道名称',
  '网红粉丝量',
  '网红频道链接',
  '社媒平台',
  '国家',
  '网红类型',
  '近10个视频均播',
  '网红成本价格（折算美元）',
  '网红交付物（植入-完播等信息）',
  'Turing备注',
  '对外商务报价（美元）',
  '网红联系方式',
  'CPM（自动计算）',
  'CPV(自动计算)',
  '父记录'
];

const FIELD_ALIASES = {
  platform: ['Platform', 'platform', '社媒平台', '平台', 'Social Platform'],
  kol_handle: ['KOL Handle', 'kol_handle', 'name', 'Name', 'KOL', '网红频道名称', '网红名称', '达人名称', '频道名称'],
  profile_link: ['Link', 'Profile Link', 'profile_link', 'url', 'URL', '网红频道链接', '链接', '主页链接'],
  followers: ['Followers', 'followers', '网红粉丝量', '粉丝量', 'Fans'],
  avg_views_10: ['AvgViews10', 'Avg Views 10', 'avg_views_10', '近10个视频均播', '近10个视频平均播放', '均播'],
  avg_engagement: ['Engagement', 'avg_engagement', '互动率', 'engagement_rate'],
  category: ['Category', 'category', 'Tag', 'tags', '标签', '类目', '网红类型'],
  influencer_type: ['网红类型', 'Influencer Type', 'Type', 'type', 'KOL Type', '达人类型'],
  tags: ['Tag', 'Tags', 'tags', '标签'],
  region: ['Country', 'country', 'region', '国家', '地区', 'Region'],
  language: ['Language', 'language', '语言'],
  content_style: ['Content Style', 'content_style', '内容风格'],
  collab_type: ['Collab Type', 'collab_type', '合作形式'],
  cost_usd: ['Cost', 'Cost(USD)', 'cost_usd', '成本价', '报价成本', '网红成本价格（折算美元）', '网红成本价格(折算美元)', '网红成本价格'],
  cpm: ['CPM', 'cpm', 'CPM（自动计算）', 'CPM(自动计算)'],
  brand_collab_history: ['TuringNote', 'Brand History', 'brand_collab_history', 'Turing备注', '备注', '历史合作品牌'],
  contact_email: ['Email', 'email', 'contact_email', '邮箱', '网红联系方式', '联系方式', '联系信息'],
  project_name: ['Project', 'project_name', '项目', '项目&客户', '项目客户'],
  product_name: ['Product', 'product_name', '推广产品', '产品'],
  reporter: ['Submitter', 'reporter', '提报人'],
  quoted_price: ['Price', 'quoted_price', '对外商务报价', '商务报价', '对外商务报价（美元）', '对外商务报价(美元)'],
  content_deliverable: ['Deliverable', 'content_deliverable', '网红交付物', '交付物', '网红交付物（植入-完播等信息）', '网红交付物(植入-完播等信息)'],
  is_duplicate: ['Duplicate', 'is_duplicate', '是否重复'],
  cpv: ['CPV', 'cpv', 'CPV(自动计算)', 'CPV（自动计算）'],
  parent_record: ['父记录', 'Parent Record', 'parent_record', 'Parent']
};

const IMPORT_FIELD_DEFINITIONS = Object.freeze([
  ['created_at', '日期', 'date', false],
  ['reporter', '提报人', 'text', false],
  ['project_name', '项目&客户', 'text', false],
  ['product_name', '推广产品', 'text', false],
  ['is_duplicate', '是否重复', 'boolean', false],
  ['kol_handle', '网红频道名称', 'text', true],
  ['followers', '网红粉丝量', 'number', false],
  ['profile_link', '网红频道链接', 'url', false],
  ['platform', '社媒平台', 'text', false],
  ['region', '国家', 'text', false],
  ['influencer_type', '网红类型', 'text', false],
  ['avg_views_10', '近10个视频均播', 'number', false],
  ['cost_usd', '网红成本价格（折算美元）', 'number', false],
  ['content_deliverable', '网红交付物（植入-完播等信息）', 'text', false],
  ['brand_collab_history', 'Turing备注', 'text', false],
  ['quoted_price', '对外商务报价（美元）', 'number', false],
  ['contact_email', '网红联系方式', 'contact', false],
  ['cpm', 'CPM（自动计算）', 'number', false],
  ['cpv', 'CPV(自动计算)', 'number', false],
  ['parent_record', '父记录', 'text', false]
].map(function(definition) {
  return Object.freeze({
    key: definition[0],
    label: definition[1],
    type: definition[2],
    required: definition[3]
  });
}));

const IMPORT_TARGETS = new Set(IMPORT_FIELD_DEFINITIONS.map(function(field) { return field.key; }));
const NUMERIC_IMPORT_FIELDS = new Set([
  'followers',
  'avg_views_10',
  'cost_usd',
  'quoted_price',
  'cpm',
  'cpv'
]);
const NON_NEGATIVE_IMPORT_FIELDS = new Set([
  'followers',
  'avg_views_10',
  'cpm',
  'cpv'
]);
const TEMPLATE_TARGETS = [
  'created_at',
  'reporter',
  'project_name',
  'product_name',
  'is_duplicate',
  'kol_handle',
  'followers',
  'profile_link',
  'platform',
  'region',
  'influencer_type',
  'avg_views_10',
  'cost_usd',
  'content_deliverable',
  'brand_collab_history',
  'quoted_price',
  'contact_email',
  'cpm',
  'cpv',
  'parent_record'
];
const SUGGESTION_OVERRIDES = Object.freeze(Object.assign(
  Object.fromEntries(TEMPLATE_HEADERS.map(function(header, index) {
    return [header, TEMPLATE_TARGETS[index]];
  })),
  {
    '标签': 'influencer_type',
    Tag: 'influencer_type',
    Tags: 'influencer_type',
    tags: 'influencer_type',
    '成本价': 'cost_usd',
    '邮箱': 'contact_email',
    cpm: 'cpm',
    cpv: 'cpv'
  }
));

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

function isBlankValue(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function isBlankRow(row) {
  return !row || Object.values(row).every(isBlankValue);
}

function parseGuidedNumericCell(value) {
  if (isBlankValue(value)) return { valid: true, value: 0 };
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { valid: true, value }
      : { valid: false, value: 0 };
  }
  const raw = String(value).trim();
  const match = raw.match(/^(?:(USD|US\$|\$|￥)\s*)?([+-]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)([KM])?(?:\s*(USD|US\$|\$|￥))?$/i);
  if (!match || (match[1] && match[5])) return { valid: false, value: 0 };
  let parsed = Number(match[3].replace(/,/g, ''));
  if (match[2] === '-') parsed *= -1;
  if (String(match[4] || '').toUpperCase() === 'K') parsed *= 1000;
  if (String(match[4] || '').toUpperCase() === 'M') parsed *= 1000000;
  return Number.isFinite(parsed)
    ? { valid: true, value: parsed }
    : { valid: false, value: 0 };
}

function importMappingError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'INVALID_FIELD_MAPPING';
  return error;
}

function collectSourceColumns(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows || []) {
    for (const source of Object.keys(row || {})) {
      if (seen.has(source)) continue;
      seen.add(source);
      columns.push(source);
    }
  }
  return columns;
}

function suggestedTarget(source) {
  const raw = String(source || '').replace(/^\uFEFF/, '').trim();
  if (!raw || /^__EMPTY(?:_\d+)?$/i.test(raw)) return 'ignore';
  if (Object.prototype.hasOwnProperty.call(SUGGESTION_OVERRIDES, raw)) {
    return SUGGESTION_OVERRIDES[raw];
  }
  for (const target of TEMPLATE_TARGETS) {
    const aliases = target === 'created_at' ? ['Date', 'date', '日期'] : (FIELD_ALIASES[target] || []);
    if (aliases.some(function(alias) { return normalizeKey(alias) === normalizeKey(raw); })) {
      return target;
    }
  }
  return 'ignore';
}

function automaticFieldMapping(columns) {
  const mapping = {};
  const claimed = new Set();
  for (const source of columns) {
    const target = suggestedTarget(source);
    if (target === 'ignore' || claimed.has(target)) {
      mapping[source] = 'ignore';
      continue;
    }
    mapping[source] = target;
    claimed.add(target);
  }
  return mapping;
}

function validateFieldMapping(rows, fieldMapping, options) {
  options = options || {};
  const sources = collectSourceColumns(rows);
  const sourceSet = new Set(sources);
  if (!fieldMapping || typeof fieldMapping !== 'object' || Array.isArray(fieldMapping)) {
    throw importMappingError('Field mapping must be an object');
  }
  const mapping = {};
  const claimed = new Set();
  for (const source of Object.keys(fieldMapping)) {
    if (!sourceSet.has(source)) throw importMappingError('Field mapping contains an unknown source column');
    const target = fieldMapping[source];
    if (typeof target !== 'string' || (target !== 'ignore' && !IMPORT_TARGETS.has(target))) {
      throw importMappingError('Field mapping contains an unknown target field');
    }
    if (target !== 'ignore' && claimed.has(target)) {
      throw importMappingError('Field mapping contains duplicate target fields');
    }
    mapping[source] = target;
    if (target !== 'ignore') claimed.add(target);
  }
  for (const source of sources) {
    if (!Object.prototype.hasOwnProperty.call(mapping, source)) mapping[source] = 'ignore';
  }
  if (options.requireHandle !== false && !claimed.has('kol_handle')) {
    throw importMappingError('Field mapping must include exactly one KOL handle source');
  }
  return mapping;
}

function mappedSourceRow(row, fieldMapping) {
  const mapped = {};
  for (const source of Object.keys(fieldMapping)) {
    const target = fieldMapping[source];
    if (target !== 'ignore') mapped[target] = row[source];
  }
  return mapped;
}

function normalizeImportDate(value) {
  if (isBlankValue(value)) return '';
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return value.toISOString().slice(0, 10) + ' 00:00:00';
  }
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:(?:T|\s)\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-') + ' 00:00:00';
}

function rowWarnings(mapped, rowNumber) {
  const warnings = [];
  const profileLink = String(mapped.profile_link || '').trim();
  if (profileLink) {
    try {
      const parsed = new URL(profileLink);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    } catch (error) {
      warnings.push({ row_number: rowNumber, field: 'profile_link', code: 'format_warning', message: '链接格式可能无效' });
    }
  }
  const contact = String(mapped.contact_email || '').trim();
  if (contact && contact.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    warnings.push({ row_number: rowNumber, field: 'contact_email', code: 'format_warning', message: '联系方式格式可能无效' });
  }
  const platform = String(mapped.platform || '').trim();
  if (platform.length > 100) {
    warnings.push({ row_number: rowNumber, field: 'platform', code: 'format_warning', message: '平台名称过长' });
  }
  return warnings;
}

function prepareMappedInfluencerRows(rows, options) {
  options = options || {};
  rows = Array.isArray(rows) ? rows : [];
  const columns = collectSourceColumns(rows);
  const explicitMapping = options.field_mapping !== undefined;
  const proposedMapping = explicitMapping ? options.field_mapping : automaticFieldMapping(columns);
  const fieldMapping = validateFieldMapping(rows, proposedMapping, {
    requireHandle: explicitMapping || columns.some(function(source) {
      return proposedMapping[source] === 'kol_handle';
    })
  });
  const rowNumberOffset = Number.isSafeInteger(options.row_number_offset)
    ? options.row_number_offset
    : 1;
  const validRows = [];
  const blankRows = [];
  const rejectedRows = [];
  const warnings = [];

  rows.forEach(function(row, index) {
    const rowNumber = index + rowNumberOffset;
    if (isBlankRow(row)) {
      blankRows.push({ row_number: rowNumber, source_row: row || {} });
      return;
    }
    const mapped = mappedSourceRow(row || {}, fieldMapping);
    const errors = [];
    if (isBlankValue(mapped.kol_handle)) {
      errors.push({ row_number: rowNumber, field: 'kol_handle', code: 'required', message: '网红频道名称不能为空' });
    }
    for (const field of NUMERIC_IMPORT_FIELDS) {
      const numericCell = parseGuidedNumericCell(mapped[field]);
      if (!numericCell.valid) {
        errors.push({ row_number: rowNumber, field, code: 'invalid_number', message: '数值格式无效' });
      } else if (NON_NEGATIVE_IMPORT_FIELDS.has(field) && numericCell.value < 0) {
        errors.push({ row_number: rowNumber, field, code: 'negative_number', message: '该指标不能为负数' });
      }
    }
    const createdAt = normalizeImportDate(mapped.created_at);
    if (createdAt === null) {
      errors.push({ row_number: rowNumber, field: 'created_at', code: 'invalid_date', message: '日期格式无效' });
    }
    if (errors.length) {
      rejectedRows.push({ row_number: rowNumber, source_row: row || {}, errors });
      return;
    }
    const normalized = normalizeInfluencerRow(mapped);
    normalized.created_at = createdAt;
    validRows.push(normalized);
    warnings.push.apply(warnings, rowWarnings(mapped, rowNumber));
  });

  return {
    columns,
    fieldMapping,
    validRows,
    blankRows,
    rejectedRows,
    warnings
  };
}

function buildErrorReportCsv(rejectedRows) {
  const chunks = [];
  let byteCount = 0;

  function append(chunk) {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (byteCount + chunkBytes > ERROR_REPORT_MAX_BYTES) {
      const error = new Error('Influencer import error report exceeds the size limit.');
      error.statusCode = 413;
      error.code = 'INFLUENCER_IMPORT_ERROR_REPORT_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
    byteCount += chunkBytes;
  }

  append('\uFEFFrow_number,field,code,message,source_row\n');
  for (const rejected of rejectedRows) {
    const errors = Array.isArray(rejected.errors) ? rejected.errors : [];
    append(csvLine([
      rejected.row_number,
      JSON.stringify(errors.map(function(error) { return error.field; })),
      JSON.stringify(errors.map(function(error) { return error.code; })),
      JSON.stringify(errors.map(function(error) { return error.message; })),
      JSON.stringify(rejected.source_row)
    ]) + '\n');
  }
  return chunks.join('');
}

function previewInfluencerImport(rows, options) {
  options = options || {};
  rows = Array.isArray(rows) ? rows : [];
  const prepared = prepareMappedInfluencerRows(rows, options);
  const allErrors = prepared.rejectedRows.flatMap(function(rejected) { return rejected.errors; });
  return {
    mapping_version: IMPORT_MAPPING_VERSION,
    fields: IMPORT_FIELD_DEFINITIONS,
    columns: prepared.columns.map(function(source, index) {
      const samples = [];
      for (const row of rows) {
        if (samples.length >= 3) break;
        const value = row && row[source];
        if (!isBlankValue(value) && !samples.includes(String(value))) samples.push(String(value));
      }
      return {
        source,
        position: index + 1,
        suggested_target: prepared.fieldMapping[source],
        samples
      };
    }),
    row_count: rows.length,
    blank_count: prepared.blankRows.length,
    valid_count: prepared.validRows.length,
    error_count: prepared.rejectedRows.length,
    warning_count: prepared.warnings.length,
    row_errors: allErrors.slice(0, 100),
    row_errors_truncated: allErrors.length > 100,
    error_report_csv: buildErrorReportCsv(prepared.rejectedRows),
    sample: prepared.validRows.slice(0, 10)
  };
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
  normalized.platform = String(normalized.platform || '').trim();
  normalized.kol_handle = String(normalized.kol_handle || '').trim();
  normalized.profile_link = String(normalized.profile_link || '').trim();
  normalized.followers = Math.round(parseNumber(normalized.followers));
  normalized.avg_views_10 = Math.round(parseNumber(normalized.avg_views_10));
  normalized.avg_engagement = parseNumber(normalized.avg_engagement);
  normalized.influencer_type = String(normalized.influencer_type || normalized.category || normalized.tags || '').trim();
  normalized.category = String(normalized.category || normalized.influencer_type || normalized.tags || '').trim();
  normalized.tags = String(normalized.tags || normalized.category || normalized.influencer_type || '').trim();
  normalized.region = String(normalized.region || '').trim();
  normalized.language = String(normalized.language || '').trim();
  normalized.content_style = String(normalized.content_style || '').trim();
  normalized.collab_type = String(normalized.collab_type || 'Dedicated').trim();
  normalized.cost_usd = Math.abs(Math.round(parseNumber(normalized.cost_usd)));
  normalized.cpm = Math.abs(parseNumber(normalized.cpm));
  normalized.cpv = Math.abs(parseNumber(normalized.cpv));
  normalized.brand_collab_history = String(normalized.brand_collab_history || '').trim();
  normalized.contact_email = String(normalized.contact_email || '').trim();
  normalized.project_name = String(normalized.project_name || '').trim();
  normalized.product_name = String(normalized.product_name || '').trim();
  normalized.reporter = String(normalized.reporter || '').trim();
  normalized.quoted_price = Math.abs(Math.round(parseNumber(normalized.quoted_price)));
  normalized.content_deliverable = String(normalized.content_deliverable || '').trim();
  normalized.is_duplicate = parseBoolean(normalized.is_duplicate);
  normalized.parent_record = String(normalized.parent_record || '').trim();
  return normalized;
}

function archiveImportKnowledge(db, rows, stats, batch, rowsSha256, user) {
  const sample = (rows || []).slice(0, 20);
  const projectNames = Array.from(new Set(rows.map(function(row) { return row.project_name || ''; }).filter(Boolean))).slice(0, 20);
  const productNames = Array.from(new Set(rows.map(function(row) { return row.product_name || ''; }).filter(Boolean))).slice(0, 20);
  const importedTags = Array.from(new Set(rows.map(function(row) { return row.tags || row.category || ''; }).filter(Boolean))).slice(0, 30);
  return knowledgeService.ingestBusinessArtifact(db, {
    artifactType: 'influencer_batch',
    artifactState: 'ingested',
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
    sourceId: batch,
    visibility: 'team',
    tags: ['influencer', 'import'].concat(importedTags.slice(0, 10)),
    businessType: 'influencer',
    businessId: batch,
    createdBy: user && user.id,
    actorRole: user && user.role,
    metadata: {
      imported: stats.imported,
      skipped: stats.skipped,
      total: stats.total,
      rows_sha256: rowsSha256,
      projectNames,
      productNames
    }
  });
}

function influencerBatchConflict(message) {
  const error = new knowledgeService.CampaignKnowledgeConflictError(message);
  error.message = message;
  return error;
}

function importInfluencerRows(db, rows, opts) {
  opts = opts || {};
  rows = Array.isArray(rows) ? rows : [];
  if (!rows.length) {
    const err = new Error('No rows provided');
    err.statusCode = 400;
    throw err;
  }
  const guided = opts.field_mapping !== undefined;
  const insert = db.prepare(`INSERT INTO influencers (platform, kol_handle, profile_link, followers, avg_views_10, avg_engagement, category, sub_category, region, language, content_style, collab_type, cost_usd, cpm, brand_collab_history, contact_email, project_name, product_name, reporter, tags, quoted_price, content_deliverable, is_duplicate, import_batch, data_source, influencer_type, cpv, parent_record${guided ? ', created_at' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${guided ? ', COALESCE(?, CURRENT_TIMESTAMP)' : ''})`);
  let skipped = 0;
  let blankCount = 0;
  let errorCount = 0;
  let rowErrors = [];
  let rowErrorsTruncated = false;
  let errorReportCsv = '';
  let warningCount = 0;
  let rowWarnings = [];
  const normalizedRows = [];
  const skippedRows = [];
  const batch = opts.batch_id || opts.batch || 'import_' + Date.now();
  if (opts.field_mapping !== undefined) {
    const prepared = prepareMappedInfluencerRows(rows, opts);
    normalizedRows.push.apply(normalizedRows, prepared.validRows);
    blankCount = prepared.blankRows.length;
    errorCount = prepared.rejectedRows.length;
    skipped = blankCount + errorCount;
    const allErrors = prepared.rejectedRows.flatMap(function(rejected) { return rejected.errors; });
    rowErrors = allErrors.slice(0, 100);
    rowErrorsTruncated = allErrors.length > rowErrors.length;
    errorReportCsv = buildErrorReportCsv(prepared.rejectedRows);
    warningCount = prepared.warnings.length;
    rowWarnings = prepared.warnings.slice(0, 100);
    for (const blank of prepared.blankRows) {
      skippedRows.push({ index: blank.row_number, reason: 'blank_row' });
    }
    for (const rejected of prepared.rejectedRows) {
      skippedRows.push({ index: rejected.row_number, reason: rejected.errors[0].code });
    }
  } else {
    for (let index = 0; index < rows.length; index++) {
      const normalized = normalizeInfluencerRow(rows[index]);
      if (!normalized.kol_handle) {
        skipped++;
        skippedRows.push({ index: index + 1, reason: 'missing_kol_handle' });
        continue;
      }
      normalizedRows.push(normalized);
    }
  }
  const rowsSha256 = crypto.createHash('sha256')
    .update(Buffer.from(JSON.stringify(normalizedRows), 'utf8'))
    .digest('hex');
  const archiveStats = {
    imported: normalizedRows.length,
    skipped,
    total: rows.length,
    batch
  };
  let archiveResult;
  let imported = 0;
  let replayed = false;
  const doImport = db.transaction(function() {
    archiveResult = archiveImportKnowledge(
      db,
      normalizedRows,
      archiveStats,
      batch,
      rowsSha256,
      opts.user || {}
    );
    if (archiveResult.status === 'exact_existing' || archiveResult.status === 'reused') {
      const existingRows = db.prepare(`
        SELECT COUNT(*) AS count FROM influencers WHERE import_batch=?
      `).get(batch).count;
      if (existingRows !== normalizedRows.length) {
        throw influencerBatchConflict(
          'Influencer batch archive and imported rows are inconsistent'
        );
      }
      replayed = true;
      return;
    }
    if (archiveResult.status !== 'created') {
      throw influencerBatchConflict('Influencer batch archive status is invalid');
    }
    for (const normalized of normalizedRows) {
      const values = [
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
        opts.data_source || 'import',
        normalized.influencer_type,
        normalized.cpv,
        normalized.parent_record
      ];
      if (guided) values.push(normalized.created_at || null);
      insert.run(...values);
      imported++;
    }
  });
  doImport.immediate();
  const result = {
    imported,
    skipped,
    total: rows.length,
    batch,
    skipped_rows: skippedRows,
    sample: normalizedRows.slice(0, 10),
    knowledge_entry_id: archiveResult && archiveResult.entry && archiveResult.entry.id
  };
  if (opts.field_mapping !== undefined) {
    result.blank_count = blankCount;
    result.error_count = errorCount;
    result.warning_count = warningCount;
    result.row_errors = rowErrors;
    result.row_errors_truncated = rowErrorsTruncated;
    result.row_warnings = rowWarnings;
    result.error_report_csv = errorReportCsv;
  }
  Object.defineProperty(result, 'replayed', {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false
  });
  return result;
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
    inf.influencer_type || inf.category || inf.tags || '',
    inf.avg_views_10 || 0,
    inf.cost_usd || 0,
    inf.content_deliverable || inf.collab_type || '',
    inf.brand_collab_history || '',
    inf.quoted_price || 0,
    inf.contact_email || '',
    inf.cpm || 0,
    inf.cpv || 0,
    inf.parent_record || ''
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
    project_name: 'Sample Launch / Sample Customer',
    product_name: 'Sample Product',
    is_duplicate: 0,
    kol_handle: '@sample_creator',
    followers: 120000,
    profile_link: 'https://example.com/@sample_creator',
    platform: 'TikTok',
    region: 'US',
    influencer_type: 'Outdoor Tech',
    tags: 'Outdoor Tech',
    avg_views_10: 45000,
    cost_usd: 1500,
    content_deliverable: '1 short video',
    brand_collab_history: 'TuringNote sample',
    quoted_price: 2500,
    contact_email: 'creator@example.com',
    cpm: 33,
    cpv: 0.05,
    parent_record: 'CRM-001'
  }]);
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
  IMPORT_MAPPING_VERSION,
  IMPORT_FIELD_DEFINITIONS,
  TEMPLATE_HEADERS,
  normalizeInfluencerRow,
  previewInfluencerImport,
  importInfluencerRows,
  buildInfluencerCsv,
  buildTemplateCsv,
  queryInfluencers,
  influencerToTemplateRow
};
