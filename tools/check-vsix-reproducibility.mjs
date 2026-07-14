// Best-effort two-run VSIX reproducibility checker.
//
// Default mode: package the extension twice from the same checkout, keep both
// VSIX artifacts in temp paths, compute SHA-256 of each, and compare. Identical
// bytes pass cleanly. When the two archives differ, the drift is classified:
//   - zip-entry-timestamp: every entry's uncompressed content is byte-identical
//     across both archives (only zip container metadata such as entry mtimes or
//     compression differs). Allowed.
//   - vsce-tool-metadata: every RUNTIME package entry (anything not in the
//     packer-owned metadata set) is byte-identical; only vsce tool-metadata
//     entries (extension.vsixmanifest, [Content_Types].xml) differ. Allowed.
//   - unexplained-content-drift: any runtime package source/content entry
//     differs, or the entry set differs. Fails.
//
// Reporting: rule names, filenames, SHA-256 hashes, and allowed category names
// ONLY. Never the matched/differing entry content.
//
// Test hook: `--compare <a.vsix> <b.vsix>` compares two pre-built archives
// instead of packaging, so the classifier is testable with fixtures.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { basename, join, resolve } from 'node:path';
import yauzl from 'yauzl';

const repoRoot = resolve(import.meta.dirname, '..');

// vsce/packer-owned metadata entries — produced by the tool, not project source.
const TOOL_METADATA_ENTRIES = new Set(['extension.vsixmanifest', '[content_types].xml']);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
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

// Returns Map<entryPath(lower), contentHash> for the archive's file entries.
async function entryHashes(vsixPath) {
  const zipFile = await openZip(vsixPath);
  const map = new Map();
  return new Promise((resolveMap, reject) => {
    zipFile.on('entry', async (entry) => {
      try {
        const entryPath = entry.fileName.replaceAll('\\', '/');
        if (entryPath.endsWith('/')) {
          zipFile.readEntry();
          return;
        }
        const buffer = await readEntry(zipFile, entry);
        map.set(entryPath.toLowerCase(), sha256(buffer));
        zipFile.readEntry();
      } catch (error) {
        reject(error);
      }
    });
    zipFile.on('end', () => {
      zipFile.close();
      resolveMap(map);
    });
    zipFile.on('error', reject);
    zipFile.readEntry();
  });
}

function isToolMetadata(entryPath) {
  return TOOL_METADATA_ENTRIES.has(entryPath);
}

// Classify drift between two entry-hash maps. Returns { ok, categories[] } when
// drift is explainable, or { ok: false } when unexplained.
function classifyDrift(aMap, bMap) {
  const categories = new Set();
  const allKeys = new Set([...aMap.keys(), ...bMap.keys()]);

  // Entry-set must match — a missing/extra entry is never metadata-only.
  for (const key of allKeys) {
    if (!aMap.has(key) || !bMap.has(key)) {
      return { ok: false };
    }
  }

  let anyContentDiff = false;
  for (const key of allKeys) {
    if (aMap.get(key) === bMap.get(key)) {
      continue;
    }
    anyContentDiff = true;
    if (isToolMetadata(key)) {
      categories.add('vsce-tool-metadata');
    } else {
      // A runtime package entry differs in content → unexplained.
      return { ok: false };
    }
  }

  if (!anyContentDiff) {
    // All entry contents are byte-identical; the archives differed only in zip
    // container metadata (timestamps/compression).
    categories.add('zip-entry-timestamp');
  }
  return { ok: true, categories: [...categories] };
}

function packageOnce(destDir, label) {
  const result = spawnSync('npm', ['run', 'package:vsix'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`check:vsix-reproducibility: packaging run ${label} failed`);
    process.exit(1);
  }
  const vsix = readdirSync(repoRoot).find(
    (f) => f.startsWith('tokengauge-vscode-') && f.endsWith('.vsix'),
  );
  if (!vsix) {
    console.error(`check:vsix-reproducibility: no VSIX produced on run ${label}`);
    process.exit(1);
  }
  const dest = join(destDir, `${label}.vsix`);
  renameSync(join(repoRoot, vsix), dest);
  return dest;
}

async function compare(aPath, bPath) {
  for (const p of [aPath, bPath]) {
    if (!existsSync(p)) {
      console.error('Reproducibility check violations:');
      console.error(`  [missing-vsix] ${basename(p)}`);
      process.exit(1);
    }
  }

  const aBytes = readFileSync(aPath);
  const bBytes = readFileSync(bPath);
  const aHash = sha256(aBytes);
  const bHash = sha256(bBytes);

  if (aHash === bHash) {
    console.log('OK: VSIX reproducibility — byte-identical');
    console.log(`  sha256 ${aHash}  ${basename(aPath)}`);
    console.log(`  sha256 ${bHash}  ${basename(bPath)}`);
    return;
  }

  const [aMap, bMap] = await Promise.all([entryHashes(aPath), entryHashes(bPath)]);
  const verdict = classifyDrift(aMap, bMap);

  if (!verdict.ok) {
    console.error('Reproducibility check violations:');
    console.error(`  [unexplained-content-drift] ${basename(aPath)} vs ${basename(bPath)}`);
    console.error(`  sha256 ${aHash}  ${basename(aPath)}`);
    console.error(`  sha256 ${bHash}  ${basename(bPath)}`);
    process.exit(1);
  }

  console.log('OK: VSIX reproducibility — only documented metadata-only drift');
  console.log(`  sha256 ${aHash}  ${basename(aPath)}`);
  console.log(`  sha256 ${bHash}  ${basename(bPath)}`);
  console.log(`  allowed categories: ${verdict.categories.join(', ')}`);
}

const compareIndex = process.argv.indexOf('--compare');
if (compareIndex !== -1) {
  const aPath = process.argv[compareIndex + 1];
  const bPath = process.argv[compareIndex + 2];
  if (!aPath || !bPath) {
    console.error('Reproducibility check violations:');
    console.error('  [missing-compare-args] --compare requires two VSIX paths');
    process.exit(1);
  }
  await compare(resolve(aPath), resolve(bPath));
} else {
  const tempDir = mkdtempSync(join(os.tmpdir(), 'tokengauge-repro-'));
  try {
    const a = packageOnce(tempDir, 'run-1');
    const b = packageOnce(tempDir, 'run-2');
    await compare(a, b);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
