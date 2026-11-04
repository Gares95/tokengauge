// Child-process lifecycle of the Codex app-server runner.
//
// These drive the REAL runner against throwaway shell-script stand-ins for
// `codex` written to a temp dir. The real codex binary never runs, no account
// or credential is touched, and every assertion waits on an observable event
// (a pid file appearing, a pid disappearing) under a generous bound rather than
// on a fixed sleep, so the outcome does not depend on machine speed.

import * as assert from 'node:assert/strict';
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
