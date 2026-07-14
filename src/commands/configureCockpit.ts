// The cockpit guidance
// entry point — a SINGLE intentional surface.
//
// `tokenGauge.configureCockpit` ("Configure Cockpit") is a READ-ONLY first-run
// helper. Invoking it opens exactly ONE surface: a QuickPick of the essential
// cockpit setup actions. Only the action the user picks then either opens VS
// Code Settings (scoped to a specific TokenGauge setting, or the whole
// namespace for "open all") or routes to an existing guidance/config command.
// It NEVER opens Settings AND a quick pick at the same time (the double-surface
// bug it closes).
//
// For the v1 native-plan-limit product the
// first-run flow offers native cockpit setup only. Each Claude/Codex provider
// option opens an extension-scoped provider filter so users see both that
// provider's setup and card-visibility settings; only "Open all TokenGauge
// settings" keeps the namespace-wide query.
//
// HARD CONSTRAINT (review): this command MUST NOT write or flip any tokenGauge.*
// setting value. Its dependency surface has NO settings-writer — the only side
// effects are showing the pick, opening Settings (a filter STRING), and routing
// to existing commands. The privacy posture is framed as the recommended
// default (native-only, logs off); no option nudges toward enabling a
// privacy-sensitive setting — the Codex probe is framed as an off-by-default
// opt-in.
//
// The pick and command execution are INJECTED seams so this module stays clean
// against tools/check-no-stray-ui-surfaces.mjs and unit-testable without
// booting VS Code.

import * as vscode from 'vscode';

export const CONFIGURE_COCKPIT_COMMAND = 'tokenGauge.configureCockpit' as const;

// The namespace-wide settings filter, used ONLY by "Open all TokenGauge
// settings". Provider options below use extension-scoped provider filters.
export const COCKPIT_SETTINGS_QUERY = 'tokenGauge' as const;
export const TOKEN_GAUGE_EXTENSION_SETTINGS_FILTER = '@ext:tokengauge.tokengauge-vscode' as const;

// Provider-level filters used by Configure Cockpit. These are read-only
// Settings search strings, not values. They show both provider setup and
// provider visibility settings under this extension.
export const CLAUDE_PROVIDER_SETTINGS_QUERY =
  `${TOKEN_GAUGE_EXTENSION_SETTINGS_FILTER} Claude` as const;
export const CODEX_PROVIDER_SETTINGS_QUERY =
  `${TOKEN_GAUGE_EXTENSION_SETTINGS_FILTER} Codex` as const;

// id-scoped Settings queries for card-specific CTAs. `@id:<settingId>` focuses
// Settings on that exact setting (read-only — it never sets a value).
export const CLAUDE_SNAPSHOT_SETTING_QUERY =
  '@id:tokenGauge.claude.statuslineSnapshotPath' as const;
export const CODEX_PROBE_SETTING_QUERY =
  '@id:tokenGauge.providers.codex.nativeStatusProbe' as const;
export const PROVIDER_CARD_VISIBILITY_SETTINGS_QUERY = 'tokenGauge.display.cards' as const;

// A quick-pick option either routes to an EXISTING command, or opens the
// (filtered, read-only) Settings surface scoped to a specific query. No option
// writes a value.
export type ConfigureCockpitOption =
  | {
      readonly kind: 'command';
      readonly label: string;
      readonly detail: string;
      readonly commandId: string;
    }
  | {
      readonly kind: 'settings';
      readonly label: string;
      readonly detail: string;
      // The Settings filter to open. Provider options use extension-scoped
      // filters; "open all" uses COCKPIT_SETTINGS_QUERY.
      readonly query: string;
    };

// The single-surface action list. Each option states what it does and its
// privacy posture; none auto-enables anything. Opt-ins are framed neutrally.
//
// No manual-limit entry here — v1 is native plan-limit gauges
// for Claude/Codex plan users.
export const CONFIGURE_COCKPIT_OPTIONS: readonly ConfigureCockpitOption[] = [
  {
    kind: 'settings',
    label: 'Claude settings',
    detail: 'Open Claude snapshot path and Claude card visibility settings.',
    query: CLAUDE_PROVIDER_SETTINGS_QUERY,
  },
  {
    kind: 'settings',
    label: 'Codex settings',
    detail: 'Open Codex probe opt-in (off by default) and Codex card visibility settings.',
    query: CODEX_PROVIDER_SETTINGS_QUERY,
  },
  {
    kind: 'settings',
    label: 'Open all TokenGauge settings',
    detail: 'Opens VS Code Settings filtered to TokenGauge. Nothing is changed for you.',
    query: COCKPIT_SETTINGS_QUERY,
  },
  {
    kind: 'command',
    label: 'Run Diagnostics',
    detail: 'Open the read-only Cockpit Diagnostics report to inspect native-status health.',
    commandId: 'tokenGauge.cockpitDiagnostics',
  },
  // The Privacy & Data Report is useful but is NOT a
  // cockpit setup step. It is DEMOTED to the end and re-labelled to read as a
  // learn option — never a required setup action. The setup-focused options
  // above LEAD. `tokenGauge.openPrivacyReport` stays reachable standalone.
  {
    kind: 'command',
    label: 'Learn what TokenGauge reads & stores',
    detail: 'Open the read-only Privacy & Data Report to see what TokenGauge reads and stores.',
    commandId: 'tokenGauge.openPrivacyReport',
  },
] as const;

export interface ConfigureCockpitResult {
  readonly commandId: typeof CONFIGURE_COCKPIT_COMMAND;
  // Exactly one surface is presented on entry: the quick pick. Always 1.
  readonly surfacesOpenedOnEntry: 1;
  // True only when the user picked an option that opens the Settings surface.
  readonly openedSettings: boolean;
  // The Settings filter opened (id-scoped `@id:` query for focused options, or
  // the generic namespace query for "open all").
  readonly openedSettingsQuery?: string;
  // The existing command id invoked, when the user picked a routing option.
  readonly invokedCommand?: string;
  // True when the Codex option opened WORKSPACE settings because a
  // Workspace/Folder scope is the effective source of the probe value.
  readonly openedWorkspaceSettings?: boolean;
  // True when TokenGauge is running in a remote extension host and the command
  // showed scope guidance before opening Settings.
  readonly remoteScopeNoticeShown?: boolean;
}

export interface ConfigureCockpitDeps {
  readonly executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
  // Shows the single quick pick of setup actions. Returns the chosen label, or
  // undefined when dismissed (silent cancel — changes nothing).
  readonly showActionPick: (
    options: readonly ConfigureCockpitOption[],
  ) => Promise<string | undefined>;
  // The SCOPE that supplies the effective Codex probe value, so the
  // Codex option can route to the scope that actually controls it (a Workspace value
  // overrides User). Scope label only — never a raw path/account. Optional: when
  // absent, the Codex option opens the setting as a User-scope focus (prior behavior).
  readonly codexProbeScope?: () => CodexProbeScope;
  // Shows a short, non-modal info message (the Workspace-override guidance). Optional.
  readonly showInfo?: (message: string) => void;
  // VS Code remote extension-host label, for example "wsl" or "ssh-remote".
  // Label only; never a path/account. Optional: absent means local window.
  readonly remoteName?: () => string | undefined;
}

export type CodexProbeScope = 'default' | 'user' | 'workspace' | 'workspaceFolder';

export interface OpenCodexProbeSettingDeps {
  readonly executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
  readonly codexProbeScope?: () => CodexProbeScope;
  readonly showInfo?: (message: string) => void;
  readonly remoteName?: () => string | undefined;
}

// Shared route (also used by the cockpit one-click CTA): open
// the Codex probe setting in the scope that actually CONTROLS its effective
// value. When a Workspace/Folder value overrides User, opening User settings
// would be misleading — the user would flip a value that doesn't win — so open
// WORKSPACE settings and say why. Read-only either way: only a filtered Settings
// surface opens; no value is ever written.
export async function openCodexProbeSetting(
  deps: OpenCodexProbeSettingDeps,
): Promise<{ openedWorkspaceSettings: boolean; remoteScopeNoticeShown?: boolean }> {
  return openCodexSettings(deps, CODEX_PROBE_SETTING_QUERY);
}

async function openCodexSettings(
  deps: OpenCodexProbeSettingDeps,
  query: string,
): Promise<{ openedWorkspaceSettings: boolean; remoteScopeNoticeShown?: boolean }> {
  const remoteScopeNoticeShown = maybeShowRemoteSettingsScopeNotice(deps);
  const scope = deps.codexProbeScope?.();
  if (scope === 'workspace' || scope === 'workspaceFolder') {
    deps.showInfo?.(
      'Codex native probe is enabled in Workspace settings — change the Workspace value to turn it off (Workspace settings override your User setting).',
    );
    await deps.executeCommand('workbench.action.openWorkspaceSettings', query);
    return {
      openedWorkspaceSettings: true,
      ...(remoteScopeNoticeShown ? { remoteScopeNoticeShown: true } : {}),
    };
  }
  await deps.executeCommand('workbench.action.openSettings', query);
  return {
    openedWorkspaceSettings: false,
    ...(remoteScopeNoticeShown ? { remoteScopeNoticeShown: true } : {}),
  };
}

export function remoteSettingsScopeMessage(remoteName: string): string {
  return (
    `TokenGauge is running in Remote: ${remoteName}. ` +
    'Set this value in Remote or Workspace settings for this window. ' +
    'Local User settings may not affect this window. In Settings, use the Remote tab or Workspace scope when available.'
  );
}

function maybeShowRemoteSettingsScopeNotice(deps: {
  readonly remoteName?: () => string | undefined;
  readonly showInfo?: (message: string) => void;
}): boolean {
  const raw = deps.remoteName?.();
  const remoteName = typeof raw === 'string' ? raw.trim() : '';
  if (remoteName.length === 0) {
    return false;
  }
  if (deps.showInfo === undefined) {
    return false;
  }
  deps.showInfo(remoteSettingsScopeMessage(remoteName));
  return true;
}

async function openSettingsWithRemoteScopeNotice(
  deps: ConfigureCockpitDeps,
  query: string,
): Promise<{ remoteScopeNoticeShown?: boolean }> {
  const remoteScopeNoticeShown = maybeShowRemoteSettingsScopeNotice(deps);
  await deps.executeCommand('workbench.action.openSettings', query);
  return remoteScopeNoticeShown ? { remoteScopeNoticeShown: true } : {};
}

export function registerConfigureCockpitCommand(
  context: vscode.ExtensionContext,
  deps: ConfigureCockpitDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CONFIGURE_COCKPIT_COMMAND, () => runConfigureCockpit(deps)),
  );
}

export async function runConfigureCockpit(
  deps: ConfigureCockpitDeps,
): Promise<ConfigureCockpitResult> {
  // ONE surface on entry: the quick pick. Nothing else runs until the user
  // picks — no Settings, no second overlay (closes the double-surface bug).
  const chosenLabel = await deps.showActionPick(CONFIGURE_COCKPIT_OPTIONS);

  if (chosenLabel === undefined) {
    // Silent cancel: no side effects, no setting touched.
    return {
      commandId: CONFIGURE_COCKPIT_COMMAND,
      surfacesOpenedOnEntry: 1,
      openedSettings: false,
    };
  }

  const chosen = CONFIGURE_COCKPIT_OPTIONS.find((o) => o.label === chosenLabel);
  if (chosen === undefined) {
    return {
      commandId: CONFIGURE_COCKPIT_COMMAND,
      surfacesOpenedOnEntry: 1,
      openedSettings: false,
    };
  }

  if (chosen.kind === 'settings') {
    // The Codex probe option routes through the shared
    // scope-aware opener (Workspace overrides User — open the scope that wins).
    if (chosen.query === CODEX_PROVIDER_SETTINGS_QUERY) {
      const { openedWorkspaceSettings, remoteScopeNoticeShown } = await openCodexSettings(
        deps,
        CODEX_PROVIDER_SETTINGS_QUERY,
      );
      return {
        commandId: CONFIGURE_COCKPIT_COMMAND,
        surfacesOpenedOnEntry: 1,
        openedSettings: true,
        openedSettingsQuery: chosen.query,
        ...(openedWorkspaceSettings ? { openedWorkspaceSettings: true } : {}),
        ...(remoteScopeNoticeShown ? { remoteScopeNoticeShown: true } : {}),
      };
    }
    // Read-only: open native Settings scoped to the option's query. The query
    // is a filter STRING only — `@id:<setting>` focuses one setting; it never
    // sets a value.
    const { remoteScopeNoticeShown } = await openSettingsWithRemoteScopeNotice(deps, chosen.query);
    return {
      commandId: CONFIGURE_COCKPIT_COMMAND,
      surfacesOpenedOnEntry: 1,
      openedSettings: true,
      openedSettingsQuery: chosen.query,
      ...(remoteScopeNoticeShown ? { remoteScopeNoticeShown: true } : {}),
    };
  }

  // Routing option: invoke the chosen existing command and nothing else.
  await deps.executeCommand(chosen.commandId);
  return {
    commandId: CONFIGURE_COCKPIT_COMMAND,
    surfacesOpenedOnEntry: 1,
    openedSettings: false,
    invokedCommand: chosen.commandId,
  };
}
