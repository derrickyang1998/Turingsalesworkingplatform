'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const { createPptArtifactStore } = require('../services/ppt_artifact_store');
const {
  CampaignPptServiceError,
  createCampaignPptService
} = require('../services/campaign_ppt_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = Object.freeze([Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixturePptx(label) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`singleflight:${label}`, 'utf8')
  ]);
}

function artifactKey(organizationId, userId, scope, key, leaseToken) {
  const baseCacheKey = sha256(`${organizationId}\n${userId}\n${scope}\n${key}`);
  return sha256(`tm-artifact-v1\n${baseCacheKey}\n${sha256(leaseToken)}`);
}

function openFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ppt-singleflight-'));
  const databasePath = path.join(root, 'singleflight.sqlite');
  const db = new Database(databasePath);
  db.pragma('busy_timeout = 5000');
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  }), { status: 'managed', currentVersion: 2 });
  const identity = db.prepare(`
    SELECT team.org_id AS organizationId,team.team_id AS teamId,team.user_id AS userId
    FROM team_memberships team
    JOIN organizations organization ON organization.id=team.org_id
    WHERE organization.code='turingmarket-default' AND team.status='active'
    ORDER BY team.user_id,team.team_id LIMIT 1
  `).get();
  const fixture = {
    ...identity,
    campaignId: 956101,
    customerId: 956102,
    opportunityId: 956103,
    demandId: 956104,
    proposalId: 956105,
    proposalBundleId: sha256('singleflight-proposal-bundle')
  };
  db.transaction(() => {
    db.prepare('INSERT INTO customers (id,brand_name,created_by,assigned_to,is_public) VALUES (@customerId,\'Single flight\',@userId,@userId,0)').run(fixture);
    db.prepare(`INSERT INTO opportunities (id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by)
      VALUES (@opportunityId,@customerId,'Single flight opportunity','proposal',1000,50,'PPT','influencer',@userId)`).run(fixture);
    db.prepare(`INSERT INTO campaigns (id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,lifecycle_state,operational_status,row_version)
      VALUES (@campaignId,@organizationId,'Single flight campaign',@customerId,@opportunityId,@userId,@teamId,'proposal_confirmed','active',1)`).run(fixture);
    db.prepare('INSERT INTO demands (id,user_id,brand_name,data_json) VALUES (@demandId,@userId,\'Single flight\',\'{}\')').run(fixture);
    db.prepare('INSERT INTO proposals (id,user_id,demand_id,template_id,content) VALUES (@proposalId,@userId,@demandId,\'ppt-template\',\'{"title":"Single flight"}\')').run(fixture);
    db.prepare(`INSERT INTO campaign_record_links (org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json)
      VALUES (@organizationId,@campaignId,'proposal',@proposalBundleId,@proposalRecordId,'proposal',@userId,'{}')`).run({
      ...fixture,
      proposalRecordId: String(fixture.proposalId)
    });
  })();
  const secondDb = new Database(databasePath);
  secondDb.pragma('busy_timeout = 5000');
  t.after(() => {
    if (secondDb.open) secondDb.close();
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, secondDb, root, fixture };
}

function request(fixture, key) {
  const outline = { title: 'Single flight' };
  return {
    userId: fixture.userId,
    campaignId: fixture.campaignId,
    proposalId: fixture.proposalId,
    requestId: `request-${key}`,
    idempotencyKey: key,
    proposalContentSha256: sha256(JSON.stringify(outline)),
    outline
  };
}

test('one confirmed proposal version permits one renderer across keys then replays only the winner', (t) => {
  const { db, secondDb, root, fixture } = openFixture(t);
  const first = request(fixture, 'ppt-singleflight-first-0001');
  const second = request(fixture, 'ppt-singleflight-second-0001');
  const artifactStore = createPptArtifactStore({ rootDir: path.join(root, 'cache') });
  let rendererCalls = 0;
  const secondService = createCampaignPptService(secondDb, {
    artifactStore,
    tempDir: path.join(root, 'work-second'),
    runPptGenerator() {
      assert.fail('the second connection must not enter the renderer while the first lease is live');
    }
  });
  const service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator({ outputPath }) {
      rendererCalls += 1;
      assert.throws(
        () => secondService.generate(second),
        (error) => error instanceof CampaignPptServiceError &&
          error.statusCode === 409 &&
          error.code === 'PPT_GENERATION_IN_PROGRESS' &&
          error.retryAfterSeconds >= 1
      );
      fs.writeFileSync(outputPath, fixturePptx('winner'));
    }
  });

  const winner = service.generate(first);
  assert.equal(winner.replayed, false);
  assert.equal(rendererCalls, 1);
  assert.throws(
    () => service.generate(second),
    (error) => error instanceof CampaignPptServiceError &&
      error.statusCode === 409 &&
      error.code === 'RECORD_ALREADY_LINKED' &&
      assert.deepEqual(error.details, {
        relation_type: 'ppt', record_type: 'proposal', record_id: String(fixture.proposalId)
      }) === undefined
  );
  const replay = service.generate(first);
  assert.equal(replay.replayed, true);
  assert.equal(rendererCalls, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM campaign_record_links
    WHERE campaign_id=? AND record_type='proposal' AND record_id=? AND relation_type='ppt'`).get(
    fixture.campaignId, String(fixture.proposalId)
  ).count, 1);
});

test('a failed renderer releases the proposal-version claim for a different idempotency key', (t) => {
  const { db, root, fixture } = openFixture(t);
  let rendererCalls = 0;
  const service = createCampaignPptService(db, {
    artifactStore: createPptArtifactStore({ rootDir: path.join(root, 'cache') }),
    tempDir: path.join(root, 'work'),
    runPptGenerator({ outputPath }) {
      rendererCalls += 1;
      if (rendererCalls === 1) throw new Error('renderer unavailable');
      fs.writeFileSync(outputPath, fixturePptx('retry'));
    }
  });
  assert.throws(
    () => service.generate(request(fixture, 'ppt-release-first-0001')),
    (error) => error instanceof CampaignPptServiceError && error.code === 'PPT_GENERATION_FAILED'
  );
  const recovered = service.generate(request(fixture, 'ppt-release-second-0001'));
  assert.equal(recovered.replayed, false);
  assert.equal(rendererCalls, 2);
  assert.deepEqual(db.prepare(`SELECT state,response_kind FROM request_idempotency
    WHERE scope='proposal.ppt.generate.linked' ORDER BY id`).all(), [
    { state: 'failed', response_kind: null },
    { state: 'completed', response_kind: 'binary' }
  ]);
});

test('a reclaimed lease publishes a distinct winner that stale-worker cleanup cannot delete', (t) => {
  const { db, secondDb, root, fixture } = openFixture(t);
  const input = request(fixture, 'ppt-stale-reclaim-key-0001');
  const artifactStore = createPptArtifactStore({ rootDir: path.join(root, 'cache') });
  let staleLeaseToken;
  let winningLeaseToken;
  let staleArtifactKey;
  let winner;

  const winnerService = createCampaignPptService(secondDb, {
    artifactStore,
    tempDir: path.join(root, 'winner-work'),
    runPptGenerator({ outputPath }) {
      winningLeaseToken = secondDb.prepare(`
        SELECT lease_token FROM request_idempotency
        WHERE scope='proposal.ppt.generate.linked' AND state='processing'
      `).get().lease_token;
      fs.writeFileSync(outputPath, fixturePptx('reclaimed-winner'));
    }
  });
  const staleService = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'stale-work'),
    runPptGenerator({ outputPath }) {
      staleLeaseToken = db.prepare(`
        SELECT lease_token FROM request_idempotency
        WHERE scope='proposal.ppt.generate.linked' AND state='processing'
      `).get().lease_token;
      staleArtifactKey = artifactKey(
        fixture.organizationId,
        fixture.userId,
        'proposal.ppt.generate.linked',
        input.idempotencyKey,
        staleLeaseToken
      );

      // Advance only the lease wall clock so the second real connection uses
      // the production processing-row reclaim path and receives a new token.
      secondDb.exec('DROP TRIGGER request_idempotency_legal_transition');
      secondDb.prepare(`
        UPDATE request_idempotency
        SET lease_until=datetime(CURRENT_TIMESTAMP,'-1 second')
        WHERE scope='proposal.ppt.generate.linked' AND state='processing'
      `).run();
      winner = winnerService.generate(input);
      fs.writeFileSync(outputPath, fixturePptx('stale-loser'));
    }
  });

  assert.throws(
    () => staleService.generate(input),
    (error) => error instanceof CampaignPptServiceError
  );
  const retained = db.prepare(`
    SELECT state,response_kind,response_cache_key,response_sha256,response_bytes
    FROM request_idempotency WHERE scope='proposal.ppt.generate.linked'
  `).get();
  const winningArtifactKey = artifactKey(
    fixture.organizationId,
    fixture.userId,
    'proposal.ppt.generate.linked',
    input.idempotencyKey,
    winningLeaseToken
  );

  assert.notEqual(staleLeaseToken, winningLeaseToken);
  assert.notEqual(staleArtifactKey, winningArtifactKey);
  assert.deepEqual(retained, {
    state: 'completed',
    response_kind: 'binary',
    response_cache_key: winningArtifactKey,
    response_sha256: sha256(fixturePptx('reclaimed-winner')),
    response_bytes: fixturePptx('reclaimed-winner').length
  });
  assert.equal(winner.filePath, path.join(
    root,
    'cache',
    winningArtifactKey.slice(0, 2),
    `${winningArtifactKey}.pptx`
  ));
  assert.deepEqual(fs.readFileSync(winner.filePath), fixturePptx('reclaimed-winner'));
  assert.equal(fs.existsSync(path.join(
    root,
    'cache',
    staleArtifactKey.slice(0, 2),
    `${staleArtifactKey}.pptx`
  )), false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM campaign_record_links
    WHERE campaign_id=? AND record_type='proposal' AND record_id=? AND relation_type='ppt'`).get(
    fixture.campaignId,
    String(fixture.proposalId)
  ).count, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='campaign_ppt'").get().count,
    1
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM request_idempotency
    WHERE scope='proposal.ppt.generate.linked' AND state='completed' AND response_kind='binary'`).get().count, 1);
  const retainedFiles = fs.readdirSync(path.join(root, 'cache')).flatMap((shard) => (
    fs.readdirSync(path.join(root, 'cache', shard)).filter((name) => name.endsWith('.pptx'))
  ));
  assert.equal(retainedFiles.length, 1);
});
