// The Codex native
// status probe.
//
// A bounded, non-interactive `codex app-server` stdio JSON-RPC exchange,
// verified live on codex-cli 0.137.0: spawn → initialize →
// initialized → account/rateLimits/read → ALWAYS kill. This version recognizes
// the tested 5-hour and 7-day account-window response shape and maps it under
// sourceTier `codex_status_snapshot` at confidence 'medium' (the app-server
// protocol is flagged [experimental] — never 'high'). Other bucket shapes fail
// closed instead of being guessed.
//
// Privacy + honesty invariants enforced here:
//   - The runner is an injectable seam. Tests inject a fake runner so the REAL
//     codex binary never executes in unit tests.
//   - spawn discipline: fixed argv ['app-server'], shell:false, a bounded
//     explicit env allowlist (buildEnv below — PATH plus the home/XDG/locale/
//     user vars codex needs to find its own config/credentials; NEVER the full
//     process env), hard ~15s timeout, kill on EVERY settle path
//     (success/failure/timeout/dispose).
//   - FORBIDDEN by construction (and asserted in tests): `account/read`, any
//     `thread/*` method, any read of `auth.json`, any long-lived daemon. The one
//     status call is `account/rateLimits/read`; the child lives only for the
//     exchange.
//   - Strict zod on consumed fields (tolerant of added keys via `.loose()`) plus
//     a windowDurationMins 300/10080 shape check before window assignment.
//     Any drift fails CLOSED to `codex_protocol_drift` — never a fabricated gauge.
//   - The initialize response can carry path-like fields (codexHome,
//     requestUserAgent). ONLY a sanitized version/userAgent fingerprint crosses
//     into the result; the raw initialize payload never reaches the result,
//     diagnostics, candidate, or any thrown error.
//   - Every failure funnels through one fail(reason) recording a rule-id-only
// diagnostic: stderr / Error.message NEVER surface.

import { z } from 'zod';
import type { AgentId, ProviderId } from '../../core/usage/UsageEvent';

// ---------------------------------------------------------------------------
// Runner seam — the only place a process is spawned. The probe drives the
// JSON-RPC protocol over the exchange handle; the runner owns spawn/kill.
// ---------------------------------------------------------------------------

export interface CodexProbeRunRequest {
  // Fixed argv — exactly ['app-server']. No user-controlled arguments.
  readonly args: readonly string[];
  // Bounded explicit env allowlist (see CodexAppServerProbe.buildEnv). The full
  // host env never crosses.
  readonly env: Readonly<Record<string, string>>;
  // shell is ALWAYS false — no shell interpretation of argv.
  readonly shell: false;
  readonly timeoutMs: number;
  // Optional sanitized I/O event seam. The runner calls
  // it at child-process I/O milestones (stdin write, first stdout chunk, each line,
  // each parse, notification, stderr) so the probe can report WHERE a hang occurs.
  // Closed-set labels only — the runner NEVER passes raw output through it.
  readonly onIo?: (event: CodexProbeIoEvent) => void;
  // Explicit cwd for the child (ext host spawns from an unpredictable
  // cwd; codex startup can be cwd-sensitive). A dir path to the child — never stored.
  readonly cwd?: string;
  // Sanitized child-exit seam — a code/signal BUCKET so a no-output
  // timeout is distinguishable from a child that exited. Bucket only; no raw code.
  readonly onExit?: (bucket: CodexProbeExitBucket) => void;
}

// Child-exit outcome bucket (no raw code/signal value crosses).
export type CodexProbeExitBucket = 'none' | 'zero' | 'nonzero' | 'signal';

// The interactive stdio handle. `writeLine` writes one newline-delimited JSON-RPC
// object; `readResult` resolves the result payload for a correlated request id.
export interface CodexProbeExchange {
  writeLine(obj: unknown): void;
  readResult(id: number): Promise<unknown>;
}

export interface CodexProbeRunResult {
  // false when the binary could not be located (ENOENT / not on PATH).
  readonly found: boolean;
  // Sanitized executable resolver label. Never a raw path.
  readonly cliResolver?: CodexCliResolverLabel;
  // Sanitized resolver stage. Never a raw path.
  readonly cliResolverStage?: CodexCliResolverStage;
  readonly stderr: string;
  readonly exchange: CodexProbeExchange | null;
  // Terminates the child. Idempotent at the call site, but the probe invokes it
  // exactly once per run.
  kill(): void;
}

export type CodexProbeRunner = (request: CodexProbeRunRequest) => Promise<CodexProbeRunResult>;

export type CodexCliResolverLabel =
  | 'extension_path'
  | 'user_shell'
  | 'user_bin'
  | 'nvm'
  | 'configured'
  | 'not_found';

export type CodexCliResolverStage =
  | 'extension_path_found'
  | 'extension_path_not_found'
  | 'user_shell_found'
  | 'user_shell_not_found'
  | 'user_bin_found'
  | 'user_bin_not_found'
  | 'nvm_found'
  | 'nvm_not_found';

export interface CodexProbeDiagnosticLike {
  record(entry: {
    ruleId: string;
    status: string;
    severity: 'info' | 'warning' | 'error';
    details?: Readonly<Record<string, unknown>>;
  }): void;
}

export interface CodexAppServerProbeOptions {
  readonly runner: CodexProbeRunner;
  readonly extensionVersion: string;
  readonly now?: () => Date;
  readonly diagnostics?: CodexProbeDiagnosticLike;
  readonly timeoutMs?: number;
  // Explicit child cwd (the wiring passes the user's home dir).
  readonly cwd?: string;
}

// ---------------------------------------------------------------------------
// Strict boundary schema. Tolerant of
// added keys, strict on the fields we consume.
// ---------------------------------------------------------------------------

const RateLimitWindowSchema = z.object({
  usedPercent: z.number().int().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: z.number().int().nonnegative().nullable().optional(),
});

const CodexRateLimitsSchema = z.object({
  rateLimits: z
    .object({
      primary: RateLimitWindowSchema.nullable().optional(),
      secondary: RateLimitWindowSchema.nullable().optional(),
      planType: z.string().max(64).nullable().optional(),
      rateLimitReachedType: z.string().max(64).nullable().optional(),
    })
    .loose(),
});

type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

// The expected window durations. A response that assigns a different duration to
// primary/secondary is protocol drift — never silently re-mapped.
const PRIMARY_WINDOW_MINS = 300; // 5h
const SECONDARY_WINDOW_MINS = 10080; // weekly

// A cold `codex app-server` startup in WSL/Remote can be slower
// than a warm desktop spawn; 15s gives the first initialize/rateLimits round-trip
// headroom without hanging the cockpit (the watchdog still kills the child).
const DEFAULT_TIMEOUT_MS = 15_000;

export type CodexProbeReason =
  | 'codex_cli_not_found'
  | 'codex_probe_timeout'
  | 'codex_probe_failed'
  | 'codex_protocol_drift';

// A SANITIZED stage marker recording how far the JSON-RPC exchange
// got, so an installed-VSIX timeout is diagnosable WITHOUT raw payloads — e.g. a
// timeout at `initialize_sent` means the app-server never answered initialize
// (framing/protocol/auth), while `ratelimits_sent` means initialize succeeded but
// the status call hung. NEVER carries a path/account/session/stderr.
export type CodexProbeStage =
  | 'idle'
  | 'spawn_attempted'
  | 'cli_not_found'
  | 'no_stdio'
  | 'run_threw'
  | 'spawned'
  | 'initialize_sent'
  | 'initialize_received'
  | 'initialized_sent'
  | 'ratelimits_sent'
  | 'ratelimits_received'
  | 'parsed'
  | 'completed';

// GRANULAR child-process I/O markers reported by the
// runner seam, so a hang at `initialize_sent` is diagnosable WITHOUT raw output:
// no `stdout_chunk_received` ⇒ the child never flushed stdout to our pipe (non-TTY
// buffering / piped-stdin not read); chunk but no `stdout_line_received` ⇒ framing;
// `stdout_json_parsed` but no `response_matched` ⇒ correlation/shape. Closed-set
// labels + a stderr-seen boolean only — never raw stdout/stderr/payload.
export type CodexProbeIoStage =
  | 'none'
  | 'stdin_write_started'
  | 'stdin_write_completed'
  | 'stdout_chunk_received'
  | 'stdout_line_received'
  | 'stdout_json_parsed'
  | 'notification_received'
  | 'response_matched';

export type CodexProbeIoEvent = CodexProbeIoStage | 'stderr_chunk';

const IO_STAGE_RANK: Record<CodexProbeIoStage, number> = {
  none: 0,
  stdin_write_started: 1,
  stdin_write_completed: 2,
  stdout_chunk_received: 3,
  stdout_line_received: 4,
  stdout_json_parsed: 5,
  notification_received: 6,
  response_matched: 7,
};

export interface CodexProbeWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  readonly resetsAt: number | null;
}

export type CodexProbeResult =
  | {
      readonly ok: true;
      readonly primary: CodexProbeWindow;
      readonly secondary: CodexProbeWindow;
      readonly planType?: string;
      readonly rateLimitReachedType?: string;
      // Sanitized version/userAgent fingerprint — the ONLY initialize field that
      // crosses. Doubles as the protocol-drift fingerprint.
      readonly codexVersion: string;
      // Always 'completed' on success.
      readonly stage: CodexProbeStage;
      // round 9: furthest child-process I/O milestone + whether any stderr was seen.
      readonly ioStage: CodexProbeIoStage;
      readonly sawStderr: boolean;
      // round 12: count of raw stdout chunks + child-exit bucket (diagnose ext-host
      // runtime differences: 0 chunks + a child exit ⇒ wrong binary / startup error).
      readonly stdoutChunks: number;
      readonly exitBucket: CodexProbeExitBucket;
    }
  | {
      readonly ok: false;
      readonly reason: CodexProbeReason;
      // How far the exchange got before failing (diagnosable cause).
      readonly stage: CodexProbeStage;
      // round 9: furthest child-process I/O milestone + whether any stderr was seen.
      readonly ioStage: CodexProbeIoStage;
      readonly sawStderr: boolean;
      // round 12: count of raw stdout chunks + child-exit bucket (diagnose ext-host
      // runtime differences: 0 chunks + a child exit ⇒ wrong binary / startup error).
      readonly stdoutChunks: number;
      readonly exitBucket: CodexProbeExitBucket;
    };

// Sentinel a hung readResult rejects with when the hard timeout fires.
const TIMEOUT_SENTINEL = Symbol('codex-probe-timeout');

function fingerprintFromInitialize(initialize: unknown): string {
  // The initialize result carries path-like fields (codexHome, requestUserAgent).
  // ONLY userAgent crosses — bounded length, no path-like content.
  if (initialize !== null && typeof initialize === 'object') {
    const ua = (initialize as { userAgent?: unknown }).userAgent;
    if (typeof ua === 'string' && ua.length > 0) {
      return ua.slice(0, 128);
    }
  }
  return 'unknown';
}

export class CodexAppServerProbe {
  private readonly runner: CodexProbeRunner;
  private readonly extensionVersion: string;
  private readonly diagnostics?: CodexProbeDiagnosticLike;
  private readonly timeoutMs: number;
  private readonly cwd?: string;

  public constructor(options: CodexAppServerProbeOptions) {
    this.runner = options.runner;
    this.extensionVersion = options.extensionVersion;
    this.diagnostics = options.diagnostics;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cwd = options.cwd;
  }

  public async run(): Promise<CodexProbeResult> {
    // round 9: track the furthest child-process I/O milestone + a stderr-seen flag,
    // updated by the runner via onIo. By closure, these reflect the latest I/O state
    // by the time run() settles (success/timeout) — diagnosable, never raw output.
    let ioStage: CodexProbeIoStage = 'none';
    let sawStderr = false;
    // round 12: count raw stdout chunks + capture the child-exit bucket.
    let stdoutChunks = 0;
    let exitBucket: CodexProbeExitBucket = 'none';
    const onIo = (event: CodexProbeIoEvent): void => {
      if (event === 'stderr_chunk') {
        sawStderr = true;
        return;
      }
      if (event === 'stdout_chunk_received') {
        stdoutChunks += 1;
      }
      if (IO_STAGE_RANK[event] > IO_STAGE_RANK[ioStage]) {
        ioStage = event;
      }
    };

    const request: CodexProbeRunRequest = {
      args: ['app-server'],
      env: this.buildEnv(),
      shell: false,
      timeoutMs: this.timeoutMs,
      onIo,
      onExit: (bucket) => {
        exitBucket = bucket;
      },
      ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
    };

    // Track the furthest stage reached. On a timeout the current
    // value tells us WHERE the exchange hung (initialize vs rateLimits).
    let stage: CodexProbeStage = 'spawn_attempted';

    // Fold the live I/O markers into every failure result/diagnostic.
    const settleFail = (
      reason: CodexProbeReason,
      kill: (() => void) | undefined,
      st: CodexProbeStage,
    ): CodexProbeResult =>
      this.fail(reason, kill, st, ioStage, sawStderr, stdoutChunks, exitBucket);

    let run: CodexProbeRunResult;
    try {
      run = await this.runner(request);
    } catch {
      // A throwing runner is a run failure, never a crash. No stderr surfaces.
      return settleFail('codex_probe_failed', undefined, 'run_threw');
    }

    if (!run.found || run.exchange === null) {
      // The child may still need killing if it was spawned then reported missing.
      run.kill();
      if (!run.found) {
        return settleFail('codex_cli_not_found', undefined, 'cli_not_found');
      }
      return settleFail('codex_probe_failed', undefined, 'no_stdio');
    }
    stage = 'spawned';

    let killed = false;
    const killOnce = (): void => {
      if (!killed) {
        killed = true;
        run.kill();
      }
    };

    try {
      const exchange = run.exchange;
      // (1) initialize — capture the userAgent version fingerprint only.
      exchange.writeLine({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'tokengauge', version: this.extensionVersion } },
      });
      stage = 'initialize_sent';
      const initialize = await this.withTimeout(exchange.readResult(1));
      stage = 'initialize_received';
      const codexVersion = fingerprintFromInitialize(initialize);

      // (2) initialized notification.
      exchange.writeLine({ jsonrpc: '2.0', method: 'initialized' });
      stage = 'initialized_sent';

      // (3) the ONE status call. NEVER account/read, NEVER thread/*.
      exchange.writeLine({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
      stage = 'ratelimits_sent';
      const rawRateLimits = await this.withTimeout(exchange.readResult(2));
      stage = 'ratelimits_received';

      const parsed = CodexRateLimitsSchema.safeParse(rawRateLimits);
      if (!parsed.success) {
        return settleFail('codex_protocol_drift', killOnce, stage);
      }
      const { primary, secondary } = parsed.data.rateLimits;
      // Window-duration sanity: a mismatch means the window mapping is untrustworthy.
      const primaryWindow = matchedWindow(primary, PRIMARY_WINDOW_MINS);
      const secondaryWindow = matchedWindow(secondary, SECONDARY_WINDOW_MINS);
      if (primaryWindow === null || secondaryWindow === null) {
        return settleFail('codex_protocol_drift', killOnce, stage);
      }
      stage = 'parsed';

      killOnce();
      const planType = parsed.data.rateLimits.planType;
      const rateLimitReachedType = parsed.data.rateLimits.rateLimitReachedType;
      return {
        ok: true,
        primary: primaryWindow,
        secondary: secondaryWindow,
        ...(typeof planType === 'string' ? { planType: planType.slice(0, 64) } : {}),
        ...(typeof rateLimitReachedType === 'string'
          ? { rateLimitReachedType: rateLimitReachedType.slice(0, 64) }
          : {}),
        codexVersion,
        stage: 'completed',
        ioStage,
        sawStderr,
        stdoutChunks,
        exitBucket,
      };
    } catch (error) {
      if (error === TIMEOUT_SENTINEL) {
        // `stage` is the last step reached — initialize_sent (app-server never
        // answered initialize) or ratelimits_sent (initialize ok, status hung).
        return settleFail('codex_probe_timeout', killOnce, stage);
      }
      return settleFail('codex_probe_failed', killOnce, stage);
    } finally {
      killOnce();
    }
  }

  // Minimal, explicit env — the full host env is never spread in.
  // BUT `codex app-server` needs the user's home to locate its OWN
  // ~/.codex/auth.json + config: HOME (POSIX) / USERPROFILE (win32), and CODEX_HOME
  // when the user points codex elsewhere. Regression note: with PATH only,
  // the rateLimits call could not authenticate in WSL/Remote and the exchange hung →
  // codex_probe_timeout every time. These home vars are passed to the user's OWN
  // codex tool so it can find its own credentials; they are NEVER persisted,
  // displayed, or surfaced in any result/diagnostic/error (the rule-id-only fail
  // funnel + no-stderr discipline are unchanged). Still NOT the full host env.
  private buildEnv(): Record<string, string> {
    // A freshly-spawned codex app-server over a non-interactive
    // pipe needs more than PATH/HOME to start cleanly — the XDG_* dirs, locale, and
    // shell/user/term vars a full login shell provides (and that the WORKING
    // interactive test had, but our minimal spawn did not). Forward an explicit
    // ALLOWLIST (never the full host env) — each only when present. These go to the
    // user's OWN codex tool; they are never stored, displayed, or surfaced.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
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
    ];
    if (process.platform === 'win32') {
      forward.push('USERPROFILE', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA');
    }
    for (const key of forward) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(TIMEOUT_SENTINEL), this.timeoutMs);
      // Don't keep the event loop alive solely for this timer.
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  // The single fail funnel — records a rule-id-only diagnostic (ruleId mirrors
  // the reason with dashes). NO stderr, NO Error.message ever crosses.
  private fail(
    reason: CodexProbeReason,
    kill: (() => void) | undefined,
    stage: CodexProbeStage,
    ioStage: CodexProbeIoStage,
    sawStderr: boolean,
    stdoutChunks: number,
    exitBucket: CodexProbeExitBucket,
  ): CodexProbeResult {
    kill?.();
    const ruleId = reason.replace(/_/g, '-');
    this.diagnostics?.record({
      ruleId,
      status: 'rejected',
      severity: 'warning',
      // Stage/ioStage/exitBucket are closed-set labels; sawStderr is
      // a boolean and stdoutChunks a count — no path/account/session/raw stdout/stderr
      // ever crosses.
      details: { source: 'codex-app-server', stage, ioStage, sawStderr, stdoutChunks, exitBucket },
    });
    return { ok: false, reason, stage, ioStage, sawStderr, stdoutChunks, exitBucket };
  }
}

// Validate the window's duration matches the expected slot, returning the
// mapped window on success or null on mismatch/absence (→ codex_protocol_drift).
function matchedWindow(
  window: RateLimitWindow | null | undefined,
  expectedMins: number,
): CodexProbeWindow | null {
  if (window === null || window === undefined) return null;
  if (window.windowDurationMins !== expectedMins) return null;
  return {
    usedPercent: window.usedPercent,
    windowDurationMins: expectedMins,
    resetsAt: window.resetsAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Probe result → codex_status_snapshot SourceCandidate. The config.toml
// model/reasoning extractor below is intentionally inactive in shipped probe
// behavior for v1; it remains exported for bounded helper tests and future wiring
// only. Do not document config.toml as an active source unless runtime code calls
// the helper.
// ---------------------------------------------------------------------------

// Local structural mirror of SourcePriorityResolver.SourceCandidate's codex
// subset — imported as a type elsewhere; defined inline to avoid a hard import
// cycle in the value module.
export interface CodexStatusCandidate {
  readonly sourceTier: 'codex_status_snapshot';
  readonly producedAtMs: number;
  readonly scope: { readonly provider: ProviderId; readonly agent: AgentId };
  readonly confidence: 'medium';
  readonly session: {
    readonly usedPct: number;
    readonly leftPct: number;
    readonly resetsAt?: string;
  };
  readonly weekly: {
    readonly usedPct: number;
    readonly leftPct: number;
    readonly resetsAt?: string;
  };
  readonly agentVersion: string;
  readonly planType?: string;
  readonly model?: string;
  readonly reasoning?: string;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function epochToIso(resetsAt: number | null): string | undefined {
  if (resetsAt === null) return undefined;
  return new Date(resetsAt * 1000).toISOString();
}

export interface MapCandidateExtras {
  readonly model?: string;
  readonly reasoning?: string;
}

// Map a successful probe result to a fully-shaped codex_status_snapshot
// candidate. context is intentionally ABSENT (no safe source per research Q5 —
// honest unavailable, never fabricated). thread/workspace/session identifiers are
// NEVER sourced from probe output.
export function mapProbeResultToCandidate(
  result: Extract<CodexProbeResult, { ok: true }>,
  now: () => Date,
  extras: MapCandidateExtras = {},
): CodexStatusCandidate {
  const session = windowToField(result.primary);
  const weekly = windowToField(result.secondary);
  return {
    sourceTier: 'codex_status_snapshot',
    producedAtMs: now().getTime(),
    scope: { provider: 'openai', agent: 'codex' },
    confidence: 'medium',
    session,
    weekly,
    agentVersion: result.codexVersion,
    ...(result.planType !== undefined ? { planType: result.planType } : {}),
    ...(extras.model !== undefined ? { model: extras.model } : {}),
    ...(extras.reasoning !== undefined ? { reasoning: extras.reasoning } : {}),
  };
}

function windowToField(window: CodexProbeWindow): {
  usedPct: number;
  leftPct: number;
  resetsAt?: string;
} {
  const usedPct = clampPct(window.usedPercent);
  const leftPct = clampPct(100 - window.usedPercent);
  const resetsAt = epochToIso(window.resetsAt);
  return {
    usedPct,
    leftPct,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

// Bounded two-key extraction from ~/.codex/config.toml text. Matches ONLY the
// top-level `model` and `model_reasoning_effort` keys that appear BEFORE the
// first `[` section header — because the file carries raw project paths under
// `[projects."…"]` sections (research unsafe-paths table). These are
// CONFIG-DERIVED (the user's configured default, not guaranteed live-session
// truth): the card renders 'configured' phrasing at medium confidence. NEVER a
// TOML parser dependency, NEVER any other key. Values length-bounded (≤128) and
// passed through redactString as a backstop.
//
// run-state/permissions (sandbox_mode / approval_policy): OMITTED for MVP —
// deferred ("only if safe"); not extracted here.
export function extractCodexConfigFields(tomlText: string): {
  model?: string;
  reasoning?: string;
} {
  const out: { model?: string; reasoning?: string } = {};
  const lines = tomlText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Stop at the first section header — everything after may contain raw paths.
    if (line.startsWith('[')) break;
    const model = matchTopLevelKey(line, 'model');
    if (model !== undefined && out.model === undefined) {
      out.model = boundedSafe(model);
    }
    const reasoning = matchTopLevelKey(line, 'model_reasoning_effort');
    if (reasoning !== undefined && out.reasoning === undefined) {
      out.reasoning = boundedSafe(reasoning);
    }
  }
  return {
    ...(out.model !== undefined ? { model: out.model } : {}),
    ...(out.reasoning !== undefined ? { reasoning: out.reasoning } : {}),
  };
}

// Match `key = "value"` (or single-quoted) at the top level. Anchored so
// `model_reasoning_effort` is never matched by the `model` key.
function matchTopLevelKey(line: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*=\\s*["']([^"']*)["']\\s*$`);
  const m = re.exec(line);
  return m ? m[1] : undefined;
}

function boundedSafe(value: string): string {
  const bounded = value.slice(0, 128);
  // redactString backstop — a forbidden pattern is neutralized, never raw.
  return redactConfigValue(bounded);
}

// Local import-light redaction backstop. Mirrors the project's redactString for
// the two short config strings without pulling the full Redactor graph into this
// module — the bounded values are simple enum-like strings.
function redactConfigValue(value: string): string {
  // Path-like or home-dir content should never appear in a config enum value;
  // if it does, neutralize it rather than pass it through.
  if (/\/(home|Users)\//.test(value) || value.includes('..')) {
    return '[redacted]';
  }
  return value;
}
