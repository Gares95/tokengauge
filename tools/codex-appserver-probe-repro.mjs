#!/usr/bin/env node
// Docs-faithful long-lived `codex app-server` stdio repro.
//
// PURPOSE: reproduce, OUTSIDE the extension, exactly how TokenGauge drives the
// Codex app-server — a LONG-LIVED child with stdin kept OPEN, newline-delimited
// JSON-RPC, read line-by-line — so we can tell whether a correct pipe client gets
// a response in THIS environment. This is the decisive test (NOT
// `printf … | codex app-server`, which closes stdin after one line).
//
// Run it in the SAME WSL/Remote shell where the extension is installed:
//   node tools/codex-appserver-probe-repro.mjs            # minimal allowlist env (mirrors the extension)
//   node tools/codex-appserver-probe-repro.mjs --full-env # full inherited env (to test if env is the difference)
//
// SAFE OUTPUT ONLY: sanitized stage markers + booleans + window-duration ints
// (300/10080). It prints NO raw stdout/stderr, NO account/session/path/email, NO
// usedPercent value, NO resetsAt. This is a diagnostic tool — it is NOT shipped in
// the VSIX (tools/ is excluded by .vscodeignore) and is never a production data path.

import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const fullEnv = process.argv.includes('--full-env');
const TIMEOUT_MS = 15_000;
const MAX_RESOLVER_OUTPUT_BYTES = 2048;
const SHELL_RESOLVE_COMMAND = 'command -v codex';
const USER_SHELL_RESOLVE_TIMEOUT_MS = 2_500;
const MAX_NVM_VERSION_CANDIDATES = 48;
const extensionVersion =
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';

// Mirror the extension's allowlist (src/adapters/codex/CodexAppServerProbe buildEnv).
function minimalEnv() {
  const env = { PATH: process.env.PATH ?? '' };
  const forward = [
    'HOME',
    'CODEX_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SHELL',
    'USER',
    'LOGNAME',
    'TERM',
    'TMPDIR',
    'NVM_DIR',
    'NVM_BIN',
    'USERPROFILE',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
  ];
  for (const k of forward) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

const stages = [];
function stage(s) {
  stages.push(s);
  console.log(`[stage] ${s}`);
}

console.log(`codex app-server repro — env: ${fullEnv ? 'FULL inherited' : 'minimal allowlist'}`);

const env = fullEnv ? process.env : minimalEnv();
const cwd = homedir();
let child;
let cliResolver = 'not_found';
let cliResolverStage = 'nvm_not_found';
let settled = false;
const done = (verdict) => {
  if (settled) return;
  settled = true;
  console.log(`\n[verdict] ${verdict}`);
  console.log(`[resolver] ${cliResolver}`);
  console.log(`[resolver stage] ${cliResolverStage}`);
  console.log(`[stages reached] ${stages.join(' → ') || 'none'}`);
  try {
    child?.kill('SIGKILL');
  } catch {}
  process.exit(verdict.startsWith('PASS') ? 0 : 1);
};

const watchdog = setTimeout(() => done(`FAIL: timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);
watchdog.unref?.();

const pending = new Map();
const buffered = new Map();

function send(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}
function await_(id) {
  if (buffered.has(id)) {
    const value = buffered.get(id);
    buffered.delete(id);
    return Promise.resolve(value);
  }
  return new Promise((res) => pending.set(id, res));
}

async function spawnAppServer() {
  const fromPath = await spawnAttempt('codex', 'extension_path');
  if (fromPath !== null) return fromPath;
  const resolved = await resolveCodexExecutableFromUserShell();
  if (resolved !== null) {
    const fromShell = await spawnAttempt(resolved.executable, resolved.resolver, resolved.stage);
    if (fromShell !== null) return fromShell;
  }
  const userBin = resolveCodexExecutableFromCommonUserBins();
  if (userBin !== null) {
    const fromUserBin = await spawnAttempt(userBin.executable, userBin.resolver, userBin.stage);
    if (fromUserBin !== null) return fromUserBin;
  }
  const nvm = resolveCodexExecutableFromNvm();
  if (nvm !== null) {
    const fromNvm = await spawnAttempt(nvm.executable, nvm.resolver, nvm.stage);
    if (fromNvm !== null) return fromNvm;
  }
  return null;
}

function spawnAttempt(executable, resolver, resolverStage = `${resolver}_found`) {
  const candidate = spawn(executable, ['app-server'], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd,
  });
  return new Promise((resolve) => {
    candidate.once('spawn', () => resolve({ child: candidate, resolver, resolverStage }));
    candidate.once('error', () => resolve(null));
  });
}

function attachReaders(target) {
  target.stderr?.on('data', () => stage('stderr_chunk'));
  target.stdout?.on('data', () => stage('stdout_chunk_received'));
  const rl = createInterface({ input: target.stdout });
  rl.on('line', (line) => {
    const t = line.trim();
    if (t.length === 0) return;
    stage('stdout_line_received');
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }
    stage('stdout_json_parsed');
    if (msg && typeof msg === 'object' && typeof msg.id === 'number') {
      stage(`response_matched(id=${msg.id})`);
      const w = pending.get(msg.id);
      if (w) {
        pending.delete(msg.id);
        w(msg.result);
      } else {
        buffered.set(msg.id, msg.result);
      }
    } else if (msg && typeof msg === 'object' && typeof msg.method === 'string') {
      stage('notification_received');
    }
  });
}

function resolveCodexExecutableFromUserShell() {
  const shellPath = validateUserShell(env.SHELL);
  if (shellPath === null) return Promise.resolve(null);
  const args = shellArgsForResolver(shellPath);
  const timeoutMs = Math.max(1, Math.min(USER_SHELL_RESOLVE_TIMEOUT_MS, TIMEOUT_MS));
  return new Promise((resolve) => {
    let resolved = false;
    let output = '';
    let outputOverflow = false;
    let resolverChild;
    try {
      resolverChild = spawn(shellPath, args, {
        shell: false,
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }

    const kill = () => {
      try {
        resolverChild.kill('SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      kill();
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(
        value === null
          ? null
          : { executable: value, resolver: 'user_shell', stage: 'user_shell_found' },
      );
    };
    if (resolverChild.stdout === null) {
      kill();
      settle(null);
      return;
    }
    resolverChild.stdout.on('data', (chunk) => {
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
    resolverChild.once('error', () => {
      kill();
      settle(null);
    });
    resolverChild.once('close', (code) => {
      if (code !== 0 || outputOverflow) {
        settle(null);
        return;
      }
      settle(validateResolvedCodexExecutable(output));
    });
  });
}

function validateUserShell(raw) {
  if (raw === undefined || raw.length === 0 || raw.length > 512) return null;
  if (raw.includes('\0') || /[\r\n]/.test(raw)) return null;
  if (!isAbsolute(raw)) return null;
  const base = stripKnownExecutableExtension(basename(raw).toLowerCase());
  if (!new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish']).has(base)) return null;
  return raw;
}

function shellArgsForResolver(shellPath) {
  const base = stripKnownExecutableExtension(basename(shellPath).toLowerCase());
  if (base === 'sh' || base === 'dash') return ['-c', SHELL_RESOLVE_COMMAND];
  return ['-lc', SHELL_RESOLVE_COMMAND];
}

function validateResolvedCodexExecutable(raw) {
  if (raw.length === 0 || raw.length > MAX_RESOLVER_OUTPUT_BYTES) return null;
  if (raw.includes('\0')) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RESOLVER_OUTPUT_BYTES) return null;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length !== 1) return null;
  const value = lines[0].trim();
  if (value.length === 0 || /[\r\n]/.test(value)) return null;
  if (!isAbsolute(value)) return null;
  if (stripKnownExecutableExtension(basename(value).toLowerCase()) !== 'codex') return null;
  if (!isExecutableFile(value)) return null;
  return value;
}

function resolveCodexExecutableFromCommonUserBins() {
  const home = validateAbsolutePath(env.HOME);
  if (home === null) return null;
  for (const root of [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
  ]) {
    const candidate = join(root, 'codex');
    if (validateRootedCodexExecutable(candidate, root) !== null) {
      return { executable: candidate, resolver: 'user_bin', stage: 'user_bin_found' };
    }
  }
  return null;
}

function resolveCodexExecutableFromNvm() {
  for (const root of nvmRoots()) {
    const active = validateNvmActiveCandidate(root, env.NVM_BIN);
    if (active !== null) return { executable: active, resolver: 'nvm', stage: 'nvm_found' };
    const versionsRoot = join(root, 'versions', 'node');
    let entries;
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
        return { executable: candidate, resolver: 'nvm', stage: 'nvm_found' };
      }
    }
  }
  return null;
}

function nvmRoots() {
  const out = [];
  const explicit = validateAbsolutePath(env.NVM_DIR);
  if (explicit !== null) out.push(resolve(explicit));
  const home = validateAbsolutePath(env.HOME);
  if (home !== null) out.push(resolve(home, '.nvm'));
  return Array.from(new Set(out));
}

function validateNvmActiveCandidate(root, nvmBin) {
  const bin = validateAbsolutePath(nvmBin);
  if (bin === null) return null;
  return validateRootedCodexExecutable(join(bin, 'codex'), root);
}

function validateAbsolutePath(raw) {
  if (raw === undefined || raw.length === 0 || raw.length > 1024) return null;
  if (raw.includes('\0') || /[\r\n]/.test(raw)) return null;
  if (!isAbsolute(raw)) return null;
  return raw;
}

function validateRootedCodexExecutable(candidate, root) {
  if (stripKnownExecutableExtension(basename(candidate).toLowerCase()) !== 'codex') return null;
  if (!isUnderRoot(candidate, root)) return null;
  if (!isExecutableFile(candidate)) return null;
  if (!realPathIsUnderRoot(candidate, root)) return null;
  return candidate;
}

function isExecutableFile(value) {
  try {
    if (!statSync(value).isFile()) return false;
    accessSync(value, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUnderRoot(candidate, root) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realPathIsUnderRoot(candidate, root) {
  try {
    return isUnderRoot(realpathSync(candidate), realpathSync(root));
  } catch {
    return false;
  }
}

function compareNodeVersionDesc(a, b) {
  const parsedA = parseNodeVersion(a);
  const parsedB = parseNodeVersion(b);
  for (let i = 0; i < parsedA.length; i += 1) {
    const delta = parsedB[i] - parsedA[i];
    if (delta !== 0) return delta;
  }
  return b.localeCompare(a);
}

function parseNodeVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (match === null) return [0, 0, 0];
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function stripKnownExecutableExtension(value) {
  return value.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

(async () => {
  const spawned = await spawnAppServer();
  if (spawned === null) {
    done('FAIL: codex CLI not found by TokenGauge-style resolvers');
    return;
  }
  child = spawned.child;
  cliResolver = spawned.resolver;
  cliResolverStage = spawned.resolverStage;
  attachReaders(child);
  stage('spawned');
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'tokengauge', version: extensionVersion } },
  });
  stage('initialize_sent');
  await await_(1);
  stage('initialize_received');
  send({ jsonrpc: '2.0', method: 'initialized' });
  stage('initialized_sent');
  send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
  stage('ratelimits_sent');
  const result = await await_(2);
  stage('ratelimits_received');
  const rl2 = result?.rateLimits ?? {};
  const primaryMins = rl2?.primary?.windowDurationMins ?? null;
  const secondaryMins = rl2?.secondary?.windowDurationMins ?? null;
  // SAFE booleans/ints only — never usedPercent/resetsAt/account/path.
  console.log(
    `[result] primary window present: ${rl2?.primary != null} (durationMins=${primaryMins})`,
  );
  console.log(
    `[result] secondary window present: ${rl2?.secondary != null} (durationMins=${secondaryMins})`,
  );
  clearTimeout(watchdog);
  done('PASS: app-server answered over a long-lived pipe');
})().catch((e) => {
  if (e?.code !== undefined) {
    done(`FAIL: spawn error (${e.code})`);
    return;
  }
  done(`FAIL: ${e?.message ?? 'error'}`);
});
