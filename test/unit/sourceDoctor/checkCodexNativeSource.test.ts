import * as assert from 'node:assert/strict';
import type { CodexNativeSourceDoctorInput } from '../../../src/core/sourceDoctor/checkCodexNativeSource';
import { checkCodexNativeSource } from '../../../src/core/sourceDoctor/checkCodexNativeSource';

function input(
  overrides: Partial<CodexNativeSourceDoctorInput> = {},
): CodexNativeSourceDoctorInput {
  return {
    visible: true,
    configuredProbeEnabled: false,
    effectiveProbeEnabled: false,
    effectiveScope: 'user',
    lastProbeStage: 'idle',
    lastProbeIoStage: 'none',
    sawStderr: false,
    stdoutChunks: 0,
    exitBucket: 'none',
    cliResolver: 'not_found',
    cliResolverStage: 'nvm_not_found',
    ...overrides,
  };
}

function ruleIds(report: ReturnType<typeof checkCodexNativeSource>): string[] {
  return report.findings.map((finding) => finding.ruleId);
}

suite('Native Source Doctor — Codex checks', () => {
  test('Hidden Codex card reports no-spawn posture', () => {
    const report = checkCodexNativeSource(input({ visible: false, configuredProbeEnabled: true }));

    assert.equal(report.visible, false);
    assert.deepEqual(ruleIds(report), ['doctor_codex_card_hidden']);
    assert.match(report.findings[0]?.message ?? '', /does not spawn/i);
  });

  test('Visible Codex card with probe off reports opt-in disabled state', () => {
    const report = checkCodexNativeSource(input());

    assert.deepEqual(ruleIds(report), ['doctor_codex_probe_disabled']);
    assert.equal(report.findings[0]?.severity, 'info');
    assert.deepEqual(
      report.findings[0]?.facts?.find((fact) => fact.name === 'effective scope')?.value,
      'user',
    );
  });

  test('Enabled Codex card consumes existing stage labels without running a probe', () => {
    const report = checkCodexNativeSource(
      input({
        configuredProbeEnabled: true,
        effectiveProbeEnabled: true,
        effectiveScope: 'workspace',
        loop: {
          lastRefreshAtMs: 1,
          lastPostAtMs: 2,
          lastRefreshTrigger: 'manual',
          lastRefreshRuleId: 'cockpit-refresh-ok',
          pollActive: true,
          watchActive: false,
          probeEnabled: true,
          manualRefreshForcedProbe: true,
        },
        lastProbeStage: 'ratelimits_received',
        lastProbeIoStage: 'response_matched',
        cliResolver: 'extension_path',
        cliResolverStage: 'extension_path_found',
      }),
    );

    assert.deepEqual(ruleIds(report), [
      'doctor_codex_probe_enabled',
      'doctor_codex_probe_stage',
      'doctor_codex_probe_not_started',
    ]);
    assert.equal(report.findings[1]?.severity, 'ok');
    assert.deepEqual(
      report.findings[1]?.facts?.find((fact) => fact.name === 'probe stage')?.value,
      'ratelimits_received',
    );
  });

  test('Retained fresh value reports recognized window state', () => {
    const report = checkCodexNativeSource(
      input({
        configuredProbeEnabled: true,
        effectiveProbeEnabled: true,
        retention: {
          probeEnabled: true,
          hasLastKnownValid: true,
          lastStepRuleId: 'codex_retention_accepted_fresh',
          lastAppliedReason: undefined,
          lastProbeAgeBucketSeconds: 5,
          freshnessTier: 'fresh',
          windowUsed: 'both',
          resetAtPresent: true,
          reducerRejectedLower: false,
        },
        lastProbeStage: 'completed',
        lastProbeIoStage: 'response_matched',
      }),
    );

    assert.ok(ruleIds(report).includes('doctor_codex_last_known_value'));
    assert.equal(
      report.findings.find((finding) => finding.ruleId === 'doctor_codex_last_known_value')
        ?.severity,
      'ok',
    );
  });

  test('Fresh valid retained snapshot with no failure reason remains OK', () => {
    const report = checkCodexNativeSource(
      input({
        configuredProbeEnabled: true,
        effectiveProbeEnabled: true,
        retention: {
          probeEnabled: true,
          hasLastKnownValid: true,
          lastStepRuleId: 'codex_retention_accepted_fresh',
          lastAppliedReason: undefined,
          lastProbeAgeBucketSeconds: 5,
          freshnessTier: 'fresh',
          windowUsed: 'weekly',
          resetAtPresent: true,
          reducerRejectedLower: false,
        },
        lastProbeStage: 'ratelimits_received',
        lastProbeIoStage: 'response_matched',
      }),
    );

    const retained = report.findings.find(
      (finding) => finding.ruleId === 'doctor_codex_last_known_value',
    );
    assert.ok(retained);
    assert.equal(retained.severity, 'ok');
  });

  for (const [reason, expectedAction] of [
    ['codex_probe_timeout', /refresh native status/i],
    ['codex_probe_temporarily_unavailable', /signed in/i],
    ['codex_probe_parse_failed_after_valid', /status response changed/i],
    ['codex_probe_no_data_after_valid', /recognized short or weekly/i],
  ] as const) {
    test(`Valid snapshot followed by ${reason} is a warning`, () => {
      const report = checkCodexNativeSource(
        input({
          configuredProbeEnabled: true,
          effectiveProbeEnabled: true,
          retention: {
            probeEnabled: true,
            hasLastKnownValid: true,
            lastStepRuleId: 'codex_retention_retained_degraded',
            lastAppliedReason: reason,
            lastProbeAgeBucketSeconds: 15,
            freshnessTier: 'retained',
            windowUsed: 'session-5h',
            resetAtPresent: true,
            reducerRejectedLower: false,
          },
          lastProbeStage: 'ratelimits_received',
          lastProbeIoStage: 'response_matched',
        }),
      );

      const degraded = report.findings.find(
        (finding) => finding.ruleId === 'doctor_codex_probe_degraded',
      );
      assert.ok(degraded);
      assert.equal(degraded.severity, 'warning');
      assert.match(degraded.action ?? '', expectedAction);
      assert.equal(JSON.stringify(degraded).includes('62'), false);
    });
  }

  test('Stale retained snapshot is a warning', () => {
    const report = checkCodexNativeSource(
      input({
        configuredProbeEnabled: true,
        effectiveProbeEnabled: true,
        retention: {
          probeEnabled: true,
          hasLastKnownValid: true,
          lastStepRuleId: 'codex_retention_held_stale',
          lastAppliedReason: 'codex_probe_stale',
          lastProbeAgeBucketSeconds: 600,
          freshnessTier: 'stale',
          windowUsed: 'both',
          resetAtPresent: true,
          reducerRejectedLower: false,
        },
        lastProbeStage: 'completed',
        lastProbeIoStage: 'response_matched',
      }),
    );

    const stale = report.findings.find((finding) => finding.ruleId === 'doctor_codex_probe_stale');
    assert.ok(stale);
    assert.equal(stale.severity, 'warning');
  });

  test('Provider summary severity reflects retained degradation', () => {
    const report = checkCodexNativeSource(
      input({
        configuredProbeEnabled: true,
        effectiveProbeEnabled: true,
        retention: {
          probeEnabled: true,
          hasLastKnownValid: true,
          lastStepRuleId: 'codex_retention_retained_degraded',
          lastAppliedReason: 'codex_probe_timeout',
          lastProbeAgeBucketSeconds: 10,
          freshnessTier: 'retained',
          windowUsed: 'both',
          resetAtPresent: true,
          reducerRejectedLower: false,
        },
        lastProbeStage: 'completed',
        lastProbeIoStage: 'response_matched',
      }),
    );

    assert.ok(report.findings.some((finding) => finding.severity === 'warning'));
    assert.equal(
      report.findings.some((finding) => finding.severity === 'blocked'),
      false,
    );
  });

  test('Protocol drift is blocked and does not fabricate a window', () => {
    const report = checkCodexNativeSource(
      input({
        configuredProbeEnabled: true,
        effectiveProbeEnabled: true,
        retention: {
          probeEnabled: true,
          hasLastKnownValid: false,
          lastStepRuleId: 'codex_retention_passed_blocker',
          lastAppliedReason: 'codex_protocol_drift',
          lastProbeAgeBucketSeconds: undefined,
          freshnessTier: 'none',
          windowUsed: 'none',
          resetAtPresent: false,
          reducerRejectedLower: false,
        },
        lastProbeStage: 'ratelimits_received',
        lastProbeIoStage: 'response_matched',
      }),
    );

    const drift = report.findings.find(
      (finding) => finding.ruleId === 'doctor_codex_protocol_drift',
    );
    assert.ok(drift);
    assert.equal(drift.severity, 'blocked');
    assert.deepEqual(drift.facts?.find((fact) => fact.name === 'window used')?.value, 'none');
  });
});
