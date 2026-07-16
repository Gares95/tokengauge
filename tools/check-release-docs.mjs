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
  'THIRD_PARTY_NOTICES.md',
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

function forbidSensitiveFragments(file) {
  const content = docs[file];
  if (content === undefined) {
    return;
  }
  const checks = [
    /\b(?:\/home|\/Users)\/(?!YOUR_USER(?:\/|$))[A-Za-z0-9._-]+\/(?:projects|workspace|captures?|media|private|Desktop|Documents|Downloads)\b/i,
    /\b[A-Z]:[\\/]+Users[\\/]+(?!YOUR_USER(?:[\\/]|$))[A-Za-z0-9._-]+[\\/]+(?:projects|workspace|captures?|media|private|Desktop|Documents|Downloads)\b/i,
    /\\\\wsl(?:\.localhost)?\\[^\\\s]+\\home\\(?!YOUR_USER(?:\\|$))[A-Za-z0-9._-]+\\(?:projects|workspace|captures?|media|private|Desktop|Documents|Downloads)\b/i,
    /\brelease-p\d{2}(?:-[A-Za-z0-9._-]+)?\b/i,
    /\bdocs\/p\d{2}-[A-Za-z0-9._/-]+\b/i,
    /\b(?:media|captures?)\/p\d{2}-[A-Za-z0-9._/-]+\b/i,
  ];
  if (checks.some((pattern) => pattern.test(content))) {
    fail('private-fragment', file);
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
    'TokenGauge reads only that exact directory, non-recursively',
    'up to 32 hash-named snapshot files',
    'never deletes snapshot files',
    'strict schema rejects leaky or malformed snapshots',
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
    '--file /home/YOUR_USER/.tokengauge/claude/statusline-snapshot.json',
    '--dir /home/YOUR_USER/.tokengauge/claude/statusline-snapshots',
    'node C:/Users/YOUR_USER/.tokengauge/claude/claude-statusline-writer.mjs',
    '--file C:/Users/YOUR_USER/.tokengauge/claude/statusline-snapshot.json',
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
    !bashBlock.includes('realpath ~/.tokengauge/claude/claude-statusline-writer.mjs') ||
    !bashBlock.includes('function outputPathFor(mode, target, snapshot)') ||
    !bashBlock.includes('TokenGauge snapshot updated')
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
    !powerShellBlock.includes('(Resolve-Path $writer).Path') ||
    !powerShellBlock.includes('function outputPathFor(mode, target, snapshot)') ||
    !powerShellBlock.includes('TokenGauge snapshot updated')
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

const DELETED_BRIDGE_ARTIFACT_REFS = [
  'src/bridge/README-bridge-setup.md',
  'README-bridge-setup',
  'bridge setup guide',
  'src/bridge/claude-statusline-writer.example.sh',
  'claude-statusline-writer.example.sh',
];
for (const file of ['README.md', 'PRIVACY.md']) {
  forbidPhrases(file, DELETED_BRIDGE_ARTIFACT_REFS, 'stale-bridge-artifact-reference');
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

// stale-accuracy-architecture (17-E01): current docs must not reintroduce the
// deleted accuracy-lattice helpers, an accuracy-lattice/aggregation claim, a
// stats-cache "token-detail" display claim, or the old claim that `partial`
// labels are expected. These are unambiguous stale markers: the corrected copy
// says "does not display token counts" and "never emits the `partial` label",
// which contain none of these phrases.
const STALE_ACCURACY_ARCHITECTURE = [
  'accuracy.combine',
  'leastaccurate',
  'accuracy lattice',
  'token-detail',
  'labels are expected whenever sources disagree',
];
for (const file of ['README.md', 'PRIVACY.md', 'ACCURACY.md', 'CONTRIBUTING.md', 'CHANGELOG.md']) {
  forbidPhrases(file, STALE_ACCURACY_ARCHITECTURE, 'stale-accuracy-architecture');
}

// missing-emitted-label-truth (17-E01): ACCURACY must state which labels the
// current resolver actually emits, so the declared-vs-emitted distinction
// cannot silently regress.
requirePhrases(
  'ACCURACY.md',
  ['emits only `proxy_reported` and `unknown`', 'never emits'],
  'missing-emitted-label-truth',
);

// stale-directory-watch-claim (17-E02): README must not describe snapshot
// updates as generally reacting to file changes — only single-file mode has a
// watcher; directory mode is poll-only. The corrected wording states the
// distinction explicitly, so the unqualified phrase and the missing
// distinction are both mechanical regressions.
forbidPhrases(
  'README.md',
  ['and also reacts to file changes as they happen'],
  'stale-directory-watch-claim',
);
requirePhrases(
  'README.md',
  ['directory mode is poll-only', 'no file watcher'],
  'missing-watch-poll-distinction',
);

// stale-jq-primary-inspection (17-E01): PRIVACY's statusLine inspection command
// must stay Node-first like the README primary setup; the jq-primary command
// must not return.
forbidPhrases('PRIVACY.md', ["jq -r '.statusline.command'"], 'stale-jq-primary-inspection');
requirePhrases(
  'PRIVACY.md',
  ['console.log(s.statusline?.command'],
  'missing-node-inspection-command',
);

// platform-guide truth (17-E02): the repo-only setup guides are optional, but
// when present they must carry the directory-mode bounds, the poll-only truth,
// the evidence-honest narrowing/visibility statements, and must not
// reintroduce overclaims, a second embedded writer body, the deleted shell
// writer, or the jq-primary inspection. Marker phrases only; rule + path
// reported, never content.
const SETUP_GUIDES = ['docs/setup/windows.md', 'docs/setup/wsl.md'];
for (const file of SETUP_GUIDES) {
  const content = read(file);
  if (content === null) {
    continue;
  }
  docs[file] = content;
  requirePhrases(
    file,
    [
      'non-recursively',
      'up to 32 hash-named',
      'about 90 seconds',
      'never deletes snapshot files',
      'poll-only',
      'macOS is not verified',
    ],
    'missing-guide-truth-markers',
  );
  forbidPhrases(
    file,
    [
      'tokengauge_statusline',
      'claude-statusline-writer.example.sh',
      "jq -r '.statusline.command'",
      'cross-platform verified',
      'tested on macos',
      'verified on macos',
      'tested end to end on',
      'was tested end to end',
      'reacts to file changes as they happen',
      'cat the raw payload',
      'paste the raw payload',
    ],
    'stale-guide-claim',
  );
}
if (docs['docs/setup/windows.md'] !== undefined) {
  requirePhrases(
    'docs/setup/windows.md',
    ['not verified end to end in this remediation'],
    'missing-windows-evidence-narrowing',
  );
}
if (docs['docs/setup/wsl.md'] !== undefined) {
  requirePhrases(
    'docs/setup/wsl.md',
    ['visible to the extension host'],
    'missing-extension-host-visibility-rule',
  );
}

// packaged-link closure (17-F01): vsce rewrites relative links in the packaged
// README/CHANGELOG to absolute GitHub blob/HEAD URLs on the default branch.
// Under approved Strategy B the public default branch equals this tree at
// publication, so closure = every relative target is an approved packaged-doc
// destination that exists in this tree; anchors must match a real heading;
// absolute URLs are allowlisted; no packaged doc may point at media, image, or
// planning content. Rule + path reported, never content.
const PACKAGED_DOCS = ['README.md', 'CHANGELOG.md'];
const APPROVED_RELATIVE_TARGETS = new Set([
  'ACCURACY.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/adr/ADR-004-native-only-privacy-model.md',
  // 17-G01 reviewed extension: repo-only setup guides plus the two approved
  // GitHub-only README images (D4: media stays excluded from the VSIX; vsce
  // serves these via rewritten GitHub URLs).
  'docs/setup/windows.md',
  'docs/setup/wsl.md',
  'docs/images/tokengauge-hero.png',
  'docs/images/cockpit-overview.png',
]);
const APPROVED_ABSOLUTE_PREFIXES = ['https://keepachangelog.com/', 'https://semver.org/'];

function headingSlugs(content) {
  const slugs = new Set();
  for (const match of content.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const slug = match[1]
      .toLowerCase()
      .replace(/[`*_]/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    slugs.add(slug);
  }
  return slugs;
}

for (const file of PACKAGED_DOCS) {
  const content = docs[file];
  if (content === undefined) {
    continue;
  }
  const slugs = headingSlugs(content);
  const targets = new Set([...content.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]));
  for (const target of targets) {
    if (target.startsWith('#')) {
      if (!slugs.has(target.slice(1))) {
        fail('broken-anchor', file);
      }
    } else if (/^https?:\/\//i.test(target)) {
      if (!APPROVED_ABSOLUTE_PREFIXES.some((prefix) => target.startsWith(prefix))) {
        fail('unapproved-packaged-link', file);
      }
    } else if (APPROVED_RELATIVE_TARGETS.has(target)) {
      if (!existsSync(join(root, target))) {
        fail('packaged-link-target-missing', file);
      }
    } else if (/^(?:media|docs\/images)\//i.test(target) || target.startsWith('.planning')) {
      fail('media-link-in-packaged-doc', file);
    } else {
      fail('unapproved-packaged-link', file);
    }
  }
}

// media-not-excluded (17-F01/D4): the .vscodeignore allowlist posture that
// keeps media and docs out of the VSIX must not gain a media/docs negation.
{
  const vscodeignore = read('.vscodeignore');
  if (vscodeignore !== null) {
    if (!/^\*\*\s*$/m.test(vscodeignore) || /^!(?:media|docs)\b/im.test(vscodeignore)) {
      fail('media-not-excluded', '.vscodeignore');
    }
  }
}

// missing-packaging-truth (17-F01): the README documentation note must state
// the actual vsce blob/HEAD rewrite behavior and the merge/tag-pin release
// rule, so the corrected packaging story cannot silently regress.
requirePhrases('README.md', ['blob/head', 'merge or tag-pin'], 'missing-packaging-truth');

// walkthrough-media truth (17-G01): guides embedding setup media must show the
// owner-mandated stale-visual notice BEFORE the first media reference, keep
// the authoritative --file/--dir commands in normal text, use non-empty alt
// text, and have existing media targets. No doc may present capture commands
// as current, target the frozen P09 branch, or claim animations are packaged.
// Marker/allowlist checks only; rule + path reported, never content.
const MEDIA_NOTICE_MARKER = 'do not copy code or commands from the images';
for (const file of SETUP_GUIDES) {
  const content = docs[file];
  if (content === undefined) {
    continue;
  }
  // Collapse blockquote markers and soft wraps so the notice phrase matches
  // regardless of Markdown line breaks; media refs contain no spaces, so the
  // before/after ordering survives normalization.
  const lower = content.toLowerCase().replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
  const firstMedia = lower.search(/\]\((?:\.\.\/)?images\//);
  if (firstMedia !== -1) {
    const notice = lower.indexOf(MEDIA_NOTICE_MARKER);
    if (notice === -1 || notice > firstMedia) {
      fail('missing-visual-walkthrough-notice', file);
    }
    for (const match of content.matchAll(/\]\((\.\.\/images\/[^)]+)\)/g)) {
      if (!existsSync(join(root, 'docs', match[1].slice(3)))) {
        fail('guide-media-target-missing', file);
      }
    }
    if (/!\[\]\(/.test(content)) {
      fail('missing-alt-text', file);
    }
  }
  requirePhrases(file, ['--file', '--dir'], 'missing-authoritative-writer-command');
  forbidPhrases(
    file,
    [
      'copy the commands shown in the',
      'copy the command shown in the',
      'commands shown in the animation are current',
    ],
    'stale-visual-overclaim',
  );
}
for (const file of [...PACKAGED_DOCS, ...SETUP_GUIDES]) {
  if (docs[file] === undefined) {
    continue;
  }
  forbidPhrases(file, ['docs/p09-setup-guides-and-visuals'], 'p09-branch-url');
  forbidPhrases(
    file,
    ['animations are packaged', 'animations ship inside the vsix'],
    'animation-packaged-claim',
  );
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

// missing-release-posture (SECURITY): credentials stay isolated, first
// Marketplace publication uses one preverified VSIX, and Open VSX remains
// separately authorized.
requirePhrases(
  'SECURITY.md',
  ['marketplace', 'open vsx', 'credential', 'preverified vsix', 'github environment'],
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

for (const file of REQUIRED_DOCS) {
  forbidSensitiveFragments(file);
}

if (violations.length > 0) {
  console.error('Release docs gate violations:');
  for (const { rule, file } of violations) {
    console.error(`  [${rule}] ${file}`);
  }
  process.exit(1);
}

console.log('OK: release docs gate passed');
