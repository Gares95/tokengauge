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

function assertReadmeCopiesMatch(readmeText: string): void {
  const canonical = readFileSync(writerPath, 'utf8').trimEnd();
  const bashBody = extractBetween(
    readmeText,
    "cat > ~/.tokengauge/claude/claude-statusline-writer.mjs <<'TOKENGAUGE_STATUSLINE'",
    '\nTOKENGAUGE_STATUSLINE\n',
  );
  const powerShellBody = extractBetween(
    readmeText,
    "@'\n",
    "\n'@ | Set-Content -Path $writer -Encoding utf8",
  );
  assert.equal(bashBody, canonical, 'README Bash writer body must match canonical source');
  assert.equal(
    powerShellBody,
    canonical,
    'README PowerShell writer body must match canonical source',
  );
}

suite('Claude statusLine canonical writer', () => {
  test('file mode writes a schema-valid snapshot consumed by the live reader', () => {
    const dir = tempDir();
    try {
      const output = path.join(dir, 'statusline-snapshot.json');
      const result = runWriter(['--file', output]);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'TokenGauge snapshot updated\n');
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

  test('README Bash and PowerShell bodies match the canonical writer exactly', () => {
    const readme = readFileSync(readmePath, 'utf8');
    assertReadmeCopiesMatch(readme);

    assert.throws(() =>
      assertReadmeCopiesMatch(
        readme.replace('TokenGauge snapshot updated', 'mutated snapshot updated'),
      ),
    );
  });
});
