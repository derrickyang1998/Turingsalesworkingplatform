module.exports = function(app, db, authMiddleware) {

  // ===== CUSTOMER ROUTES =====
  const STAGES = ['new_lead', 'inquiry', 'proposal', 'influencer_matching', 'submitted', 'won', 'lost'];
  const STAGE_LABELS = {
    new_lead: '新线索', inquiry: '需求沟通', proposal: '方案中',
    influencer_matching: '红人匹配', submitted: '已提报', won: '成交', lost: '丢失'
  };

  app.get('/api/customers', authMiddleware, (req, res) => {
    const { stage, industry, search, assigned_to } = req.query;
    let sql = 'SELECT c.*, u.display_name as created_by_name, u2.display_name as assigned_to_name FROM customers c LEFT JOIN users u ON c.created_by = u.id LEFT JOIN users u2 ON c.assigned_to = u2.id';
    const params = [];
    const conditions = [];
    if (stage) { conditions.push('c.stage = ?'); params.push(stage); }
    if (industry) { conditions.push('c.industry LIKE ?'); params.push('%' + industry + '%'); }
    if (search) { conditions.push('(c.brand_name LIKE ? OR c.company_name LIKE ? OR c.contact_person LIKE ?)'); params.push('%' + search + '%', '%' + search + '%', '%' + search + '%'); }
    if (assigned_to) { conditions.push('c.assigned_to = ?'); params.push(parseInt(assigned_to)); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY c.updated_at DESC LIMIT 200';
    const customers = db.prepare(sql).all(...params);
    res.json({ customers, total: customers.length });
  });

  app.get('/api/customers/stats', authMiddleware, (req, res) => {
    const byStage = db.prepare('SELECT stage, COUNT(*) as count FROM customers GROUP BY stage').all();
    const total = db.prepare('SELECT COUNT(*) as count FROM customers').get().count;
    const active = db.prepare(`SELECT COUNT(*) as count FROM customers WHERE stage NOT IN ('won', 'lost')`).get().count;
    const byIndustry = db.prepare('SELECT industry, COUNT(*) as count FROM customers GROUP BY industry ORDER BY count DESC LIMIT 10').all();
    res.json({ byStage, total, active, byIndustry });
  });

  app.post('/api/customers', authMiddleware, (req, res) => {
    const { brand_name, company_name, contact_person, contact_info, industry, stage, source, budget_estimate, notes, assigned_to } = req.body;
    const result = db.prepare('INSERT INTO customers (brand_name, company_name, contact_person, contact_info, industry, stage, source, budget_estimate, notes, created_by, assigned_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      brand_name, company_name, contact_person, contact_info, industry, stage || 'new_lead', source, budget_estimate, notes, req.user.id, assigned_to || req.user.id
    );
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'create_customer', 'customer', 'Created customer: ' + brand_name, req.ip);
    db.prepare('INSERT INTO customer_activity (customer_id, user_id, action, stage_to, notes) VALUES (?, ?, ?, ?, ?)').run(result.lastInsertRowid, req.user.id, 'created', stage || 'new_lead', '客户创建');
    res.json({ id: result.lastInsertRowid });
  });

  app.put('/api/customers/:id', authMiddleware, (req, res) => {
    const { brand_name, company_name, contact_person, contact_info, industry, stage, source, budget_estimate, notes, assigned_to } = req.body;
    const old = db.prepare('SELECT stage FROM customers WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE customers SET brand_name = COALESCE(?, brand_name), company_name = COALESCE(?, company_name), contact_person = COALESCE(?, contact_person), contact_info = COALESCE(?, contact_info), industry = COALESCE(?, industry), stage = COALESCE(?, stage), source = COALESCE(?, source), budget_estimate = COALESCE(?, budget_estimate), notes = COALESCE(?, notes), assigned_to = COALESCE(?, assigned_to), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      brand_name, company_name, contact_person, contact_info, industry, stage, source, budget_estimate, notes, assigned_to, req.params.id
    );
    if (stage && old && old.stage !== stage) {
      db.prepare('INSERT INTO customer_activity (customer_id, user_id, action, stage_from, stage_to, notes) VALUES (?, ?, ?, ?, ?, ?)').run(req.params.id, req.user.id, 'stage_change', old.stage, stage, '阶段变更: ' + (STAGE_LABELS[old.stage] || old.stage) + ' -> ' + (STAGE_LABELS[stage] || stage));
    }
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'update_customer', 'customer', 'Updated customer #' + req.params.id, req.ip);
    res.json({ success: true });
  });

  app.delete('/api/customers/:id', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM customer_activity WHERE customer_id = ?').run(req.params.id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

};
