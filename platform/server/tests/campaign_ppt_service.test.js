'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const {
  PptArtifactStoreError,
  createPptArtifactStore
} = require('../services/ppt_artifact_store');
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

function openFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-campaign-ppt-'));
  const db = new Database(':memory:');
  db.pragma('busy_timeout = 5000');
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  }), { status: 'managed', currentVersion: 2 });
  const identity = db.prepare(`
    SELECT membership.org_id AS organizationId,membership.team_id AS teamId,
      membership.user_id AS userId
    FROM team_memberships membership
    JOIN organizations organization ON organization.id=membership.org_id
    WHERE organization.code='turingmarket-default' AND membership.status='active'
    ORDER BY membership.user_id,membership.team_id
    LIMIT 1
  `).get();
  assert.ok(identity);
  const fixture = {
    ...identity,
    campaignId: 954101,
    customerId: 954102,
    opportunityId: 954103,
    demandId: 954104,
    proposalId: 954105,
    proposalBundleId: sha256('campaign-ppt-proposal-bundle')
  };
  db.prepare(`
    INSERT INTO customers (id,brand_name,created_by,assigned_to,is_public)
    VALUES (@customerId,'Campaign PPT brand',@userId,@userId,0)
  `).run(fixture);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (
      @opportunityId,@customerId,'Campaign PPT opportunity','proposal',1000,50,
      'Campaign PPT product','influencer',@userId
    )
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@organizationId,'Campaign PPT campaign',@customerId,@opportunityId,
      @userId,@teamId,@lifecycleState,'active',1
    )
  `).run({ ...fixture, lifecycleState: options.lifecycleState || 'proposal_confirmed' });
  db.prepare(`
    INSERT INTO demands (id,user_id,brand_name,data_json)
    VALUES (@demandId,@userId,'Campaign PPT demand','{}')
  `).run(fixture);
  db.prepare(`
    INSERT INTO proposals (id,user_id,demand_id,template_id,content)
    VALUES (@proposalId,@userId,@demandId,'ppt-template','{"title":"Campaign PPT"}')
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (
      @organizationId,@campaignId,'proposal',@proposalBundleId,@proposalRecordId,'proposal',
      @userId,'{}'
    )
  `).run({ ...fixture, proposalRecordId: String(fixture.proposalId) });
  t.after(() => {
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    root,
    fixture,
    artifactStore: createPptArtifactStore({ rootDir: path.join(root, 'cache') })
  };
}

function requestInput(fixture, overrides = {}) {
  const outline = { title: 'Campaign PPT' };
  return {
    userId: fixture.userId,
    campaignId: fixture.campaignId,
    proposalId: fixture.proposalId,
    requestId: 'campaign-ppt-contract-0001',
    idempotencyKey: 'campaign-ppt-key-0001',
    proposalContentSha256: sha256(JSON.stringify(outline)),
    outline,
    ...overrides
  };
}

function fixturePptx(label) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`campaign-ppt:${label}`, 'utf8')
  ]);
}

function persistedProposalOutline() {
  return {
    title: 'Campaign PPT',
    sections: [{ title: 'Scope', items: ['Persisted version only'] }]
  };
}

function persistedProposalDigest(outline = persistedProposalOutline()) {
  return sha256(JSON.stringify(outline));
}

function expectedPptResourceClaim(organizationId, campaignId, proposalId, proposalContentSha256) {
  const frame = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  };
  return sha256(Buffer.concat([
    frame('tm-ppt-proposal-claim-v1'),
    frame(String(organizationId)),
    frame(String(campaignId)),
    frame(String(proposalId)),
    frame(proposalContentSha256)
  ]));
}

function expectedArtifactKey(organizationId, userId, scope, key, leaseToken) {
  const baseCacheKey = sha256(`${organizationId}\n${userId}\n${scope}\n${key}`);
  return sha256(`tm-artifact-v1\n${baseCacheKey}\n${sha256(leaseToken)}`);
}

function archiveSummary(content) {
  return Array.from(content.replace(/\s+/gu, ' ').trim()).slice(0, 1000).join('');
}

test('linked campaign PPT rejects an outline whose canonical digest differs from the confirmed proposal before rendering', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t);
  const outline = persistedProposalOutline();
  db.prepare('UPDATE proposals SET content=? WHERE id=?').run(JSON.stringify(outline), fixture.proposalId);
  let generatorCalls = 0;
  const service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator() {
      generatorCalls += 1;
    }
  });

  assert.throws(
    () => service.generate({
      ...requestInput(fixture),
      proposalContentSha256: persistedProposalDigest(outline),
      outline: { ...outline, title: 'Attacker controlled outline' }
    }),
    (error) => error instanceof CampaignPptServiceError &&
      error.statusCode === 409 &&
      error.code === 'PROPOSAL_CONTENT_CHANGED'
  );
  assert.equal(generatorCalls, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM request_idempotency WHERE scope='proposal.ppt.generate.linked'").get().count,
    0
  );
});

test('linked campaign PPT rejects a formerly confirmed outline after its persisted proposal version changes', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t);
  const confirmedOutline = persistedProposalOutline();
  const editedOutline = { ...confirmedOutline, title: 'Edited after confirmation' };
  db.prepare('UPDATE proposals SET content=? WHERE id=?').run(JSON.stringify(editedOutline), fixture.proposalId);
  let generatorCalls = 0;
  const service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator() {
      generatorCalls += 1;
    }
  });

  assert.throws(
    () => service.generate({
      ...requestInput(fixture),
      proposalContentSha256: persistedProposalDigest(confirmedOutline),
      outline: confirmedOutline
    }),
    (error) => error instanceof CampaignPptServiceError &&
      error.statusCode === 409 &&
      error.code === 'PROPOSAL_CONTENT_CHANGED'
  );
  assert.equal(generatorCalls, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM request_idempotency WHERE scope='proposal.ppt.generate.linked'").get().count,
    0
  );
});

test('linked campaign PPT generation publishes, archives, and replays a verified artifact', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t);
  let generatorCalls = 0;
  let winningLeaseToken;
  const service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator({ outputPath }) {
      generatorCalls += 1;
      winningLeaseToken = db.prepare(`
        SELECT lease_token FROM request_idempotency
        WHERE scope='proposal.ppt.generate.linked' AND state='processing'
      `).get().lease_token;
      fs.writeFileSync(outputPath, fixturePptx('success'));
    }
  });
  const input = requestInput(fixture);
  const first = service.generate(input);
  assert.equal(first.status, 200);
  assert.equal(first.replayed, false);
  assert.equal(first.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(
    first.headers['Content-Disposition'],
    `attachment; filename="proposal-${fixture.proposalId}.pptx"; ` +
      `filename*=UTF-8''proposal-${fixture.proposalId}.pptx`
  );
  assert.deepEqual(fs.readFileSync(first.filePath), fixturePptx('success'));

  const replay = service.generate(input);
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.filePath, first.filePath);
  assert.equal(generatorCalls, 1);
  assert.deepEqual(
    db.prepare(`
      SELECT relation_type,bundle_id FROM campaign_record_links
      WHERE campaign_id=? AND record_type='proposal' AND record_id=?
      ORDER BY relation_type
    `).all(fixture.campaignId, String(fixture.proposalId)),
    [
      { relation_type: 'ppt', bundle_id: fixture.proposalBundleId },
      { relation_type: 'proposal', bundle_id: fixture.proposalBundleId }
    ]
  );
  assert.deepEqual(
    db.prepare(`
      SELECT event_type,reason,source FROM campaign_events
      WHERE campaign_id=?
    `).all(fixture.campaignId),
    [{ event_type: 'link_attached', reason: 'Linked ppt', source: 'ppt_link' }]
  );
  const archive = db.prepare(`
    SELECT entry_type,source_type,source_id,title,summary,content,business_type,business_id,
      visibility,tags_json,metadata_json
    FROM knowledge_entries WHERE entry_type='campaign_ppt'
  `).get();
  const archiveContent = JSON.stringify({
    proposal_id: fixture.proposalId,
    proposal_content_sha256: sha256(JSON.stringify({ title: 'Campaign PPT' })),
    artifact_sha256: sha256(fixturePptx('success')),
    response_bytes: fixturePptx('success').length
  });
  assert.deepEqual(archive, {
    entry_type: 'campaign_ppt',
    source_type: 'campaign_ppt',
    source_id: `${fixture.proposalId}:${sha256(JSON.stringify({ title: 'Campaign PPT' }))}`,
    title: `Campaign PPT #${fixture.proposalId}`,
    summary: archiveSummary(archiveContent),
    content: archiveContent,
    business_type: 'campaign',
    business_id: String(fixture.campaignId),
    visibility: 'team',
    tags_json: '["campaign","ppt"]',
    metadata_json: JSON.stringify({
      artifact_contract: 'tm-business-artifact-v1',
      artifact_state: 'completed',
      artifact_type: 'ppt_output'
    })
  });
  const retained = db.prepare(`
    SELECT id,state,status_code,response_kind,response_cache_key,response_content_type,
      response_filename,resource_claim,
      unixepoch(operation_deadline)-unixepoch(created_at) AS operation_seconds
    FROM request_idempotency WHERE scope='proposal.ppt.generate.linked'
  `).get();
  assert.deepEqual(retained, {
    id: retained.id,
    state: 'completed',
    status_code: 200,
    response_kind: 'binary',
    response_cache_key: expectedArtifactKey(
      fixture.organizationId,
      fixture.userId,
      'proposal.ppt.generate.linked',
      input.idempotencyKey,
      winningLeaseToken
    ),
    response_content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    response_filename: `proposal-${fixture.proposalId}.pptx`,
    resource_claim: expectedPptResourceClaim(
      fixture.organizationId,
      fixture.campaignId,
      fixture.proposalId,
      sha256(JSON.stringify({ title: 'Campaign PPT' }))
    ),
    operation_seconds: 180
  });
  assert.equal(path.basename(path.dirname(first.filePath)), retained.response_cache_key.slice(0, 2));
  assert.equal(path.basename(first.filePath), `${retained.response_cache_key}.pptx`);
  assert.deepEqual(
    JSON.parse(db.prepare(`SELECT metadata_json FROM campaign_record_links
      WHERE campaign_id=? AND record_type='proposal' AND record_id=? AND relation_type='ppt'`).get(
      fixture.campaignId,
      String(fixture.proposalId)
    ).metadata_json),
    {
      proposal_content_sha256: sha256(JSON.stringify({ title: 'Campaign PPT' })),
      request_ledger_id: retained.id
    }
  );
  assert.deepEqual(
    JSON.parse(db.prepare(`SELECT metadata_json FROM campaign_record_links
      WHERE campaign_id=? AND record_type='knowledge_entry' AND record_id=?
        AND relation_type='knowledge'`).get(
      fixture.campaignId,
      String(db.prepare("SELECT id FROM knowledge_entries WHERE entry_type='campaign_ppt'").get().id)
    ).metadata_json),
    {}
  );
});

test('linked campaign PPT failure leaves no PPT link, knowledge archive, or retained artifact', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t);
  const service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator() {
      throw new Error('generator unavailable');
    }
  });
  assert.throws(
    () => service.generate(requestInput(fixture, {
      idempotencyKey: 'campaign-ppt-failure-0001'
    })),
    (error) => (
      error instanceof CampaignPptServiceError &&
      error.statusCode === 502 &&
      error.code === 'PPT_GENERATION_FAILED'
    )
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE campaign_id=? AND record_type='proposal' AND record_id=? AND relation_type='ppt'
    `).get(fixture.campaignId, String(fixture.proposalId)).count,
    0
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE entry_type='campaign_ppt'").get().count,
    0
  );
  assert.deepEqual(fs.readdirSync(path.join(root, 'cache')), []);
  assert.equal(
    db.prepare(`
      SELECT state FROM request_idempotency
      WHERE scope='proposal.ppt.generate.linked'
    `).get().state,
    'failed'
  );
});

test('linked campaign PPT requires a confirmed campaign proposal stage', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t, {
    lifecycleState: 'proposal_draft'
  });
  let generatorCalls = 0;
  const service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator() {
      generatorCalls += 1;
    }
  });
  assert.throws(
    () => service.generate(requestInput(fixture, {
      idempotencyKey: 'campaign-ppt-confirmation-0001'
    })),
    (error) => error instanceof CampaignPptServiceError &&
      error.statusCode === 409 &&
      error.code === 'PROPOSAL_CONFIRMATION_REQUIRED'
  );
  assert.equal(generatorCalls, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM request_idempotency WHERE scope='proposal.ppt.generate.linked'").get().count,
    0
  );
});

test('linked campaign PPT retries safely when rollback leaves a verified retained artifact', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t);
  let generatorCalls = 0;
  let removalAttempts = 0;
  const service = createCampaignPptService(db, {
    artifactStore: {
      publishFromFile: artifactStore.publishFromFile,
      readVerified: artifactStore.readVerified,
      readExisting: artifactStore.readExisting,
      runJanitor: artifactStore.runJanitor,
      remove() {
        removalAttempts += 1;
        throw new PptArtifactStoreError(
          'PPT_ARTIFACT_STORAGE_FAILED',
          'simulated cleanup failure'
        );
      }
    },
    tempDir: path.join(root, 'work'),
    runPptGenerator({ outputPath }) {
      generatorCalls += 1;
      fs.writeFileSync(outputPath, fixturePptx('recovery'));
    }
  });
  db.exec(`
    CREATE TRIGGER test_block_first_ppt_link
    BEFORE INSERT ON campaign_record_links
    WHEN NEW.relation_type='ppt'
    BEGIN SELECT RAISE(ABORT,'simulated finalization failure'); END;
  `);
  const input = requestInput(fixture, {
    idempotencyKey: 'campaign-ppt-recovery-0001'
  });
  assert.throws(
    () => service.generate(input),
    (error) => error instanceof CampaignPptServiceError &&
      error.code === 'AUDIT_PERSISTENCE_FAILED'
  );
  db.exec('DROP TRIGGER test_block_first_ppt_link');

  const retried = service.generate(input);
  assert.equal(retried.status, 200);
  assert.equal(retried.replayed, false);
  assert.equal(generatorCalls, 2);
  assert.equal(removalAttempts, 1);
  assert.equal(
    db.prepare(`
      SELECT state FROM request_idempotency
      WHERE scope='proposal.ppt.generate.linked'
    `).get().state,
    'completed'
  );
});

test('expired linked PPT artifact cleanup removes only the expired binary ledger artifact and never rerenders the confirmed version', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t);
  let generatorCalls = 0;
  const service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator({ outputPath }) {
      generatorCalls += 1;
      fs.writeFileSync(outputPath, fixturePptx('expiry'));
    }
  });
  const input = requestInput(fixture, { idempotencyKey: 'campaign-ppt-expiry-0001' });
  service.generate(input);
  const retained = db.prepare(`
    SELECT response_cache_key,response_sha256,response_bytes,response_content_type,response_filename
    FROM request_idempotency WHERE scope='proposal.ppt.generate.linked'
  `).get();
  assert.match(retained.response_cache_key, /^[0-9a-f]{64}$/);
  assert.equal(retained.response_sha256, sha256(fixturePptx('expiry')));
  assert.equal(retained.response_bytes, fixturePptx('expiry').length);
  assert.equal(
    retained.response_content_type,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
  assert.equal(retained.response_filename, `proposal-${fixture.proposalId}.pptx`);

  // Retention uses a 30-day wall clock. This fixture advances only the retained
  // row after dropping its transition guard, so cleanup itself stays real.
  db.exec('DROP TRIGGER request_idempotency_legal_transition');
  db.prepare(`UPDATE request_idempotency
    SET expires_at=datetime(CURRENT_TIMESTAMP,'-1 second'),updated_at=datetime(CURRENT_TIMESTAMP,'-2 seconds')
    WHERE scope='proposal.ppt.generate.linked'`).run();

  const cleanup = service.runArtifactJanitor();
  assert.equal(cleanup.expiringRemoved, 1);
  assert.equal(cleanup.expiringMissing, 0);
  assert.equal(generatorCalls, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, 'cache')), []);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM request_idempotency WHERE scope='proposal.ppt.generate.linked'").get().count,
    0
  );
  assert.throws(
    () => service.generate(input),
    (error) => error instanceof CampaignPptServiceError && error.code === 'RECORD_ALREADY_LINKED'
  );
});

test('linked campaign PPT returns stable replay corruption without regenerating billable output', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t);
  let generatorCalls = 0;
  const service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator({ outputPath }) {
      generatorCalls += 1;
      fs.writeFileSync(outputPath, fixturePptx('replay-corruption'));
    }
  });
  const input = requestInput(fixture, { idempotencyKey: 'campaign-ppt-corrupt-replay-0001' });
  const first = service.generate(input);
  fs.unlinkSync(first.filePath);

  assert.throws(
    () => service.generate(input),
    (error) => error instanceof CampaignPptServiceError &&
      error.statusCode === 500 &&
      error.code === 'REPLAY_ARTIFACT_INVALID'
  );
  assert.equal(generatorCalls, 1);
});

test('startup or hourly janitor derives and protects every live processing lease artifact regardless of age', (t) => {
  const { db, root, fixture, artifactStore } = openFixture(t);
  const input = requestInput(fixture, { idempotencyKey: 'campaign-ppt-live-janitor-0001' });
  let service;
  let liveArtifactPath;
  let janitorResult;
  service = createCampaignPptService(db, {
    artifactStore,
    tempDir: path.join(root, 'work'),
    runPptGenerator({ outputPath }) {
      fs.writeFileSync(outputPath, fixturePptx('live-janitor'));
      const leaseToken = db.prepare(`
        SELECT lease_token FROM request_idempotency
        WHERE scope='proposal.ppt.generate.linked' AND state='processing'
      `).get().lease_token;
      const cacheKey = expectedArtifactKey(
        fixture.organizationId,
        fixture.userId,
        'proposal.ppt.generate.linked',
        input.idempotencyKey,
        leaseToken
      );
      liveArtifactPath = artifactStore.publishFromFile({ cacheKey, sourcePath: outputPath });
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(path.join(
        root,
        'cache',
        cacheKey.slice(0, 2),
        `${cacheKey}.pptx`
      ), old, old);
      janitorResult = service.runArtifactJanitor();
      assert.doesNotThrow(() => artifactStore.readExisting({ cacheKey }));
    }
  });

  const generated = service.generate(input);
  assert.equal(generated.replayed, false);
  assert.equal(janitorResult.orphanArtifactsRemoved, 0);
  assert.equal(liveArtifactPath.cacheKey, path.basename(generated.filePath, '.pptx'));
  assert.deepEqual(fs.readFileSync(generated.filePath), fixturePptx('live-janitor'));
});
