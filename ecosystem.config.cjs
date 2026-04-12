module.exports = {
  apps: [
    {
      name: 'pack-server',
      cwd: './server',
      script: 'dist/server/src/index.js',
      env: {
        PORT: 8555,
        HOST: '0.0.0.0',
        DATA_DIR: './data',
        NODE_ENV: 'production',
      },
    },
  ],
};
