// The sanitized GaugeCardViewModel composition layer.
//
// These tests pin the trust chokepoint between the extension host and the
// webview: per-agent resolve() composition, honest gauge math, freshness
// mapping, per-card trust context, the
// honesty invariant (every visible metric carries an accuracyLabel), and the
// privacy defaults (no planType, redact backstop on every display string).

// Pin the host timezone so the date-aware reset-label
// assertions below are deterministic regardless of the CI machine's local zone.
// Local Intl formatting (timeZone: undefined) honors process.env.TZ in Node.
process.env.TZ = 'UTC';

import * as assert from 'node:assert/strict';
import {
  ABSENT_GRACE_MS,
  createClaudeSnapshotStabilityGate,
} from '../../../src/cockpit/ClaudeSnapshotStabilityGate';
import { createCockpitStabilizationPass } from '../../../src/cockpit/CockpitStabilizationPass';
import {
  buildGaugeCardViewModels,
  type GaugeCardViewModel,
} from '../../../src/cockpit/GaugeCardViewModel';
import {
  codexProbeVisibleForCockpit,
  filterGaugeCardsByVisibility,
  resolveProviderCardVisibility,
  visibleAgentsForCardVisibility,
} from '../../../src/cockpit/providerCardVisibility';
import type { SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const now = () => NOW;

function claudeCandidate(over: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: NOW.getTime(),
    scope: { provider: 'anthropic', agent: 'claude-code', model: 'claude-opus-4' },
    confidence: 'high',
    session: { usedPct: 84 },
    weekly: { usedPct: 40 },
    context: { usedPct: 30 },
    model: 'claude-opus-4',
    ...over,
  };
}

// A working Codex native-status candidate (codex_status_snapshot): the
// app-server JSON-RPC probe carries 5h/weekly rate limits but NO context-window
// fields — context is intentionally absent (no safe native source).
function codexCandidate(over: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    sourceTier: 'codex_status_snapshot',
    producedAtMs: NOW.getTime(),
    scope: { provider: 'openai', agent: 'codex' },
    confidence: 'high',
    session: { usedPct: 12 },
    weekly: { usedPct: 5 },
    // No context — the probe does not expose it.
    ...over,
  };
}

function cardFor(cards: readonly GaugeCardViewModel[], agent: string): GaugeCardViewModel {
  const card = cards.find((c) => c.agent === agent);
  assert.ok(card, `expected a card for agent ${agent}`);
  return card;
}

suite('GaugeCardViewModel snapshot_writer_collision rendering', () => {
  test('A collision candidate keeps its value but surfaces the degraded reason (never blank)', () => {
    // The stability gate emits the held last-known candidate (value intact) with
    // unavailableReason: 'snapshot_writer_collision'. The card must show the
    // retained value AND the degraded reason — never go blank, never flap.
    const collided = claudeCandidate({
      session: { usedPct: 88 },
      unavailableReason: 'snapshot_writer_collision',
    });
    const cards = buildGaugeCardViewModels({
      candidates: [collided],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    // Value retained — the gauge is NOT blanked to '—'.
    assert.equal(claude.session.usedPct, 88);
    assert.equal(claude.session.centerLabel, '88%');
    // The collision reason surfaces at the card level and on the primary gauge.
    assert.equal(claude.reason, 'snapshot_writer_collision');
    assert.equal(claude.session.reason, 'snapshot_writer_collision');
    // Degraded freshness — not 'fresh'.
    assert.notEqual(claude.freshness, 'fresh');
  });
});

suite('GaugeCardViewModel missing Claude rate-limit fields', () => {
  test('A read snapshot without rate_limits stays unavailable with a precise reason, not configuration copy', () => {
    const noLimits = claudeCandidate({
      session: undefined,
      weekly: undefined,
      context: { usedPct: 11 },
      cost: 0.42,
      unavailableReason: 'statusline_snapshot_missing_rate_limits',
    });
    const cards = buildGaugeCardViewModels({
      candidates: [noLimits],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.usedPct, undefined);
    assert.equal(claude.session.reason, 'statusline_snapshot_missing_rate_limits');
    assert.equal(claude.reason, 'statusline_snapshot_missing_rate_limits');
    assert.equal(claude.model, 'claude-opus-4');
    assert.equal(claude.costLabel, '$0.42');
    assert.equal(claude.context.usedPct, 11);
  });
});

suite('GaugeCardViewModel context muted under collision', () => {
  // Context usage is SESSION-LOCAL: each Claude session has its own context
  // window, so conservative-max is meaningless and last-write-wins flaps. Under
  // snapshot_writer_collision the context gauge must be MUTED (no value, '—',
  // context_session_specific_collision) — NOT the alternating session value.
  // The 5h/weekly gauges stay conservative-stable with snapshot_writer_collision.
  test('(a) under collision the context gauge has no value and carries context_session_specific_collision', () => {
    const collided = claudeCandidate({
      session: { usedPct: 88 },
      context: { usedPct: 30 },
      unavailableReason: 'snapshot_writer_collision',
    });
    const cards = buildGaugeCardViewModels({
      candidates: [collided],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    // Context muted — no numeric value, honest '—', session-specific reason.
    assert.equal(claude.context.usedPct, undefined);
    assert.equal(claude.context.centerLabel, '—');
    assert.equal(claude.context.state, 'unavailable');
    assert.equal(claude.context.reason, 'context_session_specific_collision');
    // Never the alternating session value.
    assert.notEqual(claude.context.usedPct, 30);
  });

  test('(b) under collision 5h + weekly stay conservative-stable with snapshot_writer_collision (regression guard)', () => {
    const collided = claudeCandidate({
      session: { usedPct: 88 },
      weekly: { usedPct: 40 },
      context: { usedPct: 30 },
      unavailableReason: 'snapshot_writer_collision',
    });
    const cards = buildGaugeCardViewModels({
      candidates: [collided],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    // 5h retains its value + collision reason (unchanged by the context mute).
    assert.equal(claude.session.usedPct, 88);
    assert.equal(claude.session.reason, 'snapshot_writer_collision');
    assert.equal(claude.session.state, 'degraded');
    // Weekly retains its value (degraded-with-retained-value collision overlay).
    assert.equal(claude.weekly.usedPct, 40);
    // Card-level reason stays the 5h/weekly collision story.
    assert.equal(claude.reason, 'snapshot_writer_collision');
  });

  test('(c) NON-collision single session renders the real context value (no off-collision change)', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ context: { usedPct: 30 } })],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.context.usedPct, 30);
    assert.equal(claude.context.centerLabel, '30%');
    assert.notEqual(claude.context.reason, 'context_session_specific_collision');
  });
});

suite('GaugeCardViewModel reset-expiry rendering', () => {
  // End-to-end: a candidate whose 5h window has reset (resetsAt in the past) is run
  // through the stabilization pass then the builder. The 5h gauge must render
  // PENDING — '—', unavailable, native_window_reset_pending — NOT the stale used%,
  // NOT 'fresh', and the card risk must be 'unavailable' (no value drives risk).
  test('An expired 5h window renders pending (not stale used%, not fresh, no risk)', () => {
    const past = new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const expired = claudeCandidate({
      session: { usedPct: 96, leftPct: 4, resetsAt: past },
      weekly: { usedPct: 40, leftPct: 60 },
    });
    const pass = createCockpitStabilizationPass({ now });
    const stabilized = pass.step([expired]);
    const cards = buildGaugeCardViewModels({
      candidates: [...stabilized],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.usedPct, undefined, '5h value dropped');
    assert.equal(claude.session.centerLabel, '—');
    assert.equal(claude.session.state, 'unavailable');
    assert.equal(claude.session.reason, 'native_window_reset_pending');
    assert.notEqual(claude.freshness, 'fresh');
    // A near-100 pre-reset value must NOT survive to drive critical risk.
    assert.equal(claude.risk, 'unavailable');
  });
});

// Claude cost is SESSION-SPECIFIC — under
// snapshot_writer_collision two sessions' costs ($26.60 ↔ $23.53) would flap
// last-writer-wins. The cost must be MUTED under collision (no costLabel) and the
// card must surface cost_session_specific_collision — mirror of the muted context
// gauge. Off-collision cost renders normally (no behavior change).
suite('GaugeCardViewModel cost muted under collision', () => {
  // (a) under collision → no costLabel; the card carries the session-specific
  //     reason; the card is never blank (5h/weekly stay conservative-stable).
  test('(a) under collision the cost is muted with cost_session_specific_collision', () => {
    const collided = claudeCandidate({
      session: { usedPct: 88 },
      cost: 26.6,
      unavailableReason: 'snapshot_writer_collision',
    });
    const cards = buildGaugeCardViewModels({
      candidates: [collided],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    // The cost label is dropped (no flapping dollar figure).
    assert.equal(claude.costLabel, undefined);
    // The session-specific cost reason is surfaced on the card.
    assert.equal(claude.costReason, 'cost_session_specific_collision');
    // The 5h gauge still retains its value (card never blank).
    assert.equal(claude.session.usedPct, 88);
  });

  // (b) off-collision → cost renders as before (regression guard).
  test('(b) off-collision cost renders normally', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ cost: 12.34 })],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.ok(claude.costLabel, 'off-collision cost must render');
    assert.match(claude.costLabel ?? '', /\$12\.34/);
    assert.equal(claude.costReason, undefined);
  });

  // (c) across a two-writer sequence the cost does not alternate — it stays muted
  //     (the per-refresh card cost is always absent under collision).
  test('(c) cost does not alternate under a two-writer collision sequence', () => {
    const costs = [26.6, 23.53, 26.6, 23.53];
    const labels = costs.map((cost) => {
      const collided = claudeCandidate({
        session: { usedPct: 88 },
        cost,
        unavailableReason: 'snapshot_writer_collision',
      });
      const cards = buildGaugeCardViewModels({
        candidates: [collided],
        configuredAgents: ['claude-code'],
        now,
      });
      return cardFor(cards, 'claude-code').costLabel;
    });
    // Every refresh muted the cost — no alternation between the two session costs.
    assert.deepEqual(new Set(labels), new Set([undefined]));
  });
});

suite('GaugeCardViewModel after-valid degraded reasons', () => {
  // The stability gate injects the held last-known Claude candidate (value
  // intact) marked with one of the after-valid degraded reasons when the
  // current refresh has no valid native value. The card MUST keep the value
  // and surface the reason — never blank, never `no_source`/not-configured.
  for (const reason of [
    'native_temporarily_unavailable',
    'snapshot_incomplete_after_valid',
  ] as const) {
    test(`a held value + ${reason} renders a degraded card that keeps usedPct`, () => {
      const held = claudeCandidate({
        session: { usedPct: 88 },
        unavailableReason: reason,
      });
      const cards = buildGaugeCardViewModels({
        candidates: [held],
        configuredAgents: ['claude-code'],
        now,
      });
      const claude = cardFor(cards, 'claude-code');
      // Value retained — never blanked to '—', never not-configured.
      assert.equal(claude.session.usedPct, 88);
      assert.equal(claude.session.centerLabel, '88%');
      assert.notEqual(claude.reason, 'no_source');
      // The after-valid reason surfaces at card + primary gauge.
      assert.equal(claude.reason, reason);
      assert.equal(claude.session.reason, reason);
      // Degraded freshness, never 'fresh', never 'unavailable'.
      assert.equal(claude.session.state, 'degraded');
      assert.equal(claude.freshness, 'degraded');
    });
  }
});

suite('Gate → builder pipeline: degraded-after-valid vs not-configured', () => {
  const STATUSLINE_NOT_CONFIGURED: SourceCandidate = {
    sourceTier: 'unknown',
    producedAtMs: NOW.getTime(),
    scope: { provider: 'anthropic', agent: 'claude-code' },
    unavailableReason: 'statusline_snapshot_not_configured',
  };

  function gateNow() {
    let t = NOW.getTime();
    return {
      now: () => new Date(t),
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  // After a valid snapshot then an absence/blocker persisting BEYOND the
  // transient-absence grace, the FULL pipeline (gate then builder) must show the
  // held value with a degraded after-valid reason — NOT the not-configured card.
  // (Within the grace the held value stays fresh — covered in the gate's own
  // transient-absence suite.)
  test('Valid then absent → card keeps value, reason native_temporarily_unavailable (not no_source)', () => {
    const clock = gateNow();
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    gate.step([claudeCandidate({ session: { usedPct: 88 } })]);
    clock.advance(ABSENT_GRACE_MS + 1000);
    // The gatherer emits the not-configured blocker (path momentarily missing).
    const stepped = gate.step([STATUSLINE_NOT_CONFIGURED]);

    const cards = buildGaugeCardViewModels({
      candidates: stepped,
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.usedPct, 88);
    assert.equal(claude.reason, 'native_temporarily_unavailable');
    assert.notEqual(claude.reason, 'no_source');
    assert.notEqual(claude.reason, 'statusline_snapshot_not_configured');
    assert.equal(claude.freshness, 'degraded');
  });

  // A FRESH gate (simulating the loop rebuild after the user clears
  // statuslineSnapshotPath) with NO prior valid value yields the honest
  // not-configured card — deliberate disable reads as not-configured, NOT held.
  test('Fresh gate (config cleared) with no prior value → honest not-configured card', () => {
    const clock = gateNow();
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });

    const stepped = gate.step([STATUSLINE_NOT_CONFIGURED]);
    const cards = buildGaugeCardViewModels({
      candidates: stepped,
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.usedPct, undefined);
    assert.equal(claude.session.state, 'unavailable');
    assert.equal(claude.reason, 'statusline_snapshot_not_configured');
    assert.notEqual(claude.reason, 'native_temporarily_unavailable');
  });
});

suite('GaugeCardViewModel composition', () => {
  test('Builds one VM per configured agent in stable order', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate()],
      configuredAgents: ['claude-code', 'codex'],
      now,
    });
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards.map((c) => c.agent),
      ['claude-code', 'codex'],
    );
  });

  test('Codex configured with zero codex candidates still produces a card', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate()],
      configuredAgents: ['claude-code', 'codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    assert.equal(codex.freshness, 'unavailable');
    assert.equal(codex.session.state, 'unavailable');
    assert.ok(codex.reason, 'codex card must carry a closed-set reason');
    assert.equal(codex.colorKey, 'codex');
  });

  test('Session gauge math: usedPct 84 → leftPct 16, centerLabel 84%', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate()],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.usedPct, 84);
    assert.equal(claude.session.leftPct, 16);
    assert.equal(claude.session.centerLabel, '84%');
  });

  test('Clamp: usedPct over 100 clamps and never renders empty', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ session: { usedPct: 137 } })],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.usedPct, 100);
    assert.equal(claude.session.leftPct, 0);
    assert.equal(claude.session.centerLabel, '100%');
  });

  test('Unavailable session → centerLabel — and state unavailable (never 0%)', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ session: undefined })],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.state, 'unavailable');
    assert.equal(claude.session.centerLabel, '—');
    assert.equal(claude.session.usedPct, undefined);
  });

  test('Context gauge falls back to usedTokens/windowSizeTokens when usedPct absent', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          context: { usedTokens: 50_000, windowSizeTokens: 200_000 },
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.context.usedPct, 25);
    assert.equal(claude.context.centerLabel, '25%');
  });

  test('Context gauge unavailable when neither usedPct nor tokens available', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ context: { inputTokens: 1 } })],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.context.state, 'unavailable');
    assert.equal(claude.context.centerLabel, '—');
  });

  test('Stale native session → card freshness stale/degraded; risk not fabricated', () => {
    // produced 10 minutes ago — past the 5-minute limit freshness threshold.
    const stale = NOW.getTime() - 10 * 60 * 1000;
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ producedAtMs: stale })],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.ok(
      claude.freshness === 'stale' || claude.freshness === 'degraded',
      `expected stale/degraded freshness, got ${claude.freshness}`,
    );
    assert.equal(claude.session.reason, 'native_status_stale');
    // usedPct 84 → warning, still derived honestly from the shown value.
    assert.equal(claude.risk, 'warning');
  });

  test('Unavailable session → risk rendered as unavailable, never ok', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ session: undefined })],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.risk, 'unavailable');
  });

  test('VM carries trust context: sourceTier, freshness, reason', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate()],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.sourceTier, 'statusline_snapshot');
    assert.ok(typeof claude.freshness === 'string');
  });

  test('Honesty invariant (HIGH-1): every visible metric carries an accuracyLabel', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate()],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    // card-level
    assert.ok(claude.accuracyLabel, 'card must carry an accuracyLabel');
    assert.equal(claude.accuracyLabel, 'proxy_reported');
    // per-gauge, for every gauge with a visible value
    for (const gauge of [claude.session, claude.weekly, claude.context]) {
      if (gauge.usedPct !== undefined) {
        assert.ok(gauge.accuracyLabel, 'a visible gauge value must carry an accuracyLabel');
      }
    }
  });

  test('PlanType never appears on the VM (privacy default)', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ planType: 'max-20x' })],
      configuredAgents: ['claude-code'],
      now,
    });
    const serialized = JSON.stringify(cards);
    assert.ok(!serialized.includes('planType'));
    assert.ok(!serialized.includes('max-20x'));
  });

  test('Every formatted display string passes through redactString', () => {
    const leaky = `model-${'sk' + '-'}abcdefghijklmnopqrstuvwxyz0123`;
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ model: leaky })],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.ok(claude.model);
    assert.ok(
      claude.model.includes('[redacted:'),
      `expected redacted model string, got ${claude.model}`,
    );
  });
});

suite('Provider card visibility filtering', () => {
  test('Missing and non-boolean visibility values default to visible', () => {
    assert.deepEqual(resolveProviderCardVisibility(), { claude: true, codex: true });
    assert.deepEqual(
      resolveProviderCardVisibility({ claude: 'hidden', codex: null }),
      { claude: true, codex: true },
      'malformed settings fall back to visible rather than hiding a provider',
    );
  });

  test('VisibleAgentsForCardVisibility returns the visible provider list in cockpit order', () => {
    assert.deepEqual(visibleAgentsForCardVisibility({ claude: true, codex: true }), [
      'claude-code',
      'codex',
    ]);
    assert.deepEqual(visibleAgentsForCardVisibility({ claude: false, codex: true }), ['codex']);
    assert.deepEqual(visibleAgentsForCardVisibility({ claude: true, codex: false }), [
      'claude-code',
    ]);
    assert.deepEqual(visibleAgentsForCardVisibility({ claude: false, codex: false }), []);
  });

  test('Hiding Codex suppresses cockpit probe work without enabling the probe', () => {
    assert.equal(
      codexProbeVisibleForCockpit(false, { claude: true, codex: true }),
      false,
      'default off remains off',
    );
    assert.equal(
      codexProbeVisibleForCockpit(true, { claude: true, codex: false }),
      false,
      'hidden Codex is not probed for cockpit rendering even when the opt-in is on',
    );
    assert.equal(
      codexProbeVisibleForCockpit(true, { claude: true, codex: true }),
      true,
      'the explicit opt-in still governs visible Codex',
    );
  });

  test('FilterGaugeCardsByVisibility omits hidden providers without mutating cards', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate(), codexCandidate()],
      configuredAgents: ['claude-code', 'codex'],
      now,
    });

    assert.deepEqual(
      filterGaugeCardsByVisibility(cards, { claude: false, codex: true }).map((card) => card.agent),
      ['codex'],
    );
    assert.deepEqual(
      filterGaugeCardsByVisibility(cards, { claude: true, codex: false }).map((card) => card.agent),
      ['claude-code'],
    );
    assert.deepEqual(
      filterGaugeCardsByVisibility(cards, { claude: false, codex: false }).map(
        (card) => card.agent,
      ),
      [],
    );
    assert.deepEqual(
      cards.map((card) => card.agent),
      ['claude-code', 'codex'],
      'filtering must not mutate the original VM set',
    );
  });
});

suite('GaugeCardViewModel codex context unavailable', () => {
  // The tested codex app-server JSON-RPC response carries account rate-limit
  // windows, not context-window fields. Context exists only in the interactive
  // statusLine, which is DO-NOT-SCRAPE. So when the Codex card has a WORKING
  // codex_status_snapshot limit source but no context, the context gauge must
  // surface the PRECISE codex_context_unavailable reason — NOT the generic
  // no_source ("No data source configured"), which is misleading because the
  // native source IS configured and working for limits.
  test('(a) working codex limit source + no context → context gauge codex_context_unavailable, NOT no_source', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [codexCandidate()],
      configuredAgents: ['codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    // 5h/weekly native limits render — untouched by this fix.
    assert.equal(codex.session.usedPct, 12);
    assert.equal(codex.weekly.usedPct, 5);
    // Context gauge: honest '—', precise reason, never no_source.
    assert.equal(codex.context.usedPct, undefined);
    assert.equal(codex.context.centerLabel, '—');
    assert.equal(codex.context.state, 'unavailable');
    assert.equal(codex.context.reason, 'codex_context_unavailable');
    assert.notEqual(codex.context.reason, 'no_source');
  });

  test('(a2) only weekly value present (no session) still surfaces codex_context_unavailable', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [codexCandidate({ session: undefined, weekly: { usedPct: 7 } })],
      configuredAgents: ['codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    assert.equal(codex.session.usedPct, undefined, 'no fabricated 5h window');
    assert.equal(codex.weekly.usedPct, 7);
    assert.equal(codex.weekly.leftPct, 93);
    assert.equal(codex.freshness, 'fresh');
    assert.equal(codex.reason, undefined);
    assert.equal(codex.risk, 'ok');
    assert.equal(codex.sourceTier, 'codex_status_snapshot');
    assert.equal(codex.context.reason, 'codex_context_unavailable');
    assert.notEqual(codex.context.reason, 'no_source');
  });

  test('(a3) only 5h value present remains a successful Codex card with no weekly fabrication', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [codexCandidate({ weekly: undefined, session: { usedPct: 12 } })],
      configuredAgents: ['codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    assert.equal(codex.session.usedPct, 12);
    assert.equal(codex.session.leftPct, 88);
    assert.equal(codex.weekly.usedPct, undefined, 'no fabricated weekly window');
    assert.equal(codex.freshness, 'fresh');
    assert.equal(codex.reason, undefined);
    assert.equal(codex.context.reason, 'codex_context_unavailable');
  });

  test('(b) truly not-configured / zero-candidate Codex card keeps the not-configured reason (no false codex_context_unavailable)', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate()],
      configuredAgents: ['claude-code', 'codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    // No working codex limit source → context must NOT claim codex_context_unavailable.
    assert.notEqual(codex.context.reason, 'codex_context_unavailable');
    assert.equal(codex.session.state, 'unavailable');
    assert.equal(codex.context.state, 'unavailable');
  });

  test('(b2) probe-disabled blocker on Codex keeps its blocker reason on context (no false codex_context_unavailable)', () => {
    const disabled = codexCandidate({
      session: undefined,
      weekly: undefined,
      unavailableReason: 'codex_probe_disabled',
    });
    const cards = buildGaugeCardViewModels({
      candidates: [disabled],
      configuredAgents: ['codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    // No working limit value → the probe-disabled blocker governs, not context-unavailable.
    assert.notEqual(codex.context.reason, 'codex_context_unavailable');
    assert.equal(codex.context.reason, 'codex_probe_disabled');
  });

  test('(b3) codex WITH a real context value renders it — codex_context_unavailable never masks a present value', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [codexCandidate({ context: { usedPct: 18 } })],
      configuredAgents: ['codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    assert.equal(codex.context.usedPct, 18);
    assert.equal(codex.context.centerLabel, '18%');
    assert.notEqual(codex.context.reason, 'codex_context_unavailable');
  });

  test('(c) Claude context behaviour unchanged: real value renders; codex_context_unavailable never leaks to Claude', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate({ context: { usedPct: 30 } }), codexCandidate()],
      configuredAgents: ['claude-code', 'codex'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.context.usedPct, 30);
    assert.notEqual(claude.context.reason, 'codex_context_unavailable');
    // Claude context muted under collision keeps its own session-specific reason.
    const collided = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          context: { usedPct: 30 },
          unavailableReason: 'snapshot_writer_collision',
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claudeCollided = cardFor(collided, 'claude-code');
    assert.equal(claudeCollided.context.reason, 'context_session_specific_collision');
    assert.notEqual(claudeCollided.context.reason, 'codex_context_unavailable');
  });
});

// A bare reset TIME is ambiguous when the reset is days
// away (Claude weekly: "resets Jun 22") or crosses local midnight (5h window). The
// SINGLE shared resetSubLabel formatter must add the weekday+date once the reset is
// a DIFFERENT local calendar day from `now`, and stay time-only on the same day —
// uniformly for session(5h) + weekly, Claude + Codex. Display formatting only: no
// change to values, window choice, usedPct, accuracy, freshness, or reason-ids.
// Determinism: NOW is fixed (2026-06-12T12:00:00Z) and the file pins TZ=UTC.
suite('GaugeCardViewModel date-aware reset labels', () => {
  test('(a) same local day → time-only label (unchanged)', () => {
    // Reset later TODAY (15:00 UTC vs now 12:00 UTC) → no date, time only.
    const cards = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          session: { usedPct: 84, resetsAt: '2026-06-12T15:00:00.000Z' },
          weekly: { usedPct: 40, resetsAt: '2026-06-12T15:00:00.000Z' },
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    // The 5h (session) line also carries a "· in Xh Ym" countdown (3h out).
    assert.equal(claude.session.subLabel, '16% left · resets 03:00 PM · in 3h 0m');
    // The weekly line keeps its reset time only — no countdown.
    assert.equal(claude.weekly.subLabel, '60% left · resets 03:00 PM');
    // No date token leaked into a same-day label.
    assert.ok(!/Jun|Fri|Sat|Mon/.test(claude.session.subLabel ?? ''));
  });

  test('(b) weekly reset N days away → includes weekday + date (Claude)', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          weekly: { usedPct: 40, resetsAt: '2026-06-22T02:00:00.000Z' },
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.weekly.subLabel, '60% left · resets Mon, Jun 22, 02:00 AM');
  });

  test('(c) reset tomorrow → includes date even one day out', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          weekly: { usedPct: 10, resetsAt: '2026-06-13T09:00:00.000Z' },
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.weekly.subLabel, '90% left · resets Sat, Jun 13, 09:00 AM');
  });

  test('(d) 5h session reset crossing local midnight → includes date', () => {
    // 5h window whose reset lands at 01:00 the NEXT local day must show the date.
    const cards = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          session: { usedPct: 70, resetsAt: '2026-06-13T01:00:00.000Z' },
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.subLabel, '30% left · resets Sat, Jun 13, 01:00 AM · in 13h 0m');
  });

  test('(e) the SAME shared formatter applies to Codex (date when not today)', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [
        codexCandidate({
          session: { usedPct: 12, resetsAt: '2026-06-12T18:00:00.000Z' },
          weekly: { usedPct: 5, resetsAt: '2026-06-22T02:00:00.000Z' },
        }),
      ],
      configuredAgents: ['codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    // Same-day 5h → time-only + countdown; weekly days away → weekday+date, no countdown.
    assert.equal(codex.session.subLabel, '88% left · resets 06:00 PM · in 6h 0m');
    assert.equal(codex.weekly.subLabel, '95% left · resets Mon, Jun 22, 02:00 AM');
  });

  test('(f) unparseable / absent resetsAt → "…% left" only (unchanged)', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          session: { usedPct: 84, resetsAt: 'not-a-date' },
          weekly: { usedPct: 40 }, // no resetsAt at all
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.subLabel, '16% left');
    assert.equal(claude.weekly.subLabel, '60% left');
  });

  test('(g) display-only: usedPct / accuracy / freshness / reason unchanged by the label', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          session: { usedPct: 84, resetsAt: '2026-06-22T02:00:00.000Z' },
          weekly: { usedPct: 40, resetsAt: '2026-06-22T02:00:00.000Z' },
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    // Values + freshness untouched; only the subLabel string carries the date.
    assert.equal(claude.session.usedPct, 84);
    assert.equal(claude.weekly.usedPct, 40);
    assert.equal(claude.session.centerLabel, '84%');
    assert.equal(claude.freshness, 'fresh');
    assert.equal(claude.session.reason, undefined);
    assert.ok((claude.weekly.subLabel ?? '').includes('Mon, Jun 22'));
  });

  // The 5h line carries a "· in Xh Ym" countdown (how long until the window
  // resets); the weekly line never does (its exact reset time is the signal).
  test('(h) 5h line gets a countdown; weekly line does not', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [
        claudeCandidate({
          // 1h42m from now (12:00 → 13:42) — matches the design's "in 1h 42m".
          session: { usedPct: 60, resetsAt: '2026-06-12T13:42:00.000Z' },
          weekly: { usedPct: 30, resetsAt: '2026-06-15T12:00:00.000Z' },
        }),
      ],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.subLabel, '40% left · resets 01:42 PM · in 1h 42m');
    // Weekly: date label, NO countdown appended.
    assert.ok((claude.weekly.subLabel ?? '').includes('resets '));
    assert.ok(!/· in \d/.test(claude.weekly.subLabel ?? ''), 'weekly has no countdown');
  });
});

// The model is SESSION-SPECIFIC — under snapshot_writer_collision two
// sessions' models (e.g. fable ↔ opus) alternate last-writer-wins in the card
// header and status-bar tooltip. The VM mutes it (mirror of the context/cost
// mutes); the webview renders a stable multi-session line in its place.
suite('GaugeCardViewModel model muted under collision', () => {
  test('Under collision the VM carries NO model (never an alternating model id)', () => {
    const collided = claudeCandidate({
      session: { usedPct: 88 },
      unavailableReason: 'snapshot_writer_collision',
    });
    const cards = buildGaugeCardViewModels({
      candidates: [collided],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.model, undefined);
    // The conservative 5h value is retained (unchanged by the model mute).
    assert.equal(claude.session.usedPct, 88);
    assert.equal(claude.reason, 'snapshot_writer_collision');
  });

  test('Off-collision a single session renders the real model (no change)', () => {
    const cards = buildGaugeCardViewModels({
      candidates: [claudeCandidate()],
      configuredAgents: ['claude-code'],
      now,
    });
    assert.equal(cardFor(cards, 'claude-code').model, 'claude-opus-4');
  });
});
