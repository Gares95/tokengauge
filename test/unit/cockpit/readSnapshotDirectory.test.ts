// Per-session snapshot DIRECTORY mode. One snapshot file
// per Claude Code session gives TokenGauge a real active-session signal — the
// multiple-writers state persists while >=2 sessions are alive (even when both
// are IDLE, which single-file interleave detection can never prove) and clears
// within the active TTL once a session closes. These tests pin the pure reader:
// strict filename pattern, mtime TTL, per-file fail-closed parsing, the
// deterministic conservative merge, and the privacy shape of the merged output.

import * as assert from 'node:assert/strict';
import { createClaudeSnapshotStabilityGate } from '../../../src/cockpit/ClaudeSnapshotStabilityGate';
import {
  ACTIVE_WRITER_TTL_MS,
  MAX_SNAPSHOT_FILES,
  readSnapshotDirectoryCandidate,
  SNAPSHOT_FILE_PATTERN,
  type SnapshotDirEntry,
} from '../../../src/core/cockpit/readSnapshotDirectory';
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
        body: snapshotBody({ sessionHash: S1, usedPct: 44 }),
      },
      { name: fileName(S2), mtimeMs: NOW_MS - 5_000, body: '{ torn mid-rename' },
    ]);
    // The torn file neither counts as a writer nor breaks the healthy one.
    assert.equal(out.status, 'snapshot_dir_loaded');
    assert.equal(out.activeWriters, 1);
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

  test('Exposes the documented TTL, cap, and strict filename pattern', () => {
    assert.equal(ACTIVE_WRITER_TTL_MS, 90_000);
    assert.ok(MAX_SNAPSHOT_FILES <= 64, 'listing must stay bounded');
    assert.ok(SNAPSHOT_FILE_PATTERN.test('aaaaaaaaaaaaaaaa-1111111111111111.json'));
    assert.ok(!SNAPSHOT_FILE_PATTERN.test('anything-else.json'));
    assert.ok(!SNAPSHOT_FILE_PATTERN.test('aaaaaaaaaaaaaaaa-1111111111111111.json.tmp'));
    assert.ok(!SNAPSHOT_FILE_PATTERN.test('/etc/aaaaaaaaaaaaaaaa-1111111111111111.json'));
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
});
