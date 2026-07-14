// SourcePriorityResolver tests.
//
// The resolver selects the best source PER FIELD by SourceTier order (with
// per-field cost/reset overrides), stamps source/accuracy/freshness/confidence,
// and applies the documented freshness policy (stale native → degraded, never
// silently dropped). Native-only: a limit/reset field is shown only from a
// native source — the estimator never fills a limit/reset field. Grep: "resolve".

import * as assert from 'node:assert/strict';
import {
  FRESHNESS_DETAIL_MS,
  FRESHNESS_LIMIT_MS,
  resolve,
  type SourceCandidate,
} from '../../../../src/core/cockpit/SourcePriorityResolver';

const NOW = Date.parse('2026-06-11T12:00:00.000Z');
const clock = (): Date => new Date(NOW);

function candidate(over: Partial<SourceCandidate>): SourceCandidate {
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: NOW,
    scope: { provider: 'anthropic', agent: 'claude-code' },
    ...over,
  };
}

suite('SourcePriorityResolver: per-field selection', () => {
  test('StatusLine 62% beats a codex 47% for the same field class', () => {
    const candidates: SourceCandidate[] = [
      candidate({ sourceTier: 'codex_status_snapshot', session: { usedPct: 47 } }),
      candidate({ sourceTier: 'statusline_snapshot', session: { usedPct: 62 } }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.session.usedPct.value, 62);
    assert.equal(state.session.usedPct.sourceTier, 'statusline_snapshot');
  });

  test('Weekly % and resets pick the fresher/stronger native source', () => {
    const candidates: SourceCandidate[] = [
      candidate({
        sourceTier: 'codex_status_snapshot',
        weekly: { usedPct: 30, resetsAt: '2026-06-15T00:00:00.000Z' },
      }),
      candidate({
        sourceTier: 'statusline_snapshot',
        weekly: { usedPct: 71, resetsAt: '2026-06-18T00:00:00.000Z' },
      }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.weekly.usedPct.value, 71);
    assert.equal(state.weekly.resetsAt.value, '2026-06-18T00:00:00.000Z');
    assert.equal(state.weekly.usedPct.sourceTier, 'statusline_snapshot');
  });

  test('Selection is PER FIELD: statusline session % coexists with a stats-cache cost', () => {
    const candidates: SourceCandidate[] = [
      candidate({ sourceTier: 'statusline_snapshot', session: { usedPct: 50 } }),
      candidate({ sourceTier: 'stats_cache_snapshot', cost: 1.23 }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.session.usedPct.sourceTier, 'statusline_snapshot');
    assert.equal(state.cost.value, 1.23);
    assert.equal(state.cost.sourceTier, 'stats_cache_snapshot');
  });

  test('FRESHNESS POLICY: stale native → degraded reason, shown not dropped', () => {
    const stale = candidate({
      sourceTier: 'statusline_snapshot',
      producedAtMs: NOW - FRESHNESS_LIMIT_MS - 1,
      session: { usedPct: 62 },
    });
    const state = resolve([stale], { now: clock });
    assert.equal(state.session.usedPct.available, true);
    assert.equal(state.session.usedPct.value, 62);
    assert.equal(state.session.usedPct.reason, 'native_status_stale');
    assert.equal(state.session.usedPct.confidence, 'low');
  });

  test('FRESHNESS POLICY: a non-stale higher-or-equal-tier candidate replaces a stale one', () => {
    const stale = candidate({
      sourceTier: 'statusline_snapshot',
      producedAtMs: NOW - FRESHNESS_LIMIT_MS - 1,
      session: { usedPct: 10 },
    });
    const fresh = candidate({
      sourceTier: 'statusline_snapshot',
      producedAtMs: NOW,
      session: { usedPct: 62 },
    });
    const state = resolve([stale, fresh], { now: clock });
    assert.equal(state.session.usedPct.value, 62);
    assert.equal(state.session.usedPct.reason, undefined);
  });

  test('Token-detail freshness uses the detail threshold, not the limit threshold', () => {
    assert.ok(FRESHNESS_DETAIL_MS > FRESHNESS_LIMIT_MS);
    const c = candidate({
      sourceTier: 'statusline_snapshot',
      producedAtMs: NOW - FRESHNESS_LIMIT_MS - 1,
      cost: 4.2,
    });
    const state = resolve([c], { now: clock });
    assert.equal(state.cost.value, 4.2);
    assert.equal(state.cost.reason, undefined);
  });

  test('COST PER SCOPE: a statusLine cost outranks a stats-cache cost', () => {
    const candidates: SourceCandidate[] = [
      candidate({ sourceTier: 'stats_cache_snapshot', cost: 9.99 }),
      candidate({ sourceTier: 'statusline_snapshot', cost: 1.5 }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.cost.value, 1.5);
    assert.equal(state.cost.sourceTier, 'statusline_snapshot');
  });

  test('NATIVE-ONLY: a field with no native candidate resolves unavailable (no_source)', () => {
    // No synthetic fallback — a field with no native source reads no_source.
    const candidates: SourceCandidate[] = [
      candidate({ sourceTier: 'statusline_snapshot', cost: 1.2 }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.session.usedPct.available, false);
    assert.equal(state.session.usedPct.reason, 'no_source');
  });

  test('A fresher higher-tier native source wins a limit field over a weaker-tier one', () => {
    const candidates: SourceCandidate[] = [
      candidate({ sourceTier: 'statusline_snapshot', producedAtMs: NOW, session: { usedPct: 62 } }),
      candidate({ sourceTier: 'stats_cache_snapshot', session: { usedPct: 41 } }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.session.usedPct.value, 62);
    assert.equal(state.session.usedPct.sourceTier, 'statusline_snapshot');
  });

  // A codex_status_snapshot limit field resolves
  // with the proxy_reported accuracy label — an agent-reported status surface
  // never masquerades as billing truth.
  test('Codex_status_snapshot resolves a limit field labeled proxy_reported', () => {
    const candidates: SourceCandidate[] = [
      candidate({ sourceTier: 'codex_status_snapshot', session: { usedPct: 47 } }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.session.usedPct.value, 47);
    assert.equal(state.session.usedPct.sourceTier, 'codex_status_snapshot');
    assert.equal(state.session.usedPct.accuracyLabel, 'proxy_reported');
  });

  test('A candidate context sub-object resolves into available context fields', () => {
    const candidates: SourceCandidate[] = [
      candidate({
        sourceTier: 'statusline_snapshot',
        context: { usedPct: 12, windowSizeTokens: 258000, inputTokens: 19900, outputTokens: 120 },
      }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.context.usedPct.value, 12);
    assert.equal(state.context.usedPct.available, true);
    assert.equal(state.context.usedPct.sourceTier, 'statusline_snapshot');
    assert.equal(state.context.windowSizeTokens.value, 258000);
    assert.equal(state.context.inputTokens.value, 19900);
    assert.equal(state.context.outputTokens.value, 120);
    assert.equal(state.context.usedTokens.available, false);
  });

  test('Reasoning/agentVersion/planType resolve as available scalar fields', () => {
    const candidates: SourceCandidate[] = [
      candidate({
        sourceTier: 'codex_status_snapshot',
        reasoning: 'xhigh',
        agentVersion: '0.137.0',
        planType: 'plus',
      }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.reasoning.value, 'xhigh');
    assert.equal(state.reasoning.available, true);
    assert.equal(state.agentVersion.value, '0.137.0');
    assert.equal(state.planType.value, 'plus');
  });

  test('A stale candidate degrades the new fields with native_status_stale', () => {
    const stale = candidate({
      sourceTier: 'statusline_snapshot',
      producedAtMs: NOW - FRESHNESS_LIMIT_MS - 1,
      context: { usedPct: 50 },
      reasoning: 'high',
    });
    const state = resolve([stale], { now: clock });
    assert.equal(state.context.usedPct.available, true);
    assert.equal(state.context.usedPct.reason, 'native_status_stale');
    assert.equal(state.reasoning.available, true);
    assert.equal(state.reasoning.reason, 'native_status_stale');
  });

  test('A native value is never emitted stronger than its source (proxy_reported, not billing)', () => {
    const candidates: SourceCandidate[] = [
      candidate({ sourceTier: 'stats_cache_snapshot', cost: 55 }),
    ];
    const state = resolve(candidates, { now: clock });
    assert.equal(state.cost.accuracyLabel, 'proxy_reported');
    assert.notEqual(state.cost.accuracyLabel, 'exact');
    assert.notEqual(state.cost.accuracyLabel, 'billing_authoritative');
  });

  test('Current v1 resolver emits proxy_reported for active native tiers and never partial', () => {
    const statusLine = resolve(
      [candidate({ sourceTier: 'statusline_snapshot', session: { usedPct: 62 } })],
      { now: clock },
    );
    const statsCache = resolve(
      [candidate({ sourceTier: 'stats_cache_snapshot', cost: 3.14, model: 'claude-sonnet' })],
      { now: clock },
    );
    const codex = resolve(
      [candidate({ sourceTier: 'codex_status_snapshot', session: { usedPct: 47 } })],
      { now: clock },
    );
    const stale = resolve(
      [
        candidate({
          sourceTier: 'statusline_snapshot',
          producedAtMs: NOW - FRESHNESS_LIMIT_MS - 1,
          session: { usedPct: 62 },
        }),
      ],
      { now: clock },
    );
    const unavailable = resolve([], { now: clock });

    const emitted = [
      statusLine.session.usedPct.accuracyLabel,
      statsCache.cost.accuracyLabel,
      statsCache.model.accuracyLabel,
      codex.session.usedPct.accuracyLabel,
      stale.session.usedPct.accuracyLabel,
    ];

    assert.deepEqual(emitted, [
      'proxy_reported',
      'proxy_reported',
      'proxy_reported',
      'proxy_reported',
      'proxy_reported',
    ]);
    assert.ok(!emitted.includes('partial'));
    assert.equal(stale.session.usedPct.reason, 'native_status_stale');
    assert.equal(unavailable.session.usedPct.available, false);
    assert.equal(unavailable.session.usedPct.sourceTier, 'unknown');
    assert.equal(unavailable.session.usedPct.accuracyLabel, undefined);
  });
});
