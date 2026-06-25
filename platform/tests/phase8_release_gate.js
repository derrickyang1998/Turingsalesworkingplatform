const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'server');

const checks = [
  {
    name: 'app.js syntax',
    cwd: root,
    command: process.execPath,
    args: ['-e', "const fs=require('fs'); new Function(fs.readFileSync('app.js','utf8'));"]
  },
  { name: 'server.js syntax', cwd: root, command: process.execPath, args: ['-c', 'server/server.js'] },
  { name: 'routes_customers.js syntax', cwd: root, command: process.execPath, args: ['-c', 'server/routes_customers.js'] },
  { name: 'routes_workflow.js syntax', cwd: root, command: process.execPath, args: ['-c', 'server/routes_workflow.js'] },
  { name: 'Phase 1 UI acceptance', cwd: root, command: process.execPath, args: ['tests/phase1_acceptance.js'] },
  { name: 'Phase 2 permissions acceptance', cwd: serverDir, command: process.execPath, args: ['phase2_permissions_test.js'] },
  { name: 'Phase 3 artifacts acceptance', cwd: serverDir, command: process.execPath, args: ['phase3_artifacts_test.js'] },
  { name: 'Phase 4 workflow automation acceptance', cwd: serverDir, command: process.execPath, args: ['phase4_workflow_automation_test.js'] },
  { name: 'Phase 5 task center UI acceptance', cwd: root, command: process.execPath, args: ['tests/phase5_tasks_ui_acceptance.js'] },
  { name: 'Phase 6 admin dashboard acceptance', cwd: root, command: process.execPath, args: ['tests/phase6_admin_dashboard_acceptance.js'] },
  { name: 'Phase 7 knowledge reuse acceptance', cwd: root, command: process.execPath, args: ['tests/phase7_knowledge_reuse_acceptance.js'] },
  { name: 'API smoke test', cwd: serverDir, command: process.execPath, args: ['smoke_test.js'] }
];

function assertFile(file) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error('Missing required release artifact: ' + file);
  }
}

(async () => {
  const requiredDocs = [
    'docs/acceptance-phase1-checklist.md',
    'docs/acceptance-phase2-checklist.md',
    'docs/acceptance-phase3-checklist.md',
    'docs/acceptance-phase4-checklist.md',
    'docs/acceptance-phase5-checklist.md',
    'docs/acceptance-phase6-checklist.md',
    'docs/acceptance-phase7-checklist.md',
    'docs/acceptance-phase8-checklist.md',
    'docs/release-v8-baseline.md'
  ];
  requiredDocs.forEach(assertFile);

  const results = [];
  for (const check of checks) {
    const started = Date.now();
    const result = spawnSync(check.command, check.args, {
      cwd: check.cwd,
      shell: false,
      encoding: 'utf8',
      env: { ...process.env }
    });
    const elapsed = Date.now() - started;
    const ok = result.status === 0;
    results.push({ name: check.name, ok, elapsed });
    process.stdout.write((ok ? 'PASS' : 'FAIL') + ' ' + check.name + ' (' + elapsed + 'ms)\n');
    if (!ok) {
      if (result.stdout) process.stdout.write(result.stdout + '\n');
      if (result.stderr) process.stderr.write(result.stderr + '\n');
      throw new Error('Release gate failed: ' + check.name);
    }
  }

  process.stdout.write('\nPhase 8 release gate passed\n');
  process.stdout.write(results.map(r => '- ' + r.name + ': ' + r.elapsed + 'ms').join('\n') + '\n');
})().catch(err => {
  console.error('Phase 8 release gate failed:', err.message);
  process.exit(1);
});
