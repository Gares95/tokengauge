// The sanitized GaugeCardViewModel composition layer.
//
// This is the TRUST CHOKEPOINT between the extension host and the cockpit
// webview. The webview receives ONLY this closed, serializable, display-only
// shape — no CockpitState, no SourceCandidate, no usage-store totals.
//
// Composition (research Pitfall 8): candidates are grouped by scope.agent and
// `resolve()` is called ONCE PER GROUP — never one mixed-scope resolve across
// agents. resolve() itself is reused unmodified (CONTEXT reuse constraint); the
// per-agent grouping + display mapping lives here.
//
// Honesty: every visible metric carries an
// accuracyLabel (and confidence when available) propagated from the resolved
// CockpitField metadata. sourceTier is NOT a substitute for accuracyLabel. A VM
// is NEVER emitted with a visible value but no accuracyLabel.
//
// Privacy (Pitfall 12): the only string class that may reach the VM is the
// closed CockpitFieldReason union plus redactString-backstopped display strings.
// No planType, no hashes, no raw paths, no free-form error strings.
//
// Input is RESOLVED CockpitState only: this module imports NEITHER
// UsageStore NOR UsageSnapshotService NOR UsageIngestor.

import type { Confidence } from '../core/cockpit/CockpitState';
import {
  type CockpitContextWindow,
  type CockpitField,
  type CockpitFieldReason,
  type CockpitState,
  type CockpitWindow,
  deriveRisk,
  emptyCockpitState,
  type RiskLevel,
} from '../core/cockpit/CockpitState';
import { resolve, type SourceCandidate } from '../core/cockpit/SourcePriorityResolver';
import type { SourceTier } from '../core/sources/SourceTier';
import type { AccuracyLabel, AgentId } from '../core/usage/NativeUsageTaxonomy';
import { redactString } from '../security/Redactor';

export type CardFreshness = 'fresh' | 'stale' | 'degraded' | 'unavailable';
export type AgentColorKey = 'claude' | 'codex' | 'other';
export type CardRisk = 'ok' | 'warning' | 'critical' | 'unavailable';

// A single gauge ring. usedPct fills the arc; leftPct = 100 - usedPct clamped.
// An unavailable gauge carries no value, a '—' centerLabel, and a closed reason.
export interface GaugeViewModel {
  readonly usedPct?: number;
  readonly leftPct?: number;
  readonly centerLabel: string;
  readonly subLabel?: string;
  readonly state: CardFreshness;
  readonly reason?: CockpitFieldReason;
  readonly accuracyLabel?: AccuracyLabel;
  readonly confidence?: Confidence;
}

export interface GaugeCardViewModel {
  readonly agent: AgentId;
  readonly agentLabel: string;
  readonly colorKey: AgentColorKey;
  readonly model?: string;
  readonly reasoning?: string;
  readonly agentVersion?: string;
  readonly session: GaugeViewModel;
  readonly weekly: GaugeViewModel;
  readonly context: GaugeViewModel;
  readonly costLabel?: string;
  // When the cost is muted (session-specific under
  // collision) the costLabel is absent and this carries the closed reason the
  // card surfaces in its place. Distinct from the card-level `reason` (the
  // 5h/weekly collision story).
  readonly costReason?: CockpitFieldReason;
  readonly risk: CardRisk;
  readonly sourceTier: SourceTier;
  readonly accuracyLabel?: AccuracyLabel;
  readonly confidence?: Confidence;
  readonly freshness: CardFreshness;
  readonly reason?: CockpitFieldReason;
}

export interface BuildGaugeCardViewModelsOptions {
  readonly candidates: readonly SourceCandidate[];
  readonly configuredAgents: readonly AgentId[];
  readonly now: () => Date;
}

const AGENT_LABELS: Partial<Record<AgentId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

function agentLabelFor(agent: AgentId): string {
  return AGENT_LABELS[agent] ?? agent;
}

function colorKeyFor(agent: AgentId): AgentColorKey {
  if (agent === 'claude-code') return 'claude';
  if (agent === 'codex') return 'codex';
  return 'other';
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function redactOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return redactString(value);
}

// Map a resolved usedPct field to a gauge ring state. Available without a
// degraded reason → fresh; available with native_status_stale → stale;
// unavailable → unavailable. (Per-gauge; the card aggregates these below.)
function gaugeStateFor(usedPct: CockpitField<number>): CardFreshness {
  if (!usedPct.available || typeof usedPct.value !== 'number') return 'unavailable';
  if (usedPct.reason === 'native_status_stale') return 'stale';
  return 'fresh';
}

function metaProps(field: CockpitField<unknown>): {
  accuracyLabel?: AccuracyLabel;
  confidence?: Confidence;
} {
  return {
    ...(field.accuracyLabel !== undefined ? { accuracyLabel: field.accuracyLabel } : {}),
    ...(field.confidence !== undefined ? { confidence: field.confidence } : {}),
  };
}

// True when two instants fall on the same LOCAL calendar day. Compared in the
// host's local timezone (the same frame resets render in), so a reset later
// today is "today" and a reset past local midnight is "another day".
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// The SINGLE shared reset-label formatter for both 5h
// (session) and weekly windows, Claude and Codex alike. A weekly reset days away
// (or a 5h reset that crosses local midnight) is ambiguous as a bare time, so the
// label includes the weekday + date once the reset is a DIFFERENT local calendar
// day from `now`. Same-day resets keep the time-only label (unchanged). `now` is
// the snapshot's single clock threaded in — never a second read.
// A coarse minute countdown ("in 2h 15m") to a FUTURE reset. It directly
// answers "how long until the window resets". Coarse minute precision, recomputed
// each poll from the single render clock; a past/invalid reset yields no countdown
// (the native_window_reset_pending path covers a reset that has already passed).
function countdownLabel(resetsAt: Date, now: Date): string | undefined {
  const ms = resetsAt.getTime() - now.getTime();
  if (ms <= 0) return undefined;
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return 'in <1m';
}

function resetSubLabel(
  leftPct: number,
  resetsAt: CockpitField<string>,
  now: Date,
  kind: 'session' | 'weekly',
): string | undefined {
  if (!resetsAt.available || typeof resetsAt.value !== 'string') {
    return `${leftPct}% left`;
  }
  const parsed = new Date(resetsAt.value);
  if (Number.isNaN(parsed.getTime())) {
    return `${leftPct}% left`;
  }
  // Phase timezone decision: bucketing is UTC, but reset times render in
  // the host's LOCAL time. Intl.DateTimeFormat with no timeZone = local.
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
  // The 5h (session) line also carries a "· in Xh Ym" countdown; the weekly
  // line keeps its exact reset time only (a countdown there would be noise).
  const countdown = kind === 'session' ? countdownLabel(parsed, now) : undefined;
  const tail = countdown !== undefined ? ` · ${countdown}` : '';
  if (sameLocalDay(parsed, now)) {
    return `${leftPct}% left · resets ${time}${tail}`;
  }
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(parsed);
  return `${leftPct}% left · resets ${date}, ${time}${tail}`;
}

// Build a limit-window gauge (session / weekly) from a resolved CockpitWindow.
// `now` is the snapshot's single clock, threaded into the reset-label formatter
// so the date appears only when the reset is not the same local day.
function limitGauge(window: CockpitWindow, now: Date, kind: 'session' | 'weekly'): GaugeViewModel {
  const usedField = window.usedPct;
  const state = gaugeStateFor(usedField);
  if (!usedField.available || typeof usedField.value !== 'number') {
    return {
      centerLabel: '—',
      state: 'unavailable',
      ...(usedField.reason !== undefined ? { reason: usedField.reason } : {}),
      ...metaProps(usedField),
    };
  }
  const usedPct = clampPct(usedField.value);
  const leftPct = clampPct(100 - usedPct);
  const subLabel = redactOptional(resetSubLabel(leftPct, window.resetsAt, now, kind));
  return {
    usedPct,
    leftPct,
    centerLabel: `${usedPct}%`,
    ...(subLabel !== undefined ? { subLabel } : {}),
    state,
    ...(usedField.reason !== undefined ? { reason: usedField.reason } : {}),
    ...metaProps(usedField),
  };
}

// Build the context gauge: prefer context.usedPct; else usedTokens/windowSize.
function contextGauge(context: CockpitContextWindow): GaugeViewModel {
  const usedPctField = context.usedPct;
  if (usedPctField.available && typeof usedPctField.value === 'number') {
    const usedPct = clampPct(usedPctField.value);
    return {
      usedPct,
      leftPct: clampPct(100 - usedPct),
      centerLabel: `${usedPct}%`,
      state: gaugeStateFor(usedPctField),
      ...(usedPctField.reason !== undefined ? { reason: usedPctField.reason } : {}),
      ...metaProps(usedPctField),
    };
  }
  const used = context.usedTokens;
  const size = context.windowSizeTokens;
  if (
    used.available &&
    typeof used.value === 'number' &&
    size.available &&
    typeof size.value === 'number' &&
    size.value > 0
  ) {
    const usedPct = clampPct((used.value / size.value) * 100);
    return {
      usedPct,
      leftPct: clampPct(100 - usedPct),
      centerLabel: `${usedPct}%`,
      state: gaugeStateFor(used),
      ...(used.reason !== undefined ? { reason: used.reason } : {}),
      ...metaProps(used),
    };
  }
  const reason = usedPctField.reason ?? used.reason;
  return {
    centerLabel: '—',
    state: 'unavailable',
    ...(reason !== undefined ? { reason } : {}),
  };
}

function isOptionalLimitAbsence(reason: CockpitFieldReason | undefined): boolean {
  return reason === undefined || reason === 'no_source' || reason === 'no_candidate';
}

function canPromoteWeekly(agent: AgentId, session: GaugeViewModel): boolean {
  return agent === 'codex' && isOptionalLimitAbsence(session.reason);
}

function primaryLimitField(agent: AgentId, state: CockpitState): CockpitField<number> {
  if (state.session.usedPct.available && typeof state.session.usedPct.value === 'number') {
    return state.session.usedPct;
  }
  if (
    agent === 'codex' &&
    isOptionalLimitAbsence(state.session.usedPct.reason) &&
    state.weekly.usedPct.available &&
    typeof state.weekly.usedPct.value === 'number'
  ) {
    return state.weekly.usedPct;
  }
  return state.session.usedPct;
}

function primaryLimitGauge(session: GaugeViewModel, weekly: GaugeViewModel): GaugeViewModel {
  if (session.usedPct !== undefined) return session;
  if (weekly.usedPct !== undefined) return weekly;
  return session;
}

// Aggregate per-card freshness from any available known limit window. Optional
// absence of one known window no longer blanks the whole card, but a non-optional
// 5h absence such as reset-pending remains a card-level no-meter state.
function cardFreshness(
  agent: AgentId,
  session: GaugeViewModel,
  weekly: GaugeViewModel,
): CardFreshness {
  if (
    session.usedPct === undefined &&
    weekly.usedPct !== undefined &&
    !canPromoteWeekly(agent, session)
  ) {
    return 'unavailable';
  }
  const available = [session, weekly].filter((gauge) => gauge.usedPct !== undefined);
  if (available.length === 0) return 'unavailable';
  if (available.some((gauge) => gauge.state === 'degraded')) return 'degraded';
  if (available.some((gauge) => gauge.state === 'stale')) return 'stale';
  return 'fresh';
}

function cardRisk(risk: CockpitField<RiskLevel>): CardRisk {
  if (!risk.available || typeof risk.value !== 'string') return 'unavailable';
  return risk.value;
}

function costLabelFor(cost: CockpitField<number>): string | undefined {
  if (!cost.available || typeof cost.value !== 'number') return undefined;
  return redactString(`$${cost.value.toFixed(2)}`);
}

// Overlay the specific blocker reason onto an UNAVAILABLE gauge. A gauge with a
// visible value is left untouched (the blocker only ever explains absence).
function withBlockerReason(
  gauge: GaugeViewModel,
  blockerReason: CockpitFieldReason | undefined,
): GaugeViewModel {
  if (blockerReason === undefined || gauge.state !== 'unavailable') {
    return gauge;
  }
  return { ...gauge, reason: blockerReason };
}

// The DEGRADED-WITH-RETAINED-VALUE
// reason set (unlike the absence blockers above). The stability gate emits the
// held last-known Claude candidate WITH a real session value plus one of these
// reasons; the card must KEEP the value visible (never blank, never flap, never
// "not configured") while marking the gauge degraded and surfacing the reason.
// - snapshot_writer_collision: competing-session writes alternate the file.
// - native_temporarily_unavailable: snapshot absent / parse-failed after valid.
// - snapshot_incomplete_after_valid: snapshot present but valueless after valid.
const DEGRADED_WITH_VALUE_REASONS: ReadonlySet<CockpitFieldReason> = new Set([
  'snapshot_writer_collision',
  'native_temporarily_unavailable',
  'snapshot_incomplete_after_valid',
  // The Codex probe retention reasons retain the last-known
  // Codex gauges and degrade — same value-keeping treatment as the Claude
  // after-valid reasons, never the not-configured blanking.
  'codex_probe_temporarily_unavailable',
  'codex_probe_parse_failed_after_valid',
  'codex_probe_no_data_after_valid',
  // A held Codex value whose freshness TTL expired (the probe
  // is overdue/stuck). Retains the last-known value and degrades — never blanks.
  'codex_probe_stale',
]);

function isDegradedWithValueReason(
  reason: CockpitFieldReason | undefined,
): reason is CockpitFieldReason {
  return reason !== undefined && DEGRADED_WITH_VALUE_REASONS.has(reason);
}

// Overlay a degraded-with-retained-value reason onto a gauge that DOES carry a
// value (the inverse of withBlockerReason). A gauge with no value is left
// untouched — these reasons only ever explain a RETAINED value, never absence.
function withRetainedValueReason(
  gauge: GaugeViewModel,
  reason: CockpitFieldReason | undefined,
): GaugeViewModel {
  if (!isDegradedWithValueReason(reason) || gauge.usedPct === undefined) {
    return gauge;
  }
  return { ...gauge, state: 'degraded', reason };
}

// Context-window usage is SESSION-LOCAL — each Claude
// session has its own context window. Under snapshot_writer_collision the two
// sessions' context values would alternate (last-write-wins), and a conservative
// "highest" is meaningless. So MUTE the context gauge: drop the value, render the
// honest '—' unavailable state, and surface a session-specific reason. This is
// distinct from the value-retaining collision overlay used for the account-level
// 5h/weekly limits (withRetainedValueReason), which stay conservative-stable.
function mutedContextOnCollision(gauge: GaugeViewModel, isCollision: boolean): GaugeViewModel {
  if (!isCollision) {
    return gauge;
  }
  return {
    centerLabel: '—',
    state: 'unavailable',
    reason: 'context_session_specific_collision',
  };
}

// The tested codex app-server JSON-RPC response carries account rate-limit
// windows, not context-window fields (context lives only in the DO-NOT-SCRAPE
// interactive statusLine). So when the Codex card has a WORKING
// codex_status_snapshot LIMIT source (session and/or weekly value present) but the
// context gauge resolved unavailable, surface the PRECISE codex_context_unavailable
// reason instead of the misleading generic no_source. Scoped strictly to the Codex
// context gauge while its native limits work — never Claude, never a Codex card
// whose limits are not configured/disabled (those keep their own reason), and
// never a context gauge that DOES carry a value.
function codexContextReason(
  agent: AgentId,
  contextGaugeVm: GaugeViewModel,
  session: CockpitField<number>,
  weekly: CockpitField<number>,
): GaugeViewModel {
  if (agent !== 'codex' || contextGaugeVm.usedPct !== undefined) {
    return contextGaugeVm;
  }
  const limitWorks =
    (session.available &&
      typeof session.value === 'number' &&
      session.sourceTier === 'codex_status_snapshot') ||
    (weekly.available &&
      typeof weekly.value === 'number' &&
      weekly.sourceTier === 'codex_status_snapshot');
  if (!limitWorks) {
    return contextGaugeVm;
  }
  // Only override the generic/absent reason — never mask a specific blocker
  // (probe-disabled / collision / a Codex degraded-with-value reason).
  const r = contextGaugeVm.reason;
  if (r !== undefined && r !== 'no_source' && r !== 'no_candidate') {
    return contextGaugeVm;
  }
  return { ...contextGaugeVm, reason: 'codex_context_unavailable' };
}

function viewModelFromState(
  agent: AgentId,
  state: CockpitState,
  now: Date,
  blockerReason?: CockpitFieldReason,
): GaugeCardViewModel {
  // Collision = multiple Claude sessions writing one shared snapshot. The 5h/
  // weekly account-level gauges stay conservative-stable; the SESSION-LOCAL
  // context gauge must be muted rather than alternating.
  const isCollision = blockerReason === 'snapshot_writer_collision';
  // A degraded-with-retained-value reason (collision / native_temporarily_unavailable
  // / snapshot_incomplete_after_valid) keeps the value and surfaces the reason,
  // distinct from the absence blockers handled by withBlockerReason. It is never
  // used to blank a gauge.
  const isDegradedWithValue = isDegradedWithValueReason(blockerReason);
  const session = withRetainedValueReason(
    withBlockerReason(limitGauge(state.session, now, 'session'), blockerReason),
    blockerReason,
  );
  const weekly = withBlockerReason(limitGauge(state.weekly, now, 'weekly'), blockerReason);
  const context = codexContextReason(
    agent,
    mutedContextOnCollision(
      withBlockerReason(contextGauge(state.context), blockerReason),
      isCollision,
    ),
    state.session.usedPct,
    state.weekly.usedPct,
  );
  const limitField = primaryLimitField(agent, state);
  const risk = deriveRisk(limitField);
  const freshness = cardFreshness(agent, session, weekly);
  // Card-level accuracy/confidence propagate from the resolved session field —
  // the primary visible metric (HIGH-1: a card with a visible metric must carry
  // an accuracyLabel).
  const cardMeta = metaProps(limitField);
  // The model is SESSION-SPECIFIC — under snapshot_writer_collision two
  // sessions' models (e.g. fable ↔ opus) alternate last-writer-wins in the card
  // header and the status-bar tooltip. Mute it like context/cost; the card
  // renders a stable "Multiple <agent> sessions" line in its place.
  const model = isCollision
    ? undefined
    : redactOptional(state.model.available ? (state.model.value as string | undefined) : undefined);
  const reasoning = redactOptional(
    state.reasoning.available ? (state.reasoning.value as string | undefined) : undefined,
  );
  const agentVersion = redactOptional(
    state.agentVersion.available ? (state.agentVersion.value as string | undefined) : undefined,
  );
  // Cost is SESSION-SPECIFIC. Under snapshot_writer_collision
  // two sessions' costs alternate last-writer-wins, so MUTE the cost label and
  // surface cost_session_specific_collision in its place (mirror of the muted
  // context gauge). Off-collision cost renders normally.
  const rawCostLabel = costLabelFor(state.cost);
  const costLabel = isCollision ? undefined : rawCostLabel;
  const costReason: CockpitFieldReason | undefined = isCollision
    ? 'cost_session_specific_collision'
    : undefined;
  // The card-level reason mirrors the session field's reason, but a specific
  // blocker (probe disabled / snapshot not configured) takes precedence over the
  // generic `no_source` when the session resolved unavailable. A
  // degraded-with-retained-value reason surfaces even though the session is
  // available.
  const primaryGauge = primaryLimitGauge(session, weekly);
  const cardReason =
    session.usedPct === undefined &&
    weekly.usedPct !== undefined &&
    !canPromoteWeekly(agent, session)
      ? session.reason
      : isDegradedWithValue && primaryGauge.usedPct !== undefined
        ? blockerReason
        : blockerReason !== undefined && primaryGauge.usedPct === undefined
          ? blockerReason
          : primaryGauge.reason;

  return {
    agent,
    agentLabel: agentLabelFor(agent),
    colorKey: colorKeyFor(agent),
    ...(model !== undefined ? { model } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(agentVersion !== undefined ? { agentVersion } : {}),
    session,
    weekly,
    context,
    ...(costLabel !== undefined ? { costLabel } : {}),
    ...(costReason !== undefined ? { costReason } : {}),
    risk: cardRisk(risk),
    sourceTier: limitField.sourceTier,
    ...cardMeta,
    freshness,
    ...(cardReason !== undefined ? { reason: cardReason } : {}),
  };
}

export function buildGaugeCardViewModels(
  options: BuildGaugeCardViewModelsOptions,
): GaugeCardViewModel[] {
  const { candidates, configuredAgents, now } = options;
  const ctx = { now };
  // Read the snapshot clock ONCE here and thread the single
  // Date into every card's reset-label formatting — never a second clock read.
  const nowDate = now();

  // Group candidates by scope.agent — Pitfall 8: resolve() per agent group,
  // NEVER one mixed-scope resolve across agents.
  const byAgent = new Map<AgentId, SourceCandidate[]>();
  for (const candidate of candidates) {
    const agent = candidate.scope.agent;
    const list = byAgent.get(agent);
    if (list) {
      list.push(candidate);
    } else {
      byAgent.set(agent, [candidate]);
    }
  }

  // One VM per configured agent, in the configured order (the card
  // always exists — for an agent with no candidates we resolve an empty state
  // so the card surfaces an honest reason instead of disappearing).
  return configuredAgents.map((agent) => {
    const group = byAgent.get(agent);
    const state =
      group && group.length > 0
        ? resolve(group, ctx)
        : emptyCockpitState({ provider: 'unknown', agent });
    // A blocker candidate (Codex probe disabled / statusLine snapshot not
    // configured) carries the SPECIFIC closed-set reason the card should surface.
    // It only ever upgrades a card whose session resolved UNAVAILABLE — it can
    // NEVER mask a live value (a candidate with a real session wins on its own).
    const blockerReason = group?.find((c) => c.unavailableReason !== undefined)?.unavailableReason;
    return viewModelFromState(agent, state, nowDate, blockerReason);
  });
}
