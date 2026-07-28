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

async function startTestServer(prefix) {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tempDir, 'test.db');
  const output = [];
  const child = spawn(process.execPath, [serverEntry], {
    cwd: platformRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
      JWT_SECRET: 'task7-wave1-red-secret',
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'AdminTest1!Secure'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 20; attempt += 1) {
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
