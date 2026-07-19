const {
  DEFAULT_ORGANIZATION_CODE,
  resolveOrganizationScope
} = require('./organization_access_service');

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const RECORD_RELATIONS = Object.freeze({
  demand: Object.freeze(['demand']),
  proposal: Object.freeze(['proposal', 'ppt']),
  influencer: Object.freeze(['shortlist']),
  collaboration: Object.freeze([
    'order',
    'execution',
    'publication',
    'settlement'
  ]),
  ai_conversation: Object.freeze(['ai_run']),
  workflow_instance: Object.freeze(['workflow']),
  knowledge_entry: Object.freeze(['knowledge', 'review'])
});
const TRUSTED_ONLY_RELATIONS = new Set([
  'ppt',
  'order',
  'execution',
  'publication',
  'settlement',
  'review',
  'workflow'
]);
const BOUND_COLLECTION_SCOPES = new Set([
  'workflow_children',
  'ai_conversations',
  'ai_messages',
  'knowledge',
  'knowledge_dedup',
  'knowledge_rag',
  'knowledge_references',
  'knowledge_categories',
  'collaboration_stats'
]);
const EVENT_METADATA_KEYS = Object.freeze({
  campaign_created: Object.freeze([
    'customer_id',
    'opportunity_id',
    'owner_user_id',
    'team_id',
    'row_version'
  ]),
  lifecycle_transition: Object.freeze([
    'previous_version',
    'next_version'
  ]),
  operational_status_changed: Object.freeze([
    'previous_status',
    'next_status',
    'previous_version',
    'next_version'
  ]),
  campaign_transferred: Object.freeze([
    'previous_owner_user_id',
    'next_owner_user_id',
    'previous_team_id',
    'next_team_id',
    'previous_version',
    'next_version'
  ]),
  link_attached: Object.freeze([
    'bundle_id',
    'relation_types',
    'record_type',
    'record_id',
    'link_ids'
  ]),
  link_revoked: Object.freeze([
    'bundle_id',
    'relation_types',
    'record_type',
    'record_id',
    'revoked_link_ids'
  ]),
  link_moved: Object.freeze([
    'source_bundle_id',
    'destination_bundle_id',
    'relation_types',
    'record_type',
    'record_id',
    'source_campaign_id',
    'destination_campaign_id',
    'revoked_link_ids',
    'replacement_link_ids'
  ]),
  workflow_reconciliation: Object.freeze([
    'original_dispatch_id',
    'replacement_dispatch_id',
    'template_id',
    'template_version'
  ])
});
const LINK_EVENTS = new Set(['link_attached', 'link_revoked', 'link_moved']);

function canonicalId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (
      Number.isSafeInteger(parsed) &&
      parsed > 0 &&
      parsed <= SAFE_MAX &&
      String(parsed) === value
    ) {
      return parsed;
    }
  }
  return null;
}

function canonicalRecordId(value) {
  const parsed = canonicalId(value);
  return parsed === null ? null : String(parsed);
}

function campaignNotFound() {
  return {
    ok: false,
    kind: 'not_found',
    status: 404,
    code: 'CAMPAIGN_NOT_FOUND'
  };
}

function campaignForbidden() {
  return {
    ok: false,
    kind: 'forbidden',
    status: 403,
    code: 'CAMPAIGN_FORBIDDEN'
  };
}

function permissionMatrix(operationalStatus, privileged) {
  if (operationalStatus === 'active') {
    return {
      read: true,
      write: true,
      recovery: false,
      resume: false,
      cancel: true,
      correct_links: true,
      revoke_links: true,
      correct_evidence: false
    };
  }
  if (operationalStatus === 'on_hold') {
    return {
      read: true,
      write: false,
      recovery: true,
      resume: true,
      cancel: true,
      correct_links: true,
      revoke_links: true,
      correct_evidence: false
    };
  }
  return {
    read: true,
    write: false,
    recovery: Boolean(privileged),
    resume: false,
    cancel: false,
    correct_links: Boolean(privileged),
    revoke_links: Boolean(privileged),
    correct_evidence: Boolean(privileged)
  };
}

function getCampaignAccess(db, options) {
  const userId = canonicalId(options && options.userId);
  const campaignId = canonicalId(options && options.campaignId);
  if (userId === null || campaignId === null) return campaignNotFound();
  const scope = resolveOrganizationScope(db, {
    userId,
    repairMissing: false
  });
  if (!scope.ok) return campaignNotFound();
  const campaign = db.prepare(`
    SELECT
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version,product_name,region,
      currency,budget_minor,start_date,end_date,created_at,updated_at
    FROM campaigns
    WHERE id=?
  `).get(campaignId);
  if (
    !campaign ||
    campaign.org_id !== scope.authContext.organization.id
  ) {
    return campaignNotFound();
  }

  let role = null;
  if (scope.authContext.organization.role_code === 'org_admin') {
    role = 'org_admin';
  } else if (campaign.owner_user_id === userId) {
    role = 'owner';
  } else if (scope.authContext.teams.some((team) => team.id === campaign.team_id)) {
    role = 'team_member';
  }
  if (role === null) return campaignForbidden();
  const privileged = role === 'org_admin' || role === 'owner';
  return {
    ok: true,
    kind: 'allowed',
    role,
    campaign,
    organization: scope.authContext.organization,
    permissions: permissionMatrix(campaign.operational_status, privileged)
  };
}

function emptyCustody() {
  return {
    classification: 'unclassified',
    state: 'none',
    orgId: null,
    campaignId: null,
    bundleId: null,
    linkIds: []
  };
}

function resolveRecordCustody(db, options) {
  const recordType = options && options.recordType;
  const recordId = canonicalRecordId(options && options.recordId);
  if (!Object.prototype.hasOwnProperty.call(RECORD_RELATIONS, recordType)) {
    throw new TypeError('unsupported campaign record type');
  }
  if (recordId === null) {
    throw new TypeError('recordId must be a positive canonical safe integer');
  }
  const rows = db.prepare(`
    SELECT
      id,org_id,campaign_id,bundle_id,relation_type,created_at,revoked_at
    FROM campaign_record_links
    WHERE record_type=? AND record_id=?
    ORDER BY created_at,id
  `).all(recordType, recordId);
  if (rows.length === 0) return emptyCustody();
  const classified = rows.filter((row) => row.relation_type !== 'shortlist');
  if (classified.length === 0) {
    return {
      classification: 'shortlist_only',
      state: 'shared',
      orgId: null,
      campaignId: null,
      bundleId: null,
      linkIds: []
    };
  }

  const active = classified.filter((row) => row.revoked_at === null);
  if (active.length > 0) {
    const identities = new Set(
      active.map((row) => (
        row.org_id + ':' + row.campaign_id + ':' + row.bundle_id
      ))
    );
    if (identities.size !== 1) {
      throw new Error('campaign custody is ambiguous');
    }
    const representative = active[0];
    const moved = classified.some((row) => (
      row.revoked_at !== null &&
      (
        row.org_id !== representative.org_id ||
        row.campaign_id !== representative.campaign_id
      )
    ));
    return {
      classification: 'campaign_classified',
      state: moved ? 'moved' : 'active',
      orgId: representative.org_id,
      campaignId: representative.campaign_id,
      bundleId: representative.bundle_id,
      linkIds: active.map((row) => row.id).sort((left, right) => left - right)
    };
  }

  const ordered = [...classified].sort((left, right) => {
    const timestamp = String(right.revoked_at).localeCompare(String(left.revoked_at));
    return timestamp !== 0 ? timestamp : right.id - left.id;
  });
  const representative = ordered[0];
  return {
    classification: 'campaign_classified',
    state: 'revoke_only',
    orgId: representative.org_id,
    campaignId: representative.campaign_id,
    bundleId: representative.bundle_id,
    linkIds: classified
      .filter((row) => row.bundle_id === representative.bundle_id)
      .map((row) => row.id)
      .sort((left, right) => left - right)
  };
}

function invalidLink() {
  return {
    ok: false,
    kind: 'invalid',
    status: 400,
    code: 'INVALID_CAMPAIGN_LINK'
  };
}

function targetNotFound(recordType) {
  return {
    ok: false,
    kind: 'not_found',
    status: 404,
    code: recordType === 'knowledge_entry'
      ? 'KNOWLEDGE_ENTRY_NOT_FOUND'
      : 'RECORD_NOT_FOUND'
  };
}

function targetForbidden() {
  return {
    ok: false,
    kind: 'forbidden',
    status: 403,
    code: 'RECORD_FORBIDDEN'
  };
}

function operationalBlock(status) {
  return {
    ok: false,
    kind: 'blocked',
    status: 409,
    code: status === 'cancelled'
      ? 'CAMPAIGN_CANCELLED'
      : 'CAMPAIGN_ON_HOLD',
    details: {
      operational_status: status
    }
  };
}

function targetRow(db, recordType, recordId) {
  switch (recordType) {
    case 'demand':
      return db.prepare(`
        SELECT id,user_id
        FROM demands
        WHERE id=?
      `).get(recordId);
    case 'proposal':
      return db.prepare(`
        SELECT id,user_id,demand_id
        FROM proposals
        WHERE id=?
      `).get(recordId);
    case 'influencer':
      return db.prepare(`
        SELECT id,is_active
        FROM influencers
        WHERE id=?
      `).get(recordId);
    case 'collaboration':
      return db.prepare(`
        SELECT id,user_id,status,row_version
        FROM collaborations
        WHERE id=?
      `).get(recordId);
    case 'ai_conversation':
      return db.prepare(`
        SELECT id,user_id,visibility
        FROM ai_conversations
        WHERE id=?
      `).get(recordId);
    case 'workflow_instance':
      return db.prepare(`
        SELECT id,org_id,campaign_id,started_by,status
        FROM workflow_instances
        WHERE id=?
      `).get(recordId);
    case 'knowledge_entry':
      return db.prepare(`
        SELECT id,created_by,visibility,is_public
        FROM knowledge_entries
        WHERE id=?
      `).get(recordId);
    default:
      throw new TypeError('unsupported campaign record type');
  }
}

function actorRow(db, userId) {
  return db.prepare(`
    SELECT id,role,is_active
    FROM users
    WHERE id=?
  `).get(userId);
}

function targetOwnerIsInOrganization(db, ownerUserId, orgId) {
  if (!canonicalId(ownerUserId)) return false;
  return Boolean(db.prepare(`
    SELECT 1
    FROM organization_memberships
    WHERE user_id=? AND org_id=?
  `).get(ownerUserId, orgId));
}

function targetPermissions(db, {
  actor,
  campaignAccess,
  recordType,
  target
}) {
  const platformAdmin = (
    actor &&
    actor.role === 'admin' &&
    Number(actor.is_active) === 1
  );
  const orgAdmin = (
    campaignAccess.role === 'org_admin' &&
    targetOwnerIsInOrganization(
      db,
      target.user_id || target.created_by || target.started_by,
      campaignAccess.campaign.org_id
    )
  );
  const actorOwns = (
    target.user_id === actor.id ||
    target.created_by === actor.id ||
    target.started_by === actor.id
  );
  switch (recordType) {
    case 'demand':
    case 'proposal':
      return {
        visible: platformAdmin || actorOwns,
        manageable: platformAdmin || actorOwns
      };
    case 'influencer':
      return {
        visible: Number(target.is_active) === 1,
        manageable: Number(target.is_active) === 1
      };
    case 'collaboration':
    case 'ai_conversation':
      return {
        visible: platformAdmin || orgAdmin || actorOwns,
        manageable: platformAdmin || orgAdmin || actorOwns
      };
    case 'workflow_instance': {
      const sameCampaign = (
        target.org_id === campaignAccess.campaign.org_id &&
        target.campaign_id === campaignAccess.campaign.id
      );
      return {
        visible: sameCampaign,
        manageable: sameCampaign
      };
    }
    case 'knowledge_entry': {
      const visibility = projectKnowledgeVisibility({
        legacyVisibility: target.visibility,
        isPublic: target.is_public
      });
      return {
        visible: platformAdmin || actorOwns || visibility === 'team',
        manageable: platformAdmin || actorOwns
      };
    }
    default:
      return { visible: false, manageable: false };
  }
}

function getTargetAccess(db, options) {
  const {
    userId: rawUserId,
    campaignId: rawCampaignId,
    recordType,
    recordId: rawRecordId,
    relationType,
    intent = 'read'
  } = options || {};
  const userId = canonicalId(rawUserId);
  const campaignId = canonicalId(rawCampaignId);
  const recordId = canonicalId(rawRecordId);
  const relations = RECORD_RELATIONS[recordType];
  if (
    userId === null ||
    campaignId === null ||
    recordId === null ||
    !relations ||
    !relations.includes(relationType) ||
    !['read', 'manage', 'attach'].includes(intent) ||
    (intent === 'attach' && TRUSTED_ONLY_RELATIONS.has(relationType))
  ) {
    return invalidLink();
  }
  const campaignAccess = getCampaignAccess(db, { userId, campaignId });
  if (!campaignAccess.ok) return campaignAccess;

  const target = targetRow(db, recordType, recordId);
  if (!target) return targetNotFound(recordType);
  const actor = actorRow(db, userId);
  const permissions = targetPermissions(db, {
    actor,
    campaignAccess,
    recordType,
    target
  });
  if (!permissions.visible) return targetNotFound(recordType);

  const custody = resolveRecordCustody(db, { recordType, recordId });
  if (custody.classification === 'campaign_classified') {
    const custodyAccess = getCampaignAccess(db, {
      userId,
      campaignId: custody.campaignId
    });
    if (!custodyAccess.ok) return targetNotFound(recordType);
    if (intent === 'attach') {
      return {
        ok: false,
        kind: 'conflict',
        status: 409,
        code: 'RECORD_REQUIRES_LINK_CORRECTION'
      };
    }
    if (
      custody.orgId !== campaignAccess.campaign.org_id ||
      custody.campaignId !== campaignAccess.campaign.id
    ) {
      return targetNotFound(recordType);
    }
  }
  if (
    (intent === 'manage' || intent === 'attach') &&
    !permissions.manageable
  ) {
    return targetForbidden();
  }
  if (
    (intent === 'manage' || intent === 'attach') &&
    !campaignAccess.permissions.write
  ) {
    return operationalBlock(campaignAccess.campaign.operational_status);
  }
  return {
    ok: true,
    kind: 'allowed',
    target,
    custody,
    campaignAccess
  };
}

function campaignPredicate(userAlias, campaignAlias) {
  return `EXISTS (
    SELECT 1
    FROM users ${userAlias}
    JOIN organizations access_organization
      ON access_organization.code=?
    JOIN organization_memberships access_membership
      ON access_membership.org_id=access_organization.id
     AND access_membership.user_id=${userAlias}.id
     AND access_membership.status='active'
    WHERE ${userAlias}.id=?
      AND ${userAlias}.is_active=1
      AND access_organization.id=${campaignAlias}.org_id
      AND (
        access_membership.role_code='org_admin'
        OR ${campaignAlias}.owner_user_id=${userAlias}.id
        OR EXISTS (
          SELECT 1
          FROM team_memberships access_team
          WHERE access_team.org_id=${campaignAlias}.org_id
            AND access_team.team_id=${campaignAlias}.team_id
            AND access_team.user_id=${userAlias}.id
            AND access_team.status='active'
        )
      )
  )`;
}

function boundPredicate() {
  return `EXISTS (
    SELECT 1
    FROM campaigns access_campaign
    JOIN users access_user ON access_user.id=?
    JOIN organizations access_organization
      ON access_organization.code=?
     AND access_organization.id=access_campaign.org_id
    JOIN organization_memberships access_membership
      ON access_membership.org_id=access_campaign.org_id
     AND access_membership.user_id=access_user.id
     AND access_membership.status='active'
    WHERE access_user.is_active=1
      AND access_campaign.org_id=campaign_scope.org_id
      AND access_campaign.id=campaign_scope.campaign_id
      AND (
        access_membership.role_code='org_admin'
        OR access_campaign.owner_user_id=access_user.id
        OR EXISTS (
          SELECT 1
          FROM team_memberships access_team
          WHERE access_team.org_id=access_campaign.org_id
            AND access_team.team_id=access_campaign.team_id
            AND access_team.user_id=access_user.id
            AND access_team.status='active'
        )
      )
  )`;
}

function buildCollectionAccessPredicate(scope, options) {
  const userId = canonicalId(options && options.userId);
  if (userId === null) throw new TypeError('userId must be a positive safe integer');
  if (scope === 'influencer_library') return { sql: '1=1', params: [] };
  if (scope === 'campaigns') {
    return {
      sql: campaignPredicate('access_user', 'campaign'),
      params: [DEFAULT_ORGANIZATION_CODE, userId]
    };
  }
  if (BOUND_COLLECTION_SCOPES.has(scope)) {
    return {
      sql: boundPredicate(),
      params: [userId, DEFAULT_ORGANIZATION_CODE]
    };
  }
  throw new TypeError('unsupported collection scope');
}

function serializeWorkspaceLink(link, authorization) {
  const state = authorization && authorization.target;
  if (state === 'restricted') {
    const restrictedCount = canonicalId(authorization.restrictedCount);
    if (restrictedCount === null) {
      throw new TypeError('restrictedCount must be a positive safe integer');
    }
    return {
      relation_type: link.relation_type,
      access_state: 'restricted',
      restricted_count: restrictedCount
    };
  }
  if (state === 'missing') {
    return {
      link_id: link.id,
      relation_type: link.relation_type,
      access_state: 'missing',
      created_at: link.created_at,
      revoked_at: link.revoked_at
    };
  }
  if (state !== 'available') {
    throw new TypeError('explicit workspace target state is required');
  }
  return {
    link_id: link.id,
    relation_type: link.relation_type,
    record_type: link.record_type,
    record_id: String(link.record_id),
    access_state: 'available',
    label: authorization.label,
    route: authorization.route,
    created_at: link.created_at,
    revoked_at: link.revoked_at
  };
}

function serializeEventMetadata(eventType, metadata, authorization) {
  const keys = EVENT_METADATA_KEYS[eventType];
  if (!keys) throw new TypeError('unsupported campaign event type');
  if (LINK_EVENTS.has(eventType)) {
    const allowedStates = new Set(['available', 'restricted', 'missing']);
    if (
      !authorization ||
      !allowedStates.has(authorization.target) ||
      (
        eventType === 'link_moved' &&
        (
          !allowedStates.has(authorization.sourceCampaign) ||
          !allowedStates.has(authorization.destinationCampaign)
        )
      )
    ) {
      throw new TypeError('explicit event authorization states are required');
    }
    if (authorization.target === 'missing') {
      return { access_state: 'missing' };
    }
    if (
      authorization.target !== 'available' ||
      (
        eventType === 'link_moved' &&
        (
          authorization.sourceCampaign !== 'available' ||
          authorization.destinationCampaign !== 'available'
        )
      )
    ) {
      return { access_state: 'restricted' };
    }
  }
  const serialized = {};
  for (const key of keys) serialized[key] = metadata[key];
  return serialized;
}

function projectKnowledgeVisibility({ legacyVisibility, isPublic }) {
  if (legacyVisibility === 'private') return 'private';
  if (
    legacyVisibility === 'team' ||
    legacyVisibility === 'public' ||
    legacyVisibility === 'shared'
  ) {
    return 'team';
  }
  return Number(isPublic) === 1 ? 'team' : 'private';
}

function projectKnowledgeSource(sourceType) {
  const sources = {
    upload: { kind: 'upload', label: 'Uploaded knowledge' },
    knowledge_upload: { kind: 'upload', label: 'Uploaded knowledge' },
    ai_chat: { kind: 'ai_chat', label: 'AI conversation' },
    ai_conversation: { kind: 'ai_chat', label: 'AI conversation' },
    demand: { kind: 'demand', label: 'Demand' },
    proposal: { kind: 'proposal', label: 'Proposal' },
    ppt: { kind: 'ppt', label: 'PPT proposal' },
    collaboration: { kind: 'collaboration', label: 'Collaboration' },
    workflow: { kind: 'workflow', label: 'Workflow' },
    campaign_review: { kind: 'review', label: 'Campaign review' },
    review: { kind: 'review', label: 'Campaign review' },
    manual: { kind: 'manual', label: 'Manual knowledge' }
  };
  return sources[sourceType]
    ? { ...sources[sourceType] }
    : { kind: 'other', label: 'Other knowledge' };
}

function citationLabel(reference) {
  const rank = canonicalId(reference && reference.rank);
  if (rank === null) throw new TypeError('reference rank is invalid');
  return 'KB-' + rank;
}

function serializeKnowledgeReference(reference, authorization) {
  const label = citationLabel(reference);
  const state = authorization && authorization.target;
  if (state === 'restricted' || state === 'missing') {
    return {
      citation_label: label,
      access_state: state
    };
  }
  if (state !== 'available') {
    throw new TypeError('explicit reference target state is required');
  }
  return {
    citation_label: label,
    entry_id: reference.entry_id,
    chunk_id: reference.chunk_id,
    chunk_index: reference.chunk_index,
    title: reference.title,
    entry_type: reference.entry_type,
    source: projectKnowledgeSource(reference.source_type),
    visibility: projectKnowledgeVisibility({
      legacyVisibility: reference.visibility,
      isPublic: reference.is_public
    }),
    snippet: reference.snippet,
    selected: reference.selection_origin === 'selected',
    rank: reference.rank,
    source_identity_sha256: reference.source_identity_sha256,
    entry_content_sha256: reference.entry_content_sha256,
    chunk_content_sha256: reference.chunk_content_sha256
  };
}

function resolveConversationCampaign(db, options) {
  const conversationId = canonicalId(options && options.conversationId);
  const requested = options && options.requestedCampaignId;
  const requestedCampaignId = requested === null || requested === undefined
    ? null
    : canonicalId(requested);
  if (conversationId === null || (requested !== null && requested !== undefined && requestedCampaignId === null)) {
    return {
      ok: false,
      kind: 'invalid',
      status: 400,
      code: 'INVALID_CAMPAIGN_INPUT'
    };
  }
  const conversation = db.prepare(`
    SELECT id
    FROM ai_conversations
    WHERE id=?
  `).get(conversationId);
  if (!conversation) return targetNotFound('ai_conversation');
  const campaigns = db.prepare(`
    SELECT DISTINCT campaign_id
    FROM campaign_record_links
    WHERE record_type='ai_conversation'
      AND record_id=?
      AND relation_type='ai_run'
    ORDER BY campaign_id
  `).all(String(conversationId)).map((row) => row.campaign_id);
  if (
    campaigns.length > 1 ||
    (
      campaigns.length === 1 &&
      requestedCampaignId !== null &&
      requestedCampaignId !== campaigns[0]
    )
  ) {
    return {
      ok: false,
      kind: 'conflict',
      status: 409,
      code: 'CONVERSATION_CAMPAIGN_MISMATCH'
    };
  }
  if (campaigns.length === 1) {
    return {
      ok: true,
      campaignId: campaigns[0],
      derived: true
    };
  }
  return {
    ok: true,
    campaignId: requestedCampaignId,
    derived: false
  };
}

function buildCrmDependencyQueries(targetType, targetIdValue) {
  const targetId = canonicalId(targetIdValue);
  if (targetId === null) {
    throw new TypeError('CRM dependency target id is invalid');
  }
  if (targetType === 'customer') {
    return [
      {
        type: 'campaigns',
        sql: 'SELECT COUNT(*) AS count FROM campaigns WHERE customer_id=?',
        params: [targetId]
      },
      {
        type: 'opportunities',
        sql: 'SELECT COUNT(*) AS count FROM opportunities WHERE customer_id=?',
        params: [targetId]
      }
    ];
  }
  if (targetType === 'opportunity') {
    return [{
      type: 'campaigns',
      sql: 'SELECT COUNT(*) AS count FROM campaigns WHERE opportunity_id=?',
      params: [targetId]
    }];
  }
  throw new TypeError('unsupported CRM dependency target');
}

function listCrmDependencies(db, options) {
  return buildCrmDependencyQueries(
    options && options.targetType,
    options && options.targetId
  ).map((query) => ({
    type: query.type,
    count: db.prepare(query.sql).get(...query.params).count
  })).filter((dependency) => dependency.count > 0);
}

module.exports = {
  getCampaignAccess,
  resolveRecordCustody,
  getTargetAccess,
  buildCollectionAccessPredicate,
  serializeWorkspaceLink,
  serializeEventMetadata,
  serializeKnowledgeReference,
  resolveConversationCampaign,
  projectKnowledgeVisibility,
  projectKnowledgeSource,
  buildCrmDependencyQueries,
  listCrmDependencies
};
