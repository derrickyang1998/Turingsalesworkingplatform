const { createFeishuClient, FeishuClientError } = require('./feishu_client');

function writeFeishuAudit(db, req, action, details) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, action, 'feishu', JSON.stringify(details || {}), req.ip);
  } catch (error) {
    // Audit writes must not turn a completed provider request into an unknown result.
  }
}

function safeConnectionError(error) {
  if (error instanceof FeishuClientError) {
    return {
      statusCode: error.statusCode || 502,
      code: error.code,
      message: error.message
    };
  }
  return {
    statusCode: 502,
    code: 'FEISHU_CONNECTION_TEST_FAILED',
    message: 'Feishu connection test failed.'
  };
}

module.exports = function registerFeishuRoutes(app, options) {
  options = options || {};
  const db = options.db;
  const authMiddleware = options.authMiddleware;
  const adminOnly = options.adminOnly;
  const feishuClient = options.feishuClient || createFeishuClient();

  app.get('/api/feishu/status', authMiddleware, function(req, res) {
    res.json(feishuClient.getStatus());
  });

  app.post('/api/feishu/test', authMiddleware, adminOnly, async function(req, res) {
    try {
      const result = await feishuClient.testConnection();
      writeFeishuAudit(db, req, 'feishu_connection_test', { mode: result.mode, ok: true });
      res.json(result);
    } catch (error) {
      const failure = safeConnectionError(error);
      const status = feishuClient.getStatus();
      writeFeishuAudit(db, req, 'feishu_connection_test_failed', {
        mode: status.mode,
        code: failure.code
      });
      res.status(failure.statusCode).json({ error: failure.message, code: failure.code });
    }
  });
};
