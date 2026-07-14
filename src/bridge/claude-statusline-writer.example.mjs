import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { argv, stderr, stdin, stdout } from 'node:process';

// TOKENGAUGE_STATUSLINE_WRITER_START
const ERROR_PREFIX = 'TokenGauge statusline writer error:';
const HASH_MISSING_VALUE = 'none';

class UserError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function fail(message, code = 1) {
  throw new UserError(message, code);
}

function parseArgs(args) {
  if (args.length !== 2) {
    fail('invalid arguments', 2);
  }

  const [mode, target] = args;
  if (mode !== '--file' && mode !== '--dir') {
    fail('invalid arguments', 2);
  }
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
    fail('invalid target', 2);
  }

  return { mode, target: resolve(target) };
}

function hash16(value) {
  const text = typeof value === 'string' && value.length > 0 ? value : HASH_MISSING_VALUE;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function safeString(value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return undefined;
  }
  return value;
}

function pct(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function nonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function compact(value) {
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const next = compact(item);
      if (next !== undefined) result[key] = next;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return value === undefined || value === null ? undefined : value;
}

function rateLimitWindow(input) {
  if (!input || typeof input !== 'object') return undefined;
  return compact({
    used_percentage: pct(input.used_percentage),
    resets_at: nonnegativeInt(input.resets_at),
  });
}

function buildSnapshot(data) {
  if (!data || typeof data !== 'object') {
    fail('invalid payload');
  }

  const modelId = safeString(data.model?.id, 120) ?? safeString(data.model?.display_name, 120);
  if (modelId === undefined) {
    fail('invalid payload');
  }

  const workspacePath =
    safeString(data.workspace?.project_dir, 4096) ??
    safeString(data.workspace?.current_dir, 4096) ??
    safeString(data.cwd, 4096);

  return compact({
    source: 'claude_statusline',
    timestamp: new Date().toISOString(),
    provider: 'anthropic',
    agent: 'claude-code',
    session_id_hash: hash16(data.session_id),
    workspace_hash: hash16(workspacePath),
    model: {
      id: modelId,
      display_name: safeString(data.model?.display_name, 120),
    },
    cost: {
      total_cost_usd: nonnegativeNumber(data.cost?.total_cost_usd),
    },
    rate_limits: {
      five_hour: rateLimitWindow(data.rate_limits?.five_hour),
      seven_day: rateLimitWindow(data.rate_limits?.seven_day),
    },
    context_window: {
      context_window_size: positiveInt(data.context_window?.context_window_size),
      used_percentage: pct(data.context_window?.used_percentage),
      remaining_percentage: pct(data.context_window?.remaining_percentage),
      total_input_tokens: nonnegativeInt(data.context_window?.total_input_tokens),
      total_output_tokens: nonnegativeInt(data.context_window?.total_output_tokens),
    },
    exceeds_200k_tokens:
      typeof data.exceeds_200k_tokens === 'boolean' ? data.exceeds_200k_tokens : undefined,
  });
}

function ensureDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('invalid target');
  }
}

function rejectSymlink(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    fail('invalid target');
  }
}

function writeAtomic(finalPath, snapshot) {
  const dir = dirname(finalPath);
  ensureDirectory(dir);
  rejectSymlink(finalPath);

  const tmp = join(dir, `.${basename(finalPath)}.tmp-${process.pid}-${Date.now()}`);
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, finalPath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    if (error instanceof UserError) throw error;
    fail('write failed');
  }
}

function outputPathFor(mode, target, snapshot) {
  if (mode === '--file') {
    return target;
  }

  ensureDirectory(target);
  return join(target, `${snapshot.workspace_hash}-${snapshot.session_id_hash}.json`);
}

async function readStdin() {
  let input = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    input += chunk;
    if (input.length > 1024 * 1024) {
      fail('invalid payload');
    }
  }
  return input;
}

async function main() {
  const { mode, target } = parseArgs(argv.slice(2));
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch (error) {
    if (error instanceof UserError) throw error;
    fail('invalid payload');
  }

  const snapshot = buildSnapshot(payload);
  writeAtomic(outputPathFor(mode, target, snapshot), snapshot);
  stdout.write('TokenGauge snapshot updated\n');
}

main().catch((error) => {
  const message = error instanceof UserError ? error.message : 'write failed';
  stderr.write(`${ERROR_PREFIX} ${message}\n`);
  process.exitCode = error instanceof UserError ? error.code : 1;
});
// TOKENGAUGE_STATUSLINE_WRITER_END
