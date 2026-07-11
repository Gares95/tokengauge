import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import archiver from 'archiver';

const repoRoot = path.resolve(import.meta.dirname, '..');
const auditScript = path.join(repoRoot, 'tools/audit-vsix.mjs');
const apiKey = 'sk-' + '1234567890' + 'abcdef' + '1234567890' + 'abcdef';
const localArtifactPath = 'extension/.' + 'plan' + 'ning/PROJECT.md';

const baseEntries = [
  {
    path: 'extension/package.json',
    content:
      '{"name":"x","version":"0.0.1","publisher":"p","engines":{"vscode":"^1.95.0"},"main":"./dist/extension.js","displayName":"x"}',
  },
  { path: 'extension/dist/extension.js', content: 'module.exports = {};\n' },
  {
    // The clean fixture's cockpit.js must carry the current copy
    // sentinels so the stale-asset gate passes on a current bundle.
    path: 'extension/dist/webview/cockpit.js',
    content:
      'globalThis.__cockpit = true;\n' +
      'const copy = ["Near limit","Welcome to TokenGauge","5-hour window"];\n',
  },
  {
    path: 'extension/dist/webview/assets/cockpit-def456.css',
    content: ':root { color: inherit; }\n',
  },
  {
    path: 'extension/resources/tokengauge-view.svg',
    content: '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  },
  { path: 'extension/README.md', content: '# x\n' },
  { path: 'extension/LICENSE', content: 'Apache-2.0 stub\n' },
  { path: 'extension/CHANGELOG.md', content: '# Changelog\n\n## Unreleased\n' },
  { path: 'extension.vsixmanifest', content: '<?xml version="1.0"?><PackageManifest/>' },
  { path: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
];

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

async function buildVsix(tempDir, name, entries) {
  const vsixPath = path.join(tempDir, `${name}.vsix`);
  const output = createWriteStream(vsixPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const done = new Promise((resolve, reject) => {
    output.on('close', () => resolve(vsixPath));
    output.on('error', reject);
    archive.on('error', reject);
  });

  archive.pipe(output);
  for (const entry of entries) {
    archive.append(entry.content, { name: entry.path });
  }
  await archive.finalize();
  return done;
}

function runAudit(vsixPath) {
  const result = spawnSync('node', [auditScript, vsixPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

async function runFixture(name, entries, check) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `tokengauge-${name}-`));
  try {
    const vsixPath = await buildVsix(tempDir, name, entries);
    const result = runAudit(vsixPath);
    check(result);
    console.log(`OK: ${name}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await runFixture('clean', baseEntries, (result) => {
  assert(result.status === 0, `clean fixture should pass, got:\n${result.output}`);
});

await runFixture(
  'local-artifact-leak',
  [...baseEntries, { path: localArtifactPath, content: 'local notes\n' }],
  (result) => {
    assert(result.status === 1, 'local artifact fixture should fail');
    assert(result.output.includes('[local-workspace-artifact]'), 'expected local artifact rule');
  },
);

await runFixture(
  'secret-leak',
  [...baseEntries, { path: 'extension/dist/leaked.js', content: `const k = "${apiKey}";\n` }],
  (result) => {
    assert(result.status === 1, 'secret fixture should fail');
    assert(result.output.includes('[openai-api-key]'), 'expected openai-api-key rule');
    assert(!result.output.includes(apiKey), 'audit output must not include the secret value');
  },
);

await runFixture(
  'dotenv-leak',
  [...baseEntries, { path: 'extension/.env', content: 'API_KEY=x\n' }],
  (result) => {
    assert(result.status === 1, 'dotenv fixture should fail');
    assert(result.output.includes('[dotenv]'), 'expected dotenv rule');
  },
);

await runFixture(
  'case-insensitive-readme',
  baseEntries.map((entry) =>
    entry.path === 'extension/README.md' ? { ...entry, path: 'extension/readme.md' } : entry,
  ),
  (result) => {
    assert(result.status === 0, `lowercase readme fixture should pass, got:\n${result.output}`);
  },
);

await runFixture(
  'reporting-style',
  [...baseEntries, { path: 'extension/dist/key.js', content: `const k = "${apiKey}";\n` }],
  (result) => {
    assert(result.status === 1, 'reporting-style fixture should fail');
    assert(!result.output.includes(apiKey), 'audit output must not include the secret value');
    for (const slice of longSlices(apiKey)) {
      assert(
        !result.output.includes(slice),
        'audit output must not include long secret substrings',
      );
    }
  },
);

// A packaged cockpit.js that ships STALE assets
// (missing the current copy sentinels) must fail the audit, so a future package
// can never silently regress to an older cockpit copy. Output reports the
// missing-sentinel COUNT only — never the matched copy.
await runFixture(
  'stale-cockpit-copy',
  baseEntries.map((entry) =>
    entry.path === 'extension/dist/webview/cockpit.js'
      ? { ...entry, content: 'globalThis.__cockpit = true;\n/* stale legacy bundle */\n' }
      : entry,
  ),
  (result) => {
    assert(result.status === 1, 'stale cockpit copy fixture should fail');
    assert(
      result.output.includes('[stale-cockpit-copy-sentinels]'),
      'expected stale-cockpit-copy-sentinels rule',
    );
    // Counts-only: the audit must not dump the sentinel copy itself.
    assert(
      !result.output.includes('Welcome to TokenGauge'),
      'audit output must not dump the sentinel copy',
    );
    assert(result.output.includes('missing 3/3 sentinels'), 'expected the missing-sentinel count');
  },
);

await runFixture(
  'missing-cockpit-bundle',
  baseEntries.filter((entry) => entry.path !== 'extension/dist/webview/cockpit.js'),
  (result) => {
    assert(result.status === 1, 'missing cockpit bundle fixture should fail');
    // A wholly absent cockpit.js trips the content gate's missing-target rule too.
    assert(
      result.output.includes('[missing-cockpit-copy-sentinels]'),
      'expected missing-cockpit-copy-sentinels rule',
    );
  },
);

console.log('OK: audit-vsix fixture suite passed.');
