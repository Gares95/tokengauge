// The Codex app-server probe is stdio JSON-RPC —
// child_process.spawn with stdio pipes, NEVER a network port. This static-source
// assertion is the companion to the mechanical no-server gate
// (tools/check-no-network-default.mjs): it pins the spawn discipline at the one
// place a child process is created, so a future edit that swaps stdio for a TCP
// port is caught here as well as by the gate.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexAppServerProbe } from '../../../../src/adapters/codex/CodexAppServerProbe';
import { spawnCodexAppServerExchange } from '../../../../src/adapters/codex/spawnCodexAppServer';
import { findRepoRoot } from '../../../_helpers/repoRoot';

function readSpawnSource(): string {
  const file = path.join(findRepoRoot(), 'src/adapters/codex/spawnCodexAppServer.ts');
  return fs.readFileSync(file, 'utf8');
}

function readExtensionSource(): string {
  const file = path.join(findRepoRoot(), 'src/extension.ts');
  return fs.readFileSync(file, 'utf8');
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-resolver-'));
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeExecutable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function writePassiveCodex(file: string): void {
  writeExecutable(file, '#!/bin/sh\nwhile IFS= read -r _line; do :; done\n');
}

function writeResolverShell(file: string, output: string): void {
  writeExecutable(file, `#!/bin/sh\nprintf '%s' ${shQuote(output)}\n`);
}

function writeTimeoutShell(file: string): void {
  writeExecutable(file, '#!/bin/sh\nwhile :; do :; done\n');
}

function writeCodexAppServer(file: string): void {
  writeExecutable(
    file,
    `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-cli/fixture"}}'
      ;;
    *'"method":"account/rateLimits/read"'*)
      printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"primary":{"usedPercent":12,"windowDurationMins":300,"resetsAt":null},"secondary":{"usedPercent":34,"windowDurationMins":10080,"resetsAt":null}}}}'
      ;;
  esac
done
`,
  );
}

function skipWindowsShellScripts(ctx: Mocha.Context): void {
  if (process.platform === 'win32') {
    ctx.skip();
  }
}

function bashForLoginShellTest(ctx: Mocha.Context): string {
  skipWindowsShellScripts(ctx);
  for (const candidate of ['/bin/bash', '/usr/bin/bash']) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  ctx.skip();
}

function writeBashProfile(root: string, bin: string): void {
  fs.writeFileSync(path.join(root, '.bash_profile'), `PATH=${shQuote(bin)}:$PATH\nexport PATH\n`);
}

function nvmCodexPath(nvmRoot: string, version: string): string {
  return path.join(nvmRoot, 'versions', 'node', version, 'bin', 'codex');
}

function nvmBinPath(nvmRoot: string, version: string): string {
  return path.dirname(nvmCodexPath(nvmRoot, version));
}

function prepareNvmBin(nvmRoot: string, version: string): string {
  const bin = nvmBinPath(nvmRoot, version);
  fs.mkdirSync(bin, { recursive: true });
  return bin;
}

function nvmEnv(root: string, nvmRoot: string): Record<string, string> {
  return {
    PATH: path.join(root, 'empty-path'),
    HOME: root,
    NVM_DIR: nvmRoot,
    SHELL: path.join(root, 'not-a-shell'),
  };
}

suite('SpawnCodexAppServer stdio discipline — no port', () => {
  test('Spawns via child_process.spawn with stdio pipes', () => {
    const src = readSpawnSource();
    assert.match(src, /from\s+['"]node:child_process['"]/, 'must import child_process');
    assert.match(
      src,
      /spawnCodexAppServerProcess\(\s*'codex'\s*,\s*'extension_path'/,
      "must try the 'codex' binary on the extension PATH first",
    );
    assert.match(src, /spawn\(\s*executable/, 'must spawn only the resolved executable');
    assert.match(src, /stdio:\s*\[\s*'pipe',\s*'pipe',\s*'pipe'\s*\]/, 'must use stdio pipes');
  });

  // The runner wires the sanitized onIo seam at the key
  // child-process I/O points so a WSL hang is diagnosable. A future edit that drops
  // the instrumentation is caught here (closed-set markers only — never raw output).
  test('Wires the sanitized onIo I/O markers', () => {
    const src = readSpawnSource();
    for (const marker of [
      'stdin_write_completed',
      'stdout_chunk_received',
      'stdout_line_received',
      'stdout_json_parsed',
      'response_matched',
      'stderr_chunk',
    ]) {
      assert.match(src, new RegExp(`onIo\\?\\.\\('${marker}'\\)`), `must emit onIo ${marker}`);
    }
    // never passes raw stdout/stderr text through the seam (boolean/label markers).
    assert.doesNotMatch(src, /onIo\?\.\(\s*chunk/, 'onIo must not forward raw chunk data');
  });

  test('Opens no network listener/server/port', () => {
    const src = readSpawnSource();
    assert.doesNotMatch(src, /\.\s*listen\s*\(/, 'no .listen(');
    assert.doesNotMatch(src, /createServer\s*\(/, 'no createServer(');
    assert.doesNotMatch(
      src,
      /WebSocketServer|new\s+WebSocket\s*\.\s*Server/,
      'no WebSocket server',
    );
    assert.doesNotMatch(src, /dgram\s*\.\s*createSocket/, 'no dgram socket');
    assert.doesNotMatch(src, /\bport\s*:/, 'no port option in the spawn');
  });

  test('Async spawn failure returns not found before exposing a fake no-response exchange', async () => {
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-empty-path-'));
    const ioEvents: string[] = [];
    try {
      const result = await spawnCodexAppServerExchange({
        args: ['app-server'],
        env: {
          PATH: emptyPath,
          ...(process.platform === 'win32' ? { PATHEXT: '.EXE;.CMD;.BAT' } : {}),
        },
        shell: false,
        timeoutMs: 1_000,
        cwd: emptyPath,
        onIo: (event) => {
          ioEvents.push(event);
        },
      });

      assert.equal(result.found, false);
      assert.equal(result.exchange, null);
      assert.ok(!ioEvents.includes('stdin_write_started'), 'must not write to a failed spawn');
      assert.ok(!ioEvents.includes('stdin_write_completed'), 'must not report a fake stdin write');
      assert.ok(!ioEvents.includes('stdout_chunk_received'), 'must not report fake stdout absence');
    } finally {
      fs.rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  test('Extension PATH finds Codex before invoking the shell resolver', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    writePassiveCodex(path.join(bin, 'codex'));
    const result = await spawnCodexAppServerExchange({
      args: ['app-server'],
      env: { PATH: bin, HOME: root, SHELL: path.join(root, 'not-a-shell') },
      shell: false,
      timeoutMs: 1_000,
      cwd: root,
    });

    try {
      assert.equal(result.found, true, `resolver=${result.cliResolver ?? 'none'}`);
      assert.equal(result.cliResolver, 'extension_path');
      assert.ok(result.exchange, 'extension PATH spawn should expose an exchange');
    } finally {
      result.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Extension PATH missing Codex but user shell resolver finds Codex', async function () {
    const shell = bashForLoginShellTest(this);
    const root = makeTempRoot();
    const emptyPath = path.join(root, 'empty-path');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(emptyPath);
    fs.mkdirSync(bin);
    const codex = path.join(bin, 'codex');
    writePassiveCodex(codex);
    writeBashProfile(root, bin);

    const result = await spawnCodexAppServerExchange({
      args: ['app-server'],
      env: { PATH: emptyPath, HOME: root, SHELL: shell },
      shell: false,
      timeoutMs: 1_000,
      cwd: root,
    });

    try {
      assert.equal(result.found, true, `resolver=${result.cliResolver ?? 'none'}`);
      assert.equal(result.cliResolver, 'user_shell');
      assert.ok(result.exchange, 'shell-resolved spawn should expose an exchange');
    } finally {
      result.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const variant of ['empty', 'invalid', 'timeout'] as const) {
    test(`shell resolver ${variant} result returns not_found without fake I/O`, async function () {
      skipWindowsShellScripts(this);
      const root = makeTempRoot();
      const emptyPath = path.join(root, 'empty-path');
      fs.mkdirSync(emptyPath);
      const shell = path.join(root, 'bash');
      if (variant === 'empty') {
        writeResolverShell(shell, '');
      } else if (variant === 'invalid') {
        writeResolverShell(shell, `${path.join(root, 'not-codex')}\n`);
      } else {
        writeTimeoutShell(shell);
      }
      const ioEvents: string[] = [];

      try {
        const result = await spawnCodexAppServerExchange({
          args: ['app-server'],
          env: { PATH: emptyPath, HOME: root, SHELL: shell },
          shell: false,
          timeoutMs: variant === 'timeout' ? 50 : 1_000,
          cwd: root,
          onIo: (event) => {
            ioEvents.push(event);
          },
        });

        assert.equal(result.found, false);
        assert.equal(result.exchange, null);
        assert.equal(result.cliResolver, 'not_found');
        assert.ok(!ioEvents.includes('stdin_write_started'), 'must not write to a failed spawn');
        assert.ok(
          !ioEvents.includes('stdin_write_completed'),
          'must not report a fake stdin write',
        );
        assert.ok(
          !ioEvents.includes('stdout_chunk_received'),
          'must not report fake stdout absence',
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('NativeStatusProbe=true shell-resolved Codex proceeds to app-server probe', async function () {
    const shell = bashForLoginShellTest(this);
    const root = makeTempRoot();
    const emptyPath = path.join(root, 'empty-path');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(emptyPath);
    fs.mkdirSync(bin);
    const codex = path.join(bin, 'codex');
    writeCodexAppServer(codex);
    writeBashProfile(root, bin);
    let resolver: string | undefined;

    try {
      const probe = new CodexAppServerProbe({
        extensionVersion: '1.2.3',
        timeoutMs: 1_000,
        cwd: root,
        runner: async (request) => {
          const result = await spawnCodexAppServerExchange({
            ...request,
            env: { PATH: emptyPath, HOME: root, SHELL: shell },
            cwd: root,
            timeoutMs: 1_000,
          });
          resolver = result.cliResolver;
          return result;
        },
      });

      const result = await probe.run();
      assert.equal(resolver, 'user_shell');
      assert.equal(result.ok, true, `resolver=${resolver ?? 'none'}`);
      if (!result.ok) return;
      assert.equal(result.primary.windowDurationMins, 300);
      assert.equal(result.secondary.windowDurationMins, 10080);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NVM fallback finds Codex under HOME .nvm', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const emptyPath = path.join(root, 'empty-path');
    fs.mkdirSync(emptyPath);
    const codex = nvmCodexPath(path.join(root, '.nvm'), 'v24.14.1');
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    writePassiveCodex(codex);

    const result = await spawnCodexAppServerExchange({
      args: ['app-server'],
      env: { PATH: emptyPath, HOME: root, SHELL: path.join(root, 'not-a-shell') },
      shell: false,
      timeoutMs: 1_000,
      cwd: root,
    });

    try {
      assert.equal(result.found, true, `resolver=${result.cliResolver ?? 'none'}`);
      assert.equal(result.cliResolver, 'nvm');
      assert.equal(result.cliResolverStage, 'nvm_found');
    } finally {
      result.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NVM_DIR is respected when present', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const emptyPath = path.join(root, 'empty-path');
    const nvmRoot = path.join(root, 'custom-nvm');
    fs.mkdirSync(emptyPath);
    const codex = nvmCodexPath(nvmRoot, 'v22.11.0');
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    writePassiveCodex(codex);

    const result = await spawnCodexAppServerExchange({
      args: ['app-server'],
      env: nvmEnv(root, nvmRoot),
      shell: false,
      timeoutMs: 1_000,
      cwd: root,
    });

    try {
      assert.equal(result.found, true, `resolver=${result.cliResolver ?? 'none'}`);
      assert.equal(result.cliResolver, 'nvm');
      assert.equal(result.cliResolverStage, 'nvm_found');
    } finally {
      result.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Multiple NVM candidates are bounded and latest-version deterministic', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const nvmRoot = path.join(root, '.nvm');
    fs.mkdirSync(path.join(root, 'empty-path'));
    fs.mkdirSync(path.dirname(nvmCodexPath(nvmRoot, 'v18.19.0')), { recursive: true });
    writePassiveCodex(nvmCodexPath(nvmRoot, 'v18.19.0'));
    fs.mkdirSync(path.dirname(nvmCodexPath(nvmRoot, 'v24.14.1')), { recursive: true });
    writeCodexAppServer(nvmCodexPath(nvmRoot, 'v24.14.1'));
    const src = readSpawnSource();
    assert.match(src, /MAX_NVM_VERSION_CANDIDATES/);
    assert.match(src, /\.slice\(0,\s*MAX_NVM_VERSION_CANDIDATES\)/);

    try {
      const probe = new CodexAppServerProbe({
        extensionVersion: '1.2.3',
        timeoutMs: 1_000,
        cwd: root,
        runner: async (request) =>
          spawnCodexAppServerExchange({
            ...request,
            env: {
              PATH: path.join(root, 'empty-path'),
              HOME: root,
              SHELL: path.join(root, 'not-a-shell'),
            },
            cwd: root,
            timeoutMs: 1_000,
          }),
      });

      const result = await probe.run();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.primary.windowDurationMins, 300);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NVM non-executable candidate is rejected', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const nvmRoot = path.join(root, '.nvm');
    fs.mkdirSync(path.join(root, 'empty-path'));
    const codex = nvmCodexPath(nvmRoot, 'v24.14.1');
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    fs.chmodSync(codex, 0o644);

    try {
      const result = await spawnCodexAppServerExchange({
        args: ['app-server'],
        env: nvmEnv(root, nvmRoot),
        shell: false,
        timeoutMs: 1_000,
        cwd: root,
      });
      assert.equal(result.found, false);
      assert.equal(result.cliResolver, 'not_found');
      assert.equal(result.cliResolverStage, 'nvm_not_found');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NVM basename mismatch is rejected', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const nvmRoot = path.join(root, '.nvm');
    fs.mkdirSync(path.join(root, 'empty-path'));
    const bin = prepareNvmBin(nvmRoot, 'v24.14.1');
    writePassiveCodex(path.join(bin, 'not-codex'));

    try {
      const result = await spawnCodexAppServerExchange({
        args: ['app-server'],
        env: nvmEnv(root, nvmRoot),
        shell: false,
        timeoutMs: 1_000,
        cwd: root,
      });
      assert.equal(result.found, false);
      assert.equal(result.cliResolverStage, 'nvm_not_found');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NVM candidate escaping the NVM root is rejected', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const nvmRoot = path.join(root, '.nvm');
    fs.mkdirSync(path.join(root, 'empty-path'));
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const outsideCodex = path.join(outside, 'codex');
    writePassiveCodex(outsideCodex);
    const bin = prepareNvmBin(nvmRoot, 'v24.14.1');
    fs.symlinkSync(outsideCodex, path.join(bin, 'codex'));

    try {
      const result = await spawnCodexAppServerExchange({
        args: ['app-server'],
        env: nvmEnv(root, nvmRoot),
        shell: false,
        timeoutMs: 1_000,
        cwd: root,
      });
      assert.equal(result.found, false);
      assert.equal(result.cliResolverStage, 'nvm_not_found');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NVM resolver does not include raw paths in its result surface', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const nvmRoot = path.join(root, '.nvm');
    fs.mkdirSync(path.join(root, 'empty-path'));
    const codex = nvmCodexPath(nvmRoot, 'v24.14.1');
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    writePassiveCodex(codex);

    const result = await spawnCodexAppServerExchange({
      args: ['app-server'],
      env: nvmEnv(root, nvmRoot),
      shell: false,
      timeoutMs: 1_000,
      cwd: root,
    });

    try {
      assert.equal(result.cliResolver, 'nvm');
      assert.equal(JSON.stringify(result).includes(root), false);
      assert.equal(JSON.stringify(result).includes(nvmRoot), false);
    } finally {
      result.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('NativeStatusProbe=true NVM-resolved Codex proceeds to app-server probe', async function () {
    skipWindowsShellScripts(this);
    const root = makeTempRoot();
    const nvmRoot = path.join(root, '.nvm');
    fs.mkdirSync(path.join(root, 'empty-path'));
    const codex = nvmCodexPath(nvmRoot, 'v24.14.1');
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    writeCodexAppServer(codex);
    let resolver: string | undefined;

    try {
      const probe = new CodexAppServerProbe({
        extensionVersion: '1.2.3',
        timeoutMs: 1_000,
        cwd: root,
        runner: async (request) => {
          const result = await spawnCodexAppServerExchange({
            ...request,
            env: nvmEnv(root, nvmRoot),
            cwd: root,
            timeoutMs: 1_000,
          });
          resolver = result.cliResolver;
          return result;
        },
      });

      const result = await probe.run();
      assert.equal(resolver, 'nvm');
      assert.equal(result.ok, true, `resolver=${resolver ?? 'none'}`);
      if (!result.ok) return;
      assert.equal(result.primary.windowDurationMins, 300);
      assert.equal(result.secondary.windowDurationMins, 10080);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Cockpit diagnostics surfaces resolver labels only, never raw resolved paths', () => {
    const src = readExtensionSource();
    assert.match(src, /codexCliResolver:\s*cockpitCodexCliResolver/);
    assert.match(src, /codexCliResolverStage:\s*cockpitCodexCliResolverStage/);
    assert.match(src, /codex cli resolver: \$\{cockpitCodexCliResolver\}/);
    assert.match(src, /codex cli resolver stage: \$\{cockpitCodexCliResolverStage\}/);
    assert.doesNotMatch(src, /codex(?:Cli)?(?:Executable|Path)\s*:/i);
  });
});
