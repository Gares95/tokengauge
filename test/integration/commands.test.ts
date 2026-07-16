// Configure Cockpit command — Extension Host integration.
//
// Asserts the command is REGISTERED in a real Extension Host, contributed in the
// manifest (palette + cockpit view title), opens exactly ONE surface (the quick
// pick — never Settings + a palette at once), opens Settings ONLY after the
// settings option is selected, and — critically — mutates NO tokenGauge.*
// setting value (strictly read-only guidance).

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  CONFIGURE_COCKPIT_OPTIONS,
  runConfigureCockpit,
} from '../../src/commands/configureCockpit';
import type { TokenGaugeTestApi } from '../../src/extension';

const EXTENSION_ID = 'gares-extensions.tokengauge-vscode';
const CONFIGURE_COCKPIT_COMMAND = 'tokenGauge.configureCockpit';

// The privacy-sensitive defaults that must remain untouched after invocation.
const PRIVACY_SETTINGS: readonly { key: string; expected: unknown }[] = [
  { key: 'providers.codex.nativeStatusProbe', expected: false },
];

async function activate(): Promise<{ packageJSON: unknown }> {
  const extension = vscode.extensions.getExtension<TokenGaugeTestApi>(EXTENSION_ID);
  assert.ok(extension, `extension not loaded: ${EXTENSION_ID}`);
  const api = await extension.activate();
  await api.saltReady;
  return { packageJSON: extension.packageJSON };
}

interface ManifestCommand {
  command?: string;
  title?: string;
  category?: string;
}

suite('Configure Cockpit command', () => {
  test('Command is registered in the Extension Host', async () => {
    await activate();
    const registered = await vscode.commands.getCommands(true);
    assert.ok(
      registered.includes(CONFIGURE_COCKPIT_COMMAND),
      `command not registered: ${CONFIGURE_COCKPIT_COMMAND}`,
    );
  });

  test('Manifest contributes Configure Cockpit with the palette title + category', async () => {
    const { packageJSON } = await activate();
    const commands =
      (packageJSON as { contributes?: { commands?: ManifestCommand[] } }).contributes?.commands ??
      [];
    const entry = commands.find((c) => c.command === CONFIGURE_COCKPIT_COMMAND);
    assert.ok(entry, 'Configure Cockpit must be contributed');
    assert.equal(entry.title, 'Configure Cockpit');
    assert.equal(entry.category, 'TokenGauge');
  });

  // The top-right view-title Configure button is removed (webview action links
  // own it); the command stays in the Command Palette.
  test('Manifest does NOT wire Configure Cockpit into the cockpit view title', async () => {
    const { packageJSON } = await activate();
    const viewTitle =
      (
        packageJSON as {
          contributes?: { menus?: { 'view/title'?: { command?: string; when?: string }[] } };
        }
      ).contributes?.menus?.['view/title'] ?? [];
    const entry = viewTitle.find((m) => m.command === CONFIGURE_COCKPIT_COMMAND);
    assert.equal(entry, undefined, 'Configure Cockpit must NOT appear in the view title menu');
  });

  // Invoking opens exactly ONE surface — the quick pick — and
  // runs NO command (no openSettings, no routing) until the user picks. We
  // dismiss the pick and assert no command ran.
  test('Invoking opens a single surface (quick pick) and never Settings on entry', async () => {
    await activate();
    const ran: string[] = [];
    let picksShown = 0;

    const result = await runConfigureCockpit({
      executeCommand: async (command, ...args) => {
        ran.push(command);
        return vscode.commands.executeCommand(command, ...args);
      },
      showActionPick: async () => {
        picksShown += 1;
        return undefined;
      },
    });

    assert.equal(picksShown, 1, 'the quick pick is the single entry surface');
    assert.equal(result.surfacesOpenedOnEntry, 1);
    assert.deepEqual(ran, [], 'no command runs (incl. openSettings) until the user picks');
    assert.equal(result.openedSettings, false);
  });

  // Settings opens for real ONLY after the user selects the settings option —
  // routed through the REAL vscode.commands.executeCommand.
  test('Selecting the settings option opens Settings only after selection', async () => {
    await activate();
    const settingsOption = CONFIGURE_COCKPIT_OPTIONS.find((o) => o.kind === 'settings');
    assert.ok(settingsOption, 'a settings option must exist');
    const ran: string[] = [];

    const result = await runConfigureCockpit({
      executeCommand: async (command, ...args) => {
        ran.push(command);
        return vscode.commands.executeCommand(command, ...args);
      },
      showActionPick: async () => settingsOption.label,
    });

    assert.equal(result.openedSettings, true);
    assert.deepEqual(
      ran,
      ['workbench.action.openSettings'],
      'exactly one surface opens — Settings',
    );
  });

  // CRITICAL read-only constraint: invoking the command and dismissing — or
  // selecting the settings option (which runs the REAL openSettings deep-link) —
  // must not flip any privacy-sensitive default.
  test('Invoking the command does not mutate any tokenGauge.* privacy setting', async () => {
    await activate();
    const settingsOption = CONFIGURE_COCKPIT_OPTIONS.find((o) => o.kind === 'settings');
    assert.ok(settingsOption, 'a settings option must exist');
    const config = vscode.workspace.getConfiguration('tokenGauge');
    const before = PRIVACY_SETTINGS.map(({ key }) => config.get(key));

    await runConfigureCockpit({
      executeCommand: (command, ...args) =>
        Promise.resolve(vscode.commands.executeCommand(command, ...args)),
      // Pick the settings option so the real openSettings deep-link runs.
      showActionPick: async () => settingsOption.label,
    });

    const after = vscode.workspace.getConfiguration('tokenGauge');
    PRIVACY_SETTINGS.forEach(({ key, expected }, i) => {
      const value = after.get(key);
      assert.deepEqual(value, before[i], `Configure Cockpit changed ${key}`);
      assert.deepEqual(value, expected, `${key} drifted from its private default`);
    });
  });
});
