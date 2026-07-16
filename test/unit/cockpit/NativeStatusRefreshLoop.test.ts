// the live-update loop tests.
//
// These pin the non-negotiable boundaries of the refresh loop:
//   - exact-file-only watching (a directory input is rejected at the factory
//     and degrades to poll-only with a path-free diagnostic);
//   - add/change/unlink all schedule a debounced refresh that coalesces bursts;
//   - every poll tick re-resolves + re-posts even with zero fs events so
// native_status_stale surfaces on a clock (research Pitfall 7);
//   - ALL Codex probes (incl. manual) are gated by probeEnabled, and poll adds
// a ≥60s cadence floor (review HIGH-2);
//   - failures funnel to rule-id-only diagnostics; no fabricated post.
//
// The loop is fully seam-injected: zero vscode import, zero real fs/process.

import * as assert from 'node:assert/strict';
import { createClaudeSnapshotStabilityGate } from '../../../src/cockpit/ClaudeSnapshotStabilityGate';
import { createCockpitStabilizationPass } from '../../../src/cockpit/CockpitStabilizationPass';
import {
  CODEX_FRESH_TTL_MS,
  createCodexProbeRetentionGate,
} from '../../../src/cockpit/CodexProbeRetentionGate';
import {
  buildGaugeCardViewModels,
  type GaugeCardViewModel,
} from '../../../src/cockpit/GaugeCardViewModel';
import {
  type CockpitWatcherLike,
  createNativeStatusRefreshLoop,
  PROBE_MIN_INTERVAL_MS,
} from '../../../src/cockpit/NativeStatusRefreshLoop';
import type { CockpitFieldReason } from '../../../src/core/cockpit/CockpitState';
import type { SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';

const EXACT_PATH = '/home/u/.claude/tokengauge-status.json';

function claudeCandidate(over: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: Date.now(),
    scope: { provider: 'anthropic', agent: 'claude-code', model: 'claude-opus-4' },
    confidence: 'high',
    session: { usedPct: 84 },
    weekly: { usedPct: 40 },
    context: { usedPct: 30 },
    ...over,
  };
}

// A controllable fake watcher capturing handlers and close calls.
class FakeWatcher implements CockpitWatcherLike {
  public readonly handlers = new Map<string, (path: string) => void>();
  public closeCount = 0;
  on(event: string, handler: (path: string) => void): unknown {
    this.handlers.set(event, handler);
    return this;
  }
  close(): void {
    this.closeCount += 1;
  }
  emit(event: string, path = EXACT_PATH): void {
    const h = this.handlers.get(event);
    if (h) h(path);
  }
}

// A manual clock: advance() moves the wall clock; the loop reads it via now().
function fakeClock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return {
    now: (): Date => new Date(ms),
    advance: (deltaMs: number): void => {
      ms += deltaMs;
    },
    set: (absMs: number): void => {
      ms = absMs;
    },
  };
}

// A controllable interval seam: capture the registered tick + ms, fire on demand.
function fakeTimers() {
  const registered: { fn: () => void; ms: number }[] = [];
  return {
    setIntervalFn: ((fn: () => void, ms: number): { id: number } => {
      registered.push({ fn, ms });
      return { id: registered.length };
    }) as unknown as (fn: () => void, ms: number) => unknown,
    clearIntervalFn: ((): void => {}) as unknown as (handle: unknown) => void,
    registered,
    tick(index = 0): void {
      const r = registered[index];
      if (r) r.fn();
    },
  };
}

function recordingDiagnostics() {
  const records: { ruleId: string; details?: Record<string, unknown> }[] = [];
  return {
    record(entry: {
      readonly ruleId: string;
      readonly status: string;
      readonly severity: 'info' | 'warning' | 'error';
      readonly details?: Readonly<Record<string, unknown>>;
    }): void {
      records.push({
        ruleId: entry.ruleId,
        details: entry.details as Record<string, unknown> | undefined,
      });
    },
    records,
  };
}

function baseOptions(over: Record<string, unknown> = {}) {
  return {
    snapshotPaths: [EXACT_PATH],
    configuredAgents: ['claude-code', 'codex'] as const,
    gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
    pollIntervalSeconds: 10,
    probeEnabled: false,
    ...over,
  };
}

// Drain the loop's serialized refresh chain so assertions see settled state.
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

suite('NativeStatusRefreshLoop — exact-file watcher seam', () => {
  test('Directory input is rejected at the factory: zero watcher, poll-only, no path in diagnostic', async () => {
    const diagnostics = recordingDiagnostics();
    let watcherCreated = false;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        diagnostics,
        statFile: async () => ({ isDirectory: () => true }),
        watcherFactory: (): CockpitWatcherLike => {
          watcherCreated = true;
          return new FakeWatcher();
        },
      }),
    );
    await settle();
    assert.equal(watcherCreated, false, 'a directory path must never reach the watcher');
    const watchFailed = diagnostics.records.find((r) => r.ruleId === 'cockpit-watch-failed');
    assert.ok(watchFailed, 'a cockpit-watch-failed diagnostic must be recorded');
    const serialized = JSON.stringify(watchFailed);
    assert.ok(
      !serialized.includes('/.claude/') && !serialized.includes(EXACT_PATH),
      `diagnostic must not leak the path: ${serialized}`,
    );
    loop.dispose();
  });

  test('Add, change, unlink each schedule a refresh; rapid bursts coalesce to one', async () => {
    let refreshCount = 0;
    const watcher = new FakeWatcher();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => watcher,
        debounceMs: 0,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => {
          refreshCount += 1;
          return [claudeCandidate()];
        },
      }),
    );
    await settle();
    const baseline = refreshCount;
    // A burst of all three event kinds inside the debounce window.
    watcher.emit('add');
    watcher.emit('change');
    watcher.emit('unlink');
    await settle();
    await new Promise((r) => setTimeout(r, 5));
    await settle();
    assert.equal(refreshCount - baseline, 1, 'a burst must coalesce into exactly one refresh');
    loop.dispose();
  });

  test('Watcher factory throw → sanitized diagnostic, poll-only, dispose still safe', async () => {
    const diagnostics = recordingDiagnostics();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        diagnostics,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => {
          throw new Error('boom /secret/path leaked?');
        },
      }),
    );
    await settle();
    const rec = diagnostics.records.find((r) => r.ruleId === 'cockpit-watch-failed');
    assert.ok(rec, 'factory throw records cockpit-watch-failed');
    assert.ok(!JSON.stringify(rec).includes('/secret/path'), 'error message must not leak');
    assert.doesNotThrow(() => loop.dispose());
  });

  test('Dispose closes the watcher and never throws on double-dispose', async () => {
    const watcher = new FakeWatcher();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => watcher,
      }),
    );
    await settle();
    loop.dispose();
    assert.equal(watcher.closeCount, 1, 'dispose must close the watcher');
    assert.doesNotThrow(() => loop.dispose());
  });
});

suite('NativeStatusRefreshLoop — poll, probe cadence, pipeline', () => {
  test('PollIntervalSeconds 3 clamps to 10s; 99 clamps to 15s', async () => {
    const timersLow = fakeTimers();
    const loopLow = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timersLow.setIntervalFn,
        clearIntervalFn: timersLow.clearIntervalFn,
        pollIntervalSeconds: 3,
      }),
    );
    await settle();
    assert.equal(timersLow.registered[0]?.ms, 10_000, '3s clamps to 10s');
    loopLow.dispose();

    const timersHigh = fakeTimers();
    const loopHigh = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timersHigh.setIntervalFn,
        clearIntervalFn: timersHigh.clearIntervalFn,
        pollIntervalSeconds: 99,
      }),
    );
    await settle();
    assert.equal(timersHigh.registered[0]?.ms, 15_000, '99s clamps to 15s');
    loopHigh.dispose();
  });

  test('Poll tick with zero fs events still gathers → builds → posts; stale flips on the clock', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const producedAt = clock.now().getTime();
    const posts: unknown[][] = [];
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [
          claudeCandidate({ producedAtMs: producedAt }),
        ],
        post: (vms: unknown[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    posts.length = 0;
    // Advance past the 5-minute limit freshness threshold, then tick with NO
    // fs events at all.
    clock.advance(10 * 60 * 1000);
    timers.tick();
    await settle();
    assert.equal(posts.length, 1, 'a poll tick re-posts even with zero fs events');
    const cards = posts[0] as { agent: string; session: { reason?: string } }[];
    const claude = cards.find((c) => c.agent === 'claude-code');
    assert.ok(claude, 'claude card present');
    assert.equal(
      claude.session.reason,
      'native_status_stale',
      'staleness must surface on the clock',
    );
    loop.dispose();
  });

  test('Review HIGH-2: manual refresh with probeEnabled=false does NOT spawn (no probe)', async () => {
    let probeCalls = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        probeEnabled: false,
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          probeCalls += 1;
          return [];
        },
      }),
    );
    await settle();
    await loop.refresh('manual');
    await settle();
    assert.equal(probeCalls, 0, 'a disabled probe must never be invoked, even manually');
    loop.dispose();
  });

  test('Hidden Codex posture: no probe and no Codex card when configuredAgents omits Codex', async () => {
    let probeCalls = 0;
    const posts: GaugeCardViewModel[][] = [];
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        configuredAgents: ['claude-code'] as const,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        probeEnabled: false,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          probeCalls += 1;
          return [];
        },
        post: (vms: GaugeCardViewModel[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    await loop.refresh('manual');
    await settle();

    assert.equal(probeCalls, 0, 'hidden Codex must not probe through the cockpit loop');
    assert.ok(posts.length > 0, 'visible provider cards still post');
    assert.ok(
      posts.every((post) => post.every((card) => card.agent !== 'codex')),
      'hidden Codex must not leak a disabled card into rendered VMs',
    );
    loop.dispose();
  });

  test('Manual refresh with probeEnabled=true probes immediately (exempt from cadence)', async () => {
    let probeCalls = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        probeEnabled: true,
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          probeCalls += 1;
          return [];
        },
      }),
    );
    await settle();
    const before = probeCalls;
    await loop.refresh('manual');
    await settle();
    await loop.refresh('manual');
    await settle();
    assert.equal(probeCalls - before, 2, 'each manual refresh probes (cadence-exempt)');
    loop.dispose();
  });

  test('Poll probes only when enabled AND ≥60s elapsed: two ticks 10s apart → one probe', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    let probeCalls = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: true,
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          probeCalls += 1;
          return [];
        },
      }),
    );
    await settle();
    // Move past the startup probe's floor so the two counted ticks exercise the
    // 60s cadence in isolation (the startup paint already probed once on enable).
    clock.advance(PROBE_MIN_INTERVAL_MS);
    const before = probeCalls;
    timers.tick();
    await settle();
    clock.advance(10_000);
    timers.tick();
    await settle();
    assert.equal(probeCalls - before, 1, 'two poll ticks 10s apart probe exactly once (60s floor)');
    loop.dispose();
  });

  test('GatherCandidates rejection → cockpit-refresh-failed diagnostic, no fabricated post', async () => {
    const diagnostics = recordingDiagnostics();
    const posts: unknown[][] = [];
    let gatherCalls = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        diagnostics,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => {
          gatherCalls += 1;
          if (gatherCalls === 1) {
            return [claudeCandidate()];
          }
          throw new Error('gather /private/path failed');
        },
        post: (vms: unknown[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    posts.length = 0;
    await loop.refresh('manual');
    await settle();
    const rec = diagnostics.records.find((r) => r.ruleId === 'cockpit-refresh-failed');
    assert.ok(rec, 'gather failure records cockpit-refresh-failed');
    assert.ok(!JSON.stringify(rec).includes('/private/path'), 'failure must not leak paths');
    assert.equal(posts.length, 0, 'a failed gather must not post fabricated data');
    // A subsequent successful refresh still works (the loop keeps running).
    await loop.refresh('manual');
    await settle();
    loop.dispose();
  });

  test('Probe failure still posts a VM set (codex card carries a closed reason)', async () => {
    const posts: unknown[][] = [];
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        probeEnabled: true,
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          // A probe that fails contributes no candidate; the codex card resolves
          // to its honest unavailable reason via the builder's empty-state path.
          return [];
        },
        post: (vms: unknown[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    posts.length = 0;
    await loop.refresh('manual');
    await settle();
    assert.equal(posts.length, 1, 'a probe failure still produces a posted VM set');
    const cards = posts[0] as { agent: string; reason?: string }[];
    const codex = cards.find((c) => c.agent === 'codex');
    assert.ok(codex, 'the codex card always appears');
    assert.ok(codex.reason, 'the codex card carries a closed reason');
    loop.dispose();
  });
});

// The gate is wired in extension.ts by wrapping the gatherer's
// result through a per-loop gate instance between gatherCandidates and
// buildViewModels. These tests reproduce that exact wiring with a flapping
// gather seam to prove the posted Claude VM never reverts and shows collision.
suite('NativeStatusRefreshLoop × ClaudeSnapshotStabilityGate', () => {
  function flappingClaude(usedPct: number, workspaceHash: string, capturedAtMs: number) {
    return claudeCandidate({
      // Same reset window across all writes — the limit is conservative within it.
      session: { usedPct, resetsAt: '2026-06-14T12:00:00.000Z' },
      weekly: { usedPct: 40, resetsAt: 'week-1' },
      context: { usedPct: 30 },
      workspaceHash,
      snapshotCapturedAtMs: capturedAtMs,
    });
  }

  // Stability contract (supersedes the earlier "emit current reading" behavior): a
  // flapping snapshot inside ONE reset window must show a STABLE, CONSERVATIVE
  // value (the highest known usedPct), honestly labelled `snapshot_writer_collision`
  // — and must NEVER alternate. A lagging session's later, lower write cannot
  // lower the limit; only a real reset-window change may.
  test('A flapping snapshot file is collision-labelled and stays at the conservative high (no alternation)', async () => {
    const clock = fakeClock(1_000_000);
    const gate = createClaudeSnapshotStabilityGate({ now: clock.now });
    const posts: { agent: string; session: { usedPct?: number }; reason?: string }[][] = [];

    // Two competing writers alternate LOWER values after the window high (88).
    const sequence = [
      flappingClaude(88, 'ws-aaaaaaaaaaaaaaaa', 200),
      flappingClaude(82, 'ws-bbbbbbbbbbbbbbbb', 999),
      flappingClaude(70, 'ws-aaaaaaaaaaaaaaaa', 201),
      flappingClaude(82, 'ws-bbbbbbbbbbbbbbbb', 1000),
    ];
    let idx = 0;

    const timers = fakeTimers();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        now: clock.now,
        // Wrap the raw gather result through the gate — the extension.ts wiring.
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => {
          const raw = [sequence[Math.min(idx, sequence.length - 1)] as SourceCandidate];
          idx += 1;
          return gate.step(raw);
        },
        post: (vms: unknown): void => {
          posts.push(vms as { agent: string; session: { usedPct?: number }; reason?: string }[]);
        },
      }),
    );
    await settle();
    // Drive successive poll ticks, advancing the clock a few seconds each (within
    // the collision window) so the competing writes register as a flap.
    for (let i = 0; i < 3; i += 1) {
      clock.advance(4000);
      timers.tick();
      await settle();
    }

    const claudeCards = posts.map((p) => p.find((c) => c.agent === 'claude-code'));
    // First post accepts 88 (the window high).
    assert.equal(claudeCards[0]?.session.usedPct, 88);
    // Every COMPETING-write post is honestly degraded-labelled (never silent).
    const collisionPosts = claudeCards.filter((c) => c?.reason === 'snapshot_writer_collision');
    assert.ok(collisionPosts.length > 0, 'the collision reason surfaces while sessions compete');
    // The gauge NEVER alternates: the conservative value stays pinned at 88 — a
    // lagging session's lower write can never lower a limit inside its window.
    const distinct = new Set(claudeCards.map((c) => c?.session.usedPct));
    assert.deepEqual(
      distinct,
      new Set([88]),
      `must stay conservative, saw ${[...distinct].join(',')}`,
    );
    loop.dispose();
  });

  test('Default profile posts both cards with zero Codex spawns through the gate', async () => {
    const gate = createClaudeSnapshotStabilityGate({ now: () => new Date() });
    let codexSpawns = 0;
    const posts: { agent: string }[][] = [];
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        probeEnabled: false,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> =>
          gate.step([
            claudeCandidate({ workspaceHash: 'ws-aaaaaaaaaaaaaaaa', snapshotCapturedAtMs: 1 }),
          ]),
        // runProbe must never be invoked when probeEnabled is false.
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          codexSpawns += 1;
          return [];
        },
        post: (vms: unknown): void => {
          posts.push(vms as { agent: string }[]);
        },
      }),
    );
    await settle();
    assert.equal(codexSpawns, 0, 'zero Codex spawns on the default profile');
    const cards = posts[0];
    assert.ok(cards, 'a VM set is posted');
    assert.ok(
      cards.some((c) => c.agent === 'claude-code') && cards.some((c) => c.agent === 'codex'),
      'both cards always present',
    );
    loop.dispose();
  });
});

suite('NativeStatusRefreshLoop — anti-wedge', () => {
  test('A throwing gather on one tick never poisons the chain — the next tick still refreshes', async () => {
    const diagnostics = recordingDiagnostics();
    const timers = fakeTimers();
    const posts: unknown[] = [];
    let tick = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        diagnostics,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => {
          tick += 1;
          // The 2nd gather throws; the chain must survive and keep refreshing.
          if (tick === 2) throw new Error('boom /secret leaked?');
          return [claudeCandidate()];
        },
        post: (vms: unknown): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    const baseline = posts.length;
    // Tick 2 throws inside gather → recorded as a path-free diagnostic, no post.
    timers.tick();
    await settle();
    assert.equal(posts.length, baseline, 'a failed gather posts nothing');
    const failed = diagnostics.records.find((r) => r.ruleId === 'cockpit-refresh-failed');
    assert.ok(failed, 'a path-free refresh-failed diagnostic is recorded');
    assert.ok(!JSON.stringify(failed).includes('/secret'), 'error text must never leak');
    // Tick 3 must STILL refresh — the chain was not poisoned.
    timers.tick();
    await settle();
    assert.ok(posts.length > baseline, 'the loop keeps refreshing after an error tick');
    loop.dispose();
  });

  test('A throwing post on one tick never poisons the chain — a later tick still posts', async () => {
    const timers = fakeTimers();
    let posts = 0;
    let postTick = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        post: (): void => {
          postTick += 1;
          if (postTick === 2) throw new Error('post boom');
          posts += 1;
        },
      }),
    );
    await settle();
    const baseline = posts;
    timers.tick(); // post #2 throws — must not poison the chain.
    await settle();
    timers.tick(); // post #3 must still happen.
    await settle();
    assert.ok(posts > baseline, 'a later tick still posts after a throwing post');
    loop.dispose();
  });

  test('DiagnosticsSnapshot exposes only rule-id-level fields (no raw paths/ids/messages)', async () => {
    const timers = fakeTimers();
    const clock = fakeClock(1_700_000_000_000);
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
      }),
    );
    await settle();
    const snap = loop.diagnosticsSnapshot();
    // Closed set of rule-id-level fields only.
    const allowedKeys = new Set([
      'lastRefreshAtMs',
      'lastPostAtMs',
      'lastRefreshTrigger',
      'lastRefreshRuleId',
      'pollActive',
      'watchActive',
      'probeEnabled',
      // The spawn-count seam — a boolean, never a count.
      'manualRefreshForcedProbe',
    ]);
    for (const key of Object.keys(snap)) {
      assert.ok(allowedKeys.has(key), `unexpected diagnostics key: ${key}`);
    }
    // No value in the snapshot may be a string that looks like a path or leaks
    // raw data — only enum rule ids / triggers, booleans, and numbers.
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes('/'), 'no path-like value in diagnostics');
    assert.ok(!serialized.includes('.claude'), 'no raw home-dir fragment');
    // A successful refresh stamps a rule id + timestamps.
    assert.equal(snap.lastRefreshRuleId, 'cockpit-refresh-ok');
    assert.equal(typeof snap.lastRefreshAtMs, 'number');
    assert.equal(snap.pollActive, true);
    loop.dispose();
  });
});

// The manual-refresh-forced-probe spawn-count seam. A
// manual Refresh forces an app-server probe ONLY when the probe is enabled (zero-
// spawn posture intact when disabled). The boolean reflects the LAST manual refresh
// and is untouched by poll/watch ticks, so diagnostics can confirm a Refresh truly
// re-probed Codex vs reused a retained sample — WITHOUT scraping anything.
suite('NativeStatusRefreshLoop — manual-refresh-forced-probe seam', () => {
  test('Manual refresh with probe ENABLED forces a probe → flag true (spawn observed)', async () => {
    const clock = fakeClock(1_700_000_000_000);
    const timers = fakeTimers();
    let spawns = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: true,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          spawns += 1;
          return [];
        },
      }),
    );
    await settle();
    assert.equal(
      loop.diagnosticsSnapshot().manualRefreshForcedProbe,
      false,
      'no manual refresh yet → false',
    );
    await loop.refresh('manual');
    await settle();
    assert.ok(spawns >= 1, 'the manual refresh forced an actual probe spawn');
    assert.equal(
      loop.diagnosticsSnapshot().manualRefreshForcedProbe,
      true,
      'spawn-count seam reflects the forced probe',
    );
    loop.dispose();
  });

  test('Manual refresh with probe DISABLED forces NO probe → flag false, zero spawn', async () => {
    const clock = fakeClock(1_700_000_000_000);
    const timers = fakeTimers();
    let spawns = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: false,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          spawns += 1;
          return [];
        },
      }),
    );
    await settle();
    await loop.refresh('manual');
    await settle();
    assert.equal(spawns, 0, 'zero-spawn posture: disabled manual refresh never probes');
    assert.equal(
      loop.diagnosticsSnapshot().manualRefreshForcedProbe,
      false,
      'disabled manual refresh does not force a probe',
    );
    loop.dispose();
  });

  test('A poll tick does NOT overwrite the last manual-refresh-forced-probe flag', async () => {
    const clock = fakeClock(1_700_000_000_000);
    const timers = fakeTimers();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: true,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        runProbe: async (): Promise<readonly SourceCandidate[]> => [],
      }),
    );
    await settle();
    await loop.refresh('manual');
    await settle();
    assert.equal(loop.diagnosticsSnapshot().manualRefreshForcedProbe, true);
    // A poll tick (probe not yet due) must leave the manual flag as-is.
    clock.advance(5_000);
    timers.tick();
    await settle();
    assert.equal(
      loop.diagnosticsSnapshot().manualRefreshForcedProbe,
      true,
      'poll ticks never overwrite the last manual-refresh decision',
    );
    loop.dispose();
  });
});

// The per-tick post-merge transform seam. It runs on
// EVERY refresh tick (poll/watch/manual) AFTER the probe merge and BEFORE
// buildViewModels — so a stateful transform (the Codex retention gate) can keep a
// card stable across the intervening no-probe poll ticks that carry no codex
// candidate. The transform is total: a throw degrades to the untransformed merged
// set and records cockpit-refresh-failed; it never wedges the loop and never spawns.
suite('NativeStatusRefreshLoop — per-tick transformCandidates seam', () => {
  function codexBlocker(): SourceCandidate {
    return {
      sourceTier: 'unknown',
      producedAtMs: Date.now(),
      scope: { provider: 'openai', agent: 'codex' },
      unavailableReason: 'codex_native_status_unavailable',
    };
  }

  test('The transform is invoked on EVERY tick (including no-probe poll ticks) and its output reaches buildViewModels', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const seenByBuilder: number[] = [];
    let transformCalls = 0;
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        // The gatherer never yields a codex candidate (mirrors probe-enabled gather).
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        // A stateful transform that INJECTS a codex candidate every tick — the loop
        // must call it on every tick so the codex card is present on no-probe ticks.
        transformCandidates: (merged: readonly SourceCandidate[]): readonly SourceCandidate[] => {
          transformCalls += 1;
          return [...merged, codexBlocker()];
        },
        buildViewModels: ((opts: { candidates: readonly SourceCandidate[] }) => {
          const codexCount = opts.candidates.filter((c) => c.scope.agent === 'codex').length;
          seenByBuilder.push(codexCount);
          return [];
        }) as unknown as typeof import('../../../src/cockpit/GaugeCardViewModel').buildGaugeCardViewModels,
      }),
    );
    await settle();
    const baselineCalls = transformCalls;
    // Two no-probe poll ticks — the transform must run on each and its injected
    // codex candidate must reach the builder every time.
    timers.tick();
    await settle();
    clock.advance(10_000);
    timers.tick();
    await settle();
    assert.ok(transformCalls - baselineCalls >= 2, 'transform runs on every tick');
    // Every build call saw exactly one codex candidate (the injected one).
    assert.ok(
      seenByBuilder.every((count) => count === 1),
      `builder must always see the injected codex candidate, saw ${seenByBuilder.join(',')}`,
    );
    loop.dispose();
  });

  test('A throwing transform degrades to the untransformed merged set and the loop keeps running', async () => {
    const diagnostics = recordingDiagnostics();
    const timers = fakeTimers();
    const seenByBuilder: number[] = [];
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        diagnostics,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        transformCandidates: (): readonly SourceCandidate[] => {
          throw new Error('transform boom /secret/path');
        },
        buildViewModels: ((opts: { candidates: readonly SourceCandidate[] }) => {
          seenByBuilder.push(opts.candidates.length);
          return [];
        }) as unknown as typeof import('../../../src/cockpit/GaugeCardViewModel').buildGaugeCardViewModels,
      }),
    );
    await settle();
    const baseline = seenByBuilder.length;
    timers.tick();
    await settle();
    // The build still ran with the untransformed merged set (one claude candidate).
    assert.ok(seenByBuilder.length > baseline, 'a throwing transform still posts (degraded)');
    assert.equal(
      seenByBuilder[seenByBuilder.length - 1],
      1,
      'the builder sees the untransformed merged set',
    );
    const rec = diagnostics.records.find((r) => r.ruleId === 'cockpit-refresh-failed');
    assert.ok(rec, 'a throwing transform records cockpit-refresh-failed');
    assert.ok(!JSON.stringify(rec).includes('/secret/path'), 'no raw path may leak');
    // The loop keeps running.
    timers.tick();
    await settle();
    assert.ok(
      seenByBuilder.length > baseline + 1,
      'the loop keeps refreshing after a transform throw',
    );
    loop.dispose();
  });

  test('The transform must NOT trigger a probe/spawn (zero spawn even with probeEnabled=false)', async () => {
    let probeCalls = 0;
    const timers = fakeTimers();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: false,
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          probeCalls += 1;
          return [];
        },
        transformCandidates: (merged: readonly SourceCandidate[]): readonly SourceCandidate[] => [
          ...merged,
          codexBlocker(),
        ],
      }),
    );
    await settle();
    timers.tick();
    await settle();
    assert.equal(probeCalls, 0, 'the per-tick transform must never invoke runProbe/spawn');
    loop.dispose();
  });
});

// The loop × CodexProbeRetentionGate cadence path.
// These drive the REAL loop with the REAL builder and the REAL gate wired through
// transformCandidates — exactly the extension.ts wiring — to prove the Codex card
// stays stable (native → retained-degraded → recovered) across the probe + no-probe
// poll cadence, and NEVER shows no_source ("No data source configured") once valid
// or while the probe is enabled.
suite('NativeStatusRefreshLoop × CodexProbeRetentionGate cadence', () => {
  function validCodex(
    over: { sessionPct?: number | null; weeklyPct?: number | null } = {},
  ): SourceCandidate {
    const sessionPct = over.sessionPct === undefined ? 1 : over.sessionPct;
    const weeklyPct = over.weeklyPct === undefined ? 5 : over.weeklyPct;
    return {
      sourceTier: 'codex_status_snapshot',
      producedAtMs: Date.now(),
      scope: { provider: 'openai', agent: 'codex' },
      confidence: 'medium',
      ...(sessionPct !== null
        ? { session: { usedPct: sessionPct, leftPct: 100 - sessionPct } }
        : {}),
      ...(weeklyPct !== null ? { weekly: { usedPct: weeklyPct, leftPct: 100 - weeklyPct } } : {}),
      agentVersion: 'codex/0.137.0',
    };
  }

  // Build a loop whose runProbe yields the supplied probe outcomes (one per probe
  // tick), wired through the real gate + real builder. The gatherer yields ONLY a
  // claude candidate (mirrors probe-enabled gather: no codex candidate from gather).
  function buildLoop(opts: {
    probeOutcomes: (readonly SourceCandidate[])[];
    posts: GaugeCardViewModel[][];
    clock: ReturnType<typeof fakeClock>;
    timers: ReturnType<typeof fakeTimers>;
    probeEnabled?: boolean;
    onProbe?: () => void;
  }) {
    const gate = createCodexProbeRetentionGate({
      probeEnabled: opts.probeEnabled ?? true,
      now: opts.clock.now,
    });
    let probeIdx = 0;
    return createNativeStatusRefreshLoop(
      baseOptions({
        now: opts.clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: opts.timers.setIntervalFn,
        clearIntervalFn: opts.timers.clearIntervalFn,
        probeEnabled: opts.probeEnabled ?? true,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          opts.onProbe?.();
          const out = opts.probeOutcomes[Math.min(probeIdx, opts.probeOutcomes.length - 1)] ?? [];
          probeIdx += 1;
          return out;
        },
        transformCandidates: (merged: readonly SourceCandidate[]): readonly SourceCandidate[] =>
          gate.step(merged),
        buildViewModels: buildGaugeCardViewModels,
        post: (vms: GaugeCardViewModel[]): void => {
          opts.posts.push(vms);
        },
      }),
    );
  }

  function codexCard(post: GaugeCardViewModel[] | undefined): GaugeCardViewModel | undefined {
    return post?.find((c) => c.agent === 'codex');
  }

  // A codex probe-failure blocker (the gated probe yields this on a probe failure).
  function codexBlocker(reason: CockpitFieldReason): SourceCandidate {
    return {
      sourceTier: 'unknown',
      producedAtMs: Date.now(),
      scope: { provider: 'openai', agent: 'codex' },
      unavailableReason: reason,
    };
  }

  test('Probe enabled at activation forces an immediate probe even before the cadence floor', async () => {
    const clock = fakeClock(0);
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    let probeAttempts = 0;
    const loop = buildLoop({
      clock,
      timers,
      posts,
      probeOutcomes: [[validCodex({ sessionPct: 12, weeklyPct: 21 })]],
      onProbe: () => {
        probeAttempts += 1;
      },
    });

    await settle();

    assert.equal(probeAttempts, 1, 'enabled activation must probe immediately');
    const codex = codexCard(posts.at(-1));
    assert.equal(codex?.session.usedPct, 12);
    assert.equal(codex?.weekly.usedPct, 21);
    assert.equal(codex?.freshness, 'fresh');
    loop.dispose();
  });

  test('Weekly-only probe at activation is fresh and does not retain a fabricated 5h value', async () => {
    const clock = fakeClock(0);
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const loop = buildLoop({
      clock,
      timers,
      posts,
      probeOutcomes: [[validCodex({ sessionPct: null, weeklyPct: 7 })]],
    });

    await settle();

    const codex = codexCard(posts.at(-1));
    assert.equal(codex?.session.usedPct, undefined);
    assert.equal(codex?.weekly.usedPct, 7);
    assert.equal(codex?.freshness, 'fresh');
    assert.equal(codex?.reason, undefined);
    loop.dispose();
  });

  test('A later weekly-only valid probe clears the prior retained 5h value', async () => {
    const clock = fakeClock(0);
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const loop = buildLoop({
      clock,
      timers,
      posts,
      probeOutcomes: [
        [validCodex({ sessionPct: 12, weeklyPct: 21 })],
        [validCodex({ sessionPct: null, weeklyPct: 23 })],
      ],
    });
    await settle();
    assert.equal(codexCard(posts.at(-1))?.session.usedPct, 12);

    posts.length = 0;
    clock.advance(PROBE_MIN_INTERVAL_MS);
    timers.tick();
    await settle();

    const codex = codexCard(posts.at(-1));
    assert.equal(codex?.session.usedPct, undefined, 'old 5h value cleared');
    assert.equal(codex?.weekly.usedPct, 23);
    assert.equal(codex?.freshness, 'fresh');
    loop.dispose();
  });

  test('A later dual-window probe restores the normal two-window Codex state', async () => {
    const clock = fakeClock(0);
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const loop = buildLoop({
      clock,
      timers,
      posts,
      probeOutcomes: [
        [validCodex({ sessionPct: null, weeklyPct: 7 })],
        [validCodex({ sessionPct: 9, weeklyPct: 11 })],
      ],
    });
    await settle();
    assert.equal(codexCard(posts.at(-1))?.session.usedPct, undefined);

    posts.length = 0;
    clock.advance(PROBE_MIN_INTERVAL_MS);
    timers.tick();
    await settle();

    const codex = codexCard(posts.at(-1));
    assert.equal(codex?.session.usedPct, 9);
    assert.equal(codex?.weekly.usedPct, 11);
    assert.equal(codex?.freshness, 'fresh');
    loop.dispose();
  });

  test('Probe disabled at activation spawns zero probes and shows Probe off', async () => {
    const clock = fakeClock(0);
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    let probeAttempts = 0;
    const gate = createCodexProbeRetentionGate({ probeEnabled: false, now: clock.now });
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: false,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [
          claudeCandidate(),
          codexBlocker('codex_probe_disabled'),
        ],
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          probeAttempts += 1;
          return [validCodex({ sessionPct: 99, weeklyPct: 99 })];
        },
        transformCandidates: (merged: readonly SourceCandidate[]): readonly SourceCandidate[] =>
          gate.step(merged),
        buildViewModels: buildGaugeCardViewModels,
        post: (vms: GaugeCardViewModel[]): void => {
          posts.push(vms);
        },
      }),
    );

    await settle();

    assert.equal(probeAttempts, 0, 'disabled activation must never spawn codex');
    const codex = codexCard(posts.at(-1));
    assert.equal(codex?.reason, 'codex_probe_disabled');
    assert.equal(codex?.session.usedPct, undefined, 'disabled state must not show an old value');
    loop.dispose();
  });

  test('Reactivation starts a new Codex retention state, so a stale 99% cannot hold a fresh lower probe', async () => {
    const clock = fakeClock(0);
    const timersA = fakeTimers();
    const postsA: GaugeCardViewModel[][] = [];
    const staleLoop = buildLoop({
      clock,
      timers: timersA,
      posts: postsA,
      probeOutcomes: [[validCodex({ sessionPct: 99, weeklyPct: 99 })]],
    });
    await settle();
    assert.equal(codexCard(postsA.at(-1))?.session.usedPct, 99);
    staleLoop.dispose();

    const timersB = fakeTimers();
    const postsB: GaugeCardViewModel[][] = [];
    let freshProbeAttempts = 0;
    const freshLoop = buildLoop({
      clock,
      timers: timersB,
      posts: postsB,
      probeOutcomes: [[validCodex({ sessionPct: 14, weeklyPct: 22 })]],
      onProbe: () => {
        freshProbeAttempts += 1;
      },
    });
    await settle();

    assert.equal(freshProbeAttempts, 1, 'reactivation must perform a fresh probe');
    const codex = codexCard(postsB.at(-1));
    assert.equal(codex?.session.usedPct, 14);
    assert.equal(codex?.weekly.usedPct, 22);
    assert.equal(codex?.freshness, 'fresh');
    freshLoop.dispose();
  });

  // (a)+(b) Retention (supersedes the earlier always-degrade behavior on no-probe
  // ticks): a valid probe tick, then the intervening no-probe poll ticks WITHIN the
  // freshness TTL keep the card FRESH and visually STABLE (no fresh↔degraded
  // flicker, no reason/context/footer change, NEVER no_source), then a later valid
  // probe tick recovers it to fresh native values.
  test('(a/b) valid probe → within-TTL no-probe poll ticks STAY FRESH (no flicker) → later valid recovers', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const loop = buildLoop({
      clock,
      timers,
      posts,
      // The startup poll itself probes (lastProbeAt=0 < now−60s), so outcome #0 is
      // consumed there; the first explicit probe tick below consumes #1 (same 1%
      // value), and the later recovery tick consumes #2 (a fresh 3%). Three probe
      // ticks occur in this scenario; supply all three so indices line up.
      probeOutcomes: [
        [validCodex({ sessionPct: 1, weeklyPct: 5 })],
        [validCodex({ sessionPct: 1, weeklyPct: 5 })],
        [validCodex({ sessionPct: 3, weeklyPct: 8 })],
      ],
    });
    await settle();
    posts.length = 0;

    // First probe tick (≥60s after startup) → fresh 1%/5%.
    clock.advance(PROBE_MIN_INTERVAL_MS);
    timers.tick();
    await settle();
    const firstCodex = codexCard(posts.at(-1));
    assert.ok(firstCodex, 'codex card present');
    assert.equal(firstCodex?.session.usedPct, 1, 'fresh native value 1%');
    assert.notEqual(firstCodex?.reason, 'no_source');
    assert.equal(firstCodex?.freshness, 'fresh', 'fresh after the valid probe');

    // Several intervening no-probe poll ticks (10s apart, < 60s floor, all within
    // the freshness TTL). The card must STAY FRESH and unchanged — no flicker.
    for (let i = 0; i < 3; i += 1) {
      posts.length = 0;
      clock.advance(10_000);
      timers.tick();
      await settle();
      const codex = codexCard(posts.at(-1));
      assert.ok(codex, 'codex card stays present on a no-probe tick');
      assert.equal(codex?.session.usedPct, 1, 'value retained at 1% across no-probe ticks');
      assert.notEqual(codex?.reason, 'no_source', 'never collapses to no_source');
      assert.notEqual(codex?.reason, 'no_candidate', 'never collapses to no_candidate');
      assert.equal(
        codex?.reason,
        undefined,
        'WITHIN TTL no degraded reason surfaces — no fresh↔degraded flicker',
      );
      assert.equal(codex?.freshness, 'fresh', 'card stays FRESH across no-probe ticks');
    }

    // A later valid probe tick recovers to the fresh native value.
    posts.length = 0;
    clock.advance(PROBE_MIN_INTERVAL_MS);
    timers.tick();
    await settle();
    const recovered = codexCard(posts.at(-1));
    assert.equal(recovered?.session.usedPct, 3, 'recovers to fresh 3%');
    assert.equal(recovered?.reason, undefined, 'no degraded reason after recovery');
    loop.dispose();
  });

  // (a-stale) A probe outage that exceeds the freshness TTL → the card
  // goes stale/degraded (codex_probe_stale) with the value RETAINED — NOT no_source.
  test('(a-stale) a no-probe outage beyond the TTL marks the card stale/degraded (value kept, not no_source)', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const loop = buildLoop({
      clock,
      timers,
      posts,
      // The startup probe yields the valid value; every later probe tick yields
      // nothing (a stuck probe), so the only refreshes are no-probe poll ticks.
      probeOutcomes: [[validCodex({ sessionPct: 4, weeklyPct: 9 })], []],
    });
    await settle();
    posts.length = 0;

    // A no-probe poll tick well beyond the TTL — the held value is overdue.
    clock.advance(CODEX_FRESH_TTL_MS + 10_000);
    timers.tick();
    await settle();
    const codex = codexCard(posts.at(-1));
    assert.ok(codex, 'codex card stays present');
    assert.equal(codex?.session.usedPct, 4, 'value still retained when stale');
    assert.notEqual(codex?.reason, 'no_source', 'beyond TTL it is stale, NOT no_source');
    assert.equal(codex?.reason, 'codex_probe_stale', 'stale/degraded reason surfaces');
    loop.dispose();
  });

  // (c-fail) An explicit probe FAILURE after a valid result retains
  // degraded IMMEDIATELY (not TTL-gated) with the failure reason — distinct from a
  // mere no-probe tick within the TTL.
  test('(c-fail) a probe FAILURE after valid retains degraded immediately (not TTL-gated)', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const codexFailure: SourceCandidate = {
      sourceTier: 'unknown',
      producedAtMs: clock.now().getTime(),
      scope: { provider: 'openai', agent: 'codex' },
      unavailableReason: 'codex_probe_failed',
    };
    const loop = buildLoop({
      clock,
      timers,
      posts,
      // startup probe → valid; the next probe tick yields a failure blocker.
      probeOutcomes: [[validCodex({ sessionPct: 2, weeklyPct: 6 })], [codexFailure]],
    });
    await settle();
    posts.length = 0;

    // A probe tick (≥60s) just after the valid result — well within the TTL — that
    // returns a failure blocker. It must degrade immediately, not stay fresh.
    clock.advance(PROBE_MIN_INTERVAL_MS);
    timers.tick();
    await settle();
    const codex = codexCard(posts.at(-1));
    assert.equal(codex?.session.usedPct, 2, 'value retained');
    assert.equal(
      codex?.reason,
      'codex_probe_temporarily_unavailable',
      'an actual failure degrades immediately (not TTL-gated)',
    );
    loop.dispose();
  });

  // The status-bar VM and the cockpit VM derive from the SAME
  // posted view-model set each tick — they can never disagree fresh vs degraded.
  test('(f) status-bar VM == cockpit VM each tick (no fresh/degraded disagreement)', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const cockpitPosts: GaugeCardViewModel[][] = [];
    const statusBarPosts: GaugeCardViewModel[][] = [];
    const gate = createCodexProbeRetentionGate({ probeEnabled: true, now: clock.now });
    let probeIdx = 0;
    const probeOutcomes: (readonly SourceCandidate[])[] = [
      [validCodex({ sessionPct: 1, weeklyPct: 5 })],
    ];
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: true,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [claudeCandidate()],
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          const out = probeOutcomes[Math.min(probeIdx, probeOutcomes.length - 1)] ?? [];
          probeIdx += 1;
          return out;
        },
        transformCandidates: (merged: readonly SourceCandidate[]): readonly SourceCandidate[] =>
          gate.step(merged),
        buildViewModels: buildGaugeCardViewModels,
        // The real extension posts the SAME vm set to both surfaces; mirror that.
        post: (vms: GaugeCardViewModel[]): void => {
          cockpitPosts.push(vms);
          statusBarPosts.push(vms);
        },
      }),
    );
    await settle();

    // A probe tick then several within-TTL no-probe poll ticks — the two surfaces
    // must see byte-identical freshness/reason on every tick.
    clock.advance(PROBE_MIN_INTERVAL_MS);
    timers.tick();
    await settle();
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000);
      timers.tick();
      await settle();
    }
    assert.equal(cockpitPosts.length, statusBarPosts.length, 'same number of posts');
    for (let i = 0; i < cockpitPosts.length; i += 1) {
      const c = codexCard(cockpitPosts[i]);
      const s = codexCard(statusBarPosts[i]);
      assert.equal(c?.freshness, s?.freshness, `freshness agrees on tick ${i}`);
      assert.equal(c?.reason, s?.reason, `reason agrees on tick ${i}`);
    }
    loop.dispose();
  });

  // (c) enabled but never a valid probe → the no-probe poll ticks show a
  //     probe-pending/exact-unavailable reason, NEVER no_source.
  test('(c) enabled-never-valid: no-probe ticks show codex_probe_pending, never no_source', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const loop = buildLoop({
      clock,
      timers,
      posts,
      probeOutcomes: [[]], // every probe tick yields nothing (never valid)
    });
    await settle();

    // The startup paint + several no-probe poll ticks must never show no_source.
    for (let i = 0; i < 3; i += 1) {
      posts.length = 0;
      clock.advance(10_000);
      timers.tick();
      await settle();
      const codex = codexCard(posts.at(-1));
      assert.ok(codex, 'codex card present (never absent) while enabled');
      assert.notEqual(codex?.reason, 'no_source', 'enabled-never-valid never shows no_source');
      assert.equal(codex?.reason, 'codex_probe_pending', 'honest pending reason instead');
    }
    loop.dispose();
  });

  // (d) disabled → the gatherer's codex_probe_disabled card stands every tick and
  //     runProbe is NEVER invoked (zero spawn).
  test('(d) disabled: codex_probe_disabled every tick, ZERO probe invocation', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    let probeInvocations = 0;
    // When disabled the gatherer emits the codex_probe_disabled blocker; emulate it.
    const gate = createCodexProbeRetentionGate({ probeEnabled: false });
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: false,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [
          claudeCandidate(),
          {
            sourceTier: 'unknown',
            producedAtMs: Date.now(),
            scope: { provider: 'openai', agent: 'codex' },
            unavailableReason: 'codex_probe_disabled',
          },
        ],
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          probeInvocations += 1;
          return [];
        },
        transformCandidates: (merged: readonly SourceCandidate[]): readonly SourceCandidate[] =>
          gate.step(merged),
        buildViewModels: buildGaugeCardViewModels,
        post: (vms: GaugeCardViewModel[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    for (let i = 0; i < 3; i += 1) {
      posts.length = 0;
      clock.advance(10_000);
      timers.tick();
      await settle();
      const codex = codexCard(posts.at(-1));
      assert.equal(codex?.reason, 'codex_probe_disabled', 'disabled card stands every tick');
    }
    assert.equal(probeInvocations, 0, 'ZERO probe invocations while disabled');
    loop.dispose();
  });

  // (e) a manual Refresh and a background poll converge to the same stable card —
  //     no path divergence between the two refresh entry points.
  test('(e) manual refresh and background poll converge to the same stable card', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const loop = buildLoop({
      clock,
      timers,
      posts,
      probeOutcomes: [[validCodex({ sessionPct: 2, weeklyPct: 6 })]],
    });
    await settle();

    // A manual refresh probes immediately (cadence-exempt) → fresh value.
    posts.length = 0;
    await loop.refresh('manual');
    await settle();
    const manualCodex = codexCard(posts.at(-1));
    assert.equal(manualCodex?.session.usedPct, 2, 'manual refresh shows the native value');

    // A background poll tick within the 60s floor (no probe) retains the same value.
    // Within the freshness TTL the retained value stays FRESH (no
    // flicker), never no_source.
    posts.length = 0;
    clock.advance(10_000);
    timers.tick();
    await settle();
    const pollCodex = codexCard(posts.at(-1));
    assert.equal(pollCodex?.session.usedPct, 2, 'background poll retains the same value');
    assert.notEqual(pollCodex?.reason, 'no_source', 'never no_source');
    assert.equal(
      pollCodex?.reason,
      undefined,
      'within TTL the retained value is fresh — no degraded reason',
    );
    loop.dispose();
  });

  // Manual Refresh FORCES a real probe attempt
  // (spawn-count seam), not a silent repaint of retained values. On success the card
  // reads the fresh/current native value; on failure it retains the last-known value
  // with a PRECISE reason (never bare fresh, never no_source); disabled → zero spawn.
  test('(mr) manual refresh forces a real probe attempt (spawn-count seam) when enabled', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    let probeAttempts = 0;
    const loop = buildLoop({
      clock,
      timers,
      posts,
      probeOutcomes: [[validCodex({ sessionPct: 88, weeklyPct: 40 })]],
      onProbe: () => {
        probeAttempts += 1;
      },
    });
    await settle();
    const before = probeAttempts;
    posts.length = 0;
    // A manual refresh must invoke runProbe (a real probe attempt), not just repaint.
    await loop.refresh('manual');
    await settle();
    assert.equal(probeAttempts - before, 1, 'manual refresh forces exactly one real probe attempt');
    const codex = codexCard(posts.at(-1));
    assert.equal(codex?.session.usedPct, 88, 'a successful manual probe shows the fresh value');
    assert.equal(codex?.freshness, 'fresh', 'a successful manual probe reads fresh/current');
    loop.dispose();
  });

  test('(mr-fail) manual refresh probe FAILURE retains the value with a precise reason (no repaint-as-fresh)', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    let probeAttempts = 0;
    const loop = buildLoop({
      clock,
      timers,
      posts,
      // First probe (startup) succeeds; the manual-refresh probe yields a failure
      // blocker → the gate retains the last-known value degraded with a precise reason.
      probeOutcomes: [
        [validCodex({ sessionPct: 91, weeklyPct: 50 })],
        [codexBlocker('codex_probe_failed')],
      ],
      onProbe: () => {
        probeAttempts += 1;
      },
    });
    await settle();
    const before = probeAttempts;
    posts.length = 0;
    await loop.refresh('manual');
    await settle();
    assert.equal(probeAttempts - before, 1, 'manual refresh still forces a real probe attempt');
    const codex = codexCard(posts.at(-1));
    assert.equal(
      codex?.session.usedPct,
      91,
      'value retained (never blanks) on a manual-probe failure',
    );
    assert.notEqual(codex?.reason, 'no_source', 'a failure is never no_source');
    assert.equal(
      codex?.reason,
      'codex_probe_temporarily_unavailable',
      'a manual-probe failure surfaces a precise retained reason, not a silent fresh repaint',
    );
    assert.notEqual(codex?.freshness, 'fresh', 'a failed manual probe is degraded, not bare fresh');
    loop.dispose();
  });

  test('(mr-disabled) manual refresh while disabled spawns ZERO probes and shows codex_probe_disabled', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    let probeAttempts = 0;
    const gate = createCodexProbeRetentionGate({ probeEnabled: false });
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        probeEnabled: false,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [
          claudeCandidate(),
          {
            sourceTier: 'unknown',
            producedAtMs: Date.now(),
            scope: { provider: 'openai', agent: 'codex' },
            unavailableReason: 'codex_probe_disabled',
          },
        ],
        runProbe: async (): Promise<readonly SourceCandidate[]> => {
          probeAttempts += 1;
          return [];
        },
        transformCandidates: (merged: readonly SourceCandidate[]): readonly SourceCandidate[] =>
          gate.step(merged),
        buildViewModels: buildGaugeCardViewModels,
        post: (vms: GaugeCardViewModel[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    posts.length = 0;
    await loop.refresh('manual');
    await settle();
    assert.equal(probeAttempts, 0, 'a disabled manual refresh must spawn ZERO probes');
    const codex = codexCard(posts.at(-1));
    assert.equal(
      codex?.reason,
      'codex_probe_disabled',
      'disabled manual refresh shows the disabled card',
    );
    loop.dispose();
  });
});

// End-to-end through the loop with the
// PRODUCTION transform chain — pass.step(retentionGate.step(merged)) — so the
// single stabilization pass runs last (after the gates) before buildViewModels.
suite('NativeStatusRefreshLoop — stabilization pass (expiry + no-flap)', () => {
  function claudeCard(post: GaugeCardViewModel[] | undefined): GaugeCardViewModel | undefined {
    return post?.find((c) => c.agent === 'claude-code');
  }

  // The production transform chain: retention gate, then the stabilization pass.
  function chain(clock: { now: () => Date }) {
    const gate = createCodexProbeRetentionGate({ probeEnabled: false, now: clock.now });
    const pass = createCockpitStabilizationPass({ now: clock.now });
    return (merged: readonly SourceCandidate[]): readonly SourceCandidate[] =>
      pass.step(gate.step(merged));
  }

  test('Expired 5h window → pending across the loop (not stale used%, not fresh, no risk)', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    // resetsAt 6h before the loop clock — the window has reset by the clock.
    const past = new Date(clock.now().getTime() - 6 * 60 * 60 * 1000).toISOString();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [
          claudeCandidate({ session: { usedPct: 96, leftPct: 4, resetsAt: past } }),
        ],
        transformCandidates: chain(clock),
        buildViewModels: buildGaugeCardViewModels,
        post: (vms: GaugeCardViewModel[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    const claude = claudeCard(posts.at(-1));
    assert.equal(claude?.session.usedPct, undefined, 'expired value dropped');
    assert.equal(claude?.session.reason, 'native_window_reset_pending');
    assert.notEqual(claude?.freshness, 'fresh');
    assert.equal(claude?.risk, 'unavailable', 'a pre-reset near-100 value never drives risk');
    loop.dispose();
  });

  test('No-flap: N consecutive no-new-sample poll ticks → ZERO semantic-state changes', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const future = new Date(clock.now().getTime() + 3 * 60 * 60 * 1000).toISOString();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        // The SAME accepted sample every tick (no new sample arriving).
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [
          claudeCandidate({ session: { usedPct: 55, leftPct: 45, resetsAt: future } }),
        ],
        transformCandidates: chain(clock),
        buildViewModels: buildGaugeCardViewModels,
        post: (vms: GaugeCardViewModel[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();

    const states = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      clock.advance(10_000);
      timers.tick();
      await settle();
      const c = claudeCard(posts.at(-1));
      states.add(
        JSON.stringify({
          session: c?.session.usedPct ?? null,
          reason: c?.reason ?? null,
          freshness: c?.freshness ?? null,
          risk: c?.risk ?? null,
        }),
      );
    }
    assert.equal(states.size, 1, 'no semantic-state change across no-new-sample poll ticks');
    loop.dispose();
  });

  test('A manual refresh that yields the same sample causes no semantic cycling', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const posts: GaugeCardViewModel[][] = [];
    const future = new Date(clock.now().getTime() + 3 * 60 * 60 * 1000).toISOString();
    const loop = createNativeStatusRefreshLoop(
      baseOptions({
        now: clock.now,
        statFile: async () => ({ isDirectory: () => false }),
        watcherFactory: (): CockpitWatcherLike => new FakeWatcher(),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
        gatherCandidates: async (): Promise<readonly SourceCandidate[]> => [
          claudeCandidate({ session: { usedPct: 60, leftPct: 40, resetsAt: future } }),
        ],
        transformCandidates: chain(clock),
        buildViewModels: buildGaugeCardViewModels,
        post: (vms: GaugeCardViewModel[]): void => {
          posts.push(vms);
        },
      }),
    );
    await settle();
    const states = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      clock.advance(3_000);
      await loop.refresh('manual');
      await settle();
      const c = claudeCard(posts.at(-1));
      states.add(JSON.stringify({ reason: c?.reason ?? null, freshness: c?.freshness ?? null }));
    }
    assert.equal(states.size, 1, 'manual refresh with no new sample → no reason/freshness cycling');
    loop.dispose();
  });
});
