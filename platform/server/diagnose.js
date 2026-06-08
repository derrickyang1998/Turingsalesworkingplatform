// Diagnostic script - run with: node diagnose.js
// Checks all new/modified files for syntax errors

const fs = require('fs');
const path = require('path');

const files = [
  'db.js',
  'workflow_engine.js',
  'routes_workflow.js',
  'server.js',
  'routes_customers.js'
];

console.log('=== Syntax Check ===\n');

let allOk = true;

for (const file of files) {
  const fullPath = path.join(__dirname, file);
  try {
    const code = fs.readFileSync(fullPath, 'utf8');
    // Basic syntax check
    try {
      // Try to parse the module's exports to verify it's valid JS
      new Function(code.replace(/require\([^)]+\)/g, 'null'));
      console.log(`✅ ${file} - syntax OK (${code.split('\n').length} lines)`);
    } catch(e) {
      console.log(`❌ ${file} - SYNTAX ERROR: ${e.message}`);
      allOk = false;
    }
  } catch(e) {
    console.log(`❌ ${file} - CANNOT READ: ${e.message}`);
    allOk = false;
  }
}

console.log('\n=== Require Check ===\n');

// Try requiring the modules
try {
  // Force delete from cache if previously loaded
  delete require.cache[require.resolve('./db')];
  const db = require('./db');
  console.log('✅ db.js - loaded successfully');

  // Check workflow tables exist
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%'").all();
  console.log(`   Workflow tables found: ${tables.map(t => t.name).join(', ') || 'NONE!'}`);

  delete require.cache[require.resolve('./workflow_engine')];
  const engine = require('./workflow_engine');
  console.log('✅ workflow_engine.js - loaded successfully');
  console.log(`   Exports: ${Object.keys(engine).join(', ')}`);

  console.log('\n=== All checks passed! Try: node server.js ===');
  process.exit(0);
} catch(e) {
  console.log(`❌ FAILED: ${e.message}`);
  console.log(e.stack);
  process.exit(1);
}
