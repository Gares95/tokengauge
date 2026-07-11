// SourceTier unit tests.
//
// SourceTier is a runtime SOURCE dimension, structurally DISTINCT from the
// AccuracyLabel honesty lattice. Native-only: the canonical tiers are
// the native Claude/Codex surfaces plus the unknown floor — there is NO synthetic
// estimator tier. These tests pin the canonical order, per-field-class ranking,
// the per-FIELD overrides, and that SourceTier does not mutate the accuracy
// lattice. Grep target: "SourceTier".

import * as assert from 'node:assert/strict';
import { leastAccurate } from '../../../../src/core/accuracy/Accuracy';
import {
  outranks,
  rankOf,
  SOURCE_TIERS,
  type SourceTier,
} from '../../../../src/core/sources/SourceTier';

suite('SourceTier: canonical native tiers + per-field ranking', () => {
  test('SOURCE_TIERS is the native-only canonical list (no estimator tier)', () => {
    assert.deepEqual(
      [...SOURCE_TIERS],
      ['statusline_snapshot', 'codex_status_snapshot', 'stats_cache_snapshot', 'unknown'],
    );
  });

  // Codex_status_snapshot is a first-class native
  // tier ranked in every strength table; it never breaks a strict total order.
  test('Limit/risk: statusline_snapshot > codex_status_snapshot > stats_cache_snapshot > unknown', () => {
    assert.ok(outranks('statusline_snapshot', 'codex_status_snapshot', 'limit'));
    assert.ok(outranks('codex_status_snapshot', 'stats_cache_snapshot', 'limit'));
    assert.ok(outranks('stats_cache_snapshot', 'unknown', 'limit'));
  });

  test('Reset: statusline_snapshot > codex_status_snapshot > stats_cache_snapshot > unknown', () => {
    assert.ok(outranks('statusline_snapshot', 'codex_status_snapshot', 'reset'));
    assert.ok(outranks('codex_status_snapshot', 'stats_cache_snapshot', 'reset'));
    assert.ok(outranks('stats_cache_snapshot', 'unknown', 'reset'));
  });

  test('Token-detail/cost: native structured (statusLine / stats-cache) > codex probe (carries neither)', () => {
    // The Codex status probe carries no token-bucket detail and no cost, so it is
    // demoted near the floor in those two tables.
    assert.ok(outranks('statusline_snapshot', 'stats_cache_snapshot', 'tokenDetail'));
    assert.ok(outranks('stats_cache_snapshot', 'codex_status_snapshot', 'tokenDetail'));
    assert.ok(outranks('stats_cache_snapshot', 'codex_status_snapshot', 'cost'));
    assert.ok(outranks('codex_status_snapshot', 'unknown', 'tokenDetail'));
    assert.ok(outranks('codex_status_snapshot', 'unknown', 'cost'));
  });

  test('Cost: a native structured cost (statusLine / stats-cache) leads', () => {
    assert.ok(outranks('statusline_snapshot', 'codex_status_snapshot', 'cost'));
    assert.ok(outranks('stats_cache_snapshot', 'codex_status_snapshot', 'cost'));
  });

  test('Outranks() is a total order per field class; unknown is weakest', () => {
    for (const field of ['limit', 'tokenDetail', 'cost', 'reset'] as const) {
      for (const tier of SOURCE_TIERS) {
        if (tier === 'unknown') continue;
        assert.ok(outranks(tier, 'unknown', field), `${tier} should outrank unknown for ${field}`);
        assert.ok(!outranks('unknown', tier, field));
      }
      // Antisymmetry + irreflexivity on the full set.
      for (const a of SOURCE_TIERS) {
        assert.ok(!outranks(a, a, field), `${a} must not outrank itself`);
        for (const b of SOURCE_TIERS) {
          if (a === b) continue;
          const ab = outranks(a, b, field);
          const ba = outranks(b, a, field);
          assert.ok(!(ab && ba), `${a}/${b} cannot both outrank for ${field}`);
          assert.ok(ab || ba, `${a}/${b} must be comparable for ${field}`);
        }
      }
    }
  });

  test('RankOf gives a strict numeric ordering for a field class', () => {
    assert.ok(rankOf('statusline_snapshot', 'limit') > rankOf('codex_status_snapshot', 'limit'));
    assert.ok(rankOf('codex_status_snapshot', 'limit') > rankOf('stats_cache_snapshot', 'limit'));
    assert.equal(rankOf('unknown', 'limit'), 0);
  });

  test('SourceTier is DISTINCT from AccuracyLabel — lattice behavior unchanged', () => {
    assert.equal(leastAccurate(['exact', 'proxy_reported'], 'token'), 'proxy_reported');
    assert.equal(leastAccurate(['billing_authoritative', 'exact'], 'cost'), 'exact');
    assert.equal(leastAccurate(['proxy_reported', 'partial'], 'token'), 'partial');
    assert.equal(leastAccurate([], 'token'), 'unknown');
    // SourceTier values are NOT AccuracyLabels — there is no `statusline_snapshot`
    // accuracy label. The two type spaces never collide.
    const tier: SourceTier = 'statusline_snapshot';
    assert.ok(!['exact', 'billing_authoritative', 'proxy_reported'].includes(tier));
  });
});
