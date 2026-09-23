'use strict';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 120;
const CATEGORIES = new Set(['all', 'provider', 'import', 'workflow', 'security']);

class AdminOperationsServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AdminOperationsServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function serviceError(statusCode, code, message) {
  return new AdminOperationsServiceError(statusCode, code, message);
}

function positiveInteger(value, label) {
  const source = typeof value === 'number' ? String(value) : value;
  if (typeof source !== 'string' || !/^[1-9]\d*$/.test(source)) {
    throw serviceError(400, 'INVALID_ADMIN_OPERATIONS_FILTER', `${label} must be a positive integer.`);
  }
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed)) {
    throw serviceError(400, 'INVALID_ADMIN_OPERATIONS_FILTER', `${label} must be safe.`);
  }
  return parsed;
}

function boundedQuery(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > MAX_QUERY_LENGTH) {
    throw serviceError(400, 'INVALID_ADMIN_OPERATIONS_FILTER', 'q is invalid.');
  }
  return value.trim();
}

function boundedLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const limit = positiveInteger(value, 'limit');
  if (limit > MAX_LIMIT) throw serviceError(400, 'INVALID_ADMIN_OPERATIONS_FILTER', 'limit is too large.');
  return limit;
}

function category(value) {
  const normalized = value === undefined || value === null || value === '' ? 'all' : value;
  if (typeof normalized !== 'string' || !CATEGORIES.has(normalized)) {
    throw serviceError(400, 'INVALID_ADMIN_OPERATIONS_FILTER', 'category is invalid.');
  }
  return normalized;
}

function assertPlatformAdmin(db, actor) {
  const actorId = positiveInteger(actor && actor.id, 'actor.id');
  const row = db.prepare('SELECT id,role,is_active FROM users WHERE id=?').get(actorId);
  if (!row || row.role !== 'admin' || row.is_active !== 1 || !actor || actor.role !== 'admin') {
    throw serviceError(403, 'ADMIN_REQUIRED', 'Platform administrator access is required.');
  }
  return actorId;
}

function categorySql() {
  return `CASE
    WHEN lower(COALESCE(activity.module,'')) LIKE '%security%'
      OR lower(activity.action) LIKE '%login%'
      OR lower(activity.action) LIKE '%password%'
      OR lower(activity.action) LIKE '%session%'
      OR lower(activity.action) LIKE '%credential%' THEN 'security'
    WHEN lower(COALESCE(activity.module,'')) LIKE '%workflow%'
      OR lower(activity.action) LIKE '%workflow%'
      OR lower(activity.action) LIKE '%task%' THEN 'workflow'
    WHEN lower(COALESCE(activity.module,'')) LIKE '%import%'
      OR lower(activity.action) LIKE '%import%'
      OR lower(activity.action) LIKE '%upload%' THEN 'import'
    WHEN lower(COALESCE(activity.module,'')) LIKE '%provider%'
      OR lower(activity.action) LIKE '%provider%'
      OR lower(activity.action) LIKE '%feishu%'
      OR lower(activity.action) LIKE '%collection%'
      OR lower(activity.action) LIKE '%sync%' THEN 'provider'
    ELSE 'other'
  END`;
}

function createAdminOperationsService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A better-sqlite3 database is required.');
  }

  function listOperations(options = {}) {
    const query = options.query && typeof options.query === 'object' ? options.query : {};
    const q = boundedQuery(query.q);
    const selectedCategory = category(query.category);
    const limit = boundedLimit(query.limit);
    const cursor = query.cursor === undefined || query.cursor === '' ? null : positiveInteger(query.cursor, 'cursor');
    return db.transaction(() => {
      const actorUserId = assertPlatformAdmin(db, options.actor);
      const classification = categorySql();
      const where = `
        WHERE (? IS NULL OR activity.id < ?)
          AND (?='' OR (
            instr(lower(COALESCE(activity.action,'')),lower(?))>0 OR
            instr(lower(COALESCE(activity.module,'')),lower(?))>0 OR
            instr(lower(COALESCE(activity.details,'')),lower(?))>0 OR
            instr(lower(COALESCE(user.username,'')),lower(?))>0 OR
            instr(lower(COALESCE(user.display_name,'')),lower(?))>0
          ))
          AND (?='all' OR (${classification})=?)`;
      const params = [cursor, cursor, q, q, q, q, q, q, selectedCategory, selectedCategory];
      const rows = db.prepare(`
        SELECT activity.id, activity.action, activity.module, activity.details,
          activity.ip_address, activity.created_at,
          user.username, user.display_name,
          (${classification}) AS category
        FROM activity_log activity
        LEFT JOIN users user ON user.id=activity.user_id
        ${where}
        ORDER BY activity.id DESC
        LIMIT ?
      `).all(...params, limit + 1);
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit).map((row) => ({
        id: row.id,
        action: row.action,
        module: row.module,
        details: row.details,
        ip_address: row.ip_address,
        created_at: row.created_at,
        category: row.category,
        actor: row.username ? { username: row.username, display_name: row.display_name } : null
      }));
      const summaryRows = db.prepare(`
        SELECT (${classification}) AS category, COUNT(*) AS count
        FROM activity_log activity
        LEFT JOIN users user ON user.id=activity.user_id
        ${where}
        GROUP BY (${classification})
        ORDER BY category
      `).all(...params);
      const summary = { provider: 0, import: 0, workflow: 0, security: 0, other: 0 };
      for (const row of summaryRows) summary[row.category] = Number(row.count);
      const nextCursor = hasMore ? events[events.length - 1].id : null;
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details,ip_address)
        VALUES (?,'admin_operations_read','security',?,?)
      `).run(actorUserId, JSON.stringify({
        schema_version: 1,
        request_id: options.requestId || null,
        category: selectedCategory,
        query: q ? '[provided]' : '',
        result_count: events.length,
        next_cursor: nextCursor
      }), options.ipAddress || null);
      return { events, summary, page: { limit, next_cursor: nextCursor, has_more: hasMore } };
    }).immediate();
  }

  return Object.freeze({ listOperations });
}

module.exports = {
  AdminOperationsServiceError,
  createAdminOperationsService,
  categorySql
};
