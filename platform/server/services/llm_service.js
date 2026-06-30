const DEFAULT_DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

function fallbackContent(messages) {
  const userMessage = (messages || []).filter(function(m) { return m.role === 'user'; }).slice(-1)[0];
  return [
    'AI 服务尚未配置 DeepSeek API Key，当前只能基于平台知识库给出有限回复。',
    '',
    userMessage ? '你的问题：' + userMessage.content : '',
    '',
    '请在服务端环境变量中配置 DEEPSEEK_API_KEY 后再获取完整生成结果。'
  ].filter(Boolean).join('\n');
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
        return {
          content: fallbackContent(messages),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: model,
          degraded: true,
          reason: !apiKey ? 'deepseek api key not configured' : 'fetch not available'
        };
      }

      const response = await fetchImpl(endpoint, {
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
      });

      if (!response.ok) {
        const text = await response.text().catch(function() { return ''; });
        throw new Error('DeepSeek API failed: ' + response.status + (text ? ' ' + text.slice(0, 180) : ''));
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
