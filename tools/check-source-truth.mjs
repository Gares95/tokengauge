// Blocking semantic source/bundle truth gate (17-G02).
//
// Contracts enforced (symbol-keyed, path-independent — a renamed file cannot
// evade the scan):
//   1. Dead bridge/observed-limit/accuracy/estimator architecture must not be
//      redeclared anywhere in src, and its symbols must be unreachable in the
//      production extension and webview bundles.
//   2. The removed 'estimated'/'log_derived' taxonomy values must not return
//      as quoted literals in src or bundles.
//   3. The B03 test seam must stay behind the ExtensionMode.Test guard: the
//      guard has to appear in the extension bundle BEFORE the first test
//      helper, and no test helper may appear in the webview bundle. (Static
//      textual proof; normal-mode runtime confirmation is H01 evidence.)
//   4. Privacy fixture sentinels must never leak into shipped bundles.
//
// False-positive controls: fixed identifier list with word boundaries; src
// scope only (tests/fixtures/tools are out of scope); reports rule + path
// only, never content. --src-root/--bundle-dir let the selftest run mutations
// against temporary copies.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : null;
}

const repoRoot = resolve(import.meta.dirname, '..');
const srcRoot = argValue('--src-root') ?? join(repoRoot, 'src');
const bundleDir = argValue('--bundle-dir') ?? join(repoRoot, 'dist');

const FORBIDDEN_SYMBOLS = [
  'compareAccuracy',
  'leastAccurate',
  'snapshotToObservedLimitSample',
  'BRIDGE_SOURCE_FINGERPRINT',
  'ObservedLimitSampleGuard',
  'ObservedLimitSampleSchema',
  'ObservedLimitEstimator',
  'CalibrationGuard',
  'extractCodexConfigFields',
];
const FORBIDDEN_MEMBER_PATTERNS = [/\bAccuracy\.combine\b/];
const FORBIDDEN_TAXONOMY_LITERALS = [/['"]estimated['"]/, /['"]log_derived['"]/];
const TEST_SEAM_HELPERS = [
  'refreshCockpitForTest',
  'codexProbeSpawnCountForTest',
  'resolveCockpitViewForTest',
];
const FIXTURE_SENTINELS = ['TG_RAW_SESSION_SHOULD_NOT_APPEAR', 'TG_RAW_CWD_SHOULD_NOT_APPEAR'];

const violations = [];
function fail(rule, file) {
  violations.push({ rule, file });
}

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// 1+2: semantic src scan.
if (existsSync(srcRoot) && statSync(srcRoot).isDirectory()) {
  for (const file of listSourceFiles(srcRoot)) {
    const rel = relative(repoRoot, file);
    const content = readFileSync(file, 'utf8');
    for (const symbol of FORBIDDEN_SYMBOLS) {
      const decl = new RegExp(
        `\\b(?:function|const|let|var|class|interface|type|enum)\\s+${symbol}\\b|\\b${symbol}\\s*[:=(]`,
      );
      if (decl.test(content)) {
        fail('dead-architecture-symbol', rel);
      }
    }
    for (const pattern of FORBIDDEN_MEMBER_PATTERNS) {
      if (pattern.test(content)) {
        fail('dead-architecture-symbol', rel);
      }
    }
    for (const pattern of FORBIDDEN_TAXONOMY_LITERALS) {
      if (pattern.test(content)) {
        fail('removed-taxonomy-literal', rel);
      }
    }
  }
} else {
  fail('missing-src-root', relative(repoRoot, srcRoot));
}

// 2+3+4: bundle reachability.
const extensionBundle = join(bundleDir, 'extension.js');
const webviewBundle = join(bundleDir, 'webview', 'cockpit.js');
for (const [bundle, label] of [
  [extensionBundle, 'dist/extension.js'],
  [webviewBundle, 'dist/webview/cockpit.js'],
]) {
  if (!existsSync(bundle)) {
    fail('missing-bundle', label);
    continue;
  }
  const content = readFileSync(bundle, 'utf8');
  for (const symbol of FORBIDDEN_SYMBOLS) {
    if (content.includes(symbol)) {
      fail('dead-architecture-in-bundle', label);
    }
  }
  for (const pattern of [...FORBIDDEN_MEMBER_PATTERNS, ...FORBIDDEN_TAXONOMY_LITERALS]) {
    if (pattern.test(content)) {
      fail('dead-architecture-in-bundle', label);
    }
  }
  for (const sentinel of FIXTURE_SENTINELS) {
    if (content.includes(sentinel)) {
      fail('fixture-sentinel-in-bundle', label);
    }
  }
}

// 3: seam guard order in the extension bundle; helpers absent from webview.
// The dev bundle keeps `extensionMode !== ...ExtensionMode.Test` with an early
// return; the production minifier inverts it to `=== ...ExtensionMode.Test`
// returning the API inside the test branch. Both forms satisfy the same
// invariant: the mode comparison must precede the first helper.
if (existsSync(extensionBundle)) {
  const content = readFileSync(extensionBundle, 'utf8');
  const guard = content.search(/extensionMode\s*[!=]==?\s*\w+(?:\.\w+)*\.ExtensionMode\.Test/);
  const helperOffsets = TEST_SEAM_HELPERS.map((h) => content.indexOf(h)).filter((i) => i !== -1);
  if (helperOffsets.length > 0) {
    const firstHelper = Math.min(...helperOffsets);
    if (guard === -1 || guard > firstHelper) {
      fail('test-seam-guard-order', 'dist/extension.js');
    }
  }
}
if (existsSync(webviewBundle)) {
  const content = readFileSync(webviewBundle, 'utf8');
  for (const helper of TEST_SEAM_HELPERS) {
    if (content.includes(helper)) {
      fail('test-helper-in-webview-bundle', 'dist/webview/cockpit.js');
    }
  }
}

if (violations.length > 0) {
  console.error('Source truth gate violations:');
  for (const { rule, file } of violations) {
    console.error(`  [${rule}] ${file}`);
  }
  process.exit(1);
}

console.log('OK: source truth gate passed');
