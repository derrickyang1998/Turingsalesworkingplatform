const Database = require('better-sqlite3');
const path = require('path');
const runtimeConfig = require('./config/runtime_config');
const migrationService = require('./services/migration_service');
const legacyBaseline = require('./migrations/baselines/legacy_v1');

runtimeConfig.loadPlatformEnvironment();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'turingmarket.db');
const db = new Database(DB_PATH);

db.pragma('foreign_keys = ON');

migrationService.runMigrations(db, {
  rootDir: __dirname,
  seedAdmissions: legacyBaseline.seedAdmissions
});

db.pragma('journal_mode = WAL');

db.seedAdmissions = legacyBaseline.seedAdmissions;

module.exports = db;
