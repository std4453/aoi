// Probe only the local listener. Certificate trust is checked by user browsers;
// the certificate's public hostname need not match the container's loopback IP.
const tls = Boolean(process.env.TLS_CERT_FILE);
const client = require(tls ? 'node:https' : 'node:http');
const request = client.get({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  path: '/healthz',
  rejectUnauthorized: false,
  timeout: 4000,
}, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy(new Error('Health check timed out')));
request.on('error', () => { process.exitCode = 1; });
