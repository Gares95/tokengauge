// The CockpitState model.
//
// CockpitState is the transient, render-only cockpit view: session/5h +
// weekly/7d limit state, cost, model, scope, and a derived risk level. It is
// SEPARATE from the shared native usage taxonomy and upstream SourceCandidate
// inputs.
//
// CockpitState is NOT persisted. There is NO write
// path to any store from this module (TokenGauge is native-only and persists no
// usage events). The dev report renders sanitized text only. If a future phase
// persists CockpitState, that write MUST pass the Redactor sanitization path —
// out of scope here.
//
// Honesty: every field carries BOTH a single canonical `sourceTier`
// AND an `accuracyLabel`, plus `freshnessMs` (age of the underlying source) and
// `confidence`. A field with no usable source is `available: false` with an
// explicit `reason` — never a silent zero. A stale-but-shown native value is
// `available: true` with `reason: 'native_status_stale'` and lowered confidence
//. Scope is hashed-only: workspace/session hashes, never raw paths or
// raw session ids.

import type { SourceTier } from '../sources/SourceTier';
import type { AccuracyLabel, AgentId, ProviderId } from '../usage/NativeUsageTaxonomy';

export type Confidence = 'low' | 'medium' | 'high';

// Documented reasons a field is unavailable or degraded. Closed set so the
// report and diagnostics never echo a free-form (potentially leaky) message.
// Exported as a runtime tuple (not just a type) so the cockpit message
// schema can build a closed z.enum from the single source of truth.
export const COCKPIT_FIELD_REASONS = [
  'native_status_stale',
  'codex_native_status_unavailable',
  // The bounded Codex-probe + statusline
  // outcome reasons. This closed set is the ONLY string class that may reach the
  // VM/UI — a free-form Error.message never crosses.
  'codex_probe_disabled',
  'codex_probe_failed',
  'codex_probe_timeout',
  // The probe spawned and sent `initialize` but the app-server
  // produced NO stdout at all before the timeout (granular I/O markers: ioStage
  // never reached `stdout_chunk_received`, no stderr). On codex-cli 0.137.0 in
  // WSL/Remote, `codex app-server` answers an interactive terminal but returns
  // nothing over a PIPE (confirmed: `printf … | codex app-server` prints nothing).
  // A precise, actionable degrade — NOT a transient timeout: the native probe is
  // unavailable here because app-server needs interactive input. No scrape/fabrication.
  'codex_probe_no_response',
  'codex_cli_not_found',
  'codex_protocol_drift',
  // The Codex probe valid→degraded RETENTION reasons. After
  // a VALID Codex native probe (codex_status_snapshot), a later miss/failure must
  // RETAIN the last-known Codex gauges marked degraded — never revert to the
  // not-configured/blocker card. `codex_probe_temporarily_unavailable` = a
  // miss/timeout/run-failure after a valid result; `codex_probe_parse_failed_after_valid`
  // = a protocol/parse failure after a valid result; `codex_probe_no_data_after_valid`
  // = an empty/valueless result after a valid one. All three are
  // degraded-WITH-RETAINED-VALUE — distinct from the never-configured states.
  'codex_probe_temporarily_unavailable',
  'codex_probe_parse_failed_after_valid',
  'codex_probe_no_data_after_valid',
  // The Codex probe runs on a ~60s cadence, but the loop
  // polls every 10-15s. On the intervening no-probe poll ticks BEFORE any valid
  // result has ever been seen (probe ENABLED), the Codex card must surface this
  // honest "pending" reason rather than the misleading no_source/log-path action.
  // It is NOT a retained-value reason (no value exists yet) — it is an honest
  // "enabled but awaiting the first native result" state, distinct from the
  // never-configured / disabled card.
  'codex_probe_pending',
  // The Codex probe runs on a ~60s cadence floor while the
  // loop polls every 10-15s, so most poll ticks carry NO codex candidate. A no-probe
  // tick is "no new sample due yet", NOT a failure — within a freshness TTL the
  // last-known value stays FRESH. This reason marks the OTHER side: a held value
  // whose freshness TTL has EXPIRED (the probe is overdue/stuck) — the value is
  // RETAINED but degraded/stale, distinct from an actual failure
  // (codex_probe_temporarily_unavailable) and from the never-configured/no-source
  // states. It is a degraded-WITH-RETAINED-VALUE reason.
  'codex_probe_stale',
  // The tested codex app-server JSON-RPC response carries account rate-limit
  // windows, not context-window fields.
  // Context exists only in the interactive statusLine, which is DO-NOT-SCRAPE
  //. So when the Codex card has a WORKING
  // codex_status_snapshot LIMIT source but no context, the context gauge surfaces
  // this PRECISE reason rather than the misleading generic `no_source`
  // ("No data source configured") — the native source IS configured and working
  // for limits; only context is structurally absent. Never fabricated, never
  // scraped. Distinct from the never-configured / probe-disabled / stale states.
  'codex_context_unavailable',
  'statusline_snapshot_not_configured',
  // The configured Claude statusLine snapshot was read and parsed safely, but
  // Claude Code did not report any 5h/weekly rate-limit windows in that sample.
  // This is NOT a path/configuration failure and must not be shown as one.
  'statusline_snapshot_missing_rate_limits',
  // Multiple Claude sessions (different workspaces) write
  // ONE shared statusLine snapshot file, so the cockpit value alternates. The
  // stability gate degrades to this reason and retains the last-known value
  // rather than flapping to the competing source's number.
  'snapshot_writer_collision',
  // After a VALID native snapshot, a transient failure must
  // NOT revert the card to "not configured" — it preserves the last-known value
  // and degrades with one of these precise reasons. `native_temporarily_unavailable`
  // = the snapshot went absent / parse-failed after a valid one;
  // `snapshot_incomplete_after_valid` = a snapshot is present but carries no usable
  // rate_limits (usage-limited / waiting-for-approval) after a valid one. Both are
  // degraded-WITH-RETAINED-VALUE — distinct from the never-configured states.
  'native_temporarily_unavailable',
  'snapshot_incomplete_after_valid',
  // Context-window usage is SESSION-LOCAL — each Claude
  // session has its own context window. Under snapshot_writer_collision a
  // conservative "highest context" is meaningless and last-write-wins flaps, so
  // the context gauge is MUTED (no value, '—') with this reason rather than
  // alternating. The 5h/weekly limit gauges stay conservative-stable with
  // snapshot_writer_collision (those ARE account-level).
  'context_session_specific_collision',
  // Cost is SESSION-SPECIFIC — under snapshot_writer_collision
  // two Claude sessions' costs alternate last-writer-wins. The cost label is MUTED
  // (dropped) with this reason rather than flapping. Mirror of
  // context_session_specific_collision for the cost field.
  'cost_session_specific_collision',
  // A rate-limit window whose `resetsAt` is in the PAST
  // (by the single render clock) with NO newer accepted native sample for that
  // window. By the clock the window has reset, so the pre-reset used% can no
  // longer be presented as current. The value is DROPPED (not fabricated to a
  // post-reset number) and the gauge surfaces this honest pending reason — never
  // bare `fresh`, never driving near-limit risk. Applies to session(5h) + weekly,
  // Claude + Codex. Clock-driven: cleared automatically when a fresh native sample
  // for the new window arrives — the user need not send a new prompt.
  'native_window_reset_pending',
  'no_source',
  'no_candidate',
] as const;

export type CockpitFieldReason = (typeof COCKPIT_FIELD_REASONS)[number];

// The SINGLE deterministic CockpitState reason priority,
// strongest-first. This is the ONE source of truth the post-merge stabilization
// pass (CockpitStabilizationPass) uses to arbitrate between the reasons produced by
// the upstream gates so the final per-card reason is decided ONCE — never the
// "whichever transform wrote last" race that caused the no-flap blocker.
//
// Ordering rationale (strongest wins):
//  1. Absence / not-configured / probe blockers (no value at all) — the card has
//     nothing to show; this must never be masked by a retained-value reason.
//  2. native_window_reset_pending — the window has reset by the clock; the
//     pre-reset value is no longer current and was dropped.
//  3. Collision (account-level ambiguity) — multiple writers; value retained
//     conservative but the source is ambiguous.
//  4. Session-specific collision mutes (context/cost) — same collision story, for
//     the session-local fields.
//  5. Stale (sample-age TTL crossed) — value retained but provably aged.
//  6. After-valid retained reasons — value retained across a transient miss.
//  7. (implicit) undefined reason = fresh — the weakest; any ranked reason wins.
//
// Reasons NOT listed are treated as just-above-fresh (rank 0) by the pass so an
// unranked reason can never silently outrank a ranked honesty signal.
export const COCKPIT_REASON_PRIORITY: readonly CockpitFieldReason[] = [
  // 1. Absence / blockers (no value).
  'no_source',
  'no_candidate',
  'statusline_snapshot_not_configured',
  'statusline_snapshot_missing_rate_limits',
  'codex_native_status_unavailable',
  'codex_probe_disabled',
  'codex_probe_failed',
  'codex_probe_timeout',
  'codex_probe_no_response',
  'codex_cli_not_found',
  'codex_protocol_drift',
  'codex_probe_pending',
  'codex_context_unavailable',
  // 2. Reset-expiry pending (value dropped by the clock).
  'native_window_reset_pending',
  // 3. Collision (account-level ambiguity, value retained conservative).
  'snapshot_writer_collision',
  // 4. Session-specific collision mutes.
  'context_session_specific_collision',
  'cost_session_specific_collision',
  // 5. Stale (sample-age TTL crossed, value retained).
  'native_status_stale',
  'codex_probe_stale',
  // 6. After-valid retained reasons (value retained across a transient miss).
  'native_temporarily_unavailable',
  'snapshot_incomplete_after_valid',
  'codex_probe_temporarily_unavailable',
  'codex_probe_parse_failed_after_valid',
  'codex_probe_no_data_after_valid',
] as const;

export interface CockpitFieldMeta {
  readonly sourceTier: SourceTier;
  readonly accuracyLabel: AccuracyLabel;
  // Age (ms) of the underlying source at resolve time. 0 = just produced.
  readonly freshnessMs?: number;
  readonly confidence: Confidence;
  // A degraded-but-shown reason (e.g. native_status_stale). Optional on an
  // available field.
  readonly reason?: CockpitFieldReason;
}

// A single cockpit field. Either available (carries a value + full metadata) or
// unavailable (carries a reason + the `unknown` source tier, never a value).
export interface CockpitField<T> {
  readonly available: boolean;
  readonly value?: T;
  readonly sourceTier: SourceTier;
  readonly accuracyLabel?: AccuracyLabel;
  readonly freshnessMs?: number;
  readonly confidence?: Confidence;
  readonly reason?: CockpitFieldReason;
}

export function fieldOf<T>(value: T, meta: CockpitFieldMeta): CockpitField<T> {
  return {
    available: true,
    value,
    sourceTier: meta.sourceTier,
    accuracyLabel: meta.accuracyLabel,
    ...(meta.freshnessMs !== undefined ? { freshnessMs: meta.freshnessMs } : {}),
    confidence: meta.confidence,
    ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
  };
}

export function unavailableField<T = never>(reason: CockpitFieldReason): CockpitField<T> {
  return {
    available: false,
    sourceTier: 'unknown',
    reason,
  };
}

// Hashed-only scope. There is intentionally NO `workspacePath` / `sessionId`
// field — raw identity never lands on CockpitState.
export interface CockpitScope {
  readonly provider: ProviderId;
  readonly agent: AgentId;
  readonly model?: string;
  readonly workspaceHash?: string;
  readonly sessionHash?: string;
}

export interface CockpitWindow {
  readonly usedPct: CockpitField<number>;
  readonly leftPct: CockpitField<number>;
  readonly resetsAt: CockpitField<string>;
}

// The agent's CURRENT context-window usage
// (distinct from the session/weekly RATE-LIMIT windows above). usedTokens is left
// unavailable when the source does not carry it — never fabricated from in+out.
export interface CockpitContextWindow {
  readonly usedPct: CockpitField<number>;
  readonly leftPct: CockpitField<number>;
  readonly windowSizeTokens: CockpitField<number>;
  readonly usedTokens: CockpitField<number>;
  readonly inputTokens: CockpitField<number>;
  readonly outputTokens: CockpitField<number>;
}

export type RiskLevel = 'ok' | 'warning' | 'critical';

export interface CockpitState {
  readonly scope: CockpitScope;
  readonly session: CockpitWindow;
  readonly weekly: CockpitWindow;
  readonly cost: CockpitField<number>;
  readonly model: CockpitField<string>;
  readonly riskLevel: CockpitField<RiskLevel>;
  readonly context: CockpitContextWindow;
  readonly reasoning: CockpitField<string>;
  readonly agentVersion: CockpitField<string>;
  readonly planType: CockpitField<string>;
}

function unavailableWindow(reason: CockpitFieldReason): CockpitWindow {
  return {
    usedPct: unavailableField<number>(reason),
    leftPct: unavailableField<number>(reason),
    resetsAt: unavailableField<string>(reason),
  };
}

function unavailableContextWindow(reason: CockpitFieldReason): CockpitContextWindow {
  return {
    usedPct: unavailableField<number>(reason),
    leftPct: unavailableField<number>(reason),
    windowSizeTokens: unavailableField<number>(reason),
    usedTokens: unavailableField<number>(reason),
    inputTokens: unavailableField<number>(reason),
    outputTokens: unavailableField<number>(reason),
  };
}

// A fully-unavailable CockpitState for the given scope. The resolver overlays
// available fields onto this base so a never-resolved field is explicitly
// unavailable rather than silently absent.
export function emptyCockpitState(scope: CockpitScope): CockpitState {
  return {
    scope: {
      provider: scope.provider,
      agent: scope.agent,
      ...(scope.model !== undefined ? { model: scope.model } : {}),
      ...(scope.workspaceHash !== undefined ? { workspaceHash: scope.workspaceHash } : {}),
      ...(scope.sessionHash !== undefined ? { sessionHash: scope.sessionHash } : {}),
    },
    session: unavailableWindow('no_source'),
    weekly: unavailableWindow('no_source'),
    cost: unavailableField<number>('no_source'),
    model: unavailableField<string>('no_source'),
    riskLevel: unavailableField<RiskLevel>('no_source'),
    context: unavailableContextWindow('no_source'),
    reasoning: unavailableField<string>('no_source'),
    agentVersion: unavailableField<string>('no_source'),
    planType: unavailableField<string>('no_source'),
  };
}

// Derive a risk level from a used-percent field. Pure; the thresholds match the
// project's existing 80/95 warning convention. A stale/unavailable used-pct
// yields an unavailable risk (no fabricated "ok").
export function deriveRisk(usedPct: CockpitField<number>): CockpitField<RiskLevel> {
  if (!usedPct.available || typeof usedPct.value !== 'number') {
    return unavailableField<RiskLevel>(usedPct.reason ?? 'no_source');
  }
  const level: RiskLevel =
    usedPct.value >= 95 ? 'critical' : usedPct.value >= 80 ? 'warning' : 'ok';
  return {
    available: true,
    value: level,
    sourceTier: usedPct.sourceTier,
    ...(usedPct.accuracyLabel !== undefined ? { accuracyLabel: usedPct.accuracyLabel } : {}),
    ...(usedPct.freshnessMs !== undefined ? { freshnessMs: usedPct.freshnessMs } : {}),
    ...(usedPct.confidence !== undefined ? { confidence: usedPct.confidence } : {}),
    ...(usedPct.reason !== undefined ? { reason: usedPct.reason } : {}),
  };
}
