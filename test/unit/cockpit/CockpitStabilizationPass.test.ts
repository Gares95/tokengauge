// The single post-merge cockpit
// stabilization pass.
//
// A rate-limit window whose `resetsAt` is in the PAST with no
// newer accepted native sample is EXPIRED — its used% must NOT be presented as
// current. The pass drops the expired window value and marks the candidate with
// the `native_window_reset_pending` reason (never `fresh`, never driving risk).
// Applies to session(5h) + weekly, Claude + Codex. A NEW valid sample (a newer
// reset / fresh produce time) clears it. An expired writer no longer participates
// in collision.

import * as assert from 'node:assert/strict';
import { createCockpitStabilizationPass } from '../../../src/cockpit/CockpitStabilizationPass';
import type { CockpitFieldReason } from '../../../src/core/cockpit/CockpitState';
import type { SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';

function fakeClock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return {
    now: (): Date => new Date(ms),
    advance: (deltaMs: number): void => {
      ms += deltaMs;
    },
    set: (next: number): void => {
      ms = next;
    },
    nowMs: (): number => ms,
  };
}

const HOUR = 60 * 60 * 1000;

// A Claude statusline candidate carrying a 5h (session) window at usedPct with the
// given resetsAt, captured/produced at producedAtMs.
function claude(opts: {
  usedPct: number;
  resetsAt: string;
  producedAtMs: number;
  weeklyUsedPct?: number;
  weeklyResetsAt?: string;
  workspaceHash?: string;
}): SourceCandidate {
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: opts.producedAtMs,
    snapshotCapturedAtMs: opts.producedAtMs,
    scope: { provider: 'anthropic', agent: 'claude-code' },
    session: { usedPct: opts.usedPct, leftPct: 100 - opts.usedPct, resetsAt: opts.resetsAt },
    ...(opts.weeklyUsedPct !== undefined
      ? {
          weekly: {
            usedPct: opts.weeklyUsedPct,
            leftPct: 100 - opts.weeklyUsedPct,
            ...(opts.weeklyResetsAt !== undefined ? { resetsAt: opts.weeklyResetsAt } : {}),
          },
        }
      : {}),
    ...(opts.workspaceHash !== undefined ? { workspaceHash: opts.workspaceHash } : {}),
  };
}

function codex(opts: { usedPct: number; resetsAt: string; producedAtMs: number }): SourceCandidate {
  return {
    sourceTier: 'codex_status_snapshot',
    producedAtMs: opts.producedAtMs,
    scope: { provider: 'openai', agent: 'codex' },
    session: { usedPct: opts.usedPct, leftPct: 100 - opts.usedPct, resetsAt: opts.resetsAt },
  };
}

function claudeOf(list: readonly SourceCandidate[]): SourceCandidate | undefined {
  return list.find((c) => c.scope.agent === 'claude-code');
}
function codexOf(list: readonly SourceCandidate[]): SourceCandidate | undefined {
  return list.find((c) => c.scope.agent === 'codex');
}
function reasonOf(c: SourceCandidate | undefined): CockpitFieldReason | undefined {
  return c?.unavailableReason;
}

suite('CockpitStabilizationPass — resetAt expiry', () => {
  test('Claude 5h: resetAt hours in the past, no newer sample → pending, value dropped, not fresh', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });

    // A held snapshot whose 5h window has ALREADY reset (resetsAt 6h before now).
    const resetsAt = new Date(clock.nowMs() - 6 * HOUR).toISOString();
    const input = [claude({ usedPct: 72, resetsAt, producedAtMs: clock.nowMs() - 11 * HOUR })];

    const out = pass.step(input);
    const card = claudeOf(out);
    assert.ok(card, 'claude card still present');
    // Value dropped — not the stale 72%.
    assert.equal(card?.session?.usedPct, undefined, 'expired session usedPct dropped');
    assert.equal(reasonOf(card), 'native_window_reset_pending');
  });

  test('A NEW valid sample for the new window clears the pending state', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });

    const oldReset = new Date(clock.nowMs() - 6 * HOUR).toISOString();
    pass.step([
      claude({ usedPct: 72, resetsAt: oldReset, producedAtMs: clock.nowMs() - 11 * HOUR }),
    ]);

    // A fresh sample for the NEW window (reset in the future) arrives.
    const newReset = new Date(clock.nowMs() + 4 * HOUR).toISOString();
    const out = pass.step([
      claude({ usedPct: 5, resetsAt: newReset, producedAtMs: clock.nowMs() }),
    ]);
    const card = claudeOf(out);
    assert.equal(reasonOf(card), undefined, 'fresh new-window sample → no pending reason');
    assert.equal(card?.session?.usedPct, 5, 'new value surfaces');
  });

  test('Weekly window expiry behaves the same as 5h', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });

    const sessionReset = new Date(clock.nowMs() + 2 * HOUR).toISOString(); // 5h still live
    const weeklyReset = new Date(clock.nowMs() - 2 * HOUR).toISOString(); // weekly expired
    const out = pass.step([
      claude({
        usedPct: 40,
        resetsAt: sessionReset,
        producedAtMs: clock.nowMs() - 30 * 60 * 1000,
        weeklyUsedPct: 88,
        weeklyResetsAt: weeklyReset,
      }),
    ]);
    const card = claudeOf(out);
    // 5h stays available; weekly is dropped + pending.
    assert.equal(card?.session?.usedPct, 40, '5h still live');
    assert.equal(card?.weekly?.usedPct, undefined, 'expired weekly dropped');
    assert.equal(reasonOf(card), 'native_window_reset_pending');
  });

  test('Codex window expiry → pending too', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });

    const resetsAt = new Date(clock.nowMs() - 3 * HOUR).toISOString();
    const out = pass.step([
      codex({ usedPct: 65, resetsAt, producedAtMs: clock.nowMs() - 5 * HOUR }),
    ]);
    const card = codexOf(out);
    assert.equal(card?.session?.usedPct, undefined, 'expired codex session dropped');
    assert.equal(reasonOf(card), 'native_window_reset_pending');
  });

  test('A window whose resetAt is in the FUTURE is untouched', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });
    const resetsAt = new Date(clock.nowMs() + 2 * HOUR).toISOString();
    const out = pass.step([claude({ usedPct: 50, resetsAt, producedAtMs: clock.nowMs() })]);
    const card = claudeOf(out);
    assert.equal(card?.session?.usedPct, 50);
    assert.equal(reasonOf(card), undefined);
  });

  test('Expired pending does not drive risk (no value to derive risk from)', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });
    const resetsAt = new Date(clock.nowMs() - 6 * HOUR).toISOString();
    const out = pass.step([
      claude({ usedPct: 96, resetsAt, producedAtMs: clock.nowMs() - 11 * HOUR }),
    ]);
    const card = claudeOf(out);
    // A near-100 pre-reset value must NOT survive to drive critical risk.
    assert.equal(card?.session?.usedPct, undefined);
  });

  test('An expired window outranks a collision reason (expired writer leaves collision)', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });
    const resetsAt = new Date(clock.nowMs() - 6 * HOUR).toISOString();
    // The Claude gate already degraded this to collision; once the window has
    // reset, the deterministic priority surfaces the pending reason instead.
    const collided: SourceCandidate = {
      ...claude({ usedPct: 72, resetsAt, producedAtMs: clock.nowMs() - 11 * HOUR }),
      unavailableReason: 'snapshot_writer_collision',
    };
    const out = pass.step([collided]);
    assert.equal(reasonOf(claudeOf(out)), 'native_window_reset_pending');
  });
});

// A deterministic reason priority + an idempotent
// no-flap stabilization. Identical accepted inputs across consecutive ticks must
// yield identical semantic state (reason/freshness/visible windows); a real source
// event (a probe failure after valid, a new value) still flips immediately.
suite('CockpitStabilizationPass — deterministic reason priority + idempotent no-flap', () => {
  // A semantic signature of a card: the visible windows + the arbitrated reason.
  // Two ticks that produce the same signature are "no semantic-state change".
  function sig(c: SourceCandidate | undefined): string {
    if (c === undefined) return 'absent';
    return JSON.stringify({
      session: c.session?.usedPct ?? null,
      sessionReset: c.session?.resetsAt ?? null,
      weekly: c.weekly?.usedPct ?? null,
      reason: c.unavailableReason ?? null,
    });
  }

  test('N consecutive identical-input ticks → ZERO semantic-state changes (identical reasons)', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });
    const future = new Date(clock.nowMs() + 3 * HOUR).toISOString();

    const signatures = new Set<string>();
    for (let i = 0; i < 12; i++) {
      // Same accepted value each tick; producedAtMs advances (read-time noise) but
      // the semantic state must NOT change.
      clock.advance(8_000);
      const out = pass.step([
        claude({ usedPct: 55, resetsAt: future, producedAtMs: clock.nowMs() }),
      ]);
      signatures.add(sig(claudeOf(out)));
    }
    assert.equal(signatures.size, 1, 'no semantic-state change across identical-input ticks');
  });

  test('A collision reason stays stable across consecutive ticks (no oscillation)', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });
    const future = new Date(clock.nowMs() + 3 * HOUR).toISOString();

    const reasons = new Set<string | undefined>();
    for (let i = 0; i < 8; i++) {
      clock.advance(7_000);
      const collided: SourceCandidate = {
        ...claude({ usedPct: 70, resetsAt: future, producedAtMs: clock.nowMs() }),
        unavailableReason: 'snapshot_writer_collision',
      };
      const out = pass.step([collided]);
      reasons.add(reasonOf(claudeOf(out)));
    }
    assert.equal(reasons.size, 1);
    assert.ok(reasons.has('snapshot_writer_collision'));
  });

  test('A real probe failure AFTER a valid value still degrades immediately (not frozen)', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });
    const future = new Date(clock.nowMs() + 3 * HOUR).toISOString();

    // A valid codex value first.
    let out = pass.step([codex({ usedPct: 20, resetsAt: future, producedAtMs: clock.nowMs() })]);
    assert.equal(reasonOf(codexOf(out)), undefined, 'valid → fresh');

    // Then a retained-degraded candidate (the retention gate's after-valid output).
    clock.advance(9_000);
    const degraded: SourceCandidate = {
      ...codex({ usedPct: 20, resetsAt: future, producedAtMs: clock.nowMs() }),
      unavailableReason: 'codex_probe_temporarily_unavailable',
    };
    out = pass.step([degraded]);
    assert.equal(
      reasonOf(codexOf(out)),
      'codex_probe_temporarily_unavailable',
      'a real degrade flips immediately — the pass does not freeze it to fresh',
    );
  });

  test('Deterministic priority: a higher-priority reason on the candidate wins over a lower one', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });
    // An EXPIRED window (pending, higher priority) presented together with a
    // lower-priority after-valid reason already on the candidate → pending wins.
    const past = new Date(clock.nowMs() - 4 * HOUR).toISOString();
    const c: SourceCandidate = {
      ...claude({ usedPct: 80, resetsAt: past, producedAtMs: clock.nowMs() - 9 * HOUR }),
      unavailableReason: 'native_temporarily_unavailable',
    };
    const out = pass.step([c]);
    assert.equal(reasonOf(claudeOf(out)), 'native_window_reset_pending');
  });

  test('Idempotent: calling step twice with the same input + same clock is byte-identical', () => {
    const clock = fakeClock();
    const pass = createCockpitStabilizationPass({ now: clock.now });
    const future = new Date(clock.nowMs() + 3 * HOUR).toISOString();
    const input = [claude({ usedPct: 44, resetsAt: future, producedAtMs: clock.nowMs() })];
    const a = pass.step(input);
    const b = pass.step(input);
    assert.deepEqual(b, a, 'same input + same clock → identical output');
  });
});
