import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      'TokenGauge reads only that exact directory, non-recursively. It considers ' +
      'up to 32 hash-named snapshot files and never deletes snapshot files. ' +
      'The strict schema rejects leaky or malformed snapshots. ' +
      '#### WSL, Linux, macOS, or Git Bash\n' +
      'Use this block in Bash-like shells only. It is not PowerShell syntax. ' +
      'Run node --version first. TokenGauge does not install Node or Claude Code. ' +
      "mkdir -p ~/.tokengauge/claude\ncat > ~/.tokengauge/claude/claude-statusline-writer.mjs <<'TOKENGAUGE_STATUSLINE'\n" +
      'function outputPathFor(mode, target, snapshot) {}\nTokenGauge snapshot updated\n' +
      'TOKENGAUGE_STATUSLINE\nrealpath ~/.tokengauge/claude/claude-statusline-writer.mjs\n' +
      '#### PowerShell\n' +
      "$writer = Join-Path $HOME '.tokengauge\\claude\\claude-statusline-writer.mjs'\n" +
      "@'\nfunction outputPathFor(mode, target, snapshot) {}\nTokenGauge snapshot updated\n'@ | Set-Content -Path $writer -Encoding utf8\n" +
      'node --check $writer\n(Resolve-Path $writer).Path\n' +
      'If you intentionally keep a custom shell writer instead. ' +
      'Create claude-statusline-writer.mjs and validate it with node --check. ' +
      'Print the absolute writer path with realpath ~/.tokengauge/claude/claude-statusline-writer.mjs. ' +
      'No `jq`, `sha256sum`, `chmod`, or `sed` step is needed. ' +
      'Do not run bare `/statusline` for TokenGauge setup. ' +
      'Claude statusLine.command points to the writer script, but TokenGauge points to the snapshot output, not the writer script. ' +
      'Use --file /home/YOUR_USER/.tokengauge/claude/statusline-snapshot.json for single-file mode. ' +
      'Use --dir /home/YOUR_USER/.tokengauge/claude/statusline-snapshots for directory mode. ' +
      'If the snapshot file exists but the Claude card still shows no gauge, check statusline_snapshot_missing_rate_limits. ' +
      'That means TokenGauge read the snapshot, but Claude did not report limit fields. This is not a path problem. TokenGauge will not guess a usage window. ' +
      'Run claude auth status and claude doctor locally. Do not paste raw auth output in public issues. TokenGauge shows a gauge as soon as Claude Code reports fields. ' +
      'Use the absolute writer path printed by `realpath` or `Resolve-Path`. Merge it into the existing JSON object; do not delete unrelated settings. ' +
      'node C:/Users/YOUR_USER/.tokengauge/claude/claude-statusline-writer.mjs. ' +
      '--file C:/Users/YOUR_USER/.tokengauge/claude/statusline-snapshot.json. ' +
      'C:/Users/YOUR_USER/.tokengauge/claude/statusline-snapshot.json. ' +
      'The Configure snapshot path button opens this exact setting. ' +
      'In remote windows use Remote settings or Workspace settings; Local User settings may not affect that window. ' +
      'Claude Code must already run in the same environment. If `claude` does not start, fix Claude Code first. ' +
      'Same-host setup is preferred. Cross-host paths can work but are not the recommended setup. ' +
      'Opt in to tokenGauge.providers.codex.nativeStatusProbe only when wanted and keep the Codex card visible for probes. ' +
      'Use tokenGauge.display.cards.claude.visible and tokenGauge.display.cards.codex.visible for card visibility. ' +
      'When both are hidden, the cockpit shows No cards visible. ' +
      'In snapshot directory mode there is no file watcher; directory mode is poll-only. ' +
      'vsce rewrites relative links to absolute blob/HEAD URLs; releases use merge or tag-pin delivery. ' +
      'See [PRIVACY.md](PRIVACY.md) and jump to [setup](#quick-start).\n',
    '.vscodeignore':
      '**\n!dist/\n!package.json\n!README.md\n!LICENSE\n!CHANGELOG.md\n!THIRD_PARTY_NOTICES.md\n',
    'PRIVACY.md':
      'SecretStorage caveats. Local install salt is a non-credential value. ' +
      'TokenGauge does not clear SecretStorage on uninstall. no outbound network by default.\n' +
      'Inspect with node -e \'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(s.statusLine?.command ?? "")\' ~/.claude/settings.json\n',
    'SECURITY.md':
      'Release Workflow Posture. Tag-only trigger. GitHub Environment approval. ' +
      'Publishing credentials remain isolated. Initial Marketplace publication uses ' +
      'owner-authenticated manual upload of one preverified VSIX. Open VSX remains separately authorized. ' +
      'No OIDC claim.\n',
    'CONTRIBUTING.md': 'npm run lint, npm run typecheck, npm run test, npm run check.\n',
    'ACCURACY.md':
      'Labels: exact, billing_authoritative, proxy_reported, ' +
      'partial, unknown. The cost unknown contract. ' +
      'Current v1 emits only `proxy_reported` and `unknown`; it never emits the ' +
      'partial label.\n\n' +
      '## Native limitations\n' +
      'No public Anthropic tokenizer. The stats-cache is a cost/model cache. Missing native data ' +
      'reads unavailable.\n',
    'CHANGELOG.md': `# Changelog\n\n## ${pkgVersion}\n\nMVP release.\n`,
    'THIRD_PARTY_NOTICES.md': '# Third-Party Notices\n\nBundled runtime components.\n',
    LICENSE: 'Apache-2.0 stub\n',
  };
}

function writeFixture(dir, docs) {
  for (const [name, content] of Object.entries(docs)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
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

runFixture(
  'stale-bridge-artifact-reference',
  (docs) => {
    docs['README.md'] =
      `${docs['README.md']}\nSee src/bridge/README-bridge-setup.md and claude-statusline-writer.example.sh.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'README pointing at deleted bridge artifacts should fail');
    assert(
      result.output.includes('stale-bridge-artifact-reference'),
      'expected stale-bridge-artifact-reference rule',
    );
  },
);

// Test 2e2 (17-E01): the stale-accuracy-architecture gate. Reintroducing the
// deleted accuracy-lattice helper, a stats-cache token-detail display claim, or
// the old "partial labels are expected" claim fails without leaking doc bodies.
runFixture(
  'stale-accuracy-architecture-combine',
  (docs) => {
    docs['ACCURACY.md'] =
      `${docs['ACCURACY.md']}\nThis logic lives in a single Accuracy.combine() helper.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'ACCURACY reintroducing Accuracy.combine should fail');
    assert(
      result.output.includes('stale-accuracy-architecture'),
      'expected stale-accuracy-architecture rule',
    );
  },
);

runFixture(
  'stale-accuracy-architecture-token-detail',
  (docs) => {
    docs['README.md'] =
      `${docs['README.md']}\nTokenGauge reads the local stats-cache.json token-detail file.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'README reintroducing token-detail claim should fail');
    assert(
      result.output.includes('stale-accuracy-architecture'),
      'expected stale-accuracy-architecture rule',
    );
  },
);

runFixture(
  'stale-accuracy-architecture-partial-expected',
  (docs) => {
    docs['ACCURACY.md'] =
      `${docs['ACCURACY.md']}\npartial and unknown labels are expected whenever sources disagree.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'ACCURACY claiming partial is expected should fail');
    assert(
      result.output.includes('stale-accuracy-architecture'),
      'expected stale-accuracy-architecture rule',
    );
  },
);

runFixture(
  'missing-emitted-label-truth',
  (docs) => {
    docs['ACCURACY.md'] = docs['ACCURACY.md'].replace(
      'Current v1 emits only `proxy_reported` and `unknown`; it never emits the partial label.',
      'All five labels appear in the cockpit.',
    );
  },
  (result) => {
    assert(result.status !== 0, 'ACCURACY without the emitted-label truth should fail');
    assert(
      result.output.includes('missing-emitted-label-truth'),
      'expected missing-emitted-label-truth rule',
    );
  },
);

// Test 2e2b (17-E02): the watch-versus-poll truth. The unqualified "reacts to
// file changes" wording fails, and dropping the poll-only distinction fails.
runFixture(
  'stale-directory-watch-claim',
  (docs) => {
    docs['README.md'] =
      `${docs['README.md']}\nThe cockpit re-checks every 15 seconds and also reacts to file changes as they happen.\n`;
  },
  (result) => {
    assert(result.status !== 0, 'unqualified watch claim should fail');
    assert(
      result.output.includes('stale-directory-watch-claim'),
      'expected stale-directory-watch-claim rule',
    );
  },
);

runFixture(
  'missing-watch-poll-distinction',
  (docs) => {
    docs['README.md'] = docs['README.md'].replace(
      'In snapshot directory mode there is no file watcher; directory mode is poll-only. ',
      '',
    );
  },
  (result) => {
    assert(result.status !== 0, 'README without the watch/poll distinction should fail');
    assert(
      result.output.includes('missing-watch-poll-distinction'),
      'expected missing-watch-poll-distinction rule',
    );
  },
);

// Test 2e2c (17-E02): the platform-guide truth gate. The guides are optional;
// when present they must carry the truth markers and reject overclaims.
function cleanGuide(extensionHostLine) {
  return (
    'Directory mode: TokenGauge reads only that exact directory, non-recursively; ' +
    'it considers up to 32 hash-named snapshot files, treats files rewritten within ' +
    'about 90 seconds as active, and never deletes snapshot files. Directory mode is poll-only. ' +
    'Pass --file for a single snapshot or --dir for a per-session directory. ' +
    `${extensionHostLine} macOS is not verified in this remediation.\n`
  );
}
function cleanGuides(docs) {
  docs['docs/setup/windows.md'] = cleanGuide(
    'The Windows extension-host flow was not verified end to end in this remediation.',
  );
  docs['docs/setup/wsl.md'] = cleanGuide(
    'The configured snapshot path must be visible to the extension host that reads it.',
  );
}
function runGuideFixture(name, mutateGuides, check) {
  runFixture(
    name,
    (docs) => {
      cleanGuides(docs);
      if (mutateGuides) {
        mutateGuides(docs);
      }
    },
    check,
  );
}

runGuideFixture('guides-clean', null, (result) => {
  assert(result.status === 0, `clean guides should pass, got:\n${result.output}`);
});

runGuideFixture(
  'guide-windows-tested-overclaim',
  (docs) => {
    docs['docs/setup/windows.md'] += 'Windows was tested end to end in this remediation.\n';
  },
  (result) => {
    assert(result.status !== 0, 'Windows end-to-end overclaim should fail');
    assert(result.output.includes('stale-guide-claim'), 'expected stale-guide-claim rule');
  },
);

runGuideFixture(
  'guide-macos-verified-overclaim',
  (docs) => {
    docs['docs/setup/wsl.md'] += 'Verified on macOS as well.\n';
  },
  (result) => {
    assert(result.status !== 0, 'macOS verified overclaim should fail');
    assert(result.output.includes('stale-guide-claim'), 'expected stale-guide-claim rule');
  },
);

runGuideFixture(
  'guide-recursive-scan-claim',
  (docs) => {
    docs['docs/setup/windows.md'] = docs['docs/setup/windows.md'].replace(
      'non-recursively',
      'recursively',
    );
  },
  (result) => {
    assert(result.status !== 0, 'recursive-scan wording should fail');
    assert(
      result.output.includes('missing-guide-truth-markers'),
      'expected missing-guide-truth-markers rule',
    );
  },
);

runGuideFixture(
  'guide-freshness-marker-removed',
  (docs) => {
    docs['docs/setup/wsl.md'] = docs['docs/setup/wsl.md'].replace('about 90 seconds', 'a while');
  },
  (result) => {
    assert(result.status !== 0, 'missing freshness marker should fail');
    assert(
      result.output.includes('missing-guide-truth-markers'),
      'expected missing-guide-truth-markers rule',
    );
  },
);

runGuideFixture(
  'guide-deleted-shell-writer',
  (docs) => {
    docs['docs/setup/windows.md'] += 'Or run claude-statusline-writer.example.sh instead.\n';
  },
  (result) => {
    assert(result.status !== 0, 'deleted shell-writer recommendation should fail');
    assert(result.output.includes('stale-guide-claim'), 'expected stale-guide-claim rule');
  },
);

runGuideFixture(
  'guide-raw-payload-inspection',
  (docs) => {
    docs['docs/setup/wsl.md'] += 'To debug, cat the raw payload and paste it into an issue.\n';
  },
  (result) => {
    assert(result.status !== 0, 'raw payload inspection instruction should fail');
    assert(result.output.includes('stale-guide-claim'), 'expected stale-guide-claim rule');
  },
);

runGuideFixture(
  'guide-second-writer-body',
  (docs) => {
    docs['docs/setup/wsl.md'] +=
      "cat > writer.mjs <<'TOKENGAUGE_STATUSLINE'\n...\nTOKENGAUGE_STATUSLINE\n";
  },
  (result) => {
    assert(result.status !== 0, 'embedded second writer body should fail');
    assert(result.output.includes('stale-guide-claim'), 'expected stale-guide-claim rule');
  },
);

runGuideFixture(
  'guide-windows-narrowing-removed',
  (docs) => {
    docs['docs/setup/windows.md'] = docs['docs/setup/windows.md'].replace(
      'was not verified end to end in this remediation',
      'works everywhere',
    );
  },
  (result) => {
    assert(result.status !== 0, 'missing Windows narrowing should fail');
    assert(
      result.output.includes('missing-windows-evidence-narrowing'),
      'expected missing-windows-evidence-narrowing rule',
    );
  },
);

// Test 2e2d (17-G01): walkthrough-media truth. Each violation fails with its
// rule name only.
const GUIDE_NOTICE =
  '> **Visual walkthrough note:** Do not copy code or commands from the images or animations.\n';

runGuideFixture(
  'stale-walkthrough-without-notice',
  (docs) => {
    docs['docs/setup/windows.md'] += '![step](../images/setup/windows/demo.webp)\n';
  },
  (result) => {
    assert(result.status !== 0, 'stale walkthrough without notice should fail');
    assert(
      result.output.includes('missing-visual-walkthrough-notice'),
      'expected missing-visual-walkthrough-notice rule',
    );
  },
);

runGuideFixture(
  'image-commands-claimed-current',
  (docs) => {
    docs['docs/setup/wsl.md'] += 'You can copy the commands shown in the animation.\n';
  },
  (result) => {
    assert(result.status !== 0, 'claiming image commands are current should fail');
    assert(
      result.output.includes('stale-visual-overclaim'),
      'expected stale-visual-overclaim rule',
    );
  },
);

runGuideFixture(
  'missing-authoritative-writer-command',
  (docs) => {
    docs['docs/setup/windows.md'] = docs['docs/setup/windows.md'].replace(
      'Pass --file for a single snapshot or --dir for a per-session directory. ',
      '',
    );
  },
  (result) => {
    assert(result.status !== 0, 'guide without --file/--dir text should fail');
    assert(
      result.output.includes('missing-authoritative-writer-command'),
      'expected missing-authoritative-writer-command rule',
    );
  },
);

runGuideFixture(
  'media-included-in-vsix',
  (docs) => {
    docs['.vscodeignore'] = '**\n!docs/images/\n!README.md\n';
  },
  (result) => {
    assert(result.status !== 0, 'docs/images negation in .vscodeignore should fail');
    assert(result.output.includes('media-not-excluded'), 'expected media-not-excluded rule');
  },
);

runGuideFixture(
  'permanent-p09-branch-url',
  (docs) => {
    docs['README.md'] += '\nSee the guides on the docs/p09-setup-guides-and-visuals branch.\n';
  },
  (result) => {
    assert(result.status !== 0, 'P09-branch URL should fail');
    assert(result.output.includes('p09-branch-url'), 'expected p09-branch-url rule');
  },
);

runGuideFixture(
  'guide-media-target-missing',
  (docs) => {
    docs['docs/setup/wsl.md'] =
      `${GUIDE_NOTICE}${docs['docs/setup/wsl.md']}![step](../images/setup/wsl/missing.webp)\n`;
  },
  (result) => {
    assert(result.status !== 0, 'missing guide media target should fail');
    assert(
      result.output.includes('guide-media-target-missing'),
      'expected guide-media-target-missing rule',
    );
  },
);

runGuideFixture(
  'animation-described-as-packaged',
  (docs) => {
    docs['docs/setup/windows.md'] += 'The animations ship inside the VSIX.\n';
  },
  (result) => {
    assert(result.status !== 0, 'animation-packaged claim should fail');
    assert(
      result.output.includes('animation-packaged-claim'),
      'expected animation-packaged-claim rule',
    );
  },
);

// Test 2e3 (17-E01): the Node-first inspection contract. Reintroducing the
// jq-primary inspection command or dropping the Node command fails.
runFixture(
  'stale-jq-primary-inspection',
  (docs) => {
    docs['PRIVACY.md'] =
      `${docs['PRIVACY.md']}\nInspect with jq -r '.statusLine.command' ~/.claude/settings.json\n`;
  },
  (result) => {
    assert(result.status !== 0, 'PRIVACY reintroducing jq-primary inspection should fail');
    assert(
      result.output.includes('stale-jq-primary-inspection'),
      'expected stale-jq-primary-inspection rule',
    );
  },
);

runFixture(
  'missing-node-inspection-command',
  (docs) => {
    docs['PRIVACY.md'] =
      'SecretStorage caveats. Local install salt is a non-credential value. ' +
      'TokenGauge does not clear SecretStorage on uninstall. no outbound network by default.\n';
  },
  (result) => {
    assert(result.status !== 0, 'PRIVACY without the Node inspection command should fail');
    assert(
      result.output.includes('missing-node-inspection-command'),
      'expected missing-node-inspection-command rule',
    );
  },
);

// Test 2e4 (17-F01): the packaged-link closure gate. The clean fixture carries
// an approved link with an existing target plus a valid anchor; each closure
// violation fails with its rule name only.
runFixture(
  'broken-anchor',
  (docs) => {
    docs['README.md'] += '\nJump to [missing](#nonexistent-section).\n';
  },
  (result) => {
    assert(result.status !== 0, 'broken anchor should fail');
    assert(result.output.includes('broken-anchor'), 'expected broken-anchor rule');
  },
);

runFixture(
  'media-link-in-packaged-doc',
  (docs) => {
    docs['README.md'] += '\nSee the [demo](media/p9/demo.webp).\n';
  },
  (result) => {
    assert(result.status !== 0, 'media link in packaged doc should fail');
    assert(
      result.output.includes('media-link-in-packaged-doc'),
      'expected media-link-in-packaged-doc rule',
    );
  },
);

runFixture(
  'unapproved-relative-packaged-link',
  (docs) => {
    docs['README.md'] += '\nRead the [macOS guide](docs/setup/macos.md).\n';
  },
  (result) => {
    assert(result.status !== 0, 'unapproved relative packaged link should fail');
    assert(
      result.output.includes('unapproved-packaged-link'),
      'expected unapproved-packaged-link rule',
    );
  },
);

// 17-G01: an approved image target must still exist in the tree.
runFixture(
  'approved-image-target-missing',
  (docs) => {
    docs['README.md'] += '\n![hero](docs/images/tokengauge-hero.png)\n';
  },
  (result) => {
    assert(result.status !== 0, 'approved image link with missing target should fail');
    assert(
      result.output.includes('packaged-link-target-missing'),
      'expected packaged-link-target-missing rule',
    );
  },
);

runFixture(
  'unapproved-absolute-packaged-link',
  (docs) => {
    docs['CHANGELOG.md'] += '\nMore at [example](https://example.com/x).\n';
  },
  (result) => {
    assert(result.status !== 0, 'unapproved absolute packaged link should fail');
    assert(
      result.output.includes('unapproved-packaged-link'),
      'expected unapproved-packaged-link rule',
    );
  },
);

runFixture(
  'packaged-link-target-missing',
  (docs) => {
    docs['CHANGELOG.md'] += '\nSee [ADR-004](docs/adr/ADR-004-native-only-privacy-model.md).\n';
  },
  (result) => {
    assert(result.status !== 0, 'approved link with missing target should fail');
    assert(
      result.output.includes('packaged-link-target-missing'),
      'expected packaged-link-target-missing rule',
    );
  },
);

runFixture(
  'media-not-excluded',
  (docs) => {
    docs['.vscodeignore'] = '**\n!media/\n!README.md\n';
  },
  (result) => {
    assert(result.status !== 0, 'media negation in .vscodeignore should fail');
    assert(result.output.includes('media-not-excluded'), 'expected media-not-excluded rule');
  },
);

runFixture(
  'missing-packaging-truth',
  (docs) => {
    docs['README.md'] = docs['README.md'].replace(
      'vsce rewrites relative links to absolute blob/HEAD URLs; releases use merge or tag-pin delivery. ',
      '',
    );
  },
  (result) => {
    assert(result.status !== 0, 'README without the packaging truth should fail');
    assert(
      result.output.includes('missing-packaging-truth'),
      'expected missing-packaging-truth rule',
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
      'Publishing credentials remain isolated. Initial Marketplace publication uses one preverified VSIX. Open VSX remains separately authorized. ' +
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

// Test 4d: public docs must not carry private local paths, private capture
// names, or unreleased phase-branch fragments. The gate reports only rule names
// and file paths, never matched content.
runFixture(
  'private-fragment',
  (docs) => {
    docs['README.md'] = `${docs['README.md']}\n/home/syntheticuser/projects/private-capture\n`;
    docs['SECURITY.md'] =
      `${docs['SECURITY.md']}\nrelease-p99-private-capture docs/p99-private-capture media/p99-private-capture\n`;
  },
  (result) => {
    assert(result.status !== 0, 'private fragments should fail');
    assert(result.output.includes('private-fragment'), 'expected private-fragment rule');
    assert(!result.output.includes('syntheticuser'), 'gate output must not echo private path');
    assert(!result.output.includes('release-p99'), 'gate output must not echo branch fragment');
    assert(!result.output.includes('media/p99'), 'gate output must not echo capture fragment');
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
