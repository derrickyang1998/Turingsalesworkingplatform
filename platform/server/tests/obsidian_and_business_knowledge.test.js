const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-kb-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

test('obsidian sync imports safe notes and skips private or secret-looking files', async () => {
  const db = freshDb();
  const obsidian = require('../services/obsidian_ingest_service');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-obsidian-'));
  process.env.OBSIDIAN_KB_ROOT = root;
  fs.mkdirSync(path.join(root, 'strategy'), { recursive: true });
  fs.mkdirSync(path.join(root, '99-private'), { recursive: true });
  fs.writeFileSync(path.join(root, 'strategy', 'brief.md'), '# Beauty launch\n\nTikTok creator plan for US market.', 'utf8');
  fs.writeFileSync(path.join(root, 'strategy', 'unsafe-token.md'), 'DEEPSEEK_API_KEY=dummy_secret_value_0000', 'utf8');
  fs.writeFileSync(path.join(root, '99-private', 'account.md'), 'private notes', 'utf8');

  const dryRun = await obsidian.syncObsidianFolder(db, {
    rootPath: root,
    dryRun: true,
    user: { id: 1, role: 'admin' },
    visibility: 'team'
  });

  assert.equal(dryRun.imported, 0);
  assert.equal(dryRun.eligible, 1);
  assert.equal(dryRun.skipped, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count, 0);

  const synced = await obsidian.syncObsidianFolder(db, {
    rootPath: root,
    user: { id: 1, role: 'admin' },
    visibility: 'team'
  });

  assert.equal(synced.imported, 1);
  assert.equal(synced.skipped, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_type = ?').get('obsidian').count, 1);

  const entry = db.prepare('SELECT title, content, visibility, source_id FROM knowledge_entries WHERE source_type = ?').get('obsidian');
  assert.equal(entry.title, 'Beauty launch');
  assert.match(entry.content, /TikTok creator plan/);
  assert.equal(entry.visibility, 'team');
  assert.match(entry.source_id, /strategy\/brief\.md$/);

  await obsidian.syncObsidianFolder(db, {
    rootPath: root,
    user: { id: 1, role: 'admin' },
    visibility: 'team'
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_type = ?').get('obsidian').count, 1);

  db.close();
});

test('knowledge filesystem roots must be inside configured allowlists', async () => {
  const db = freshDb();
  const obsidian = require('../services/obsidian_ingest_service');
  const vault = require('../services/vault_export_service');
  const allowedImport = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-allowed-import-'));
  const deniedImport = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-denied-import-'));
  const allowedExport = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-allowed-export-'));
  const deniedExport = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-denied-export-'));
  process.env.OBSIDIAN_KB_ROOT = allowedImport;
  process.env.PLATFORM_KB_VAULT_ROOT = allowedExport;
  fs.writeFileSync(path.join(deniedImport, 'note.md'), '# Denied', 'utf8');

  await assert.rejects(
    obsidian.syncObsidianFolder(db, {
      rootPath: deniedImport,
      user: { id: 1, role: 'admin' },
      visibility: 'team'
    }),
    /allowlist/
  );

  assert.throws(function() {
    vault.exportKnowledgeVault(db, {
      rootPath: deniedExport,
      user: { id: 1, role: 'admin' }
    });
  }, /allowlist/);

  db.close();
});

test('business archive helper stores crm and brand events as searchable knowledge', () => {
  const db = freshDb();
  const archive = require('../services/business_knowledge_service');
  const knowledge = require('../services/knowledge_service');
  const user = { id: 2, role: 'user' };

  const customerEntry = archive.archiveCustomer(db, {
    id: 45,
    brand_name: 'Aurora Beauty',
    company_name: 'Aurora Inc',
    industry: 'beauty',
    stage: 'proposal',
    notes: 'Needs TikTok and YouTube launch plan'
  }, user);

  const brandEntry = archive.archiveBrand(db, {
    id: 7,
    name: 'Aurora Beauty',
    market: 'US',
    industry_tags: ['beauty', 'skincare'],
    top_platform: 'TikTok',
    creative_angles: ['routine', 'before-after']
  }, { id: 1, role: 'admin' });

  assert.equal(customerEntry.entry_type, 'crm_customer');
  assert.equal(customerEntry.visibility, 'private');
  assert.equal(brandEntry.entry_type, 'brand_profile');
  assert.equal(brandEntry.visibility, 'team');

  const userResults = knowledge.searchKnowledge(db, { q: 'Aurora TikTok', user });
  assert.equal(userResults.length, 2);

  const otherResults = knowledge.searchKnowledge(db, { q: 'Needs TikTok', entry_type: 'crm_customer', user: { id: 3, role: 'user' } });
  assert.equal(otherResults.length, 0);

  const adminResults = knowledge.searchKnowledge(db, { q: 'Needs TikTok', entry_type: 'crm_customer', user: { id: 1, role: 'admin' } });
  assert.equal(adminResults.length, 1);

  db.close();
});

test('vault export writes knowledge entries as linked markdown files', () => {
  const db = freshDb();
  const knowledge = require('../services/knowledge_service');
  const vault = require('../services/vault_export_service');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-vault-'));
  process.env.PLATFORM_KB_VAULT_ROOT = root;

  const customer = knowledge.ingestKnowledge(db, {
    title: 'CRM customer: Aurora Beauty',
    content: 'Customer needs US TikTok launch.',
    entry_type: 'crm_customer',
    source_type: 'crm_customer',
    source_id: '45',
    visibility: 'private',
    tags: ['crm', 'customer', 'beauty'],
    business_type: 'customer',
    business_id: '45',
    created_by: 2
  });
  knowledge.ingestKnowledge(db, {
    title: 'Brand profile: Aurora Beauty',
    content: 'Brand profile mentions TikTok and skincare.',
    entry_type: 'brand_profile',
    source_type: 'brand_profile',
    source_id: 'aurora',
    visibility: 'team',
    tags: ['brand', 'beauty'],
    business_type: 'brand',
    business_id: 'aurora',
    created_by: 1
  });

  const result = vault.exportKnowledgeVault(db, {
    rootPath: root,
    user: { id: 1, role: 'admin' }
  });

  assert.equal(result.exported, 2);
  assert.equal(result.indexPath.endsWith('知识库索引.md'), true);
  const customerFile = result.files.find(function(file) { return file.entry_id === customer.id; });
  assert.ok(customerFile);
  const markdown = fs.readFileSync(customerFile.path, 'utf8');
  assert.match(markdown, /entry_type: crm_customer/);
  assert.match(markdown, /business_type: customer/);
  assert.match(markdown, /# CRM customer: Aurora Beauty/);
  assert.match(markdown, /#crm/);
  assert.match(fs.readFileSync(result.indexPath, 'utf8'), /CRM customer: Aurora Beauty/);

  db.close();
});
