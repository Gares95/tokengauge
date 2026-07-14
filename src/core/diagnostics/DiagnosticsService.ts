// Sanitized diagnostics recorder. Stores rule IDs, statuses, and
// redacted paths/details only — never matched sentinel values. An optional
// OutputChannel sink mirrors the cockpit-diagnostics text style.
//
// No imports from UsageStore, SecretManager, IdHasher, cost, or tokenizers —
// dependent modules must consume this service without circular imports.

import { Redactor } from '../../security/Redactor';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface DiagnosticsEntryInput {
  readonly ruleId: string;
  readonly status: string;
  readonly severity: DiagnosticSeverity;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DiagnosticsEntry {
  readonly ruleId: string;
  readonly status: string;
  readonly severity: DiagnosticSeverity;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

// Minimal structural typing for vscode.OutputChannel so this module can be
// imported and unit-tested without the vscode runtime.
export interface DiagnosticsOutputChannelLike {
  appendLine(value: string): void;
}

// The cockpit poll/watch loop records on every tick. Cap the
// in-memory history to a finite ring buffer so a long-running session cannot
// grow memory unbounded; on overflow the oldest entry is dropped.
export const DIAGNOSTICS_MAX_ENTRIES = 500;

// Per-ruleId rollup for the bounded, on-demand report. Counts +
// latest status/severity/timestamp only — never a raw path, id, or payload.
export interface DiagnosticsRuleSummary {
  readonly ruleId: string;
  readonly count: number;
  readonly latestStatus: string;
  readonly latestSeverity: DiagnosticSeverity;
  readonly latestTimestamp: string;
}

export interface DiagnosticsSummary {
  readonly total: number;
  readonly rules: readonly DiagnosticsRuleSummary[];
}

export interface DiagnosticsServiceOptions {
  readonly outputChannel?: DiagnosticsOutputChannelLike;
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  // Opt-in live OutputChannel mirroring. OFF by default so the
  // cockpit loop's per-tick record() never floods the Output panel. The bounded
  // on-demand report (summary) is the supported diagnostics surface.
  readonly live?: boolean;
}

export class DiagnosticsService {
  private readonly entriesList: DiagnosticsEntry[] = [];
  private readonly outputChannel?: DiagnosticsOutputChannelLike;
  private readonly redactor: Redactor;
  private readonly now: () => Date;
  private readonly live: boolean;

  public constructor(options: DiagnosticsServiceOptions = {}) {
    this.outputChannel = options.outputChannel;
    this.redactor = options.redactor ?? new Redactor();
    this.now = options.now ?? (() => new Date());
    this.live = options.live === true;
  }

  public record(input: DiagnosticsEntryInput): void {
    const sanitizedPath =
      input.path !== undefined ? this.redactor.redactString(input.path) : undefined;
    const sanitizedDetails =
      input.details !== undefined
        ? (this.redactor.redactSerializable(input.details) as Readonly<Record<string, unknown>>)
        : undefined;

    const entry: DiagnosticsEntry = Object.freeze({
      ruleId: input.ruleId,
      status: input.status,
      severity: input.severity,
      path: sanitizedPath,
      details: sanitizedDetails !== undefined ? Object.freeze({ ...sanitizedDetails }) : undefined,
      timestamp: this.now().toISOString(),
    });

    this.entriesList.push(entry);
    if (this.entriesList.length > DIAGNOSTICS_MAX_ENTRIES) {
      this.entriesList.shift();
    }

    // Live per-record mirroring is opt-in. By default the loop's
    // per-tick records never reach the OutputChannel — the bounded summary is the
    // supported surface.
    if (this.live && this.outputChannel) {
      this.emitToOutputChannel(entry);
    }
  }

  public entries(): readonly DiagnosticsEntry[] {
    return this.entriesList.slice();
  }

  // Finite, deduplicated, counted snapshot for the on-demand
  // report. Rule-id + status/severity/timestamp only — no raw path/details. The
  // returned shape is the same regardless of how many ticks were recorded, so
  // repeated invocations never produce an ever-growing stream.
  public summary(): DiagnosticsSummary {
    const byRule = new Map<string, { count: number; latest: DiagnosticsEntry }>();
    for (const entry of this.entriesList) {
      const existing = byRule.get(entry.ruleId);
      if (existing === undefined) {
        byRule.set(entry.ruleId, { count: 1, latest: entry });
      } else {
        existing.count += 1;
        existing.latest = entry; // entriesList is append-ordered; last wins.
      }
    }

    const rules: DiagnosticsRuleSummary[] = [];
    for (const [ruleId, { count, latest }] of byRule) {
      rules.push({
        ruleId,
        count,
        latestStatus: latest.status,
        latestSeverity: latest.severity,
        latestTimestamp: latest.timestamp,
      });
    }
    rules.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));

    return { total: this.entriesList.length, rules };
  }

  private emitToOutputChannel(entry: DiagnosticsEntry): void {
    if (!this.outputChannel) {
      return;
    }
    const pathFragment = entry.path !== undefined ? ` path=${entry.path}` : '';
    this.outputChannel.appendLine(
      `[tokengauge:diagnostics] rule=${entry.ruleId} status=${entry.status} severity=${entry.severity}${pathFragment}`,
    );
    if (entry.details !== undefined) {
      // JSON.stringify the already-redacted details. Redaction happened in
      // record(); this is purely a formatting concern for the OutputChannel.
      this.outputChannel.appendLine(
        `[tokengauge:diagnostics]   details=${JSON.stringify(entry.details)}`,
      );
    }
  }
}
