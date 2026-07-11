// The per-agent native candidate
// assembly for the live cockpit. This is the gatherCandidates seam the
// NativeStatusRefreshLoop calls every tick.
//
// It uses the SAME native readers used across the native cockpit
// (readStatsCacheCandidates + readStatuslineSnapshotCandidate) — NO conversation
// log scanning, NO UsageStore/UsageSnapshotService data. The Codex
// probe is NOT gathered here: the loop owns the consent + cadence gating and
// supplies the gated probe via its separate runProbe seam.
//
// Snapshot path:
//   1. tokenGauge.claude.statuslineSnapshotPath (non-empty) →
//      a) points at a DIRECTORY → per-session snapshot mode (active-writer
//         fix): one file per session, bounded strict-pattern listing, active
//         writers counted by mtime TTL — see readSnapshotDirectory.ts;
//      b) points at a FILE → the legacy single-snapshot mode (EXACT file).
//   2. else NO path — the Claude candidates resolve to the honest blocker reason
//      `statusline_snapshot_not_configured` (a `sourceTier: 'unknown'` candidate,
//      never a fabricated gauge).
//
// Diagnostics are rule-id-only ('statusline-snapshot' ruleId): the raw path is
// NEVER recorded.

import { readStatsCacheCandidates } from '../adapters/claudeCode/ClaudeStatsCacheSource';
import type { CockpitFieldReason } from '../core/cockpit/CockpitState';
import {
  readSnapshotDirectoryCandidate,
  type SnapshotDirEntry,
} from '../core/cockpit/readSnapshotDirectory';
import { readStatuslineSnapshotCandidate } from '../core/cockpit/readStatuslineSnapshot';
import type { SourceCandidate } from '../core/cockpit/SourcePriorityResolver';
import type { IdHasher } from '../security/IdHasher';

// Re-exported so the production wiring (extension.ts) can pattern-filter and
// cap the directory listing before stat'ing, using the single source of truth.
export {
  ACTIVE_WRITER_TTL_MS,
  MAX_SNAPSHOT_FILES,
  SNAPSHOT_FILE_PATTERN,
} from '../core/cockpit/readSnapshotDirectory';

const STATUSLINE_NOT_CONFIGURED: CockpitFieldReason = 'statusline_snapshot_not_configured';
const CODEX_PROBE_DISABLED: CockpitFieldReason = 'codex_probe_disabled';

// A blocker candidate carrying ONLY the specific closed-set reason. No
// session/weekly → it never competes for a value; the builder reads its
// `unavailableReason` to surface the honest card reason.
function blocker(
  provider: SourceCandidate['scope']['provider'],
  agent: SourceCandidate['scope']['agent'],
  reason: CockpitFieldReason,
): SourceCandidate {
  return {
    sourceTier: 'unknown',
    producedAtMs: 0,
    scope: { provider, agent },
    unavailableReason: reason,
  };
}

export interface CockpitGatherDiagnosticsLike {
  record(entry: {
    readonly ruleId: string;
    readonly status: string;
    readonly severity: 'info' | 'warning' | 'error';
    readonly details?: Readonly<Record<string, unknown>>;
  }): void;
}

export interface GatherNativeCockpitCandidatesDeps {
  // Display visibility. Defaults preserve prior behavior for existing
  // callers/tests. When hidden, the cockpit gather path skips that provider's
  // native work instead of reading/probing for a card that will not render.
  readonly claudeVisible?: boolean;
  readonly codexVisible?: boolean;
  // The resolved EXACT statusLine snapshot path (precedence already applied), or
  // undefined when neither setting yields a usable path → the not-configured
  // blocker is emitted.
  readonly statuslineSnapshotPath: string | undefined;
  // The ~/.claude/stats-cache.json path (native token-detail source).
  readonly statsCachePath: string;
  readonly hasher: IdHasher;
  readonly now: () => Date;
  // Injected so the gatherer stays filesystem-free and unit-testable; production
  // supplies a synchronous UTF-8 read that THROWS on a missing/unreadable file.
  readonly readFile: (path: string) => string;
  // Per-session directory mode (all three optional — absent means the
  // gatherer treats the configured path as a single file, exactly as before):
  // isDirectory answers "does the configured path point at a directory?"
  // (false on missing path); listDir lists the configured directory's plain
  // files (name + mtimeMs), throwing when unreadable; join builds the per-file
  // path for readFile.
  readonly isDirectory?: (path: string) => boolean;
  readonly listDir?: (path: string) => readonly SnapshotDirEntry[];
  readonly join?: (...parts: string[]) => string;
  readonly readStatsCache?: typeof readStatsCacheCandidates;
  readonly diagnostics?: CockpitGatherDiagnosticsLike;
  // Effective Codex probe permission after user opt-in and card-visibility
  // gates. When false the gatherer emits the codex_probe_disabled blocker so the
  // Codex card is honest on EVERY refresh — independent of the loop's probe
  // cadence (the loop never invokes runProbe when disabled, so the disabled card
  // must originate here). When true the loop's runProbe supplies the live codex
  // candidate (or a probe-failure blocker), which the resolver ranks above any
  // blocker the gatherer omits.
  readonly codexProbeEnabled: boolean;
}

// Expand ONLY a leading tilde segment (`~` or `~/...`) to the user
// home dir — Node readFileSync does not expand `~`, so a configured
// `~/.claude/.../statusline-snapshot.json` would otherwise be unreadable and the
// Claude card would show an unavailable reason instead of real gauges. A
// mid-path `~` (e.g. `/var/~weird`) is never touched. `homedir` is injected so
// the function stays filesystem-free and unit-testable.
function expandLeadingTilde(value: string, homedir?: () => string): string {
  if (homedir === undefined) {
    return value;
  }
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return homedir() + value.slice(1);
  }
  return value;
}

// Derive the EXACT statusLine snapshot path from the configured file path.
// Returns undefined when no usable path exists (→ not-configured blocker).
export function resolveStatuslineSnapshotPath(options: {
  readonly statuslineSnapshotPath: unknown;
  readonly join: (...parts: string[]) => string;
  readonly homedir?: () => string;
}): string | undefined {
  const explicit = options.statuslineSnapshotPath;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return expandLeadingTilde(explicit, options.homedir);
  }
  return undefined;
}

export function gatherNativeCockpitCandidates(
  deps: GatherNativeCockpitCandidatesDeps,
): SourceCandidate[] {
  const out: SourceCandidate[] = [];
  const claudeVisible = deps.claudeVisible ?? true;
  const codexVisible = deps.codexVisible ?? true;

  // stats-cache.json — NATIVE token-detail (stats_cache_snapshot), never log
  // ingestion, never statusline_snapshot. Fails closed to [] on absence.
  const readStatsCache = deps.readStatsCache ?? readStatsCacheCandidates;
  if (claudeVisible) {
    out.push(...readStatsCache(deps.statsCachePath, { now: deps.now }));
  }

  // Codex: when the probe is disabled the loop never spawns it, so the honest
  // codex_probe_disabled card originates HERE (every refresh, no cadence
  // dependency). When enabled the loop's runProbe supplies the live candidate and
  // this blocker is omitted so it can never mask a real value.
  if (codexVisible && !deps.codexProbeEnabled) {
    out.push(blocker('openai', 'codex', CODEX_PROBE_DISABLED));
  }

  if (!claudeVisible) {
    return out;
  }

  // statusLine snapshot — the live native limit/risk surface.
  if (deps.statuslineSnapshotPath === undefined) {
    deps.diagnostics?.record({
      ruleId: 'statusline-snapshot',
      status: STATUSLINE_NOT_CONFIGURED,
      severity: 'info',
    });
    out.push(blocker('anthropic', 'claude-code', STATUSLINE_NOT_CONFIGURED));
    return out;
  }

  // A configured path that is a DIRECTORY selects
  // per-session snapshot mode — one file per session, active writers counted by
  // mtime TTL, >=2 active writers merged into ONE conservative collision
  // candidate (see readSnapshotDirectory.ts). A file path keeps the legacy
  // single-snapshot behavior unchanged.
  const isDir = deps.isDirectory?.(deps.statuslineSnapshotPath) === true;
  if (isDir && deps.listDir !== undefined && deps.join !== undefined) {
    const dirResult = readSnapshotDirectoryCandidate(deps.statuslineSnapshotPath, {
      listDir: deps.listDir,
      readFile: deps.readFile,
      join: deps.join,
      hasher: deps.hasher,
      now: deps.now,
    });
    deps.diagnostics?.record({
      ruleId: 'statusline-snapshot',
      status: dirResult.status,
      severity:
        dirResult.status === 'snapshot_dir_loaded' ||
        dirResult.status === 'snapshot_dir_multi_writer'
          ? 'info'
          : 'warning',
    });
    if (dirResult.candidate !== undefined) {
      out.push(dirResult.candidate);
    }
    return out;
  }

  const result = readStatuslineSnapshotCandidate(deps.statuslineSnapshotPath, {
    readFile: deps.readFile,
    hasher: deps.hasher,
    now: deps.now,
  });
  deps.diagnostics?.record({
    ruleId: 'statusline-snapshot',
    status: result.status,
    severity: result.status === 'statusline_snapshot_loaded' ? 'info' : 'warning',
  });
  if (result.candidate !== undefined) {
    out.push(result.candidate);
  }
  return out;
}
