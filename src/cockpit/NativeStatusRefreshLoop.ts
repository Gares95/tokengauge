// the live-update loop — exact-allowlisted-file watching + mtime-poll floor +
// debounced refresh + probe-cadence gating + the resolve-and-post pipeline.
//
// The loop is COMPOSITION ONLY. It reads NO files and spawns NO processes
// itself — every side-effecting capability arrives as an injected seam supplied
// by extension.ts: the exact snapshot paths, the candidate
// gatherers, the gated probe, the config values, and the post callback. This
// keeps the module host-API-free (no `vscode` import) and fully unit-testable.
//
// The non-negotiable boundary (research Pattern 4): the watcher
// input is a single EXACT file path derived from explicit user configuration —
// never a directory, glob, or broad root. Each path is stat-checked and a
// directory is refused at the factory, degrading honestly to poll-only mode
// with a path-free diagnostic. Allowlisted native status files are not
// conversation logs — TokenGauge is native-only and reads no logs.
//
// Probe consent: ALL Codex probes are gated by
// probeEnabled — including the manual Refresh command. Manual refresh with
// probeEnabled=false refreshes file snapshots only (no spawn). With
// probeEnabled=true a manual refresh probes immediately (consent-gated, but
// cadence-exempt); a poll tick additionally requires ≥60s since the last probe.
// The 10-15s file-poll clamp and the 60s probe floor are two DISTINCT cadences.

import { stat } from 'node:fs/promises';
import * as chokidar from 'chokidar';
import type { SourceCandidate } from '../core/cockpit/SourcePriorityResolver';
import type { AgentId } from '../core/usage/UsageEvent';
import {
  buildGaugeCardViewModels as defaultBuildViewModels,
  type GaugeCardViewModel,
} from './GaugeCardViewModel';

// File-poll cadence bounds. Distinct from the probe floor below.
export const FILE_POLL_MIN_SECONDS = 10;
export const FILE_POLL_MAX_SECONDS = 15;
// Background Codex probe cadence floor.
// A poll tick may participate in a probe only after this much has elapsed.
export const PROBE_MIN_INTERVAL_MS = 60_000;
// Debounce window collapsing event bursts (atomic-rename writers emit add +
// unlink + add in quick succession — research Pitfall 6) into one refresh.
export const DEFAULT_DEBOUNCE_MS = 250;

export type RefreshTrigger = 'manual' | 'poll' | 'watch';

// Minimal structural watcher contract — chokidar v4's FSWatcher satisfies it.
// Accepting the narrow shape keeps the watch path unit-testable without real
// filesystem timing and without depending on chokidar's full type surface.
export interface CockpitWatcherLike {
  on(event: string, handler: (path: string) => void): unknown;
  close(): Promise<void> | void;
}

export type CockpitWatcherFactory = (exactPath: string) => CockpitWatcherLike;

// Record-only diagnostics sink (rule-id + path-free details only). The concrete
// DiagnosticsService satisfies it; tests substitute a recorder.
export interface CockpitRefreshDiagnosticsLike {
  record(entry: {
    readonly ruleId: string;
    readonly status: string;
    readonly severity: 'info' | 'warning' | 'error';
    readonly details?: Readonly<Record<string, unknown>>;
  }): void;
}

// The narrow stat shape we need: is this exact path actually a file? A
// directory input must never be watched (it would widen into a root scan).
export interface StatLike {
  isDirectory(): boolean;
}

export interface NativeStatusRefreshLoopOptions {
  // EXACT files only — never a directory/glob/root. Each is stat-checked before
  // a watcher is created; a directory is refused at the factory.
  readonly snapshotPaths: readonly string[];
  readonly configuredAgents: readonly AgentId[];
  // Reads the allowlisted native snapshot files and returns
  // the native candidate set. The loop never touches the filesystem.
  gatherCandidates(): Promise<readonly SourceCandidate[]>;
  // Optional gated Codex probe. Returns the probe's candidate(s)
  // to merge, or an empty array on disabled/failure (the codex card then
  // resolves to its honest unavailable reason via the builder's empty state).
  // The loop owns the consent + cadence gating; the spawn lives behind this seam.
  runProbe?(): Promise<readonly SourceCandidate[]>;
  // Effective Codex probe permission after user opt-in and card-visibility
  // gates. When false, runProbe is NEVER invoked — provably zero spawn, manual
  // included.
  readonly probeEnabled: boolean;
  // An OPTIONAL per-tick post-merge transform invoked on
  // EVERY refresh tick (poll/watch/manual) AFTER probe candidates are merged and
  // BEFORE buildViewModels. A stateful transform (the Codex retention gate) uses
  // it to keep a card stable across the intervening no-probe poll ticks that carry
  // no codex candidate. It operates on the IN-MEMORY candidate list ONLY — it must
  // NOT spawn or trigger a probe (the spawn stays gated behind runProbe, probe
  // ticks only). It is treated as TOTAL: a throw is caught, the loop falls back to
  // the untransformed merged set, records cockpit-refresh-failed, and keeps running.
  transformCandidates?(merged: readonly SourceCandidate[]): readonly SourceCandidate[];
  // 10-15s after clamping; every tick calls refresh('poll').
  readonly pollIntervalSeconds: number;
  // Seams (production defaults; tests substitute).
  readonly watcherFactory?: CockpitWatcherFactory;
  readonly statFile?: (path: string) => Promise<StatLike>;
  readonly buildViewModels?: typeof defaultBuildViewModels;
  readonly post?: (viewModels: GaugeCardViewModel[]) => void;
  readonly diagnostics?: CockpitRefreshDiagnosticsLike;
  readonly now?: () => Date;
  readonly setIntervalFn?: (fn: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
  readonly debounceMs?: number;
}

// Rule-id-only diagnostics surface. EVERY field is an enum
// rule id / trigger, a boolean, or a timestamp — NEVER a raw path, id, message,
// or any sensitive value. Safe to render in the Cockpit Diagnostics command.
export type CockpitRefreshRuleId =
  | 'cockpit-refresh-ok'
  | 'cockpit-refresh-failed'
  | 'cockpit-refresh-pending';

export interface CockpitLoopDiagnosticsSnapshot {
  readonly lastRefreshAtMs: number | undefined;
  readonly lastPostAtMs: number | undefined;
  readonly lastRefreshTrigger: RefreshTrigger | undefined;
  readonly lastRefreshRuleId: CockpitRefreshRuleId;
  readonly pollActive: boolean;
  readonly watchActive: boolean;
  readonly probeEnabled: boolean;
  // Whether the MOST RECENT manual Refresh actually
  // forced an app-server probe (the spawn-count seam). A boolean only — never a
  // count of, or payload from, any probe. False when no manual refresh has run, or
  // when the last manual refresh refreshed file snapshots only because the probe is
  // disabled (zero-spawn posture intact). Lets diagnostics confirm a Refresh truly
  // re-probed Codex (vs reusing a retained sample) WITHOUT scraping anything.
  readonly manualRefreshForcedProbe: boolean;
}

export interface NativeStatusRefreshLoopHandle {
  refresh(trigger: RefreshTrigger): Promise<void>;
  // Rule-id-only snapshot for the Cockpit Diagnostics command. No raw data.
  diagnosticsSnapshot(): CockpitLoopDiagnosticsSnapshot;
  dispose(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Default exact-file watcher (research Pattern 4). chokidar v4 watching a single
// EXACT path; ignoreInitial:false so an existing snapshot fires on startup;
// awaitWriteFinish collapses partial writes into one settled event.
function defaultWatcherFactory(exactPath: string): CockpitWatcherLike {
  return chokidar.watch(exactPath, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  }) as unknown as CockpitWatcherLike;
}

function defaultStatFile(path: string): Promise<StatLike> {
  return stat(path);
}

export function createNativeStatusRefreshLoop(
  options: NativeStatusRefreshLoopOptions,
): NativeStatusRefreshLoopHandle {
  const watcherFactory = options.watcherFactory ?? defaultWatcherFactory;
  const statFile = options.statFile ?? defaultStatFile;
  const buildViewModels = options.buildViewModels ?? defaultBuildViewModels;
  const now = options.now ?? ((): Date => new Date());
  const setIntervalFn =
    options.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const watchers: CockpitWatcherLike[] = [];
  let intervalHandle: unknown;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // Serialize refresh executions on a promise chain (ClaudeCodeAdapter pattern)
  // so overlapping triggers never interleave their gather/build/post.
  let refreshChain: Promise<void> = Promise.resolve();
  let lastProbeAt = 0;
  // A newly-created enabled loop represents activation/rebuild/opt-in. Its
  // first refresh must perform a fresh Codex probe and must not inherit a
  // previous process-local cadence floor.
  let forceProbeOnNextEnabledRefresh = options.probeEnabled;

  // Rule-id-only diagnostics state. NEVER stores a path,
  // id, or message — only timestamps, the trigger enum, and a refresh rule id.
  let lastRefreshAtMs: number | undefined;
  let lastPostAtMs: number | undefined;
  let lastRefreshTrigger: RefreshTrigger | undefined;
  let lastRefreshRuleId: CockpitRefreshRuleId = 'cockpit-refresh-pending';
  // Whether the most recent MANUAL refresh forced a probe
  // (spawn-count seam). Set on every manual trigger to the probe-due decision for
  // that trigger; untouched by poll/watch ticks so it always reflects the last
  // user-initiated Refresh. A boolean — never a count or payload.
  let manualRefreshForcedProbe = false;

  function recordDiagnostic(ruleId: string): void {
    // Rule-id-only: NEVER the path or a raw error message.
    options.diagnostics?.record({
      ruleId,
      status: ruleId,
      severity: 'warning',
      details: { source: 'cockpit-native-snapshot' },
    });
  }

  // Decide whether this trigger participates in a probe. Consent (probeEnabled)
  // gates ALL probes; manual is cadence-exempt; poll needs ≥60s since the last.
  function probeDue(trigger: RefreshTrigger): boolean {
    if (!options.probeEnabled || options.runProbe === undefined) return false;
    if (trigger === 'manual') return true;
    if (forceProbeOnNextEnabledRefresh) return true;
    return now().getTime() - lastProbeAt >= PROBE_MIN_INTERVAL_MS;
  }

  // TOTAL by construction: this function must NEVER reject
  // — every failure path is caught and recorded — so the serialized refreshChain
  // can never be poisoned and future poll/watch/manual refreshes always proceed.
  async function executeRefresh(trigger: RefreshTrigger): Promise<void> {
    if (disposed) return;
    lastRefreshTrigger = trigger;
    lastRefreshAtMs = now().getTime();

    let candidates: readonly SourceCandidate[];
    try {
      candidates = await options.gatherCandidates();
    } catch {
      // Gather failure: record a path-free diagnostic and SKIP the post — never
      // fabricate a VM set. The loop keeps running; the next trigger retries.
      lastRefreshRuleId = 'cockpit-refresh-failed';
      recordDiagnostic('cockpit-refresh-failed');
      return;
    }

    let probeCandidates: readonly SourceCandidate[] = [];
    const willProbe = probeDue(trigger) && options.runProbe !== undefined;
    // A manual Refresh forces a probe only when the probe
    // is enabled (zero-spawn posture: a disabled manual refresh re-reads file
    // snapshots only). Record the actual decision for the spawn-count seam; leave
    // the flag untouched on poll/watch ticks so it reflects the last manual Refresh.
    if (trigger === 'manual') {
      manualRefreshForcedProbe = willProbe;
    }
    if (willProbe && options.runProbe !== undefined) {
      lastProbeAt = now().getTime();
      forceProbeOnNextEnabledRefresh = false;
      try {
        probeCandidates = await options.runProbe();
      } catch {
        // A probe failure contributes no candidate; the codex card resolves to
        // its honest unavailable reason via the builder's empty-state path. This
        // is honest, not fabricated — so we still post below.
        probeCandidates = [];
      }
    }

    const merged = probeCandidates.length > 0 ? [...candidates, ...probeCandidates] : candidates;
    // Run the per-tick transform on EVERY tick (including
    // no-probe poll ticks) after the merge and before the build. TOTAL by
    // construction: a throw degrades to the untransformed merged set, records a
    // path-free diagnostic, and never wedges the loop. In-memory only — no spawn.
    let transformed = merged;
    if (options.transformCandidates !== undefined) {
      try {
        transformed = options.transformCandidates(merged);
      } catch {
        transformed = merged;
        lastRefreshRuleId = 'cockpit-refresh-failed';
        recordDiagnostic('cockpit-refresh-failed');
      }
    }
    try {
      const viewModels = buildViewModels({
        candidates: transformed,
        configuredAgents: options.configuredAgents,
        now,
      });
      options.post?.(viewModels);
      lastPostAtMs = now().getTime();
      lastRefreshRuleId = 'cockpit-refresh-ok';
    } catch {
      lastRefreshRuleId = 'cockpit-refresh-failed';
      recordDiagnostic('cockpit-refresh-failed');
    }
  }

  function refresh(trigger: RefreshTrigger): Promise<void> {
    // Belt-and-braces: executeRefresh is total, but a `.catch` on the chain
    // guarantees that even an unforeseen throw can NEVER permanently poison the
    // serialized chain and wedge every subsequent refresh.
    refreshChain = refreshChain.then(() =>
      executeRefresh(trigger).catch(() => {
        lastRefreshRuleId = 'cockpit-refresh-failed';
        recordDiagnostic('cockpit-refresh-failed');
      }),
    );
    return refreshChain;
  }

  function scheduleDebounced(): void {
    if (disposed) return;
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh('watch');
    }, debounceMs);
  }

  // Set up an exact-file watcher per snapshot path — but only after confirming
  // the path is a FILE. A directory input is refused (poll-only degradation).
  async function setUpWatcher(exactPath: string): Promise<void> {
    let stats: StatLike;
    try {
      stats = await statFile(exactPath);
    } catch {
      // Path missing/unstattable → cannot watch it; degrade to poll-only. The
      // poll tick will still surface a snapshot once the file appears.
      recordDiagnostic('cockpit-watch-failed');
      return;
    }
    if (stats.isDirectory()) {
      // The input must NEVER become a directory/root scan.
      recordDiagnostic('cockpit-watch-failed');
      return;
    }
    let watcher: CockpitWatcherLike;
    try {
      watcher = watcherFactory(exactPath);
    } catch {
      recordDiagnostic('cockpit-watch-failed');
      return;
    }
    if (disposed) {
      void Promise.resolve(watcher.close()).catch(() => {});
      return;
    }
    // add / change / unlink are handled IDENTICALLY: schedule a debounced
    // refresh (Pitfall 6 — atomic-rename writers fire unlink+add).
    watcher.on('add', () => scheduleDebounced());
    watcher.on('change', () => scheduleDebounced());
    watcher.on('unlink', () => scheduleDebounced());
    watchers.push(watcher);
  }

  // Kick off watcher setup (async, fire-and-forget — failures degrade, never
  // throw) and an immediate first refresh so the cockpit paints on startup.
  for (const exactPath of options.snapshotPaths) {
    void setUpWatcher(exactPath);
  }
  void refresh('poll');

  // Poll loop: clamp the cadence to 10-15s; every tick re-resolves + re-posts so
  // native_status_stale flips on a clock even with zero fs events (Pitfall 7).
  const pollMs =
    clamp(options.pollIntervalSeconds, FILE_POLL_MIN_SECONDS, FILE_POLL_MAX_SECONDS) * 1000;
  intervalHandle = setIntervalFn(() => {
    void refresh('poll');
  }, pollMs);

  return {
    refresh,
    diagnosticsSnapshot(): CockpitLoopDiagnosticsSnapshot {
      return {
        lastRefreshAtMs,
        lastPostAtMs,
        lastRefreshTrigger,
        lastRefreshRuleId,
        // The poll interval is always registered at construction; it is active
        // until dispose. The watcher is active when at least one was created.
        pollActive: !disposed && intervalHandle !== undefined,
        watchActive: !disposed && watchers.length > 0,
        probeEnabled: options.probeEnabled,
        manualRefreshForcedProbe,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (intervalHandle !== undefined) {
        clearIntervalFn(intervalHandle);
        intervalHandle = undefined;
      }
      for (const watcher of watchers) {
        void Promise.resolve(watcher.close()).catch(() => {});
      }
      watchers.length = 0;
    },
  };
}
