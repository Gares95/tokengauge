// The sidebar Webview View
// provider. The cockpit's webview boundary uses one audited CSP builder plus
// localResourceRoots enforcement, never a duplicated string.
//
// View-specific behavior (research Pattern 1): a WebviewView is
// destroyed when hidden (retainContextWhenHidden stays false — Pitfall 2), so a
// re-show must NOT leave the view blank. We re-post the latest VMs on the
// webview's `ready` handshake AND on every visibility-change-to-visible
// (Pitfall 1). Posting to a hidden view silently fails, so setLatestViewModels
// only posts when the view is attached AND visible.

import { existsSync, readdirSync } from 'node:fs';
import * as vscode from 'vscode';
import {
  type CodexProbeScope,
  openCodexProbeSetting,
  PROVIDER_CARD_VISIBILITY_SETTINGS_QUERY,
  remoteSettingsScopeMessage,
} from '../commands/configureCockpit';
import type { DiagnosticsService } from '../core/diagnostics/DiagnosticsService';
import type { CockpitOutboundMessage } from './CockpitMessageSchema';
import { parseCockpitInboundMessage } from './CockpitMessageSchema';
import { buildCockpitCsp, createNonce } from './csp';
import type { GaugeCardViewModel } from './GaugeCardViewModel';
import {
  DEFAULT_PROVIDER_CARD_VISIBILITY,
  type ProviderCardVisibility,
} from './providerCardVisibility';
import { webviewBuildId, webviewCacheBustToken } from './webviewBuildId';

export const COCKPIT_VIEW_ID = 'tokenGauge.views.cockpit';

// Rule-id-only diagnostics surface: booleans + a timestamp
// only. NEVER a raw path, id, html, or message — safe for Cockpit Diagnostics.
export interface CockpitProviderDiagnosticsSnapshot {
  readonly resolved: boolean;
  readonly visible: boolean;
  readonly lastPostAtMs: number | undefined;
}

const EXTENSION_SETTINGS_FILTER = '@ext:tokengauge.tokengauge-vscode';

export interface GaugeCockpitViewProviderDeps {
  readonly requestRefresh: () => Promise<void> | void;
  readonly diagnostics: DiagnosticsService;
  readonly executeCommand?: (command: string, ...args: readonly unknown[]) => Thenable<unknown>;
  // Reads tokenGauge.display.showTechnicalDetails
  // at post time so the cockpit reflects the current setting (and a live change once
  // re-posted). Non-sensitive boolean. Defaults to false (simpler card) when absent.
  readonly showTechnicalDetails?: () => boolean;
  // Provider card visibility. Booleans only; hiding a card removes it from the
  // cockpit/status summaries and upstream loop gates provider reads/probes. It
  // is not provider enablement, not deletion, and not a probe opt-in toggle.
  readonly cardVisibility?: () => ProviderCardVisibility;
  // One-click CTA: the scope that supplies the effective Codex
  // probe value + the info toast, so the codexProbe settings target routes to the
  // scope that actually controls it (shared openCodexProbeSetting). Scope label
  // only — never a raw path/account. Absent → plain User-scope focus.
  readonly codexProbeScope?: () => CodexProbeScope;
  readonly showInfo?: (message: string) => void;
  // VS Code remote extension-host label, for example "wsl" or "ssh-remote".
  // Label only; never a path/account. Optional: absent means local window.
  readonly remoteName?: () => string | undefined;
}

export interface GaugeCockpitViewProviderTestState {
  readonly resolveCount: number;
  readonly viewId: string;
  readonly localResourceRoots: readonly string[];
  readonly postedMessages: readonly CockpitOutboundMessage[];
  readonly html?: string;
}

interface MutableTestState {
  resolveCount: number;
  viewId: string;
  localResourceRoots: string[];
  postedMessages: CockpitOutboundMessage[];
  html?: string;
}

const testState: MutableTestState = {
  resolveCount: 0,
  viewId: COCKPIT_VIEW_ID,
  localResourceRoots: [],
  postedMessages: [],
};

function findStylesheetName(webviewRoot: vscode.Uri): string | undefined {
  const assetsRoot = vscode.Uri.joinPath(webviewRoot, 'assets');
  if (!existsSync(assetsRoot.fsPath)) {
    return undefined;
  }
  // R1: each entry emits its OWN stylesheet (cockpit-*.css / webview-*.css).
  // Match the cockpit bundle's own CSS by prefix — never "first .css", which
  // could pick up another bundle's stylesheet.
  return readdirSync(assetsRoot.fsPath).find(
    (name) => name.startsWith('cockpit-') && name.endsWith('.css'),
  );
}

function html(options: {
  readonly webview: vscode.Webview;
  readonly extensionUri: vscode.Uri;
  readonly nonce: string;
  readonly extensionVersion: string;
}): string {
  const webviewRoot = vscode.Uri.joinPath(options.extensionUri, 'dist', 'webview');
  const bundleUri = vscode.Uri.joinPath(webviewRoot, 'cockpit.js');
  // Append a per-build, content-derived cache-bust token
  // so a fresh VSIX install serves the NEW bundle instead of VS Code's cached one.
  // The uri stays a vscode-webview RESOURCE uri (no inline, no remote) — only the
  // `?v=` suffix is added; the nonce on the <script> tag is unchanged, CSP byte-
  // identical. Token is non-sensitive (version + short content hash).
  const cacheBust = webviewCacheBustToken(bundleUri, options.extensionVersion);
  // Append the token to the STRINGIFIED resource uri rather than via Uri.with({query}),
  // because vscode.Uri.toString() percent-encodes a query's `=` to `%3D` — keeping a
  // literal `?v=<token>` makes the bust legible and still resolves to the same
  // vscode-webview resource (the webview ignores the query when locating the file).
  const scriptSrc = `${options.webview.asWebviewUri(bundleUri).toString()}?v=${cacheBust}`;
  const buildId = webviewBuildId(bundleUri, options.extensionVersion);
  const stylesheetName = findStylesheetName(webviewRoot);
  const styleTag =
    stylesheetName !== undefined
      ? `<link rel="stylesheet" nonce="${options.nonce}" href="${options.webview.asWebviewUri(
          vscode.Uri.joinPath(webviewRoot, 'assets', stylesheetName),
        )}">`
      : '';
  const csp = buildCockpitCsp({
    nonce: options.nonce,
    webviewCspSource: options.webview.cspSource,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${styleTag}
  <title>TokenGauge Cockpit</title>
</head>
<body>
  <div id="root" data-build-id="${buildId}"></div>
  <script nonce="${options.nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}

export class GaugeCockpitViewProvider implements vscode.WebviewViewProvider {
  private readonly context: vscode.ExtensionContext;
  private readonly deps: GaugeCockpitViewProviderDeps;
  private view: vscode.WebviewView | undefined;
  private latestViewModels: GaugeCardViewModel[] = [];
  private lastPostAtMs: number | undefined;

  public constructor(context: vscode.ExtensionContext, deps: GaugeCockpitViewProviderDeps) {
    this.context = context;
    this.deps = deps;
  }

  // Non-sensitive extension version, read from the activated extension's
  // packageJSON. Falls back to '0.0.0' (mirrors the codex-probe call site).
  private extensionVersion(): string {
    return (
      (this.context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0'
    );
  }

  // The non-sensitive build id surfaced to the webview + diagnostics
  // so UAT can prove which build is live. Version + short content hash; no path/secret.
  public buildId(): string {
    const bundleUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webview',
      'cockpit.js',
    );
    return webviewBuildId(bundleUri, this.extensionVersion());
  }

  // Rule-id-only diagnostics for the Cockpit Diagnostics command. No raw data.
  public diagnosticsSnapshot(): CockpitProviderDiagnosticsSnapshot {
    return {
      resolved: this.view !== undefined,
      visible: this.view?.visible === true,
      lastPostAtMs: this.lastPostAtMs,
    };
  }

  public resolveWebviewView(
    view: vscode.WebviewView,
    _resolveContext: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = view;
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    // retainContextWhenHidden is intentionally NOT set (false default, Pitfall 2):
    // the webview hydrates from setState plus the ready/visibility re-post.
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };
    testState.resolveCount += 1;
    testState.viewId = COCKPIT_VIEW_ID;
    testState.localResourceRoots = ['dist/webview'];

    view.webview.html = html({
      webview: view.webview,
      extensionUri: this.context.extensionUri,
      nonce: createNonce(),
      extensionVersion: this.extensionVersion(),
    });
    testState.html = view.webview.html;

    view.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message).catch(() => {
        this.recordAsyncBoundaryFailure('cockpit-postmessage-handler-failed');
      });
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postLatest();
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });

    // R2: trigger exactly one initial refresh so the cockpit paints glanceably
    // on first open (no manual Refresh needed). ensureCockpitLoop is memoised
    // upstream, so repeated resolves never build duplicate loops/watchers. The
    // loop's immediate refresh('poll') posts the Claude + Codex cards with zero
    // codex spawns by default. Fire-and-forget, but still catch the promise
    // boundary so a rejected command path never appears as an uncaught extension
    // error.
    this.requestRefreshSafely('cockpit-initial-refresh-failed');
  }

  public setLatestViewModels(viewModels: GaugeCardViewModel[]): void {
    this.latestViewModels = viewModels;
    this.postLatest();
  }

  public static testState(): GaugeCockpitViewProviderTestState {
    return {
      resolveCount: testState.resolveCount,
      viewId: testState.viewId,
      localResourceRoots: [...testState.localResourceRoots],
      postedMessages: [...testState.postedMessages],
      ...(testState.html !== undefined ? { html: testState.html } : {}),
    };
  }

  private postLatest(): void {
    // Posting to a hidden/detached view silently fails (Pitfall 1) — only post
    // when the view is attached AND visible.
    if (this.view === undefined || !this.view.visible) {
      return;
    }
    // Deliver the cards FIRST (preserving the synchronous-first-post
    // contract), then the current display posture alongside, so a visibility re-show
    // (the WebviewView is destroyed when hidden) re-applies the simple-vs-technical
    // setting without waiting for the next ready handshake.
    this.postMessageSafely({ type: 'gaugeCards', cards: this.latestViewModels });
    this.postDisplayConfigSafely();
  }

  // Post the NON-SENSITIVE showTechnicalDetails
  // flag (default false when the dep is absent). Called on ready, on every card
  // post, and on a config change so the card reflects the current setting.
  private async postDisplayConfig(): Promise<void> {
    if (this.view === undefined || !this.view.visible) {
      return;
    }
    await this.postMessage({
      type: 'displayConfig',
      showTechnicalDetails: this.deps.showTechnicalDetails?.() ?? false,
      cardVisibility: this.deps.cardVisibility?.() ?? DEFAULT_PROVIDER_CARD_VISIBILITY,
    });
  }

  // Re-post the display posture when the setting changes so a live toggle of
  // tokenGauge.display.showTechnicalDetails updates the open cockpit immediately.
  public refreshDisplayConfig(): void {
    this.postDisplayConfigSafely();
  }

  private recordAsyncBoundaryFailure(ruleId: string): void {
    this.deps.diagnostics.record({
      ruleId,
      status: 'rejected',
      severity: 'error',
    });
  }

  private requestRefreshSafely(ruleId: string): void {
    try {
      void Promise.resolve(this.deps.requestRefresh()).catch(() => {
        this.recordAsyncBoundaryFailure(ruleId);
      });
    } catch {
      this.recordAsyncBoundaryFailure(ruleId);
    }
  }

  private postMessageSafely(message: CockpitOutboundMessage): void {
    void this.postMessage(message).catch(() => {
      this.recordAsyncBoundaryFailure('cockpit-webview-post-failed');
    });
  }

  private postDisplayConfigSafely(): void {
    void this.postDisplayConfig().catch(() => {
      this.recordAsyncBoundaryFailure('cockpit-webview-post-failed');
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const parsed = parseCockpitInboundMessage(raw, this.deps.diagnostics);
    if (!parsed.ok) {
      return;
    }
    const commandExecutor = this.deps.executeCommand ?? vscode.commands.executeCommand;
    switch (parsed.message.type) {
      case 'ready':
        // The ready handshake re-posts the latest VMs regardless of the cached
        // visibility flag — the webview signalled it is live. It also delivers the
        // non-sensitive build id for internal traceability and the display posture
        // so the card is simple-vs-technical.
        // Post the cards FIRST so a single synchronous handler tick still delivers
        // them; the display-posture + build-id markers ride alongside (non-blocking).
        await this.postMessage({ type: 'gaugeCards', cards: this.latestViewModels });
        await this.postDisplayConfig();
        await this.postMessage({ type: 'buildInfo', buildId: this.buildId() });
        return;
      case 'refreshNativeStatus':
        await this.deps.requestRefresh();
        return;
      case 'openClaudeSnapshotPathSetting': {
        const rawRemoteName = this.deps.remoteName?.();
        const remoteName = typeof rawRemoteName === 'string' ? rawRemoteName.trim() : '';
        if (remoteName.length > 0) {
          this.deps.showInfo?.(remoteSettingsScopeMessage(remoteName));
        }
        await commandExecutor(
          'workbench.action.openSettings',
          '@id:tokenGauge.claude.statuslineSnapshotPath',
        );
        return;
      }
      case 'openSettings': {
        // A SetupCallout CTA may target a SPECIFIC setting (one click) via the
        // closed-enum `target`; absent → the extension-filtered list (default).
        // The codexProbe target routes through the scope-aware
        // opener: a Workspace/Folder value overrides User, so the CTA must open
        // the scope that actually controls the toggle.
        if (parsed.message.target === 'codexProbe') {
          await openCodexProbeSetting({
            executeCommand: async (command, ...args) => commandExecutor(command, ...args),
            ...(this.deps.codexProbeScope !== undefined
              ? { codexProbeScope: this.deps.codexProbeScope }
              : {}),
            ...(this.deps.showInfo !== undefined ? { showInfo: this.deps.showInfo } : {}),
            ...(this.deps.remoteName !== undefined ? { remoteName: this.deps.remoteName } : {}),
          });
          return;
        }
        const query =
          parsed.message.target === 'claudeSnapshotPath'
            ? '@id:tokenGauge.claude.statuslineSnapshotPath'
            : parsed.message.target === 'providerCards'
              ? PROVIDER_CARD_VISIBILITY_SETTINGS_QUERY
              : EXTENSION_SETTINGS_FILTER;
        const rawRemoteName = this.deps.remoteName?.();
        const remoteName = typeof rawRemoteName === 'string' ? rawRemoteName.trim() : '';
        if (remoteName.length > 0) {
          this.deps.showInfo?.(remoteSettingsScopeMessage(remoteName));
        }
        await commandExecutor('workbench.action.openSettings', query);
        return;
      }
      case 'configureCockpit':
        // Route the empty-state button to the READ-ONLY
        // Configure Cockpit guidance command — never sets a setting value.
        await commandExecutor('tokenGauge.configureCockpit');
        return;
      case 'openPrivacyReport':
        // The persistent "Privacy & data" action link → the read-only
        // Privacy & Data Report command. No payload, no setting write.
        await commandExecutor('tokenGauge.openPrivacyReport');
        return;
      case 'openCockpitDiagnostics':
        // The persistent "Diagnostics" action link → the Cockpit Diagnostics
        // command (rule-id-only surface). No payload, no setting write.
        await commandExecutor('tokenGauge.cockpitDiagnostics');
        return;
    }
  }

  private async postMessage(message: CockpitOutboundMessage): Promise<void> {
    testState.postedMessages.push(message);
    this.lastPostAtMs = Date.now();
    await this.view?.webview.postMessage(message);
  }
}

export function registerGaugeCockpitViewProvider(
  context: vscode.ExtensionContext,
  deps: GaugeCockpitViewProviderDeps,
): GaugeCockpitViewProvider {
  const provider = new GaugeCockpitViewProvider(context, deps);
  const disposable = vscode.window.registerWebviewViewProvider(COCKPIT_VIEW_ID, provider);
  context.subscriptions.push(disposable);
  return provider;
}
