'use strict';

const INFLUENCER_VIEW_COLUMN_KEYS = Object.freeze([
  'id',
  'kol_handle',
  'platform',
  'followers',
  'project_name',
  'product_name',
  'region',
  'type',
  'parent_record',
  'profile_link',
  'content_deliverable',
  'cost_usd',
  'quoted_price',
  'cpm',
  'cpv'
]);

const INFLUENCER_VIEW_FILTER_KEYS = Object.freeze([
  'search',
  'platform',
  'region',
  'project_name',
  'product_name',
  'tags',
  'filter_id',
  'filter_kol_handle',
  'filter_platform',
  'filter_followers',
  'filter_project_name',
  'filter_product_name',
  'filter_region',
  'filter_type',
  'filter_parent_record',
  'filter_profile_link',
  'filter_content_deliverable',
  'filter_cost_usd',
  'filter_quoted_price',
  'filter_cpm',
  'filter_cpv',
  'filter_cost'
]);

const COLUMN_KEY_SET = new Set(INFLUENCER_VIEW_COLUMN_KEYS);
const FILTER_KEY_SET = new Set(INFLUENCER_VIEW_FILTER_KEYS);

class InfluencerSavedViewError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'InfluencerSavedViewError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

function viewError(statusCode, code, message) {
  return new InfluencerSavedViewError(statusCode, code, message);
}

function requireUserId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('userId must be a positive safe integer');
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeName(value) {
  if (typeof value !== 'string') {
    throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'View name is required.');
  }
  const name = value.trim();
  if (!name || name.length > 32 || /[\u0000-\u001f]/u.test(name)) {
    throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'View name is invalid.');
  }
  return name;
}

function normalizeFilters(value) {
  if (!isPlainObject(value)) {
    throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'View filters must be an object.');
  }
  const normalized = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!FILTER_KEY_SET.has(key)) {
      throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'View filter is not supported.');
    }
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
      throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'View filter value is invalid.');
    }
    const filterValue = String(rawValue).trim();
    if (filterValue.length > 200) {
      throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'View filter value is too long.');
    }
    if (filterValue) normalized[key] = filterValue;
  }
  return normalized;
}

function normalizeColumnOrder(value) {
  if (!Array.isArray(value) || value.length !== INFLUENCER_VIEW_COLUMN_KEYS.length) {
    throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'Column order is invalid.');
  }
  const seen = new Set();
  for (const key of value) {
    if (typeof key !== 'string' || !COLUMN_KEY_SET.has(key) || seen.has(key)) {
      throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'Column order is invalid.');
    }
    seen.add(key);
  }
  return value.slice();
}

function normalizeVisibleColumns(value, columnOrder) {
  if (!Array.isArray(value) || value.length < 1 || value.length > columnOrder.length) {
    throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'Visible columns are invalid.');
  }
  const visible = new Set();
  for (const key of value) {
    if (typeof key !== 'string' || !COLUMN_KEY_SET.has(key) || visible.has(key)) {
      throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'Visible columns are invalid.');
    }
    visible.add(key);
  }
  return columnOrder.filter((key) => visible.has(key));
}

function normalizeBody(body) {
  if (!isPlainObject(body)) {
    throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'Saved view body is invalid.');
  }
  const allowed = new Set(['name', 'filters', 'visible_columns', 'column_order']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'Saved view body is invalid.');
  }
  const columnOrder = normalizeColumnOrder(body.column_order);
  return {
    name: normalizeName(body.name),
    filters: normalizeFilters(body.filters),
    visibleColumns: normalizeVisibleColumns(body.visible_columns, columnOrder),
    columnOrder
  };
}

function parseView(row) {
  return {
    id: row.id,
    name: row.name,
    filters: JSON.parse(row.filters_json),
    visible_columns: JSON.parse(row.visible_columns_json),
    column_order: JSON.parse(row.column_order_json),
    row_version: row.row_version,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function createInfluencerSavedViewService(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('influencer saved-view service requires a SQLite database');
  }

  function activeUser(userId) {
    return db.prepare('SELECT id FROM users WHERE id=? AND is_active=1').get(userId) || null;
  }

  function list(input) {
    const userId = requireUserId(input && input.userId);
    if (!activeUser(userId)) return { views: [] };
    const rows = db.prepare(`
      SELECT id,name,filters_json,visible_columns_json,column_order_json,row_version,created_at,updated_at
      FROM influencer_saved_views
      WHERE user_id=?
      ORDER BY updated_at DESC,id DESC
    `).all(userId);
    return { views: rows.map(parseView) };
  }

  function save(input) {
    const userId = requireUserId(input && input.userId);
    if (!activeUser(userId)) {
      throw viewError(404, 'INFLUENCER_VIEW_NOT_FOUND', 'Saved view owner was not found.');
    }
    const normalized = normalizeBody(input && input.body);
    return db.transaction(() => {
      const existing = db.prepare(`
        SELECT id,row_version
        FROM influencer_saved_views
        WHERE user_id=? AND lower(name)=lower(?)
      `).get(userId, normalized.name);
      let status;
      let id;
      if (existing) {
        db.prepare(`
          UPDATE influencer_saved_views
          SET name=?,filters_json=?,visible_columns_json=?,column_order_json=?,
              row_version=row_version+1,updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND user_id=?
        `).run(
          normalized.name,
          JSON.stringify(normalized.filters),
          JSON.stringify(normalized.visibleColumns),
          JSON.stringify(normalized.columnOrder),
          existing.id,
          userId
        );
        id = existing.id;
        status = 200;
      } else {
        const count = db.prepare('SELECT COUNT(*) AS count FROM influencer_saved_views WHERE user_id=?').get(userId).count;
        if (count >= 20) {
          throw viewError(409, 'INFLUENCER_VIEW_LIMIT', 'Each account can save up to 20 influencer views.');
        }
        id = Number(db.prepare(`
          INSERT INTO influencer_saved_views (
            user_id,name,filters_json,visible_columns_json,column_order_json
          ) VALUES (?,?,?,?,?)
        `).run(
          userId,
          normalized.name,
          JSON.stringify(normalized.filters),
          JSON.stringify(normalized.visibleColumns),
          JSON.stringify(normalized.columnOrder)
        ).lastInsertRowid);
        status = 201;
      }
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details,ip_address)
        VALUES (?,'influencer_view_saved','influencer',?,NULL)
      `).run(userId, JSON.stringify({ view_id: id, created: status === 201 }));
      const row = db.prepare(`
        SELECT id,name,filters_json,visible_columns_json,column_order_json,row_version,created_at,updated_at
        FROM influencer_saved_views WHERE id=? AND user_id=?
      `).get(id, userId);
      return { status, view: parseView(row) };
    }).immediate();
  }

  function remove(input) {
    const userId = requireUserId(input && input.userId);
    const viewId = Number(input && input.viewId);
    if (!Number.isSafeInteger(viewId) || viewId < 1) {
      throw viewError(400, 'INVALID_INFLUENCER_VIEW', 'Saved view id is invalid.');
    }
    if (!activeUser(userId)) return false;
    return db.transaction(() => {
      const row = db.prepare('SELECT id FROM influencer_saved_views WHERE id=? AND user_id=?').get(viewId, userId);
      if (!row) return false;
      db.prepare('DELETE FROM influencer_saved_views WHERE id=? AND user_id=?').run(viewId, userId);
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details,ip_address)
        VALUES (?,'influencer_view_deleted','influencer',?,NULL)
      `).run(userId, JSON.stringify({ view_id: viewId }));
      return true;
    }).immediate();
  }

  return Object.freeze({ list, save, remove });
}

module.exports = {
  INFLUENCER_VIEW_COLUMN_KEYS,
  INFLUENCER_VIEW_FILTER_KEYS,
  InfluencerSavedViewError,
  createInfluencerSavedViewService
};
