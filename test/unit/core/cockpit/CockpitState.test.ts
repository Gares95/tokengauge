// CockpitState model unit tests.
//
// CockpitState is a transient, render-only model (NOT persisted). Each
// field carries BOTH a single canonical sourceTier AND an accuracyLabel, plus
// freshness + confidence. Missing/degraded fields carry an explicit reason
// (never a silent zero). Scope is hashed-only — no raw path/session id.

import * as assert from 'node:assert/strict';
import {
  type CockpitField,
  type CockpitState,
  emptyCockpitState,
  fieldOf,
  unavailableField,
} from '../../../../src/core/cockpit/CockpitState';

suite('CockpitState: per-field source/accuracy/freshness/confidence', () => {
  test('A populated field carries sourceTier + accuracyLabel + freshness + confidence', () => {
    const field: CockpitField<number> = fieldOf(62, {
      sourceTier: 'statusline_snapshot',
      accuracyLabel: 'proxy_reported',
      freshnessMs: 1000,
      confidence: 'high',
    });
    assert.equal(field.value, 62);
    assert.equal(field.sourceTier, 'statusline_snapshot');
    assert.equal(field.accuracyLabel, 'proxy_reported');
    assert.equal(field.freshnessMs, 1000);
    assert.equal(field.confidence, 'high');
    assert.equal(field.available, true);
  });

  test('An unavailable field carries a reason and no value (not silent zero)', () => {
    const field = unavailableField('codex_native_status_unavailable');
    assert.equal(field.available, false);
    assert.equal(field.value, undefined);
    assert.equal(field.reason, 'codex_native_status_unavailable');
    assert.equal(field.sourceTier, 'unknown');
  });

  // The six closed reasons are the ONLY
  // string class that may reach the VM/UI; each round-trips through unavailableField.
  test('The six new codex/statusline closed reasons round-trip through unavailableField', () => {
    const reasons = [
      'codex_probe_disabled',
      'codex_probe_failed',
      'codex_probe_timeout',
      'codex_cli_not_found',
      'codex_protocol_drift',
      'statusline_snapshot_not_configured',
    ] as const;
    for (const reason of reasons) {
      const field = unavailableField(reason);
      assert.equal(field.available, false);
      assert.equal(field.value, undefined);
      assert.equal(field.reason, reason);
      assert.equal(field.sourceTier, 'unknown');
    }
  });

  test('Native_status_stale is a valid degraded reason on an available field', () => {
    // A stale native value is still SHOWN (available) but degraded with a reason
    // and lowered confidence — never silently dropped.
    const field: CockpitField<number> = fieldOf(40, {
      sourceTier: 'statusline_snapshot',
      accuracyLabel: 'proxy_reported',
      freshnessMs: 9_000_000,
      confidence: 'low',
      reason: 'native_status_stale',
    });
    assert.equal(field.available, true);
    assert.equal(field.value, 40);
    assert.equal(field.reason, 'native_status_stale');
    assert.equal(field.confidence, 'low');
  });

  test('EmptyCockpitState produces all-unavailable fields with no raw scope', () => {
    const state: CockpitState = emptyCockpitState({
      provider: 'anthropic',
      agent: 'claude-code',
      workspaceHash: 'a'.repeat(64),
      sessionHash: 'b'.repeat(64),
    });
    assert.equal(state.session.usedPct.available, false);
    assert.equal(state.weekly.usedPct.available, false);
    assert.equal(state.cost.available, false);
    assert.equal(state.model.available, false);
    assert.equal(state.riskLevel.available, false);
    // Scope is hashed-only — no raw path, no raw session id.
    assert.equal(state.scope.workspaceHash, 'a'.repeat(64));
    assert.equal(state.scope.sessionHash, 'b'.repeat(64));
    assert.equal((state.scope as unknown as Record<string, unknown>).workspacePath, undefined);
    assert.equal((state.scope as unknown as Record<string, unknown>).sessionId, undefined);
  });

  // The cockpit field set defaults
  // to explicitly-unavailable (never silently absent) in emptyCockpitState.
  test('EmptyCockpitState defaults context/reasoning/agentVersion/planType to unavailable no_source', () => {
    const state: CockpitState = emptyCockpitState({
      provider: 'anthropic',
      agent: 'claude-code',
    });
    const ctxFields = [
      state.context.usedPct,
      state.context.leftPct,
      state.context.windowSizeTokens,
      state.context.usedTokens,
      state.context.inputTokens,
      state.context.outputTokens,
    ];
    for (const f of ctxFields) {
      assert.equal(f.available, false);
      assert.equal(f.reason, 'no_source');
    }
    assert.equal(state.reasoning.available, false);
    assert.equal(state.reasoning.reason, 'no_source');
    assert.equal(state.agentVersion.available, false);
    assert.equal(state.agentVersion.reason, 'no_source');
    assert.equal(state.planType.available, false);
    assert.equal(state.planType.reason, 'no_source');
  });

  test('CockpitState scope rejects raw-looking fields by construction (hashed only)', () => {
    const state = emptyCockpitState({
      provider: 'anthropic',
      agent: 'claude-code',
      workspaceHash: 'a'.repeat(64),
    });
    // sessionHash optional; absent when not known.
    assert.equal(state.scope.sessionHash, undefined);
    assert.equal(state.scope.provider, 'anthropic');
    assert.equal(state.scope.agent, 'claude-code');
  });
});
