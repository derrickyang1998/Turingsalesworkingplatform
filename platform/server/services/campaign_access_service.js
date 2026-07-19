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
const EVENT_INTEGER_METADATA_KEYS = new Set([
  'customer_id',
  'opportunity_id',
  'owner_user_id',
  'team_id',
  'row_version',
  'previous_version',
  'next_version',
  'previous_owner_user_id',
  'next_owner_user_id',
  'previous_team_id',
  'next_team_id',
  'source_campaign_id',
  'destination_campaign_id',
  'original_dispatch_id',
  'replacement_dispatch_id',
  'template_id',
  'template_version'
]);
const EVENT_STATUS_VALUES = new Set(['active', 'on_hold', 'cancelled']);
const EVENT_BUNDLE_PATTERN = /^[0-9a-f]{64}$/;
const WORKSPACE_RELATION_TYPES = new Set([
  'demand',
  'proposal',
  'ppt',
  'shortlist',
  'order',
  'execution',
  'publication',
  'settlement',
  'ai_run',
  'workflow',
  'knowledge',
  'review'
]);
const OWN_VALUE_MISSING = Symbol('own value missing');
const WORKSPACE_LABEL_MAX = 200;
const KNOWLEDGE_TITLE_MAX = 200;
const KNOWLEDGE_TYPE_MAX = 80;
const KNOWLEDGE_SNIPPET_MAX = 1200;
const KNOWLEDGE_SOURCE_PROJECTIONS = Object.freeze({
  upload: Object.freeze({
    kind: 'upload',
    label: 'Uploaded knowledge'
  }),
  knowledge_upload: Object.freeze({
    kind: 'upload',
    label: 'Uploaded knowledge'
  }),
  ai_chat: Object.freeze({
    kind: 'ai_chat',
    label: 'AI conversation'
  }),
  ai_conversation: Object.freeze({
    kind: 'ai_chat',
    label: 'AI conversation'
  }),
  demand: Object.freeze({
    kind: 'demand',
    label: 'Demand'
  }),
  proposal: Object.freeze({
    kind: 'proposal',
    label: 'Proposal'
  }),
  ppt: Object.freeze({
    kind: 'ppt',
    label: 'PPT proposal'
  }),
  collaboration: Object.freeze({
    kind: 'collaboration',
    label: 'Collaboration'
  }),
  workflow: Object.freeze({
    kind: 'workflow',
    label: 'Workflow'
  }),
  campaign_review: Object.freeze({
    kind: 'review',
    label: 'Campaign review'
  }),
  review: Object.freeze({
    kind: 'review',
    label: 'Campaign review'
  }),
  manual: Object.freeze({
    kind: 'manual',
    label: 'Manual knowledge'
  })
});

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

function ownDataValue(object, key) {
  if (object === null || typeof object !== 'object') return OWN_VALUE_MISSING;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return OWN_VALUE_MISSING;
    }
    return descriptor.value;
  } catch {
    return OWN_VALUE_MISSING;
  }
}

function closedMapValue(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key)
    ? map[key]
    : null;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function scalarLength(value) {
  if (typeof value !== 'string') return null;
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null;
    }
    length += 1;
  }
  return length;
}

function isBoundedScalarText(value, minimum, maximum) {
  const length = scalarLength(value);
  return length !== null && length >= minimum && length <= maximum;
}

function isSha256Digest(value) {
  return typeof value === 'string' && EVENT_BUNDLE_PATTERN.test(value);
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day >= 1 && day <= monthLengths[month - 1];
}

function invalidWorkspaceLinkSerialization() {
  throw new TypeError('invalid workspace link serialization');
}

function invalidKnowledgeReferenceSerialization() {
  throw new TypeError('invalid knowledge reference serialization');
}

function invalidEventMetadata() {
  throw new TypeError('invalid campaign event metadata');
}

function sortedUniqueArray(value, validateItem, compareItems) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1
  ) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !validateItem(value[index])
    ) {
      return false;
    }
    if (
      index > 0 &&
      compareItems(value[index - 1], value[index]) >= 0
    ) {
      return false;
    }
  }
  return true;
}

function validateFullEventMetadata(eventType, metadata, keys) {
  let descriptors;
  let ownKeys;
  try {
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      Object.getPrototypeOf(metadata) !== Object.prototype
    ) {
      return invalidEventMetadata();
    }
    ownKeys = Reflect.ownKeys(metadata);
    descriptors = Object.getOwnPropertyDescriptors(metadata);
  } catch {
    return invalidEventMetadata();
  }
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    return invalidEventMetadata();
  }

  const values = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.value === undefined
    ) {
      return invalidEventMetadata();
    }
    values[key] = descriptor.value;
    if (
      EVENT_INTEGER_METADATA_KEYS.has(key) &&
      (
        !Number.isSafeInteger(values[key]) ||
        values[key] < 1
      )
    ) {
      return invalidEventMetadata();
    }
  }

  if (
    eventType === 'operational_status_changed' &&
    (
      !EVENT_STATUS_VALUES.has(values.previous_status) ||
      !EVENT_STATUS_VALUES.has(values.next_status)
    )
  ) {
    return invalidEventMetadata();
  }

  if (!LINK_EVENTS.has(eventType)) return values;
  const bundleKeys = eventType === 'link_moved'
    ? ['source_bundle_id', 'destination_bundle_id']
    : ['bundle_id'];
  if (bundleKeys.some((key) => (
    typeof values[key] !== 'string' ||
    !EVENT_BUNDLE_PATTERN.test(values[key])
  ))) {
    return invalidEventMetadata();
  }
  const recordRelations = closedMapValue(
    RECORD_RELATIONS,
    values.record_type
  );
  if (
    !recordRelations ||
    typeof values.record_id !== 'string' ||
    canonicalRecordId(values.record_id) !== values.record_id
  ) {
    return invalidEventMetadata();
  }
  if (!sortedUniqueArray(
    values.relation_types,
    (relationType) => (
      typeof relationType === 'string' &&
      recordRelations.includes(relationType)
    ),
    (left, right) => (left < right ? -1 : left > right ? 1 : 0)
  )) {
    return invalidEventMetadata();
  }

  const idArrayKeys = eventType === 'link_attached'
    ? ['link_ids']
    : eventType === 'link_revoked'
      ? ['revoked_link_ids']
      : ['revoked_link_ids', 'replacement_link_ids'];
  if (idArrayKeys.some((key) => !sortedUniqueArray(
    values[key],
    (id) => Number.isSafeInteger(id) && id > 0,
    (left, right) => left - right
  ))) {
    return invalidEventMetadata();
  }
  if (
    eventType === 'link_moved' &&
    (
      values.source_campaign_id === values.destination_campaign_id ||
      values.source_bundle_id === values.destination_bundle_id
    )
  ) {
    return invalidEventMetadata();
  }
  return values;
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
    FROM organization_memberships membership
    JOIN users owner
      ON owner.id=membership.user_id
      AND owner.is_active=1
    WHERE membership.user_id=?
      AND membership.org_id=?
      AND membership.status='active'
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
  const relations = closedMapValue(RECORD_RELATIONS, recordType);
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
  const state = ownDataValue(authorization, 'target');
  if (state === 'restricted') {
    const relationType = ownDataValue(link, 'relation_type');
    const restrictedCount = ownDataValue(authorization, 'restrictedCount');
    if (
      !WORKSPACE_RELATION_TYPES.has(relationType) ||
      !isPositiveSafeInteger(restrictedCount)
    ) {
      return invalidWorkspaceLinkSerialization();
    }
    return {
      relation_type: relationType,
      access_state: 'restricted',
      restricted_count: restrictedCount
    };
  }
  if (state === 'missing') {
    const linkId = ownDataValue(link, 'id');
    const relationType = ownDataValue(link, 'relation_type');
    const createdAt = ownDataValue(link, 'created_at');
    const revokedAt = ownDataValue(link, 'revoked_at');
    if (
      !isPositiveSafeInteger(linkId) ||
      !WORKSPACE_RELATION_TYPES.has(relationType) ||
      !isCanonicalTimestamp(createdAt) ||
      !(revokedAt === null || isCanonicalTimestamp(revokedAt))
    ) {
      return invalidWorkspaceLinkSerialization();
    }
    return {
      link_id: linkId,
      relation_type: relationType,
      access_state: 'missing',
      created_at: createdAt,
      revoked_at: revokedAt
    };
  }
  if (state !== 'available') {
    throw new TypeError('explicit workspace target state is required');
  }
  const linkId = ownDataValue(link, 'id');
  const relationType = ownDataValue(link, 'relation_type');
  const recordType = ownDataValue(link, 'record_type');
  const recordId = ownDataValue(link, 'record_id');
  const label = ownDataValue(authorization, 'label');
  const createdAt = ownDataValue(link, 'created_at');
  const revokedAt = ownDataValue(link, 'revoked_at');
  const relations = closedMapValue(RECORD_RELATIONS, recordType);
  if (
    !isPositiveSafeInteger(linkId) ||
    !WORKSPACE_RELATION_TYPES.has(relationType) ||
    !relations ||
    !relations.includes(relationType) ||
    typeof recordId !== 'string' ||
    canonicalRecordId(recordId) !== recordId ||
    !isBoundedScalarText(label, 1, WORKSPACE_LABEL_MAX) ||
    label.trim().length === 0 ||
    !isCanonicalTimestamp(createdAt) ||
    !(revokedAt === null || isCanonicalTimestamp(revokedAt))
  ) {
    return invalidWorkspaceLinkSerialization();
  }
  return {
    link_id: linkId,
    relation_type: relationType,
    record_type: recordType,
    record_id: recordId,
    access_state: 'available',
    label,
    created_at: createdAt,
    revoked_at: revokedAt
  };
}

function serializeEventMetadata(eventType, metadata, authorization) {
  const keys = closedMapValue(EVENT_METADATA_KEYS, eventType);
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
  const validated = validateFullEventMetadata(eventType, metadata, keys);
  const serialized = {};
  for (const key of keys) {
    serialized[key] = Array.isArray(validated[key])
      ? [...validated[key]]
      : validated[key];
  }
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
  return legacyVisibility === null && isPublic === 1
    ? 'team'
    : 'private';
}

function projectKnowledgeSource(sourceType) {
  const projection = closedMapValue(KNOWLEDGE_SOURCE_PROJECTIONS, sourceType);
  return projection
    ? { ...projection }
    : { kind: 'other', label: 'Other knowledge' };
}

function citationLabel(rank) {
  if (!isPositiveSafeInteger(rank)) {
    return invalidKnowledgeReferenceSerialization();
  }
  return 'KB-' + rank;
}

function serializeKnowledgeReference(reference, authorization) {
  const state = ownDataValue(authorization, 'target');
  const rank = ownDataValue(reference, 'rank');
  const label = citationLabel(rank);
  if (state === 'restricted' || state === 'missing') {
    return {
      citation_label: label,
      access_state: state
    };
  }
  if (state !== 'available') {
    throw new TypeError('explicit reference target state is required');
  }
  const values = {
    entryId: ownDataValue(reference, 'entry_id'),
    chunkId: ownDataValue(reference, 'chunk_id'),
    chunkIndex: ownDataValue(reference, 'chunk_index'),
    title: ownDataValue(reference, 'title'),
    entryType: ownDataValue(reference, 'entry_type'),
    sourceType: ownDataValue(reference, 'source_type'),
    visibility: ownDataValue(reference, 'visibility'),
    isPublic: ownDataValue(reference, 'is_public'),
    snippet: ownDataValue(reference, 'snippet'),
    selectionOrigin: ownDataValue(reference, 'selection_origin'),
    sourceIdentitySha256: ownDataValue(reference, 'source_identity_sha256'),
    entryContentSha256: ownDataValue(reference, 'entry_content_sha256'),
    chunkContentSha256: ownDataValue(reference, 'chunk_content_sha256')
  };
  if (
    !isPositiveSafeInteger(values.entryId) ||
    !isPositiveSafeInteger(values.chunkId) ||
    !isNonnegativeSafeInteger(values.chunkIndex) ||
    !isBoundedScalarText(values.title, 0, KNOWLEDGE_TITLE_MAX) ||
    !isBoundedScalarText(values.entryType, 1, KNOWLEDGE_TYPE_MAX) ||
    !isBoundedScalarText(values.sourceType, 1, KNOWLEDGE_TYPE_MAX) ||
    !(
      values.visibility === null ||
      scalarLength(values.visibility) !== null
    ) ||
    !(values.isPublic === 0 || values.isPublic === 1) ||
    !isBoundedScalarText(values.snippet, 0, KNOWLEDGE_SNIPPET_MAX) ||
    !(
      values.selectionOrigin === 'selected' ||
      values.selectionOrigin === 'retrieved'
    ) ||
    !isSha256Digest(values.sourceIdentitySha256) ||
    !isSha256Digest(values.entryContentSha256) ||
    !isSha256Digest(values.chunkContentSha256)
  ) {
    return invalidKnowledgeReferenceSerialization();
  }
  return {
    citation_label: label,
    entry_id: values.entryId,
    chunk_id: values.chunkId,
    chunk_index: values.chunkIndex,
    title: values.title,
    entry_type: values.entryType,
    source: projectKnowledgeSource(values.sourceType),
    visibility: projectKnowledgeVisibility({
      legacyVisibility: values.visibility,
      isPublic: values.isPublic
    }),
    snippet: values.snippet,
    selected: values.selectionOrigin === 'selected',
    rank,
    source_identity_sha256: values.sourceIdentitySha256,
    entry_content_sha256: values.entryContentSha256,
    chunk_content_sha256: values.chunkContentSha256
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
