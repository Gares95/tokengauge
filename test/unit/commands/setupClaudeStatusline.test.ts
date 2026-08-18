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
    assert.match(
      json,
      /node \/home\/dev\/\.tokengauge\/claude\/w\.mjs --file \/home\/dev\/s\.json/,
    );
  });

  test('Windows paths are emitted with forward slashes so the JSON needs no escaping', () => {
    const json = statusLineCommandJson('C:\\Users\\dev\\w.mjs', 'C:\\Users\\dev\\s.json');
    assert.ok(!json.includes('\\'), `no backslashes in the pasted JSON: ${json}`);
    assert.match(json, /C:\/Users\/dev\/w\.mjs/);
  });

  // The scope trap: in a Remote/WSL/Dev Container window the extension host does
  // not read local User settings, which is the most common reason a
  // correct-looking setup shows nothing.
  test('writes the setting to the scope the extension host actually reads', async () => {
    const { deps, rec } = harness({ targetScope: () => 'workspace', remoteName: () => 'wsl' });
    await runSetupClaudeStatusline(deps);
    assert.equal(rec.settings[0]?.scope, 'workspace');
    assert.match(rec.reports.join('\n'), /Workspace/);
    assert.match(rec.reports.join('\n'), /wsl/, 'names the remote so the choice is explicable');
  });

  test('a local window uses User scope and says nothing about remotes', async () => {
    const { deps, rec } = harness();
    await runSetupClaudeStatusline(deps);
    assert.equal(rec.settings[0]?.scope, 'user');
    assert.ok(!/remote/i.test(rec.reports.join('\n')));
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
  });
});
