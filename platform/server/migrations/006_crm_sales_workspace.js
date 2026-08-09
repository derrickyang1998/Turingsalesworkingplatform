'use strict';

const { createHash } = require('node:crypto');

const ACTIVE_CUSTOMER_STAGES = new Set([
  'lead',
  'info_confirmed',
  'advantage_shared',
  'needs_confirmed',
  'analysis',
  'proposal',
  'kol_matching',
  'cooperation'
]);
const TERMINAL_CUSTOMER_STAGES = new Set(['paused', 'won', 'lost']);
const LEGACY_DIGEST_DOMAIN = 'tm-crm-v6-legacy-projection-v1';
const IDENTITY_DOMAIN = 'crm-customer-identity:v1\u0000';
const MIGRATION_OCCURRED_AT = '1970-01-01 00:00:00';
const LEGACY_PROJECTION_TABLES = Object.freeze([
  'campaign_record_links',
  'customer_activity',
  'customers',
  'opportunities'
]);

const CUSTOMER_COLUMN_DEFINITIONS = Object.freeze([
  'org_id INTEGER REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  'team_id INTEGER REFERENCES teams(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  'country TEXT CHECK(country IS NULL OR length(trim(country)) BETWEEN 1 AND 120)',
  "next_action_at TEXT CHECK(next_action_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',next_action_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',next_action_at)=next_action_at))",
  "stalled_at TEXT CHECK(stalled_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',stalled_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',stalled_at)=stalled_at))",
  "normalized_identity_key TEXT CHECK(normalized_identity_key IS NULL OR (length(normalized_identity_key)=64 AND normalized_identity_key=lower(normalized_identity_key) AND normalized_identity_key NOT GLOB '*[^0-9a-f]*'))",
  'duplicate_enforced INTEGER NOT NULL DEFAULT 0 CHECK(duplicate_enforced IN (0,1))'
]);

const OPPORTUNITY_COLUMN_DEFINITIONS = Object.freeze([
  'org_id INTEGER REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  'team_id INTEGER REFERENCES teams(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  'owner_user_id INTEGER REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  "next_action_at TEXT CHECK(next_action_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',next_action_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',next_action_at)=next_action_at))",
  'loss_reason TEXT CHECK(loss_reason IS NULL OR length(trim(loss_reason)) BETWEEN 1 AND 1000)',
  "closed_at TEXT CHECK(closed_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',closed_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',closed_at)=closed_at))",
  'campaign_id INTEGER REFERENCES campaigns(id) ON UPDATE RESTRICT ON DELETE RESTRICT'
]);

const TABLE_SQL = Object.freeze({
  customer_contacts: `CREATE TABLE customer_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  customer_id INTEGER NOT NULL CHECK(customer_id BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  role TEXT CHECK(role IS NULL OR length(trim(role)) BETWEEN 1 AND 200),
  email TEXT CHECK(email IS NULL OR length(trim(email)) BETWEEN 3 AND 320),
  phone TEXT CHECK(phone IS NULL OR length(trim(phone)) BETWEEN 1 AND 80),
  is_preferred INTEGER NOT NULL DEFAULT 0 CHECK(is_preferred IN (0,1)),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT,
  UNIQUE(org_id,customer_id,id),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at),
  CHECK(archived_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',archived_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',archived_at)=archived_at)),
  CHECK(archived_at IS NULL OR is_preferred=0),
  FOREIGN KEY(org_id,customer_id) REFERENCES customers(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`,
  crm_tasks: `CREATE TABLE crm_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  team_id INTEGER CHECK(team_id IS NULL OR team_id BETWEEN 1 AND 9007199254740991),
  customer_id INTEGER NOT NULL CHECK(customer_id BETWEEN 1 AND 9007199254740991),
  opportunity_id INTEGER CHECK(opportunity_id IS NULL OR opportunity_id BETWEEN 1 AND 9007199254740991),
  owner_user_id INTEGER NOT NULL CHECK(owner_user_id BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 240),
  description TEXT CHECK(description IS NULL OR length(description) BETWEEN 1 AND 4000),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','stage_transition','reminder')),
  completed_at TEXT,
  completed_by INTEGER CHECK(completed_by IS NULL OR completed_by BETWEEN 1 AND 9007199254740991),
  completion_note TEXT CHECK(completion_note IS NULL OR length(completion_note) BETWEEN 1 AND 2000),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,customer_id,id),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',due_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',due_at)=due_at),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at),
  CHECK(completed_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',completed_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',completed_at)=completed_at)),
  CHECK((status='completed' AND completed_at IS NOT NULL AND completed_by IS NOT NULL) OR (status IN ('open','cancelled') AND completed_at IS NULL AND completed_by IS NULL)),
  FOREIGN KEY(org_id,customer_id) REFERENCES customers(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,customer_id,opportunity_id) REFERENCES opportunities(org_id,customer_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,owner_user_id) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,team_id,owner_user_id) REFERENCES team_memberships(org_id,team_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,completed_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`,
  crm_audit_events: `CREATE TABLE crm_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  customer_id INTEGER CHECK(customer_id IS NULL OR customer_id BETWEEN 1 AND 9007199254740991),
  opportunity_id INTEGER CHECK(opportunity_id IS NULL OR opportunity_id BETWEEN 1 AND 9007199254740991),
  task_id INTEGER CHECK(task_id IS NULL OR task_id BETWEEN 1 AND 9007199254740991),
  contact_id INTEGER CHECK(contact_id IS NULL OR contact_id BETWEEN 1 AND 9007199254740991),
  actor_user_id INTEGER CHECK(actor_user_id IS NULL OR actor_user_id BETWEEN 1 AND 9007199254740991),
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 80 AND event_type=lower(event_type) AND event_type NOT GLOB '*[^a-z0-9_]*'),
  request_id TEXT CHECK(request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  correlation_id TEXT CHECK(correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  CHECK(strftime('%Y-%m-%d %H:%M:%S',occurred_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',occurred_at)=occurred_at),
  CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object' AND length(CAST(metadata_json AS BLOB)) <= 8192),
  CHECK(opportunity_id IS NULL OR customer_id IS NOT NULL),
  CHECK(task_id IS NULL OR customer_id IS NOT NULL),
  CHECK(contact_id IS NULL OR customer_id IS NOT NULL),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,customer_id) REFERENCES customers(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,customer_id,opportunity_id) REFERENCES opportunities(org_id,customer_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,customer_id,task_id) REFERENCES crm_tasks(org_id,customer_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,customer_id,contact_id) REFERENCES customer_contacts(org_id,customer_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,actor_user_id) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`
});

const INDEX_SQL = Object.freeze({
  ux_customers_crm_org_id: 'CREATE UNIQUE INDEX ux_customers_crm_org_id ON customers(org_id,id)',
  ux_opportunities_crm_org_customer_id: 'CREATE UNIQUE INDEX ux_opportunities_crm_org_customer_id ON opportunities(org_id,customer_id,id)',
  idx_customers_crm_org_owner_updated: 'CREATE INDEX idx_customers_crm_org_owner_updated ON customers(org_id,assigned_to,updated_at DESC,id DESC)',
  idx_customers_crm_org_team_updated: 'CREATE INDEX idx_customers_crm_org_team_updated ON customers(org_id,team_id,updated_at DESC,id DESC)',
  idx_customers_crm_org_stage_updated: 'CREATE INDEX idx_customers_crm_org_stage_updated ON customers(org_id,stage,updated_at DESC,id DESC)',
  idx_customers_crm_org_next_action: 'CREATE INDEX idx_customers_crm_org_next_action ON customers(org_id,next_action_at)',
  idx_customers_crm_org_identity: 'CREATE INDEX idx_customers_crm_org_identity ON customers(org_id,normalized_identity_key)',
  idx_opportunities_crm_org_owner_updated: 'CREATE INDEX idx_opportunities_crm_org_owner_updated ON opportunities(org_id,owner_user_id,updated_at DESC,id DESC)',
  idx_opportunities_crm_org_team_stage_updated: 'CREATE INDEX idx_opportunities_crm_org_team_stage_updated ON opportunities(org_id,team_id,stage,updated_at DESC,id DESC)',
  idx_opportunities_crm_org_customer: 'CREATE INDEX idx_opportunities_crm_org_customer ON opportunities(org_id,customer_id)',
  ux_customers_crm_active_identity: `CREATE UNIQUE INDEX ux_customers_crm_active_identity
ON customers(org_id,normalized_identity_key)
WHERE duplicate_enforced=1
  AND normalized_identity_key IS NOT NULL
  AND stage NOT IN ('paused','won','lost')`,
  ux_customer_contacts_preferred_active: 'CREATE UNIQUE INDEX ux_customer_contacts_preferred_active ON customer_contacts(org_id,customer_id) WHERE is_preferred=1 AND archived_at IS NULL',
  idx_customer_contacts_org_customer: 'CREATE INDEX idx_customer_contacts_org_customer ON customer_contacts(org_id,customer_id,archived_at,id)',
  idx_crm_tasks_org_owner_status_due: 'CREATE INDEX idx_crm_tasks_org_owner_status_due ON crm_tasks(org_id,owner_user_id,status,due_at,id)',
  idx_crm_tasks_org_team_status_due: 'CREATE INDEX idx_crm_tasks_org_team_status_due ON crm_tasks(org_id,team_id,status,due_at,id)',
  idx_crm_tasks_org_customer_status_due: 'CREATE INDEX idx_crm_tasks_org_customer_status_due ON crm_tasks(org_id,customer_id,status,due_at,id)',
  idx_crm_tasks_org_opportunity: 'CREATE INDEX idx_crm_tasks_org_opportunity ON crm_tasks(org_id,opportunity_id,id)',
  idx_crm_audit_org_time: 'CREATE INDEX idx_crm_audit_org_time ON crm_audit_events(org_id,occurred_at DESC,id DESC)',
  idx_crm_audit_customer_time: 'CREATE INDEX idx_crm_audit_customer_time ON crm_audit_events(org_id,customer_id,occurred_at DESC,id DESC)',
  idx_crm_audit_opportunity_time: 'CREATE INDEX idx_crm_audit_opportunity_time ON crm_audit_events(org_id,opportunity_id,occurred_at DESC,id DESC)',
  idx_crm_audit_task_time: 'CREATE INDEX idx_crm_audit_task_time ON crm_audit_events(org_id,task_id,occurred_at DESC,id DESC)',
  idx_crm_audit_contact_time: 'CREATE INDEX idx_crm_audit_contact_time ON crm_audit_events(org_id,contact_id,occurred_at DESC,id DESC)',
  idx_crm_audit_request: 'CREATE INDEX idx_crm_audit_request ON crm_audit_events(org_id,request_id) WHERE request_id IS NOT NULL',
  idx_crm_audit_correlation: 'CREATE INDEX idx_crm_audit_correlation ON crm_audit_events(org_id,correlation_id) WHERE correlation_id IS NOT NULL'
});

const TRIGGER_SQL = Object.freeze({
  crm_audit_events_append_only_update: `CREATE TRIGGER crm_audit_events_append_only_update
BEFORE UPDATE ON crm_audit_events
BEGIN
  SELECT RAISE(ABORT,'crm audit events are append-only');
END`,
  crm_audit_events_append_only_delete: `CREATE TRIGGER crm_audit_events_append_only_delete
BEFORE DELETE ON crm_audit_events
BEGIN
  SELECT RAISE(ABORT,'crm audit events are append-only');
END`,
  customer_contacts_identity_immutable: `CREATE TRIGGER customer_contacts_identity_immutable
BEFORE UPDATE OF org_id,customer_id,created_by,created_at ON customer_contacts
WHEN NEW.org_id IS NOT OLD.org_id
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'crm contact identity is immutable');
END`,
  customer_contacts_no_hard_delete: `CREATE TRIGGER customer_contacts_no_hard_delete
BEFORE DELETE ON customer_contacts
BEGIN
  SELECT RAISE(ABORT,'crm contacts must be archived');
END`,
  crm_tasks_identity_immutable: `CREATE TRIGGER crm_tasks_identity_immutable
BEFORE UPDATE OF org_id,customer_id,opportunity_id,created_by,created_at ON crm_tasks
WHEN NEW.org_id IS NOT OLD.org_id
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.opportunity_id IS NOT OLD.opportunity_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'crm task identity is immutable');
END`,
  crm_tasks_no_hard_delete: `CREATE TRIGGER crm_tasks_no_hard_delete
BEFORE DELETE ON crm_tasks
BEGIN
  SELECT RAISE(ABORT,'crm tasks must be cancelled');
END`
});

const REQUIRED_TABLES = Object.freeze([
  'campaign_record_links',
  'campaigns',
  'customer_activity',
  'customers',
  'opportunities',
  'organization_memberships',
  'organizations',
  'team_memberships',
  'teams',
  'users'
]);

const OWNED_COLUMNS = Object.freeze({
  customers: Object.freeze(CUSTOMER_COLUMN_DEFINITIONS.map(function(definition) {
    return definition.split(' ')[0];
  })),
  opportunities: Object.freeze(OPPORTUNITY_COLUMN_DEFINITIONS.map(function(definition) {
    return definition.split(' ')[0];
  }))
});

function utf8Bytes(value, label) {
  if (typeof value !== 'string') throw new Error(label + ' must be text');
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    let point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      if (index + 1 >= value.length) throw new Error(label + ' has an isolated surrogate');
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new Error(label + ' has an isolated surrogate');
      point = 0x10000 + ((point - 0xd800) * 0x400) + (low - 0xdc00);
      index += 1;
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      throw new Error(label + ' has an isolated surrogate');
    }
    if (point <= 0x7f) {
      bytes.push(point);
    } else if (point <= 0x7ff) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point <= 0xffff) {
      bytes.push(
        0xe0 | (point >> 12),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

function concatenate(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function unsigned32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('identity frame length is out of range');
  }
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ]);
}

function unsigned64(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('digest frame length is out of range');
  }
  const output = new Uint8Array(8);
  let remaining = value;
  for (let index = 7; index >= 0; index -= 1) {
    output[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return output;
}

function frame(bytes) {
  return concatenate([unsigned64(bytes.length), bytes]);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareBytes(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function compareUtf8(left, right) {
  return compareBytes(utf8Bytes(left, 'sort value'), utf8Bytes(right, 'sort value'));
}

function bytesFromHex(value, label) {
  if (typeof value !== 'string' || value.length % 2 !== 0 || /[^0-9a-f]/i.test(value)) {
    throw new Error(label + ' has invalid hex bytes');
  }
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, (index * 2) + 2), 16);
  }
  return output;
}

function quoteIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function normalizeIdentityText(value, label) {
  if (typeof value !== 'string') throw new Error(label + ' must be text');
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ +| +$/g, '')
    .toLowerCase();
  utf8Bytes(normalized, label);
  return normalized;
}

function customerIdentityDigest(brandName, companyName) {
  const brand = normalizeIdentityText(brandName, 'customers.brand_name');
  if (brand.length === 0) throw new Error('customers.brand_name normalizes to empty text');
  if (companyName !== null && typeof companyName !== 'string') {
    throw new Error('customers.company_name must be text or null');
  }
  const company = normalizeIdentityText(companyName === null ? '' : companyName, 'customers.company_name');
  const brandBytes = utf8Bytes(brand, 'normalized brand_name');
  const companyBytes = utf8Bytes(company, 'normalized company_name');
  return sha256(concatenate([
    utf8Bytes(IDENTITY_DOMAIN, 'identity domain'),
    unsigned32(brandBytes.length),
    brandBytes,
    unsigned32(companyBytes.length),
    companyBytes
  ]));
}

function projectedTeamCode(department, storageType) {
  if (storageType === 'null') return 'legacy-unassigned';
  if (storageType !== 'text' || typeof department !== 'string') {
    throw new Error('users.department has invalid storage class');
  }
  const display = department
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ +| +$/g, '');
  if (display.length === 0) return 'legacy-unassigned';
  return 'legacy-dept-' + sha256(utf8Bytes(department.normalize('NFC'), 'users.department'));
}

function scalarFrame(storageType, hexValue, label) {
  const tags = { null: 0, integer: 1, real: 2, text: 3, blob: 4 };
  if (!Object.prototype.hasOwnProperty.call(tags, storageType)) {
    throw new Error(label + ' has unsupported SQLite storage class ' + storageType);
  }
  const payload = storageType === 'null' ? new Uint8Array(0) : bytesFromHex(hexValue, label);
  return concatenate([new Uint8Array([tags[storageType]]), frame(payload)]);
}

function tableProjectionDigest(db, tableName, columns) {
  const expressions = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = quoteIdentifier(columns[index].name);
    expressions.push('typeof(' + column + ') AS ' + quoteIdentifier('type_' + index));
    expressions.push('hex(CAST(' + column + ' AS BLOB)) AS ' + quoteIdentifier('hex_' + index));
  }
  const primaryKeys = columns
    .filter(function(column) { return column.pk > 0; })
    .sort(function(left, right) { return left.pk - right.pk; });
  const orderSql = primaryKeys.length
    ? ' ORDER BY ' + primaryKeys.map(function(column) { return quoteIdentifier(column.name); }).join(',')
    : '';
  const rows = db.prepare(
    'SELECT ' + expressions.join(',') + ' FROM ' + quoteIdentifier(tableName) + orderSql
  ).all();
  const rowFrames = rows.map(function(row) {
    const parts = [];
    for (let index = 0; index < columns.length; index += 1) {
      parts.push(scalarFrame(row['type_' + index], row['hex_' + index], tableName + '.' + columns[index].name));
    }
    return concatenate(parts);
  });
  if (!primaryKeys.length) rowFrames.sort(compareBytes);

  const hash = createHash('sha256');
  hash.update(frame(utf8Bytes(LEGACY_DIGEST_DOMAIN, 'legacy digest domain')));
  hash.update(frame(utf8Bytes(tableName, 'legacy table name')));
  hash.update(unsigned64(columns.length));
  for (const column of columns) {
    hash.update(frame(utf8Bytes(column.name, 'legacy column name')));
    hash.update(frame(utf8Bytes(String(column.type || ''), 'legacy column type')));
  }
  hash.update(unsigned64(rows.length));
  for (const rowFrame of rowFrames) hash.update(frame(rowFrame));
  return { count: rows.length, sha256: hash.digest('hex') };
}

function legacyProjectionReport(db, frozenColumns) {
  const columns = frozenColumns || {};
  const tables = {};
  for (const tableName of LEGACY_PROJECTION_TABLES) {
    if (!columns[tableName]) {
      columns[tableName] = db.prepare(
        'PRAGMA table_info(' + JSON.stringify(tableName) + ')'
      ).all().map(function(column) {
        return { name: column.name, type: column.type, pk: column.pk };
      });
    }
    tables[tableName] = tableProjectionDigest(db, tableName, columns[tableName]);
  }
  const overall = createHash('sha256');
  overall.update(frame(utf8Bytes(LEGACY_DIGEST_DOMAIN, 'legacy digest domain')));
  const orderedNames = [...LEGACY_PROJECTION_TABLES].sort(compareUtf8);
  for (const tableName of orderedNames) {
    overall.update(frame(utf8Bytes(tableName, 'legacy table name')));
    overall.update(unsigned64(tables[tableName].count));
    overall.update(frame(utf8Bytes(tables[tableName].sha256, 'legacy table digest')));
  }
  return { columns, tables, overallSha256: overall.digest('hex') };
}

function assertLegacyProjectionEqual(before, after) {
  for (const tableName of LEGACY_PROJECTION_TABLES) {
    const left = before.tables[tableName];
    const right = after.tables[tableName];
    if (left.count !== right.count || left.sha256 !== right.sha256) {
      throw new Error('006 legacy projection changed for ' + tableName);
    }
  }
  if (before.overallSha256 !== after.overallSha256) {
    throw new Error('006 overall legacy projection changed');
  }
}

function auditEvent(eventType, customerId, opportunityId, reasonCode, details) {
  const metadata = {
    reason_code: reasonCode,
    customer_id: customerId
  };
  if (opportunityId !== null) metadata.opportunity_id = opportunityId;
  for (const [key, value] of Object.entries(details || {})) metadata[key] = value;
  return {
    customerId,
    opportunityId,
    eventType,
    metadataJson: JSON.stringify(metadata)
  };
}

function ownerProjection(db, organizationId, assignedTo) {
  const user = db.prepare(`
    SELECT id,is_active,department,typeof(department) AS department_type
    FROM users WHERE id=?
  `).get(assignedTo);
  if (!user) return { teamId: null, reasonCode: 'owner_missing' };
  if (user.is_active !== 1) return { teamId: null, reasonCode: 'owner_inactive' };
  const membership = db.prepare(`
    SELECT status FROM organization_memberships
    WHERE org_id=? AND user_id=?
  `).get(organizationId, assignedTo);
  if (!membership) return { teamId: null, reasonCode: 'organization_membership_missing' };
  if (membership.status !== 'active') {
    return { teamId: null, reasonCode: 'organization_membership_inactive' };
  }
  const teamCode = projectedTeamCode(user.department, user.department_type);
  const teams = db.prepare(`
    SELECT team.id
    FROM teams team
    JOIN team_memberships membership
      ON membership.org_id=team.org_id
     AND membership.team_id=team.id
     AND membership.user_id=?
    WHERE team.org_id=? AND team.code=? AND membership.status='active'
    ORDER BY team.id
  `).all(assignedTo, organizationId, teamCode);
  if (teams.length !== 1) {
    return { teamId: null, reasonCode: 'projected_team_membership_missing' };
  }
  return { teamId: teams[0].id, reasonCode: null };
}

function buildBackfillPlan(db, organizationId) {
  const customerRows = db.prepare(`
    SELECT
      id,assigned_to,is_public,stage,typeof(stage) AS stage_type,
      brand_name,typeof(brand_name) AS brand_type,
      company_name,typeof(company_name) AS company_type
    FROM customers
    ORDER BY id
  `).all();
  const customers = [];
  const customersById = new Map();
  const events = [];
  const activeIdentityGroups = new Map();
  for (const row of customerRows) {
    if (row.brand_type !== 'text') throw new Error('customers.brand_name has invalid storage class');
    if (row.company_type !== 'null' && row.company_type !== 'text') {
      throw new Error('customers.company_name has invalid storage class');
    }
    if (row.is_public !== 0 && row.is_public !== 1) {
      throw new Error('customers.is_public must be an exact integer boolean');
    }
    const identityKey = customerIdentityDigest(row.brand_name, row.company_name);
    let custody = 'quarantine';
    let teamId = null;
    let reasonCode = null;
    if (row.assigned_to === null && row.is_public === 1) {
      custody = 'public';
    } else if (row.assigned_to !== null && row.is_public === 0) {
      const owner = ownerProjection(db, organizationId, row.assigned_to);
      if (owner.reasonCode === null) {
        custody = 'private';
        teamId = owner.teamId;
      } else {
        reasonCode = owner.reasonCode;
      }
    } else if (row.assigned_to === null) {
      reasonCode = 'unassigned_non_public';
    } else {
      reasonCode = 'assigned_public';
    }
    const stageClass = row.stage_type === 'text' && ACTIVE_CUSTOMER_STAGES.has(row.stage)
      ? 'active'
      : (row.stage_type === 'text' && TERMINAL_CUSTOMER_STAGES.has(row.stage) ? 'terminal' : 'unclassified');
    const customer = {
      id: row.id,
      assignedTo: row.assigned_to,
      custody,
      duplicateEnforced: 0,
      identityKey,
      reasonCode,
      stageClass,
      teamId
    };
    customers.push(customer);
    customersById.set(customer.id, customer);
    if (custody === 'quarantine') {
      events.push(auditEvent('crm_backfill_quarantined', customer.id, null, reasonCode, {}));
    }
    if (stageClass === 'unclassified') {
      events.push(auditEvent('crm_legacy_stage_unclassified', customer.id, null, 'legacy_stage_unclassified', {
        identity_hash: identityKey
      }));
    }
    if (stageClass === 'active') {
      if (!activeIdentityGroups.has(identityKey)) activeIdentityGroups.set(identityKey, []);
      activeIdentityGroups.get(identityKey).push(customer);
    }
  }
  const identityKeys = [...activeIdentityGroups.keys()].sort(compareUtf8);
  for (const identityKey of identityKeys) {
    const group = activeIdentityGroups.get(identityKey).sort(function(left, right) { return left.id - right.id; });
    if (group.length === 1) {
      group[0].duplicateEnforced = 1;
      continue;
    }
    for (const customer of group) {
      events.push(auditEvent('crm_legacy_duplicate_collision', customer.id, null, 'active_identity_collision', {
        identity_hash: identityKey,
        collision_count: group.length
      }));
    }
  }

  const opportunities = [];
  const opportunityRows = db.prepare(`
    SELECT id,customer_id
    FROM opportunities
    ORDER BY id
  `).all();
  for (const row of opportunityRows) {
    const customer = customersById.get(row.customer_id);
    if (!customer) throw new Error('006 orphan opportunity customer_id=' + row.customer_id);
    const opportunity = {
      id: row.id,
      customerId: row.customer_id,
      ownerUserId: customer.custody === 'private' ? customer.assignedTo : null,
      teamId: customer.custody === 'private' ? customer.teamId : null
    };
    opportunities.push(opportunity);
    if (customer.custody !== 'private') {
      events.push(auditEvent(
        'crm_backfill_quarantined',
        customer.id,
        opportunity.id,
        customer.custody === 'public' ? 'parent_public_custody' : 'parent_quarantined_custody',
        customer.reasonCode ? { parent_reason_code: customer.reasonCode } : {}
      ));
    }
  }
  return { customers, events, opportunities };
}

function applyBackfill(db, organizationId, plan) {
  const updateCustomer = db.prepare(`
    UPDATE customers
    SET org_id=?,team_id=?,normalized_identity_key=?,duplicate_enforced=?
    WHERE id=?
  `);
  for (const customer of plan.customers) {
    const result = updateCustomer.run(
      organizationId,
      customer.teamId,
      customer.identityKey,
      customer.duplicateEnforced,
      customer.id
    );
    if (result.changes !== 1) throw new Error('006 customer backfill missed id=' + customer.id);
  }
  const updateOpportunity = db.prepare(`
    UPDATE opportunities
    SET org_id=?,team_id=?,owner_user_id=?,campaign_id=NULL
    WHERE id=?
  `);
  for (const opportunity of plan.opportunities) {
    const result = updateOpportunity.run(
      organizationId,
      opportunity.teamId,
      opportunity.ownerUserId,
      opportunity.id
    );
    if (result.changes !== 1) throw new Error('006 opportunity backfill missed id=' + opportunity.id);
  }
  const insertEvent = db.prepare(`
    INSERT INTO crm_audit_events (
      org_id,customer_id,opportunity_id,task_id,contact_id,actor_user_id,
      event_type,request_id,correlation_id,occurred_at,metadata_json
    ) VALUES (?,?,?,NULL,NULL,NULL,?,NULL,NULL,?,?)
  `);
  for (const event of plan.events) {
    insertEvent.run(
      organizationId,
      event.customerId,
      event.opportunityId,
      event.eventType,
      MIGRATION_OCCURRED_AT,
      event.metadataJson
    );
  }
}

function validateBackfill(db, organizationId, plan) {
  const storedCustomers = db.prepare(`
    SELECT id,org_id,team_id,normalized_identity_key,duplicate_enforced
    FROM customers ORDER BY id
  `).all();
  if (storedCustomers.length !== plan.customers.length) {
    throw new Error('006 customer backfill count mismatch');
  }
  for (let index = 0; index < plan.customers.length; index += 1) {
    const expected = plan.customers[index];
    const actual = storedCustomers[index];
    if (
      actual.id !== expected.id ||
      actual.org_id !== organizationId ||
      actual.team_id !== expected.teamId ||
      actual.normalized_identity_key !== expected.identityKey ||
      actual.duplicate_enforced !== expected.duplicateEnforced
    ) {
      throw new Error('006 customer backfill validation failed id=' + expected.id);
    }
  }
  const storedOpportunities = db.prepare(`
    SELECT id,org_id,team_id,owner_user_id,campaign_id
    FROM opportunities ORDER BY id
  `).all();
  if (storedOpportunities.length !== plan.opportunities.length) {
    throw new Error('006 opportunity backfill count mismatch');
  }
  for (let index = 0; index < plan.opportunities.length; index += 1) {
    const expected = plan.opportunities[index];
    const actual = storedOpportunities[index];
    if (
      actual.id !== expected.id ||
      actual.org_id !== organizationId ||
      actual.team_id !== expected.teamId ||
      actual.owner_user_id !== expected.ownerUserId ||
      actual.campaign_id !== null
    ) {
      throw new Error('006 opportunity backfill validation failed id=' + expected.id);
    }
  }
}

function existingOwnedShape(db) {
  const objects = [
    ...Object.keys(TABLE_SQL),
    ...Object.keys(INDEX_SQL),
    ...Object.keys(TRIGGER_SQL)
  ];
  const placeholders = objects.map(function() { return '?'; }).join(',');
  const existingObjects = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE name IN (${placeholders})
    ORDER BY name
  `).all(...objects).map(function(row) { return row.name; });
  const existingColumns = [];
  for (const tableName of Object.keys(OWNED_COLUMNS)) {
    const expectedNames = new Set(OWNED_COLUMNS[tableName]);
    for (const column of db.prepare(`PRAGMA table_xinfo(${JSON.stringify(tableName)})`).all()) {
      if (expectedNames.has(column.name)) existingColumns.push(tableName + '.' + column.name);
    }
  }
  return { objects: existingObjects, columns: existingColumns };
}

function normalizedSql(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactSql(value) {
  return normalizedSql(value).replace(/\s/g, '').toLowerCase();
}

function schemaObjectSql(db, type, name) {
  const rows = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type=? AND name=?
    ORDER BY name
  `).all(type, name);
  if (rows.length !== 1 || typeof rows[0].sql !== 'string') {
    throw new Error('partial or incompatible v6 CRM shape: ' + name);
  }
  return rows[0].sql;
}

function assertManifestColumns(db) {
  for (const [tableName, expectedColumns] of Object.entries(migration.schemaManifest.columns)) {
    const actualColumns = db.prepare(
      'PRAGMA table_xinfo(' + JSON.stringify(tableName) + ')'
    ).all();
    const actualByName = new Map(actualColumns.map(function(column) { return [column.name, column]; }));
    for (const [columnName, expected] of Object.entries(expectedColumns)) {
      const actual = actualByName.get(columnName);
      if (
        !actual ||
        String(actual.type).toUpperCase() !== expected.type ||
        actual.notnull !== expected.notnull ||
        actual.dflt_value !== expected.defaultValue
      ) {
        throw new Error('partial or incompatible v6 CRM column: ' + tableName + '.' + columnName);
      }
    }
    if (Object.prototype.hasOwnProperty.call(TABLE_SQL, tableName) && actualColumns.length !== Object.keys(expectedColumns).length) {
      throw new Error('partial or incompatible v6 CRM table columns: ' + tableName);
    }
  }
}

function assertLegacyColumnChecks(db) {
  for (const tableName of Object.keys(OWNED_COLUMNS)) {
    const tableSql = compactSql(schemaObjectSql(db, 'table', tableName));
    for (const checkSql of migration.schemaManifest.tableChecks[tableName] || []) {
      if (!tableSql.includes(compactSql(checkSql))) {
        throw new Error('partial or incompatible v6 CRM CHECK: ' + tableName);
      }
    }
  }
  const expectedForeignKeys = {
    customers: [
      ['org_id', 'organizations', 'id'],
      ['team_id', 'teams', 'id']
    ],
    opportunities: [
      ['campaign_id', 'campaigns', 'id'],
      ['org_id', 'organizations', 'id'],
      ['owner_user_id', 'users', 'id'],
      ['team_id', 'teams', 'id']
    ]
  };
  for (const [tableName, expectedRows] of Object.entries(expectedForeignKeys)) {
    const actualRows = db.prepare(
      'PRAGMA foreign_key_list(' + JSON.stringify(tableName) + ')'
    ).all();
    for (const [from, parentTable, to] of expectedRows) {
      const matches = actualRows.filter(function(row) {
        return row.from === from && row.table === parentTable && row.to === to &&
          row.on_update === 'RESTRICT' && row.on_delete === 'RESTRICT';
      });
      if (matches.length !== 1) {
        throw new Error('partial or incompatible v6 CRM foreign key: ' + tableName + '.' + from);
      }
    }
  }
}

function assertCompleteShape(db) {
  assertManifestColumns(db);
  assertLegacyColumnChecks(db);
  for (const [name, expectedSql] of Object.entries(TABLE_SQL)) {
    if (normalizedSql(schemaObjectSql(db, 'table', name)) !== normalizedSql(expectedSql)) {
      throw new Error('partial or incompatible v6 CRM table SQL: ' + name);
    }
  }
  for (const [name, expectedSql] of Object.entries(INDEX_SQL)) {
    if (normalizedSql(schemaObjectSql(db, 'index', name)) !== normalizedSql(expectedSql)) {
      throw new Error('partial or incompatible v6 CRM index SQL: ' + name);
    }
  }
  for (const [name, expectedSql] of Object.entries(TRIGGER_SQL)) {
    if (normalizedSql(schemaObjectSql(db, 'trigger', name)) !== normalizedSql(expectedSql)) {
      throw new Error('partial or incompatible v6 CRM trigger SQL: ' + name);
    }
  }
}

function classifyOwnedShape(db) {
  const shape = existingOwnedShape(db);
  if (shape.objects.length === 0 && shape.columns.length === 0) return 'absent';
  const expectedObjectCount = Object.keys(TABLE_SQL).length + Object.keys(INDEX_SQL).length + Object.keys(TRIGGER_SQL).length;
  const expectedColumnCount = Object.values(OWNED_COLUMNS).reduce(function(total, columns) {
    return total + columns.length;
  }, 0);
  if (shape.objects.length !== expectedObjectCount || shape.columns.length !== expectedColumnCount) {
    const first = shape.objects[0] || shape.columns[0] || 'owned object count';
    throw new Error('partial or incompatible v6 CRM shape: ' + first);
  }
  assertCompleteShape(db);
  return 'complete';
}

function legacyProjectionColumns(db) {
  const columns = {};
  for (const tableName of LEGACY_PROJECTION_TABLES) {
    const excluded = new Set(OWNED_COLUMNS[tableName] || []);
    columns[tableName] = db.prepare(
      'PRAGMA table_info(' + JSON.stringify(tableName) + ')'
    ).all().filter(function(column) {
      return !excluded.has(column.name);
    }).map(function(column) {
      return { name: column.name, type: column.type, pk: column.pk };
    });
  }
  return columns;
}

function validateMigrationEvents(db, organizationId, plan, requireExactCount) {
  const countExactEvent = db.prepare(`
    SELECT COUNT(*) AS count
    FROM crm_audit_events
    WHERE org_id=?
      AND customer_id=?
      AND opportunity_id IS ?
      AND task_id IS NULL
      AND contact_id IS NULL
      AND actor_user_id IS NULL
      AND event_type=?
      AND request_id IS NULL
      AND correlation_id IS NULL
      AND occurred_at=?
      AND metadata_json=?
  `);
  for (const event of plan.events) {
    const row = countExactEvent.get(
      organizationId,
      event.customerId,
      event.opportunityId,
      event.eventType,
      MIGRATION_OCCURRED_AT,
      event.metadataJson
    );
    if (row.count !== 1) {
      throw new Error('006 migration audit validation failed for ' + event.eventType);
    }
  }
  if (requireExactCount) {
    const total = db.prepare('SELECT COUNT(*) AS count FROM crm_audit_events').get().count;
    if (total !== plan.events.length) throw new Error('006 migration audit count mismatch');
  }
}

function assertPrerequisites(db) {
  for (const tableName of REQUIRED_TABLES) {
    const present = db.prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?"
    ).get(tableName);
    if (!present) throw new Error('006 requires ' + tableName);
  }
  const organizations = db.prepare(
    "SELECT id FROM organizations WHERE code='turingmarket-default' ORDER BY id"
  ).all();
  if (organizations.length !== 1) {
    throw new Error('006 requires exactly one turingmarket-default organization');
  }
  return organizations[0].id;
}

function createSchema(db) {
  for (const definition of CUSTOMER_COLUMN_DEFINITIONS) {
    db.exec('ALTER TABLE customers ADD COLUMN ' + definition);
  }
  for (const definition of OPPORTUNITY_COLUMN_DEFINITIONS) {
    db.exec('ALTER TABLE opportunities ADD COLUMN ' + definition);
  }
  db.exec(INDEX_SQL.ux_customers_crm_org_id);
  db.exec(INDEX_SQL.ux_opportunities_crm_org_customer_id);
  for (const sql of Object.values(TABLE_SQL)) db.exec(sql);
  for (const [name, sql] of Object.entries(INDEX_SQL)) {
    if (name === 'ux_customers_crm_org_id' || name === 'ux_opportunities_crm_org_customer_id') continue;
    db.exec(sql);
  }
  for (const sql of Object.values(TRIGGER_SQL)) db.exec(sql);
}

const migration = {
  version: 6,
  name: '006_crm_sales_workspace',
  sourcePath: 'migrations/006_crm_sales_workspace.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      customers: {
        org_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        team_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        country: { type: 'TEXT', notnull: 0, defaultValue: null },
        next_action_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        stalled_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        normalized_identity_key: { type: 'TEXT', notnull: 0, defaultValue: null },
        duplicate_enforced: { type: 'INTEGER', notnull: 1, defaultValue: '0' }
      },
      opportunities: {
        org_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        team_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        owner_user_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        next_action_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        loss_reason: { type: 'TEXT', notnull: 0, defaultValue: null },
        closed_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        campaign_id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      },
      customer_contacts: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        customer_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        name: { type: 'TEXT', notnull: 1, defaultValue: null },
        role: { type: 'TEXT', notnull: 0, defaultValue: null },
        email: { type: 'TEXT', notnull: 0, defaultValue: null },
        phone: { type: 'TEXT', notnull: 0, defaultValue: null },
        is_preferred: { type: 'INTEGER', notnull: 1, defaultValue: '0' },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        archived_at: { type: 'TEXT', notnull: 0, defaultValue: null }
      },
      crm_tasks: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        team_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        customer_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        opportunity_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        owner_user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        title: { type: 'TEXT', notnull: 1, defaultValue: null },
        description: { type: 'TEXT', notnull: 0, defaultValue: null },
        due_at: { type: 'TEXT', notnull: 1, defaultValue: null },
        status: { type: 'TEXT', notnull: 1, defaultValue: "'open'" },
        source: { type: 'TEXT', notnull: 1, defaultValue: "'manual'" },
        completed_at: { type: 'TEXT', notnull: 0, defaultValue: null },
        completed_by: { type: 'INTEGER', notnull: 0, defaultValue: null },
        completion_note: { type: 'TEXT', notnull: 0, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      crm_audit_events: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        customer_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        opportunity_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        task_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        contact_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        actor_user_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        event_type: { type: 'TEXT', notnull: 1, defaultValue: null },
        request_id: { type: 'TEXT', notnull: 0, defaultValue: null },
        correlation_id: { type: 'TEXT', notnull: 0, defaultValue: null },
        occurred_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        metadata_json: { type: 'TEXT', notnull: 1, defaultValue: "'{}'" }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      customers: [
        'CHECK(country IS NULL OR length(trim(country)) BETWEEN 1 AND 120)',
        "CHECK(next_action_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',next_action_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',next_action_at)=next_action_at))",
        "CHECK(stalled_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',stalled_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',stalled_at)=stalled_at))",
        "CHECK(normalized_identity_key IS NULL OR (length(normalized_identity_key)=64 AND normalized_identity_key=lower(normalized_identity_key) AND normalized_identity_key NOT GLOB '*[^0-9a-f]*'))",
        'CHECK(duplicate_enforced IN (0,1))'
      ],
      opportunities: [
        "CHECK(next_action_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',next_action_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',next_action_at)=next_action_at))",
        'CHECK(loss_reason IS NULL OR length(trim(loss_reason)) BETWEEN 1 AND 1000)',
        "CHECK(closed_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',closed_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',closed_at)=closed_at))"
      ],
      customer_contacts: [
        'CHECK(id BETWEEN 1 AND 9007199254740991)',
        'CHECK(is_preferred IN (0,1))',
        'CHECK(archived_at IS NULL OR is_preferred=0)'
      ],
      crm_tasks: [
        "CHECK(status IN ('open','completed','cancelled'))",
        "CHECK(source IN ('manual','stage_transition','reminder'))",
        "CHECK((status='completed' AND completed_at IS NOT NULL AND completed_by IS NOT NULL) OR (status IN ('open','cancelled') AND completed_at IS NULL AND completed_by IS NULL))"
      ],
      crm_audit_events: [
        "CHECK(length(event_type) BETWEEN 1 AND 80 AND event_type=lower(event_type) AND event_type NOT GLOB '*[^a-z0-9_]*')",
        "CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object' AND length(CAST(metadata_json AS BLOB)) <= 8192)",
        'CHECK(opportunity_id IS NULL OR customer_id IS NOT NULL)',
        'CHECK(task_id IS NULL OR customer_id IS NOT NULL)',
        'CHECK(contact_id IS NULL OR customer_id IS NOT NULL)'
      ]
    }
  },
  apply(db) {
    const shape = classifyOwnedShape(db);
    const organizationId = assertPrerequisites(db);
    const legacyBefore = legacyProjectionReport(db, legacyProjectionColumns(db));
    const backfillPlan = buildBackfillPlan(db, organizationId);
    if (shape === 'complete') {
      validateBackfill(db, organizationId, backfillPlan);
      validateMigrationEvents(db, organizationId, backfillPlan, false);
      return;
    }
    createSchema(db);
    applyBackfill(db, organizationId, backfillPlan);
    validateBackfill(db, organizationId, backfillPlan);
    validateMigrationEvents(db, organizationId, backfillPlan, true);
    const legacyAfter = legacyProjectionReport(db, legacyBefore.columns);
    assertLegacyProjectionEqual(legacyBefore, legacyAfter);
  }
};

module.exports = migration;
