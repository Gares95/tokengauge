// Codex native status source.
//
// The earlier "no safe machine-readable Codex status source today" framing is
// SUPERSEDED. A live-probe investigation (codex-cli 0.137.0,
// 2026-06-11) answered all five questions:
//   Q1 — statusLine config: `~/.codex/config.toml [tui].status_line` selects
//        BUILT-IN item IDs (e.g. "model-with-reasoning", "five-hour-limit"),
//        NOT a user-command hook.
//   Q2 — machine-readable status file: NONE in `~/.codex/`. `auth.json` holds
//        OAuth tokens (FORBIDDEN to read); `version.json` is update-check
//        metadata; `sessions/*.jsonl` + `*.sqlite` are conversation logs.
//        Preference path #1: unavailable.
//   Q3 — statusLine-writer (Claude analog): INFEASIBLE on 0.137.0 — because
//        `[tui].status_line` selects built-in items rather than invoking a
//        command, there is no hook through which the user's own script could
//        emit a TokenGauge-safe JSON snapshot. Preference path #2: infeasible.
//        (If a future Codex version adds a command-style status hook, it
//        becomes the preferred path.)
//   Q4 — bounded non-interactive status-only invocation: VERIFIED for the tested
//        codex-cli 0.137.0 response shape. `codex app-server` answered
//        `account/rateLimits/read` over stdio JSON-RPC in ~1-2 s with 5-hour and
//        7-day account-window values. Preference path #3 — the implementation
//        (see CodexAppServerProbe). The protocol is flagged [experimental], so
//        the produced candidate carries confidence 'medium' and any drift or
//        unsupported bucket shape fails CLOSED to `codex_protocol_drift`.
//   Q5 — renderer/thread context state: NOT SAFE / NOT NEEDED. The
//        context-window notification only fires for threads inside our own
//        app-server instance (we own none); the TUI numbers are unreachable
//        without scraping (forbidden). Codex context resolves honestly
//        unavailable.
//
// The `/usage` `/context` `/status` TUI surfaces stay DO-NOT-SCRAPE
// (version-fragile, leak-prone, account/session id/dir in output). The SAFE
// machine-readable path is the opt-in `codex app-server` probe above (Q4 / path
// #3); when it is off (the default), unavailable, or fails, the Codex cockpit
// limit-state resolves to `unknown` with an honest blocker reason
// (`codex_probe_disabled` / `codex_native_status_unavailable` / a closed probe
// reason) — never a fabricated native claim or a TUI scrape.
//
// Unsafe-paths summary (NEVER touched by this source or the probe): auth.json,
// `account/read`, any `thread/*` method, sessions/history/sqlite logs, and no
// long-lived daemon — the app-server child lives only for the bounded exchange.
//
// Consent: the probe spawns the
// authenticated codex CLI, which makes ONE backend request with the user's
// stored credentials. A generic refresh action is NOT sufficient consent for
// that. The effective probe permission combines the
// `tokenGauge.providers.codex.nativeStatusProbe` setting (default false) with
// Codex card visibility and gates ALL Codex app-server probes, INCLUDING the
// manual `Refresh Native Status` command. When disabled or hidden, the Codex card
// renders `codex_probe_disabled` with an enable-in-settings affordance and NO
// codex process is spawned (provably zero spawn — the runner seam is never
// invoked). This module receives booleans/seams only; configuration reading and
// visibility gating happen in extension.ts, and the ≥60s background cadence floor
// is wired there — this module exposes the gating parameter, it does not read it.

import type { CockpitFieldReason } from '../../core/cockpit/CockpitState';
import type { AgentId, ProviderId } from '../../core/usage/NativeUsageTaxonomy';
import {
  type CodexProbeExitBucket,
  type CodexProbeIoStage,
  type CodexProbeResult,
  type CodexProbeStage,
  type CodexStatusCandidate,
  mapProbeResultToCandidate,
} from './CodexAppServerProbe';

export const CODEX_NATIVE_STATUS_BLOCKED_REASON: CockpitFieldReason =
  'codex_native_status_unavailable';

// The reason surfaced when the user has not opted in to the app-server probe.
// Distinct from the protocol/runtime failure reasons — it is a consent state,
// not a degradation, and carries an enable-in-settings affordance in the card.
export const CODEX_PROBE_DISABLED_REASON: CockpitFieldReason = 'codex_probe_disabled';

// A minimal blocker candidate: provider/agent scope + the documented
// unavailable reason. It carries NO session/weekly limit value (no fabrication)
// and NO raw account/dir/session id.
export interface CodexBlockedCandidate {
  readonly sourceTier: 'unknown';
  readonly scope: { readonly provider: ProviderId; readonly agent: AgentId };
  readonly session?: never;
  readonly weekly?: never;
  readonly unavailableReason: CockpitFieldReason;
}

export function codexNativeStatusBlocked(
  reason: CockpitFieldReason = CODEX_NATIVE_STATUS_BLOCKED_REASON,
): CodexBlockedCandidate {
  return {
    sourceTier: 'unknown',
    scope: { provider: 'openai', agent: 'codex' },
    unavailableReason: reason,
  };
}

// The injectable probe seam — narrowed to just the `run()` surface the wiring
// needs. extension.ts supplies a real CodexAppServerProbe instance;
// tests supply a fake. The seam keeps this module free of any process spawn and
// any `vscode` host-API import.
export interface CodexProbeSeam {
  run(): Promise<CodexProbeResult>;
}

export interface ProbeCodexNativeStatusOptions {
  // Effective Codex probe permission after user opt-in and card-visibility
  // gates. When false, NO probe runs — provably zero process spawn — and the
  // result is the honest `codex_probe_disabled` blocker. This gate applies to
  // the manual Refresh command too.
  readonly probeEnabled: boolean;
  // Present only when enabled; the wiring constructs the probe behind the gate.
  readonly probe?: CodexProbeSeam;
  readonly now?: () => Date;
}

// The gated probe result: either the honest blocker (disabled, or a closed
// probe-failure reason) or the fully-shaped codex_status_snapshot candidate.
export interface CodexGatedProbeMarkers {
  readonly stage: CodexProbeStage;
  readonly ioStage: CodexProbeIoStage;
  readonly sawStderr: boolean;
  // round 12: stdout chunk count + child-exit bucket (ext-host runtime diagnosis).
  readonly stdoutChunks: number;
  readonly exitBucket: CodexProbeExitBucket;
}

export type CodexGatedProbeResult =
  | ({ readonly ok: true; readonly candidate: CodexStatusCandidate } & CodexGatedProbeMarkers)
  | ({ readonly ok: false; readonly blocked: CodexBlockedCandidate } & CodexGatedProbeMarkers);

// The marker defaults for the no-spawn paths (disabled / no seam).
const NO_SPAWN_MARKERS: CodexGatedProbeMarkers = {
  stage: 'idle',
  ioStage: 'none',
  sawStderr: false,
  stdoutChunks: 0,
  exitBucket: 'none',
};

// Run the gated Codex native-status probe behind the explicit consent gate.
//
// disabled  → `codex_probe_disabled` blocker, ZERO spawn (the seam is never
//             invoked — the disabled branch returns before touching `probe`).
// enabled   → run the probe; success maps to the codex_status_snapshot
//             candidate (the probe mapper); a probe failure passes its closed
//             reason through unchanged, still never fabricating a gauge.
export async function probeCodexNativeStatusGated(
  options: ProbeCodexNativeStatusOptions,
): Promise<CodexGatedProbeResult> {
  if (!options.probeEnabled) {
    return {
      ok: false,
      blocked: codexNativeStatusBlocked(CODEX_PROBE_DISABLED_REASON),
      ...NO_SPAWN_MARKERS,
    };
  }
  // Enabled but no seam supplied — treat as a run failure, never a fabrication.
  if (options.probe === undefined) {
    return {
      ok: false,
      blocked: codexNativeStatusBlocked('codex_probe_failed'),
      ...NO_SPAWN_MARKERS,
    };
  }
  const result = await options.probe.run();
  const markers: CodexGatedProbeMarkers = {
    stage: result.stage,
    ioStage: result.ioStage,
    sawStderr: result.sawStderr,
    stdoutChunks: result.stdoutChunks,
    exitBucket: result.exitBucket,
  };
  if (result.ok) {
    const now = options.now ?? (() => new Date());
    return { ok: true, candidate: mapProbeResultToCandidate(result, now), ...markers };
  }
  // A timeout where the app-server produced NO stdout at all (the
  // granular I/O markers never reached `stdout_chunk_received`, and no stderr) is a
  // precise ENVIRONMENT limitation — codex app-server answers an interactive
  // terminal but returns nothing over a pipe (codex-cli 0.137.0, WSL/Remote). Map
  // it to the actionable `codex_probe_no_response` rather than a generic timeout.
  const noOutput =
    result.ioStage === 'none' ||
    result.ioStage === 'stdin_write_started' ||
    result.ioStage === 'stdin_write_completed';
  const mappedReason: CockpitFieldReason =
    result.reason === 'codex_probe_timeout' && noOutput && !result.sawStderr
      ? 'codex_probe_no_response'
      : result.reason;
  // Otherwise pass the probe's closed reason through unchanged (codex_cli_not_found,
  // codex_probe_timeout with output, codex_probe_failed, codex_protocol_drift).
  return { ok: false, blocked: codexNativeStatusBlocked(mappedReason), ...markers };
}
