// CodexAppServerProbe cancellation (AbortSignal) tests.
//
// The refresh loop aborts its signal when it is disposed: the user turned the
// probe off, hid the Codex card, changed a cockpit setting, or the extension
// deactivated. From that moment the probe must stop at once: start nothing,
// send nothing more (in particular never `account/rateLimits/read`, the call
// that makes Codex contact its backend), kill its child, and settle without a
// result. Every reply here is released by hand from a fake runner, so each
// ordering, including same-tick races, is exercised deterministically.

import * as assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  CodexAppServerProbe,
  type CodexProbeResult,
  type CodexProbeRunner,
  type CodexProbeRunRequest,
} from '../../../../src/adapters/codex/CodexAppServerProbe';
import { findRepoRoot } from '../../../_helpers/repoRoot';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    join(findRepoRoot(), 'test', 'fixtures', 'codex', 'app-server-ratelimits.json'),
    'utf8',
  ),
) as { initialize: Record<string, unknown>; rateLimits: Record<string, unknown> };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}

// One full macrotask turn: every microtask queued so far has run.
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// A runner whose start-up and both replies are released by the test.
function controlledRunner(options: { gateStart?: boolean } = {}) {
  const started = deferred<void>();
  const initialize = deferred<unknown>();
  const rateLimits = deferred<unknown>();
  const state = {
    calls: 0,
    killCount: 0,
    methods: [] as string[],
    requests: [] as CodexProbeRunRequest[],
  };
  const runner: CodexProbeRunner = async (request) => {
    state.calls += 1;
    state.requests.push(request);
    if (options.gateStart) {
      await started.promise;
    }
    return {
      found: true,
      stderr: '',
      exchange: {
        writeLine: (obj: unknown) => {
          state.methods.push(String((obj as { method?: unknown }).method));
        },
        readResult: (id: number) => (id === 1 ? initialize.promise : rateLimits.promise),
      },
      kill: () => {
        state.killCount += 1;
      },
    };
  };
  return { runner, state, started, initialize, rateLimits };
}

function makeProbe(runner: CodexProbeRunner, timeoutMs = 60_000) {
  const records: string[] = [];
  const probe = new CodexAppServerProbe({
    runner,
    extensionVersion: '1.2.3',
    timeoutMs,
    diagnostics: { record: (entry) => records.push(entry.ruleId) },
  });
  return { probe, records };
}

type Outcome = { ok: CodexProbeResult } | { error: unknown } | undefined;

function track(run: Promise<CodexProbeResult>): { readonly current: Outcome } {
  const holder: { current: Outcome } = { current: undefined };
  run.then(
    (ok) => {
      holder.current = { ok };
    },
    (error: unknown) => {
      holder.current = { error };
    },
  );
  return holder;
}

function assertAborted(outcome: Outcome): void {
  assert.ok(outcome !== undefined, 'run() must settle once it is aborted');
  assert.ok('error' in outcome, `expected an AbortError rejection, got ${JSON.stringify(outcome)}`);
  assert.equal((outcome.error as Error).name, 'AbortError');
}

suite('CodexAppServerProbe: cancellation', () => {
  test('An already-aborted signal rejects with AbortError and never invokes the runner', async () => {
    const { runner, state } = controlledRunner();
    const { probe, records } = makeProbe(runner);
    const controller = new AbortController();
    controller.abort();

    const outcome = track(probe.run(controller.signal));
    await nextTurn();

    assertAborted(outcome.current);
    assert.equal(state.calls, 0, 'a cancelled probe must spawn nothing');
    assert.deepEqual(records, [], 'cancellation is not a probe failure');
  });

  test('The signal reaches the runner request so it can stop its own process starts', async () => {
    const { runner, state, initialize, rateLimits } = controlledRunner();
    const { probe } = makeProbe(runner);
    const controller = new AbortController();
    const run = probe.run(controller.signal);
    initialize.resolve(FIXTURE.initialize);
    rateLimits.resolve({ rateLimits: FIXTURE.rateLimits });
    await run;
    assert.equal(state.requests[0]?.signal, controller.signal);
  });

  test('Abort while awaiting initialize settles at once, kills the child, records nothing', async () => {
    const { runner, state, initialize, rateLimits } = controlledRunner();
    const { probe, records } = makeProbe(runner);
    const controller = new AbortController();
    try {
      const outcome = track(probe.run(controller.signal));
      await nextTurn();
      assert.deepEqual(state.methods, ['initialize']);

      controller.abort();
      await nextTurn();

      // No waiting out the 60s per-reply timeout.
      assertAborted(outcome.current);
      assert.equal(state.killCount, 1, 'the child is killed exactly once');
      assert.deepEqual(records, [], 'cancellation is not a probe failure');
    } finally {
      initialize.resolve(FIXTURE.initialize);
      rateLimits.resolve({ rateLimits: FIXTURE.rateLimits });
    }
  });

  test('An initialize reply arriving after abort never leads to account/rateLimits/read', async () => {
    const { runner, state, initialize } = controlledRunner();
    // Short reply timeout so an implementation that ignores the signal still
    // settles (by timing out) and the assertion below reports the real defect.
    const { probe } = makeProbe(runner, 200);
    const controller = new AbortController();
    const outcome = track(probe.run(controller.signal));
    await nextTurn();

    controller.abort();
    initialize.resolve(FIXTURE.initialize);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(state.methods, ['initialize'], 'nothing may be sent after cancellation');
    assertAborted(outcome.current);
  });

  test('Abort while the runner is still starting kills the late child and writes nothing', async () => {
    const { runner, state, started } = controlledRunner({ gateStart: true });
    const { probe } = makeProbe(runner, 200);
    const controller = new AbortController();
    const outcome = track(probe.run(controller.signal));
    await nextTurn();
    assert.equal(state.calls, 1);

    controller.abort();
    started.resolve();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(state.methods, [], 'a child that started after abort is never driven');
    assert.equal(state.killCount, 1, 'a child that started after abort is killed');
    assertAborted(outcome.current);
  });

  test('Race: abort in the same tick as the initialize reply — abort wins, nothing more is sent', async () => {
    const { runner, state, initialize, rateLimits } = controlledRunner();
    const { probe } = makeProbe(runner);
    const controller = new AbortController();
    try {
      const outcome = track(probe.run(controller.signal));
      await nextTurn();

      initialize.resolve(FIXTURE.initialize);
      controller.abort();
      await nextTurn();

      assert.deepEqual(state.methods, ['initialize']);
      assertAborted(outcome.current);
      assert.equal(state.killCount, 1);
    } finally {
      rateLimits.resolve({ rateLimits: FIXTURE.rateLimits });
    }
  });

  test('Race: abort in the same tick as the rateLimits reply — no result is delivered', async () => {
    const { runner, state, initialize, rateLimits } = controlledRunner();
    const { probe, records } = makeProbe(runner);
    const controller = new AbortController();
    const outcome = track(probe.run(controller.signal));
    initialize.resolve(FIXTURE.initialize);
    await nextTurn();
    assert.deepEqual(state.methods, ['initialize', 'initialized', 'account/rateLimits/read']);

    rateLimits.resolve({ rateLimits: FIXTURE.rateLimits });
    controller.abort();
    await nextTurn();

    assertAborted(outcome.current);
    assert.equal(state.killCount, 1);
    assert.deepEqual(records, []);
  });

  test('Abort after run() resolved is a no-op and leaves no abort listener behind', async () => {
    const { runner, state, initialize, rateLimits } = controlledRunner();
    const { probe } = makeProbe(runner);
    const controller = new AbortController();
    const run = probe.run(controller.signal);
    initialize.resolve(FIXTURE.initialize);
    rateLimits.resolve({ rateLimits: FIXTURE.rateLimits });
    const result = await run;

    assert.equal(result.ok, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort();
    await nextTurn();
    assert.equal(state.killCount, 1, 'the completed child is not killed twice');
  });

  test('A long-lived signal accumulates no abort listeners across success, timeout and failure', async () => {
    // The loop hands every probe in its lifetime the same signal.
    const controller = new AbortController();
    const listeners = (): number => getEventListeners(controller.signal, 'abort').length;

    const success = controlledRunner();
    success.initialize.resolve(FIXTURE.initialize);
    success.rateLimits.resolve({ rateLimits: FIXTURE.rateLimits });
    assert.equal((await makeProbe(success.runner).probe.run(controller.signal)).ok, true);
    assert.equal(listeners(), 0, 'after success');

    const hung = controlledRunner();
    const timedOut = await makeProbe(hung.runner, 20).probe.run(controller.signal);
    assert.equal(timedOut.ok ? 'ok' : timedOut.reason, 'codex_probe_timeout');
    assert.equal(listeners(), 0, 'after timeout');

    const drift = controlledRunner();
    drift.initialize.resolve(FIXTURE.initialize);
    drift.rateLimits.resolve({ rateLimits: 'not-an-object' });
    const drifted = await makeProbe(drift.runner).probe.run(controller.signal);
    assert.equal(drifted.ok ? 'ok' : drifted.reason, 'codex_protocol_drift');
    assert.equal(listeners(), 0, 'after protocol drift');

    const throwing: CodexProbeRunner = async () => {
      throw new Error('spawn failed');
    };
    const failed = await makeProbe(throwing).probe.run(controller.signal);
    assert.equal(failed.ok ? 'ok' : failed.reason, 'codex_probe_failed');
    assert.equal(listeners(), 0, 'after a runner failure');
  });
});
