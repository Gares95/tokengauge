// The NATIVE-first status bar surface.
//
// This is the single source path permitted to call
// `vscode.window.createStatusBarItem` (enforced by
// tools/check-no-stray-ui-surfaces.mjs). Under the default native cockpit the
// bar is driven by the sanitized GaugeCardViewModel[] the cockpit loop posts —
// NOT by the log-derived aggregator. Honesty invariants for the native path:
//   - the text reflects the Claude card's session-gauge usedPct + risk; a
//     degraded/collision card keeps its value and is marked `(last known)`; an
//     unavailable card renders `—`. It NEVER renders "no usage yet" or any
//     log-derived source string while a native card is present.
// - risk warning/critical maps to the status-bar warning background.
//   - the tooltip is PLAIN-LANGUAGE and user-facing — agent, model, a
//     "reported by <tool>; not an official billing total" honesty cue, a plain
//     last-known/unavailable state line, and the "Click to open the TokenGauge
//     Cockpit." action. Raw internal taxonomy (sourceTier / accuracyLabel /
//     confidence / freshness ids, and the "billing-authoritative" jargon) is NOT
//     surfaced here — it stays in the card's technical details and Cockpit
//     Diagnostics. It never carries "local logs / last sync never / accuracy
//     unknown".
//   - clicking focuses the native cockpit view (the auto-provided focus command),
//     never the legacy log-derived surface.
//
// No raw log path, project path, JSONL content, prompt/completion text, stack
// trace, env value, session id, or credential ever reaches this surface.

import * as vscode from 'vscode';
import type { CardRisk, GaugeCardViewModel } from '../cockpit/GaugeCardViewModel';

// VS Code auto-provides `<viewId>.focus` for a contributed view, so focusing the
// cockpit needs no bespoke command (the plan's Option A).
export const COCKPIT_STATUS_COMMAND = 'tokenGauge.views.cockpit.focus';

// Shown before the cockpit loop has posted any card. Neutral and honest — never
// the legacy log-derived empty-state copy.
export const NEUTRAL_STATUS_BAR_TEXT = 'TG: open cockpit';

function claudeCard(cards: readonly GaugeCardViewModel[]): GaugeCardViewModel | undefined {
  return cards.find((c) => c.agent === 'claude-code') ?? cards[0];
}

function codexHint(cards: readonly GaugeCardViewModel[]): string | undefined {
  const codex = cards.find((c) => c.agent === 'codex');
  if (codex === undefined) {
    return undefined;
  }
  if (codex.session.usedPct !== undefined) {
    return `Codex ${codex.session.usedPct}%`;
  }
  return 'Codex off';
}

// Map a native card to glanceable status-bar text. A fresh card shows the 5h
// session usedPct; a degraded card keeps the value and flags `(last known)`; an
// unavailable card shows a `—` — never "no usage yet".
export function formatCockpitStatusBarText(cards: readonly GaugeCardViewModel[]): string {
  const card = claudeCard(cards);
  if (card === undefined) {
    return NEUTRAL_STATUS_BAR_TEXT;
  }
  const label = card.agentLabel.replace(/\s+code$/i, '');
  let head: string;
  if (card.session.usedPct === undefined) {
    head = `TG: ${label} —`;
  } else if (card.session.state === 'degraded' || card.freshness === 'degraded') {
    // Plain-language "retained value" cue — never the raw `degraded` taxonomy.
    head = `TG: ${label} ${card.session.usedPct}% 5h (last known)`;
  } else {
    head = `TG: ${label} ${card.session.usedPct}% 5h`;
  }
  const hint = card.agent === 'codex' ? undefined : codexHint(cards);
  return hint !== undefined ? `${head} · ${hint}` : head;
}

// Warning/critical risk → warning background. `ok`/`unavailable` carry
// no background so an unavailable card is not painted as a risk.
export function cockpitStatusIsWarning(cards: readonly GaugeCardViewModel[]): boolean {
  const risk: CardRisk | undefined = claudeCard(cards)?.risk;
  return risk === 'warning' || risk === 'critical';
}

// Native source tiers whose `proxy_reported` accuracy is "agent/native-reported"
// — honest, but NEVER billing truth. Local mirror of the card-footer rule so the
// extension-host status bar pulls in no webview/React code.
const NATIVE_SOURCE_TIERS: ReadonlySet<string> = new Set([
  'statusline_snapshot',
  'codex_status_snapshot',
  'stats_cache_snapshot',
]);

// Plain-language honesty cue for a native proxy value. The non-billing qualifier
// is MANDATORY (the cardinal rule) so the number never reads as an official
// billing total — but it is phrased for a normal user ("not an official billing
// total", named by the reporting tool) rather than the internal "Native-reported
// · not billing-authoritative" jargon. The raw accuracy id never reaches here.
function reportedByLine(card: GaugeCardViewModel): string | undefined {
  if (card.accuracyLabel === 'proxy_reported' && NATIVE_SOURCE_TIERS.has(card.sourceTier)) {
    return `Reported by ${card.agentLabel}; not an official billing total.`;
  }
  return undefined;
}

// Plain-language state cue — never a raw freshness/sourceTier id. A retained value
// reads as "last known" (not live, not a failure); an absent value reads as
// unavailable; a live value reads as native status data.
function plainStateLine(card: GaugeCardViewModel): string {
  if (card.session.usedPct === undefined) {
    return 'Some values are currently unavailable.';
  }
  if (
    card.session.state === 'degraded' ||
    card.freshness === 'degraded' ||
    card.freshness === 'stale'
  ) {
    return 'Some values are last known, not live.';
  }
  return 'Showing native status data.';
}

// Plain-language, user-facing tooltip. It keeps the honesty signals (native vs
// billing, last-known vs live, unavailable) in readable copy and front-loads the
// cockpit action; raw internal taxonomy stays in the card's technical details and
// Cockpit Diagnostics.
export function buildCockpitStatusTooltip(cards: readonly GaugeCardViewModel[]): string {
  const card = claudeCard(cards);
  if (card === undefined) {
    return ['TokenGauge', 'No native status yet.', 'Click to open the TokenGauge Cockpit.'].join(
      '\n',
    );
  }
  const lines: string[] = [`TokenGauge: ${card.agentLabel}`];
  if (card.model !== undefined) {
    lines.push(`Model: ${card.model}`);
  }
  const accuracy = reportedByLine(card);
  if (accuracy !== undefined) {
    lines.push(accuracy);
  }
  lines.push(plainStateLine(card));
  lines.push('Click to open the TokenGauge Cockpit.');
  lines.push('For technical details, run TokenGauge: Cockpit Diagnostics.');
  return lines.join('\n');
}

// Owns exactly one native status bar item. The class is intentionally thin —
// all honesty logic lives in the pure formatters above so it is unit-testable
// without booting VS Code. It is fed exclusively by the native cockpit; the
// legacy log-derived supervisor feed was removed (no released
// users, so the unused path is deleted rather than deprecated).
export class StatusBarUsageItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor(priority = 100) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
    this.item.command = COCKPIT_STATUS_COMMAND;
    this.item.text = NEUTRAL_STATUS_BAR_TEXT;
    this.item.tooltip = buildCockpitStatusTooltip([]);
  }

  public get text(): string {
    return this.item.text;
  }

  // Drive the bar from the native cockpit's sanitized GaugeCardViewModel[]. The
  // cockpit loop calls this on every refresh (extension.ts buildCockpitLoop post).
  public updateFromCockpit(cards: readonly GaugeCardViewModel[]): void {
    this.item.text = formatCockpitStatusBarText(cards);
    this.item.tooltip = buildCockpitStatusTooltip(cards);
    this.item.backgroundColor = cockpitStatusIsWarning(cards)
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  public show(): void {
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}
