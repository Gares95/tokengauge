// Fixture-based regression suite for the VSIX reproducibility checker.
//
// Builds pairs of fixture ZIPs and runs the checker in --compare mode so the
// classifier is exercised without packaging the real extension twice. Asserts:
//   - identical content (and identical bytes) passes
//   - metadata-only drift (zip timestamps, vsce tool metadata) passes and is
//     reported only by allowed category name
//   - runtime source/content drift fails as unexplained
//   - failure output reports rule names, filenames, hashes, and allowed
//     category names only — never matched entry content
import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import archiver from 'archiver';

const repoRoot = path.resolve(import.meta.dirname, '..');
const checker = path.join(repoRoot, 'tools/check-vsix-reproducibility.mjs');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// Runtime package entries that MUST be byte-identical between two reproducible
// builds. Drift here is unexplained and must fail.
const RUNTIME_ENTRIES = [
  { path: 'extension/package.json', content: '{"name":"x","version":"0.0.1"}\n' },
  { path: 'extension/dist/extension.js', content: 'module.exports = {};\n' },
  { path: 'extension/README.md', content: '# x\n' },
];

// vsce-tool metadata entries — produced by the packer, not project source.
const META_ENTRIES = [
  { path: 'extension.vsixmanifest', content: '<?xml version="1.0"?><PackageManifest/>' },
  { path: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
];

function buildZip(tempDir, name, entries, { date } = {}) {
  const zipPath = path.join(tempDir, `${name}.vsix`);
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise((resolve, reject) => {
    output.on('close', () => resolve(zipPath));
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const entry of entries) {
    const opts = { name: entry.path };
    if (date) {
      opts.date = date;
    }
    archive.append(entry.content, opts);
  }
  archive.finalize();
  return done;
}

function runCompare(a, b) {
  const result = spawnSync('node', [checker, '--compare', a, b], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function runFixture(name, build, check) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `tokengauge-${name}-`));
  try {
    const [a, b] = await build(tempDir);
    check(runCompare(a, b));
    console.log(`OK: ${name}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const ALL = [...RUNTIME_ENTRIES, ...META_ENTRIES];

// Test 1: identical builds (same content, same fixed timestamps) → byte-equal.
await runFixture(
  'identical',
  async (dir) => {
    const date = new Date('2020-01-01T00:00:00Z');
    return [await buildZip(dir, 'a', ALL, { date }), await buildZip(dir, 'b', ALL, { date })];
  },
  (result) => {
    assert(result.status === 0, `identical builds should pass, got:\n${result.output}`);
  },
);

// Test 3 (metadata-only via timestamps): same content, different zip entry
// timestamps → allowed `zip-entry-timestamp` category, passes.
await runFixture(
  'metadata-timestamp-drift',
  async (dir) => [
    await buildZip(dir, 'a', ALL, { date: new Date('2020-01-01T00:00:00Z') }),
    await buildZip(dir, 'b', ALL, { date: new Date('2024-06-06T12:00:00Z') }),
  ],
  (result) => {
    assert(result.status === 0, `timestamp-only drift should pass, got:\n${result.output}`);
    assert(
      result.output.includes('zip-entry-timestamp'),
      'expected zip-entry-timestamp category in report',
    );
  },
);

// Test 3 (metadata-only via tool metadata): runtime entries byte-identical, only
// vsce tool-metadata entry content differs → allowed `vsce-tool-metadata`.
await runFixture(
  'metadata-tool-drift',
  async (dir) => {
    const date = new Date('2020-01-01T00:00:00Z');
    const aEntries = [...RUNTIME_ENTRIES, ...META_ENTRIES];
    const bEntries = [
      ...RUNTIME_ENTRIES,
      { path: 'extension.vsixmanifest', content: '<?xml version="1.0"?><PackageManifest x="2"/>' },
      META_ENTRIES[1],
    ];
    return [
      await buildZip(dir, 'a', aEntries, { date }),
      await buildZip(dir, 'b', bEntries, { date }),
    ];
  },
  (result) => {
    assert(result.status === 0, `tool-metadata drift should pass, got:\n${result.output}`);
    assert(
      result.output.includes('vsce-tool-metadata'),
      'expected vsce-tool-metadata category in report',
    );
  },
);

// Test 2: runtime content drift → unexplained, must fail.
await runFixture(
  'content-drift',
  async (dir) => {
    const date = new Date('2020-01-01T00:00:00Z');
    const bEntries = ALL.map((e) =>
      e.path === 'extension/dist/extension.js'
        ? { ...e, content: 'module.exports = { changed: true };\n' }
        : e,
    );
    return [await buildZip(dir, 'a', ALL, { date }), await buildZip(dir, 'b', bEntries, { date })];
  },
  (result) => {
    assert(result.status === 1, 'runtime content drift must fail');
    assert(
      result.output.includes('[unexplained-content-drift]'),
      'expected unexplained-content-drift rule',
    );
  },
);

// Missing entry on one side is also unexplained drift.
await runFixture(
  'missing-entry-drift',
  async (dir) => {
    const date = new Date('2020-01-01T00:00:00Z');
    return [
      await buildZip(dir, 'a', ALL, { date }),
      await buildZip(dir, 'b', RUNTIME_ENTRIES, { date }),
    ];
  },
  (result) => {
    assert(result.status === 1, 'missing entry must fail');
    assert(
      result.output.includes('[unexplained-content-drift]'),
      'expected unexplained-content-drift rule',
    );
  },
);

// Reporting style: failure output must not echo matched entry content.
await runFixture(
  'reporting-style',
  async (dir) => {
    const date = new Date('2020-01-01T00:00:00Z');
    const secret = 'REPRO_SECRET_CONTENT_NEEDLE';
    const bEntries = ALL.map((e) =>
      e.path === 'extension/dist/extension.js' ? { ...e, content: `const k = "${secret}";\n` } : e,
    );
    return [await buildZip(dir, 'a', ALL, { date }), await buildZip(dir, 'b', bEntries, { date })];
  },
  (result) => {
    assert(result.status === 1, 'reporting-style fixture must fail');
    assert(
      !result.output.includes('REPRO_SECRET_CONTENT_NEEDLE'),
      'checker output must not echo entry content',
    );
  },
);

console.log('OK: check-vsix-reproducibility fixture suite passed.');
