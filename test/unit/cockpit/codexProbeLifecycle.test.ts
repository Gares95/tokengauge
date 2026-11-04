// Codex probe lifecycle across the refresh loop, composed the way extension.ts
// wires it: loop.runProbe(signal) → probeCodexNativeStatusGated → a real
// CodexAppServerProbe → a fake runner standing in for the child process.
//
// Turning the probe off, hiding the Codex card, changing any cockpit setting,
// and deactivating the extension all reach the probe through the same path:
// extension.ts disposes the loop (on rebuild, or via context.subscriptions on
// deactivation). These tests therefore pin what disposal must do to a probe
// that is still in flight: kill its child, send nothing more, post nothing,
// and never let a rebuilt loop's probe overlap the old one.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CodexAppServerProbe,
  type CodexProbeRunner,
} from '../../../src/adapters/codex/CodexAppServerProbe';
import { probeCodexNativeStatusGated } from '../../../src/adapters/codex/CodexStatusSource';
import { createNativeStatusRefreshLoop } from '../../../src/cockpit/NativeStatusRefreshLoop';
import type { SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';
import type { AgentId } from '../../../src/core/usage/NativeUsageTaxonomy';
import { findRepoRoot } from '../../_helpers/repoRoot';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(findRepoRoot(), 'test', 'fixtures', 'codex', 'app-server-ratelimits.json'),
    'utf8',
  ),
) as { initialize: Record<string, unknown>; rateLimits: Record<string, unknown> };

function deferred<T>() {
  let resolveFn: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeChild {
  alive: boolean;
  readonly methods: string[];
  readonly aliveSiblingsAtStart: number;
  readonly initialize: ReturnType<typeof deferred<unknown>>;
  readonly rateLimits: ReturnType<typeof deferred<unknown>>;
}

// Each runner call is one fake `codex app-server` child. Replies are released
// by the test unless `autoReply` is set.
function fakeCodex(options: { autoReply?: boolean } = {}) {
  const children: FakeChild[] = [];
  const alive = (): number => children.filter((c) => c.alive).length;
  const runner: CodexProbeRunner = async () => {
    const child: FakeChild = {
      alive: true,
      methods: [],
      aliveSiblingsAtStart: alive(),
      initialize: deferred<unknown>(),
      rateLimits: deferred<unknown>(),
    };
    children.push(child);
    if (options.autoReply) {
      child.initialize.resolve(FIXTURE.initialize);
      child.rateLimits.resolve({ rateLimits: FIXTURE.rateLimits });
    }
    return {
      found: true,
      stderr: '',
      exchange: {
        writeLine: (obj: unknown) => {
          child.methods.push(String((obj as { method?: unknown }).method));
        },
        readResult: (id: number) =>
          id === 1 ? child.initialize.promise : child.rateLimits.promise,
      },
      kill: () => {
        child.alive = false;
      },
    };
  };
  return { runner, children, alive };
}

// The extension.ts runProbe, minus its module-level diagnostics bookkeeping.
function wiredRunProbe(runner: CodexProbeRunner) {
  return async (signal: AbortSignal): Promise<readonly SourceCandidate[]> => {
    const result = await probeCodexNativeStatusGated({
      probeEnabled: true,
      probe: new CodexAppServerProbe({ runner, extensionVersion: '1.2.3', timeoutMs: 60_000 }),
      signal,
    });
    const emission: SourceCandidate = result.ok
      ? { ...result.candidate, producedAtMs: Date.now() }
      : {
          sourceTier: 'unknown',
          producedAtMs: Date.now(),
          scope: result.blocked.scope,
          unavailableReason: result.blocked.unavailableReason,
        };
    return [emission];
  };
}

function codexDisabledBlocker(): SourceCandidate {
  return {
    sourceTier: 'unknown',
    producedAtMs: Date.now(),
    scope: { provider: 'openai', agent: 'codex' },
    unavailableReason: 'codex_probe_disabled',
  };
}

function makeLoop(options: {
  runner: CodexProbeRunner;
  probeEnabled: boolean;
  configuredAgents?: readonly AgentId[];
  posts: unknown[];
}) {
  return createNativeStatusRefreshLoop({
    snapshotPaths: [],
    configuredAgents: options.configuredAgents ?? ['claude-code', 'codex'],
    gatherCandidates: async () => (options.probeEnabled ? [] : [codexDisabledBlocker()]),
    runProbe: wiredRunProbe(options.runner),
    probeEnabled: options.probeEnabled,
    pollIntervalSeconds: 15,
    post: (vms) => options.posts.push(vms),
    // The background poll is not under test; refreshes are driven explicitly.
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
}

suite('Codex probe lifecycle across loop disposal', () => {
  test('Disposing the loop mid-probe kills the child, sends nothing more, and posts nothing', async () => {
    const codex = fakeCodex();
    const posts: unknown[] = [];
    const loop = makeLoop({ runner: codex.runner, probeEnabled: true, posts });
    await nextTurn();
    assert.equal(codex.children.length, 1, 'the startup refresh is probing');
    const child = codex.children[0];
    assert.deepEqual(child.methods, ['initialize']);

    loop.dispose();
    await nextTurn();
    assert.equal(child.alive, false, 'disposal must kill the in-flight codex child');

    // The reply the user no longer wants arrives anyway.
    child.initialize.resolve(FIXTURE.initialize);
    child.rateLimits.resolve({ rateLimits: FIXTURE.rateLimits });
    await nextTurn();
    assert.deepEqual(child.methods, ['initialize'], 'no account/rateLimits/read after disposal');
    assert.equal(posts.length, 0);
  });

  for (const posture of ['probe disabled', 'Codex card hidden'] as const) {
    test(`Rebuild to "${posture}" mid-probe: the old probe stops and nothing new is spawned`, async () => {
      const codex = fakeCodex();
      const oldPosts: unknown[] = [];
      const newPosts: unknown[] = [];
      const oldLoop = makeLoop({ runner: codex.runner, probeEnabled: true, posts: oldPosts });
      await nextTurn();
      const child = codex.children[0];

      // What buildCockpitLoop does on the settings change: dispose, rebuild.
      oldLoop.dispose();
      const newLoop = makeLoop({
        runner: codex.runner,
        probeEnabled: false,
        posts: newPosts,
        ...(posture === 'Codex card hidden' ? { configuredAgents: ['claude-code'] } : {}),
      });
      await nextTurn();
      await newLoop.refresh('manual');

      child.initialize.resolve(FIXTURE.initialize);
      await nextTurn();

      assert.equal(child.alive, false, 'the old child must be killed');
      assert.deepEqual(child.methods, ['initialize'], 'no account/rateLimits/read after opt-out');
      assert.equal(codex.children.length, 1, 'the rebuilt loop must spawn nothing');
      assert.equal(oldPosts.length, 0, 'the old loop must not post');
      assert.ok(newPosts.length > 0, 'the rebuilt loop still renders its cards');
      newLoop.dispose();
    });
  }

  test('A settings rebuild with the probe still on never runs two codex children at once', async () => {
    const codex = fakeCodex();
    const oldLoop = makeLoop({ runner: codex.runner, probeEnabled: true, posts: [] });
    await nextTurn();
    assert.equal(codex.children.length, 1);

    // e.g. the poll interval changed: the rebuilt loop probes immediately.
    oldLoop.dispose();
    const newLoop = makeLoop({ runner: codex.runner, probeEnabled: true, posts: [] });
    await nextTurn();

    assert.equal(codex.children.length, 2, 'the rebuilt loop probes at once');
    assert.equal(codex.children[1].aliveSiblingsAtStart, 0, 'the old child was still running');
    newLoop.dispose();
    await nextTurn();
    assert.equal(codex.alive(), 0);
  });

  // Repeated Refresh clicks are serialized by the loop's refresh chain. Each
  // one still forces its own probe (the documented, cadence-exempt manual
  // behavior), one child at a time.
  test('Repeated manual refreshes probe one at a time and kill every child', async () => {
    const codex = fakeCodex({ autoReply: true });
    const posts: unknown[] = [];
    const loop = makeLoop({ runner: codex.runner, probeEnabled: true, posts });
    await Promise.all([loop.refresh('manual'), loop.refresh('manual'), loop.refresh('manual')]);

    assert.equal(codex.children.length, 4, 'startup probe + one probe per manual refresh');
    assert.ok(
      codex.children.every((c) => c.aliveSiblingsAtStart === 0),
      'probes must never overlap',
    );
    assert.equal(codex.alive(), 0, 'every child is killed when its exchange ends');
    assert.equal(posts.length, 4);
    loop.dispose();
  });

  // extension.ts can only run inside the VS Code extension host, so this pins
  // the one line of wiring the composition above relies on: the loop's signal
  // must reach the gated probe.
  test('Extension wiring forwards the loop signal into the gated Codex probe', () => {
    const src = fs.readFileSync(path.join(findRepoRoot(), 'src', 'extension.ts'), 'utf8');
    assert.match(src, /const runProbe = async \(signal: AbortSignal\)/);
    assert.match(src, /probeCodexNativeStatusGated\(\{\s*signal,/);
  });
});
