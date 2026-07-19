const path = require('node:path');
const legacyBaseline = require('../../migrations/baselines/legacy_v1');
const migration001 = require('../../migrations/001_legacy_compat_columns');
const migrationService = require('../../services/migration_service');
const sqliteDigest = require('../../services/sqlite_digest_service');

const SERVER_ROOT = path.resolve(__dirname, '../..');
const LONG_DEPARTMENT = '超长部门边界'.repeat(32);

const LEGACY_USERS = Object.freeze([
  Object.freeze({
    id: 1,
    username: 'fixture_admin',
    displayName: 'Fixture Admin',
    role: 'admin',
    email: 'fixture-admin@example.invalid',
    department: '管理',
    apiQuota: 200000,
    createdAt: '2024-01-02 03:04:05',
    isActive: 1
  }),
  Object.freeze({
    id: 2,
    username: 'fixture_member',
    displayName: 'Fixture Member',
    role: 'user',
    email: 'fixture-member@example.invalid',
    department: '商务一部',
    apiQuota: 50000,
    createdAt: '2024-02-03 04:05:06',
    isActive: 1
  }),
  Object.freeze({
    id: 3,
    username: 'fixture_unassigned',
    displayName: 'Fixture Unassigned',
    role: 'user',
    email: 'fixture-unassigned@example.invalid',
    department: ' \t\r\n ',
    apiQuota: 50000,
    createdAt: '2024-03-04 05:06:07',
    isActive: 1
  }),
  Object.freeze({
    id: 4,
    username: 'fixture_long_department',
    displayName: 'Fixture Long Department',
    role: 'member',
    email: 'fixture-long@example.invalid',
    department: LONG_DEPARTMENT,
    apiQuota: 50000,
    createdAt: '2024-04-05 06:07:08',
    isActive: 1
  }),
  Object.freeze({
    id: 5,
    username: 'fixture_unknown_inactive',
    displayName: 'Fixture Unknown Inactive',
    role: 'auditor',
    email: 'fixture-inactive@example.invalid',
    department: null,
    apiQuota: 1000,
    createdAt: '2024-05-06 07:08:09',
    isActive: 0
  })
]);

const KNOWLEDGE_CANARIES = Object.freeze([
  Object.freeze({
    id: 7,
    entryType: 'note',
    sourceType: null,
    sourceId: 42,
    keyTerms: 'private integer legacy',
    content: 'Private integer-source legacy entry body.',
    createdBy: null,
    isPublic: 0,
    usageCount: 2,
    createdAt: '2024-06-01 01:02:03',
    updatedAt: '2024-06-02 02:03:04',
    title: 'Private integer source',
    summary: 'Private visibility canary',
    tagsJson: '["legacy","private"]',
    visibility: 'private',
    sourceHash: 'legacy|hash',
    businessType: 'campaign',
    businessId: '9',
    metadataJson: '{"fixture":"integer-source"}',
    embeddingJson: null
  }),
  Object.freeze({
    id: 8,
    entryType: 'uploaded_document',
    sourceType: 'knowledge_upload',
    sourceId: 'brief.csv',
    keyTerms: 'public filename upload',
    content: 'Public filename-backed legacy entry body.',
    createdBy: 3,
    isPublic: 1,
    usageCount: 3,
    createdAt: '2024-06-03 03:04:05',
    updatedAt: '2024-06-04 04:05:06',
    title: 'Public filename source',
    summary: 'Public visibility response canary',
    tagsJson: '["public","upload"]',
    visibility: 'public',
    sourceHash: null,
    businessType: null,
    businessId: null,
    metadataJson: '{"filename":"brief.csv"}',
    embeddingJson: null
  }),
  Object.freeze({
    id: 9,
    entryType: 'note',
    sourceType: 'manual_note',
    sourceId: 'shared-note.txt',
    keyTerms: 'shared response compatibility',
    content: 'Shared-token legacy response entry body.',
    createdBy: 2,
    isPublic: 1,
    usageCount: 5,
    createdAt: '2024-06-05 05:06:07',
    updatedAt: '2024-06-06 06:07:08',
    title: 'Shared response source',
    summary: 'Shared visibility response canary',
    tagsJson: '["shared"]',
    visibility: 'shared',
    sourceHash: 'fixture-shared-source-hash',
    businessType: null,
    businessId: null,
    metadataJson: '{"fixture":"shared"}',
    embeddingJson: null
  }),
  Object.freeze({
    id: 10,
    entryType: 'note',
    sourceType: 'legacy_import',
    sourceId: 77,
    keyTerms: 'team response compatibility',
    content: 'Team-token legacy response entry body.',
    createdBy: 2,
    isPublic: 1,
    usageCount: 7,
    createdAt: '2024-06-07 07:08:09',
    updatedAt: '2024-06-08 08:09:10',
    title: 'Team integer source',
    summary: 'Team visibility response canary',
    tagsJson: '["team"]',
    visibility: 'team',
    sourceHash: null,
    businessType: null,
    businessId: null,
    metadataJson: '{"fixture":"team"}',
    embeddingJson: null
  })
]);

const FTS_CANARIES = Object.freeze({
  orchidprivate: Object.freeze([701]),
  quartzpublic: Object.freeze([801]),
  zephyrshared: Object.freeze([901]),
  nebulateam: Object.freeze([1001])
});

const SEQUENCE_FLOORS = Object.freeze({
  users: 50,
  demands: 130,
  activity_log: 200,
  customers: 120,
  customer_activity: 130,
  influencers: 140,
  collaborations: 150,
  workflow_templates: 160,
  workflow_instances: 170,
  workflow_tasks: 180,
  workflow_timers: 190,
  workflow_node_logs: 210,
  opportunities: 220,
  knowledge_entries: 240,
  knowledge_chunks: 1200,
  ai_conversations: 1300,
  ai_messages: 1400,
  ai_references: 1500
});

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function encodedStoredValue(storageClass, value) {
  if (storageClass === 'null') return null;
  if (storageClass === 'blob') return Buffer.from(value).toString('hex');
  if (storageClass === 'real' && Object.is(value, -0)) return '-0';
  return value;
}

function captureTypedTable(db, tableName, requestedColumns) {
  const allColumns = db.pragma(`table_xinfo(${JSON.stringify(tableName)})`)
    .filter((column) => column.hidden === 0);
  const byName = new Map(allColumns.map((column) => [column.name, column]));
  const columnNames = requestedColumns ? [...requestedColumns] : allColumns.map((column) => column.name);
  for (const name of columnNames) {
    if (!byName.has(name)) throw new Error(`missing snapshot column ${tableName}.${name}`);
  }

  const projection = [];
  for (const name of columnNames) {
    const identifier = quoteIdentifier(name);
    projection.push(identifier, `typeof(${identifier})`);
  }
  const rawRows = db.prepare(
    `SELECT ${projection.join(',')} FROM ${quoteIdentifier(tableName)}`
  ).raw(true).all();
  const rows = rawRows.map((row) => {
    const cells = [];
    for (let index = 0; index < columnNames.length; index += 1) {
      const value = row[index * 2];
      const storageClass = row[(index * 2) + 1];
      cells.push([storageClass, encodedStoredValue(storageClass, value)]);
    }
    return cells;
  });
  rows.sort((left, right) => compareUtf8(JSON.stringify(left), JSON.stringify(right)));

  return {
    columns: columnNames,
    primaryKey: allColumns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name),
    rows
  };
}

function captureFtsProjection(db) {
  const rows = db.prepare(`
    SELECT
      title,typeof(title),
      content,typeof(content),
      tags,typeof(tags),
      entry_id,typeof(entry_id),
      chunk_id,typeof(chunk_id)
    FROM knowledge_chunks_fts
  `).raw(true).all().map((row) => {
    const cells = [];
    for (let index = 0; index < 5; index += 1) {
      const value = row[index * 2];
      const storageClass = row[(index * 2) + 1];
      cells.push([storageClass, encodedStoredValue(storageClass, value)]);
    }
    return cells;
  });
  rows.sort((left, right) => compareUtf8(JSON.stringify(left), JSON.stringify(right)));
  return rows;
}

function snapshotTableNames(db) {
  return db.pragma('table_list')
    .filter((table) => (
      table.schema === 'main' &&
      table.type === 'table' &&
      table.name !== 'sqlite_schema'
    ))
    .map((table) => table.name)
    .sort(compareUtf8);
}

function captureLegacySnapshot(db) {
  const tables = {};
  for (const tableName of snapshotTableNames(db)) {
    tables[tableName] = captureTypedTable(db, tableName);
  }
  return {
    tables,
    ftsProjection: captureFtsProjection(db)
  };
}

function setSequenceFloors(db) {
  const update = db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?');
  for (const [tableName, floor] of Object.entries(SEQUENCE_FLOORS)) {
    const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(tableName);
    if (!row) throw new Error(`missing sqlite_sequence fixture row for ${tableName}`);
    if (row.seq > floor) throw new Error(`sqlite_sequence fixture floor is below current max for ${tableName}`);
    if (update.run(BigInt(floor), tableName).changes !== 1) {
      throw new Error(`failed to freeze sqlite_sequence fixture row for ${tableName}`);
    }
  }
}

function insertUsers(db) {
  const insert = db.prepare(`
    INSERT INTO users (
      id,username,password_hash,display_name,role,email,department,api_quota,created_at,is_active
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  for (const user of LEGACY_USERS) {
    insert.run(
      user.id,
      user.username,
      `$fixture$not-a-production-secret$${user.id}`,
      user.displayName,
      user.role,
      user.email,
      user.department,
      user.apiQuota,
      user.createdAt,
      user.isActive
    );
  }
}

function insertCrmAndCollaborationRows(db) {
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,contact_person,contact_info,industry,stage,source,
      budget_estimate,notes,created_by,assigned_to,created_at,updated_at,
      lead_source,lead_score,win_probability,tags,is_public,priority
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    11, 'Fixture Alpha', 'Fixture Alpha LLC', 'Alpha Contact', 'alpha@example.invalid',
    '3C', 'qualified', 'fixture', '$50000', 'Legacy customer alpha', 1, 2,
    '2024-02-01 01:02:03', '2024-02-02 02:03:04',
    'fixture-referral', 80, 70, 'alpha,priority', 0, 'high'
  );
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,industry,stage,source,created_by,assigned_to,
      created_at,updated_at,lead_source,lead_score,win_probability,is_public,priority
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    12, 'Fixture Beta', 'Fixture Beta GmbH', 'Smart Home', 'lead', 'fixture',
    1, 3, '2024-02-03 03:04:05', '2024-02-04 04:05:06',
    'fixture-event', 35, 40, 1, 'medium'
  );
  db.prepare(`
    INSERT INTO customer_activity (
      id,customer_id,user_id,action,stage_from,stage_to,notes,created_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(13, 11, 2, 'stage_change', 'lead', 'qualified', 'Fixture stage history', '2024-02-02 02:03:04');

  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,
      expected_close_date,competitor_info,decision_chain,notes,created_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    21, 11, 'Fixture Alpha Launch', 'proposal', 50000.5, 70, 'Alpha Device',
    'influencer', '2024-12-31 00:00:00', 'Fixture competitor', 'Fixture buyer',
    'Legacy opportunity alpha', 1, '2024-02-05 05:06:07', '2024-02-06 06:07:08'
  );
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,
      created_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    22, 12, 'Fixture Beta Launch', 'discovery', 12000, 25, 'Beta Hub',
    'content', 1, '2024-02-07 07:08:09', '2024-02-08 08:09:10'
  );

  db.prepare(`
    INSERT INTO demands (
      id,user_id,brand_name,company_name,product_name,industry,budget,target_market,
      platform,status,data_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    31, 2, 'Fixture Alpha', 'Fixture Alpha LLC', 'Alpha Device', '3C',
    '$50000', 'US', 'YouTube', 'confirmed', '{"fixture":true}',
    '2024-02-09 09:10:11', '2024-02-10 10:11:12'
  );
  db.prepare(`
    INSERT INTO influencers (
      id,platform,kol_handle,profile_link,followers,avg_views_10,avg_engagement,
      category,sub_category,region,language,content_style,collab_type,cost_usd,
      cost_range_min,cost_range_max,cpm,brand_collab_history,contact_email,data_source,
      created_at,updated_at,project_name,product_name,reporter,tags,quoted_price,
      content_deliverable,is_duplicate,import_batch,influencer_type,cpv,parent_record
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    41, 'YouTube', '@fixture_creator', 'https://example.invalid/fixture_creator',
    12345, 4567, 4.25, '3C', 'Reviews', 'US', 'EN', 'Review', 'Dedicated',
    1200, 900, 1500, 12.5, 'Fixture Alpha', 'creator@example.invalid', 'fixture',
    '2024-02-11 11:12:13', '2024-02-12 12:13:14',
    'Fixture Project', 'Alpha Device', 'Fixture Reporter', 'fixture,review',
    1300, 'One video', 0, 'fixture-batch', 'micro', 0.27, null
  );
  db.prepare(`
    INSERT INTO collaborations (
      id,demand_id,influencer_id,user_id,status,proposal_notes,cost_quoted,cost_actual,
      content_url,roi_data,timeline_start,timeline_end,notes,created_at,updated_at,
      row_version,cost_actual_confirmed
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    51, 31, 41, 2, 'completed', 'Fixture proposal', 1200, 1100,
    'https://example.invalid/content', '{"views":4567}', '2024-03-01', '2024-03-31',
    'Legacy collaboration', '2024-02-13 13:14:15', '2024-03-31 23:59:59', 1, 0
  );
}

function insertWorkflowRows(db) {
  db.prepare(`
    INSERT INTO workflow_templates (
      id,name,description,module,category,nodes,edges,version,is_active,created_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    61, 'Fixture Approval', 'Legacy populated workflow template', 'crm', 'approval',
    '[{"id":"start","type":"start"},{"id":"approve","type":"approval"}]',
    '[{"source":"start","target":"approve"}]',
    3, 1, 1, '2024-03-01 01:02:03', '2024-03-02 02:03:04'
  );
  db.prepare(`
    INSERT INTO workflow_instances (
      id,template_id,business_type,business_id,current_node_id,status,node_data,
      started_by,completed_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    71, 61, 'customer', 11, 'approve', 'active', '{"fixture":true}',
    2, null, '2024-03-03 03:04:05'
  );
  db.prepare(`
    INSERT INTO workflow_tasks (
      id,instance_id,node_id,node_type,title,description,assignee_id,assignee_role,
      status,comment,due_at,completed_at,completed_by,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    81, 71, 'approve', 'approval', 'Approve fixture', 'Legacy pending task',
    2, 'user', 'pending', '', '2024-04-01 00:00:00', null, null,
    '2024-03-04 04:05:06'
  );
  db.prepare(`
    INSERT INTO workflow_timers (
      id,instance_id,node_id,fire_at,action,fired,created_at
    ) VALUES (?,?,?,?,?,?,?)
  `).run(91, 71, 'approve', '2024-04-01 00:00:00', 'advance', 0, '2024-03-05 05:06:07');
  db.prepare(`
    INSERT INTO workflow_node_logs (
      id,instance_id,node_id,action,user_id,details,created_at
    ) VALUES (?,?,?,?,?,?,?)
  `).run(101, 71, 'start', 'entered', 2, '{"fixture":"legacy-log"}', '2024-03-03 03:04:06');
}

function insertKnowledgeRows(db) {
  const insertEntry = db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      usage_count,created_at,updated_at,title,summary,tags_json,visibility,source_hash,
      business_type,business_id,metadata_json,embedding_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const entry of KNOWLEDGE_CANARIES) {
    insertEntry.run(
      entry.id,
      entry.entryType,
      entry.sourceType,
      entry.sourceId,
      entry.keyTerms,
      entry.content,
      entry.createdBy,
      entry.isPublic,
      entry.usageCount,
      entry.createdAt,
      entry.updatedAt,
      entry.title,
      entry.summary,
      entry.tagsJson,
      entry.visibility,
      entry.sourceHash,
      entry.businessType,
      entry.businessId,
      entry.metadataJson,
      entry.embeddingJson
    );
  }

  const insertChunk = db.prepare(`
    INSERT INTO knowledge_chunks (
      id,entry_id,chunk_index,content,metadata_json,token_count,embedding_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `);
  insertChunk.run(
    701, 7, 0, 'orchidprivate integer source canary', '{"fixture":"private"}',
    4, null, '2024-06-01 01:03:00'
  );
  insertChunk.run(
    801, 8, 0, 'quartzpublic filename source canary', '{"fixture":"public-0"}',
    4, null, '2024-06-03 03:05:00'
  );
  insertChunk.run(
    802, 8, 1, 'public continuation chunk', '{"fixture":"public-1"}',
    3, null, '2024-06-03 03:06:00'
  );
  insertChunk.run(
    901, 9, 0, 'zephyrshared response canary', '{"fixture":"shared"}',
    3, null, '2024-06-05 05:07:00'
  );
  insertChunk.run(
    1001, 10, 0, 'nebulateam response canary', '{"fixture":"team"}',
    3, null, '2024-06-07 07:09:00'
  );
}

function insertAiRows(db) {
  db.prepare(`
    INSERT INTO ai_conversations (
      id,user_id,title,visibility,source_module,archived_summary_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    1101, 2, 'Legacy fixture conversation', 'team', 'assistant', 8,
    '2024-07-01 01:02:03', '2024-07-01 02:03:04'
  );
  db.prepare(`
    INSERT INTO ai_messages (
      id,conversation_id,user_id,role,content,model,prompt_tokens,completion_tokens,
      total_tokens,metadata_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    1201, 1101, 2, 'user', 'Summarize the fixture.', null, 0, 0, 0,
    '{"fixture":"user"}', '2024-07-01 01:03:00'
  );
  db.prepare(`
    INSERT INTO ai_messages (
      id,conversation_id,user_id,role,content,model,prompt_tokens,completion_tokens,
      total_tokens,metadata_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    1202, 1101, 2, 'assistant', 'Fixture summary.', 'fixture-model', 11, 7, 18,
    '{"fixture":"assistant"}', '2024-07-01 01:04:00'
  );
  db.prepare(`
    INSERT INTO ai_references (
      id,message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    1301, 1202, 'knowledge', '8', 'Public filename source', '',
    'Legacy reference snapshot canary', 'knowledge_base', '{"legacy":true}',
    '2024-07-01 01:04:01'
  );
}

function installManagedV1Ledger(db) {
  migrationService.createLedger(db);
  const checksum = migrationService.computeRegisteredMigrationChecksum(
    migration001,
    { rootDir: SERVER_ROOT }
  );
  db.prepare(`
    INSERT INTO schema_migrations (
      version,name,checksum,source_path,engine_version,applied_at
    ) VALUES (?,?,?,?,?,?)
  `).run(
    migration001.version,
    migration001.name,
    checksum,
    migration001.sourcePath,
    migration001.engineVersion,
    '2024-01-01 00:00:00'
  );
}

function buildLegacyPopulatedFixture(db) {
  db.pragma('foreign_keys = ON');
  const existingObjects = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
  `).get().count;
  if (existingObjects !== 0) throw new Error('legacy populated fixture requires an empty database');

  legacyBaseline.apply(db);
  migration001.apply(db);
  installManagedV1Ledger(db);

  db.transaction(() => {
    insertUsers(db);
    insertCrmAndCollaborationRows(db);
    insertWorkflowRows(db);
    insertKnowledgeRows(db);
    insertAiRows(db);
    db.prepare(`
      INSERT INTO activity_log (
        id,user_id,action,module,details,ip_address,created_at
      ) VALUES (?,?,?,?,?,?,?)
    `).run(
      151, 2, 'fixture_existing_activity', 'crm',
      '{"safe":"legacy-fixture"}', '192.0.2.10', '2024-08-01 01:02:03'
    );
    setSequenceFloors(db);
  })();

  sqliteDigest.rebuildKnowledgeChunksFts(db);
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`legacy fixture integrity_check failed: ${integrity}`);
  const foreignKeyFailures = db.pragma('foreign_key_check');
  if (foreignKeyFailures.length !== 0) {
    throw new Error(`legacy fixture foreign_key_check failed: ${foreignKeyFailures.length}`);
  }

  return {
    snapshot: captureLegacySnapshot(db),
    users: LEGACY_USERS,
    knowledgeCanaries: KNOWLEDGE_CANARIES,
    ftsCanaries: FTS_CANARIES,
    sequenceFloors: SEQUENCE_FLOORS
  };
}

module.exports = {
  LONG_DEPARTMENT,
  LEGACY_USERS,
  KNOWLEDGE_CANARIES,
  FTS_CANARIES,
  SEQUENCE_FLOORS,
  buildLegacyPopulatedFixture,
  captureTypedTable,
  captureFtsProjection,
  captureLegacySnapshot
};
