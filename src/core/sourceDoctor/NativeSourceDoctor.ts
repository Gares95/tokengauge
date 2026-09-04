import {
  type ClaudeNativeSourceDoctorInput,
  checkClaudeNativeSource,
} from './checkClaudeNativeSource';
import {
  type CodexNativeSourceDoctorInput,
  checkCodexNativeSource,
} from './checkCodexNativeSource';
import type {
  NativeSourceDoctorProviderReport,
  NativeSourceDoctorReport,
  NativeSourceDoctorSettingsScope,
} from './types';

export interface BuildNativeSourceDoctorReportInput {
  readonly generatedAtMs: number;
  readonly remoteLabel?: string;
  readonly claudeSnapshotScope: NativeSourceDoctorSettingsScope;
  readonly codexProbeScope: NativeSourceDoctorSettingsScope;
  readonly claude: ClaudeNativeSourceDoctorInput;
  readonly codex: CodexNativeSourceDoctorInput;
}

function normalizedRemoteLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export function buildNativeSourceDoctorReport(
  input: BuildNativeSourceDoctorReportInput,
): NativeSourceDoctorReport {
  const remoteLabel = normalizedRemoteLabel(input.remoteLabel);
  const providers: NativeSourceDoctorProviderReport[] = [
    checkClaudeNativeSource(input.claude),
    checkCodexNativeSource(input.codex),
  ];
  return {
    generatedAtMs: input.generatedAtMs,
    host: {
      remoteKind: remoteLabel === undefined ? 'local' : 'remote',
      ...(remoteLabel !== undefined ? { remoteLabel } : {}),
      claudeSnapshotScope: input.claudeSnapshotScope,
      codexProbeScope: input.codexProbeScope,
    },
    providers,
  };
}
