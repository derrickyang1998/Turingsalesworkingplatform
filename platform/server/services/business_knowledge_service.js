const knowledgeService = require('./knowledge_service');
const crmAccess = require('./crm_access_service');

function compact(value, maxLength) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '...';
}

function cleanTags(tags) {
  return Array.from(new Set((tags || []).map(function(tag) {
    return String(tag || '').trim();
  }).filter(Boolean))).slice(0, 30);
}

function stringifyRecord(record) {
  return JSON.stringify(record || {}, null, 2);
}

function actor(user) {
  return user || { id: null, role: 'system' };
}

function ingest(db, input, user, ownerId) {
  const current = actor(user);
  return knowledgeService.ingestKnowledge(db, Object.assign({
    created_by: ownerId || current.id,
    actor_role: current.role
  }, input));
}

function safeIngest(db, input, user, ownerId) {
  try {
    return ingest(db, input, user, ownerId);
  } catch (e) {
    return null;
  }
}

function archiveLead(db, lead, user) {
  lead = lead || {};
  return safeIngest(db, {
    title: 'CRM lead: ' + (lead.brand_name || lead.company_name || lead.id || 'untitled'),
    summary: compact([lead.brand_name, lead.company_name, lead.industry, lead.source, lead.status].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(lead),
    entry_type: 'crm_lead',
    source_type: 'crm_lead',
    source_id: lead.id,
    visibility: 'private',
    tags: cleanTags(['crm', 'lead', lead.industry, lead.source, lead.status]),
    business_type: 'lead',
    business_id: lead.id,
    metadata: { module: 'crm' }
  }, user, crmAccess.leadOwnerId(lead, user));
}

function archiveCustomer(db, customer, user) {
  customer = customer || {};
  return safeIngest(db, {
    title: 'CRM customer: ' + (customer.brand_name || customer.company_name || customer.id || 'untitled'),
    summary: compact([customer.brand_name, customer.company_name, customer.industry, customer.stage, customer.budget_estimate].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(customer),
    entry_type: 'crm_customer',
    source_type: 'crm_customer',
    source_id: customer.id,
    visibility: 'private',
    tags: cleanTags(['crm', 'customer', customer.industry, customer.stage, customer.source]),
    business_type: 'customer',
    business_id: customer.id,
    metadata: { module: 'crm' }
  }, user, crmAccess.customerOwnerId(customer, user));
}

function archiveOpportunity(db, opportunity, user) {
  opportunity = opportunity || {};
  return safeIngest(db, {
    title: 'CRM opportunity: ' + (opportunity.name || opportunity.id || 'untitled'),
    summary: compact([opportunity.name, opportunity.stage, opportunity.product_name, opportunity.channel_type, opportunity.value].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(opportunity),
    entry_type: 'crm_opportunity',
    source_type: 'crm_opportunity',
    source_id: opportunity.id,
    visibility: 'private',
    tags: cleanTags(['crm', 'opportunity', opportunity.stage, opportunity.product_name, opportunity.channel_type]),
    business_type: 'opportunity',
    business_id: opportunity.id,
    metadata: { module: 'crm', customer_id: opportunity.customer_id }
  }, user, crmAccess.opportunityOwnerId(db, opportunity, user));
}

function archiveBrand(db, brand, user) {
  brand = brand || {};
  const rawTags = Array.isArray(brand.industry_tags)
    ? brand.industry_tags
    : String(brand.industry_tags || '').split(',');
  return safeIngest(db, {
    title: 'Brand profile: ' + (brand.name || brand.name_cn || brand.id || 'untitled'),
    summary: compact([brand.name, brand.name_cn, brand.market, rawTags.join('/'), brand.top_platform].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(brand),
    entry_type: 'brand_profile',
    source_type: 'brand_profile',
    source_id: brand.id || brand.name,
    visibility: 'team',
    tags: cleanTags(['brand', 'market', brand.market, brand.top_platform].concat(rawTags)),
    business_type: 'brand',
    business_id: brand.id || brand.name,
    metadata: { module: 'brand_intelligence' }
  }, user);
}

function archiveInfluencer(db, influencer, user) {
  influencer = influencer || {};
  return safeIngest(db, {
    title: 'Influencer profile: ' + (influencer.kol_handle || influencer.id || 'untitled'),
    summary: compact([influencer.platform, influencer.kol_handle, influencer.category, influencer.region, influencer.followers].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(influencer),
    entry_type: 'influencer_profile',
    source_type: 'influencer_profile',
    source_id: influencer.id || influencer.kol_handle,
    visibility: 'team',
    tags: cleanTags(['influencer', influencer.platform, influencer.category, influencer.region, influencer.tags]),
    business_type: 'influencer',
    business_id: influencer.id || influencer.kol_handle,
    metadata: { module: 'influencer' }
  }, user);
}

function archiveCollaboration(db, collaboration, user) {
  collaboration = collaboration || {};
  return safeIngest(db, {
    title: 'Collaboration: ' + (collaboration.id || collaboration.influencer_id || 'untitled'),
    summary: compact([collaboration.status, collaboration.cost_quoted, collaboration.cost_actual, collaboration.content_url].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(collaboration),
    entry_type: 'collaboration_record',
    source_type: 'collaboration',
    source_id: collaboration.id,
    visibility: 'team',
    tags: cleanTags(['collaboration', collaboration.status, collaboration.demand_id, collaboration.influencer_id]),
    business_type: 'collaboration',
    business_id: collaboration.id,
    metadata: { module: 'influencer', demand_id: collaboration.demand_id, influencer_id: collaboration.influencer_id }
  }, user);
}

function archiveWorkflowTemplate(db, template, user) {
  template = template || {};
  return safeIngest(db, {
    title: 'Workflow template: ' + (template.name || template.id || 'untitled'),
    summary: compact([template.name, template.module, template.category, template.description].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(template),
    entry_type: 'workflow_template',
    source_type: 'workflow_template',
    source_id: template.id,
    visibility: 'team',
    tags: cleanTags(['workflow', 'template', template.module, template.category]),
    business_type: 'workflow_template',
    business_id: template.id,
    metadata: { module: 'workflow' }
  }, user);
}

function archiveWorkflowInstance(db, instance, user, action) {
  instance = instance || {};
  return safeIngest(db, {
    title: 'Workflow instance: ' + (instance.id || instance.business_type || 'untitled'),
    summary: compact([action || 'started', instance.business_type, instance.business_id, instance.status].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(Object.assign({ action: action || 'started' }, instance)),
    entry_type: 'workflow_instance',
    source_type: 'workflow_instance',
    source_id: instance.id,
    visibility: 'team',
    tags: cleanTags(['workflow', 'instance', action, instance.business_type, instance.status]),
    business_type: instance.business_type || 'workflow_instance',
    business_id: instance.business_id || instance.id,
    metadata: { module: 'workflow', workflow_instance_id: instance.id }
  }, user);
}

function archiveWorkflowTask(db, task, user, action, comment) {
  task = task || {};
  return safeIngest(db, {
    title: 'Workflow task: ' + (task.title || task.id || 'untitled'),
    summary: compact([action, task.title, task.status, comment].filter(Boolean).join(' / '), 240),
    content: stringifyRecord(Object.assign({ action: action, comment: comment || '' }, task)),
    entry_type: 'workflow_task',
    source_type: 'workflow_task',
    source_id: task.id,
    visibility: 'team',
    tags: cleanTags(['workflow', 'task', action, task.node_type, task.status]),
    business_type: 'workflow_task',
    business_id: task.id,
    metadata: { module: 'workflow', instance_id: task.instance_id }
  }, user);
}

module.exports = {
  archiveLead,
  archiveCustomer,
  archiveOpportunity,
  archiveBrand,
  archiveInfluencer,
  archiveCollaboration,
  archiveWorkflowTemplate,
  archiveWorkflowInstance,
  archiveWorkflowTask
};
