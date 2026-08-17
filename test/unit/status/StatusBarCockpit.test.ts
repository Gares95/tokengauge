// The NATIVE-first status bar surface.
//
// The status bar is now fed by the native cockpit GaugeCardViewModel output, NOT
// the log-derived aggregator. These tests pin the honesty invariants for the
// native path:
//   - text reflects the card's PRIMARY limit window ("TG: Claude 84% 5h"), using
//     the same promotion rule the card renders with, and always NAMES the window
//     so a promoted weekly value never reads as a 5h value
//   - the compact Codex hint says "off" ONLY when the probe is actually disabled
//   - degraded/collision/unavailable states are honest, NEVER "no usage yet"
//   - risk warning/critical maps to the status-bar warning background
//   - the tooltip is PLAIN-LANGUAGE and covers EVERY visible card: per agent its
//     model, one line per REPORTED window with used% and reset time, a
//     native-reported/non-billing honesty cue, and the "Open the TokenGauge
//     Cockpit" action. An unreported window gets no line (never a fabricated 0%);
//     cost and context stay off the hover, matching the default card — NEVER raw
//     internal ids (sourceTier / accuracyLabel / confidence / freshness), NEVER
//     "local logs / last sync never / accuracy unknown", NEVER a raw
//     path/id/credential.
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

// A Codex account whose app-server reports ONLY the weekly window: no 5h value,
// a real weekly value. `no_candidate` is the optional-absence reason the builder
// uses when a known window is simply not reported (see canPromoteWeekly).
function weeklyOnlyCodexCard(overrides: Partial<GaugeCardViewModel> = {}): GaugeCardViewModel {
  return codexCard({
    session: { centerLabel: '—', state: 'unavailable', reason: 'no_candidate' },
    weekly: {
      usedPct: 42,
      leftPct: 58,
      centerLabel: '42%',
      state: 'fresh',
      accuracyLabel: 'proxy_reported',
    },
    risk: 'ok',
    sourceTier: 'codex_status_snapshot',
    accuracyLabel: 'proxy_reported',
    freshness: 'fresh',
    reason: undefined,
    ...overrides,
  });
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

  // A Codex account may report ONLY a weekly window. The card promotes weekly to
  // the primary meter; the bar must follow the same promotion instead of reading
  // `session` directly, or a working probe renders a false "Codex off".
  test('Weekly-only Codex hint shows the promoted weekly value, never "off"', () => {
    const text = formatCockpitStatusBarText([claudeCard(), weeklyOnlyCodexCard()]);
    assert.equal(text, 'TG: Claude 84% 5h · Codex 42% weekly');
    assert.ok(!/Codex off/.test(text), 'a reporting probe must never read as off');
  });

  // The window is NAMED so a promoted weekly value can never be misread as a 5h
  // value — the honesty rule that a number never reads stronger than its source.
  test('Weekly-only Codex value is never labelled as the 5h window', () => {
    const text = formatCockpitStatusBarText([claudeCard(), weeklyOnlyCodexCard()]);
    assert.ok(!/42% 5h/.test(text), 'weekly value must not carry the 5h label');
    assert.ok(/42% weekly/.test(text), 'weekly value must name the weekly window');
  });

  // Same promotion when Codex is the PRIMARY card (Claude hidden): the head text
  // read `session` directly too, so a weekly-only Codex showed "TG: Codex —".
  test('Weekly-only Codex as the primary card shows its value, not a dash', () => {
    const text = formatCockpitStatusBarText([weeklyOnlyCodexCard()]);
    assert.equal(text, 'TG: Codex 42% weekly');
    assert.ok(!text.includes('—'), 'a card with a promoted value is not unavailable');
  });

  // `off` is a claim about the user's SETTING. Only the disabled reason may make
  // it; every other absence must not contradict an enabled probe.
  test('Enabled-but-pending Codex reads pending, never "off"', () => {
    const text = formatCockpitStatusBarText([
      claudeCard(),
      codexCard({
        session: { centerLabel: '—', state: 'unavailable', reason: 'codex_probe_pending' },
        reason: 'codex_probe_pending',
      }),
    ]);
    assert.equal(text, 'TG: Claude 84% 5h · Codex pending');
    assert.ok(!/Codex off/.test(text), 'an enabled probe must never read as off');
  });

  test('Other Codex blockers read n/a, never falsely reporting the probe as off', () => {
    for (const reason of [
      'codex_cli_not_found',
      'codex_probe_timeout',
      'codex_probe_no_response',
      'codex_protocol_drift',
      'codex_native_status_unavailable',
      'native_window_reset_pending',
    ] as const) {
      const text = formatCockpitStatusBarText([
        claudeCard(),
        codexCard({
          session: { centerLabel: '—', state: 'unavailable', reason },
          reason,
        }),
      ]);
      assert.equal(text, 'TG: Claude 84% 5h · Codex n/a', `reason ${reason}`);
      assert.ok(!/Codex off/.test(text), `reason ${reason} must not read as off`);
    }
  });

  // The disabled reason keeps its honest, actionable copy.
  test('Only the disabled reason renders "Codex off"', () => {
    const text = formatCockpitStatusBarText([
      claudeCard(),
      codexCard({
        session: { centerLabel: '—', state: 'unavailable', reason: 'codex_probe_disabled' },
        reason: 'codex_probe_disabled',
      }),
    ]);
    assert.equal(text, 'TG: Claude 84% 5h · Codex off');
  });

  // A retained weekly value keeps the last-known cue: promotion must not launder
  // a degraded value into a live-looking one.
  test('Retained weekly-only Codex value keeps the last-known cue', () => {
    const text = formatCockpitStatusBarText([
      claudeCard(),
      weeklyOnlyCodexCard({
        weekly: {
          usedPct: 42,
          leftPct: 58,
          centerLabel: '42%',
          state: 'degraded',
          reason: 'codex_probe_stale',
        },
        freshness: 'degraded',
      }),
    ]);
    assert.equal(text, 'TG: Claude 84% 5h · Codex 42% weekly (last known)');
  });

  // The tooltip read `session` directly as well, so a working weekly-only card
  // was described as unavailable.
  test('Weekly-only primary card tooltip reports its window, not unavailable', () => {
    const tip = buildCockpitStatusTooltip([weeklyOnlyCodexCard()]);
    assert.ok(/Weekly: 42% used/.test(tip), `weekly window must be reported, got: ${tip}`);
    assert.ok(!/currently unavailable/i.test(tip), 'never described as unavailable');
    assert.ok(!/available yet/i.test(tip), 'never described as having no window');
  });

  // The bar and the card must agree on WHICH window is primary. The card's rule
  // lives in AgentCard's primaryDisplayLimit; both derive from the same
  // session-then-weekly promotion, so pin the agreement here.
  test('Bar and card agree on the promoted primary window', async () => {
    const { primaryLimitWindow } = await import('../../../src/cockpit/GaugeCardViewModel.js');
    assert.equal(primaryLimitWindow(weeklyOnlyCodexCard())?.kind, 'weekly');
    assert.equal(primaryLimitWindow(claudeCard())?.kind, 'session');
    assert.equal(primaryLimitWindow(codexCard()), undefined);
  });

  // Promotion is Codex-only (canPromoteWeekly). A Claude card whose 5h window is
  // unavailable must NOT promote its weekly value — the card shows no meters in
  // that state, so the bar must not invent one.
  test('Claude never promotes weekly over an unavailable 5h window', async () => {
    const { primaryLimitWindow } = await import('../../../src/cockpit/GaugeCardViewModel.js');
    const claudeNoSession = claudeCard({
      session: {
        centerLabel: '—',
        state: 'unavailable',
        reason: 'statusline_snapshot_not_configured',
      },
      freshness: 'unavailable',
    });
    assert.equal(primaryLimitWindow(claudeNoSession), undefined);
    assert.equal(formatCockpitStatusBarText([claudeNoSession]), 'TG: Claude —');
  });

  // Promotion is refused for a BLOCKER absence even on Codex: a card that shows
  // no meters must not gain a value in the bar.
  test('Codex blocker absence does not promote a retained weekly value', async () => {
    const { primaryLimitWindow } = await import('../../../src/cockpit/GaugeCardViewModel.js');
    const blocked = weeklyOnlyCodexCard({
      session: { centerLabel: '—', state: 'unavailable', reason: 'codex_cli_not_found' },
      reason: 'codex_cli_not_found',
      freshness: 'unavailable',
    });
    assert.equal(primaryLimitWindow(blocked), undefined);
    assert.equal(
      formatCockpitStatusBarText([claudeCard(), blocked]),
      'TG: Claude 84% 5h · Codex n/a',
    );
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

  // The hover is the only surface with room for the numbers. It used to carry
  // none: no window percentages, no reset times, and nothing at all about the
  // second agent even though the bar text named it.
  test('Tooltip reports each window with its used% and reset time', () => {
    const tip = buildCockpitStatusTooltip([claudeCard()]);
    assert.ok(/5-hour: 84% used, resets 17:30/.test(tip), `5h line missing, got: ${tip}`);
    assert.ok(/Weekly: 40% used/.test(tip), `weekly line missing, got: ${tip}`);
  });

  test('Tooltip covers every visible card, not only the primary one', () => {
    const tip = buildCockpitStatusTooltip([claudeCard(), weeklyOnlyCodexCard()]);
    assert.ok(/Claude Code/.test(tip), 'primary agent present');
    assert.ok(/5-hour: 84% used/.test(tip), 'primary agent window present');
    assert.ok(/^Codex$/m.test(tip), 'secondary agent gets its own block');
    assert.ok(/Weekly: 42% used/.test(tip), 'secondary agent window present');
  });

  // The case that prompted this: a window at 100% is exactly when the reset time
  // matters most, so it must be on the hover.
  test('An exhausted window still reports when it resets', () => {
    const tip = buildCockpitStatusTooltip([
      weeklyOnlyCodexCard({
        weekly: {
          usedPct: 100,
          leftPct: 0,
          centerLabel: '100%',
          subLabel: '0% left · resets Mon Aug 25, 02:00',
          state: 'fresh',
        },
        risk: 'critical',
      }),
    ]);
    assert.ok(/Weekly: 100% used, resets Mon Aug 25, 02:00/.test(tip), `got: ${tip}`);
  });

  // An unreported window must produce NO line rather than a fabricated 0%.
  test('Tooltip omits unreported windows instead of showing a zero', () => {
    const tip = buildCockpitStatusTooltip([weeklyOnlyCodexCard()]);
    assert.ok(!/5-hour/.test(tip), 'an unreported 5h window gets no line');
    assert.ok(!/0% used/.test(tip), 'never a fabricated zero for a missing window');
  });

  // A card with no window at all says so plainly, with no number.
  test('Tooltip states a valueless card plainly, with no number', () => {
    const tip = buildCockpitStatusTooltip([codexCard()]);
    assert.ok(/Codex/.test(tip), 'the card is still named');
    assert.ok(/available yet|currently unavailable/i.test(tip), 'plain absence line');
    assert.ok(!/% used/.test(tip), 'no percentage for a valueless card');
  });

  // Per-window last-known marking replaces the old card-wide state line.
  test('Tooltip marks a retained window value in place', () => {
    const tip = buildCockpitStatusTooltip([
      claudeCard({
        session: {
          usedPct: 84,
          leftPct: 16,
          centerLabel: '84%',
          subLabel: '16% left · resets 17:30',
          state: 'degraded',
          reason: 'snapshot_writer_collision',
        },
        freshness: 'degraded',
      }),
    ]);
    assert.ok(/5-hour: 84% used, resets 17:30 \(last known\)/.test(tip), `got: ${tip}`);
  });

  // Cost and context are the technical details the cards hide by default; the
  // hover must not contradict that default by surfacing them anyway.
  test('Tooltip omits cost and context, matching the default card', () => {
    const tip = buildCockpitStatusTooltip([
      claudeCard({
        costLabel: '$1.23',
        context: { usedPct: 45, centerLabel: '45%', state: 'fresh' },
      }),
    ]);
    assert.ok(!/\$1\.23/.test(tip), 'no cost on the hover');
    assert.ok(!/Context/i.test(tip), 'no context meter on the hover');
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

// The weekly-only Codex path end-to-end through the REAL card builder: a probe
// result carrying only a weekly window must reach the status bar as a value, not
// as "Codex off". This is the shape that made an enabled, working probe read as
// disabled — the builder promoted weekly, the bar did not follow.
suite('StatusBar with a weekly-only Codex account', () => {
  test('A weekly-only probe result renders its value, never "Codex off"', async () => {
    const { buildGaugeCardViewModels } = await import('../../../src/cockpit/GaugeCardViewModel.js');
    const now = () => new Date('2026-07-04T12:00:00.000Z');
    const cards = buildGaugeCardViewModels({
      candidates: [
        {
          sourceTier: 'codex_status_snapshot',
          producedAtMs: now().getTime(),
          scope: { provider: 'openai', agent: 'codex' },
          confidence: 'high',
          // No `session` at all — the account exposes only the weekly window.
          weekly: { usedPct: 42, leftPct: 58, resetsAt: '2026-07-08T00:00:00.000Z' },
        },
      ],
      configuredAgents: ['codex'],
      now,
    });

    const text = formatCockpitStatusBarText(cards);
    assert.ok(!/Codex off/.test(text), `weekly-only Codex must not read as off, got: ${text}`);
    assert.ok(/42%/.test(text), `weekly value must reach the bar, got: ${text}`);
    assert.ok(/weekly/.test(text), `the weekly window must be named, got: ${text}`);
    assert.ok(!/42% 5h/.test(text), `weekly value must not be labelled 5h, got: ${text}`);

    const tip = buildCockpitStatusTooltip(cards);
    assert.ok(!/currently unavailable/i.test(tip), 'a promoted weekly value is not unavailable');
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
