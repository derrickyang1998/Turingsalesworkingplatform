// ecosystem.config.js - PM2 configuration
module.exports = {
  apps: [{
    name: "turingmarket",
    script: "server/server.js",
    cwd: __dirname,
    env: {
      NODE_ENV: "production",
      PORT: "3002",
      DB_PATH: "server/db/turingmarket.db"
    },
    instances: 1,
    exec_mode: "fork",
    max_memory_restart: "500M"
  }]
};
