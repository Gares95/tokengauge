import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GaugeCardViewModel } from '../../../src/cockpit/GaugeCardViewModel';
import {
  COCKPIT_VIEW_ID,
  GaugeCockpitViewProvider,
} from '../../../src/cockpit/GaugeCockpitViewProvider';
import type { ProviderCardVisibility } from '../../../src/cockpit/providerCardVisibility';
import { DiagnosticsService } from '../../../src/core/diagnostics/DiagnosticsService';

interface FakeWebview {
  options: vscode.WebviewOptions;
  html: string;
  cspSource: string;
  readonly posted: unknown[];
  asWebviewUri(uri: vscode.Uri): vscode.Uri;
  postMessage(message: unknown): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): vscode.Disposable;
  fireMessage(message: unknown): void;
}

interface FakeWebviewView {
  webview: FakeWebview;
  visible: boolean;
  onDidChangeVisibility(listener: () => void): vscode.Disposable;
  onDidDispose(listener: () => void): vscode.Disposable;
  fireVisibilityChange(visible: boolean): void;
}

function makeFakeView(): FakeWebviewView {
  let messageListener: ((message: unknown) => void) | undefined;
  let visibilityListener: (() => void) | undefined;
  const view: FakeWebviewView = {
    visible: true,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://fake',
      posted: [],
      asWebviewUri: (uri) => uri,
      postMessage(message) {
        this.posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(listener) {
        messageListener = listener;
        return { dispose: () => {} };
      },
      fireMessage(message) {
        messageListener?.(message);
      },
    },
    onDidChangeVisibility(listener) {
      visibilityListener = listener;
      return { dispose: () => {} };
    },
    onDidDispose() {
      return { dispose: () => {} };
    },
    fireVisibilityChange(visible) {
      this.visible = visible;
      visibilityListener?.();
    },
  };
  return view;
}

// Drain pending microtasks so awaited posts (displayConfig/buildInfo) after the
// synchronous-first gaugeCards post are observable. A few turns covers the chain.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function fakeContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('/ext'),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function sampleCard(): GaugeCardViewModel {
  const gauge = { centerLabel: '—', state: 'unavailable' as const };
  return {
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    colorKey: 'claude',
    session: gauge,
    weekly: gauge,
    context: gauge,
    risk: 'unavailable',
    sourceTier: 'unknown',
    freshness: 'unavailable',
  };
}

function resolveProvider(options?: {
  requestRefresh?: () => Promise<void> | void;
  diagnostics?: DiagnosticsService;
  executeCommand?: (command: string, ...args: readonly unknown[]) => Thenable<unknown>;
  showTechnicalDetails?: () => boolean;
  cardVisibility?: () => ProviderCardVisibility;
  codexProbeScope?: () => 'default' | 'user' | 'workspace' | 'workspaceFolder';
  showInfo?: (message: string) => void;
  remoteName?: () => string | undefined;
}): { provider: GaugeCockpitViewProvider; view: FakeWebviewView } {
  const provider = new GaugeCockpitViewProvider(fakeContext(), {
    requestRefresh: options?.requestRefresh ?? ((): void => {}),
    diagnostics: options?.diagnostics ?? new DiagnosticsService(),
    ...(options?.executeCommand !== undefined ? { executeCommand: options.executeCommand } : {}),
    ...(options?.showTechnicalDetails !== undefined
      ? { showTechnicalDetails: options.showTechnicalDetails }
      : {}),
    ...(options?.cardVisibility !== undefined ? { cardVisibility: options.cardVisibility } : {}),
    ...(options?.codexProbeScope !== undefined ? { codexProbeScope: options.codexProbeScope } : {}),
    ...(options?.showInfo !== undefined ? { showInfo: options.showInfo } : {}),
    ...(options?.remoteName !== undefined ? { remoteName: options.remoteName } : {}),
  });
  const view = makeFakeView();
  provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken,
  );
  return { provider, view };
}

suite('GaugeCockpitViewProvider', () => {
  test('COCKPIT_VIEW_ID is tokenGauge.views.cockpit', () => {
    assert.equal(COCKPIT_VIEW_ID, 'tokenGauge.views.cockpit');
  });

  test('ResolveWebviewView serves nonce CSP html, scripts enabled, dist/webview roots', () => {
    const { view } = resolveProvider();
    assert.equal(view.webview.options.enableScripts, true);
    const state = GaugeCockpitViewProvider.testState();
    assert.deepEqual(state.localResourceRoots, ['dist/webview']);

    const html = view.webview.html;
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(html.includes('cockpit.js'));
    assert.ok(/nonce="[^"]+"/.test(html), 'script tag carries a nonce');
    assert.ok(!html.includes('unsafe-inline'));
  });

  // The webview JS uri carries a per-build
  // cache-bust token so a fresh VSIX install never serves VS Code's cached bundle.
  test('Cockpit.js script src carries a ?v= cache-bust token on a vscode-webview uri', () => {
    const { view } = resolveProvider();
    const html = view.webview.html;
    const scriptSrc = /<script nonce="[^"]+" src="([^"]+)">/.exec(html)?.[1];
    assert.ok(scriptSrc, 'cockpit script tag present');
    assert.ok(scriptSrc.includes('cockpit.js'), 'src points at the cockpit bundle');
    assert.match(scriptSrc, /[?&]v=/, 'src carries a ?v= cache-bust token');
    // The uri stays a resource uri — no inline script, no remote origin.
    assert.ok(!scriptSrc.startsWith('http://'), 'no remote http origin');
    assert.ok(!scriptSrc.includes('unsafe-inline'));
    // The nonce is still present on the script tag (CSP intact).
    assert.match(html, /<script nonce="[^"]+" src="[^"]*cockpit\.js[^"]*">/);
  });

  // A non-sensitive build id is embedded as a DOM marker so UAT
  // can read which build is live; it carries no path or secret.
  test('Html embeds a non-sensitive data-build-id marker', () => {
    const { provider, view } = resolveProvider();
    const buildId = /data-build-id="([^"]+)"/.exec(view.webview.html)?.[1];
    assert.ok(buildId, 'root div carries a data-build-id');
    assert.match(buildId, /^build /, 'build id reads "build …"');
    assert.ok(!buildId.includes('/'), 'no path in build id');
    assert.equal(buildId, provider.buildId(), 'marker matches provider.buildId()');
  });

  test('ResolveWebviewView triggers exactly one initial refresh (R2 — paint on open)', () => {
    let refreshCount = 0;
    resolveProvider({
      requestRefresh: (): void => {
        refreshCount += 1;
      },
    });
    assert.equal(refreshCount, 1, 'first resolution must request exactly one refresh');
  });

  test('Inbound ready posts the latest cached gaugeCards', () => {
    const { provider, view } = resolveProvider();
    provider.setLatestViewModels([sampleCard()]);
    view.webview.posted.length = 0;

    view.webview.fireMessage({ type: 'ready' });

    const posted = view.webview.posted as Array<{ type?: string; cards?: unknown[] }>;
    const gaugeCards = posted.find((message) => message.type === 'gaugeCards');
    assert.ok(gaugeCards, 'ready must trigger a gaugeCards post');
    assert.equal(gaugeCards.cards?.length, 1);
  });

  // The NON-SENSITIVE display posture is posted
  // on ready (and on every post) so the webview can switch simple vs technical. It
  // carries a single boolean — never a path/secret/value.
  // The ready handler posts the cards FIRST (synchronous-first contract) then the
  // displayConfig + buildInfo across awaits, so flush microtasks before asserting.
  test('Inbound ready posts a displayConfig reflecting display-only deps', async () => {
    const { view } = resolveProvider({
      showTechnicalDetails: (): boolean => true,
      cardVisibility: () => ({ claude: false, codex: true }),
    });
    view.webview.posted.length = 0;

    view.webview.fireMessage({ type: 'ready' });
    await flushMicrotasks();

    const posted = view.webview.posted as Array<{
      type?: string;
      showTechnicalDetails?: unknown;
      cardVisibility?: unknown;
    }>;
    const cfg = posted.find((message) => message.type === 'displayConfig');
    assert.ok(cfg, 'ready must post a displayConfig message');
    assert.equal(cfg.showTechnicalDetails, true);
    assert.deepEqual(cfg.cardVisibility, { claude: false, codex: true });
    // Only the closed key set rides the displayConfig message — no leak vector.
    const allowed = new Set(['type', 'showTechnicalDetails', 'cardVisibility']);
    for (const key of Object.keys(cfg)) {
      assert.ok(allowed.has(key), `unexpected displayConfig key: ${key}`);
    }
  });

  test('DisplayConfig defaults to false when no showTechnicalDetails dep is provided', async () => {
    const { view } = resolveProvider();
    view.webview.posted.length = 0;
    view.webview.fireMessage({ type: 'ready' });
    await flushMicrotasks();
    const cfg = (
      view.webview.posted as Array<{
        type?: string;
        showTechnicalDetails?: unknown;
        cardVisibility?: unknown;
      }>
    ).find((m) => m.type === 'displayConfig');
    assert.ok(cfg, 'a displayConfig is still posted');
    assert.equal(cfg.showTechnicalDetails, false, 'default posture is the simple card');
    assert.deepEqual(cfg.cardVisibility, { claude: true, codex: true });
  });

  test('RefreshDisplayConfig re-posts the current display posture (live toggle)', () => {
    let show = false;
    const { provider, view } = resolveProvider({ showTechnicalDetails: (): boolean => show });
    view.webview.posted.length = 0;
    show = true;
    provider.refreshDisplayConfig();
    const cfg = (
      view.webview.posted as Array<{ type?: string; showTechnicalDetails?: unknown }>
    ).find((m) => m.type === 'displayConfig');
    assert.ok(cfg, 'refreshDisplayConfig posts a displayConfig');
    assert.equal(cfg.showTechnicalDetails, true);
  });

  test('Inbound refreshNativeStatus invokes requestRefresh once', () => {
    let refreshCount = 0;
    const { view } = resolveProvider({
      requestRefresh: (): void => {
        refreshCount += 1;
      },
    });
    // R2: resolution itself fires exactly one initial refresh; reset so this
    // test isolates the message-driven refresh.
    refreshCount = 0;

    view.webview.fireMessage({ type: 'refreshNativeStatus' });

    assert.equal(refreshCount, 1);
  });

  test('Inbound openSettings executes openSettings with the extension filter', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
    });

    view.webview.fireMessage({ type: 'openSettings' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'workbench.action.openSettings');
    assert.equal(calls[0]?.args[0], '@ext:gares-extensions.tokengauge-vscode');
  });

  // A targeted openSettings focuses the EXACT setting so the Codex probe
  // CTA drops the user on the toggle, not a list.
  test('Inbound openSettings with a target focuses the exact @id setting', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
    });

    view.webview.fireMessage({ type: 'openSettings', target: 'codexProbe' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'workbench.action.openSettings');
    assert.equal(calls[0]?.args[0], '@id:tokenGauge.providers.codex.nativeStatusProbe');
  });

  test('Inbound openClaudeSnapshotPathSetting focuses the exact snapshot path setting', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
    });

    view.webview.fireMessage({ type: 'openClaudeSnapshotPathSetting' });

    assert.deepEqual(calls, [
      {
        command: 'workbench.action.openSettings',
        args: ['@id:tokenGauge.claude.statuslineSnapshotPath'],
      },
    ]);
    assert.ok(
      !calls.some((call) => call.command === 'tokenGauge.configureCockpit'),
      'Claude snapshot CTA must not open the generic Configure Cockpit picker',
    );
  });

  test('Inbound openClaudeSnapshotPathSetting warns about Remote scope when remote', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const infos: string[] = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
      remoteName: () => 'wsl',
      showInfo: (message) => {
        infos.push(message);
      },
    });

    view.webview.fireMessage({ type: 'openClaudeSnapshotPathSetting' });

    assert.deepEqual(calls, [
      {
        command: 'workbench.action.openSettings',
        args: ['@id:tokenGauge.claude.statuslineSnapshotPath'],
      },
    ]);
    assert.equal(infos.length, 1);
    assert.match(infos[0] ?? '', /Remote: wsl/);
    assert.match(infos[0] ?? '', /Remote or Workspace settings/);
    assert.match(infos[0] ?? '', /Local User settings may not affect/);
  });

  test('Inbound openSettings warns about Remote scope when TokenGauge runs remotely', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const infos: string[] = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
      remoteName: () => 'wsl',
      showInfo: (message) => {
        infos.push(message);
      },
    });

    view.webview.fireMessage({ type: 'openSettings', target: 'claudeSnapshotPath' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'workbench.action.openSettings');
    assert.equal(calls[0]?.args[0], '@id:tokenGauge.claude.statuslineSnapshotPath');
    assert.equal(infos.length, 1);
    assert.match(infos[0] ?? '', /Remote: wsl/);
    assert.match(infos[0] ?? '', /Remote or Workspace settings/);
    assert.match(infos[0] ?? '', /Local User settings may not affect/);
  });

  // When a Workspace scope controls the effective probe value,
  // the one-click CTA must open WORKSPACE settings (with the explanation toast) —
  // never User settings, where the toggle would not win.
  test('Inbound openSettings codexProbe routes to Workspace settings when that scope wins', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const infos: string[] = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
      codexProbeScope: () => 'workspace',
      showInfo: (message) => {
        infos.push(message);
      },
    });

    view.webview.fireMessage({ type: 'openSettings', target: 'codexProbe' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'workbench.action.openWorkspaceSettings');
    assert.equal(calls[0]?.args[0], '@id:tokenGauge.providers.codex.nativeStatusProbe');
    assert.equal(infos.length, 1);
    assert.match(infos[0] ?? '', /Workspace settings override/);
  });

  test('Inbound openSettings providerCards opens the shared visibility filter', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
    });

    view.webview.fireMessage({ type: 'openSettings', target: 'providerCards' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'workbench.action.openSettings');
    assert.equal(calls[0]?.args[0], 'tokenGauge.display.cards');
  });

  // The persistent "Privacy & data" action link routes to the existing
  // read-only Privacy & Data Report command (no payload).
  test('Inbound openPrivacyReport executes the Privacy & Data Report command', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
    });

    view.webview.fireMessage({ type: 'openPrivacyReport' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'tokenGauge.openPrivacyReport');
  });

  // The persistent "Diagnostics" action link routes to the existing Cockpit
  // Diagnostics command (no payload).
  test('Inbound openCockpitDiagnostics executes the Cockpit Diagnostics command', () => {
    const calls: Array<{ command: string; args: readonly unknown[] }> = [];
    const { view } = resolveProvider({
      executeCommand: (command, ...args) => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
    });

    view.webview.fireMessage({ type: 'openCockpitDiagnostics' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'tokenGauge.cockpitDiagnostics');
  });

  test('Rejected inbound command is recorded instead of escaping as an uncaught error', async () => {
    const diagnostics = new DiagnosticsService();
    const { view } = resolveProvider({
      diagnostics,
      executeCommand: () => Promise.reject(new Error('command failed')),
    });

    assert.doesNotThrow(() => view.webview.fireMessage({ type: 'openCockpitDiagnostics' }));
    await flushMicrotasks();

    assert.ok(
      diagnostics.entries().some((entry) => entry.ruleId === 'cockpit-postmessage-handler-failed'),
      'webview command rejections must be captured by sanitized diagnostics',
    );
  });

  test('Rejected initial refresh is recorded instead of escaping as an uncaught error', async () => {
    const diagnostics = new DiagnosticsService();
    resolveProvider({
      diagnostics,
      requestRefresh: () => Promise.reject(new Error('refresh failed')),
    });

    await flushMicrotasks();

    assert.ok(
      diagnostics.entries().some((entry) => entry.ruleId === 'cockpit-initial-refresh-failed'),
      'fire-and-forget initial refresh rejections must be captured by sanitized diagnostics',
    );
  });

  test('Invalid inbound is dropped with diagnostics and no post or throw', () => {
    const diagnostics = new DiagnosticsService();
    const provider = new GaugeCockpitViewProvider(fakeContext(), {
      requestRefresh: (): void => {},
      diagnostics,
    });
    const view = makeFakeView();
    provider.resolveWebviewView(
      view as unknown as vscode.WebviewView,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken,
    );
    view.webview.posted.length = 0;

    assert.doesNotThrow(() => view.webview.fireMessage({ type: 'ready', prompt: 'leak' }));

    assert.equal(view.webview.posted.length, 0);
    assert.ok(
      diagnostics.entries().some((entry) => entry.ruleId === 'cockpit-postmessage-invalid'),
    );
  });

  // The provider exposes a rule-id-only diagnostics surface
  // for the Cockpit Diagnostics command — only booleans/timestamps, no raw data.
  test('DiagnosticsSnapshot reports resolved/visible booleans only, no raw data', () => {
    const { provider, view } = resolveProvider();
    const snap = provider.diagnosticsSnapshot();
    assert.equal(snap.resolved, true);
    assert.equal(snap.visible, true);
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes('/'), 'no path-like value');
    assert.ok(!serialized.includes('.claude'), 'no raw home-dir fragment');
    // Only the closed key set is present.
    const allowed = new Set(['resolved', 'visible', 'lastPostAtMs']);
    for (const key of Object.keys(snap)) {
      assert.ok(allowed.has(key), `unexpected diagnostics key: ${key}`);
    }
    view.fireVisibilityChange(false);
    assert.equal(provider.diagnosticsSnapshot().visible, false);
  });

  test('Re-posts latest VMs on visibility change to visible; never posts whilehidden', () => {
    const { provider, view } = resolveProvider();
    view.fireVisibilityChange(false);
    provider.setLatestViewModels([sampleCard()]);
    assert.equal(
      (view.webview.posted as Array<{ type?: string }>).filter((m) => m.type === 'gaugeCards')
        .length,
      0,
      'no post while hidden',
    );

    view.fireVisibilityChange(true);

    assert.ok(
      (view.webview.posted as Array<{ type?: string }>).some((m) => m.type === 'gaugeCards'),
      're-post on becoming visible',
    );
  });
});
