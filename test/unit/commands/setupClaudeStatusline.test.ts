// The Set Up Claude statusLine command.
//
// The command exists to remove the error-prone parts of setup, but its HARD
// CONSTRAINT is what these tests mostly pin: it must never write or read the
// user's `~/.claude/settings.json`, and must never flip a privacy toggle. It
// writes OUR writer and OUR snapshot-path setting, then SHOWS the line to paste.

import * as assert from 'node:assert/strict';
import {
  runSetupClaudeStatusline,
  type SettingsScope,
  type SetupClaudeStatuslineDeps,
  statusLineCommandJson,
} from '../../../src/commands/setupClaudeStatusline';

interface Recorded {
  readonly dirs: string[];
  readonly writes: Array<{ file: string; contents: string }>;
  readonly settings: Array<{ value: string; scope: SettingsScope }>;
  readonly reports: string[];
  readonly infos: string[];
  readonly errors: string[];
  readonly syntaxChecked: string[];
}

const CANONICAL =
  "import { createHash } from 'node:crypto';\n// TOKENGAUGE_STATUSLINE_WRITER_START\n";

function harness(overrides: Partial<SetupClaudeStatuslineDeps> = {}) {
  const rec: Recorded = {
    dirs: [],
    writes: [],
    settings: [],
    reports: [],
    infos: [],
    errors: [],
    syntaxChecked: [],
  };
  const deps: SetupClaudeStatuslineDeps = {
    homeDir: () => '/home/dev',
    join: (...parts) => parts.join('/'),
    readCanonicalWriter: async () => CANONICAL,
    ensureDir: async (dir) => {
      rec.dirs.push(dir);
    },
    writeFile: async (file, contents) => {
      rec.writes.push({ file, contents });
    },
    syntaxCheck: async (file) => {
      rec.syntaxChecked.push(file);
      return true;
    },
    writeSnapshotPathSetting: async (value, scope) => {
      rec.settings.push({ value, scope });
    },
    targetScope: () => 'user',
    remoteName: () => undefined,
    renderReport: async (md) => {
      rec.reports.push(md);
    },
    showInfo: (m) => {
      rec.infos.push(m);
    },
    showError: (m) => {
      rec.errors.push(m);
    },
    ...overrides,
  };
  return { deps, rec };
}

function commandFromJson(json: string): string {
  return JSON.parse(json).statusLine.command;
}

suite('Set Up Claude statusLine: the hard constraint', () => {
  // The promise TokenGauge makes in the README and enforces in the release-docs
  // gate. The command's dependency surface has no seam that could write it, and
  // this pins that the module never grows one.
  test('nothing in the command can write the user Claude settings file', async () => {
    const { deps, rec } = harness();
    await runSetupClaudeStatusline(deps);
    const touched = [...rec.dirs, ...rec.writes.map((w) => w.file)];
    for (const path of touched) {
      assert.ok(!path.includes('.claude'), `must not touch the Claude config tree: ${path}`);
    }
    assert.ok(
      touched.every((p) => p.startsWith('/home/dev/.tokengauge')),
      'writes stay inside the TokenGauge directory',
    );
  });

  // .vscode/settings.json is a shared, committable project file. Writing it is the
  // same class of overreach as writing ~/.claude/settings.json.
  test('never writes Workspace scope, in any window, remote or local', async () => {
    for (const remote of [undefined, 'wsl', 'ssh-remote', 'dev-container']) {
      const { deps, rec } = harness({ remoteName: () => remote });
      await runSetupClaudeStatusline(deps);
      assert.equal(rec.settings[0]?.scope, 'user', `remote=${String(remote)}`);
    }
  });

  test('the only setting written is the snapshot path, never a privacy toggle', async () => {
    const { deps, rec } = harness();
    await runSetupClaudeStatusline(deps);
    assert.equal(rec.settings.length, 1);
    assert.equal(rec.settings[0]?.value, '/home/dev/.tokengauge/claude/statusline-snapshot.json');
    const report = rec.reports.join('\n');
    assert.ok(!/nativeStatusProbe/.test(report), 'never nudges the Codex probe toggle');
  });

  test('the report tells the user to paste it themselves, and says we do not', async () => {
    const { deps, rec } = harness();
    await runSetupClaudeStatusline(deps);
    const report = rec.reports.join('\n');
    assert.ok(/does not edit your Claude config/i.test(report), 'states the promise');
    assert.ok(/yourself/i.test(report), 'assigns the step to the user');
    assert.ok(/already has a `statusLine`/i.test(report), 'warns about replacing an existing one');
  });
});

suite('Set Up Claude statusLine: what it does for the user', () => {
  test('writes the canonical writer verbatim, then syntax-checks that same file', async () => {
    const { deps, rec } = harness();
    const result = await runSetupClaudeStatusline(deps);
    assert.equal(rec.writes.length, 1);
    assert.equal(rec.writes[0]?.file, '/home/dev/.tokengauge/claude/claude-statusline-writer.mjs');
    assert.equal(rec.writes[0]?.contents, CANONICAL, 'written byte-for-byte, never regenerated');
    assert.deepEqual(rec.syntaxChecked, [rec.writes[0]?.file]);
    assert.equal(result.status, 'completed');
    assert.equal(result.syntaxOk, true);
  });

  test('the pasteable JSON points node at the writer and --file at the snapshot', () => {
    const json = statusLineCommandJson('/home/dev/.tokengauge/claude/w.mjs', '/home/dev/s.json');
    assert.match(json, /"type": "command"/);
    assert.equal(
      commandFromJson(json),
      'node "/home/dev/.tokengauge/claude/w.mjs" --file "/home/dev/s.json"',
    );
  });

  test('Windows paths are emitted with forward slashes so the JSON needs no escaping', () => {
    const json = statusLineCommandJson('C:\\Users\\dev\\w.mjs', 'C:\\Users\\dev\\s.json');
    const command = commandFromJson(json);
    assert.ok(!command.includes('\\'), `no path backslashes in the command: ${command}`);
    assert.equal(command, 'node "C:/Users/dev/w.mjs" --file "C:/Users/dev/s.json"');
  });

  test('paths with spaces are quoted in the pasteable command', () => {
    const command = commandFromJson(
      statusLineCommandJson(
        'C:\\Users\\Dev User\\.tokengauge\\claude\\writer.mjs',
        'C:\\Users\\Dev User\\.tokengauge\\claude\\snapshot.json',
      ),
    );
    assert.equal(
      command,
      'node "C:/Users/Dev User/.tokengauge/claude/writer.mjs" --file "C:/Users/Dev User/.tokengauge/claude/snapshot.json"',
    );
  });

  test('a local window writes User scope and says nothing about remotes', async () => {
    const { deps, rec } = harness();
    await runSetupClaudeStatusline(deps);
    assert.equal(rec.settings[0]?.scope, 'user');
    assert.ok(!/wsl|remote/i.test(rec.reports.join('\n')));
  });

  // REGRESSION: the first version chose Workspace scope in a remote window, which
  // VS Code stores in the project's .vscode/settings.json. That file is shared and
  // may be version-controlled, and the value is a machine-specific absolute path
  // that is wrong on every other machine. A remote window must still write User
  // scope and EXPLAIN itself rather than writing a project file.
  test('a remote window still writes User scope, never the project settings', async () => {
    const { deps, rec } = harness({ remoteName: () => 'wsl' });
    await runSetupClaudeStatusline(deps);
    assert.equal(rec.settings[0]?.scope, 'user', 'never Workspace scope');
    const report = rec.reports.join('\n');
    assert.match(report, /wsl/i, 'names the remote so the choice is explicable');
    assert.match(report, /User/, 'states which scope was written');
    assert.match(report, /Remote or Workspace settings/, 'tells the user what to check');
    assert.match(report, /does not write your project settings/i, 'states the boundary');
  });
});

suite('Set Up Claude statusLine: honest failure', () => {
  test('a failed syntax check is reported but does not claim success', async () => {
    const { deps, rec } = harness({ syntaxCheck: async () => false });
    const result = await runSetupClaudeStatusline(deps);
    assert.equal(result.syntaxOk, false);
    assert.equal(result.wroteWriter, true, 'the writer is still on disk');
    assert.match(rec.reports.join('\n'), /Could not verify/i);
  });

  test('an unwritable home directory fails without claiming the writer exists', async () => {
    const { deps, rec } = harness({
      writeFile: async () => {
        throw new Error('EACCES');
      },
    });
    const result = await runSetupClaudeStatusline(deps);
    assert.equal(result.status, 'failed');
    assert.equal(result.wroteWriter, false);
    assert.equal(rec.settings.length, 0, 'no setting written when the writer failed');
    assert.equal(rec.reports.length, 0, 'no success report');
    assert.equal(rec.errors.length, 1);
  });

  // Raw filesystem errors and paths must not reach a toast.
  test('failure notifications carry no raw path or errno', async () => {
    const { deps, rec } = harness({
      writeFile: async () => {
        throw new Error('EACCES: permission denied, open /home/dev/.tokengauge/x');
      },
    });
    await runSetupClaudeStatusline(deps);
    const text = rec.errors.join('\n');
    assert.ok(!text.includes('/home/dev'), 'no raw path in the notification');
    assert.ok(!/EACCES/.test(text), 'no errno in the notification');
  });

  test('a settings write failure still reports what did succeed', async () => {
    const { deps, rec } = harness({
      writeSnapshotPathSetting: async () => {
        throw new Error('nope');
      },
    });
    const result = await runSetupClaudeStatusline(deps);
    assert.equal(result.wroteWriter, true);
    assert.equal(result.wroteSetting, false);
    assert.equal(rec.reports.length, 1, 'the user still gets the paste instructions');
    const report = rec.reports.join('\n');
    assert.ok(
      !report.includes('Set `tokenGauge.claude.statuslineSnapshotPath`'),
      'must not falsely claim the setting was saved',
    );
    assert.match(report, /Could not save `tokenGauge\.claude\.statuslineSnapshotPath`/);
    assert.match(report, /Set it manually/);
  });
});
