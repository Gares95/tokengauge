// The REAL CodexProbeRunner — the single place
// a `codex app-server` child process is spawned. It is constructed ONLY behind
// the nativeStatusProbe consent gate (extension.ts); the default profile never
// imports or invokes it (provably zero spawn).
//
// Spawn discipline (CodexAppServerProbe header contract, enforced here):
//   - fixed argv from request.args (exactly ['app-server']); shell:false.
//   - bounded explicit env allowlist from request.env (see
//     CodexAppServerProbe.buildEnv) — the full host env is NEVER passed through.
//   - hard timeout: a watchdog kills the child after request.timeoutMs even if
//     the probe's own withTimeout does not fire.
//   - kill on EVERY settle path — the probe calls kill() in its finally; this
//     runner also kills on spawn error / exit so no child outlives the exchange.
//   - stderr is buffered (bounded) but NEVER surfaced into a result/diagnostic —
//     the probe's fail() funnel records rule-id-only.
//
// The exchange is newline-delimited JSON-RPC: writeLine appends one JSON object
// + '\n' to stdin; readResult resolves the `result` payload for a correlated id
// by scanning parsed stdout lines. Notifications / mismatched ids are ignored.

import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  CodexCliResolverLabel,
  CodexCliResolverStage,
  CodexProbeExchange,
  CodexProbeRunRequest,
  CodexProbeRunResult,
} from './CodexAppServerProbe';

// Bound the buffered stderr so a chatty child can never grow memory unbounded.
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_RESOLVER_OUTPUT_BYTES = 2048;
const SHELL_RESOLVE_COMMAND = 'command -v codex';
const USER_SHELL_RESOLVE_TIMEOUT_MS = 2_500;
const MAX_NVM_VERSION_CANDIDATES = 48;

export async function spawnCodexAppServerExchange(
  request: CodexProbeRunRequest,
): Promise<CodexProbeRunResult> {
  const fromPath = await spawnCodexAppServerProcess(
    'codex',
    'extension_path',
    'extension_path_found',
    'extension_path_not_found',
    request,
  );
  if (fromPath.found) {
    return fromPath;
  }

  const resolved = await resolveCodexExecutableFromUserShell(request);
  if (resolved !== null) {
    const fromShell = await spawnCodexAppServerProcess(
      resolved.executable,
      resolved.resolver,
      resolved.foundStage,
      'user_shell_not_found',
      request,
    );
    if (fromShell.found) {
      return fromShell;
    }
  }

  const userBin = resolveCodexExecutableFromCommonUserBins(request);
  if (userBin !== null) {
    const fromUserBin = await spawnCodexAppServerProcess(
      userBin.executable,
      userBin.resolver,
      userBin.foundStage,
      'user_bin_not_found',
      request,
    );
    if (fromUserBin.found) {
      return fromUserBin;
    }
  }

  const nvm = resolveCodexExecutableFromNvm(request);
  if (nvm !== null) {
    const fromNvm = await spawnCodexAppServerProcess(
      nvm.executable,
      nvm.resolver,
      nvm.foundStage,
      'nvm_not_found',
      request,
    );
    if (fromNvm.found) {
      return fromNvm;
    }
  }

  return notFoundResult('nvm_not_found');
}

function spawnCodexAppServerProcess(
  executable: string,
  cliResolver: CodexCliResolverLabel,
  foundStage: CodexCliResolverStage,
  notFoundStage: CodexCliResolverStage,
  request: CodexProbeRunRequest,
): Promise<CodexProbeRunResult> {
  return new Promise<CodexProbeRunResult>((resolve) => {
    let settled = false;
    let stderr = '';

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...request.args], {
        shell: false,
        env: { ...request.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // A stable cwd (the user's home) — the ext host's default
        // cwd is unpredictable and codex app-server startup can be cwd-sensitive.
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      });
    } catch {
      resolve({
        found: false,
        cliResolver,
        cliResolverStage: notFoundStage,
        stderr: '',
        exchange: null,
        kill: () => {},
      });
      return;
    }

    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone — nothing to do.
      }
    };

    // Hard watchdog: independent of the probe's per-call timeout, guarantees the
    // child cannot outlive the bounded exchange.
    const watchdog = setTimeout(kill, Math.max(1, request.timeoutMs));
    if (typeof watchdog.unref === 'function') {
      watchdog.unref();
    }

    // Resolve the run result exactly once. `found:false` only on ENOENT.
    const settle = (result: CodexProbeRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(result);
    };

    child.once('error', () => {
      kill();
      settle({
        found: false,
        cliResolver,
        cliResolverStage: notFoundStage,
        stderr: '',
        exchange: null,
        kill,
      });
    });

    const stdin = child.stdin;
    const stdout = child.stdout;
    if (stdin === null || stdout === null) {
      kill();
      settle({
        found: true,
        cliResolver,
        cliResolverStage: foundStage,
        stderr: '',
        exchange: null,
        kill,
      });
      return;
    }

    if (child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer) => {
        // round 9: a stderr-seen marker (boolean only) — never the raw stderr text.
        request.onIo?.('stderr_chunk');
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - stderr.length);
        }
      });
    }

    // A RAW stdout-chunk marker, distinct from a parsed
    // line, so "child produced output at all" is separable from "we parsed a line".
    // No raw bytes cross — the listener only signals that a chunk arrived.
    stdout.on('data', () => request.onIo?.('stdout_chunk_received'));

    // Parsed stdout lines awaiting correlation. A readResult before its line
    // arrives parks a resolver keyed by id; a line for an unawaited id is queued.
    const pendingById = new Map<number, (value: unknown) => void>();
    const bufferedById = new Map<number, unknown>();

    const rl = createInterface({ input: stdout });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      request.onIo?.('stdout_line_received');
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // non-JSON banner / log line — ignore.
      }
      if (parsed === null || typeof parsed !== 'object') return;
      request.onIo?.('stdout_json_parsed');
      const record = parsed as { id?: unknown; result?: unknown };
      if (typeof record.id !== 'number') {
        // A method/notification line (e.g. remoteControl/status/changed) — observed,
        // ignored for correlation. Marker only; no payload crosses.
        request.onIo?.('notification_received');
        return;
      }
      const id = record.id;
      const payload = record.result;
      request.onIo?.('response_matched');
      const waiter = pendingById.get(id);
      if (waiter !== undefined) {
        pendingById.delete(id);
        waiter(payload);
      } else {
        bufferedById.set(id, payload);
      }
    });

    const exchange: CodexProbeExchange = {
      writeLine: (obj: unknown): void => {
        try {
          request.onIo?.('stdin_write_started');
          stdin.write(`${JSON.stringify(obj)}\n`);
          request.onIo?.('stdin_write_completed');
        } catch {
          // A write after the child died surfaces as a readResult timeout in the
          // probe — never a throw here.
        }
      },
      readResult: (id: number): Promise<unknown> => {
        if (bufferedById.has(id)) {
          const value = bufferedById.get(id);
          bufferedById.delete(id);
          return Promise.resolve(value);
        }
        return new Promise<unknown>((resolveResult) => {
          pendingById.set(id, resolveResult);
        });
      },
    };

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Report a sanitized exit BUCKET (never the raw code/signal)
      // so a no-output timeout can be told apart from a child that exited early
      // (wrong binary / startup error vs a genuine hang).
      request.onExit?.(
        signal !== null ? 'signal' : code === 0 ? 'zero' : code === null ? 'none' : 'nonzero',
      );
      kill();
    });

    child.once('spawn', () => {
      settle({ found: true, cliResolver, cliResolverStage: foundStage, stderr, exchange, kill });
    });
  });
}

function notFoundResult(cliResolverStage: CodexCliResolverStage): CodexProbeRunResult {
  return {
    found: false,
    cliResolver: 'not_found',
    cliResolverStage,
    stderr: '',
    exchange: null,
    kill: () => {},
  };
}

async function resolveCodexExecutableFromUserShell(
  request: CodexProbeRunRequest,
): Promise<ResolvedCodexExecutable | null> {
  const shellPath = validateUserShell(request.env.SHELL);
  if (shellPath === null) {
    return null;
  }

  const args = shellArgsForResolver(shellPath);
  const timeoutMs = Math.max(1, Math.min(USER_SHELL_RESOLVE_TIMEOUT_MS, request.timeoutMs));
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let outputOverflow = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shellPath, args, {
        shell: false,
        env: { ...request.env },
        stdio: ['ignore', 'pipe', 'ignore'],
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      });
    } catch {
      resolve(null);
      return;
    }

    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone — nothing to do.
      }
    };

    const timer = setTimeout(() => {
      kill();
      settle(null);
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        value === null
          ? null
          : { executable: value, resolver: 'user_shell', foundStage: 'user_shell_found' },
      );
    };

    if (child.stdout === null) {
      kill();
      settle(null);
      return;
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length >= MAX_RESOLVER_OUTPUT_BYTES) {
        outputOverflow = true;
        kill();
        return;
      }
      const remaining = MAX_RESOLVER_OUTPUT_BYTES - output.length;
      const text = chunk.toString('utf8');
      output += text.slice(0, remaining);
      if (text.length > remaining) {
        outputOverflow = true;
        kill();
      }
    });

    child.once('error', () => {
      kill();
      settle(null);
    });

    child.once('close', (code: number | null) => {
      if (code !== 0 || outputOverflow) {
        settle(null);
        return;
      }
      settle(validateResolvedCodexExecutable(output));
    });
  });
}

function validateUserShell(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0 || raw.length > 512) return null;
  if (raw.includes('\0') || /[\r\n]/.test(raw)) return null;
  if (!isAbsolute(raw)) return null;
  const base = stripKnownExecutableExtension(basename(raw).toLowerCase());
  if (!new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish']).has(base)) return null;
  return raw;
}

function shellArgsForResolver(shellPath: string): readonly string[] {
  const base = stripKnownExecutableExtension(basename(shellPath).toLowerCase());
  if (base === 'sh' || base === 'dash') {
    return ['-c', SHELL_RESOLVE_COMMAND];
  }
  return ['-lc', SHELL_RESOLVE_COMMAND];
}

function validateResolvedCodexExecutable(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_RESOLVER_OUTPUT_BYTES) return null;
  if (raw.includes('\0')) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RESOLVER_OUTPUT_BYTES) return null;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length !== 1) return null;
  const value = lines[0].trim();
  if (value.length === 0 || /[\r\n]/.test(value)) return null;
  if (!isAbsolute(value)) return null;
  if (!isCodexExecutableBasename(value)) return null;
  if (!isExecutableFile(value)) return null;
  return value;
}

function resolveCodexExecutableFromCommonUserBins(
  request: CodexProbeRunRequest,
): ResolvedCodexExecutable | null {
  const home = validateAbsolutePath(request.env.HOME);
  if (home === null) return null;
  const roots = [join(home, '.local', 'bin'), join(home, 'bin'), join(home, '.npm-global', 'bin')];
  for (const root of roots) {
    const candidate = join(root, 'codex');
    if (validateRootedCodexExecutable(candidate, root) !== null) {
      return { executable: candidate, resolver: 'user_bin', foundStage: 'user_bin_found' };
    }
  }
  return null;
}

function resolveCodexExecutableFromNvm(
  request: CodexProbeRunRequest,
): ResolvedCodexExecutable | null {
  const roots = nvmRoots(request.env);
  for (const root of roots) {
    const active = validateNvmActiveCandidate(root, request.env.NVM_BIN);
    if (active !== null) {
      return { executable: active, resolver: 'nvm', foundStage: 'nvm_found' };
    }

    const versionsRoot = join(root, 'versions', 'node');
    let entries: string[];
    try {
      entries = readdirSync(versionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => /^[A-Za-z0-9._-]{1,64}$/.test(name))
        .sort(compareNodeVersionDesc)
        .slice(0, MAX_NVM_VERSION_CANDIDATES);
    } catch {
      continue;
    }

    for (const versionDir of entries) {
      const candidate = join(versionsRoot, versionDir, 'bin', 'codex');
      if (validateRootedCodexExecutable(candidate, root) !== null) {
        return { executable: candidate, resolver: 'nvm', foundStage: 'nvm_found' };
      }
    }
  }
  return null;
}

interface ResolvedCodexExecutable {
  readonly executable: string;
  readonly resolver: CodexCliResolverLabel;
  readonly foundStage: CodexCliResolverStage;
}

function nvmRoots(env: Readonly<Record<string, string>>): readonly string[] {
  const out: string[] = [];
  const explicit = validateAbsolutePath(env.NVM_DIR);
  if (explicit !== null) out.push(resolve(explicit));
  const home = validateAbsolutePath(env.HOME);
  if (home !== null) out.push(resolve(home, '.nvm'));
  return Array.from(new Set(out));
}

function validateNvmActiveCandidate(root: string, nvmBin: string | undefined): string | null {
  const bin = validateAbsolutePath(nvmBin);
  if (bin === null) return null;
  return validateRootedCodexExecutable(join(bin, 'codex'), root);
}

function validateAbsolutePath(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0 || raw.length > 1024) return null;
  if (raw.includes('\0') || /[\r\n]/.test(raw)) return null;
  if (!isAbsolute(raw)) return null;
  return raw;
}

function validateRootedCodexExecutable(candidate: string, root: string): string | null {
  if (!isCodexExecutableBasename(candidate)) return null;
  if (!isUnderRoot(candidate, root)) return null;
  if (!isExecutableFile(candidate)) return null;
  if (!realPathIsUnderRoot(candidate, root)) return null;
  return candidate;
}

function isExecutableFile(value: string): boolean {
  try {
    const stat = statSync(value);
    if (!stat.isFile()) return false;
    accessSync(value, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUnderRoot(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realPathIsUnderRoot(candidate: string, root: string): boolean {
  try {
    const realCandidate = realpathSync(candidate);
    const realRoot = realpathSync(root);
    return isUnderRoot(realCandidate, realRoot);
  } catch {
    return false;
  }
}

function compareNodeVersionDesc(a: string, b: string): number {
  const parsedA = parseNodeVersion(a);
  const parsedB = parseNodeVersion(b);
  for (let i = 0; i < parsedA.length; i += 1) {
    const delta = parsedB[i] - parsedA[i];
    if (delta !== 0) return delta;
  }
  return b.localeCompare(a);
}

function parseNodeVersion(value: string): readonly number[] {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (match === null) return [0, 0, 0];
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function isCodexExecutableBasename(value: string): boolean {
  const base = stripKnownExecutableExtension(basename(value).toLowerCase());
  return base === 'codex';
}

function stripKnownExecutableExtension(value: string): string {
  return value.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}
