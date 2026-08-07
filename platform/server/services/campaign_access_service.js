const { types: utilTypes } = require('node:util');
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
const DEMAND_PROPOSAL_COLLECTIONS = Object.freeze({
  demand: Object.freeze({
    table: 'demands',
    adminProjection: ', owner.display_name, owner.department',
    searchColumns: Object.freeze([
      'brand_name',
      'company_name',
      'product_name',
      'industry',
      'budget',
      'target_market',
      'platform',
      'status'
    ])
  }),
  proposal: Object.freeze({
    table: 'proposals',
    adminProjection: ', owner.display_name',
    searchColumns: Object.freeze(['template_id', 'content'])
  })
});
const DEMAND_PROPOSAL_COLLECTION_LIMIT = 200;
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

function isProxyValue(value) {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    utilTypes.isProxy(value)
  );
}

function snapshotPlainOptions(value, recognizedKeys, allowOmitted = true) {
  if (utilTypes.isProxy(value)) return null;
  if (value === null || value === undefined) {
    return allowOmitted ? Object.freeze({}) : null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const snapshot = {};
    for (const key of recognizedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function ownDataValue(object, key) {
  if (
    object === null ||
    typeof object !== 'object' ||
    isProxyValue(object)
  ) {
    return OWN_VALUE_MISSING;
  }
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

function snapshotSortedUniqueArray(value, validateItem, compareItems) {
  let descriptors;
  let ownKeys;
  try {
    if (
      isProxyValue(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return null;
    }
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    lengthDescriptor.enumerable ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 1
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  if (
    ownKeys.length !== length + 1 ||
    ownKeys[length] !== 'length'
  ) {
    return null;
  }

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    if (ownKeys[index] !== String(index)) return null;
    const descriptor = descriptors[index];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.value === undefined ||
      !validateItem(descriptor.value)
    ) {
      return null;
    }
    if (
      index > 0 &&
      compareItems(snapshot[index - 1], descriptor.value) >= 0
    ) {
      return null;
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function validateFullEventMetadata(eventType, metadata, keys) {
  let descriptors;
  let ownKeys;
  try {
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      isProxyValue(metadata) ||
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
  const relationTypes = snapshotSortedUniqueArray(
    values.relation_types,
    (relationType) => (
      typeof relationType === 'string' &&
      recordRelations.includes(relationType)
    ),
    (left, right) => (left < right ? -1 : left > right ? 1 : 0)
  );
  if (!relationTypes) {
    return invalidEventMetadata();
  }
  values.relation_types = relationTypes;

  const idArrayKeys = eventType === 'link_attached'
    ? ['link_ids']
    : eventType === 'link_revoked'
      ? ['revoked_link_ids']
      : ['revoked_link_ids', 'replacement_link_ids'];
  for (const key of idArrayKeys) {
    const ids = snapshotSortedUniqueArray(
      values[key],
      (id) => Number.isSafeInteger(id) && id > 0,
      (left, right) => left - right
    );
    if (!ids) return invalidEventMetadata();
    values[key] = ids;
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
  const input = snapshotPlainOptions(options, ['userId', 'campaignId']);
  if (input === null) return campaignNotFound();
  const userId = canonicalId(input.userId);
  const campaignId = canonicalId(input.campaignId);
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

function resolveKnowledgeRecordCustody(db, recordId) {
  const active = db.prepare(`
    SELECT id,org_id,campaign_id,bundle_id
    FROM campaign_record_links
    WHERE record_type='knowledge_entry'
      AND relation_type<>'shortlist'
      AND record_id=?
      AND revoked_at IS NULL
    ORDER BY id
  `).all(String(recordId));
  if (active.length > 0) {
    const identities = new Set(active.map((row) => (
      `${row.org_id}:${row.campaign_id}:${row.bundle_id}`
    )));
    if (identities.size !== 1) throw new Error('campaign custody is ambiguous');
    const representative = active[0];
    const moved = Boolean(db.prepare(`
      SELECT 1 AS present
      FROM campaign_record_links
      WHERE record_type='knowledge_entry'
        AND relation_type<>'shortlist'
        AND record_id=?
        AND revoked_at IS NOT NULL
        AND (org_id<>? OR campaign_id<>?)
      LIMIT 1
    `).get(String(recordId), representative.org_id, representative.campaign_id));
    return {
      classification: 'campaign_classified',
      state: moved ? 'moved' : 'active',
      orgId: representative.org_id,
      campaignId: representative.campaign_id,
      bundleId: representative.bundle_id,
      linkIds: active.map((row) => row.id)
    };
  }

  const historical = db.prepare(`
    SELECT id,org_id,campaign_id,bundle_id
    FROM campaign_record_links
    WHERE record_type='knowledge_entry'
      AND relation_type<>'shortlist'
      AND record_id=?
      AND revoked_at IS NOT NULL
    ORDER BY revoked_at DESC,id DESC
    LIMIT 1
  `).get(String(recordId));
  if (historical) {
    return {
      classification: 'campaign_classified',
      state: 'revoke_only',
      orgId: historical.org_id,
      campaignId: historical.campaign_id,
      bundleId: historical.bundle_id,
      linkIds: db.prepare(`
        SELECT id
        FROM campaign_record_links
        WHERE record_type='knowledge_entry'
          AND relation_type<>'shortlist'
          AND record_id=?
          AND bundle_id=?
        ORDER BY id
      `).all(String(recordId), historical.bundle_id).map((row) => row.id)
    };
  }

  return emptyCustody();
}

function resolveRecordCustody(db, options) {
  const input = snapshotPlainOptions(options, ['recordType', 'recordId']);
  if (input === null) {
    throw new TypeError('unsupported campaign record type');
  }
  const recordType = input.recordType;
  const recordId = canonicalRecordId(input.recordId);
  if (
    typeof recordType !== 'string' ||
    !Object.hasOwn(RECORD_RELATIONS, recordType)
  ) {
    throw new TypeError('unsupported campaign record type');
  }
  if (recordId === null) {
    throw new TypeError('recordId must be a positive canonical safe integer');
  }
  if (recordType === 'knowledge_entry') {
    return resolveKnowledgeRecordCustody(db, recordId);
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
      AND typeof(owner.is_active)='integer'
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
    actor.is_active === 1
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
        visible: target.is_active === 1,
        manageable: target.is_active === 1
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
  const input = snapshotPlainOptions(options, [
    'userId',
    'campaignId',
    'recordType',
    'recordId',
    'relationType',
    'intent'
  ]);
  if (input === null) return invalidLink();
  const {
    userId: rawUserId,
    campaignId: rawCampaignId,
    recordType,
    recordId: rawRecordId,
    relationType,
    intent = 'read'
  } = input;
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
    !['read', 'manage', 'manage_authority', 'attach'].includes(intent) ||
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
    if (
      intent !== 'attach' &&
      (
        custody.orgId !== campaignAccess.campaign.org_id ||
        custody.campaignId !== campaignAccess.campaign.id
      )
    ) {
      return targetNotFound(recordType);
    }
  }
  if (
    (intent === 'manage' || intent === 'manage_authority' || intent === 'attach') &&
    !permissions.manageable
  ) {
    return targetForbidden();
  }
  if (
    custody.classification === 'campaign_classified' &&
    intent === 'attach'
  ) {
    return {
      ok: false,
      kind: 'conflict',
      status: 409,
      code: 'RECORD_REQUIRES_LINK_CORRECTION'
    };
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
      AND typeof(${userAlias}.is_active)='integer'
      AND ${userAlias}.is_active=1
      AND access_organization.id=${campaignAlias}.org_id
      AND EXISTS (
        SELECT 1
        FROM team_memberships access_identity_team
        WHERE access_identity_team.org_id=access_organization.id
          AND access_identity_team.user_id=${userAlias}.id
          AND access_identity_team.status='active'
      )
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
    WHERE typeof(access_user.is_active)='integer'
      AND access_user.is_active=1
      AND access_campaign.org_id=campaign_scope.org_id
      AND access_campaign.id=campaign_scope.campaign_id
      AND EXISTS (
        SELECT 1
        FROM team_memberships access_identity_team
        WHERE access_identity_team.org_id=access_campaign.org_id
          AND access_identity_team.user_id=access_user.id
          AND access_identity_team.status='active'
      )
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
  const input = snapshotPlainOptions(options, ['userId']);
  const userId = input === null ? null : canonicalId(input.userId);
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

function normalizeDemandProposalSearch(value) {
  if (value === undefined || value === null) return null;
  const length = scalarLength(value);
  if (length === null || length > 200) {
    throw new TypeError('search must be at most 200 Unicode scalar values');
  }
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function readDemandProposalCollection(db, options) {
  const input = snapshotPlainOptions(
    options,
    ['userId', 'recordType', 'search'],
    false
  );
  if (input === null) throw new TypeError('collection options are required');
  const userId = canonicalId(input.userId);
  if (userId === null) {
    throw new TypeError('userId must be a positive canonical safe integer');
  }
  const collection = closedMapValue(
    DEMAND_PROPOSAL_COLLECTIONS,
    input.recordType
  );
  if (!collection) {
    throw new TypeError('recordType must be demand or proposal');
  }
  const search = normalizeDemandProposalSearch(input.search);
  const actor = actorRow(db, userId);
  if (!actor || actor.is_active !== 1) return [];

  const platformAdmin = actor.role === 'admin';
  const legacyPredicate = platformAdmin ? '1=1' : 'record.user_id=?';
  const campaignAccessPredicate = boundPredicate();
  const searchPredicate = search === null
    ? ''
    : `WHERE (${collection.searchColumns.map((column) => (
        `instr(lower(COALESCE(record.${column},'')),lower(?))>0`
      )).join(' OR ')})`;
  const ownerJoin = platformAdmin
    ? 'JOIN users owner ON owner.id=record.user_id'
    : '';
  const projection = platformAdmin ? collection.adminProjection : '';
  const params = [input.recordType];
  if (!platformAdmin) params.push(userId);
  params.push(userId, DEFAULT_ORGANIZATION_CODE);
  if (search !== null) {
    params.push(...collection.searchColumns.map(() => search));
  }
  params.push(DEMAND_PROPOSAL_COLLECTION_LIMIT);

  return db.prepare(`
    WITH classified_links AS (
      SELECT
        id,record_id,org_id,campaign_id,bundle_id,revoked_at
      FROM campaign_record_links
      WHERE record_type=?
        AND relation_type<>'shortlist'
    ),
    classified_records AS (
      SELECT record_id
      FROM classified_links
      GROUP BY record_id
    ),
    active_identities AS (
      SELECT record_id,org_id,campaign_id,bundle_id
      FROM classified_links
      WHERE revoked_at IS NULL
      GROUP BY record_id,org_id,campaign_id,bundle_id
    ),
    active_custody AS (
      SELECT
        record_id,
        MIN(org_id) AS org_id,
        MIN(campaign_id) AS campaign_id
      FROM active_identities
      GROUP BY record_id
      HAVING COUNT(*)=1
    ),
    latest_revoked_custody AS (
      SELECT
        link.record_id,
        link.org_id,
        link.campaign_id
      FROM classified_links link
      WHERE link.revoked_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM active_identities active
          WHERE active.record_id=link.record_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM classified_links newer
          WHERE newer.record_id=link.record_id
            AND newer.revoked_at IS NOT NULL
            AND (
              newer.revoked_at>link.revoked_at
              OR (newer.revoked_at=link.revoked_at AND newer.id>link.id)
            )
        )
    ),
    campaign_scope AS (
      SELECT record_id,org_id,campaign_id
      FROM active_custody
      UNION ALL
      SELECT record_id,org_id,campaign_id
      FROM latest_revoked_custody
    ),
    authorized_record_ids AS (
      SELECT record.id
      FROM ${collection.table} record
      LEFT JOIN classified_records classification
        ON classification.record_id=CAST(record.id AS TEXT)
      LEFT JOIN campaign_scope
        ON campaign_scope.record_id=CAST(record.id AS TEXT)
      WHERE ${legacyPredicate}
        AND (
          classification.record_id IS NULL
          OR (
            campaign_scope.record_id IS NOT NULL
            AND ${campaignAccessPredicate}
          )
        )
    ),
    matched_record_ids AS (
      SELECT record.id
      FROM ${collection.table} record
      JOIN authorized_record_ids authorized ON authorized.id=record.id
      ${searchPredicate}
    )
    SELECT record.*${projection}
    FROM ${collection.table} record
    JOIN matched_record_ids matched ON matched.id=record.id
    ${ownerJoin}
    ORDER BY record.created_at DESC,record.id DESC
    LIMIT ?
  `).all(...params);
}

function serializeWorkspaceLink(link, authorization) {
  if (isProxyValue(authorization)) {
    throw new TypeError('explicit workspace target state is required');
  }
  const state = ownDataValue(authorization, 'target');
  if (isProxyValue(link)) return invalidWorkspaceLinkSerialization();
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
  if (isProxyValue(metadata)) return invalidEventMetadata();
  if (LINK_EVENTS.has(eventType)) {
    if (isProxyValue(authorization)) {
      throw new TypeError('explicit event authorization states are required');
    }
    const allowedStates = new Set(['available', 'restricted', 'missing']);
    const targetState = ownDataValue(authorization, 'target');
    const sourceCampaignState = eventType === 'link_moved'
      ? ownDataValue(authorization, 'sourceCampaign')
      : null;
    const destinationCampaignState = eventType === 'link_moved'
      ? ownDataValue(authorization, 'destinationCampaign')
      : null;
    if (
      !allowedStates.has(targetState) ||
      (
        eventType === 'link_moved' &&
        (
          !allowedStates.has(sourceCampaignState) ||
          !allowedStates.has(destinationCampaignState)
        )
      )
    ) {
      throw new TypeError('explicit event authorization states are required');
    }
    if (targetState === 'missing') {
      return { access_state: 'missing' };
    }
    if (
      targetState !== 'available' ||
      (
        eventType === 'link_moved' &&
        (
          sourceCampaignState !== 'available' ||
          destinationCampaignState !== 'available'
        )
      )
    ) {
      return { access_state: 'restricted' };
    }
  }
  const validated = validateFullEventMetadata(eventType, metadata, keys);
  const serialized = {};
  for (const key of keys) {
    serialized[key] = validated[key];
  }
  if (Buffer.byteLength(JSON.stringify(serialized), 'utf8') > 4096) {
    return invalidEventMetadata();
  }
  return serialized;
}

function projectKnowledgeVisibility(options) {
  const input = snapshotPlainOptions(
    options,
    ['legacyVisibility', 'isPublic'],
    false
  );
  if (input === null) {
    throw new TypeError('knowledge visibility options must be a plain data object');
  }
  const { legacyVisibility, isPublic } = input;
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
  if (isProxyValue(authorization)) {
    throw new TypeError('explicit reference target state is required');
  }
  const state = ownDataValue(authorization, 'target');
  if (isProxyValue(reference)) {
    return invalidKnowledgeReferenceSerialization();
  }
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
  const input = snapshotPlainOptions(
    options,
    ['conversationId', 'requestedCampaignId']
  );
  const conversationId = input === null
    ? null
    : canonicalId(input.conversationId);
  const requested = input === null ? undefined : input.requestedCampaignId;
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
  const input = snapshotPlainOptions(options, ['targetType', 'targetId']);
  return buildCrmDependencyQueries(
    input === null ? undefined : input.targetType,
    input === null ? undefined : input.targetId
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
  readDemandProposalCollection,
  serializeWorkspaceLink,
  serializeEventMetadata,
  serializeKnowledgeReference,
  resolveConversationCampaign,
  projectKnowledgeVisibility,
  projectKnowledgeSource,
  buildCrmDependencyQueries,
  listCrmDependencies
};
