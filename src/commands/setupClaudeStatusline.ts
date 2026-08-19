// `tokenGauge.setupClaudeStatusline` — the one-command Claude setup.
//
// It removes the error-prone parts of the statusLine setup: creating the writer
// script by hand (shell-specific, the largest source of setup failures),
// syntax-checking it, and pointing TokenGauge at the snapshot in the settings
// scope that actually applies to this window.
//
// HARD CONSTRAINT: it MUST NOT write `~/.claude/settings.json`. Editing the
// user's agent config is a promise TokenGauge makes in the README and enforces
// via tools/check-release-docs.mjs (`automatic-claude-settings-edit`). This
// command writes OUR files and OUR setting, then SHOWS the exact line for the
// user to paste themselves. Writing a file is not configuring the agent; keep
// that line sharp.
//
// It also does NOT read `~/.claude/settings.json`, not even to detect an
// existing statusLine. The user opens that file to paste, so they see any
// existing entry themselves, and TokenGauge's read surface stays unchanged.
//
// The only tokenGauge setting it writes is the snapshot PATH, and only in USER
// scope. It never flips a privacy toggle; the Codex probe stays off unless the
// user enables it. It never writes Workspace scope: that lands in the project's
// shared .vscode/settings.json, which may be under version control, and the value
// is a machine-specific absolute path that would be wrong for everyone else.
//
// Every side effect is an INJECTED seam so this module stays clean against
// tools/check-no-stray-ui-surfaces.mjs and unit-testable without booting VS Code.

export const SETUP_CLAUDE_STATUSLINE_COMMAND = 'tokenGauge.setupClaudeStatusline' as const;

// Where the writer and its snapshot live. These match the README defaults so a
// user who followed the manual steps and a user who ran this command end up with
// the same layout.
export const WRITER_DIR_SEGMENTS = ['.tokengauge', 'claude'] as const;
export const WRITER_FILENAME = 'claude-statusline-writer.mjs' as const;
export const SNAPSHOT_FILENAME = 'statusline-snapshot.json' as const;

// The command writes User scope. The value is a machine-specific absolute path,
// so Workspace scope would place it in the project's shared, committable
// .vscode/settings.json, where an absolute home path is wrong on every other
// machine. 'workspace' remains in the type because a caller may still need to
// report it; the command never selects it itself.
export type SettingsScope = 'user' | 'workspace';

export interface SetupClaudeStatuslineDeps {
  readonly homeDir: () => string;
  readonly join: (...parts: string[]) => string;
  // The canonical writer, shipped into dist/ at build time. Read, never
  // reconstructed: there is exactly one writer body in this project.
  readonly readCanonicalWriter: () => Promise<string>;
  readonly ensureDir: (dir: string) => Promise<void>;
  readonly writeFile: (file: string, contents: string) => Promise<void>;
  // `node --check <file>`; resolves false when node is unavailable or the file
  // does not parse. Never surfaces raw stderr.
  readonly syntaxCheck: (file: string) => Promise<boolean>;
  // Writes ONLY tokenGauge.claude.statuslineSnapshotPath.
  readonly writeSnapshotPathSetting: (value: string, scope: SettingsScope) => Promise<void>;
  // Which scope the extension host actually reads in this window. In Remote/WSL
  // /Dev Container windows this is not User, which is the single most common
  // reason a correct-looking setup shows nothing.
  readonly targetScope: () => SettingsScope;
  readonly remoteName: () => string | undefined;
  readonly renderReport: (markdown: string) => Promise<void>;
  readonly showInfo: (message: string) => void;
  readonly showError: (message: string) => void;
}

export interface SetupClaudeStatuslineResult {
  readonly status: 'completed' | 'failed';
  readonly wroteWriter: boolean;
  readonly syntaxOk: boolean;
  readonly wroteSetting: boolean;
  readonly scope: SettingsScope;
}

const SCOPE_LABEL: Record<SettingsScope, string> = {
  user: 'User',
  workspace: 'Workspace',
};

// The exact JSON the user pastes. Windows paths are written with forward
// slashes, which is valid in JSON and avoids escaping mistakes.
export function statusLineCommandJson(writerPath: string, snapshotPath: string): string {
  const w = writerPath.replace(/\\/g, '/');
  const s = snapshotPath.replace(/\\/g, '/');
  return `{
  "statusLine": {
    "type": "command",
    "command": "node ${w} --file ${s}"
  }
}`;
}

function report(input: {
  readonly writerPath: string;
  readonly snapshotPath: string;
  readonly scope: SettingsScope;
  readonly syntaxOk: boolean;
  readonly remote: string | undefined;
}): string {
  const { writerPath, snapshotPath, scope, syntaxOk, remote } = input;
  return [
    '# TokenGauge: Claude statusLine setup',
    '',
    '## Done for you',
    '',
    `- Wrote the statusLine writer to \`${writerPath}\`.`,
    syntaxOk
      ? '- Verified it parses with `node --check`.'
      : '- Could not verify it with `node --check`. Node may not be on this PATH. The writer was still written; check it before relying on the card.',
    `- Set \`tokenGauge.claude.statuslineSnapshotPath\` to \`${snapshotPath}\` in **${SCOPE_LABEL[scope]}** settings.`,
    ...(remote !== undefined
      ? [
          '',
          `> **This is a ${remote} window.** The path was written to your **User**`,
          '> settings, which is correct for a machine-specific path. If the Claude card',
          '> stays empty after a session reports usage, this extension host may be',
          '> reading Remote or Workspace settings instead: open Settings, search',
          '> `statuslineSnapshotPath`, and set the same value on the tab this window',
          '> uses. TokenGauge does not write your project settings, so nothing was',
          "> added to this repository's `.vscode/settings.json`.",
        ]
      : []),
    '',
    '## One step left, for you to do',
    '',
    'TokenGauge does not edit your Claude config. Add this to `~/.claude/settings.json`',
    'yourself, merging it with what is already there:',
    '',
    '```json',
    statusLineCommandJson(writerPath, snapshotPath),
    '```',
    '',
    '**If that file already has a `statusLine`**, you are about to replace it. Keep a',
    'copy first if you want it back. Prefer to keep your own status line as well? The',
    'README shows a wrapper that runs the writer and then prints your own line.',
    '',
    'Do not run bare `/statusline`: Claude Code may treat it as a request to generate',
    'a different status line and overwrite the command above.',
    '',
    '## Then',
    '',
    'Start or resume a Claude Code session **in a terminal** (statusLine does not run',
    'in the Claude Code panel) and send one message. The card fills in once Claude',
    'Code reports rate limits, which needs a Claude.ai Pro or Max session and the',
    "session's first response. Your Claude status line will also start showing your",
    'account windows, for example `32% 5h · 12% wk`.',
    '',
    'Nothing happened? Run **TokenGauge: Cockpit Diagnostics**.',
  ].join('\n');
}

export async function runSetupClaudeStatusline(
  deps: SetupClaudeStatuslineDeps,
): Promise<SetupClaudeStatuslineResult> {
  const scope = deps.targetScope();
  const dir = deps.join(deps.homeDir(), ...WRITER_DIR_SEGMENTS);
  const writerPath = deps.join(dir, WRITER_FILENAME);
  const snapshotPath = deps.join(dir, SNAPSHOT_FILENAME);

  let source: string;
  try {
    source = await deps.readCanonicalWriter();
  } catch {
    deps.showError('TokenGauge could not read its bundled statusLine writer.');
    return { status: 'failed', wroteWriter: false, syntaxOk: false, wroteSetting: false, scope };
  }

  try {
    await deps.ensureDir(dir);
    await deps.writeFile(writerPath, source);
  } catch {
    // No raw path in the notification: the report carries it, the toast does not.
    deps.showError('TokenGauge could not write the statusLine writer to your home directory.');
    return { status: 'failed', wroteWriter: false, syntaxOk: false, wroteSetting: false, scope };
  }

  // A failed syntax check is reported, not fatal: the writer is on disk and the
  // user may simply not have node on the extension host PATH.
  const syntaxOk = await deps.syntaxCheck(writerPath).catch(() => false);

  let wroteSetting = false;
  try {
    await deps.writeSnapshotPathSetting(snapshotPath, scope);
    wroteSetting = true;
  } catch {
    deps.showError('TokenGauge wrote the writer but could not save the snapshot path setting.');
  }

  await deps.renderReport(
    report({ writerPath, snapshotPath, scope, syntaxOk, remote: deps.remoteName() }),
  );
  deps.showInfo('Writer created. One line left to paste into your Claude settings.');

  return { status: 'completed', wroteWriter: true, syntaxOk, wroteSetting, scope };
}
