import { readStatsCacheCandidates as defaultReadStatsCacheCandidates } from '../../adapters/claudeCode/ClaudeStatsCacheSource';
import type { IdHasher } from '../../security/IdHasher';
import {
  readSnapshotDirectoryCandidate,
  type SnapshotDirEntry,
  type SnapshotDirectoryStatus,
} from '../cockpit/readSnapshotDirectory';
import {
  readStatuslineSnapshotCandidate,
  type StatuslineSnapshotStatus,
} from '../cockpit/readStatuslineSnapshot';
import type { SourceCandidate } from '../cockpit/SourcePriorityResolver';
import type { NativeSourceDoctorFinding, NativeSourceDoctorProviderReport } from './types';

export interface ClaudeNativeSourceDoctorInput {
  readonly visible: boolean;
  readonly configuredLocation?: string;
  readonly statsCacheLocation?: string;
  readonly readFile: (location: string) => string;
  readonly isDirectory: (location: string) => boolean;
  readonly listDir: (location: string) => readonly SnapshotDirEntry[];
  readonly join: (...parts: string[]) => string;
  readonly hasher: IdHasher;
  readonly now: () => Date;
  readonly readStatsCacheCandidates?: typeof defaultReadStatsCacheCandidates;
}

function windowsOf(candidate: SourceCandidate | undefined): string {
  if (candidate === undefined) return 'none';
  const windows: string[] = [];
  if (candidate.session?.usedPct !== undefined) windows.push('short');
  if (candidate.weekly?.usedPct !== undefined) windows.push('weekly');
  return windows.length > 0 ? windows.join(', ') : 'none';
}

function singleFileFinding(
  status: StatuslineSnapshotStatus,
  candidate: SourceCandidate | undefined,
): NativeSourceDoctorFinding {
  const facts = [{ name: 'snapshot mode', value: 'single file' }];
  switch (status) {
    case 'statusline_snapshot_loaded':
      return {
        ruleId: 'doctor_claude_snapshot_loaded',
        severity: 'ok',
        title: 'Claude statusLine snapshot is readable',
        message: 'The configured snapshot parsed safely and exposes recognized limit windows.',
        facts: [...facts, { name: 'recognized windows', value: windowsOf(candidate) }],
      };
    case 'statusline_snapshot_missing':
      return {
        ruleId: 'doctor_claude_snapshot_missing',
        severity: 'warning',
        title: 'Claude statusLine snapshot is missing or unreadable',
        message: 'TokenGauge could not read the configured snapshot source.',
        action:
          'Confirm Claude Code is running the statusLine writer and that TokenGauge points to the snapshot output.',
        facts,
      };
    case 'statusline_snapshot_parse_failed':
      return {
        ruleId: 'doctor_claude_snapshot_parse_failed',
        severity: 'blocked',
        title: 'Claude statusLine snapshot was rejected',
        message: 'The snapshot could not be parsed as a safe supported native status structure.',
        action:
          'Validate the configured writer with node --check and recreate the snapshot from Claude Code statusLine.',
        facts,
      };
    case 'statusline_snapshot_missing_rate_limits':
      return {
        ruleId: 'doctor_claude_snapshot_missing_rate_limits',
        severity: 'warning',
        title: 'Claude statusLine snapshot has no limit windows yet',
        message:
          'The snapshot is safe, but Claude Code did not report 5h or weekly rate-limit fields.',
        action:
          'Send a Claude Code response in a CLI session and wait for the statusLine writer to refresh.',
        facts: [...facts, { name: 'recognized windows', value: 'none' }],
      };
  }
}

function directoryFinding(
  status: SnapshotDirectoryStatus,
  activeWriters: number,
  candidate: SourceCandidate | undefined,
): NativeSourceDoctorFinding {
  const facts = [
    { name: 'snapshot mode', value: 'directory' },
    { name: 'active writers', value: activeWriters },
  ];
  switch (status) {
    case 'snapshot_dir_loaded':
      return {
        ruleId: 'doctor_claude_snapshot_directory_loaded',
        severity: 'ok',
        title: 'Claude snapshot directory has one active writer',
        message:
          'A recent per-session snapshot parsed safely and exposes recognized limit windows.',
        facts: [...facts, { name: 'recognized windows', value: windowsOf(candidate) }],
      };
    case 'snapshot_dir_missing_rate_limits':
      return {
        ruleId: 'doctor_claude_snapshot_directory_missing_rate_limits',
        severity: 'warning',
        title: 'Claude snapshot directory has no limit windows yet',
        message:
          'A recent per-session snapshot parsed safely, but it did not report rate-limit fields.',
        action:
          'Send a Claude Code response in the active CLI session and wait for the statusLine writer to refresh.',
        facts,
      };
    case 'snapshot_dir_multi_writer':
      return {
        ruleId: 'doctor_claude_snapshot_directory_multi_writer',
        severity: 'warning',
        title: 'Multiple active Claude statusLine writers are visible',
        message:
          'TokenGauge will show a conservative account-level limit state and mute session-specific fields.',
        action:
          'Close idle Claude Code sessions or use per-session snapshots intentionally when multiple sessions are active.',
        facts: [...facts, { name: 'recognized windows', value: windowsOf(candidate) }],
      };
    case 'snapshot_dir_no_active_writer':
      return {
        ruleId: 'doctor_claude_snapshot_directory_no_active_writer',
        severity: 'warning',
        title: 'No active Claude statusLine writer is visible',
        message:
          'No recently refreshed per-session snapshot matched the supported snapshot naming contract.',
        action: 'Start or focus a Claude Code CLI session using the documented statusLine writer.',
        facts,
      };
    case 'snapshot_dir_unreadable':
      return {
        ruleId: 'doctor_claude_snapshot_directory_unreadable',
        severity: 'blocked',
        title: 'Claude snapshot directory is unreadable',
        message: 'TokenGauge could not list the configured snapshot directory.',
        action:
          'Confirm TokenGauge is configured from the same local, WSL, SSH, or container side as Claude Code.',
        facts,
      };
  }
}

function statsCacheFinding(input: ClaudeNativeSourceDoctorInput): NativeSourceDoctorFinding {
  if (input.statsCacheLocation === undefined) {
    return {
      ruleId: 'doctor_claude_stats_cache_unavailable',
      severity: 'info',
      title: 'Claude stats-cache check was skipped',
      message: 'No stats-cache location was supplied to the Doctor.',
    };
  }
  const reader = input.readStatsCacheCandidates ?? defaultReadStatsCacheCandidates;
  const candidates = reader(input.statsCacheLocation, { now: input.now });
  if (candidates.length === 0) {
    return {
      ruleId: 'doctor_claude_stats_cache_unavailable',
      severity: 'info',
      title: 'Claude stats-cache cost/model data is unavailable',
      message:
        'This does not block limit gauges; it only means optional cost/model detail is not available from stats-cache.',
      facts: [{ name: 'candidate count', value: 0 }],
    };
  }
  return {
    ruleId: 'doctor_claude_stats_cache_loaded',
    severity: 'ok',
    title: 'Claude stats-cache cost/model data is readable',
    message:
      'Stats-cache produced sanitized cost/model candidates without exposing session details.',
    facts: [{ name: 'candidate count', value: candidates.length }],
  };
}

export function checkClaudeNativeSource(
  input: ClaudeNativeSourceDoctorInput,
): NativeSourceDoctorProviderReport {
  const findings: NativeSourceDoctorFinding[] = [];
  if (!input.visible) {
    return {
      provider: 'claude',
      displayName: 'Claude Code',
      visible: false,
      findings: [
        {
          ruleId: 'doctor_claude_card_hidden',
          severity: 'info',
          title: 'Claude card is hidden',
          message:
            'TokenGauge does not read Claude statusLine or stats-cache surfaces while the Claude card is hidden.',
          action: 'Use Configure Cockpit to show the Claude card before diagnosing Claude setup.',
        },
      ],
    };
  }

  const configured = input.configuredLocation?.trim() ?? '';
  if (configured.length === 0) {
    findings.push({
      ruleId: 'doctor_claude_snapshot_not_configured',
      severity: 'warning',
      title: 'Claude statusLine snapshot is not configured',
      message: 'TokenGauge has no Claude statusLine snapshot source to read.',
      action:
        'Run TokenGauge: Configure Cockpit and set the Claude statusLine snapshot output location.',
    });
  } else if (input.isDirectory(configured)) {
    const result = readSnapshotDirectoryCandidate(configured, input);
    findings.push(directoryFinding(result.status, result.activeWriters, result.candidate));
  } else {
    const result = readStatuslineSnapshotCandidate(configured, input);
    findings.push(singleFileFinding(result.status, result.candidate));
  }

  findings.push(statsCacheFinding(input));
  return { provider: 'claude', displayName: 'Claude Code', visible: true, findings };
}
