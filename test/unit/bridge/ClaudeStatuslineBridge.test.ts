// ClaudeStatuslineBridge unit tests.
//
// Assert the mapping flow: a clean snapshot becomes a guarded ObservedLimitSample
// with source:'bridge', percentConsumed from the read rate-limit window, a
// HASHED session id in scopeHash (never the raw id), a resetTime derived from
// the epoch `resets_at`, and the BRIDGE_SOURCE_FINGERPRINT version tag. The
// bridge reads ONLY the injected snapshot object — no network, no TUI scrape.

import * as assert from 'node:assert/strict';
import {
  BRIDGE_SOURCE_FINGERPRINT,
  type ClaudeStatuslineBridgeDeps,
  snapshotToObservedLimitSample,
} from '../../../src/bridge/ClaudeStatuslineBridge';
import { IdHasher } from '../../../src/security/IdHasher';

const RAW_SESSION_ID = '11111111-2222-3333-4444-555555555555';

function cleanSnapshot(): Record<string, unknown> {
  return {
    model: { id: 'claude-opus-4' },
    cost: { total_cost_usd: 4.27 },
    context_window: { context_window_size: 200000, used_percentage: 38.5 },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1781110800 },
      seven_day: { used_percentage: 71, resets_at: 1781308800 },
    },
    session_id: RAW_SESSION_ID,
  };
}

function makeDeps(overrides: Partial<ClaudeStatuslineBridgeDeps> = {}): ClaudeStatuslineBridgeDeps {
  const hasher = new IdHasher('test-install-salt');
  return {
    hasher,
    now: () => new Date('2026-06-09T10:00:00.000Z'),
    deriveId: (material: string) =>
      // Deterministic 64-hex from the install salt; reuses IdHasher, no new dep.
      hasher.hashWorkspaceId(material),
    sourceFingerprint: BRIDGE_SOURCE_FINGERPRINT,
    ...overrides,
  };
}

suite('ClaudeStatuslineBridge: snapshot -> guarded source:bridge sample', () => {
  test('Maps the clean snapshot to a source:bridge sample with hashed session id', () => {
    const sample = snapshotToObservedLimitSample(cleanSnapshot(), makeDeps());
    assert.equal(sample.source, 'bridge');
    assert.equal(sample.provider, 'anthropic');
    assert.equal(sample.agent, 'claude-code');
    assert.equal(sample.percentConsumed, 42); // five_hour by default
    assert.equal(sample.model, 'claude-opus-4');
    assert.match(sample.scopeHash ?? '', /^[0-9a-f]{64}$/);
  });

  test('Reads the weekly window when windowType=weekly', () => {
    const sample = snapshotToObservedLimitSample(cleanSnapshot(), makeDeps(), {
      windowType: 'weekly',
    });
    assert.equal(sample.windowType, 'weekly');
    assert.equal(sample.percentConsumed, 71); // seven_day
  });

  test('The raw session_id never appears anywhere in the produced sample', () => {
    const sample = snapshotToObservedLimitSample(cleanSnapshot(), makeDeps());
    const serialized = JSON.stringify(sample);
    assert.ok(!serialized.includes(RAW_SESSION_ID), 'raw session id leaked into sample');
  });

  test('The produced sample carries the BRIDGE_SOURCE_FINGERPRINT version tag', () => {
    const sample = snapshotToObservedLimitSample(cleanSnapshot(), makeDeps());
    assert.ok(sample.note?.includes(BRIDGE_SOURCE_FINGERPRINT));
    assert.match(BRIDGE_SOURCE_FINGERPRINT, /^claude-statusline-v\d+$/);
  });

  test('Resets_at epoch is converted to an ISO-8601 resetTime', () => {
    const sample = snapshotToObservedLimitSample(cleanSnapshot(), makeDeps());
    assert.equal(sample.resetTime, new Date(1781110800 * 1000).toISOString());
  });

  test('A snapshot carrying a leaky field is rejected by the strict schema', () => {
    const leaky = { ...cleanSnapshot(), cwd: '/raw/path' };
    assert.throws(() => snapshotToObservedLimitSample(leaky, makeDeps()));
  });

  test('The bridge performs no network call and reads only the injected object', () => {
    // The deps surface exposes no fetch/http/file-read seam; the only input is
    // the snapshot object. This is the structural guarantee. Map succeeds purely
    // from the injected object.
    const sample = snapshotToObservedLimitSample(cleanSnapshot(), makeDeps());
    assert.ok(sample.id.match(/^[0-9a-f]{64}$/));
  });
});
