// Per-session snapshot DIRECTORY mode. One snapshot file
// per Claude Code session gives TokenGauge a real active-session signal — the
// multiple-writers state persists while >=2 sessions are alive (even when both
// are IDLE, which single-file interleave detection can never prove) and clears
// within the active TTL once a session closes. These tests pin the pure reader:
// strict filename pattern, mtime TTL, per-file fail-closed parsing, the
// deterministic conservative merge, and the privacy shape of the merged output.

import * as assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createClaudeSnapshotStabilityGate } from '../../../src/cockpit/ClaudeSnapshotStabilityGate';
import {
  ACTIVE_WRITER_TTL_MS,
  listSnapshotDirectory,
  MAX_SNAPSHOT_FILES,
  readSnapshotDirectoryCandidate,
  SNAPSHOT_FILE_PATTERN,
  type SnapshotDirEntry,
} from '../../../src/core/cockpit/readSnapshotDirectory';
import { resolve, type SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';
import { IdHasher } from '../../../src/security/IdHasher';

const NOW = new Date('2026-07-04T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const hasher = new IdHasher('test-salt-0123456789');

const DIR = '/cfg/snapshots';
const join = (...parts: string[]) => parts.join('/');

const WS = 'aaaaaaaaaaaaaaaa';
const S1 = '1111111111111111';
const S2 = '2222222222222222';

// A valid per-session snapshot body (same strict schema as single-file mode).
function snapshotBody(over: {
  sessionHash: string;
  usedPct?: number;
  resetsAtIso?: string;
  model?: string;
  costUsd?: number;
  contextUsedPct?: number;
  omitRateLimits?: boolean;
}): string {
  return JSON.stringify({
    source: 'claude_statusline',
    timestamp: NOW.toISOString(),
    session_id_hash: over.sessionHash,
    workspace_hash: WS,
    model: { id: over.model ?? 'claude-fable-5' },
    ...(over.costUsd !== undefined ? { cost: { total_cost_usd: over.costUsd } } : {}),
    ...(over.omitRateLimits
      ? {}
      : {
          rate_limits: {
            five_hour: {
              used_percentage: over.usedPct ?? 50,
              resets_at_iso: over.resetsAtIso ?? '2026-07-04T15:00:00.000Z',
            },
          },
        }),
    ...(over.contextUsedPct !== undefined
      ? { context_window: { used_percentage: over.contextUsedPct } }
      : {}),
  });
}

function fileName(sessionHash: string): string {
  return `${WS}-${sessionHash}.json`;
}

// A tiny injected filesystem: entries + bodies keyed by name.
function fsOf(files: Array<{ name: string; mtimeMs: number; body?: string }>) {
  const bodies = new Map(files.map((f) => [join(DIR, f.name), f.body]));
  return {
    listDir: (path: string): readonly SnapshotDirEntry[] => {
      assert.equal(path, DIR, 'must list ONLY the configured directory');
      return files.map(({ name, mtimeMs }) => ({ name, mtimeMs }));
    },
    readFile: (path: string): string => {
      const body = bodies.get(path);
      if (body === undefined) throw new Error('missing');
      return body;
    },
  };
}

function read(files: Array<{ name: string; mtimeMs: number; body?: string }>, nowMs = NOW_MS) {
  const fs = fsOf(files);
  return readSnapshotDirectoryCandidate(DIR, {
    listDir: fs.listDir,
    readFile: fs.readFile,
    join,
    hasher,
    now: () => new Date(nowMs),
  });
}

suite('ReadSnapshotDirectory — active-writer detection', () => {
  test('Two RECENT per-session snapshots → multi-writer, no interleaving required', () => {
    // Both sessions idle-but-open: each file was refreshed recently; there is
    // no write alternation at all. The state must still be multi-writer.
    const out = read([
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 10_000,
        body: snapshotBody({ sessionHash: S1, usedPct: 80 }),
      },
      {
        name: fileName(S2),
        mtimeMs: NOW_MS - 20_000,
        body: snapshotBody({ sessionHash: S2, usedPct: 60 }),
      },
    ]);
    assert.equal(out.status, 'snapshot_dir_multi_writer');
    assert.equal(out.activeWriters, 2);
    assert.equal(out.candidate?.unavailableReason, 'snapshot_writer_collision');
    // Conservative account-level 5h: MAX across the active writers.
    assert.equal(out.candidate?.session?.usedPct, 80);
  });

  test('One recent writer + one EXPIRED writer → Live single-session view', () => {
    const out = read([
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 5_000,
        body: snapshotBody({
          sessionHash: S1,
          usedPct: 42,
          model: 'claude-fable-5',
          costUsd: 1.5,
          contextUsedPct: 30,
        }),
      },
      {
        name: fileName(S2),
        mtimeMs: NOW_MS - (ACTIVE_WRITER_TTL_MS + 5_000),
        body: snapshotBody({ sessionHash: S2, usedPct: 99 }),
      },
    ]);
    assert.equal(out.status, 'snapshot_dir_loaded');
    assert.equal(out.activeWriters, 1);
    assert.equal(out.candidate?.unavailableReason, undefined);
    // The expired writer's higher value does NOT bleed into the live view; the
    // session-specific fields are the single live session's own.
    assert.equal(out.candidate?.session?.usedPct, 42);
    assert.equal(out.candidate?.model, 'claude-fable-5');
    assert.equal(out.candidate?.cost, 1.5);
    assert.equal(out.candidate?.context?.usedPct, 30);
  });

  test('Prune-on-tick: the SAME files read after the TTL passes drop the departed writer', () => {
    const files = [
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 5_000,
        body: snapshotBody({ sessionHash: S1, usedPct: 70 }),
      },
      {
        name: fileName(S2),
        mtimeMs: NOW_MS - 15_000,
        body: snapshotBody({ sessionHash: S2, usedPct: 60 }),
      },
    ];
    // Both active now → multi-writer.
    assert.equal(read(files).status, 'snapshot_dir_multi_writer');
    // Session 2 closes (its file stops refreshing). Any tick after the TTL —
    // a scheduled poll OR a manual Refresh — prunes it immediately: the
    // evaluation is stateless over mtimes, no second quiet period exists.
    const later = NOW_MS + ACTIVE_WRITER_TTL_MS + 1_000;
    const refreshed = read(
      [
        { ...files[0], mtimeMs: later - 5_000 } as (typeof files)[number],
        files[1] as (typeof files)[number],
      ],
      later,
    );
    assert.equal(refreshed.status, 'snapshot_dir_loaded');
    assert.equal(refreshed.activeWriters, 1);
    assert.equal(refreshed.candidate?.unavailableReason, undefined);
  });

  test('Multi-writer merge MUTES the session-specific fields and carries no identity', () => {
    const out = read([
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 5_000,
        body: snapshotBody({
          sessionHash: S1,
          usedPct: 80,
          model: 'claude-fable-5',
          costUsd: 9.99,
          contextUsedPct: 70,
        }),
      },
      {
        name: fileName(S2),
        mtimeMs: NOW_MS - 6_000,
        body: snapshotBody({
          sessionHash: S2,
          usedPct: 60,
          model: 'claude-opus-4-8',
          costUsd: 1.11,
          contextUsedPct: 10,
        }),
      },
    ]);
    const c = out.candidate;
    assert.ok(c);
    // Session-specific fields belong to no one session → omitted entirely.
    assert.equal(c?.model, undefined);
    assert.equal(c?.scope.model, undefined);
    assert.equal(c?.cost, undefined);
    assert.equal(c?.context, undefined);
    // No identity hashes on the merged candidate (privacy + no false identity).
    assert.equal(c?.sessionHash, undefined);
    assert.equal(c?.workspaceHash, undefined);
  });

  test('The newest reset window wins the merge (a stale pre-reset cache never masks it)', () => {
    const out = read([
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 5_000,
        body: snapshotBody({
          sessionHash: S1,
          usedPct: 12,
          resetsAtIso: '2026-07-04T17:00:00.000Z',
        }),
      },
      {
        name: fileName(S2),
        mtimeMs: NOW_MS - 6_000,
        // Older window with a scarier number — must not win.
        body: snapshotBody({
          sessionHash: S2,
          usedPct: 96,
          resetsAtIso: '2026-07-04T12:30:00.000Z',
        }),
      },
    ]);
    assert.equal(out.candidate?.session?.usedPct, 12);
    assert.equal(out.candidate?.session?.resetsAt, '2026-07-04T17:00:00.000Z');
  });

  test('Only strict hash-pattern names are read; other files are ignored unread', () => {
    let reads = 0;
    const files = [
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 5_000,
        body: snapshotBody({ sessionHash: S1, usedPct: 44 }),
      },
      { name: 'notes.txt', mtimeMs: NOW_MS - 1_000, body: 'raw /home/user/path secrets' },
      { name: `${WS}-${S2}.json.tmp`, mtimeMs: NOW_MS - 1_000, body: 'torn' },
      { name: 'UPPER-CASE.JSON', mtimeMs: NOW_MS - 1_000, body: '{}' },
    ];
    const fs = fsOf(files);
    const out = readSnapshotDirectoryCandidate(DIR, {
      listDir: fs.listDir,
      readFile: (p) => {
        reads += 1;
        return fs.readFile(p);
      },
      join,
      hasher,
      now: () => NOW,
    });
    assert.equal(out.status, 'snapshot_dir_loaded');
    assert.equal(reads, 1, 'exactly one pattern-matching file may be read');
  });

  test('A torn/unparseable file fails closed for that file only (transient, no flap to error)', () => {
    const out = read([
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 5_000,
        body: snapshotBody({ sessionHash: S1, usedPct: 44, model: 'claude-fable-5' }),
      },
      { name: fileName(S2), mtimeMs: NOW_MS - 5_000, body: '{ torn mid-rename' },
    ]);
    // The torn file contributes no value and does not break the healthy one,
    // but its fresh mtime proves a second session is writing: the state stays
    // multi-writer (session-specific fields muted), never a lone Live session.
    assert.equal(out.status, 'snapshot_dir_multi_writer');
    assert.equal(out.activeWriters, 2);
    assert.equal(out.candidate?.unavailableReason, 'snapshot_writer_collision');
    assert.equal(out.candidate?.session?.usedPct, 44);
    assert.equal(out.candidate?.model, undefined);
  });

  test('A single active pre-first-response session reads as missing_rate_limits', () => {
    const out = read([
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 5_000,
        body: snapshotBody({ sessionHash: S1, omitRateLimits: true }),
      },
    ]);
    assert.equal(out.status, 'snapshot_dir_missing_rate_limits');
    assert.equal(out.activeWriters, 1);
    assert.equal(out.candidate?.unavailableReason, 'statusline_snapshot_missing_rate_limits');
  });

  test('All files expired → no active writer; unreadable directory → unreadable', () => {
    const expired = read([
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - (ACTIVE_WRITER_TTL_MS + 60_000),
        body: snapshotBody({ sessionHash: S1 }),
      },
    ]);
    assert.equal(expired.status, 'snapshot_dir_no_active_writer');
    assert.equal(expired.candidate, undefined);

    const unreadable = readSnapshotDirectoryCandidate(DIR, {
      listDir: () => {
        throw new Error('EACCES');
      },
      readFile: () => '',
      join,
      hasher,
      now: () => NOW,
    });
    assert.equal(unreadable.status, 'snapshot_dir_unreadable');
  });

  // Regression: the merged multi-writer candidate was stamped with the READ
  // time, so samples whose writer timestamps were long past rendered fresh and
  // high-confidence once two of them were merged, while either one alone
  // rendered stale. A merge must never be fresher than its oldest input.
  test('The merged multi-writer value is never fresher than its oldest sample', () => {
    const aged = (minutes: number) => new Date(NOW_MS - minutes * 60_000).toISOString();
    const withTimestamp = (sessionHash: string, usedPct: number, ts: string) =>
      JSON.stringify({ ...JSON.parse(snapshotBody({ sessionHash, usedPct })), timestamp: ts });
    const files = [
      { name: fileName(S1), mtimeMs: NOW_MS - 5_000, body: withTimestamp(S1, 40, aged(20)) },
      { name: fileName(S2), mtimeMs: NOW_MS - 6_000, body: withTimestamp(S2, 50, aged(12)) },
    ];
    const single = read(files.slice(0, 1));
    const merged = read(files);
    assert.equal(merged.status, 'snapshot_dir_multi_writer');
    assert.equal(merged.candidate?.producedAtMs, NOW_MS - 20 * 60_000);

    const ctx = { now: () => NOW };
    const singleState = resolve([single.candidate as SourceCandidate], ctx);
    const mergedState = resolve([merged.candidate as SourceCandidate], ctx);
    assert.equal(singleState.session.usedPct.reason, 'native_status_stale');
    assert.equal(mergedState.session.usedPct.reason, 'native_status_stale');
    assert.equal(mergedState.session.usedPct.confidence, 'low');
  });

  test('Fresh writers merge to a fresh value (normal multi-session operation unchanged)', () => {
    const out = read([
      {
        name: fileName(S1),
        mtimeMs: NOW_MS - 5_000,
        body: snapshotBody({ sessionHash: S1, usedPct: 40 }),
      },
      {
        name: fileName(S2),
        mtimeMs: NOW_MS - 6_000,
        body: snapshotBody({ sessionHash: S2, usedPct: 50 }),
      },
    ]);
    const state = resolve([out.candidate as SourceCandidate], { now: () => NOW });
    assert.equal(state.session.usedPct.reason, undefined);
    assert.equal(state.session.usedPct.value, 50);
  });

  test('More snapshot files than the cap → too_many_files, never an arbitrary subset', () => {
    // 40 historical sessions plus one live one: the reader must not pick from
    // a truncated listing; it reports the bounded inspection was exceeded.
    const hex16 = (n: number) => n.toString(16).padStart(16, '0');
    const files = Array.from({ length: MAX_SNAPSHOT_FILES + 8 }, (_, i) => ({
      name: `${WS}-${hex16(i + 1)}.json`,
      mtimeMs: NOW_MS - 3 * 86_400_000,
      body: snapshotBody({ sessionHash: hex16(i + 1) }),
    }));
    files.push({
      name: fileName(S1),
      mtimeMs: NOW_MS - 5_000,
      body: snapshotBody({ sessionHash: S1, usedPct: 42 }),
    });
    const out = read(files);
    assert.equal(out.status, 'snapshot_dir_too_many_files');
    assert.equal(out.candidate, undefined, 'no value is offered when inspection is incomplete');
    assert.equal(out.activeWriters, 0);
  });

  test('Exactly the cap is still inspected; non-snapshot names never count toward it', () => {
    const hex16 = (n: number) => n.toString(16).padStart(16, '0');
    const files = Array.from({ length: MAX_SNAPSHOT_FILES - 1 }, (_, i) => ({
      name: `${WS}-${hex16(i + 1)}.json`,
      mtimeMs: NOW_MS - 3 * 86_400_000,
      body: snapshotBody({ sessionHash: hex16(i + 1) }),
    }));
    files.push({
      name: fileName(S1),
      mtimeMs: NOW_MS - 5_000,
      body: snapshotBody({ sessionHash: S1, usedPct: 42 }),
    });
    // Writer temp files and unrelated names are ignored entirely.
    for (let i = 0; i < 100; i += 1) {
      files.push({ name: `.${fileName(S2)}.tmp-${i}`, mtimeMs: NOW_MS, body: '{' });
    }
    const out = read(files);
    assert.equal(out.status, 'snapshot_dir_loaded');
    assert.equal(out.candidate?.session?.usedPct, 42);
  });

  test('Exposes the documented TTL, cap, and strict filename pattern', () => {
    assert.equal(ACTIVE_WRITER_TTL_MS, 90_000);
    assert.ok(MAX_SNAPSHOT_FILES <= 64, 'listing must stay bounded');
    assert.ok(SNAPSHOT_FILE_PATTERN.test('aaaaaaaaaaaaaaaa-1111111111111111.json'));
    assert.ok(!SNAPSHOT_FILE_PATTERN.test('anything-else.json'));
    assert.ok(!SNAPSHOT_FILE_PATTERN.test('aaaaaaaaaaaaaaaa-1111111111111111.json.tmp'));
    assert.ok(!SNAPSHOT_FILE_PATTERN.test('/etc/aaaaaaaaaaaaaaaa-1111111111111111.json'));
  });
});

// The shared production lister against a REAL temporary directory (ext4/tmpfs/
// NTFS readdir order is filesystem-defined, so a readdir-order cap can hide the
// live session; the lister must never truncate).
suite('ReadSnapshotDirectory — bounded production lister on a real directory', () => {
  const hex16 = (n: number) => n.toString(16).padStart(16, '0');

  function withTempDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), 'tokengauge-snapdir-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function writeSnapshot(dir: string, session: string, ageMs: number, usedPct = 50): string {
    const name = `${WS}-${session}.json`;
    const file = path.join(dir, name);
    writeFileSync(file, snapshotBody({ sessionHash: session, usedPct }));
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(file, t, t);
    return name;
  }

  function readReal(dir: string, statEntry: (p: string) => Stats = statSync) {
    let stats = 0;
    const result = readSnapshotDirectoryCandidate(dir, {
      listDir: (p) =>
        listSnapshotDirectory(p, {
          readdir: (d) => readdirSync(d),
          statEntry: (e) => {
            stats += 1;
            return statEntry(e);
          },
          join: path.join,
        }),
      readFile: (p) => readFileSync(p, 'utf8'),
      join: path.join,
      hasher,
      now: () => new Date(),
    });
    return { result, stats };
  }

  test('Over the cap: reported as too_many_files with zero per-entry stats', () => {
    withTempDir((dir) => {
      for (let i = 0; i < 200; i += 1) writeSnapshot(dir, hex16(i + 1), 3 * 86_400_000);
      writeSnapshot(dir, S1, 1_000, 42);
      const { result, stats } = readReal(dir);
      assert.equal(result.status, 'snapshot_dir_too_many_files');
      assert.equal(result.candidate, undefined);
      assert.equal(stats, 0, 'inspection stays bounded: nothing is stat-ed past the cap');
    });
  });

  test('Within the cap: the live session is found wherever readdir places it', () => {
    withTempDir((dir) => {
      for (let i = 0; i < MAX_SNAPSHOT_FILES - 1; i += 1) {
        writeSnapshot(dir, hex16(i + 1), 3 * 86_400_000);
      }
      writeSnapshot(dir, S1, 1_000, 42);
      const { result, stats } = readReal(dir);
      assert.equal(result.status, 'snapshot_dir_loaded');
      assert.equal(result.candidate?.session?.usedPct, 42);
      assert.equal(stats, MAX_SNAPSHOT_FILES);
    });
  });

  test('An entry deleted between readdir and stat fails closed for that entry only', () => {
    withTempDir((dir) => {
      writeSnapshot(dir, S1, 1_000, 42);
      const gone = writeSnapshot(dir, S2, 1_000, 99);
      const { result } = readReal(dir, (p) => {
        if (p.endsWith(gone)) rmSync(p);
        return statSync(p);
      });
      assert.equal(result.status, 'snapshot_dir_loaded');
      assert.equal(result.candidate?.session?.usedPct, 42);
    });
  });
});

// End-to-end with the stability gate: the merged multi-writer candidate keeps
// its collision state across quiet ticks (no interleaving anywhere), and the
// transition back to a single writer is one-stage Live.
suite('ReadSnapshotDirectory — idle multi-session persistence through the gate', () => {
  test('Idle-but-open sessions stay in the multi-writer state across many ticks', () => {
    let t = NOW_MS;
    const gate = createClaudeSnapshotStabilityGate({ now: () => new Date(t) });
    for (let i = 0; i < 10; i += 1) {
      const tick = read(
        [
          {
            name: fileName(S1),
            mtimeMs: t - 8_000,
            body: snapshotBody({ sessionHash: S1, usedPct: 80 }),
          },
          {
            name: fileName(S2),
            mtimeMs: t - 9_000,
            body: snapshotBody({ sessionHash: S2, usedPct: 60 }),
          },
        ],
        t,
      );
      assert.ok(tick.candidate);
      const out = gate.step([tick.candidate as NonNullable<typeof tick.candidate>]);
      const claude = out.find((c) => c.scope.agent === 'claude-code');
      assert.equal(
        claude?.unavailableReason,
        'snapshot_writer_collision',
        `tick ${i}: idle open sessions must keep the multi-writer state`,
      );
      assert.equal(claude?.session?.usedPct, 80, 'conservative value never alternates');
      t += 10_000;
    }
  });

  test('After the second session closes, the first post-TTL tick is fully Live (one stage)', () => {
    let t = NOW_MS;
    const gate = createClaudeSnapshotStabilityGate({ now: () => new Date(t) });
    const closedAt = t;
    // Two active writers → collision.
    const multi = read(
      [
        {
          name: fileName(S1),
          mtimeMs: t - 5_000,
          body: snapshotBody({ sessionHash: S1, usedPct: 80 }),
        },
        {
          name: fileName(S2),
          mtimeMs: t - 5_000,
          body: snapshotBody({ sessionHash: S2, usedPct: 60 }),
        },
      ],
      t,
    );
    gate.step([multi.candidate as NonNullable<typeof multi.candidate>]);

    // Session 2 closed at t; after the TTL its file is stale and the next tick
    // emits the surviving session's own view — Live immediately (the collision
    // reason is latch-exempt in the gate).
    t = closedAt + ACTIVE_WRITER_TTL_MS + 10_000;
    const single = read(
      [
        {
          name: fileName(S1),
          mtimeMs: t - 5_000,
          body: snapshotBody({ sessionHash: S1, usedPct: 81, model: 'claude-fable-5' }),
        },
        {
          name: fileName(S2),
          mtimeMs: closedAt - 5_000,
          body: snapshotBody({ sessionHash: S2, usedPct: 60 }),
        },
      ],
      t,
    );
    assert.equal(single.status, 'snapshot_dir_loaded');
    const out = gate.step([single.candidate as NonNullable<typeof single.candidate>]);
    const claude = out.find((c) => c.scope.agent === 'claude-code');
    assert.equal(claude?.unavailableReason, undefined, 'one-stage recovery to Live');
    assert.equal(claude?.session?.usedPct, 81);
    assert.equal(claude?.model, 'claude-fable-5', 'session-specific fields return');
  });

  // Regression: a file whose mtime is inside the TTL proves its session is
  // writing, even on a tick where its body cannot be used (a non-atomic writer
  // caught mid-write, a transient lock or permission error, a file removed
  // between listing and reading, a rejected payload). Dropping it from the
  // writer count flipped two live sessions to a single "Live" session for that
  // tick, un-muting the OTHER session's model/cost/context, then flipped back.
  for (const [kind, s2Body] of [
    ['unreadable (EACCES / vanished)', undefined],
    ['torn mid-write', '{ "source": "claude_statusline", "mod'],
    ['rejected payload', JSON.stringify({ model: { id: 'x' }, cwd: '/raw/path' })],
  ] as const) {
    test(`An active session whose file is ${kind} for one tick keeps the multi-writer state`, () => {
      let t = NOW_MS;
      const gate = createClaudeSnapshotStabilityGate({ now: () => new Date(t) });
      const s1 = (at: number) => ({
        name: fileName(S1),
        mtimeMs: at - 4_000,
        body: snapshotBody({ sessionHash: S1, usedPct: 70, model: 'model-s1', costUsd: 3 }),
      });
      const s2Good = (at: number) => ({
        name: fileName(S2),
        mtimeMs: at - 2_000,
        body: snapshotBody({ sessionHash: S2, usedPct: 80, model: 'model-s2', costUsd: 7 }),
      });
      const ticks = [
        [s1(t), s2Good(t)],
        [s1(t + 10_000), { ...s2Good(t + 10_000), body: s2Body }],
        [s1(t + 20_000), s2Good(t + 20_000)],
      ];
      for (const [i, files] of ticks.entries()) {
        const tick = read(files as Array<{ name: string; mtimeMs: number; body?: string }>, t);
        assert.equal(tick.status, 'snapshot_dir_multi_writer', `tick ${i} status`);
        assert.equal(tick.activeWriters, 2, `tick ${i} counts both live sessions`);
        const out = gate.step(tick.candidate ? [tick.candidate] : []);
        const claude = out.find((c) => c.scope.agent === 'claude-code');
        assert.equal(claude?.unavailableReason, 'snapshot_writer_collision', `tick ${i} label`);
        assert.equal(claude?.model, undefined, `tick ${i}: no session's model is shown`);
        assert.equal(claude?.cost, undefined, `tick ${i}: no session's cost is shown`);
        assert.equal(claude?.session?.usedPct, 80, `tick ${i}: conservative value holds`);
        t += 10_000;
      }
    });
  }

  test('A lone active file that fails to parse still offers no value (no invented writer)', () => {
    const out = read([{ name: fileName(S2), mtimeMs: NOW_MS - 2_000, body: '{ torn' }]);
    assert.equal(out.status, 'snapshot_dir_no_active_writer');
    assert.equal(out.candidate, undefined);
    assert.equal(out.activeWriters, 0);
  });
});
