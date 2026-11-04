// Per-session snapshot DIRECTORY mode for the Claude
// statusLine bridge.
//
// WHY: a single last-writer-wins snapshot file cannot prove that a second,
// idle-but-open Claude Code session exists — once interleaved writes stop, the
// file only ever shows the latest writer, so any single-file detector must
// eventually clear its multi-writer state (UAT: the warning vanished while two
// sessions were still open, and session-specific model/context/cost came back).
// The fix is a real per-session signal: the SAME `tokenGauge.claude.
// statuslineSnapshotPath` setting may point at a DIRECTORY into which the
// user's statusLine script writes ONE snapshot file per session
// (`<workspace_hash>-<session_id_hash>.json`, atomic rename). Each open session
// refreshes its own file on every statusLine update, so "how many sessions are
// active" becomes a bounded mtime check — no interleave inference needed.
//
// Privacy / scope guarantees:
//  - ONLY the explicitly configured directory is listed — never a `.claude`
//    root, never recursive, never another location.
//  - Only files matching the strict hash-derived name pattern are read, capped
//    at MAX_SNAPSHOT_FILES (more than that is reported, never partially
//    inspected); filenames carry HASHES (the writer derives them),
//    never raw paths or raw session ids, and no filename is ever surfaced in
//    UI/diagnostics (statuses are closed strings; the count is not identity).
//  - Every file body goes through the SAME strict `.strict()` snapshot schema,
//    hashing, and Redactor backstop as single-file mode
//    (snapshotToCockpitCandidate) — a leaky payload fails closed per file.
//  - No log/transcript/prompt parsing; these are the same statusLine snapshots,
//    just one per session.
//
// Pure: filesystem access is injected (listDir/readFile/join); the module does
// no I/O of its own and is fully unit-testable.

import type { IdHasher } from '../../security/IdHasher';
import { snapshotToCockpitCandidate } from './ClaudeStatuslineCockpitSource';
import type { SourceCandidate } from './SourcePriorityResolver';

// How recently a per-session snapshot must have been rewritten (mtime) for its
// session to count as an ACTIVE writer. Claude Code refreshes the statusLine
// every few seconds while a session is open (the owner's config uses 5s), so
// 90s is ~18 refresh intervals of margin — tolerant of throttling — while
// keeping close-a-session recovery consistent with the single-file interleave
// window ("clears within about a minute and a half"). Every tick re-evaluates
// mtimes, so a manual Refresh prunes expired writers immediately.
export const ACTIVE_WRITER_TTL_MS = 90_000;

// Hard cap on per-session files considered per tick — bounds I/O and rules out
// unbounded directory scans by construction. A directory holding MORE
// pattern-matching names than this is reported as `snapshot_dir_too_many_files`
// rather than inspected partially: without stat'ing every candidate there is
// no way to know which files are newest, and an arbitrary (readdir-order)
// subset can silently hide a live session.
export const MAX_SNAPSHOT_FILES = 32;

// The ONLY filenames directory mode will read: `<hex>-<hex>.json`, both parts
// hash-derived by the writer (workspace hash + session id hash). Anything else
// in the directory is ignored, unread.
export const SNAPSHOT_FILE_PATTERN = /^[0-9a-f]{8,64}-[0-9a-f]{8,64}\.json$/;

export interface SnapshotDirEntry {
  readonly name: string;
  readonly mtimeMs: number;
}

// A bounded listing of the configured directory. `overCapacity` is true when
// the directory holds more pattern-matching names than MAX_SNAPSHOT_FILES; the
// lister then stats nothing and `entries` is empty.
export interface SnapshotDirListing {
  readonly entries: readonly SnapshotDirEntry[];
  readonly overCapacity: boolean;
}

// The narrow per-entry stat shape the lister needs (node's Stats satisfies it).
export interface SnapshotDirEntryStat {
  isFile(): boolean;
  readonly mtimeMs: number;
}

export interface ListSnapshotDirectoryDeps {
  // Names in ONE directory, non-recursive. MUST throw when unreadable.
  readonly readdir: (path: string) => readonly string[];
  // Stats one entry WITHOUT following symlinks (lstat semantics), so a
  // symlinked entry is not a plain file and is skipped. May throw when the
  // entry vanished mid-listing.
  readonly statEntry: (path: string) => SnapshotDirEntryStat;
  readonly join: (...parts: string[]) => string;
}

// The single bounded directory lister shared by the cockpit and the Source
// Doctor. Pattern-filters names BEFORE any stat, refuses to inspect a partial
// subset when more snapshot names exist than the cap, and keeps only plain
// files (never symlinks). Throws only when the directory cannot be listed.
export function listSnapshotDirectory(
  dirPath: string,
  deps: ListSnapshotDirectoryDeps,
): SnapshotDirListing {
  const names = deps.readdir(dirPath).filter((name) => SNAPSHOT_FILE_PATTERN.test(name));
  if (names.length > MAX_SNAPSHOT_FILES) {
    return { entries: [], overCapacity: true };
  }
  const entries: SnapshotDirEntry[] = [];
  for (const name of names) {
    try {
      const st = deps.statEntry(deps.join(dirPath, name));
      if (st.isFile()) entries.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // per-file races (deleted mid-list) fail closed for that file
    }
  }
  return { entries, overCapacity: false };
}

export type SnapshotDirectoryStatus =
  // The directory could not be listed (deleted / permissions) — treated like a
  // missing snapshot so the gate's after-valid retention applies.
  | 'snapshot_dir_unreadable'
  // More hash-named snapshot files than MAX_SNAPSHOT_FILES: the bounded
  // inspection cannot tell which sessions are active, so no value is offered
  // (never a guess from an arbitrary subset). TokenGauge never deletes files.
  | 'snapshot_dir_too_many_files'
  // No per-session file was rewritten within the active TTL (all sessions
  // closed/idle-beyond-TTL, or none ever wrote) — no active writer.
  | 'snapshot_dir_no_active_writer'
  // Exactly one active writer with usable rate-limit windows — the Live path.
  | 'snapshot_dir_loaded'
  // Exactly one active writer but its snapshot carries no rate-limit windows
  // (pre-first-response) — mirrors single-file missing_rate_limits.
  | 'snapshot_dir_missing_rate_limits'
  // Two or more active writers — the merged conservative multi-writer state.
  | 'snapshot_dir_multi_writer';

export interface SnapshotDirectoryReadResult {
  readonly status: SnapshotDirectoryStatus;
  readonly candidate?: SourceCandidate;
  // How many active per-session snapshots parsed cleanly this tick. A bounded
  // small integer — carries no identity.
  readonly activeWriters: number;
}

export interface ReadSnapshotDirectoryDeps {
  // Lists the configured directory's plain files (name + mtime). MUST throw (or
  // be undefined-safe at the call site) when the directory is unreadable. The
  // production lister (listSnapshotDirectory) already pattern-filters and
  // enforces the cap, but this module re-applies both — defence in depth, and
  // the pure tests exercise it with plain entry arrays.
  readonly listDir: (path: string) => readonly SnapshotDirEntry[] | SnapshotDirListing;
  readonly readFile: (path: string) => string;
  readonly join: (...parts: string[]) => string;
  readonly hasher: IdHasher;
  readonly now: () => Date;
}

function windowOf(
  c: SourceCandidate,
  metric: 'session' | 'weekly',
): { usedPct?: number; leftPct?: number; resetsAt?: string } | undefined {
  return metric === 'session' ? c.session : c.weekly;
}

function resetMsOf(resetsAt: string | undefined): number | undefined {
  if (typeof resetsAt !== 'string' || resetsAt.length === 0) return undefined;
  const ms = Date.parse(resetsAt);
  return Number.isNaN(ms) ? undefined : ms;
}

// Deterministic conservative account-level merge for one metric across the
// active writers: the NEWEST parseable reset window wins (a stale pre-reset
// cache can never mask a post-reset window — same time-ordering rule as the
// stability gate), and within that window usedPct is the MAX / leftPct the MIN
// seen. Writers with no parseable resetsAt only compete when NO writer has one
// (then all are treated as the same window).
function mergeMetric(
  candidates: readonly SourceCandidate[],
  metric: 'session' | 'weekly',
): { usedPct?: number; leftPct?: number; resetsAt?: string } | undefined {
  const windows = candidates
    .map((c) => windowOf(c, metric))
    .filter((w): w is NonNullable<typeof w> => w !== undefined && w.usedPct !== undefined);
  if (windows.length === 0) return undefined;

  const newestResetMs = windows.reduce<number | undefined>((acc, w) => {
    const ms = resetMsOf(w.resetsAt);
    if (ms === undefined) return acc;
    return acc === undefined || ms > acc ? ms : acc;
  }, undefined);

  const group =
    newestResetMs === undefined
      ? windows
      : windows.filter((w) => resetMsOf(w.resetsAt) === newestResetMs);

  const usedPct = group.reduce<number>((acc, w) => Math.max(acc, w.usedPct as number), 0);
  const leftPct = group.reduce<number | undefined>((acc, w) => {
    if (w.leftPct === undefined) return acc;
    return acc === undefined ? w.leftPct : Math.min(acc, w.leftPct);
  }, undefined);
  const resetsAt = group.find((w) => resetMsOf(w.resetsAt) === newestResetMs)?.resetsAt;

  return {
    usedPct,
    ...(leftPct !== undefined ? { leftPct } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

// Merge >=2 active writers into ONE conservative multi-writer candidate. The
// account-level 5h/weekly windows stay visible (conservative); the
// SESSION-SPECIFIC fields — model, context, cost, and the identity hashes —
// are intentionally OMITTED: with several live sessions they belong to no one
// session, and the card must not present one session's values as the truth.
function mergeActiveWriters(
  candidates: readonly SourceCandidate[],
  nowMs: number,
): SourceCandidate {
  const session = mergeMetric(candidates, 'session');
  const weekly = mergeMetric(candidates, 'weekly');
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: nowMs,
    scope: { provider: 'anthropic', agent: 'claude-code' },
    confidence: 'high',
    ...(session !== undefined ? { session } : {}),
    ...(weekly !== undefined ? { weekly } : {}),
    unavailableReason: 'snapshot_writer_collision',
  };
}

export function readSnapshotDirectoryCandidate(
  dirPath: string,
  deps: ReadSnapshotDirectoryDeps,
): SnapshotDirectoryReadResult {
  const nowMs = deps.now().getTime();

  let listing: SnapshotDirListing;
  try {
    const listed = deps.listDir(dirPath);
    listing = 'overCapacity' in listed ? listed : { entries: listed, overCapacity: false };
  } catch {
    return { status: 'snapshot_dir_unreadable', activeWriters: 0 };
  }

  // Strict pattern + cap. Exceeding the cap is reported, never truncated: a
  // truncated listing could omit a live session's file.
  const matching = listing.entries.filter((e) => SNAPSHOT_FILE_PATTERN.test(e.name));
  if (listing.overCapacity || matching.length > MAX_SNAPSHOT_FILES) {
    return { status: 'snapshot_dir_too_many_files', activeWriters: 0 };
  }

  // TTL, newest first.
  const active = matching
    .filter((e) => nowMs - e.mtimeMs <= ACTIVE_WRITER_TTL_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const parsed: SourceCandidate[] = [];
  for (const entry of active) {
    // A torn/mid-rename or leaky file fails closed for THIS file only — it is
    // not counted as a writer this tick (it will parse on the next rewrite).
    try {
      const raw = deps.readFile(deps.join(dirPath, entry.name));
      parsed.push(
        snapshotToCockpitCandidate(JSON.parse(raw), { hasher: deps.hasher, now: deps.now }),
      );
    } catch {
      // skip — per-file fail-closed
    }
  }

  if (parsed.length === 0) {
    return { status: 'snapshot_dir_no_active_writer', activeWriters: 0 };
  }

  if (parsed.length === 1) {
    const candidate = parsed[0] as SourceCandidate;
    const valueless = candidate.session === undefined && candidate.weekly === undefined;
    return {
      status: valueless ? 'snapshot_dir_missing_rate_limits' : 'snapshot_dir_loaded',
      candidate: valueless
        ? { ...candidate, unavailableReason: 'statusline_snapshot_missing_rate_limits' }
        : candidate,
      activeWriters: 1,
    };
  }

  return {
    status: 'snapshot_dir_multi_writer',
    candidate: mergeActiveWriters(parsed, nowMs),
    activeWriters: parsed.length,
  };
}
