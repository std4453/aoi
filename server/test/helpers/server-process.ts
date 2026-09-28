import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';

export interface TestServer {
  child: ChildProcess;
  port: number;
  url: string;
  output: () => string;
}

export async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to allocate a test port');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

export async function startTestServer(
  dataDir: string,
  waitForReady = true,
  environment: NodeJS.ProcessEnv = {}
): Promise<TestServer> {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FRONTEND_ONLY: 'false',
      SERVER_SELECTION_ENABLED: 'false',
      AUTH_KEY: '',
      TLS_CERT_FILE: '',
      TLS_KEY_FILE: '',
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      BACKUP_RETENTION: '3',
      SHUTDOWN_TIMEOUT: '5000',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let combinedOutput = '';
  child.stdout?.on('data', chunk => {
    combinedOutput += chunk.toString();
  });
  child.stderr?.on('data', chunk => {
    combinedOutput += chunk.toString();
  });

  const server = {
    child,
    port,
    url: `http://127.0.0.1:${port}`,
    output: () => combinedOutput,
  };

  if (waitForReady) {
    await waitForHealth(server);
  }
  return server;
}

export async function waitForHealth(server: TestServer, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Test server exited before becoming healthy:\n${server.output()}`);
    }
    try {
      const response = await fetch(`${server.url}/healthz`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for test server:\n${server.output()}`);
}

export async function waitForExit(server: TestServer, timeoutMs = 10_000): Promise<number | null> {
  if (server.child.exitCode !== null) return server.child.exitCode;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for process exit:\n${server.output()}`)), timeoutMs);
    server.child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function stopTestServer(server: TestServer, signal: NodeJS.Signals = 'SIGTERM'): Promise<number | null> {
  if (server.child.exitCode === null) {
    server.child.kill(signal);
  }
  return waitForExit(server);
}
