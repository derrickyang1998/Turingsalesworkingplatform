'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const Database = require('better-sqlite3');
const {
  auditFingerprint,
  canonicalJsonBytes,
  requestHash,
  sha256Hex
} = require('../services/sqlite_digest_service');
const idempotencyService = require('../services/idempotency_service');
const knowledgeService = require('../services/knowledge_service');

const platformRoot = path.join(__dirname, '..', '..');
const serverEntry = path.join(platformRoot, 'server', 'server.js');
const USER_ENTRY_LIMIT = 50_000;
const TEST_JWT_SECRET = 'N7CiYIrosB8AK7AfEHtMt_fe3hbx8YRJFncgLgcW9I8';
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir',
  'TEMP', 'TMP', 'ComSpec', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE',
  'PROCESSOR_ARCHITECTURE', 'SystemDrive'
]);

function isolatedChildEnvironment(overrides, sourceEnvironment = process.env) {
  const environment = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(sourceEnvironment, key)) {
      environment[key] = sourceEnvironment[key];
    }
  }
  return Object.assign(environment, overrides);
}

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

test('network child OS environment excludes inherited secrets and application configuration', () => {
  const environment = isolatedChildEnvironment({}, {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    NODE_OPTIONS: '--require inherited-hook.js',
    DEEPSEEK_API_KEY: 'inherited-deepseek-key',
    TAVILY_API_KEY: 'inherited-tavily-key',
    TM_ENV_FILE: 'C:\\untrusted.env',
    DB_PATH: 'C:\\production.db'
  });

  assert.deepEqual(environment, {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp'
  });
  for (const key of [
    'NODE_OPTIONS',
    'DEEPSEEK_API_KEY',
    'TAVILY_API_KEY',
    'TM_ENV_FILE',
    'DB_PATH'
  ]) {
    assert.equal(Object.hasOwn(environment, key), false, `${key} was inherited`);
  }
});

async function startTestServer(prefix) {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tempDir, 'test.db');
  const output = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: isolatedChildEnvironment({
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
      UPLOAD_SANDBOX_SPOOL_ROOT: path.join(tempDir, 'upload-sandbox'),
      TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
      JWT_SECRET: TEST_JWT_SECRET,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early (${child.exitCode}).\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) {
        return {
          baseUrl,
          dbPath,
          output: () => output.join(''),
          async close() {
            await stopChild(child);
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        };
      }
    } catch (_error) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopChild(child);
  throw new Error(`Timed out waiting for test server.\n${output.join('')}`);
}

async function jsonRequest(server, requestPath, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(server.baseUrl + requestPath, {
    method: options.method || 'POST',
    headers,
    body: Object.hasOwn(options, 'body') ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    text
  };
}

async function rawRequest(server, requestPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(server.baseUrl + requestPath, {
    method: options.method || 'POST',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    text
  };
}

async function createFixture(prefix, operationalStatus = 'active') {
  const server = await startTestServer(prefix);
  let db = null;
  try {
    const admin = await jsonRequest(server, '/api/auth/login', {
      body: { username: 'admin', password: 'AdminTest1!Secure' }
    });
    assert.equal(admin.status, 200, admin.text + '\n' + server.output());
    const password = 'Task7Member1!Safe';
    const created = await jsonRequest(server, '/api/admin/users', {
      token: admin.body.token,
      body: {
        username: 'task7-member',
        password,
        display_name: 'Task 7 Member',
        role: 'user',
        department: 'Sales',
        email: 'task7-member@example.invalid'
      }
    });
    assert.equal(created.status, 200, created.text);
    const login = await jsonRequest(server, '/api/auth/login', {
      body: { username: 'task7-member', password }
    });
    assert.equal(login.status, 200, login.text);

    db = new Database(server.dbPath);
    db.pragma('busy_timeout = 5000');
    const identity = db.prepare(`
      SELECT organization_membership.org_id AS orgId,
        team_membership.team_id AS teamId
      FROM organization_memberships organization_membership
      JOIN team_memberships team_membership
        ON team_membership.org_id=organization_membership.org_id
       AND team_membership.user_id=organization_membership.user_id
       AND team_membership.status='active'
      WHERE organization_membership.user_id=?
        AND organization_membership.status='active'
      LIMIT 1
    `).get(created.body.id);
    assert.ok(identity);
    const customer = db.prepare(`
      INSERT INTO customers (brand_name,created_by,assigned_to,is_public)
      VALUES (?,?,?,0)
    `).run('Task 7 fixture customer', created.body.id, created.body.id);
    const opportunity = db.prepare(`
      INSERT INTO opportunities (customer_id,name,created_by)
      VALUES (?,?,?)
    `).run(customer.lastInsertRowid, 'Task 7 fixture opportunity', created.body.id);
    const campaign = db.prepare(`
      INSERT INTO campaigns (
        org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
        lifecycle_state,operational_status,row_version
      ) VALUES (?,?,?,?,?,?,?,?,1)
    `).run(
      identity.orgId,
      `Task 7 ${operationalStatus} campaign`,
      customer.lastInsertRowid,
      opportunity.lastInsertRowid,
      created.body.id,
      identity.teamId,
      'lead',
      operationalStatus
    );
    const seedDemand = db.prepare(`
      INSERT INTO demands (user_id,brand_name,data_json)
      VALUES (?,?,'{}')
    `).run(created.body.id, 'Task 7 proposal parent');

    return {
      server,
      db,
      token: login.body.token,
      userId: Number(created.body.id),
      orgId: identity.orgId,
      teamId: identity.teamId,
      campaignId: Number(campaign.lastInsertRowid),
      seedDemandId: Number(seedDemand.lastInsertRowid),
      async close() {
        if (db.open) db.close();
        await server.close();
      }
    };
  } catch (error) {
    if (db && db.open) db.close();
    await server.close();
    throw error;
  }
}

function transferCampaignAway(fixture) {
  const replacement = fixture.db.prepare(`
    SELECT membership.user_id AS userId,team_membership.team_id AS teamId
    FROM organization_memberships membership
    JOIN team_memberships team_membership
      ON team_membership.org_id=membership.org_id
     AND team_membership.user_id=membership.user_id
     AND team_membership.status='active'
    WHERE membership.org_id=?
      AND membership.user_id<>?
      AND membership.status='active'
    ORDER BY CASE WHEN membership.role_code='org_admin' THEN 0 ELSE 1 END,
      membership.user_id,team_membership.team_id
    LIMIT 1
  `).get(fixture.orgId, fixture.userId);
  assert.ok(replacement);
  assert.equal(fixture.db.prepare(`
    UPDATE campaigns
    SET owner_user_id=?,team_id=?,row_version=row_version+1
    WHERE id=?
  `).run(replacement.userId, replacement.teamId, fixture.campaignId).changes, 1);
}

function demandBody(overrides = {}) {
  return {
    brand_name: 'Wave 1 demand',
    company_name: 'Wave 1 Company',
    product_name: 'Wave 1 Product',
    industry: 'SaaS',
    budget: '10000 USD',
    target_market: 'US',
    platform: 'YouTube',
    data_json: { objective: 'deterministic-red' },
    ...overrides
  };
}

function proposalBody(demandId, overrides = {}) {
  return {
    demand_id: demandId,
    template_id: 'wave1-template',
    content: '{"title":"Wave 1 proposal","sections":["Deterministic RED"]}',
    ...overrides
  };
}

function proposalConfirmationBody(overrides = {}) {
  return {
    demand: demandBody({ brand_name: 'Task 6A confirmed demand' }),
    proposal: {
      template_id: 'task6a-human-confirmed',
      content: '# Task 6A human edited proposal\n\nUse the edited creator plan.'
    },
    draft: {
      demand_entry_id: 987654,
      ai_conversation_id: 456,
      ai_message_id: 789,
      source: 'human_confirmed'
    },
    ...overrides
  };
}

function contractFramedSha256(values) {
  const frames = values.map((value) => {
    const payload = Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    return Buffer.concat([length, payload]);
  });
  return sha256Hex(Buffer.concat(frames));
}

function campaignSourceIdentityDigestFixture(values) {
  return contractFramedSha256([
    'tm-knowledge-source-v1',
    values.organizationId,
    values.campaignId,
    values.sourceType,
    values.sourceId,
    values.entryType,
    values.ownerId || ''
  ]);
}

function knowledgeContentDigestFixture(values) {
  return contractFramedSha256([
    'tm-knowledge-content-v1',
    values.entryType,
    values.title,
    values.summary,
    values.content,
    values.tagsJson,
    values.visibility
  ]);
}

function knowledgeBody(campaignId, sourceId, overrides = {}) {
  return {
    campaign_id: campaignId,
    entry_type: 'campaign_note',
    title: `Task 7 knowledge ${sourceId}`,
    summary: 'Task 7 linked knowledge summary',
    content: 'Task 7 linked knowledge content',
    tags: ['campaign', 'knowledge'],
    source_type: 'task7_integration',
    source_id: sourceId,
    ...overrides
  };
}

function bulkFillUserKnowledgeEntries(db, createdBy, count) {
  if (count === 0) return;
  const replacementGuard = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='knowledge_entries_no_replace_insert'
  `).get();
  assert.ok(replacementGuard && replacementGuard.sql);
  db.exec('DROP TRIGGER knowledge_entries_no_replace_insert');
  try {
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL SELECT value + 1 FROM fixture_rows WHERE value < @count
      )
      INSERT INTO knowledge_entries (
        entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,source_hash,business_type,business_id,
        metadata_json,embedding_json,source_identity_sha256,content_sha256
      )
      SELECT
        'note','task7_capacity_fixture',NULL,'[]','',@createdBy,0,
        '','','[]','private',NULL,NULL,NULL,'{}',NULL,
        lower(printf('e%063x', 2000000 + value)),
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      FROM fixture_rows
    `).run({ count, createdBy });
  } finally {
    db.exec(replacementGuard.sql);
  }
}

function responseSummary(response) {
  return { status: response.status, code: response.body && response.body.code };
}

test('omitting campaign_id preserves exact legacy demand and proposal writes with no campaign state', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave1-legacy-');
  try {
    const demand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      body: demandBody({ brand_name: 'Wave 1 legacy demand' })
    });
    assert.equal(demand.status, 200, demand.text);
    assert.deepEqual(demand.body, { id: demand.body.id });

    const proposal = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      body: proposalBody(demand.body.id, { template_id: 'wave1-legacy-proposal' })
    });
    assert.equal(proposal.status, 200, proposal.text);
    assert.deepEqual(proposal.body, { id: proposal.body.id });
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE (record_type='demand' AND record_id=?)
         OR (record_type='proposal' AND record_id=?)
    `).get(String(demand.body.id), String(proposal.body.id)).count, 0);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM campaign_events').get().count, 0);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('linked demand and proposal requests require idempotency and campaign preauthorization before mutation', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave1-admission-');
  try {
    const missingDemand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      body: demandBody({ brand_name: 'Wave 1 missing-key demand', campaign_id: fixture.campaignId })
    });
    const missingProposal = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      body: proposalBody(fixture.seedDemandId, {
        template_id: 'wave1-missing-key-proposal',
        campaign_id: fixture.campaignId
      })
    });
    transferCampaignAway(fixture);
    const forbiddenDemand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      idempotencyKey: 'task7-forbidden-demand',
      body: demandBody({ brand_name: 'Wave 1 forbidden demand', campaign_id: fixture.campaignId })
    });
    const forbiddenProposal = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-forbidden-proposal',
      body: proposalBody(fixture.seedDemandId, {
        template_id: 'wave1-forbidden-proposal',
        campaign_id: fixture.campaignId
      })
    });

    const markerRows = fixture.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM demands WHERE brand_name LIKE 'Wave 1 %key demand' OR brand_name='Wave 1 forbidden demand') AS demands,
        (SELECT COUNT(*) FROM proposals WHERE template_id IN ('wave1-missing-key-proposal','wave1-forbidden-proposal')) AS proposals
    `).get();
    assert.deepEqual({
      responses: [missingDemand, missingProposal, forbiddenDemand, forbiddenProposal].map(responseSummary),
      markerRows
    }, {
      responses: [
        { status: 400, code: 'IDEMPOTENCY_REQUIRED' },
        { status: 400, code: 'IDEMPOTENCY_REQUIRED' },
        { status: 403, code: 'CAMPAIGN_FORBIDDEN' },
        { status: 403, code: 'CAMPAIGN_FORBIDDEN' }
      ],
      markerRows: { demands: 0, proposals: 0 }
    });
  } finally {
    await fixture.close();
  }
});

test('linked demand and proposal success commits business archive links event and ledger once and replay reauthorizes', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave1-success-');
  try {
    const linkedDemandBody = demandBody({
      brand_name: 'Wave 1 linked demand',
      campaign_id: fixture.campaignId
    });
    const linkedProposalBody = proposalBody(fixture.seedDemandId, {
      template_id: 'wave1-linked-proposal',
      campaign_id: fixture.campaignId
    });
    const demand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      idempotencyKey: 'task7-linked-demand',
      body: linkedDemandBody
    });
    const proposal = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-linked-proposal',
      body: linkedProposalBody
    });

    transferCampaignAway(fixture);
    const demandReplay = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      idempotencyKey: 'task7-linked-demand',
      body: linkedDemandBody
    });
    const proposalReplay = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-linked-proposal',
      body: linkedProposalBody
    });

    const state = {
      demandRows: fixture.db.prepare("SELECT COUNT(*) AS count FROM demands WHERE brand_name='Wave 1 linked demand'").get().count,
      proposalRows: fixture.db.prepare("SELECT COUNT(*) AS count FROM proposals WHERE template_id='wave1-linked-proposal'").get().count,
      archives: fixture.db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_type IN ('campaign_demand','campaign_proposal')").get().count,
      businessLinks: fixture.db.prepare("SELECT COUNT(*) AS count FROM campaign_record_links WHERE campaign_id=? AND relation_type IN ('demand','proposal') AND revoked_at IS NULL").get(fixture.campaignId).count,
      archiveLinks: fixture.db.prepare("SELECT COUNT(*) AS count FROM campaign_record_links WHERE campaign_id=? AND relation_type='knowledge' AND revoked_at IS NULL").get(fixture.campaignId).count,
      events: fixture.db.prepare("SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=? AND event_type='link_attached' AND source IN ('demand_link','proposal_link')").get(fixture.campaignId).count,
      ledgers: fixture.db.prepare("SELECT COUNT(*) AS count FROM request_idempotency WHERE campaign_id=? AND scope IN ('demand.create.linked','proposal.create.linked') AND state='completed' AND status_code=201").get(fixture.campaignId).count
    };
    assert.deepEqual({
      initial: [
        { status: demand.status, keys: Object.keys(demand.body || {}).sort() },
        { status: proposal.status, keys: Object.keys(proposal.body || {}).sort() }
      ],
      replay: [responseSummary(demandReplay), responseSummary(proposalReplay)],
      state
    }, {
      initial: [
        { status: 201, keys: ['campaign_id', 'id', 'link_id'] },
        { status: 201, keys: ['campaign_id', 'content_sha256', 'id'] }
      ],
      replay: [
        { status: 403, code: 'CAMPAIGN_FORBIDDEN' },
        { status: 403, code: 'CAMPAIGN_FORBIDDEN' }
      ],
      state: {
        demandRows: 1,
        proposalRows: 1,
        archives: 2,
        businessLinks: 2,
        archiveLinks: 2,
        events: 2,
        ledgers: 2
      }
    });
  } finally {
    await fixture.close();
  }
});

test('campaign proposal confirmation commits real demand proposal archives links events ledger once and replays', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task6a-confirmation-success-');
  try {
    const body = proposalConfirmationBody();
    const requestPath = `/api/campaigns/${fixture.campaignId}/proposal-confirmations`;
    const created = await jsonRequest(fixture.server, requestPath, {
      token: fixture.token,
      idempotencyKey: 'task6a-confirmation-success',
      body
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.campaign_id, fixture.campaignId);
    assert.ok(created.body.demand.id > 0);
    assert.ok(created.body.demand.link_id > 0);
    assert.ok(created.body.proposal.id > 0);
    assert.match(created.body.proposal.content_sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      created.body.proposal.content_sha256,
      sha256Hex(Buffer.from(body.proposal.content, 'utf8'))
    );

    const proposalRow = fixture.db.prepare(`
      SELECT id,demand_id,template_id,content
      FROM proposals
      WHERE id=?
    `).get(created.body.proposal.id);
    assert.deepEqual(proposalRow, {
      id: created.body.proposal.id,
      demand_id: created.body.demand.id,
      template_id: body.proposal.template_id,
      content: body.proposal.content
    });
    assert.notEqual(proposalRow.demand_id, body.draft.demand_entry_id);

    const firstState = fixture.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM demands WHERE brand_name='Task 6A confirmed demand') AS demands,
        (SELECT COUNT(*) FROM proposals WHERE template_id='task6a-human-confirmed') AS proposals,
        (SELECT COUNT(*) FROM knowledge_entries
          WHERE source_type IN ('campaign_demand','campaign_proposal')) AS archives,
        (SELECT COUNT(*) FROM knowledge_chunks
          WHERE entry_id IN (
            SELECT id FROM knowledge_entries
            WHERE source_type IN ('campaign_demand','campaign_proposal')
          )) AS chunks,
        (SELECT COUNT(*) FROM campaign_record_links
          WHERE campaign_id=@campaignId AND relation_type IN ('demand','proposal')
            AND revoked_at IS NULL) AS businessLinks,
        (SELECT COUNT(*) FROM campaign_record_links
          WHERE campaign_id=@campaignId AND relation_type='knowledge'
            AND revoked_at IS NULL) AS archiveLinks,
        (SELECT COUNT(*) FROM campaign_events
          WHERE campaign_id=@campaignId AND event_type='link_attached'
            AND source IN ('demand_link','proposal_link')) AS events,
        (SELECT COUNT(*) FROM activity_log
          WHERE user_id=@userId AND action IN ('create_demand','generate_proposal')
            AND (details LIKE '%Task 6A confirmed demand%'
              OR details LIKE '%task6a-human-confirmed%')) AS activity,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE campaign_id=@campaignId
            AND scope='proposal.create.linked'
            AND idempotency_key='task6a-confirmation-success'
            AND state='completed'
            AND status_code=201) AS ledgers
    `).get({ campaignId: fixture.campaignId, userId: fixture.userId });
    assert.deepEqual(firstState, {
      demands: 1,
      proposals: 1,
      archives: 2,
      chunks: 2,
      businessLinks: 2,
      archiveLinks: 2,
      events: 1,
      activity: 2,
      ledgers: 1
    });

    const replay = await jsonRequest(fixture.server, requestPath, {
      token: fixture.token,
      idempotencyKey: 'task6a-confirmation-success',
      body
    });
    const conflict = await jsonRequest(fixture.server, requestPath, {
      token: fixture.token,
      idempotencyKey: 'task6a-confirmation-success',
      body: proposalConfirmationBody({
        proposal: {
          template_id: 'task6a-human-confirmed',
          content: '# Task 6A changed human proposal'
        }
      })
    });
    const secondState = fixture.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM demands WHERE brand_name='Task 6A confirmed demand') AS demands,
        (SELECT COUNT(*) FROM proposals WHERE template_id='task6a-human-confirmed') AS proposals,
        (SELECT COUNT(*) FROM knowledge_entries
          WHERE source_type IN ('campaign_demand','campaign_proposal')) AS archives,
        (SELECT COUNT(*) FROM campaign_record_links WHERE campaign_id=@campaignId) AS links,
        (SELECT COUNT(*) FROM campaign_events WHERE campaign_id=@campaignId) AS events,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE campaign_id=@campaignId
            AND scope='proposal.create.linked') AS ledgers
    `).get({ campaignId: fixture.campaignId });
    assert.equal(replay.status, 201, replay.text);
    assert.deepEqual(replay.body, created.body);
    assert.deepEqual(responseSummary(conflict), {
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    });
    assert.deepEqual(secondState, {
      demands: 1,
      proposals: 1,
      archives: 2,
      links: 4,
      events: 1,
      ledgers: 1
    });
  } finally {
    await fixture.close();
  }
});

test('campaign proposal confirmation replay reauthorizes after campaign access is revoked', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task6a-confirmation-revoked-');
  try {
    const body = proposalConfirmationBody({
      demand: demandBody({ brand_name: 'Task 6A revoked replay demand' }),
      proposal: {
        template_id: 'task6a-revoked-replay',
        content: '# Task 6A revoked replay proposal'
      }
    });
    const requestPath = `/api/campaigns/${fixture.campaignId}/proposal-confirmations`;
    const created = await jsonRequest(fixture.server, requestPath, {
      token: fixture.token,
      idempotencyKey: 'task6a-confirmation-revoked',
      body
    });
    assert.equal(created.status, 201, created.text);

    transferCampaignAway(fixture);
    const replay = await jsonRequest(fixture.server, requestPath, {
      token: fixture.token,
      idempotencyKey: 'task6a-confirmation-revoked',
      body
    });
    assert.deepEqual(responseSummary(replay), {
      status: 403,
      code: 'CAMPAIGN_FORBIDDEN'
    });
  } finally {
    await fixture.close();
  }
});

test('campaign proposal confirmation archive failure rolls back every linked artifact and ledger', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task6a-confirmation-rollback-');
  try {
    fixture.db.exec(`
      CREATE TRIGGER task6a_fail_confirmation_archive
      BEFORE INSERT ON knowledge_entries
      WHEN NEW.source_type IN ('campaign_demand','campaign_proposal')
      BEGIN SELECT RAISE(ABORT,'injected task6a archive failure'); END
    `);
    const response = await jsonRequest(
      fixture.server,
      `/api/campaigns/${fixture.campaignId}/proposal-confirmations`,
      {
        token: fixture.token,
        idempotencyKey: 'task6a-confirmation-rollback',
        body: proposalConfirmationBody({
          demand: demandBody({ brand_name: 'Task 6A rollback demand' }),
          proposal: {
            template_id: 'task6a-rollback-proposal',
            content: '# Task 6A rollback proposal'
          }
        })
      }
    );
    assert.equal(response.status, 500, response.text);
    assert.equal(response.body.code, 'AUDIT_PERSISTENCE_FAILED');
    assert.equal(JSON.stringify(response.body).includes('task6a archive failure'), false);
    assert.deepEqual(fixture.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM demands WHERE brand_name='Task 6A rollback demand') AS demands,
        (SELECT COUNT(*) FROM proposals WHERE template_id='task6a-rollback-proposal') AS proposals,
        (SELECT COUNT(*) FROM knowledge_entries
          WHERE source_type IN ('campaign_demand','campaign_proposal')) AS archives,
        (SELECT COUNT(*) FROM knowledge_chunks
          WHERE entry_id IN (
            SELECT id FROM knowledge_entries
            WHERE source_type IN ('campaign_demand','campaign_proposal')
          )) AS chunks,
        (SELECT COUNT(*) FROM campaign_record_links WHERE campaign_id=@campaignId) AS links,
        (SELECT COUNT(*) FROM campaign_events WHERE campaign_id=@campaignId) AS events,
        (SELECT COUNT(*) FROM activity_log
          WHERE user_id=@userId AND action IN ('create_demand','generate_proposal')
            AND (details LIKE '%Task 6A rollback demand%'
              OR details LIKE '%task6a-rollback-proposal%')) AS activity,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE campaign_id=@campaignId
            AND idempotency_key='task6a-confirmation-rollback') AS ledgers
    `).get({ campaignId: fixture.campaignId, userId: fixture.userId }), {
      demands: 0,
      proposals: 0,
      archives: 0,
      chunks: 0,
      links: 0,
      events: 0,
      activity: 0,
      ledgers: 0
    });
  } finally {
    await fixture.close();
  }
});

test('linked demand and proposal archives project only committed immutable rows with canonical JSON and scalar-safe summaries', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-archive-projection-');
  try {
    fixture.db.exec(`
      CREATE TRIGGER task7_committed_demand_projection
      AFTER INSERT ON demands
      WHEN NEW.brand_name='Task 7 request-body demand'
      BEGIN
        UPDATE demands
        SET brand_name='Task 7 committed demand',
          company_name='Committed Company',
          product_name='Committed Product',
          industry='Committed Industry',
          budget='9999 USD',
          target_market='Committed Market',
          platform='Committed Platform',
          status='confirmed',
          data_json='{"z":{"b":2,"a":1},"a":["\\u00e9","\\ud83d\\ude00"]}'
        WHERE id=NEW.id;
      END;
      CREATE TRIGGER task7_committed_proposal_projection
      AFTER INSERT ON proposals
      WHEN NEW.template_id='task7-request-template'
      BEGIN
        UPDATE proposals
        SET content='{"z":2,"title":"Task 7 committed proposal","a":["\\ud83d\\ude00","\\u00e9"]}'
        WHERE id=NEW.id;
      END;
    `);

    const { createCampaignLinkService } = require('../services/campaign_link_service');
    assert.doesNotThrow(() => createCampaignLinkService(fixture.db).createProposal({
      userId: fixture.userId,
      requestId: 'task7-archive-projection-direct-proposal-request',
      idempotencyKey: 'task7-archive-projection-direct-proposal',
      body: proposalBody(fixture.seedDemandId, {
        template_id: 'task7-direct-template',
        campaign_id: fixture.campaignId
      })
    }));

    const demand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      idempotencyKey: 'task7-archive-demand-projection',
      body: demandBody({
        brand_name: 'Task 7 request-body demand',
        company_name: 'Request Company',
        product_name: 'Request Product',
        industry: 'Request Industry',
        budget: '1 USD',
        target_market: 'Request Market',
        platform: 'Request Platform',
        data_json: { request_only: true },
        campaign_id: fixture.campaignId
      })
    });
    const proposalRequestBody = proposalBody(fixture.seedDemandId, {
      template_id: 'task7-request-template',
      content: '{"title":"Task 7 request proposal","request_only":true}',
      campaign_id: fixture.campaignId
    });
    const proposal = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-archive-proposal-projection',
      body: proposalRequestBody
    });

    assert.equal(demand.status, 201, `${demand.text}\n${fixture.server.output()}`);
    assert.equal(proposal.status, 201, `${proposal.text}\n${fixture.server.output()}`);

    const demandRow = fixture.db.prepare(`
      SELECT id,brand_name,company_name,product_name,industry,budget,
        target_market,platform,status,data_json
      FROM demands WHERE id=?
    `).get(demand.body.id);
    const proposalRow = fixture.db.prepare(`
      SELECT id,demand_id,content FROM proposals WHERE id=?
    `).get(proposal.body.id);
    const demandArchive = fixture.db.prepare(`
      SELECT id,entry_type,source_type,source_id,
        typeof(source_id) AS source_id_type,title,summary,content,
        key_terms,tags_json,visibility,is_public,source_hash,business_type,
        business_id,metadata_json,embedding_json,created_by,
        source_identity_sha256,content_sha256
      FROM knowledge_entries WHERE source_type='campaign_demand' AND source_id=?
    `).get(String(demand.body.id));
    const proposalArchive = fixture.db.prepare(`
      SELECT id,entry_type,source_type,source_id,
        typeof(source_id) AS source_id_type,title,summary,content,
        key_terms,tags_json,visibility,is_public,source_hash,business_type,
        business_id,metadata_json,embedding_json,created_by,
        source_identity_sha256,content_sha256
      FROM knowledge_entries WHERE source_type='campaign_proposal' AND source_id=?
    `).get(String(proposal.body.id));
    const committedDemandData = JSON.parse(canonicalJsonBytes(JSON.parse(demandRow.data_json)).toString('utf8'));
    const committedProposalContent = JSON.parse(canonicalJsonBytes(JSON.parse(proposalRow.content)).toString('utf8'));
    const committedProposalDigest = sha256Hex(canonicalJsonBytes(committedProposalContent));
    const expectedDemandContent = JSON.stringify({
      id: demandRow.id,
      brand_name: demandRow.brand_name,
      company_name: demandRow.company_name,
      product_name: demandRow.product_name,
      industry: demandRow.industry,
      budget: demandRow.budget,
      target_market: demandRow.target_market,
      platform: demandRow.platform,
      status: demandRow.status,
      data: committedDemandData
    });
    const expectedProposalContent = JSON.stringify({
      id: proposalRow.id,
      demand_id: proposalRow.demand_id,
      title: committedProposalContent.title,
      content_sha256: committedProposalDigest,
      content: committedProposalContent
    });
    const demandTitle = `Campaign demand #${demandRow.id}`;
    const proposalTitle = `Campaign proposal #${proposalRow.id}`;
    const demandSummary = Array.from(
      expectedDemandContent.replace(/\s+/gu, ' ').trim()
    ).slice(0, 1000).join('');
    const proposalSummary = Array.from(
      expectedProposalContent.replace(/\s+/gu, ' ').trim()
    ).slice(0, 1000).join('');
    const demandTagsJson = '["campaign","demand"]';
    const proposalTagsJson = '["campaign","proposal"]';
    const demandEntryId = demandArchive.id;
    const proposalEntryId = proposalArchive.id;
    const readRecordLink = fixture.db.prepare(`
      SELECT record_type,record_id,relation_type,metadata_json
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type=? AND record_id=?
        AND relation_type=? AND revoked_at IS NULL
    `);

    assert.deepEqual({
      demand: readRecordLink.get(
        fixture.campaignId,
        'demand',
        String(demandRow.id),
        'demand'
      ),
      demandArchive: readRecordLink.get(
        fixture.campaignId,
        'knowledge_entry',
        String(demandEntryId),
        'knowledge'
      ),
      proposal: readRecordLink.get(
        fixture.campaignId,
        'proposal',
        String(proposalRow.id),
        'proposal'
      ),
      proposalArchive: readRecordLink.get(
        fixture.campaignId,
        'knowledge_entry',
        String(proposalEntryId),
        'knowledge'
      )
    }, {
      demand: {
        record_type: 'demand',
        record_id: String(demandRow.id),
        relation_type: 'demand',
        metadata_json: '{}'
      },
      demandArchive: {
        record_type: 'knowledge_entry',
        record_id: String(demandEntryId),
        relation_type: 'knowledge',
        metadata_json: '{}'
      },
      proposal: {
        record_type: 'proposal',
        record_id: String(proposalRow.id),
        relation_type: 'proposal',
        metadata_json: '{}'
      },
      proposalArchive: {
        record_type: 'knowledge_entry',
        record_id: String(proposalEntryId),
        relation_type: 'knowledge',
        metadata_json: '{}'
      }
    });

    assert.deepEqual(Object.keys(JSON.parse(demandArchive.content)), [
      'id',
      'brand_name',
      'company_name',
      'product_name',
      'industry',
      'budget',
      'target_market',
      'platform',
      'status',
      'data'
    ]);
    assert.deepEqual(Object.keys(JSON.parse(proposalArchive.content)), [
      'id',
      'demand_id',
      'title',
      'content_sha256',
      'content'
    ]);

    assert.ok(Number.isSafeInteger(demandEntryId) && demandEntryId > 0);
    assert.ok(Number.isSafeInteger(proposalEntryId) && proposalEntryId > 0);
    assert.deepEqual({ ...demandArchive, id: undefined }, {
      id: undefined,
      entry_type: 'campaign_demand',
      source_type: 'campaign_demand',
      source_id: demandRow.id,
      source_id_type: 'integer',
      title: demandTitle,
      summary: demandSummary,
      content: expectedDemandContent,
      key_terms: demandTagsJson,
      tags_json: demandTagsJson,
      visibility: 'team',
      is_public: 1,
      source_hash: null,
      business_type: 'campaign',
      business_id: String(fixture.campaignId),
      metadata_json: '{}',
      embedding_json: null,
      created_by: fixture.userId,
      source_identity_sha256: campaignSourceIdentityDigestFixture({
        organizationId: fixture.orgId,
        campaignId: fixture.campaignId,
        sourceType: 'campaign_demand',
        sourceId: demandRow.id,
        entryType: 'campaign_demand'
      }),
      content_sha256: knowledgeContentDigestFixture({
        entryType: 'campaign_demand',
        title: demandTitle,
        summary: demandSummary,
        content: expectedDemandContent,
        tagsJson: demandTagsJson,
        visibility: 'team'
      })
    });
    assert.deepEqual({ ...proposalArchive, id: undefined }, {
      id: undefined,
      entry_type: 'campaign_proposal',
      source_type: 'campaign_proposal',
      source_id: proposalRow.id,
      source_id_type: 'integer',
      title: proposalTitle,
      summary: proposalSummary,
      content: expectedProposalContent,
      key_terms: proposalTagsJson,
      tags_json: proposalTagsJson,
      visibility: 'team',
      is_public: 1,
      source_hash: null,
      business_type: 'campaign',
      business_id: String(fixture.campaignId),
      metadata_json: '{}',
      embedding_json: null,
      created_by: fixture.userId,
      source_identity_sha256: campaignSourceIdentityDigestFixture({
        organizationId: fixture.orgId,
        campaignId: fixture.campaignId,
        sourceType: 'campaign_proposal',
        sourceId: proposalRow.id,
        entryType: 'campaign_proposal'
      }),
      content_sha256: knowledgeContentDigestFixture({
        entryType: 'campaign_proposal',
        title: proposalTitle,
        summary: proposalSummary,
        content: expectedProposalContent,
        tagsJson: proposalTagsJson,
        visibility: 'team'
      })
    });
    assert.deepEqual(fixture.db.prepare(`
      SELECT entry_id,chunk_index,content,metadata_json,embedding_json,
        content_sha256
      FROM knowledge_chunks
      WHERE entry_id=?
      ORDER BY chunk_index,id
    `).all(demandEntryId), [{
      entry_id: demandEntryId,
      chunk_index: 0,
      content: expectedDemandContent,
      metadata_json: JSON.stringify({ title: demandTitle }),
      embedding_json: null,
      content_sha256: sha256Hex(Buffer.from(expectedDemandContent, 'utf8'))
    }]);
    assert.deepEqual(fixture.db.prepare(`
      SELECT entry_id,chunk_index,content,metadata_json,embedding_json,
        content_sha256
      FROM knowledge_chunks
      WHERE entry_id=?
      ORDER BY chunk_index,id
    `).all(proposalEntryId), [{
      entry_id: proposalEntryId,
      chunk_index: 0,
      content: expectedProposalContent,
      metadata_json: JSON.stringify({ title: proposalTitle }),
      embedding_json: null,
      content_sha256: sha256Hex(Buffer.from(expectedProposalContent, 'utf8'))
    }]);
    assert.equal(proposal.body.content_sha256, committedProposalDigest);

    const unicodeBody = demandBody({
      brand_name: `${'a'.repeat(980)}😀tail`,
      campaign_id: fixture.campaignId
    });
    const unicodeDemand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      idempotencyKey: 'task7-unicode-summary-boundary',
      body: unicodeBody
    });
    assert.equal(unicodeDemand.status, 201, unicodeDemand.text);
    const unicodeArchive = fixture.db.prepare(`
      SELECT content,summary FROM knowledge_entries
      WHERE source_type='campaign_demand' AND source_id=?
    `).get(String(unicodeDemand.body.id));
    assert.equal(
      unicodeArchive.summary,
      Array.from(unicodeArchive.content.replace(/\s+/gu, ' ').trim()).slice(0, 1000).join('')
    );
    assert.equal(Array.from(unicodeArchive.summary).length, 1000);
    assert.equal(/[\ud800-\udfff]/u.test(unicodeArchive.summary), false);

    const proposalReplay = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-archive-proposal-projection',
      body: proposalRequestBody
    });
    const proposalConflict = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-archive-proposal-projection',
      body: {
        ...proposalRequestBody,
        content: '{"title":"Task 7 changed proposal"}'
      }
    });
    assert.equal(proposalReplay.status, proposal.status);
    assert.deepEqual(proposalReplay.body, proposal.body);
    assert.deepEqual(responseSummary(proposalConflict), {
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED'
    });
  } finally {
    await fixture.close();
  }
});

test('linked demand and proposal archive failure rolls back producer links event gauges and ledger', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-archive-failure-');
  try {
    const gaugeCount = fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_capacity_gauges'
    ).get().count;
    fixture.db.exec(`
      CREATE TRIGGER task7_fail_archive_projection
      BEFORE INSERT ON knowledge_entries
      WHEN NEW.source_type IN ('campaign_demand','campaign_proposal')
      BEGIN SELECT RAISE(ABORT,'injected archive projection failure'); END;
    `);
    const demand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      idempotencyKey: 'task7-archive-failure-demand',
      body: demandBody({
        brand_name: 'Task 7 archive failure demand',
        campaign_id: fixture.campaignId
      })
    });
    const proposal = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-archive-failure-proposal',
      body: proposalBody(fixture.seedDemandId, {
        template_id: 'task7-archive-failure-proposal',
        campaign_id: fixture.campaignId
      })
    });
    for (const response of [demand, proposal]) {
      assert.equal(response.status, 500, response.text);
    }
    assert.deepEqual(fixture.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM demands WHERE brand_name='Task 7 archive failure demand') AS demands,
        (SELECT COUNT(*) FROM proposals WHERE template_id='task7-archive-failure-proposal') AS proposals,
        (SELECT COUNT(*) FROM knowledge_entries
          WHERE source_type IN ('campaign_demand','campaign_proposal')) AS archives,
        (SELECT COUNT(*) FROM campaign_record_links WHERE campaign_id=@campaignId) AS links,
        (SELECT COUNT(*) FROM campaign_events WHERE campaign_id=@campaignId) AS events,
        (SELECT COUNT(*) FROM knowledge_capacity_gauges) AS gauges,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE idempotency_key IN ('task7-archive-failure-demand','task7-archive-failure-proposal')) AS ledgers
    `).get({ campaignId: fixture.campaignId }), {
      demands: 0,
      proposals: 0,
      archives: 0,
      links: 0,
      events: 0,
      gauges: gaugeCount,
      ledgers: 0
    });
  } finally {
    await fixture.close();
  }
});

test('linked demand and proposal final-transaction rejection leaves zero producer archive link or event state', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave1-rollback-', 'on_hold');
  try {
    const demand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      idempotencyKey: 'task7-held-demand',
      body: demandBody({ brand_name: 'Wave 1 held demand', campaign_id: fixture.campaignId })
    });
    const proposal = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-held-proposal',
      body: proposalBody(fixture.seedDemandId, {
        template_id: 'wave1-held-proposal',
        campaign_id: fixture.campaignId
      })
    });
    const state = {
      demandRows: fixture.db.prepare("SELECT COUNT(*) AS count FROM demands WHERE brand_name='Wave 1 held demand'").get().count,
      proposalRows: fixture.db.prepare("SELECT COUNT(*) AS count FROM proposals WHERE template_id='wave1-held-proposal'").get().count,
      archives: fixture.db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_type IN ('campaign_demand','campaign_proposal')").get().count,
      links: fixture.db.prepare('SELECT COUNT(*) AS count FROM campaign_record_links WHERE campaign_id=?').get(fixture.campaignId).count,
      events: fixture.db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?').get(fixture.campaignId).count,
      errorLedgers: fixture.db.prepare("SELECT COUNT(*) AS count FROM request_idempotency WHERE campaign_id=? AND scope IN ('demand.create.linked','proposal.create.linked') AND state='completed' AND status_code=409").get(fixture.campaignId).count
    };
    assert.deepEqual({
      responses: [responseSummary(demand), responseSummary(proposal)],
      state
    }, {
      responses: [
        { status: 409, code: 'CAMPAIGN_ON_HOLD' },
        { status: 409, code: 'CAMPAIGN_ON_HOLD' }
      ],
      state: {
        demandRows: 0,
        proposalRows: 0,
        archives: 0,
        links: 0,
        events: 0,
        errorLedgers: 2
      }
    });
  } finally {
    await fixture.close();
  }
});

test('linked knowledge JSON routes require closed input and idempotency without changing omission behavior', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-knowledge-admission-');
  try {
    const legacy = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      body: {
        title: 'Task 7 legacy knowledge',
        content: 'Legacy omission remains unlinked',
        visibility: 'shared'
      }
    });
    const missingKey = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      body: knowledgeBody(fixture.campaignId, 'missing-key')
    });
    const invalidVisibility = await jsonRequest(fixture.server, '/api/knowledge/ingest', {
      token: fixture.token,
      idempotencyKey: 'task7-invalid-knowledge-visibility',
      body: knowledgeBody(fixture.campaignId, 'invalid-visibility', {
        visibility: 'public'
      })
    });
    const invalidAlias = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'task7-invalid-knowledge-alias',
      body: knowledgeBody(fixture.campaignId, 'invalid-alias', { is_public: 1 })
    });
    const invalidMetadataResponses = [];
    for (const [suffix, metadata] of [['null', null], ['array', []]]) {
      invalidMetadataResponses.push(await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        idempotencyKey: `task7-invalid-metadata-${suffix}`,
        body: knowledgeBody(fixture.campaignId, `invalid-metadata-${suffix}`, { metadata })
      }));
    }

    assert.equal(legacy.status, 200, legacy.text);
    assert.equal(missingKey.status, 400, missingKey.text);
    assert.equal(missingKey.body.code, 'IDEMPOTENCY_REQUIRED');
    assert.equal(invalidVisibility.status, 400, invalidVisibility.text);
    assert.equal(invalidVisibility.body.code, 'INVALID_CAMPAIGN_INPUT');
    assert.equal(invalidAlias.status, 400, invalidAlias.text);
    assert.equal(invalidAlias.body.code, 'INVALID_CAMPAIGN_INPUT');
    for (const invalidMetadata of invalidMetadataResponses) {
      assert.equal(invalidMetadata.status, 400, invalidMetadata.text);
      assert.equal(invalidMetadata.body.code, 'INVALID_CAMPAIGN_INPUT');
    }
    const legacyUse = await jsonRequest(
      fixture.server,
      `/api/knowledge/${legacy.body.id}/use`,
      {
        token: fixture.token,
        body: { legacy_hint: true }
      }
    );
    assert.equal(legacyUse.status, 200, legacyUse.text);
    assert.deepEqual(legacyUse.body, { success: true });
    for (const invalidId of ['07', '+7', '7.0', '9007199254740992']) {
      const invalidUse = await jsonRequest(
        fixture.server,
        `/api/knowledge/${invalidId}/use`,
        { token: fixture.token }
      );
      assert.equal(invalidUse.status, 400, invalidId + ': ' + invalidUse.text);
      assert.equal(invalidUse.body.code, 'INVALID_CAMPAIGN_INPUT', invalidId);
    }
    assert.deepEqual(fixture.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM campaign_record_links
          WHERE record_type='knowledge_entry') AS links,
        (SELECT COUNT(*) FROM campaign_events
          WHERE source='knowledge_link') AS events,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE scope IN ('knowledge.create.linked','knowledge.ingest.linked')) AS ledgers,
        (SELECT visibility FROM knowledge_entries WHERE id=?) AS legacy_visibility
    `).get(legacy.body.id), {
      links: 0,
      events: 0,
      ledgers: 0,
      legacy_visibility: 'shared'
    });
    assert.equal(
      fixture.db.prepare('SELECT usage_count FROM knowledge_entries WHERE id=?')
        .get(legacy.body.id).usage_count,
      1
    );
  } finally {
    await fixture.close();
  }
});

test('legacy knowledge omission rejects reserved campaign namespaces before persistence', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-legacy-reserved-');
  try {
    const attempts = [
      await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        body: {
          entry_type: 'note',
          title: 'Reserved legacy source type',
          summary: 'Must not fabricate internal evidence',
          content: 'Must not fabricate internal evidence',
          tags: ['legacy'],
          source_type: 'campaign_review',
          source_id: 'legacy-reserved-source'
        }
      }),
      await jsonRequest(fixture.server, '/api/knowledge/ingest', {
        token: fixture.token,
        body: {
          entry_type: 'campaign_review',
          title: 'Reserved legacy entry type',
          summary: 'Must not fabricate internal evidence',
          content: 'Must not fabricate internal evidence',
          tags: ['legacy'],
          source_type: 'manual_upload',
          source_id: 'legacy-reserved-entry'
        }
      }),
      await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        body: {
          type: 'campaign_review',
          title: 'Reserved legacy type alias',
          summary: 'Must not fabricate internal evidence',
          content: 'Must not fabricate internal evidence',
          tags: ['legacy'],
          source_type: 'manual_upload',
          source_id: 'legacy-reserved-type-alias'
        }
      }),
      await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        body: {
          entry_type: 'note',
          title: 'Reserved source array',
          summary: 'Must reject type confusion',
          content: 'Must reject type confusion',
          tags: ['legacy'],
          source_type: ['campaign_review'],
          source_id: 'legacy-reserved-source-array'
        }
      }),
      await jsonRequest(fixture.server, '/api/knowledge/ingest', {
        token: fixture.token,
        body: {
          entry_type: ['campaign_review'],
          title: 'Reserved entry array',
          summary: 'Must reject type confusion',
          content: 'Must reject type confusion',
          tags: ['legacy'],
          source_type: 'manual_upload',
          source_id: 'legacy-reserved-entry-array'
        }
      }),
      await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        body: {
          entry_type: '',
          type: 'campaign_review',
          title: 'Reserved fallback alias',
          summary: 'Must reject fallback alias confusion',
          content: 'Must reject fallback alias confusion',
          tags: ['legacy'],
          source_type: 'manual_upload',
          source_id: 'legacy-reserved-empty-entry-alias'
        }
      }),
      await jsonRequest(fixture.server, '/api/knowledge/ingest', {
        token: fixture.token,
        body: {
          entry_type: null,
          type: 'campaign_review',
          title: 'Reserved null fallback alias',
          summary: 'Must reject null fallback alias confusion',
          content: 'Must reject null fallback alias confusion',
          tags: ['legacy'],
          source_type: 'manual_upload',
          source_id: 'legacy-reserved-null-entry-alias'
        }
      }),
      await rawRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([
          ['entry_type', 'note'],
          ['title', 'Reserved form source array'],
          ['summary', 'Must reject form type confusion'],
          ['content', 'Must reject form type confusion'],
          ['tags[]', 'legacy'],
          ['source_type[]', 'campaign_review'],
          ['source_id', 'legacy-reserved-form-array']
        ]).toString()
      })
    ];

    assert.deepEqual(attempts.map(responseSummary), attempts.map(() => ({
      status: 400,
      code: 'INVALID_CAMPAIGN_INPUT'
    })));
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_entries
      WHERE source_id IN (
        'legacy-reserved-source',
        'legacy-reserved-entry',
        'legacy-reserved-type-alias',
        'legacy-reserved-source-array',
        'legacy-reserved-entry-array',
        'legacy-reserved-empty-entry-alias',
        'legacy-reserved-null-entry-alias',
        'legacy-reserved-form-array'
      )
    `).get().count, 0);
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count
      FROM request_idempotency
      WHERE scope IN ('knowledge.create.linked','knowledge.ingest.linked')
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('numeric linked knowledge source ids canonicalize before hashing while preserving SQLite affinity', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-numeric-source-id-');
  try {
    const idempotencyKey = 'wave2-numeric-source-canonical';
    const numericBody = knowledgeBody(fixture.campaignId, 7);
    const created = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey,
      body: numericBody
    });
    const replay = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey,
      body: { ...numericBody, source_id: '7' }
    });

    assert.equal(created.status, 201, created.text);
    assert.equal(replay.status, created.status, replay.text);
    assert.deepEqual(replay.body, created.body);
    assert.deepEqual(fixture.db.prepare(`
      SELECT source_id,typeof(source_id) AS storage_type
      FROM knowledge_entries
      WHERE id=?
    `).get(created.body.id), {
      source_id: 7,
      storage_type: 'integer'
    });
    const ledger = fixture.db.prepare(`
      SELECT request_hash
      FROM request_idempotency
      WHERE scope='knowledge.create.linked' AND idempotency_key=?
    `).get(idempotencyKey);
    assert.deepEqual(ledger, {
      request_hash: requestHash({
        method: 'POST',
        path: '/api/knowledge',
        campaignId: fixture.campaignId,
        kind: 'json',
        payload: {
          ...numericBody,
          source_id: '7',
          visibility: 'private',
          metadata: {}
        }
      })
    });
  } finally {
    await fixture.close();
  }
});

test('linked knowledge rejects every non-string tag as a stable client error', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-linked-tags-');
  try {
    const invalidTags = [
      ['null', null],
      ['boolean', true],
      ['number', 7],
      ['object', { invalid: true }],
      ['array', ['nested']]
    ];
    const responses = [];
    for (const [endpointIndex, endpoint] of ['/api/knowledge', '/api/knowledge/ingest'].entries()) {
      for (const [caseIndex, [label, tag]] of invalidTags.entries()) {
        responses.push(await jsonRequest(fixture.server, endpoint, {
          token: fixture.token,
          idempotencyKey: `wave2-linked-tag-${endpointIndex}-${caseIndex}`,
          body: knowledgeBody(fixture.campaignId, `linked-tag-${endpointIndex}-${label}`, {
            tags: [tag]
          })
        }));
      }
    }

    assert.deepEqual(responses.map(responseSummary), responses.map(() => ({
      status: 400,
      code: 'INVALID_CAMPAIGN_INPUT'
    })));
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_id LIKE 'linked-tag-%'
    `).get().count, 0);
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE idempotency_key LIKE 'wave2-linked-tag-%'
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('legacy knowledge omission rejects non-string tags as stable client errors', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-legacy-tags-');
  try {
    const invalidTags = [
      ['null', null],
      ['boolean', true],
      ['number', 7],
      ['object', { invalid: true }],
      ['array', ['nested']]
    ];
    const responses = [];
    for (const [endpointIndex, endpoint] of ['/api/knowledge', '/api/knowledge/ingest'].entries()) {
      for (const [label, tag] of invalidTags) {
        const body = knowledgeBody(
          fixture.campaignId,
          `legacy-tag-${endpointIndex}-${label}`,
          { tags: [tag], source_type: 'legacy_tag_validation' }
        );
        delete body.campaign_id;
        responses.push(await jsonRequest(fixture.server, endpoint, {
          token: fixture.token,
          body
        }));
      }
    }

    assert.deepEqual(responses.map(responseSummary), responses.map(() => ({
      status: 400,
      code: 'INVALID_CAMPAIGN_INPUT'
    })));
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_type='legacy_tag_validation'
    `).get().count, 0);
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope IN ('knowledge.create.linked','knowledge.ingest.linked')
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('linked knowledge create ingest and use commit once while inaccessible use stays concealed', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-knowledge-success-');
  try {
    const createBody = knowledgeBody(fixture.campaignId, 'create-once');
    const ingestBody = knowledgeBody(fixture.campaignId, 'ingest-once', {
      visibility: 'team'
    });
    const created = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'task7-linked-knowledge-create',
      body: createBody
    });
    const ingested = await jsonRequest(fixture.server, '/api/knowledge/ingest', {
      token: fixture.token,
      idempotencyKey: 'task7-linked-knowledge-ingest',
      body: ingestBody
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(ingested.status, 201, ingested.text);
    assert.deepEqual(Object.keys(created.body).sort(), [
      'campaign_id', 'entry', 'id', 'link_id'
    ]);
    assert.equal(created.body.entry.visibility, 'private');
    assert.equal(ingested.body.entry.visibility, 'team');
    const exactExisting = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'task7-linked-knowledge-exact-existing',
      body: createBody
    });
    assert.deepEqual(responseSummary(exactExisting), {
      status: 409,
      code: 'RECORD_ALREADY_LINKED'
    });
    const contentConflictOptions = {
      token: fixture.token,
      idempotencyKey: 'task7-linked-knowledge-content-conflict',
      body: { ...createBody, content: 'Changed immutable source content' }
    };
    const contentConflict = await jsonRequest(
      fixture.server,
      '/api/knowledge',
      contentConflictOptions
    );
    const contentConflictReplay = await jsonRequest(
      fixture.server,
      '/api/knowledge',
      contentConflictOptions
    );
    assert.deepEqual(responseSummary(contentConflict), {
      status: 409,
      code: 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT'
    });
    assert.equal(contentConflictReplay.status, contentConflict.status);
    assert.deepEqual(contentConflictReplay.body, contentConflict.body);
    const ingestConflictOptions = {
      token: fixture.token,
      idempotencyKey: 'task7-linked-knowledge-ingest-conflict',
      body: { ...ingestBody, content: 'Changed immutable ingest content' }
    };
    const ingestConflict = await jsonRequest(
      fixture.server,
      '/api/knowledge/ingest',
      ingestConflictOptions
    );
    const ingestConflictReplay = await jsonRequest(
      fixture.server,
      '/api/knowledge/ingest',
      ingestConflictOptions
    );
    assert.deepEqual(responseSummary(ingestConflict), {
      status: 409,
      code: 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT'
    });
    assert.equal(ingestConflictReplay.status, ingestConflict.status);
    assert.deepEqual(ingestConflictReplay.body, ingestConflict.body);

    const missingUseKey = await jsonRequest(
      fixture.server,
      `/api/knowledge/${created.body.id}/use`,
      { token: fixture.token }
    );
    assert.equal(missingUseKey.status, 400, missingUseKey.text);
    assert.equal(missingUseKey.body.code, 'IDEMPOTENCY_REQUIRED');
    const used = await jsonRequest(
      fixture.server,
      `/api/knowledge/${created.body.id}/use`,
      {
        token: fixture.token,
        idempotencyKey: 'task7-linked-knowledge-use'
      }
    );
    const replay = await jsonRequest(
      fixture.server,
      `/api/knowledge/${created.body.id}/use`,
      {
        token: fixture.token,
        idempotencyKey: 'task7-linked-knowledge-use'
      }
    );
    assert.equal(used.status, 200, used.text);
    assert.deepEqual(used.body, { success: true });
    assert.deepEqual(replay, used);

    const state = fixture.db.prepare(`
      SELECT
        (SELECT usage_count FROM knowledge_entries WHERE id=@entryId) AS usage_count,
        (SELECT COUNT(*) FROM knowledge_entries
          WHERE source_type='task7_integration') AS entries,
        (SELECT COUNT(*) FROM campaign_record_links
          WHERE campaign_id=@campaignId AND record_type='knowledge_entry'
            AND relation_type='knowledge' AND revoked_at IS NULL) AS links,
        (SELECT COUNT(*) FROM campaign_events
          WHERE campaign_id=@campaignId AND source='knowledge_link') AS events,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE campaign_id=@campaignId
            AND scope IN (
              'knowledge.create.linked',
              'knowledge.ingest.linked',
              'knowledge.use.linked'
            ) AND state='completed') AS ledgers,
        (SELECT request_hash FROM request_idempotency
          WHERE campaign_id=@campaignId
            AND scope='knowledge.use.linked') AS use_request_hash
    `).get({ entryId: created.body.id, campaignId: fixture.campaignId });
    assert.deepEqual(state, {
      usage_count: 1,
      entries: 2,
      links: 2,
      events: 2,
      ledgers: 6,
      use_request_hash: requestHash({
        method: 'POST',
        path: `/api/knowledge/${created.body.id}/use`,
        campaignId: fixture.campaignId,
        kind: 'empty',
        payload: null
      })
    });

    transferCampaignAway(fixture);
    const deniedCreateReplay = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'task7-linked-knowledge-create',
      body: createBody
    });
    const deniedUseReplay = await jsonRequest(
      fixture.server,
      `/api/knowledge/${created.body.id}/use`,
      {
        token: fixture.token,
        idempotencyKey: 'task7-linked-knowledge-use'
      }
    );
    assert.deepEqual(responseSummary(deniedCreateReplay), {
      status: 403,
      code: 'CAMPAIGN_FORBIDDEN'
    });
    assert.deepEqual(deniedUseReplay, {
      status: 200,
      body: { success: true },
      text: '{"success":true}'
    });

    const replacementOwner = fixture.db.prepare(
      'SELECT owner_user_id AS userId FROM campaigns WHERE id=?'
    ).get(fixture.campaignId);
    const inaccessibleLegacy = knowledgeService.ingestKnowledge(fixture.db, {
      entry_type: 'note',
      title: 'Private legacy custody control',
      content: 'Private legacy content must not be exposed to the former campaign owner.',
      source_type: 'manual_upload',
      source_id: 'task7-private-legacy-control.md',
      visibility: 'private',
      created_by: replacementOwner.userId
    });
    const concealedRequests = await Promise.all([
      jsonRequest(fixture.server, `/api/knowledge/${created.body.id}/use`, {
        token: fixture.token,
        body: { probe: 'linked' }
      }),
      jsonRequest(fixture.server, `/api/knowledge/${inaccessibleLegacy.id}/use`, {
        token: fixture.token,
        body: { probe: 'legacy' }
      }),
      jsonRequest(fixture.server, `/api/knowledge/${inaccessibleLegacy.id + 1000000}/use`, {
        token: fixture.token,
        body: { probe: 'missing' }
      })
    ]);
    assert.deepEqual(concealedRequests, concealedRequests.map(() => ({
      status: 200,
      body: { success: true },
      text: '{"success":true}'
    })));
    assert.equal(fixture.db.prepare(
      'SELECT usage_count FROM knowledge_entries WHERE id=?'
    ).get(created.body.id).usage_count, 1);
    assert.equal(fixture.db.prepare(
      'SELECT usage_count FROM knowledge_entries WHERE id=?'
    ).get(inaccessibleLegacy.id).usage_count, 0);
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE campaign_id=? AND scope='knowledge.use.linked'
    `).get(fixture.campaignId).count, 1);
  } finally {
    await fixture.close();
  }
});

test('linked knowledge create and ingest replay retained operational errors unchanged', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-operational-replay-');
  try {
    for (const operationalStatus of ['on_hold', 'cancelled']) {
      fixture.db.prepare(`
        UPDATE campaigns
        SET operational_status=?,row_version=row_version+1
        WHERE id=?
      `).run(operationalStatus, fixture.campaignId);
      for (const [index, endpoint] of ['/api/knowledge', '/api/knowledge/ingest'].entries()) {
        const suffix = `${operationalStatus}-${index}`;
        const options = {
          token: fixture.token,
          idempotencyKey: `wave2-operational-${suffix}`,
          body: knowledgeBody(fixture.campaignId, `operational-${suffix}`)
        };
        const first = await jsonRequest(fixture.server, endpoint, options);
        const replay = await jsonRequest(fixture.server, endpoint, options);
        assert.deepEqual(responseSummary(first), {
          status: 409,
          code: operationalStatus === 'cancelled'
            ? 'CAMPAIGN_CANCELLED'
            : 'CAMPAIGN_ON_HOLD'
        });
        assert.equal(replay.status, first.status);
        assert.deepEqual(replay.body, first.body);
      }
    }
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_id LIKE 'operational-%'
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('linked knowledge create and ingest replay retained capacity errors unchanged', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-capacity-replay-');
  try {
    const existing = fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_entries WHERE created_by=?'
    ).get(fixture.userId).count;
    bulkFillUserKnowledgeEntries(
      fixture.db,
      fixture.userId,
      USER_ENTRY_LIMIT - existing
    );
    for (const [index, endpoint] of ['/api/knowledge', '/api/knowledge/ingest'].entries()) {
      const options = {
        token: fixture.token,
        idempotencyKey: `wave2-capacity-${index}`,
        body: knowledgeBody(fixture.campaignId, `capacity-${index}`)
      };
      const first = await jsonRequest(fixture.server, endpoint, options);
      const replay = await jsonRequest(fixture.server, endpoint, options);
      assert.deepEqual(responseSummary(first), {
        status: 507,
        code: 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED'
      });
      assert.equal(replay.status, first.status);
      assert.deepEqual(replay.body, first.body);
    }
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_id LIKE 'capacity-%'
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('knowledge media compatibility authenticates first and enforces JSON only for linked writes', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-media-');
  try {
    const legacyForm = new URLSearchParams({
      entry_type: 'note',
      title: 'Legacy form knowledge',
      summary: 'Legacy form summary',
      content: 'Legacy form content',
      source_type: 'legacy_form',
      source_id: 'legacy-form-create',
      visibility: 'private'
    }).toString();
    const legacyCreate = await rawRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: legacyForm
    });
    const legacyIngest = await rawRequest(fixture.server, '/api/knowledge/ingest', {
      token: fixture.token,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        entry_type: 'note',
        title: 'Legacy form ingest',
        summary: 'Legacy ingest summary',
        content: 'Legacy ingest content',
        source_type: 'legacy_form',
        source_id: 'legacy-form-ingest',
        visibility: 'private'
      }).toString()
    });
    assert.equal(legacyCreate.status, 200, legacyCreate.text);
    assert.equal(legacyIngest.status, 200, legacyIngest.text);

    const linkedForm = await rawRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'wave2-linked-form-rejected',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        campaign_id: String(fixture.campaignId),
        entry_type: 'campaign_note',
        title: 'Linked form rejected',
        summary: 'Linked form rejected',
        content: 'Linked form rejected',
        source_type: 'task7_integration',
        source_id: 'linked-form-rejected'
      }).toString()
    });
    assert.deepEqual(responseSummary(linkedForm), {
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE'
    });

    const unauthenticated = await rawRequest(fixture.server, '/api/knowledge', {
      headers: { 'Content-Type': 'text/plain' },
      body: 'campaign_id=1'
    });
    assert.equal(unauthenticated.status, 401, unauthenticated.text);
    assert.equal(unauthenticated.body.code, 'AUTHENTICATION_REQUIRED');

    const linked = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'wave2-use-body-entry',
      body: knowledgeBody(fixture.campaignId, 'use-body-entry')
    });
    assert.equal(linked.status, 201, linked.text);
    const bodyRejected = await jsonRequest(
      fixture.server,
      `/api/knowledge/${linked.body.id}/use`,
      {
        token: fixture.token,
        idempotencyKey: 'wave2-use-body-rejected',
        body: {}
      }
    );
    assert.deepEqual(responseSummary(bodyRejected), {
      status: 400,
      code: 'INVALID_CAMPAIGN_INPUT'
    });
  } finally {
    await fixture.close();
  }
});

test('linked knowledge rejects noncanonical and oversized source identifiers as stable client errors', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-source-id-validation-');
  try {
    const before = fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_entries'
    ).get().count;
    const invalidSourceIds = ['01', '0', '1.0', 'x'.repeat(4097)];
    for (const [index, sourceId] of invalidSourceIds.entries()) {
      const response = await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        idempotencyKey: `wave2-invalid-source-${index}`,
        body: {
          ...knowledgeBody(fixture.campaignId, `invalid-source-${index}`),
          source_id: sourceId
        }
      });
      assert.deepEqual(responseSummary(response), {
        status: 400,
        code: 'INVALID_CAMPAIGN_INPUT'
      }, sourceId.length > 32 ? 'oversized source_id' : sourceId);
    }
    assert.equal(fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_entries'
    ).get().count, before);
    assert.equal(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope='knowledge.create.linked'
        AND idempotency_key LIKE 'wave2-invalid-source-%'
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('legacy knowledge JSON preserves strict object or array container semantics', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-legacy-json-strict-');
  try {
    const before = fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_entries'
    ).get().count;
    for (const endpoint of ['/api/knowledge', '/api/knowledge/ingest']) {
      for (const body of ['null', '"scalar"', '42', 'true', 'false']) {
        const response = await rawRequest(fixture.server, endpoint, {
          token: fixture.token,
          headers: { 'Content-Type': 'application/json' },
          body
        });
        assert.equal(response.status, 400, `${endpoint} ${body}: ${response.text}`);
        assert.equal(response.body.code, 'INVALID_REQUEST_BODY');
      }
    }
    assert.equal(fixture.db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_entries'
    ).get().count, before);
  } finally {
    await fixture.close();
  }
});

test('linked knowledge rejects reserved deep and oversized inputs before mutation', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-bounds-');
  try {
    let nested = { leaf: true };
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    const attempts = [
      await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        idempotencyKey: 'wave2-reserved-source',
        body: knowledgeBody(fixture.campaignId, 'reserved-source', {
          source_type: 'campaign_review'
        })
      }),
      await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        idempotencyKey: 'wave2-deep-metadata',
        body: knowledgeBody(fixture.campaignId, 'deep-metadata', { metadata: nested })
      }),
      await jsonRequest(fixture.server, '/api/knowledge', {
        token: fixture.token,
        idempotencyKey: 'wave2-oversized-response',
        body: knowledgeBody(fixture.campaignId, 'oversized-response', {
          content: 'x'.repeat(400_000)
        })
      })
    ];
    assert.deepEqual(attempts.map(responseSummary), [
      { status: 400, code: 'INVALID_CAMPAIGN_INPUT' },
      { status: 400, code: 'INVALID_CAMPAIGN_INPUT' },
      { status: 413, code: 'KNOWLEDGE_ENTRY_TOO_LARGE' }
    ]);
    assert.deepEqual(fixture.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM knowledge_entries
          WHERE source_id IN ('reserved-source','deep-metadata','oversized-response')) AS entries,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE idempotency_key IN (
            'wave2-reserved-source','wave2-deep-metadata','wave2-oversized-response'
          )) AS ledgers
    `).get(), { entries: 0, ledgers: 0 });
  } finally {
    await fixture.close();
  }
});

test('knowledge create replay reauthorizes current custody after a move', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-replay-custody-');
  try {
    const body = knowledgeBody(fixture.campaignId, 'replay-current-custody');
    const created = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'wave2-replay-current-custody',
      body
    });
    assert.equal(created.status, 201, created.text);

    const replacement = fixture.db.prepare(`
      SELECT membership.user_id
      FROM organization_memberships membership
      WHERE membership.org_id=? AND membership.user_id<>?
        AND membership.status='active'
      ORDER BY CASE WHEN membership.role_code='org_admin' THEN 0 ELSE 1 END,
        membership.user_id
      LIMIT 1
    `).get(fixture.orgId, fixture.userId);
    assert.ok(replacement);
    const teamId = Number(fixture.db.prepare(`
      INSERT INTO teams (org_id,code,name) VALUES (?,?,?)
    `).run(
      fixture.orgId,
      `replay-custody-${fixture.campaignId}`,
      'Replay custody destination'
    ).lastInsertRowid);
    fixture.db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,?,?,'team_lead','active')
    `).run(fixture.orgId, teamId, replacement.user_id);
    const parent = fixture.db.prepare(`
      SELECT customer_id,opportunity_id FROM campaigns WHERE id=?
    `).get(fixture.campaignId);
    const destinationCampaignId = Number(fixture.db.prepare(`
      INSERT INTO campaigns (
        org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
        lifecycle_state,operational_status,row_version
      ) VALUES (?,?,?,?,?,?,'lead','active',1)
    `).run(
      fixture.orgId,
      'Replay custody destination',
      parent.customer_id,
      parent.opportunity_id,
      replacement.user_id,
      teamId
    ).lastInsertRowid);
    fixture.db.transaction(() => {
      fixture.db.prepare(`
        UPDATE campaign_record_links
        SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,revoke_reason='test custody move'
        WHERE record_type='knowledge_entry' AND record_id=? AND revoked_at IS NULL
      `).run(replacement.user_id, String(created.body.id));
      fixture.db.prepare(`
        INSERT INTO campaign_record_links (
          org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
          created_by,metadata_json
        ) VALUES (?,?,'knowledge_entry',?,?, 'knowledge',?,'{}')
      `).run(
        fixture.orgId,
        destinationCampaignId,
        'b'.repeat(64),
        String(created.body.id),
        replacement.user_id
      );
    }).immediate();

    const replay = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'wave2-replay-current-custody',
      body
    });
    assert.deepEqual(responseSummary(replay), {
      status: 403,
      code: 'CAMPAIGN_FORBIDDEN'
    });

    const originalLedger = fixture.db.prepare(`
      SELECT request_hash FROM request_idempotency
      WHERE idempotency_key='wave2-replay-current-custody'
    `).get();
    const changedHash = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'wave2-replay-current-custody',
      body: { ...body, title: 'Changed hash must not precede custody authorization' }
    });
    assert.deepEqual(responseSummary(changedHash), {
      status: 403,
      code: 'CAMPAIGN_FORBIDDEN'
    });

    const processingKey = 'wave2-processing-current-custody';
    const processing = fixture.db.transaction(() => (
      idempotencyService.reserveProcessingInTransaction(fixture.db, {
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        campaignId: fixture.campaignId,
        secondaryCampaignId: null,
        resourceClaim: null,
        scope: 'knowledge.create.linked',
        key: processingKey,
        requestHash: originalLedger.request_hash,
        expectedEventCount: 1,
        operationTimeoutSeconds: 60
      })
    )).immediate();
    assert.equal(processing.state, 'reserved');
    const processingDisposition = await jsonRequest(
      fixture.server,
      '/api/knowledge',
      { token: fixture.token, idempotencyKey: processingKey, body }
    );
    assert.deepEqual(responseSummary(processingDisposition), {
      status: 403,
      code: 'CAMPAIGN_FORBIDDEN'
    });

    const expiredKey = 'wave2-expired-current-custody';
    const reservationNonce = 'c'.repeat(64);
    const fingerprint = auditFingerprint({
      organizationId: fixture.orgId,
      actorUserId: fixture.userId,
      scope: 'knowledge.create.linked',
      key: expiredKey,
      requestHash: originalLedger.request_hash,
      reservationNonce
    });
    fixture.db.prepare(`
      INSERT INTO request_idempotency (
        org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
        idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
        expected_event_count,state,status_code,response_kind,response_json,
        response_headers_json,created_at,updated_at,operation_deadline,expires_at
      ) VALUES (
        @orgId,@userId,@campaignId,NULL,NULL,'knowledge.create.linked',
        @key,@reservationNonce,@requestHash,@auditFingerprint,
        1,'completed',201,'json',@responseJson,@responseHeadersJson,
        datetime(CURRENT_TIMESTAMP,'-40 days'),
        datetime(CURRENT_TIMESTAMP,'-31 days'),
        datetime(CURRENT_TIMESTAMP,'-39 days'),
        datetime(CURRENT_TIMESTAMP,'-1 day')
      )
    `).run({
      orgId: fixture.orgId,
      userId: fixture.userId,
      campaignId: fixture.campaignId,
      key: expiredKey,
      reservationNonce,
      requestHash: originalLedger.request_hash,
      auditFingerprint: fingerprint,
      responseJson: JSON.stringify(created.body),
      responseHeadersJson: '{"Content-Type":"application/json; charset=utf-8"}'
    });
    const expiredDisposition = await jsonRequest(
      fixture.server,
      '/api/knowledge',
      { token: fixture.token, idempotencyKey: expiredKey, body }
    );
    assert.deepEqual(responseSummary(expiredDisposition), {
      status: 403,
      code: 'CAMPAIGN_FORBIDDEN'
    });
  } finally {
    await fixture.close();
  }
});

test('linked knowledge use retains operational rejection and its details', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-use-hold-');
  try {
    const created = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'wave2-use-hold-entry',
      body: knowledgeBody(fixture.campaignId, 'use-hold-entry')
    });
    assert.equal(created.status, 201, created.text);
    fixture.db.prepare(`
      UPDATE campaigns SET operational_status='on_hold',row_version=row_version+1
      WHERE id=?
    `).run(fixture.campaignId);
    const requestOptions = {
      token: fixture.token,
      idempotencyKey: 'wave2-use-hold-retained'
    };
    const first = await jsonRequest(
      fixture.server,
      `/api/knowledge/${created.body.id}/use`,
      requestOptions
    );
    const replay = await jsonRequest(
      fixture.server,
      `/api/knowledge/${created.body.id}/use`,
      requestOptions
    );
    assert.equal(replay.status, first.status);
    assert.deepEqual(replay.body, first.body);
    assert.deepEqual(responseSummary(first), {
      status: 409,
      code: 'CAMPAIGN_ON_HOLD'
    });
    assert.deepEqual(first.body.details, { operational_status: 'on_hold' });
    const ledger = fixture.db.prepare(`
      SELECT state,status_code,response_json
      FROM request_idempotency
      WHERE idempotency_key='wave2-use-hold-retained'
    `).get();
    assert.equal(ledger.state, 'completed');
    assert.equal(ledger.status_code, 409);
    assert.deepEqual(JSON.parse(ledger.response_json).details, {
      operational_status: 'on_hold'
    });
    assert.equal(fixture.db.prepare(
      'SELECT usage_count FROM knowledge_entries WHERE id=?'
    ).get(created.body.id).usage_count, 0);
  } finally {
    await fixture.close();
  }
});

test('linked demand proposal and knowledge gauge failures roll back every producer artifact', {
  timeout: 30000
}, async () => {
  const fixture = await createFixture('tm-task7-wave2-producer-gauge-');
  try {
    fixture.db.exec(`
      CREATE TRIGGER task7_fail_linked_producer_gauge
      BEFORE UPDATE ON knowledge_capacity_gauges
      BEGIN SELECT RAISE(ABORT,'injected linked producer gauge failure'); END
    `);
    const demand = await jsonRequest(fixture.server, '/api/demands', {
      token: fixture.token,
      idempotencyKey: 'task7-gauge-failure-demand',
      body: demandBody({
        brand_name: 'Task 7 gauge failure demand',
        campaign_id: fixture.campaignId
      })
    });
    const proposal = await jsonRequest(fixture.server, '/api/proposals', {
      token: fixture.token,
      idempotencyKey: 'task7-gauge-failure-proposal',
      body: proposalBody(fixture.seedDemandId, {
        template_id: 'task7-gauge-failure-proposal',
        campaign_id: fixture.campaignId
      })
    });
    const knowledgeResponse = await jsonRequest(fixture.server, '/api/knowledge', {
      token: fixture.token,
      idempotencyKey: 'task7-gauge-failure-knowledge',
      body: knowledgeBody(fixture.campaignId, 'gauge-failure')
    });
    for (const response of [demand, proposal, knowledgeResponse]) {
      assert.equal(response.status, 500, response.text);
      assert.equal(response.body.code, 'AUDIT_PERSISTENCE_FAILED');
      assert.equal(JSON.stringify(response.body).includes('gauge failure'), false);
    }
    assert.deepEqual(fixture.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM demands
          WHERE brand_name='Task 7 gauge failure demand') AS demands,
        (SELECT COUNT(*) FROM proposals
          WHERE template_id='task7-gauge-failure-proposal') AS proposals,
        (SELECT COUNT(*) FROM knowledge_entries
          WHERE source_type IN (
            'campaign_demand','campaign_proposal','task7_integration'
          )) AS archives,
        (SELECT COUNT(*) FROM campaign_record_links
          WHERE campaign_id=@campaignId) AS links,
        (SELECT COUNT(*) FROM campaign_events
          WHERE campaign_id=@campaignId) AS events,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE campaign_id=@campaignId AND idempotency_key LIKE 'task7-gauge-failure-%') AS ledgers
    `).get({ campaignId: fixture.campaignId }), {
      demands: 0,
      proposals: 0,
      archives: 0,
      links: 0,
      events: 0,
      ledgers: 0
    });
  } finally {
    await fixture.close();
  }
});
