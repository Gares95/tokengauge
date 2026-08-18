import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeStatuslineSnapshotSchema } from '../../../src/bridge/ClaudeStatuslineSnapshotSchema';
import { readSnapshotDirectoryCandidate } from '../../../src/core/cockpit/readSnapshotDirectory';
import { readStatuslineSnapshotCandidate } from '../../../src/core/cockpit/readStatuslineSnapshot';
import { IdHasher } from '../../../src/security/IdHasher';
import { findRepoRoot } from '../../_helpers/repoRoot';

const repoRoot = findRepoRoot();
const writerPath = path.join(repoRoot, 'src', 'bridge', 'claude-statusline-writer.example.mjs');
const readmePath = path.join(repoRoot, 'README.md');
const fixturePath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'statusline',
  'official-claude-statusline-payload.json',
);
const payload = readFileSync(fixturePath, 'utf8');
const payloadObject = JSON.parse(payload) as Record<string, unknown>;
const hasher = new IdHasher('writer-test-salt-0123456789');
const now = (): Date => new Date('2026-07-13T12:00:00.000Z');

function hash16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function runWriter(args: readonly string[], input = payload) {
  return spawnSync(process.execPath, [writerPath, ...args], {
    input,
    encoding: 'utf8',
    cwd: repoRoot,
  });
}

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'tokengauge-writer-'));
}

function readSnapshot(file: string): ReturnType<typeof ClaudeStatuslineSnapshotSchema.parse> {
  return ClaudeStatuslineSnapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

function assertPrivateInputAbsent(text: string): void {
  for (const forbidden of [
    'TG_RAW_SESSION_SHOULD_NOT_APPEAR',
    'TG_TRANSCRIPT_PATH_SHOULD_NOT_APPEAR',
    'TG_RAW_CWD_SHOULD_NOT_APPEAR',
    'TG_RAW_WORKSPACE_CURRENT_SHOULD_NOT_APPEAR',
    'TG_RAW_WORKSPACE_PROJECT_SHOULD_NOT_APPEAR',
    'TG_REPO_OWNER_SHOULD_NOT_APPEAR',
    'TG_REPO_NAME_SHOULD_NOT_APPEAR',
    'current_usage',
    'total_duration_ms',
    'total_api_duration_ms',
    'total_lines_added',
    'total_lines_removed',
    'transcript_path',
    '"cwd"',
    '"workspace"',
  ]) {
    assert.ok(!text.includes(forbidden), `output must not include ${forbidden}`);
  }
}

function assertPrivateErrorAbsent(text: string): void {
  for (const forbidden of [
    'TG_RAW_SESSION_SHOULD_NOT_APPEAR',
    'TG_RAW_CWD_SHOULD_NOT_APPEAR',
    'TG_RAW_WORKSPACE_CURRENT_SHOULD_NOT_APPEAR',
    'TG_RAW_WORKSPACE_PROJECT_SHOULD_NOT_APPEAR',
  ]) {
    assert.ok(!text.includes(forbidden), `error must not include ${forbidden}`);
  }
}

function assertNoTempLeft(dir: string): void {
  const leftovers = readdirSync(dir).filter((entry) => entry.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
}

function modeIsPrivate(file: string): boolean {
  if (process.platform === 'win32') return true;
  return (statSync(file).mode & 0o077) === 0;
}

function extractBetween(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker ${start}`);
  const bodyStart = startIndex + start.length;
  const endIndex = text.indexOf(end, bodyStart);
  assert.notEqual(endIndex, -1, `missing end marker ${end}`);
  return text
    .slice(bodyStart, endIndex)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '');
}

// The README carries the writer body EXACTLY ONCE. Every platform copies that
// one block, so there is no second copy able to drift away from the canonical
// source; the PowerShell section saves and verifies this same body rather than
// repeating it.
function assertReadmeCopiesMatch(readmeText: string): void {
  const canonical = readFileSync(writerPath, 'utf8').trimEnd();
  const bashBody = extractBetween(
    readmeText,
    "cat > ~/.tokengauge/claude/claude-statusline-writer.mjs <<'TOKENGAUGE_STATUSLINE'",
    '\nTOKENGAUGE_STATUSLINE\n',
  );
  assert.equal(bashBody, canonical, 'README writer body must match canonical source');
  assert.equal(
    readmeText.split('TOKENGAUGE_STATUSLINE_WRITER_START').length - 1,
    1,
    'the README must carry exactly one writer body',
  );
}

// The writer's stdout IS the user's whole Claude status line (Claude Code renders
// the first stdout line of statusLine.command), so the format is a user-facing
// contract. It must carry the account-level windows, name each window, omit an
// unreported window rather than fabricate 0%, and stay identical across
// concurrent sessions on one account.
suite('Claude statusLine canonical writer: status line output', () => {
  // Session-local values would make the line differ between concurrent sessions
  // and would imply the account-level percentages belong to one session.
  function statusLineFor(rateLimits: unknown, modelId = 'claude-opus-4-1'): string {
    const dir = tempDir();
    try {
      const input = JSON.stringify({
        ...payloadObject,
        model: { id: modelId, display_name: 'Display Name' },
        rate_limits: rateLimits,
      });
      const result = runWriter(['--file', path.join(dir, 'snapshot.json')], input);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('both windows render as account-level percentages, each window named', () => {
    const line = statusLineFor({
      five_hour: { used_percentage: 32 },
      seven_day: { used_percentage: 12 },
    });
    assert.equal(line, '32% 5h · 12% wk\n');
  });

  test('a 5h-only account reports just that window', () => {
    assert.equal(statusLineFor({ five_hour: { used_percentage: 32 } }), '32% 5h\n');
  });

  test('a weekly-only account reports just that window, never mislabelled 5h', () => {
    const line = statusLineFor({ seven_day: { used_percentage: 12 } });
    assert.equal(line, '12% wk\n');
    assert.ok(!line.includes('5h'), 'a weekly value must never carry the 5h label');
  });

  // rate_limits is absent for API-key/Console sessions and before the session's
  // first response. That is normal, so it must read honestly rather than as 0%,
  // and it still confirms the writer ran.
  test('no rate_limits reads honestly instead of fabricating a zero', () => {
    const line = statusLineFor(undefined);
    assert.equal(line, 'no limit fields yet\n');
    assert.ok(!line.includes('%'), 'never a percentage when none was reported');
  });

  test('an unreported window is omitted, never rendered as 0%', () => {
    const line = statusLineFor({ seven_day: { used_percentage: 12 } });
    assert.ok(!line.includes('0% 5h'), 'a missing window must not become 0%');
  });

  // A window Claude Code genuinely reports as 0 is a real value, not an absence.
  test('a genuine zero is reported as a value', () => {
    assert.equal(statusLineFor({ five_hour: { used_percentage: 0 } }), '0% 5h\n');
  });

  test('an exhausted window is reported plainly at 100%', () => {
    const line = statusLineFor({
      five_hour: { used_percentage: 41 },
      seven_day: { used_percentage: 100 },
    });
    assert.equal(line, '41% 5h · 100% wk\n');
  });

  // The property that keeps multi-session use coherent: same account, different
  // session models, identical line. A session-local value would break this.
  test('the line is identical across sessions running different models', () => {
    const windows = {
      five_hour: { used_percentage: 32 },
      seven_day: { used_percentage: 12 },
    };
    const opus = statusLineFor(windows, 'claude-opus-4-1');
    const haiku = statusLineFor(windows, 'claude-haiku-4-5');
    assert.equal(opus, haiku, 'concurrent sessions on one account must agree');
    assert.ok(!opus.includes('opus') && !haiku.includes('haiku'), 'no session-local model');
  });

  test('the status line carries no session-local model, context, or cost', () => {
    const line = statusLineFor({ five_hour: { used_percentage: 32 } });
    for (const forbidden of ['claude', 'opus', 'Display Name', '12.34', '$', '38%', '200000']) {
      assert.ok(!line.includes(forbidden), `status line must not carry ${forbidden}`);
    }
  });

  // Dropping them from the LINE must not drop them from the snapshot: the cards
  // and the status bar hover still read model/cost/context from the file.
  test('the snapshot still carries the model, cost, and context for the cards', () => {
    const dir = tempDir();
    try {
      const output = path.join(dir, 'snapshot.json');
      assert.equal(runWriter(['--file', output]).status, 0);
      const snapshot = readSnapshot(output);
      assert.equal(snapshot.model.id, 'claude-opus-4-1');
      assert.equal(snapshot.cost?.total_cost_usd, 12.34);
      assert.equal(snapshot.context_window?.used_percentage, 38);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A failed write must not print a status line that implies success.
  test('a failed write prints nothing to stdout and exits non-zero', () => {
    const result = runWriter(['--file', ''], payload);
    assert.notEqual(result.status, 0, 'must not report success');
    assert.equal(result.stdout, '', 'no status line on failure');
    assertPrivateErrorAbsent(result.stderr);
  });
});

suite('Claude statusLine canonical writer', () => {
  test('file mode writes a schema-valid snapshot consumed by the live reader', () => {
    const dir = tempDir();
    try {
      const output = path.join(dir, 'statusline-snapshot.json');
      const result = runWriter(['--file', output]);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '64% 5h · 29% wk\n');
      assertPrivateErrorAbsent(result.stderr);
      assertNoTempLeft(dir);
      assert.ok(modeIsPrivate(output), 'snapshot file must not be group/world accessible');

      const raw = readFileSync(output, 'utf8');
      assertPrivateInputAbsent(raw);
      const snapshot = readSnapshot(output);
      assert.equal(snapshot.model.id, 'claude-opus-4-1');
      assert.equal(snapshot.rate_limits?.five_hour?.used_percentage, 64);
      assert.equal(snapshot.rate_limits?.five_hour?.resets_at, 1781110800);
      assert.equal(snapshot.rate_limits?.five_hour?.resets_at_iso, undefined);
      assert.equal(snapshot.cost?.total_cost_usd, 12.34);
      assert.equal(snapshot.context_window?.context_window_size, 200000);
      assert.match(snapshot.session_id_hash ?? '', /^[0-9a-f]{16}$/);
      assert.match(snapshot.workspace_hash ?? '', /^[0-9a-f]{16}$/);

      const reader = readStatuslineSnapshotCandidate(output, {
        readFile: (file) => readFileSync(file, 'utf8'),
        hasher,
        now,
      });
      assert.equal(reader.status, 'statusline_snapshot_loaded');
      assert.equal(reader.candidate?.session?.usedPct, 64);
      assert.equal(reader.candidate?.session?.resetsAt, '2026-06-10T17:00:00.000Z');
      assert.equal(reader.candidate?.weekly?.usedPct, 29);
      assert.equal(
        reader.candidate?.workspaceHash,
        hash16('TG_RAW_WORKSPACE_PROJECT_SHOULD_NOT_APPEAR'),
      );
      assert.equal(reader.candidate?.sessionHash, hash16('TG_RAW_SESSION_SHOULD_NOT_APPEAR'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('file mode atomically replaces an existing snapshot', () => {
    const dir = tempDir();
    try {
      const output = path.join(dir, 'statusline-snapshot.json');
      writeFileSync(output, '{"old":true}\n');

      const result = runWriter(['--file', output]);

      assert.equal(result.status, 0, result.stderr);
      assertNoTempLeft(dir);
      const snapshot = readSnapshot(output);
      assert.equal(snapshot.model.id, 'claude-opus-4-1');
      assert.equal((snapshot as unknown as { old?: boolean }).old, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('directory mode writes hash-derived filenames consumed by the live reader', () => {
    const dir = tempDir();
    try {
      const outputDir = path.join(dir, 'snapshots');
      const result = runWriter(['--dir', outputDir]);

      assert.equal(result.status, 0, result.stderr);
      assert.ok(modeIsPrivate(outputDir), 'snapshot directory must not be group/world accessible');
      const expectedName = `${hash16('TG_RAW_WORKSPACE_PROJECT_SHOULD_NOT_APPEAR')}-${hash16(
        'TG_RAW_SESSION_SHOULD_NOT_APPEAR',
      )}.json`;
      assert.deepEqual(readdirSync(outputDir), [expectedName]);
      assert.ok(!expectedName.includes('TG_RAW'));
      assertNoTempLeft(outputDir);

      const output = path.join(outputDir, expectedName);
      assertPrivateInputAbsent(readFileSync(output, 'utf8'));
      const directoryResult = readSnapshotDirectoryCandidate(outputDir, {
        listDir: (dirPath) =>
          readdirSync(dirPath).map((name) => ({
            name,
            mtimeMs: statSync(path.join(dirPath, name)).mtimeMs,
          })),
        readFile: (file) => readFileSync(file, 'utf8'),
        join: path.join,
        hasher,
        now: () => new Date(),
      });
      assert.equal(directoryResult.status, 'snapshot_dir_loaded');
      assert.equal(directoryResult.activeWriters, 1);
      assert.equal(directoryResult.candidate?.session?.usedPct, 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('directory mode uses deterministic safe filenames for missing and malicious identifiers', () => {
    const dir = tempDir();
    try {
      const outputDir = path.join(dir, 'snapshots');
      const altered = {
        ...payloadObject,
        session_id: '../bad\\session:id',
        workspace: { project_dir: '..\\bad/workspace:name' },
      };
      const first = runWriter(['--dir', outputDir], JSON.stringify(altered));
      const second = runWriter(['--dir', outputDir], JSON.stringify(altered));

      assert.equal(first.status, 0, first.stderr);
      assert.equal(second.status, 0, second.stderr);
      const files = readdirSync(outputDir);
      assert.equal(files.length, 1);
      assert.match(files[0] ?? '', /^[0-9a-f]{16}-[0-9a-f]{16}\.json$/);
      assert.ok(!(files[0] ?? '').includes('..'));
      assert.ok(!(files[0] ?? '').includes('\\'));
      assert.ok(!(files[0] ?? '').includes(':'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing optional identifiers still produce deterministic directory output', () => {
    const dir = tempDir();
    try {
      const outputDir = path.join(dir, 'snapshots');
      const altered = { ...payloadObject };
      delete altered.session_id;
      delete altered.workspace;
      delete altered.cwd;

      const result = runWriter(['--dir', outputDir], JSON.stringify(altered));

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readdirSync(outputDir), [`${hash16('none')}-${hash16('none')}.json`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('invalid input and invalid targets fail without echoing sensitive input', () => {
    const dir = tempDir();
    try {
      const badJson = runWriter(
        ['--file', path.join(dir, 'out.json')],
        '{"cwd":"TG_RAW_CWD_SHOULD_NOT_APPEAR"',
      );
      assert.notEqual(badJson.status, 0);
      assert.match(badJson.stderr, /invalid payload/);
      assertPrivateErrorAbsent(badJson.stderr);

      const missingModel = { ...payloadObject };
      delete missingModel.model;
      const invalidPayload = runWriter(
        ['--file', path.join(dir, 'missing-model.json')],
        JSON.stringify(missingModel),
      );
      assert.notEqual(invalidPayload.status, 0);
      assert.match(invalidPayload.stderr, /invalid payload/);
      assertPrivateErrorAbsent(invalidPayload.stderr);

      const invalidArgs = runWriter(['--file', path.join(dir, 'a.json'), '--dir', dir]);
      assert.equal(invalidArgs.status, 2);
      assert.match(invalidArgs.stderr, /invalid arguments/);

      const parentFile = path.join(dir, 'not-a-directory');
      writeFileSync(parentFile, 'x');
      const writeFailure = runWriter(['--file', path.join(parentFile, 'out.json')]);
      assert.notEqual(writeFailure.status, 0);
      assert.match(writeFailure.stderr, /write failed|invalid target/);
      assertPrivateErrorAbsent(writeFailure.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses symlinked final outputs', function () {
    if (process.platform === 'win32') {
      this.skip();
    }

    const dir = tempDir();
    try {
      const real = path.join(dir, 'real.json');
      const link = path.join(dir, 'link.json');
      writeFileSync(real, '{}\n');
      symlinkSync(real, link);

      const result = runWriter(['--file', link]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid target/);
      assert.equal(readFileSync(real, 'utf8'), '{}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('source has no network, process-spawn, shell, or provider SDK dependency', () => {
    const source = readFileSync(writerPath, 'utf8');
    for (const forbidden of [
      'node:child_process',
      'node:http',
      'node:https',
      'node:net',
      'node:dns',
      'fetch(',
      'XMLHttpRequest',
      'spawn(',
      'exec(',
      'from "openai"',
      "from 'openai'",
      'from "anthropic"',
      "from 'anthropic'",
    ]) {
      assert.ok(!source.includes(forbidden), `writer source must not include ${forbidden}`);
    }
  });

  test('the README carries exactly one writer body, matching canonical', () => {
    const readme = readFileSync(readmePath, 'utf8');
    assertReadmeCopiesMatch(readme);

    assert.throws(() =>
      assertReadmeCopiesMatch(readme.replace("parts.join(' · ')", "parts.join(' mutated ')")),
    );
  });
});
