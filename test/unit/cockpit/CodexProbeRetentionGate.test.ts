// the Codex probe valid→degraded RETENTION gate, as a PER-TICK candidate-list
// transform.
//
// CONTRACT (supersedes the earlier step(outcome) gate-only contract): the
// gate runs on EVERY refresh tick via the loop's transformCandidates seam. It
// operates only on the codex slot and passes every other candidate through. After
// a VALID Codex probe, a later miss / no-candidate tick must RETAIN the last-known
// Codex gauges marked degraded — never revert to the not-configured/blocker card.
// Before any valid probe, an empty codex slot (the no-probe poll tick) injects a
// codex_probe_pending honest candidate when the probe is ENABLED, and injects
// NOTHING when disabled (the gatherer's codex_probe_disabled stands). The gate is
// pure + stateful; it carries only the already-sanitized probe candidate fields.

import * as assert from 'node:assert/strict';
import {
  CODEX_FRESH_GRACE_MS,
  CODEX_FRESH_TTL_MS,
  CODEX_SAMPLE_FRESH_MS,
  type CodexProbeRetentionGate,
  createCodexProbeRetentionGate,
} from '../../../src/cockpit/CodexProbeRetentionGate';
import { PROBE_MIN_INTERVAL_MS } from '../../../src/cockpit/NativeStatusRefreshLoop';
import type { CockpitFieldReason } from '../../../src/core/cockpit/CockpitState';
import type { SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';

// A manual clock for the freshness-TTL tests: advance() moves the wall clock; the
// gate reads it via the injected now().
function fakeClock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return {
    now: (): Date => new Date(ms),
    advance: (deltaMs: number): void => {
      ms += deltaMs;
    },
  };
}

// A claude candidate that must always pass through untouched.
function claudeCandidate(): SourceCandidate {
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: 0,
    scope: { provider: 'anthropic', agent: 'claude-code' },
    confidence: 'high',
    session: { usedPct: 50 },
  };
}

// A valid codex_status_snapshot candidate (1%/5% etc). Optional resetsAt keys let
// the conservative-window tests model a real reset (a newer resetsAt) vs a stale
// lower in-window reading (same resetsAt).
function validCodex(
  over: {
    sessionPct?: number;
    weeklyPct?: number;
    sessionResetsAt?: string;
    weeklyResetsAt?: string;
  } = {},
): SourceCandidate {
  const sessionPct = over.sessionPct ?? 1;
  const weeklyPct = over.weeklyPct ?? 5;
  return {
    sourceTier: 'codex_status_snapshot',
    producedAtMs: 0,
    scope: { provider: 'openai', agent: 'codex' },
    confidence: 'medium',
    session: {
      usedPct: sessionPct,
      leftPct: 100 - sessionPct,
      ...(over.sessionResetsAt !== undefined ? { resetsAt: over.sessionResetsAt } : {}),
    },
    weekly: {
      usedPct: weeklyPct,
      leftPct: 100 - weeklyPct,
      ...(over.weeklyResetsAt !== undefined ? { resetsAt: over.weeklyResetsAt } : {}),
    },
    agentVersion: 'codex/0.137.0',
  };
}

function unavailableReasonOf(c: SourceCandidate | undefined): string | undefined {
  return (c as { unavailableReason?: string } | undefined)?.unavailableReason;
}

function codexBlocker(reason: CockpitFieldReason): SourceCandidate {
  return {
    sourceTier: 'unknown',
    producedAtMs: 0,
    scope: { provider: 'openai', agent: 'codex' },
    unavailableReason: reason,
  };
}

function codexOf(list: readonly SourceCandidate[]): SourceCandidate | undefined {
  return list.find((c) => c.scope.agent === 'codex');
}

function enabledGate(): CodexProbeRetentionGate {
  return createCodexProbeRetentionGate({ probeEnabled: true });
}

suite('CodexProbeRetentionGate — per-tick list transform', () => {
  test('Passes a non-codex candidate through unchanged', () => {
    const gate = enabledGate();
    const out = gate.step([claudeCandidate()]);
    const claude = out.find((c) => c.scope.agent === 'claude-code');
    assert.ok(claude, 'the claude candidate survives');
    assert.equal(claude?.session?.usedPct, 50);
  });

  // (a) Retention (supersedes the earlier always-degrade behavior): a valid probe
  //     tick then several no-probe poll ticks WITHIN the freshness TTL → the codex
  //     card stays at the retained-FRESH last-known across every no-probe tick (no
  //     fresh↔degraded flicker); NEVER not-configured, NEVER a degraded reason.
  test('(a) valid then several within-TTL no-codex-candidate ticks STAY FRESH (no flicker)', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });

    const first = codexOf(
      gate.step([claudeCandidate(), validCodex({ sessionPct: 1, weeklyPct: 5 })]),
    );
    assert.equal(first?.sourceTier, 'codex_status_snapshot');
    assert.equal(first?.session?.usedPct, 1);
    assert.equal((first as { unavailableReason?: string }).unavailableReason, undefined);

    // Three no-probe poll ticks ~10s apart, all comfortably within the TTL (>60s
    // probe floor) — the candidate list has ONLY the claude card each time.
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000);
      const tick = gate.step([claudeCandidate()]);
      const codex = codexOf(tick);
      assert.ok(codex, 'the codex card is injected on a no-probe tick (never absent)');
      assert.equal(codex?.sourceTier, 'codex_status_snapshot', 'retained value kept');
      assert.equal(codex?.session?.usedPct, 1, 'retained 1%');
      assert.equal(codex?.weekly?.usedPct, 5, 'retained 5%');
      assert.equal(
        (codex as { unavailableReason?: string }).unavailableReason,
        undefined,
        'WITHIN TTL the retained value is FRESH — no degraded reason (no flicker)',
      );
    }
  });

  // (a2) The TTL strictly exceeds the 60s probe cadence floor plus
  //      poll jitter so a normal cadence keeps the card continuously fresh.
  test('(a2) CODEX_FRESH_TTL_MS strictly exceeds the 60s probe cadence floor', () => {
    assert.ok(
      CODEX_FRESH_TTL_MS > 60_000,
      `the freshness TTL (${CODEX_FRESH_TTL_MS}) must exceed the 60s probe floor`,
    );
  });

  // (a3) A no-probe poll tick AFTER the TTL → the retained value goes
  //      stale/degraded (codex_probe_stale) — NOT unavailable/no-source, the value
  //      is still kept.
  test('(a3) a no-probe tick after the TTL marks the retained value stale (value kept)', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 7, weeklyPct: 9 })]);

    // Advance beyond the TTL with no probe — the held value is now overdue.
    clock.advance(CODEX_FRESH_TTL_MS + 1);
    const codex = codexOf(gate.step([claudeCandidate()]));
    assert.ok(codex, 'the codex card is still present (never blanks)');
    assert.equal(codex?.sourceTier, 'codex_status_snapshot', 'retained value kept');
    assert.equal(codex?.session?.usedPct, 7, 'value retained even when stale');
    assert.equal(
      (codex as { unavailableReason?: string }).unavailableReason,
      'codex_probe_stale',
      'beyond TTL → stale/degraded, NOT unavailable/no-source',
    );
  });

  // (a4) A within-bound no-probe tick stays
  //      fresh, and a fresh probe RESETS the sample-age window. This makes the
  //      honesty bound CADENCE-COMPATIBLE — aligned with the 120s retention TTL so a
  //      held sample never flaps fresh↔stale across a normal 60s no-probe interval.
  test('(a4) a fresh probe resets the sample-age freshness window', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 1, weeklyPct: 5 })]);

    clock.advance(CODEX_SAMPLE_FRESH_MS - 5_000); // still within the tight bound
    const stillFresh = codexOf(gate.step([claudeCandidate()]));
    assert.equal(
      (stillFresh as { unavailableReason?: string }).unavailableReason,
      undefined,
      'still within the tight sample bound → fresh',
    );

    // A fresh probe re-stamps lastValidAtMs.
    gate.step([validCodex({ sessionPct: 2, weeklyPct: 6 })]);
    clock.advance(CODEX_SAMPLE_FRESH_MS - 5_000); // within the NEW window
    const afterReset = codexOf(gate.step([claudeCandidate()]));
    assert.equal(afterReset?.session?.usedPct, 2, 'recovered value retained');
    assert.equal(
      (afterReset as { unavailableReason?: string }).unavailableReason,
      undefined,
      'a fresh probe resets the sample age — still fresh after the same elapsed time',
    );
  });

  // (b) a later valid probe tick → recovers to fresh native values, no degraded reason.
  test('(b) a later valid probe recovers to fresh native values', () => {
    const gate = enabledGate();
    gate.step([validCodex({ sessionPct: 1, weeklyPct: 5 })]);
    gate.step([claudeCandidate()]); // no-probe tick (retained)
    const recovered = codexOf(gate.step([validCodex({ sessionPct: 3, weeklyPct: 8 })]));
    assert.equal(recovered?.session?.usedPct, 3);
    assert.equal(recovered?.weekly?.usedPct, 8);
    assert.equal((recovered as { unavailableReason?: string }).unavailableReason, undefined);
  });

  // (c) enabled but never valid: a no-codex-candidate tick injects codex_probe_pending
  //     (NOT no_source); a blocker tick passes the exact reason through.
  test('(c) enabled-never-valid: empty codex slot injects codex_probe_pending, not no_source', () => {
    const gate = enabledGate();
    const codex = codexOf(gate.step([claudeCandidate()]));
    assert.ok(codex, 'a codex card is injected so the card never blanks');
    assert.equal(codex?.sourceTier, 'unknown');
    assert.equal(
      (codex as { unavailableReason?: string }).unavailableReason,
      'codex_probe_pending',
      'enabled-never-valid surfaces probe-pending, not no_source',
    );
  });

  test('(c2) enabled-never-valid: a blocker passes the exact reason through, then is re-surfaced on an empty tick', () => {
    const gate = enabledGate();
    const blockerOut = codexOf(gate.step([codexBlocker('codex_native_status_unavailable')]));
    assert.equal(
      (blockerOut as { unavailableReason?: string }).unavailableReason,
      'codex_native_status_unavailable',
    );
    // A later empty tick re-surfaces the last exact unavailable reason, not pending.
    const emptyOut = codexOf(gate.step([claudeCandidate()]));
    assert.equal(
      (emptyOut as { unavailableReason?: string }).unavailableReason,
      'codex_native_status_unavailable',
    );
  });

  // (d) disabled: the gatherer emits codex_probe_disabled every tick → the gate
  //     passes it through and NEVER injects (zero-spawn posture upstream).
  test('(d) disabled: codex_probe_disabled passes through; an empty tick injects NOTHING', () => {
    const gate = createCodexProbeRetentionGate({ probeEnabled: false });
    const out = gate.step([claudeCandidate(), codexBlocker('codex_probe_disabled')]);
    const codex = codexOf(out);
    assert.equal(
      (codex as { unavailableReason?: string }).unavailableReason,
      'codex_probe_disabled',
    );

    // A degenerate empty tick (no codex candidate) while disabled → never fabricate.
    const emptyOut = gate.step([claudeCandidate()]);
    assert.equal(codexOf(emptyOut), undefined, 'disabled gate must never inject a codex card');
  });

  // After a valid result, a blocker tick retains the last-known degraded.
  test('Valid then a blocker tick retains the last-known value, degraded', () => {
    const gate = enabledGate();
    gate.step([validCodex({ sessionPct: 1, weeklyPct: 5 })]);
    const out = codexOf(gate.step([codexBlocker('codex_probe_failed')]));
    assert.equal(out?.sourceTier, 'codex_status_snapshot');
    assert.equal(out?.session?.usedPct, 1);
    assert.equal(out?.weekly?.usedPct, 5);
    assert.equal(
      (out as { unavailableReason?: string }).unavailableReason,
      'codex_probe_temporarily_unavailable',
    );
  });

  // A protocol/parse drift after a valid result retains with the parse reason.
  test('A protocol drift after valid retains with codex_probe_parse_failed_after_valid', () => {
    const gate = enabledGate();
    gate.step([validCodex()]);
    const out = codexOf(gate.step([codexBlocker('codex_protocol_drift')]));
    assert.equal(
      (out as { unavailableReason?: string }).unavailableReason,
      'codex_probe_parse_failed_after_valid',
    );
    assert.equal(out?.session?.usedPct, 1);
  });

  // (f) Privacy: a retained/injected candidate carries only sanitized probe fields.
  test('(f) retained/injected candidates carry only sanitized probe fields', () => {
    const gate = enabledGate();
    gate.step([validCodex()]);
    const retained = codexOf(gate.step([claudeCandidate()]));
    const keys = Object.keys(retained ?? {}).sort();
    for (const forbidden of ['accountId', 'sessionId', 'path', 'cwd', 'home', 'thread']) {
      assert.ok(!keys.includes(forbidden), `retained candidate must not carry ${forbidden}`);
    }
    const serialized = JSON.stringify(retained);
    assert.ok(!/\/home\/|\/Users\//.test(serialized), 'no raw path may appear');

    // The injected never-valid pending candidate is likewise minimal.
    const freshGate = enabledGate();
    const pending = codexOf(freshGate.step([claudeCandidate()]));
    const pendingSerialized = JSON.stringify(pending);
    assert.ok(!/\/home\/|\/Users\//.test(pendingSerialized), 'pending candidate carries no path');
  });
});

// CONSERVATIVE near-limit. A Codex probe sample
// can lag the live native status, and a newer probe may report a LOWER in-window
// used% than an earlier higher reading. The gate must mirror the Claude
// conservative-max / reset-window-aware posture: never display a LOWER used% than a
// newer/higher known used% within the SAME window; only a genuine reset (a newer
// resetsAt) may lower the gauge.
suite('CodexProbeRetentionGate — conservative near-limit', () => {
  const RESET_A = '2026-06-16T05:00:00.000Z';
  const RESET_B = '2026-06-16T10:00:00.000Z'; // a LATER reset → a real new window

  test('A later LOWER in-window probe never lowers the 5h gauge (holds the higher used%)', () => {
    const gate = enabledGate();
    // First probe: 93% used on the 5h window (near limit), same reset.
    gate.step([validCodex({ sessionPct: 93, sessionResetsAt: RESET_A })]);
    // A later probe reports a LOWER 77% for the SAME window — a lagging/stale view.
    const out = codexOf(gate.step([validCodex({ sessionPct: 77, sessionResetsAt: RESET_A })]));
    assert.equal(
      out?.session?.usedPct,
      93,
      'never reverts to the lower 77% within the same window',
    );
    assert.equal(out?.session?.leftPct, 7, 'leftPct stays conservative (least remaining)');
  });

  test('A later HIGHER in-window probe moves the gauge UP and holds', () => {
    const gate = enabledGate();
    gate.step([validCodex({ sessionPct: 80, sessionResetsAt: RESET_A })]);
    const up = codexOf(gate.step([validCodex({ sessionPct: 91, sessionResetsAt: RESET_A })]));
    assert.equal(up?.session?.usedPct, 91, 'a newer higher used% is accepted (gauge increases)');
    // A subsequent lower reading does not pull it back down.
    const held = codexOf(gate.step([validCodex({ sessionPct: 85, sessionResetsAt: RESET_A })]));
    assert.equal(held?.session?.usedPct, 91, 'the higher used% holds, never reverts');
  });

  test('A genuine reset (newer resetsAt) is the ONLY path that may lower the gauge', () => {
    const gate = enabledGate();
    gate.step([validCodex({ sessionPct: 93, sessionResetsAt: RESET_A })]);
    // A new window (later resetsAt) legitimately starts low.
    const reset = codexOf(gate.step([validCodex({ sessionPct: 4, sessionResetsAt: RESET_B })]));
    assert.equal(reset?.session?.usedPct, 4, 'a real reset (newer window) accepts the lower value');
  });

  test('Conservative-max applies independently to 5h and weekly', () => {
    const gate = enabledGate();
    gate.step([
      validCodex({
        sessionPct: 90,
        weeklyPct: 60,
        sessionResetsAt: RESET_A,
        weeklyResetsAt: RESET_A,
      }),
    ]);
    const out = codexOf(
      gate.step([
        validCodex({
          sessionPct: 70,
          weeklyPct: 40,
          sessionResetsAt: RESET_A,
          weeklyResetsAt: RESET_A,
        }),
      ]),
    );
    assert.equal(out?.session?.usedPct, 90, '5h holds its higher used%');
    assert.equal(out?.weekly?.usedPct, 60, 'weekly holds its higher used% independently');
  });

  test('The conservative held value is what gets RETAINED degraded on a later miss', () => {
    const gate = enabledGate();
    gate.step([validCodex({ sessionPct: 93, sessionResetsAt: RESET_A })]);
    gate.step([validCodex({ sessionPct: 77, sessionResetsAt: RESET_A })]); // rejected lower
    const retained = codexOf(gate.step([codexBlocker('codex_probe_failed')]));
    assert.equal(retained?.session?.usedPct, 93, 'retention keeps the conservative 93%, not 77%');
    assert.equal(
      unavailableReasonOf(retained),
      'codex_probe_temporarily_unavailable',
      'still degraded with the after-valid reason',
    );
  });
});

// FRESHNESS HONESTY made CADENCE-COMPATIBLE.
// REGRESSION: the old sample-fresh bound (30s) was HALF the 60s probe
// floor (PROBE_MIN_INTERVAL_MS), so with the probe enabled and no agent activity a
// held sample inevitably aged past 30s before the next 60s probe arrived → the
// Codex card flapped fresh → stale → fresh every cadence boundary while idle. The
// fix: the user-visible fresh→stale boundary MUST be >= PROBE_MIN_INTERVAL_MS plus
// a grace margin, so a held sample stays FRESH across a normal no-probe interval and
// only degrades when a probe is genuinely OVERDUE / fails / resets / collides.
// Honesty is preserved: the value still degrades on real events, never claims fresh
// once a probe is overdue beyond cadence+grace.
suite('CodexProbeRetentionGate — cadence-compatible freshness', () => {
  // REGRESSION LOCK: the fresh bound must never again drop below the probe cadence
  // plus grace — that is exactly the idle flap.
  test('REGRESSION LOCK: CODEX_SAMPLE_FRESH_MS >= PROBE_MIN_INTERVAL_MS + grace', () => {
    assert.ok(
      CODEX_SAMPLE_FRESH_MS >= PROBE_MIN_INTERVAL_MS + CODEX_FRESH_GRACE_MS,
      `the fresh bound (${CODEX_SAMPLE_FRESH_MS}) must be >= the probe cadence (${PROBE_MIN_INTERVAL_MS}) + grace (${CODEX_FRESH_GRACE_MS}) so a held sample never flaps across a normal no-probe interval`,
    );
    assert.ok(CODEX_FRESH_GRACE_MS > 0, 'the grace margin must be positive (absorb poll jitter)');
  });

  // The freshness bound now aligns with the retention TTL: a held sample is fresh
  // for the whole retention window and goes stale exactly when retention expires.
  test('CODEX_SAMPLE_FRESH_MS aligns with the retention TTL (single boundary, no sub-cadence flap)', () => {
    assert.equal(
      CODEX_SAMPLE_FRESH_MS,
      CODEX_FRESH_TTL_MS,
      'the honesty bound aligns with the retention TTL so there is no second, tighter boundary that flaps mid-cadence',
    );
  });

  // The actual idle-no-flap scenario: a successful probe followed by
  // N poll ticks spanning > the OLD 30s bound but < cadence+grace → the card STAYS
  // fresh, no fresh↔stale cycling.
  test('Idle: poll ticks past the OLD 30s bound but within cadence+grace STAY FRESH (no flap)', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 93 })]);

    // Poll every ~10s up to just under the next probe cadence — every intervening
    // tick must remain bare fresh (the OLD code went stale after 30s here).
    for (let elapsed = 10_000; elapsed < PROBE_MIN_INTERVAL_MS; elapsed += 10_000) {
      clock.advance(10_000);
      const codex = codexOf(gate.step([claudeCandidate()]));
      assert.equal(codex?.session?.usedPct, 93, 'value retained across the idle interval');
      assert.equal(
        unavailableReasonOf(codex),
        undefined,
        `at ${elapsed}ms idle the held sample is still FRESH (no flap) — old code flapped past 30s`,
      );
    }
  });

  // A held sample within the cadence+grace bound stays bare fresh.
  test('A held sample WITHIN the cadence-compatible bound stays bare fresh (no degraded reason)', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 93 })]);
    clock.advance(CODEX_SAMPLE_FRESH_MS - 1_000);
    const codex = codexOf(gate.step([claudeCandidate()]));
    assert.equal(codex?.session?.usedPct, 93, 'value retained');
    assert.equal(unavailableReasonOf(codex), undefined, 'within the bound → bare fresh');
  });

  // Genuinely OVERDUE: a no-probe tick past cadence+grace → stale (value kept).
  test('A held sample OVERDUE beyond cadence+grace surfaces codex_probe_stale (value kept)', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 93 })]);
    // Past the cadence-compatible bound: a probe is genuinely overdue/stuck.
    clock.advance(CODEX_SAMPLE_FRESH_MS + 1_000);
    const codex = codexOf(gate.step([claudeCandidate()]));
    assert.equal(codex?.session?.usedPct, 93, 'value still retained (never blanks)');
    assert.equal(
      unavailableReasonOf(codex),
      'codex_probe_stale',
      'overdue beyond cadence+grace → precise stale reason, never bare fresh',
    );
  });

  // A REAL probe failure after a valid result degrades promptly (NOT gated by the
  // freshness clock) — honesty is not weakened by the larger fresh bound.
  test('A real probe failure after valid degrades promptly (not gated by the fresh clock)', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 93 })]);
    // A failure arrives well WITHIN the fresh bound — it must still degrade now.
    clock.advance(5_000);
    const codex = codexOf(gate.step([codexBlocker('codex_probe_failed')]));
    assert.equal(codex?.session?.usedPct, 93, 'value retained');
    assert.equal(
      unavailableReasonOf(codex),
      'codex_probe_temporarily_unavailable',
      'a real failure degrades immediately regardless of the (larger) fresh bound',
    );
  });

  test('A fresh probe within the bound resets the sample-age window', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 90 })]);
    clock.advance(CODEX_SAMPLE_FRESH_MS - 2_000);
    // A new probe re-stamps the sample-age anchor.
    gate.step([validCodex({ sessionPct: 92 })]);
    clock.advance(CODEX_SAMPLE_FRESH_MS - 2_000); // within the NEW window
    const codex = codexOf(gate.step([claudeCandidate()]));
    assert.equal(
      unavailableReasonOf(codex),
      undefined,
      'a fresh probe resets the sample age → fresh',
    );
  });
});

// The rule-id/boolean-only diagnostics snapshot. The
// Cockpit Diagnostics command renders these fields — they must be a closed-set rule
// id or a boolean ONLY, NEVER a raw path / account / session / thread / value.
suite('CodexProbeRetentionGate.diagnosticsSnapshot — rule-id/boolean only', () => {
  test('Idle before any step; reflects probeEnabled', () => {
    const off = createCodexProbeRetentionGate({ probeEnabled: false }).diagnosticsSnapshot();
    assert.equal(off.probeEnabled, false);
    assert.equal(off.hasLastKnownValid, false);
    assert.equal(off.lastStepRuleId, 'codex_retention_idle');
    assert.equal(off.lastAppliedReason, undefined);

    const on = enabledGate().diagnosticsSnapshot();
    assert.equal(on.probeEnabled, true);
  });

  test('Tracks step rule ids: accepted → held-fresh within TTL, with hasLastKnownValid flipping', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex()]);
    const afterValid = gate.diagnosticsSnapshot();
    assert.equal(afterValid.lastStepRuleId, 'codex_retention_accepted_fresh');
    assert.equal(afterValid.hasLastKnownValid, true);
    assert.equal(afterValid.lastAppliedReason, undefined);

    // A no-codex-candidate tick WITHIN the TTL holds the value FRESH.
    clock.advance(10_000);
    gate.step([claudeCandidate()]);
    const afterMiss = gate.diagnosticsSnapshot();
    assert.equal(afterMiss.lastStepRuleId, 'codex_retention_held_fresh');
    assert.equal(afterMiss.lastAppliedReason, undefined);
    assert.equal(afterMiss.hasLastKnownValid, true);

    // Beyond the TTL the same no-candidate tick goes stale/degraded.
    clock.advance(CODEX_FRESH_TTL_MS);
    gate.step([claudeCandidate()]);
    const afterStale = gate.diagnosticsSnapshot();
    assert.equal(afterStale.lastStepRuleId, 'codex_retention_held_stale');
    assert.equal(afterStale.lastAppliedReason, 'codex_probe_stale');
    assert.equal(afterStale.hasLastKnownValid, true);
  });

  test('Enabled-never-valid no-candidate tick records injected-pending', () => {
    const gate = enabledGate();
    gate.step([claudeCandidate()]);
    const snap = gate.diagnosticsSnapshot();
    assert.equal(snap.lastStepRuleId, 'codex_retention_injected_pending');
    assert.equal(snap.lastAppliedReason, 'codex_probe_pending');
    assert.equal(snap.hasLastKnownValid, false);
  });

  test('Every snapshot field is a boolean or a closed-set rule id — never a raw value', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 42, weeklyPct: 77 })]);
    gate.step([codexBlocker('codex_probe_timeout')]);
    const snap = gate.diagnosticsSnapshot();
    assert.equal(typeof snap.probeEnabled, 'boolean');
    assert.equal(typeof snap.hasLastKnownValid, 'boolean');
    assert.equal(typeof snap.lastStepRuleId, 'string');
    // No session/weekly used% (42/77) or path can appear anywhere in the snapshot.
    // The age field is bucketed seconds (0 with the held clock), never the value.
    const serialized = JSON.stringify(snap);
    assert.ok(!/42|77/.test(serialized), 'no session/weekly value may leak into diagnostics');
    assert.ok(!/\/home\/|\/Users\//.test(serialized), 'no raw path may appear');
  });
});

// The freshness CLARITY block on the diagnostics snapshot.
// A user (and the Cockpit Report) must be able to decide WHY a Codex card vs inline-
// statusline mismatch occurs — probe lag, retained sample, stale sample, wrong
// window, or a correctly-rejected lower sample — WITHOUT scraping anything. Every
// field is a bucketed age, a closed enum, or a boolean.
suite('CodexProbeRetentionGate.diagnosticsSnapshot — freshness clarity', () => {
  test('Distinguishes a FRESH app-server sample from a RETAINED/STALE one', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });

    // none before any valid probe.
    assert.equal(gate.diagnosticsSnapshot().freshnessTier, 'none');
    assert.equal(gate.diagnosticsSnapshot().lastProbeAgeBucketSeconds, undefined);

    // A recent app-server probe → fresh, age ~0s.
    gate.step([validCodex({ sessionPct: 30 })]);
    const fresh = gate.diagnosticsSnapshot();
    assert.equal(fresh.freshnessTier, 'fresh', 'a recent probe reads fresh');
    assert.equal(fresh.lastProbeAgeBucketSeconds, 0, 'age bucketed to whole seconds');

    // Within the tight sample-age bound, a no-probe tick stays fresh.
    clock.advance(CODEX_SAMPLE_FRESH_MS - 5_000);
    gate.step([claudeCandidate()]);
    assert.equal(gate.diagnosticsSnapshot().freshnessTier, 'fresh', 'within bound → still fresh');

    // Past the tight bound → stale (value kept, but no longer current).
    clock.advance(10_000);
    gate.step([claudeCandidate()]);
    const stale = gate.diagnosticsSnapshot();
    assert.equal(stale.freshnessTier, 'stale', 'past the bound → stale');
    assert.ok(
      (stale.lastProbeAgeBucketSeconds ?? 0) > CODEX_SAMPLE_FRESH_MS / 1000,
      'age reflects the elapsed time past the bound',
    );
  });

  test('An after-valid miss (not pure age) reads as RETAINED', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([validCodex({ sessionPct: 30 })]);
    // A blocker AFTER a valid result retains-degraded (codex_retention_retained_degraded).
    clock.advance(CODEX_SAMPLE_FRESH_MS + 5_000);
    gate.step([codexBlocker('codex_probe_timeout')]);
    assert.equal(
      gate.diagnosticsSnapshot().freshnessTier,
      'retained',
      'a retained-degraded after-valid miss reads retained, not bare stale',
    );
  });

  test('WindowUsed + resetAtPresent reflect the held sample (booleans/enums only)', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });

    // session-only, no reset.
    gate.step([
      {
        sourceTier: 'codex_status_snapshot',
        producedAtMs: 0,
        scope: { provider: 'openai', agent: 'codex' },
        confidence: 'medium',
        session: { usedPct: 20, leftPct: 80 },
      },
    ]);
    let snap = gate.diagnosticsSnapshot();
    assert.equal(snap.windowUsed, 'session-5h');
    assert.equal(snap.resetAtPresent, false, 'no resetsAt yet');

    // both windows + a reset present.
    gate.step([
      validCodex({
        sessionPct: 25,
        weeklyPct: 40,
        sessionResetsAt: '2099-01-01T00:00:00Z',
      }),
    ]);
    snap = gate.diagnosticsSnapshot();
    assert.equal(snap.windowUsed, 'both');
    assert.equal(snap.resetAtPresent, true, 'a parseable resetsAt is present (boolean only)');
  });

  test('ReducerRejectedLower is set when a lower in-window probe was REJECTED', () => {
    const reset = '2026-06-16T05:00:00.000Z';
    const gate = enabledGate();
    assert.equal(gate.diagnosticsSnapshot().reducerRejectedLower, false, 'no rejection yet');
    gate.step([validCodex({ sessionPct: 90, sessionResetsAt: reset })]);
    assert.equal(
      gate.diagnosticsSnapshot().reducerRejectedLower,
      false,
      'first sample is not a rejection',
    );
    // A lower in-window sample (same resetsAt) is held back by the reducer.
    gate.step([validCodex({ sessionPct: 70, sessionResetsAt: reset })]);
    assert.equal(
      gate.diagnosticsSnapshot().reducerRejectedLower,
      true,
      'a rejected lower in-window probe sets the boolean flag',
    );
  });

  test('The freshness block never leaks a raw value/path (privacy)', () => {
    const clock = fakeClock();
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    gate.step([
      validCodex({
        sessionPct: 88,
        weeklyPct: 63,
        sessionResetsAt: '2099-03-04T05:06:07Z',
      }),
    ]);
    const snap = gate.diagnosticsSnapshot();
    const serialized = JSON.stringify(snap);
    assert.ok(!/88|63/.test(serialized), 'no used% value may leak');
    assert.ok(!serialized.includes('2099-03-04'), 'no raw reset timestamp may leak');
    assert.ok(!/\/home\/|\/Users\//.test(serialized), 'no raw path may appear');
    // The tier/window are closed enums; age is a bucketed number.
    assert.ok(['fresh', 'retained', 'stale', 'none'].includes(snap.freshnessTier));
    assert.ok(['session-5h', 'weekly', 'both', 'none'].includes(snap.windowUsed));
    assert.equal(typeof snap.resetAtPresent, 'boolean');
    assert.equal(typeof snap.reducerRejectedLower, 'boolean');
  });
});

// A disabled probe is AUTHORITATIVE — the gate must NEVER surface a
// prior valid/timeout state as the disabled card. codex_probe_disabled always wins,
// drops retained state, and passes through honestly.
suite('CodexProbeRetentionGate — disabled is authoritative', () => {
  test('Valid → timeout → disabled ⇒ codex_probe_disabled (no retained timeout)', () => {
    const gate = enabledGate();
    gate.step([validCodex({ sessionPct: 80 })]); // a valid sample is now held
    const timedOut = gate.step([codexBlocker('codex_probe_timeout')]);
    // with a held value, a timeout retains degraded — not disabled yet
    assert.notEqual(unavailableReasonOf(codexOf(timedOut)), 'codex_probe_disabled');
    const out = gate.step([codexBlocker('codex_probe_disabled')]);
    assert.equal(
      unavailableReasonOf(codexOf(out)),
      'codex_probe_disabled',
      'disabled must win — never a retained timeout/temporarily-unavailable',
    );
  });

  test('Never-valid timeout → disabled ⇒ codex_probe_disabled', () => {
    const gate = enabledGate();
    gate.step([codexBlocker('codex_probe_timeout')]);
    const out = gate.step([codexBlocker('codex_probe_disabled')]);
    assert.equal(unavailableReasonOf(codexOf(out)), 'codex_probe_disabled');
  });

  test('Valid → disabled ⇒ disabled (retained value dropped); later miss does not resurrect it', () => {
    const gate = enabledGate();
    gate.step([validCodex({ sessionPct: 80 })]);
    const disabled = gate.step([codexBlocker('codex_probe_disabled')]);
    assert.equal(unavailableReasonOf(codexOf(disabled)), 'codex_probe_disabled');
    // a subsequent no-codex-candidate tick must not re-emit the dropped value as fresh
    const after = gate.step([claudeCandidate()]);
    const codex = codexOf(after);
    if (codex !== undefined) {
      assert.notEqual(codex.session?.usedPct, 80, 'dropped value must not resurface');
    }
  });

  test('Claude candidate still passes through untouched alongside a disabled codex tick', () => {
    const gate = enabledGate();
    const out = gate.step([claudeCandidate(), codexBlocker('codex_probe_disabled')]);
    const claude = out.find((c) => c.scope.agent === 'claude-code');
    assert.equal(claude?.session?.usedPct, 50);
    assert.equal(unavailableReasonOf(codexOf(out)), 'codex_probe_disabled');
  });
});
