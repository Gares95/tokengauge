// the Claude statusLine snapshot stability gate — CONSERVATIVE, reset-window-aware.
//
// These tests pin the conservative monotonic limit selector that sits between
// the candidate gatherer and the per-agent builder. The gate is pure (injected
// clock, no filesystem) and stateful across successive refreshes. It operates
// ONLY on the Claude statusline_snapshot candidate; every other candidate
// (Codex, blockers, stats-cache) passes through untouched.
//
// CONTRACT (supersedes the earlier "emit current reading" behavior):
// for a usage LIMIT inside a reset window the gauge must be STABLE and
// CONSERVATIVE — the highest known usedPct for the window, never lowered by a
// lagging session's later write. A lower value is accepted ONLY on a real
// reset-window change (resetsAt/windowKey changes). Timestamp-newer is NOT
// sufficient. Identity (workspaceHash) is collision METADATA ONLY — it sets the
// degraded `snapshot_writer_collision` label, never permission to lower the gauge.

import * as assert from 'node:assert/strict';
import {
  ABSENT_GRACE_MS,
  COLLISION_EVIDENCE_WINDOW_MS,
  createClaudeSnapshotStabilityGate,
  LABEL_RECOVERY_REFRESHES,
} from '../../../src/cockpit/ClaudeSnapshotStabilityGate';
import type { SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';

const WS_A = 'workspacehash-aaaaaaaaaaaaaaaa';
const WS_B = 'workspacehash-bbbbbbbbbbbbbbbb';

// A reset-window identity (resetsAt ISO). Same string = same window.
const WIN_1 = '2026-06-14T12:00:00.000Z';
const WIN_2 = '2026-06-14T17:00:00.000Z';

// An EARLIER reset window than WIN_1 (a stale old-window
// writer that lingers after a reset). Its resetsAt is OLDER than WIN_1, so by
// reset-TIME it can never legitimately take control once WIN_1 is held.
const WIN_OLD = '2026-06-14T07:00:00.000Z';

function claudeSnapshot(over: {
  usedPct: number;
  workspaceHash: string;
  sessionHash?: string;
  capturedAtMs?: number;
  resetsAt?: string;
  weeklyUsedPct?: number;
  weeklyResetsAt?: string;
}): SourceCandidate {
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: 0,
    scope: { provider: 'anthropic', agent: 'claude-code', model: 'claude-opus-4' },
    confidence: 'high',
    session: {
      usedPct: over.usedPct,
      leftPct: 100 - over.usedPct,
      ...(over.resetsAt !== undefined ? { resetsAt: over.resetsAt } : {}),
    },
    ...(over.weeklyUsedPct !== undefined
      ? {
          weekly: {
            usedPct: over.weeklyUsedPct,
            leftPct: 100 - over.weeklyUsedPct,
            ...(over.weeklyResetsAt !== undefined ? { resetsAt: over.weeklyResetsAt } : {}),
          },
        }
      : {}),
    workspaceHash: over.workspaceHash,
    ...(over.sessionHash !== undefined ? { sessionHash: over.sessionHash } : {}),
    ...(over.capturedAtMs !== undefined ? { snapshotCapturedAtMs: over.capturedAtMs } : {}),
  };
}

function claudeOf(candidates: readonly SourceCandidate[]): SourceCandidate {
  const claude = candidates.find((c) => c.scope.agent === 'claude-code');
  assert.ok(claude, 'expected a claude candidate to be present');
  return claude as SourceCandidate;
}

// A present-but-valueless statusline_snapshot candidate (missing_rate_limits:
// cost/model parsed, but no session/weekly windows).
function valuelessClaudeSnapshot(
  over: { workspaceHash?: string; sessionHash?: string } = {},
): SourceCandidate {
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: 0,
    scope: { provider: 'anthropic', agent: 'claude-code', model: 'claude-opus-4' },
    confidence: 'high',
    cost: 1.23,
    ...(over.workspaceHash !== undefined ? { workspaceHash: over.workspaceHash } : {}),
    ...(over.sessionHash !== undefined ? { sessionHash: over.sessionHash } : {}),
  };
}

// The not-configured / missing blocker candidate the gatherer emits when the
// statusLine snapshot path is absent or unreadable (no session/weekly value).
function claudeBlocker(reason: SourceCandidate['unavailableReason']): SourceCandidate {
  return {
    sourceTier: 'unknown',
    producedAtMs: 0,
    scope: { provider: 'anthropic', agent: 'claude-code' },
    unavailableReason: reason,
  };
}

// A stats-cache candidate (non-statusline) — always present, must pass through.
const STATS_CACHE: SourceCandidate = {
  sourceTier: 'stats_cache_snapshot',
  producedAtMs: 0,
  scope: { provider: 'anthropic', agent: 'claude-code' },
  context: { usedTokens: 1000, windowSizeTokens: 200000 },
};

// A monotonically advancing clock seam.
function clockFrom(startMs: number) {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

// Capture the rule-id-only diagnostics the gate records (no raw data ever).
function diagSink(): {
  recorded: Array<{ ruleId: string }>;
  record: (e: { ruleId: string }) => void;
} {
  const recorded: Array<{ ruleId: string }> = [];
  return { recorded, record: (e) => recorded.push({ ruleId: e.ruleId }) };
}

suite('ClaudeSnapshotStabilityGate — conservative reset-window monotonic', () => {
  // (a) 37 then 87 same window → shows 87 (higher accepted).
  test('(a) lower then higher same window → accepts the higher value', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    const first = gate.step([
      claudeSnapshot({ usedPct: 37, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 100 }),
    ]);
    assert.equal(claudeOf(first).session?.usedPct, 37);

    clock.advance(2000);
    const second = gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    assert.equal(claudeOf(second).session?.usedPct, 87);
  });

  // (b) 87 then 37 same window → stays 87 (lower rejected); NEVER 37. A lagging
  //     session's later (lower) write must never lower a limit. A single
  //     writer SWITCH is a handoff, not proof of concurrency — the collision
  //     label appears only when the first writer provably writes AGAIN.
  test('(b) higher then lower same window → holds the higher value, never lowers', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    clock.advance(2000);
    const out = claudeOf(
      gate.step([
        // A competing, lagging session writes a LOWER usage with a NEWER capture.
        claudeSnapshot({ usedPct: 37, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 999 }),
      ]),
    );
    // The conservative value stays at the window high — never lowered to 37.
    assert.equal(out.session?.usedPct, 87);
    // ONE switch could be a handoff (restart / new session) — no collision yet.
    assert.equal(out.unavailableReason, undefined);

    clock.advance(2000);
    const back = claudeOf(
      gate.step([
        // The first writer writes AGAIN → live interleave → collision.
        claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 1100 }),
      ]),
    );
    assert.equal(back.session?.usedPct, 87);
    assert.equal(back.unavailableReason, 'snapshot_writer_collision');
  });

  // (c) then 93 same window → updates to 93 (higher accepted).
  test('(c) a later higher value same window → accepts (rises to 93)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    gate.step([
      claudeSnapshot({ usedPct: 37, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 999 }),
    ]);
    clock.advance(2000);
    const out = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 93, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 1500 }),
      ]),
    );
    assert.equal(out.session?.usedPct, 93);
  });

  // (d) after rising to a high, the gauge does NOT later return to 87/37 without a
  //     reset — sustained lower writes are always rejected.
  test('(d) never returns to a prior lower value without a reset-window change', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 93, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      clock.advance(2000);
      const ws = i % 2 === 0 ? WS_B : WS_A;
      const pct = i % 2 === 0 ? 37 : 87;
      const out = claudeOf(
        gate.step([
          claudeSnapshot({
            usedPct: pct,
            workspaceHash: ws,
            resetsAt: WIN_1,
            capturedAtMs: 300 + i,
          }),
        ]),
      );
      seen.push(out.session?.usedPct as number);
    }
    // Every emitted value stays at the conservative window high (93) — never 87/37.
    assert.deepEqual(new Set(seen), new Set([93]));
  });

  // (e) windowKey (resetsAt) changes → a LOWER value IS accepted as a new window.
  test('(e) a reset-window change accepts a lower value as the new window', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 93, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    clock.advance(2000);
    const out = claudeOf(
      gate.step([
        // Real reset: resetsAt advances → a lower value is the new window's truth.
        claudeSnapshot({ usedPct: 12, workspaceHash: WS_A, resetsAt: WIN_2, capturedAtMs: 300 }),
      ]),
    );
    assert.equal(out.session?.usedPct, 12);
    assert.notEqual(out.unavailableReason, 'snapshot_writer_collision');
  });

  // (f) sustained two-writer alternation → STABLE conservative value, degraded-
  //     labelled, NO alternation, and still updates on a new higher value (no wedge).
  test('(f) sustained two-writer alternation is stable + degraded, still rises on a new high', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      clock.advance(3000);
      const ws = i % 2 === 0 ? WS_B : WS_A;
      const pct = i % 2 === 0 ? 37 : 50;
      const out = claudeOf(
        gate.step([
          claudeSnapshot({
            usedPct: pct,
            workspaceHash: ws,
            resetsAt: WIN_1,
            capturedAtMs: 300 + i,
          }),
        ]),
      );
      // The FIRST switch (i=0) is a possible handoff; from the second switch on
      // (a writer wrote again after the other) the collision label is stable.
      if (i >= 1) {
        assert.equal(out.unavailableReason, 'snapshot_writer_collision');
      }
      seen.push(out.session?.usedPct as number);
    }
    // The value never alternated — it stayed pinned at the conservative high (87).
    assert.deepEqual(new Set(seen), new Set([87]));

    // A genuinely higher reading still updates the gauge (no wedge).
    clock.advance(3000);
    const higher = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 91, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 500 }),
      ]),
    );
    assert.equal(higher.session?.usedPct, 91);
  });

  // (g) the SAME conservative held value is what the gate emits, so the status bar
  //     VM and the cockpit VM (both fed from this single post) must agree.
  test('(g) the gate emits a single conservative value (status bar == cockpit)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    const out = gate.step([
      claudeSnapshot({ usedPct: 37, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 999 }),
    ]);
    // There is exactly ONE Claude statusline value-bearing candidate, carrying the
    // conservative value — both surfaces read the same post.
    const valueBearers = out.filter(
      (c) =>
        c.scope.agent === 'claude-code' &&
        c.sourceTier === 'statusline_snapshot' &&
        c.session?.usedPct !== undefined,
    );
    assert.equal(valueBearers.length, 1);
    assert.equal(valueBearers[0]?.session?.usedPct, 87);
  });

  // Weekly window is governed by the SAME conservative rule, independently.
  test('The weekly window is conservatively monotonic, independent of the session', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({
        usedPct: 50,
        workspaceHash: WS_A,
        resetsAt: WIN_1,
        capturedAtMs: 200,
        weeklyUsedPct: 60,
        weeklyResetsAt: 'week-1',
      }),
    ]);
    clock.advance(2000);
    const out = claudeOf(
      gate.step([
        claudeSnapshot({
          usedPct: 80, // session rises
          workspaceHash: WS_B,
          resetsAt: WIN_1,
          capturedAtMs: 999,
          weeklyUsedPct: 40, // weekly LOWER → must be rejected
          weeklyResetsAt: 'week-1',
        }),
      ]),
    );
    assert.equal(out.session?.usedPct, 80);
    assert.equal(out.weekly?.usedPct, 60); // held at the weekly high
  });

  // A lower-usage rejection records a rule-id-only diagnostic (no raw data).
  test('Rejecting a lower in-window value records lower_usage_snapshot_rejected (rule-id only)', () => {
    const clock = clockFrom(1_000_000);
    const diag = diagSink();
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now, diagnostics: diag });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    gate.step([
      claudeSnapshot({ usedPct: 37, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 999 }),
    ]);
    assert.ok(
      diag.recorded.some((e) => e.ruleId === 'lower_usage_snapshot_rejected'),
      'a rejected lower in-window value must record the rule-id-only diagnostic',
    );
    // Privacy: every recorded entry is rule-id only (no payload keys leaked).
    for (const e of diag.recorded) {
      assert.deepEqual(Object.keys(e), ['ruleId']);
    }
  });

  // Recovery: once the alternation stops, the switch evidence ages out of the
  // window and the card returns to fresh — one stage, no extra quiet timer.
  test('After collision settles to one writer, the card recovers to fresh', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    // Sustained collision (from the second switch on).
    for (let i = 0; i < 4; i += 1) {
      clock.advance(3000);
      const ws = i % 2 === 0 ? WS_B : WS_A;
      const out = claudeOf(
        gate.step([
          claudeSnapshot({
            usedPct: 50,
            workspaceHash: ws,
            resetsAt: WIN_1,
            capturedAtMs: 300 + i,
          }),
        ]),
      );
      if (i >= 1) {
        assert.equal(out.unavailableReason, 'snapshot_writer_collision');
      }
    }
    // The alternation stops; once the evidence window has passed, the very next
    // single-writer tick is fresh — the collision label does NOT hand off to a
    // lingering "temporarily unavailable" tail (the latch is collision-exempt).
    clock.advance(COLLISION_EVIDENCE_WINDOW_MS + 1000);
    const recovered = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 91, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 500 }),
      ]),
    );
    // The value rose (91 > 87) and the label is fully fresh in ONE stage.
    assert.equal(recovered.session?.usedPct, 91);
    assert.equal(recovered.unavailableReason, undefined);
  });

  // A single same-workspace writer with a stale re-read never lowers the gauge.
  test('A single-writer stale lower re-read holds the conservative value', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(1000);
    const held = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 82, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 100 }),
      ]),
    );
    assert.equal(held.session?.usedPct, 88);
  });

  test('Non-Claude candidates always pass through untouched', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });
    const codex: SourceCandidate = {
      sourceTier: 'unknown',
      producedAtMs: 0,
      scope: { provider: 'openai', agent: 'codex' },
      unavailableReason: 'codex_probe_disabled',
    };
    const out = gate.step([codex]);
    assert.deepEqual(out, [codex]);
  });

  test('Exposes the documented collision evidence window', () => {
    // Must span several poll ticks (default 10s) so genuine alternation holds
    // the label stably, while recovery stays fast enough to feel responsive.
    assert.equal(COLLISION_EVIDENCE_WINDOW_MS, 90_000);
  });
});

// Reset-window TIME-ordering. After a hibernate/resume +
// reset-window change, a stale OLD-window writer (older resetsAt) must NEVER take
// control back from a NEW-window value. The window-change rule is no longer
// direction-agnostic string-equality: it compares parsed resetsAt epoch ms.
suite('ClaudeSnapshotStabilityGate — reset-window TIME-ordering', () => {
  // (a) a NEW window (newer resetsAt) with a LOWER value → accepted as the new
  //     window (the only path that lowers the gauge).
  test('(a) newer reset window with a lower value is accepted as the new window', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    const out = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 22, workspaceHash: WS_A, resetsAt: WIN_2, capturedAtMs: 300 }),
      ]),
    );
    assert.equal(out.session?.usedPct, 22);
    assert.equal(out.session?.resetsAt, WIN_2);
  });

  // (b) THE CORE NO-REVERT CASE. After a new window is accepted, an OLD-window
  //     snapshot (older resetsAt) is REJECTED and the value holds — no revert.
  test('(b) an older-window snapshot after a new window is rejected (no revert)', () => {
    const clock = clockFrom(1_000_000);
    const diag = diagSink();
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now, diagnostics: diag });

    // New window accepted (post-reset, lower value).
    gate.step([
      claudeSnapshot({ usedPct: 22, workspaceHash: WS_A, resetsAt: WIN_2, capturedAtMs: 300 }),
    ]);
    clock.advance(2000);
    // A stale session B (pre-reset) writes the OLD window with a high value.
    const out = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 87, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 400 }),
      ]),
    );
    // The old window is rejected — value holds on the NEW window, never reverts.
    assert.equal(out.session?.usedPct, 22);
    assert.equal(out.session?.resetsAt, WIN_2);
    assert.ok(
      diag.recorded.some((e) => e.ruleId === 'stale_old_window_rejected'),
      'a rejected older reset window must record stale_old_window_rejected',
    );
    for (const e of diag.recorded) {
      assert.deepEqual(Object.keys(e), ['ruleId']);
    }
  });

  // (c) same-window lower → still rejected (regression intact).
  test('(c) same-window lower is still rejected', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    const out = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 37, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 300 }),
      ]),
    );
    assert.equal(out.session?.usedPct, 87);
  });

  // (d) same-window higher → accepted (regression intact).
  test('(d) same-window higher is still accepted', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 37, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    const out = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 93, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 300 }),
      ]),
    );
    assert.equal(out.session?.usedPct, 93);
  });

  // (e) alternating new-window(56,newReset) ↔ old-window(87,oldReset) → STABLE at
  //     the new-window value, never flaps to 87.
  test('(e) alternating new-window vs stale old-window feed stays pinned to the new window', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    // Establish the new window (WIN_2) at 56.
    gate.step([
      claudeSnapshot({ usedPct: 56, workspaceHash: WS_A, resetsAt: WIN_2, capturedAtMs: 300 }),
    ]);

    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      clock.advance(2000);
      const stale = i % 2 === 0;
      const out = claudeOf(
        gate.step([
          stale
            ? // A stale OLD-window writer (older resetsAt) with a high value.
              claudeSnapshot({
                usedPct: 87,
                workspaceHash: WS_B,
                resetsAt: WIN_1,
                capturedAtMs: 400 + i,
              })
            : // The live NEW-window writer.
              claudeSnapshot({
                usedPct: 56,
                workspaceHash: WS_A,
                resetsAt: WIN_2,
                capturedAtMs: 400 + i,
              }),
        ]),
      );
      seen.push(out.session?.usedPct as number);
    }
    // Never flapped to the stale 87 — pinned to the new window's 56.
    assert.deepEqual(new Set(seen), new Set([56]));
  });

  // Weekly mirror: a newer weekly reset accepts a lower value; an older weekly
  // reset is rejected — independent of the session metric.
  test('Weekly mirrors reset-window time-ordering independently of the session', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    // Establish the new weekly window at 30, session at 56 (new session window).
    gate.step([
      claudeSnapshot({
        usedPct: 56,
        workspaceHash: WS_A,
        resetsAt: WIN_2,
        capturedAtMs: 300,
        weeklyUsedPct: 30,
        weeklyResetsAt: '2026-06-20T00:00:00.000Z',
      }),
    ]);
    clock.advance(2000);
    // A stale writer carries the OLD weekly window (older resetsAt) at a high value.
    const out = claudeOf(
      gate.step([
        claudeSnapshot({
          usedPct: 56,
          workspaceHash: WS_B,
          resetsAt: WIN_2,
          capturedAtMs: 400,
          weeklyUsedPct: 90,
          weeklyResetsAt: '2026-06-13T00:00:00.000Z',
        }),
      ]),
    );
    // The old weekly window is rejected — weekly holds at 30 on the new window.
    assert.equal(out.weekly?.usedPct, 30);
  });

  // A missing resetsAt on either side → treated as SAME window (conservative;
  // never lowered without proof of a newer reset).
  test('A missing resetsAt is treated as the same window (no unproven lowering)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([claudeSnapshot({ usedPct: 80, workspaceHash: WS_A, capturedAtMs: 200 })]);
    clock.advance(2000);
    const out = claudeOf(
      gate.step([claudeSnapshot({ usedPct: 20, workspaceHash: WS_A, capturedAtMs: 300 })]),
    );
    // No parseable reset on either side → same window → lower rejected.
    assert.equal(out.session?.usedPct, 80);
  });
});

// Live-evidence contract (supersedes the earlier last-seen-aging model): collision requires
// LIVE INTERLEAVE EVIDENCE — a writer must provably write again after a different
// writer did (two switches within the evidence window). A single switch is a
// handoff and never flags; recovery is the evidence aging out, one stage.
suite('ClaudeSnapshotStabilityGate — interleave-evidence collision', () => {
  // (f) two writers ALTERNATING in the same window → degraded collision,
  //     conservative max, no flap.
  test('(f) two alternating writers same window → degraded collision, conservative max', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    // First switch — could be a handoff; not yet a collision.
    const handoff = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 37, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 300 }),
      ]),
    );
    assert.equal(handoff.session?.usedPct, 87);
    assert.equal(handoff.unavailableReason, undefined);

    clock.advance(2000);
    // The first writer writes AGAIN → both are alive → collision.
    const out = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 40, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 400 }),
      ]),
    );
    assert.equal(out.session?.usedPct, 87);
    assert.equal(out.unavailableReason, 'snapshot_writer_collision');
  });

  // (g) the second writer may first appear long after the surviving session —
  //     the interleave is still detected when the first writer returns.
  test('(g) a second writer appearing after a long gap is still detected on interleave', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    // A minute later a second writer appears…
    clock.advance(60_000);
    gate.step([
      claudeSnapshot({ usedPct: 50, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 300 }),
    ]);
    clock.advance(10_000);
    // …and the first one writes again → live interleave → collision.
    const out = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 60, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 400 }),
      ]),
    );
    assert.equal(out.unavailableReason, 'snapshot_writer_collision');
    assert.equal(out.session?.usedPct, 87);
  });

  // (h) the alternation stops → the evidence ages out of the window and the very
  //     next single-writer tick is FRESH (one-stage recovery; value not lowered).
  test('(h) collision clears within one evidence window after the alternation stops', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    gate.step([
      claudeSnapshot({ usedPct: 50, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 300 }),
    ]);
    clock.advance(2000);
    const collided = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 55, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 400 }),
      ]),
    );
    assert.equal(collided.unavailableReason, 'snapshot_writer_collision');

    // WS_B goes quiet; once the evidence window passes, the next WS_A tick is
    // fully fresh — no second quiet period, no lingering degraded tail.
    clock.advance(COLLISION_EVIDENCE_WINDOW_MS + 1000);
    const recovered = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 91, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 500 }),
      ]),
    );
    assert.equal(recovered.session?.usedPct, 91);
    assert.equal(recovered.unavailableReason, undefined);
  });

  // (i) sustained two-writer activity → stays degraded across the whole run.
  test('(i) sustained two-writer activity stays degraded (never last-writer-wins)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    for (let i = 0; i < 8; i += 1) {
      clock.advance(5000);
      const ws = i % 2 === 0 ? WS_B : WS_A;
      const out = claudeOf(
        gate.step([
          claudeSnapshot({
            usedPct: 40,
            workspaceHash: ws,
            resetsAt: WIN_1,
            capturedAtMs: 300 + i,
          }),
        ]),
      );
      if (i >= 1) {
        assert.equal(out.unavailableReason, 'snapshot_writer_collision');
      }
      assert.equal(out.session?.usedPct, 87);
    }
  });

  // A session RESTART (old key stops, new key takes over) is a handoff — the
  // stuck "Multiple Claude Code sessions" card from UAT must never come back.
  test('Startup/restart handoff after a historical session hash never flags a collision', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    // First poll reads the STALE file left by the previous session…
    gate.step([
      claudeSnapshot({ usedPct: 44, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 100 }),
    ]);
    // …then the new session writes from here on. No key ever reappears.
    for (let i = 0; i < 10; i += 1) {
      clock.advance(10_000);
      const out = claudeOf(
        gate.step([
          claudeSnapshot({
            usedPct: 44 + i,
            workspaceHash: WS_B,
            resetsAt: WIN_1,
            capturedAtMs: 200 + i,
          }),
        ]),
      );
      assert.notEqual(
        out.unavailableReason,
        'snapshot_writer_collision',
        `tick ${i}: a handoff must never read as multiple sessions`,
      );
    }
  });

  // A manual Refresh is just an extra step() tick: it prunes aged evidence
  // immediately, so a user pressing Refresh after closing the other session sees
  // the card recover without waiting for the next scheduled poll.
  test('An out-of-cadence Refresh tick clears aged collision evidence immediately', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    // Live alternation → collision.
    gate.step([
      claudeSnapshot({ usedPct: 80, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 100 }),
    ]);
    clock.advance(5000);
    gate.step([
      claudeSnapshot({ usedPct: 70, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(5000);
    const collided = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 80, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 300 }),
      ]),
    );
    assert.equal(collided.unavailableReason, 'snapshot_writer_collision');

    // The other session closes. Later — past the evidence window — the user hits
    // Refresh (a single extra tick, not a poll-cadence boundary): fresh at once.
    clock.advance(COLLISION_EVIDENCE_WINDOW_MS + 500);
    const refreshed = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 82, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 400 }),
      ]),
    );
    assert.equal(refreshed.unavailableReason, undefined);
    assert.equal(refreshed.session?.usedPct, 82);
  });
});

// Cold-start / gate-restart convergence. After a
// reload (fresh gate) the path must converge regardless of which session is seen
// first.
suite('ClaudeSnapshotStabilityGate — cold-start / reload convergence', () => {
  // (j) fresh gate sees the STALE old-window writer first, then the NEW-window
  //     writer → converges to the new window, never flaps back.
  test('(j) stale-first then new-window converges to the new window', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    // Stale old-window writer seen first by a fresh gate.
    const first = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 87, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 200 }),
      ]),
    );
    assert.equal(first.session?.usedPct, 87);

    clock.advance(2000);
    // The real new-window writer arrives (newer resetsAt → real reset).
    const second = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 22, workspaceHash: WS_A, resetsAt: WIN_2, capturedAtMs: 300 }),
      ]),
    );
    assert.equal(second.session?.usedPct, 22);

    clock.advance(2000);
    // Stale old-window writer reappears → must be rejected (no flap back).
    const third = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 87, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 400 }),
      ]),
    );
    assert.equal(third.session?.usedPct, 22);
  });

  // (k) fresh gate sees the NEW-window writer first, then a STALE old-window
  //     writer → stale rejected, stays on the new window.
  test('(k) new-window-first then stale → stale rejected, stays on the new window', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    const first = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 22, workspaceHash: WS_A, resetsAt: WIN_2, capturedAtMs: 300 }),
      ]),
    );
    assert.equal(first.session?.usedPct, 22);

    clock.advance(2000);
    const second = claudeOf(
      gate.step([
        claudeSnapshot({ usedPct: 87, workspaceHash: WS_B, resetsAt: WIN_OLD, capturedAtMs: 400 }),
      ]),
    );
    assert.equal(second.session?.usedPct, 22);
  });

  // (l) weekly has equivalent protection (mirror of j/k for the weekly metric).
  test('(l) weekly converges to the new window regardless of order', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    // Stale weekly window seen first.
    gate.step([
      claudeSnapshot({
        usedPct: 56,
        workspaceHash: WS_B,
        resetsAt: WIN_2,
        capturedAtMs: 200,
        weeklyUsedPct: 90,
        weeklyResetsAt: '2026-06-13T00:00:00.000Z',
      }),
    ]);
    clock.advance(2000);
    // New weekly window (newer resetsAt, lower value) → accepted.
    const out = claudeOf(
      gate.step([
        claudeSnapshot({
          usedPct: 56,
          workspaceHash: WS_A,
          resetsAt: WIN_2,
          capturedAtMs: 300,
          weeklyUsedPct: 20,
          weeklyResetsAt: '2026-06-20T00:00:00.000Z',
        }),
      ]),
    );
    assert.equal(out.weekly?.usedPct, 20);

    clock.advance(2000);
    // Stale old weekly window reappears → rejected.
    const back = claudeOf(
      gate.step([
        claudeSnapshot({
          usedPct: 56,
          workspaceHash: WS_B,
          resetsAt: WIN_2,
          capturedAtMs: 400,
          weeklyUsedPct: 90,
          weeklyResetsAt: '2026-06-13T00:00:00.000Z',
        }),
      ]),
    );
    assert.equal(back.weekly?.usedPct, 20);
  });

  // (m) after the sequence, the status bar VM == cockpit VM (exactly one emitted
  //     conservative value-bearing candidate).
  test('(m) the gate emits a single conservative value after the convergence sequence', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(2000);
    gate.step([
      claudeSnapshot({ usedPct: 22, workspaceHash: WS_A, resetsAt: WIN_2, capturedAtMs: 300 }),
    ]);
    clock.advance(2000);
    const out = gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_B, resetsAt: WIN_1, capturedAtMs: 400 }),
    ]);
    const valueBearers = out.filter(
      (c) =>
        c.scope.agent === 'claude-code' &&
        c.sourceTier === 'statusline_snapshot' &&
        c.session?.usedPct !== undefined,
    );
    assert.equal(valueBearers.length, 1);
    assert.equal(valueBearers[0]?.session?.usedPct, 22);
  });
});

// Find the Claude statusline_snapshot candidate carrying a real session value
// (the gauge-bearing candidate the builder uses for the visible ring).
function heldClaudeValue(candidates: readonly SourceCandidate[]): SourceCandidate {
  const held = candidates.find(
    (c) =>
      c.scope.agent === 'claude-code' &&
      c.sourceTier === 'statusline_snapshot' &&
      c.session?.usedPct !== undefined,
  );
  assert.ok(held, 'expected a held statusline candidate with a session value');
  return held as SourceCandidate;
}

suite('ClaudeSnapshotStabilityGate after-valid preservation', () => {
  // (a) valid 88 → file missing (NO claude statusline candidate, only the
  // missing blocker) BEYOND the absence grace → gate injects held 88 marked
  // native_temporarily_unavailable. (Within the grace the held value is emitted
  // UNDEGRADED — see the transient-absence suite below.)
  test('(a) valid then absent (missing blocker) injects held value, never not-configured', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    clock.advance(ABSENT_GRACE_MS + 1000);
    const out = gate.step([STATS_CACHE, claudeBlocker('statusline_snapshot_not_configured')]);
    const held = heldClaudeValue(out);
    assert.equal(held.session?.usedPct, 88);
    assert.equal(held.unavailableReason, 'native_temporarily_unavailable');
    // The honest stats-cache candidate still passes through.
    assert.ok(out.some((c) => c.sourceTier === 'stats_cache_snapshot'));
  });

  // (b) valid 88 → parse-failed (no statusline candidate at all) beyond the
  // grace → held degraded.
  test('(b) valid then parse-failed (no claude candidate) injects held value', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    clock.advance(ABSENT_GRACE_MS + 1000);
    const out = gate.step([STATS_CACHE]);
    const held = heldClaudeValue(out);
    assert.equal(held.session?.usedPct, 88);
    assert.equal(held.unavailableReason, 'native_temporarily_unavailable');
  });

  // (c) valid 88 → present-but-valueless (missing_rate_limits) → held 88 degraded
  // snapshot_incomplete_after_valid; the empty snapshot does NOT replace the value.
  test('(c) valid then present-but-valueless injects held value as snapshot_incomplete_after_valid', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    clock.advance(1000);
    const out = gate.step([valuelessClaudeSnapshot({ workspaceHash: WS_A })]);
    const held = heldClaudeValue(out);
    assert.equal(held.session?.usedPct, 88);
    assert.equal(held.unavailableReason, 'snapshot_incomplete_after_valid');
    // The valueless snapshot must NOT also appear with a fake session value.
    const withValue = out.filter(
      (c) => c.sourceTier === 'statusline_snapshot' && c.session?.usedPct !== undefined,
    );
    assert.equal(withValue.length, 1);
  });

  // (d) NEVER valid → absent/blocker → passes through unchanged (not-configured
  // stands; the honest "not configured" card must win).
  test('(d) never valid then blocker passes through unchanged (not-configured stands)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    const out = gate.step([STATS_CACHE, claudeBlocker('statusline_snapshot_not_configured')]);
    // No held value injected — only the original candidates pass through.
    assert.equal(
      out.filter((c) => c.sourceTier === 'statusline_snapshot' && c.session?.usedPct !== undefined)
        .length,
      0,
    );
    const blocker = out.find((c) => c.unavailableReason !== undefined);
    assert.ok(blocker);
    assert.equal(blocker?.unavailableReason, 'statusline_snapshot_not_configured');
  });

  // (d2) never valid then a valueless snapshot passes through unchanged.
  test('(d2) never valid then valueless snapshot is not promoted', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    const out = gate.step([valuelessClaudeSnapshot({ workspaceHash: WS_A })]);
    assert.equal(
      out.filter((c) => c.session?.usedPct !== undefined).length,
      0,
      'a valueless first snapshot must not gain a fabricated value',
    );
  });

  // (e) recovery: valid 88 → missing (held degraded) → the VALUE accepts a fresh
  //     higher 92 immediately, but the LABEL recovers to fresh only after
  //     LABEL_RECOVERY_REFRESHES consecutive valid single-writer refreshes (the
  //     sticky-label invariant, supersedes the old per-tick recovery — no released
  //     users, so the superseded assertion is updated rather than compat-shimmed).
  test('(e) recovery accepts the higher value immediately; label recovers after K valid refreshes', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    clock.advance(ABSENT_GRACE_MS + 1000);
    // Missing/parse-failed beyond the grace → held degraded.
    const degraded = heldClaudeValue(gate.step([STATS_CACHE]));
    assert.equal(degraded.session?.usedPct, 88);
    assert.equal(degraded.unavailableReason, 'native_temporarily_unavailable');

    // K consecutive valid single-writer refreshes recover the label to fresh; the
    // conservative VALUE rises to 92 immediately on the first.
    let recovered: SourceCandidate | undefined;
    for (let i = 0; i < LABEL_RECOVERY_REFRESHES; i += 1) {
      clock.advance(1000);
      recovered = heldClaudeValue(
        gate.step([
          claudeSnapshot({
            usedPct: 92,
            workspaceHash: WS_A,
            resetsAt: WIN_1,
            capturedAtMs: 300 + i,
          }),
        ]),
      );
      // Value is conservative-stable at 92 every recovery tick.
      assert.equal(recovered.session?.usedPct, 92);
    }
    // After the full K-streak the label is fresh again.
    assert.notEqual(recovered?.unavailableReason, 'native_temporarily_unavailable');
    assert.notEqual(recovered?.unavailableReason, 'snapshot_incomplete_after_valid');
  });

  // (f) the valueless candidate must not overwrite the held value across repeats.
  test('(f) repeated valueless refreshes keep holding the original value', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    for (let i = 0; i < 4; i += 1) {
      clock.advance(1000);
      const held = heldClaudeValue(gate.step([valuelessClaudeSnapshot({ workspaceHash: WS_A })]));
      assert.equal(held.session?.usedPct, 88);
      assert.equal(held.unavailableReason, 'snapshot_incomplete_after_valid');
    }
  });
});

// The set of degraded/held reasons whose LABEL must be sticky.
const DEGRADED_REASONS = new Set([
  'snapshot_writer_collision',
  'native_temporarily_unavailable',
  'snapshot_incomplete_after_valid',
]);

function claudeReason(candidates: readonly SourceCandidate[]): string | undefined {
  // The emitted value-bearing Claude candidate (the one the builder reads).
  const held = candidates.find(
    (c) => c.scope.agent === 'claude-code' && c.sourceTier === 'statusline_snapshot',
  );
  return held?.unavailableReason as string | undefined;
}

// The freshness/degraded LABEL must be STICKY for the
// after-valid/absent reasons. A lone valid tick must NOT flip the label to fresh —
// it stays degraded until K consecutive valid, unambiguous refreshes. The
// COLLISION reason is exempt: it recovers via its own evidence window.
// The conservative VALUE selection is unchanged (the reducers own the value).
suite('ClaudeSnapshotStabilityGate — sticky freshness/degraded label', () => {
  // (a) Oscillation fix (supersedes the earlier stable-DEGRADED pinning): a
  //     single healthy writer whose file is transiently unreadable at some read
  //     instants (torn/empty/mid-rename reads) must render STABLE-FRESH — every
  //     absent tick within ABSENT_GRACE_MS of the last valid read re-emits the
  //     held value undegraded. No per-tick flap in EITHER direction.
  test('(a) alternating present/absent within the grace stays stable-fresh (no flap)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    // Establish a valid value.
    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    for (let i = 0; i < 6; i += 1) {
      clock.advance(2000);
      // Even ticks: absent (transient read artifact, within the grace).
      // Odd ticks: a present valid value for the SAME stable held value.
      const out =
        i % 2 === 0
          ? gate.step([STATS_CACHE])
          : gate.step([
              claudeSnapshot({
                usedPct: 88,
                workspaceHash: WS_A,
                resetsAt: WIN_1,
                capturedAtMs: 300 + i,
              }),
            ]);
      const held = heldClaudeValue(out);
      assert.equal(held.session?.usedPct, 88, 'the held value survives every tick');
      assert.equal(
        claudeReason(out),
        undefined,
        `tick ${i}: a transient in-grace absence must not degrade the label`,
      );
    }
  });

  // (b) after K consecutive valid, single-writer refreshes → the label returns to
  //     fresh (undefined reason).
  test('(b) K consecutive valid single-writer refreshes recover the label to fresh', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    // Trip the after-valid degraded label with one BEYOND-GRACE absent refresh.
    clock.advance(ABSENT_GRACE_MS + 2000);
    assert.ok(DEGRADED_REASONS.has(claudeReason(gate.step([STATS_CACHE])) as string));

    // Now K consecutive valid single-writer refreshes recover to fresh.
    let last: string | undefined;
    for (let i = 0; i < LABEL_RECOVERY_REFRESHES; i += 1) {
      clock.advance(2000);
      last = claudeReason(
        gate.step([
          claudeSnapshot({
            usedPct: 90,
            workspaceHash: WS_A,
            resetsAt: WIN_1,
            capturedAtMs: 400 + i,
          }),
        ]),
      );
    }
    assert.equal(last, undefined, 'after K valid single-writer refreshes the label is fresh');
  });

  // (c) sustained two-writer collision → stays degraded the whole run (from the
  //     second switch on — the first is a possible handoff).
  test('(c) sustained two-writer collision stays degraded (interleave intact)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 87, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    for (let i = 0; i < 8; i += 1) {
      clock.advance(4000);
      const ws = i % 2 === 0 ? WS_B : WS_A;
      const out = gate.step([
        claudeSnapshot({
          usedPct: 40,
          workspaceHash: ws,
          resetsAt: WIN_1,
          capturedAtMs: 300 + i,
        }),
      ]);
      if (i >= 1) {
        assert.equal(claudeReason(out), 'snapshot_writer_collision');
      }
    }
  });

  // (d) a lone valid tick amid alternation must NOT recover (sub-K) — it stays
  //     degraded until the FULL K-streak completes (no premature flip).
  test('(d) a lone valid tick amid alternation does not flip the label to fresh', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 88, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    clock.advance(ABSENT_GRACE_MS + 2000);
    assert.ok(DEGRADED_REASONS.has(claudeReason(gate.step([STATS_CACHE])) as string));

    // One valid tick — but not K in a row.
    clock.advance(2000);
    const oneValid = claudeReason(
      gate.step([
        claudeSnapshot({ usedPct: 89, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 300 }),
      ]),
    );
    // A single valid refresh (with K>1) must NOT clear the sticky degraded label.
    if (LABEL_RECOVERY_REFRESHES > 1) {
      assert.ok(
        oneValid !== undefined && DEGRADED_REASONS.has(oneValid),
        `a lone valid tick must stay degraded, got ${oneValid}`,
      );
    }

    // A within-grace absent tick while LATCHED keeps the degraded overlay (the
    // label never flashes fresh mid-recovery); the streak freezes, not resets.
    clock.advance(2000);
    assert.ok(DEGRADED_REASONS.has(claudeReason(gate.step([STATS_CACHE])) as string));
  });

  test('Exposes the documented label-recovery refresh count', () => {
    assert.ok(LABEL_RECOVERY_REFRESHES >= 1);
  });
});

// A statusLine writer rewrites the snapshot on every UI tick,
// so a poll-instant read can catch a torn/empty/mid-rename file while the source
// is perfectly healthy. Such an ABSENT refresh within ABSENT_GRACE_MS of the last
// valid read must re-emit the held value UNDEGRADED and leave the label latch
// untouched. Only absence persisting beyond the grace degrades (retention unchanged).
suite('ClaudeSnapshotStabilityGate — transient-absence grace', () => {
  test('A single in-grace absent tick keeps the card fresh (held value, no reason)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 62, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    clock.advance(5000);
    const out = gate.step([STATS_CACHE]);
    const held = heldClaudeValue(out);
    assert.equal(held.session?.usedPct, 62);
    assert.equal(held.unavailableReason, undefined, 'an in-grace absence must not degrade');
    // Non-Claude candidates still pass through.
    assert.ok(out.some((c) => c.sourceTier === 'stats_cache_snapshot'));
  });

  test('An in-grace absence drops a Claude blocker (never a not-configured flash)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 62, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    clock.advance(5000);
    const out = gate.step([claudeBlocker('statusline_snapshot_not_configured')]);
    assert.equal(heldClaudeValue(out).unavailableReason, undefined);
    assert.ok(
      !out.some((c) => c.unavailableReason === 'statusline_snapshot_not_configured'),
      'the transient blocker must not surface while the held value is in grace',
    );
  });

  test('Absence persisting beyond the grace degrades exactly as before', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 62, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);

    // Repeated absences: in-grace ticks stay fresh, the first beyond-grace tick
    // degrades to native_temporarily_unavailable.
    clock.advance(ABSENT_GRACE_MS - 5000);
    assert.equal(heldClaudeValue(gate.step([STATS_CACHE])).unavailableReason, undefined);
    clock.advance(10_000);
    assert.equal(
      heldClaudeValue(gate.step([STATS_CACHE])).unavailableReason,
      'native_temporarily_unavailable',
    );
  });

  test('An in-grace absence freezes (not resets) the label-recovery streak', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({ usedPct: 62, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 200 }),
    ]);
    // Trip the latch with a beyond-grace absence.
    clock.advance(ABSENT_GRACE_MS + 2000);
    assert.equal(
      heldClaudeValue(gate.step([STATS_CACHE])).unavailableReason,
      'native_temporarily_unavailable',
    );

    // K-1 clean valid refreshes, then one in-grace absent tick, then one more
    // clean refresh: the streak survives the artifact and the label recovers.
    for (let i = 0; i < LABEL_RECOVERY_REFRESHES - 1; i += 1) {
      clock.advance(2000);
      gate.step([
        claudeSnapshot({
          usedPct: 62,
          workspaceHash: WS_A,
          resetsAt: WIN_1,
          capturedAtMs: 300 + i,
        }),
      ]);
    }
    clock.advance(2000);
    // In-grace absence while latched: still degraded (no fresh flash)…
    assert.equal(
      heldClaudeValue(gate.step([STATS_CACHE])).unavailableReason,
      'native_temporarily_unavailable',
    );
    // …but the streak was frozen, so ONE more clean refresh completes recovery.
    clock.advance(2000);
    const recovered = heldClaudeValue(
      gate.step([
        claudeSnapshot({ usedPct: 62, workspaceHash: WS_A, resetsAt: WIN_1, capturedAtMs: 400 }),
      ]),
    );
    assert.equal(recovered.unavailableReason, undefined);
  });

  test('Exposes the documented absence grace', () => {
    assert.ok(ABSENT_GRACE_MS >= 15_000, 'the grace must cover at least one poll tick');
  });
});

// Multi-session contract: session-level writer identity with LIVE INTERLEAVE
// evidence — a handoff (restart, new session, stale startup read) never flags;
// genuine alternation flags stably; recovery is one evidence window, one stage.
suite('ClaudeSnapshotStabilityGate — multi-session interleave evidence', () => {
  const SESSION_1 = 'sessionhash-1111111111111111';
  const SESSION_2 = 'sessionhash-2222222222222222';

  test('Two sessions in the SAME workspace collide on interleave (session hash)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({
        usedPct: 60,
        workspaceHash: WS_A,
        sessionHash: SESSION_1,
        resetsAt: WIN_1,
      }),
    ]);
    clock.advance(2000);
    // First switch: could be a handoff (same workspace, new session) — no flag.
    const handoff = claudeOf(
      gate.step([
        claudeSnapshot({
          usedPct: 40,
          workspaceHash: WS_A,
          sessionHash: SESSION_2,
          resetsAt: WIN_1,
        }),
      ]),
    );
    assert.equal(handoff.unavailableReason, undefined);
    assert.equal(handoff.session?.usedPct, 60);

    clock.advance(2000);
    // Session 1 writes again → both alive in the same workspace → collision.
    const collided = claudeOf(
      gate.step([
        claudeSnapshot({
          usedPct: 61,
          workspaceHash: WS_A,
          sessionHash: SESSION_1,
          resetsAt: WIN_1,
        }),
      ]),
    );
    assert.equal(collided.unavailableReason, 'snapshot_writer_collision');
    assert.equal(collided.session?.usedPct, 61);
  });

  test('A fresh single writer after a HISTORICAL session hash becomes Live (no stuck state)', () => {
    // THE UAT regression: reinstall/startup reads the previous session's stale
    // snapshot once, then the only live session writes. The card must go Live
    // and stay Live — never "Multiple Claude Code sessions".
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({
        usedPct: 35,
        workspaceHash: WS_A,
        sessionHash: SESSION_1, // the historical session's leftover snapshot
        resetsAt: WIN_1,
      }),
    ]);
    for (let i = 0; i < 12; i += 1) {
      clock.advance(10_000);
      const out = claudeOf(
        gate.step([
          claudeSnapshot({
            usedPct: 35 + i,
            workspaceHash: WS_A,
            sessionHash: SESSION_2, // the one live session
            resetsAt: WIN_1,
          }),
        ]),
      );
      assert.equal(
        out.unavailableReason,
        undefined,
        `tick ${i}: a single live writer after a historical hash must be fresh`,
      );
    }
  });

  test('A competing VALUELESS writer converges to the stable collision story (no flap)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    // Session 1 is live and valid; session 2 (freshly opened, pre-first-response)
    // alternates valueless writes into the same file.
    gate.step([
      claudeSnapshot({
        usedPct: 70,
        workspaceHash: WS_A,
        sessionHash: SESSION_1,
        resetsAt: WIN_1,
      }),
    ]);
    clock.advance(5000);
    // First competing valueless write — one switch, not yet proof of concurrency.
    gate.step([valuelessClaudeSnapshot({ workspaceHash: WS_A, sessionHash: SESSION_2 })]);

    clock.advance(5000);
    // Session 1 returns → interleave → collision from here on, stably.
    const validTick = claudeOf(
      gate.step([
        claudeSnapshot({
          usedPct: 70,
          workspaceHash: WS_A,
          sessionHash: SESSION_1,
          resetsAt: WIN_1,
        }),
      ]),
    );
    assert.equal(validTick.unavailableReason, 'snapshot_writer_collision');

    clock.advance(5000);
    // The next valueless tick re-emits the HELD value under the SAME collision
    // label — never snapshot_incomplete_after_valid alternating with live.
    const valuelessTick = claudeOf(
      gate.step([valuelessClaudeSnapshot({ workspaceHash: WS_A, sessionHash: SESSION_2 })]),
    );
    assert.equal(valuelessTick.session?.usedPct, 70);
    assert.equal(valuelessTick.unavailableReason, 'snapshot_writer_collision');
  });

  test('A valueless write with NO competing writer still degrades honestly (incomplete)', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([
      claudeSnapshot({
        usedPct: 70,
        workspaceHash: WS_A,
        sessionHash: SESSION_1,
        resetsAt: WIN_1,
      }),
    ]);
    clock.advance(5000);
    const out = claudeOf(
      gate.step([valuelessClaudeSnapshot({ workspaceHash: WS_A, sessionHash: SESSION_1 })]),
    );
    assert.equal(out.session?.usedPct, 70);
    assert.equal(out.unavailableReason, 'snapshot_incomplete_after_valid');
  });

  test("Under CONTINUOUS polling, collision clears within one evidence window of the departed writer's last write", () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });
    const tickMs = 10_000;

    // Both sessions alternate for a while — collision active from the 2nd switch.
    for (let i = 0; i < 6; i += 1) {
      gate.step([
        claudeSnapshot({
          usedPct: 80,
          workspaceHash: WS_A,
          sessionHash: i % 2 === 0 ? SESSION_1 : SESSION_2,
          resetsAt: WIN_1,
        }),
      ]);
      clock.advance(tickMs);
    }
    // Session 2 closes; session 1 keeps writing every tick. The label must clear
    // within ONE evidence window (+ tick slack) of session 2's last write —
    // recovery is driven by the observed writes aging out, nothing else.
    let clearedAfterMs: number | undefined;
    for (let elapsed = 0; elapsed <= COLLISION_EVIDENCE_WINDOW_MS + 4 * tickMs; elapsed += tickMs) {
      const out = claudeOf(
        gate.step([
          claudeSnapshot({
            usedPct: 80,
            workspaceHash: WS_A,
            sessionHash: SESSION_1,
            resetsAt: WIN_1,
          }),
        ]),
      );
      if (out.unavailableReason !== 'snapshot_writer_collision') {
        clearedAfterMs = elapsed;
        break;
      }
      clock.advance(tickMs);
    }
    assert.ok(clearedAfterMs !== undefined, 'collision never cleared');
    assert.ok(
      (clearedAfterMs as number) <= COLLISION_EVIDENCE_WINDOW_MS + 2 * tickMs,
      `collision took ${clearedAfterMs}ms to clear — must be bounded by one evidence window (+ tick slack)`,
    );
  });

  test('Writer identity falls back to workspaceHash when no sessionHash is present', () => {
    const clock = clockFrom(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([claudeSnapshot({ usedPct: 60, workspaceHash: WS_A, resetsAt: WIN_1 })]);
    clock.advance(2000);
    gate.step([claudeSnapshot({ usedPct: 40, workspaceHash: WS_B, resetsAt: WIN_1 })]);
    clock.advance(2000);
    const collided = claudeOf(
      gate.step([claudeSnapshot({ usedPct: 50, workspaceHash: WS_A, resetsAt: WIN_1 })]),
    );
    assert.equal(collided.unavailableReason, 'snapshot_writer_collision');
  });
});
