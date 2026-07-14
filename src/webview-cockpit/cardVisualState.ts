// The pure presentation classifier that maps a sanitized GaugeCardViewModel
// to a design visual state. NO new data — it reads existing VM fields only
// (freshness, the closed-union reason, session value presence) and decides which
// design treatment a card gets. The honesty rule is structural: a card with NO
// session value never renders a meter — it renders a SetupCallout instead, so an
// unavailable source can never look like 0% usage.

import type { GaugeCardViewModel } from '../cockpit/GaugeCardViewModel';
import type { CockpitFieldReason } from '../core/cockpit/CockpitState';

export type CardVisualState =
  | 'live'
  | 'stale'
  | 'notConfigured'
  | 'disabled'
  | 'unavailable'
  | 'error';

export type CardEdge = 'brand' | 'neutral' | 'crit';
export type BadgeTone = 'live' | 'stale' | 'muted' | 'blocked';

export interface BadgeSpec {
  readonly tone: BadgeTone;
  readonly label: string;
}

// Which existing read-only inbound message a SetupCallout CTA posts. The webview
// NEVER sets a setting; specific setup CTAs either post a named exact-setting
// message (Claude snapshot path) or openSettings with a closed settingTarget.
export type SetupAction =
  | 'configureCockpit'
  | 'openClaudeSnapshotPathSetting'
  | 'openSettings'
  | 'refreshNativeStatus'
  | 'openCockpitDiagnostics';

// A closed enum of settings a CTA may open directly (never an arbitrary query).
export type SettingTarget = 'claudeSnapshotPath' | 'codexProbe' | 'providerCards';

export interface SetupSpec {
  readonly title: string;
  readonly msg: string;
  readonly ctaLabel: string;
  readonly action: SetupAction;
  // For action 'openSettings' — the specific setting to focus (one-click).
  readonly settingTarget?: SettingTarget;
}

// Error-class blockers: the source is set up but actively failing/returning no
// usable status → crit edge, "Blocked" badge, recheck CTA.
const ERROR_REASONS: ReadonlySet<CockpitFieldReason> = new Set<CockpitFieldReason>([
  'codex_probe_failed',
  'codex_probe_timeout',
  'codex_protocol_drift',
  'codex_native_status_unavailable',
  'codex_probe_no_response',
]);

// ONLY the reason that proves the user has not configured the source. The
// generic no_source/no_candidate absences are NOT "not configured" — they also
// arise when a path IS configured but the file is missing/unparseable, and the
// card must not deny a configuration the user made (honest-copy fix). Those
// fall through to 'unavailable'.
const NOT_CONFIGURED_REASONS: ReadonlySet<CockpitFieldReason> = new Set<CockpitFieldReason>([
  'statusline_snapshot_not_configured',
]);

export function cardVisualState(card: GaugeCardViewModel): CardVisualState {
  // A card with a real session value always shows meters: fresh → live, anything
  // else (stale / degraded-with-retained-value) → last-known.
  if (card.session.usedPct !== undefined) {
    return card.freshness === 'fresh' ? 'live' : 'stale';
  }
  // No session value → a no-meter state classified by the closed-union reason.
  const reason = card.reason;
  if (reason !== undefined) {
    if (ERROR_REASONS.has(reason)) return 'error';
    if (reason === 'codex_probe_disabled') return 'disabled';
    if (NOT_CONFIGURED_REASONS.has(reason)) return 'notConfigured';
  }
  // CLI-missing, probe-pending, window-reset-pending, or an unmapped absence:
  // an honest "unavailable" (neutral, no gauge) — never a fabricated 0%.
  return 'unavailable';
}

export function edgeForState(state: CardVisualState): CardEdge {
  if (state === 'error') return 'crit';
  if (state === 'live' || state === 'stale') return 'brand';
  return 'neutral';
}

export function badgeForState(state: CardVisualState): BadgeSpec {
  switch (state) {
    case 'live':
      return { tone: 'live', label: 'Live' };
    case 'stale':
      return { tone: 'stale', label: 'Last known' };
    case 'notConfigured':
      return { tone: 'muted', label: 'Not configured' };
    case 'disabled':
      return { tone: 'muted', label: 'Probe off' };
    case 'unavailable':
      return { tone: 'muted', label: 'Unavailable' };
    case 'error':
      return { tone: 'blocked', label: 'Blocked' };
  }
}

export function monogramFor(card: GaugeCardViewModel): string {
  if (card.colorKey === 'claude') return 'C';
  if (card.colorKey === 'codex') return '›';
  return (card.agentLabel.trim()[0] ?? '·').toUpperCase();
}

// The SetupCallout copy for a no-value card, keyed by the closed-union reason.
// Honors the design microcopy. Returns undefined for a card that should show
// meters (the caller only invokes this for no-value states).
const SETUP_BY_REASON: Partial<Record<CockpitFieldReason, SetupSpec>> = {
  statusline_snapshot_not_configured: {
    title: 'Not configured',
    msg: 'Read the Claude statusLine snapshot you choose to write. Use a per-session directory for multiple sessions; single-file mode is for one writer.',
    ctaLabel: 'Configure snapshot path',
    action: 'openClaudeSnapshotPathSetting',
  },
  statusline_snapshot_missing_rate_limits: {
    title: 'Waiting for limit fields',
    msg: 'TokenGauge read the Claude statusLine snapshot, but this sample did not include 5h or weekly rate-limit fields. Claude Code usually reports those fields only for supported subscription sessions and after a Claude response. TokenGauge will not guess a usage window.',
    ctaLabel: 'Open diagnostics',
    action: 'openCockpitDiagnostics',
  },
  codex_probe_disabled: {
    title: 'Native probe is off',
    msg: 'Codex status uses an explicit opt-in probe, off by default. Open the setting when you want local Codex status; no provider secrets are requested.',
    ctaLabel: 'Open probe setting',
    // One-click to the exact toggle (the user still flips it themselves).
    action: 'openSettings',
    settingTarget: 'codexProbe',
  },
  codex_cli_not_found: {
    title: 'Codex CLI not found',
    msg: 'Install the Codex CLI and reopen the workspace, then recheck native status.',
    ctaLabel: 'Recheck native status',
    action: 'refreshNativeStatus',
  },
  codex_probe_no_response: {
    title: 'Native status blocked',
    msg: 'The Codex app-server did not respond over stdio. In some WSL or remote setups this can be a Codex CLI or app-server limitation; update Codex CLI or try an environment where app-server responds over stdio.',
    ctaLabel: 'Open diagnostics',
    action: 'openCockpitDiagnostics',
  },
  codex_probe_failed: {
    title: 'Native status blocked',
    msg: 'The native probe is on but returned no usable status — try a recheck.',
    ctaLabel: 'Recheck native status',
    action: 'refreshNativeStatus',
  },
  codex_probe_timeout: {
    title: 'Native status blocked',
    msg: 'The native probe is on but returned no usable status — try a recheck.',
    ctaLabel: 'Recheck native status',
    action: 'refreshNativeStatus',
  },
  codex_protocol_drift: {
    title: 'Native status blocked',
    msg: 'The native probe is on but its status format was not recognized — try a recheck.',
    ctaLabel: 'Recheck native status',
    action: 'refreshNativeStatus',
  },
  codex_native_status_unavailable: {
    title: 'Native status blocked',
    msg: 'The native probe is on but returned no usable status — try a recheck.',
    ctaLabel: 'Recheck native status',
    action: 'refreshNativeStatus',
  },
  codex_probe_pending: {
    title: 'Awaiting native status',
    msg: 'The native probe is on — waiting for its first status. Try a recheck in a moment.',
    ctaLabel: 'Recheck native status',
    action: 'refreshNativeStatus',
  },
};

// The reset-pending callout is agent-aware and tells the user the ONE
// action that actually produces a fresh window (the agent must complete a new
// response) — a bare "recheck" reads like a broken install when the snapshot
// file is being rewritten but still carries the already-passed window.
function windowResetPendingSpec(agentLabel: string): SetupSpec {
  return {
    title: 'Waiting for a fresh sample',
    msg: `${agentLabel} has not reported a fresh limit window yet — the previous window already reset. Continue a ${agentLabel} response, then recheck.`,
    ctaLabel: 'Recheck native status',
    action: 'refreshNativeStatus',
  };
}

// The fallback for an unmapped no-value absence (no_source / no_candidate / an
// unknown hole). It must NOT claim "not configured" — the same absence occurs
// when a configured snapshot path points at a missing/unparseable file, and
// denying the user's configuration is the worst first-run debugging experience.
const DEFAULT_SETUP: SetupSpec = {
  title: 'No native status',
  msg: 'TokenGauge could not read a native status for this agent on the last check. If you have configured a source, verify it — Diagnostics has details.',
  ctaLabel: 'Configure Cockpit',
  action: 'configureCockpit',
};

export function setupCalloutFor(card: GaugeCardViewModel): SetupSpec {
  const reason = card.reason;
  if (reason === 'native_window_reset_pending') {
    return windowResetPendingSpec(card.agentLabel);
  }
  if (reason !== undefined && SETUP_BY_REASON[reason] !== undefined) {
    return SETUP_BY_REASON[reason] as SetupSpec;
  }
  return DEFAULT_SETUP;
}

// ── Top-of-view summary aggregation ──────────────────────────────────────────

export interface SummarySpec {
  readonly tone: BadgeTone;
  readonly text: string;
  readonly sub?: string;
}

function withChecked(checkedLabel: string | undefined, tail: string): string {
  return checkedLabel !== undefined ? `Checked ${checkedLabel} · ${tail}` : tail;
}

// Aggregate one honest "what's going on" line from the per-card states. Pure: it
// reads each card's visual state + agentLabel only. The exact sub copy is an
// honest summary, never a fabricated count.
export function summarize(
  cards: readonly GaugeCardViewModel[],
  options: { readonly checkedLabel?: string } = {},
): SummarySpec {
  const checkedLabel = options.checkedLabel;
  // The cards array is an untrusted boundary — a malformed VM can arrive (see
  // SafeAgentCard, which renders it as a safe error card). A card that throws on
  // classification simply does not contribute to the summary; one bad card must
  // never break the whole status line.
  const states: Array<{ state: CardVisualState; label: string }> = [];
  for (const card of cards) {
    try {
      states.push({ state: cardVisualState(card), label: card.agentLabel });
    } catch {
      // Skip the malformed card.
    }
  }
  const live = states.filter((s) => s.state === 'live');
  const stale = states.filter((s) => s.state === 'stale');
  const errored = states.filter((s) => s.state === 'error');
  const total = states.length;

  if (errored.length > 0) {
    const who = errored[0]?.label ?? 'a source';
    return {
      tone: 'blocked',
      text: 'A source is blocked',
      // "<agent> needs attention", not "check <agent>" — the sub already opens
      // with "Checked HH:MM" and "Checked … check …" read like a stutter.
      sub: withChecked(checkedLabel, `${who} needs attention`),
    };
  }
  if (live.length > 0 && live.length === total) {
    return {
      tone: 'live',
      text: 'All sources live',
      sub: withChecked(checkedLabel, 'native sources fresh'),
    };
  }
  if (live.length > 0) {
    const offLabel = states.find((s) => s.state !== 'live' && s.state !== 'stale')?.label;
    const sub =
      offLabel !== undefined
        ? withChecked(checkedLabel, `${offLabel} not live`)
        : withChecked(checkedLabel, 'native sources fresh');
    const text = `${live.length} source${live.length === 1 ? '' : 's'} live`;
    return { tone: 'live', text, sub };
  }
  if (stale.length > 0) {
    return { tone: 'stale', text: 'Last known status', sub: withChecked(checkedLabel, 'not live') };
  }
  // Nothing usable. If any card is set-up-able (not configured / probe off) frame
  // it as setup; only when there is genuinely nothing to act on say "no sources".
  const actionable = states.some(
    (s) => s.state === 'notConfigured' || s.state === 'disabled' || s.state === 'unavailable',
  );
  if (actionable) {
    return { tone: 'muted', text: 'Setup needed', sub: 'Configure a source to begin' };
  }
  return { tone: 'muted', text: 'No sources available', sub: 'Configure a source to begin' };
}
