import { readStatsCacheCandidates as defaultReadStatsCacheCandidates } from '../adapters/claudeCode/ClaudeStatsCacheSource';
import type {
  CodexCliResolverLabel,
  CodexCliResolverStage,
  CodexProbeExitBucket,
  CodexProbeIoStage,
  CodexProbeStage,
} from '../adapters/codex/CodexAppServerProbe';
import type { CodexProbeRetentionDiagnosticsSnapshot } from '../cockpit/CodexProbeRetentionGate';
import {
  MAX_SNAPSHOT_FILES,
  resolveStatuslineSnapshotPath,
  SNAPSHOT_FILE_PATTERN,
} from '../cockpit/gatherNativeCockpitCandidates';
import type { CockpitLoopDiagnosticsSnapshot } from '../cockpit/NativeStatusRefreshLoop';
import {
  codexProbeVisibleForCockpit,
  resolveProviderCardVisibility,
} from '../cockpit/providerCardVisibility';
import { buildNativeSourceDoctorReport } from '../core/sourceDoctor/NativeSourceDoctor';
import type {
  NativeSourceDoctorReport,
  NativeSourceDoctorSettingsScope,
} from '../core/sourceDoctor/types';
import { IdHasher } from '../security/IdHasher';

export interface SettingInspection<T> {
  readonly defaultValue?: T;
  readonly globalValue?: T;
  readonly workspaceValue?: T;
  readonly workspaceFolderValue?: T;
}

export interface NativeSourceDoctorConfigSnapshot {
  readonly 'tokenGauge.display.cards.claude.visible': unknown;
  readonly 'tokenGauge.display.cards.codex.visible': unknown;
  readonly 'tokenGauge.providers.codex.nativeStatusProbe': unknown;
  readonly 'tokenGauge.claude.statuslineSnapshotPath': unknown;
}

export interface NativeSourceDoctorCodexState {
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

export interface NativeSourceDoctorReportBuilderDeps {
  readonly snapshot: () => NativeSourceDoctorConfigSnapshot;
  readonly getInstallSalt: () => Promise<string>;
  readonly remoteName: () => string | undefined;
  readonly inspectClaudeSnapshotScope: () => SettingInspection<string> | undefined;
  readonly inspectCodexProbeScope: () => SettingInspection<boolean> | undefined;
  readonly codexProbeState: () => NativeSourceDoctorCodexState;
  readonly now: () => Date;
  readonly homedir: () => string;
  readonly join: (...parts: string[]) => string;
  readonly readFile: (location: string) => string;
  readonly isDirectory: (location: string) => boolean;
  readonly listDir: (location: string) => readonly string[];
  readonly fileMtimeMs: (location: string) => number | undefined;
  readonly isFile: (location: string) => boolean;
  readonly readStatsCacheCandidates?: typeof defaultReadStatsCacheCandidates;
}

export function settingScopeFromInspection<T>(
  inspection: SettingInspection<T> | undefined,
): NativeSourceDoctorSettingsScope {
  if (inspection?.workspaceFolderValue !== undefined) return 'workspaceFolder';
  if (inspection?.workspaceValue !== undefined) return 'workspace';
  if (inspection?.globalValue !== undefined) return 'user';
  return 'default';
}

export async function buildNativeSourceDoctorReportFromHost(
  deps: NativeSourceDoctorReportBuilderDeps,
): Promise<NativeSourceDoctorReport> {
  const snapshot = deps.snapshot();
  const cardVisibility = resolveProviderCardVisibility({
    claude: snapshot['tokenGauge.display.cards.claude.visible'],
    codex: snapshot['tokenGauge.display.cards.codex.visible'],
  });
  const probeSettingEnabled = snapshot['tokenGauge.providers.codex.nativeStatusProbe'] === true;
  const effectiveProbeEnabled = codexProbeVisibleForCockpit(probeSettingEnabled, cardVisibility);
  const salt = await deps.getInstallSalt();
  const hasher = new IdHasher(salt);
  const statuslinePath = cardVisibility.claude
    ? resolveStatuslineSnapshotPath({
        statuslineSnapshotPath: snapshot['tokenGauge.claude.statuslineSnapshotPath'],
        join: deps.join,
        homedir: deps.homedir,
      })
    : undefined;
  const statsCachePath = cardVisibility.claude
    ? deps.join(deps.homedir(), '.claude', 'stats-cache.json')
    : undefined;
  const codexProbeScope = settingScopeFromInspection(deps.inspectCodexProbeScope());
  const claudeSnapshotScope = settingScopeFromInspection(deps.inspectClaudeSnapshotScope());
  const codexState = deps.codexProbeState();
  return buildNativeSourceDoctorReport({
    generatedAtMs: deps.now().getTime(),
    remoteLabel: deps.remoteName(),
    claudeSnapshotScope,
    codexProbeScope,
    claude: {
      visible: cardVisibility.claude,
      configuredLocation: statuslinePath,
      statsCacheLocation: statsCachePath,
      readFile: deps.readFile,
      isDirectory: deps.isDirectory,
      listDir: (location) => {
        const out: Array<{ name: string; mtimeMs: number }> = [];
        for (const name of deps.listDir(location)) {
          if (!SNAPSHOT_FILE_PATTERN.test(name)) continue;
          if (out.length >= MAX_SNAPSHOT_FILES) break;
          const child = deps.join(location, name);
          if (!deps.isFile(child)) continue;
          const mtimeMs = deps.fileMtimeMs(child);
          if (mtimeMs !== undefined) out.push({ name, mtimeMs });
        }
        return out;
      },
      join: deps.join,
      hasher,
      now: deps.now,
      readStatsCacheCandidates: deps.readStatsCacheCandidates ?? defaultReadStatsCacheCandidates,
    },
    codex: {
      visible: cardVisibility.codex,
      configuredProbeEnabled: probeSettingEnabled,
      effectiveProbeEnabled,
      effectiveScope: codexProbeScope,
      loop: codexState.loop,
      retention: codexState.retention,
      lastProbeStage: codexState.lastProbeStage,
      lastProbeIoStage: codexState.lastProbeIoStage,
      sawStderr: codexState.sawStderr,
      stdoutChunks: codexState.stdoutChunks,
      exitBucket: codexState.exitBucket,
      cliResolver: codexState.cliResolver,
      cliResolverStage: codexState.cliResolverStage,
    },
  });
}
