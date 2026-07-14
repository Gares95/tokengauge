/**
 * activate() must complete in <200ms. DO NOT add top-level imports of
 * heavyweight modules. Defer with `await import(...)` inside command handlers.
 *
 * The activation marker `[tokengauge] activation ready: Xms (budget: 200ms)` is
 * parsed by Plan 04 integration tests. Do not change the format without
 * updating those tests.
 *
 * TEST API RETURN VALUE: normal production activation returns no supported API.
 * Integration tests run under `ExtensionMode.Test`; only that mode receives
 * the internal test seam used to inspect sanitized extension-host state.
 */
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import {
  GaugeCockpitViewProvider as GaugeCockpitViewProviderClass,
  type GaugeCockpitViewProviderTestState,
  registerGaugeCockpitViewProvider,
} from './cockpit/GaugeCockpitViewProvider';
import {
  codexProbeVisibleForCockpit,
  resolveProviderCardVisibility,
  visibleAgentsForCardVisibility,
} from './cockpit/providerCardVisibility';
import { notifyCommandResult } from './commands/nativeUiSeams';
import { ConfigService } from './config/ConfigService';
import type { EffectiveConfig } from './config/keys';
import type { DiagnosticsEntry } from './core/diagnostics/DiagnosticsService';
import { DiagnosticsService } from './core/diagnostics/DiagnosticsService';
import { classifyActivationFailure } from './core/diagnostics/errors';
import { IdHasher } from './security/IdHasher';
import { SecretManager } from './security/SecretManager';
import { StatusBarUsageItem } from './status/StatusBarUsageItem';

const ACTIVATION_BUDGET_MS = 200 as const;

let outputChannel: vscode.OutputChannel | undefined;
let configService: ConfigService | undefined;
let secretManager: SecretManager | undefined;
let lastActivationMs: number | undefined;

// Every Codex app-server spawn ATTEMPT increments this. With
// the default profile (nativeStatusProbe=false) the loop never invokes runProbe,
// so this stays 0 — the integration test reads it via the test API to prove the
// consent gate spawns no codex process. Module-scope so it survives across the
// activate() return value closure.
let cockpitCodexSpawnCount = 0;
// The SANITIZED stage the most recent Codex probe reached
// (spawned / initialize_sent / ratelimits_sent / completed / cli_not_found / …).
// Surfaced in Cockpit Diagnostics so an installed-VSIX timeout is diagnosable —
// it tells WHERE the exchange hung. Closed-set label only; never a payload/path.
let cockpitCodexLastProbeStage: import('./adapters/codex/CodexAppServerProbe').CodexProbeStage =
  'idle';
// round 9: the furthest child-process I/O milestone + whether stderr was seen.
let cockpitCodexLastProbeIoStage: import('./adapters/codex/CodexAppServerProbe').CodexProbeIoStage =
  'none';
let cockpitCodexLastProbeSawStderr = false;
// round 12: stdout chunk count + child-exit bucket — distinguish a no-output hang
// (0 chunks, exit 'none') from a child that exited early (wrong binary / startup error).
let cockpitCodexLastProbeStdoutChunks = 0;
let cockpitCodexLastProbeExitBucket: import('./adapters/codex/CodexAppServerProbe').CodexProbeExitBucket =
  'none';
let cockpitCodexCliResolver: import('./adapters/codex/CodexAppServerProbe').CodexCliResolverLabel =
  'not_found';
let cockpitCodexCliResolverStage: import('./adapters/codex/CodexAppServerProbe').CodexCliResolverStage =
  'nvm_not_found';
type CodexProbeCwdLabel = 'unset' | 'home' | 'codex_home' | 'configured';
let cockpitCodexProbeCwdLabel: CodexProbeCwdLabel = 'unset';

function labelCodexProbeCwd(cwd: string, home: string): CodexProbeCwdLabel {
  const resolvedCwd = nodePath.resolve(cwd);
  const resolvedHome = nodePath.resolve(home);
  if (resolvedCwd === resolvedHome) return 'home';
  if (resolvedCwd === nodePath.resolve(nodePath.join(home, '.codex'))) return 'codex_home';
  return 'configured';
}

export interface TokenGaugeTestApi {
  readonly configService: ConfigService | undefined;
  readonly secretManager: SecretManager | undefined;
  readonly saltReady: Promise<void>;
  getLastActivationMs(): number | undefined;
  globalStoragePath(): string;
  // Sanitized end-to-end surface. Each returns aggregate/operational data only —
  // never raw secrets, raw store internals, or watched paths.
  statusBarText(): string | undefined;
  diagnosticsEntries(): readonly DiagnosticsEntry[];
  cockpitViewProviderState(): GaugeCockpitViewProviderTestState;
  // Count of Codex app-server spawn ATTEMPTS since
  // activation. The default profile (nativeStatusProbe=false) keeps this 0.
  codexProbeSpawnCountForTest(): number;
  // Drive a single explicit cockpit refresh end-to-end (build the loop if
  // needed, then refresh('manual')) so the integration test can assert the
  // posted card set without a flaky headless webview reveal.
  refreshCockpitForTest(): Promise<void>;
  // Drive the REAL resolveWebviewView path with a fake visible view
  // so the integration test proves that view RESOLUTION alone (no manual
  // refresh command) builds the loop and posts both cards with zero codex
  // spawns. Returns once the resolution-triggered refresh has settled.
  resolveCockpitViewForTest(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): TokenGaugeTestApi | undefined {
  const t0 = performance.now();

  outputChannel = vscode.window.createOutputChannel('TokenGauge');
  context.subscriptions.push(outputChannel);

  configService = new ConfigService();
  context.subscriptions.push(configService);
  const cfg = configService as ConfigService;

  secretManager = new SecretManager(context.secrets);

  // One sanitized diagnostics recorder is shared by the cockpit loop, the Codex
  // probe seam, and the diagnostics command so every component appends into the
  // same redacted entry log.
  const diagnostics = new DiagnosticsService({ outputChannel });

  // Kick off install-salt initialization but do not await it inside activate()
  // — the salt must be available before any hashing, not before
  // activation completes. Tests await `saltReady` when they need the salt
  // visible in SecretStorage. The promise discards its resolved value so the
  // raw salt never reaches the test API.
  const saltReady = secretManager.getOrCreateInstallSalt().then(() => undefined);

  // The native status bar surface is the single approved native usage surface
  //; it is fed by the cockpit loop and created lazily on the first
  // cockpit build so activation pays nothing.
  let statusBar: StatusBarUsageItem | undefined;
  let lastStatusBarText: string | undefined;

  // The single native status bar surface, fed by the cockpit loop.
  // Created lazily on the first cockpit build so activation pays nothing and the
  // bar never shows the legacy log-derived text. It focuses the cockpit on click.
  function getOrBuildStatusBar(): StatusBarUsageItem {
    if (statusBar === undefined) {
      statusBar = new StatusBarUsageItem();
      context.subscriptions.push(statusBar);
      statusBar.show();
      lastStatusBarText = statusBar.text;
    }
    return statusBar;
  }

  // The sidebar cockpit + its live
  // native-status refresh loop. Registration is synchronous and cheap (Pitfall
  // 10); the loop and every cockpit module are dynamic-imported lazily inside
  // the requestRefresh seam / command handler, so activation never pays for
  // chokidar or the candidate readers. The Codex probe seam records every
  // spawn ATTEMPT into a module counter so the default-profile integration test
  // can prove ZERO spawns without touching the real codex binary.
  let cockpitLoop:
    | import('./cockpit/NativeStatusRefreshLoop').NativeStatusRefreshLoopHandle
    | undefined;
  let cockpitProvider:
    | import('./cockpit/GaugeCockpitViewProvider').GaugeCockpitViewProvider
    | undefined;
  let cockpitBuildPromise: Promise<void> | undefined;
  // The live Codex retention gate (one per loop
  // lifetime). Held so the rule-id/boolean-only Cockpit Diagnostics command can
  // read its sanitized snapshot. Reassigned on every (re)build.
  let codexRetentionGate:
    | import('./cockpit/CodexProbeRetentionGate').CodexProbeRetentionGate
    | undefined;

  // Snapshot the cockpit-sensitive config so the loop is rebuilt on change of any
  // of these (the supervisor-rebuild-on-config-change precedent above).
  const COCKPIT_SENSITIVE_KEYS = [
    'tokenGauge.providers.codex.nativeStatusProbe',
    'tokenGauge.claude.statuslineSnapshotPath',
    'tokenGauge.pollIntervalSeconds',
    'tokenGauge.display.cards.claude.visible',
    'tokenGauge.display.cards.codex.visible',
  ] as const satisfies readonly (keyof EffectiveConfig)[];

  async function buildCockpitLoop(): Promise<void> {
    if (cockpitProvider === undefined) {
      return;
    }
    const provider = cockpitProvider;
    const [
      { createNativeStatusRefreshLoop },
      {
        gatherNativeCockpitCandidates,
        resolveStatuslineSnapshotPath,
        MAX_SNAPSHOT_FILES,
        SNAPSHOT_FILE_PATTERN,
      },
      { createClaudeSnapshotStabilityGate },
      { createCodexProbeRetentionGate },
      { createCockpitStabilizationPass },
      { probeCodexNativeStatusGated },
      { CodexAppServerProbe },
      { homedir },
      { join },
      { readFileSync, readdirSync, statSync },
    ] = await Promise.all([
      import('./cockpit/NativeStatusRefreshLoop.js'),
      import('./cockpit/gatherNativeCockpitCandidates.js'),
      import('./cockpit/ClaudeSnapshotStabilityGate.js'),
      import('./cockpit/CodexProbeRetentionGate.js'),
      import('./cockpit/CockpitStabilizationPass.js'),
      import('./adapters/codex/CodexStatusSource.js'),
      import('./adapters/codex/CodexAppServerProbe.js'),
      import('node:os'),
      import('node:path'),
      import('node:fs'),
    ]);

    const sm = secretManager as SecretManager;
    const salt = await sm.getOrCreateInstallSalt();
    const hasher = new IdHasher(salt);

    const snapshot = (configService as ConfigService).snapshot();
    const cardVisibility = resolveProviderCardVisibility({
      claude: snapshot['tokenGauge.display.cards.claude.visible'],
      codex: snapshot['tokenGauge.display.cards.codex.visible'],
    });
    const visibleAgents = visibleAgentsForCardVisibility(cardVisibility);
    const probeEnabled = snapshot['tokenGauge.providers.codex.nativeStatusProbe'] === true;
    const cockpitProbeEnabled = codexProbeVisibleForCockpit(probeEnabled, cardVisibility);

    const statuslinePath = cardVisibility.claude
      ? resolveStatuslineSnapshotPath({
          statuslineSnapshotPath: snapshot['tokenGauge.claude.statuslineSnapshotPath'],
          join,
          // R3: expand a configured leading `~` so the real snapshot file is
          // readable (Node fs does not expand tildes).
          homedir,
        })
      : undefined;
    const statsCachePath = join(homedir(), '.claude', 'stats-cache.json');

    // A per-loop-lifetime stability gate sits between the
    // gatherer and the builder. It holds the last-accepted Claude statusLine
    // value (monotonic by the writer's capture time) and degrades to
    // `snapshot_writer_collision` when competing sessions overwrite one shared
    // snapshot file — so the gauge never silently reverts/flaps. A fresh
    // instance is built here on every (re)build, resetting its memory on
    // config-change as required.
    const stabilityGate = createClaudeSnapshotStabilityGate({
      now: () => new Date(),
      // A rejected lower in-window usage records a
      // rule-id-only diagnostic (no raw values/ids/paths cross). Stamp the fixed
      // status/severity the sanitized sink requires.
      diagnostics: {
        record: ({ ruleId }) => diagnostics.record({ ruleId, status: 'held', severity: 'info' }),
      },
    });
    const gatherCandidates = async () =>
      stabilityGate.step(
        gatherNativeCockpitCandidates({
          claudeVisible: cardVisibility.claude,
          codexVisible: cardVisibility.codex,
          statuslineSnapshotPath: statuslinePath,
          statsCachePath,
          hasher,
          now: () => new Date(),
          readFile: (p) => readFileSync(p, 'utf8'),
          // Per-session directory mode: the SAME setting may point at a
          // TokenGauge-owned snapshot directory (one file per session). The
          // lister reads ONLY that directory, non-recursively, pattern-filters
          // the hash-derived names BEFORE stat'ing, and caps the count — no
          // broad scanning by construction. A missing/unreadable path is
          // simply "not a directory" (single-file mode decides the rest).
          isDirectory: (p) => {
            try {
              return statSync(p).isDirectory();
            } catch {
              return false;
            }
          },
          listDir: (p) => {
            const out: Array<{ name: string; mtimeMs: number }> = [];
            for (const name of readdirSync(p)) {
              if (!SNAPSHOT_FILE_PATTERN.test(name)) continue;
              if (out.length >= MAX_SNAPSHOT_FILES) break;
              try {
                const st = statSync(join(p, name));
                if (st.isFile()) out.push({ name, mtimeMs: st.mtimeMs });
              } catch {
                // per-file races (deleted mid-list) fail closed for that file
              }
            }
            return out;
          },
          join,
          diagnostics,
          codexProbeEnabled: cockpitProbeEnabled,
        }),
      );

    // A per-loop-lifetime Codex
    // retention gate, applied as a PER-TICK candidate-list transform via the loop's
    // transformCandidates seam (below) — NOT inside runProbe. After a VALID Codex
    // probe, a later miss / no-probe poll tick RETAINS the last-known degraded Codex
    // card (precise reason) rather than reverting to "No data source configured".
    // On a no-probe poll tick before any valid result, with the probe ENABLED, it
    // injects an honest codex_probe_pending card (never no_source); when disabled it
    // injects nothing (the gatherer's codex_probe_disabled stands). Fresh instance
    // per (re)build → resets retention on config-change. No spawn, no log read.
    // The gate takes an injected clock so it can keep a card
    // FRESH across the intervening no-probe poll ticks within CODEX_FRESH_TTL_MS
    // (a no-probe tick is "no sample due yet", not a failure) and only mark it
    // stale/degraded once the probe is overdue beyond the TTL.
    codexRetentionGate = createCodexProbeRetentionGate({
      probeEnabled: cockpitProbeEnabled,
      now: () => new Date(),
    });
    const retentionGate = codexRetentionGate;

    // The SINGLE post-merge cockpit
    // stabilization pass. It runs LAST in the transform chain — AFTER the Claude
    // stability gate (inside gatherCandidates), the probe merge, and the Codex
    // retention gate — and BEFORE buildViewModels. It (1) detects a rate-limit
    // window whose resetsAt has passed by the single render clock with no fresher
    // native sample and drops the expired value, surfacing
    // native_window_reset_pending (never the stale used%, never fresh, never risk);
    // and (2) arbitrates the final per-card reason via the one deterministic
    // COCKPIT_REASON_PRIORITY so the reason is decided ONCE rather than by whichever
    // upstream gate wrote last. Pure (injected clock); fresh instance per (re)build
    // → resets on config-change. No spawn, no log read.
    const stabilizationPass = createCockpitStabilizationPass({ now: () => new Date() });

    // The gated Codex probe: when probeEnabled is
    // false the loop NEVER invokes runProbe — provably zero spawn — and the codex
    // card resolves to codex_probe_disabled. When enabled, runProbe constructs the
    // real app-server probe behind the consent gate. The runner records each spawn
    // attempt so the default-profile test can assert zero spawns.
    const runProbe = async () => {
      // Record the ATTEMPT immediately so Cockpit Diagnostics shows
      // a probe is in flight even while the (up to 15s) exchange is pending — it is
      // overwritten with the precise final stage when probeCodexNativeStatusGated
      // resolves. runProbe is only reached when the probe is effectively enabled.
      cockpitCodexLastProbeStage = 'spawn_attempted';
      cockpitCodexLastProbeIoStage = 'none';
      cockpitCodexLastProbeSawStderr = false;
      cockpitCodexLastProbeStdoutChunks = 0;
      cockpitCodexLastProbeExitBucket = 'none';
      cockpitCodexCliResolver = 'not_found';
      cockpitCodexCliResolverStage = 'nvm_not_found';
      const codexProbeCwd = homedir();
      cockpitCodexProbeCwdLabel = labelCodexProbeCwd(codexProbeCwd, homedir());
      const result = await probeCodexNativeStatusGated({
        probeEnabled: cockpitProbeEnabled,
        probe: cockpitProbeEnabled
          ? new CodexAppServerProbe({
              runner: async (request) => {
                cockpitCodexSpawnCount += 1;
                const { spawnCodexAppServerExchange } = await import(
                  './adapters/codex/spawnCodexAppServer.js'
                );
                const runResult = await spawnCodexAppServerExchange(request);
                cockpitCodexCliResolver = runResult.cliResolver ?? 'not_found';
                cockpitCodexCliResolverStage = runResult.cliResolverStage ?? 'nvm_not_found';
                return runResult;
              },
              extensionVersion: context.extension?.packageJSON?.version ?? '0.0.0',
              diagnostics,
              // Spawn from a STABLE cwd (the user's home, where
              // ~/.codex lives) rather than the ext host's unpredictable default —
              // codex app-server startup can be cwd-sensitive (the repro ran from a
              // real dir and worked).
              cwd: codexProbeCwd,
            })
          : undefined,
        now: () => new Date(),
      });
      // Capture the sanitized stage + I/O markers for Cockpit
      // Diagnostics (closed-set labels + a boolean; never raw output).
      cockpitCodexLastProbeStage = result.stage;
      cockpitCodexLastProbeIoStage = result.ioStage;
      cockpitCodexLastProbeSawStderr = result.sawStderr;
      cockpitCodexLastProbeStdoutChunks = result.stdoutChunks;
      cockpitCodexLastProbeExitBucket = result.exitBucket;

      // RunProbe produces ONLY the raw probe outcome — the fresh valid
      // codex_status_snapshot candidate, or an unknown-tier blocker carrying the
      // exact unavailable reason. The retention gate is NO LONGER applied here; it
      // runs once per tick on the merged candidate set via transformCandidates so
      // retention also covers the no-probe poll ticks. A blocker has
      // no session/weekly → never competes for a value; the gate / builder read
      // unavailableReason for the honest card.
      const emission: import('./core/cockpit/SourcePriorityResolver.js').SourceCandidate = result.ok
        ? { ...result.candidate, producedAtMs: Date.now() }
        : {
            sourceTier: 'unknown',
            producedAtMs: Date.now(),
            scope: result.blocked.scope,
            unavailableReason: result.blocked.unavailableReason,
          };
      return [emission];
    };

    cockpitLoop?.dispose();
    cockpitLoop = createNativeStatusRefreshLoop({
      snapshotPaths: statuslinePath !== undefined ? [statuslinePath] : [],
      configuredAgents: visibleAgents,
      gatherCandidates,
      runProbe,
      probeEnabled: cockpitProbeEnabled,
      // Apply the Codex retention gate on EVERY tick (probe
      // and no-probe alike) after the probe merge and before the build, so the
      // Codex card never flickers to "No data source configured" on the no-probe
      // poll ticks. In-memory only — no spawn (the spawn stays gated in runProbe).
      // The single stabilization pass runs LAST (reset-expiry +
      // deterministic reason arbitration) so the final per-card state is decided
      // once, after every gate. Also in-memory only — no spawn, no log read.
      transformCandidates: (merged) => stabilizationPass.step(retentionGate.step(merged)),
      pollIntervalSeconds: ((): number => {
        // Mirrors the manifest default (15); the loop additionally clamps to
        // its 10-15s file-poll bounds, so a bad type can never widen the cadence.
        const raw = snapshot['tokenGauge.pollIntervalSeconds'];
        return typeof raw === 'number' ? raw : 15;
      })(),
      post: (viewModels) => {
        provider.setLatestViewModels(viewModels);
        // The status bar mirrors the native cockpit cards (Claude
        // session gauge + risk color) and focuses the cockpit on click — never
        // the legacy log-derived surface.
        const bar = getOrBuildStatusBar();
        bar.updateFromCockpit(viewModels);
        lastStatusBarText = bar.text;
      },
      diagnostics,
    });
  }

  // Memoized first build: the view's FIRST resolution (or the manual command)
  // triggers exactly one build. createNativeStatusRefreshLoop runs an immediate
  // refresh('poll') internally so the cards paint glanceably with no command and
  // zero spawns by default ("open VS Code → immediately see").
  async function ensureCockpitLoop(): Promise<void> {
    if (cockpitLoop !== undefined) {
      return;
    }
    cockpitBuildPromise ??= buildCockpitLoop();
    await cockpitBuildPromise;
  }

  function rebuildCockpitLoop(): void {
    cockpitBuildPromise = buildCockpitLoop();
    void cockpitBuildPromise.catch((error: unknown) => {
      diagnostics.record({
        ruleId: 'cockpit-rebuild-failed',
        status: 'error',
        severity: 'error',
        details: { phase: 'settings-rebuild', code: classifyActivationFailure(error) },
      });
    });
  }

  // The scope that supplies the EFFECTIVE Codex probe value, shared
  // by Configure Cockpit and the cockpit one-click CTA so both route to the scope
  // that actually controls the toggle. Scope label only — no raw path/account.
  const codexProbeScopeOf = (): 'default' | 'user' | 'workspace' | 'workspaceFolder' => {
    const ins = vscode.workspace
      .getConfiguration('tokenGauge')
      .inspect<boolean>('providers.codex.nativeStatusProbe');
    if (ins?.workspaceFolderValue !== undefined) return 'workspaceFolder';
    if (ins?.workspaceValue !== undefined) return 'workspace';
    if (ins?.globalValue !== undefined) return 'user';
    return 'default';
  };

  cockpitProvider = registerGaugeCockpitViewProvider(context, {
    requestRefresh: async (): Promise<void> => {
      await ensureCockpitLoop();
      await cockpitLoop?.refresh('manual');
    },
    diagnostics,
    // Plumb the NON-SENSITIVE display setting to
    // the webview so the default card stays simple (technical trust metadata hidden).
    showTechnicalDetails: (): boolean =>
      (configService as ConfigService).snapshot()['tokenGauge.display.showTechnicalDetails'] ===
      true,
    cardVisibility: () => {
      const snapshot = (configService as ConfigService).snapshot();
      return resolveProviderCardVisibility({
        claude: snapshot['tokenGauge.display.cards.claude.visible'],
        codex: snapshot['tokenGauge.display.cards.codex.visible'],
      });
    },
    codexProbeScope: codexProbeScopeOf,
    remoteName: () => vscode.env.remoteName,
    showInfo: (message) => {
      notifyCommandResult('info', message);
    },
  });
  context.subscriptions.push({ dispose: () => cockpitLoop?.dispose() });

  // A clear native primary that reveals the cockpit view. VS Code
  // auto-provides `<viewId>.focus`; this command gives the palette a discoverable
  // "TokenGauge: Open Cockpit" entry that routes to the native cockpit (never the
  // legacy log-derived surface) and warms the loop so it paints immediately.
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenGauge.openCockpit', async () => {
      await vscode.commands.executeCommand('tokenGauge.views.cockpit.focus');
      await ensureCockpitLoop();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenGauge.refreshNativeStatus', async () => {
      await ensureCockpitLoop();
      await cockpitLoop?.refresh('manual');
    }),
  );

  // A SAFE, rule-id-only cockpit diagnostics surface. It
  // composes the loop's and the provider's diagnostics snapshots — every field
  // is a boolean, a timestamp, or a closed-set rule id / trigger. NEVER a raw
  // path, id, prompt, transcript, log line, email, or secret. It records the
  // composed snapshot to the sanitized diagnostics sink and opens a read-only
  // rule-id-only summary document.
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenGauge.cockpitDiagnostics', async () => {
      await ensureCockpitLoop();
      const loopSnap = cockpitLoop?.diagnosticsSnapshot();
      const viewSnap = cockpitProvider?.diagnosticsSnapshot();
      // Rule-id/boolean-only Codex retention fields.
      const codexSnap = codexRetentionGate?.diagnosticsSnapshot();
      // Which SCOPE supplies the EFFECTIVE Codex probe value,
      // so a User-vs-Workspace/Folder override (why a tester sees "off" in User
      // settings yet the probe runs) is diagnosable. Scope LABEL only — never the
      // raw value, a path, an account, or a session id.
      const codexProbeScope = codexProbeScopeOf();
      diagnostics.record({
        ruleId: 'cockpit-diagnostics',
        status: loopSnap?.lastRefreshRuleId ?? 'cockpit-refresh-pending',
        severity: 'info',
        details: {
          lastRefreshTrigger: loopSnap?.lastRefreshTrigger ?? 'none',
          pollActive: loopSnap?.pollActive ?? false,
          watchActive: loopSnap?.watchActive ?? false,
          probeEnabled: loopSnap?.probeEnabled ?? false,
          claudeCardVisible: cfg.snapshot()['tokenGauge.display.cards.claude.visible'] === true,
          codexCardVisible: cfg.snapshot()['tokenGauge.display.cards.codex.visible'] === true,
          viewResolved: viewSnap?.resolved ?? false,
          viewVisible: viewSnap?.visible ?? false,
          codexProbeEnabled: codexSnap?.probeEnabled ?? false,
          codexProbeEffectiveScope: codexProbeScope,
          codexProbeLastStage: cockpitCodexLastProbeStage,
          codexProbeLastIoStage: cockpitCodexLastProbeIoStage,
          codexProbeSawStderr: cockpitCodexLastProbeSawStderr,
          codexProbeStdoutChunks: cockpitCodexLastProbeStdoutChunks,
          codexProbeExitBucket: cockpitCodexLastProbeExitBucket,
          codexProbeCwd: cockpitCodexProbeCwdLabel,
          codexCliResolver: cockpitCodexCliResolver,
          codexCliResolverStage: cockpitCodexCliResolverStage,
          codexHasLastKnownValid: codexSnap?.hasLastKnownValid ?? false,
          codexRetentionStep: codexSnap?.lastStepRuleId ?? 'codex_retention_idle',
          codexRetentionReason: codexSnap?.lastAppliedReason ?? 'none',
          // The Codex freshness clarity block. Bucketed
          // age / closed-set tier+window enums / booleans only — no raw values.
          codexLastProbeAgeSeconds: codexSnap?.lastProbeAgeBucketSeconds ?? 'n/a',
          codexFreshnessTier: codexSnap?.freshnessTier ?? 'none',
          codexWindowUsed: codexSnap?.windowUsed ?? 'none',
          codexResetAtPresent: codexSnap?.resetAtPresent ?? false,
          codexReducerRejectedLower: codexSnap?.reducerRejectedLower ?? false,
          codexManualRefreshForcedProbe: loopSnap?.manualRefreshForcedProbe ?? false,
        },
      });
      const lines = [
        '# TokenGauge — Cockpit Diagnostics',
        '',
        'Rule-id-only. No raw paths, ids, prompts, logs, emails, or secrets.',
        '',
        `- last refresh rule: ${loopSnap?.lastRefreshRuleId ?? 'cockpit-refresh-pending'}`,
        `- last refresh trigger: ${loopSnap?.lastRefreshTrigger ?? 'none'}`,
        `- last cockpit update (ms): ${loopSnap?.lastRefreshAtMs ?? 'n/a'}`,
        `- last webview post by loop (ms): ${loopSnap?.lastPostAtMs ?? 'n/a'}`,
        `- last webview post by provider (ms): ${viewSnap?.lastPostAtMs ?? 'n/a'}`,
        `- poll loop active: ${loopSnap?.pollActive ?? false}`,
        `- watch loop active: ${loopSnap?.watchActive ?? false}`,
        `- codex probe enabled: ${loopSnap?.probeEnabled ?? false}`,
        `- claude card visible: ${cfg.snapshot()['tokenGauge.display.cards.claude.visible'] === true}`,
        `- codex card visible: ${cfg.snapshot()['tokenGauge.display.cards.codex.visible'] === true}`,
        `- codex probe effective scope: ${codexProbeScope}`,
        `- codex probe last stage: ${cockpitCodexLastProbeStage}`,
        `- codex probe io stage: ${cockpitCodexLastProbeIoStage}`,
        `- codex probe stderr seen: ${cockpitCodexLastProbeSawStderr}`,
        `- codex probe stdout chunks: ${cockpitCodexLastProbeStdoutChunks}`,
        `- codex probe child exit: ${cockpitCodexLastProbeExitBucket}`,
        `- codex probe cwd: ${cockpitCodexProbeCwdLabel}`,
        `- codex cli resolver: ${cockpitCodexCliResolver}`,
        `- codex cli resolver stage: ${cockpitCodexCliResolverStage}`,
        `- codex probe env: HOME=${process.env.HOME !== undefined} XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR !== undefined} LANG=${process.env.LANG !== undefined} SHELL=${process.env.SHELL !== undefined} PATH=${(process.env.PATH ?? '').length > 0}`,
        `- cockpit view resolved: ${viewSnap?.resolved ?? false}`,
        `- cockpit view visible: ${viewSnap?.visible ?? false}`,
        // Codex retention gate — rule-id/boolean only.
        `- codex retention probe enabled: ${codexSnap?.probeEnabled ?? false}`,
        `- codex last-known value held: ${codexSnap?.hasLastKnownValid ?? false}`,
        `- codex retention last step: ${codexSnap?.lastStepRuleId ?? 'codex_retention_idle'}`,
        `- codex retention last reason: ${codexSnap?.lastAppliedReason ?? 'none'}`,
        // Codex freshness clarity — decide a card-vs-
        // inline-statusline mismatch (probe lag / retained / stale / wrong window /
        // rejected-lower) WITHOUT scraping. Bucketed age / closed enums / booleans.
        `- codex last app-server probe age (s, bucketed): ${codexSnap?.lastProbeAgeBucketSeconds ?? 'n/a'}`,
        `- codex freshness tier: ${codexSnap?.freshnessTier ?? 'none'}`,
        `- codex window used: ${codexSnap?.windowUsed ?? 'none'}`,
        `- codex resetAt present: ${codexSnap?.resetAtPresent ?? false}`,
        `- codex conservative reducer rejected lower: ${codexSnap?.reducerRejectedLower ?? false}`,
        `- codex manual refresh forced probe: ${loopSnap?.manualRefreshForcedProbe ?? false}`,
        '',
        '## Claude snapshot setup checks',
        '',
        '- If the snapshot JSON file does not exist, Claude Code has not run the writer successfully yet.',
        '- Claude Code `statusLine.command` must invoke the writer command, for example `node .../claude-statusline-writer.mjs`.',
        '- TokenGauge `tokenGauge.claude.statuslineSnapshotPath` must point to the snapshot JSON file or snapshot directory, not the writer script.',
        '- If the recorded status is `statusline_snapshot_missing_rate_limits` or `snapshot_dir_missing_rate_limits`, TokenGauge read the snapshot but Claude Code did not report 5h/weekly rate-limit fields. This is not a path problem, and TokenGauge will not guess a usage window.',
        '- Validate the recommended Node writer with `node --check .../claude-statusline-writer.mjs`.',
        '- Only custom shell writers need executable-bit and LF-line-ending checks.',
        '- In WSL, Remote-SSH, or Dev Container windows, set TokenGauge values in the Remote or Workspace settings for the extension host. Local User settings may not affect this window.',
        '',
        '## Recorded diagnostics (bounded, counted)',
        '',
        ...(() => {
          // Finite per-ruleId rollup — counts + latest only. This
          // is the bounded surface that replaces the unbounded per-tick stream.
          const summary = diagnostics.summary();
          if (summary.rules.length === 0) {
            return ['- (none recorded yet)'];
          }
          return [
            `- total recorded (bounded to ${diagnostics.entries().length}): ${summary.total}`,
            ...summary.rules.map(
              (r) =>
                `- ${r.ruleId}: count=${r.count}, latest=${r.latestStatus}/${r.latestSeverity} @ ${r.latestTimestamp}`,
            ),
          ];
        })(),
      ];
      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  // Rebuild the loop when any cockpit-sensitive key changes (probe consent,
  // snapshot path, poll cadence, card visibility) — the supervisor-rebuild
  // precedent. Only rebuilds once the loop has actually been built (a config
  // change before first reveal leaves the lazy build to pick up the new values).
  let lastCockpitInputs: Record<string, unknown> = Object.fromEntries(
    COCKPIT_SENSITIVE_KEYS.map((key) => [key, cfg.snapshot()[key]]),
  );
  context.subscriptions.push(
    configService.onDidChange((next) => {
      const nextInputs: Record<string, unknown> = Object.fromEntries(
        COCKPIT_SENSITIVE_KEYS.map((key) => [key, next[key]]),
      );
      const changed = COCKPIT_SENSITIVE_KEYS.some(
        (key) => nextInputs[key] !== lastCockpitInputs[key],
      );
      lastCockpitInputs = nextInputs;
      if (changed && cockpitLoop !== undefined) {
        rebuildCockpitLoop();
      }
    }),
  );

  // Re-post card presentation state. Technical details do not require a loop
  // rebuild. Visibility also rebuilds the loop above to gate provider
  // reads/probes, but the webview needs the displayConfig update to distinguish
  // a deliberate both-hidden empty state from the first-run welcome.
  const COCKPIT_DISPLAY_CONFIG_KEYS = [
    'tokenGauge.display.showTechnicalDetails',
    'tokenGauge.display.cards.claude.visible',
    'tokenGauge.display.cards.codex.visible',
  ] as const satisfies readonly (keyof EffectiveConfig)[];
  let lastDisplayConfigInputs: Record<string, unknown> = Object.fromEntries(
    COCKPIT_DISPLAY_CONFIG_KEYS.map((key) => [key, cfg.snapshot()[key]]),
  );
  context.subscriptions.push(
    configService.onDidChange((next) => {
      const nextInputs: Record<string, unknown> = Object.fromEntries(
        COCKPIT_DISPLAY_CONFIG_KEYS.map((key) => [key, next[key]]),
      );
      const changed = COCKPIT_DISPLAY_CONFIG_KEYS.some(
        (key) => nextInputs[key] !== lastDisplayConfigInputs[key],
      );
      if (changed) {
        lastDisplayConfigInputs = nextInputs;
        cockpitProvider?.refreshDisplayConfig();
      }
    }),
  );

  // ── Command workflows ──────────────────────────────────────────────────
  // Commands are registered synchronously so they appear in the Command
  // Palette immediately, but each handler dynamically imports its module
  // (filesystem/process/QuickPick logic) only when invoked — activation
  // never pays for them. The real VS Code native-UI/file seams
  // are supplied here; the command modules stay gate-clean.
  context.subscriptions.push(
    // A READ-ONLY first-run guidance entry point that
    // opens exactly ONE surface — a quick pick of essential setup actions. Only
    // the chosen action then opens Settings (filtered) or routes to an existing
    // command; it never opens Settings AND a quick pick at once, and never
    // writes or flips any tokenGauge.* value. Reachable from the command
    // palette, the cockpit view title, and the empty-state button — all route
    // through this single flow.
    vscode.commands.registerCommand('tokenGauge.configureCockpit', async () => {
      const { runConfigureCockpit } = await import('./commands/configureCockpit.js');
      return runConfigureCockpit({
        executeCommand: (command, ...args) =>
          Promise.resolve(vscode.commands.executeCommand(command, ...args)),
        showActionPick: async (options) => {
          const items = options.map((option) => ({
            label: option.label,
            detail: option.detail,
          }));
          const chosen = await vscode.window.showQuickPick(items, {
            title: 'Configure Cockpit',
            placeHolder:
              'TokenGauge is private by default (native-only, logs off). Pick one — nothing is enabled for you.',
            matchOnDetail: true,
          });
          return chosen?.label;
        },
        // Shared effective-scope reader (also feeds the cockpit
        // one-click CTA) so the option routes to the scope that controls it.
        codexProbeScope: codexProbeScopeOf,
        remoteName: () => vscode.env.remoteName,
        showInfo: (message) => {
          notifyCommandResult('info', message);
        },
      });
    }),
    vscode.commands.registerCommand('tokenGauge.openPrivacyReport', async () => {
      const { runOpenPrivacyReport } = await import('./commands/openPrivacyReport.js');
      return runOpenPrivacyReport({
        buildInput: async () => {
          const snapshot = cfg.snapshot();
          const cardVisibility = resolveProviderCardVisibility({
            claude: snapshot['tokenGauge.display.cards.claude.visible'],
            codex: snapshot['tokenGauge.display.cards.codex.visible'],
          });
          return {
            codexProbeEnabled: snapshot['tokenGauge.providers.codex.nativeStatusProbe'] === true,
            codexCardVisible: cardVisibility.codex,
            claudeCardVisible: cardVisibility.claude,
          };
        },
        renderReport: async (report) => {
          const doc = await vscode.workspace.openTextDocument({
            content: report.body,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        },
      });
    }),
  );

  // Show the native status bar immediately (neutral "open cockpit"
  // state, click → cockpit) and kick a deferred, idle cockpit-loop build so the
  // bar populates with native cards WITHOUT the user opening the view. The build
  // is fire-and-forget off the activation hot path; it spawns zero Codex process
  // by default (nativeStatusProbe=false) and stays lazy enough not to regress the
  // <200ms activation budget — the immediate refresh runs after activate()
  // returns. Failures route through the diagnostics seam.
  getOrBuildStatusBar();
  setTimeout(() => {
    void ensureCockpitLoop().catch((error: unknown) => {
      diagnostics.record({
        ruleId: 'cockpit-deferred-build-failed',
        status: 'error',
        severity: 'error',
        details: { phase: 'deferred-activation', code: classifyActivationFailure(error) },
      });
    });
  }, 0);

  const elapsed = performance.now() - t0;
  lastActivationMs = elapsed;

  outputChannel.appendLine(
    `[tokengauge] activation ready: ${elapsed.toFixed(1)}ms (budget: ${ACTIVATION_BUDGET_MS}ms)`,
  );

  if (elapsed > ACTIVATION_BUDGET_MS) {
    outputChannel.appendLine(
      `[tokengauge] WARNING: activation exceeded budget by ${(elapsed - ACTIVATION_BUDGET_MS).toFixed(1)}ms`,
    );
  }

  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return undefined;
  }

  return {
    configService,
    secretManager,
    saltReady,
    getLastActivationMs: () => lastActivationMs,
    globalStoragePath: () => context.globalStorageUri.fsPath,
    statusBarText: (): string | undefined => lastStatusBarText,
    diagnosticsEntries: (): readonly DiagnosticsEntry[] => diagnostics.entries(),
    cockpitViewProviderState: (): GaugeCockpitViewProviderTestState =>
      GaugeCockpitViewProviderClass.testState(),
    codexProbeSpawnCountForTest: (): number => cockpitCodexSpawnCount,
    refreshCockpitForTest: async (): Promise<void> => {
      await ensureCockpitLoop();
      await cockpitLoop?.refresh('manual');
    },
    resolveCockpitViewForTest: async (): Promise<void> => {
      // Drive the genuine provider.resolveWebviewView with a minimal visible
      // fake view. resolveWebviewView fires requestRefresh() fire-and-forget, so
      // afterwards we await the SAME build+refresh sequence to settle before the
      // test inspects the posted cards / spawn count (R2 regression guard).
      const noopDisposable: vscode.Disposable = { dispose: () => {} };
      const fakeView = {
        visible: true,
        webview: {
          options: {},
          html: '',
          cspSource: 'vscode-webview://test',
          asWebviewUri: (uri: vscode.Uri) => uri,
          postMessage: () => Promise.resolve(true),
          onDidReceiveMessage: () => noopDisposable,
        },
        onDidChangeVisibility: () => noopDisposable,
        onDidDispose: () => noopDisposable,
      } as unknown as vscode.WebviewView;
      cockpitProvider?.resolveWebviewView(
        fakeView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken,
      );
      await ensureCockpitLoop();
      await cockpitLoop?.refresh('manual');
    },
  };
}

export function deactivate(): void {
  /* Disposables are cleaned up via context.subscriptions automatically. */
}
