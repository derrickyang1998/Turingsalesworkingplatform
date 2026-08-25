const runtimeConfig = require('./config/runtime_config');
const LOCAL_UPLOAD_WORKER_MODE = explicitLocalUploadWorkerMode();
const PHASE4_ONE_REQUEST_REPLAY_MODE = explicitPhase4OneRequestReplayMode();
runtimeConfig.loadPlatformEnvironment();
const { jwtSecret: JWT_SECRET } = runtimeConfig.validateNetworkRuntimeConfig();
const PORT = process.env.PORT || 3002;
const SERVER_LISTEN_ARGS = runtimeConfig.serverListenArgs(PORT);
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const db = require('./db');
const knowledgeService = require('./services/knowledge_service');
const aiService = require('./services/ai_service');
const idempotency = require('./services/idempotency_service');
const uploadAdmissionIdempotency = Object.freeze({
  reserveProcessingInTransaction(database, input) {
    return idempotency.reserveProcessingInTransaction(database, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      campaignId: input.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      expectedEventCount: input.expectedEventCount,
      operationTimeoutSeconds: input.operationTimeoutSeconds
    });
  },
  completeAdmissionInTransaction: idempotency.completeAdmissionInTransaction,
  failInternalInTransaction: idempotency.failInternalInTransaction
});
const {
  assertUploadSandboxStartupReady,
  createUploadSandboxService,
  loadRuntimeManifest,
  runCommandNoDisclosure,
  workerMain
} = require('./services/upload_sandbox_service');
const obsidianIngestService = require('./services/obsidian_ingest_service');
const businessKnowledge = require('./services/business_knowledge_service');
const vaultExportService = require('./services/vault_export_service');
const crmAccess = require('./services/crm_access_service');
const latestUiCompat = require('./services/latest_ui_compat_service');
const influencerWorkflow = require('./services/influencer_workflow_service');
const publicAssets = require('./services/public_assets_service');
const credentialRotation = require('./services/credential_rotation_service');
const organizationAccess = require('./services/organization_access_service');
const {
  productionSelfTestEnvironment,
  verifyInstalledControlArtifacts
} = require('./services/parser_startup_service');
const {
  getCampaignAccess,
  readDemandProposalCollection
} = require('./services/campaign_access_service');
const campaignContract = require('./contracts/campaign_contract');
const { createPptArtifactStore } = require('./services/ppt_artifact_store');
const { createCampaignPptService } = require('./services/campaign_ppt_service');
const {
  createCampaignCollaborationService
} = require('./services/campaign_collaboration_service');
const registerCampaignRoutes = require('./routes_campaigns');
const {
  createCampaignPptBridgeHandler
} = registerCampaignRoutes;
const {
  CampaignLinkServiceError,
  createCampaignLinkService,
  validateLegacyKnowledgeBody
} = require('./services/campaign_link_service');
const {
  Phase4RequestError,
  createPhase4RequestPipeline
} = require('./middleware/phase4_request_pipeline');
const app = express();
app.set('trust proxy', 'loopback');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'turingmarket.db');
const TOKEN_EXPIRY = '24h';
const TMP_DIR = path.resolve(process.env.TMP_DIR || path.join(__dirname, '..', 'tmp'));
const PPT_CACHE_DIR = path.resolve(
  process.env.PPT_CACHE_DIR || path.join(__dirname, '..', 'ppt-cache')
);
const UPLOAD_SANDBOX_SPOOL_ROOT = path.resolve(
  process.env.UPLOAD_SANDBOX_SPOOL_ROOT || '/var/lib/turingmarket-parser/jobs'
);
const RELEASE_PINNED_UPLOAD_MANIFEST_SHA256 =
  '44db310046efe65bd68c110313b4887995c73e276e7d58f65fe037c09a973c5b';
const UPLOAD_SANDBOX_SELF_TEST_RUNNER =
  '/usr/local/libexec/turingmarket/upload_sandbox_self_test';
const REQUIRED_UPLOAD_SANDBOX_SELF_TESTS = Object.freeze([
  'identity',
  'mount_isolation',
  'syscall_denial',
  'network_denial',
  'socket_creation_denial',
  'host_log_socket_denial',
  'aio_socket_bypass_denial',
  'pid_namespace_sibling_fd_denial',
  'result_inode_metadata_denial',
  'write_escape_denial',
  'aggregate_memory_pressure',
  'aggregate_cpu_pressure',
  'aggregate_task_pressure',
  'scratch_pressure',
  'private_temp_write_denial',
  'dev_submount_write_denial',
  'writable_filesystem_inventory',
  'output_pressure',
  'xlsx_parsing',
  'pptx_parsing',
  'ocr_inference'
]);
const campaignPptService = createCampaignPptService(db, {
  artifactStore: createPptArtifactStore({ rootDir: PPT_CACHE_DIR }),
  tempDir: TMP_DIR,
  runPptGenerator({ payload, outputPath }) {
    const workDir = path.dirname(outputPath);
    const dataPath = path.join(workDir, 'ppt-payload.json');
    fs.writeFileSync(dataPath, JSON.stringify(payload), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    try {
      const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
      childProcess.execFileSync(
        python,
        [path.join(__dirname, 'generate_ppt.py'), dataPath, outputPath],
        {
          timeout: 60_000,
          cwd: __dirname,
          stdio: 'pipe',
          env: runtimeConfig.pythonChildEnvironment()
        }
      );
    } finally {
      fs.rmSync(dataPath, { force: true });
    }
  }
});
const campaignCollaborationService = createCampaignCollaborationService(db);
const campaignPptBridgeHandler = createCampaignPptBridgeHandler(campaignPptService);
let campaignPptJanitor = null;
let uploadSandboxService = null;
let phase4RequestPipeline = null;
let uploadSandboxReadiness = null;

// Middleware
app.use(cors());
const phase4PolicyNames = [
  'CAMPAIGN_OPTIONS',
  'CAMPAIGN_CREATE',
  'CAMPAIGN_LIST',
  'CAMPAIGN_DETAIL',
  'CAMPAIGN_UPDATE',
  'CAMPAIGN_TRANSITION',
  'CAMPAIGN_OPERATIONAL_ACTION',
  'CAMPAIGN_TRANSFER',
  'CAMPAIGN_LINK_ATTACH',
  'CAMPAIGN_LINK_CORRECT',
  'CAMPAIGN_LINK_CANDIDATES',
  'CAMPAIGN_WORKSPACE',
  'CAMPAIGN_KNOWLEDGE_LIST',
  'CAMPAIGN_KNOWLEDGE_DETAIL',
  'CAMPAIGN_REVIEW_CREATE',
  'CAMPAIGN_PROPOSAL_PPT_GENERATE',
  'LEGACY_COLLABORATION_CREATE',
  'LEGACY_COLLABORATION_UPDATE',
  'LEGACY_DEMAND_CREATE',
  'LEGACY_PROPOSAL_CREATE',
  'LEGACY_KNOWLEDGE_CREATE',
  'LEGACY_KNOWLEDGE_INGEST',
  'KNOWLEDGE_USE',
  'LEGACY_AI_CHAT',
  'SHARED_KNOWLEDGE_UPLOAD',
  'SHARED_INFLUENCER_UPLOAD',
  'SHARED_DEMAND_PARSE_FILE',
  'CRM_LEAD_CREATE',
  'CRM_LEAD_UPDATE',
  'CRM_LEAD_CONVERT',
  'CRM_CUSTOMER_CREATE',
  'CRM_CUSTOMER_UPDATE',
  'CRM_CUSTOMER_ASSIGN',
  'CRM_CUSTOMER_RETURN_POOL',
  'CRM_CUSTOMER_RETURN',
  'CRM_CUSTOMER_CLAIM',
  'CRM_CUSTOMER_ARCHIVE_RESULT',
  'CRM_CUSTOMER_ACTIVITY',
  'CRM_OPPORTUNITY_CREATE',
  'CRM_OPPORTUNITY_UPDATE',
  'CRM_SALES_TARGET_CREATE',
  'CRM_CONTACT_CREATE',
  'CRM_CONTACT_UPDATE',
  'CRM_CONTACT_ARCHIVE',
  'CRM_TASK_CREATE',
  'CRM_TASK_COMPLETE',
  'CRM_TASK_CANCEL',
  'CAMPAIGN_WORKFLOW_RECONCILIATION_OPTIONS',
  'CAMPAIGN_WORKFLOW_RETRY',
  'CAMPAIGN_WORKFLOW_RECONCILE',
  'CAMPAIGN_WORKFLOW_TASK_REASSIGN',
  'WORKFLOW_TEMPLATE_CREATE',
  'WORKFLOW_TEMPLATE_UPDATE',
  'WORKFLOW_TEMPLATE_TRIGGER_GET',
  'WORKFLOW_TEMPLATE_TRIGGER_UPDATE',
  'WORKFLOW_TEMPLATE_PUBLISH',
  'WORKFLOW_TEMPLATE_DELETE',
  'WORKFLOW_TASK_APPROVE',
  'WORKFLOW_TASK_REJECT',
  'WORKFLOW_TASK_COMPLETE',
  'WORKFLOW_INSTANCE_PAUSE',
  'WORKFLOW_INSTANCE_RESUME',
  'WORKFLOW_INSTANCE_CANCEL',
  'CUSTOMER_DELETE',
  'OPPORTUNITY_DELETE'
];
const phase4Registry = campaignContract.createRoutePolicyRegistry(
  phase4PolicyNames.map((name) => campaignContract.REQUEST_POLICIES[name])
);
const sharedWorkflowPolicyIds = new Set([
  'workflow.task.approve',
  'workflow.task.reject',
  'workflow.task.complete',
  'workflow.instance.pause',
  'workflow.instance.resume',
  'workflow.instance.cancel'
]);

function campaignLinkedSharedWorkflowOwner(request, policy) {
  if (!sharedWorkflowPolicyIds.has(policy.id)) return true;
  try {
    const pathname = new URL(
      request.originalUrl || request.url || request.path,
      'http://phase4.local'
    ).pathname;
    const match = /^\/api\/workflow\/(tasks|instances)\/([^/]+)\/(approve|reject|complete|pause|resume|cancel)\/?$/i
      .exec(pathname);
    if (!match) return true;
    const rawId = match[2];
    if (!/^[1-9][0-9]*$/.test(rawId)) return true;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1) return true;
    const instance = match[1].toLowerCase() === 'tasks'
      ? db.prepare(`
          SELECT instance.*
          FROM workflow_tasks task
          JOIN workflow_instances instance ON instance.id=task.instance_id
          WHERE task.id=?
        `).get(id)
      : db.prepare('SELECT * FROM workflow_instances WHERE id=?').get(id);
    if (!instance) return false;
    if (
      instance.org_id !== null ||
      instance.campaign_id !== null ||
      instance.campaign_event_id !== null ||
      instance.campaign_dispatch_id !== null ||
      instance.business_type === 'campaign'
    ) {
      return true;
    }
    return Boolean(db.prepare(`
      SELECT 1
      FROM campaign_record_links
      WHERE record_type='workflow_instance'
        AND relation_type='workflow'
        AND record_id=?
        AND revoked_at IS NULL
      LIMIT 1
    `).get(String(instance.id)));
  } catch (_error) {
    return true;
  }
}
function legacyJsonMediaType(req) {
  const value = req.headers && req.headers['content-type'];
  return (
    (!phase4RequestPipeline || !phase4RequestPipeline.shouldSkipGlobalBodyParser(req)) &&
    typeof value === 'string' &&
    /^application\/json(?:\s*;|$)/i.test(value.trim())
  );
}

function legacyUrlencodedMediaType(req) {
  const value = req.headers && req.headers['content-type'];
  return (
    (!phase4RequestPipeline || !phase4RequestPipeline.shouldSkipGlobalBodyParser(req)) &&
    typeof value === 'string' &&
    /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(value.trim())
  );
}

app.use(express.json({ limit: '50mb', type: legacyJsonMediaType }));
app.use(express.urlencoded({
  extended: true,
  type: legacyUrlencodedMediaType
}));
app.use((req, res, next) => {
  if (!phase4RequestPipeline) {
    return res.status(503).json({
      error: 'Upload sandbox readiness has not completed.',
      code: 'UPLOAD_SANDBOX_NOT_READY',
      request_id: identityRequestId(req) || 'phase4-request'
    });
  }
  return phase4RequestPipeline.middleware(req, res, next);
});

// Serve only the browser assets required by the platform UI.
publicAssets.registerPublicAssets(app, express, path.join(__dirname, '..'));

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

// ===== AUTH MIDDLEWARE =====
function bearerTokenFromAuthorization(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match ? match[1] : null;
}

function authenticateRequest(req) {
  if (req.user && req.authContext) {
    return {
      ok: true,
      user: req.user,
      authContext: req.authContext
    };
  }
  const token = bearerTokenFromAuthorization(req.headers.authorization);
  if (!token) return { ok: false, error: 'No token provided' };

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const session = db.prepare(`SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')`).get(token);
    if (!session) return { ok: false, error: 'Session expired' };

    const user = db.prepare('SELECT id, username, display_name, role, department, api_quota FROM users WHERE id = ? AND is_active = 1').get(decoded.userId);
    if (!user) return { ok: false, error: 'User not found' };
    const scope = organizationAccess.resolveOrganizationScope(db, {
      userId: user.id,
      repairMissing: false
    });
    if (!scope.ok) {
      return { ok: false, error: 'Organization access unavailable' };
    }

    req.user = user;
    req.authContext = scope.authContext;
    return {
      ok: true,
      user,
      authContext: scope.authContext
    };
  } catch(e) {
    return { ok: false, error: 'Invalid token' };
  }
}

function authenticatePhase4Request(req) {
  const authentication = authenticateRequest(req);
  return authentication.ok ? authentication.user : null;
}

function authMiddleware(req, res, next) {
  const authentication = authenticateRequest(req);
  if (!authentication.ok) {
    return res.status(401).json({ error: authentication.error });
  }
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

function boolParam(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return value === true || value === 'true' || value === '1' || value === 1;
}

function hashPassword(password) {
  const salt = bcrypt.genSaltSync(10);
  return bcrypt.hashSync(password, salt);
}

function identityRequestId(req) {
  const value = req.headers && req.headers['x-request-id'];
  return campaignContract.isValidRequestId(value) ? value : null;
}

function explicitLocalUploadWorkerMode() {
  const mode = process.env.TM_UPLOAD_SANDBOX_TEST_MODE;
  if (mode === undefined || mode === '') return false;
  const portText = process.env.PORT;
  const port = typeof portText === 'string' && /^[1-9][0-9]{0,4}$/.test(portText)
    ? Number(portText)
    : null;
  if (
    mode !== 'local-worker' ||
    process.env.NODE_ENV !== 'test' ||
    process.env.TM_DISABLE_DOTENV !== '1' ||
    process.env.SERVER_HOST !== '127.0.0.1' ||
    port === null ||
    port > 65535 ||
    port === 3002
  ) {
    throw new Error('Invalid upload sandbox test adapter configuration');
  }
  return true;
}

function explicitPhase4OneRequestReplayMode() {
  const mode = process.env.TM_PHASE4_ONE_REQUEST_REPLAY_MODE;
  if (mode === undefined || mode === '') return false;
  if (
    mode !== '1' ||
    !LOCAL_UPLOAD_WORKER_MODE ||
    process.env.TM_PHASE4_ONE_REQUEST_REPLAY_USER_ID !== '1' ||
    typeof process.send !== 'function'
  ) {
    throw new Error('Invalid Phase 4 one-request replay configuration');
  }
  return true;
}

function uploadSelfTestResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Upload sandbox self-test result is invalid');
  }
  const result = value.format === 'tm-parser-self-test-observations-v1'
    ? value.self_tests
    : value;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Upload sandbox self-test result is invalid');
  }
  return Object.freeze(Object.fromEntries(
    REQUIRED_UPLOAD_SANDBOX_SELF_TESTS.map((name) => [name, result[name] === true])
  ));
}

function emitUploadSandboxControllerEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runProductionUploadSandboxSelfTests() {
  if (process.platform !== 'linux') {
    throw new Error('Production upload sandbox self-tests require Linux');
  }
  const result = await runCommandNoDisclosure(
    UPLOAD_SANDBOX_SELF_TEST_RUNNER,
    ['--json'],
    {
      captureStdout: true,
      timeoutMs: 120_000,
      env: productionSelfTestEnvironment()
    }
  );
  return uploadSelfTestResult(JSON.parse(result.stdout));
}

function localUploadReadinessSnapshot() {
  return Object.freeze({
    ready: true,
    manifestSha256: loadRuntimeManifest().manifestSha256,
    parserIdentity: Object.freeze({
      user: 'turingmarket-parser',
      group: 'turingmarket-parser',
      home: '/nonexistent',
      shell: '/usr/sbin/nologin',
      locked: true,
      supplementary_groups: [],
      uid: 64123,
      gid: 64123
    })
  });
}

function localUploadReadinessAdapters() {
  return {
    verifyIdentity: async () => ({
      user: 'turingmarket-parser',
      group: 'turingmarket-parser',
      home: '/nonexistent',
      shell: '/usr/sbin/nologin',
      locked: true,
      supplementary_groups: [],
      uid: 64123,
      gid: 64123
    }),
    verifyInstalledArtifacts: async () => {},
    systemdVersion: async () => loadRuntimeManifest().manifest.minimum_systemd_version,
    systemctlShow: async (_unitName, expected) => expected,
    staleUnitController: Object.freeze({
      async kill() {},
      async stop() {},
      async resetFailed() {},
      async assertCollected() {}
    }),
    runSelfTests: async () => uploadSelfTestResult(
      Object.fromEntries(REQUIRED_UPLOAD_SANDBOX_SELF_TESTS.map((name) => [name, true]))
    )
  };
}

function recoverUploadAdmissions() {
  return db.transaction(() => (
    idempotency.recoverParserAdmissionsInTransaction(db)
  )).immediate();
}

function resolveUploadPrincipal(req) {
  const organizationId = req.authContext && req.authContext.organization &&
    req.authContext.organization.id;
  if (
    !req.user || !Number.isSafeInteger(req.user.id) || req.user.id < 1 ||
    !Number.isSafeInteger(organizationId) || organizationId < 1
  ) {
    throw uploadAuthorityError(401, 'AUTHORITY_REVOKED', 'Current upload authority could not be verified.');
  }
  return Object.freeze({ userId: req.user.id, organizationId });
}

function uploadAuthorityError(statusCode, code, message) {
  const error = new Error(message);
  error.name = 'UploadAuthorityError';
  error.statusCode = statusCode;
  error.status = statusCode;
  error.code = code;
  return error;
}

function currentUploadAuthority(database, state) {
  let decoded;
  try {
    decoded = jwt.verify(state.token, JWT_SECRET);
  } catch (_error) {
    throw uploadAuthorityError(401, 'AUTHORITY_REVOKED', 'Current upload authority could not be verified.');
  }
  if (!decoded || Number(decoded.userId) !== state.userId) {
    throw uploadAuthorityError(401, 'AUTHORITY_REVOKED', 'Current upload authority no longer matches the admitted request.');
  }
  const session = database.prepare(`
    SELECT user_id
    FROM sessions
    WHERE token=? AND user_id=? AND expires_at>datetime('now')
  `).get(state.token, state.userId);
  const user = database.prepare(`
    SELECT id,username,display_name,role,department,api_quota
    FROM users
    WHERE id=? AND is_active=1
  `).get(state.userId);
  if (!session || !user || session.user_id !== state.userId) {
    throw uploadAuthorityError(401, 'AUTHORITY_REVOKED', 'Current upload authority could not be verified.');
  }
  const scope = organizationAccess.resolveOrganizationScope(database, {
    userId: state.userId,
    repairMissing: false
  });
  if (
    !scope.ok || !scope.authContext || !scope.authContext.organization ||
    scope.authContext.organization.id !== state.organizationId
  ) {
    throw uploadAuthorityError(401, 'AUTHORITY_REVOKED', 'Current organization authority could not be verified.');
  }
  if (state.campaignId !== null) {
    const access = getCampaignAccess(database, {
      userId: state.userId,
      campaignId: state.campaignId
    });
    if (!access.ok || access.campaign.org_id !== state.organizationId) {
      throw uploadAuthorityError(
        access.status || 403,
        access.code || 'CAMPAIGN_FORBIDDEN',
        access.kind === 'not_found' ? 'Campaign not found.' : 'Campaign access is forbidden.'
      );
    }
  }
  return {
    identity: Object.freeze({
      userId: state.userId,
      organizationId: state.organizationId,
      campaignId: state.campaignId
    }),
    user
  };
}

function createUploadAuthority(req, campaignId) {
  const admission = req.phase4Request && req.phase4Request.admission;
  const principal = resolveUploadPrincipal(req);
  const token = bearerTokenFromAuthorization(req.headers && req.headers.authorization);
  if (
    !admission || !token ||
    admission.userId !== principal.userId ||
    admission.organizationId !== principal.organizationId
  ) {
    throw uploadAuthorityError(401, 'AUTHORITY_REVOKED', 'Current upload authority does not match parser admission.');
  }
  const state = Object.freeze({
    token,
    userId: admission.userId,
    organizationId: admission.organizationId,
    campaignId
  });
  return Object.freeze({
    userId: state.userId,
    organizationId: state.organizationId,
    campaignId,
    assertFresh(input) {
      if (
        !input || input.userId !== state.userId ||
        input.organizationId !== state.organizationId ||
        input.campaignId !== state.campaignId ||
        typeof input.phase !== 'string' || input.phase.length === 0
      ) {
        throw uploadAuthorityError(401, 'AUTHORITY_REVOKED', 'Current upload authority request is invalid.');
      }
      const database = input.db;
      return currentUploadAuthority(database, state).identity;
    },
    readFresh(database) {
      return currentUploadAuthority(database, state);
    }
  });
}

function assertUploadAuthorityFresh(authority) {
  return authority.assertFresh({
    db,
    phase: 'sandbox_authorization',
    userId: authority.userId,
    organizationId: authority.organizationId,
    campaignId: authority.campaignId
  });
}

function renewUploadAdmissionLease(admission) {
  return db.transaction(() => idempotency.renewLeaseInTransaction(db, {
    ledgerId: admission.ledgerId,
    requestHash: admission.requestHash,
    leaseToken: admission.leaseToken
  })).immediate();
}

function requestUploadSignal(req) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Upload request was disconnected'));
  req.once('aborted', abort);
  return Object.freeze({
    signal: controller.signal,
    dispose() { req.removeListener('aborted', abort); }
  });
}

function multipartTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch (_error) {}
  return value.split(/[,;\n|]/).map((tag) => tag.trim()).filter(Boolean);
}

function sandboxWarning(data) {
  if (Array.isArray(data.warnings) && data.warnings.length) {
    return data.warnings.join(' | ');
  }
  return data.warning || undefined;
}

function projectKnowledgeUpload(req, parsed, actor) {
  const data = parsed && parsed.data ? parsed.data : {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const kind = data.kind || (rows.length ? 'table' : 'document');
  const content = typeof data.content === 'string' ? data.content : String(data.text || '');
  const metadata = {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    kind,
    row_count: rows.length
  };
  for (const [name, value] of Object.entries({
    parser: data.parser,
    fallback: data.fallback,
    warning: sandboxWarning(data)
  })) {
    if (value !== undefined) metadata[name] = value;
  }
  return {
    rows: rows.length,
    body: {
      title: req.body.title || req.file.originalname,
      summary: req.body.summary || '',
      content,
      entry_type: req.body.entry_type || (kind === 'table' ? 'uploaded_table' : 'uploaded_document'),
      source_type: req.body.source_type || 'knowledge_upload',
      source_id: req.body.source_id || req.file.originalname,
      visibility: req.body.visibility || 'private',
      tags: multipartTags(req.body.tags),
      business_type: req.body.business_type,
      business_id: req.body.business_id,
      created_by: actor.id,
      actor_role: actor.role,
      metadata
    }
  };
}

function linkedKnowledgeBody(campaignId, projected) {
  return {
    campaign_id: campaignId,
    entry_type: projected.body.entry_type,
    title: projected.body.title,
    summary: projected.body.summary,
    content: projected.body.content,
    tags: projected.body.tags,
    source_type: projected.body.source_type,
    source_id: projected.body.source_id,
    visibility: projected.body.visibility,
    metadata: projected.body.metadata
  };
}

function legacyUploadError(res, error) {
  const status = Number.isSafeInteger(error && error.statusCode)
    ? error.statusCode
    : Number.isSafeInteger(error && error.status)
      ? error.status
      : 500;
  return res.status(status).json({
    error: error && error.message ? error.message : 'Upload request failed.'
  });
}

function phase4UploadHookError(error) {
  if (
    error &&
    (error.name === 'UploadSandboxError' || error.name === 'IdempotencyServiceError') &&
    Number.isSafeInteger(error.statusCode || error.status) &&
    typeof error.code === 'string'
  ) {
    return new Phase4RequestError(
      error.statusCode || error.status,
      error.code,
      error.message,
      error.details
    );
  }
  return error;
}

function nextUserIdInTransaction() {
  const row = db.prepare(`
    SELECT MAX(high_water)+1 AS id
    FROM (
      SELECT COALESCE(MAX(id),0) AS high_water
      FROM users
      UNION ALL
      SELECT COALESCE((
        SELECT seq
        FROM sqlite_sequence
        WHERE name='users'
      ),0)
    )
  `).get();
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1) {
    throw new Error('User identifier allocation failed');
  }
  return row.id;
}

function createUserWithIdentity(input) {
  const create = db.transaction(() => {
    const userId = nextUserIdInTransaction();
    organizationAccess.runIdentityProjectionTransaction(db, {
      actorUserId: input.actorUserId,
      subjectUserId: userId,
      reason: 'user_create',
      requestId: input.requestId,
      mutateUser() {
        db.prepare(`
          INSERT INTO users (
            id,username,password_hash,display_name,role,email,department
          ) VALUES (?,?,?,?,?,?,?)
        `).run(
          userId,
          input.username,
          input.passwordHash,
          input.displayName,
          input.role,
          input.email,
          input.department
        );
      }
    });
    return userId;
  });
  return create.immediate();
}

function updateUserWithIdentity(input) {
  if (!campaignContract.isCanonicalSafeIntegerPathSegment(input.userId)) {
    return { found: false, invalid: true };
  }
  const userId = Number(input.userId);
  const update = db.transaction(() => {
    const current = db.prepare(`
      SELECT id,is_active
      FROM users
      WHERE id=?
    `).get(userId);
    if (!current) return { found: false };
    const requestedActive = input.isActive === undefined || input.isActive === null
      ? current.is_active
      : Number(input.isActive);
    const reason = current.is_active === 1 && requestedActive === 0
      ? 'soft_deactivate'
      : current.is_active !== 1 && requestedActive === 1
        ? 'reactivate'
        : 'admin_update';
    const projection = organizationAccess.runIdentityProjectionTransaction(db, {
      actorUserId: input.actorUserId,
      subjectUserId: current.id,
      reason,
      requestId: input.requestId,
      mutateUser() {
        db.prepare(`
          UPDATE users
          SET
            display_name=COALESCE(?,display_name),
            department=COALESCE(?,department),
            api_quota=COALESCE(?,api_quota),
            is_active=COALESCE(?,is_active),
            role=COALESCE(?,role)
          WHERE id=?
        `).run(
          input.displayName,
          input.department,
          input.apiQuota,
          input.isActive,
          input.role,
          current.id
        );
      }
    });
    return { found: true, projection };
  });
  return update.immediate();
}

function resolveUserCreationPassword(body) {
  const hasSuppliedPassword = Object.prototype.hasOwnProperty.call(body || {}, 'password');
  const password = hasSuppliedPassword
    ? String(body.password || '')
    : credentialRotation.generateTemporaryPassword();
  const policyErrors = credentialRotation.passwordPolicyErrors(password);
  return {
    hasSuppliedPassword,
    password,
    policyErrors
  };
}

function redactSecretValue(value, secret) {
  if (value === undefined || value === null) return value;
  const secretText = String(secret || '');
  if (!secretText) return String(value);
  return String(value).split(secretText).join('[REDACTED]');
}

function normalizePptRequestPayload(body) {
  body = body || {};
  if (!body.outline) return body;
  const outline = body.outline || {};
  const demand = body.demand || {};
  const brand = body.brand || demand.brand || demand.brand_name || demand.company || demand.company_name || outline.title || 'Brand';
  const tagline = body.tagline || outline.subtitle || [demand.product || demand.product_name, demand.target_market || demand.market].filter(Boolean).join(' / ');
  const sections = Array.isArray(outline.sections) ? outline.sections : [];
  return {
    brand,
    tagline,
    title: outline.title || body.title || brand,
    sections: sections.map(function(section) {
      const items = Array.isArray(section.items) ? section.items
        : Array.isArray(section.points) ? section.points
          : String(section.points || section.note || '').split(/\n|;|；/).filter(Boolean);
      return {
        title: section.title || '',
        items: items.map(function(item) { return String(item); }).filter(Boolean)
      };
    }).filter(function(section) { return section.title || section.items.length; }),
    outline,
    demand
  };
}

function aiQuotaGuard(req, res, next) {
  const quota = Number(req.user.api_quota || 0);
  if (!quota || req.user.role === 'admin') return next();
  const used = db.prepare('SELECT COALESCE(SUM(total_tokens), 0) AS total FROM token_usage WHERE user_id = ?').get(req.user.id).total;
  if (used >= quota) return res.status(429).json({ error: 'AI quota exceeded' });
  next();
}

// ===== AUTH ROUTES =====
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const organizationScope = organizationAccess.resolveOrganizationScope(db, {
    userId: user.id,
    repairMissing: true,
    actorUserId: user.id,
    requestId: null
  });
  if (!organizationScope.ok) {
    return res.status(401).json({ error: 'Organization access unavailable' });
  }

  // Create session
  const token = jwt.sign({ userId: user.id, role: user.role, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token, ip_address, expires_at) VALUES (?, ?, ?, ?)').run(user.id, token, req.ip, expiresAt);
  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  // Log activity
  db.prepare('INSERT INTO activity_log (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)').run(user.id, 'login', 'auth', req.ip);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      department: user.department,
      api_quota: user.api_quota
    },
    auth_context: organizationScope.authContext
  });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = bearerTokenFromAuthorization(req.headers.authorization);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  db.prepare('INSERT INTO activity_log (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)').run(req.user.id, 'logout', 'auth', req.ip);
  res.json({ success: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user, auth_context: req.authContext });
});

// ===== DEMAND ROUTES =====
const campaignLinkService = createCampaignLinkService(db);

function campaignLinkRequestId(req) {
  return req.requestId ||
    req.phase4Request && req.phase4Request.requestId ||
    identityRequestId(req) ||
    'campaign-link-request';
}

function sendCampaignLinkResult(res, result) {
  for (const [name, value] of Object.entries(result.headers || {})) {
    res.setHeader(name, value);
  }
  return res.status(result.status).json(result.body);
}

function sendCampaignLinkError(req, res, error) {
  const known = error instanceof CampaignLinkServiceError ||
    error && (
      error.name === 'IdempotencyServiceError' ||
      error.name === 'UploadSandboxError' ||
      error.name === 'UploadAuthorityError'
    );
  const body = {
    error: known ? error.message : 'Campaign-linked record request failed.',
    code: known ? error.code : 'AUDIT_PERSISTENCE_FAILED',
    request_id: campaignLinkRequestId(req)
  };
  if (known && error.details !== undefined) body.details = error.details;
  if (known && error.retryAfterSeconds) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  return res.status(known ? error.statusCode : 500).json(body);
}

function sendAiChatError(req, res, error) {
  const linkedError = error && (
    error.name === 'AIServiceError' ||
    error.name === 'IdempotencyServiceError'
  );
  if (!linkedError) {
    const message = error && error.message ? error.message : 'AI chat request failed.';
    const status = /forbidden|not found/i.test(message) ? 403 : 400;
    return res.status(status).json({ error: message });
  }

  const body = {
    error: error.message,
    code: error.code || 'AI_CHAT_FAILED',
    request_id: campaignLinkRequestId(req)
  };
  if (error.details !== undefined) body.details = error.details;
  if (error.retryAfterSeconds) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  return res.status(error.statusCode || 500).json(body);
}

function sendAiReadError(req, res, error) {
  const knownAuditFailure = error &&
    error.name === 'AIServiceError' &&
    error.code === 'AUDIT_PERSISTENCE_FAILED';
  return res.status(500).json({
    error: knownAuditFailure ? error.message : 'AI conversation read failed.',
    code: 'AUDIT_PERSISTENCE_FAILED',
    request_id: campaignLinkRequestId(req)
  });
}

function hasCampaignId(body) {
  return body !== null && body !== undefined &&
    (typeof body === 'object' || typeof body === 'function') &&
    Object.hasOwn(body, 'campaign_id');
}

function requireCampaignLinkedJson(req) {
  if (
    !req.phase4Request ||
    req.phase4Request.mediaKind !== campaignContract.MEDIA_KINDS.JSON
  ) {
    throw new CampaignLinkServiceError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Campaign-linked knowledge requests require application/json.'
    );
  }
}

function createLegacyDemand(req, res) {
  const { brand_name, company_name, product_name, industry, budget, target_market, platform, data_json } = req.body;
  const result = db.prepare('INSERT INTO demands (user_id, brand_name, company_name, product_name, industry, budget, target_market, platform, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.user.id, brand_name, company_name, product_name, industry, budget, target_market, platform, JSON.stringify(data_json)
  );
  db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'create_demand', 'demand', `Created demand for ${brand_name}`, req.ip);
  try {
    knowledgeService.ingestKnowledge(db, {
      title: '需求归档：' + (brand_name || product_name || result.lastInsertRowid),
      summary: [brand_name, product_name, industry, target_market, budget].filter(Boolean).join(' / '),
      content: JSON.stringify({ brand_name, company_name, product_name, industry, budget, target_market, platform, data_json }, null, 2),
      entry_type: 'demand',
      source_type: 'demand_record',
      source_id: result.lastInsertRowid,
      visibility: 'private',
      tags: ['demand', industry, target_market].filter(Boolean),
      business_type: 'demand',
      business_id: result.lastInsertRowid,
      created_by: req.user.id,
      actor_role: req.user.role
    });
  } catch(e) {}
  res.json({ id: result.lastInsertRowid });
}

app.post('/api/demands', authMiddleware, (req, res) => {
  if (!hasCampaignId(req.body)) return createLegacyDemand(req, res);
  try {
    return sendCampaignLinkResult(res, campaignLinkService.createDemand({
      userId: req.user.id,
      requestId: campaignLinkRequestId(req),
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body,
      ipAddress: req.ip
    }));
  } catch (error) {
    return sendCampaignLinkError(req, res, error);
  }
});

app.get('/api/demands', authMiddleware, (req, res) => {
  const demands = readDemandProposalCollection(db, {
    userId: req.user.id,
    recordType: 'demand',
    search: req.query.search
  });
  res.json({ demands });
});

// ===== PROPOSAL ROUTES =====
function createLegacyProposal(req, res) {
  const { demand_id, template_id, content } = req.body;
  const result = db.prepare('INSERT INTO proposals (user_id, demand_id, template_id, content) VALUES (?, ?, ?, ?)').run(req.user.id, demand_id, template_id, content);
  db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'generate_proposal', 'proposal', `Generated proposal with template ${template_id}`, req.ip);
  try {
    knowledgeService.ingestKnowledge(db, {
      title: '确认方案：' + (demand_id || result.lastInsertRowid),
      summary: String(content || '').slice(0, 240),
      content: content || '',
      entry_type: 'proposal_confirmed',
      source_type: 'proposal_record',
      source_id: result.lastInsertRowid,
      visibility: 'team',
      tags: ['proposal', 'confirmed', template_id].filter(Boolean),
      business_type: 'proposal',
      business_id: result.lastInsertRowid,
      created_by: req.user.id,
      metadata: { demand_id, template_id },
      actor_role: req.user.role
    });
  } catch(e) {}
  res.json({ id: result.lastInsertRowid });
}

app.post('/api/proposals', authMiddleware, (req, res) => {
  if (!hasCampaignId(req.body)) return createLegacyProposal(req, res);
  try {
    return sendCampaignLinkResult(res, campaignLinkService.createProposal({
      userId: req.user.id,
      requestId: campaignLinkRequestId(req),
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body,
      ipAddress: req.ip
    }));
  } catch (error) {
    return sendCampaignLinkError(req, res, error);
  }
});

app.get('/api/proposals', authMiddleware, (req, res) => {
  const proposals = readDemandProposalCollection(db, {
    userId: req.user.id,
    recordType: 'proposal',
    search: req.query.search
  });
  res.json({ proposals });
});

// ===== TOKEN TRACKING =====
app.post('/api/token-usage', authMiddleware, (req, res) => {
  const { model, prompt_tokens, completion_tokens, total_tokens, endpoint } = req.body;
  db.prepare('INSERT INTO token_usage (user_id, model, prompt_tokens, completion_tokens, total_tokens, endpoint) VALUES (?, ?, ?, ?, ?, ?)').run(
    req.user.id, model, prompt_tokens, completion_tokens, total_tokens, endpoint
  );
  res.json({ success: true });
});

app.get('/api/token-usage', authMiddleware, (req, res) => {
  const usage = req.user.role === 'admin'
    ? db.prepare(`
        SELECT u.username, u.display_name, u.department,
               COALESCE(SUM(tu.total_tokens), 0) as total_tokens,
               COALESCE(SUM(tu.prompt_tokens), 0) as prompt_tokens,
               COALESCE(SUM(tu.completion_tokens), 0) as completion_tokens,
               COUNT(tu.id) as request_count,
               MAX(tu.created_at) as last_used
        FROM users u LEFT JOIN token_usage tu ON u.id = tu.user_id
        GROUP BY u.id ORDER BY total_tokens DESC
      `).all()
    : db.prepare('SELECT * FROM token_usage WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ usage });
});

// ===== ADMIN DASHBOARD =====
app.get('/api/admin/overview', authMiddleware, adminOnly, (req, res) => {
  const stats = {
    totalUsers: db.prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1').get().count,
    totalDemands: db.prepare('SELECT COUNT(*) as count FROM demands').get().count,
    totalProposals: db.prepare('SELECT COUNT(*) as count FROM proposals').get().count,
    totalTokens: db.prepare('SELECT COALESCE(SUM(total_tokens), 0) as total FROM token_usage').get().total,
    activeSessions: db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE expires_at > datetime('now')`).get().count,
    todayLogins: db.prepare(`SELECT COUNT(DISTINCT user_id) as count FROM activity_log WHERE action = 'login' AND date(created_at) = date('now')`).get().count,
    demandsByStatus: db.prepare('SELECT status, COUNT(*) as count FROM demands GROUP BY status').all(),
    demandsByUser: db.prepare('SELECT u.display_name, u.department, COUNT(d.id) as count FROM users u LEFT JOIN demands d ON u.id = d.user_id GROUP BY u.id ORDER BY count DESC').all(),
    recentActivity: db.prepare('SELECT a.*, u.display_name FROM activity_log a JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT 50').all(),
    tokenUsageTrend: db.prepare('SELECT date(created_at) as date, SUM(total_tokens) as tokens FROM token_usage GROUP BY date(created_at) ORDER BY date DESC LIMIT 30').all(),
  };
  res.json({ stats });
});

// ===== USER MANAGEMENT (Admin) =====
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, department, email, api_quota, created_at, last_login, is_active FROM users ORDER BY department, id').all();
  res.json({ users });
});

app.post('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const { username, display_name, role, department, email } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const passwordResult = resolveUserCreationPassword(req.body);
  if (passwordResult.policyErrors.length) {
    return res.status(400).json({ error: 'Password policy failed', details: passwordResult.policyErrors });
  }
  const temporaryPassword = passwordResult.password;
  const hash = hashPassword(temporaryPassword);
  try {
    const userId = createUserWithIdentity({
      actorUserId: req.user.id,
      requestId: identityRequestId(req),
      username,
      passwordHash: hash,
      displayName: display_name || username,
      role: role || 'user',
      email: email || '',
      department: department || ''
    });
    res.json({
      id: userId,
      temporary_password: passwordResult.hasSuppliedPassword ? undefined : temporaryPassword,
      message: passwordResult.hasSuppliedPassword ? 'User created with provided password' : 'User created. Share the temporary password securely.'
    });
  } catch(e) {
    res.status(400).json({ error: 'Username may already exist' });
  }
});

app.put('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { display_name, department, api_quota, is_active, role } = req.body;
  try {
    const result = updateUserWithIdentity({
      actorUserId: req.user.id,
      userId: req.params.id,
      requestId: identityRequestId(req),
      displayName: display_name,
      department,
      apiQuota: api_quota,
      isActive: is_active,
      role
    });
    if (result.invalid) return res.status(400).json({ error: 'Invalid user id' });
    res.json({ success: true });
  } catch (_error) {
    res.status(500).json({ error: 'User update failed' });
  }
});

app.delete('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const result = updateUserWithIdentity({
      actorUserId: req.user.id,
      userId: req.params.id,
      requestId: identityRequestId(req),
      displayName: undefined,
      department: undefined,
      apiQuota: undefined,
      isActive: 0,
      role: undefined
    });
    if (result.invalid) return res.status(400).json({ error: 'Invalid user id' });
    res.json({ success: true });
  } catch (_error) {
    res.status(500).json({ error: 'User deactivation failed' });
  }
});

app.post('/api/admin/users/reset-password/:id', authMiddleware, adminOnly, (req, res) => {
  if (!campaignContract.isCanonicalSafeIntegerPathSegment(req.params.id)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  const targetUserId = Number(req.params.id);
  const target = db.prepare('SELECT id, username FROM users WHERE id = ? AND is_active = 1').get(targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const hasSuppliedPassword = Object.prototype.hasOwnProperty.call(req.body || {}, 'password');
  const temporaryPassword = hasSuppliedPassword
    ? String(req.body.password || '')
    : credentialRotation.generateTemporaryPassword();

  try {
    const resetTransaction = db.transaction(function() {
      const auditIp = redactSecretValue(req.ip, temporaryPassword);
      const result = credentialRotation.rotateUserPasswords(db, {
        actorUserId: req.user.id,
        rotations: [{ username: target.username, password: temporaryPassword }],
        invalidateAllSessions: false,
        ipAddress: auditIp,
        reason: 'admin reset'
      });

      db.prepare(`
        INSERT INTO activity_log (user_id, action, module, details, ip_address)
        VALUES (?, ?, ?, ?, ?)
      `).run(req.user.id, 'admin_reset_password', 'security', JSON.stringify({
        actorUserId: req.user.id,
        targetUserId: Number(target.id),
        targetUsername: redactSecretValue(target.username, temporaryPassword),
        sessionsRevoked: result.sessionsRevoked
      }), auditIp);

      return result;
    });
    const result = resetTransaction();

    res.json({
      success: true,
      sessions_revoked: result.sessionsRevoked,
      temporary_password: hasSuppliedPassword ? undefined : temporaryPassword,
      message: hasSuppliedPassword ? 'Password reset to provided value' : 'Password reset. Share the temporary password securely.'
    });
  } catch(e) {
    if (/Password policy failed/.test(e.message)) return res.status(400).json({ error: e.message });
    if (/Active user not found/.test(e.message)) return res.status(404).json({ error: 'User not found' });
    res.status(500).json({ error: e.message });
  }
});

// ===== INVITE SYSTEM =====
app.post('/api/admin/invites', authMiddleware, adminOnly, (req, res) => {
  const code = 'TM' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO team_invites (code, created_by, role, expires_at) VALUES (?, ?, ?, ?)').run(code, req.user.id, 'user', expiresAt);
  res.json({ code, expires_at: expiresAt });
});

// ===== PPT GENERATION =====
function createLegacyPpt(req, res) {
  const path = require('path');
  const fs = require('fs');
  const cp = require('child_process');
  const tmpDir = TMP_DIR;
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const dataPath = path.join(tmpDir, 'ppt_data_' + Date.now() + '.json');
  const outPath = path.join(tmpDir, 'proposal_' + Date.now() + '.pptx');
  const pptPayload = normalizePptRequestPayload(req.body);
  fs.writeFileSync(dataPath, JSON.stringify(pptPayload));
  try {
    try {
      knowledgeService.ingestKnowledge(db, {
        title: 'PPT 生成请求：' + (pptPayload.brand || pptPayload.title || Date.now()),
        summary: String(req.body.summary || pptPayload.title || pptPayload.brand || '').slice(0, 240),
        content: JSON.stringify(pptPayload, null, 2),
        entry_type: 'proposal_ppt_request',
        source_type: 'ppt_generation',
        source_id: req.body.demand_id || pptPayload.brand || dataPath,
        visibility: 'private',
        tags: ['ppt', 'proposal', pptPayload.brand].filter(Boolean),
        business_type: 'proposal',
        business_id: req.body.demand_id || '',
        created_by: req.user.id,
        actor_role: req.user.role
      });
    } catch (archiveErr) {}
    const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    cp.execFileSync(python, [path.join(__dirname, 'generate_ppt.py'), dataPath, outPath], {
      timeout: 30000,
      cwd: __dirname,
      env: runtimeConfig.pythonChildEnvironment()
    });
    fs.unlinkSync(dataPath);
    res.download(outPath, 'proposal.pptx', function() { try { fs.unlinkSync(outPath); } catch(e) {} });
  } catch (e) {
    try { fs.unlinkSync(dataPath); } catch(e2) {}
    res.status(500).json({ error: 'PPT generation failed: ' + e.message });
  }
}

app.post('/api/proposal/generate-ppt', authMiddleware, (req, res) => {
  if (hasCampaignId(req.body)) return campaignPptBridgeHandler(req, res);
  return createLegacyPpt(req, res);
});


// ===== INFLUENCER & COLLABORATION ROUTES =====
require('./routes')(app, db, authMiddleware, { campaignCollaborationService });
require('./routes_customers')(app, db, authMiddleware);
registerCampaignRoutes(app, db);
require('./routes_brands')(app, db, authMiddleware, aiLimiter, aiQuotaGuard);

// ===== WORKFLOW ENGINE ROUTES =====
require('./routes_workflow')(app, db, authMiddleware, adminOnly);


// ===== KNOWLEDGE BASE ROUTES =====
app.get('/api/knowledge', authMiddleware, (req, res) => {
  try {
    const entries = knowledgeService.searchKnowledge(db, {
      q: req.query.q || req.query.search || '',
      type: req.query.type,
      entry_type: req.query.entry_type,
      source_type: req.query.source_type,
      visibility: req.query.visibility,
      business_type: req.query.business_type,
      business_id: req.query.business_id,
      tags: req.query.tags,
      limit: req.query.limit || 100,
      user: req.user
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/knowledge', authMiddleware, (req, res) => {
  if (hasCampaignId(req.body)) {
    try {
      requireCampaignLinkedJson(req);
      return sendCampaignLinkResult(res, campaignLinkService.createKnowledge({
        userId: req.user.id,
        requestId: campaignLinkRequestId(req),
        idempotencyKey: req.get('Idempotency-Key'),
        body: req.body
      }));
    } catch (error) {
      return sendCampaignLinkError(req, res, error);
    }
  }
  try {
    validateLegacyKnowledgeBody(req.body);
    const entry = knowledgeService.ingestKnowledge(db, Object.assign({}, req.body, { created_by: req.user.id, actor_role: req.user.role }));
    res.json({ entry, id: entry.id });
  } catch (e) {
    if (e instanceof CampaignLinkServiceError) return sendCampaignLinkError(req, res, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/knowledge/search', authMiddleware, (req, res) => {
  try {
    const entries = knowledgeService.searchKnowledge(db, {
      q: req.query.q || req.query.search || '',
      entry_type: req.query.entry_type || req.query.type,
      source_type: req.query.source_type,
      visibility: req.query.visibility,
      business_type: req.query.business_type,
      business_id: req.query.business_id,
      tags: req.query.tags,
      limit: req.query.limit || 50,
      user: req.user
    });
    res.json({ entries, total: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/knowledge/ingest', authMiddleware, (req, res) => {
  if (hasCampaignId(req.body)) {
    try {
      requireCampaignLinkedJson(req);
      return sendCampaignLinkResult(res, campaignLinkService.ingestKnowledge({
        userId: req.user.id,
        requestId: campaignLinkRequestId(req),
        idempotencyKey: req.get('Idempotency-Key'),
        body: req.body
      }));
    } catch (error) {
      return sendCampaignLinkError(req, res, error);
    }
  }
  try {
    validateLegacyKnowledgeBody(req.body);
    const entry = knowledgeService.ingestKnowledge(db, Object.assign({}, req.body, {
      created_by: req.user.id,
      actor_role: req.user.role
    }));
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'knowledge_ingest', 'knowledge', 'Ingested knowledge entry ' + entry.id, req.ip);
    res.json({ entry, id: entry.id });
  } catch (e) {
    if (e instanceof CampaignLinkServiceError) return sendCampaignLinkError(req, res, e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/knowledge/upload', authMiddleware, async (req, res) => {
  const linked = Object.prototype.hasOwnProperty.call(req.body || {}, 'campaign_id');
  const campaignId = linked ? Number(req.body.campaign_id) : null;
  const requestSignal = requestUploadSignal(req);
  try {
    const authority = createUploadAuthority(req, campaignId);
    const admission = req.phase4Request.admission;
    const multipart = req.phase4Request.multipart;
    const finalizeLinked = linked
      ? campaignLinkService.createMultipartKnowledgeFinalizer({
          campaignId,
          idempotencyKey: req.get('Idempotency-Key'),
          canonicalRequestHash: multipart.canonicalRequestHash,
          requestId: campaignLinkRequestId(req),
          admission,
          authority: {
            userId: authority.userId,
            organizationId: authority.organizationId,
            assertFresh: authority.assertFresh
          }
        })
      : null;
    const result = await uploadSandboxService.processUpload({
      multipart: multipart.sandboxMultipart,
      admission,
      signal: requestSignal.signal,
      assertLeaseOwned: () => renewUploadAdmissionLease(admission),
      assertAuthorized: () => assertUploadAuthorityFresh(authority),
      finalize(parsed, lifecycle) {
        if (finalizeLinked) {
          const projected = projectKnowledgeUpload(req, parsed, authority.readFresh(db).user);
          return finalizeLinked({
            body: linkedKnowledgeBody(campaignId, projected),
            rows: projected.rows,
            lifecycle
          });
        }
        return db.transaction(() => {
          const current = authority.readFresh(db);
          const projected = projectKnowledgeUpload(req, parsed, current.user);
          const entry = knowledgeService.ingestKnowledge(db, projected.body);
          lifecycle.completeAdmissionInTransaction(db);
          return { entry, rows: projected.rows };
        }).immediate();
      }
    });
    if (linked) return sendCampaignLinkResult(res, result);
    return res.json(result);
  } catch (error) {
    if (linked) return sendCampaignLinkError(req, res, error);
    return legacyUploadError(res, error);
  } finally {
    requestSignal.dispose();
  }
});

app.post('/api/influencers/upload', authMiddleware, async (req, res) => {
  const requestSignal = requestUploadSignal(req);
  try {
    const authority = createUploadAuthority(req, null);
    const admission = req.phase4Request.admission;
    const result = await uploadSandboxService.processUpload({
      multipart: req.phase4Request.multipart.sandboxMultipart,
      admission,
      signal: requestSignal.signal,
      assertLeaseOwned: () => renewUploadAdmissionLease(admission),
      assertAuthorized: () => assertUploadAuthorityFresh(authority),
      finalize(parsed, lifecycle) {
        return db.transaction(() => {
          const current = authority.readFresh(db);
          const data = parsed && parsed.data ? parsed.data : {};
          if (!Array.isArray(data.rows) || data.rows.length === 0) {
            const error = new Error('No table rows found in uploaded file');
            error.statusCode = 400;
            throw error;
          }
          const imported = influencerWorkflow.importInfluencerRows(db, data.rows, {
            batch_id: req.body.batch_id || req.file.originalname,
            user: current.user,
            data_source: 'upload'
          });
          lifecycle.completeAdmissionInTransaction(db);
          return Object.assign({
            parser: data.parser,
            warning: sandboxWarning(data)
          }, imported);
        }).immediate();
      }
    });
    return res.json(result);
  } catch (error) {
    return legacyUploadError(res, error);
  } finally {
    requestSignal.dispose();
  }
});

app.post('/api/admin/knowledge/import/obsidian', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await obsidianIngestService.syncObsidianFolder(db, {
      rootPath: req.body.root_path || req.body.rootPath || process.env.OBSIDIAN_KB_ROOT || 'D:\\主盘\\图灵集市',
      dryRun: boolParam(req.body.dry_run !== undefined ? req.body.dry_run : req.body.dryRun, true),
      visibility: req.body.visibility || 'team',
      user: req.user
    });
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, result.dryRun ? 'obsidian_dry_run' : 'obsidian_sync', 'knowledge', 'Obsidian sync eligible=' + result.eligible + ' imported=' + result.imported + ' skipped=' + result.skipped, req.ip);
    res.json(result);
  } catch (e) {
    res.status(/admin only/i.test(e.message) ? 403 : 500).json({ error: e.message });
  }
});

app.post('/api/admin/knowledge/vault/export', authMiddleware, adminOnly, (req, res) => {
  try {
    const result = vaultExportService.exportKnowledgeVault(db, {
      rootPath: req.body.root_path || req.body.rootPath || process.env.PLATFORM_KB_VAULT_ROOT || 'D:\\图灵商务在线平台',
      entry_type: req.body.entry_type,
      source_type: req.body.source_type,
      visibility: req.body.visibility,
      limit: req.body.limit || 5000,
      user: req.user
    });
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'knowledge_vault_export', 'knowledge', 'Exported ' + result.exported + ' knowledge entries to vault', req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/knowledge/similar', authMiddleware, (req, res) => {
  try {
    const entries = latestUiCompat.similarKnowledge(db, req.query || {}, req.user);
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/knowledge/:id/use', authMiddleware, (req, res) => {
  try {
    if (!campaignContract.isCanonicalSafeIntegerPathSegment(req.params.id)) {
      throw new CampaignLinkServiceError(
        400,
        'INVALID_CAMPAIGN_INPUT',
        'knowledge_entry_id is invalid.'
      );
    }
    const linked = campaignLinkService.useKnowledge({
      userId: req.user.id,
      requestId: campaignLinkRequestId(req),
      idempotencyKey: req.get('Idempotency-Key'),
      entryId: Number(req.params.id),
      bodyIsEmpty: Boolean(
        req.phase4Request &&
        Buffer.isBuffer(req.phase4Request.rawBody) &&
        req.phase4Request.rawBody.length === 0
      )
    });
    if (linked) return sendCampaignLinkResult(res, linked);
    knowledgeService.markKnowledgeUsed(db, [req.params.id], req.user);
    return res.json({ success: true });
  } catch (error) {
    return sendCampaignLinkError(req, res, error);
  }
});

// ===== AI CONVERSATION + RAG ROUTES =====
app.post('/api/ai/chat', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await aiService.handleChat(db, {
      user: req.user,
      message: body.message,
      campaign_id: body.campaign_id === undefined ? body.campaignId : body.campaign_id,
      conversation_id: body.conversation_id === undefined ? body.conversationId : body.conversation_id,
      knowledge_entry_ids: body.knowledge_entry_ids === undefined
        ? body.knowledgeEntryIds
        : body.knowledge_entry_ids,
      idempotencyKey: req.get('Idempotency-Key'),
      requestId: campaignLinkRequestId(req),
      allowWeb: boolParam(body.allow_web, false),
      source_module: body.source_module || 'assistant',
      business_type: body.business_type,
      business_id: body.business_id,
      summaryVisibility: body.summary_visibility || 'private',
      knowledgeLimit: body.knowledge_limit || 8,
      max_tokens: body.max_tokens
    });
    res.json(result);
  } catch (e) {
    sendAiChatError(req, res, e);
  }
});

app.get('/api/ai/conversations', authMiddleware, (req, res) => {
  try {
    const conversations = aiService.listConversations(db, {
      user: req.user,
      authContext: req.authContext,
      requestId: campaignLinkRequestId(req),
      q: req.query.q || '',
      user_id: req.query.user_id,
      source_module: req.query.source_module,
      limit: req.query.limit || 100
    });
    res.json({ conversations });
  } catch (error) {
    sendAiReadError(req, res, error);
  }
});

app.get('/api/ai/conversations/:id', authMiddleware, (req, res) => {
  try {
    const conversation = aiService.getConversation(db, {
      id: req.params.id,
      user: req.user,
      authContext: req.authContext,
      requestId: campaignLinkRequestId(req)
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ conversation });
  } catch (error) {
    sendAiReadError(req, res, error);
  }
});

app.post('/api/ai/proposal-draft', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const linkedRequest = hasCampaignId(body);
  try {
    const demand = body.demand && typeof body.demand === 'object' ? body.demand : {};
    const demandText = String(body.demand_content || body.content || JSON.stringify(demand));
    const demandTitle = body.title || demand.brand || demand.product || '需求方案草稿';
    let demandEntry = null;
    if (!linkedRequest) {
      demandEntry = knowledgeService.ingestKnowledge(db, {
        title: '需求归档：' + demandTitle,
        summary: demandText.slice(0, 240),
        content: demandText,
        entry_type: 'demand',
        source_type: body.source_type || 'proposal_draft_request',
        source_id: body.demand_id || body.source_id || demandTitle,
        visibility: body.visibility || 'private',
        tags: body.tags || ['demand', 'proposal'],
        business_type: 'demand',
        business_id: body.demand_id || '',
        created_by: req.user.id,
        actor_role: req.user.role,
        metadata: { demand }
      });
    }
    const template = body.template && typeof body.template === 'object' ? body.template : {};
    const templateSections = Array.isArray(template.sections)
      ? template.sections.slice(0, 20).map((section) => String(section).slice(0, 200))
      : [];
    const demandConversationId = Number(body.demand_analysis_conversation_id);
    const demandMessageId = Number(body.demand_analysis_message_id);
    const demandAudit = [];
    if (Number.isSafeInteger(demandConversationId) && demandConversationId > 0) {
      demandAudit.push('需求分析对话 #' + demandConversationId);
    }
    if (Number.isSafeInteger(demandMessageId) && demandMessageId > 0) {
      demandAudit.push('需求分析消息 #' + demandMessageId);
    }
    const prompt = [
      '请基于以下客户需求和平台知识库，生成红人营销方案草稿。',
      '请使用 Markdown，明确区分事实依据、推断和待客户确认项；知识引用沿用系统提供的 [KB-n] 标记。',
      '必须包含：执行摘要、市场/竞品判断、达人类型与平台建议、60-30-10预算建议、执行时间线、KPI、风险与下一步确认项。',
      template.name ? '方案模板：' + String(template.name).slice(0, 160) : '',
      template.description ? '模板说明：' + String(template.description).slice(0, 600) : '',
      templateSections.length ? '模板章节：' + templateSections.join('；') : '',
      demandAudit.length ? '审计上下文：' + demandAudit.join('，') : '',
      '',
      demandText
    ].filter(Boolean).join('\n');
    const result = await aiService.handleChat(db, {
      user: req.user,
      message: prompt,
      ragQuery: demandText,
      allowWeb: false,
      source_module: 'proposal',
      campaign_id: body.campaign_id,
      idempotencyKey: req.get('Idempotency-Key'),
      requestId: campaignLinkRequestId(req),
      knowledge_entry_ids: body.knowledge_entry_ids,
      visibility: 'private',
      knowledgeLimit: 8,
      archiveSummary: false,
      atomicOneShot: true,
      max_tokens: 3200
    });
    res.json({ draft: result.answer, demand_entry: demandEntry, ai: result });
  } catch (e) {
    if (linkedRequest) return sendAiChatError(req, res, e);
    return res.status(500).json({
      error: 'AI proposal draft request failed.',
      code: 'AI_PROPOSAL_DRAFT_FAILED'
    });
  }
});

// ===== LATEST UI COMPATIBILITY ROUTES =====
app.post('/api/demand/parse-file', authMiddleware, async (req, res) => {
  const requestSignal = requestUploadSignal(req);
  try {
    const authority = createUploadAuthority(req, null);
    const admission = req.phase4Request.admission;
    const result = await uploadSandboxService.processUpload({
      multipart: req.phase4Request.multipart.sandboxMultipart,
      admission,
      signal: requestSignal.signal,
      assertLeaseOwned: () => renewUploadAdmissionLease(admission),
      assertAuthorized: () => assertUploadAuthorityFresh(authority),
      finalize(parsed, lifecycle) {
        const data = parsed && parsed.data ? parsed.data : {};
        const response = {
          fileName: req.file.originalname,
          extractedText: data.text,
          analysisHint: latestUiCompat.inferDemandAnalysis(
            data.text,
            data.warning || '',
            req.file.originalname
          ),
          fallback: data.fallback,
          warning: sandboxWarning(data),
          parser: data.parser,
          needsOcr: data.needsOcr,
          ocrUsed: data.ocrUsed
        };
        db.transaction(() => {
          authority.readFresh(db);
          lifecycle.completeAdmissionInTransaction(db);
        }).immediate();
        return response;
      }
    });
    return res.json(result);
  } catch (error) {
    return legacyUploadError(res, error);
  } finally {
    requestSignal.dispose();
  }
});

app.post('/api/ai/strategy', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  try {
    const result = await latestUiCompat.generateStrategy(db, req.user, req.body.prompt, req.body.input);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, content: '', fallback: true, warning: e.message });
  }
});

app.post('/api/ai/demand-analysis', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const linkedRequest = hasCampaignId(body);
  try {
    const result = await latestUiCompat.generateDemandAnalysis(
      body.prompt,
      body.input,
      body.fileName,
      {
        db,
        user: req.user,
        allowWeb: boolParam(body.allow_web, false),
        campaignId: body.campaign_id,
        idempotencyKey: req.get('Idempotency-Key'),
        requestId: campaignLinkRequestId(req),
        knowledgeLimit: 8
      }
    );
    res.json(result);
  } catch (e) {
    if (linkedRequest) return sendAiChatError(req, res, e);
    return res.status(500).json({
      error: 'AI demand analysis request failed.',
      code: 'AI_DEMAND_ANALYSIS_FAILED'
    });
  }
});

app.post('/api/ai/ppt-outline', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  try {
    const result = await latestUiCompat.generatePptOutline(db, req.user, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== KNOWLEDGE CATEGORIES =====
app.get('/api/knowledge/categories', authMiddleware, (req, res) => {
  try {
    const categories = knowledgeService.listKnowledgeCategories(db, {
      user: req.user
    });
    res.json({ categories });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== AUTH REGISTER (admin) =====
app.post('/api/auth/register', authMiddleware, adminOnly, (req, res) => {
  const { username, display_name, role, department, email } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const passwordResult = resolveUserCreationPassword(req.body);
  if (passwordResult.policyErrors.length) {
    return res.status(400).json({ error: 'Password policy failed', details: passwordResult.policyErrors });
  }
  const temporaryPassword = passwordResult.password;
  const hash = hashPassword(temporaryPassword);
  try {
    const userId = createUserWithIdentity({
      actorUserId: req.user.id,
      requestId: identityRequestId(req),
      username,
      passwordHash: hash,
      displayName: display_name || username,
      role: role || 'user',
      email: email || '',
      department: department || ''
    });
    res.json({
      id: userId,
      temporary_password: passwordResult.hasSuppliedPassword ? undefined : temporaryPassword,
      message: passwordResult.hasSuppliedPassword ? 'User created with provided password' : 'User created. Share the temporary password securely.'
    });
  } catch(e) {
    res.status(400).json({ error: 'Username may already exist' });
  }
});

// ===== USERS LIST (for frontend) =====
app.get('/api/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, department, email, api_quota, created_at, last_login, is_active FROM users ORDER BY department, id').all();
  res.json({ users });
});
// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    parser: {
      ready: uploadSandboxReadiness && uploadSandboxReadiness.ready === true,
      manifest_sha256: uploadSandboxReadiness
        ? uploadSandboxReadiness.manifestSha256
        : RELEASE_PINNED_UPLOAD_MANIFEST_SHA256
    }
  });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ===== SPA FALLBACK =====
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'), {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }
  });
});

let campaignPptJanitorStopped = false;
function stopCampaignPptJanitor() {
  if (campaignPptJanitorStopped) return;
  campaignPptJanitorStopped = true;
  if (campaignPptJanitor) clearInterval(campaignPptJanitor);
}

let httpServer = null;
let shutdownStarted = false;
function shutdownServer(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopCampaignPptJanitor();
  if (!httpServer) {
    process.exit(1);
    return;
  }
  httpServer.close((error) => {
    if (error) {
      console.error(`Server shutdown failed after ${signal}`, error);
      process.exit(1);
    }
    process.exit(0);
  });
}

async function bootstrapServer() {
  const localWorker = LOCAL_UPLOAD_WORKER_MODE;
  if (localWorker) {
    await fs.promises.mkdir(UPLOAD_SANDBOX_SPOOL_ROOT, {
      recursive: true,
      mode: 0o700
    });
    await fs.promises.chmod(UPLOAD_SANDBOX_SPOOL_ROOT, 0o700);
  }
  const readiness = PHASE4_ONE_REQUEST_REPLAY_MODE
    ? localUploadReadinessSnapshot()
    : await assertUploadSandboxStartupReady({
        expectedManifestSha256: localWorker
          ? loadRuntimeManifest().manifestSha256
          : RELEASE_PINNED_UPLOAD_MANIFEST_SHA256,
        idempotency: uploadAdmissionIdempotency,
        spoolRoot: UPLOAD_SANDBOX_SPOOL_ROOT,
        recoverAdmissions: recoverUploadAdmissions,
        verifyInstalledArtifacts: verifyInstalledControlArtifacts,
        runSelfTests: runProductionUploadSandboxSelfTests,
        ...(localWorker ? localUploadReadinessAdapters() : {})
      });
  uploadSandboxReadiness = Object.freeze({
    ready: readiness.ready === true,
    manifestSha256: readiness.manifestSha256
  });
  const sandboxOptions = {
    db,
    idempotency: uploadAdmissionIdempotency,
    spoolRoot: UPLOAD_SANDBOX_SPOOL_ROOT,
    parserIdentity: readiness.parserIdentity,
    emitControllerEvent: emitUploadSandboxControllerEvent
  };
  if (localWorker) {
    sandboxOptions.executeJob = async (job, options) => {
      await options.assertLeaseOwned(job.admission);
      await workerMain([
        'worker',
        '--job-id', job.id,
        '--request', job.requestPath,
        '--input', job.inputPath,
        '--output-root', job.outputRoot
      ]);
      await options.assertLeaseOwned(job.admission);
    };
    sandboxOptions.killJob = async () => {};
  }
  uploadSandboxService = createUploadSandboxService(sandboxOptions);
  const uploadHooks = uploadSandboxService.createPipelineHooks({
    resolvePrincipal: resolveUploadPrincipal
  });
  phase4RequestPipeline = createPhase4RequestPipeline({
    registry: phase4Registry,
    authenticate: authenticatePhase4Request,
    async admit(request, context) {
      if (!(context && context.policy && context.policy.admission)) return true;
      try {
        return await uploadHooks.admit(request, context);
      } catch (error) {
        throw phase4UploadHookError(error);
      }
    },
    async parseMultipart(request, rawBody, policy) {
      try {
        return await uploadHooks.parseMultipart(request, rawBody, policy);
      } catch (error) {
        throw phase4UploadHookError(error);
      }
    },
    onAdmissionFailure: uploadHooks.onAdmissionFailure,
    requireDurableAdmission: true,
    shouldOwnRequest: campaignLinkedSharedWorkflowOwner
  });

  campaignPptService.runArtifactJanitor();
  campaignPptJanitor = setInterval(() => {
    try {
      campaignPptService.runArtifactJanitor();
    } catch (error) {
      console.error('Campaign PPT artifact janitor tick failed', error);
    }
  }, 60 * 60 * 1000);
  if (campaignPptJanitor && typeof campaignPptJanitor.unref === 'function') {
    campaignPptJanitor.unref();
  }

  const workflowEngine = require('./workflow_engine');
  workflowEngine.initEngine();
  const { startCampaignWorkflowDispatcher } = require('./services/campaign_workflow_service');
  startCampaignWorkflowDispatcher(db);

  httpServer = app.listen(...SERVER_LISTEN_ARGS, () => {
    console.log(`TuringMarket server running on http://localhost:${PORT}`);
  });
  httpServer.once('close', stopCampaignPptJanitor);
  process.once('SIGTERM', () => shutdownServer('SIGTERM'));
  process.once('SIGINT', () => shutdownServer('SIGINT'));
}

bootstrapServer().catch((error) => {
  stopCampaignPptJanitor();
  console.error('Server startup failed', error);
  process.exitCode = 1;
});
