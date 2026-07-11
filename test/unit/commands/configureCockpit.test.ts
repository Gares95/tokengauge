// Configure Cockpit opens ONE intentional surface.
// For the v1 native-plan-limit product the
// first-run quick pick offers native cockpit setup only: each Claude/Codex
// option opens its SPECIFIC setting via an id-scoped Settings query.
//
// `tokenGauge.configureCockpit` is a READ-ONLY guidance entry point. It shows a
// SINGLE quick pick FIRST listing essential setup actions; only the chosen
// action then opens Settings (filtered) or routes to an existing command. It
// must NEVER open Settings AND a quick pick simultaneously, and it must never
// write or flip any tokenGauge.* setting value.
//
// COPY/PRIVACY CONSTRAINT (review): the guidance frames native-only/logs-off as
// the recommended default; no option reads as "enable the probe / log ingestion
// / broad log roots" — opt-ins are framed neutrally.
//

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_PROVIDER_SETTINGS_QUERY,
  CLAUDE_SNAPSHOT_SETTING_QUERY,
  COCKPIT_SETTINGS_QUERY,
  CODEX_PROBE_SETTING_QUERY,
  CODEX_PROVIDER_SETTINGS_QUERY,
  CONFIGURE_COCKPIT_COMMAND,
  CONFIGURE_COCKPIT_OPTIONS,
  type ConfigureCockpitDeps,
  remoteSettingsScopeMessage,
  runConfigureCockpit,
} from '../../../src/commands/configureCockpit';
import { findRepoRoot } from '../../_helpers/repoRoot';

interface ManifestCommand {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

function readManifest(): {
  commands: ManifestCommand[];
  viewTitleMenu: { command?: string; when?: string }[];
  configKeys: string[];
} {
  const manifestPath = join(findRepoRoot(), 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    contributes?: {
      commands?: ManifestCommand[];
      menus?: { 'view/title'?: { command?: string; when?: string }[] };
      configuration?:
        | { properties?: Record<string, unknown> }
        | { properties?: Record<string, unknown> }[];
    };
  };
  const config = manifest.contributes?.configuration;
  const configKeys: string[] = [];
  for (const block of Array.isArray(config) ? config : config ? [config] : []) {
    configKeys.push(...Object.keys(block.properties ?? {}));
  }
  return {
    commands: manifest.contributes?.commands ?? [],
    viewTitleMenu: manifest.contributes?.menus?.['view/title'] ?? [],
    configKeys,
  };
}

suite('Configure Cockpit command', () => {
  test('Is contributed with the exact label + category and reachable from the palette', () => {
    const { commands } = readManifest();
    const entry = commands.find((c) => c.command === CONFIGURE_COCKPIT_COMMAND);
    assert.ok(entry, 'configureCockpit must be contributed');
    assert.equal(entry.title, 'Configure Cockpit');
    assert.equal(entry.category, 'TokenGauge');
  });

  // The top-right view-title button is removed; the in-webview action links
  // own Configure. The command stays reachable via the Command Palette.
  test('Is NOT wired into the cockpit view title (webview action links own it)', () => {
    const { viewTitleMenu } = readManifest();
    const entry = viewTitleMenu.find((m) => m.command === CONFIGURE_COCKPIT_COMMAND);
    assert.equal(entry, undefined, 'configureCockpit must NOT appear in the view/title menu');
  });

  // Core fix: invoking opens a SINGLE surface — the quick pick —
  // and NOTHING else. Settings is NOT opened on entry. No double-surface.
  test('Opens exactly one surface (the quick pick) and never Settings on entry', async () => {
    const calls: { command: string; args: unknown[] }[] = [];
    let pickShown = 0;
    const deps: ConfigureCockpitDeps = {
      executeCommand: async (command, ...args) => {
        calls.push({ command, args });
        return undefined;
      },
      // User dismisses the pick — nothing else should happen.
      showActionPick: async () => {
        pickShown += 1;
        return undefined;
      },
    };

    const result = await runConfigureCockpit(deps);

    assert.equal(pickShown, 1, 'the quick pick must be the single entry surface');
    assert.equal(result.surfacesOpenedOnEntry, 1, 'exactly one surface on entry');
    assert.deepEqual(
      calls,
      [],
      'no command (including openSettings) runs until the user picks an action',
    );
    assert.equal(result.openedSettings, false, 'cancel must not open Settings');
    assert.equal(result.invokedCommand, undefined);
  });

  // The settings surface opens ONLY after the user explicitly picks a settings
  // option — and only then.
  test('Opens Settings (filtered) ONLY after the user selects a settings option', async () => {
    const calls: { command: string; args: unknown[] }[] = [];
    const settingsOption = CONFIGURE_COCKPIT_OPTIONS.find((o) => o.kind === 'settings');
    assert.ok(settingsOption, 'a settings option must exist');
    const deps: ConfigureCockpitDeps = {
      executeCommand: async (command, ...args) => {
        calls.push({ command, args });
        return undefined;
      },
      showActionPick: async () => settingsOption.label,
    };

    const result = await runConfigureCockpit(deps);

    assert.equal(result.openedSettings, true);
    assert.equal(calls.length, 1, 'exactly one command runs — opening Settings');
    assert.equal(calls[0].command, 'workbench.action.openSettings');
    assert.equal(calls[0].args[0], settingsOption.query);
  });

  // When a Workspace/Folder scope is the effective source of the
  // Codex probe value, the Codex option opens WORKSPACE settings and explains that
  // Workspace overrides User — instead of opening the (losing) User setting.
  test('Codex option opens Workspace settings + warns when Workspace scope is effective', async () => {
    const codexOption = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'settings' && o.query === CODEX_PROVIDER_SETTINGS_QUERY,
    );
    assert.ok(codexOption, 'a Codex settings option must exist');
    const calls: { command: string; args: unknown[] }[] = [];
    let infoMessage: string | undefined;
    const result = await runConfigureCockpit({
      executeCommand: async (command, ...args) => {
        calls.push({ command, args });
        return undefined;
      },
      showActionPick: async () => codexOption.label,
      codexProbeScope: () => 'workspace',
      showInfo: (m) => {
        infoMessage = m;
      },
    });
    assert.equal(result.openedSettings, true);
    assert.equal(result.openedWorkspaceSettings, true);
    assert.deepEqual(calls, [
      { command: 'workbench.action.openWorkspaceSettings', args: [CODEX_PROVIDER_SETTINGS_QUERY] },
    ]);
    assert.match(String(infoMessage), /Workspace settings/i);
    assert.match(String(infoMessage), /override/i);
  });

  test('Codex option opens normal (user) settings when no Workspace override is in effect', async () => {
    const codexOption = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'settings' && o.query === CODEX_PROVIDER_SETTINGS_QUERY,
    );
    assert.ok(codexOption, 'a Codex settings option must exist');
    const calls: { command: string; args: unknown[] }[] = [];
    const result = await runConfigureCockpit({
      executeCommand: async (command, ...args) => {
        calls.push({ command, args });
        return undefined;
      },
      showActionPick: async () => codexOption.label,
      codexProbeScope: () => 'user',
    });
    assert.equal(result.openedWorkspaceSettings, undefined);
    assert.deepEqual(calls, [
      { command: 'workbench.action.openSettings', args: [CODEX_PROVIDER_SETTINGS_QUERY] },
    ]);
  });

  test('Settings options warn about Remote scope when TokenGauge runs remotely', async () => {
    const claudeOption = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'settings' && o.query === CLAUDE_PROVIDER_SETTINGS_QUERY,
    );
    assert.ok(claudeOption && claudeOption.kind === 'settings');
    const calls: { command: string; args: unknown[] }[] = [];
    const infos: string[] = [];

    const result = await runConfigureCockpit({
      executeCommand: async (command, ...args) => {
        calls.push({ command, args });
        return undefined;
      },
      showActionPick: async () => claudeOption.label,
      remoteName: () => 'wsl',
      showInfo: (message) => {
        infos.push(message);
      },
    });

    assert.equal(result.remoteScopeNoticeShown, true);
    assert.deepEqual(calls, [
      { command: 'workbench.action.openSettings', args: [CLAUDE_PROVIDER_SETTINGS_QUERY] },
    ]);
    assert.equal(infos.length, 1);
    assert.equal(infos[0], remoteSettingsScopeMessage('wsl'));
    assert.match(infos[0] ?? '', /Remote or Workspace settings/);
    assert.match(infos[0] ?? '', /Local User settings may not affect/);
  });

  test('Routing options route only to existing tokenGauge commands — never a value write', async () => {
    for (const option of CONFIGURE_COCKPIT_OPTIONS.filter((o) => o.kind === 'command')) {
      assert.match(
        option.commandId as string,
        /^tokenGauge\./,
        'routed commands stay within the tokenGauge namespace',
      );
    }
  });

  test('Choosing a routing option executes that command id and nothing else', async () => {
    const commandOption = CONFIGURE_COCKPIT_OPTIONS.find((o) => o.kind === 'command');
    assert.ok(commandOption, 'a routing option must exist');
    const executed: string[] = [];
    const deps: ConfigureCockpitDeps = {
      executeCommand: async (command) => {
        executed.push(command);
        return undefined;
      },
      showActionPick: async () => commandOption.label,
    };

    const result = await runConfigureCockpit(deps);

    assert.equal(result.invokedCommand, commandOption.commandId);
    assert.deepEqual(executed, [commandOption.commandId]);
    assert.equal(result.openedSettings, false, 'a routing option must not also open Settings');
  });

  test('Run Diagnostics executes the Cockpit Diagnostics command and writes nothing', async () => {
    const diagnosticsOption = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'command' && o.commandId === 'tokenGauge.cockpitDiagnostics',
    );
    assert.ok(diagnosticsOption, 'Run Diagnostics option must exist');
    assert.equal(diagnosticsOption.label, 'Run Diagnostics');
    const calls: { command: string; args: unknown[] }[] = [];
    const result = await runConfigureCockpit({
      executeCommand: async (command, ...args) => {
        calls.push({ command, args });
        if (/updateConfiguration|configuration\.update/i.test(command)) {
          assert.fail('Run Diagnostics must never write a setting value');
        }
        return undefined;
      },
      showActionPick: async () => diagnosticsOption.label,
    });

    assert.equal(result.invokedCommand, 'tokenGauge.cockpitDiagnostics');
    assert.equal(result.openedSettings, false);
    assert.deepEqual(calls, [{ command: 'tokenGauge.cockpitDiagnostics', args: [] }]);
  });

  // CRITICAL read-only constraint (hard_constraints): invoking the command and
  // selecting ANY option (or cancelling) must NOT mutate any tokenGauge.* value.
  // The dependency surface has no settings-writer at all.
  test('Invocation mutates no tokenGauge.* setting value', async () => {
    const settingWrites: string[] = [];
    const deps: ConfigureCockpitDeps = {
      executeCommand: async (command, ...args) => {
        if (/updateConfiguration|configuration\.update/i.test(command)) {
          settingWrites.push(command);
        }
        if (command === 'workbench.action.openSettings') {
          assert.equal(typeof args[0], 'string', 'openSettings takes a filter string only');
        }
        return undefined;
      },
      showActionPick: async () => undefined,
    };

    await runConfigureCockpit(deps);

    assert.deepEqual(settingWrites, [], 'Configure Cockpit must never write a setting value');
    assert.ok(
      !('updateSetting' in deps) && !('updateConfiguration' in deps),
      'ConfigureCockpitDeps must expose no settings-writer',
    );
  });

  // Read-only invariant across EVERY option: pick each option in turn and
  // confirm no openSettings call ever carries a value, and no configuration write
  // command is ever issued.
  test('Selecting any single option never writes a tokenGauge.* value', async () => {
    for (const option of CONFIGURE_COCKPIT_OPTIONS) {
      const settingWrites: string[] = [];
      const deps: ConfigureCockpitDeps = {
        executeCommand: async (command, ...args) => {
          if (/updateConfiguration|configuration\.update/i.test(command)) {
            settingWrites.push(command);
          }
          if (command === 'workbench.action.openSettings') {
            // A filter STRING only — never an object/array that could set a value.
            assert.equal(
              typeof args[0],
              'string',
              `option "${option.label}" must open Settings with a filter string only`,
            );
            assert.equal(args.length, 1, 'openSettings is invoked with the query only');
          }
          return undefined;
        },
        showActionPick: async () => option.label,
      };

      await runConfigureCockpit(deps);

      assert.deepEqual(
        settingWrites,
        [],
        `option "${option.label}" must never write a setting value`,
      );
    }
  });

  // Privacy-posture copy: no option label/detail recommends flipping a
  // privacy-sensitive default. The Codex probe is framed as off-by-default opt-in.
  test('Option copy never recommends enabling a privacy-sensitive default', () => {
    for (const option of CONFIGURE_COCKPIT_OPTIONS) {
      const text = `${option.label} ${option.detail ?? ''}`;
      assert.doesNotMatch(
        text,
        /\benable (the )?(codex (native )?status )?probe\b/i,
        `option "${option.label}" must not read as a recommendation to enable the probe`,
      );
      assert.doesNotMatch(
        text,
        /\benable (log ingestion|broad log roots)\b/i,
        `option "${option.label}" must not read as a recommendation to enable logs/broad roots`,
      );
    }
    // The Codex option, if present, must frame the probe as off-by-default opt-in.
    const codexOption = CONFIGURE_COCKPIT_OPTIONS.find((o) => /codex/i.test(o.label));
    if (codexOption) {
      assert.match(
        `${codexOption.label} ${codexOption.detail ?? ''}`,
        /opt[- ]?in|off by default/i,
        'the Codex option must frame the probe as an off-by-default opt-in',
      );
    }
  });

  test('Quick pick keeps provider setup separate from card visibility', () => {
    assert.deepEqual(
      CONFIGURE_COCKPIT_OPTIONS.map((option) => option.label),
      [
        'Claude settings',
        'Codex settings',
        'Open all TokenGauge settings',
        'Run Diagnostics',
        'Learn what TokenGauge reads & stores',
      ],
    );
    assert.equal(
      CONFIGURE_COCKPIT_OPTIONS.find((o) => /automatic cockpit check interval/i.test(o.label)),
      undefined,
      'advanced interval tuning belongs under all settings, not the first-run picker',
    );
    for (const oldLabel of [
      'Set Claude statusLine snapshot path',
      'Codex native status probe (opt-in, off by default)',
      'Show or hide provider cards',
    ]) {
      assert.equal(
        CONFIGURE_COCKPIT_OPTIONS.find((o) => o.label === oldLabel),
        undefined,
        `${oldLabel} must be consolidated into provider settings entries`,
      );
    }
  });

  test('Provider option details explain setup and display-only visibility', () => {
    const claude = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'settings' && o.query === CLAUDE_PROVIDER_SETTINGS_QUERY,
    );
    assert.ok(claude && claude.kind === 'settings');
    assert.match(claude.detail, /snapshot path/i);
    assert.match(claude.detail, /card visibility/i);

    const codex = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'settings' && o.query === CODEX_PROVIDER_SETTINGS_QUERY,
    );
    assert.ok(codex && codex.kind === 'settings');
    assert.match(codex.detail, /off by default/i);
    assert.match(codex.detail, /opt-in/i);
    assert.match(codex.detail, /card visibility/i);
    assert.doesNotMatch(codex.detail, /API key|connect your account|sign in/i);
  });
});

// For the v1 native-plan-limit product the first-run flow
// no longer presents manual limits as a primary action, and W3 removes the
// remaining public manual settings from the manifest.
suite('Configure Cockpit — manual limits removed from first-run and manifest', () => {
  test('The quick pick no longer offers an Add Manual Limit option', () => {
    const manualOption = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) =>
        /manual\s+limit/i.test(o.label) ||
        (o.kind === 'command' && o.commandId === 'tokenGauge.addManualLimit'),
    );
    assert.equal(
      manualOption,
      undefined,
      'Add Manual Limit must not be a first-run Configure Cockpit option (v1 = native plan-limit gauges)',
    );
  });

  test('Manual-limit settings are not contributed', () => {
    const { configKeys } = readManifest();
    const manualSetting = configKeys.find((k) => /manualLimit|manual/i.test(k));
    assert.equal(manualSetting, undefined, 'manual-limit settings must not remain in the manifest');
  });
});

// Each Claude/Codex provider setup option opens its SPECIFIC
// setting via an id-scoped query; "open all settings" stays generic.
suite('Configure Cockpit — focused setting deep-links', () => {
  test('Id-scoped queries target the exact setting ids that exist in the manifest', () => {
    const { configKeys } = readManifest();
    const targets = [
      { query: CLAUDE_SNAPSHOT_SETTING_QUERY, id: 'tokenGauge.claude.statuslineSnapshotPath' },
      { query: CODEX_PROBE_SETTING_QUERY, id: 'tokenGauge.providers.codex.nativeStatusProbe' },
    ];
    for (const { query, id } of targets) {
      assert.equal(query, `@id:${id}`, `${id} must be opened by an id-scoped query`);
      assert.ok(configKeys.includes(id), `${id} must exist in the manifest`);
    }
    assert.equal(COCKPIT_SETTINGS_QUERY, 'tokenGauge', '"open all settings" stays generic');
  });

  test('Claude and Codex provider entries open provider-scoped settings filters', async () => {
    const setupRoutes = [
      {
        label: 'Claude settings',
        query: CLAUDE_PROVIDER_SETTINGS_QUERY,
        includedSettings: [
          'tokenGauge.claude.statuslineSnapshotPath',
          'tokenGauge.display.cards.claude.visible',
        ],
      },
      {
        label: 'Codex settings',
        query: CODEX_PROVIDER_SETTINGS_QUERY,
        includedSettings: [
          'tokenGauge.providers.codex.nativeStatusProbe',
          'tokenGauge.display.cards.codex.visible',
        ],
      },
    ] as const;

    const { configKeys } = readManifest();
    for (const route of setupRoutes) {
      const option = CONFIGURE_COCKPIT_OPTIONS.find(
        (o) => o.kind === 'settings' && o.label === route.label,
      );
      assert.ok(option && option.kind === 'settings');
      assert.equal(option.query, route.query);
      assert.match(option.query, /^@ext:tokengauge\.tokengauge-vscode (Claude|Codex)$/);
      for (const setting of route.includedSettings) {
        assert.ok(configKeys.includes(setting), `${setting} must exist in the manifest`);
      }

      const settingWrites: string[] = [];
      const calls: { command: string; args: unknown[] }[] = [];
      const result = await runConfigureCockpit({
        executeCommand: async (command, ...args) => {
          calls.push({ command, args });
          if (/updateConfiguration|configuration\.update/i.test(command)) {
            settingWrites.push(command);
          }
          return undefined;
        },
        showActionPick: async () => option.label,
        codexProbeScope: () => 'user',
      });

      assert.equal(result.openedSettings, true);
      assert.equal(result.openedSettingsQuery, route.query);
      assert.deepEqual(calls, [{ command: 'workbench.action.openSettings', args: [route.query] }]);
      assert.deepEqual(settingWrites, [], `${option.label} must not mutate provider settings`);
    }
  });

  test('Separate Claude/Codex card visibility options are not shown', () => {
    assert.equal(
      CONFIGURE_COCKPIT_OPTIONS.find((o) => /show or hide claude card/i.test(o.label)),
      undefined,
      'Claude card visibility must not have a separate Configure Cockpit item',
    );
    assert.equal(
      CONFIGURE_COCKPIT_OPTIONS.find((o) => /show or hide codex card/i.test(o.label)),
      undefined,
      'Codex card visibility must not have a separate Configure Cockpit item',
    );
  });

  test('Claude and Codex setup options each open a DISTINCT provider filter (not the generic one)', async () => {
    const expected: { match: RegExp; query: string }[] = [
      { match: /^Claude settings$/, query: CLAUDE_PROVIDER_SETTINGS_QUERY },
      { match: /^Codex settings$/, query: CODEX_PROVIDER_SETTINGS_QUERY },
    ];

    const seenQueries = new Set<string>();
    for (const { match, query } of expected) {
      const option = CONFIGURE_COCKPIT_OPTIONS.find(
        (o) => o.kind === 'settings' && match.test(o.label),
      );
      assert.ok(
        option && option.kind === 'settings',
        `a settings option matching ${match} must exist`,
      );
      assert.equal(
        option.query,
        query,
        `option "${option.label}" must use its specific id-scoped query`,
      );
      assert.notEqual(
        option.query,
        COCKPIT_SETTINGS_QUERY,
        `option "${option.label}" must NOT fall back to the generic tokenGauge query`,
      );
      assert.match(option.query, /^@ext:tokengauge\.tokengauge-vscode /);
      assert.ok(!seenQueries.has(option.query), `option "${option.label}" query must be distinct`);
      seenQueries.add(option.query);

      // The option, when selected, opens Settings with exactly its scoped query.
      const calls: { command: string; args: unknown[] }[] = [];
      const result = await runConfigureCockpit({
        executeCommand: async (command, ...args) => {
          calls.push({ command, args });
          return undefined;
        },
        showActionPick: async () => option.label,
      });
      assert.equal(result.openedSettings, true);
      assert.equal(result.openedSettingsQuery, query);
      assert.deepEqual(calls, [{ command: 'workbench.action.openSettings', args: [query] }]);
    }

    assert.equal(
      seenQueries.size,
      2,
      'the two provider setup options resolve to two distinct queries',
    );
  });

  test('The check-interval option is intentionally absent from the first-run picker', () => {
    const interval = CONFIGURE_COCKPIT_OPTIONS.find((o) =>
      /automatic cockpit check interval|poll interval|check interval/i.test(o.label),
    );
    assert.equal(interval, undefined);
  });

  test('An "open all settings" option keeps the generic tokenGauge query', () => {
    const openAll = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'settings' && o.query === COCKPIT_SETTINGS_QUERY,
    );
    assert.ok(openAll, 'an "open all TokenGauge settings" option must exist');
    assert.match(openAll.label, /all/i, 'the generic option must read as opening all settings');
  });

  test('All-settings, privacy, and diagnostics surfaces remain reachable', () => {
    const openAll = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'settings' && o.query === COCKPIT_SETTINGS_QUERY,
    );
    assert.ok(openAll, 'Configure Cockpit must keep an all-settings route');
    assert.match(openAll.detail, /Nothing is changed/i);

    const { commands } = readManifest();
    assert.ok(
      commands.find((c) => c.command === 'tokenGauge.openPrivacyReport'),
      'Privacy & Data Report must remain contributed',
    );
    assert.ok(
      commands.find((c) => c.command === 'tokenGauge.cockpitDiagnostics'),
      'Cockpit Diagnostics must remain contributed',
    );
    const diagnostics = CONFIGURE_COCKPIT_OPTIONS.find(
      (o) => o.kind === 'command' && o.commandId === 'tokenGauge.cockpitDiagnostics',
    );
    assert.ok(diagnostics, 'Configure Cockpit must expose Run Diagnostics directly');
    assert.equal(diagnostics.label, 'Run Diagnostics');
  });
});

// The Privacy & Data Report is useful but is NOT a
// cockpit SETUP step. In Configure Cockpit it is DEMOTED — re-labelled to read as
// a learn option ("Learn what TokenGauge reads & stores"), positioned AFTER the
// setup-focused options (provider settings, focused/all settings, diagnostics)
// so it never reads as a required setup step. The
// `tokenGauge.openPrivacyReport` command stays reachable standalone (not deleted).
suite('Configure Cockpit — Privacy report demoted to a learn option', () => {
  // The setup-focused options that must LEAD the pick.
  const SETUP_MATCHERS: readonly RegExp[] = [
    /claude/i, // Claude settings
    /codex/i, // Codex settings
    /all/i, // Open all TokenGauge settings (focused/all settings)
    /diagnostics/i, // Run Diagnostics
  ];

  function privacyReportIndex(): number {
    return CONFIGURE_COCKPIT_OPTIONS.findIndex(
      (o) => o.kind === 'command' && o.commandId === 'tokenGauge.openPrivacyReport',
    );
  }

  test('The privacy report, if present, routes to the standalone openPrivacyReport command', () => {
    const idx = privacyReportIndex();
    if (idx === -1) {
      // Removed-from-pick variant is acceptable per the plan — the command stays
      // reachable standalone (asserted in the manifest test). Nothing to demote.
      return;
    }
    const option = CONFIGURE_COCKPIT_OPTIONS[idx];
    assert.equal(option.kind, 'command');
    assert.equal(
      (option as { commandId: string }).commandId,
      'tokenGauge.openPrivacyReport',
      'the privacy report option must route to the standalone command',
    );
  });

  test('The privacy report reads as a learn option, not a required setup step', () => {
    const idx = privacyReportIndex();
    if (idx === -1) return; // removed-from-pick variant
    const option = CONFIGURE_COCKPIT_OPTIONS[idx];
    assert.match(
      option.label,
      /learn/i,
      'the demoted privacy report must read as a learn option (e.g. "Learn what TokenGauge reads & stores")',
    );
    assert.doesNotMatch(
      `${option.label} ${option.detail ?? ''}`,
      /\b(set up|setup step|required|configure (your )?cockpit|get started)\b/i,
      'the demoted privacy report must not read as a required setup step',
    );
  });

  test('Every setup-focused option leads the privacy report in the pick order', () => {
    const idx = privacyReportIndex();
    if (idx === -1) return; // removed-from-pick variant — setup options trivially lead
    for (const matcher of SETUP_MATCHERS) {
      const setupIdx = CONFIGURE_COCKPIT_OPTIONS.findIndex((o) => matcher.test(o.label));
      assert.ok(setupIdx !== -1, `a setup option matching ${matcher} must exist`);
      assert.ok(
        setupIdx < idx,
        `setup option matching ${matcher} (index ${setupIdx}) must lead the privacy report (index ${idx})`,
      );
    }
  });

  test('The demoted privacy report still invokes its standalone command and writes nothing', async () => {
    const idx = privacyReportIndex();
    if (idx === -1) return; // removed-from-pick variant
    const option = CONFIGURE_COCKPIT_OPTIONS[idx];
    const calls: { command: string; args: unknown[] }[] = [];
    const result = await runConfigureCockpit({
      executeCommand: async (command, ...args) => {
        calls.push({ command, args });
        if (/updateConfiguration|configuration\.update/i.test(command)) {
          assert.fail('the privacy report option must never write a setting value');
        }
        return undefined;
      },
      showActionPick: async () => option.label,
    });
    assert.equal(result.invokedCommand, 'tokenGauge.openPrivacyReport');
    assert.equal(result.openedSettings, false, 'a learn/routing option must not open Settings');
    assert.deepEqual(calls, [{ command: 'tokenGauge.openPrivacyReport', args: [] }]);
  });

  test('The openPrivacyReport command stays contributed (reachable standalone, not deleted)', () => {
    const { commands } = readManifest();
    const entry = commands.find((c) => c.command === 'tokenGauge.openPrivacyReport');
    assert.ok(
      entry,
      'tokenGauge.openPrivacyReport must stay contributed so the report is reachable standalone',
    );
  });
});
