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

function codexFailureAction(reason: CockpitFieldReason | undefined): string | undefined {
  switch (reason) {
    case 'codex_protocol_drift':
      return 'Update TokenGauge when Codex changes its app-server status format; TokenGauge will not guess missing windows.';
    case 'codex_probe_timeout':
      return 'Run Refresh Native Status again after confirming the local Codex CLI responds in this extension-host environment.';
    case 'codex_probe_no_response':
      return 'Update Codex CLI or try an environment where the local app-server responds over stdio.';
    case 'codex_cli_not_found':
      return 'Install or expose the Codex CLI on the extension-host PATH, then run Refresh Native Status.';
    case 'codex_probe_failed':
    case 'codex_native_status_unavailable':
    case 'codex_probe_temporarily_unavailable':
      return 'Run Refresh Native Status after confirming Codex is signed in on this extension-host side.';
    case 'codex_probe_parse_failed_after_valid':
      return 'Update TokenGauge if the Codex local status response changed; TokenGauge will keep the last known sanitized value until a supported response returns.';
    case 'codex_probe_no_data_after_valid':
      return 'Run Refresh Native Status after Codex reports a recognized short or weekly window again.';
    case 'codex_probe_stale':
      return 'Use Refresh Native Status to request a fresh Codex probe when the probe is enabled.';
    case 'codex_probe_pending':
      return 'Open the cockpit or run Refresh Native Status to collect current sanitized Codex state.';
    default:
      return undefined;
  }
}

function codexFailureLabel(reason: CockpitFieldReason | undefined): string {
  return reason?.replace(/^codex_/, '').replaceAll('_', '-') ?? 'no-failure';
}

function reasonSeverity(
  reason: CockpitFieldReason | undefined,
): NativeSourceDoctorFinding['severity'] {
  if (reason === undefined) return 'ok';
  if (reason === 'codex_protocol_drift') return 'blocked';
  if (reason === 'codex_probe_disabled') return 'info';
  return 'warning';
}

function stageSeverity(
  stage: CodexProbeStage,
  reason: CockpitFieldReason | undefined,
): NativeSourceDoctorFinding['severity'] {
  const fromReason = reasonSeverity(reason);
  if (fromReason !== 'ok') return fromReason;
  if (stage === 'completed' || stage === 'parsed' || stage === 'ratelimits_received') return 'ok';
  if (stage === 'idle') return 'info';
  if (stage === 'cli_not_found' || stage === 'no_stdio' || stage === 'run_threw') return 'warning';
  return 'info';
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
      action: codexFailureAction(retention.lastAppliedReason),
      facts,
    };
  }
  if (retention.hasLastKnownValid) {
    const reasonSeverityValue = reasonSeverity(retention.lastAppliedReason);
    const degradedByReason = reasonSeverityValue === 'warning' || reasonSeverityValue === 'blocked';
    const degradedByFreshness =
      retention.freshnessTier === 'retained' || retention.freshnessTier === 'stale';
    if (
      retention.freshnessTier === 'stale' ||
      retention.lastAppliedReason === 'codex_probe_stale'
    ) {
      return {
        ruleId: 'doctor_codex_probe_stale',
        severity: 'warning',
        title: 'Codex value is retained but stale',
        message:
          'TokenGauge is showing a sanitized last-known Codex value because no current supported value is available inside the freshness window.',
        action: codexFailureAction(retention.lastAppliedReason),
        facts,
      };
    }
    if (degradedByReason || degradedByFreshness) {
      return {
        ruleId: 'doctor_codex_probe_degraded',
        severity: 'warning',
        title: 'Codex value is retained after a degraded probe',
        message: `TokenGauge is showing a sanitized last-known Codex value because the current probe ended in a closed ${codexFailureLabel(
          retention.lastAppliedReason,
        )} state.`,
        action: codexFailureAction(retention.lastAppliedReason),
        facts,
      };
    }
    return {
      ruleId: 'doctor_codex_last_known_value',
      severity: 'ok',
      title: 'Codex has a current recognized window state',
      message: 'TokenGauge has a sanitized Codex value from a valid app-server response.',
      facts,
    };
  }
  const windowUsed: CodexWindowUsed = retention.windowUsed;
  const severity = reasonSeverity(retention.lastAppliedReason);
  return {
    ruleId: 'doctor_codex_no_last_known_value',
    severity: severity === 'ok' ? (retention.probeEnabled ? 'warning' : 'info') : severity,
    title: 'Codex has no valid native value yet',
    message:
      'No valid Codex app-server response has produced a recognized short or weekly window in this session.',
    action: codexFailureAction(retention.lastAppliedReason),
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
