// Child-process lifecycle of the Codex app-server runner.
//
// These drive the REAL runner against throwaway shell-script stand-ins for
// `codex` written to a temp dir. The real codex binary never runs, no account
// or credential is touched, and every assertion waits on an observable event
// (a pid file appearing, a pid disappearing) under a generous bound rather than
// on a fixed sleep, so the outcome does not depend on machine speed.

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexAppServerProbe } from '../../../../src/adapters/codex/CodexAppServerProbe';
import { spawnCodexAppServerExchange } from '../../../../src/adapters/codex/spawnCodexAppServer';

function skipWindowsShellScripts(ctx: Mocha.Context): void {
  if (process.platform === 'win32') {
    ctx.skip();
  }
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-lifecycle-'));
}

function writeExecutable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

// A stand-in that records its own pid, then idles reading stdin. It never
// answers, so only a kill ends it.
function writePidRecordingCodex(file: string): void {
  writeExecutable(
    file,
    '#!/bin/sh\necho $$ > "$TG_PID_FILE"\nwhile IFS= read -r _line; do :; done\n',
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(condition: () => boolean, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

async function readPid(pidFile: string): Promise<number> {
  const appeared = await waitFor(
    () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0,
    2_000,
  );
  assert.ok(appeared, 'the stand-in codex never started');
  return Number(fs.readFileSync(pidFile, 'utf8').trim());
}

suite('SpawnCodexAppServer lifecycle — watchdog and stdio errors', () => {
  test('The watchdog kills a child whose caller never calls kill()', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    writePidRecordingCodex(path.join(bin, 'codex'));
    const pidFile = path.join(root, 'codex.pid');

    const result = await spawnCodexAppServerExchange({
      args: ['app-server'],
      env: { PATH: bin, HOME: root, TG_PID_FILE: pidFile },
      shell: false,
      timeoutMs: 100,
      cwd: root,
    });
    try {
      assert.equal(result.found, true);
      const pid = await readPid(pidFile);
      // Deliberately no result.kill(): the runner's own watchdog must bound the
      // child's lifetime even when the caller abandons it.
      const exited = await waitFor(() => !isAlive(pid), 3_000);
      assert.ok(exited, 'child outlived the watchdog bound (timeoutMs=100)');
    } finally {
      result.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A child that answers initialize and then closes its stdin (as a crashing or
  // exiting app-server does) makes the probe's next write fail with EPIPE. That
  // failure must stay inside the exchange: an unhandled stream 'error' would be
  // an uncaught exception in the extension host (mocha reports it as a failure).
  test('A write to a child that closed its stdin never raises an uncaught error', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    writeExecutable(
      path.join(bin, 'codex'),
      `#!/bin/sh
IFS= read -r _line
exec 0<&-
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-cli/fixture"}}'
exec sleep 5
`,
    );

    try {
      const probe = new CodexAppServerProbe({
        extensionVersion: '1.2.3',
        timeoutMs: 300,
        cwd: root,
        runner: (request) =>
          spawnCodexAppServerExchange({ ...request, env: { PATH: bin, HOME: root }, cwd: root }),
      });
      const result = await probe.run();
      assert.equal(result.ok, false);
      if (result.ok) return;
      // The lost reply is still reported through the existing closed reason.
      assert.equal(result.reason, 'codex_probe_timeout');
      assert.equal(result.stage, 'ratelimits_sent');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite('SpawnCodexAppServer lifecycle — cancellation', () => {
  test('An already-aborted signal starts no process and rejects with AbortError', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    writePidRecordingCodex(path.join(bin, 'codex'));
    const pidFile = path.join(root, 'codex.pid');
    const controller = new AbortController();
    controller.abort();

    const outcome = await spawnCodexAppServerExchange({
      args: ['app-server'],
      env: { PATH: bin, HOME: root, TG_PID_FILE: pidFile },
      shell: false,
      timeoutMs: 60_000,
      cwd: root,
      signal: controller.signal,
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(fs.existsSync(pidFile), false, 'a cancelled probe must not spawn codex');
      assert.ok('error' in outcome, 'expected a rejection');
      assert.equal((outcome.error as Error).name, 'AbortError');
    } finally {
      if ('result' in outcome) outcome.result.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Abort kills the spawned child, spares an unrelated codex process, and drops its listener', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const codex = path.join(bin, 'codex');
    writePidRecordingCodex(codex);
    const ownPidFile = path.join(root, 'own.pid');
    const otherPidFile = path.join(root, 'other.pid');
    // A codex process TokenGauge did not start (e.g. the user's own session).
    const unrelated = spawn(codex, ['app-server'], {
      env: { PATH: bin, TG_PID_FILE: otherPidFile },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const controller = new AbortController();
    let result: Awaited<ReturnType<typeof spawnCodexAppServerExchange>> | undefined;
    try {
      const otherPid = await readPid(otherPidFile);
      result = await spawnCodexAppServerExchange({
        args: ['app-server'],
        env: { PATH: bin, HOME: root, TG_PID_FILE: ownPidFile },
        shell: false,
        // Far beyond the test: only the abort can end this child.
        timeoutMs: 60_000,
        cwd: root,
        signal: controller.signal,
      });
      assert.equal(result.found, true);
      const ownPid = await readPid(ownPidFile);

      controller.abort();

      assert.ok(await waitFor(() => !isAlive(ownPid), 2_000), 'abort must kill our child');
      assert.equal(isAlive(otherPid), true, 'an unrelated codex process must survive');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      result?.kill();
      unrelated.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The extension-PATH lookup misses, so the runner asks the user's login
  // shell where codex is (up to 2.5s). Disabling the probe during that lookup
  // must end the chain: the shell is killed and codex is never started.
  test('Abort during the login-shell lookup kills the shell and never starts codex', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const emptyPath = path.join(root, 'empty-path');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(emptyPath);
    fs.mkdirSync(bin);
    const codex = path.join(bin, 'codex');
    writeExecutable(
      codex,
      '#!/bin/sh\n: > "$TG_MARK_DIR/codex-started"\nwhile IFS= read -r _line; do :; done\n',
    );
    // A stand-in login shell: records its pid, blocks until released, then
    // prints the codex path as `command -v codex` would.
    const shell = path.join(root, 'bash');
    writeExecutable(
      shell,
      `#!/bin/sh
PATH=/usr/bin:/bin
export PATH
echo $$ > "$TG_MARK_DIR/resolver.pid"
while [ ! -e "$TG_MARK_DIR/release" ]; do sleep 0.02; done
printf '%s\\n' "$TG_CODEX"
`,
    );
    const controller = new AbortController();
    let outcome:
      | { result: Awaited<ReturnType<typeof spawnCodexAppServerExchange>> }
      | { error: unknown }
      | undefined;
    try {
      const pending = spawnCodexAppServerExchange({
        args: ['app-server'],
        env: { PATH: emptyPath, HOME: root, SHELL: shell, TG_MARK_DIR: root, TG_CODEX: codex },
        shell: false,
        timeoutMs: 60_000,
        cwd: root,
        signal: controller.signal,
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const resolverPid = await readPid(path.join(root, 'resolver.pid'));

      controller.abort();
      // Let a shell that ignored the abort finish its lookup.
      fs.writeFileSync(path.join(root, 'release'), '');
      outcome = await pending;
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(
        fs.existsSync(path.join(root, 'codex-started')),
        false,
        'codex app-server was started after the probe was cancelled',
      );
      assert.ok('error' in outcome, 'expected a rejection');
      assert.equal((outcome.error as Error).name, 'AbortError');
      assert.ok(await waitFor(() => !isAlive(resolverPid), 2_000), 'abort must kill the shell');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      if (outcome !== undefined && 'result' in outcome) outcome.result.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Lookups that find nothing leave no abort listener on a long-lived signal', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const emptyPath = path.join(root, 'empty-path');
    fs.mkdirSync(emptyPath);
    const controller = new AbortController();
    try {
      const result = await spawnCodexAppServerExchange({
        args: ['app-server'],
        env: { PATH: emptyPath, HOME: root, SHELL: path.join(root, 'not-a-shell') },
        shell: false,
        timeoutMs: 1_000,
        cwd: root,
        signal: controller.signal,
      });
      assert.equal(result.found, false);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
