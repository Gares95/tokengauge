// CodexStatusSource unit tests cover the honest blocker shape and the explicit
// opt-in app-server probe gate. The TUI remains DO-NOT-SCRAPE.

import * as assert from 'node:assert/strict';
import type { CodexProbeResult } from '../../../../src/adapters/codex/CodexAppServerProbe';
import {
  CODEX_NATIVE_STATUS_BLOCKED_REASON,
  CODEX_PROBE_DISABLED_REASON,
  type CodexProbeSeam,
  codexNativeStatusBlocked,
  probeCodexNativeStatusGated,
} from '../../../../src/adapters/codex/CodexStatusSource';

const NOW = () => new Date('2026-06-12T00:00:00.000Z');

const SUCCESS_RESULT: Extract<CodexProbeResult, { ok: true }> = {
  ok: true,
  primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1781212269 },
  secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1781799069 },
  planType: 'plus',
  codexVersion: 'codex-cli 0.137.0',
  stage: 'completed',
  ioStage: 'response_matched',
  sawStderr: false,
  stdoutChunks: 3,
  exitBucket: 'none',
};

// A recording fake probe seam — `ran` proves whether the runner was invoked, so
// the disabled-gate test can assert ZERO spawn (the seam must never run).
function makeFakeProbe(result: CodexProbeResult): { probe: CodexProbeSeam; ran: () => boolean } {
  let invoked = false;
  return {
    probe: {
      run: async () => {
        invoked = true;
        return result;
      },
    },
    ran: () => invoked,
  };
}

suite('CodexStatusSource: documented blocker', () => {
  test('CodexNativeStatusBlocked() resolves limit-state to unknown with the documented reason', () => {
    const candidate = codexNativeStatusBlocked();
    assert.equal(candidate.sourceTier, 'unknown');
    assert.equal(candidate.scope.provider, 'openai');
    assert.equal(candidate.scope.agent, 'codex');
    // No fabricated session/weekly limit value.
    assert.equal(candidate.session, undefined);
    assert.equal(candidate.weekly, undefined);
    assert.equal(candidate.unavailableReason, CODEX_NATIVE_STATUS_BLOCKED_REASON);
  });

  test('The blocker never scrapes a TUI command and emits no raw account/dir/session', () => {
    const candidate = codexNativeStatusBlocked();
    const serialized = JSON.stringify(candidate);
    assert.ok(!serialized.includes('access_token'));
    assert.ok(!serialized.includes('account_id'));
    assert.ok(!/\/(home|Users)\//.test(serialized));
  });

  test('The documented reason matches the cockpit CockpitFieldReason literal', () => {
    assert.equal(CODEX_NATIVE_STATUS_BLOCKED_REASON, 'codex_native_status_unavailable');
  });
});

suite('CodexStatusSource: gated app-server probe path', () => {
  test('Disabled → codex_probe_disabled blocker with ZERO probe spawn', async () => {
    const { probe, ran } = makeFakeProbe(SUCCESS_RESULT);
    const result = await probeCodexNativeStatusGated({ probeEnabled: false, probe, now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.blocked.sourceTier, 'unknown');
    assert.equal(result.blocked.unavailableReason, CODEX_PROBE_DISABLED_REASON);
    assert.equal(result.blocked.unavailableReason, 'codex_probe_disabled');
    // No session/weekly fabricated.
    assert.equal(result.blocked.session, undefined);
    assert.equal(result.blocked.weekly, undefined);
    // The runner seam was NEVER invoked — provably zero process spawn.
    assert.equal(ran(), false);
  });

  test('Enabled + success → codex_status_snapshot candidate from the probe mapper', async () => {
    const { probe, ran } = makeFakeProbe(SUCCESS_RESULT);
    const result = await probeCodexNativeStatusGated({ probeEnabled: true, probe, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.candidate.sourceTier, 'codex_status_snapshot');
    assert.equal(result.candidate.confidence, 'medium');
    assert.ok(result.candidate.session);
    assert.ok(result.candidate.weekly);
    assert.equal(result.candidate.session.usedPct, 6);
    assert.equal(result.candidate.session.leftPct, 94);
    assert.equal(result.candidate.weekly.usedPct, 1);
    assert.equal(result.candidate.planType, 'plus');
    assert.ok(result.candidate.agentVersion.includes('0.137.0'));
    assert.equal(result.candidate.producedAtMs, NOW().getTime());
    assert.equal(ran(), true);
  });

  test('Enabled + weekly-only success → candidate remains valid with no fabricated 5h window', async () => {
    const weeklyOnly: Extract<CodexProbeResult, { ok: true }> = {
      ok: true,
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1781799069 },
      planType: 'plus',
      codexVersion: 'codex-cli 0.137.0',
      stage: 'completed',
      ioStage: 'response_matched',
      sawStderr: false,
      stdoutChunks: 3,
      exitBucket: 'none',
    };
    const { probe } = makeFakeProbe(weeklyOnly);
    const result = await probeCodexNativeStatusGated({ probeEnabled: true, probe, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.candidate.session, undefined);
    assert.equal(result.candidate.weekly?.usedPct, 12);
    assert.equal(result.candidate.weekly?.leftPct, 88);
  });

  test('Enabled + probe failure → closed reason passed through unchanged, no fabrication', async () => {
    for (const reason of [
      'codex_cli_not_found',
      'codex_probe_timeout',
      'codex_probe_failed',
      'codex_protocol_drift',
    ] as const) {
      const { probe } = makeFakeProbe({
        ok: false,
        reason,
        stage: 'ratelimits_sent',
        ioStage: 'stdout_chunk_received',
        sawStderr: false,
        stdoutChunks: 0,
        exitBucket: 'none',
      });
      const result = await probeCodexNativeStatusGated({ probeEnabled: true, probe, now: NOW });
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.blocked.unavailableReason, reason);
      assert.equal(result.blocked.sourceTier, 'unknown');
      assert.equal(result.blocked.session, undefined);
    }
  });

  // A timeout where the app-server produced NO stdout at all is the
  // precise environment limitation (codex app-server needs an interactive terminal),
  // surfaced as codex_probe_no_response — NOT a generic timeout.
  test('Timeout with NO stdout received → codex_probe_no_response (interactive-only)', async () => {
    for (const ioStage of ['none', 'stdin_write_started', 'stdin_write_completed'] as const) {
      const { probe } = makeFakeProbe({
        ok: false,
        reason: 'codex_probe_timeout',
        stage: 'initialize_sent',
        ioStage,
        sawStderr: false,
        stdoutChunks: 0,
        exitBucket: 'none',
      });
      const result = await probeCodexNativeStatusGated({ probeEnabled: true, probe, now: NOW });
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.blocked.unavailableReason, 'codex_probe_no_response');
    }
  });

  test('Timeout that DID receive stdout stays codex_probe_timeout (a different fault)', async () => {
    const { probe } = makeFakeProbe({
      ok: false,
      reason: 'codex_probe_timeout',
      stage: 'ratelimits_sent',
      ioStage: 'stdout_line_received',
      sawStderr: false,
      stdoutChunks: 2,
      exitBucket: 'none',
    });
    const result = await probeCodexNativeStatusGated({ probeEnabled: true, probe, now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.blocked.unavailableReason, 'codex_probe_timeout');
  });

  test('Enabled but no seam supplied → codex_probe_failed (never a fabricated gauge)', async () => {
    const result = await probeCodexNativeStatusGated({ probeEnabled: true, now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.blocked.unavailableReason, 'codex_probe_failed');
  });
});
