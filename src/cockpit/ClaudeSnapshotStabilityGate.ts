// the Claude statusLine snapshot stability gate — CONSERVATIVE + reset-window-aware.
//
// CONFIRMED ROOT CAUSE (do not re-derive): a global Claude statusLine writer
// hardcodes ONE snapshot file path, so Claude sessions from DIFFERENT workspaces
// overwrite it with their own cached account-usage view. The refresh loop
// faithfully re-reads the file each tick (no internal cache), so the cockpit
// value alternated between competing writers (e.g. 87% ↔ 37%).
//
// An earlier gate surfaced the CURRENT reading during alternation, which made the gauge
// bounce. For a usage LIMIT inside a reset window that is wrong: a lagging
// session can write a STALE, LOWER account-usage view, and timestamp-newer is
// NOT proof of higher truth. The gate replaces value selection with
// a CONSERVATIVE, reset-window-aware MONOTONIC reducer:
//
//  - Per metric (session=5h, weekly), hold { windowKey, usedPct=max, leftPct=min }
//    where windowKey is the metric's `resetsAt` (ISO; absent → treat as the SAME
//    window — conservative; never lower without proof of a reset).
//  - same windowKey, incoming usedPct >= held → ACCEPT (max).
//  - same windowKey, incoming usedPct <  held → REJECT the lower value; HOLD;
//    record a rule-id-only diagnostic `lower_usage_snapshot_rejected`.
//  - windowKey CHANGED (a real reset) → ACCEPT incoming (allow lower) as the new
//    window.
//  - VALUE selection is INDEPENDENT of workspace/session identity and capture
//    time. Identity is ONLY collision metadata for the degraded label — never
//    permission to lower the gauge.
//
// Degraded label (decoupled from value): when live writer-interleave evidence
// proves concurrent writers (see the multi-session rework section below), the card is degraded
// `snapshot_writer_collision` WHILE showing the conservative held value. Once
// the evidence ages out, recover to fresh. The value NEVER alternates.
//
// The gate is PURE (injected clock + optional rule-id-only diagnostics sink, no
// filesystem) and STATEFUL across refreshes. It operates ONLY on the Claude
// `statusline_snapshot` candidate; every other candidate passes through
// untouched. extension.ts builds one instance per loop lifetime (resets memory
// on config change). The SAME emitted candidate feeds the status bar and the
// cockpit, so they agree.
//
// After-valid injection (held value preserved across a transient absent/
// valueless refresh) and the recovery/anti-wedge semantics are preserved.
// An absent refresh within ABSENT_GRACE_MS of the last valid read is a
// transient READ ARTIFACT (statusline writers rewrite the file per UI tick) —
// the held value is re-emitted UNDEGRADED and the tick is latch-neutral. Only
// absence persisting beyond the grace degrades the card (see ABSENT_GRACE_MS).
//
// After hibernate/resume + VS Code reload + a reset-window
// change, the 5h gauge flapped again between two open Claude sessions (a
// post-reset value and a stale pre-reset value). ROOT CAUSE: the original
// window-change rule (`incomingKey !== hold.windowKey`) was DIRECTION-AGNOSTIC —
// it accepted ANY resetsAt-key difference as a legitimate reset, IN EITHER TIME
// DIRECTION, so a stale OLD-window writer (older resetsAt) was re-accepted as a
// "window change" and took control back. FIX: compare windows by reset
// TIME (parsed resetsAt epoch ms):
//   - incoming resetsAt NEWER than held → REAL RESET → accept (allow lower);
//   - incoming resetsAt OLDER than held → STALE old-window → REJECT, hold the
//     new-window value, rule-id-only `stale_old_window_rejected`;
//   - EQUAL (same window) or either side unparseable → SAME window → conservative
//     max (conservative behavior unchanged).
// An older window can NEVER take control again. Additionally, the degraded collision
// label is made robust to a hibernate clock jump and a single-session-first
// resume — distinct active writers are aged by last-seen over RECOVERY_QUIET_MS
// rather than gated by a bare 30s window that a clock jump erases. The value
// stays conservative/time-ordered regardless of the label (the reducer owns the
// value; the latch owns only the label).
//
// Multi-session rework — collision requires LIVE INTERLEAVE EVIDENCE.
//
// The earlier model ("collision while >=2 distinct writer keys were seen within
// a quiet window") flagged states that are NOT concurrency: a startup read of a
// stale file followed by the new session's first write, a session restart, or a
// /clear that rotates the session id. Each is ONE writer handing off to another,
// yet the card read "Multiple Claude Code sessions" for minutes, Refresh could
// not clear it, and the user had no way to act on it (UAT: stuck card).
//
// The snapshot file is last-writer-wins, so the ONLY provable concurrency signal
// is an INTERLEAVE: the read key SWITCHES away from a writer and later switches
// BACK (A → B → A). A single switch is a handoff; a second switch within the
// evidence window proves both writers were alive in that window. Therefore:
//
//  - Writer identity = sessionHash ?? workspaceHash (same-workspace sessions are
//    distinguished when the writer emits session_id_hash). Valueless snapshots
//    carry identity too and participate (a pre-first-response session is a real
//    writer).
//  - Every successful statusline read records a SWITCH when its key differs from
//    the previous read's key. Collision is ACTIVE iff >=2 switches happened
//    within COLLISION_EVIDENCE_WINDOW_MS. It stays active while alternation
//    keeps producing switches and clears within ONE window once alternation
//    stops — recovery is driven by observed writes, not a hidden quiet timer,
//    and a manual Refresh tick prunes aged evidence immediately.
//  - The collision reason does NOT engage the sticky label latch (it has its own
//    hysteresis); the latch remains for the after-valid/absent degradations.
//  - While a collision is active, a competing valueless write re-emits the HELD
//    value under the stable collision label (no live↔incomplete flap), and the
//    VM layer mutes the session-specific model/context/cost fields.
//
// Known limit (single shared file, documented in README + bridge guide): when
// two live writers phase-lock so reads only ever see one of them, no interleave
// is observable and the card shows that writer's coherent view — the 5h/weekly
// numbers are account-level so they still reflect both sessions' consumption.
// The single-file bridge is specified as ONE active statusline writer per
// configured snapshot; the per-session snapshot directory mode is the real fix.

import type { CockpitFieldReason } from '../core/cockpit/CockpitState';
import type { SourceCandidate } from '../core/cockpit/SourcePriorityResolver';

// The sliding evidence window for writer-interleave collision
// detection. Collision is ACTIVE iff at least two writer SWITCHES (the read key
// changing between consecutive successful reads) occurred within this window —
// i.e. some writer provably wrote AFTER a different writer did, twice, recently.
// One switch is a handoff (restart / new session / stale-file startup read) and
// never flags. The same window bounds recovery: once alternation stops, the
// remaining switch evidence ages out and the label clears within ONE window —
// there is no separate quiet timer to wait through, and any tick (including a
// manual Refresh) prunes aged evidence. Sized to span several poll ticks (the
// default poll is 15s) so genuine alternation holds the label stably, while
// recovery stays fast enough to feel responsive (~1.5 minutes worst case).
export const COLLISION_EVIDENCE_WINDOW_MS = 90_000;

// How many consecutive valid, unambiguous, single-writer
// refreshes the LABEL must observe before it recovers from a held/after-valid
// degraded state back to fresh. With >1 a single lone valid tick amid alternation
// can NOT flip the label to fresh — the label only goes fresh after a real,
// sustained recovery streak. This governs the LABEL hysteresis only; the
// conservative VALUE selection is unchanged. The collision label
// is exempt from this latch — it carries its own hysteresis via
// COLLISION_EVIDENCE_WINDOW_MS, and stacking the two delayed recovery by an
// extra ~30s for no honesty gain.
export const LABEL_RECOVERY_REFRESHES = 3;

// Oscillation fix: how long after the last VALID value-bearing snapshot read
// an ABSENT refresh (missing / parse-failed → no statusline candidate) is treated
// as a transient READ ARTIFACT rather than a source change. A statusLine writer
// truncates+rewrites (or unlink+renames) the snapshot on every UI tick, so a
// poll-instant read can catch an empty/torn/mid-rename file even though the
// source is healthy. Before this grace, one such tick degraded the card AND
// latched the label for LABEL_RECOVERY_REFRESHES cleans — during active Claude
// use the card visibly oscillated live↔"Temporarily unavailable" every ~10s.
// Within the grace the held value is re-emitted UNDEGRADED and the tick is
// LATCH-NEUTRAL (it neither sets the latch nor resets the recovery streak).
// Absence persisting beyond the grace degrades exactly as before, and the
// resolver's own FRESHNESS_LIMIT_MS still governs value staleness independently.
export const ABSENT_GRACE_MS = 30_000;

const COLLISION_REASON: CockpitFieldReason = 'snapshot_writer_collision';
const NATIVE_TEMPORARILY_UNAVAILABLE: CockpitFieldReason = 'native_temporarily_unavailable';
const SNAPSHOT_INCOMPLETE_AFTER_VALID: CockpitFieldReason = 'snapshot_incomplete_after_valid';

// Rule-id-only diagnostic: a lower in-window usage value was rejected to keep the
// limit conservative. NEVER carries raw values, ids, paths, or timestamps.
const LOWER_USAGE_REJECTED_RULE = 'lower_usage_snapshot_rejected';

// Rule-id-only diagnostic: an OLDER reset window (a stale
// pre-reset writer) was rejected so it can never take control back from the
// accepted newer window. Rule-id only — never a value, id, path, or timestamp.
const STALE_OLD_WINDOW_REJECTED_RULE = 'stale_old_window_rejected';

// A minimal rule-id-only diagnostics sink. The gate records ONLY a ruleId — no
// payload — so nothing leaky can cross.
export interface StabilityGateDiagnostics {
  record(entry: { ruleId: string }): void;
}

export interface ClaudeSnapshotStabilityGateDeps {
  readonly now: () => Date;
  readonly diagnostics?: StabilityGateDiagnostics;
}

export interface ClaudeSnapshotStabilityGate {
  // Run one refresh's candidate list through the gate. The returned list is the
  // same length/order; only the Claude statusline_snapshot candidate may be
  // substituted (conservative held value) or degraded (collision). Resets on a
  // fresh gate instance — extension.ts builds one per loop lifetime.
  step(candidates: readonly SourceCandidate[]): SourceCandidate[];
}

function isClaudeSnapshot(c: SourceCandidate): boolean {
  return c.scope.agent === 'claude-code' && c.sourceTier === 'statusline_snapshot';
}

function isClaudeAgent(c: SourceCandidate): boolean {
  return c.scope.agent === 'claude-code';
}

// A statusline candidate carries a "real value" only when it has a session or
// weekly window — a valueless missing_rate_limits snapshot (cost/model only)
// must never overwrite a held valid value.
function hasNativeValue(c: SourceCandidate): boolean {
  return c.session !== undefined || c.weekly !== undefined;
}

type Metric = 'session' | 'weekly';

// Per-metric conservative hold. windowKey is the metric's resetsAt (or the
// sentinel SAME_WINDOW when absent). usedPct is the max seen for the window;
// leftPct is the min seen. Both move only forward within a window.
interface MetricHold {
  windowKey: string;
  // Parsed epoch ms of windowKey (undefined for SAME_WINDOW / unparseable).
  resetMs: number | undefined;
  usedPct: number | undefined;
  leftPct: number | undefined;
}

// Sentinel windowKey used when a metric carries no resetsAt — treated as the
// SAME window so a value is never lowered without proof of a reset.
const SAME_WINDOW = ' same-window';

function windowKeyOf(window: { resetsAt?: string } | undefined): string {
  const resetsAt = window?.resetsAt;
  return typeof resetsAt === 'string' && resetsAt.length > 0 ? resetsAt : SAME_WINDOW;
}

// Parse a window's resetsAt (ISO) to epoch ms. Returns undefined when absent or
// unparseable. An undefined on either side is treated as the SAME window
// (conservative; never lower without proof of a newer reset).
function resetMsOf(window: { resetsAt?: string } | undefined): number | undefined {
  const resetsAt = window?.resetsAt;
  if (typeof resetsAt !== 'string' || resetsAt.length === 0) {
    return undefined;
  }
  const ms = Date.parse(resetsAt);
  return Number.isNaN(ms) ? undefined : ms;
}

export function createClaudeSnapshotStabilityGate(
  deps: ClaudeSnapshotStabilityGateDeps,
): ClaudeSnapshotStabilityGate {
  const diagnostics = deps.diagnostics;

  // The conservative held value, rebuilt as candidates arrive. `candidate` is the
  // last accepted Claude statusline candidate, MUTATED so its session/weekly
  // usedPct/leftPct carry the conservative held numbers (never a lagging lower
  // reading). Used both for the emitted value and the after-valid injection.
  let heldCandidate: SourceCandidate | undefined;
  const holds: Record<Metric, MetricHold> = {
    session: { windowKey: SAME_WINDOW, resetMs: undefined, usedPct: undefined, leftPct: undefined },
    weekly: { windowKey: SAME_WINDOW, resetMs: undefined, usedPct: undefined, leftPct: undefined },
  };

  // Collision tracking (degraded label ONLY; identity NEVER
  // lowers a value). `lastWriterKey` is the writer key of the most recent
  // successful statusline read; `switchTimesMs` holds the timestamps of recent
  // key SWITCHES (read key != previous read key). Two switches inside the
  // evidence window prove a writer wrote after a different writer did — live
  // concurrency — while a single switch is a handoff and never flags. A read
  // with no key (writer emits no hashes) is identity-neutral: it neither
  // registers a switch nor updates `lastWriterKey`.
  let lastWriterKey: string | undefined;
  const switchTimesMs: number[] = [];

  // The degraded LABEL latch. Once an emitted Claude
  // candidate is degraded by an after-valid/absent reason, the label REMAINS
  // degraded until LABEL_RECOVERY_REFRESHES consecutive valid, unambiguous,
  // single-writer refreshes are observed — so a lone valid tick amid alternation
  // does NOT flip the freshness/degraded label fresh per-tick. The value selection
  // is unchanged; this governs only the surfaced reason. The COLLISION
  // reason is exempt — it carries its own hysteresis (the evidence window), and
  // latching it here made recovery two-stage (collision clears, then 3 more
  // ticks of "Temporarily unavailable") for no honesty gain.
  let labelDegradedLatched = false;
  let consecutiveCleanRefreshes = 0;

  // Oscillation fix: when the last VALID value-bearing statusline read
  // happened, anchoring ABSENT_GRACE_MS. Undefined until a first valid value.
  let lastValidValueAtMs: number | undefined;

  // Record writer-switch evidence for this tick's statusline
  // read (valueless included — a pre-first-response session writes valueless
  // snapshots and IS a real writer), prune evidence older than the window, and
  // report whether a collision is currently active. Session hash identifies the
  // writer when present so same-workspace sessions are distinguished; workspace
  // hash is the fallback for writers that carry no session identity.
  function trackWriterInterleave(candidates: readonly SourceCandidate[], nowMs: number): boolean {
    for (const c of candidates) {
      if (!isClaudeSnapshot(c)) continue;
      const key = c.sessionHash ?? c.workspaceHash;
      if (key === undefined) continue;
      if (lastWriterKey !== undefined && key !== lastWriterKey) {
        switchTimesMs.push(nowMs);
      }
      lastWriterKey = key;
    }
    while (
      switchTimesMs.length > 0 &&
      nowMs - (switchTimesMs[0] as number) > COLLISION_EVIDENCE_WINDOW_MS
    ) {
      switchTimesMs.shift();
    }
    return switchTimesMs.length >= 2;
  }

  // Apply the conservative reducer to one metric. Returns the conservative
  // { usedPct, leftPct } to surface for the metric, or undefined if the metric is
  // absent on the incoming candidate AND never held.
  function reduceMetric(
    metric: Metric,
    window: { usedPct?: number; leftPct?: number; resetsAt?: string } | undefined,
  ): { usedPct?: number; leftPct?: number; resetsAt?: string } | undefined {
    const hold = holds[metric];
    if (window === undefined || window.usedPct === undefined) {
      // Nothing incoming for this metric. Preserve a prior held value if any.
      if (hold.usedPct === undefined) {
        return window;
      }
      return {
        usedPct: hold.usedPct,
        ...(hold.leftPct !== undefined ? { leftPct: hold.leftPct } : {}),
        ...(hold.windowKey !== SAME_WINDOW ? { resetsAt: hold.windowKey } : {}),
      };
    }

    const incomingKey = windowKeyOf(window);
    const incomingResetMs = resetMsOf(window);

    // Classify the incoming window vs the held one by reset
    // TIME, not by bare string difference. The window is only "newer" or "older"
    // when BOTH sides carry a parseable resetsAt; if either side is unparseable we
    // treat it as the SAME window (conservative; never lower without proof).
    const hadPrior = hold.usedPct !== undefined;
    const bothTimed = incomingResetMs !== undefined && hold.resetMs !== undefined;
    const isRealReset =
      hadPrior && bothTimed && (incomingResetMs as number) > (hold.resetMs as number);
    const isStaleOldWindow =
      hadPrior && bothTimed && (incomingResetMs as number) < (hold.resetMs as number);

    if (isStaleOldWindow) {
      // An OLDER reset window than the one held. A stale pre-reset writer must
      // NEVER take control back. Reject; hold the new-window value. Rule-id-only.
      diagnostics?.record({ ruleId: STALE_OLD_WINDOW_REJECTED_RULE });
    } else if (isRealReset) {
      // The incoming reset is genuinely NEWER. This is the ONLY path that lowers
      // the gauge: accept incoming as the new window.
      hold.windowKey = incomingKey;
      hold.resetMs = incomingResetMs;
      hold.usedPct = window.usedPct;
      hold.leftPct = window.leftPct;
    } else {
      // Same window (equal reset / unparseable either side / first observation).
      // Accept higher usedPct; reject lower.
      if (hold.usedPct === undefined) {
        hold.windowKey = incomingKey;
        hold.resetMs = incomingResetMs;
      }
      if (hold.usedPct === undefined || window.usedPct >= hold.usedPct) {
        hold.usedPct = window.usedPct;
        // leftPct moves to the MIN (conservative — least remaining).
        if (window.leftPct !== undefined) {
          hold.leftPct =
            hold.leftPct === undefined ? window.leftPct : Math.min(hold.leftPct, window.leftPct);
        }
      } else {
        // Lower in-window value: reject; hold. Rule-id-only diagnostic.
        diagnostics?.record({ ruleId: LOWER_USAGE_REJECTED_RULE });
      }
    }

    return {
      usedPct: hold.usedPct as number,
      ...(hold.leftPct !== undefined ? { leftPct: hold.leftPct } : {}),
      ...(hold.windowKey !== SAME_WINDOW ? { resetsAt: hold.windowKey } : {}),
    };
  }

  // Build the emitted candidate from the incoming one with the conservative
  // session/weekly values folded in. The incoming candidate supplies all other
  // fields (cost/model/context/scope/identity) verbatim.
  function withConservativeValues(incoming: SourceCandidate): {
    candidate: SourceCandidate;
  } {
    const session = reduceMetric('session', incoming.session);
    const weekly = reduceMetric('weekly', incoming.weekly);

    const candidate: SourceCandidate = {
      ...incoming,
      ...(session !== undefined ? { session } : {}),
      ...(weekly !== undefined ? { weekly } : {}),
    };
    return { candidate };
  }

  function decideClaude(incoming: SourceCandidate, collisionActive: boolean): SourceCandidate {
    // A present-but-valueless statusline candidate (missing_rate_limits) must NOT
    // be turned into a value-bearing one by folding the held value in — the
    // after-valid path (step) needs to see it as valueless to mark it
    // snapshot_incomplete_after_valid. Pass it through untouched.
    if (!hasNativeValue(incoming)) {
      return incoming;
    }
    const { candidate } = withConservativeValues(incoming);

    // Remember the conservative held candidate for after-valid injection.
    if (hasNativeValue(candidate)) {
      heldCandidate = candidate;
    }

    // Collision label (decoupled from value; writer tracking runs once per step).
    if (collisionActive) {
      return { ...candidate, unavailableReason: COLLISION_REASON };
    }
    return candidate;
  }

  // Build the held conservative candidate marked degraded with the right
  // after-valid reason. The retained value/scope stay intact; only the reason +
  // freshness signal degrade.
  function heldDegraded(present: boolean): SourceCandidate {
    const base = heldCandidate as SourceCandidate;
    return {
      ...base,
      unavailableReason: present ? SNAPSHOT_INCOMPLETE_AFTER_VALID : NATIVE_TEMPORARILY_UNAVAILABLE,
    };
  }

  // Apply the sticky degraded-LABEL latch to the emitted
  // output. `cleanThisRefresh` is true when this refresh produced a fresh
  // single-writer value (no collision, exactly one active writer). The latch is
  // set whenever the emitted Claude value-bearing candidate carries a degraded
  // reason; it clears only after LABEL_RECOVERY_REFRESHES consecutive clean
  // refreshes. While latched but otherwise-fresh this refresh, overlay
  // native_temporarily_unavailable so the label does not flip to fresh per-tick.
  function applyLabelLatch(out: SourceCandidate[], cleanThisRefresh: boolean): SourceCandidate[] {
    const idx = out.findIndex((c) => isClaudeSnapshot(c) && hasNativeValue(c));
    const emitted = idx !== -1 ? out[idx] : undefined;
    const emittedReason = emitted?.unavailableReason;
    const emittedDegraded = emittedReason !== undefined;

    if (emittedDegraded) {
      // A degraded value-bearing candidate this refresh → reset the streak, and
      // (re)latch UNLESS the reason is the collision label, which recovers via
      // its own evidence window rather than this latch.
      if (emittedReason !== COLLISION_REASON) {
        labelDegradedLatched = true;
      }
      consecutiveCleanRefreshes = 0;
      return out;
    }

    if (cleanThisRefresh && emitted !== undefined) {
      consecutiveCleanRefreshes += 1;
      if (consecutiveCleanRefreshes >= LABEL_RECOVERY_REFRESHES) {
        labelDegradedLatched = false;
      }
    } else {
      // A refresh with no fresh single-writer value interrupts the recovery streak.
      consecutiveCleanRefreshes = 0;
    }

    if (labelDegradedLatched && emitted !== undefined && idx !== -1) {
      const next = [...out];
      next[idx] = { ...emitted, unavailableReason: NATIVE_TEMPORARILY_UNAVAILABLE };
      return next;
    }
    return out;
  }

  return {
    step(candidates: readonly SourceCandidate[]): SourceCandidate[] {
      const nowMs = deps.now().getTime();
      // Writer-switch evidence is recorded ONCE per step, for every present
      // statusline candidate (valueless included), before any per-candidate
      // decision reads the collision state. Every step also PRUNES aged
      // evidence, so a manual Refresh tick can clear the label without waiting
      // for the next poll.
      const collisionActive = trackWriterInterleave(candidates, nowMs);
      const stepped = candidates.map((c) =>
        isClaudeSnapshot(c) ? decideClaude(c, collisionActive) : c,
      );

      // A "clean" refresh for label-recovery purposes: a fresh Claude value is
      // present this refresh (not the after-valid held path), AND no collision
      // evidence is live. A lone valid tick amid observed alternation is
      // therefore NOT clean (collision keeps it degraded).
      const freshClaude = stepped.find((c) => isClaudeSnapshot(c) && hasNativeValue(c));
      const cleanThisRefresh =
        freshClaude !== undefined &&
        freshClaude.unavailableReason === undefined &&
        !collisionActive;

      // After a valid snapshot, a transient failure must
      // preserve the last-known conservative value. Detect "no valid Claude
      // native value this refresh".
      if (heldCandidate === undefined) {
        // Never had a valid value → pass through (the honest not-configured /
        // blocker card stands). Never inject. The label latch never engages before
        // a first valid value (it has nothing to retain).
        return stepped;
      }
      const valueIndex = stepped.findIndex((c) => isClaudeSnapshot(c) && hasNativeValue(c));
      if (valueIndex !== -1) {
        // A valid Claude native value is present this refresh — nothing to inject.
        lastValidValueAtMs = nowMs;
        return applyLabelLatch(stepped, cleanThisRefresh);
      }

      // No valid native value. A present-but-valueless statusline candidate maps
      // to snapshot_incomplete_after_valid; absence / a blocker maps to
      // native_temporarily_unavailable. REPLACE a present valueless statusline
      // candidate so the empty snapshot never reaches the builder; otherwise
      // APPEND the held degraded candidate.
      const valuelessIndex = stepped.findIndex((c) => isClaudeSnapshot(c) && !hasNativeValue(c));
      if (valuelessIndex !== -1) {
        const out = [...stepped];
        // While a collision is active, a valueless snapshot is a COMPETING
        // session's write (typically a freshly-opened session before its first
        // API response), not our accepted source going incomplete. Re-emit the
        // held value under the stable collision label — the same story the
        // value-bearing ticks tell — instead of flapping to
        // snapshot_incomplete_after_valid every other tick.
        out[valuelessIndex] = collisionActive
          ? { ...(heldCandidate as SourceCandidate), unavailableReason: COLLISION_REASON }
          : heldDegraded(true);
        return applyLabelLatch(out, false);
      }

      // Absent (parse-failed / missing file → no statusline candidate) or only a
      // not-configured/missing blocker for Claude. Drop any Claude blocker so its
      // not-configured reason cannot win over the held degraded reason at the
      // builder (the builder surfaces the FIRST unavailableReason in the group),
      // then inject the held value marked native_temporarily_unavailable. Non-Claude
      // candidates (e.g. the Codex blocker, stats-cache) pass through untouched.
      const withoutClaudeBlockers = stepped.filter(
        (c) => !(isClaudeAgent(c) && c.unavailableReason !== undefined),
      );

      // Oscillation fix: an absent read within ABSENT_GRACE_MS of the last
      // valid one is a transient read artifact (torn/empty/mid-rename file), not
      // a source change. Re-emit the held value UNDEGRADED and stay LATCH-NEUTRAL:
      // the tick neither sets the latch nor touches the recovery streak. While a
      // REAL prior degradation holds the latch, the overlay still applies so the
      // label cannot flash fresh mid-recovery (label hysteresis intact).
      const withinGrace =
        lastValidValueAtMs !== undefined && nowMs - lastValidValueAtMs <= ABSENT_GRACE_MS;
      if (withinGrace) {
        const injected: SourceCandidate = labelDegradedLatched
          ? {
              ...(heldCandidate as SourceCandidate),
              unavailableReason: NATIVE_TEMPORARILY_UNAVAILABLE,
            }
          : { ...(heldCandidate as SourceCandidate) };
        return [...withoutClaudeBlockers, injected];
      }

      return applyLabelLatch([...withoutClaudeBlockers, heldDegraded(false)], false);
    },
  };
}
