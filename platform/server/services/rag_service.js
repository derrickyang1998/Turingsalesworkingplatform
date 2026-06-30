const knowledge = require('./knowledge_service');

function buildRagContext(db, opts) {
  opts = opts || {};
  const query = opts.query || opts.q || '';
  const limit = opts.limit || 8;
  const results = knowledge.searchKnowledge(db, {
    q: query,
    user: opts.user,
    limit: limit,
    entry_type: opts.entry_type,
    source_type: opts.source_type,
    visibility: opts.visibility,
    business_type: opts.business_type,
    business_id: opts.business_id,
    tags: opts.tags
  });

  const references = results.map(function(entry) {
    return {
      id: entry.id,
      title: entry.title,
      entry_type: entry.entry_type,
      source_type: entry.source_type,
      source_id: entry.source_id,
      visibility: entry.visibility,
      snippet: entry.snippet || String(entry.content || '').slice(0, 220),
      usage_count: entry.usage_count || 0
    };
  });

  const contextText = references.length
    ? results.map(function(entry, index) {
      return [
        `[KB-${index + 1}] ${entry.title || 'Knowledge'} (#${entry.id})`,
        `Type: ${entry.entry_type || 'note'}; Tags: ${(entry.tags || []).join(', ') || '-'}`,
        String(entry.summary || entry.content || '').slice(0, 900)
      ].join('\n');
    }).join('\n\n')
    : '';

  return {
    query: query,
    contextText: contextText,
    references: references,
    hasKnowledge: references.length > 0
  };
}

function buildSystemPrompt(opts) {
  opts = opts || {};
  const lines = [
    '你是 TuringMarket 平台的 AI 商务与红人营销助手。',
    '回答必须优先使用平台知识库内容；如果知识库不足，明确说明不足之处。',
    '当联网结果存在时，可以结合联网来源，但不要把未验证信息说成平台事实。',
    '涉及方案、PPT、客户、品牌、达人和流程建议时，尽量引用 [KB-n] 或 [WEB-n] 编号。',
    '回答使用中文，结构清晰，可执行，适合商务团队直接复用。'
  ];
  if (opts.contextText) {
    lines.push('\n【平台知识库上下文】\n' + opts.contextText);
  }
  if (opts.webContext) {
    lines.push('\n【联网搜索上下文】\n' + opts.webContext);
  }
  return lines.join('\n');
}

module.exports = {
  buildRagContext,
  buildSystemPrompt
};
