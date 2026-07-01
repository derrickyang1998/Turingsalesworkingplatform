function id(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function isAssignedOrCreator(user, record) {
  if (!user || !record) return false;
  const userId = id(user.id);
  return id(record.assigned_to) === userId || id(record.created_by) === userId;
}

function canAccessCustomer(user, customer) {
  if (!customer) return false;
  if (isAdmin(user)) return true;
  if (isAssignedOrCreator(user, customer)) return true;
  return Number(customer.is_public || 0) === 1 && !customer.assigned_to;
}

function canManageCustomer(user, customer) {
  if (!customer) return false;
  if (isAdmin(user)) return true;
  return isAssignedOrCreator(user, customer);
}

function canAccessLead(user, lead) {
  if (!lead) return false;
  if (isAdmin(user)) return true;
  return id(lead.assigned_to) === id(user && user.id);
}

function getCustomer(db, customerId) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
}

function getLead(db, leadId) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
}

function getOpportunityWithCustomer(db, opportunityId) {
  return db.prepare(`
    SELECT o.*, c.assigned_to AS customer_assigned_to, c.created_by AS customer_created_by, c.is_public AS customer_is_public
    FROM opportunities o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.id = ?
  `).get(opportunityId);
}

function canAccessOpportunity(user, opportunity) {
  if (!opportunity) return false;
  if (isAdmin(user)) return true;
  const customer = {
    assigned_to: opportunity.customer_assigned_to,
    created_by: opportunity.customer_created_by,
    is_public: opportunity.customer_is_public
  };
  return id(opportunity.created_by) === id(user && user.id) || canAccessCustomer(user, customer);
}

function canManageOpportunity(user, opportunity) {
  if (!opportunity) return false;
  if (isAdmin(user)) return true;
  const userId = id(user && user.id);
  return id(opportunity.created_by) === userId ||
    id(opportunity.customer_assigned_to) === userId ||
    id(opportunity.customer_created_by) === userId;
}

function customerOwnerId(customer, fallbackUser) {
  return id(customer && customer.assigned_to) || id(customer && customer.created_by) || id(fallbackUser && fallbackUser.id) || null;
}

function leadOwnerId(lead, fallbackUser) {
  return id(lead && lead.assigned_to) || id(fallbackUser && fallbackUser.id) || null;
}

function opportunityOwnerId(db, opportunity, fallbackUser) {
  if (!opportunity) return id(fallbackUser && fallbackUser.id) || null;
  const customer = opportunity.customer_id ? getCustomer(db, opportunity.customer_id) : null;
  return customerOwnerId(customer, fallbackUser) || id(opportunity.created_by) || id(fallbackUser && fallbackUser.id) || null;
}

function forbidden(res) {
  return res.status(403).json({ error: 'Forbidden' });
}

function notFound(res, label) {
  return res.status(404).json({ error: (label || 'Record') + ' not found' });
}

module.exports = {
  canAccessCustomer,
  canManageCustomer,
  canAccessLead,
  canAccessOpportunity,
  canManageOpportunity,
  getCustomer,
  getLead,
  getOpportunityWithCustomer,
  customerOwnerId,
  leadOwnerId,
  opportunityOwnerId,
  forbidden,
  notFound
};
