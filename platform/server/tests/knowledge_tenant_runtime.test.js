const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const platformRoot = path.join(__dirname, '..', '..');
const serverEntry = path.join(platformRoot, 'server', 'server.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startRuntimeServer() {
  const port = await reservePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-tenant-http-'));
  const dbPath = path.join(dir, 'runtime.db');
  const output = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
      UPLOAD_SANDBOX_SPOOL_ROOT: path.join(dir, 'upload-sandbox'),
      TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
      JWT_SECRET: 'N7CiYIrosB8AK7AfEHtMt_fe3hbx8YRJFncgLgcW9I8',
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Runtime test server exited early (${child.exitCode}).\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return {
          baseUrl,
          dbPath,
          output: () => output.join(''),
          async close() {
            await stopChild(child);
            fs.rmSync(dir, { recursive: true, force: true });
          }
        };
      }
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopChild(child);
  throw new Error(`Timed out waiting for runtime test server.\n${output.join('')}`);
}

async function jsonRequest(server, requestPath, options) {
  options = options || {};
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(server.baseUrl + requestPath, {
    method: options.method || 'GET',
    headers,
    body: Object.hasOwn(options, 'body') ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

async function multipartRequest(server, requestPath, options) {
  const form = new FormData();
  for (const [name, value] of Object.entries(options.fields || {})) {
    form.append(name, String(value));
  }
  form.append('file', new Blob([options.bytes], { type: 'text/plain' }), options.fileName);
  const response = await fetch(server.baseUrl + requestPath, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'X-Request-Id': options.requestId
    },
    body: form,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-knowledge-tenant-runtime-'));
  const dbPath = path.join(dir, 'runtime.db');
  process.env.NODE_ENV = 'test';
  process.env.TM_DISABLE_DOTENV = '1';
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve('../db')];
  const db = require('../db');
  test.after(() => {
    try { db.close(); } catch (_error) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function installTask1RuntimeShape(db) {
  const alreadyV24 = Boolean(db.prepare(`
    SELECT 1 AS present
    FROM pragma_table_info('knowledge_entries')
    WHERE name='org_id'
  `).get());
  if (!alreadyV24) {
    db.exec(`
      ALTER TABLE knowledge_entries ADD COLUMN org_id INTEGER REFERENCES organizations(id);
      UPDATE knowledge_entries SET org_id=1 WHERE org_id IS NULL;
      DROP INDEX idx_knowledge_source_hash;
      DROP INDEX ux_knowledge_source_identity;
      DROP INDEX ux_knowledge_campaign_review_source;
      CREATE UNIQUE INDEX idx_knowledge_source_hash
        ON knowledge_entries(org_id,source_hash)
        WHERE source_hash IS NOT NULL AND source_hash<>'';
      CREATE UNIQUE INDEX ux_knowledge_source_identity
        ON knowledge_entries(org_id,source_identity_sha256)
        WHERE source_identity_sha256 IS NOT NULL;
      CREATE UNIQUE INDEX ux_knowledge_campaign_review_source
        ON knowledge_entries(org_id,source_type,CAST(source_id AS TEXT))
        WHERE source_type='campaign_review';
      CREATE INDEX idx_test_knowledge_org_id ON knowledge_entries(org_id,id);
      DROP TRIGGER knowledge_entries_no_replace_insert;
      CREATE TRIGGER knowledge_entries_no_replace_insert
      BEFORE INSERT ON knowledge_entries
      WHEN EXISTS (
        SELECT 1
        FROM knowledge_entries existing
        WHERE existing.id=NEW.id
          OR (
            existing.org_id=NEW.org_id
            AND (
              (NEW.source_hash IS NOT NULL AND NEW.source_hash<>'' AND existing.source_hash=NEW.source_hash)
              OR (NEW.source_identity_sha256 IS NOT NULL AND existing.source_identity_sha256=NEW.source_identity_sha256)
              OR (
                NEW.source_type='campaign_review'
                AND existing.source_type='campaign_review'
                AND CAST(existing.source_id AS TEXT)=CAST(NEW.source_id AS TEXT)
              )
            )
          )
        )
      BEGIN
        SELECT RAISE(ABORT,'knowledge entry cannot be replaced');
      END;
      CREATE TRIGGER test_knowledge_org_insert_required
      BEFORE INSERT ON knowledge_entries
      WHEN NEW.org_id IS NULL
      BEGIN
        SELECT RAISE(ABORT,'knowledge org_id required');
      END;
    `);
  }
  const secondOrgId = Number(db.prepare(`
    INSERT INTO organizations (code,name) VALUES ('tenant-b','Tenant B')
  `).run().lastInsertRowid);
  return { defaultOrgId: 1, secondOrgId };
}

function legacyInput(overrides) {
  return Object.assign({
    entry_type: 'tenant_runtime_note',
    source_type: 'runtime_fixture',
    source_id: 'shared-source',
    title: 'Tenant runtime fixture',
    summary: 'organization isolation fixture',
    content: 'tenant-runtime-needle',
    visibility: 'team',
    tags: ['tenant-runtime'],
    created_by: 2,
    actor_role: 'user'
  }, overrides || {});
}

function campaignContext(db) {
  const identity = db.prepare(`
    SELECT organization.id AS organizationId,user.id AS userId,team.id AS teamId
    FROM organizations organization
    JOIN organization_memberships membership
      ON membership.org_id=organization.id AND membership.status='active'
    JOIN users user ON user.id=membership.user_id AND user.is_active=1
    JOIN team_memberships team_membership
      ON team_membership.org_id=organization.id
     AND team_membership.user_id=user.id
     AND team_membership.status='active'
    JOIN teams team
      ON team.org_id=team_membership.org_id AND team.id=team_membership.team_id
    WHERE organization.code='turingmarket-default'
    ORDER BY CASE WHEN membership.role_code='org_admin' THEN 0 ELSE 1 END,user.id,team.id
    LIMIT 1
  `).get();
  assert.ok(identity);
  const values = {
    ...identity,
    customerId: 981001,
    opportunityId: 981002,
    campaignId: 981003
  };
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,
      is_public,org_id,team_id,duplicate_enforced
    ) VALUES (
      @customerId,'Tenant runtime','Tenant runtime Ltd','qualified','test',
      @userId,@userId,0,@organizationId,@teamId,1
    )
  `).run(values);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,
      channel_type,created_by,org_id,team_id,owner_user_id
    ) VALUES (
      @opportunityId,@customerId,'Tenant runtime campaign','proposal',1000,50,
      'Runtime','influencer',@userId,@organizationId,@teamId,@userId
    )
  `).run(values);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@organizationId,'Tenant runtime campaign',@customerId,
      @opportunityId,@userId,@teamId,'lead','active',1
    )
  `).run(values);
  return values;
}

function labeledWrite(label, operation) {
  try {
    return operation();
  } catch (error) {
    throw new Error(`${label}: ${error && error.message || error}`, { cause: error });
  }
}

test('legacy source hashes keep their bytes while lookup and reuse are organization scoped', () => {
  const db = freshDb();
  const { defaultOrgId, secondOrgId } = installTask1RuntimeShape(db);
  const knowledge = require('../services/knowledge_service');
  const input = legacyInput();
  const expectedHash = knowledge.hashInput({
    entry_type: input.entry_type,
    title: input.title,
    content: input.content,
    source_type: input.source_type,
    source_id: input.source_id,
    business_type: input.business_type,
    business_id: input.business_id,
    owner_id: ''
  });

  const first = labeledWrite('first organization insert', () => (
    knowledge.ingestKnowledge(db, { ...input, organizationId: defaultOrgId })
  ));
  const replay = labeledWrite('same organization replay', () => (
    knowledge.ingestKnowledge(db, { ...input, organizationId: defaultOrgId })
  ));
  const otherTenant = labeledWrite('second organization insert', () => (
    knowledge.ingestKnowledge(db, {
      ...input,
      organizationId: secondOrgId,
      created_by: 3
    })
  ));

  assert.equal(replay.id, first.id);
  assert.notEqual(otherTenant.id, first.id);
  assert.deepEqual(db.prepare(`
    SELECT id,org_id,source_hash
    FROM knowledge_entries
    WHERE id IN (?,?)
    ORDER BY id
  `).all(first.id, otherTenant.id), [
    { id: first.id, org_id: defaultOrgId, source_hash: expectedHash },
    { id: otherTenant.id, org_id: secondOrgId, source_hash: expectedHash }
  ]);
});

test('ordinary knowledge, RAG, categories, and usage stay in the active organization', () => {
  const db = freshDb();
  const { defaultOrgId, secondOrgId } = installTask1RuntimeShape(db);
  const knowledge = require('../services/knowledge_service');
  const rag = require('../services/rag_service');
  const user = { id: 2, role: 'user' };
  const admin = { id: 1, role: 'admin' };
  const first = knowledge.ingestKnowledge(db, {
    ...legacyInput({ source_id: 'tenant-a', title: 'Tenant A knowledge' }),
    organizationId: defaultOrgId
  });
  const second = knowledge.ingestKnowledge(db, {
    ...legacyInput({ source_id: 'tenant-b', title: 'Tenant B knowledge', created_by: 3 }),
    organizationId: secondOrgId
  });

  assert.deepEqual(knowledge.searchKnowledge(db, {
    q: 'tenant-runtime-needle',
    user,
    organizationId: defaultOrgId
  }).map((entry) => entry.id), [first.id]);
  assert.deepEqual(knowledge.listKnowledgeCategories(db, {
    user,
    organizationId: defaultOrgId
  }), [{ entry_type: 'tenant_runtime_note', count: 1 }]);
  assert.deepEqual(rag.buildRagContext(db, {
    query: 'tenant-runtime-needle',
    user: admin,
    organizationId: defaultOrgId
  }).references.map((reference) => reference.id), [first.id]);
  assert.deepEqual(knowledge.searchKnowledge(db, {
    q: 'tenant-runtime-needle',
    user: admin,
    adminAuditGlobal: true
  }).map((entry) => entry.id).sort((left, right) => left - right), [first.id, second.id]);

  assert.equal(knowledge.recordKnowledgeUsageTelemetry(
    db,
    [first.id, second.id],
    user,
    { organizationId: defaultOrgId }
  ), 1);
  assert.deepEqual(db.prepare(`
    SELECT id,usage_count FROM knowledge_entries WHERE id IN (?,?) ORDER BY id
  `).all(first.id, second.id), [
    { id: first.id, usage_count: 1 },
    { id: second.id, usage_count: 0 }
  ]);
});

test('explicit Admin KB audit remains global when visibility filters are present', () => {
  const db = freshDb();
  const { defaultOrgId, secondOrgId } = installTask1RuntimeShape(db);
  const knowledge = require('../services/knowledge_service');
  const admin = { id: 1, role: 'admin' };
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,1,'org_admin','active')
  `).run(secondOrgId);
  const first = knowledge.ingestKnowledge(db, {
    ...legacyInput({ source_id: 'admin-audit-a', title: 'Admin audit A' }),
    organizationId: defaultOrgId
  });
  const second = knowledge.ingestKnowledge(db, {
    ...legacyInput({ source_id: 'admin-audit-b', title: 'Admin audit B', created_by: 3 }),
    organizationId: secondOrgId
  });

  assert.deepEqual(knowledge.searchKnowledge(db, {
    q: 'tenant-runtime-needle',
    visibility: 'team',
    user: admin,
    adminAuditGlobal: true
  }).map((entry) => entry.id).sort((left, right) => left - right), [first.id, second.id]);
  assert.deepEqual(knowledge.listKnowledgeCategories(db, {
    visibility: 'team',
    user: admin,
    adminAuditGlobal: true
  }), [{ entry_type: 'tenant_runtime_note', count: 2 }]);
});

test('missing organization context fails closed for a multi-organization actor', () => {
  const db = freshDb();
  const { secondOrgId } = installTask1RuntimeShape(db);
  const knowledge = require('../services/knowledge_service');
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,2,'member','active')
  `).run(secondOrgId);

  assert.throws(
    () => knowledge.searchKnowledge(db, { user: { id: 2, role: 'user' } }),
    /organization context is required/i
  );
});

test('Campaign and organization knowledge writers persist their authoritative organization', () => {
  const db = freshDb();
  const { secondOrgId } = installTask1RuntimeShape(db);
  const knowledge = require('../services/knowledge_service');
  const context = campaignContext(db);
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,3,'org_admin','active')
  `).run(secondOrgId);

  const campaign = db.transaction(() => knowledge.writeCampaignKnowledgeInTransaction(db, {
    organizationId: context.organizationId,
    campaignId: context.campaignId,
    createdBy: context.userId,
    entryType: 'campaign_runtime_note',
    sourceType: 'campaign_runtime_note',
    sourceId: 'campaign-runtime-source',
    title: 'Campaign runtime knowledge',
    summary: 'campaign writer tenant check',
    content: 'campaign-runtime-writer-needle',
    tags: ['runtime'],
    visibility: 'team',
    metadata: { runtime: true }
  }))();
  const organization = db.transaction(() => knowledge.writeOrganizationKnowledgeInTransaction(db, {
    organizationId: secondOrgId,
    createdBy: 3,
    entryType: 'organization_runtime_note',
    sourceType: 'organization_runtime_note',
    sourceId: 'organization-runtime-source',
    title: 'Organization runtime knowledge',
    summary: 'organization writer tenant check',
    content: 'organization-runtime-writer-needle',
    tags: ['runtime'],
    metadata: { runtime: true }
  }))();

  assert.deepEqual(db.prepare(`
    SELECT id,org_id FROM knowledge_entries WHERE id IN (?,?) ORDER BY id
  `).all(campaign.entry.id, organization.entry.id), [
    { id: campaign.entry.id, org_id: context.organizationId },
    { id: organization.entry.id, org_id: secondOrgId }
  ]);
});

test('AI summary and manual promotion reject cross-organization reparenting', async () => {
  const db = freshDb();
  const { defaultOrgId, secondOrgId } = installTask1RuntimeShape(db);
  const ai = require('../services/ai_service');
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,1,'org_admin','active')
  `).run(secondOrgId);
  const provider = {
    async complete() {
      return {
        content: 'Active organization AI conclusion.',
        model: 'tenant-runtime-provider',
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      };
    }
  };
  const generated = await ai.handleChat(db, {
    user: { id: 1, role: 'admin' },
    organizationId: defaultOrgId,
    message: 'Generate an organization-scoped conclusion.',
    allowWeb: false,
    archiveSummary: true,
    provider
  });

  assert.throws(() => ai.promoteMessageToKnowledge(db, {
    user: { id: 1, role: 'admin' },
    authContext: { organization: { id: secondOrgId, role_code: 'org_admin' } },
    organizationId: secondOrgId,
    conversation_id: generated.conversation_id,
    message_id: generated.message_id,
    visibility: 'private',
    requestId: 'tenant-runtime-promotion-second'
  }), (error) => error && error.statusCode === 404 && error.code === 'RECORD_NOT_FOUND');
  const promotedInDefault = ai.promoteMessageToKnowledge(db, {
    user: { id: 1, role: 'admin' },
    authContext: { organization: { id: defaultOrgId, role_code: 'org_admin' } },
    organizationId: defaultOrgId,
    conversation_id: generated.conversation_id,
    message_id: generated.message_id,
    visibility: 'private',
    requestId: 'tenant-runtime-promotion-default'
  });

  assert.notEqual(promotedInDefault.knowledge_entry_id, generated.archived_summary_id);
  assert.deepEqual(db.prepare(`
    SELECT id,org_id,source_type
    FROM knowledge_entries
    WHERE id IN (?,?)
    ORDER BY id
  `).all(generated.archived_summary_id, promotedInDefault.knowledge_entry_id), [
    { id: generated.archived_summary_id, org_id: defaultOrgId, source_type: 'ai_message' },
    { id: promotedInDefault.knowledge_entry_id, org_id: defaultOrgId, source_type: 'ai_selected_message' }
  ]);
});

test('platform-admin conversation audit projects cross-org references without enabling org-admin access', () => {
  const db = freshDb();
  const { defaultOrgId, secondOrgId } = installTask1RuntimeShape(db);
  const knowledge = require('../services/knowledge_service');
  const ai = require('../services/ai_service');
  const organizationAdminId = Number(labeledWrite('organization admin user insert', () => db.prepare(`
    INSERT INTO users (username,password_hash,display_name,role,is_active)
    VALUES ('tenant-runtime-org-admin','not-used','Runtime Org Admin','user',1)
  `).run()).lastInsertRowid);
  labeledWrite('organization admin membership insert', () => db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,?,'org_admin','active')
  `).run(defaultOrgId, organizationAdminId));
  const campaignId = 982104;
  labeledWrite('cross-organization campaign fixture', () => db.transaction(() => {
    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (?,3,'org_admin','active')
    `).run(secondOrgId);
    db.prepare(`
      INSERT INTO teams (id,org_id,code,name)
      VALUES (982101,?,'tenant-runtime-audit','Tenant Runtime Audit')
    `).run(secondOrgId);
    db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,982101,3,'team_lead','active')
    `).run(secondOrgId);
    db.prepare(`
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,
        is_public,org_id,team_id,duplicate_enforced
      ) VALUES (
        982102,'Audit tenant','Audit tenant Ltd','qualified','test',3,3,
        0,?,982101,1
      )
    `).run(secondOrgId);
    db.prepare(`
      INSERT INTO opportunities (
        id,customer_id,name,stage,value,win_probability,product_name,
        channel_type,created_by,org_id,team_id,owner_user_id
      ) VALUES (
        982103,982102,'Audit tenant campaign','proposal',1000,50,'Runtime',
        'influencer',3,?,982101,3
      )
    `).run(secondOrgId);
    db.prepare(`
      INSERT INTO campaigns (
        id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
        lifecycle_state,operational_status,row_version
      ) VALUES (
        ?,?,'Audit tenant campaign',982102,982103,3,982101,'lead','active',1
      )
    `).run(campaignId, secondOrgId);
  })());
  const crossOrganization = labeledWrite('cross-organization knowledge insert', () => knowledge.ingestKnowledge(db, {
    ...legacyInput({
      source_id: 'conversation-audit-cross-org',
      title: 'Cross organization audit reference',
      content: 'cross-organization-audit-reference-payload',
      created_by: 3
    }),
    organizationId: secondOrgId
  }));
  const snapshot = db.prepare(`
    SELECT
      entry.id AS entry_id,entry.title,entry.source_identity_sha256,
      entry.content_sha256 AS entry_content_sha256,
      chunk.id AS chunk_id,chunk.content_sha256 AS chunk_content_sha256
    FROM knowledge_entries entry
    JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    WHERE entry.id=?
    ORDER BY chunk.chunk_index
    LIMIT 1
  `).get(crossOrganization.id);
  const conversationId = Number(labeledWrite('conversation insert', () => db.prepare(`
    INSERT INTO ai_conversations (user_id,title,visibility,source_module,org_id)
    VALUES (?,'Cross organization audit conversation','private','assistant',?)
  `).run(organizationAdminId, secondOrgId)).lastInsertRowid);
  const messageId = Number(labeledWrite('assistant message insert', () => db.prepare(`
    INSERT INTO ai_messages (
      conversation_id,user_id,role,content,model,metadata_json
    ) VALUES (?,?,'assistant','Audited answer','runtime-audit','{}')
  `).run(conversationId, organizationAdminId)).lastInsertRowid);
  labeledWrite('cross-organization reference insert', () => db.prepare(`
    INSERT INTO ai_references (
      message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json,
      reference_schema_version,knowledge_entry_id,knowledge_chunk_id,campaign_id,
      source_identity_sha256,entry_content_sha256,chunk_content_sha256,reference_rank,
      selection_origin
    ) VALUES (
      @messageId,'knowledge',@referenceId,@title,'','audit snippet','','{}',
      1,@entryId,@chunkId,@campaignId,@sourceIdentitySha256,@entryContentSha256,
      @chunkContentSha256,1,'retrieved'
    )
  `).run({
    messageId,
    referenceId: String(snapshot.entry_id),
    title: snapshot.title,
    entryId: snapshot.entry_id,
    chunkId: snapshot.chunk_id,
    campaignId,
    sourceIdentitySha256: snapshot.source_identity_sha256,
    entryContentSha256: snapshot.entry_content_sha256,
    chunkContentSha256: snapshot.chunk_content_sha256
  }));

  const platformAdmin = ai.getConversation(db, {
    id: conversationId,
    user: { id: 1, role: 'admin' },
    authContext: { organization: { id: defaultOrgId, role_code: 'org_admin' } },
    adminAuditGlobal: true,
    requestId: 'tenant-runtime-platform-admin-audit'
  });
  assert.equal(platformAdmin.messages[0].references[0].entry_id, crossOrganization.id);
  assert.equal(platformAdmin.messages[0].references[0].snippet, 'audit snippet');

  const organizationAdmin = ai.getConversation(db, {
    id: conversationId,
    user: { id: organizationAdminId, role: 'user' },
    authContext: { organization: { id: defaultOrgId, role_code: 'org_admin' } },
    requestId: 'tenant-runtime-organization-admin-read'
  });
  assert.equal(organizationAdmin, null);
});

test('business producers persist only their authenticated or entity-owned organization', () => {
  const db = freshDb();
  const { defaultOrgId, secondOrgId } = installTask1RuntimeShape(db);
  const business = require('../services/business_knowledge_service');
  const crm = require('../services/crm_customer_service');
  const influencer = require('../services/influencer_workflow_service');
  const context = campaignContext(db);
  const user = { id: context.userId, role: 'admin' };
  Object.defineProperty(user, '__active_organization_id', {
    value: defaultOrgId,
    enumerable: false
  });
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,3,'org_admin','active')
  `).run(secondOrgId);

  const writes = [
    business.archiveLead(db, { id: 991001, brand_name: 'Runtime lead' }, user),
    business.archiveCustomer(db, {
      id: 991002,
      brand_name: 'Runtime customer',
      assigned_to: 3,
      org_id: secondOrgId
    }, user),
    business.archiveOpportunity(db, {
      id: context.opportunityId,
      customer_id: context.customerId,
      name: 'Runtime opportunity',
      org_id: defaultOrgId
    }, user),
    business.archiveBrand(db, {
      id: 991003,
      name: 'Runtime brand',
      org_id: secondOrgId
    }, user),
    business.archiveInfluencer(db, {
      id: 991004,
      kol_handle: '@runtime-producer'
    }, user, { organizationId: defaultOrgId }),
    business.archiveCollaboration(db, {
      id: 991005,
      influencer_id: 991004,
      org_id: secondOrgId
    }, user),
    business.archiveWorkflowTemplate(db, {
      id: 991006,
      name: 'Runtime template',
      org_id: secondOrgId
    }, user),
    business.archiveWorkflowInstance(db, {
      id: 991007,
      business_type: 'runtime',
      business_id: 991008,
      org_id: secondOrgId
    }, user, 'started'),
    business.archiveWorkflowTask(db, {
      id: 991009,
      instance_id: 991007,
      title: 'Runtime task',
      org_id: secondOrgId
    }, user, 'complete', 'done')
  ];
  writes.forEach((entry) => assert.ok(entry && entry.id));
  assert.deepEqual(db.prepare(`
    SELECT id,org_id FROM knowledge_entries
    WHERE id IN (${writes.map(() => '?').join(',')})
    ORDER BY id
  `).all(...writes.map((entry) => entry.id)), writes
    .map((entry, index) => ({
      id: entry.id,
      org_id: index === 1 || index === 7 ? secondOrgId : defaultOrgId
    }))
    .sort((left, right) => left.id - right.id));

  const crmArchive = crm.archiveCustomerResult(db, {
    actorUserId: context.userId,
    organizationId: context.organizationId,
    requestId: 'tenant-runtime-crm-archive',
    correlationId: 'tenant-runtime-crm-archive',
    command: {
      customerId: context.customerId,
      artifact_type: 'strategy',
      title: 'Runtime CRM strategy',
      content: 'Runtime CRM organization-owned strategy.',
      tags: ['runtime'],
      source_type: 'ai_strategy'
    }
  });
  assert.equal(db.prepare('SELECT org_id FROM knowledge_entries WHERE id=?')
    .get(crmArchive.record.knowledge_entry_id).org_id, defaultOrgId);

  const legacyA = influencer._testing.archiveImportKnowledge(
    db,
    [{ kol_handle: '@runtime-a' }],
    { imported: 1, skipped: 0, total: 1 },
    'tenant-runtime-legacy-batch',
    'a'.repeat(64),
    user,
    defaultOrgId,
    true
  );
  const legacyB = influencer._testing.archiveImportKnowledge(
    db,
    [{ kol_handle: '@runtime-b' }],
    { imported: 1, skipped: 0, total: 1 },
    'tenant-runtime-legacy-batch',
    'b'.repeat(64),
    { id: 3, role: 'user' },
    secondOrgId,
    true
  );
  assert.notEqual(legacyA.entry.id, legacyB.entry.id);
  assert.deepEqual(db.prepare(`
    SELECT id,org_id FROM knowledge_entries WHERE id IN (?,?) ORDER BY id
  `).all(legacyA.entry.id, legacyB.entry.id), [
    { id: legacyA.entry.id, org_id: defaultOrgId },
    { id: legacyB.entry.id, org_id: secondOrgId }
  ].sort((left, right) => left.id - right.id));

  assert.throws(
    () => business.archiveBrand(db, { id: 991010, name: 'Missing org' }, { id: 2, role: 'user' }),
    /organization context is required/i
  );
});

test('Obsidian sync persists its server-owned organization', async (t) => {
  const db = freshDb();
  const { secondOrgId } = installTask1RuntimeShape(db);
  const obsidian = require('../services/obsidian_ingest_service');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-tenant-obsidian-'));
  const previousRoot = process.env.OBSIDIAN_KB_ROOT;
  process.env.OBSIDIAN_KB_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.OBSIDIAN_KB_ROOT;
    else process.env.OBSIDIAN_KB_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'runtime.md'), '# Runtime tenant note\n\nOrganization-owned content.', 'utf8');

  const result = await obsidian.syncObsidianFolder(db, {
    rootPath: root,
    organizationId: secondOrgId,
    user: { id: 1, role: 'admin' },
    visibility: 'team'
  });

  assert.equal(result.imported, 1);
  assert.equal(db.prepare('SELECT org_id FROM knowledge_entries WHERE id=?')
    .get(result.entries[0].id).org_id, secondOrgId);
});

test('HTTP knowledge producers ignore body organization and enforce active-org reads and usage', {
  timeout: 60000
}, async () => {
  const server = await startRuntimeServer();
  let database = null;
  try {
    const login = await jsonRequest(server, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(login.status, 200, login.text + '\n' + server.output());

    database = new Database(server.dbPath);
    const { defaultOrgId, secondOrgId } = installTask1RuntimeShape(database);
    database.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (?,?,'org_admin','active')
    `).run(secondOrgId, login.body.user.id);
    const knowledge = require('../services/knowledge_service');
    const crossOrganization = knowledge.ingestKnowledge(database, {
      ...legacyInput({
        entry_type: 'runtime_http',
        source_type: 'runtime_http',
        source_id: 'runtime-http-cross-org',
        title: 'Runtime HTTP cross organization',
        content: 'http-runtime-needle cross-organization-only',
        created_by: login.body.user.id
      }),
      organizationId: secondOrgId
    });
    database.close();
    database = null;

    const sharedBody = {
      entry_type: 'runtime_http',
      source_type: 'runtime_http',
      visibility: 'team',
      title: 'Runtime HTTP active organization',
      content: 'http-runtime-needle active organization',
      organizationId: secondOrgId,
      org_id: secondOrgId
    };
    const created = await jsonRequest(server, '/api/knowledge', {
      method: 'POST',
      token: login.body.token,
      body: { ...sharedBody, source_id: 'runtime-http-create' }
    });
    assert.equal(created.status, 200, created.text);
    const ingested = await jsonRequest(server, '/api/knowledge/ingest', {
      method: 'POST',
      token: login.body.token,
      body: { ...sharedBody, source_id: 'runtime-http-ingest' }
    });
    assert.equal(ingested.status, 200, ingested.text);
    const uploadFields = {
      title: 'Runtime HTTP multipart',
      entry_type: 'runtime_http',
      source_type: 'runtime_http',
      source_id: 'runtime-http-upload',
      visibility: 'team'
    };
    const rejectedUpload = await multipartRequest(server, '/api/knowledge/upload', {
      token: login.body.token,
      requestId: 'tenant-runtime-http-upload-rejected-org',
      fileName: 'tenant-runtime-http.txt',
      bytes: Buffer.from('http-runtime-needle multipart active organization', 'utf8'),
      fields: { ...uploadFields, organizationId: secondOrgId }
    });
    assert.equal(rejectedUpload.status, 400, rejectedUpload.text);
    assert.equal(rejectedUpload.body.code, 'UPLOAD_INVALID_CONTENT');
    const uploaded = await multipartRequest(server, '/api/knowledge/upload', {
      token: login.body.token,
      requestId: 'tenant-runtime-http-upload',
      fileName: 'tenant-runtime-http.txt',
      bytes: Buffer.from('http-runtime-needle multipart active organization', 'utf8'),
      fields: uploadFields
    });
    assert.equal(uploaded.status, 200, uploaded.text + '\n' + server.output());

    database = new Database(server.dbPath);
    const activeIds = [created.body.id, ingested.body.id, uploaded.body.entry.id];
    assert.deepEqual(database.prepare(`
      SELECT id,org_id FROM knowledge_entries
      WHERE id IN (${activeIds.map(() => '?').join(',')})
      ORDER BY id
    `).all(...activeIds), activeIds
      .map((id) => ({ id, org_id: defaultOrgId }))
      .sort((left, right) => left.id - right.id));
    database.close();
    database = null;

    const ordinarySearch = await jsonRequest(
      server,
      '/api/knowledge/search?q=http-runtime-needle&source_type=runtime_http&visibility=team',
      { token: login.body.token }
    );
    assert.equal(ordinarySearch.status, 200, ordinarySearch.text);
    assert.deepEqual(
      ordinarySearch.body.entries.map((entry) => entry.id).sort((left, right) => left - right),
      activeIds.slice().sort((left, right) => left - right)
    );

    const adminList = await jsonRequest(
      server,
      '/api/knowledge?q=http-runtime-needle&source_type=runtime_http&visibility=team',
      { token: login.body.token }
    );
    assert.equal(adminList.status, 200, adminList.text);
    assert.deepEqual(
      adminList.body.entries.map((entry) => entry.id).sort((left, right) => left - right),
      activeIds.concat(crossOrganization.id).sort((left, right) => left - right)
    );
    const categories = await jsonRequest(
      server,
      '/api/knowledge/categories?source_type=runtime_http&visibility=team',
      { token: login.body.token }
    );
    assert.equal(categories.status, 200, categories.text);
    assert.deepEqual(categories.body.categories, [{ entry_type: 'runtime_http', count: 4 }]);

    const crossUse = await jsonRequest(server, `/api/knowledge/${crossOrganization.id}/use`, {
      method: 'POST',
      token: login.body.token
    });
    const activeUse = await jsonRequest(server, `/api/knowledge/${created.body.id}/use`, {
      method: 'POST',
      token: login.body.token
    });
    assert.equal(crossUse.status, 200, crossUse.text);
    assert.equal(activeUse.status, 200, activeUse.text);
    database = new Database(server.dbPath, { readonly: true });
    assert.deepEqual(database.prepare(`
      SELECT id,usage_count FROM knowledge_entries WHERE id IN (?,?) ORDER BY id
    `).all(crossOrganization.id, created.body.id), [
      { id: crossOrganization.id, usage_count: 0 },
      { id: created.body.id, usage_count: 1 }
    ].sort((left, right) => left.id - right.id));
  } finally {
    if (database) database.close();
    await server.close();
  }
});
