export type NativeSourceDoctorSeverity = 'ok' | 'info' | 'warning' | 'blocked';

export type NativeSourceDoctorProviderId = 'claude' | 'codex';

export type NativeSourceDoctorSettingsScope = 'default' | 'user' | 'workspace' | 'workspaceFolder';

export type NativeSourceDoctorRuleId =
  | 'doctor_claude_card_hidden'
  | 'doctor_claude_snapshot_not_configured'
  | 'doctor_claude_snapshot_loaded'
  | 'doctor_claude_snapshot_stale'
  | 'doctor_claude_snapshot_freshness_unknown'
  | 'doctor_claude_snapshot_missing'
  | 'doctor_claude_snapshot_parse_failed'
  | 'doctor_claude_snapshot_missing_rate_limits'
  | 'doctor_claude_snapshot_directory_loaded'
  | 'doctor_claude_snapshot_directory_missing_rate_limits'
  | 'doctor_claude_snapshot_directory_multi_writer'
  | 'doctor_claude_snapshot_directory_no_active_writer'
  | 'doctor_claude_snapshot_directory_unreadable'
  | 'doctor_claude_stats_cache_loaded'
  | 'doctor_claude_stats_cache_unavailable'
  | 'doctor_codex_card_hidden'
  | 'doctor_codex_probe_disabled'
  | 'doctor_codex_probe_enabled'
  | 'doctor_codex_probe_not_started'
  | 'doctor_codex_probe_stage'
  | 'doctor_codex_last_known_value'
  | 'doctor_codex_no_last_known_value'
  | 'doctor_codex_protocol_drift'
  | 'doctor_codex_probe_stale'
  | 'doctor_codex_probe_degraded';

export type NativeSourceDoctorFactValue = string | number | boolean;

export interface NativeSourceDoctorFact {
  readonly name: string;
  readonly value: NativeSourceDoctorFactValue;
}

export interface NativeSourceDoctorFinding {
  readonly ruleId: NativeSourceDoctorRuleId;
  readonly severity: NativeSourceDoctorSeverity;
  readonly title: string;
  readonly message: string;
  readonly action?: string;
  readonly facts?: readonly NativeSourceDoctorFact[];
}

export interface NativeSourceDoctorProviderReport {
  readonly provider: NativeSourceDoctorProviderId;
  readonly displayName: string;
  readonly visible: boolean;
  readonly findings: readonly NativeSourceDoctorFinding[];
}

export interface NativeSourceDoctorHostReport {
  readonly remoteKind: 'local' | 'remote';
  readonly remoteLabel?: string;
  readonly claudeSnapshotScope: NativeSourceDoctorSettingsScope;
  readonly codexProbeScope: NativeSourceDoctorSettingsScope;
}

export interface NativeSourceDoctorReport {
  readonly generatedAtMs: number;
  readonly host: NativeSourceDoctorHostReport;
  readonly providers: readonly NativeSourceDoctorProviderReport[];
}

export interface NativeSourceDoctorRenderedReport {
  readonly heading: string;
  readonly body: string;
}

const SEVERITY_RANK: Readonly<Record<NativeSourceDoctorSeverity, number>> = {
  ok: 0,
  info: 1,
  warning: 2,
  blocked: 3,
};

export function highestNativeSourceDoctorSeverity(
  findings: readonly NativeSourceDoctorFinding[],
): NativeSourceDoctorSeverity {
  let highest: NativeSourceDoctorSeverity = 'ok';
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest]) {
      highest = finding.severity;
    }
  }
  return highest;
}
