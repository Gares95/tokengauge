import type {
  CodexCliResolverLabel,
  CodexCliResolverStage,
  CodexProbeExitBucket,
  CodexProbeIoStage,
  CodexProbeStage,
} from '../../adapters/codex/CodexAppServerProbe';
import type {
  CodexProbeRetentionDiagnosticsSnapshot,
  CodexWindowUsed,
} from '../../cockpit/CodexProbeRetentionGate';
import type { CockpitLoopDiagnosticsSnapshot } from '../../cockpit/NativeStatusRefreshLoop';
import type { CockpitFieldReason } from '../cockpit/CockpitState';
import type {
  NativeSourceDoctorFinding,
  NativeSourceDoctorProviderReport,
  NativeSourceDoctorSettingsScope,
} from './types';

export interface CodexNativeSourceDoctorInput {
  readonly visible: boolean;
  readonly configuredProbeEnabled: boolean;
  readonly effectiveProbeEnabled: boolean;
  readonly effectiveScope: NativeSourceDoctorSettingsScope;
  readonly loop?: CockpitLoopDiagnosticsSnapshot;
  readonly retention?: CodexProbeRetentionDiagnosticsSnapshot;
  readonly lastProbeStage: CodexProbeStage;
  readonly lastProbeIoStage: CodexProbeIoStage;
  readonly sawStderr: boolean;
  readonly stdoutChunks: number;
  readonly exitBucket: CodexProbeExitBucket;
  readonly cliResolver: CodexCliResolverLabel;
  readonly cliResolverStage: CodexCliResolverStage;
}

function stageSeverity(stage: CodexProbeStage, reason: CockpitFieldReason | undefined) {
  if (reason === 'codex_protocol_drift') return 'blocked' as const;
  if (stage === 'completed' || stage === 'parsed' || stage === 'ratelimits_received') {
    return 'ok' as const;
  }
  if (stage === 'idle') return 'info' as const;
  if (stage === 'cli_not_found' || stage === 'no_stdio' || stage === 'run_threw') {
    return 'warning' as const;
  }
  return 'info' as const;
}

function retentionFinding(
  retention: CodexProbeRetentionDiagnosticsSnapshot | undefined,
): NativeSourceDoctorFinding {
  if (retention === undefined) {
    return {
      ruleId: 'doctor_codex_probe_not_started',
      severity: 'info',
      title: 'No Codex retention snapshot is available yet',
      message:
        'The cockpit loop has not reported a Codex retention state in this extension-host session.',
      action:
        'Open the cockpit or refresh native status after enabling the Codex probe to collect current sanitized state.',
    };
  }
  const facts = [
    { name: 'last step', value: retention.lastStepRuleId },
    { name: 'last reason', value: retention.lastAppliedReason ?? 'none' },
    { name: 'freshness tier', value: retention.freshnessTier },
    { name: 'window used', value: retention.windowUsed },
    { name: 'reset present', value: retention.resetAtPresent },
    { name: 'reducer rejected lower', value: retention.reducerRejectedLower },
  ];
  if (retention.lastAppliedReason === 'codex_protocol_drift') {
    return {
      ruleId: 'doctor_codex_protocol_drift',
      severity: 'blocked',
      title: 'Codex app-server response is unsupported',
      message:
        'The last Codex state contained neither recognized usage window nor a supported response shape.',
      action:
        'Update TokenGauge when Codex changes its app-server status format; TokenGauge will not guess missing windows.',
      facts,
    };
  }
  if (retention.hasLastKnownValid) {
    return {
      ruleId:
        retention.freshnessTier === 'stale'
          ? 'doctor_codex_probe_stale'
          : 'doctor_codex_last_known_value',
      severity: retention.freshnessTier === 'stale' ? 'warning' : 'ok',
      title:
        retention.freshnessTier === 'stale'
          ? 'Codex value is retained but stale'
          : 'Codex has a retained last-known value',
      message: 'TokenGauge has a sanitized Codex value from a previous valid app-server response.',
      action:
        retention.freshnessTier === 'stale'
          ? 'Use Refresh Native Status to request a fresh Codex probe when the probe is enabled.'
          : undefined,
      facts,
    };
  }
  const windowUsed: CodexWindowUsed = retention.windowUsed;
  return {
    ruleId: 'doctor_codex_no_last_known_value',
    severity: retention.probeEnabled ? 'warning' : 'info',
    title: 'Codex has no last-known value yet',
    message:
      'No valid Codex app-server response has produced a recognized short or weekly window in this session.',
    action: retention.probeEnabled
      ? 'Run Refresh Native Status after confirming the Codex CLI is signed in on this extension-host side.'
      : undefined,
    facts: [...facts, { name: 'recognized window state', value: windowUsed }],
  };
}

export function checkCodexNativeSource(
  input: CodexNativeSourceDoctorInput,
): NativeSourceDoctorProviderReport {
  if (!input.visible) {
    return {
      provider: 'codex',
      displayName: 'Codex',
      visible: false,
      findings: [
        {
          ruleId: 'doctor_codex_card_hidden',
          severity: 'info',
          title: 'Codex card is hidden',
          message:
            'TokenGauge does not spawn the Codex app-server probe while the Codex card is hidden.',
          action: 'Use Configure Cockpit to show the Codex card before diagnosing Codex setup.',
          facts: [{ name: 'configured probe setting', value: input.configuredProbeEnabled }],
        },
      ],
    };
  }

  const findings: NativeSourceDoctorFinding[] = [];
  if (!input.effectiveProbeEnabled) {
    findings.push({
      ruleId: 'doctor_codex_probe_disabled',
      severity: 'info',
      title: 'Codex native probe is off',
      message:
        'The Codex card can be shown, but TokenGauge will not spawn codex until the explicit probe setting is enabled.',
      action:
        'Open Codex settings from Configure Cockpit if you want TokenGauge to ask your local codex app-server for rate-limit windows.',
      facts: [
        { name: 'configured probe setting', value: input.configuredProbeEnabled },
        { name: 'effective scope', value: input.effectiveScope },
      ],
    });
    return { provider: 'codex', displayName: 'Codex', visible: true, findings };
  }

  const reason = input.retention?.lastAppliedReason;
  findings.push({
    ruleId: 'doctor_codex_probe_enabled',
    severity: 'ok',
    title: 'Codex native probe is enabled for the visible card',
    message:
      'The Doctor reports existing sanitized probe state only; it does not run a new Codex probe by itself.',
    facts: [
      { name: 'effective scope', value: input.effectiveScope },
      { name: 'poll loop active', value: input.loop?.pollActive ?? false },
      { name: 'watch loop active', value: input.loop?.watchActive ?? false },
    ],
  });
  findings.push({
    ruleId: 'doctor_codex_probe_stage',
    severity: stageSeverity(input.lastProbeStage, reason),
    title: 'Last Codex probe stage is available',
    message:
      'Closed stage labels identify where the last local app-server check stopped without exposing output.',
    facts: [
      { name: 'probe stage', value: input.lastProbeStage },
      { name: 'io stage', value: input.lastProbeIoStage },
      { name: 'stderr seen', value: input.sawStderr },
      { name: 'stdout chunks', value: input.stdoutChunks },
      { name: 'child exit', value: input.exitBucket },
      { name: 'cli resolver', value: input.cliResolver },
      { name: 'cli resolver stage', value: input.cliResolverStage },
    ],
  });
  findings.push(retentionFinding(input.retention));
  return { provider: 'codex', displayName: 'Codex', visible: true, findings };
}
