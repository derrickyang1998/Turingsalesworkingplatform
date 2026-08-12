'use strict';

const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const knowledgeService = require('../services/knowledge_service');
const campaignWorkflowService = require('../services/campaign_workflow_service');
const { CUSTOMER_LIFECYCLE_REGISTRY, buildCustomerIdentity } = require('../services/crm_contract');

const MANIFEST_VERSION = 'tm-sanitization-manifest-v1';
const REPORT_VERSION = 'tm-sanitization-report-v1';
const DEFAULT_WORKER_DEADLINE_MS = 15 * 60 * 1000;
const DEFAULT_WORKER_TERMINATION_GRACE_MS = 5 * 1000;
const DEFAULT_WORKER_KILL_OBSERVATION_MS = 5 * 1000;
const DEFAULT_LIFECYCLE_FENCE_PATH = '/run/turingmarket-sanitizer-bootstrap.lock';
const DEFAULT_LIFECYCLE_FENCE_FD = 9;
const EXACT_PROFILE_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 2,
    name: '002_campaign_business_spine',
    sourcePath: 'migrations/002_campaign_business_spine.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 3,
    name: '003_campaign_workflow_dispatch_evidence',
    sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 4,
    name: '004_knowledge_capacity_observability',
    sourcePath: 'migrations/004_knowledge_capacity_observability.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 5,
    name: '005_knowledge_custody_projection',
    sourcePath: 'migrations/005_knowledge_custody_projection.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 6,
    name: '006_crm_sales_workspace',
    sourcePath: 'migrations/006_crm_sales_workspace.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);
const FTS_MANIFEST = Object.freeze({
  fts: [Object.freeze({
    virtualName: 'knowledge_chunks_fts',
    projectionName: 'knowledge_chunks_v1',
    tokenizerOptions: 'unicode61',
    keyColumnCsv: 'entry_id,chunk_id',
    indexedColumnCsv: 'title,content,tags'
  })]
});
const JSON_POLICY = Object.freeze({
  allowedLeafTypes: Object.freeze(['null', 'boolean', 'number', 'string']),
  preserveLeafTypes: true,
  booleanReplacement: 'type-preserving-source-disjoint-or-reject',
  rejectPrototypeKeys: true,
  rejectNonFiniteNumbers: true,
  maxDepth: 64,
  maxLeaves: 100000
});
const EQUALITY_GROUPS = Object.freeze([
  Object.freeze({
    name: 'knowledge-source-identity',
    owner: 'knowledge_entries.source_identity_sha256',
    members: Object.freeze([
      'knowledge_entries.source_identity_sha256',
      'ai_references.source_identity_sha256'
    ]),
    mode: 'owner-snapshot-value-partition'
  }),
  Object.freeze({
    name: 'knowledge-entry-content',
    owner: 'knowledge_entries.content_sha256',
    members: Object.freeze([
      'knowledge_entries.content_sha256',
      'ai_references.entry_content_sha256'
    ]),
    mode: 'owner-snapshot-value-partition'
  }),
  Object.freeze({
    name: 'knowledge-chunk-content',
    owner: 'knowledge_chunks.content_sha256',
    members: Object.freeze([
      'knowledge_chunks.content_sha256',
      'ai_references.chunk_content_sha256'
    ]),
    mode: 'owner-snapshot-value-partition'
  }),
  Object.freeze({
    name: 'campaign-knowledge-bundle',
    owner: 'campaign_record_links.bundle_id',
    members: Object.freeze([
      'campaign_record_links.bundle_id',
      'knowledge_current_custody.bundle_id'
    ]),
    mode: 'owner-projection-value-partition'
  })
]);
const REFERENCE_GROUPS = Object.freeze([
  Object.freeze({
    name: 'campaign-knowledge-record-id',
    owner: 'knowledge_entries.id',
    references: Object.freeze([
      'campaign_record_links.record_id',
      'ai_references.reference_id'
    ]),
    encoding: 'canonical-positive-decimal-text',
    predicate: 'knowledge-entry-reference'
  }),
  Object.freeze({
    name: 'workflow-node-id',
    owners: Object.freeze([
      'workflow_templates.nodes#/*/id',
      'campaign_workflow_dispatches.template_snapshot_json#/nodes/*/id'
    ]),
    references: Object.freeze([
      'workflow_templates.edges#/*/from',
      'workflow_templates.edges#/*/to',
      'campaign_workflow_dispatches.template_snapshot_json#/edges/*/from',
      'campaign_workflow_dispatches.template_snapshot_json#/edges/*/to',
      'workflow_instances.current_node_id',
      'workflow_node_logs.node_id',
      'workflow_tasks.node_id',
      'workflow_timers.node_id'
    ]),
    encoding: 'tm-node-sha256-v1',
    scope: 'global-source-value-partition'
  })
]);
const V1_EQUALITY_GROUPS = Object.freeze([]);
const V1_REFERENCE_GROUPS = Object.freeze([
  Object.freeze({
    name: 'workflow-node-id',
    owners: Object.freeze([
      'workflow_templates.nodes#/*/id'
    ]),
    references: Object.freeze([
      'workflow_templates.edges#/*/from',
      'workflow_templates.edges#/*/to',
      'workflow_instances.current_node_id',
      'workflow_node_logs.node_id',
      'workflow_tasks.node_id',
      'workflow_timers.node_id'
    ]),
    encoding: 'tm-node-sha256-v1',
    scope: 'global-source-value-partition'
  })
]);
const DERIVED_REBUILDS = Object.freeze([
  'knowledge_entries.source_identity_sha256',
  'knowledge_entries.source_hash',
  'knowledge_entries.content_sha256',
  'knowledge_chunks.content_sha256',
  'knowledge_chunks.token_count',
  'ai_references.v1_snapshots',
  'ai_messages.total_tokens',
  'campaign_workflow_dispatches.template_checksum',
  'knowledge_entry_footprints',
  'knowledge_current_custody',
  'knowledge_unlinked_user_usage',
  'knowledge_capacity_gauges',
  'customers.normalized_identity_key',
  'customers.duplicate_enforced',
  'knowledge_chunks_fts'
]);
const V1_DERIVED_REBUILDS = Object.freeze([
  'knowledge_entries.source_hash',
  'knowledge_chunks.token_count',
  'ai_messages.total_tokens',
  'knowledge_chunks_fts'
]);
const PRESERVED_ACCOUNTING = Object.freeze([
  'request_idempotency.response_bytes'
]);
const V1_PRESERVED_ACCOUNTING = Object.freeze([]);
const PRESERVED_ACCOUNTING_SET = new Set(PRESERVED_ACCOUNTING);

function freezeStructuralColumnPolicy(definition) {
  const policy = Object.create(null);
  const add = (context, specification) => {
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(context) || policy[context]) {
      throw new Error(`duplicate or invalid structural policy context ${context}`);
    }
    const allowedValues = specification.allowedValues === undefined
      ? undefined
      : Object.freeze([...specification.allowedValues]);
    policy[context] = Object.freeze({
      storage: specification.storage,
      kind: specification.kind,
      ...(allowedValues === undefined ? {} : { allowedValues })
    });
  };
  for (const context of definition.integer) add(context, { storage: 'integer', kind: 'integer' });
  for (const context of definition.timestamp) add(context, { storage: 'text', kind: 'timestamp' });
  for (const context of definition.date) add(context, { storage: 'text', kind: 'date' });
  for (const context of definition.canonicalPositiveDecimal) {
    add(context, { storage: 'text', kind: 'canonical-positive-decimal' });
  }
  for (const [context, allowedValues] of Object.entries(definition.enums)) {
    add(context, { storage: 'text', kind: 'enum', allowedValues });
  }
  for (const [context, allowedValues] of Object.entries(definition.migrationLedger)) {
    add(context, { storage: 'text', kind: 'migration-ledger', allowedValues });
  }
  return Object.freeze(policy);
}

const CUSTOMER_STAGES = Object.freeze([
  'lead', 'qualified', 'info_confirmed', 'advantage_shared', 'needs_confirmed', 'analysis',
  'proposal', 'kol_matching', 'cooperation', 'negotiation', 'maintenance', 'paused', 'won', 'lost'
]);
const CAMPAIGN_LIFECYCLE_STATES = Object.freeze([
  'lead', 'qualified', 'demand_confirmed', 'proposal_draft', 'proposal_confirmed',
  'influencer_shortlist', 'ordered', 'executing', 'published', 'settled', 'reviewed'
]);
const REQUEST_IDEMPOTENCY_SCOPES = Object.freeze([
  'workflow.campaign-template.create',
  'workflow.campaign-template.graph',
  'workflow.campaign-template.trigger',
  'workflow.campaign-template.publish',
  'proposal.ppt.generate.unlinked.admission',
  'parser.knowledge-upload.admission',
  'parser.influencer-upload.admission',
  'parser.demand-parse.admission',
  'campaign.create',
  'campaign.transition',
  'campaign.operational',
  'campaign.transfer',
  'campaign.link.attach',
  'campaign.link.correct',
  'campaign.review.create',
  'campaign.workflow.reconcile',
  'demand.create.linked',
  'proposal.create.linked',
  'proposal.ppt.generate.linked',
  'collaboration.create.linked',
  'collaboration.update.linked',
  'knowledge.create.linked',
  'knowledge.ingest.linked',
  'knowledge.upload.linked',
  'ai.conversation.create.linked'
]);

const STRUCTURAL_COLUMN_POLICY = freezeStructuralColumnPolicy({
  integer: Object.freeze([
    'activity_log.id', 'activity_log.user_id', 'activity_log_ext.id', 'activity_log_ext.customer_id',
    'activity_log_ext.user_id', 'ai_conversations.id', 'ai_conversations.user_id', 'ai_conversations.archived_summary_id',
    'ai_messages.id', 'ai_messages.conversation_id', 'ai_messages.user_id', 'ai_references.id',
    'ai_references.message_id', 'ai_references.reference_schema_version', 'ai_references.knowledge_entry_id', 'ai_references.knowledge_chunk_id',
    'ai_references.campaign_id', 'ai_references.reference_rank', 'brands.id', 'campaign_events.id',
    'campaign_events.org_id', 'campaign_events.campaign_id', 'campaign_events.actor_user_id', 'campaign_record_links.id',
    'campaign_record_links.org_id', 'campaign_record_links.campaign_id', 'campaign_record_links.created_by', 'campaign_record_links.revoked_by',
    'campaign_workflow_dispatches.id', 'campaign_workflow_dispatches.org_id', 'campaign_workflow_dispatches.campaign_id', 'campaign_workflow_dispatches.event_id',
    'campaign_workflow_dispatches.trigger_event_id', 'campaign_workflow_dispatches.template_id', 'campaign_workflow_dispatches.template_version', 'campaign_workflow_dispatches.workflow_instance_id',
    'campaign_workflow_dispatches.reconciles_dispatch_id', 'campaigns.id', 'campaigns.org_id', 'campaigns.customer_id',
    'campaigns.opportunity_id', 'campaigns.owner_user_id', 'campaigns.team_id', 'campaigns.row_version',
    'collaborations.id', 'collaborations.demand_id', 'collaborations.influencer_id', 'collaborations.user_id',
    'collaborations.row_version', 'collaborations.cost_actual_confirmed', 'crm_audit_events.id', 'crm_audit_events.org_id',
    'crm_audit_events.customer_id', 'crm_audit_events.opportunity_id', 'crm_audit_events.task_id', 'crm_audit_events.contact_id',
    'crm_audit_events.actor_user_id', 'crm_tasks.id', 'crm_tasks.org_id', 'crm_tasks.team_id',
    'crm_tasks.customer_id', 'crm_tasks.opportunity_id', 'crm_tasks.owner_user_id', 'crm_tasks.completed_by', 'crm_tasks.created_by',
    'customer_activity.id', 'customer_activity.customer_id', 'customer_activity.user_id', 'customer_contacts.id',
    'customer_contacts.org_id', 'customer_contacts.customer_id', 'customer_contacts.is_preferred', 'customer_contacts.created_by',
    'customers.id', 'customers.created_by', 'customers.assigned_to', 'customers.org_id', 'customers.team_id',
    'customers.is_public', 'demands.id', 'demands.user_id', 'influencers.id',
    'influencers.is_active', 'influencers.is_duplicate', 'knowledge_capacity_gauges.scope_id', 'knowledge_chunks.id',
    'knowledge_chunks.entry_id', 'knowledge_chunks.chunk_index', 'knowledge_current_custody.knowledge_entry_id', 'knowledge_current_custody.link_id',
    'knowledge_current_custody.org_id', 'knowledge_current_custody.campaign_id', 'knowledge_entries.id', 'knowledge_entries.created_by',
    'knowledge_entries.is_public', 'knowledge_entry_footprints.knowledge_entry_id', 'knowledge_entry_footprints.created_by', 'knowledge_unlinked_user_usage.user_id',
    'leads.id', 'leads.assigned_to', 'leads.converted_customer_id', 'opportunities.id',
    'opportunities.customer_id', 'opportunities.created_by', 'opportunities.org_id', 'opportunities.team_id',
    'opportunities.owner_user_id', 'opportunities.campaign_id', 'organization_memberships.org_id', 'organization_memberships.user_id',
    'organizations.id', 'proposals.id', 'proposals.user_id', 'proposals.demand_id',
    'request_idempotency.id', 'request_idempotency.org_id', 'request_idempotency.user_id', 'request_idempotency.campaign_id',
    'request_idempotency.secondary_campaign_id', 'request_idempotency.expected_event_count', 'request_idempotency.status_code', 'sales_targets.id',
    'sales_targets.user_id', 'schema_migrations.version', 'schema_migrations.engine_version', 'sessions.id',
    'sessions.user_id', 'team_invites.id', 'team_invites.created_by', 'team_invites.is_active',
    'team_memberships.org_id', 'team_memberships.team_id', 'team_memberships.user_id', 'teams.id',
    'teams.org_id', 'token_usage.id', 'token_usage.user_id', 'users.id',
    'users.is_active', 'web_search_cache.id', 'workflow_instances.id', 'workflow_instances.template_id',
    'workflow_instances.started_by', 'workflow_instances.org_id', 'workflow_instances.campaign_id', 'workflow_instances.campaign_event_id',
    'workflow_instances.campaign_dispatch_id', 'workflow_node_logs.id', 'workflow_node_logs.instance_id', 'workflow_node_logs.user_id',
    'workflow_tasks.id', 'workflow_tasks.instance_id', 'workflow_tasks.assignee_id', 'workflow_tasks.completed_by',
    'workflow_tasks.assignment_version', 'workflow_templates.id', 'workflow_templates.version', 'workflow_templates.is_active',
    'workflow_templates.created_by', 'workflow_timers.id', 'workflow_timers.instance_id', 'workflow_timers.fired'
  ]),
  timestamp: Object.freeze([
    'activity_log.created_at', 'activity_log_ext.created_at', 'ai_conversations.created_at', 'ai_conversations.updated_at',
    'ai_messages.created_at', 'ai_references.created_at', 'brands.created_at', 'campaign_events.created_at',
    'campaign_record_links.created_at', 'campaign_record_links.revoked_at', 'campaign_workflow_dispatches.lease_until', 'campaign_workflow_dispatches.next_attempt_at',
    'campaign_workflow_dispatches.created_at', 'campaign_workflow_dispatches.updated_at', 'campaigns.created_at', 'campaigns.updated_at',
    'collaborations.created_at', 'collaborations.updated_at', 'crm_audit_events.occurred_at', 'crm_tasks.due_at',
    'crm_tasks.completed_at', 'crm_tasks.created_at', 'crm_tasks.updated_at', 'customer_activity.created_at',
    'customer_contacts.created_at', 'customer_contacts.updated_at', 'customer_contacts.archived_at', 'customers.created_at',
    'customers.updated_at', 'customers.assigned_at', 'customers.last_followup', 'customers.claim_deadline',
    'customers.next_action_at', 'customers.stalled_at',
    'demands.created_at', 'demands.updated_at', 'influencers.created_at', 'influencers.updated_at',
    'knowledge_capacity_gauges.updated_at', 'knowledge_chunks.created_at', 'knowledge_current_custody.updated_at', 'knowledge_entries.created_at',
    'knowledge_entries.updated_at', 'knowledge_entry_footprints.updated_at', 'knowledge_unlinked_user_usage.updated_at', 'leads.created_at',
    'leads.updated_at', 'opportunities.expected_close_date', 'opportunities.created_at', 'opportunities.updated_at',
    'opportunities.next_action_at', 'opportunities.closed_at',
    'organization_memberships.created_at', 'organization_memberships.revoked_at', 'organizations.created_at', 'proposals.created_at',
    'request_idempotency.lease_until', 'request_idempotency.created_at', 'request_idempotency.updated_at', 'request_idempotency.operation_deadline',
    'request_idempotency.expires_at', 'sales_targets.created_at', 'schema_migrations.applied_at', 'sessions.created_at',
    'sessions.expires_at', 'team_invites.expires_at', 'team_invites.created_at', 'team_memberships.created_at',
    'team_memberships.revoked_at', 'teams.created_at', 'token_usage.created_at', 'users.created_at',
    'users.last_login', 'web_search_cache.created_at', 'workflow_instances.completed_at', 'workflow_instances.created_at',
    'workflow_instances.execution_failed_at', 'workflow_node_logs.created_at', 'workflow_tasks.due_at', 'workflow_tasks.completed_at',
    'workflow_tasks.created_at', 'workflow_templates.created_at', 'workflow_templates.updated_at', 'workflow_timers.fire_at',
    'workflow_timers.created_at'
  ]),
  date: Object.freeze([
    'campaigns.start_date', 'campaigns.end_date', 'collaborations.timeline_start',
    'collaborations.timeline_end', 'customers.expected_close_date',
    'sales_targets.period_start', 'sales_targets.period_end'
  ]),
  canonicalPositiveDecimal: Object.freeze([
    'campaign_record_links.record_id'
  ]),
  enums: Object.freeze({
    'ai_conversations.visibility': Object.freeze(['private', 'team', 'public', 'shared']),
    'ai_messages.role': Object.freeze(['system', 'user', 'assistant', 'tool']),
    'ai_references.reference_type': Object.freeze(['knowledge', 'web']),
    'ai_references.selection_origin': Object.freeze(['selected', 'retrieved']),
    'campaign_events.event_type': Object.freeze([
      'campaign_created', 'lifecycle_transition', 'operational_status_changed',
      'campaign_transferred', 'link_attached', 'link_revoked', 'link_moved',
      'workflow_reconciliation'
    ]),
    'campaign_events.previous_state': CAMPAIGN_LIFECYCLE_STATES,
    'campaign_events.next_state': CAMPAIGN_LIFECYCLE_STATES,
    'campaign_record_links.record_type': Object.freeze([
      'demand', 'proposal', 'influencer', 'collaboration', 'ai_conversation',
      'workflow_instance', 'knowledge_entry'
    ]),
    'campaign_record_links.relation_type': Object.freeze([
      'demand', 'proposal', 'ppt', 'shortlist', 'order', 'execution',
      'publication', 'settlement', 'ai_run', 'workflow', 'knowledge', 'review'
    ]),
    'campaign_workflow_dispatches.status': Object.freeze([
      'pending', 'processing', 'completed', 'failed_validation',
      'failed_initialization', 'dead_letter', 'cancelled'
    ]),
    'campaigns.lifecycle_state': CAMPAIGN_LIFECYCLE_STATES,
    'campaigns.operational_status': Object.freeze(['active', 'on_hold', 'cancelled']),
    'collaborations.status': Object.freeze([
      'proposed', 'contacted', 'negotiating', 'confirmed', 'contract_sent',
      'live', 'content_review', 'completed', 'cancelled'
    ]),
    'crm_audit_events.event_type': Object.freeze([
      'crm_backfill_quarantined', 'crm_legacy_stage_unclassified', 'crm_legacy_duplicate_collision',
      'duplicate_detected', 'customer_created', 'customer_updated', 'customer_stage_changed',
      'opportunity_created', 'opportunity_updated', 'opportunity_stage_changed',
      'contact_created', 'contact_updated', 'contact_archived',
      'task_created', 'task_completed', 'task_cancelled',
      'customer_result_archived', 'customer_activity_recorded', 'mutation_denied',
      'customer_released_to_pool', 'customer_claimed', 'customer_transferred',
      'customer_custody_repaired'
    ]),
    'crm_tasks.status': Object.freeze(['open', 'completed', 'cancelled']),
    'crm_tasks.source': Object.freeze(['manual', 'stage_transition', 'reminder']),
    'customer_activity.stage_from': CUSTOMER_STAGES,
    'customer_activity.stage_to': CUSTOMER_STAGES,
    'customers.stage': CUSTOMER_STAGES,
    'demands.status': Object.freeze(['draft', 'confirmed', 'completed', 'archived']),
    'knowledge_capacity_gauges.scope_type': Object.freeze(['user', 'campaign', 'organization']),
    'knowledge_capacity_gauges.metric': Object.freeze(['entries', 'chunks', 'payload_bytes', 'references']),
    'knowledge_current_custody.custody_state': Object.freeze(['active', 'revoke_only']),
    'knowledge_entries.visibility': Object.freeze(['private', 'team', 'public', 'shared']),
    'leads.status': Object.freeze(['new', 'contacted', 'qualified', 'converted', 'lost']),
    'opportunities.stage': Object.freeze(['discovery', 'qualification', 'proposal', 'negotiation', 'won', 'lost']),
    'organization_memberships.role_code': Object.freeze(['org_admin', 'member']),
    'organization_memberships.status': Object.freeze(['active', 'revoked']),
    'request_idempotency.scope': REQUEST_IDEMPOTENCY_SCOPES,
    'request_idempotency.state': Object.freeze(['processing', 'completed', 'failed', 'expiring']),
    'request_idempotency.response_kind': Object.freeze(['json', 'binary', 'admission']),
    'request_idempotency.response_content_type': Object.freeze([
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ]),
    'team_invites.role': Object.freeze(['admin', 'user']),
    'team_memberships.role_code': Object.freeze(['team_lead', 'member']),
    'team_memberships.status': Object.freeze(['active', 'revoked']),
    'users.role': Object.freeze(['admin', 'user']),
    'workflow_instances.status': Object.freeze(['active', 'paused', 'completed', 'cancelled']),
    'workflow_instances.initialization_status': Object.freeze(['pending', 'ready', 'failed']),
    'workflow_tasks.node_type': Object.freeze([
      'start', 'end', 'approval', 'task', 'condition', 'parallel', 'timer',
      'webhook', 'auto_action', 'sub_process'
    ]),
    'workflow_tasks.status': Object.freeze(['pending', 'completed', 'rejected', 'cancelled']),
    'workflow_timers.action': Object.freeze(['advance'])
  }),
  migrationLedger: Object.freeze({
    'schema_migrations.name': Object.freeze([
      '001_legacy_compat_columns',
      '002_campaign_business_spine',
      '003_campaign_workflow_dispatch_evidence',
      '004_knowledge_capacity_observability',
      '005_knowledge_custody_projection',
      '006_crm_sales_workspace'
    ]),
    'schema_migrations.checksum': Object.freeze([
      'c2df6a8da2554f871dc07370f5409f58d2bc1874597928c3bbd273ecb6cb0741',
      '60c6d3cf2b06666eb6325ad2c7902bda9a2ed1756a84586a4ee0100e39f40c88',
      '534a5eab8fd9581c3584128d9d69564cf85bd802cd24038a5ef8c5aea3d3ba56',
      '8beda613d3a8b8ea2604bd4a1b5ae72df2db56ec813987c05de9de18fc0b6e92',
      '2c8978c77a56cd068d9fc7b7eaa1ae986402900f5d5e9d2d883288c3421342b2',
      'f51697d1af1b5d49b793b34ab9c67b6b4823a826cbdcad7dd606063519a13418'
    ]),
    'schema_migrations.source_path': Object.freeze([
      'migrations/001_legacy_compat_columns.js',
      'migrations/002_campaign_business_spine.js',
      'migrations/003_campaign_workflow_dispatch_evidence.js',
      'migrations/004_knowledge_capacity_observability.js',
      'migrations/005_knowledge_custody_projection.js',
      'migrations/006_crm_sales_workspace.js'
    ])
  })
});

const TRANSFORMATION_EXCLUDED_CLASSIFICATIONS = new Set([
  'structural',
  'derived',
  'preserved-accounting'
]);
const STRUCTURAL_POLICY_VALIDATOR_VERSION = 'tm-structural-policy-v2-calendar-exact';
const STRUCTURAL_POLICY_SHA256 = crypto.createHash('sha256')
  .update(JSON.stringify({
    validatorVersion: STRUCTURAL_POLICY_VALIDATOR_VERSION,
    columns: STRUCTURAL_COLUMN_POLICY
  }), 'utf8')
  .digest('hex');
const SEMANTIC_POLICIES = Object.freeze({
  storage: Object.freeze({
    preservePerCellStorageClass: true,
    preserveSignedZeroFrame: true,
    preserveIntegralReal: true,
    preserveRowNullPattern: true,
    preserveEqualityPartitions: true
  }),
  triggers: Object.freeze({
    writePhase: 'disabled',
    restore: 'byte-exact-after-derived-rebuild'
  }),
  preservedAccounting: PRESERVED_ACCOUNTING,
  forbiddenValues: Object.freeze({
    jsonLeaves: true,
    shortSecrets: true,
    numbers: true,
    ftsTerms: true,
    liveMatch: 'exact-substring',
    minimumLength: 0,
    tokenBoundary: false,
    encodings: Object.freeze(['utf8', 'utf16le', 'utf16be', 'hex', 'base64', 'sha256-hex'])
  }),
  replacementSentinels: Object.freeze({
    mode: 'classified-columns-only',
    prefixes: Object.freeze(['tmtext-', 'tmjson-', 'tmkey-', 'tm-node-', 'tm-edge-', 'tm-inert-secret-', 'tm-contact-']),
    allowedClassifications: Object.freeze({
      'tmtext-': Object.freeze(['synthetic-text']),
      'tmjson-': Object.freeze(['json-leaves']),
      'tmkey-': Object.freeze(['json-leaves']),
      'tm-node-': Object.freeze(['json-leaves', 'reference-synthetic']),
      'tm-edge-': Object.freeze(['json-leaves']),
      'tm-inert-secret-': Object.freeze(['secret-synthetic']),
      'tm-contact-': Object.freeze(['synthetic-contact'])
    })
  }),
  structuralColumns: Object.freeze({
    mode: 'frozen-exact-table-column-policy',
    unknownText: 'transform-or-reject',
    validatorVersion: STRUCTURAL_POLICY_VALIDATOR_VERSION,
    policySha256: STRUCTURAL_POLICY_SHA256
  })
});
const V1_SEMANTIC_POLICIES = Object.freeze({
  ...SEMANTIC_POLICIES,
  preservedAccounting: V1_PRESERVED_ACCOUNTING
});

const CATEGORY_NAMES = new Set([
  'structural',
  'synthetic-text',
  'synthetic-contact',
  'synthetic-email',
  'synthetic-url',
  'secret-synthetic',
  'secret-null',
  'json-leaves',
  'reference-synthetic',
  'sensitive-number',
  'blob-digest',
  'dependent-digest',
  'derived',
  'preserved-accounting',
  'virtual-derived',
  'shadow-derived',
  'system-derived'
]);

const JSON_NAMES = new Set([
  'metadata_json', 'embedding_json', 'data_json', 'roi_data', 'enrichment_data',
  'response_json', 'response_headers_json', 'node_data', 'nodes', 'edges',
  'trigger_config_json', 'template_snapshot_json', 'execution_context_json', 'tags_json'
]);

const SECRET_NAMES = new Set([
  'password_hash', 'token', 'lease_token', 'reservation_nonce', 'idempotency_key',
  'resource_claim', 'code'
]);

const DIGEST_NAMES = new Set([
  'source_hash', 'source_identity_sha256', 'content_sha256', 'entry_content_sha256',
  'chunk_content_sha256', 'request_hash', 'audit_fingerprint', 'response_sha256',
  'template_checksum', 'bundle_id'
]);

const DERIVED_NAMES = new Set([
  'usage_count', 'uses', 'attempt_count', 'chunk_count', 'entry_payload_bytes',
  'chunk_payload_bytes', 'entries', 'chunks', 'payload_bytes', 'unscoped_references',
  'usage_value', 'limit_value', 'threshold_percent', 'token_count',
  'normalized_identity_key', 'duplicate_enforced'
]);

const SENSITIVE_NUMERIC = /(?:budget|cost|price|value|revenue|followers|views|engagement|rating|volume|posts|score|probability|quota|tokens|cpm|cpv|max_uses)$/;
const URL_NAMES = /(?:url|link)$/;
const EMAIL_NAMES = /email$/;
const CONTACT_NAMES = /(?:contact|ip_address)$/;
const WORKFLOW_NODE_REFERENCE_COLUMNS = new Set([
  'workflow_instances.current_node_id',
  'workflow_node_logs.node_id',
  'workflow_tasks.node_id',
  'workflow_timers.node_id'
]);
const EQUALITY_GROUP_BY_COLUMN = new Map(EQUALITY_GROUPS.flatMap((group) => (
  group.members.map((member) => [member, group.name])
)));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function frame32(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function framedSha256(values) {
  return sha256(Buffer.concat(values.map(frame32)));
}

function typedDigestText(value) {
  return Buffer.concat([Buffer.from([2]), Buffer.from(String(value), 'utf8')]);
}

function typedDigestInteger(value) {
  return Buffer.concat([Buffer.from([1]), Buffer.from(String(value), 'utf8')]);
}

function rebuiltKnowledgeSourceIdentity(row, custody) {
  if (row.source_identity_sha256 === null) return null;
  const privateOwner = row.visibility === 'private' ? String(row.created_by) : '';
  if (custody) {
    return framedSha256([
      'tm-knowledge-source-v1',
      String(custody.org_id),
      String(custody.campaign_id),
      row.source_type,
      String(row.source_id),
      row.entry_type,
      privateOwner
    ]);
  }
  let sourceId;
  if (row.source_id === null) sourceId = Buffer.from([0]);
  else if (row.source_storage === 'integer') sourceId = typedDigestInteger(row.source_id);
  else sourceId = typedDigestText(row.source_id);
  const nullableText = (value) => value === null ? Buffer.from([0]) : typedDigestText(value);
  const nullableInteger = (value) => value === null ? Buffer.from([0]) : typedDigestInteger(value);
  return framedSha256([
    typedDigestText('tm-knowledge-legacy-source-v1'),
    typedDigestInteger(row.id),
    nullableText(row.entry_type),
    nullableText(row.source_type),
    sourceId,
    nullableText(row.source_hash),
    nullableText(row.business_type),
    nullableText(row.business_id),
    nullableInteger(row.created_by)
  ]);
}

function rebuiltKnowledgeContentDigest(row) {
  const tags = JSON.parse(row.tags_json || '[]');
  return framedSha256([
    'tm-knowledge-content-v1',
    row.entry_type,
    row.title,
    row.summary,
    row.content,
    JSON.stringify(tags),
    row.visibility
  ]);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stableToken(domain, table, column, value) {
  const storage = storageFrame(value);
  return sha256(Buffer.concat([
    Buffer.from('tm-sanitizer-v1\0', 'utf8'),
    Buffer.from(domain, 'utf8'), Buffer.from('\0', 'utf8'),
    Buffer.from(table, 'utf8'), Buffer.from('\0', 'utf8'),
    Buffer.from(column, 'utf8'), Buffer.from('\0', 'utf8'),
    storage
  ]));
}

function workflowNodeValueKey(value) {
  return logicalValueKey(value, logicalStorageType(value));
}

function workflowNodeToken(value, relationshipTokens, replacementDomain) {
  const mapped = relationshipTokens && relationshipTokens.get(workflowNodeValueKey(value));
  if (mapped) return mapped;
  const token = stableToken('reference', 'workflow', 'node-id', value);
  return reserveTypedReplacement(
    replacementDomain,
    `workflow-node\0${workflowNodeValueKey(value)}`,
    'text',
    (attempt) => `tm-node-${replacementAttemptToken(token, attempt).slice(0, 32)}`
  );
}

function workflowEdgeToken(value, replacementDomain) {
  const token = stableToken('reference', 'workflow', 'edge-id', value);
  return reserveTypedReplacement(
    replacementDomain,
    `workflow-edge\0${workflowNodeValueKey(value)}`,
    'text',
    (attempt) => `tm-edge-${replacementAttemptToken(token, attempt).slice(0, 32)}`
  );
}

function workflowNodeRelationshipTokens(db, manifest, replacementDomain) {
  const group = manifest.referenceGroups.find((entry) => entry.name === 'workflow-node-id');
  if (!group) throw new Error('sanitization manifest is missing the workflow node reference group');
  const values = new Map();
  for (const specification of [...group.owners, ...group.references]) {
    for (const entry of semanticLocations(db, specification)) {
      values.set(workflowNodeValueKey(entry.value), entry.value);
    }
  }
  const ordered = [...values.entries()].sort((left, right) => (
    Buffer.compare(Buffer.from(String(left[1]), 'utf8'), Buffer.from(String(right[1]), 'utf8'))
      || left[0].localeCompare(right[0])
  ));
  const width = Math.max(12, String(ordered.length).length);
  return new Map(ordered.map(([key, value], index) => {
    const token = stableToken('reference', 'workflow', 'node-id', value);
    return [
      key,
      reserveTypedReplacement(
        replacementDomain,
        `workflow-node\0${key}`,
        'text',
        (attempt) => `tm-node-${String(index + 1).padStart(width, '0')}-${replacementAttemptToken(token, attempt).slice(0, 16)}`
      )
    ];
  }));
}

function storageFrame(value, storageType) {
  let type = storageType;
  let bytes;
  if (Buffer.isBuffer(value)) {
    type = type || 'blob';
    bytes = Buffer.from(value);
  } else if (type === 'integer') {
    bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(BigInt(value));
  } else if (type === 'real') {
    bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
  } else {
    type = type || (typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'real') : 'text');
    bytes = Buffer.from(String(value), 'utf8');
  }
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([Buffer.from([typeBytes.length]), typeBytes, length, bytes]);
}

function deterministicBlob(token, byteLength) {
  if (byteLength === 0) return Buffer.alloc(0);
  const seed = Buffer.from(token, 'hex');
  return Buffer.concat(
    Array.from({ length: Math.ceil(byteLength / seed.length) }, () => seed)
  ).subarray(0, byteLength);
}

function replacementAttemptToken(token, attempt) {
  if (attempt === 0) return token;
  return sha256(Buffer.from(`${token}\0${attempt}`, 'utf8'));
}

class SanitizerJsonBooleanDomainExhaustedError extends Error {
  constructor(context) {
    super(`type-preserving JSON boolean replacement domain is exhausted at ${context}`);
    this.name = 'SanitizerJsonBooleanDomainExhaustedError';
    this.code = 'TM_SANITIZER_JSON_BOOLEAN_DOMAIN_EXHAUSTED';
    this.context = context;
  }
}

function createReplacementDomain(db, manifest) {
  const sourceKeys = new Set(collectLiveOutputValues(db, manifest).map((entry) => entry.key));
  const assignedKeys = new Set();
  const replacements = new Map();
  const booleanReplacements = new Map();
  return Object.freeze({
    sourceKeys,
    isUnavailable(value, storageType) {
      const key = logicalValueKey(value, storageType);
      return sourceKeys.has(key) || assignedKeys.has(key);
    },
    reserveBoolean(original, context) {
      const mappingKey = original ? 'true' : 'false';
      if (booleanReplacements.has(mappingKey)) return booleanReplacements.get(mappingKey);
      const candidate = !original;
      if (sourceKeys.has(logicalValueKey(candidate, 'boolean'))) {
        throw new SanitizerJsonBooleanDomainExhaustedError(context);
      }
      booleanReplacements.set(mappingKey, candidate);
      return candidate;
    },
    reserve(mappingKey, storageType, candidateFactory) {
      const key = `${storageType}\0${mappingKey}`;
      if (replacements.has(key)) return replacements.get(key);
      for (let attempt = 0; attempt < 1_000_000; attempt += 1) {
        const candidate = candidateFactory(attempt);
        if (candidate === null || candidate === undefined) continue;
        const observedType = logicalStorageType(candidate);
        if (observedType !== storageType) {
          throw new Error(`replacement candidate changed storage type ${storageType} -> ${observedType}`);
        }
        const candidateKey = logicalValueKey(candidate, storageType);
        if (sourceKeys.has(candidateKey) || assignedKeys.has(candidateKey)) continue;
        replacements.set(key, candidate);
        assignedKeys.add(candidateKey);
        return candidate;
      }
      throw new Error(`replacement domain exhausted for ${mappingKey}`);
    }
  });
}

function reserveTypedReplacement(replacementDomain, mappingKey, storageType, candidateFactory) {
  if (!replacementDomain) return candidateFactory(0);
  return replacementDomain.reserve(mappingKey, storageType, candidateFactory);
}

function typePreservingReplacement(
  storageType,
  original,
  token,
  textValue,
  numericValue,
  replacementDomain,
  mappingKey
) {
  if (storageType === 'blob') {
    const length = Buffer.isBuffer(original) ? original.length : Buffer.byteLength(String(original));
    return reserveTypedReplacement(
      replacementDomain,
      mappingKey,
      'blob',
      (attempt) => deterministicBlob(replacementAttemptToken(token, attempt), length)
    );
  }
  if (storageType === 'integer') {
    if (numericValue !== undefined) return Math.trunc(numericValue);
    const seed = Number.parseInt(token.slice(0, 12), 16) % 1_000_000_000;
    return reserveTypedReplacement(
      replacementDomain,
      mappingKey,
      'integer',
      (attempt) => 4_000_000_000_000_000 + seed + attempt
    );
  }
  if (storageType === 'real') {
    if (numericValue !== undefined) return Number.isInteger(numericValue) ? numericValue + 0.5 : numericValue;
    const seed = Number.parseInt(token.slice(0, 12), 16) % 1_000_000_000;
    return reserveTypedReplacement(
      replacementDomain,
      mappingKey,
      'real',
      (attempt) => -4_000_000_000_000_000 - seed - attempt - 0.5
    );
  }
  if (storageType === 'text') {
    return reserveTypedReplacement(
      replacementDomain,
      mappingKey,
      'text',
      (attempt) => {
        const attemptToken = replacementAttemptToken(token, attempt);
        if (typeof textValue === 'function') return textValue(attempt, attemptToken);
        return attempt === 0 ? textValue : `${textValue}-${attemptToken.slice(0, 12)}`;
      }
    );
  }
  throw new Error(`unsupported SQLite storage class ${storageType}`);
}

function classifyInventoryObject(object) {
  if (object.type === 'virtual') return 'virtual-derived';
  if (object.type === 'shadow') return 'shadow-derived';
  if (object.name.startsWith('sqlite_')) return 'system-derived';
  return 'base-table';
}

function classifyInventoryColumn(object, column) {
  const name = column.name;
  const context = `${object.name}.${name}`;
  if (object.name === 'sqlite_schema' || object.name === 'sqlite_sequence') return 'system-derived';
  if (object.type === 'virtual') return 'virtual-derived';
  if (object.type === 'shadow') return 'shadow-derived';
  if (PRESERVED_ACCOUNTING_SET.has(context)) return 'preserved-accounting';
  if (WORKFLOW_NODE_REFERENCE_COLUMNS.has(context)) return 'reference-synthetic';
  if (STRUCTURAL_COLUMN_POLICY[context]) return 'structural';
  if (JSON_NAMES.has(name) || /_json$/.test(name)) return 'json-leaves';
  if (SECRET_NAMES.has(name)) return 'secret-synthetic';
  if (DIGEST_NAMES.has(name) || /(?:checksum|sha256|fingerprint|_hash)$/.test(name)) return 'dependent-digest';
  if (DERIVED_NAMES.has(name)) return 'derived';
  if (SENSITIVE_NUMERIC.test(name) || ['REAL', 'INTEGER', 'NUMERIC', 'DECIMAL'].includes(String(column.type).toUpperCase())) return 'sensitive-number';
  if (EMAIL_NAMES.test(name)) return 'synthetic-email';
  if (URL_NAMES.test(name)) return 'synthetic-url';
  if (CONTACT_NAMES.test(name)) return 'synthetic-contact';
  return 'synthetic-text';
}

function profileContractForVersion(schemaVersion) {
  if (schemaVersion === 1) {
    return Object.freeze({
      semanticPolicies: V1_SEMANTIC_POLICIES,
      equalityGroups: V1_EQUALITY_GROUPS,
      referenceGroups: V1_REFERENCE_GROUPS,
      derivedRebuilds: V1_DERIVED_REBUILDS,
      preservedAccounting: V1_PRESERVED_ACCOUNTING
    });
  }
  if (schemaVersion === 6) {
    return Object.freeze({
      semanticPolicies: SEMANTIC_POLICIES,
      equalityGroups: EQUALITY_GROUPS,
      referenceGroups: REFERENCE_GROUPS,
      derivedRebuilds: DERIVED_REBUILDS,
      preservedAccounting: PRESERVED_ACCOUNTING
    });
  }
  throw new Error(`unsupported exact sanitization profile version ${schemaVersion}`);
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertManifestDocumentShape(manifest) {
  const topLevelKeys = [
    'format', 'schemaVersion', 'categories', 'jsonPolicy', 'fts', 'semanticPolicies',
    'equalityGroups', 'referenceGroups', 'derivedRebuilds', 'objects', 'exactProfiles'
  ];
  if (
    !manifest || manifest.format !== MANIFEST_VERSION || manifest.schemaVersion !== 1
    || !exactObjectKeys(manifest, topLevelKeys)
  ) {
    throw new Error('malformed sanitization manifest header');
  }
  if (!Array.isArray(manifest.exactProfiles) || manifest.exactProfiles.length !== 1) {
    throw new Error('sanitization manifest must contain one isolated exact v6 profile');
  }
  const compatibilityProfile = manifest.exactProfiles[0];
  const profileKeys = [
    'schemaVersion', 'semanticPolicies', 'equalityGroups', 'referenceGroups',
    'derivedRebuilds', 'objects'
  ];
  if (
    !exactObjectKeys(compatibilityProfile, profileKeys)
    || compatibilityProfile.schemaVersion !== 6
  ) {
    throw new Error('malformed isolated exact sanitization manifest profile');
  }
}

function manifestProfileForVersion(manifest, schemaVersion) {
  assertManifestDocumentShape(manifest);
  profileContractForVersion(schemaVersion);
  const payload = schemaVersion === 1
    ? manifest
    : manifest.exactProfiles.find((profile) => profile.schemaVersion === schemaVersion);
  if (!payload) throw new Error(`missing exact sanitization profile for managed version ${schemaVersion}`);
  return Object.freeze({
    format: manifest.format,
    schemaVersion,
    categories: manifest.categories,
    jsonPolicy: manifest.jsonPolicy,
    fts: manifest.fts,
    semanticPolicies: payload.semanticPolicies,
    equalityGroups: payload.equalityGroups,
    referenceGroups: payload.referenceGroups,
    derivedRebuilds: payload.derivedRebuilds,
    objects: payload.objects
  });
}

function exactProfileClassification(db) {
  const classification = migrationService.classifyDatabase(db, {
    rootDir: path.resolve(__dirname, '..'),
    migrations: [...migrationService.defaultMigrations(), ...EXACT_PROFILE_MIGRATIONS]
  });
  if (
    classification.status !== 'managed'
    || ![1, 6].includes(classification.currentVersion)
  ) {
    const observed = classification.currentVersion === undefined || classification.currentVersion === null
      ? classification.status
      : classification.currentVersion;
    throw new Error(`sanitization source must be an exact managed version 1 or version 6 profile; got ${observed}`);
  }
  return classification;
}

function manifestFromInventory(inventory, schemaVersion = 1) {
  const contract = profileContractForVersion(schemaVersion);
  return {
    format: MANIFEST_VERSION,
    schemaVersion,
    semanticPolicies: JSON.parse(JSON.stringify(contract.semanticPolicies)),
    equalityGroups: JSON.parse(JSON.stringify(contract.equalityGroups)),
    referenceGroups: JSON.parse(JSON.stringify(contract.referenceGroups)),
    derivedRebuilds: [...contract.derivedRebuilds],
    categories: {
      structural: 'exact table/column relationship, closed enum, validated time, identifier, or schema value',
      'synthetic-text': 'deterministic non-production text preserving equality partitions',
      'synthetic-contact': 'deterministic inert contact value',
      'synthetic-email': 'deterministic example.invalid address',
      'synthetic-url': 'deterministic example.invalid URL',
      'reference-synthetic': 'deterministic non-production identifier shared by an explicit reference group',
      'secret-synthetic': 'disjoint inert credential sentinel preserving nullness',
      'secret-null': 'NULL only; source column must be entirely NULL',
      'json-leaves': 'every JSON leaf at /** is replaced by type-preserving deterministic data',
      'sensitive-number': 'deterministic rank bucket preserving null/equality/cardinality',
      'blob-digest': 'deterministic digest bytes preserving byte length',
      'dependent-digest': 'deterministic SHA-256 replacement derived from sanitized ownership row',
      derived: 'recomputed or allowlisted aggregate',
      'preserved-accounting': 'source accounting retained because the external binary body is absent',
      'virtual-derived': 'never copied; rebuilt from sanitized base tables',
      'shadow-derived': 'never copied; rebuilt by SQLite FTS5',
      'system-derived': 'SQLite-owned schema or sequence object'
    },
    jsonPolicy: JSON.parse(JSON.stringify(JSON_POLICY)),
    fts: FTS_MANIFEST.fts,
    objects: inventory.map((object) => ({
      name: object.name,
      type: object.type,
      classification: classifyInventoryObject(object),
      columns: object.columns.map((column) => ({
        name: column.name,
        declaredType: column.type,
        notnull: column.notnull,
        pk: column.pk,
        hidden: column.hidden,
        classification: classifyInventoryColumn(object, column),
        foreignKey: Boolean(column.foreignKey),
        ...(classifyInventoryColumn(object, column) === 'json-leaves'
          ? { jsonPolicy: jsonColumnPolicy(object.name, column.name) }
          : {})
      }))
    }))
  };
}

function jsonColumnPolicy(table, column) {
  if (column === 'tags_json') {
    return { mode: 'closed', allowedPaths: ['/', '/*'], leafPolicy: 'synthetic-string' };
  }
  if (column === 'embedding_json') {
    return { mode: 'closed', allowedPaths: ['/', '/*'], leafPolicy: 'synthetic-number' };
  }
  if (column === 'nodes') {
    return {
      mode: 'closed',
      allowedPaths: [
        '/', '/*', '/*/id', '/*/type', '/*/label', '/*/name', '/*/title',
        '/*/description', '/*/role', '/*/assignee_role', '/*/action', '/*/duration',
        '/*/position', '/*/position/x', '/*/position/y', '/*/config', '/*/config/*'
      ],
      leafPolicy: 'type-preserving-synthetic'
    };
  }
  if (column === 'edges') {
    return {
      mode: 'closed',
      allowedPaths: [
        '/', '/*', '/*/id', '/*/source', '/*/target', '/*/from', '/*/to',
        '/*/outcome', '/*/label', '/*/condition', '/*/priority'
      ],
      conditionExpression: { root: '/*/condition', maxDepth: 8 },
      leafPolicy: 'type-preserving-synthetic'
    };
  }
  if (column === 'trigger_config_json') {
    return {
      mode: 'closed',
      allowedPaths: [
        '/', '/event', '/event_type', '/previous_state', '/next_state', '/from', '/to', '/enabled', '/conditions',
        '/conditions/*', '/conditions/*/field', '/conditions/*/operator',
        '/conditions/*/value', '/reconciliation', '/reconciliation/*'
      ],
      leafPolicy: 'type-preserving-synthetic'
    };
  }
  if (column === 'template_snapshot_json') {
    return {
      mode: 'closed',
      allowedPaths: [
        '/', '/snapshot_version', '/template_id', '/template_version', '/module',
        '/trigger', '/trigger/event_type', '/trigger/previous_state', '/trigger/next_state',
        '/nodes', '/nodes/*', '/nodes/*/id', '/nodes/*/type', '/nodes/*/label',
        '/nodes/*/config', '/nodes/*/config/title', '/nodes/*/config/description',
        '/nodes/*/config/assignee_id', '/nodes/*/config/assignee_role', '/nodes/*/config/due_hours',
        '/edges', '/edges/*', '/edges/*/id', '/edges/*/from', '/edges/*/to',
        '/edges/*/outcome', '/edges/*/priority', '/edges/*/condition'
      ],
      conditionExpression: { root: '/edges/*/condition', maxDepth: 8 },
      leafPolicy: 'type-preserving-synthetic'
    };
  }
  if (column === 'execution_context_json') {
    return {
      mode: 'closed',
      allowedPaths: [
        '/', '/campaign', '/campaign/id', '/campaign/lifecycle_state',
        '/campaign/operational_status', '/campaign/row_version', '/campaign/name',
        '/event', '/event/id', '/event/event_type', '/event/previous_state',
        '/event/next_state', '/event/reason', '/actor', '/actor/user_id', '/actor/role',
        '/links', '/links/*', '/links/*/id', '/links/*/record_type', '/links/*/record_id',
        '/source', '/correlation_id'
      ],
      leafPolicy: 'type-preserving-synthetic'
    };
  }
  return {
    mode: 'dynamic-sanitized',
    allowedPaths: ['/'],
    extraKeyPolicy: 'sanitize-key-and-value',
    leafPolicy: 'type-preserving-synthetic',
    owner: `${table}.${column}`
  };
}

function assertFrozenManifestPolicy(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`sanitization manifest ${label} semantic policy changed`);
  }
}

function isValidCalendarDate(yearText, monthText, dayText) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
      || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function isCanonicalCalendarTimestamp(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/
  );
  if (!match || !isValidCalendarDate(match[1], match[2], match[3])) return false;
  if (match[4] === undefined) return true;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[7] === undefined) return true;
  const offsetHour = Number(match[8]);
  const offsetMinute = Number(match[9]);
  return offsetHour <= 14 && offsetMinute <= 59 && (offsetHour !== 14 || offsetMinute === 0);
}

function assertStructuralValueAllowed(context, value, observedStorageType) {
  const policy = STRUCTURAL_COLUMN_POLICY[context];
  if (!policy) throw new Error(`missing frozen structural policy for ${context}`);
  if (value === null || value === undefined) return true;
  const storageType = observedStorageType || logicalStorageType(value);
  if (storageType !== policy.storage) {
    throw new Error(`structural policy rejected ${context}: expected ${policy.storage} storage`);
  }
  if (policy.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error(`structural policy rejected ${context}: expected a safe integer`);
    }
    return true;
  }
  if (typeof value !== 'string') {
    throw new Error(`structural policy rejected ${context}: expected text`);
  }
  if (policy.kind === 'enum' || policy.kind === 'migration-ledger') {
    if (!policy.allowedValues.includes(value)) {
      throw new Error(`structural policy rejected classified column ${context}: value is outside the closed allowlist`);
    }
    return true;
  }
  if (policy.kind === 'canonical-positive-decimal') {
    if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`structural policy rejected ${context}: value is not a canonical positive decimal`);
    }
    return true;
  }
  if (policy.kind === 'date') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match || !isValidCalendarDate(match[1], match[2], match[3])) {
      throw new Error(`structural policy rejected ${context}: value is not a canonical date`);
    }
    return true;
  }
  if (policy.kind === 'timestamp') {
    if (!isCanonicalCalendarTimestamp(value)) {
      throw new Error(`structural policy rejected ${context}: value is not a canonical timestamp`);
    }
    return true;
  }
  throw new Error(`unknown frozen structural policy kind for ${context}`);
}

function validateStructuralColumnValues(db, contexts) {
  for (const context of contexts) {
    const policy = STRUCTURAL_COLUMN_POLICY[context];
    const separator = context.indexOf('.');
    const table = context.slice(0, separator);
    const column = context.slice(separator + 1);
    const rows = db.prepare(`
      SELECT DISTINCT typeof(${quoteIdentifier(column)}) AS storage_type,
        ${quoteIdentifier(column)} AS value
      FROM ${quoteIdentifier(table)}
      WHERE ${quoteIdentifier(column)} IS NOT NULL
    `).all();
    for (const row of rows) assertStructuralValueAllowed(context, row.value, row.storage_type);
    if (!['integer', 'text'].includes(policy.storage)) {
      throw new Error(`unknown structural storage policy for ${context}`);
    }
  }
}

function actualInventory(db) {
  return db.prepare(`
    SELECT name,type FROM pragma_table_list
    WHERE schema='main' ORDER BY CAST(name AS BLOB)
  `).all().map((object) => {
    const foreignKeys = new Set(db.prepare('SELECT "from" AS name FROM pragma_foreign_key_list(?)').all(object.name).map((row) => row.name));
    return {
      ...object,
      columns: db.prepare(`
        SELECT name,type,"notnull",pk,hidden FROM pragma_table_xinfo(?) ORDER BY cid
      `).all(object.name).map((column) => ({ ...column, foreignKey: foreignKeys.has(column.name) }))
    };
  });
}

function validateManifest(manifest, db) {
  const sourceVersion = exactProfileClassification(db).currentVersion;
  const profile = manifestProfileForVersion(manifest, sourceVersion);
  const contract = profileContractForVersion(sourceVersion);
  if (!profile.jsonPolicy || !Array.isArray(profile.jsonPolicy.allowedLeafTypes)) {
    throw new Error('malformed sanitization JSON path policy');
  }
  assertFrozenManifestPolicy('JSON path', profile.jsonPolicy, JSON_POLICY);
  assertFrozenManifestPolicy('storage/trigger/forbidden/sentinel', profile.semanticPolicies, contract.semanticPolicies);
  assertFrozenManifestPolicy('equality groups', profile.equalityGroups, contract.equalityGroups);
  assertFrozenManifestPolicy('reference groups', profile.referenceGroups, contract.referenceGroups);
  assertFrozenManifestPolicy('derived rebuilds', profile.derivedRebuilds, contract.derivedRebuilds);
  assertFrozenManifestPolicy('FTS declaration', profile.fts, FTS_MANIFEST.fts);
  const actual = actualInventory(db);
  const inventoryContexts = new Set(actual.flatMap((object) => (
    object.columns.map((column) => `${object.name}.${column.name}`)
  )));
  const preservedAccountingColumns = [];
  const structuralColumns = [];
  if (!Array.isArray(profile.objects) || profile.objects.length !== actual.length) {
    throw new Error('unknown or missing schema object in sanitization manifest');
  }
  for (let index = 0; index < actual.length; index += 1) {
    const expected = profile.objects[index];
    const observed = actual[index];
    if (!expected || expected.name !== observed.name || expected.type !== observed.type) {
      throw new Error(`unknown or reordered schema object ${observed.name}`);
    }
    if (!CATEGORY_NAMES.has(expected.classification) && expected.classification !== 'base-table') {
      throw new Error(`unknown object classification ${expected.name}`);
    }
    if (expected.classification !== classifyInventoryObject(observed)) {
      throw new Error(`sanitization manifest canonical inventory classification mismatch at ${observed.name}`);
    }
    if (!Array.isArray(expected.columns) || expected.columns.length !== observed.columns.length) {
      throw new Error(`unknown or missing column in ${observed.name}`);
    }
    for (let columnIndex = 0; columnIndex < observed.columns.length; columnIndex += 1) {
      const expectedColumn = expected.columns[columnIndex];
      const observedColumn = observed.columns[columnIndex];
      for (const field of ['name', 'declaredType', 'notnull', 'pk', 'hidden', 'foreignKey']) {
        if (expectedColumn[field] !== observedColumn[field === 'declaredType' ? 'type' : field]) {
          throw new Error(`unknown or changed column ${observed.name}.${observedColumn.name}`);
        }
      }
      if (!CATEGORY_NAMES.has(expectedColumn.classification)) {
        throw new Error(`unknown column classification ${observed.name}.${observedColumn.name}`);
      }
      if (expectedColumn.classification !== classifyInventoryColumn(observed, observedColumn)) {
        throw new Error(`sanitization manifest canonical inventory classification mismatch at ${observed.name}.${observedColumn.name}`);
      }
      if (expectedColumn.classification === 'preserved-accounting') {
        preservedAccountingColumns.push(`${observed.name}.${observedColumn.name}`);
      }
      if (expectedColumn.classification === 'structural') {
        structuralColumns.push(`${observed.name}.${observedColumn.name}`);
      }
      if (expectedColumn.classification === 'json-leaves') {
        const policy = expectedColumn.jsonPolicy;
        if (!policy || !['closed', 'dynamic-sanitized'].includes(policy.mode) || !Array.isArray(policy.allowedPaths) || !policy.allowedPaths.includes('/')) {
          throw new Error(`unknown JSON path policy ${observed.name}.${observedColumn.name}`);
        }
        if (policy.mode === 'dynamic-sanitized' && policy.extraKeyPolicy !== 'sanitize-key-and-value') {
          throw new Error(`unsafe dynamic JSON policy ${observed.name}.${observedColumn.name}`);
        }
        if (JSON.stringify(policy) !== JSON.stringify(jsonColumnPolicy(observed.name, observedColumn.name))) {
          throw new Error(`unknown JSON path policy ${observed.name}.${observedColumn.name}`);
        }
      } else if (expectedColumn.jsonPolicy !== undefined) {
        throw new Error(`JSON paths declared on non-JSON column ${observed.name}.${observedColumn.name}`);
      }
    }
  }
  assertFrozenManifestPolicy(
    'preserved accounting classification',
    preservedAccountingColumns,
    contract.preservedAccounting
  );
  assertFrozenManifestPolicy(
    'exact structural column classification',
    [...structuralColumns].sort(),
    Object.keys(STRUCTURAL_COLUMN_POLICY).filter((context) => inventoryContexts.has(context)).sort()
  );
  validateStructuralColumnValues(db, structuralColumns);
  return profile;
}

function secretOnlySanitizationManifest(manifest) {
  return {
    ...manifest,
    objects: manifest.objects.map((object) => ({
      ...object,
      columns: object.columns.map((column) => ({
        ...column,
        classification: ['secret-synthetic', 'secret-null'].includes(column.classification)
          ? column.classification
          : 'structural'
      }))
    }))
  };
}

function sourceSecretCopyNeedles(secretProbes) {
  const text = new Map();
  const binary = new Map();
  for (const probe of secretProbes?.rawProbes || []) {
    if (!Buffer.isBuffer(probe.bytes) || probe.bytes.length === 0) continue;
    const key = `${probe.encoding}\0${probe.bytes.toString('hex')}`;
    binary.set(key, probe.bytes);
    if (probe.storageType !== 'text') continue;
    if (!['utf8', 'hex', 'base64', 'sha256-hex'].includes(probe.encoding)) continue;
    const value = probe.bytes.toString('utf8');
    if (value.length) text.set(key, value);
  }
  return Object.freeze({
    text: Object.freeze([...text.values()].sort((left, right) => right.length - left.length)),
    binary: Object.freeze([...binary.values()].sort((left, right) => right.length - left.length))
  });
}

function absentTextScrubFill(needles) {
  for (let codePoint = 1; codePoint <= 0xffff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (needles.every((needle) => !needle.includes(candidate))) return candidate;
  }
  throw new Error('unable to choose a non-secret text pre-scrub marker');
}

function absentBinaryScrubFill(needles) {
  for (let candidate = 0; candidate <= 0xff; candidate += 1) {
    if (needles.every((needle) => !needle.includes(candidate))) return candidate;
  }
  throw new Error('unable to choose a non-secret binary pre-scrub marker');
}

function scrubTextSecretCopies(value, needles, fill) {
  let output = value;
  for (const needle of needles) {
    if (!output.includes(needle)) continue;
    output = output.split(needle).join(fill.repeat([...needle].length));
  }
  return output;
}

function scrubBinarySecretCopies(value, needles, fill) {
  let output = Buffer.from(value);
  for (const needle of needles) {
    let offset = output.indexOf(needle);
    while (offset !== -1) {
      output.fill(fill, offset, offset + needle.length);
      offset = output.indexOf(needle, offset + needle.length);
    }
  }
  return output;
}

function scrubSecretCopiesInPlace(db, manifest, secretProbes) {
  const needles = sourceSecretCopyNeedles(secretProbes);
  if (!needles.text.length && !needles.binary.length) return;
  const textFill = needles.text.length ? absentTextScrubFill(needles.text) : null;
  const binaryFill = needles.binary.length ? absentBinaryScrubFill(needles.binary) : null;
  for (const object of manifest.objects) {
    if (object.classification !== 'base-table') continue;
    const columns = object.columns.filter((column) => (
      column.hidden === 0
        && !['secret-synthetic', 'secret-null'].includes(column.classification)
    ));
    if (!columns.length) continue;
    const keys = primaryKeyColumns(db, object.name);
    if (!keys.length) throw new Error(`pre-scrub requires a primary key for ${object.name}`);
    const projection = [
      ...keys.map(quoteIdentifier),
      ...columns.flatMap((column) => [
        quoteIdentifier(column.name),
        `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`__tm_type_${column.name}`)}`
      ])
    ].join(',');
    const order = keys.map(quoteIdentifier).join(',');
    const rows = db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(object.name)} ORDER BY ${order}`).all();
    const whereSql = keys.map((key) => `${quoteIdentifier(key)} IS ?`).join(' AND ');
    for (const column of columns) {
      const update = db.prepare(`UPDATE ${quoteIdentifier(object.name)} SET ${quoteIdentifier(column.name)}=? WHERE ${whereSql}`);
      for (const row of rows) {
        const value = row[column.name];
        const storageType = row[`__tm_type_${column.name}`];
        const replacement = storageType === 'text' && needles.text.length
          ? scrubTextSecretCopies(value, needles.text, textFill)
          : storageType === 'blob' && needles.binary.length
            ? scrubBinarySecretCopies(value, needles.binary, binaryFill)
            : value;
        const changed = Buffer.isBuffer(value)
          ? !value.equals(replacement)
          : value !== replacement;
        if (!changed) continue;
        const result = update.run(replacement, ...keys.map((key) => row[key]));
        if (result.changes !== 1) throw new Error(`pre-scrub secret-copy update failed for ${object.name}.${column.name}`);
      }
    }
  }
}

function lstatNoFollowIfPresent(filePath, options) {
  try {
    return fs.lstatSync(filePath, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertRegularDatabaseFile(filePath, label, options = {}) {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`${label} parent must be a real directory`);
  if (options.mustExist !== false) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  } else if (lstatNoFollowIfPresent(resolved) !== null) {
    throw new Error(`${label} already exists`);
  }
  return resolved;
}

function linuxMountpoints() {
  if (process.platform !== 'linux') return new Set();
  const unescapeMount = (value) => value
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\');
  return new Set(fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.split(' ');
    return path.resolve(unescapeMount(fields[4]));
  }));
}

function validateSecurePath(filePath, options = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('secure path must be absolute');
  if (typeof options.root !== 'string' || !path.isAbsolute(options.root)) throw new Error('secure path root must be absolute');
  const target = path.resolve(filePath);
  const root = path.resolve(options.root);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('secure path escapes its declared root');
  const directoryModes = new Set(options.directoryModes || [0o700]);
  const fileModes = options.fileModes === undefined
    ? (options.fileMode === undefined ? null : new Set([options.fileMode]))
    : new Set(options.fileModes);
  const expectedUid = options.expectedUid;
  const mountpoints = options.rejectMounts === false ? new Set() : linuxMountpoints();
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('secure path root is not a real directory');
  if (expectedUid !== null && expectedUid !== undefined && rootStat.uid !== expectedUid) throw new Error('secure path root owner mismatch');
  if (!directoryModes.has(rootStat.mode & 0o777)) throw new Error('secure path root mode mismatch');
  if (mountpoints.has(root)) throw new Error('secure path root is a mountpoint');

  let ancestor = path.parse(root).root;
  for (const segment of root.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    const stat = fs.lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('secure path ancestor is a symbolic link');
  }

  let cursor = root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const final = index === segments.length - 1;
    const stat = lstatNoFollowIfPresent(cursor);
    if (stat === null) {
      if (final && options.mustExist === false) break;
      throw new Error('secure path component does not exist');
    }
    if (stat.isSymbolicLink()) throw new Error('secure path component is a symbolic link');
    if (stat.dev !== rootStat.dev) throw new Error('secure path crosses devices');
    if (mountpoints.has(path.resolve(cursor))) throw new Error('secure path component is a mountpoint');
    if (expectedUid !== null && expectedUid !== undefined && stat.uid !== expectedUid) throw new Error('secure path owner mismatch');
    if (!final || stat.isDirectory()) {
      if (!stat.isDirectory()) throw new Error('secure path parent is not a directory');
      if (!directoryModes.has(stat.mode & 0o777)) throw new Error('secure path directory mode mismatch');
    } else {
      if (options.mustExist === false) throw new Error('secure output path already exists');
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('secure path must be a regular single-link file');
      if (fileModes && !fileModes.has(stat.mode & 0o777)) throw new Error('secure path file mode mismatch');
      const noFollow = process.platform === 'linux' ? (fs.constants.O_NOFOLLOW || 0) : 0;
      const fd = fs.openSync(cursor, fs.constants.O_RDONLY | noFollow);
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || !opened.isFile()) {
          throw new Error('secure path changed during no-follow validation');
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  if (segments.length === 0 && options.mustExist === false) throw new Error('secure output cannot replace its root');
  return Object.freeze({ path: target, root, device: rootStat.dev, inode: rootStat.ino });
}

function assertProductionCoordinatorEnvironment(options = {}) {
  const platform = options.platform === undefined ? process.platform : options.platform;
  const uid = options.uid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid() : null)
    : options.uid;
  if (platform !== 'linux') throw new Error('production sanitizer coordinator requires Linux namespaces');
  if (uid !== 0) throw new Error('production sanitizer coordinator must run as root');
  return true;
}

function normalizeLifecycleFencePath(value, platform = process.platform) {
  const pathApi = platform === 'linux' ? path.posix : path;
  if (typeof value !== 'string' || !pathApi.isAbsolute(value) || /[\0\r\n\t]/.test(value)) {
    throw new Error('shared sanitizer lifecycle fence must be an absolute path without control characters');
  }
  const normalized = pathApi.normalize(value);
  if (normalized === pathApi.parse(normalized).root || normalized !== value) {
    throw new Error('shared sanitizer lifecycle fence path is unsafe');
  }
  return normalized;
}

function ensureProductionLifecycleFenceFile(fencePath, options = {}) {
  const platform = options.platform || process.platform;
  const resolved = normalizeLifecycleFencePath(fencePath, platform);
  const parent = (platform === 'linux' ? path.posix : path).dirname(resolved);
  const expectedUid = options.expectedUid === undefined ? 0 : options.expectedUid;
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || (expectedUid !== null && expectedUid !== undefined && parentStat.uid !== expectedUid)
      || fs.realpathSync(parent) !== parent) {
    throw new Error('shared sanitizer lifecycle fence parent is unsafe');
  }
  let stat = lstatNoFollowIfPresent(resolved);
  if (stat === null) {
    try { secureCreateEmptyFile(resolved, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    stat = lstatNoFollowIfPresent(resolved);
  }
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (expectedUid !== null && expectedUid !== undefined && stat.uid !== expectedUid)
      || (platform === 'linux' && (stat.mode & 0o777) !== 0o600)
      || fs.realpathSync(resolved) !== resolved) {
    throw new Error('shared sanitizer lifecycle fence identity is unsafe');
  }
  return resolved;
}

function lifecycleFenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lifecycleFenceIdentity(fd, label = 'shared sanitizer lifecycle fence descriptor') {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error(`${label} is not a regular single-link file`);
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() });
}

function lockLifecycleFenceDescriptor(fd, options = {}) {
  const run = options.spawnSyncImpl || spawnSync;
  const result = run(options.flockPath || '/usr/bin/flock', ['-n', '3'], {
    stdio: ['ignore', 'pipe', 'pipe', fd],
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true
  });
  if (result.error) throw lifecycleFenceError(
    'TM_SANITIZER_LIFECYCLE_FENCE_LOCK_FAILED',
    `shared sanitizer lifecycle fence lock failed: ${result.error.message}`
  );
  if (result.signal) throw lifecycleFenceError(
    'TM_SANITIZER_LIFECYCLE_FENCE_LOCK_FAILED',
    `shared sanitizer lifecycle fence locker ended by ${result.signal}`
  );
  if (result.status === 1) throw lifecycleFenceError(
    'TM_SANITIZER_LIFECYCLE_FENCE_BUSY',
    'another deploy, sanitizer, rollback, or runtime bootstrap operation is active'
  );
  if (result.status !== 0) throw lifecycleFenceError(
    'TM_SANITIZER_LIFECYCLE_FENCE_LOCK_FAILED',
    `shared sanitizer lifecycle fence locker failed with status ${result.status}`
  );
}

function createLifecycleFenceLease(fd, identity, pathValue, options = {}) {
  let released = false;
  return Object.freeze({
    fd,
    path: pathValue || null,
    device: identity.device,
    inode: identity.inode,
    release() {
      if (released) return;
      const observed = lifecycleFenceIdentity(fd);
      if (observed.device !== identity.device || observed.inode !== identity.inode) {
        throw new Error('shared sanitizer lifecycle fence descriptor identity changed before release');
      }
      fs.closeSync(fd);
      released = true;
    }
  });
}

function acquireProductionLifecycleFence(options = {}) {
  const requireRoot = options.requireRoot !== false;
  const platform = options.platform || process.platform;
  const uid = options.uid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid() : null)
    : options.uid;
  if (requireRoot) assertProductionCoordinatorEnvironment({ platform, uid });
  const expectedUid = requireRoot ? 0 : uid;
  const fencePath = ensureProductionLifecycleFenceFile(
    options.fencePath || DEFAULT_LIFECYCLE_FENCE_PATH,
    { platform, expectedUid }
  );
  const inheritedFd = options.inheritedFd;
  if (inheritedFd !== undefined && (!Number.isSafeInteger(inheritedFd) || inheritedFd < 3)) {
    throw new Error('inherited sanitizer lifecycle fence descriptor is invalid');
  }
  const noFollow = platform === 'linux' ? (fs.constants.O_NOFOLLOW || 0) : 0;
  const fd = inheritedFd === undefined
    ? fs.openSync(fencePath, fs.constants.O_RDWR | noFollow)
    : inheritedFd;
  let lease = null;
  try {
    const opened = lifecycleFenceIdentity(fd);
    const expected = fs.lstatSync(fencePath, { bigint: true });
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n
        || opened.device !== expected.dev.toString() || opened.inode !== expected.ino.toString()) {
      throw new Error('inherited sanitizer lifecycle fence does not match the canonical lock');
    }
    lockLifecycleFenceDescriptor(fd, options);
    const after = lifecycleFenceIdentity(fd);
    if (after.device !== opened.device || after.inode !== opened.inode) {
      throw new Error('shared sanitizer lifecycle fence descriptor changed while locking');
    }
    lease = createLifecycleFenceLease(fd, opened, fencePath, options);
    return lease;
  } finally {
    if (!lease) {
      try { fs.closeSync(fd); } catch (_error) {}
    }
  }
}

function adoptInheritedLifecycleFence(options = {}) {
  const fd = options.fd === undefined ? DEFAULT_LIFECYCLE_FENCE_FD : options.fd;
  if (!Number.isSafeInteger(fd) || fd < 3 || !/^\d+$/.test(options.device || '')
      || !/^\d+$/.test(options.inode || '')) {
    throw new Error('isolated worker lifecycle fence identity is invalid');
  }
  let lease = null;
  try {
    const observed = lifecycleFenceIdentity(fd, 'isolated worker lifecycle fence descriptor');
    if (observed.device !== options.device || observed.inode !== options.inode) {
      throw new Error('isolated worker lifecycle fence descriptor identity mismatch');
    }
    lockLifecycleFenceDescriptor(fd, options);
    lease = createLifecycleFenceLease(fd, observed, null, options);
    return lease;
  } finally {
    if (!lease) {
      try { fs.closeSync(fd); } catch (_error) {}
    }
  }
}

function buildIsolatedWorkerLaunch(options) {
  if (!options || !/^[0-9a-f]{32}$/.test(options.runId || '')) throw new Error('invalid production sanitizer run id');
  if (!Number.isSafeInteger(options.uid) || options.uid <= 0) throw new Error('worker uid must be an unprivileged identity');
  if (!Number.isSafeInteger(options.gid) || options.gid <= 0) throw new Error('worker gid must be an unprivileged identity');
  const linuxPath = (value, label) => {
    if (typeof value !== 'string' || !path.posix.isAbsolute(value) || /[\0\r\n\t ]/.test(value)) {
      throw new Error(`${label} must be an absolute Linux path without whitespace`);
    }
    const normalized = path.posix.normalize(value);
    if (normalized === '/' || normalized.includes('/../')) throw new Error(`${label} is too broad`);
    return normalized;
  };
  const sourcePath = linuxPath(options.sourcePath, 'worker source path');
  const outputPath = linuxPath(options.outputPath, 'worker output path');
  if (sourcePath === outputPath || path.dirname(sourcePath) === path.dirname(outputPath)) {
    throw new Error('isolated worker source and output must use separate paths');
  }
  const nodePath = linuxPath(options.nodePath, 'worker node path');
  const scriptPath = linuxPath(options.scriptPath, 'worker script path');
  const serverRoot = linuxPath(options.serverRoot, 'worker server root');
  const sandboxRoot = linuxPath(options.sandboxRoot, 'worker sandbox root');
  const relativeScript = path.posix.relative(serverRoot, scriptPath);
  if (!relativeScript || relativeScript.startsWith('../') || path.posix.isAbsolute(relativeScript)) {
    throw new Error('worker script must be inside the candidate server root');
  }
  const outputDirectory = path.posix.dirname(outputPath);
  if (!/^\d+$/.test(options.lifecycleFenceDevice || '') || !/^\d+$/.test(options.lifecycleFenceInode || '')) {
    throw new Error('worker lifecycle fence device and inode are required');
  }
  const pairwiseSeparated = [sourcePath, outputDirectory, serverRoot, sandboxRoot];
  for (let left = 0; left < pairwiseSeparated.length; left += 1) {
    for (let right = left + 1; right < pairwiseSeparated.length; right += 1) {
      const a = pairwiseSeparated[left];
      const b = pairwiseSeparated[right];
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw new Error('worker source, output, candidate, and sandbox paths must be disjoint');
      }
    }
  }
  const workerPaths = Object.freeze({
    source: '/input/source.db',
    output: '/output/output.db',
    script: `/app/${relativeScript}`,
    node: '/runtime/node'
  });
  const allowedMounts = Object.freeze([
    Object.freeze({ host: nodePath, guest: workerPaths.node, readOnly: true, recursive: false }),
    Object.freeze({ host: serverRoot, guest: '/app', readOnly: true, recursive: false }),
    Object.freeze({ host: sourcePath, guest: workerPaths.source, readOnly: true, recursive: false }),
    Object.freeze({ host: outputDirectory, guest: '/output', readOnly: false, recursive: false }),
    Object.freeze({ host: '/usr', guest: '/usr', readOnly: true, recursive: false }),
    Object.freeze({ host: '/lib', guest: '/lib', readOnly: true, recursive: false, optional: true }),
    Object.freeze({ host: '/lib64', guest: '/lib64', readOnly: true, recursive: false, optional: true }),
    Object.freeze({ host: '/dev/null', guest: '/dev/null', readOnly: false, recursive: false }),
    Object.freeze({ host: '/dev/urandom', guest: '/dev/urandom', readOnly: true, recursive: false })
  ]);
  const namespaceScript = [
    'set -euo pipefail',
    'run_id="$1"; worker_uid="$2"; worker_gid="$3"; node_path="$4"; server_root="$5"; source_path="$6"; output_path="$7"; sandbox_root="$8"; worker_script="$9"; fence_device="${10}"; fence_inode="${11}"',
    'mount --make-rprivate /',
    'output_dir="$(dirname -- "$output_path")"',
    'mount -t tmpfs -o mode=0755,nosuid,nodev,noexec tm-sanitizer-root "$sandbox_root"',
    'mount_points="$sandbox_root"',
    'record_mount() { mount_points="${mount_points}\n$1"; }',
    'bind_dir() { host="$1"; guest="$2"; flags="$3"; mkdir -p "$guest"; mount --bind "$host" "$guest"; mount -o "remount,bind,$flags" "$guest"; record_mount "$guest"; }',
    'bind_file() { host="$1"; guest="$2"; flags="$3"; mkdir -p "$(dirname -- "$guest")"; : > "$guest"; mount --bind "$host" "$guest"; mount -o "remount,bind,$flags" "$guest"; record_mount "$guest"; }',
    'mkdir -p "$sandbox_root/runtime" "$sandbox_root/app" "$sandbox_root/input" "$sandbox_root/output" "$sandbox_root/usr" "$sandbox_root/dev" "$sandbox_root/tmp"',
    'bind_file "$node_path" "$sandbox_root/runtime/node" "ro,nosuid,nodev,exec"',
    'bind_dir "$server_root" "$sandbox_root/app" "ro,nosuid,nodev,exec"',
    'bind_file "$source_path" "$sandbox_root/input/source.db" "ro,nosuid,nodev,noexec"',
    'bind_dir "$output_dir" "$sandbox_root/output" "rw,nosuid,nodev,noexec"',
    'bind_dir /usr "$sandbox_root/usr" "ro,nosuid,nodev,exec"',
    'for runtime_tree in /lib /lib64; do if [ -L "$runtime_tree" ]; then ln -s "$(readlink -- "$runtime_tree")" "$sandbox_root$runtime_tree"; elif [ -d "$runtime_tree" ]; then bind_dir "$runtime_tree" "$sandbox_root$runtime_tree" "ro,nosuid,nodev,exec"; else [ "$runtime_tree" = /lib64 ] || exit 71; fi; done',
    'bind_file /dev/null "$sandbox_root/dev/null" "rw,nosuid,dev,noexec"',
    'bind_file /dev/urandom "$sandbox_root/dev/urandom" "ro,nosuid,dev,noexec"',
    'chown "$worker_uid:$worker_gid" "$sandbox_root/tmp"',
    'chmod 0700 "$sandbox_root/tmp"',
    'actual_mounts="$(awk -v root="$sandbox_root" \'$5 == root || index($5, root "/") == 1 { print $5 }\' /proc/self/mountinfo | LC_ALL=C sort -u)"',
    'expected_mounts="$(printf "%b\n" "$mount_points" | LC_ALL=C sort -u)"',
    '[ "$actual_mounts" = "$expected_mounts" ] || { printf "%s\n" "isolated mount allowlist mismatch" >&2; exit 72; }',
    'interfaces="$(find /sys/class/net -mindepth 1 -maxdepth 1 -printf "%f\n" | LC_ALL=C sort)"',
    '[ "$interfaces" = lo ] || { printf "%s\n" "isolated network namespace has unexpected interfaces" >&2; exit 73; }',
    'ip link set lo down',
    '[ "$(cat /sys/class/net/lo/operstate)" != up ] || { printf "%s\n" "loopback remained up" >&2; exit 74; }',
    `exec chroot "$sandbox_root" /usr/bin/setpriv --reuid "$worker_uid" --regid "$worker_gid" --clear-groups --no-new-privs /usr/bin/env -i PATH=/usr/bin:/bin TMPDIR=/tmp /runtime/node "$worker_script" --worker --run-id "$run_id" --source /input/source.db --output /output/output.db --lifecycle-fence-fd ${DEFAULT_LIFECYCLE_FENCE_FD} --lifecycle-fence-device "$fence_device" --lifecycle-fence-inode "$fence_inode"`
  ].join('\n');
  return Object.freeze({
    command: 'unshare',
    args: Object.freeze([
      '--mount', '--net', '--pid', '--fork', '--',
      'env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
      '/bin/bash', '-c', namespaceScript, 'tm-sanitizer-namespace',
      options.runId, String(options.uid), String(options.gid), nodePath, serverRoot,
      sourcePath, outputPath, sandboxRoot, workerPaths.script,
      options.lifecycleFenceDevice, options.lifecycleFenceInode,
      '--run-id', options.runId,
      '--lifecycle-fence-fd', String(DEFAULT_LIFECYCLE_FENCE_FD),
      '--lifecycle-fence-device', options.lifecycleFenceDevice,
      '--lifecycle-fence-inode', options.lifecycleFenceInode
    ]),
    worker: Object.freeze({ uid: options.uid, gid: options.gid, runId: options.runId }),
    mounts: Object.freeze({
      source: Object.freeze({ path: sourcePath, readOnly: true }),
      output: Object.freeze({ path: outputDirectory, readOnly: false })
    }),
    isolation: Object.freeze({
      root: sandboxRoot,
      rootFilesystem: 'tmpfs',
      hostRootVisible: false,
      procMounted: false,
      network: 'new-namespace-loopback-down',
      workerPaths,
      mounts: allowedMounts
    })
  });
}

function defaultCommandRunner(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    windowsHide: true
  });
}

function parsePasswdRecord(text, expectedName) {
  const line = String(text || '').trim();
  const fields = line.split(':');
  if (fields.length !== 7 || fields[0] !== expectedName) throw new Error('ephemeral user lookup returned an invalid passwd record');
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error('ephemeral user resolved to a privileged or invalid identity');
  }
  if (fields[5] !== '/nonexistent' || fields[6] !== '/usr/sbin/nologin') {
    throw new Error('ephemeral user has an unsafe home or shell');
  }
  return { name: expectedName, uid, gid };
}

function createEphemeralIdentity(options) {
  if (!options || !/^[0-9a-f]{32}$/.test(options.runId || '')) throw new Error('invalid ephemeral identity run id');
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const name = `tm-gate-${options.runId.slice(0, 12)}`;
  const create = commandRunner('useradd', [
    '--system', '--no-create-home', '--home-dir', '/nonexistent',
    '--shell', '/usr/sbin/nologin', '--user-group', name
  ]);
  if (!create || create.status !== 0) throw new Error(`ephemeral useradd failed: ${String(create?.stderr || '').trim()}`);
  try {
    const lookup = commandRunner('getent', ['passwd', name]);
    if (!lookup || lookup.status !== 0) throw new Error('ephemeral user lookup failed');
    return Object.freeze(parsePasswdRecord(lookup.stdout, name));
  } catch (error) {
    commandRunner('userdel', ['--force', name]);
    throw error;
  }
}

function removeEphemeralIdentity(identity, options = {}) {
  if (!identity || typeof identity.name !== 'string' || !/^tm-gate-[0-9a-f]{12}$/.test(identity.name)
      || !Number.isSafeInteger(identity.uid) || identity.uid <= 0
      || !Number.isSafeInteger(identity.gid) || identity.gid <= 0) {
    throw new Error('refusing to remove invalid ephemeral identity');
  }
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const lookup = commandRunner('getent', ['passwd', identity.name]);
  if (!lookup || lookup.status !== 0) return false;
  const observed = parsePasswdRecord(lookup.stdout, identity.name);
  if (observed.uid !== identity.uid || observed.gid !== identity.gid) throw new Error('ephemeral user identity changed before removal');
  const removed = commandRunner('userdel', ['--force', identity.name]);
  if (!removed || removed.status !== 0) throw new Error(`ephemeral userdel failed: ${String(removed?.stderr || '').trim()}`);
  return true;
}

function findRunBoundWorker(runId, uid) {
  if (process.platform !== 'linux') return null;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const uidMatch = status.match(/^Uid:\s+(\d+)/m);
      if (!uidMatch || Number(uidMatch[1]) !== uid) continue;
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      if (!argv.includes('--worker') || !argv.includes('--run-id') || !argv.includes(runId)) continue;
      return linuxProcessIdentity(pid, uid);
    } catch (_error) {}
  }
  return null;
}

function terminateRunBoundProcessGroup(request) {
  if (process.platform !== 'linux') throw new Error('run-bound process-group termination requires Linux');
  if (!request || !Number.isSafeInteger(request.processGroupId) || request.processGroupId <= 1
      || !request.identity) {
    throw new Error('invalid run-bound process group identity');
  }
  if (!/^[0-9a-f]{32}$/.test(request.runId || '')) throw new Error('invalid run-bound process group run id');
  if (!['SIGTERM', 'SIGKILL'].includes(request.signal)) throw new Error('invalid run-bound process group signal');
  const expected = normalizeProcessGroupIdentity(request.identity, request.processGroupId);
  try {
    process.kill(-request.processGroupId, 0);
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (!error || error.code !== 'EPERM') throw error;
  }
  let observed;
  try {
    observed = inspectProcessGroupLeader(expected.pid);
  } catch (error) {
    throw new Error(`run-bound process group identity is uncertain: ${error.message}`);
  }
  for (const key of ['pid', 'uid', 'startTimeTicks', 'exe', 'pgid']) {
    if (observed[key] !== expected[key]) throw new Error(`run-bound process group ${key} changed`);
  }
  try {
    process.kill(-request.processGroupId, request.signal);
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
  return true;
}

function isRunBoundProcessGroupAlive(request) {
  if (process.platform !== 'linux') throw new Error('run-bound process-group observation requires Linux');
  if (!request || !Number.isSafeInteger(request.processGroupId) || request.processGroupId <= 1
      || !request.identity) {
    throw new Error('invalid run-bound process group identity');
  }
  if (!/^[0-9a-f]{32}$/.test(request.runId || '')) throw new Error('invalid run-bound process group run id');
  try {
    process.kill(-request.processGroupId, 0);
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (error && error.code === 'EPERM') return true;
    throw error;
  }
  const expected = normalizeProcessGroupIdentity(request.identity, request.processGroupId);
  let observed;
  try {
    observed = inspectProcessGroupLeader(expected.pid);
  } catch (error) {
    throw new Error(`run-bound process group identity is uncertain: ${error.message}`);
  }
  for (const key of ['pid', 'uid', 'startTimeTicks', 'exe', 'pgid']) {
    if (observed[key] !== expected[key]) throw new Error(`run-bound process group ${key} changed`);
  }
  return true;
}

function workerTerminationFailure(code, runId, detail) {
  const error = new Error(`isolated sanitizer worker ${detail} (run ${runId})`);
  error.code = code;
  error.runId = runId;
  return error;
}

function launchIsolatedWorker(options) {
  if (!options || !/^[0-9a-f]{32}$/.test(options.runId || '')) {
    throw new Error('invalid isolated worker options');
  }
  const deadlineMs = options.deadlineMs === undefined ? DEFAULT_WORKER_DEADLINE_MS : options.deadlineMs;
  const terminationGraceMs = options.terminationGraceMs === undefined
    ? DEFAULT_WORKER_TERMINATION_GRACE_MS
    : options.terminationGraceMs;
  const killObservationMs = options.killObservationMs === undefined
    ? DEFAULT_WORKER_KILL_OBSERVATION_MS
    : options.killObservationMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('isolated worker deadline must be a positive integer');
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error('isolated worker termination grace must be a positive integer');
  }
  if (!Number.isSafeInteger(killObservationMs) || killObservationMs <= 0) {
    throw new Error('isolated worker kill observation deadline must be a positive integer');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new Error('isolated worker signal must be an AbortSignal');
  }
  const adapters = options.adapters || {};
  const lifecycleFence = options.lifecycleFence || null;
  if (lifecycleFence !== null && (
    !Number.isSafeInteger(lifecycleFence.fd) || lifecycleFence.fd < 3
      || !/^\d+$/.test(lifecycleFence.device || '') || !/^\d+$/.test(lifecycleFence.inode || '')
  )) {
    throw new Error('isolated worker lifecycle fence lease is invalid');
  }
  if (lifecycleFence === null && Object.keys(adapters).length === 0) {
    throw new Error('isolated worker requires an inherited lifecycle fence lease');
  }
  const buildLaunchPlan = adapters.buildLaunchPlan || buildIsolatedWorkerLaunch;
  const spawnProcess = adapters.spawnProcess || spawn;
  const inspectGroupLeader = adapters.inspectProcessGroupLeader || inspectProcessGroupLeader;
  const findWorker = adapters.findRunBoundWorker || findRunBoundWorker;
  const terminateProcessGroup = adapters.terminateProcessGroup || terminateRunBoundProcessGroup;
  const isProcessGroupAlive = adapters.isProcessGroupAlive || isRunBoundProcessGroupAlive;
  const plan = buildLaunchPlan({
    runId: options.runId,
    uid: options.identity.uid,
    gid: options.identity.gid,
    nodePath: process.execPath,
    scriptPath: __filename,
    serverRoot: path.resolve(__dirname, '..'),
    sourcePath: options.preparedSourcePath,
    outputPath: options.stagedOutputPath,
    sandboxRoot: options.sandboxRoot,
    ...(lifecycleFence ? {
      lifecycleFenceDevice: lifecycleFence.device,
      lifecycleFenceInode: lifecycleFence.inode
    } : {})
  });
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const reason = options.signal.reason instanceof Error
        ? options.signal.reason.message
        : String(options.signal.reason || 'AbortSignal');
      reject(workerTerminationFailure('TM_SANITIZER_WORKER_ABORTED', options.runId, `aborted by ${reason}`));
      return;
    }
    let child;
    try {
      const workerStdio = ['ignore', 'pipe', 'pipe'];
      if (lifecycleFence) {
        while (workerStdio.length <= DEFAULT_LIFECYCLE_FENCE_FD) workerStdio.push('ignore');
        workerStdio[DEFAULT_LIFECYCLE_FENCE_FD] = lifecycleFence.fd;
      }
      child = spawnProcess(plan.command, plan.args, {
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
        stdio: workerStdio,
        windowsHide: true,
        detached: true
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1
        || !child.stdout || !child.stderr || typeof child.once !== 'function') {
      reject(new Error('isolated worker spawn returned an invalid child process'));
      return;
    }
    const processGroupId = child.pid;
    let stdout = '';
    let stderr = '';
    let identityRecorded = false;
    let workerIdentityRecorded = false;
    let processGroupIdentity = null;
    let identityFailure = null;
    let childClosed = false;
    let processGroupExited = false;
    let closeCode = null;
    let closeSignal = null;
    let settled = false;
    let terminalFailure = null;
    let spawnFailure = null;
    let deadlineTimer = null;
    let escalationTimer = null;
    let killObservationTimer = null;
    let terminationHardTimer = null;
    let identityPoll = null;
    let processGroupPoll = null;
    try {
      processGroupIdentity = normalizeProcessGroupIdentity(inspectGroupLeader(processGroupId), processGroupId);
      if (!options.journal || typeof options.journal.recordProcessGroup !== 'function') {
        throw new Error('sanitizer journal cannot record the process group leader');
      }
      options.journal.recordProcessGroup(processGroupIdentity);
      identityRecorded = true;
    } catch (error) {
      identityFailure = workerTerminationFailure(
        'TM_SANITIZER_WORKER_IDENTITY_UNCERTAIN',
        options.runId,
        `could not persist detached process-group leader identity: ${error.message}`
      );
      if (!processGroupIdentity) identityFailure.cleanupUnsafe = true;
    }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (killObservationTimer) clearTimeout(killObservationTimer);
      if (terminationHardTimer) clearTimeout(terminationHardTimer);
      if (identityPoll) clearInterval(identityPoll);
      if (processGroupPoll) clearInterval(processGroupPoll);
      if (options.signal) options.signal.removeEventListener('abort', abortListener);
      if (error) reject(error);
      else resolve(value);
    };
    const signalGroup = (signal) => {
      if (!processGroupIdentity) {
        terminalFailure.message += `; ${signal} process-group termination refused without a verified identity`;
        terminalFailure.cleanupUnsafe = true;
        return false;
      }
      try {
        return terminateProcessGroup({
          runId: options.runId,
          processGroupId,
          identity: processGroupIdentity,
          signal
        });
      } catch (error) {
        if (terminalFailure) {
          terminalFailure.message += `; ${signal} process-group termination failed: ${error.message}`;
          terminalFailure.cleanupUnsafe = true;
        }
        return false;
      }
      return true;
    };
    const failCleanupUnsafe = (error, detail) => {
      const message = `${detail}: ${error.message}`;
      if (!terminalFailure) {
        terminalFailure = workerTerminationFailure(
          'TM_SANITIZER_WORKER_IDENTITY_UNCERTAIN',
          options.runId,
          message
        );
      } else {
        terminalFailure.message += `; ${message}`;
      }
      terminalFailure.cleanupUnsafe = true;
      finish(terminalFailure);
    };
    const settleAfterProcessExit = () => {
      if (!childClosed || !processGroupExited || settled) return;
      if (terminalFailure) return finish(terminalFailure);
      if (spawnFailure) return finish(spawnFailure);
      if (closeCode !== 0) {
        return finish(new Error(`isolated sanitizer worker failed (${closeSignal || closeCode}): ${stderr.trim()}`));
      }
      if (!identityRecorded) return finish(new Error('isolated sanitizer worker identity was not observed'));
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      try {
        finish(null, JSON.parse(lines.at(-1) || ''));
      } catch (_error) {
        finish(new Error('isolated sanitizer worker returned malformed report'));
      }
    };
    const observeProcessGroupExit = () => {
      if (settled) return;
      if (processGroupExited) {
        settleAfterProcessExit();
        return;
      }
      try {
        processGroupExited = !isProcessGroupAlive({
          runId: options.runId,
          processGroupId,
          identity: processGroupIdentity
        });
      } catch (error) {
        failCleanupUnsafe(error, 'process-group observation identity is uncertain');
        return;
      }
      if (processGroupExited) settleAfterProcessExit();
    };
    const requestTermination = (failure, journalState) => {
      if (terminalFailure) return;
      terminalFailure = failure;
      try {
        if (typeof options.journal.advance === 'function') options.journal.advance(journalState);
      } catch (error) {
        terminalFailure.message += `; termination journal update failed: ${error.message}`;
        terminalFailure.cleanupUnsafe = true;
      }
      if (signalGroup('SIGTERM') === false && terminalFailure.cleanupUnsafe) {
        finish(terminalFailure);
        return;
      }
      terminationHardTimer = setTimeout(() => {
        let stillAlive = true;
        try {
          stillAlive = isProcessGroupAlive({
            runId: options.runId,
            processGroupId,
            identity: processGroupIdentity
          });
        } catch (error) {
          failCleanupUnsafe(error, 'final process-group identity is uncertain');
          return;
        }
        if (stillAlive) {
          terminalFailure.message += '; worker termination exceeded its absolute hard deadline';
          terminalFailure.cleanupUnsafe = true;
        } else {
          processGroupExited = true;
        }
        finish(terminalFailure);
      }, terminationGraceMs + killObservationMs + 25);
      escalationTimer = setTimeout(() => {
        let alive = true;
        try {
          alive = isProcessGroupAlive({
            runId: options.runId,
            processGroupId,
            identity: processGroupIdentity
          });
        } catch (error) {
          failCleanupUnsafe(error, 'pre-SIGKILL process-group identity is uncertain');
          return;
        }
        if (!alive) {
          processGroupExited = true;
          settleAfterProcessExit();
          return;
        }
        if (signalGroup('SIGKILL') === false && terminalFailure.cleanupUnsafe) {
          finish(terminalFailure);
          return;
        }
        killObservationTimer = setTimeout(() => {
          let stillAlive = true;
          try {
            stillAlive = isProcessGroupAlive({
              runId: options.runId,
              processGroupId,
              identity: processGroupIdentity
            });
          } catch (error) {
            failCleanupUnsafe(error, 'post-SIGKILL process-group identity is uncertain');
            return;
          }
          if (stillAlive) {
            terminalFailure.message += `; process group remained alive after the ${killObservationMs}ms post-SIGKILL observation deadline`;
            terminalFailure.cleanupUnsafe = true;
          } else {
            processGroupExited = true;
          }
          finish(terminalFailure);
        }, killObservationMs);
      }, terminationGraceMs);
    };
    const abortListener = () => {
      const reason = options.signal.reason instanceof Error
        ? options.signal.reason.message
        : String(options.signal.reason || 'AbortSignal');
      requestTermination(
        workerTerminationFailure('TM_SANITIZER_WORKER_ABORTED', options.runId, `aborted by ${reason}`),
        'worker-abort-termination-requested'
      );
    };
    const collect = (target, chunk) => {
      const next = target + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > 1024 * 1024) throw new Error('isolated worker output exceeded limit');
      return next;
    };
    child.stdout.on('data', (chunk) => {
      try { stdout = collect(stdout, chunk); }
      catch (error) { requestTermination(error, 'worker-output-termination-requested'); }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = collect(stderr, chunk); }
      catch (error) { requestTermination(error, 'worker-output-termination-requested'); }
    });
    identityPoll = setInterval(() => {
      if (workerIdentityRecorded || typeof options.journal.recordWorker !== 'function') return;
      try {
        const identity = findWorker(options.runId, options.identity.uid);
        if (identity) {
          options.journal.recordWorker(identity);
          workerIdentityRecorded = true;
        }
      } catch (error) {
        requestTermination(error, 'worker-identity-termination-requested');
      }
    }, 20);
    child.once('error', (error) => {
      spawnFailure = error;
    });
    child.once('close', (code, signal) => {
      childClosed = true;
      closeCode = code;
      closeSignal = signal;
      if (processGroupExited) settleAfterProcessExit();
      else observeProcessGroupExit();
    });
    processGroupPoll = setInterval(observeProcessGroupExit, 20);
    deadlineTimer = setTimeout(() => {
      requestTermination(
        workerTerminationFailure(
          'TM_SANITIZER_WORKER_TIMEOUT',
          options.runId,
          `exceeded the ${deadlineMs}ms production deadline`
        ),
        'worker-timeout-termination-requested'
      );
    }, deadlineMs);
    if (options.signal) options.signal.addEventListener('abort', abortListener, { once: true });
    if (identityFailure) requestTermination(identityFailure, 'worker-identity-termination-requested');
    if (options.signal?.aborted) abortListener();
  });
}

function secureCreateEmptyFile(filePath, mode = 0o600) {
  const noFollow = process.platform === 'linux' ? (fs.constants.O_NOFOLLOW || 0) : 0;
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    mode
  );
  try {
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(filePath));
}

function fileIdentity(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    sha256: sha256(fs.readFileSync(filePath))
  });
}

function ownershipIdentityFromStat(stat) {
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString()
  });
}

function pathOwnershipIdentity(filePath, label = 'owned path') {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`${label} must remain a regular non-symlink path`);
  }
  return ownershipIdentityFromStat(stat);
}

function fileOwnershipIdentity(filePath, label = 'owned file') {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must remain a regular non-symlink file`);
  return ownershipIdentityFromStat(stat);
}

function sameOwnershipIdentity(left, right) {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode);
}

function validOwnershipIdentity(identity) {
  return Boolean(identity
    && /^\d+$/.test(identity.device || '')
    && /^\d+$/.test(identity.inode || ''));
}

function cleanupIdentityError(label) {
  const error = new Error(`${label} identity changed; refusing to remove a non-owned path`);
  error.code = 'TM_SANITIZER_FILE_IDENTITY_UNCERTAIN';
  error.cleanupUnsafe = true;
  return error;
}

function assertOwnershipIdentity(filePath, expected, label) {
  const stat = lstatNoFollowIfPresent(filePath, { bigint: true });
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) throw cleanupIdentityError(label);
  const actual = ownershipIdentityFromStat(stat);
  if (!sameOwnershipIdentity(actual, expected)) throw cleanupIdentityError(label);
  return actual;
}

function assertDirectoryOwnershipIdentity(directoryPath, expected, label) {
  const stat = lstatNoFollowIfPresent(directoryPath, { bigint: true });
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) throw cleanupIdentityError(label);
  const actual = ownershipIdentityFromStat(stat);
  if (!sameOwnershipIdentity(actual, expected)) throw cleanupIdentityError(label);
  return actual;
}

function bindOwnedFile(ownership, filePath, label) {
  const resolved = path.resolve(filePath);
  const identity = fileOwnershipIdentity(resolved, label);
  ownership.set(resolved, identity);
  return identity;
}

function unlinkOwnedFile(ownership, filePath, label) {
  const resolved = path.resolve(filePath);
  const expected = ownership.get(resolved);
  const stat = lstatNoFollowIfPresent(resolved, { bigint: true });
  if (!expected) {
    if (stat !== null) throw cleanupIdentityError(label);
    return false;
  }
  if (stat === null) {
    ownership.delete(resolved);
    return false;
  }
  assertOwnershipIdentity(resolved, expected, label);
  fs.unlinkSync(resolved);
  ownership.delete(resolved);
  return true;
}

function publishOwnedFileNoReplace(ownership, stagedPath, outputPath, onLinked) {
  const stage = path.resolve(stagedPath);
  const output = path.resolve(outputPath);
  const expected = ownership.get(stage);
  if (!expected) throw cleanupIdentityError('publication staging file');
  assertOwnershipIdentity(stage, expected, 'publication staging file');
  try {
    fs.linkSync(stage, output);
  } catch (error) {
    const outputStat = lstatNoFollowIfPresent(output, { bigint: true });
    if (outputStat !== null && (!outputStat.isFile() || outputStat.isSymbolicLink())) {
      throw cleanupIdentityError('published output');
    }
    if (outputStat !== null && error?.code !== 'EEXIST') {
      ownership.set(output, expected);
      error.message += '; publication result identity is uncertain';
      error.cleanupUnsafe = true;
    }
    throw error;
  }
  ownership.set(output, expected);
  assertOwnershipIdentity(output, expected, 'published output');
  if (onLinked) onLinked(expected);
  unlinkOwnedFile(ownership, stage, 'publication staging file');
  fsyncDirectory(path.dirname(output));
  return expected;
}

function assertFileIdentity(filePath, expected, label) {
  const actual = fileIdentity(filePath);
  for (const key of ['device', 'inode', 'size', 'mtimeNs', 'sha256']) {
    if (actual[key] !== expected[key]) throw new Error(`${label} changed after checkpoint`);
  }
  return actual;
}

function vacuumIntoOwnedStage(db, outputPath, options = {}) {
  const ownership = options.ownership || new Map();
  const label = options.label || 'VACUUM output';
  const journalName = options.journalName || 'vacuumStage';
  let identity = null;
  try {
    secureCreateEmptyFile(outputPath, 0o600);
    identity = bindOwnedFile(ownership, outputPath, label);
    if (!options.journal || typeof options.journal.recordPathIdentity !== 'function') {
      throw new Error(`${label} is missing its cleanup journal binding`);
    }
    options.journal.recordPathIdentity(journalName, outputPath, identity);
    assertOwnershipIdentity(outputPath, identity, label);
    db.exec(`VACUUM INTO ${quoteLiteral(outputPath)}`);
    assertOwnershipIdentity(outputPath, identity, label);
    fs.chmodSync(outputPath, 0o600);
    zeroSqliteNonLiveRegions(outputPath);
    fsyncFile(outputPath);
    rejectSidecars(outputPath, label);
    return identity;
  } catch (error) {
    if (identity || ownership.has(path.resolve(outputPath))) {
      try {
        unlinkOwnedFile(ownership, outputPath, label);
        fsyncDirectory(path.dirname(outputPath));
      } catch (cleanupError) {
        error.message += `; ${label} cleanup remains journaled: ${cleanupError.message}`;
        error.cleanupUnsafe = true;
      }
    }
    throw error;
  }
}

function preparePrivilegedSource(options) {
  if (!options || typeof options.sourcePath !== 'string' || typeof options.preparedPath !== 'string') {
    throw new Error('sourcePath and preparedPath are required for privileged preparation');
  }
  if (options.requireRoot !== false) assertProductionCoordinatorEnvironment();
  const sourcePath = assertRegularDatabaseFile(options.sourcePath, 'production source database');
  const preparedPath = assertRegularDatabaseFile(options.preparedPath, 'prepared scrubbed source', { mustExist: false });
  const rawPath = `${preparedPath}.root-raw`;
  assertRegularDatabaseFile(rawPath, 'root compact source', { mustExist: false });
  const manifestDocument = options.manifest || JSON.parse(fs.readFileSync(
    options.manifestPath || path.join(__dirname, 'sanitization_manifest.json'),
    'utf8'
  ));
  let sourceDb;
  let rawDb;
  let checkpointIdentity;
  let sourceProfile;
  const ownership = options.ownership || new Map();
  const journal = options.journal;
  try {
    sourceDb = new Database(sourcePath, { fileMustExist: true });
    sourceProfile = validateManifest(manifestDocument, sourceDb);
    const checkpoint = sourceDb.pragma('wal_checkpoint(TRUNCATE)');
    if (checkpoint.some((row) => Number(row.busy || 0) !== 0)) throw new Error('source WAL checkpoint remained busy');
    sourceDb.exec('BEGIN EXCLUSIVE; COMMIT;');
    checkpointIdentity = fileIdentity(sourcePath);
    const secretOnlyManifest = secretOnlySanitizationManifest(sourceProfile);
    const secretSourceProbes = collectSecretOnlySourceProbes(sourceDb, sourceProfile);
    vacuumIntoOwnedStage(sourceDb, rawPath, {
      ownership,
      journal,
      journalName: options.rawJournalName || 'preparedRaw',
      label: 'root compact source'
    });
    assertFileIdentity(sourcePath, checkpointIdentity, 'source database');
    sourceDb.close();
    sourceDb = null;

    rawDb = new Database(rawPath);
    const rawProfile = validateManifest(manifestDocument, rawDb);
    if (rawProfile.schemaVersion !== sourceProfile.schemaVersion) {
      throw new Error('prepared source changed exact sanitization profile');
    }
    sanitizeBaseTables(rawDb, secretOnlyManifest, {
      secretProbes: secretSourceProbes,
      replacementDomain: secretSourceProbes.replacementDomain
    });
    sqliteDigest.rebuildKnowledgeChunksFts(rawDb);
    sqliteDigest.verifyKnowledgeChunksFtsIntegrity(rawDb, FTS_MANIFEST, { checkMainIntegrity: true });
    rawDb.pragma('wal_checkpoint(TRUNCATE)');
    vacuumIntoOwnedStage(rawDb, preparedPath, {
      ownership,
      journal,
      journalName: options.preparedJournalName || 'preparedSource',
      label: 'prepared scrubbed source'
    });
    assertNoSecretCopies(preparedPath, secretSourceProbes, sourceProfile);
    rawDb.close();
    rawDb = null;
    fs.chmodSync(preparedPath, 0o400);
    assertFileIdentity(sourcePath, checkpointIdentity, 'source database');
    return Object.freeze({
      sourceIdentity: checkpointIdentity,
      preparedPath,
      preparedIdentity: fileIdentity(preparedPath)
    });
  } catch (error) {
    if (ownership.has(path.resolve(preparedPath))) {
      try { unlinkOwnedFile(ownership, preparedPath, 'prepared scrubbed source'); }
      catch (cleanupError) {
        error.message += `; prepared source cleanup remains journaled: ${cleanupError.message}`;
        error.cleanupUnsafe = true;
      }
    }
    throw error;
  } finally {
    if (rawDb) rawDb.close();
    if (sourceDb) sourceDb.close();
    if (ownership.has(path.resolve(rawPath))) {
      try { unlinkOwnedFile(ownership, rawPath, 'root compact source'); }
      catch (cleanupError) { throw cleanupError; }
    }
    fsyncDirectory(path.dirname(preparedPath));
  }
}

function sidecarPaths(databasePath) {
  return ['-journal', '-wal', '-shm'].map((suffix) => `${databasePath}${suffix}`);
}

function rejectSidecars(databasePath, label) {
  const sidecar = sidecarPaths(databasePath).find((candidate) => lstatNoFollowIfPresent(candidate) !== null);
  if (sidecar) throw new Error(`${label} has forbidden SQLite sidecar ${path.basename(sidecar)}`);
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(directoryPath) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directoryPath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWriteJournal(journalPath, payload, createOnly = false, expectedIdentity = null) {
  const resolved = path.resolve(journalPath);
  const existing = lstatNoFollowIfPresent(resolved);
  if (createOnly && existing !== null) throw new Error('sanitizer run journal already exists');
  if (existing !== null) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('invalid sanitizer run journal');
  }
  const temporary = `${resolved}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let fd = null;
  let temporaryIdentity = null;
  let operationError = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    temporaryIdentity = ownershipIdentityFromStat(fs.fstatSync(fd, { bigint: true }));
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (createOnly) {
      fs.linkSync(temporary, resolved);
    } else {
      if (!expectedIdentity) throw new Error('sanitizer journal update is missing its bound identity');
      assertOwnershipIdentity(resolved, expectedIdentity, 'sanitizer run journal');
      fs.renameSync(temporary, resolved);
      temporaryIdentity = null;
    }
    fsyncDirectory(path.dirname(resolved));
    return fileOwnershipIdentity(resolved, 'sanitizer run journal');
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (error) {
        if (operationError) operationError.message += `; journal temp close failed: ${error.message}`;
        else throw error;
      }
    }
    if (temporaryIdentity && lstatNoFollowIfPresent(temporary) !== null) {
      try {
        assertOwnershipIdentity(temporary, temporaryIdentity, 'sanitizer journal temporary file');
        fs.unlinkSync(temporary);
        fsyncDirectory(path.dirname(resolved));
      } catch (error) {
        if (operationError) {
          operationError.message += `; journal temp cleanup failed: ${error.message}`;
          operationError.cleanupUnsafe = true;
        } else {
          throw error;
        }
      }
    }
  }
}

function linuxProcessIdentity(pid = process.pid, uidOverride) {
  let startTimeTicks = null;
  let exe = pid === process.pid ? process.execPath : null;
  let pgid = null;
  let observedUid = typeof process.getuid === 'function' && pid === process.pid ? process.getuid() : null;
  if (process.platform === 'linux') {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = statText.lastIndexOf(') ');
    if (commandEnd < 0) throw new Error(`malformed process stat for pid ${pid}`);
    const fieldsAfterCommand = statText.slice(commandEnd + 2).trim().split(/\s+/);
    startTimeTicks = fieldsAfterCommand[19];
    pgid = Number(fieldsAfterCommand[2]);
    exe = fs.readlinkSync(`/proc/${pid}/exe`);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const uidMatch = status.match(/^Uid:\s+(\d+)/m);
    if (!uidMatch) throw new Error(`missing process uid for pid ${pid}`);
    observedUid = Number(uidMatch[1]);
  }
  if (uidOverride !== undefined && observedUid !== null && observedUid !== uidOverride) {
    throw new Error(`process uid mismatch for pid ${pid}`);
  }
  const uid = uidOverride === undefined ? observedUid : uidOverride;
  return Object.freeze({ pid, uid, startTimeTicks, exe, pgid });
}

function normalizeProcessGroupIdentity(identity, expectedPid) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 1
      || identity.pid !== expectedPid
      || !Number.isSafeInteger(identity.uid) || identity.uid < 0
      || !/^\d+$/.test(identity.startTimeTicks || '')
      || typeof identity.exe !== 'string' || !path.isAbsolute(identity.exe)
      || !Number.isSafeInteger(identity.pgid) || identity.pgid !== identity.pid) {
    throw new Error('invalid detached process-group leader identity');
  }
  return Object.freeze({
    pid: identity.pid,
    uid: identity.uid,
    startTimeTicks: identity.startTimeTicks,
    exe: identity.exe,
    pgid: identity.pgid
  });
}

function inspectProcessGroupLeader(pid) {
  return normalizeProcessGroupIdentity(linuxProcessIdentity(pid), pid);
}

function writeNewJournal(journalPath, payload) {
  const noFollow = process.platform === 'linux' ? (fs.constants.O_NOFOLLOW || 0) : 0;
  const fd = fs.openSync(
    journalPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    0o600
  );
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(journalPath));
  return fileOwnershipIdentity(journalPath, 'sanitizer run journal');
}

function createRunJournal(options) {
  if (!options || !/^[0-9a-f]{32}$/.test(options.runId || '')) throw new Error('invalid sanitizer journal run id');
  if (options.requireRoot !== false) assertProductionCoordinatorEnvironment();
  const journalRoot = path.resolve(options.journalRoot || '/var/lib/turingmarket/migration-gate');
  const rootStat = fs.lstatSync(journalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid sanitizer journal root');
  const journalPath = path.join(journalRoot, `${options.runId}.run.json`);
  const cleanupPaths = Object.fromEntries(Object.entries(options.cleanupPaths || {}).map(([name, target]) => [
    name,
    { path: path.resolve(target), cleanup: true, identity: null }
  ]));
  const payload = {
    format: 'tm-sanitizer-run-journal-v4',
    runId: options.runId,
    createdAt: new Date().toISOString(),
    state: 'journaled',
    coordinator: linuxProcessIdentity(),
    processGroup: null,
    worker: null,
    unit: { name: null, active: false },
    mount: { path: null, source: null, mounted: false },
    ephemeralUser: { name: null, uid: null, gid: null },
    paths: {
      source: { path: path.resolve(options.sourcePath), cleanup: false },
      output: { path: path.resolve(options.outputPath), cleanup: false },
      ...cleanupPaths
    }
  };
  let journalIdentity = writeNewJournal(journalPath, payload);
  const persist = () => {
    payload.updatedAt = new Date().toISOString();
    journalIdentity = atomicWriteJournal(journalPath, payload, false, journalIdentity);
  };
  const unlink = () => {
    if (lstatNoFollowIfPresent(journalPath) !== null) {
      assertOwnershipIdentity(journalPath, journalIdentity, 'sanitizer run journal');
      fs.unlinkSync(journalPath);
    }
    fsyncDirectory(journalRoot);
  };
  return Object.freeze({
    path: journalPath,
    payload,
    advance(state) {
      payload.state = state;
      persist();
    },
    recordProcessGroup(identity) {
      const normalized = normalizeProcessGroupIdentity(identity, identity?.pid);
      payload.processGroup = normalized;
      payload.state = 'worker-group-recorded';
      persist();
    },
    recordWorker(identity) {
      if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1
          || !Number.isSafeInteger(identity.uid) || identity.uid <= 0
          || !/^\d+$/.test(identity.startTimeTicks || '')
          || typeof identity.exe !== 'string' || !path.isAbsolute(identity.exe)) {
        throw new Error('invalid sanitizer worker process identity');
      }
      payload.worker = {
        pid: identity.pid,
        uid: identity.uid,
        startTimeTicks: identity.startTimeTicks,
        exe: identity.exe
      };
      persist();
    },
    recordEphemeralUser(identity) {
      payload.ephemeralUser = { name: identity.name, uid: identity.uid, gid: identity.gid };
      persist();
    },
    recordPathIdentity(name, filePath, identity, cleanup = true) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name || '') || !validOwnershipIdentity(identity)) {
        throw new Error('invalid sanitizer cleanup path identity');
      }
      payload.paths[name] = {
        path: path.resolve(filePath),
        cleanup,
        identity: { device: identity.device, inode: identity.inode }
      };
      persist();
    },
    complete() {
      payload.state = 'complete';
      persist();
      unlink();
    },
    unlink
  });
}

function removeCoordinatorRunDirectory(runDirectory, runRoot, expectedIdentity) {
  const resolvedRun = path.resolve(runDirectory);
  const resolvedRoot = path.resolve(runRoot);
  if (resolvedRun === resolvedRoot || !resolvedRun.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('coordinator cleanup path escaped run root');
  }
  if (!expectedIdentity) {
    if (lstatNoFollowIfPresent(resolvedRun) !== null) throw cleanupIdentityError('coordinator run directory');
    return;
  }
  if (lstatNoFollowIfPresent(resolvedRun) !== null) {
    assertDirectoryOwnershipIdentity(resolvedRun, expectedIdentity, 'coordinator run directory');
    fs.rmSync(resolvedRun, { recursive: true, force: false });
  }
  fsyncDirectory(resolvedRoot);
}

async function runProductionCoordinator(options) {
  if (!options || typeof options.sourcePath !== 'string' || typeof options.outputPath !== 'string') {
    throw new Error('sourcePath and outputPath are required for production coordinator');
  }
  let lifecycleFence = null;
  if (options.requireRoot !== false) {
    assertProductionCoordinatorEnvironment();
    lifecycleFence = acquireProductionLifecycleFence({
      fencePath: options.lifecycleFencePath
        || process.env.TM_SANITIZER_LIFECYCLE_FENCE
        || DEFAULT_LIFECYCLE_FENCE_PATH,
      inheritedFd: options.lifecycleFenceFd,
      requireRoot: true
    });
  }
  try {
    return await runProductionCoordinatorWithLifecycleFence(options, lifecycleFence);
  } finally {
    if (lifecycleFence) lifecycleFence.release();
  }
}

async function runProductionCoordinatorWithLifecycleFence(options, lifecycleFence) {
  if (options.requireRoot !== false && !lifecycleFence) {
    throw new Error('production coordinator is missing its verified lifecycle fence lease');
  }
  const sourcePath = assertRegularDatabaseFile(options.sourcePath, 'production source database');
  const outputPath = assertRegularDatabaseFile(options.outputPath, 'production sanitized output', { mustExist: false });
  const sourceRoot = path.resolve(options.sourceRoot || path.dirname(sourcePath));
  const outputRoot = path.resolve(options.outputRoot || path.dirname(outputPath));
  const coordinatorUid = process.platform === 'linux' && typeof process.getuid === 'function' ? process.getuid() : undefined;
  const privateModes = (root, required) => {
    if (process.platform === 'linux') return required;
    return [...new Set([...required, fs.lstatSync(root).mode & 0o777])];
  };
  const sourceValidation = validateSecurePath(sourcePath, {
    root: sourceRoot,
    expectedUid: coordinatorUid,
    directoryModes: privateModes(sourceRoot, [0o700]),
    fileModes: process.platform === 'linux' ? [0o400, 0o600] : [fs.lstatSync(sourcePath).mode & 0o777],
    mustExist: true,
    rejectMounts: true
  });
  const outputValidation = validateSecurePath(outputPath, {
    root: outputRoot,
    expectedUid: coordinatorUid,
    directoryModes: privateModes(outputRoot, [0o700]),
    mustExist: false,
    rejectMounts: true
  });
  const journalRoot = path.resolve(options.journalRoot || '/var/lib/turingmarket/migration-gate');
  const runRoot = path.resolve(options.runRoot || '/run/turingmarket-gate');
  fs.mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(journalRoot, 0o700);
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o711 });
  fs.chmodSync(runRoot, 0o711);
  validateSecurePath(journalRoot, {
    root: journalRoot, expectedUid: coordinatorUid,
    directoryModes: privateModes(journalRoot, [0o700]), mustExist: true, rejectMounts: true
  });
  validateSecurePath(runRoot, {
    root: runRoot, expectedUid: coordinatorUid,
    directoryModes: privateModes(runRoot, [0o711]), mustExist: true, rejectMounts: true
  });
  const runId = options.runId || crypto.randomBytes(16).toString('hex');
  const runDirectory = path.join(runRoot, runId);
  const preparedDirectory = path.join(runDirectory, 'source');
  const outputDirectory = path.join(runDirectory, 'output');
  const sandboxRoot = path.join(runDirectory, 'sandbox-root');
  const preparedSourcePath = path.join(preparedDirectory, 'source.db');
  const stagedOutputPath = path.join(outputDirectory, 'output.db');
  const publicationStagePath = path.join(outputRoot, `.${path.basename(outputPath)}.tm-stage-${runId}`);
  const ownership = new Map();
  let runDirectoryIdentity = null;
  validateSecurePath(publicationStagePath, {
    root: outputRoot,
    expectedUid: coordinatorUid,
    directoryModes: privateModes(outputRoot, [0o700]),
    mustExist: false,
    rejectMounts: true
  });
  const journal = createRunJournal({
    journalRoot,
    runId,
    sourcePath,
    outputPath,
    cleanupPaths: { runDirectory, publicationStage: publicationStagePath },
    requireRoot: options.requireRoot
  });
  let ephemeralIdentity = null;
  try {
    journal.advance('prescrub-copy-intent');
    fs.mkdirSync(runDirectory, { mode: 0o700 });
    runDirectoryIdentity = pathOwnershipIdentity(runDirectory, 'coordinator run directory');
    journal.recordPathIdentity(
      'runDirectory',
      runDirectory,
      runDirectoryIdentity
    );
    fs.mkdirSync(preparedDirectory, { mode: 0o700 });
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    fs.mkdirSync(sandboxRoot, { mode: 0o700 });
    validateSecurePath(preparedSourcePath, {
      root: preparedDirectory, expectedUid: coordinatorUid,
      directoryModes: privateModes(preparedDirectory, [0o700]), mustExist: false, rejectMounts: true
    });
    validateSecurePath(stagedOutputPath, {
      root: outputDirectory, expectedUid: coordinatorUid,
      directoryModes: privateModes(outputDirectory, [0o700]), mustExist: false, rejectMounts: true
    });
    validateSecurePath(sandboxRoot, {
      root: sandboxRoot, expectedUid: coordinatorUid,
      directoryModes: privateModes(sandboxRoot, [0o700]), mustExist: true, rejectMounts: true
    });
    const prepareSource = options.preparePrivilegedSource || preparePrivilegedSource;
    const prepared = prepareSource({
      sourcePath,
      preparedPath: preparedSourcePath,
      manifest: options.manifest,
      manifestPath: options.manifestPath,
      ownership,
      journal,
      requireRoot: options.requireRoot
    });
    validateSecurePath(preparedSourcePath, {
      root: preparedDirectory, expectedUid: coordinatorUid,
      directoryModes: privateModes(preparedDirectory, [0o700]),
      fileModes: process.platform === 'linux' ? [0o400] : [fs.lstatSync(preparedSourcePath).mode & 0o777],
      mustExist: true, rejectMounts: true
    });
    journal.advance('prescrub-staged');
    const createIdentity = options.createEphemeralIdentity || createEphemeralIdentity;
    ephemeralIdentity = await createIdentity({ runId, runDirectory, outputDirectory });
    if (!ephemeralIdentity || !Number.isSafeInteger(ephemeralIdentity.uid) || ephemeralIdentity.uid <= 0
        || !Number.isSafeInteger(ephemeralIdentity.gid) || ephemeralIdentity.gid <= 0
        || typeof ephemeralIdentity.name !== 'string') {
      throw new Error('invalid ephemeral worker identity');
    }
    journal.recordEphemeralUser(ephemeralIdentity);
    if (options.requireRoot !== false) {
      fs.chmodSync(runDirectory, 0o711);
      fs.chmodSync(preparedDirectory, 0o711);
      fs.chownSync(preparedSourcePath, ephemeralIdentity.uid, ephemeralIdentity.gid);
      fs.chmodSync(preparedSourcePath, 0o400);
      fs.chownSync(outputDirectory, ephemeralIdentity.uid, ephemeralIdentity.gid);
      fs.chmodSync(outputDirectory, 0o700);
    }
    const workerFileUid = options.requireRoot === false ? coordinatorUid : ephemeralIdentity.uid;
    validateSecurePath(stagedOutputPath, {
      root: outputDirectory, expectedUid: workerFileUid,
      directoryModes: privateModes(outputDirectory, [0o700]), mustExist: false, rejectMounts: true
    });
    journal.advance('unprivileged-stage-ready');
    const launchWorker = options.launchWorker || launchIsolatedWorker;
    journal.advance('worker-launch-intent');
    const workerResult = await launchWorker({
      runId,
      identity: ephemeralIdentity,
      preparedSourcePath,
      stagedOutputPath,
      sandboxRoot,
      journal,
      signal: options.signal,
      deadlineMs: options.workerDeadlineMs,
      terminationGraceMs: options.workerTerminationGraceMs,
      killObservationMs: options.workerKillObservationMs,
      lifecycleFence,
      adapters: options.workerAdapters
    });
    const workerOutputIdentity = bindOwnedFile(ownership, stagedOutputPath, 'isolated sanitized output');
    journal.recordPathIdentity('workerOutput', stagedOutputPath, workerOutputIdentity);
    journal.advance('logical-sanitization-complete');
    assertFileIdentity(sourcePath, prepared.sourceIdentity, 'source database');
    validateSecurePath(stagedOutputPath, {
      root: outputDirectory, expectedUid: workerFileUid,
      directoryModes: privateModes(outputDirectory, [0o700]),
      fileModes: process.platform === 'linux' ? [0o400, 0o600] : [fs.lstatSync(stagedOutputPath).mode & 0o777],
      mustExist: true, rejectMounts: true
    });
    rejectSidecars(stagedOutputPath, 'isolated sanitized output');
    fs.chmodSync(stagedOutputPath, 0o600);
    fsyncFile(stagedOutputPath);
    assertFileIdentity(sourcePath, prepared.sourceIdentity, 'source database');
    validateSecurePath(publicationStagePath, {
      root: outputRoot, expectedUid: coordinatorUid,
      directoryModes: privateModes(outputRoot, [0o700]), mustExist: false, rejectMounts: true
    });
    fs.copyFileSync(stagedOutputPath, publicationStagePath, fs.constants.COPYFILE_EXCL);
    const publicationStageIdentity = bindOwnedFile(ownership, publicationStagePath, 'publication staging file');
    journal.recordPathIdentity('publicationStage', publicationStagePath, publicationStageIdentity);
    fs.chmodSync(publicationStagePath, 0o600);
    fsyncFile(publicationStagePath);
    const publicationValidation = validateSecurePath(publicationStagePath, {
      root: outputRoot, expectedUid: coordinatorUid,
      directoryModes: privateModes(outputRoot, [0o700]),
      fileModes: process.platform === 'linux' ? [0o600] : [fs.lstatSync(publicationStagePath).mode & 0o777],
      mustExist: true, rejectMounts: true
    });
    if (publicationValidation.device !== outputValidation.device) throw new Error('publication staging crossed output filesystems');
    assertFileIdentity(sourcePath, prepared.sourceIdentity, 'source database');
    publishOwnedFileNoReplace(ownership, publicationStagePath, outputPath, (identity) => {
      journal.recordPathIdentity('publishedOutput', outputPath, identity);
    });
    fsyncFile(outputPath);
    fsyncDirectory(path.dirname(outputPath));
    validateSecurePath(outputPath, {
      root: outputRoot, expectedUid: coordinatorUid,
      directoryModes: privateModes(outputRoot, [0o700]),
      fileModes: process.platform === 'linux' ? [0o600] : [fs.lstatSync(outputPath).mode & 0o777],
      mustExist: true, rejectMounts: true
    });
    if (sourceValidation.path !== sourcePath) throw new Error('source secure-path identity changed');
    journal.advance('compact-scan-complete');
    const removeIdentity = options.removeEphemeralIdentity || removeEphemeralIdentity;
    await removeIdentity(ephemeralIdentity);
    ephemeralIdentity = null;
    removeCoordinatorRunDirectory(runDirectory, runRoot, runDirectoryIdentity);
    runDirectoryIdentity = null;
    journal.complete();
    return workerResult;
  } catch (error) {
    if (error.cleanupUnsafe) {
      error.message += '; coordinator cleanup retained the journal, process identity, and run resources';
      throw error;
    }
    try {
      for (const [candidate, label] of [
        [outputPath, 'published output'],
        [publicationStagePath, 'publication staging file']
      ]) {
        const expected = ownership.get(path.resolve(candidate));
        if (expected && lstatNoFollowIfPresent(candidate) !== null) assertOwnershipIdentity(candidate, expected, label);
      }
    } catch (caught) {
      error.message += `; coordinator cleanup retained resources: ${caught.message}`;
      error.cleanupUnsafe = true;
      throw error;
    }
    if (ownership.has(path.resolve(outputPath))) unlinkOwnedFile(ownership, outputPath, 'published output');
    if (ownership.has(path.resolve(publicationStagePath))) {
      unlinkOwnedFile(ownership, publicationStagePath, 'publication staging file');
    }
    let cleanupError = null;
    try {
      if (ephemeralIdentity) {
        const removeIdentity = options.removeEphemeralIdentity || removeEphemeralIdentity;
        await removeIdentity(ephemeralIdentity);
        ephemeralIdentity = null;
      }
      if (runDirectoryIdentity) {
        removeCoordinatorRunDirectory(runDirectory, runRoot, runDirectoryIdentity);
        runDirectoryIdentity = null;
      }
    } catch (caught) {
      cleanupError = caught;
    }
    if (!cleanupError) {
      try { journal.unlink(); } catch (caught) { cleanupError = caught; }
    }
    if (cleanupError) throw new Error(`${error.message}; coordinator cleanup remains journaled: ${cleanupError.message}`);
    throw error;
  }
}

function journalController(options, paths) {
  if (options.disableJournal === true) {
    return Object.freeze({
      journalPath: null,
      payload: null,
      advance() {},
      complete() {},
      unlink() {},
      recordPathIdentity() {}
    });
  }
  const journalPath = path.resolve(options.journalPath || `${paths.output}.run.json`);
  const payload = {
    format: 'tm-sanitizer-run-journal-v1',
    runId: crypto.randomBytes(16).toString('hex'),
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    createdAt: new Date().toISOString(),
    state: 'journaled',
    unit: {
      name: process.env.TM_GATE_SYSTEMD_UNIT || null,
      active: process.env.TM_GATE_SYSTEMD_UNIT_ACTIVE === '1'
    },
    mount: {
      path: process.env.TM_GATE_MOUNT_PATH || null,
      source: process.env.TM_GATE_MOUNT_SOURCE || null,
      mounted: process.env.TM_GATE_MOUNTED === '1'
    },
    ephemeralUser: {
      name: process.env.TM_GATE_EPHEMERAL_USER || null
    },
    paths: {
      source: { path: paths.source, cleanup: false },
      output: { path: paths.output, cleanup: false },
      preScrub: { path: paths.preScrub, cleanup: true },
      working: { path: paths.working, cleanup: true },
      publish: { path: paths.publish, cleanup: true }
    }
  };
  const ownership = options._ownedFiles || new Map();
  let journalIdentity = atomicWriteJournal(journalPath, payload, true);
  ownership.set(journalPath, journalIdentity);
  const persist = () => {
    payload.updatedAt = new Date().toISOString();
    journalIdentity = atomicWriteJournal(journalPath, payload, false, journalIdentity);
    ownership.set(journalPath, journalIdentity);
  };
  const advance = (state) => {
    payload.state = state;
    persist();
    if (options.failAfterPhase === state || process.env.TM_SANITIZER_FAIL_AFTER_PHASE === state) {
      throw new Error(`injected sanitizer failure after ${state}`);
    }
    if (process.env.TM_SANITIZER_KILL_AFTER_PHASE === state) process.kill(process.pid, 'SIGKILL');
  };
  const unlink = () => {
    if (lstatNoFollowIfPresent(journalPath) !== null) {
      assertOwnershipIdentity(journalPath, journalIdentity, 'sanitizer run journal');
      fs.unlinkSync(journalPath);
    }
    ownership.delete(journalPath);
    fsyncDirectory(path.dirname(journalPath));
  };
  const recordPathIdentity = (name, filePath, identity, cleanup = true) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name || '') || !validOwnershipIdentity(identity)) {
      throw new Error('invalid sanitizer cleanup path identity');
    }
    payload.paths[name] = {
      path: path.resolve(filePath),
      cleanup,
      identity: { device: identity.device, inode: identity.inode }
    };
    persist();
  };
  const complete = () => {
    advance('complete');
    unlink();
  };
  return { journalPath, payload, advance, complete, unlink, recordPathIdentity };
}

function sourceCounts(db, manifest) {
  const counts = {};
  for (const object of manifest.objects) {
    if (object.classification !== 'base-table') continue;
    counts[object.name] = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(object.name)}`).get().count;
  }
  return counts;
}

function sourceNullTopology(db, manifest) {
  const result = {};
  for (const object of manifest.objects) {
    if (object.classification !== 'base-table') continue;
    const columns = object.columns.filter((column) => !TRANSFORMATION_EXCLUDED_CLASSIFICATIONS.has(column.classification));
    result[object.name] = {};
    for (const column of columns) {
      result[object.name][column.name] = db.prepare(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(object.name)} WHERE ${quoteIdentifier(column.name)} IS NULL`
      ).get().count;
    }
  }
  return result;
}

function equalityCardinality(db, table, column) {
  return db.prepare(`
    SELECT COUNT(*) AS nonnull, COUNT(DISTINCT ${quoteIdentifier(column)}) AS cardinality
    FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL
  `).get();
}

function semanticRowKey(row, keys) {
  const frames = keys.map((key) => {
    const type = row[`__tm_pk_type_${key}`];
    return Buffer.concat([frame32(Buffer.from(key, 'utf8')), frame32(storageFrame(row[key], type))]);
  });
  return sha256(Buffer.concat(frames));
}

function semanticTableShape(db, object) {
  const keys = primaryKeyColumns(db, object.name);
  if (!keys.length) throw new Error(`semantic shape requires a primary key for ${object.name}`);
  const projection = [
    ...object.columns.map((column) => quoteIdentifier(column.name)),
    ...object.columns.map((column) => `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`__tm_type_${column.name}`)}`),
    ...keys.map((key) => `typeof(${quoteIdentifier(key)}) AS ${quoteIdentifier(`__tm_pk_type_${key}`)}`)
  ].join(',');
  const rows = db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(object.name)} ORDER BY ${keys.map(quoteIdentifier).join(',')}`).all();
  const rowKeys = rows.map((row) => semanticRowKey(row, keys));
  const columns = {};
  for (const column of object.columns) {
    const nullRows = [];
    const storage = [];
    const partitions = new Map();
    rows.forEach((row, index) => {
      const rowKey = rowKeys[index];
      const storageType = row[`__tm_type_${column.name}`];
      storage.push([rowKey, storageType]);
      if (row[column.name] === null) {
        nullRows.push(rowKey);
      } else if (!TRANSFORMATION_EXCLUDED_CLASSIFICATIONS.has(column.classification)) {
        const valueKey = valueStorageKey(storageType, row[column.name]);
        if (!partitions.has(valueKey)) partitions.set(valueKey, []);
        partitions.get(valueKey).push(rowKey);
      }
    });
    columns[column.name] = Object.freeze({
      nullRows: Object.freeze(nullRows.sort()),
      storage: Object.freeze(storage.sort((left, right) => left[0].localeCompare(right[0]))),
      partitions: Object.freeze([...partitions.values()].map((members) => members.sort()).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
    });
  }
  return Object.freeze({ rowKeys: Object.freeze(rowKeys.sort()), columns: Object.freeze(columns) });
}

function directSemanticLocations(db, specification) {
  const separator = specification.indexOf('.');
  const table = specification.slice(0, separator);
  const column = specification.slice(separator + 1);
  const keys = primaryKeyColumns(db, table);
  const projection = [
    ...keys.map(quoteIdentifier),
    ...keys.map((key) => `typeof(${quoteIdentifier(key)}) AS ${quoteIdentifier(`__tm_pk_type_${key}`)}`),
    quoteIdentifier(column),
    `typeof(${quoteIdentifier(column)}) AS __tm_value_type`
  ].join(',');
  return db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)} ORDER BY ${keys.map(quoteIdentifier).join(',')}`).all()
    .filter((row) => row[column] !== null)
    .map((row) => ({
      location: `${specification}@${semanticRowKey(row, keys)}`,
      value: row[column],
      storageType: row.__tm_value_type
    }));
}

function jsonPatternMatches(value, segments, index = 0, pointer = '') {
  if (index === segments.length) return [{ value, pointer: pointer || '/' }];
  const segment = segments[index];
  if (segment === '*') {
    if (Array.isArray(value)) {
      return value.flatMap((entry, entryIndex) => jsonPatternMatches(entry, segments, index + 1, `${pointer}/${entryIndex}`));
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().flatMap((key) => jsonPatternMatches(value[key], segments, index + 1, `${pointer}/${key}`));
    }
    return [];
  }
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment)) return [];
  return jsonPatternMatches(value[segment], segments, index + 1, `${pointer}/${segment}`);
}

function jsonSemanticLocations(db, specification) {
  const hashIndex = specification.indexOf('#');
  const columnSpec = specification.slice(0, hashIndex);
  const pointerPattern = specification.slice(hashIndex + 1);
  const separator = columnSpec.indexOf('.');
  const table = columnSpec.slice(0, separator);
  const column = columnSpec.slice(separator + 1);
  const keys = primaryKeyColumns(db, table);
  const projection = [
    ...keys.map(quoteIdentifier),
    ...keys.map((key) => `typeof(${quoteIdentifier(key)}) AS ${quoteIdentifier(`__tm_pk_type_${key}`)}`),
    quoteIdentifier(column)
  ].join(',');
  const segments = pointerPattern.split('/').filter(Boolean);
  const locations = [];
  for (const row of db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)} ORDER BY ${keys.map(quoteIdentifier).join(',')}`).all()) {
    if (row[column] === null) continue;
    let parsed;
    try { parsed = JSON.parse(Buffer.isBuffer(row[column]) ? row[column].toString('utf8') : String(row[column])); }
    catch (_error) { throw new Error(`malformed semantic reference JSON at ${columnSpec}`); }
    const rowKey = semanticRowKey(row, keys);
    for (const matched of jsonPatternMatches(parsed, segments)) {
      if (matched.value === null || !['string', 'number'].includes(typeof matched.value)) continue;
      locations.push({
        location: `${specification}@${rowKey}#${matched.pointer}`,
        value: matched.value,
        storageType: logicalStorageType(matched.value)
      });
    }
  }
  return locations;
}

function semanticLocations(db, specification) {
  return specification.includes('#')
    ? jsonSemanticLocations(db, specification)
    : directSemanticLocations(db, specification);
}

function semanticGroupPartitions(db, specifications, options = {}) {
  const partitions = new Map();
  for (const specification of specifications) {
    for (const entry of semanticLocations(db, specification)) {
      let key;
      if (options.canonicalDecimal) {
        const text = String(entry.value);
        if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`non-canonical decimal semantic reference at ${entry.location}`);
        key = `decimal\0${text}`;
      } else {
        key = logicalValueKey(entry.value, entry.storageType);
      }
      if (!partitions.has(key)) partitions.set(key, []);
      partitions.get(key).push(entry.location);
    }
  }
  return Object.freeze([...partitions.values()].map((members) => members.sort()).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function captureSemanticShape(db, manifest) {
  const tables = {};
  for (const object of manifest.objects) {
    if (object.classification === 'base-table') tables[object.name] = semanticTableShape(db, object);
  }
  const equalityGroups = Object.fromEntries(manifest.equalityGroups.map((group) => [
    group.name,
    semanticGroupPartitions(db, group.members)
  ]));
  const referenceGroups = Object.fromEntries(manifest.referenceGroups.map((group) => [
    group.name,
    semanticGroupPartitions(db, [...(group.owners || [group.owner]), ...group.references], {
      canonicalDecimal: group.encoding === 'canonical-positive-decimal-text'
    })
  ]));
  return Object.freeze({
    format: 'tm-sanitizer-semantic-shape-v1',
    tables: Object.freeze(tables),
    equalityGroups: Object.freeze(equalityGroups),
    referenceGroups: Object.freeze(referenceGroups)
  });
}

function assertSemanticShapePreserved(before, after) {
  const beforeTables = Object.keys(before.tables);
  const afterTables = Object.keys(after.tables);
  if (JSON.stringify(beforeTables) !== JSON.stringify(afterTables)) throw new Error('semantic base-table inventory changed');
  for (const table of beforeTables) {
    const expected = before.tables[table];
    const actual = after.tables[table];
    if (JSON.stringify(expected.rowKeys) !== JSON.stringify(actual.rowKeys)) throw new Error(`primary-key row set changed for ${table}`);
    for (const column of Object.keys(expected.columns)) {
      const left = expected.columns[column];
      const right = actual.columns[column];
      if (JSON.stringify(left.nullRows) !== JSON.stringify(right.nullRows)) throw new Error(`row-level NULL pattern changed for ${table}.${column}`);
      if (JSON.stringify(left.storage) !== JSON.stringify(right.storage)) throw new Error(`storage class changed for ${table}.${column}`);
      if (JSON.stringify(left.partitions) !== JSON.stringify(right.partitions)) throw new Error(`equality partition changed for ${table}.${column}`);
    }
  }
  for (const [name, expected] of Object.entries(before.equalityGroups)) {
    if (JSON.stringify(expected) !== JSON.stringify(after.equalityGroups[name])) throw new Error(`cross-table equality partition changed for ${name}`);
  }
  for (const [name, expected] of Object.entries(before.referenceGroups)) {
    if (JSON.stringify(expected) !== JSON.stringify(after.referenceGroups[name])) throw new Error(`reference topology changed for ${name}`);
  }
}

function jsonPathMatches(pattern, pointer) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pointer.split('/').filter(Boolean);
  return expected.length === actual.length && expected.every((segment, index) => segment === '*' || segment === actual[index]);
}

function conditionOperandPathMatches(segments, allowArray) {
  if (segments.length === 0) return true;
  if (segments.length === 1 && segments[0] === 'var') return true;
  return allowArray && segments.length === 1 && /^\d+$/.test(segments[0]);
}

function conditionExpressionPathMatches(segments, depth, maxDepth) {
  if (depth > maxDepth) return false;
  if (segments.length === 0) return true;
  const [head, ...tail] = segments;
  if (head === 'op') return tail.length === 0;
  if (head === 'left') return conditionOperandPathMatches(tail, false);
  if (head === 'right') return conditionOperandPathMatches(tail, true);
  if (head === 'arg') return conditionExpressionPathMatches(tail, depth + 1, maxDepth);
  if (head === 'args') {
    if (tail.length === 0) return true;
    if (!/^\d+$/.test(tail[0])) return false;
    return conditionExpressionPathMatches(tail.slice(1), depth + 1, maxDepth);
  }
  return false;
}

function workflowSnapshotConditionPathMatches(policy, pointer) {
  if (!policy.conditionExpression) return false;
  const root = policy.conditionExpression.root.split('/').filter(Boolean);
  const actual = pointer.split('/').filter(Boolean);
  if (actual.length < root.length) return false;
  if (!root.every((segment, index) => segment === '*' || segment === actual[index])) return false;
  return conditionExpressionPathMatches(actual.slice(root.length), 1, policy.conditionExpression.maxDepth);
}

function closedJsonPathAllowed(policy, context, pointer) {
  if (!policy || policy.mode !== 'closed') return false;
  const normalized = pointer || '/';
  return policy.allowedPaths.some((pattern) => jsonPathMatches(pattern, normalized))
    || workflowSnapshotConditionPathMatches(policy, normalized);
}

function assertJsonPath(policy, context, pointer) {
  const normalized = pointer || '/';
  if (policy.mode === 'dynamic-sanitized') return;
  if (!closedJsonPathAllowed(policy, context, normalized)) {
    throw new Error(`unknown JSON path at ${context}${normalized}`);
  }
}

function workflowJsonRelationshipRole(context, pointer) {
  if (context === 'workflow_templates.nodes' && /^\/\d+\/id$/.test(pointer)) return 'node';
  if (context === 'workflow_templates.edges' && /^\/\d+\/(?:from|to)$/.test(pointer)) return 'node';
  if (context === 'workflow_templates.edges' && /^\/\d+\/id$/.test(pointer)) return 'edge';
  if (context === 'campaign_workflow_dispatches.template_snapshot_json'
      && /^\/nodes\/\d+\/id$/.test(pointer)) return 'node';
  if (context === 'campaign_workflow_dispatches.template_snapshot_json'
      && /^\/edges\/\d+\/(?:from|to)$/.test(pointer)) return 'node';
  if (context === 'campaign_workflow_dispatches.template_snapshot_json'
      && /^\/edges\/\d+\/id$/.test(pointer)) return 'edge';
  return null;
}

function structuralJsonLeaf(context, pointer) {
  if (context === 'workflow_templates.nodes') {
    return /^\/\d+\/type$/.test(pointer)
      || /^\/\d+\/config\/(?:assignee_id|assignee_role|due_hours)$/.test(pointer);
  }
  if (context === 'workflow_templates.edges') {
    return /^\/\d+\/(?:outcome|priority|condition)$/.test(pointer)
      || /^\/\d+\/condition(?:\/(?:arg|args\/\d+))*\/op$/.test(pointer)
      || /^\/\d+\/condition(?:\/(?:arg|args\/\d+))*\/(?:left|right)\/var$/.test(pointer);
  }
  if (context === 'workflow_templates.trigger_config_json') {
    return /^\/(?:event_type|previous_state|next_state|from|to|enabled)$/.test(pointer);
  }
  if (context === 'campaign_workflow_dispatches.template_snapshot_json') {
    return /^\/(?:snapshot_version|template_id|template_version|module)$/.test(pointer)
      || /^\/trigger\/(?:event_type|previous_state|next_state)$/.test(pointer)
      || /^\/nodes\/\d+\/type$/.test(pointer)
      || /^\/nodes\/\d+\/config\/(?:assignee_id|assignee_role|due_hours)$/.test(pointer)
      || /^\/edges\/\d+\/(?:outcome|priority)$/.test(pointer)
      || /^\/edges\/\d+\/condition(?:\/(?:arg|args\/\d+))*\/op$/.test(pointer)
      || /^\/edges\/\d+\/condition(?:\/(?:arg|args\/\d+))*\/(?:left|right)\/var$/.test(pointer);
  }
  return false;
}

function transformJson(
  value,
  context,
  tokenFor,
  limits,
  policy,
  state,
  relationshipTokens,
  replacementDomain,
  depth = 0,
  pointer = ''
) {
  if (depth > limits.maxDepth) throw new Error(`JSON depth limit exceeded at ${context}${pointer}`);
  assertJsonPath(policy, context, pointer);
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry, index) => transformJson(
    entry, context, tokenFor, limits, policy, state, relationshipTokens,
    replacementDomain, depth + 1, `${pointer}/${index}`
  ));
  if (typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`forbidden JSON path at ${context}${pointer}/${key}`);
      const keyToken = tokenFor(`key\0${pointer}/${key}`);
      const outputKey = policy.mode === 'dynamic-sanitized'
        ? reserveTypedReplacement(
          replacementDomain,
          `json-key\0${context}\0${pointer}/${key}\0${logicalValueKey(key, 'text')}`,
          'text',
          (attempt) => `tmkey-${replacementAttemptToken(keyToken, attempt).slice(0, 20)}`
        )
        : key;
      output[outputKey] = transformJson(
        value[key], context, tokenFor, limits, policy, state, relationshipTokens,
        replacementDomain, depth + 1, `${pointer}/${key}`
      );
    }
    return output;
  }
  state.leaves += 1;
  if (state.leaves > limits.maxLeaves) throw new Error(`JSON leaf limit exceeded at ${context}`);
  if (context === 'workflow_templates.nodes') {
    if (/^\/\d+\/id$/.test(pointer)) return workflowNodeToken(value, relationshipTokens, replacementDomain);
    if (structuralJsonLeaf(context, pointer)) return value;
  }
  if (context === 'workflow_templates.edges') {
    if (/^\/\d+\/id$/.test(pointer)) return workflowEdgeToken(value, replacementDomain);
    if (/^\/\d+\/(?:from|to)$/.test(pointer)) return workflowNodeToken(value, relationshipTokens, replacementDomain);
    if (structuralJsonLeaf(context, pointer)) return value;
  }
  if (context === 'campaign_workflow_dispatches.template_snapshot_json') {
    const relationship = workflowJsonRelationshipRole(context, pointer);
    if (relationship === 'node') return workflowNodeToken(value, relationshipTokens, replacementDomain);
    if (relationship === 'edge') return workflowEdgeToken(value, replacementDomain);
    if (structuralJsonLeaf(context, pointer)) return value;
  }
  if (structuralJsonLeaf(context, pointer)) {
    return value;
  }
  const storageType = logicalStorageType(value);
  const mappingKey = `json-leaf\0${context}\0${pointer}\0${logicalValueKey(value, storageType)}`;
  const token = tokenFor(`${pointer}\0${String(value)}`);
  if (typeof value === 'string') {
    return reserveTypedReplacement(
      replacementDomain,
      mappingKey,
      'text',
      (attempt) => `tmjson-${replacementAttemptToken(token, attempt).slice(0, 24)}`
    );
  }
  if (typeof value === 'boolean') {
    if (!replacementDomain || typeof replacementDomain.reserveBoolean !== 'function') return !value;
    return replacementDomain.reserveBoolean(value, `${context}${pointer || '/'}`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return typePreservingReplacement(
      storageType, value, token, null, undefined, replacementDomain, mappingKey
    );
  }
  throw new Error(`unknown JSON leaf at ${context}${pointer}`);
}

function transformedValue(
  category,
  table,
  column,
  value,
  storageType,
  rankMap,
  jsonPolicy,
  columnJsonPolicy,
  relationshipTokens,
  replacementDomain
) {
  if (value === null) return null;
  const token = stableToken(category, table, column, storageFrame(value, storageType));
  const sourceKey = valueStorageKey(storageType, value);
  const mappingKey = `${category}\0${table}.${column}\0${sourceKey}`;
  if (category === 'reference-synthetic' && WORKFLOW_NODE_REFERENCE_COLUMNS.has(`${table}.${column}`) && storageType === 'text') {
    return workflowNodeToken(value, relationshipTokens, replacementDomain);
  }
  if (TRANSFORMATION_EXCLUDED_CLASSIFICATIONS.has(category)) return value;
  if (category === 'secret-null') throw new Error(`secret-null column contains data: ${table}.${column}`);
  if (category === 'secret-synthetic' && table === 'request_idempotency'
      && ['resource_claim', 'reservation_nonce'].includes(column) && storageType === 'text') {
    return reserveTypedReplacement(
      replacementDomain, mappingKey, 'text',
      (attempt) => replacementAttemptToken(token, attempt)
    );
  }
  if (category === 'secret-synthetic') return typePreservingReplacement(
    storageType, value, token,
    (_attempt, attemptToken) => `tm-inert-secret-${attemptToken}`,
    undefined, replacementDomain, mappingKey
  );
  if (category === 'synthetic-email') return typePreservingReplacement(
    storageType, value, token,
    (_attempt, attemptToken) => `tm-${attemptToken.slice(0, 24)}@example.invalid`,
    undefined, replacementDomain, mappingKey
  );
  if (category === 'synthetic-url') return typePreservingReplacement(
    storageType, value, token,
    (_attempt, attemptToken) => `https://example.invalid/${attemptToken.slice(0, 32)}`,
    undefined, replacementDomain, mappingKey
  );
  if (category === 'synthetic-contact') return typePreservingReplacement(
    storageType, value, token,
    (_attempt, attemptToken) => `tm-contact-${attemptToken.slice(0, 24)}`,
    undefined, replacementDomain, mappingKey
  );
  if (category === 'synthetic-text' && table === 'campaigns'
      && column === 'currency' && storageType === 'text') {
    if (!/^[A-Z]{3}$/.test(value)) throw new Error('campaigns.currency is not an uppercase three-letter code');
    const seed = Number.parseInt(token.slice(0, 8), 16) % (26 ** 3);
    return reserveTypedReplacement(replacementDomain, mappingKey, 'text', (attempt) => {
      let index = (seed + attempt) % (26 ** 3);
      const letters = Array(3);
      for (let position = 2; position >= 0; position -= 1) {
        letters[position] = String.fromCharCode(65 + (index % 26));
        index = Math.floor(index / 26);
      }
      return letters.join('');
    });
  }
  if (category === 'synthetic-text' && table === 'request_idempotency'
      && column === 'response_cache_key' && storageType === 'text') {
    return reserveTypedReplacement(
      replacementDomain, mappingKey, 'text',
      (attempt) => replacementAttemptToken(token, attempt)
    );
  }
  if (category === 'synthetic-text') return typePreservingReplacement(
    storageType, value, token,
    (_attempt, attemptToken) => `tmtext-${attemptToken.slice(0, 32)}`,
    undefined, replacementDomain, mappingKey
  );
  if (category === 'dependent-digest') {
    const equalityGroup = EQUALITY_GROUP_BY_COLUMN.get(`${table}.${column}`);
    const digest = equalityGroup
      ? stableToken('equality', equalityGroup, 'value', storageFrame(value, storageType))
      : token;
    const digestMappingKey = equalityGroup
      ? `dependent-digest\0${equalityGroup}\0${sourceKey}`
      : mappingKey;
    return typePreservingReplacement(
      storageType, value, digest,
      (_attempt, attemptToken) => attemptToken,
      undefined, replacementDomain, digestMappingKey
    );
  }
  if (category === 'blob-digest') {
    return typePreservingReplacement(
      'blob', value, token, null, undefined, replacementDomain, mappingKey
    );
  }
  if (category === 'sensitive-number') {
    const replacement = rankMap.get(valueStorageKey(storageType, value));
    if (replacement === undefined) throw new Error(`missing numeric rank for ${table}.${column}`);
    return typePreservingReplacement(storageType, value, token, String(replacement), replacement);
  }
  if (category === 'json-leaves') {
    let parsed;
    try { parsed = JSON.parse(String(value)); } catch (_error) { throw new Error(`malformed JSON at ${table}.${column}`); }
    const state = { leaves: 0 };
    const transformedValue = transformJson(
      parsed,
      `${table}.${column}`,
      (leaf) => stableToken('json', table, column, leaf),
      jsonPolicy,
      columnJsonPolicy,
      state,
      relationshipTokens,
      replacementDomain
    );
    const transformed = sqliteDigest.canonicalJsonBytes(transformedValue).toString('utf8');
    if (storageType === 'blob') return Buffer.from(transformed, 'utf8');
    if (storageType !== 'text') throw new Error(`JSON cell has non-text storage at ${table}.${column}`);
    return transformed;
  }
  throw new Error(`unsupported sanitizer category ${category}`);
}

function authorizeExpectedOutputValue(target, context, classification, value, storageType) {
  if (value === null || value === undefined) return;
  if (classification !== 'json-leaves') {
    target.add(`${context}\0${logicalValueKey(value, storageType)}`);
    return;
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value)); }
  catch (_error) { throw new Error(`malformed transformed JSON while authorizing ${context}`); }
  appendJsonLiveEntries(parsed, context, '', (_kind, jsonContext, leaf, leafStorageType) => {
    target.add(`${jsonContext}\0${logicalValueKey(leaf, leafStorageType)}`);
  });
}

function collectExpectedOutputContextKeys(db, manifest, options = {}) {
  const authorized = new Set();
  const replacementDomain = options.replacementDomain || createReplacementDomain(db, manifest);
  const relationshipTokens = workflowNodeRelationshipTokens(db, manifest, replacementDomain);
  for (const object of manifest.objects) {
    if (object.classification !== 'base-table') continue;
    for (const column of object.columns) {
      if (TRANSFORMATION_EXCLUDED_CLASSIFICATIONS.has(column.classification)) continue;
      if (options.secretOnly && column.classification !== 'secret-synthetic') continue;
      const rows = db.prepare(`
        SELECT DISTINCT typeof(${quoteIdentifier(column.name)}) AS storage_type,
          ${quoteIdentifier(column.name)} AS value
        FROM ${quoteIdentifier(object.name)}
        WHERE ${quoteIdentifier(column.name)} IS NOT NULL
      `).all();
      const rankMap = column.classification === 'sensitive-number'
        ? rankMapFor(db, object.name, column.name, replacementDomain)
        : new Map();
      for (const row of rows) {
        const replacement = transformedValue(
          column.classification,
          object.name,
          column.name,
          row.value,
          row.storage_type,
          rankMap,
          manifest.jsonPolicy,
          column.jsonPolicy,
          relationshipTokens,
          replacementDomain
        );
        authorizeExpectedOutputValue(
          authorized,
          `${object.name}.${column.name}`,
          column.classification,
          replacement,
          logicalStorageType(replacement, row.storage_type)
        );
        if (column.classification === 'secret-synthetic') {
          const secondReplacement = transformedValue(
            column.classification,
            object.name,
            column.name,
            replacement,
            logicalStorageType(replacement, row.storage_type),
            rankMap,
            manifest.jsonPolicy,
            column.jsonPolicy,
            relationshipTokens,
            replacementDomain
          );
          authorizeExpectedOutputValue(
            authorized,
            `${object.name}.${column.name}`,
            column.classification,
            secondReplacement,
            logicalStorageType(secondReplacement, row.storage_type)
          );
        }
      }
    }
  }
  return authorized;
}

function authorizeVerifiedRebuildOutputs(db, manifest, target) {
  for (const specification of manifest.derivedRebuilds || []) {
    const separator = specification.indexOf('.');
    if (separator < 1 || specification.includes('#')) continue;
    const table = specification.slice(0, separator);
    const column = specification.slice(separator + 1);
    const object = manifest.objects.find((entry) => entry.name === table && entry.classification === 'base-table');
    if (!object?.columns.some((entry) => entry.name === column)) continue;
    const rows = db.prepare(`
      SELECT DISTINCT typeof(${quoteIdentifier(column)}) AS storage_type,
        ${quoteIdentifier(column)} AS value
      FROM ${quoteIdentifier(table)}
      WHERE ${quoteIdentifier(column)} IS NOT NULL
    `).all();
    for (const row of rows) {
      target.add(`${specification}\0${logicalValueKey(row.value, row.storage_type)}`);
    }
  }
}

function valueStorageKey(storageType, value) {
  return `${storageType}\0${storageFrame(value, storageType).toString('hex')}`;
}

function rankMapFor(db, table, column, replacementDomain) {
  const rows = db.prepare(`
    SELECT DISTINCT typeof(${quoteIdentifier(column)}) AS storage_type,
      ${quoteIdentifier(column)} AS value
    FROM ${quoteIdentifier(table)}
    WHERE ${quoteIdentifier(column)} IS NOT NULL
    ORDER BY storage_type, ${quoteIdentifier(column)}
  `).all();
  const map = new Map();
  const byType = new Map();
  for (const row of rows) {
    if (!byType.has(row.storage_type)) byType.set(row.storage_type, []);
    byType.get(row.storage_type).push(row);
  }
  for (const [storageType, values] of byType) {
    const sourceKeys = new Set(values.map((row) => valueStorageKey(storageType, row.value)));
    const replacementKeys = new Set();
    const probabilityDomain = column === 'win_probability'
      && (table === 'customers' || table === 'opportunities');
    if (probabilityDomain && storageType !== 'integer') {
      throw new Error(`${table}.${column} probability values must use integer storage`);
    }
    const availableProbabilityValues = probabilityDomain && replacementDomain
      ? Array.from({ length: 101 }, (_value, index) => index)
        .filter((value) => !replacementDomain.isUnavailable(value, 'integer'))
      : null;
    if (probabilityDomain && (
      values.length > 101
      || (availableProbabilityValues && availableProbabilityValues.length < values.length)
    )) {
      throw new Error(`${table}.${column} probability replacement domain is exhausted`);
    }
    let integerCandidate = probabilityDomain ? 0 : replacementDomain ? 8_000_000_000_000_000 : 1;
    let realNumerator = 1;
    const realDenominator = Math.max(1_000_003, values.length + 1);
    values.forEach((row, index) => {
      let replacement;
      if (replacementDomain) {
        const mappingKey = `sensitive-number\0${table}.${column}\0${valueStorageKey(storageType, row.value)}`;
        if (storageType === 'real') {
          replacement = reserveTypedReplacement(
            replacementDomain,
            mappingKey,
            'real',
            (attempt) => (realNumerator + attempt) / realDenominator
          );
          realNumerator = Math.round(replacement * realDenominator) + 1;
        } else if (probabilityDomain) {
          replacement = reserveTypedReplacement(
            replacementDomain,
            mappingKey,
            'integer',
            (attempt) => availableProbabilityValues[attempt]
          );
        } else {
          replacement = reserveTypedReplacement(
            replacementDomain,
            mappingKey,
            storageType,
            (attempt) => integerCandidate + attempt
          );
          integerCandidate = replacement + 1;
        }
      } else if (storageType === 'real') {
        let numerator = index + 1;
        do {
          replacement = numerator / (values.length + 1);
          numerator += 1;
        } while (sourceKeys.has(valueStorageKey('real', replacement)) || replacementKeys.has(valueStorageKey('real', replacement)));
      } else {
        while (sourceKeys.has(valueStorageKey(storageType, integerCandidate))) integerCandidate += 1;
        replacement = integerCandidate;
        integerCandidate += 1;
      }
      replacementKeys.add(valueStorageKey(storageType, replacement));
      map.set(valueStorageKey(storageType, row.value), replacement);
    });
  }
  return map;
}

function primaryKeyColumns(db, table) {
  return db.prepare('SELECT name,pk FROM pragma_table_xinfo(?) WHERE pk > 0 ORDER BY pk').all(table).map((row) => row.name);
}

function sanitizeBaseTables(db, manifest, options = {}) {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
  const replacementDomain = options.replacementDomain || createReplacementDomain(db, manifest);
  const relationshipTokens = workflowNodeRelationshipTokens(db, manifest, replacementDomain);
  db.exec('PRAGMA foreign_keys=OFF');
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
  const transaction = db.transaction(() => {
    for (const object of manifest.objects) {
      if (object.classification !== 'base-table') continue;
      const columns = object.columns.filter((column) => !TRANSFORMATION_EXCLUDED_CLASSIFICATIONS.has(column.classification));
      if (!columns.length) continue;
      const keys = primaryKeyColumns(db, object.name);
      if (!keys.length) throw new Error(`sanitizer requires a primary key for ${object.name}`);
      const projection = [
        ...keys.map(quoteIdentifier),
        ...columns.flatMap((column) => [
          quoteIdentifier(column.name),
          `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`__tm_type_${column.name}`)}`
        ])
      ].join(',');
      const order = keys.map(quoteIdentifier).join(',');
      const rows = db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(object.name)} ORDER BY ${order}`).all();
      const ranks = new Map(columns.filter((column) => column.classification === 'sensitive-number').map((column) => [
        column.name,
        rankMapFor(db, object.name, column.name, replacementDomain)
      ]));
      const setSql = columns.map((column) => `${quoteIdentifier(column.name)}=?`).join(',');
      const whereSql = keys.map((key) => `${quoteIdentifier(key)} IS ?`).join(' AND ');
      const update = db.prepare(`UPDATE ${quoteIdentifier(object.name)} SET ${setSql} WHERE ${whereSql}`);
      for (const row of rows) {
        const values = columns.map((column) => transformedValue(
          column.classification,
          object.name,
          column.name,
          row[column.name],
          row[`__tm_type_${column.name}`],
          ranks.get(column.name) || new Map(),
            manifest.jsonPolicy,
            column.jsonPolicy,
            relationshipTokens,
            replacementDomain
        ));
        const result = update.run(...values, ...keys.map((key) => row[key]));
        if (result.changes !== 1) throw new Error(`sanitizer primary-key update failed for ${object.name}`);
      }
    }
    if (options.secretProbes) scrubSecretCopiesInPlace(db, manifest, options.secretProbes);
  });
  transaction.immediate();
  if (options.restoreTriggers !== false) {
    for (const trigger of triggers) db.exec(trigger.sql);
  }
  db.exec('PRAGMA foreign_keys=ON');
  if (db.pragma('foreign_key_check').length) throw new Error('sanitized database failed foreign_key_check');
  return triggers;
}

function rebuildKnowledgeProjections(db) {
  db.exec(`
    CREATE TEMP TABLE tm_old_footprint_times AS
      SELECT knowledge_entry_id,updated_at FROM knowledge_entry_footprints;
    DELETE FROM knowledge_entry_footprints;
    INSERT INTO knowledge_entry_footprints (
      knowledge_entry_id,created_by,chunk_count,entry_payload_bytes,
      chunk_payload_bytes,updated_at
    )
    SELECT
      entry.id,
      entry.created_by,
      COUNT(chunk.id),
      length(CAST(COALESCE(entry.title,'') AS BLOB)) +
        length(CAST(COALESCE(entry.summary,'') AS BLOB)) +
        length(CAST(COALESCE(entry.content,'') AS BLOB)) +
        length(CAST(COALESCE(entry.key_terms,'') AS BLOB)) +
        length(CAST(COALESCE(entry.tags_json,'') AS BLOB)) +
        length(CAST(COALESCE(entry.metadata_json,'') AS BLOB)) +
        length(CAST(COALESCE(entry.embedding_json,'') AS BLOB)),
      COALESCE(SUM(
        length(CAST(COALESCE(chunk.content,'') AS BLOB)) +
        length(CAST(COALESCE(chunk.metadata_json,'') AS BLOB)) +
        length(CAST(COALESCE(chunk.embedding_json,'') AS BLOB))
      ),0),
      COALESCE((
        SELECT old.updated_at FROM tm_old_footprint_times old
        WHERE old.knowledge_entry_id=entry.id
      ),'1970-01-01 00:00:00')
    FROM knowledge_entries entry
    LEFT JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    GROUP BY entry.id;
    DROP TABLE tm_old_footprint_times;

    CREATE TEMP TABLE tm_old_custody_times AS
      SELECT knowledge_entry_id,updated_at FROM knowledge_current_custody;
    DELETE FROM knowledge_current_custody;
    INSERT INTO knowledge_current_custody (
      knowledge_entry_id,link_id,org_id,campaign_id,bundle_id,custody_state,updated_at
    )
    SELECT
      entry.id,
      link.id,
      link.org_id,
      link.campaign_id,
      link.bundle_id,
      CASE WHEN link.revoked_at IS NULL THEN 'active' ELSE 'revoke_only' END,
      COALESCE((
        SELECT old.updated_at FROM tm_old_custody_times old
        WHERE old.knowledge_entry_id=entry.id
      ),'1970-01-01 00:00:00')
    FROM knowledge_entries entry
    JOIN campaign_record_links link ON link.id=COALESCE(
      (
        SELECT active.id FROM campaign_record_links active
        WHERE active.record_type='knowledge_entry'
          AND active.relation_type<>'shortlist'
          AND active.record_id=CAST(entry.id AS TEXT)
          AND active.revoked_at IS NULL
        ORDER BY active.id DESC LIMIT 1
      ),
      (
        SELECT historical.id FROM campaign_record_links historical
        WHERE historical.record_type='knowledge_entry'
          AND historical.relation_type<>'shortlist'
          AND historical.record_id=CAST(entry.id AS TEXT)
          AND historical.revoked_at IS NOT NULL
        ORDER BY historical.revoked_at DESC,historical.id DESC LIMIT 1
      )
    );
    DROP TABLE tm_old_custody_times;

    CREATE TEMP TABLE tm_old_unlinked_times AS
      SELECT user_id,updated_at FROM knowledge_unlinked_user_usage;
    DELETE FROM knowledge_unlinked_user_usage;
    INSERT INTO knowledge_unlinked_user_usage (
      user_id,entries,chunks,payload_bytes,unscoped_references,updated_at
    )
    SELECT
      user.id,
      COALESCE(SUM(CASE WHEN footprint.knowledge_entry_id IS NOT NULL
        AND custody.knowledge_entry_id IS NULL THEN 1 ELSE 0 END),0),
      COALESCE(SUM(CASE WHEN footprint.knowledge_entry_id IS NOT NULL
        AND custody.knowledge_entry_id IS NULL THEN footprint.chunk_count ELSE 0 END),0),
      COALESCE(SUM(CASE WHEN footprint.knowledge_entry_id IS NOT NULL
        AND custody.knowledge_entry_id IS NULL
        THEN footprint.entry_payload_bytes + footprint.chunk_payload_bytes ELSE 0 END),0),
      (
        SELECT COUNT(*)
        FROM ai_references reference
        JOIN ai_messages message ON message.id=reference.message_id
        JOIN ai_conversations conversation ON conversation.id=message.conversation_id
        WHERE conversation.user_id=user.id AND reference.campaign_id IS NULL
      ),
      COALESCE((
        SELECT old.updated_at FROM tm_old_unlinked_times old WHERE old.user_id=user.id
      ),'1970-01-01 00:00:00')
    FROM users user
    LEFT JOIN knowledge_entry_footprints footprint ON footprint.created_by=user.id
    LEFT JOIN knowledge_current_custody custody
      ON custody.knowledge_entry_id=footprint.knowledge_entry_id
    GROUP BY user.id;
    DROP TABLE tm_old_unlinked_times;
  `);

  db.exec(`
    CREATE TEMP TABLE tm_old_gauge_times AS
      SELECT scope_type,scope_id,metric,updated_at FROM knowledge_capacity_gauges;
  `);
  const organizations = db.prepare('SELECT id,code FROM organizations ORDER BY id').all();
  if (!organizations.length) throw new Error('sanitized knowledge capacity requires an organization');
  const namedDefault = organizations.filter((row) => row.code === 'turingmarket-default');
  if (namedDefault.length > 1 || (namedDefault.length === 1 && namedDefault[0].id !== organizations[0].id)) {
    throw new Error('default organization identity is inconsistent with the migration baseline');
  }
  const defaultOrganization = organizations[0];
  const sanitizedDefaultCode = defaultOrganization.code;
  if (namedDefault.length === 0 && !/^tm-inert-secret-[0-9a-f]{64}$/.test(sanitizedDefaultCode)) {
    throw new Error('default organization code was not sanitized before derived rebuild');
  }
  db.prepare('UPDATE organizations SET code=? WHERE id=?')
    .run('turingmarket-default', defaultOrganization.id);
  try {
    knowledgeService.reconcileKnowledgeCapacityGaugesInTransaction(db);
  } finally {
    db.prepare('UPDATE organizations SET code=? WHERE id=?')
      .run(sanitizedDefaultCode, defaultOrganization.id);
  }
  db.exec(`
    UPDATE knowledge_capacity_gauges
    SET updated_at=COALESCE((
      SELECT old.updated_at FROM tm_old_gauge_times old
      WHERE old.scope_type=knowledge_capacity_gauges.scope_type
        AND old.scope_id=knowledge_capacity_gauges.scope_id
        AND old.metric=knowledge_capacity_gauges.metric
    ),'1970-01-01 00:00:00');
    DROP TABLE tm_old_gauge_times;
  `);
}

function rebuildCampaignWorkflowDispatchEvidence(db) {
  const present = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='campaign_workflow_dispatches'").get();
  if (!present) return;
  const update = db.prepare(`
    UPDATE campaign_workflow_dispatches
    SET template_snapshot_json=?,template_checksum=?
    WHERE id=?
  `);
  for (const row of db.prepare(`
    SELECT id,template_snapshot_json
    FROM campaign_workflow_dispatches ORDER BY id
  `).all()) {
    let snapshot;
    try {
      snapshot = campaignWorkflowService.validateCampaignWorkflowSnapshot(JSON.parse(row.template_snapshot_json));
    } catch (_error) {
      throw new Error(`sanitized campaign workflow snapshot is invalid for dispatch ${row.id}`);
    }
    const snapshotJson = sqliteDigest.canonicalJsonBytes(snapshot).toString('utf8');
    const checksum = campaignWorkflowService.checksumCampaignWorkflowSnapshot(snapshot);
    update.run(snapshotJson, checksum, row.id);
  }
  for (const row of db.prepare(`
    SELECT id,template_snapshot_json,template_checksum
    FROM campaign_workflow_dispatches ORDER BY id
  `).all()) {
    const snapshot = campaignWorkflowService.validateCampaignWorkflowSnapshot(JSON.parse(row.template_snapshot_json));
    const canonical = sqliteDigest.canonicalJsonBytes(snapshot).toString('utf8');
    const checksum = campaignWorkflowService.checksumCampaignWorkflowSnapshot(snapshot);
    if (row.template_snapshot_json !== canonical || row.template_checksum !== checksum) {
      throw new Error(`campaign workflow dispatch evidence rebuild failed for dispatch ${row.id}`);
    }
  }
}

function rebuildManagedV1DerivedData(db) {
  const updateEntry = db.prepare('UPDATE knowledge_entries SET source_hash=? WHERE id=?');
  for (const row of db.prepare(`
    SELECT *,typeof(source_id) AS source_storage
    FROM knowledge_entries ORDER BY id
  `).all()) {
    const sourceHash = row.source_hash === null ? null : knowledgeService.hashInput({
      entry_type: row.entry_type,
      title: row.title,
      content: row.content,
      source_type: row.source_type,
      source_id: row.source_id,
      business_type: row.business_type,
      business_id: row.business_id,
      owner_id: row.visibility === 'private' ? row.created_by : ''
    });
    updateEntry.run(sourceHash, row.id);
  }
  db.exec(`
    UPDATE knowledge_chunks
    SET token_count=CAST((length(content) + 3) / 4 AS INTEGER);

    UPDATE ai_messages
    SET total_tokens=COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)
    WHERE total_tokens IS NOT NULL;
  `);
}

function rebuildCrmDerivedData(db) {
  const rebuild = db.transaction(() => {
    const customers = db.prepare(`
      SELECT id,org_id,brand_name,company_name,stage,normalized_identity_key
      FROM customers ORDER BY id
    `).all().map((row) => {
      const identityKey = row.normalized_identity_key === null
        ? null
        : buildCustomerIdentity({
            brand_name: row.brand_name,
            company_name: row.company_name
          }).key;
      const lifecycle = CUSTOMER_LIFECYCLE_REGISTRY[row.stage];
      const enforceable = identityKey !== null
        && lifecycle?.class === 'active'
        && Number.isSafeInteger(row.org_id)
        && row.org_id > 0;
      return {
        id: row.id,
        identityKey,
        enforceable,
        scopeKey: enforceable ? `${row.org_id}\0${identityKey}` : null
      };
    });
    const activeIdentityCounts = new Map();
    for (const customer of customers) {
      if (!customer.enforceable) continue;
      activeIdentityCounts.set(
        customer.scopeKey,
        (activeIdentityCounts.get(customer.scopeKey) || 0) + 1
      );
    }

    db.prepare('UPDATE customers SET duplicate_enforced=0').run();
    const updateIdentity = db.prepare(`
      UPDATE customers SET normalized_identity_key=? WHERE id=?
    `);
    for (const customer of customers) {
      if (updateIdentity.run(customer.identityKey, customer.id).changes !== 1) {
        throw new Error(`CRM identity rebuild missed customer ${customer.id}`);
      }
    }
    const enableDuplicateEnforcement = db.prepare(`
      UPDATE customers SET duplicate_enforced=1 WHERE id=?
    `);
    for (const customer of customers) {
      if (!customer.enforceable || activeIdentityCounts.get(customer.scopeKey) !== 1) continue;
      if (enableDuplicateEnforcement.run(customer.id).changes !== 1) {
        throw new Error(`CRM duplicate enforcement rebuild missed customer ${customer.id}`);
      }
    }
  });
  rebuild.immediate();
}

function rebuildDerivedData(db, manifest) {
  if (![1, 6].includes(manifest.schemaVersion)) {
    throw new Error(`unsupported derived rebuild profile ${manifest.schemaVersion}`);
  }
  const hasKnowledge = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='knowledge_entries'").get();
  if (hasKnowledge && manifest.schemaVersion === 1) {
    rebuildManagedV1DerivedData(db);
  } else if (hasKnowledge) {
    const updateEntry = db.prepare(`
      UPDATE knowledge_entries
      SET source_hash=?,source_identity_sha256=?,content_sha256=?
      WHERE id=?
    `);
    for (const row of db.prepare(`
      SELECT *,typeof(source_id) AS source_storage
      FROM knowledge_entries ORDER BY id
    `).all()) {
      const custody = db.prepare(`
        SELECT org_id,campaign_id FROM knowledge_current_custody
        WHERE knowledge_entry_id=?
      `).get(row.id);
      const sourceHash = row.source_hash === null ? null : knowledgeService.hashInput({
        entry_type: row.entry_type,
        title: row.title,
        content: row.content,
        source_type: row.source_type,
        source_id: row.source_id,
        business_type: row.business_type,
        business_id: row.business_id,
        owner_id: row.visibility === 'private' ? row.created_by : ''
      });
      updateEntry.run(
        sourceHash,
        rebuiltKnowledgeSourceIdentity({ ...row, source_hash: sourceHash }, custody),
        row.content_sha256 === null ? null : rebuiltKnowledgeContentDigest(row),
        row.id
      );
    }
    const updateChunk = db.prepare('UPDATE knowledge_chunks SET content_sha256=? WHERE id=?');
    for (const row of db.prepare('SELECT id,content,content_sha256 FROM knowledge_chunks ORDER BY id').all()) {
      if (row.content_sha256 !== null) updateChunk.run(sha256(Buffer.from(row.content, 'utf8')), row.id);
    }
    db.exec(`
      UPDATE knowledge_chunks
      SET token_count=CAST((length(content) + 3) / 4 AS INTEGER);

      UPDATE ai_messages
      SET total_tokens=COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)
      WHERE total_tokens IS NOT NULL;

      UPDATE ai_references
      SET reference_id=CAST(knowledge_entry_id AS TEXT),
          source_identity_sha256=(
            SELECT source_identity_sha256 FROM knowledge_entries
            WHERE id=ai_references.knowledge_entry_id
          ),
          entry_content_sha256=(
            SELECT content_sha256 FROM knowledge_entries
            WHERE id=ai_references.knowledge_entry_id
          ),
          chunk_content_sha256=(
            SELECT content_sha256 FROM knowledge_chunks
            WHERE id=ai_references.knowledge_chunk_id
          )
      WHERE reference_schema_version=1
    `);
    const rebuild = db.transaction(() => rebuildKnowledgeProjections(db));
    rebuild.immediate();
  }
  if (manifest.schemaVersion === 6) rebuildCrmDerivedData(db);
  rebuildCampaignWorkflowDispatchEvidence(db);
  sqliteDigest.rebuildKnowledgeChunksFts(db);
  sqliteDigest.verifyKnowledgeChunksFtsIntegrity(db, FTS_MANIFEST, { checkMainIntegrity: true });
}

function bytesForForbiddenValue(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'number' && Object.is(value, -0)) return Buffer.from('-0', 'utf8');
  return Buffer.from(String(value), 'utf8');
}

function utf16be(bytes) {
  const littleEndian = Buffer.from(bytes.toString('utf8'), 'utf16le');
  const bigEndian = Buffer.alloc(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1];
    bigEndian[index + 1] = littleEndian[index];
  }
  return bigEndian;
}

function rawEncodings(value) {
  const bytes = bytesForForbiddenValue(value);
  return [
    ['utf8', bytes],
    ['utf16le', Buffer.from(bytes.toString('utf8'), 'utf16le')],
    ['utf16be', utf16be(bytes)],
    ['hex', Buffer.from(bytes.toString('hex'), 'ascii')],
    ['base64', Buffer.from(bytes.toString('base64'), 'ascii')],
    ['sha256-hex', Buffer.from(sha256(bytes), 'ascii')]
  ];
}

function logicalStorageType(value, declared) {
  if (declared) return declared;
  if (Buffer.isBuffer(value)) return 'blob';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) && !Object.is(value, -0) ? 'integer' : 'real';
  return 'null';
}

function logicalValueKey(value, storageType) {
  if (storageType === 'boolean') return `boolean\0${value ? '1' : '0'}`;
  return `${storageType}\0${storageFrame(value, storageType).toString('hex')}`;
}

function appendJsonLiveEntries(value, baseContext, pointer, append) {
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendJsonLiveEntries(entry, baseContext, `${pointer}/${index}`, append));
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
      append('json-key', `${baseContext}#${pointer || ''}/${escaped}@key`, key, 'text');
      appendJsonLiveEntries(value[key], baseContext, `${pointer}/${escaped}`, append);
    }
    return;
  }
  append('json-leaf', `${baseContext}#${pointer || '/'}`, value, logicalStorageType(value));
}

function sourceFtsTerms(db) {
  const vocabularyName = 'tm_forbidden_knowledge_vocab';
  try {
    db.exec(`DROP TABLE IF EXISTS temp.${quoteIdentifier(vocabularyName)}`);
    db.exec(`CREATE VIRTUAL TABLE temp.${quoteIdentifier(vocabularyName)} USING fts5vocab('main','knowledge_chunks_fts','row')`);
    return db.prepare(`SELECT term FROM temp.${quoteIdentifier(vocabularyName)} ORDER BY CAST(term AS BLOB)`).all().map((row) => row.term);
  } finally {
    try { db.exec(`DROP TABLE IF EXISTS temp.${quoteIdentifier(vocabularyName)}`); } catch (_error) {}
  }
}

function collectForbiddenValues(db, manifest, options = {}) {
  const logicalEntries = [];
  const rawProbes = [];
  const authorizedEntries = [];
  const authorizedContextKeys = new Set();
  const replacementDomain = createReplacementDomain(db, manifest);
  const authorizedOutputContextKeys = collectExpectedOutputContextKeys(db, manifest, {
    ...options,
    replacementDomain
  });
  const authorizedRawKeys = new Set();
  const authorizedSchemaOccurrences = new Map();
  const probeKeys = new Set();
  const appendAuthorized = (kind, context, value, declaredStorageType, category) => {
    if (value === null || value === undefined) return;
    const storageType = logicalStorageType(value, declaredStorageType);
    const entry = Object.freeze({
      kind,
      context,
      category,
      storageType,
      value,
      key: logicalValueKey(value, storageType)
    });
    authorizedEntries.push(entry);
    authorizedContextKeys.add(`${context}\0${entry.key}`);
    for (const [encoding, bytes] of rawEncodings(value)) {
      authorizedRawKeys.add(`${encoding}\0${bytes.toString('hex')}`);
    }
  };
  const appendForbidden = (kind, context, value, declaredStorageType, category = null) => {
    if (value === null || value === undefined) return;
    const storageType = logicalStorageType(value, declaredStorageType);
    const canonicalKey = logicalValueKey(value, storageType);
    logicalEntries.push(Object.freeze({ kind, context, category, storageType, value, key: canonicalKey }));
    for (const [encoding, bytes] of rawEncodings(value)) {
      const key = `${context}\0${canonicalKey}\0${encoding}\0${bytes.toString('hex')}`;
      if (probeKeys.has(key)) continue;
      probeKeys.add(key);
      rawProbes.push(Object.freeze({
        kind, context, encoding, bytes, storageType, category, canonicalKey
      }));
    }
  };
  for (const object of manifest.objects) {
    if (object.classification !== 'base-table') continue;
    for (const column of object.columns) {
      if (column.classification === 'secret-null') continue;
      const secretColumn = column.classification === 'secret-synthetic';
      const semanticAuthorization = manifest.schemaVersion === 6
        && object.name === 'ai_references' && column.name === 'reference_id'
        ? `CASE WHEN (
          reference_schema_version=1
          AND knowledge_entry_id IS NOT NULL
          AND reference_id=CAST(knowledge_entry_id AS TEXT)
        ) THEN 1 ELSE 0 END`
        : '0';
      const rows = db.prepare(`
        SELECT DISTINCT typeof(${quoteIdentifier(column.name)}) AS storage_type,
          ${quoteIdentifier(column.name)} AS value,
          ${semanticAuthorization} AS semantic_authorized
        FROM ${quoteIdentifier(object.name)} WHERE ${quoteIdentifier(column.name)} IS NOT NULL
      `).all();
      for (const row of rows) {
        const context = `${object.name}.${column.name}`;
        if (options.secretOnly && !secretColumn) {
          if (column.classification === 'json-leaves') {
            appendAuthorized('json-container', context, row.value, row.storage_type, column.classification);
            let parsed;
            try { parsed = JSON.parse(Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value)); }
            catch (_error) { throw new Error(`malformed JSON while collecting secret source probes at ${context}`); }
            appendJsonLiveEntries(parsed, context, '', (kind, jsonContext, value, storageType) => {
              appendAuthorized(kind, jsonContext, value, storageType, column.classification);
            });
          } else {
            appendAuthorized('cell', context, row.value, row.storage_type, column.classification);
          }
          continue;
        }
        if (row.semantic_authorized) {
          appendAuthorized('semantic-reference', context, row.value, row.storage_type, column.classification);
          continue;
        }
        if (column.classification === 'json-leaves') {
          appendForbidden('json-container', context, row.value, row.storage_type, column.classification);
          let parsed;
          try { parsed = JSON.parse(Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value)); }
          catch (_error) { throw new Error(`malformed JSON while collecting forbidden values at ${context}`); }
          appendJsonLiveEntries(parsed, context, '', (kind, jsonContext, value, storageType) => {
            const hashIndex = jsonContext.indexOf('#');
            const pointer = hashIndex === -1 ? '' : jsonContext.slice(hashIndex + 1).replace(/@key$/, '');
            const authorized = kind === 'json-key'
              ? closedJsonPathAllowed(column.jsonPolicy, context, pointer)
              : column.jsonPolicy?.mode === 'closed'
                && closedJsonPathAllowed(column.jsonPolicy, context, pointer)
                && structuralJsonLeaf(context, pointer);
            (authorized ? appendAuthorized : appendForbidden)(
              kind, jsonContext, value, storageType, column.classification
            );
          });
        } else if (TRANSFORMATION_EXCLUDED_CLASSIFICATIONS.has(column.classification)) {
          appendAuthorized('cell', context, row.value, row.storage_type, column.classification);
        } else {
          appendForbidden('cell', context, row.value, row.storage_type, column.classification);
        }
      }
    }
  }
  if (options.secretOnly) {
    for (const term of sourceFtsTerms(db)) {
      appendAuthorized('fts-term', `knowledge_chunks_fts#${term}`, term, 'text', 'virtual-derived');
    }
  } else if (options.includeFtsTerms !== false) {
    for (const term of sourceFtsTerms(db)) {
      appendForbidden('fts-term', `knowledge_chunks_fts#${term}`, term, 'text', 'virtual-derived');
    }
  }
  const schemaSql = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name
  `).all().map((row) => Buffer.from(row.sql, 'utf8'));
  const seenProbeKeys = new Set();
  for (const probe of rawProbes) {
    if (probe.encoding !== 'utf8' || probe.bytes.length === 0) continue;
    const key = `${probe.encoding}\0${probe.bytes.toString('hex')}`;
    if (seenProbeKeys.has(key)) continue;
    seenProbeKeys.add(key);
    let occurrences = 0;
    for (const sql of schemaSql) {
      let offset = 0;
      while (offset <= sql.length - probe.bytes.length) {
        const found = sql.indexOf(probe.bytes, offset);
        if (found === -1) break;
        occurrences += 1;
        offset = found + probe.bytes.length;
      }
    }
    if (occurrences > 0) authorizedSchemaOccurrences.set(key, occurrences);
  }
  return Object.freeze({
    logicalEntries: Object.freeze(logicalEntries),
    rawProbes: Object.freeze(rawProbes),
    authorizedEntries: Object.freeze(authorizedEntries),
    authorizedContextKeys,
    authorizedOutputContextKeys,
    authorizedRawKeys,
    authorizedSchemaOccurrences,
    sourceDomainKeys: replacementDomain.sourceKeys,
    replacementDomain,
    classifiedValues: logicalEntries.length
  });
}

function collectSecretOnlySourceProbes(db, manifest) {
  return collectForbiddenValues(db, manifest, { secretOnly: true });
}

function forbiddenSensitiveValues(db, manifest) {
  return collectForbiddenValues(db, manifest);
}

function assertNoRawLeaks(outputPath, forbidden) {
  const bytes = fs.readFileSync(outputPath);
  for (const probe of forbidden.rawProbes) {
    if (probe.context.startsWith('knowledge_chunks_fts#')) continue;
    if (probe.bytes.length > 0 && bytes.indexOf(probe.bytes) !== -1) {
      throw new Error(`sanitized output contains a classified source leak from ${probe.context} (${probe.encoding})`);
    }
  }
}

function assertCompactSqlite(outputPath, db) {
  rejectSidecars(outputPath, 'sanitized output');
  if (db.pragma('quick_check', { simple: true }) !== 'ok') {
    throw new Error('sanitized output compactness quick_check failed');
  }
  const freelistCount = db.pragma('freelist_count', { simple: true });
  if (freelistCount !== 0) throw new Error(`sanitized output is not compact: freelist_count=${freelistCount}`);
  const pageSize = db.pragma('page_size', { simple: true });
  const pageCount = db.pragma('page_count', { simple: true });
  const expectedBytes = pageSize * pageCount;
  const actualBytes = fs.statSync(outputPath).size;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || actualBytes !== expectedBytes) {
    throw new Error(`sanitized output size is not exactly page_size*page_count (${actualBytes} != ${expectedBytes})`);
  }
}

function collectLiveOutputValues(db, manifest) {
  const entries = [];
  const append = (kind, context, value, declaredStorageType, category) => {
    if (value === null || value === undefined) return;
    const storageType = logicalStorageType(value, declaredStorageType);
    entries.push(Object.freeze({
      kind, context, category, storageType, value, key: logicalValueKey(value, storageType)
    }));
  };
  for (const object of manifest.objects) {
    if (object.classification !== 'base-table') continue;
    for (const column of object.columns) {
      const context = `${object.name}.${column.name}`;
      const rows = db.prepare(`
        SELECT DISTINCT typeof(${quoteIdentifier(column.name)}) AS storage_type,
          ${quoteIdentifier(column.name)} AS value
        FROM ${quoteIdentifier(object.name)}
        WHERE ${quoteIdentifier(column.name)} IS NOT NULL
      `).all();
      for (const row of rows) {
        if (column.classification !== 'json-leaves') {
          append('cell', context, row.value, row.storage_type, column.classification);
          continue;
        }
        let parsed;
        try { parsed = JSON.parse(Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value)); }
        catch (_error) { throw new Error(`malformed JSON while scanning live output at ${context}`); }
        appendJsonLiveEntries(parsed, context, '', (kind, jsonContext, value, storageType) => {
          append(kind, jsonContext, value, storageType, column.classification);
        });
      }
    }
  }
  for (const term of sourceFtsTerms(db)) {
    append('fts-term', `knowledge_chunks_fts#${term}`, term, 'text', 'virtual-derived');
  }
  return Object.freeze(entries);
}

function exactProbeAt(bytes, offset, probe, absoluteOffset = 0) {
  if (probe.bytes.length === 0 || offset + probe.bytes.length > bytes.length) return false;
  if ((probe.encoding === 'utf16le' || probe.encoding === 'utf16be')
      && (absoluteOffset + offset) % 2 !== 0) return false;
  return bytes.subarray(offset, offset + probe.bytes.length).equals(probe.bytes);
}

function buildRecordProbeIndex(rawProbes) {
  const index = new Map();
  for (const probe of rawProbes) {
    if (probe.kind === 'json-container' || probe.bytes.length === 0) continue;
    const first = probe.bytes[0];
    if (!index.has(first)) index.set(first, []);
    index.get(first).push(probe);
  }
  return index;
}

function matchingRecordProbe(observed, probeIndex) {
  const bytes = bytesForForbiddenValue(observed.value);
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const candidates = probeIndex.get(bytes[offset]);
    if (!candidates) continue;
    for (const probe of candidates) {
      if (exactProbeAt(bytes, offset, probe)) return probe;
    }
  }
  return null;
}

function sqliteNonLiveRegions(outputPath) {
  const bytes = fs.readFileSync(outputPath);
  if (bytes.length < 100 || !bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'ascii'))) {
    throw new Error('sanitized output is not a SQLite database');
  }
  const encodedPageSize = bytes.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0 || bytes.length % pageSize !== 0) {
    throw new Error('sanitized output has an invalid SQLite page size');
  }
  const regions = [];
  const btreeTypes = new Set([0x02, 0x05, 0x0a, 0x0d]);
  for (let pageStart = 0; pageStart < bytes.length; pageStart += pageSize) {
    const pageHeader = pageStart === 0 ? pageStart + 100 : pageStart;
    const pageEnd = pageStart + pageSize;
    const pageType = bytes[pageHeader];
    if (!btreeTypes.has(pageType)) continue;
    const headerSize = pageType === 0x02 || pageType === 0x05 ? 12 : 8;
    const cellCount = bytes.readUInt16BE(pageHeader + 3);
    const pointerEnd = pageHeader + headerSize + (cellCount * 2);
    const encodedContentStart = bytes.readUInt16BE(pageHeader + 5);
    const contentStart = pageStart + (encodedContentStart === 0 ? 65_536 : encodedContentStart);
    if (pointerEnd > pageEnd || contentStart < pointerEnd || contentStart > pageEnd) {
      throw new Error('sanitized output has a malformed SQLite b-tree page');
    }
    if (contentStart > pointerEnd) {
      regions.push(Object.freeze({ offset: pointerEnd, bytes: bytes.subarray(pointerEnd, contentStart) }));
    }
    let freeblock = bytes.readUInt16BE(pageHeader + 1);
    const seen = new Set();
    while (freeblock !== 0) {
      if (seen.has(freeblock)) throw new Error('sanitized output has a cyclic SQLite freeblock chain');
      seen.add(freeblock);
      const blockStart = pageStart + freeblock;
      if (blockStart < pageHeader + headerSize || blockStart + 4 > pageEnd) {
        throw new Error('sanitized output has an invalid SQLite freeblock offset');
      }
      const next = bytes.readUInt16BE(blockStart);
      const size = bytes.readUInt16BE(blockStart + 2);
      if (size < 4 || blockStart + size > pageEnd) throw new Error('sanitized output has an invalid SQLite freeblock size');
      if (size > 4) regions.push(Object.freeze({ offset: blockStart + 4, bytes: bytes.subarray(blockStart + 4, blockStart + size) }));
      freeblock = next;
    }
  }
  return Object.freeze(regions);
}

function zeroSqliteNonLiveRegions(outputPath) {
  const regions = sqliteNonLiveRegions(outputPath);
  if (regions.length === 0) return;
  const fd = fs.openSync(outputPath, 'r+');
  try {
    for (const region of regions) {
      if (region.bytes.length > 0) fs.writeSync(fd, Buffer.alloc(region.bytes.length), 0, region.bytes.length, region.offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertNoPhysicalLeaks(outputPath, forbidden) {
  const probes = forbidden.rawProbes.filter((probe) => probe.bytes.length > 0);
  if (probes.length === 0) return;
  for (const region of sqliteNonLiveRegions(outputPath)) {
    const probeIndex = buildRecordProbeIndex(probes);
    for (let offset = 0; offset < region.bytes.length; offset += 1) {
      const candidates = probeIndex.get(region.bytes[offset]);
      if (!candidates) continue;
      for (const probe of candidates) {
        if (exactProbeAt(region.bytes, offset, probe, region.offset)) {
          throw new Error(
            `sanitized output contains a classified source leak from ${probe.context} `
            + `(${probe.encoding}) in non-live SQLite page bytes`
          );
        }
      }
    }
  }
}

function outputJsonPositionAuthorized(observed, manifest) {
  if (!observed.context.includes('#')) return false;
  const [baseContext, suffix] = observed.context.split('#', 2);
  const separator = baseContext.indexOf('.');
  if (separator < 1) return false;
  const table = baseContext.slice(0, separator);
  const columnName = baseContext.slice(separator + 1);
  const object = manifest.objects.find((entry) => entry.name === table && entry.classification === 'base-table');
  const column = object?.columns.find((entry) => entry.name === columnName && entry.classification === 'json-leaves');
  if (!column?.jsonPolicy) return false;
  const pointer = suffix.replace(/@key$/, '');
  if (observed.kind === 'json-key') {
    return column.jsonPolicy.mode === 'closed'
      && closedJsonPathAllowed(column.jsonPolicy, baseContext, pointer);
  }
  return observed.kind === 'json-leaf'
    && column.jsonPolicy.mode === 'closed'
    && closedJsonPathAllowed(column.jsonPolicy, baseContext, pointer)
    && structuralJsonLeaf(baseContext, pointer);
}

function verifiedDerivedOutputAllowsSubstringCoincidence(observed, manifest) {
  const baseContext = observed.context.split('#', 1)[0];
  if ((manifest.derivedRebuilds || []).includes(baseContext)) return true;
  if (observed.category === 'virtual-derived') return true;
  if (observed.category === 'blob-digest') return observed.storageType === 'blob';
  return observed.category === 'dependent-digest'
    && observed.storageType === 'text'
    && /^[0-9a-f]{64}$/.test(String(observed.value));
}

class SanitizerTypedSourceDomainIntersectionError extends Error {
  constructor(context) {
    super(`sanitized output has a forbidden complete typed source-domain intersection at ${context}`);
    this.name = 'SanitizerTypedSourceDomainIntersectionError';
    this.code = 'TM_SANITIZER_TYPED_SOURCE_DOMAIN_INTERSECTION';
    this.context = context;
  }
}

function assertNoForbiddenValues(outputPath, forbidden, manifest) {
  const outputDb = new Database(outputPath, { readonly: true, fileMustExist: true });
  try {
    assertCompactSqlite(outputPath, outputDb);
    const authorizedContextKeys = forbidden.authorizedContextKeys || new Set();
    const authorizedOutputContextKeys = forbidden.authorizedOutputContextKeys || new Set();
    const sourceDomainKeys = forbidden.sourceDomainKeys || new Set(
      (forbidden.logicalEntries || []).map((entry) => entry.key)
    );
    const probeIndex = buildRecordProbeIndex(forbidden.rawProbes);
    for (const observed of collectLiveOutputValues(outputDb, manifest)) {
      const contextKey = `${observed.context}\0${observed.key}`;
      const invariant = authorizedContextKeys.has(contextKey)
        || TRANSFORMATION_EXCLUDED_CLASSIFICATIONS.has(observed.category)
        || outputJsonPositionAuthorized(observed, manifest);
      if (!invariant
          && observed.category !== 'virtual-derived'
          && sourceDomainKeys.has(observed.key)) {
        throw new SanitizerTypedSourceDomainIntersectionError(observed.context);
      }
      if (invariant
          || authorizedOutputContextKeys.has(contextKey)
          || verifiedDerivedOutputAllowsSubstringCoincidence(observed, manifest)) continue;
      const probe = matchingRecordProbe(observed, probeIndex);
      if (probe) {
        throw new Error(
          `sanitized output contains a forbidden source representation from ${probe.context} `
          + `(${probe.encoding}) at ${observed.context}`
        );
      }
    }
  } finally {
    outputDb.close();
  }
  assertNoPhysicalLeaks(outputPath, forbidden);
}

function assertNoSecretCopies(outputPath, secretSourceProbes, manifest) {
  if (!secretSourceProbes || !Array.isArray(secretSourceProbes.rawProbes)) {
    throw new TypeError('secret source probes are required for pre-worker validation');
  }
  const outputDb = new Database(outputPath, { readonly: true, fileMustExist: true });
  try {
    assertCompactSqlite(outputPath, outputDb);
    const authorizedOutputContextKeys = secretSourceProbes.authorizedOutputContextKeys || new Set();
    const probeIndex = buildRecordProbeIndex(secretSourceProbes.rawProbes);
    for (const observed of collectLiveOutputValues(outputDb, manifest)) {
      if (authorizedOutputContextKeys.has(`${observed.context}\0${observed.key}`)
          || verifiedDerivedOutputAllowsSubstringCoincidence(observed, manifest)) continue;
      const probe = matchingRecordProbe(observed, probeIndex);
      if (probe) {
        throw new Error(
          `prepared source contains a secret source representation from ${probe.context} `
          + `(${probe.encoding}) at ${observed.context}`
        );
      }
    }
  } finally {
    outputDb.close();
  }
  assertNoPhysicalLeaks(outputPath, {
    rawProbes: secretSourceProbes.rawProbes,
    authorizedRawKeys: new Set(),
    authorizedSchemaOccurrences: secretSourceProbes.authorizedSchemaOccurrences
  });
}

function sentinelPrefix(value, prefixes) {
  if (typeof value !== 'string') return null;
  return prefixes.find((prefix) => value.includes(prefix)) || null;
}

function jsonSentinelPositionAllowed(prefix, context, pointer, columnPolicy, keyPosition) {
  if (keyPosition) return prefix === 'tmkey-' && columnPolicy.mode === 'dynamic-sanitized';
  const relationship = workflowJsonRelationshipRole(context, pointer);
  if (prefix === 'tm-node-') return relationship === 'node';
  if (prefix === 'tm-edge-') return relationship === 'edge';
  if (prefix === 'tmjson-') return relationship === null && !structuralJsonLeaf(context, pointer);
  return false;
}

function assertJsonSentinels(value, context, category, policy, columnPolicy, pointer = '') {
  assertJsonPath(columnPolicy, context, pointer);
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSentinels(entry, context, category, policy, columnPolicy, `${pointer}/${index}`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const childPointer = `${pointer}/${key}`;
      const keyPrefix = sentinelPrefix(key, policy.prefixes);
      if (keyPrefix && (!policy.allowedClassifications[keyPrefix].includes(category)
          || !jsonSentinelPositionAllowed(keyPrefix, context, childPointer, columnPolicy, true))) {
        throw new Error(`replacement sentinel escaped its manifest-authorized JSON key at ${context}${childPointer}`);
      }
      assertJsonSentinels(entry, context, category, policy, columnPolicy, childPointer);
    }
    return;
  }
  const prefix = sentinelPrefix(String(value), policy.prefixes);
  if (prefix && (!policy.allowedClassifications[prefix].includes(category)
      || !jsonSentinelPositionAllowed(prefix, context, pointer, columnPolicy, false))) {
    throw new Error(`replacement sentinel escaped its manifest-authorized JSON position at ${context}${pointer}`);
  }
}

function assertReplacementSentinelsConfined(db, manifest) {
  const policy = manifest.semanticPolicies.replacementSentinels;
  for (const object of manifest.objects) {
    if (object.classification !== 'base-table') continue;
    for (const column of object.columns) {
      const rows = db.prepare(`SELECT ${quoteIdentifier(column.name)} AS value FROM ${quoteIdentifier(object.name)} WHERE ${quoteIdentifier(column.name)} IS NOT NULL`).all();
      for (const row of rows) {
        const context = `${object.name}.${column.name}`;
        if (column.classification === 'json-leaves') {
          let parsed;
          try { parsed = JSON.parse(Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value)); }
          catch (_error) { throw new Error(`malformed JSON while checking replacement sentinels at ${context}`); }
          assertJsonSentinels(parsed, context, column.classification, policy, column.jsonPolicy);
          continue;
        }
        const text = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
        const prefix = sentinelPrefix(text, policy.prefixes);
        if (prefix && !policy.allowedClassifications[prefix].includes(column.classification)) {
          throw new Error(`replacement sentinel escaped its classified column at ${context}`);
        }
      }
    }
  }
}

function assertTopologyPreserved(before, after, label) {
  if (before.topologySha256 !== after.topologySha256) throw new Error(`${label} topology changed`);
}

function verifyDeterministicFtsCanaries(db) {
  const candidates = [];
  const seen = new Set();
  for (const row of db.prepare('SELECT id,content FROM knowledge_chunks ORDER BY id').all()) {
    if (typeof row.content !== 'string') continue;
    for (const match of row.content.matchAll(/[A-Za-z0-9]{16,}/g)) {
      const term = match[0].toLowerCase();
      if (term === 'tmtext' || seen.has(term)) continue;
      seen.add(term);
      candidates.push(term);
      if (candidates.length === 2) break;
    }
    if (candidates.length === 2) break;
  }
  for (const fallback of ['tmftsdeterministicnomatcha', 'tmftsdeterministicnomatchb']) {
    if (candidates.length === 2) break;
    candidates.push(fallback);
  }
  sqliteDigest.verifyKnowledgeChunksFtsCanaries(db, candidates);
  const evidence = candidates.map((term) => ({
    term,
    chunkIds: sqliteDigest.matchKnowledgeChunksCanary(db, term)
  }));
  return Object.freeze({
    count: candidates.length,
    sha256: sha256(Buffer.from(JSON.stringify(evidence), 'utf8'))
  });
}

function openReadonly(databasePath) {
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function sanitizeProductionShapePipeline(options) {
  const ownership = options._ownedFiles || new Map();
  const sourcePath = assertRegularDatabaseFile(options.sourcePath, 'source database');
  const outputPath = assertRegularDatabaseFile(options.outputPath, 'sanitized output', { mustExist: false });
  if (path.dirname(sourcePath) === path.dirname(outputPath) && path.basename(sourcePath) === path.basename(outputPath)) {
    throw new Error('source and output database must differ');
  }
  rejectSidecars(sourcePath, 'source database');
  const manifestDocument = options.manifest || JSON.parse(fs.readFileSync(
    options.manifestPath || path.join(__dirname, 'sanitization_manifest.json'),
    'utf8'
  ));
  let manifest;
  const sourceIdentity = fileIdentity(sourcePath);
  let beforeDigest;
  let counts;
  let semanticShape;
  let nulls;
  const cardinality = {};
  let forbidden;
  const preScrubPath = `${outputPath}.root-prescrub-${process.pid}`;
  const workingPath = `${outputPath}.sanitized-stage-${process.pid}`;
  const publishPath = `${outputPath}.publish-${process.pid}`;
  if ([preScrubPath, workingPath, publishPath].some((candidate) => lstatNoFollowIfPresent(candidate) !== null)) {
    throw new Error('sanitizer staging path already exists');
  }
  let sourceDb = openReadonly(sourcePath);
  let journal;
  try {
    manifest = validateManifest(manifestDocument, sourceDb);
    beforeDigest = sqliteDigest.databaseDigest(sourceDb, FTS_MANIFEST);
    counts = sourceCounts(sourceDb, manifest);
    semanticShape = captureSemanticShape(sourceDb, manifest);
    nulls = sourceNullTopology(sourceDb, manifest);
    for (const object of manifest.objects) {
      if (object.classification !== 'base-table') continue;
      for (const column of object.columns.filter((entry) => (
        !TRANSFORMATION_EXCLUDED_CLASSIFICATIONS.has(entry.classification)
        && entry.classification !== 'secret-null'
      ))) {
        cardinality[`${object.name}.${column.name}`] = equalityCardinality(sourceDb, object.name, column.name);
      }
    }
    forbidden = forbiddenSensitiveValues(sourceDb, manifest);
    journal = journalController(options, {
      source: sourcePath,
      output: outputPath,
      preScrub: preScrubPath,
      working: workingPath,
      publish: publishPath
    });
    journal.advance('prescrub-copy-intent');
    vacuumIntoOwnedStage(sourceDb, preScrubPath, {
      ownership,
      journal,
      journalName: 'preScrub',
      label: 'pre-scrub staging file'
    });
  } finally {
    if (sourceDb) sourceDb.close();
    sourceDb = null;
  }
  fs.chmodSync(preScrubPath, 0o600);
  rejectSidecars(preScrubPath, 'pre-scrub database');
  journal.advance('prescrub-staged');

  let preScrubDb;
  try {
    preScrubDb = new Database(preScrubPath);
    const preScrubProfile = validateManifest(manifestDocument, preScrubDb);
    if (preScrubProfile.schemaVersion !== manifest.schemaVersion) {
      throw new Error('pre-scrub copy changed exact sanitization profile');
    }
    const secretOnlyManifest = secretOnlySanitizationManifest(manifest);
    sanitizeBaseTables(preScrubDb, secretOnlyManifest, {
      replacementDomain: forbidden.replacementDomain
    });
    preScrubDb.pragma('wal_checkpoint(TRUNCATE)');
    vacuumIntoOwnedStage(preScrubDb, workingPath, {
      ownership,
      journal,
      journalName: 'working',
      label: 'sanitizer working file'
    });
    preScrubDb.close();
    preScrubDb = null;
    fs.chmodSync(workingPath, 0o600);
    fsyncFile(workingPath);
    journal.advance('unprivileged-stage-ready');
    unlinkOwnedFile(ownership, preScrubPath, 'pre-scrub staging file');
    fsyncDirectory(path.dirname(outputPath));
  } finally {
    if (preScrubDb) preScrubDb.close();
    if (ownership.has(path.resolve(preScrubPath))) {
      unlinkOwnedFile(ownership, preScrubPath, 'pre-scrub staging file');
    }
  }

  let outputDb = new Database(workingPath);
  let afterDigest;
  try {
    const outputProfile = validateManifest(manifestDocument, outputDb);
    if (outputProfile.schemaVersion !== manifest.schemaVersion) {
      throw new Error('working copy changed exact sanitization profile');
    }
    for (const contextKey of collectExpectedOutputContextKeys(outputDb, manifest, {
      replacementDomain: forbidden.replacementDomain
    })) {
      forbidden.authorizedOutputContextKeys.add(contextKey);
    }
    const fts = manifest.fts || [];
    const ftsDefinitions = fts.map((entry) => {
      const row = outputDb.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(entry.virtualName);
      if (!row || !row.sql) throw new Error(`missing FTS definition ${entry.virtualName}`);
      return { ...entry, sql: row.sql };
    });
    for (const entry of ftsDefinitions) outputDb.exec(`DROP TABLE ${quoteIdentifier(entry.virtualName)}`);
    const triggers = sanitizeBaseTables(outputDb, manifest, {
      restoreTriggers: false,
      replacementDomain: forbidden.replacementDomain
    });
    for (const entry of ftsDefinitions) outputDb.exec(entry.sql);
    rebuildDerivedData(outputDb, manifest);
    authorizeVerifiedRebuildOutputs(outputDb, manifest, forbidden.authorizedOutputContextKeys);
    assertReplacementSentinelsConfined(outputDb, manifest);
    for (const trigger of triggers) outputDb.exec(trigger.sql);
    journal.advance('logical-sanitization-complete');
    outputDb.pragma('wal_checkpoint(TRUNCATE)');
    afterDigest = sqliteDigest.databaseDigest(outputDb, FTS_MANIFEST);
    assertTopologyPreserved(beforeDigest, afterDigest, 'sanitized database');
    const afterCounts = sourceCounts(outputDb, manifest);
    assertSemanticShapePreserved(semanticShape, captureSemanticShape(outputDb, manifest));
    const afterNulls = sourceNullTopology(outputDb, manifest);
    if (JSON.stringify(afterCounts) !== JSON.stringify(counts)) throw new Error('sanitizer changed base-table row counts');
    if (JSON.stringify(afterNulls) !== JSON.stringify(nulls)) throw new Error('sanitizer changed NULL topology');
    for (const [key, expected] of Object.entries(cardinality)) {
      const [table, column] = key.split('.');
      const actual = equalityCardinality(outputDb, table, column);
      if (actual.nonnull !== expected.nonnull || actual.cardinality !== expected.cardinality) {
        throw new Error(`sanitizer changed equality cardinality for ${key}`);
      }
    }
    if (outputDb.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('sanitized database quick_check failed');
    if (outputDb.pragma('foreign_key_check').length) throw new Error('sanitized database foreign_key_check failed');
    outputDb.pragma('wal_checkpoint(TRUNCATE)');
    vacuumIntoOwnedStage(outputDb, publishPath, {
      ownership,
      journal,
      journalName: 'publish',
      label: 'sanitizer publication file'
    });
    outputDb.close();
    outputDb = null;
  } finally {
    if (outputDb) outputDb.close();
  }
  fs.chmodSync(publishPath, 0o600);
  zeroSqliteNonLiveRegions(publishPath);
  fsyncFile(publishPath);
  rejectSidecars(workingPath, 'sanitizer staging database');
  rejectSidecars(publishPath, 'sanitized publish database');
  assertNoForbiddenValues(publishPath, forbidden, manifest);
  journal.advance('compact-scan-complete');
  const finalDb = new Database(publishPath);
  let finalDigest;
  let ftsCanaries;
  try {
    const finalProfile = validateManifest(manifestDocument, finalDb);
    if (finalProfile.schemaVersion !== manifest.schemaVersion) {
      throw new Error('published copy changed exact sanitization profile');
    }
    assertSemanticShapePreserved(semanticShape, captureSemanticShape(finalDb, manifest));
    assertReplacementSentinelsConfined(finalDb, manifest);
    finalDigest = sqliteDigest.databaseDigest(finalDb, FTS_MANIFEST);
    sqliteDigest.verifyKnowledgeChunksFtsIntegrity(finalDb, FTS_MANIFEST, { checkMainIntegrity: true });
    ftsCanaries = verifyDeterministicFtsCanaries(finalDb);
  } finally {
    finalDb.close();
  }
  if (finalDigest.topologySha256 !== afterDigest.topologySha256 || finalDigest.logicalSha256 !== afterDigest.logicalSha256) {
    throw new Error('final compacted database digest changed');
  }
  assertFileIdentity(sourcePath, sourceIdentity, 'source database');
  unlinkOwnedFile(ownership, workingPath, 'sanitizer working file');
  publishOwnedFileNoReplace(ownership, publishPath, outputPath, (identity) => {
    journal.recordPathIdentity('publishedOutput', outputPath, identity);
  });
  fsyncFile(outputPath);
  fsyncDirectory(path.dirname(outputPath));
  rejectSidecars(outputPath, 'sanitized output');
  assertFileIdentity(sourcePath, sourceIdentity, 'source database');
  const outputSha256 = sha256(fs.readFileSync(outputPath));
  const report = {
    format: REPORT_VERSION,
    sourceVersion: manifest.schemaVersion,
    tableCount: Object.keys(counts).length,
    rowCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
    classifiedValueCount: forbidden.classifiedValues,
    outputSha256,
    ftsCanaryCount: ftsCanaries.count,
    ftsCanarySha256: ftsCanaries.sha256,
    topologySha256: afterDigest.topologySha256,
    logicalSha256: afterDigest.logicalSha256,
    fts: afterDigest.fts.map((entry) => ({ virtualName: entry.virtualName, sha256: entry.sha256 }))
  };
  journal.complete();
  return Object.freeze(report);
}

function sanitizeProductionShape(options) {
  if (!options || typeof options.outputPath !== 'string') {
    throw new Error('sourcePath and outputPath are required for sanitization');
  }
  const outputPath = path.resolve(options.outputPath);
  const journalPath = path.resolve(options.journalPath || `${outputPath}.run.json`);
  const ownership = new Map();
  const artifacts = [
    `${outputPath}.root-prescrub-${process.pid}`,
    `${outputPath}.sanitized-stage-${process.pid}`,
    `${outputPath}.publish-${process.pid}`
  ];
  try {
    return sanitizeProductionShapePipeline({ ...options, _ownedFiles: ownership });
  } catch (error) {
    if (error.cleanupUnsafe) throw error;
    const cleanupErrors = [];
    const removeFile = (candidate) => {
      const resolved = path.resolve(candidate);
      if (!ownership.has(resolved)) return;
      try {
        unlinkOwnedFile(ownership, resolved, path.basename(resolved));
      } catch (caught) {
        cleanupErrors.push(`${path.basename(resolved)}: ${caught.message}`);
      }
      for (const target of sidecarPaths(candidate)) {
        try {
          if (ownership.has(path.resolve(target))) unlinkOwnedFile(ownership, target, path.basename(target));
        } catch (caught) {
          cleanupErrors.push(`${path.basename(target)}: ${caught.message}`);
        }
      }
    };
    for (const artifact of artifacts) removeFile(artifact);
    removeFile(outputPath);
    if (cleanupErrors.length === 0) removeFile(journalPath);
    try { fsyncDirectory(path.dirname(outputPath)); } catch (caught) { cleanupErrors.push(caught.message); }
    if (cleanupErrors.length > 0) {
      error.message += `; sanitizer cleanup remains journaled: ${cleanupErrors.join('; ')}`;
      error.cleanupUnsafe = true;
    }
    throw error;
  }
}

function parseCli(argv) {
  const options = { mode: 'local' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key || !key.startsWith('--') || seen.has(key)) throw new Error(`invalid or duplicate argument ${key || ''}`);
    seen.add(key);
    if (key === '--production' || key === '--worker') {
      if (options.mode !== 'local') throw new Error('sanitizer mode is ambiguous');
      options.mode = key === '--production' ? 'production' : 'worker';
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    index += 1;
    if (key === '--source') options.sourcePath = value;
    else if (key === '--output') options.outputPath = value;
    else if (key === '--manifest') options.manifestPath = value;
    else if (key === '--journal-root') options.journalRoot = value;
    else if (key === '--run-root') options.runRoot = value;
    else if (key === '--run-id') options.runId = value;
    else if (key === '--lifecycle-fence-fd') options.lifecycleFenceFd = Number(value);
    else if (key === '--lifecycle-fence-device') options.lifecycleFenceDevice = value;
    else if (key === '--lifecycle-fence-inode') options.lifecycleFenceInode = value;
    else throw new Error(`unknown argument ${key}`);
  }
  if (!options.sourcePath || !options.outputPath) throw new Error('--source and --output are required');
  if (options.runId !== undefined && !/^[0-9a-f]{32}$/.test(options.runId)) throw new Error('--run-id must be 32 lowercase hexadecimal characters');
  if (options.mode === 'worker' && options.runId === undefined) throw new Error('--worker requires a valid --run-id');
  if (options.mode === 'local' && options.runId !== undefined) throw new Error('--run-id is reserved for production and worker modes');
  const hasFenceFd = options.lifecycleFenceFd !== undefined;
  const hasFenceIdentity = options.lifecycleFenceDevice !== undefined || options.lifecycleFenceInode !== undefined;
  if (options.mode === 'worker') {
    if (options.lifecycleFenceFd !== DEFAULT_LIFECYCLE_FENCE_FD
        || !/^\d+$/.test(options.lifecycleFenceDevice || '')
        || !/^\d+$/.test(options.lifecycleFenceInode || '')) {
      throw new Error('--worker requires the exact inherited lifecycle fence descriptor identity');
    }
  } else if (hasFenceIdentity) {
    throw new Error('lifecycle fence device/inode arguments are reserved for worker mode');
  } else if (hasFenceFd && (
    options.mode !== 'production' || options.lifecycleFenceFd !== DEFAULT_LIFECYCLE_FENCE_FD
  )) {
    throw new Error('inherited lifecycle fence descriptor is invalid for this mode');
  }
  return options;
}

if (require.main === module) {
  (async () => {
    let signalController = null;
    let workerLifecycleFence = null;
    const signalHandlers = new Map();
    try {
      const options = parseCli(process.argv.slice(2));
      let report;
      if (options.mode === 'production') {
        signalController = new AbortController();
        for (const signalName of ['SIGINT', 'SIGTERM']) {
          const handler = () => signalController.abort(new Error(signalName));
          signalHandlers.set(signalName, handler);
          process.once(signalName, handler);
        }
        report = await runProductionCoordinator({ ...options, signal: signalController.signal });
      }
      else {
        if (options.mode === 'worker') {
          workerLifecycleFence = adoptInheritedLifecycleFence({
            fd: options.lifecycleFenceFd,
            device: options.lifecycleFenceDevice,
            inode: options.lifecycleFenceInode
          });
        }
        report = sanitizeProductionShape({
          ...options,
          disableJournal: options.mode === 'worker'
        });
      }
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } catch (error) {
      process.stderr.write(`sanitization gate failed: ${error.message}\n`);
      process.exitCode = 1;
    } finally {
      for (const [signalName, handler] of signalHandlers) process.removeListener(signalName, handler);
      if (workerLifecycleFence) workerLifecycleFence.release();
    }
  })();
}

module.exports = {
  DEFAULT_LIFECYCLE_FENCE_FD,
  DEFAULT_LIFECYCLE_FENCE_PATH,
  DEFAULT_WORKER_DEADLINE_MS,
  DEFAULT_WORKER_KILL_OBSERVATION_MS,
  DEFAULT_WORKER_TERMINATION_GRACE_MS,
  FTS_MANIFEST,
  MANIFEST_VERSION,
  REPORT_VERSION,
  STRUCTURAL_COLUMN_POLICY,
  STRUCTURAL_POLICY_SHA256,
  STRUCTURAL_POLICY_VALIDATOR_VERSION,
  actualInventory,
  assertProductionCoordinatorEnvironment,
  classifyInventoryColumn,
  manifestFromInventory,
  sanitizeProductionShape,
  verifyDeterministicFtsCanaries,
  validateManifest,
  _testing: Object.freeze({
    acquireProductionLifecycleFence,
    adoptInheritedLifecycleFence,
    buildIsolatedWorkerLaunch,
    assertNoForbiddenValues,
    assertNoSecretCopies,
    assertNoRawLeaks,
    assertReplacementSentinelsConfined,
    assertJsonSentinels,
    rebuildCampaignWorkflowDispatchEvidence,
    assertSemanticShapePreserved,
    captureSemanticShape,
    collectForbiddenValues,
    collectSecretOnlySourceProbes,
    scrubSecretCopiesInPlace,
    createEphemeralIdentity,
    createRunJournal,
    manifestProfileForVersion,
    jsonColumnPolicy,
    assertStructuralValueAllowed,
    launchIsolatedWorker,
    preparePrivilegedSource,
    parseCli,
    removeEphemeralIdentity,
    runProductionCoordinator,
    stableToken,
    storageFrame,
    transformedValue,
    validateSecurePath,
    vacuumIntoOwnedStage
  })
};
