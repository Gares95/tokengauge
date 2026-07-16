// the Codex probe valid→degraded RETENTION gate, applied as a PER-TICK candidate
// list transform.
//
// MIRROR of the Claude after-valid retention (ClaudeSnapshotStabilityGate)
// applied to the Codex app-server probe. CONFIRMED ROOT CAUSE (do not re-derive):
// the Codex probe runs on a ~60s cadence floor, but the refresh loop polls every
// 10-15s. On the intervening no-probe poll ticks, when the probe is ENABLED the
// gatherer emits NO codex candidate at all, so the merged candidate set has ZERO
// codex entries → the builder resolves the codex card to emptyCockpitState →
// "No data source configured". The earlier gate only ran INSIDE runProbe (probe
// ticks only), so retention was bypassed on every no-probe tick → the flicker
//.
//
// FIX: the gate is a PER-TICK list transform wired via the loop's
// transformCandidates seam. It runs on EVERY refresh tick — probe
// and no-probe alike — operating ONLY on the codex slot and passing every other
// candidate through unchanged.
//
// CONTRACT (per tick, codex slot only):
//   - a VALID codex candidate present (codex_status_snapshot with a session/weekly
//     value) → ACCEPT it unchanged, REMEMBER it as the last-known value;
//   - a codex FAILURE / blocker candidate present AFTER a valid one → REPLACE it
//     with the retained last-known candidate marked degraded with a precise closed
//     reason (NOT the not-configured/blocker reason):
//       * miss / timeout / run-failure / cli-not-found  →
//         codex_probe_temporarily_unavailable
//       * protocol/parse drift                          →
//         codex_probe_parse_failed_after_valid
//       * an empty/valueless VALID result               →
//         codex_probe_no_data_after_valid
//   - a codex blocker present but NO valid result ever seen → pass it THROUGH
//     unchanged (codex_probe_disabled when off; an exact probe-failed reason when
//     on-but-never-succeeded) so the honest unavailable/disabled card stands;
//   - NO codex candidate present this tick (the no-probe poll tick — the bug):
//       * if a last-known valid exists → INJECT the retained last-known marked
//         degraded (codex_probe_temporarily_unavailable) so the card NEVER
//         collapses to not-configured across the no-probe cadence;
//       * else if the probe is ENABLED but never-valid → inject a stable honest
//         candidate carrying the last emitted unavailable reason, or
//         codex_probe_pending if none — NOT no_source/"No data source configured";
//       * else (probe DISABLED) → inject NOTHING. The gatherer already emits
//         codex_probe_disabled on every tick when disabled, so a disabled tick
//         always has a codex blocker present and never reaches this branch; the
//         gate must never fabricate a codex card while disabled (zero-spawn posture).
//
// The gate is PURE (no I/O, no spawn, no host API) and STATEFUL across refreshes.
// extension.ts builds ONE instance per loop lifetime and resets it on
// rebuild/config-change. It NEVER reads any prompt/transcript/log and carries NO
// raw path/account/session — only the already-sanitized probe candidate fields
// (hashed/medium-confidence). It NEVER fabricates a gauge: retention only
// ever re-surfaces a value that was already produced by a real valid probe.

import type { CockpitFieldReason } from '../core/cockpit/CockpitState';
import type { SourceCandidate } from '../core/cockpit/SourcePriorityResolver';
import { PROBE_MIN_INTERVAL_MS } from './NativeStatusRefreshLoop';

// The probe FRESHNESS TTL. The Codex probe runs on a ~60s
// cadence floor (PROBE_MIN_INTERVAL_MS) while the loop polls every 10-15s, so most
// poll ticks carry NO codex candidate — that is "no new sample due yet", NOT a
// failure. A successful probe keeps the card FRESH until this TTL expires (or an
// actual failure occurs). The TTL is set strictly GREATER than the 60s probe floor
// plus poll jitter (2× the floor) so a normal cadence — a fresh probe at least
// every ~60s — keeps the card continuously fresh across every intervening no-probe
// poll tick, with no fresh↔degraded flicker.
export const CODEX_FRESH_TTL_MS = 120_000;

// The GRACE margin added on top of the probe cadence
// floor when deciding the fresh→stale boundary. It absorbs poll jitter, debounce,
// and probe execution latency so a probe that lands a little late on a normal
// cadence still keeps the card fresh. Equal to one cadence interval, which lands the
// boundary at 2× the floor (= CODEX_FRESH_TTL_MS) — the same retention window.
export const CODEX_FRESH_GRACE_MS = PROBE_MIN_INTERVAL_MS;

// The user-visible sample-freshness bound, made
// CADENCE-COMPATIBLE. REGRESSION being fixed here: the old bound was
// 30_000 ms — HALF the 60s PROBE_MIN_INTERVAL_MS probe floor — so with the probe
// ENABLED and no agent activity, a held sample inevitably aged past 30s before the
// next 60s probe arrived, flapping the Codex card fresh → stale → fresh on every
// cadence boundary while idle. A normal no-probe interval is NOT a failure.
//
// The bound MUST be >= PROBE_MIN_INTERVAL_MS + CODEX_FRESH_GRACE_MS so a held
// sample stays FRESH across a normal probe interval; the card only degrades to
// stale when a probe is genuinely OVERDUE (beyond cadence+grace), fails,
// resetAt-expires, collides, or the source is disabled/unavailable. It
// aligns with CODEX_FRESH_TTL_MS so there is a SINGLE fresh→stale boundary at the
// retention window — no second, tighter boundary that flaps mid-cadence. Honesty
// is preserved: a real probe failure degrades immediately (the blocker path), and
// a sample overdue beyond the boundary surfaces the precise `codex_probe_stale`
// reason (value KEPT, never blanked) instead of bare fresh.
export const CODEX_SAMPLE_FRESH_MS = PROBE_MIN_INTERVAL_MS + CODEX_FRESH_GRACE_MS;

// A rule-id/boolean-ONLY diagnostics surface for the
// bounded Cockpit Diagnostics command. EVERY field is a closed-set rule id or a
// boolean — NEVER a raw path / account / session / thread / prompt / log / value.
export interface CodexProbeRetentionDiagnosticsSnapshot {
  // Whether the probe is effectively enabled after user opt-in and
  // card-visibility gates.
  readonly probeEnabled: boolean;
  // Whether a last-known VALID Codex value is currently held (a boolean — never
  // the value itself, never session/weekly numbers).
  readonly hasLastKnownValid: boolean;
  // The rule id the gate emitted for the codex slot on the most recent tick
  // (e.g. accepted-fresh / retained-degraded / injected-pending / passed-blocker),
  // or 'codex_retention_idle' before the first step.
  readonly lastStepRuleId: CodexRetentionStepRuleId;
  // The closed reason the gate last applied to the codex slot (a closed-set rule
  // id), or undefined when the last step accepted a fresh value.
  readonly lastAppliedReason: CockpitFieldReason | undefined;
  // The freshness CLARITY block. Every field below is a
  // bucketed age, a closed-set tier/window enum, or a boolean — NEVER a raw value,
  // account, session, path, or reset timestamp. These let a user (and the Cockpit
  // Report) decide WHY a Codex card vs inline-statusline mismatch occurs — probe
  // lag, retained sample, stale sample, wrong window, or rejected-lower — WITHOUT
  // scraping anything.
  //
  // The age of the last accepted app-server probe, BUCKETED to whole seconds
  // (Math.round). Undefined before the first valid probe. A coarse age — never a
  // precise timestamp, never the probe payload.
  readonly lastProbeAgeBucketSeconds: number | undefined;
  // The freshness tier of the currently-held Codex sample, decided against the
  // sample-age bound (CODEX_SAMPLE_FRESH_MS): a sample within the bound is
  // `fresh` (recent app-server probe); one past the bound (still retained, value
  // kept) is `stale`; `retained` covers a held value degraded by an after-valid
  // miss/parse/no-data reason that is not purely age. `none` before any valid probe.
  readonly freshnessTier: CodexFreshnessTier;
  // Which limit window the held sample carries a value for — `session-5h`,
  // `weekly`, `both`, or `none`. A boolean-grade enum; never the used% itself.
  readonly windowUsed: CodexWindowUsed;
  // Whether the held sample's window(s) carry a parseable resetsAt (a boolean —
  // never the timestamp). Lets diagnostics distinguish "we know the reset" from
  // "no reset known" without leaking the reset instant.
  readonly resetAtPresent: boolean;
  // Whether the conservative per-window reducer has REJECTED a lower in-window
  // probe at least once (a lagging sample reported a lower used% that was held
  // back). A boolean — never the rejected value. Distinguishes "the card is high
  // because a lower lagging sample was correctly rejected" from a conversion bug.
  readonly reducerRejectedLower: boolean;
}

// The freshness tier of the held Codex sample. `fresh`
// == a recent app-server probe within the sample-age bound; `stale` == a held
// value past the bound (kept, but no longer current); `retained` == held + degraded
// by a non-age after-valid reason; `none` == no valid probe ever accepted.
export type CodexFreshnessTier = 'fresh' | 'retained' | 'stale' | 'none';

// Which limit window the held sample has a value for (closed enum).
export type CodexWindowUsed = 'session-5h' | 'weekly' | 'both' | 'none';

// Closed-set rule ids describing what the gate did with the codex slot on a tick.
export type CodexRetentionStepRuleId =
  | 'codex_retention_idle'
  | 'codex_retention_accepted_fresh'
  | 'codex_retention_retained_degraded'
  | 'codex_retention_injected_retained'
  // A no-probe poll tick with a held value WITHIN the
  // freshness TTL re-emits the last-known value AS FRESH (no degraded reason); a
  // tick beyond the TTL re-emits it RETAINED-STALE (codex_probe_stale).
  | 'codex_retention_held_fresh'
  | 'codex_retention_held_stale'
  | 'codex_retention_injected_pending'
  | 'codex_retention_passed_blocker'
  | 'codex_retention_passed_through';

export interface CodexProbeRetentionGate {
  // Run one refresh's full candidate list through the gate. Returns the list with
  // the codex slot normalised (accepted / retained-degraded / injected / passed
  // through); every non-codex candidate is returned unchanged in place.
  step(candidates: readonly SourceCandidate[]): readonly SourceCandidate[];
  // Rule-id/boolean-only snapshot for the Cockpit Diagnostics command. No values.
  diagnosticsSnapshot(): CodexProbeRetentionDiagnosticsSnapshot;
}

export interface CodexProbeRetentionGateOptions {
  // Mirrors the effective Codex probe permission. Decides the never-valid
  // no-candidate injection: when the probe is ENABLED an empty codex
  // slot is filled with codex_probe_pending (or the last unavailable reason); when
  // DISABLED the gate never injects (the gatherer's codex_probe_disabled stands).
  readonly probeEnabled: boolean;
  // An injected clock so the gate can distinguish "no probe
  // due yet, still fresh" (a held value within CODEX_FRESH_TTL_MS) from "probe
  // overdue/stuck" (the TTL expired → retained-stale). Pure: no I/O. Defaults to a
  // real clock for production; tests inject a controllable one.
  readonly now?: () => Date;
}

function isCodex(candidate: SourceCandidate): boolean {
  return candidate.scope.agent === 'codex';
}

// Per-window conservative hold (mirror of the Claude
// conservative reducer). Within a window (keyed by resetsAt) usedPct only moves UP and
// leftPct only moves DOWN; a genuine reset (a NEWER resetsAt) is the only path
// that may lower the gauge. A probe sample lagging the live native status can
// report a stale LOWER reading — that must never pull the gauge down.
type CodexMetric = 'session' | 'weekly';

interface CodexMetricHold {
  resetMs: number | undefined;
  usedPct: number | undefined;
  leftPct: number | undefined;
}

function resetMsOf(window: { resetsAt?: string } | undefined): number | undefined {
  const resetsAt = window?.resetsAt;
  if (typeof resetsAt !== 'string' || resetsAt.length === 0) {
    return undefined;
  }
  const ms = Date.parse(resetsAt);
  return Number.isNaN(ms) ? undefined : ms;
}

// A value-bearing codex candidate: the native snapshot tier carrying a real
// session OR weekly used-percent. A snapshot with neither (a future valueless
// mapping) is treated as "no data" rather than a value-bearer.
function isValidCodexValue(candidate: SourceCandidate): boolean {
  return (
    candidate.sourceTier === 'codex_status_snapshot' &&
    (candidate.session?.usedPct !== undefined || candidate.weekly?.usedPct !== undefined)
  );
}

// A codex blocker: the unknown tier carrying a closed unavailable reason (no
// value). Produced by the gatherer (disabled) or runProbe (probe failure).
function isCodexBlocker(candidate: SourceCandidate): boolean {
  return candidate.sourceTier === 'unknown' && candidate.unavailableReason !== undefined;
}

// Map a blocker's reason to the precise after-valid retention reason. Drift/parse
// → parse_failed_after_valid; everything else (timeout, run failure, cli-not-found,
// generic unavailable) → temporarily_unavailable. A valueless VALID result is
// handled separately (no_data_after_valid) before this is called.
function retentionReasonFor(blockerReason: CockpitFieldReason | undefined): CockpitFieldReason {
  if (blockerReason === 'codex_protocol_drift') {
    return 'codex_probe_parse_failed_after_valid';
  }
  return 'codex_probe_temporarily_unavailable';
}

export function createCodexProbeRetentionGate(
  options: CodexProbeRetentionGateOptions,
): CodexProbeRetentionGate {
  const { probeEnabled } = options;
  const now = options.now ?? ((): Date => new Date());
  // The last-known VALID codex candidate (value-bearing). Undefined until the
  // first valid probe; once set, a later miss/no-candidate retains it degraded.
  let lastKnownValid: SourceCandidate | undefined;
  // The wall-clock ms at which the last VALID codex result
  // was accepted. The freshness TTL is measured from here, so a successful probe
  // keeps the card fresh across the intervening no-probe poll ticks.
  let lastValidAtMs = 0;
  // The last unavailable reason actually emitted while never-valid — so an empty
  // codex slot before any valid result re-surfaces the precise reason rather than
  // flickering to a generic one.
  let lastUnavailableReason: CockpitFieldReason | undefined;
  // The per-window conservative holds. A lagging probe
  // sample reporting a stale LOWER in-window used% must never lower the gauge; only
  // a genuine reset (a newer resetsAt) may. Mirror of the Claude conservative reducer.
  const holds: Record<CodexMetric, CodexMetricHold> = {
    session: { resetMs: undefined, usedPct: undefined, leftPct: undefined },
    weekly: { resetMs: undefined, usedPct: undefined, leftPct: undefined },
  };
  // Sticky boolean — set once the conservative reducer
  // has held back a lower in-window probe. A boolean only; never the value.
  let reducerRejectedLower = false;
  // Whether the last accepted valid sample carried a
  // parseable resetsAt on either window. Tracked from the emitted (conservative)
  // candidate rather than the reducer hold (the hold only captures resetMs on a
  // first-observation/genuine-reset, so a within-window sample that adds a reset
  // would not update it). A boolean — never the reset instant itself.
  let lastResetAtPresent = false;

  // Apply the conservative reducer to one metric on a fresh valid probe, mutating
  // its hold and returning
  // the conservative { usedPct, leftPct, resetsAt } to surface. Same window (equal/
  // unparseable reset) → max usedPct / min leftPct; a NEWER reset → accept the
  // (possibly lower) incoming as the new window; an OLDER reset → keep the held
  // value (a stale pre-reset sample can never take control back). An omitted
  // metric in a fresh valid probe clears that metric's hold — absence is real
  // source state, not a cue to retain a stale window.
  function reduceMetric(
    metric: CodexMetric,
    window: { usedPct?: number; leftPct?: number; resetsAt?: string } | undefined,
  ): { usedPct: number; leftPct?: number; resetsAt?: string } | undefined {
    if (window === undefined || window.usedPct === undefined) {
      holds[metric] = { resetMs: undefined, usedPct: undefined, leftPct: undefined };
      return undefined;
    }
    const hold = holds[metric];
    const incomingResetMs = resetMsOf(window);
    const hadPrior = hold.usedPct !== undefined;
    const bothTimed = incomingResetMs !== undefined && hold.resetMs !== undefined;
    const isRealReset =
      hadPrior && bothTimed && (incomingResetMs as number) > (hold.resetMs as number);
    const isStaleOldWindow =
      hadPrior && bothTimed && (incomingResetMs as number) < (hold.resetMs as number);

    if (isStaleOldWindow) {
      // A stale older-window sample — keep the held value; never lower.
    } else if (isRealReset || !hadPrior) {
      // First observation or a genuine reset → accept incoming as the new window.
      hold.resetMs = incomingResetMs;
      hold.usedPct = window.usedPct;
      hold.leftPct = window.leftPct;
    } else {
      // Same window → conservative max usedPct / min leftPct; reject a lower used%.
      if (window.usedPct >= (hold.usedPct as number)) {
        hold.usedPct = window.usedPct;
        if (window.leftPct !== undefined) {
          hold.leftPct =
            hold.leftPct === undefined ? window.leftPct : Math.min(hold.leftPct, window.leftPct);
        }
      } else {
        // A lower in-window sample was held back. Record
        // it (boolean only) so diagnostics can explain a high held value as a
        // correctly-rejected lagging sample rather than a conversion bug.
        reducerRejectedLower = true;
      }
    }
    return {
      usedPct: hold.usedPct as number,
      ...(hold.leftPct !== undefined ? { leftPct: hold.leftPct } : {}),
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    };
  }

  // Fold the conservative held session/weekly values into an accepted valid
  // candidate so the emitted (and retained) value is never a lagging lower reading.
  function withConservativeValues(candidate: SourceCandidate): SourceCandidate {
    const session = reduceMetric('session', candidate.session);
    const weekly = reduceMetric('weekly', candidate.weekly);
    return {
      ...candidate,
      ...(session !== undefined ? { session } : {}),
      ...(weekly !== undefined ? { weekly } : {}),
    };
  }
  // Rule-id/boolean-only diagnostics state. Records WHAT the gate did on
  // the most recent tick — never any value. Starts idle until the first step.
  let lastStepRuleId: CodexRetentionStepRuleId = 'codex_retention_idle';
  let lastAppliedReason: CockpitFieldReason | undefined;

  // Build the retained last-known candidate marked degraded with a reason. The
  // value is kept (DEGRADED_WITH_VALUE_REASONS in GaugeCardViewModel); the reason
  // surfaces the honest degraded story.
  function retained(reason: CockpitFieldReason): SourceCandidate {
    // lastKnownValid is guaranteed defined by the call sites below.
    const known = lastKnownValid as SourceCandidate;
    return { ...known, unavailableReason: reason };
  }

  // Re-emit the last-known valid candidate AS FRESH on a
  // no-probe poll tick within the freshness TTL. The producedAtMs is refreshed to
  // `now` so the SourcePriorityResolver's own freshness check does NOT mark it
  // native_status_stale, and NO unavailableReason is carried so the VM renders it
  // fresh — the card stays visually stable across the no-probe cadence (no flicker).
  function retainedFresh(nowMs: number): SourceCandidate {
    const known = lastKnownValid as SourceCandidate;
    const { unavailableReason: _drop, ...rest } = known;
    return { ...rest, producedAtMs: nowMs };
  }

  return {
    step(candidates: readonly SourceCandidate[]): readonly SourceCandidate[] {
      const codex = candidates.filter(isCodex);
      const others = candidates.filter((c) => !isCodex(c));

      // A DISABLED probe is AUTHORITATIVE. If any codex candidate
      //    this tick is the codex_probe_disabled blocker, the probe is off — drop ALL
      //    retained state (last value, freshness anchor, conservative holds, remembered
      //    reason) so a prior timeout/valid can NEVER surface as the disabled card, and
      //    pass the honest disabled blocker through unchanged. Zero spawn is enforced
      //    upstream by the loop's probeDue gate; this gate never spawns.
      const disabled = codex.find((c) => c.unavailableReason === 'codex_probe_disabled');
      if (disabled !== undefined) {
        lastKnownValid = undefined;
        lastValidAtMs = 0;
        lastUnavailableReason = 'codex_probe_disabled';
        lastResetAtPresent = false;
        reducerRejectedLower = false;
        holds.session = { resetMs: undefined, usedPct: undefined, leftPct: undefined };
        holds.weekly = { resetMs: undefined, usedPct: undefined, leftPct: undefined };
        lastStepRuleId = 'codex_retention_passed_blocker';
        lastAppliedReason = 'codex_probe_disabled';
        return [...others, disabled];
      }

      // 1) A fresh valid codex result this tick → accept + remember; card recovers.
      const valid = codex.find(isValidCodexValue);
      if (valid !== undefined) {
        // Fold the CONSERVATIVE per-window held value in
        // so a lagging probe sample reporting a stale LOWER in-window used% can
        // never lower the gauge (only a genuine reset may). The conservative
        // candidate is what gets remembered + emitted + later retained.
        const conservative = withConservativeValues(valid);
        lastKnownValid = conservative;
        // Stamp the freshness anchor on every valid accept so
        // a fresh probe resets the sample-age window.
        lastValidAtMs = now().getTime();
        // Record (boolean only) whether the accepted
        // sample carries a parseable resetsAt on either window.
        lastResetAtPresent =
          resetMsOf(conservative.session) !== undefined ||
          resetMsOf(conservative.weekly) !== undefined;
        lastStepRuleId = 'codex_retention_accepted_fresh';
        lastAppliedReason = undefined;
        return [...others, conservative];
      }

      // 2) A codex blocker present this tick (probe failure / disabled / valueless).
      const blocker = codex.find(isCodexBlocker);
      if (blocker !== undefined) {
        // A valueless VALID snapshot (snapshot tier, no value) reaching here is
        // already classified as "no data"; otherwise use the blocker's reason.
        const reasonIsValueless = blocker.sourceTier === 'codex_status_snapshot';
        if (lastKnownValid !== undefined) {
          const reason = reasonIsValueless
            ? 'codex_probe_no_data_after_valid'
            : retentionReasonFor(blocker.unavailableReason);
          lastStepRuleId = 'codex_retention_retained_degraded';
          lastAppliedReason = reason;
          return [...others, retained(reason)];
        }
        // Never had a value — pass the honest blocker through unchanged and
        // remember its reason for any later no-candidate tick.
        lastUnavailableReason = blocker.unavailableReason;
        lastStepRuleId = 'codex_retention_passed_blocker';
        lastAppliedReason = blocker.unavailableReason;
        return [...others, blocker];
      }

      // A non-blocker codex candidate that is neither valid nor a blocker (e.g. a
      // valueless snapshot with no unavailableReason). Treat exactly like a miss.
      const valuelessCodex = codex.length > 0;
      if (valuelessCodex && lastKnownValid !== undefined) {
        lastStepRuleId = 'codex_retention_retained_degraded';
        lastAppliedReason = 'codex_probe_no_data_after_valid';
        return [...others, retained('codex_probe_no_data_after_valid')];
      }

      // 3) NO usable codex candidate this tick (the no-probe poll tick). This is
      //    "no new sample due yet", NOT a failure (a real failure carries a blocker
      //    and is handled above). Gate on the freshness bound.
      if (lastKnownValid !== undefined) {
        const nowMs = now().getTime();
        // CADENCE-COMPATIBLE honesty bound. A held sample
        // claims bare `fresh` while it is younger than CODEX_SAMPLE_FRESH_MS, which
        // is now PROBE_MIN_INTERVAL_MS + grace (aligned with the retention TTL) so a
        // held sample stays fresh across a normal no-probe interval — no fresh↔stale
        // flap on every cadence boundary while idle (the idle-flap regression).
        // Past the bound the probe is genuinely OVERDUE/stuck: the value is KEPT but
        // degraded with the precise `codex_probe_stale` reason — never bare fresh,
        // never blanked. (A REAL probe failure does not wait for this clock — it
        // arrives as a blocker handled above and degrades immediately.)
        if (nowMs - lastValidAtMs <= CODEX_SAMPLE_FRESH_MS) {
          // Within the bound: re-emit the last-known value AS FRESH (no degraded
          // reason, producedAtMs refreshed) so the card stays visually stable across
          // the no-probe cadence — no fresh↔degraded flicker.
          lastStepRuleId = 'codex_retention_held_fresh';
          lastAppliedReason = undefined;
          return [...others, retainedFresh(nowMs)];
        }
        // Past the cadence-compatible bound — the probe is overdue and the sample can
        // no longer claim to be current vs the live native status. Retain the value
        // but mark it STALE/degraded (never unavailable/no-source).
        lastStepRuleId = 'codex_retention_held_stale';
        lastAppliedReason = 'codex_probe_stale';
        return [...others, retained('codex_probe_stale')];
      }
      if (probeEnabled) {
        // Enabled but never-valid → inject an honest pending/last-unavailable
        // candidate, NOT a not-configured blank.
        const reason = lastUnavailableReason ?? 'codex_probe_pending';
        lastStepRuleId = 'codex_retention_injected_pending';
        lastAppliedReason = reason;
        return [
          ...others,
          {
            sourceTier: 'unknown',
            producedAtMs: Date.now(),
            scope: { provider: 'openai', agent: 'codex' },
            unavailableReason: reason,
          } satisfies SourceCandidate,
        ];
      }
      // Probe disabled and no codex candidate — never fabricate (the gatherer's
      // codex_probe_disabled is the authoritative disabled card). Pass through.
      lastStepRuleId = 'codex_retention_passed_through';
      lastAppliedReason = undefined;
      return candidates;
    },
    diagnosticsSnapshot(): CodexProbeRetentionDiagnosticsSnapshot {
      // Derive the freshness clarity block from the held
      // state, ALWAYS against the same sample-age bound the step() uses, so
      // the diagnostics tier matches the card's fresh/stale decision exactly.
      const hasValid = lastKnownValid !== undefined;
      const ageMs = hasValid ? now().getTime() - lastValidAtMs : undefined;
      const lastProbeAgeBucketSeconds = ageMs === undefined ? undefined : Math.round(ageMs / 1000);
      const freshnessTier: CodexFreshnessTier = !hasValid
        ? 'none'
        : (ageMs as number) <= CODEX_SAMPLE_FRESH_MS
          ? 'fresh'
          : // Past the tight bound: a pure-age miss reads as stale; a held value
            // degraded by a non-age after-valid reason reads as retained.
            lastStepRuleId === 'codex_retention_retained_degraded'
            ? 'retained'
            : 'stale';
      const hasSession = holds.session.usedPct !== undefined;
      const hasWeekly = holds.weekly.usedPct !== undefined;
      const windowUsed: CodexWindowUsed =
        hasSession && hasWeekly
          ? 'both'
          : hasSession
            ? 'session-5h'
            : hasWeekly
              ? 'weekly'
              : 'none';
      const resetAtPresent = lastResetAtPresent;
      return {
        probeEnabled,
        hasLastKnownValid: hasValid,
        lastStepRuleId,
        lastAppliedReason,
        lastProbeAgeBucketSeconds,
        freshnessTier,
        windowUsed,
        resetAtPresent,
        reducerRejectedLower,
      };
    },
  };
}
