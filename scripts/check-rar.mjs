import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const corpus = JSON.parse(fs.readFileSync(new URL('../server/test/fixtures/rar/corpus.json', import.meta.url), 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function fixtureBytes(fixture) {
  const bytes = Buffer.from(fixture.archive, 'base64');
  assert.equal(sha256(bytes), fixture.sha256, `${fixture.name}: fixture checksum changed`);
  return bytes;
}

export function assertRarCodecs() {
  const info = execFileSync('7z', ['i'], { encoding: 'utf8', timeout: 5000 });
  const codecs = info.split('Codecs:')[1]?.split('Hashers:')[0] ?? '';
  for (const codec of ['Rar3', 'Rar5']) {
    assert.match(codecs, new RegExp(`\\b${codec}\\b`), `7z lacks the ${codec} decoder; archive handlers alone are insufficient`);
  }
  return info.split('\n').find(line => /7-Zip/.test(line));
}

/** Exercises the actual installed decoder; also runs in the final runtime image. */
export function verifyRarCorpus() {
  console.log(assertRarCodecs());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-rar-codecs-'));
  try {
    for (const fixture of corpus.cases) {
      const archive = path.join(root, `${fixture.name}.rar`);
      const output = path.join(root, fixture.name);
      fs.writeFileSync(archive, fixtureBytes(fixture));
      execFileSync('7z', ['x', '-y', `-o${output}`, ...(fixture.password ? [`-p${fixture.password}`] : []), archive], {
        input: '', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000,
      });
      const actual = [];
      const visit = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          assert.equal(entry.isSymbolicLink(), false);
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) visit(full);
          else actual.push(path.relative(output, full).split(path.sep).join('/'));
        }
      };
      visit(output);
      assert.deepEqual(actual.sort(), Object.keys(fixture.files).sort(), fixture.name);
      for (const [name, digest] of Object.entries(fixture.files)) {
        assert.equal(sha256(fs.readFileSync(path.join(output, name))), digest, `${fixture.name}: ${name}`);
      }
      console.log(`PASS ${fixture.name}: decoded ${actual.length} files with matching hashes`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyRarCorpus();
