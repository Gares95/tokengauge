import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const gateScript = path.join(repoRoot, 'tools/check-release-docs.mjs');
const pkgVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// A clean, passing set of release docs. Phrases mirror the real repo docs the
// gate enforces; the version is read from the real package.json.
function cleanDocs() {
  return {
    'package.json': JSON.stringify({ version: pkgVersion }),
    'README.md':
      '# TokenGauge\n\nGitHub Release first distribution. Native multi-agent gauge cockpit for Codex and Claude. ' +
      'no developer-controlled telemetry and no default outbound network. accuracy labeled.\n\n' +
      'TokenGauge is a native multi-agent gauge cockpit. It is native-first and ' +
      'does not scan your conversation logs by default.\n\n' +
      '## Quick start\n\nRun TokenGauge: Configure Cockpit. Set ' +
      'tokenGauge.claude.statuslineSnapshotPath to a per-session snapshot directory or ' +
      'single snapshot file. Create the writer with a TOKENGAUGE_STATUSLINE here-doc. ' +
      '#### WSL, Linux, macOS, or Git Bash\n' +
      'Use this block in Bash-like shells only. It is not PowerShell syntax. ' +
      'Run node --version first. TokenGauge does not install Node or Claude Code. ' +
      "mkdir -p ~/.tokengauge/claude\ncat > ~/.tokengauge/claude/claude-statusline-writer.mjs <<'TOKENGAUGE_STATUSLINE'\n" +
      'TOKENGAUGE_STATUSLINE\nrealpath ~/.tokengauge/claude/claude-statusline-writer.mjs\n' +
      '#### PowerShell\n' +
      "$writer = Join-Path $HOME '.tokengauge\\claude\\claude-statusline-writer.mjs'\n" +
      "@'\nwriter\n'@ | Set-Content -Path $writer -Encoding utf8\n" +
      'node --check $writer\n(Resolve-Path $writer).Path\n' +
      'If you intentionally keep a custom shell writer instead. ' +
      'Create claude-statusline-writer.mjs and validate it with node --check. ' +
      'Print the absolute writer path with realpath ~/.tokengauge/claude/claude-statusline-writer.mjs. ' +
      'No `jq`, `sha256sum`, `chmod`, or `sed` step is needed. ' +
      'Do not run bare `/statusline` for TokenGauge setup. ' +
      'Claude statusLine.command points to the writer script, but TokenGauge points to the snapshot output, not the writer script. ' +
      'If the snapshot file exists but the Claude card still shows no gauge, check statusline_snapshot_missing_rate_limits. ' +
      'That means TokenGauge read the snapshot, but Claude did not report limit fields. This is not a path problem. TokenGauge will not guess a usage window. ' +
      'Run claude auth status and claude doctor locally. Do not paste raw auth output in public issues. TokenGauge shows a gauge as soon as Claude Code reports fields. ' +
      'Use the absolute writer path printed by `realpath` or `Resolve-Path`. Merge it into the existing JSON object; do not delete unrelated settings. ' +
      'node C:/Users/YOUR_USER/.tokengauge/claude/claude-statusline-writer.mjs. C:/Users/YOUR_USER/.tokengauge/claude/statusline-snapshot.json. ' +
      'The Configure snapshot path button opens this exact setting. ' +
      'In remote windows use Remote settings or Workspace settings; Local User settings may not affect that window. ' +
      'Claude Code must already run in the same environment. If `claude` does not start, fix Claude Code first. ' +
      'Same-host setup is preferred. Cross-host paths can work but are not the recommended setup. ' +
      'Opt in to tokenGauge.providers.codex.nativeStatusProbe only when wanted and keep the Codex card visible for probes. ' +
      'Use tokenGauge.display.cards.claude.visible and tokenGauge.display.cards.codex.visible for card visibility. ' +
      'When both are hidden, the cockpit shows No cards visible.\n',
    'PRIVACY.md':
      'SecretStorage caveats. Local install salt is a non-credential value. ' +
      'TokenGauge does not clear SecretStorage on uninstall. no outbound network by default.\n',
    'SECURITY.md':
      'Release Workflow Posture. Tag-only trigger. GitHub Environment approval. ' +
      'Optional Marketplace and Open VSX paths via Personal Access Token secrets. ' +
      'No OIDC claim; publishing is PAT-gated.\n',
    'CONTRIBUTING.md': 'npm run lint, npm run typecheck, npm run test, npm run check.\n',
    'ACCURACY.md':
      'Labels: exact, billing_authoritative, proxy_reported, ' +
      'partial, unknown. The cost unknown contract.\n\n' +
      '## Native limitations\n' +
      'No public Anthropic tokenizer. Cache 5m/1h collapse. Missing native data ' +
      'reads unavailable.\n',
    'CHANGELOG.md': `# Changelog\n\n## ${pkgVersion}\n\nMVP release.\n`,
    LICENSE: 'Apache-2.0 stub\n',
  };
}

function writeFixture(dir, docs) {
  for (const [name, content] of Object.entries(docs)) {
    writeFileSync(path.join(dir, name), content);
  }
}

function runGate(root) {
  const result = spawnSync('node', [gateScript, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function runFixture(name, mutate, check) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `tokengauge-reldocs-${name}-`));
  try {
    const docs = cleanDocs();
    if (mutate) {
      mutate(docs);
    }
    writeFixture(dir, docs);
    check(runGate(dir), docs);
    console.log(`OK: ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Test 1: clean docs fixture exits 0 with the success line.
runFixture('clean', null, (result) => {
  assert(result.status === 0, `clean fixture should pass, got:\n${result.output}`);
  assert(
    result.output.includes('OK: release docs gate passed'),
    'clean fixture should print the success line',
  );
});

// Test 2: missing a required doc exits nonzero with the rule name only.
for (const doc of ['PRIVACY.md', 'CONTRIBUTING.md', 'ACCURACY.md']) {
  runFixture(
    `missing-${doc}`,
    (docs) => {
      delete docs[doc];
    },
    (result) => {
      assert(result.status !== 0, `missing ${doc} should fail`);
      assert(result.output.includes('missing-doc'), `expected missing-doc rule for ${doc}`);
    },
  );
}

// Test 2b: the native-caveats gate. Positive: the clean fixture already carries
// the native limitations and passes (covered by Test 1). Negative: stripping the
// native limitations from ACCURACY.md fails with the missing-native-caveats rule
// and never leaks the doc body.
runFixture(
  'missing-native-caveats',
  (docs) => {
    docs['ACCURACY.md'] =
      'Labels: exact, billing_authoritative, proxy_reported, ' +
      'partial, unknown. The cost unknown contract.\n';
  },
  (result) => {
    assert(result.status !== 0, 'missing native-caveats section should fail');
    assert(
      result.output.includes('missing-native-caveats'),
      'expected missing-native-caveats rule',
    );
  },
);

// Test 2c: the native-first gate. Positive: the clean fixture
// carries the native-cockpit-primary marker and passes (covered by Test 1).
// Negative A: dropping the native-cockpit marker fails with not-native-first.
runFixture(
  'not-native-first-missing-marker',
  (docs) => {
    docs['README.md'] =
      '# TokenGauge\n\nGitHub Release first distribution. Native multi-agent gauge cockpit. ' +
      'no developer-controlled telemetry and no default outbound network. accuracy labeled.\n';
  },
  (result) => {
    assert(result.status !== 0, 'README missing native-cockpit marker should fail');
    assert(result.output.includes('not-native-first'), 'expected not-native-first rule');
  },
);

// Negative B: stale log-derived-as-primary framing fails even if the marker is present.
runFixture(
  'not-native-first-stale-framing',
  (docs) => {
    docs['README.md'] =
      `${docs['README.md']}\nReads local AI-agent logs and optional local tooling output.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'README with stale log-first framing should fail');
    assert(result.output.includes('not-native-first'), 'expected not-native-first rule');
  },
);

// Test 2d: setup guidance must remain discoverable in README without dumping
// the docs body on failure.
runFixture(
  'missing-setup-guidance',
  (docs) => {
    docs['README.md'] = docs['README.md'].replace('TokenGauge: Configure Cockpit', 'settings');
  },
  (result) => {
    assert(result.status !== 0, 'README missing setup guidance should fail');
    assert(result.output.includes('missing-setup-guidance'), 'expected setup guidance rule');
    assert(
      !result.output.includes('per-session snapshot directory'),
      'gate output must not echo docs',
    );
  },
);

runFixture(
  'powershell-bash-syntax-leak',
  (docs) => {
    docs['README.md'] = docs['README.md'].replace(
      'node --check $writer\n(Resolve-Path $writer).Path\n',
      'node --check $writer\nrealpath ~/.tokengauge/claude/claude-statusline-writer.mjs\n',
    );
  },
  (result) => {
    assert(result.status !== 0, 'PowerShell section with Bash realpath should fail');
    assert(
      result.output.includes('powershell-bash-syntax-leak'),
      'expected PowerShell syntax leak rule',
    );
  },
);

runFixture(
  'automatic-claude-settings-edit',
  (docs) => {
    docs['README.md'] =
      `${docs['README.md']}\nSet-Content -Path ~/.claude/settings.json automatically.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'automatic Claude settings edit should fail');
    assert(
      result.output.includes('automatic-claude-settings-edit'),
      'expected automatic Claude settings edit rule',
    );
  },
);

// Test 2e: the stale-removed-subsystem gate. Re-marketing a removed
// subsystem (here a JSONL usage store) as a current capability in README/PRIVACY
// fails, without leaking the doc body.
runFixture(
  'stale-removed-subsystem',
  (docs) => {
    docs['PRIVACY.md'] =
      `${docs['PRIVACY.md']}\nUsage metadata is written to a local JSONL store.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'PRIVACY re-marketing a JSONL usage store should fail');
    assert(
      result.output.includes('stale-removed-subsystem'),
      'expected stale-removed-subsystem rule',
    );
  },
);

// Test 2f: the stale-removed-secret-command gate (PR #19). README/PRIVACY must not
// point users at the removed install-salt deletion command or the dead "focused
// secret commands" pointer.
runFixture(
  'stale-removed-secret-command',
  (docs) => {
    docs['README.md'] =
      `${docs['README.md']}\nSecrets are never stored in settings. Use the focused secret commands instead.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'README pointing at removed secret commands should fail');
    assert(
      result.output.includes('stale-removed-secret-command'),
      'expected stale-removed-secret-command rule',
    );
  },
);

// Test 3: missing the package version in CHANGELOG.md exits nonzero.
runFixture(
  'missing-changelog-version',
  (docs) => {
    docs['CHANGELOG.md'] = '# Changelog\n\n## Unreleased\n';
  },
  (result) => {
    assert(result.status !== 0, 'missing changelog version should fail');
    assert(
      result.output.includes('missing-changelog-version'),
      'expected missing-changelog-version rule',
    );
  },
);

// Test 4: an OIDC Marketplace publishing claim fails unless the doc explicitly
// disclaims OIDC-based Marketplace publishing.
runFixture(
  'dishonest-oidc-claim',
  (docs) => {
    docs['SECURITY.md'] =
      'Release Workflow Posture. Tag-only trigger. GitHub Environment approval. ' +
      'Optional Marketplace and Open VSX paths via Personal Access Token secrets. ' +
      'We use OIDC publishing to the Marketplace automatically.\n';
  },
  (result) => {
    assert(result.status !== 0, 'dishonest OIDC claim should fail');
    assert(
      result.output.includes('dishonest-marketplace-oidc-claim'),
      'expected dishonest-marketplace-oidc-claim rule',
    );
  },
);

// Test 4b: a doc that mentions OIDC near Marketplace but explicitly disclaims it passes.
runFixture('honest-oidc-disclaimer', null, (result) => {
  assert(result.status === 0, `honest OIDC disclaimer should pass, got:\n${result.output}`);
});

// Test 4c: failure output never echoes matched document content.
runFixture(
  'no-content-leak',
  (docs) => {
    docs['PRIVACY.md'] = 'SENTINEL_PRIVATE_DOC_BODY_DO_NOT_PRINT\n';
  },
  (result) => {
    assert(result.status !== 0, 'broken privacy doc should fail');
    assert(
      !result.output.includes('SENTINEL_PRIVATE_DOC_BODY_DO_NOT_PRINT'),
      'gate output must not echo matched document content',
    );
  },
);

// Test 5: package.json exposes check:release-docs and npm run check invokes it
// before tests. This is asserted against the real repo package.json.
{
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert(
    pkg.scripts['check:release-docs'] === 'node tools/check-release-docs.mjs',
    'package.json must expose check:release-docs',
  );
  const checkScript = pkg.scripts.check;
  assert(
    checkScript.includes('npm run check:release-docs'),
    'npm run check must invoke check:release-docs',
  );
  const docsIdx = checkScript.indexOf('npm run check:release-docs');
  const testIdx = checkScript.indexOf('npm test');
  assert(
    docsIdx !== -1 && testIdx !== -1 && docsIdx < testIdx,
    'check:release-docs must run before npm test in npm run check',
  );
  console.log('OK: package.json wiring');
}

console.log('OK: check-release-docs fixture suite passed.');
