const path = require('path');
const runtimeConfig = require('./config/runtime_config');
const migrationService = require('./services/migration_service');

runtimeConfig.loadPlatformEnvironment();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'turingmarket.db');
const db = migrationService.openMigratedDatabase(DB_PATH, { rootDir: __dirname });

db.pragma('journal_mode = WAL');

module.exports = db;
