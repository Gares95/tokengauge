// The per-agent cockpit card, battery-meter redesign. The card composes a
// brand cap + monogram header with a StateBadge, then EITHER battery meters
// (live/stale, value present) OR a no-gauge SetupCallout (not configured / probe
// off / unavailable / blocked) — an unavailable source never renders a 0% meter.
// Context and cost are technical-details only. A persistent PrivacyFooter carries
// the always-on non-billing + privacy honesty.
//
// Privacy: `reason` is a closed CockpitFieldReason union mapped to
// fixed copy via a static lookup — no free-form strings reach the DOM. The exact
// source tier / raw freshness / reason id live only in the technical <details>.

import type { CardRisk, GaugeCardViewModel, GaugeViewModel } from '../cockpit/GaugeCardViewModel';
import type { CockpitFieldReason } from '../core/cockpit/CockpitState';
import {
  badgeForState,
  cardVisualState,
  edgeForState,
  monogramFor,
  type SettingTarget,
  type SetupSpec,
  setupCalloutFor,
} from './cardVisualState';
import { levelFromLeftPct, levelFromRisk, Meter } from './Meter';
import { PrivacyFooter } from './PrivacyFooter';
import { ProviderBadge } from './ProviderBadge';
import { SetupCallout } from './SetupCallout';
import { StateBadge } from './StateBadge';

// Plain-language copy for the closed CockpitFieldReason union. CARDINAL RULE: no
// friendlier string may make a value read as MORE certain than it is — every
// retained-value reason keeps a "last-known" cue; every blocker names the honest
// absence. The reason KEYS are untouched, so diagnostics still report the id.
export const REASON_COPY: Record<CockpitFieldReason, string> = {
  native_status_stale: 'Stale · showing last-known',
  codex_native_status_unavailable: 'Codex native status unavailable',
  codex_probe_disabled: 'Codex native probe is off by default',
  codex_probe_failed: 'Codex status probe failed',
  codex_probe_timeout: 'Codex status probe timed out',
  codex_probe_no_response:
    'Codex native probe unavailable — codex app-server returned no response (it may require an interactive terminal in this environment)',
  codex_cli_not_found: 'Codex CLI not found by TokenGauge',
  codex_protocol_drift: 'Codex status format not recognized',
  codex_probe_temporarily_unavailable: 'Temporarily unavailable · showing last-known',
  codex_probe_parse_failed_after_valid: 'Status format not recognized · showing last-known',
  codex_probe_no_data_after_valid: 'No current status · showing last-known',
  codex_probe_pending: 'Native probe pending — awaiting first status',
  codex_probe_stale: 'Stale · showing last-known',
  codex_context_unavailable:
    'Context unavailable — Codex app-server does not expose current session context.',
  statusline_snapshot_not_configured: 'Claude statusLine snapshot not configured',
  statusline_snapshot_missing_rate_limits:
    'Claude statusLine snapshot read, but no 5h/weekly limit fields were reported',
  snapshot_writer_collision:
    'Multiple Claude Code writers detected · showing highest last-known usage',
  native_temporarily_unavailable: 'Temporarily unavailable · showing last-known',
  snapshot_incomplete_after_valid: 'Snapshot incomplete · showing last-known',
  context_session_specific_collision:
    'Context is session-specific — unavailable while multiple Claude sessions share this snapshot',
  cost_session_specific_collision:
    'Cost is session-specific — unavailable while multiple Claude sessions share this snapshot',
  native_window_reset_pending: 'Waiting for a fresh sample — the limit window reset',
  no_source: 'No data source configured for this agent',
  no_candidate: 'No usage data yet',
};

function reasonCopy(reason: CockpitFieldReason | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return REASON_COPY[reason];
}

// Optional ACTIONABLE guidance for a reason whose note is long
// enough to wrap. A reason with a detail renders as a compact title plus a
// collapsed "Details" disclosure (no bullet dot) instead of a dotted
// one-liner — users who intentionally run multiple sessions keep a one-line
// warning by default. Same closed-union keying as REASON_COPY — no free-form
// strings reach the DOM.
export const REASON_COPY_DETAIL: Partial<Record<CockpitFieldReason, string>> = {
  snapshot_writer_collision:
    'Another Claude Code terminal may still be writing this snapshot. Close other Claude Code terminals, or configure separate snapshot files.',
};

// Under a writer collision the session-specific context/cost explanations
// describe the SAME condition as the warning, so they live inside its Details
// disclosure (technical-details setting permitting) rather than stacking as
// extra always-visible lines under the card. Static, closed-union derived.
const COLLISION_TECH_NOTES: readonly string[] = [
  `${REASON_COPY.context_session_specific_collision}.`,
  `${REASON_COPY.cost_session_specific_collision}.`,
];

// Codex model/reasoning is config-derived — surface it with 'configured' phrasing
// so it never implies live-session truth. Under a writer collision the model is
// session-specific and muted upstream — the header line names the stable
// multi-session state instead of swapping models every poll.
function modelLine(card: GaugeCardViewModel): string | undefined {
  if (card.reason === 'snapshot_writer_collision') {
    return `Multiple ${card.agentLabel} sessions`;
  }
  const parts = [card.model, card.reasoning].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  if (parts.length === 0) return undefined;
  const joined = parts.join(' ');
  return card.colorKey === 'codex' ? `${joined} (configured)` : joined;
}

// Strip the "X% left · " prefix from the VM sublabel so the reset line stands
// alone (the % left is now the hero number). Returns undefined when no reset is
// known (the sublabel carries only "X% left").
function resetText(subLabel: string | undefined): string | undefined {
  if (subLabel === undefined) return undefined;
  const idx = subLabel.indexOf('resets ');
  return idx >= 0 ? subLabel.slice(idx) : undefined;
}

interface DisplayLimit {
  readonly kind: 'session' | 'weekly';
  readonly label: '5-hour window' | 'Weekly';
  readonly ariaLabel: '5-hour window remaining' | 'Weekly remaining';
  readonly gauge: GaugeViewModel;
}

function displayLimit(kind: 'session' | 'weekly', gauge: GaugeViewModel): DisplayLimit | undefined {
  if (gauge.usedPct === undefined) return undefined;
  return kind === 'session'
    ? { kind, label: '5-hour window', ariaLabel: '5-hour window remaining', gauge }
    : { kind, label: 'Weekly', ariaLabel: 'Weekly remaining', gauge };
}

function primaryDisplayLimit(card: GaugeCardViewModel): DisplayLimit | undefined {
  return displayLimit('session', card.session) ?? displayLimit('weekly', card.weekly);
}

// Risk must never be conveyed by color alone (WCAG 1.4.1): the meter color is
// paired with this TEXT + glyph pill. Quiet for ok/unavailable.
const RISK_PILL_COPY: Record<'warning' | 'critical', string> = {
  warning: 'Near limit',
  critical: 'Critical',
};

function RiskPill({ risk }: { readonly risk: CardRisk }) {
  if (risk !== 'warning' && risk !== 'critical') return null;
  return (
    <span className={`risk-pill risk-pill--${risk}`} role="status">
      <svg className="risk-pill__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.5 15 14H1z" fill="none" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M8 6v4" stroke-width="1.5" stroke-linecap="round" />
        <circle cx="8" cy="12" r="0.9" />
      </svg>
      <span className="risk-pill__text">{RISK_PILL_COPY[risk]}</span>
    </span>
  );
}

export interface AgentCardCallbacks {
  readonly onConfigure: () => void;
  readonly onOpenClaudeSnapshotPathSetting: () => void;
  // Opens the (read-only) Settings surface; with a target it focuses the exact
  // setting so the user can flip an opt-in in one click.
  readonly onOpenSettings: (target?: SettingTarget) => void;
  readonly onRefresh: () => void;
  readonly onDiagnostics: () => void;
}

const NO_CALLBACKS: AgentCardCallbacks = {
  onConfigure: () => {},
  onOpenClaudeSnapshotPathSetting: () => {},
  onOpenSettings: () => {},
  onRefresh: () => {},
  onDiagnostics: () => {},
};

function ctaHandler(spec: SetupSpec, callbacks: AgentCardCallbacks): () => void {
  if (spec.action === 'openClaudeSnapshotPathSetting') {
    return callbacks.onOpenClaudeSnapshotPathSetting;
  }
  if (spec.action === 'openSettings') return () => callbacks.onOpenSettings(spec.settingTarget);
  if (spec.action === 'refreshNativeStatus') return callbacks.onRefresh;
  if (spec.action === 'openCockpitDiagnostics') return callbacks.onDiagnostics;
  return callbacks.onConfigure;
}

function WindowRow({
  label,
  fillPct,
  level,
  valueText,
  reset,
  ariaLabel,
}: {
  readonly label: string;
  readonly fillPct: number;
  readonly level: 'ok' | 'warn' | 'crit';
  readonly valueText: string;
  readonly reset?: string;
  readonly ariaLabel: string;
}) {
  return (
    <>
      <div className="tg-row">
        <span className="tg-row__label">{label}</span>
        <Meter leftPct={fillPct} level={level} ariaLabel={ariaLabel} />
        <span className="tg-row__value">{valueText}</span>
      </div>
      {reset !== undefined ? <div className="tg-row__reset">{reset}</div> : null}
    </>
  );
}

// The technical-details block (gated by showTechnicalDetails): the Context row or
// an honest "not reported" note, plus the provider-reported cost. DOM-omitted
// entirely when the setting is off so screen readers match the visual state. The
// raw source-tier / confidence / freshness internals are intentionally NOT shown —
// they are developer provenance, not user-facing (the non-billing honesty lives in
// the always-on footer).
function TechnicalDetails({ card }: { readonly card: GaugeCardViewModel }) {
  const contextReason = reasonCopy(card.context.reason);
  const costReason = card.costLabel === undefined ? reasonCopy(card.costReason) : undefined;
  return (
    <div className="tg-details">
      {card.context.usedPct !== undefined ? (
        // Battery-consistent with the 5h/weekly meters: fill = % REMAINING, and
        // the value text says which direction it counts. A full bar always means
        // "plenty left" on every meter of the card.
        <WindowRow
          label="Context"
          fillPct={100 - card.context.usedPct}
          level={levelFromLeftPct(100 - card.context.usedPct)}
          valueText={`${100 - card.context.usedPct}% left`}
          ariaLabel="Context window remaining"
        />
      ) : (
        <div className="tg-context-note">
          {contextReason ?? `Context not reported by ${card.agentLabel}.`}
        </div>
      )}
      {card.costLabel !== undefined ? (
        <div className="tg-context-note">
          {`Cost ${card.costLabel} — reported by the agent, not a bill`}
        </div>
      ) : costReason !== undefined ? (
        <div className="tg-context-note">{costReason}</div>
      ) : null}
    </div>
  );
}

export function AgentCard({
  card,
  showTechnicalDetails = false,
  callbacks = NO_CALLBACKS,
}: {
  readonly card: GaugeCardViewModel;
  // Gates ALL technical detail (Context row, cost, raw source/freshness/reason).
  // Default false → the simple card. Active warnings + the privacy footer always
  // render regardless of this flag.
  readonly showTechnicalDetails?: boolean;
  // SetupCallout CTAs and the card's recheck route through these — the webview
  // never sets a setting itself. Defaults to no-ops for direct/test rendering.
  readonly callbacks?: AgentCardCallbacks;
}) {
  const state = cardVisualState(card);
  const edge = edgeForState(state);
  const badge = badgeForState(state);
  const model = modelLine(card);
  const primaryLimit = primaryDisplayLimit(card);
  const hasMeters = (state === 'live' || state === 'stale') && primaryLimit !== undefined;
  const dim = state === 'stale';
  const setup = setupCalloutFor(card);
  // leftPct always accompanies usedPct in current VMs; the derivation guards a
  // persisted VM from an older build (webview state restore is a version
  // boundary) so a missing leftPct can never render as a critical-looking 0%.
  const primaryLeft =
    primaryLimit !== undefined
      ? (primaryLimit.gauge.leftPct ?? 100 - (primaryLimit.gauge.usedPct ?? 0))
      : 0;
  const weeklySecondary =
    primaryLimit?.kind === 'session' ? displayLimit('weekly', card.weekly) : undefined;
  const staleNote = reasonCopy(card.reason);
  const staleDetail = card.reason !== undefined ? REASON_COPY_DETAIL[card.reason] : undefined;

  return (
    <article
      className={`tg-card agent-${card.colorKey}`}
      data-agent={card.colorKey}
      data-edge={edge}
      aria-label={`${card.agentLabel} status`}
    >
      <div className="tg-card__cap" />
      <div className="tg-card__body">
        <header className="tg-card__head">
          <ProviderBadge colorKey={card.colorKey} fallbackLabel={monogramFor(card)} />
          <div className="tg-card__id">
            <div className="tg-card__name">{card.agentLabel}</div>
            {model !== undefined ? <div className="tg-card__model">{model}</div> : null}
          </div>
          <StateBadge tone={badge.tone} label={badge.label} />
        </header>

        {hasMeters ? (
          <>
            <div className={dim ? 'tg-data tg-data--dim' : 'tg-data'}>
              <div className="tg-gauge__labelrow">
                <span className="tg-gauge__label">{primaryLimit.label}</span>
                <span className="tg-gauge__used">{`${primaryLimit.gauge.usedPct}% used`}</span>
              </div>
              <div className="tg-gauge__primary">
                <div className="tg-hero">
                  <span className="tg-hero__num">{primaryLeft}</span>
                  <span className="tg-hero__pct">%</span>
                  <span className="tg-hero__suffix">left</span>
                </div>
                <Meter
                  leftPct={primaryLeft}
                  level={
                    primaryLimit.kind === 'session'
                      ? levelFromRisk(card.risk)
                      : levelFromLeftPct(primaryLeft)
                  }
                  large
                  ariaLabel={`${primaryLimit.ariaLabel}${dim ? ' (last known)' : ''}`}
                />
              </div>
              <RiskPill risk={card.risk} />
              {resetText(primaryLimit.gauge.subLabel) !== undefined ? (
                <div className="tg-reset">{resetText(primaryLimit.gauge.subLabel)}</div>
              ) : null}
              {weeklySecondary !== undefined && weeklySecondary.gauge.leftPct !== undefined ? (
                <>
                  <hr className="tg-divider" />
                  <WindowRow
                    label={weeklySecondary.label}
                    fillPct={weeklySecondary.gauge.leftPct}
                    level={levelFromLeftPct(weeklySecondary.gauge.leftPct)}
                    valueText={`${weeklySecondary.gauge.leftPct}% left`}
                    {...(resetText(weeklySecondary.gauge.subLabel) !== undefined
                      ? { reset: resetText(weeklySecondary.gauge.subLabel) }
                      : {})}
                    ariaLabel={`${weeklySecondary.ariaLabel}${dim ? ' (last known)' : ''}`}
                  />
                </>
              ) : null}
            </div>
            {dim && staleNote !== undefined ? (
              staleDetail !== undefined ? (
                // A long actionable note reads as a compact status
                // block — the warn-colored title stays always-visible; the
                // guidance (and, when the technical-details setting is on, the
                // session-specific context/cost explanations) sits behind a
                // native <details> disclosure. Collapsed by default, purely
                // local (no host round-trip), and the platform announces the
                // expanded/collapsed state on the summary toggle.
                <div className="tg-stale-note tg-stale-note--block">
                  <div className="tg-stale-note__title">{staleNote}</div>
                  <details className="tg-stale-note__details">
                    <summary className="tg-stale-note__summary">Details</summary>
                    <div className="tg-stale-note__body">{staleDetail}</div>
                    {showTechnicalDetails && card.reason === 'snapshot_writer_collision'
                      ? COLLISION_TECH_NOTES.map((line) => (
                          <div key={line} className="tg-stale-note__body">
                            {line}
                          </div>
                        ))
                      : null}
                  </details>
                </div>
              ) : (
                // No "· not live" suffix: every retained-value reason copy
                // already says "showing last-known" and the badge reads "Last
                // known" — a third repetition was pure noise (stale-copy dedup).
                <div className="tg-stale-note">
                  <span className="tg-stale-note__dot" aria-hidden="true" />
                  {staleNote}
                </div>
              )
            ) : null}
            {/* Under a writer collision the technical block would carry ONLY the
                session-specific context/cost explanations, which now live in the
                warning's Details disclosure — rendering both would duplicate. */}
            {showTechnicalDetails && card.reason !== 'snapshot_writer_collision' ? (
              <TechnicalDetails card={card} />
            ) : null}
          </>
        ) : (
          <SetupCallout spec={setup} onCta={ctaHandler(setup, callbacks)} />
        )}

        <PrivacyFooter agentLabel={card.agentLabel} />
      </div>
    </article>
  );
}
