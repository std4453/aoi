import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const tsc = path.join(serverDir, 'node_modules/typescript/bin/tsc');
const tscAlias = path.join(serverDir, 'node_modules/tsc-alias/dist/bin/index.js');
const tsx = path.join(serverDir, 'node_modules/tsx/dist/cli.mjs');
const serverConfig = JSON.parse(fs.readFileSync(path.join(serverDir, 'tsconfig.json'), 'utf8'));

test('relative and aliased imports preserve the original ESM output and run in Node and tsx', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-build-imports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fixtures = {
    'file.ts': 'export const value = 1;\n',
    'feature/index.ts': 'export const value = 2;\nexport interface Value { value: number; }\n',
    'feature/nested.ts': "export { value } from './index.js';\n",
    'feature/deep/consumer.ts': "export { value } from '../../file.js';\n",
    'barrel.ts': "export { value } from './feature/index.js';\n",
    'side-effect/index.ts': 'console.log(3);\n',
    'main.ts': [
      "import { value as file } from './file.js';",
      "import { value as directory } from './feature/index.js';",
      "import { value as nested } from './feature/nested.js';",
      "import { value as reexported } from './barrel.js';",
      "import { value as deep } from './feature/deep/consumer.js';",
      "import type { Value } from './feature/index.js';",
      "import './side-effect/index.js';",
      "const dynamic = await import('./feature/index.js');",
      'const typed: Value = { value: directory };',
      'console.log(JSON.stringify([file, directory, nested, reexported, dynamic.value, typed.value, deep]));',
      '',
    ].join('\n'),
  };

  for (const variant of ['baseline', 'rewritten', 'aliased']) {
    const directory = path.join(root, variant, 'server');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
    const config = structuredClone(serverConfig);
    Object.assign(config.compilerOptions, { outDir: 'dist', types: [] });
    config.include = ['src/**/*.ts'];
    if (variant === 'baseline') {
      Object.assign(config.compilerOptions, { module: 'Node16', moduleResolution: 'Node16' });
      delete config.compilerOptions.moduleDetection;
      delete config.compilerOptions.rewriteRelativeImportExtensions;
      delete config.compilerOptions.paths;
      delete config['tsc-alias'];
    }
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify(config));
    for (const [name, original] of Object.entries(fixtures)) {
      const destination = path.join(directory, 'src', name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      let source = variant === 'baseline' ? original : original
        .replaceAll('./index.js', '.')
        .replaceAll('/index.js', '')
        .replaceAll('.js\'', '\'');
      if (variant === 'aliased') {
        source = source.replaceAll("'./", "'~/").replaceAll("'../../file'", "'~/file'");
      }
      fs.writeFileSync(destination, source);
    }
    execFileSync(process.execPath, [tsc, '-p', directory], { cwd: serverDir });
    if (variant !== 'baseline') {
      execFileSync(process.execPath, [tscAlias, '-p', path.join(directory, 'tsconfig.json')], { cwd: serverDir });
    }
  }

  for (const variant of ['rewritten', 'aliased']) {
    for (const name of Object.keys(fixtures)) {
      const emitted = name.replace(/\.ts$/, '.js');
      assert.deepEqual(
        fs.readFileSync(path.join(root, variant, 'server/dist/server/src', emitted)),
        fs.readFileSync(path.join(root, 'baseline/server/dist/server/src', emitted)),
        `${variant}/${emitted} must match the original build byte for byte`,
      );
    }
    const expected = '3\n[1,2,2,2,2,2,1]\n';
    const directory = path.join(root, variant, 'server');
    assert.equal(execFileSync(process.execPath, [path.join(directory, 'dist/server/src/main.js')], { encoding: 'utf8' }), expected);
    assert.equal(execFileSync(process.execPath, [tsx, '--tsconfig', path.join(directory, 'tsconfig.json'), path.join(directory, 'src/main.ts')], { cwd: serverDir, encoding: 'utf8' }), expected);
  }
});
