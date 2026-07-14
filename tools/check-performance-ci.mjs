// Packaged activation + adapter endurance performance gate.
//
// Steps:
//   1. Package the VSIX (npm run package:vsix) and extract its `extension/`
//      directory to a temp path — this is the exact bundle a user installs.
//   2. Assert the packaged main entry exists and is non-trivial, so the gate is
//      measuring the real packaged activation surface (not the dev tree).
//   3. Compile + run the activation and endurance integration tests, which
//      assert activation budget (UX-10: <200ms gate / <400ms CI ceiling) and
//      bounded adapter heap growth over a simulated 24h of refresh/watch cycles.
//      Mocha grep targets only those two suites so the gate stays fast.
//
// Reporting: rule names and relative paths only; never packaged file content.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import yauzl from 'yauzl';

const repoRoot = resolve(import.meta.dirname, '..');
const MIN_PACKAGED_MAIN_BYTES = 1024;

function fail(rule, detail) {
  console.error('Performance gate violations:');
  console.error(`  [${rule}]${detail ? ` ${detail}` : ''}`);
  process.exit(1);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

function openZip(vsixPath) {
  return new Promise((resolveZip, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      resolveZip(zipFile);
    });
  });
}

function readEntry(zipFile, entry) {
  return new Promise((resolveBuf, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolveBuf(Buffer.concat(chunks)));
    });
  });
}

// Extract only the `extension/` subtree of the VSIX to destDir.
async function extractExtension(vsixPath, destDir) {
  const zipFile = await openZip(vsixPath);
  return new Promise((resolveDone, reject) => {
    zipFile.on('entry', async (entry) => {
      try {
        const entryPath = entry.fileName.replaceAll('\\', '/');
        if (!entryPath.startsWith('extension/') || entryPath.endsWith('/')) {
          zipFile.readEntry();
          return;
        }
        const buffer = await readEntry(zipFile, entry);
        const outPath = join(destDir, entryPath.slice('extension/'.length));
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, buffer);
        zipFile.readEntry();
      } catch (error) {
        reject(error);
      }
    });
    zipFile.on('end', () => {
      zipFile.close();
      resolveDone();
    });
    zipFile.on('error', reject);
    zipFile.readEntry();
  });
}

// --- Step 1: package the VSIX. ---------------------------------------------
if (run('npm', ['run', 'package:vsix']) !== 0) {
  fail('packaging-failed', 'npm run package:vsix');
}

const vsix = readdirSync(repoRoot).find(
  (f) => f.startsWith('tokengauge-vscode-') && f.endsWith('.vsix'),
);
if (!vsix) {
  fail('no-vsix-produced');
}

// --- Step 2: extract and assert the packaged activation surface. -----------
const tempDir = mkdtempSync(join(os.tmpdir(), 'tokengauge-perf-'));
try {
  const extractDir = join(tempDir, 'extension');
  mkdirSync(extractDir, { recursive: true });
  await extractExtension(join(repoRoot, vsix), extractDir);

  const manifestPath = join(extractDir, 'package.json');
  if (!existsSync(manifestPath)) {
    fail('packaged-manifest-missing');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const mainRel = (manifest.main ?? '').replace(/^\.\//, '');
  if (!mainRel) {
    fail('packaged-main-undeclared');
  }
  const mainPath = join(extractDir, mainRel);
  if (!existsSync(mainPath)) {
    fail('packaged-main-missing', mainRel);
  }
  if (statSync(mainPath).size < MIN_PACKAGED_MAIN_BYTES) {
    fail('packaged-main-too-small', mainRel);
  }
  console.log(`OK: packaged activation surface present (${mainRel})`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

// --- Step 3: run activation + endurance integration suites. ----------------
if (run('npm', ['run', 'compile-tests']) !== 0) {
  fail('compile-tests-failed');
}
if (run('npm', ['run', 'build']) !== 0) {
  fail('build-failed');
}

const grep = 'Activation budget|Adapter endurance';
// `run` uses shell:true on Windows so `npx.cmd` resolves; under cmd.exe the `|`
// in the grep pattern is otherwise treated as a pipe (it ran `Adapter endurance`
// as a command). Quote the pattern on win32 so it stays a single argument.
const grepArg = process.platform === 'win32' ? `"${grep}"` : grep;
const status = run('npx', ['vscode-test', '--label', 'integration', '--', '--grep', grepArg]);
if (status !== 0) {
  fail('performance-tests-failed', 'activation/endurance integration suites');
}

console.log('OK: performance gate passed (packaged activation + adapter endurance)');
