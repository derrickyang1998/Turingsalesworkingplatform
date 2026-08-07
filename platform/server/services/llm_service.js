const DEFAULT_DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

function extractSystemContext(messages) {
  const system = (messages || []).filter(function(message) {
    return message.role === 'system';
  }).slice(-1)[0];
  const content = system ? String(system.content || '') : '';
  const kbMatch = content.match(/【平台知识库上下文】\n([\s\S]*?)(\n【联网搜索上下文】\n|$)/);
  const webMatch = content.match(/【联网搜索上下文】\n([\s\S]*)$/);
  return {
    knowledge: kbMatch ? kbMatch[1].trim() : '',
    web: webMatch ? webMatch[1].trim() : ''
  };
}

function fallbackContent(messages, reason) {
  const userMessage = (messages || []).filter(function(message) {
    return message.role === 'user';
  }).slice(-1)[0];
  const context = extractSystemContext(messages);
  const lines = [
    '当前 AI 生成服务暂时不可用，以下回复基于平台知识库和已取得的上下文生成。',
    reason ? '降级原因：' + reason : ''
  ];

  if (context.knowledge) {
    lines.push('', '可用知识库依据：', context.knowledge.slice(0, 1800));
  } else {
    lines.push('', '当前没有命中足够的知识库内容，结论需要人工复核。');
  }
  if (context.web) {
    lines.push('', '可用联网来源：', context.web.slice(0, 900));
  }
  if (userMessage) {
    lines.push('', '针对你的问题：' + userMessage.content);
  }
  lines.push('', '建议下一步：补充需求表、客户背景、达人名单或确认方案后，再让 AI 重新生成完整版本。');
  return lines.filter(Boolean).join('\n');
}

function createDeepSeekProvider(opts) {
  opts = opts || {};
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.DEEPSEEK_API_KEY;
  const endpoint = opts.endpoint || process.env.DEEPSEEK_API_URL || DEFAULT_DEEPSEEK_URL;
  const model = opts.model || process.env.DEEPSEEK_MODEL || process.env.AI_MODEL || 'deepseek-chat';
  const fetchImpl = opts.fetchImpl || global.fetch;

  return {
    async complete(request) {
      request = request || {};
      const messages = request.messages || [];
      if (!apiKey || typeof fetchImpl !== 'function') {
        const reason = !apiKey ? 'deepseek api key not configured' : 'fetch not available';
        return {
          content: fallbackContent(messages, reason),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: model,
          degraded: true,
          reason: reason
        };
      }

      let response;
      try {
        const fetchOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
          },
          body: JSON.stringify({
            model: request.model || model,
            messages: messages,
            temperature: request.temperature === undefined ? 0.7 : request.temperature,
            max_tokens: request.max_tokens || request.maxTokens || 2000
          })
        };
        if (request.signal !== undefined) fetchOptions.signal = request.signal;
        response = await fetchImpl(endpoint, fetchOptions);
      } catch (e) {
        return {
          content: fallbackContent(messages, 'deepseek network error: ' + e.message),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: model,
          degraded: true,
          reason: 'deepseek network error'
        };
      }

      if (!response.ok) {
        const text = await response.text().catch(function() { return ''; });
        return {
          content: fallbackContent(messages, 'deepseek api failed: ' + response.status),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: model,
          degraded: true,
          reason: 'deepseek api failed: ' + response.status + (text ? ' ' + text.slice(0, 180) : '')
        };
      }

      const data = await response.json();
      return {
        content: data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '',
        usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: data.model || request.model || model,
        raw: data
      };
    }
  };
}

module.exports = {
  createDeepSeekProvider,
  fallbackContent
};
