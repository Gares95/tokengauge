# The Claude statusLine writer

The script that feeds TokenGauge's Claude card, and how to create it by hand.

> **You usually do not need this page.** Run **TokenGauge: Set Up Claude statusLine**
> from the Command Palette (`Ctrl+Shift+P`, or `Cmd+Shift+P` on macOS) and it writes
> this exact file for you, validates it, and sets the snapshot path. See
> [Claude Code setup](../README.md#claude-code-setup) in the README.
>
> This page exists for two reasons: to create the writer yourself, on a custom
> path or without VS Code, and to **read the writer before you run it**. It is the
> script an extension puts on your machine, so it is published in full.

The body below is held byte-identical to
`src/bridge/claude-statusline-writer.example.mjs` by a unit test, so this page
cannot drift from the code the extension ships.

Claude Code must already run in the same environment where this writer runs. If
`claude` does not start in that environment, fix Claude Code first, then return
to TokenGauge. Run `node --version` in that same environment before creating
the writer. If `node` is not found there, install Node.js or use a custom writer
that emits the documented JSON snapshot. TokenGauge does not install Node or Claude Code.

The examples below create this writer:

- Writer script: `~/.tokengauge/claude/claude-statusline-writer.mjs`
- Snapshot JSON: `~/.tokengauge/claude/statusline-snapshot.json`

Claude Code `statusLine.command` runs the writer script with Node. TokenGauge
reads the snapshot JSON. Do not set TokenGauge's snapshot path to the writer
script. The writer does not hard-code an output path; pass either `--file` for a
single snapshot file or `--dir` for one snapshot per Claude session.

The script keeps **only** the safe, allowlisted fields (5h/weekly percentages
and reset times, model id, optional cost and context, plus a capture timestamp
and **hashed** session/workspace identifiers), never raw paths, raw session ids,
prompts, or transcripts. The hashed identifiers let TokenGauge tell two
sessions apart safely; without them the multiple-writers warning described below
cannot appear. It uses Node's built-in JSON parser and SHA-256 hashing, so
no `jq`, `sha256sum`, `chmod`, or `sed` step is needed.

## WSL, Linux, macOS, or Git Bash

Use this block in Bash-like shells only. It is not PowerShell syntax.

```bash
mkdir -p ~/.tokengauge/claude

cat > ~/.tokengauge/claude/claude-statusline-writer.mjs <<'TOKENGAUGE_STATUSLINE'
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

// Claude Code renders the FIRST stdout line of statusLine.command as your whole
// status line, so this line is the only thing that occupies that space once you
// point statusLine.command here. Spend it on the numbers Claude Code just handed
// us rather than a fixed confirmation string: a terminal-only session cannot see
// TokenGauge's VS Code surfaces at all, and this is the same data, at the point
// of attention, for free.
//
// ACCOUNT-LEVEL ONLY. Both windows are account-wide, so this line reads the same
// in every concurrent session and window. Session-local values (the model, the
// context window, cost) are deliberately left out: printing one beside
// account-level percentages would imply the percentages belong to that session.

// A window contributes a part only when it carries a real percentage. A window
// Claude Code did not report is omitted, never rendered as 0%.
function windowPart(window, label) {
  const used = window?.used_percentage;
  return typeof used === 'number' ? `${used}% ${label}` : undefined;
}

// Claude Code reports rate_limits only for Claude.ai subscription sessions, and
// only after the session's first response, so the no-window case is normal and
// must read honestly. It also keeps the confirmation value of the old fixed
// string in exactly the case where there is no number to show.
function statusLine(snapshot) {
  const parts = [
    windowPart(snapshot.rate_limits?.five_hour, '5h'),
    windowPart(snapshot.rate_limits?.seven_day, 'wk'),
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : 'no limit fields yet';
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
  stdout.write(`${statusLine(snapshot)}\n`);
}

main().catch((error) => {
  const message = error instanceof UserError ? error.message : 'write failed';
  stderr.write(`${ERROR_PREFIX} ${message}\n`);
  process.exitCode = error instanceof UserError ? error.code : 1;
});
// TOKENGAUGE_STATUSLINE_WRITER_END

TOKENGAUGE_STATUSLINE

node --check ~/.tokengauge/claude/claude-statusline-writer.mjs
realpath ~/.tokengauge/claude/claude-statusline-writer.mjs
```

Use the absolute path printed by `realpath` in Claude Code's
`statusLine.command`. On Git Bash for Windows, that path may look like
`/c/Users/YOUR_USER/.tokengauge/claude/claude-statusline-writer.mjs`; use that
path with `node`.

## PowerShell

The writer body is the same on every platform, so this page carries it once, in
the block above. On Windows, copy that block, then run this in PowerShell to save
and verify it. `Get-Clipboard` writes exactly what you copied, so there is no
second copy of the writer to drift out of step with the first.

```powershell
$writer = Join-Path $HOME ".tokengauge\claude\claude-statusline-writer.mjs"
New-Item -ItemType Directory -Force -Path (Split-Path $writer) | Out-Null

# copy the writer block above first, then:
Get-Clipboard | Set-Content -Path $writer -Encoding utf8

node --check $writer
(Resolve-Path $writer).Path
```

If `node --check` reports an error, the clipboard did not capture the whole
block; copy it again from the first `import` line to the final `}` and re-run.
You can also paste the block into the file with any editor, saving as UTF-8.

Use the absolute path printed by `Resolve-Path` in Claude Code's
`statusLine.command`. A local Windows path can be written with forward slashes
in JSON, for example `C:/Users/YOUR_USER/.tokengauge/claude/claude-statusline-writer.mjs`.

A fuller Windows walkthrough, with screenshots, lives in the
[Windows (PowerShell) setup guide](setup/windows.md).


If you intentionally keep a custom shell writer instead, make sure it has LF
line endings and the executable bit. The primary Node writer avoids that
shebang and permission path.
