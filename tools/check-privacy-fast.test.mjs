import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(repoRoot, 'tools/check-privacy-fast.mjs');
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tokengauge-privacy-fast-'));
const planted = '__TOKEN' + 'GAUGE_' + 'SEN' + 'TINEL_' + 'PROMPT__';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function longSlices(value) {
  const slices = [];
  for (let i = 0; i <= value.length - 20; i += 1) {
    slices.push(value.slice(i, i + 20));
  }
  return slices;
}

try {
  const srcDir = path.join(tempDir, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, 'leak.ts'), `const value = '${planted}';\n`);

  const result = spawnSync('node', [scriptPath, srcDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  assert(result.status !== 0, 'expected planted sentinel to fail the scan');
  assert(output.includes('[sentinel-prompt]'), 'expected sentinel-prompt rule name in output');
  assert(!output.includes(planted), 'scanner output must not include the planted value');
  for (const slice of longSlices(planted)) {
    assert(!output.includes(slice), 'scanner output must not include long substrings of the value');
  }

  console.log('OK: privacy fast-sweep reporting style test passed.');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
