const path = require('path');
const runtimeConfig = require('./config/runtime_config');
const migrationService = require('./services/migration_service');

runtimeConfig.loadPlatformEnvironment();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'turingmarket.db');
const db = migrationService.openMigratedDatabase(DB_PATH, {
  rootDir: __dirname,
  registeredMigrations: [
    {
      version: 2,
      name: '002_campaign_business_spine',
      sourcePath: 'migrations/002_campaign_business_spine.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 3,
      name: '003_campaign_workflow_dispatch_evidence',
      sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 4,
      name: '004_knowledge_capacity_observability',
      sourcePath: 'migrations/004_knowledge_capacity_observability.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 5,
      name: '005_knowledge_custody_projection',
      sourcePath: 'migrations/005_knowledge_custody_projection.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 6,
      name: '006_crm_sales_workspace',
      sourcePath: 'migrations/006_crm_sales_workspace.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 7,
      name: '007_knowledge_governance',
      sourcePath: 'migrations/007_knowledge_governance.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 8,
      name: '008_feishu_bitable_outbox',
      sourcePath: 'migrations/008_feishu_bitable_outbox.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 9,
      name: '009_feishu_bitable_retry_lineage',
      sourcePath: 'migrations/009_feishu_bitable_retry_lineage.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 10,
      name: '010_performance_manual_foundation',
      sourcePath: 'migrations/010_performance_manual_foundation.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    },
    {
      version: 11,
      name: '011_performance_feishu_connection_config',
      sourcePath: 'migrations/011_performance_feishu_connection_config.js',
      engineVersion: 1,
      dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js']
    }
  ]
});

db.pragma('journal_mode = WAL');

module.exports = db;
