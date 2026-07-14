// The NATIVE-first status bar surface.
//
// The status bar is now fed by the native cockpit GaugeCardViewModel output, NOT
// the log-derived aggregator. These tests pin the honesty invariants for the
// native path:
//   - text reflects the Claude card's session-gauge usedPct ("TG: Claude 84% 5h")
//   - degraded/collision/unavailable states are honest, NEVER "no usage yet"
//   - risk warning/critical maps to the status-bar warning background
//   - the tooltip is PLAIN-LANGUAGE: agent, model, a native-reported/non-billing
//     honesty cue, a plain last-known/unavailable state line, and the "Open the
//     TokenGauge Cockpit" action — NEVER raw internal ids (sourceTier /
//     accuracyLabel / confidence / freshness), NEVER "local logs / last sync never
//     / accuracy unknown", NEVER a raw path/id/credential.
//   - the command target is the cockpit focus, NOT the legacy dashboard.

import * as assert from 'node:assert/strict';
import type { GaugeCardViewModel } from '../../../src/cockpit/GaugeCardViewModel';
import {
  buildCockpitStatusTooltip,
  COCKPIT_STATUS_COMMAND,
  formatCockpitStatusBarText,
  NEUTRAL_STATUS_BAR_TEXT,
} from '../../../src/status/StatusBarUsageItem';

function claudeCard(overrides: Partial<GaugeCardViewModel> = {}): GaugeCardViewModel {
  return {
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    colorKey: 'claude',
    model: 'claude-sonnet-4',
    session: {
      usedPct: 84,
      leftPct: 16,
      centerLabel: '84%',
      subLabel: '16% left · resets 17:30',
      state: 'fresh',
      accuracyLabel: 'proxy_reported',
      confidence: 'high',
    },
    weekly: { usedPct: 40, leftPct: 60, centerLabel: '40%', state: 'fresh' },
    context: { usedPct: 20, leftPct: 80, centerLabel: '20%', state: 'fresh' },
    risk: 'ok',
    sourceTier: 'statusline_snapshot',
    accuracyLabel: 'proxy_reported',
    confidence: 'high',
    freshness: 'fresh',
    ...overrides,
  };
}

function codexCard(overrides: Partial<GaugeCardViewModel> = {}): GaugeCardViewModel {
  return {
    agent: 'codex',
    agentLabel: 'Codex',
    colorKey: 'codex',
    session: { centerLabel: '—', state: 'unavailable', reason: 'codex_probe_disabled' },
    weekly: { centerLabel: '—', state: 'unavailable' },
    context: { centerLabel: '—', state: 'unavailable' },
    risk: 'unavailable',
    sourceTier: 'unknown',
    freshness: 'unavailable',
    reason: 'codex_probe_disabled',
    ...overrides,
  };
}

suite('StatusBar native cockpit formatter', () => {
  test('Fresh Claude card renders glanceable native text with usedPct', () => {
    const text = formatCockpitStatusBarText([claudeCard()]);
    assert.equal(text, 'TG: Claude 84% 5h');
    assert.ok(!text.includes('no usage yet'), 'never legacy empty-state copy');
    assert.ok(!text.includes('local logs'), 'never log-derived source copy');
  });

  test('No cards renders the neutral open-cockpit state, never legacy text', () => {
    const text = formatCockpitStatusBarText([]);
    assert.equal(text, NEUTRAL_STATUS_BAR_TEXT);
    assert.ok(!text.includes('no usage yet'));
  });

  test('Degraded/collision Claude card keeps the value, marked plainly as last known', () => {
    const text = formatCockpitStatusBarText([
      claudeCard({
        session: {
          usedPct: 84,
          leftPct: 16,
          centerLabel: '84%',
          state: 'degraded',
          reason: 'snapshot_writer_collision',
        },
        freshness: 'degraded',
      }),
    ]);
    assert.equal(text, 'TG: Claude 84% 5h (last known)');
    assert.ok(!text.includes('(degraded)'), 'no raw "degraded" taxonomy in visible text');
    assert.ok(!text.includes('no usage yet'));
  });

  test('Unavailable Claude card renders an honest dash, never "no usage yet"', () => {
    const text = formatCockpitStatusBarText([
      claudeCard({
        session: {
          centerLabel: '—',
          state: 'unavailable',
          reason: 'statusline_snapshot_not_configured',
        },
        risk: 'unavailable',
        freshness: 'unavailable',
      }),
    ]);
    assert.equal(text, 'TG: Claude —');
    assert.ok(!text.includes('no usage yet'));
    assert.ok(!text.includes('local logs'));
  });

  test('Text includes a compact Codex hint when Codex is present and disabled', () => {
    const text = formatCockpitStatusBarText([claudeCard(), codexCard()]);
    assert.equal(text, 'TG: Claude 84% 5h · Codex off');
  });

  test('Hidden Codex is omitted from status bar text and tooltip when filtered out', () => {
    const visibleCards = [claudeCard()];
    const text = formatCockpitStatusBarText(visibleCards);
    const tip = buildCockpitStatusTooltip(visibleCards);
    assert.equal(text, 'TG: Claude 84% 5h');
    assert.ok(!text.includes('Codex'), 'hidden Codex must not appear in text');
    assert.ok(!tip.includes('Codex'), 'hidden Codex must not appear in tooltip');
  });

  test('Hidden Claude lets visible Codex become the primary status', () => {
    const visibleCards = [
      codexCard({
        session: {
          usedPct: 9,
          leftPct: 91,
          centerLabel: '9%',
          state: 'fresh',
          accuracyLabel: 'proxy_reported',
        },
        weekly: { usedPct: 3, leftPct: 97, centerLabel: '3%', state: 'fresh' },
        risk: 'ok',
        sourceTier: 'codex_status_snapshot',
        accuracyLabel: 'proxy_reported',
        freshness: 'fresh',
        reason: undefined,
      }),
    ];
    const text = formatCockpitStatusBarText(visibleCards);
    const tip = buildCockpitStatusTooltip(visibleCards);
    assert.equal(text, 'TG: Codex 9% 5h');
    assert.ok(!text.includes('Claude'), 'hidden Claude must not appear in text');
    assert.ok(!tip.includes('Claude'), 'hidden Claude must not appear in tooltip');
  });

  test('Both hidden uses neutral status bar text and leaks no provider details', () => {
    const text = formatCockpitStatusBarText([]);
    const tip = buildCockpitStatusTooltip([]);
    assert.equal(text, NEUTRAL_STATUS_BAR_TEXT);
    assert.ok(!/Claude|Codex|sonnet|opus/i.test(`${text}\n${tip}`));
  });

  test('Tooltip uses plain-language trust copy, not raw internal ids', () => {
    const tip = buildCockpitStatusTooltip([claudeCard()]);
    assert.ok(tip.includes('Claude Code'), 'agent label');
    assert.ok(tip.includes('claude-sonnet-4'), 'model');
    // Honesty preserved in plain, user-readable language (native-sourced proxy value):
    // named by the reporting tool + "not an official billing total".
    assert.ok(/not an official billing total/i.test(tip), 'plain non-billing honesty cue');
    assert.ok(/reported by claude code/i.test(tip), 'names the reporting tool');
    // Clear clickable affordance + a pointer to diagnostics for the technical detail.
    assert.ok(/click to open the tokengauge cockpit/i.test(tip), 'clickable cockpit affordance');
    assert.ok(/for technical details/i.test(tip), 'points to diagnostics for technical detail');
    assert.ok(/cockpit diagnostics/i.test(tip), 'names the diagnostics command');
    // Internal / jargony taxonomy must NOT appear in the default tooltip.
    assert.ok(!/billing-authoritative/i.test(tip), 'no "billing-authoritative" jargon');
    assert.ok(!/native[- ]reported/i.test(tip), 'no "Native-reported" internal phrase');
    assert.ok(!tip.includes('statusline_snapshot'), 'no raw sourceTier id');
    assert.ok(!tip.includes('proxy_reported'), 'no raw accuracyLabel id');
    assert.ok(!/Source:/i.test(tip), 'no raw "Source:" line');
    assert.ok(!/Confidence:/i.test(tip), 'no raw "Confidence:" line');
    assert.ok(
      !/Freshness:\s*(fresh|stale|degraded|unavailable)/i.test(tip),
      'no raw freshness id line',
    );
    assert.ok(!/log ingestion/i.test(tip), 'no log-ingestion line in native-only');
  });

  test('Degraded tooltip says "last known" in plain language, no raw freshness id', () => {
    const tip = buildCockpitStatusTooltip([
      claudeCard({
        session: {
          usedPct: 84,
          leftPct: 16,
          centerLabel: '84%',
          state: 'degraded',
          reason: 'snapshot_writer_collision',
        },
        freshness: 'degraded',
      }),
    ]);
    assert.ok(/last known/i.test(tip), 'plain last-known cue');
    assert.ok(!/Freshness:/i.test(tip), 'no raw "Freshness:" line');
    assert.ok(!tip.includes('degraded'), 'no raw "degraded" id in the tooltip');
  });

  test('Tooltip NEVER carries the legacy log-derived strings', () => {
    const tip = buildCockpitStatusTooltip([claudeCard()]);
    assert.ok(!/local logs/i.test(tip), 'no "local logs"');
    assert.ok(!/last sync/i.test(tip), 'no "last sync"');
    assert.ok(!/accuracy:\s*unknown/i.test(tip), 'no "accuracy: unknown"');
    assert.ok(!/open dashboard/i.test(tip), 'no "open dashboard"');
  });

  test('Tooltip never leaks raw paths, ids, or credentials', () => {
    const tip = buildCockpitStatusTooltip([claudeCard()]);
    assert.ok(!/\/home\/|\/Users\/|[A-Za-z]:\\/.test(tip), 'no raw path');
    assert.ok(!/sk-ant-|sk-|"role"\s*:/.test(tip), 'no credential/prompt shape');
  });

  test('The cockpit status command focuses the cockpit, not the dashboard', () => {
    assert.equal(COCKPIT_STATUS_COMMAND, 'tokenGauge.views.cockpit.focus');
    assert.ok(!COCKPIT_STATUS_COMMAND.includes('openDashboard'));
  });
});

// Under a writer collision the status bar must not alternate model names
// between competing sessions. The VM layer mutes the session-specific model, so
// the tooltip carries NO model line at all — end-to-end through the real builder.
suite('StatusBar under writer collision', () => {
  test('Collision tooltip carries no model line, text keeps the conservative value', async () => {
    const { buildGaugeCardViewModels } = await import('../../../src/cockpit/GaugeCardViewModel.js');
    const now = () => new Date('2026-07-04T12:00:00.000Z');
    const build = (model: string) =>
      buildGaugeCardViewModels({
        candidates: [
          {
            sourceTier: 'statusline_snapshot',
            producedAtMs: now().getTime(),
            scope: { provider: 'anthropic', agent: 'claude-code', model },
            confidence: 'high',
            session: { usedPct: 88, leftPct: 12 },
            model,
            unavailableReason: 'snapshot_writer_collision',
          },
        ],
        configuredAgents: ['claude-code'],
        now,
      });

    // Whichever session's model the shared file carried at read time, the
    // rendered tooltip is IDENTICAL — no model line, same last-known story.
    const tipA = buildCockpitStatusTooltip(build('claude-fable-5'));
    const tipB = buildCockpitStatusTooltip(build('claude-opus-4-8'));
    assert.equal(tipA, tipB, 'the tooltip must not vary with the writing session');
    assert.ok(!/Model:/.test(tipA), 'no model line under collision');
    assert.ok(!/fable|opus/i.test(tipA), 'no session-specific model id leaks');

    // The glanceable text keeps the conservative value, marked last known.
    const text = formatCockpitStatusBarText(build('claude-fable-5'));
    assert.ok(/88% 5h \(last known\)/.test(text), `expected last-known text, got: ${text}`);
  });
});
