import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A local child process owns the desktop, not Docker/Kubernetes. Closing stdin
// revokes its lease even when the broker exits without running JS cleanup.
export function launchSession(config, onEnd, command = 'python3', args = [fileURLToPath(new URL('./session-runner.py', import.meta.url))]) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  let closed = false;
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.stdin.end(); reject(new Error('browser startup timeout')); }, 95000);
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      if (output.length > 1024) { child.stdin.end(); reject(new Error('invalid browser response')); }
      if (output.includes('\n')) {
        clearTimeout(timer);
        try { if (JSON.parse(output.trim()).ready !== true) throw new Error(); resolve(); }
        catch { reject(new Error('invalid browser response')); }
      }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('browser start failed')); finish(false); });
    child.once('exit', code => {
      clearTimeout(timer); closed = true; finish(code === 0);
      reject(new Error('browser session ended')); onEnd(code === 0);
    });
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(config)}\n`);
  });
  return {
    ready,
    async close() {
      if (!closed) child.stdin.end();
      let timer;
      try {
        const clean = await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser cleanup timeout')), 45000); })]);
        if (!clean) throw new Error('browser cleanup failed');
      } finally { clearTimeout(timer); }
    },
  };
}
