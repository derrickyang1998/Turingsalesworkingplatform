const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const {
  DEFAULT_ORGANIZATION_CODE
} = require('../services/organization_access_service');
const {
  readDemandProposalCollection
} = require('../services/campaign_access_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CAMPAIGN_MIGRATIONS = Object.freeze([Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function openCampaignDatabase(t) {
  const db = new Database(':memory:');
  t.after(() => {
    if (db.open) db.close();
  });
  assert.deepEqual(
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: CAMPAIGN_MIGRATIONS
    }),
    { status: 'managed', currentVersion: 2 }
  );
  return db;
}

function seedCampaignAccessFixture(db) {
  const organization = db.prepare(
    'SELECT id FROM organizations WHERE code=?'
  ).get(DEFAULT_ORGANIZATION_CODE);
  const memberships = db.prepare(`
    SELECT team_id AS teamId,user_id AS userId
    FROM team_memberships
    WHERE org_id=? AND status='active'
    ORDER BY user_id
  `).all(organization.id);
  const identity = {
    orgId: organization.id,
    platformAdminId: 1,
    ownerId: 2,
    teammateId: 3,
    outsiderId: 4,
    ownerTeamId: memberships.find((row) => row.userId === 2).teamId,
    outsiderTeamId: memberships.find((row) => row.userId === 4).teamId
  };

  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
    ) VALUES (1001,'Collection Brand','Collection Ltd','qualified','test',2,2,1)
  `).run();
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (
      2001,1001,'Collection Launch','proposal',12000,70,
      'Collection Product','influencer',2
    )
  `).run();

  const insertCampaign = db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @id,@orgId,@name,1001,2001,@ownerUserId,@teamId,
      'lead','active',1
    )
  `);
  insertCampaign.run({
    id: 3001,
    orgId: identity.orgId,
    name: 'Owner campaign',
    ownerUserId: identity.ownerId,
    teamId: identity.ownerTeamId
  });
  insertCampaign.run({
    id: 3002,
    orgId: identity.orgId,
    name: 'Owner destination campaign',
    ownerUserId: identity.ownerId,
    teamId: identity.ownerTeamId
  });
  insertCampaign.run({
    id: 3003,
    orgId: identity.orgId,
    name: 'Other team campaign',
    ownerUserId: identity.outsiderId,
    teamId: identity.outsiderTeamId
  });
  return identity;
}

function insertRecord(db, {
  recordType,
  id,
  userId,
  marker,
  createdAt
}) {
  if (recordType === 'demand') {
    db.prepare(`
      INSERT INTO demands (
        id,user_id,brand_name,company_name,product_name,industry,budget,
        target_market,platform,status,data_json,created_at,updated_at
      ) VALUES (
        ?,?,?,?,?,'software','10000','global','web','confirmed','{}',?,?
      )
    `).run(
      id,
      userId,
      marker,
      `${marker} company`,
      `${marker} product`,
      createdAt,
      createdAt
    );
    return;
  }
  db.prepare(`
    INSERT INTO proposals (
      id,user_id,demand_id,template_id,content,created_at
    ) VALUES (?,?,NULL,?,?,?)
  `).run(id, userId, `${marker}-template`, `${marker} content`, createdAt);
}

function insertLink(db, {
  label,
  campaignId,
  recordType,
  recordId,
  createdBy,
  createdAt
}) {
  const relationType = recordType === 'demand' ? 'demand' : 'proposal';
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json,created_at
    ) VALUES (1,?,?,?,?,?,?,'{}',?)
  `).run(
    campaignId,
    recordType,
    sha256(`collection-bundle:${label}`),
    String(recordId),
    relationType,
    createdBy,
    createdAt
  );
  return Number(result.lastInsertRowid);
}

function revokeLink(db, linkId, revokedBy, revokedAt) {
  assert.equal(db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at=?,revoked_by=?,revoke_reason='Collection correction'
    WHERE id=?
  `).run(revokedAt, revokedBy, linkId).changes, 1);
}

function ids(rows) {
  return rows.map((row) => row.id);
}

describe('campaign demand/proposal collection access', () => {
  test('omitted campaign context preserves unclassified owner and platform-admin projections', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaignAccessFixture(db);

    insertRecord(db, {
      recordType: 'demand',
      id: 4001,
      userId: identity.ownerId,
      marker: 'owner demand',
      createdAt: '2026-01-01 00:00:00'
    });
    insertRecord(db, {
      recordType: 'demand',
      id: 4002,
      userId: identity.outsiderId,
      marker: 'outsider demand',
      createdAt: '2026-01-02 00:00:00'
    });
    insertRecord(db, {
      recordType: 'proposal',
      id: 5001,
      userId: identity.ownerId,
      marker: 'owner proposal',
      createdAt: '2026-01-01 00:00:00'
    });
    insertRecord(db, {
      recordType: 'proposal',
      id: 5002,
      userId: identity.outsiderId,
      marker: 'outsider proposal',
      createdAt: '2026-01-02 00:00:00'
    });

    const ownerDemands = readDemandProposalCollection(db, {
      userId: identity.ownerId,
      recordType: 'demand'
    });
    const ownerProposals = readDemandProposalCollection(db, {
      userId: identity.ownerId,
      recordType: 'proposal'
    });
    assert.deepEqual(ids(ownerDemands), [4001]);
    assert.deepEqual(ids(ownerProposals), [5001]);
    assert.equal(Object.hasOwn(ownerDemands[0], 'display_name'), false);
    assert.equal(Object.hasOwn(ownerDemands[0], 'department'), false);
    assert.equal(Object.hasOwn(ownerProposals[0], 'display_name'), false);
    assert.deepEqual(
      readDemandProposalCollection(db, {
        userId: identity.ownerId,
        recordType: 'demand',
        search: undefined
      }),
      ownerDemands
    );

    const adminDemands = readDemandProposalCollection(db, {
      userId: identity.platformAdminId,
      recordType: 'demand'
    });
    const adminProposals = readDemandProposalCollection(db, {
      userId: identity.platformAdminId,
      recordType: 'proposal'
    });
    assert.deepEqual(ids(adminDemands), [4002, 4001]);
    assert.deepEqual(ids(adminProposals), [5002, 5001]);
    assert.equal(typeof adminDemands[0].display_name, 'string');
    assert.equal(typeof adminDemands[0].department, 'string');
    assert.equal(typeof adminProposals[0].display_name, 'string');
    assert.equal(Object.hasOwn(adminProposals[0], 'department'), false);
  });

  test('authorization removes more than 200 newer inaccessible rows before search, order, and limit', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaignAccessFixture(db);

    db.transaction(() => {
      for (const [offset, recordType] of ['demand', 'proposal'].entries()) {
        const base = 10000 + (offset * 10000);
        insertRecord(db, {
          recordType,
          id: base,
          userId: identity.ownerId,
          marker: 'needle authorized older',
          createdAt: '2025-01-01 00:00:00'
        });
        insertLink(db, {
          label: `${recordType}-authorized-older`,
          campaignId: 3001,
          recordType,
          recordId: base,
          createdBy: identity.ownerId,
          createdAt: '2025-01-01 00:01:00'
        });

        for (let index = 1; index <= 205; index += 1) {
          const recordId = base + index;
          const minute = String(index % 60).padStart(2, '0');
          const hour = String(Math.floor(index / 60)).padStart(2, '0');
          const createdAt = `2026-01-02 ${hour}:${minute}:00`;
          insertRecord(db, {
            recordType,
            id: recordId,
            userId: identity.ownerId,
            marker: `needle inaccessible ${index}`,
            createdAt
          });
          insertLink(db, {
            label: `${recordType}-inaccessible-${index}`,
            campaignId: 3003,
            recordType,
            recordId,
            createdBy: identity.ownerId,
            createdAt
          });
        }
      }
    })();

    assert.deepEqual(ids(readDemandProposalCollection(db, {
      userId: identity.ownerId,
      recordType: 'demand',
      search: 'needle'
    })), [10000]);
    assert.deepEqual(ids(readDemandProposalCollection(db, {
      userId: identity.ownerId,
      recordType: 'proposal',
      search: 'needle'
    })), [20000]);
  });

  test('active, moved, and revoke-only custody use the current campaign for owner and team reads', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaignAccessFixture(db);

    for (const [offset, recordType] of ['demand', 'proposal'].entries()) {
      const base = 30000 + (offset * 1000);
      const cases = [
        { suffix: 1, marker: 'active visible', visible: true },
        { suffix: 2, marker: 'active hidden', visible: false },
        { suffix: 3, marker: 'moved hidden', visible: false },
        { suffix: 4, marker: 'moved visible', visible: true },
        { suffix: 5, marker: 'revoked visible', visible: true },
        { suffix: 6, marker: 'revoked hidden', visible: false }
      ];
      for (const item of cases) {
        insertRecord(db, {
          recordType,
          id: base + item.suffix,
          userId: identity.ownerId,
          marker: item.marker,
          createdAt: `2026-02-0${item.suffix} 00:00:00`
        });
      }

      insertLink(db, {
        label: `${recordType}-active-visible`,
        campaignId: 3001,
        recordType,
        recordId: base + 1,
        createdBy: identity.ownerId,
        createdAt: '2026-02-01 01:00:00'
      });
      insertLink(db, {
        label: `${recordType}-active-hidden`,
        campaignId: 3003,
        recordType,
        recordId: base + 2,
        createdBy: identity.ownerId,
        createdAt: '2026-02-02 01:00:00'
      });

      const movedHiddenSource = insertLink(db, {
        label: `${recordType}-moved-hidden-source`,
        campaignId: 3001,
        recordType,
        recordId: base + 3,
        createdBy: identity.ownerId,
        createdAt: '2026-02-03 01:00:00'
      });
      revokeLink(
        db,
        movedHiddenSource,
        identity.ownerId,
        '2026-02-03 02:00:00'
      );
      insertLink(db, {
        label: `${recordType}-moved-hidden-destination`,
        campaignId: 3003,
        recordType,
        recordId: base + 3,
        createdBy: identity.ownerId,
        createdAt: '2026-02-03 03:00:00'
      });

      const movedVisibleSource = insertLink(db, {
        label: `${recordType}-moved-visible-source`,
        campaignId: 3003,
        recordType,
        recordId: base + 4,
        createdBy: identity.ownerId,
        createdAt: '2026-02-04 01:00:00'
      });
      revokeLink(
        db,
        movedVisibleSource,
        identity.ownerId,
        '2026-02-04 02:00:00'
      );
      insertLink(db, {
        label: `${recordType}-moved-visible-destination`,
        campaignId: 3002,
        recordType,
        recordId: base + 4,
        createdBy: identity.ownerId,
        createdAt: '2026-02-04 03:00:00'
      });

      const revokedVisible = insertLink(db, {
        label: `${recordType}-revoked-visible`,
        campaignId: 3001,
        recordType,
        recordId: base + 5,
        createdBy: identity.ownerId,
        createdAt: '2026-02-05 01:00:00'
      });
      revokeLink(
        db,
        revokedVisible,
        identity.ownerId,
        '2026-02-05 02:00:00'
      );

      const revokedHidden = insertLink(db, {
        label: `${recordType}-revoked-hidden`,
        campaignId: 3003,
        recordType,
        recordId: base + 6,
        createdBy: identity.ownerId,
        createdAt: '2026-02-06 01:00:00'
      });
      revokeLink(
        db,
        revokedHidden,
        identity.ownerId,
        '2026-02-06 02:00:00'
      );

      insertRecord(db, {
        recordType,
        id: base + 7,
        userId: identity.teammateId,
        marker: 'team member owned',
        createdAt: '2026-02-07 00:00:00'
      });
      insertLink(db, {
        label: `${recordType}-team-member`,
        campaignId: 3001,
        recordType,
        recordId: base + 7,
        createdBy: identity.teammateId,
        createdAt: '2026-02-07 01:00:00'
      });
    }

    assert.deepEqual(new Set(ids(readDemandProposalCollection(db, {
      userId: identity.ownerId,
      recordType: 'demand'
    }))), new Set([30001, 30004, 30005]));
    assert.deepEqual(new Set(ids(readDemandProposalCollection(db, {
      userId: identity.ownerId,
      recordType: 'proposal'
    }))), new Set([31001, 31004, 31005]));
    assert.deepEqual(ids(readDemandProposalCollection(db, {
      userId: identity.teammateId,
      recordType: 'demand'
    })), [30007]);
    assert.deepEqual(ids(readDemandProposalCollection(db, {
      userId: identity.teammateId,
      recordType: 'proposal'
    })), [31007]);
  });

  test('active org admin and platform admin obey campaign policy without widening the legacy owner rule', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaignAccessFixture(db);

    insertRecord(db, {
      recordType: 'demand',
      id: 40001,
      userId: identity.outsiderId,
      marker: 'org admin own classified',
      createdAt: '2026-03-01 00:00:00'
    });
    insertLink(db, {
      label: 'org-admin-own-classified',
      campaignId: 3001,
      recordType: 'demand',
      recordId: 40001,
      createdBy: identity.outsiderId,
      createdAt: '2026-03-01 01:00:00'
    });
    insertRecord(db, {
      recordType: 'demand',
      id: 40002,
      userId: identity.ownerId,
      marker: 'other owner classified',
      createdAt: '2026-03-02 00:00:00'
    });
    insertLink(db, {
      label: 'other-owner-classified',
      campaignId: 3001,
      recordType: 'demand',
      recordId: 40002,
      createdBy: identity.ownerId,
      createdAt: '2026-03-02 01:00:00'
    });
    insertRecord(db, {
      recordType: 'demand',
      id: 40003,
      userId: identity.outsiderId,
      marker: 'org admin own unclassified',
      createdAt: '2026-03-03 00:00:00'
    });

    assert.deepEqual(ids(readDemandProposalCollection(db, {
      userId: identity.outsiderId,
      recordType: 'demand'
    })), [40003]);

    db.prepare(`
      UPDATE organization_memberships
      SET role_code='org_admin'
      WHERE org_id=? AND user_id=?
    `).run(identity.orgId, identity.outsiderId);
    assert.deepEqual(ids(readDemandProposalCollection(db, {
      userId: identity.outsiderId,
      recordType: 'demand'
    })), [40003, 40001]);

    const platformRows = readDemandProposalCollection(db, {
      userId: identity.platformAdminId,
      recordType: 'demand'
    });
    assert.deepEqual(ids(platformRows), [40003, 40002, 40001]);
    assert.equal(platformRows.every((row) => (
      typeof row.display_name === 'string' && typeof row.department === 'string'
    )), true);

    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at='2026-03-04 00:00:00'
      WHERE org_id=? AND user_id=?
    `).run(identity.orgId, identity.outsiderId);
    assert.deepEqual(ids(readDemandProposalCollection(db, {
      userId: identity.outsiderId,
      recordType: 'demand'
    })), [40003]);
  });

  test('the collection contract rejects unsupported record types and malformed searches', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaignAccessFixture(db);

    assert.throws(
      () => readDemandProposalCollection(db, {
        userId: identity.ownerId,
        recordType: 'knowledge'
      }),
      /recordType must be demand or proposal/
    );
    assert.throws(
      () => readDemandProposalCollection(db, {
        userId: identity.ownerId,
        recordType: 'demand',
        search: 'x'.repeat(201)
      }),
      /search must be at most 200 Unicode scalar values/
    );
  });
});
