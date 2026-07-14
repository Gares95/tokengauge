// Mutation-negative selftest for the semantic source/bundle truth gate
// (17-G02). Runs the gate against temporary src/bundle fixtures; canonical
// files are never mutated.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const gateScript = path.join(repoRoot, 'tools/check-source-truth.mjs');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const sourceTruthScript = packageJson.scripts?.['check:source-truth'] ?? '';
const buildOffset = sourceTruthScript.indexOf('npm run build');
const gateOffset = sourceTruthScript.indexOf('node tools/check-source-truth.mjs');
assert(buildOffset !== -1, 'check:source-truth must build bundles before checking them');
assert(gateOffset !== -1, 'check:source-truth must run tools/check-source-truth.mjs');
assert(buildOffset < gateOffset, 'check:source-truth must build before the source-truth gate');

function cleanFixture(dir) {
  const src = path.join(dir, 'src');
  mkdirSync(path.join(src, 'core'), { recursive: true });
  writeFileSync(
    path.join(src, 'core', 'live.ts'),
    "export const ACCURACY_LABELS = ['proxy_reported', 'unknown'] as const;\n" +
      "export function accuracyFor(tier: string): string { return tier === 'unknown' ? 'unknown' : 'proxy_reported'; }\n",
  );
  const bundles = path.join(dir, 'bundles');
  mkdirSync(path.join(bundles, 'webview'), { recursive: true });
  writeFileSync(
    path.join(bundles, 'extension.js'),
    'function activate(context){if(context.extensionMode!==vscode.ExtensionMode.Test)return void 0;' +
      'return{refreshCockpitForTest(){},codexProbeSpawnCountForTest(){},resolveCockpitViewForTest(){}};}\n',
  );
  writeFileSync(path.join(bundles, 'webview', 'cockpit.js'), 'render("gauge cards");\n');
  return { src, bundles };
}

function runGate(dir) {
  const result = spawnSync(
    'node',
    [gateScript, '--src-root', path.join(dir, 'src'), '--bundle-dir', path.join(dir, 'bundles')],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function runCase(name, mutate, check) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `tokengauge-srctruth-${name}-`));
  try {
    const layout = cleanFixture(dir);
    if (mutate) {
      mutate(dir, layout);
    }
    check(runGate(dir));
    console.log(`OK: ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Clean fixture passes.
runCase('clean', null, (result) => {
  assert(result.status === 0, `clean fixture should pass, got:\n${result.output}`);
});

// A renamed file redeclaring a dead symbol fails (symbol-keyed, not path-keyed).
runCase(
  'renamed-dead-accuracy-symbol',
  (dir) => {
    writeFileSync(
      path.join(dir, 'src', 'core', 'freshness-helpers.ts'),
      'export function leastAccurate(a: string, b: string): string { return a < b ? a : b; }\n',
    );
  },
  (result) => {
    assert(result.status !== 0, 'redeclared leastAccurate should fail');
    assert(result.output.includes('dead-architecture-symbol'), 'expected dead-architecture-symbol');
  },
);

runCase(
  'accuracy-combine-member',
  (dir) => {
    writeFileSync(
      path.join(dir, 'src', 'core', 'agg.ts'),
      'export const combined = Accuracy.combine(a, b);\n',
    );
  },
  (result) => {
    assert(result.status !== 0, 'Accuracy.combine member use should fail');
    assert(result.output.includes('dead-architecture-symbol'), 'expected dead-architecture-symbol');
  },
);

runCase(
  'removed-taxonomy-literal',
  (dir) => {
    writeFileSync(path.join(dir, 'src', 'core', 'tiers.ts'), "export const TIER = 'estimated';\n");
  },
  (result) => {
    assert(result.status !== 0, 'quoted estimated literal should fail');
    assert(result.output.includes('removed-taxonomy-literal'), 'expected removed-taxonomy-literal');
  },
);

runCase(
  'dead-symbol-in-bundle',
  (dir) => {
    writeFileSync(
      path.join(dir, 'bundles', 'extension.js'),
      'function activate(context){if(context.extensionMode!==vscode.ExtensionMode.Test)return void 0;' +
        'return{refreshCockpitForTest(){}};}var CalibrationGuard={};\n',
    );
  },
  (result) => {
    assert(result.status !== 0, 'CalibrationGuard in bundle should fail');
    assert(
      result.output.includes('dead-architecture-in-bundle'),
      'expected dead-architecture-in-bundle',
    );
  },
);

runCase(
  'helper-before-guard',
  (dir) => {
    writeFileSync(
      path.join(dir, 'bundles', 'extension.js'),
      'function activate(context){return{refreshCockpitForTest(){}};}\n',
    );
  },
  (result) => {
    assert(result.status !== 0, 'helper reachable without test-mode guard should fail');
    assert(result.output.includes('test-seam-guard-order'), 'expected test-seam-guard-order');
  },
);

runCase(
  'fixture-sentinel-in-bundle',
  (dir) => {
    writeFileSync(
      path.join(dir, 'bundles', 'webview', 'cockpit.js'),
      'render("TG_RAW_SESSION_SHOULD_NOT_APPEAR");\n',
    );
  },
  (result) => {
    assert(result.status !== 0, 'fixture sentinel in bundle should fail');
    assert(
      result.output.includes('fixture-sentinel-in-bundle'),
      'expected fixture-sentinel-in-bundle',
    );
  },
);

runCase(
  'test-helper-in-webview',
  (dir) => {
    writeFileSync(
      path.join(dir, 'bundles', 'webview', 'cockpit.js'),
      'window.resolveCockpitViewForTest = () => {};\n',
    );
  },
  (result) => {
    assert(result.status !== 0, 'test helper in webview bundle should fail');
    assert(
      result.output.includes('test-helper-in-webview-bundle'),
      'expected test-helper-in-webview-bundle',
    );
  },
);

// The minified production form (inverted === guard, API returned inside the
// test branch) must also pass.
runCase(
  'minified-production-guard-form',
  (dir) => {
    writeFileSync(
      path.join(dir, 'bundles', 'extension.js'),
      'e.extensionMode===H.ExtensionMode.Test)return{refreshCockpitForTest:()=>{}}\n',
    );
  },
  (result) => {
    assert(result.status === 0, `minified guard form should pass, got:\n${result.output}`);
  },
);

// Legitimate internal terminology must NOT be flagged.
runCase(
  'legitimate-terms-pass',
  (dir) => {
    writeFileSync(
      path.join(dir, 'src', 'core', 'source-tier.ts'),
      "export type FieldClass = 'limit' | 'tokenDetail';\n" +
        '// cost + token detail tolerate a longer freshness age.\n',
    );
  },
  (result) => {
    assert(result.status === 0, `legitimate terms should pass, got:\n${result.output}`);
  },
);

console.log('OK: check-source-truth selftest passed.');
