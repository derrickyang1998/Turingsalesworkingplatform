// ecosystem.config.js - PM2 configuration
module.exports = {
  apps: [{
    name: "turingmarket",
    script: "server/server.js",
    cwd: __dirname,
    env: {
      NODE_ENV: "production",
      PORT: "3002",
      SERVER_HOST: "127.0.0.1",
      TM_ENV_FILE: "/etc/turingmarket/turingmarket.env",
      DB_PATH: "/var/lib/turingmarket/db/turingmarket.db",
      UPLOAD_DIR: "/var/lib/turingmarket/uploads",
      TMP_DIR: "/var/lib/turingmarket/tmp",
      PPT_CACHE_DIR: "/var/lib/turingmarket/ppt-cache"
    },
    instances: 1,
    exec_mode: "fork",
    max_memory_restart: "500M"
  }]
};
