// Blocking release-docs gate.
//
// Validates that required release docs exist and state the locked privacy,
// accuracy, and distribution posture. On failure the tool reports rule names
// and relative paths ONLY — never matched document content.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const rootArgIndex = process.argv.indexOf('--root');
const root =
  rootArgIndex !== -1 && process.argv[rootArgIndex + 1]
    ? resolve(process.argv[rootArgIndex + 1])
    : resolve(import.meta.dirname, '..');

const REQUIRED_DOCS = [
  'README.md',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'ACCURACY.md',
  'CHANGELOG.md',
  'LICENSE',
];

const violations = [];

function fail(rule, file) {
  violations.push({ rule, file: relative(root, join(root, file)) || file });
}

function read(file) {
  const full = join(root, file);
  if (!existsSync(full)) {
    return null;
  }
  return readFileSync(full, 'utf8');
}

// missing-doc: every required release doc must exist.
const docs = {};
for (const file of REQUIRED_DOCS) {
  const content = read(file);
  if (content === null) {
    fail('missing-doc', file);
    continue;
  }
  docs[file] = content;
}

function requirePhrases(file, phrases, rule) {
  const content = docs[file];
  if (content === undefined) {
    return;
  }
  const lower = content.toLowerCase();
  for (const phrase of phrases) {
    if (!lower.includes(phrase.toLowerCase())) {
      fail(rule, file);
      return;
    }
  }
}

// forbidPhrases: fail if a marketing doc reintroduces a phrase from a removed
// subsystem as a current capability. The phrases are chosen to be unambiguous
// positive-capability markers that never appear in the native-only negative
// statements ("no usage store", "does not reconstruct …"), so this does not ban
// generic words like "log" (changelog) or honest "no usage store" copy.
function forbidPhrases(file, phrases, rule) {
  const content = docs[file];
  if (content === undefined) {
    return;
  }
  const lower = content.toLowerCase();
  for (const phrase of phrases) {
    if (lower.includes(phrase.toLowerCase())) {
      fail(rule, file);
      return;
    }
  }
}

function sectionBetween(file, startPhrase, endPhrase) {
  const content = docs[file];
  if (content === undefined) {
    return '';
  }
  const start = content.indexOf(startPhrase);
  if (start === -1) {
    return '';
  }
  const afterStart = start + startPhrase.length;
  const end = content.indexOf(endPhrase, afterStart);
  return end === -1 ? content.slice(afterStart) : content.slice(afterStart, end);
}

// missing-changelog-version: CHANGELOG must name the current package version.
if (docs['CHANGELOG.md'] !== undefined) {
  let version = null;
  const pkg = read('package.json');
  if (pkg) {
    try {
      version = JSON.parse(pkg).version;
    } catch {
      version = null;
    }
  }
  if (!version || !docs['CHANGELOG.md'].includes(version)) {
    fail('missing-changelog-version', 'CHANGELOG.md');
  }
}

// missing-release-posture: README must state GitHub Release first, MVP sources,
// no telemetry, no default outbound network, and accuracy labeling.
requirePhrases(
  'README.md',
  [
    'github release',
    'codex',
    'native multi-agent gauge cockpit',
    'no developer-controlled telemetry',
    'no default outbound network',
    'accuracy',
  ],
  'missing-release-posture',
);

// not-native-first: README must lead native-cockpit-first. The
// packaged README renders as the installed Extension Details page; after Phase
// 8/8.5 the native cockpit is the product and log-derived ingestion is advanced/
// optional and off by default. Require an affirmative native-cockpit-primary
// marker, and forbid the stale framing that presented log scanning as the main
// product. Reports rule + path only, never matched content.
{
  const content = docs['README.md'];
  if (content !== undefined) {
    // Collapse runs of whitespace (incl. line wraps) so a marker phrase that
    // spans two wrapped lines still matches — Markdown soft-wraps are not
    // semantic.
    const lower = content.toLowerCase().replace(/\s+/g, ' ');
    const hasNativeCockpitPrimary =
      lower.includes('native multi-agent gauge cockpit') &&
      lower.includes('native-first') &&
      lower.includes('does not scan your conversation logs by default');
    if (!hasNativeCockpitPrimary) {
      fail('not-native-first', 'README.md');
    }
    // Stale log-derived-as-primary framing that this gate exists to keep out.
    const STALE_LOG_FIRST = [
      'reads local ai-agent logs and optional local tooling output',
      'supported mvp sources',
    ];
    for (const stale of STALE_LOG_FIRST) {
      if (lower.includes(stale)) {
        fail('not-native-first', 'README.md');
        break;
      }
    }
  }
}

// missing-setup-guidance: setup docs must keep the native setup path
// discoverable from the README without claiming default probing or log parsing.
requirePhrases(
  'README.md',
  [
    'TokenGauge: Configure Cockpit',
    'tokenGauge.claude.statuslineSnapshotPath',
    'per-session snapshot directory',
    'single snapshot file',
    'TOKENGAUGE_STATUSLINE',
    'claude-statusline-writer.mjs',
    '#### WSL, Linux, macOS, or Git Bash',
    'Use this block in Bash-like shells only. It is not PowerShell syntax.',
    'node --version',
    'TokenGauge does not install Node or Claude Code',
    '#### PowerShell',
    'Set-Content -Path $writer -Encoding utf8',
    'node --check',
    'node --check $writer',
    '(Resolve-Path $writer).Path',
    'realpath ~/.tokengauge/claude/claude-statusline-writer.mjs',
    'No `jq`, `sha256sum`, `chmod`, or `sed` step is needed',
    'statusLine.command',
    'node C:/Users/YOUR_USER/.tokengauge/claude/claude-statusline-writer.mjs',
    'C:/Users/YOUR_USER/.tokengauge/claude/statusline-snapshot.json',
    'do not run bare `/statusline`',
    'not the writer script',
    'statusline_snapshot_missing_rate_limits',
    'snapshot file exists but the Claude card still shows no gauge',
    'not a path problem',
    'will not guess a usage window',
    'claude auth status',
    'claude doctor',
    'Do not paste raw auth output',
    'as soon as Claude Code reports',
    'Use the absolute writer path',
    '`Resolve-Path`',
    'Merge it into the existing JSON object; do not',
    'Remote settings',
    'Local User settings',
    'Configure snapshot path',
    'Claude Code must already run in the same environment',
    'fix Claude Code first',
    'Same-host setup is preferred',
    'Cross-host paths',
    'not the recommended',
    'tokenGauge.providers.codex.nativeStatusProbe',
    'tokenGauge.display.cards.claude.visible',
    'tokenGauge.display.cards.codex.visible',
    'No cards visible',
  ],
  'missing-setup-guidance',
);

forbidPhrases(
  'README.md',
  [
    'CLAUDE_CODE_GIT_BASH_PATH',
    '[Environment]::SetEnvironmentVariable',
    'C:\\Windows\\System32\\bash.exe',
    '\\\\wsl.localhost\\Ubuntu\\home\\YOUR_USER',
  ],
  'over-detailed-windows-setup',
);

{
  const bashBlock = sectionBetween(
    'README.md',
    '#### WSL, Linux, macOS, or Git Bash',
    '#### PowerShell',
  );
  if (
    !bashBlock.includes(
      "cat > ~/.tokengauge/claude/claude-statusline-writer.mjs <<'TOKENGAUGE_STATUSLINE'",
    ) ||
    !bashBlock.includes('mkdir -p ~/.tokengauge/claude') ||
    !bashBlock.includes('realpath ~/.tokengauge/claude/claude-statusline-writer.mjs')
  ) {
    fail('missing-bash-writer-setup', 'README.md');
  }

  const powerShellBlock = sectionBetween(
    'README.md',
    '#### PowerShell',
    'If you intentionally keep a custom shell writer instead',
  );
  if (
    !powerShellBlock.includes('$writer = Join-Path $HOME') ||
    !powerShellBlock.includes("@'") ||
    !powerShellBlock.includes("'@ | Set-Content -Path $writer -Encoding utf8") ||
    !powerShellBlock.includes('node --check $writer') ||
    !powerShellBlock.includes('(Resolve-Path $writer).Path')
  ) {
    fail('missing-powershell-writer-setup', 'README.md');
  }
  for (const stale of [
    "cat > ~/.tokengauge/claude/claude-statusline-writer.mjs <<'TOKENGAUGE_STATUSLINE'",
    'mkdir -p',
    'realpath ',
    'node --check ~',
  ]) {
    if (powerShellBlock.includes(stale)) {
      fail('powershell-bash-syntax-leak', 'README.md');
      break;
    }
  }
}

forbidPhrases(
  'README.md',
  [
    'Set-Content -Path ~/.claude',
    'Set-Content -Path "$HOME\\.claude',
    'automatically edit `~/.claude/settings.json`',
  ],
  'automatic-claude-settings-edit',
);

// stale-removed-subsystem: README and PRIVACY must not re-market a removed
// subsystem (log ingestion, JSONL usage store, cost/tokenizer engine, synthetic
// estimator, threshold notifications) as a current native-only capability. The
// phrases are unambiguous positive markers — they do not appear in the honest
// negative statements (e.g. "no usage store", "does not reconstruct") — so this
// keeps the native-only story from silently regressing.
const STALE_REMOVED_SUBSYSTEM = [
  'jsonl',
  'usage exports are available',
  'cost engine',
  'estimator',
  // Stale log-reading / non-native screenshot wording must not return.
  'unknown log formats',
  'synthetic/manual',
  // R2: v1 has no API-key feature and no provider/proxy endpoint config. These are
  // the stale POSITIVE claims (the honest negatives — "does not ask for API keys",
  // "makes no outbound network calls" — never contain these substrings).
  'api keys live only',
  'provider/proxy apis you configure directly',
  'provider or proxy endpoint',
];
for (const file of ['README.md', 'PRIVACY.md']) {
  forbidPhrases(file, STALE_REMOVED_SUBSYSTEM, 'stale-removed-subsystem');
}

// stale-removed-secret-command: the public install-salt deletion command and the
// older "Delete Stored Secrets" command were removed (PR #19). The user-facing
// docs must not point at a removed command or the dead "focused secret commands"
// pointer. These are unambiguous removed-surface phrases — they never appear in
// the honest current copy ("no API keys", "the install salt is a non-credential
// value"), so this does not ban the legitimate "install salt" / "SecretStorage"
// wording.
const REMOVED_SECRET_COMMANDS = [
  'focused secret commands',
  'delete stored secrets',
  'clear local install salt',
];
for (const file of ['README.md', 'PRIVACY.md']) {
  forbidPhrases(file, REMOVED_SECRET_COMMANDS, 'stale-removed-secret-command');
}

// missing-privacy-caveat: PRIVACY must state SecretStorage caveats and posture.
requirePhrases(
  'PRIVACY.md',
  [
    'secretstorage',
    // R3-copy: the public salt-deletion command was removed; PRIVACY must still
    // document the local non-credential install salt honestly (no user-managed
    // "delete stored secrets" command anymore).
    'install salt',
    'does not clear secretstorage on uninstall',
    'no outbound network by default',
  ],
  'missing-privacy-caveat',
);

// missing-accuracy-label: ACCURACY must document the native-only label set and
// contracts. `log_derived` and the `estimated`/synthetic-estimator
// taxonomy were removed (native-only).
requirePhrases(
  'ACCURACY.md',
  ['exact', 'billing_authoritative', 'proxy_reported', 'partial', 'unknown', 'cost unknown'],
  'missing-accuracy-label',
);

// missing-native-caveats: ACCURACY must keep the honest native limitations so the
// rationale is mechanically required to exist and cannot be silently dropped.
requirePhrases('ACCURACY.md', ['no public', 'cache', 'unavailable'], 'missing-native-caveats');

// missing-release-posture (SECURITY): PAT-gated optional Marketplace/Open VSX.
requirePhrases(
  'SECURITY.md',
  ['marketplace', 'open vsx', 'personal access token', 'github environment'],
  'missing-release-posture',
);

// dishonest-marketplace-oidc-claim: a doc may not claim OIDC-based Marketplace
// publishing unless it explicitly disclaims it. We flag any doc that mentions
// both OIDC and Marketplace unless the same doc explicitly says TokenGauge does
// not use/claim OIDC for Marketplace publishing.
const OIDC_DISCLAIMERS = [
  'no oidc claim',
  'does not use or claim oidc',
  'does not claim oidc',
  'no marketplace oidc claim',
  'makes no marketplace',
];
for (const file of ['README.md', 'SECURITY.md']) {
  const content = docs[file];
  if (content === undefined) {
    continue;
  }
  const lower = content.toLowerCase();
  if (lower.includes('oidc') && lower.includes('marketplace')) {
    const disclaimed = OIDC_DISCLAIMERS.some((d) => lower.includes(d));
    if (!disclaimed) {
      fail('dishonest-marketplace-oidc-claim', file);
    }
  }
}

if (violations.length > 0) {
  console.error('Release docs gate violations:');
  for (const { rule, file } of violations) {
    console.error(`  [${rule}] ${file}`);
  }
  process.exit(1);
}

console.log('OK: release docs gate passed');
