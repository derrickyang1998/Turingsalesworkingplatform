// Database setup
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'turingmarket.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    email TEXT,
    department TEXT,
    api_quota INTEGER DEFAULT 50000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_cn TEXT,
    industry_tags TEXT,
    market TEXT DEFAULT 'global',
    estimated_annual_revenue TEXT,
    user_base TEXT,
    amazon_rating REAL,
    youtube_followers INTEGER DEFAULT 0,
    instagram_followers INTEGER DEFAULT 0,
    tiktok_followers INTEGER DEFAULT 0,
    search_volume_monthly INTEGER DEFAULT 0,
    monthly_posts INTEGER DEFAULT 0,
    avg_engagement TEXT,
    avg_views INTEGER DEFAULT 0,
    top_platform TEXT,
    creative_angles TEXT,
    top_products TEXT,
    data_source TEXT DEFAULT 'user_enrich',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name);


  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS demands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    brand_name TEXT,
    company_name TEXT,
    product_name TEXT,
    industry TEXT,
    budget TEXT,
    target_market TEXT,
    platform TEXT,
    status TEXT DEFAULT 'draft',
    data_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    demand_id INTEGER,
    template_id TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (demand_id) REFERENCES demands(id)
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    endpoint TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    module TEXT,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS team_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER NOT NULL,
    role TEXT DEFAULT 'user',
    max_uses INTEGER DEFAULT 1,
    uses INTEGER DEFAULT 0,
    expires_at DATETIME,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_name TEXT NOT NULL,
    company_name TEXT,
    contact_person TEXT,
    contact_info TEXT,
    industry TEXT,
    stage TEXT DEFAULT 'lead',
    source TEXT,
    budget_estimate TEXT,
    notes TEXT,
    created_by INTEGER NOT NULL,
    assigned_to INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (assigned_to) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS customer_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    stage_from TEXT,
    stage_to TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_customers_stage ON customers(stage);
  CREATE INDEX IF NOT EXISTS idx_customers_industry ON customers(industry);
  CREATE INDEX IF NOT EXISTS idx_customers_assigned ON customers(assigned_to);

  CREATE TABLE IF NOT EXISTS influencers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    kol_handle TEXT NOT NULL,
    profile_link TEXT,
    followers INTEGER DEFAULT 0,
    avg_views_10 INTEGER DEFAULT 0,
    avg_engagement REAL DEFAULT 0,
    category TEXT,
    sub_category TEXT,
    region TEXT,
    language TEXT,
    content_style TEXT,
    collab_type TEXT DEFAULT 'Dedicated',
    cost_usd INTEGER DEFAULT 0,
    cost_range_min INTEGER,
    cost_range_max INTEGER,
    cpm REAL,
    brand_collab_history TEXT,
    contact_email TEXT,
    data_source TEXT DEFAULT 'manual',
    enrichment_data TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS collaborations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    demand_id INTEGER,
    influencer_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'proposed',
    proposal_notes TEXT,
    cost_quoted INTEGER DEFAULT 0,
    cost_actual INTEGER DEFAULT 0,
    content_url TEXT,
    roi_data TEXT,
    timeline_start DATE,
    timeline_end DATE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (demand_id) REFERENCES demands(id),
    FOREIGN KEY (influencer_id) REFERENCES influencers(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_influencers_platform ON influencers(platform);
  CREATE INDEX IF NOT EXISTS idx_influencers_category ON influencers(category);
  CREATE INDEX IF NOT EXISTS idx_influencers_region ON influencers(region);
  CREATE INDEX IF NOT EXISTS idx_influencers_followers ON influencers(followers);
  CREATE INDEX IF NOT EXISTS idx_collaborations_status ON collaborations(status);
  CREATE INDEX IF NOT EXISTS idx_collaborations_demand ON collaborations(demand_id);

  CREATE TABLE IF NOT EXISTS workflow_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    module TEXT DEFAULT '',
    category TEXT DEFAULT 'approval',
    nodes TEXT NOT NULL DEFAULT '[]',
    edges TEXT NOT NULL DEFAULT '[]',
    version INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    business_type TEXT NOT NULL,
    business_id INTEGER NOT NULL,
    current_node_id TEXT,
    status TEXT DEFAULT 'active',
    node_data TEXT DEFAULT '{}',
    started_by INTEGER,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assignee_id INTEGER,
    assignee_role TEXT,
    status TEXT DEFAULT 'pending',
    comment TEXT DEFAULT '',
    due_at DATETIME,
    completed_at DATETIME,
    completed_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_timers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    fire_at DATETIME NOT NULL,
    action TEXT DEFAULT 'advance',
    fired INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_node_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,
    user_id INTEGER,
    details TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ===== V8.0 CRM Enhancements =====
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_name TEXT,
    company_name TEXT,
    contact_person TEXT,
    contact_info TEXT,
    source TEXT DEFAULT 'manual',
    industry TEXT,
    lead_score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'new',
    assigned_to INTEGER,
    notes TEXT,
    converted_customer_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    stage TEXT DEFAULT 'discovery',
    value REAL DEFAULT 0,
    win_probability INTEGER DEFAULT 50,
    product_name TEXT,
    channel_type TEXT,
    expected_close_date DATETIME,
    competitor_info TEXT,
    decision_chain TEXT,
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS sales_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    team_name TEXT,
    target_type TEXT,
    target_value REAL,
    period TEXT,
    period_start DATE,
    period_end DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity_log_ext (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    user_id INTEGER,
    action_type TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS knowledge_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT DEFAULT 'note',
    source_type TEXT,
    source_id INTEGER,
    key_terms TEXT,
    content TEXT,
    created_by INTEGER,
    is_public INTEGER DEFAULT 1,
    usage_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    token_count INTEGER DEFAULT 0,
    embedding_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
    title,
    content,
    tags,
    entry_id UNINDEXED,
    chunk_id UNINDEXED
  );

  CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '',
    visibility TEXT DEFAULT 'private',
    source_module TEXT DEFAULT 'assistant',
    archived_summary_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (archived_summary_id) REFERENCES knowledge_entries(id)
  );

  CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    model TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    metadata_json TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS ai_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    reference_type TEXT NOT NULL,
    reference_id TEXT,
    title TEXT DEFAULT '',
    url TEXT DEFAULT '',
    snippet TEXT DEFAULT '',
    provider TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES ai_messages(id)
  );

  CREATE TABLE IF NOT EXISTS web_search_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    query TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default admin and team users
function seedPasswordHash(seedPassword) {
  const password = seedPassword || crypto.randomBytes(18).toString('base64url');
  return bcrypt.hashSync(password, bcrypt.genSaltSync(10));
}

function userPasswordEnvKey(username) {
  return 'USER_PASSWORD_' + String(username || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function configuredAdminUsername() {
  const username = String(process.env.DEFAULT_ADMIN_USERNAME || 'admin').trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new Error('DEFAULT_ADMIN_USERNAME must be 3-64 characters and only use letters, numbers, dot, underscore, or dash');
  }
  return username;
}

const defaultAdminUsername = configuredAdminUsername();
const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
if (!existingAdmin) {
  if (process.env.NODE_ENV === 'production' && !process.env.DEFAULT_ADMIN_PASSWORD) {
    throw new Error('DEFAULT_ADMIN_PASSWORD must be configured before seeding users in production');
  }
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, display_name, role, email, department, api_quota) VALUES (?, ?, ?, ?, ?, ?, ?)');

  // Admin
  insertUser.run(defaultAdminUsername, seedPasswordHash(process.env.DEFAULT_ADMIN_PASSWORD), '管理员', 'admin', 'admin@turingmarket.cn', '管理', 200000);

  // 10 team members
  const teamMembers = [
    ['zhangwei', '张伟', 'user', 'zhangwei@turingmarket.cn', '商务一部'],
    ['wangfang', '王芳', 'user', 'wangfang@turingmarket.cn', '商务一部'],
    ['liming', '李明', 'user', 'liming@turingmarket.cn', '商务二部'],
    ['zhaoli', '赵丽', 'user', 'zhaoli@turingmarket.cn', '商务二部'],
    ['chenyu', '陈宇', 'user', 'chenyu@turingmarket.cn', '商务三部'],
    ['liuxue', '刘雪', 'user', 'liuxue@turingmarket.cn', '运营部'],
    ['huanghe', '黄河', 'user', 'huanghe@turingmarket.cn', '运营部'],
    ['sunpeng', '孙鹏', 'user', 'sunpeng@turingmarket.cn', '红人组'],
    ['zhoujie', '周杰', 'user', 'zhoujie@turingmarket.cn', '红人组'],
    ['wulei', '吴磊', 'user', 'wulei@turingmarket.cn', '策略组'],
  ];

  teamMembers.forEach(([username, displayName, role, email, dept]) => {
    try { insertUser.run(username, seedPasswordHash(process.env[userPasswordEnvKey(username)]), displayName, role, email, dept, 50000); } catch(e) {}
  });

  console.log('✅ Database seeded with admin + 10 team members');
}

// Seed default influencer data from real portfolio
const existingInfluencers = db.prepare('SELECT COUNT(*) as count FROM influencers').get();
if (existingInfluencers.count === 0) {
  const insertInf = db.prepare(`INSERT INTO influencers (platform, kol_handle, profile_link, followers, avg_views_10, avg_engagement, category, sub_category, region, language, content_style, collab_type, cost_usd, cost_range_min, cost_range_max, cpm, brand_collab_history, contact_email, data_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const seedData = [
    ['YouTube', '@TechReviewPro', 'https://youtube.com/@TechReviewPro', 125000, 45000, 4.2, '3C', 'Tech Reviews', 'US', 'EN', 'Reviews', 'Dedicated', 2500, 1500, 3500, 55, 'Anker,Ugreen', 'contact@techreviewpro.com', 'seed'],
    ['YouTube', '@HomeGadgetLab', 'https://youtube.com/@HomeGadgetLab', 89000, 32000, 5.1, '智能家居', 'Smart Home', 'US', 'EN', 'Unboxing', 'Dedicated', 1800, 1000, 2500, 56, 'Xiaomi,Tapo', '', 'seed'],
    ['Instagram', '@beautywithsarah', 'https://instagram.com/beautywithsarah', 210000, 85000, 3.8, '美妆', 'Skincare', 'US', 'EN', 'Tutorial', 'Dedicated', 3000, 2000, 4500, 35, 'Loreal,Estee Lauder', '', 'seed'],
    ['TikTok', '@outdoor_life_max', 'https://tiktok.com/@outdoor_life_max', 340000, 150000, 6.2, '户外', 'Camping', 'US', 'EN', 'Lifestyle', 'Dedicated', 1200, 800, 2000, 8, 'REI,Columbia', '', 'seed'],
    ['YouTube', '@SmartHomeDIY', 'https://youtube.com/@SmartHomeDIY', 67000, 28000, 4.8, '智能家居', 'Home Automation', 'DE', 'DE', 'Tutorial', 'Dedicated', 1500, 1000, 2000, 53, 'Bosch,Philips', '', 'seed'],
    ['Instagram', '@petloversdaily', 'https://instagram.com/petloversdaily', 180000, 45000, 4.5, '宠物', 'Pet Supplies', 'US', 'EN', 'Lifestyle', 'Dedicated', 2200, 1500, 3000, 48, 'Purina,Royal Canin', '', 'seed'],
    ['TikTok', '@gymgearcheck', 'https://tiktok.com/@gymgearcheck', 450000, 200000, 5.5, '出行', 'Fitness Gear', 'US', 'EN', 'Review', 'Dedicated', 1500, 1000, 2500, 7, 'Nike,Under Armour', '', 'seed'],
    ['YouTube', '@MedTechExplained', 'https://youtube.com/@MedTechExplained', 95000, 30000, 3.5, '医疗', 'Health Tech', 'US', 'EN', 'Educational', 'Dedicated', 2000, 1500, 3000, 66, 'Omron,Withings', '', 'seed'],
    ['Instagram', '@storage_solutions', 'https://instagram.com/storage_solutions', 78000, 22000, 3.2, '储能', 'Power Station', 'US', 'EN', 'Showcase', 'Dedicated', 1600, 1000, 2200, 72, 'Bluetti,EcoFlow', '', 'seed'],
    ['YouTube', '@GadgetsJapan', 'https://youtube.com/@GadgetsJapan', 123000, 40000, 4.0, '3C', 'Gadgets', 'JP', 'JA', 'Unboxing', 'Dedicated', 2800, 2000, 4000, 70, 'Sony,Nintendo', '', 'seed'],
    ['TikTok', '@beauty_hacks_kr', 'https://tiktok.com/@beauty_hacks_kr', 520000, 180000, 7.1, '美妆', 'K-Beauty', 'KR', 'KO', 'Tutorial', 'Dedicated', 2000, 1500, 3500, 11, 'Amorepacific,LG', '', 'seed'],
    ['YouTube', '@campinggearEU', null, 42000, 15000, 5.8, '户外', 'Camping Gear', 'DE', 'DE', 'Review', 'Dedicated', 800, 500, 1200, 53, '', '', 'seed'],
    ['Instagram', '@fit_mom_life', 'https://instagram.com/fit_mom_life', 156000, 35000, 4.3, '出行', 'Family Fitness', 'US', 'EN', 'Lifestyle', 'Dedicated', 1800, 1200, 2500, 51, 'Peloton,Lululemon', '', 'seed'],
    ['YouTube', '@EnergyStorageNews', 'https://youtube.com/@EnergyStorageNews', 28000, 12000, 3.0, '储能', 'Solar', 'US', 'EN', 'Educational', 'Dedicated', 1000, 600, 1500, 83, 'Jackery,Anker', '', 'seed'],
    ['TikTok', '@pettok_daily', 'https://tiktok.com/@pettok_daily', 680000, 250000, 8.2, '宠物', 'Pet Lifestyle', 'US', 'EN', 'Funny/Lifestyle', 'Dedicated', 2500, 1800, 4000, 10, '', '', 'seed'],
  ];

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insertInf.run(...row);
    }
  });
  insertMany(seedData);
  console.log('✅ Database seeded with 15 portfolio influencers');
}

// ===== V8.0 Migration: Add new columns to customers table =====
try { db.prepare("ALTER TABLE customers ADD COLUMN lead_source TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE customers ADD COLUMN lead_score INTEGER DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE customers ADD COLUMN assigned_at DATETIME").run(); } catch(e) {}
try { db.prepare("ALTER TABLE customers ADD COLUMN last_followup DATETIME").run(); } catch(e) {}
try { db.prepare("ALTER TABLE customers ADD COLUMN opportunity_value REAL DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE customers ADD COLUMN win_probability INTEGER DEFAULT 50").run(); } catch(e) {}
try { db.prepare("ALTER TABLE customers ADD COLUMN tags TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE customers ADD COLUMN is_public INTEGER DEFAULT 1").run(); } catch(e) {}

// ===== V8.1 Migration: Add new columns to influencers table =====
try { db.prepare("ALTER TABLE influencers ADD COLUMN project_name TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN product_name TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN reporter TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN tags TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN quoted_price INTEGER DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN content_deliverable TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN is_duplicate INTEGER DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN import_batch TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN influencer_type TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN cpv REAL DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE influencers ADD COLUMN parent_record TEXT").run(); } catch(e) {}

// ===== AI Knowledge Foundation Migration =====
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN title TEXT DEFAULT ''").run(); } catch(e) {}
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN summary TEXT DEFAULT ''").run(); } catch(e) {}
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN tags_json TEXT DEFAULT '[]'").run(); } catch(e) {}
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN visibility TEXT DEFAULT 'team'").run(); } catch(e) {}
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN source_hash TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN business_type TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN business_id TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN metadata_json TEXT DEFAULT '{}'").run(); } catch(e) {}
try { db.prepare("ALTER TABLE knowledge_entries ADD COLUMN embedding_json TEXT").run(); } catch(e) {}
try { db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_source_hash ON knowledge_entries(source_hash) WHERE source_hash IS NOT NULL AND source_hash != ''").run(); } catch(e) {}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_visibility ON knowledge_entries(visibility, created_by)").run(); } catch(e) {}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_entries(source_type, source_id)").run(); } catch(e) {}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id, updated_at)").run(); } catch(e) {}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, created_at)").run(); } catch(e) {}
try { db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_references_message ON ai_references(message_id)").run(); } catch(e) {}

module.exports = db;
