module.exports = function(app, db, authMiddleware) {
  const businessKnowledge = require('./services/business_knowledge_service');

  const STAGES = ['lead', 'info_confirmed', 'advantage_shared', 'needs_confirmed', 'analysis', 'proposal', 'kol_matching', 'cooperation'];
  const TERMINAL_STAGES = ['paused', 'won', 'lost'];
  const STAGE_LABELS = {
    lead: '1.客户获取/客户开发',
    info_confirmed: '2.客户信息确认',
    advantage_shared: '3.企业优势同步',
    needs_confirmed: '4.海外营销需求确认',
    analysis: '5.行业/竞品数据分析',
    proposal: '6.红人营销方案生成',
    kol_matching: '7.网红匹配提报',
    cooperation: '8.合作落地跟踪',
    paused: '暂停/延后',
    won: '成交',
    lost: '丢失'
  };

  const ACTIVE_STAGES = STAGES.join("','");

  // ============================================================
  // LEAD ROUTES (线索管理)
  // ============================================================

  app.get('/api/leads', authMiddleware, (req, res) => {
    try {
      const { status, search } = req.query;
      let sql = 'SELECT * FROM leads';
      let params = [];
      const conds = [];
      if (status) { conds.push('status = ?'); params.push(status); }
      if (search) { conds.push('(brand_name LIKE ? OR company_name LIKE ?)'); params.push('%' + search + '%', '%' + search + '%'); }
      if (req.user.role !== 'admin') { conds.push('assigned_to = ?'); params.push(req.user.id); }
      if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
      sql += ' ORDER BY created_at DESC LIMIT 200';
      res.json({ leads: db.prepare(sql).all(...params) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/leads', authMiddleware, (req, res) => {
    try {
      const { brand_name, company_name, contact_person, contact_info, source, industry, notes } = req.body;
      const result = db.prepare(`INSERT INTO leads (brand_name, company_name, contact_person, contact_info, source, industry, notes, assigned_to, lead_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(brand_name, company_name, contact_person, contact_info, source || 'manual', industry, notes, req.user.id, 10);
      businessKnowledge.archiveLead(db, db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid), req.user);
      res.json({ id: result.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/leads/:id', authMiddleware, (req, res) => {
    try {
      const { brand_name, company_name, contact_person, contact_info, source, industry, notes, status, lead_score } = req.body;
      db.prepare(`UPDATE leads SET brand_name=COALESCE(?,brand_name), company_name=COALESCE(?,company_name), contact_person=COALESCE(?,contact_person), contact_info=COALESCE(?,contact_info), source=COALESCE(?,source), industry=COALESCE(?,industry), notes=COALESCE(?,notes), status=COALESCE(?,status), lead_score=COALESCE(?,lead_score), updated_at=datetime('now') WHERE id=?`)
        .run(brand_name, company_name, contact_person, contact_info, source, industry, notes, status, lead_score, req.params.id);
      businessKnowledge.archiveLead(db, db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id), req.user);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Convert lead to customer
  app.post('/api/leads/:id/convert', authMiddleware, (req, res) => {
    try {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      const result = db.prepare(`INSERT INTO customers (brand_name, company_name, industry, contact_person, contact_info, source, stage, assigned_to, lead_source, created_by) VALUES (?, ?, ?, ?, ?, ?, 'lead', ?, ?, ?)`)
        .run(lead.brand_name, lead.company_name, lead.industry, lead.contact_person, lead.contact_info, lead.source, req.user.id, 'lead_conversion', req.user.id);
      db.prepare("UPDATE leads SET status='converted', converted_customer_id=?, updated_at=datetime('now') WHERE id=?").run(result.lastInsertRowid, req.params.id);
      businessKnowledge.archiveLead(db, db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id), req.user);
      businessKnowledge.archiveCustomer(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid), req.user);
      res.json({ customer_id: result.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ============================================================
  // ENHANCED CUSTOMER ROUTES
  // ============================================================

  app.get('/api/customers', authMiddleware, (req, res) => {
    const { stage, industry, search, status, is_public } = req.query;
    let sql = 'SELECT c.*, u.display_name as created_by_name, u2.display_name as assigned_to_name FROM customers c LEFT JOIN users u ON c.created_by = u.id LEFT JOIN users u2 ON c.assigned_to = u2.id';
    const params = [];
    const conditions = [];

    if (status === 'active') {
      conditions.push("c.stage IN ('" + ACTIVE_STAGES + "')");
    } else if (status === 'terminal') {
      conditions.push("c.stage IN ('" + TERMINAL_STAGES.join("','") + "')");
    } else if (stage) {
      conditions.push('c.stage = ?'); params.push(stage);
    }

    if (industry) { conditions.push('c.industry LIKE ?'); params.push('%' + industry + '%'); }
    if (search) { conditions.push('(c.brand_name LIKE ? OR c.company_name LIKE ? OR c.contact_person LIKE ?)'); params.push('%' + search + '%', '%' + search + '%', '%' + search + '%'); }
    if (is_public !== undefined) { conditions.push('c.is_public = ?'); params.push(is_public); }

    // Non-admin users only see their own customers (unless querying public pool)
    if (req.user.role !== 'admin' && is_public === undefined) {
      conditions.push('c.assigned_to = ?'); params.push(req.user.id);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY c.updated_at DESC LIMIT 200';
    const customers = db.prepare(sql).all(...params);
    res.json({ customers, total: customers.length, stages: STAGE_LABELS });
  });

  app.get('/api/customers/stats', authMiddleware, (req, res) => {
    const userFilter = req.user.role !== 'admin' ? ' WHERE assigned_to = ' + req.user.id : '';
    const byStageArr = db.prepare('SELECT stage, COUNT(*) as count FROM customers' + userFilter + ' GROUP BY stage').all();
    const total = db.prepare('SELECT COUNT(*) as count FROM customers' + userFilter).get().count;
    const active = db.prepare("SELECT COUNT(*) as count FROM customers WHERE stage IN ('" + ACTIVE_STAGES + "')" + (req.user.role !== 'admin' ? ' AND assigned_to = ' + req.user.id : '')).get().count;
    const paused = db.prepare("SELECT COUNT(*) as count FROM customers WHERE stage = 'paused'" + (req.user.role !== 'admin' ? ' AND assigned_to = ' + req.user.id : '')).get().count;
    const byIndustry = db.prepare('SELECT industry, COUNT(*) as count FROM customers' + userFilter + ' GROUP BY industry ORDER BY count DESC LIMIT 10').all();
    // Convert byStage array to object for frontend compatibility
    var byStage = {}; byStageArr.forEach(function(s) { byStage[s.stage] = s.count; });
    var won = byStage['won'] || 0;
    var publicPool = db.prepare("SELECT COUNT(*) as count FROM customers WHERE is_public = 1" + (req.user.role !== 'admin' ? ' AND (assigned_to IS NULL OR assigned_to = ' + req.user.id + ')' : '')).get().count;
    var assigned = db.prepare('SELECT COUNT(*) as count FROM customers WHERE assigned_to = ?').get(req.user.id).count;
    var weeklyNew = db.prepare("SELECT COUNT(*) as count FROM customers WHERE created_at >= datetime('now', '-7 days')" + userFilter).get().count;
    res.json({ byStage, total, active, paused, byIndustry, stages: STAGE_LABELS, won, publicPool, assigned, weeklyNew });
  });

  // Customer detail with opportunities and activity
  app.get('/api/customers/:id/detail', authMiddleware, (req, res) => {
    try {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      const opportunities = db.prepare('SELECT * FROM opportunities WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
      const activity = db.prepare('SELECT a.*, u.display_name FROM customer_activity a LEFT JOIN users u ON a.user_id = u.id WHERE a.customer_id = ? ORDER BY a.created_at DESC LIMIT 50').all(req.params.id);
      res.json({ customer, opportunities, activity });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/customers', authMiddleware, (req, res) => {
    const { brand_name, company_name, contact_person, contact_info, industry, stage, source, budget_estimate, notes, assigned_to } = req.body;
    const result = db.prepare('INSERT INTO customers (brand_name, company_name, contact_person, contact_info, industry, stage, source, budget_estimate, notes, created_by, assigned_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      brand_name, company_name, contact_person, contact_info, industry, stage || 'lead', source, budget_estimate, notes, req.user.id, assigned_to || req.user.id
    );
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'create_customer', 'customer', 'Created customer: ' + brand_name, req.ip);
    businessKnowledge.archiveCustomer(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid), req.user);
    db.prepare('INSERT INTO customer_activity (customer_id, user_id, action, stage_to, notes) VALUES (?, ?, ?, ?, ?)').run(result.lastInsertRowid, req.user.id, 'created', stage || 'lead', '客户创建');
    res.json({ id: result.lastInsertRowid });
  });

  app.put('/api/customers/:id', authMiddleware, (req, res) => {
    const { brand_name, company_name, contact_person, contact_info, industry, stage, source, budget_estimate, notes, assigned_to, opportunity_value, win_probability } = req.body;
    const old = db.prepare('SELECT stage FROM customers WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE customers SET brand_name = COALESCE(?, brand_name), company_name = COALESCE(?, company_name), contact_person = COALESCE(?, contact_person), contact_info = COALESCE(?, contact_info), industry = COALESCE(?, industry), stage = COALESCE(?, stage), source = COALESCE(?, source), budget_estimate = COALESCE(?, budget_estimate), notes = COALESCE(?, notes), assigned_to = COALESCE(?, assigned_to), opportunity_value = COALESCE(?, opportunity_value), win_probability = COALESCE(?, win_probability), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      brand_name, company_name, contact_person, contact_info, industry, stage, source, budget_estimate, notes, assigned_to, opportunity_value, win_probability, req.params.id
    );
    if (stage && old && old.stage !== stage) {
      db.prepare('INSERT INTO customer_activity (customer_id, user_id, action, stage_from, stage_to, notes) VALUES (?, ?, ?, ?, ?, ?)').run(req.params.id, req.user.id, 'stage_change', old.stage, stage, '阶段变更: ' + (STAGE_LABELS[old.stage] || old.stage) + ' -> ' + (STAGE_LABELS[stage] || stage));
      try {
        const tpls = db.prepare("SELECT id FROM workflow_templates WHERE module = 'customer' AND is_active = 1").all();
        const wfEngine = require('./workflow_engine');
        for (const t of tpls) {
          try { wfEngine.startWorkflow(t.id, 'customer', parseInt(req.params.id), { stage, previous_stage: old.stage, customer_id: parseInt(req.params.id) }, req.user.id); } catch(ew) {}
        }
      } catch(ew) {}
    }
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'update_customer', 'customer', 'Updated customer #' + req.params.id, req.ip);
    businessKnowledge.archiveCustomer(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id), req.user);
    res.json({ success: true });
  });

  app.delete('/api/customers/:id', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM customer_activity WHERE customer_id = ?').run(req.params.id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Assign customer (admin only)
  app.post('/api/customers/:id/assign', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { user_id } = req.body;
    db.prepare('UPDATE customers SET assigned_to=?, is_public=0, assigned_at=datetime(\'now\') WHERE id=?').run(user_id, req.params.id);
    businessKnowledge.archiveCustomer(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id), req.user);
    res.json({ success: true });
  });

  // Return to public pool
  app.post('/api/customers/:id/return-pool', authMiddleware, (req, res) => {
    db.prepare("UPDATE customers SET assigned_to=NULL, is_public=1, updated_at=datetime('now') WHERE id=?").run(req.params.id);
    businessKnowledge.archiveCustomer(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id), req.user);
    res.json({ success: true });
  });
  app.post('/api/customers/:id/return', authMiddleware, (req, res) => {
    db.prepare("UPDATE customers SET assigned_to=NULL, is_public=1, updated_at=datetime('now') WHERE id=?").run(req.params.id);
    businessKnowledge.archiveCustomer(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id), req.user);
    res.json({ success: true });
  });

  // ============================================================
  // OPPORTUNITY ROUTES (商机管理)
  // ============================================================

  app.get('/api/opportunities', authMiddleware, (req, res) => {
    try {
      const { customer_id, stage } = req.query;
      let query = 'SELECT o.*, c.brand_name FROM opportunities o JOIN customers c ON o.customer_id = c.id WHERE 1=1';
      let params = [];
      if (customer_id) { query += ' AND o.customer_id = ?'; params.push(customer_id); }
      if (stage) { query += ' AND o.stage = ?'; params.push(stage); }
      if (req.user.role !== 'admin') { query += ' AND (o.created_by = ? OR c.assigned_to = ?)'; params.push(req.user.id, req.user.id); }
      query += ' ORDER BY o.created_at DESC';
      res.json({ opportunities: db.prepare(query).all(...params) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opportunities', authMiddleware, (req, res) => {
    try {
      const { customer_id, name, stage, value, win_probability, product_name, channel_type, expected_close_date, notes } = req.body;
      const result = db.prepare(`INSERT INTO opportunities (customer_id, name, stage, value, win_probability, product_name, channel_type, expected_close_date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(customer_id, name, stage || 'discovery', value || 0, win_probability || 50, product_name, channel_type, expected_close_date, notes, req.user.id);
      businessKnowledge.archiveOpportunity(db, db.prepare('SELECT * FROM opportunities WHERE id = ?').get(result.lastInsertRowid), req.user);
      res.json({ id: result.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/opportunities/:id', authMiddleware, (req, res) => {
    try {
      const { name, stage, value, win_probability, product_name, channel_type, expected_close_date, notes } = req.body;
      db.prepare(`UPDATE opportunities SET name=COALESCE(?,name), stage=COALESCE(?,stage), value=COALESCE(?,value), win_probability=COALESCE(?,win_probability), product_name=COALESCE(?,product_name), channel_type=COALESCE(?,channel_type), expected_close_date=COALESCE(?,expected_close_date), notes=COALESCE(?,notes), updated_at=datetime('now') WHERE id=?`)
        .run(name, stage, value, win_probability, product_name, channel_type, expected_close_date, notes, req.params.id);
      businessKnowledge.archiveOpportunity(db, db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id), req.user);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/opportunities/:id', authMiddleware, (req, res) => {
    try {
      db.prepare('DELETE FROM opportunities WHERE id=?').run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ============================================================
  // SALES TARGETS (业绩管理)
  // ============================================================

  app.get('/api/sales-targets', authMiddleware, (req, res) => {
    try {
      const targets = req.user.role === 'admin'
        ? db.prepare('SELECT st.*, u.display_name FROM sales_targets st LEFT JOIN users u ON st.user_id = u.id ORDER BY st.period_start DESC').all()
        : db.prepare('SELECT * FROM sales_targets WHERE user_id = ? OR team_name = (SELECT department FROM users WHERE id = ?) ORDER BY period_start DESC').all(req.user.id, req.user.id);
      res.json({ targets });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/sales-targets', authMiddleware, (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      const { user_id, team_name, target_type, target_value, period, period_start, period_end } = req.body;
      const result = db.prepare('INSERT INTO sales_targets (user_id, team_name, target_type, target_value, period, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(user_id || null, team_name || null, target_type, target_value, period, period_start, period_end);
      res.json({ id: result.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ============================================================
  // SALES PERFORMANCE (销售业绩)
  // ============================================================

  app.get('/api/sales-performance', authMiddleware, (req, res) => {
    try {
      const { period_start, period_end } = req.query;
      const start = period_start || new Date(Date.now() - 30 * 86400000).toISOString().substring(0, 10);
      const end = period_end || new Date().toISOString().substring(0, 10);
      const performance = db.prepare(`
        SELECT u.id, u.display_name, u.department,
          COUNT(DISTINCT c.id) as new_customers,
          COUNT(DISTINCT CASE WHEN c.stage='won' THEN c.id END) as won_deals,
          COALESCE(SUM(CASE WHEN c.stage='won' THEN COALESCE(c.opportunity_value,0) END), 0) as revenue,
          COALESCE(SUM(o.value), 0) as pipeline_value
        FROM users u
        LEFT JOIN customers c ON c.assigned_to = u.id AND c.created_at BETWEEN ? AND ?
        LEFT JOIN opportunities o ON o.created_by = u.id AND o.stage NOT IN ('lost')
        GROUP BY u.id ORDER BY revenue DESC
      `).all(start, end);
      res.json({ performance, period: { start, end } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ============================================================
  // PUBLIC POOL (公海池)
  // ============================================================

  app.get('/api/customers/sea-pool', authMiddleware, (req, res) => {
    try {
      const customers = db.prepare("SELECT * FROM customers WHERE is_public = 1 AND assigned_to IS NULL ORDER BY updated_at DESC").all();
      res.json({ customers });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Claim customer from public pool
  app.post('/api/customers/:id/claim', authMiddleware, (req, res) => {
    try {
      db.prepare("UPDATE customers SET assigned_to=?, is_public=0, assigned_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND (is_public=1 OR assigned_to IS NULL)").run(req.user.id, req.params.id);
      businessKnowledge.archiveCustomer(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id), req.user);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ============================================================
  // DASHBOARD (仪表盘)
  // ============================================================

  app.get('/api/customers/dashboard', authMiddleware, (req, res) => {
    try {
      const userFilter = req.user.role !== 'admin' ? ' WHERE assigned_to = ' + req.user.id : '';

      const pipeline = db.prepare("SELECT stage, COUNT(*) as count, SUM(COALESCE(opportunity_value,0)) as total_value FROM customers" + userFilter + " GROUP BY stage").all();
      const recentWon = db.prepare("SELECT * FROM customers WHERE stage='won'" + userFilter + " ORDER BY updated_at DESC LIMIT 5").all();
      const upcoming = db.prepare("SELECT * FROM customers WHERE stage IN ('" + ACTIVE_STAGES + "')" + userFilter + " ORDER BY updated_at DESC LIMIT 5").all();

      res.json({ pipeline, recentWon, upcoming, stages: STAGE_LABELS });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

};
