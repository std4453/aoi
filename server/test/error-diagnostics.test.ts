import assert from 'node:assert/strict';
import test from 'node:test';
import { errorDiagnostics } from '../src/services/error-diagnostics.js';

test('fatal diagnostics retain code locations without messages, credentials or runtime paths', () => {
  const error = new TypeError('https://private.invalid/link#secret\nprivate-title') as TypeError & { code: string; request: object };
  error.name = 'private-account';
  error.code = 'ERR_INVALID_ARG_TYPE';
  error.cause = new Error('private-token');
  error.request = { cookie: 'private-cookie' };
  error.stack = `TypeError: ${error.message}
    at privateName (file:///home/private-user/aoi/node_modules/megajs/dist/main.node-es.mjs:1055:30)
    at file:///home/private-user/aoi/server/src/services/mega-download.ts:120:10
    at file:///home/private-user/aoi/shared/task-errors.ts:27:5
    at load (/app/data/private-title/secret.js:1:2)
    at remote (https://private.invalid/token:1:2)
    at processTicksAndRejections (node:internal/process/task_queues:105:5)`;
  assert.deepEqual(errorDiagnostics(error), {
    type: 'TypeError', code: 'ERR_INVALID_ARG_TYPE', locations: [
      'node_modules/megajs/dist/main.node-es.mjs:1055:30',
      'server/src/services/mega-download.ts:120:10', 'shared/task-errors.ts:27:5',
      'node:internal/process/task_queues:105:5',
    ],
  });
  error.code = 'private-token';
  assert.doesNotMatch(JSON.stringify(errorDiagnostics(error)), /private|secret/);
  assert.deepEqual(errorDiagnostics({ message: 'private-title', cookie: 'private-cookie' }), { type: 'NonError' });
  assert.deepEqual(errorDiagnostics('private-token'), { type: 'NonError' });
});
