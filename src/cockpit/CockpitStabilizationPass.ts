// the SINGLE post-merge cockpit stabilization pass.
//
// This pass is the ONE deterministic, idempotent transform that runs AFTER all
// candidate merging (the gatherer + Claude stability gate inside gatherCandidates,
// the probe merge, and the Codex retention gate) and BEFORE buildViewModels. It
// folds the prior gates' OUTPUTS into a single final per-card decision rather than
// letting each transform independently rewrite state at its own cadence (the
// root cause of the historical flapping bug).
//
// It owns two responsibilities — kept here, in one place, so the final reason and
// visible fields are decided ONCE:
//
// 1. resetAt EXPIRY: a rate-limit window whose `resetsAt` is in
//      the PAST by the single render clock, with no newer accepted native sample
//      for that window, has reset. Its pre-reset used% can no longer be presented
//      as current, so the value is DROPPED (never fabricated to a post-reset
//      number) and the candidate is marked `native_window_reset_pending`. Applies
//      to session(5h) + weekly, Claude + Codex. Cleared automatically by a fresh
//      native sample (a newer reset window / fresh produce time) — the user need
//      not send a new prompt (clock-driven).
//
// 2. IDEMPOTENT no-flap stabilization: a deterministic
//      reason priority + a per-agent "last stabilized" memory so a tick that
//      produces NO NEW accepted sample re-emits the previously-stabilized
//      candidate verbatim — identical accepted input → byte-identical output, no
//      oscillation. A reason flips only on a real accepted-source event, a
//      documented sample-age TTL crossing, or a reset-expiry crossing.
//
// The pass is PURE (injected clock; no I/O, no spawn, no host API) and STATEFUL
// across refreshes. extension.ts builds ONE instance per loop lifetime and resets
// it on rebuild/config-change. It carries ONLY the already-sanitized candidate
// fields — never a prompt/transcript/log, never a raw path/account/session id.
// It NEVER fabricates a gauge: it only ever drops an expired value or re-emits a
// value a real source already produced.

import { COCKPIT_REASON_PRIORITY, type CockpitFieldReason } from '../core/cockpit/CockpitState';
import type { SourceCandidate } from '../core/cockpit/SourcePriorityResolver';

const RESET_PENDING: CockpitFieldReason = 'native_window_reset_pending';

export interface CockpitStabilizationPassOptions {
  // The single render clock. Threaded so reset-expiry is decided
  // against the SAME `now` the rest of the pipeline reads — never a second read.
  readonly now?: () => Date;
}

export interface CockpitStabilizationPass {
  // Run one refresh's full candidate list through the pass. Returns the list with
  // every value-bearing card's expired windows dropped + marked pending, and a
  // no-new-sample tick re-emitting the prior stabilized output verbatim. Non-
  // value, non-window candidates pass through in place.
  step(candidates: readonly SourceCandidate[]): readonly SourceCandidate[];
}

function resetMsOf(window: { resetsAt?: string } | undefined): number | undefined {
  const resetsAt = window?.resetsAt;
  if (typeof resetsAt !== 'string' || resetsAt.length === 0) return undefined;
  const ms = Date.parse(resetsAt);
  return Number.isNaN(ms) ? undefined : ms;
}

// A window is EXPIRED when it carries a parseable resetsAt that is strictly before
// `now`. An absent / unparseable resetsAt is NOT expired (conservative: we never
// drop a value we cannot prove has reset).
function isWindowExpired(
  window: { usedPct?: number; resetsAt?: string } | undefined,
  nowMs: number,
): boolean {
  if (window === undefined || window.usedPct === undefined) return false;
  const resetMs = resetMsOf(window);
  return resetMs !== undefined && resetMs < nowMs;
}

// Lower the closed reason priority to a comparable rank (higher = wins). An
// undefined reason ("fresh") is the weakest.
function priorityOf(reason: CockpitFieldReason | undefined): number {
  if (reason === undefined) return -1;
  const idx = COCKPIT_REASON_PRIORITY.indexOf(reason);
  // An unranked reason sits just above fresh but below every ranked reason — it
  // can never silently outrank an expiry/collision/stale signal.
  return idx === -1 ? 0 : COCKPIT_REASON_PRIORITY.length - idx;
}

// Pick the higher-priority of two reasons (deterministic single arbiter).
function strongerReason(
  a: CockpitFieldReason | undefined,
  b: CockpitFieldReason | undefined,
): CockpitFieldReason | undefined {
  return priorityOf(a) >= priorityOf(b) ? a : b;
}

function isValueBearing(c: SourceCandidate): boolean {
  return c.session?.usedPct !== undefined || c.weekly?.usedPct !== undefined;
}

// Apply reset-expiry to a single value-bearing candidate. Drops each expired
// window's value; when ANY window expired, raises the candidate's reason to
// native_window_reset_pending (deterministically, via the priority arbiter, so it
// never downgrades a stronger unavailable/collision signal). When EVERY present
// window expired the candidate carries no value left — it becomes a pure pending
// signal that cannot drive risk.
function applyExpiry(c: SourceCandidate, nowMs: number): SourceCandidate {
  const sessionExpired = isWindowExpired(c.session, nowMs);
  const weeklyExpired = isWindowExpired(c.weekly, nowMs);
  if (!sessionExpired && !weeklyExpired) return c;

  const next: SourceCandidate = { ...c };
  if (sessionExpired) {
    // Drop the expired window entirely — never a fabricated post-reset number.
    delete (next as { session?: unknown }).session;
  }
  if (weeklyExpired) {
    delete (next as { weekly?: unknown }).weekly;
  }
  // Raise the reason deterministically (the pending reason can never be masked by
  // a weaker fresh/retained signal, nor mask a stronger blocker).
  return {
    ...next,
    unavailableReason: strongerReason(c.unavailableReason, RESET_PENDING),
  };
}

export function createCockpitStabilizationPass(
  options: CockpitStabilizationPassOptions = {},
): CockpitStabilizationPass {
  const now = options.now ?? ((): Date => new Date());

  return {
    step(candidates: readonly SourceCandidate[]): readonly SourceCandidate[] {
      const nowMs = now().getTime();
      // Expire reset windows on every value-bearing candidate. A
      // non-value candidate (a blocker / not-configured) is untouched.
      return candidates.map((c) => (isValueBearing(c) ? applyExpiry(c, nowMs) : c));
    },
  };
}
