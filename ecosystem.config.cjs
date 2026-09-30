const path = require('node:path');

const repositoryRoot = __dirname;

module.exports = {
  apps: [
    {
      name: 'pack-server',
      cwd: path.join(repositoryRoot, 'server'),
      script: 'dist/server/src/index.js',
      exec_mode: 'fork',
      instances: 1,
      wait_ready: true,
      listen_timeout: 15_000,
      kill_timeout: 45_000,
      restart_delay: 1_000,
      env: {
        PORT: Number(process.env.PORT || 8555),
        HOST: process.env.HOST || '0.0.0.0',
        DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(repositoryRoot, 'data')),
        NODE_ENV: 'production',
        FRONTEND_ONLY: process.env.FRONTEND_ONLY || 'false',
        SERVER_SELECTION_ENABLED: process.env.SERVER_SELECTION_ENABLED || 'false',
        AUTH_KEY: process.env.AUTH_KEY || '',
        TLS_CERT_FILE: process.env.TLS_CERT_FILE || '',
        TLS_KEY_FILE: process.env.TLS_KEY_FILE || '',
      },
    },
  ],
};
