// Read the opt-in Claude statusLine snapshot with EXPLICIT,
// sanitized status outcomes instead of a silent empty catch. A swallowed parse
// failure previously let the report fall back to stats-cache while still
// labelling it a statusLine snapshot — the failure must be surfaced.
//
// Pure + injected I/O so it is unit-testable and carries NO raw path / raw
// session id in any returned status. The caller maps the status to a sanitized
// diagnostic (rule id + status only).

import type { IdHasher } from '../../security/IdHasher';
import { snapshotToCockpitCandidate } from './ClaudeStatuslineCockpitSource';
import type { SourceCandidate } from './SourcePriorityResolver';

export type StatuslineSnapshotStatus =
  | 'statusline_snapshot_loaded'
  | 'statusline_snapshot_missing'
  | 'statusline_snapshot_parse_failed'
  | 'statusline_snapshot_missing_rate_limits';

export interface StatuslineSnapshotReadResult {
  readonly status: StatuslineSnapshotStatus;
  // Present for 'loaded' and 'missing_rate_limits' (cost/model still usable).
  readonly candidate?: SourceCandidate;
}

export interface ReadStatuslineSnapshotDeps {
  // Reads the file as UTF-8; MUST throw when the file is absent/unreadable. The
  // path is never echoed into the result.
  readonly readFile: (path: string) => string;
  readonly hasher: IdHasher;
  readonly now: () => Date;
}

export function readStatuslineSnapshotCandidate(
  path: string,
  deps: ReadStatuslineSnapshotDeps,
): StatuslineSnapshotReadResult {
  let raw: string;
  try {
    raw = deps.readFile(path);
  } catch {
    return { status: 'statusline_snapshot_missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'statusline_snapshot_parse_failed' };
  }

  let candidate: SourceCandidate;
  try {
    candidate = snapshotToCockpitCandidate(parsed, { hasher: deps.hasher, now: deps.now });
  } catch {
    // Schema rejection (leaky payload) or guard trip — surfaced, not swallowed.
    return { status: 'statusline_snapshot_parse_failed' };
  }

  if (candidate.session === undefined && candidate.weekly === undefined) {
    // Parsed and safe, but no rate-limit windows — cost/model still usable.
    return {
      status: 'statusline_snapshot_missing_rate_limits',
      candidate: { ...candidate, unavailableReason: 'statusline_snapshot_missing_rate_limits' },
    };
  }
  return { status: 'statusline_snapshot_loaded', candidate };
}
