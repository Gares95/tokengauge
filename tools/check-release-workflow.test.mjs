// Fixture-based regression suite for the release-workflow static gate.
//
// Mirrors tools/audit-vsix.test.mjs and tools/check-release-docs.test.mjs:
// writes temp release workflow fixtures, runs the gate via --file injection,
// and asserts pass/fail plus rule-name-only reporting (never matched content).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const gateScript = path.join(repoRoot, 'tools/check-release-workflow.mjs');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runGate(filePath) {
  const result = spawnSync('node', [gateScript, '--file', filePath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function runFixture(name, content, check) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `tokengauge-${name}-`));
  try {
    const filePath = path.join(tempDir, 'release.yml');
    writeFileSync(filePath, content, 'utf8');
    check(runGate(filePath));
    console.log(`OK: ${name}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Deferred-release-mode fixtures: build a temp repo root (no release.yml at
// the default path) with the given workflow files, then run the gate with
// --root so it evaluates the deferred posture.
function runRootFixture(name, workflowFiles, check) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), `tokengauge-${name}-`));
  try {
    for (const [relPath, content] of Object.entries(workflowFiles)) {
      const filePath = path.join(tempRoot, relPath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf8');
    }
    const result = spawnSync('node', [gateScript, '--root', tempRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    check({ status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` });
    console.log(`OK: ${name}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const VERIFY_ONLY = `name: Verify

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4.2.2
      - run: npm ci
      - run: npm run check
`;

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

// A workflow that satisfies every rule. Used as the baseline; individual
// fixtures mutate it to trip a single rule at a time.
const GOOD = `name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read

jobs:
  build-and-verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - uses: actions/setup-node@${SHA2}
        with:
          node-version: '22'
  create-github-release:
    needs: build-and-verify
    runs-on: ubuntu-latest
    environment: tokengauge-release
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@${SHA}
      - name: Create release
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" tokengauge-vscode-*.vsix
      - name: Upload sha
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: gh release upload "$GITHUB_REF_NAME" SHA256SUMS.txt
  publish-marketplace:
    needs: create-github-release
    if: vars.TOKENGAUGE_ENABLE_MARKETPLACE_PUBLISH == 'true'
    runs-on: ubuntu-latest
    environment: tokengauge-release
    steps:
      - name: Publish
        env:
          VSCE_PAT: \${{ secrets.VSCE_PAT }}
        run: npx @vscode/vsce publish
  publish-open-vsx:
    needs: create-github-release
    if: vars.TOKENGAUGE_ENABLE_OPEN_VSX_PUBLISH == 'true'
    runs-on: ubuntu-latest
    environment: tokengauge-release
    steps:
      - name: Publish
        env:
          OVSX_PAT: \${{ secrets.OVSX_PAT }}
        run: npx ovsx publish
`;

// Baseline passes.
runFixture('good', GOOD, (result) => {
  assert(result.status === 0, `good fixture should pass, got:\n${result.output}`);
});

// Test 1: must trigger only on v* tags, with no pull_request trigger.
runFixture(
  'pull-request-trigger',
  GOOD.replace('on:\n  push:', 'on:\n  pull_request:\n  push:'),
  (result) => {
    assert(result.status === 1, 'pull_request trigger should fail');
    assert(result.output.includes('[trigger-not-tag-only]'), 'expected trigger-not-tag-only rule');
  },
);

runFixture(
  'missing-tag-trigger',
  GOOD.replace("    tags:\n      - 'v*'", '    branches:\n      - main'),
  (result) => {
    assert(result.status === 1, 'missing v* tag trigger should fail');
    assert(result.output.includes('[trigger-not-tag-only]'), 'expected trigger-not-tag-only rule');
  },
);

// Test 2: workflow permissions contents: read; no id-token: write anywhere.
runFixture(
  'workflow-permissions-write',
  GOOD.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
  (result) => {
    assert(result.status === 1, 'workflow-level contents: write should fail');
    assert(
      result.output.includes('[workflow-permissions-not-read]'),
      'expected workflow-permissions-not-read rule',
    );
  },
);

runFixture('id-token-write', GOOD.replace('contents: write', 'id-token: write'), (result) => {
  assert(result.status === 1, 'id-token: write should fail');
  assert(result.output.includes('[id-token-write-forbidden]'), 'expected id-token rule');
});

// Test 3: every uses: must be a full-length 40-hex SHA.
runFixture('mutable-action-ref', GOOD.replace(`@${SHA}`, '@v4'), (result) => {
  assert(result.status === 1, 'mutable @v4 ref should fail');
  assert(result.output.includes('[action-not-sha-pinned]'), 'expected action-not-sha-pinned rule');
});

// Test 4: release asset job must use environment tokengauge-release.
runFixture(
  'release-job-no-environment',
  GOOD.replace('    environment: tokengauge-release\n    permissions:', '    permissions:'),
  (result) => {
    assert(result.status === 1, 'release job without environment should fail');
    assert(
      result.output.includes('[release-job-missing-environment]'),
      'expected release-job-missing-environment rule',
    );
  },
);

// Test 5: optional publish jobs must be gated by explicit vars + use env.
runFixture(
  'marketplace-not-var-gated',
  GOOD.replace("    if: vars.TOKENGAUGE_ENABLE_MARKETPLACE_PUBLISH == 'true'\n", ''),
  (result) => {
    assert(result.status === 1, 'marketplace publish without var gate should fail');
    assert(
      result.output.includes('[publish-job-not-opt-in-gated]'),
      'expected publish-job-not-opt-in-gated rule',
    );
  },
);

// Test 6: every gh release create/upload step must bind GH_TOKEN/GITHUB_TOKEN.
runFixture(
  'gh-release-missing-token',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions ${{ }} expression literal, not a JS template.
  GOOD.replace('        env:\n          GH_TOKEN: ${{ github.token }}\n', ''),
  (result) => {
    assert(result.status === 1, 'gh release step without token binding should fail');
    assert(
      result.output.includes('[gh-release-missing-github-token]'),
      'expected gh-release-missing-github-token rule',
    );
  },
);

// Reporting style: failures never echo matched workflow content (only rule
// names and the relative file path).
runFixture('reporting-style', GOOD.replace(`@${SHA}`, '@main'), (result) => {
  assert(result.status === 1, 'reporting-style fixture should fail');
  assert(!result.output.includes('actions/checkout'), 'gate output must not echo matched content');
  assert(!result.output.includes('@main'), 'gate output must not echo the mutable ref');
});

// Test 7: a workflow named explicitly via --file must exist — deferred-release
// mode never applies to an explicit target.
{
  const missing = path.join(os.tmpdir(), 'tokengauge-nonexistent', 'release.yml');
  const result = runGate(missing);
  assert(result.status === 1, 'explicit --file at a missing path should fail');
  assert(
    result.output.includes('[missing-release-workflow]'),
    'expected missing-release-workflow rule',
  );
  console.log('OK: explicit-file-missing');
}

// Test 8: deferred-release mode passes when a verify-only workflow exists and
// no workflow can publish.
runRootFixture(
  'deferred-verify-only',
  { '.github/workflows/verify.yml': VERIFY_ONLY },
  (result) => {
    assert(result.status === 0, `deferred verify-only root should pass, got:\n${result.output}`);
    assert(result.output.includes('deferred'), 'expected deferred-mode OK message');
  },
);

// Test 9: deferred-release mode fails when there is no CI workflow at all.
runRootFixture('deferred-no-workflows', {}, (result) => {
  assert(result.status === 1, 'root without any workflow should fail');
  assert(result.output.includes('[missing-verify-workflow]'), 'expected missing-verify-workflow');
});

// Test 10: deferred-release mode fails when any workflow contains a
// publish-capable step (each marker individually).
for (const [label, line] of [
  ['vsce-publish', '      - run: npx @vscode/vsce publish'],
  ['ovsx-publish', '      - run: npx ovsx publish'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions ${{ }} expression literal, not a JS template.
  ['vsce-pat', '      - run: echo\n        env:\n          VSCE_PAT: ${{ secrets.VSCE_PAT }}'],
  ['gh-release', '      - run: gh release create "$GITHUB_REF_NAME"'],
  ['id-token', '    permissions:\n      id-token: write'],
]) {
  runRootFixture(
    `deferred-publish-capable-${label}`,
    { '.github/workflows/verify.yml': `${VERIFY_ONLY}${line}\n` },
    (result) => {
      assert(result.status === 1, `publish-capable marker ${label} should fail deferred mode`);
      assert(
        result.output.includes('[publish-capable-workflow-without-release-gate]'),
        'expected publish-capable-workflow-without-release-gate rule',
      );
    },
  );
}

// Test 11: whole-line comments naming forbidden patterns never trip the
// deferred-mode scan (same comment-strip semantics as the strict gate).
runRootFixture(
  'deferred-comment-mentions-publish',
  {
    '.github/workflows/verify.yml': `# This verify-only workflow deliberately has no vsce publish, ovsx publish,\n# VSCE_PAT, OVSX_PAT, gh release create, or id-token: write steps.\n${VERIFY_ONLY}`,
  },
  (result) => {
    assert(result.status === 0, `commented mentions should not trip the scan:\n${result.output}`);
  },
);

console.log('OK: check-release-workflow fixture suite passed.');
