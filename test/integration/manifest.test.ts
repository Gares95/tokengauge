// Command & settings audit / legacy usage de-emphasis — manifest
// assertions against the live Extension Host packageJSON.
//
// INVARIANT GUARD: this test pins command ids, the dev-command hidden posture,
// every settings key + its default, the privacy-default self-documenting copy,
// and the legacy usage view posture (kept / collapsed / log-derived /
// isolated from the native cockpit). Nothing here may be relaxed to make a
// rename pass — a rename must update this file in lockstep.
//

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'gares-extensions.tokengauge-vscode';

interface ManifestCommand {
  command?: string;
  title?: string;
  category?: string;
}
interface ManifestMenuItem {
  command?: string;
  when?: string;
  group?: string;
}
interface ManifestView {
  id?: string;
  type?: string;
  name?: string;
  visibility?: string;
}
interface ConfigProperty {
  type?: string;
  default?: unknown;
  title?: string;
  markdownDescription?: string;
  description?: string;
  order?: number;
  minimum?: number;
  maximum?: number;
}
interface ManifestConfigurationBlock {
  title?: string;
  order?: number;
  properties?: Record<string, ConfigProperty>;
}
interface Manifest {
  contributes?: {
    commands?: ManifestCommand[];
    menus?: { 'view/title'?: ManifestMenuItem[]; commandPalette?: ManifestMenuItem[] };
    views?: { tokenGauge?: ManifestView[] };
    configuration?: ManifestConfigurationBlock | ManifestConfigurationBlock[];
  };
}

// The exact contributed command ids (INVARIANT — none may be removed/renamed
// without a recorded decision + lockstep update here).
const PRIMARY_COMMANDS = [
  'tokenGauge.openCockpit',
  'tokenGauge.refreshNativeStatus',
  'tokenGauge.configureCockpit',
  'tokenGauge.cockpitDiagnostics',
] as const;
const CONFIG_COMMANDS = ['tokenGauge.openPrivacyReport'] as const;

const ALL_CONTRIBUTED_COMMANDS = [...PRIMARY_COMMANDS, ...CONFIG_COMMANDS] as const;

// The full settings surface with their unchanged defaults. R3-copy removed two
// INERT settings — tokenGauge.privacyMode (display-only no-op; nothing branched on
// it after the usage-store removal) and tokenGauge.display.showAccuracyLabels
// (zero consumers; accuracy labels always render) — leaving the v1 4-key surface.
// No remaining default changed.
const SETTINGS_DEFAULTS: readonly { key: string; default: unknown }[] = [
  // Default 15: the manifest default/range mirror the loop's real file-poll
  // clamp (10-15s) so the setting is honest about its effective behavior.
  { key: 'tokenGauge.pollIntervalSeconds', default: 15 },
  // Default false (simpler default card).
  { key: 'tokenGauge.display.showTechnicalDetails', default: false },
  { key: 'tokenGauge.display.cards.claude.visible', default: true },
  { key: 'tokenGauge.display.cards.codex.visible', default: true },
  { key: 'tokenGauge.providers.codex.nativeStatusProbe', default: false },
  { key: 'tokenGauge.claude.statuslineSnapshotPath', default: '' },
];

// The privacy-relevant default whose description must document the private
// default AND the implication of changing it (non-recommending).
const PRIVACY_DEFAULT_KEYS = ['tokenGauge.providers.codex.nativeStatusProbe'] as const;

async function loadManifest(): Promise<Manifest> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension not loaded: ${EXTENSION_ID}`);
  await extension.activate();
  return extension.packageJSON as Manifest;
}

function manifestConfigurationBlocks(manifest: Manifest): ManifestConfigurationBlock[] {
  const configuration = manifest.contributes?.configuration;
  if (Array.isArray(configuration)) return configuration;
  return configuration ? [configuration] : [];
}

function manifestConfigurationProperties(manifest: Manifest): Record<string, ConfigProperty> {
  return Object.assign(
    {},
    ...manifestConfigurationBlocks(manifest).map((block) => block.properties ?? {}),
  );
}

suite('Manifest — commands', () => {
  test('Every contributed command id is present and titled in the category', async () => {
    const manifest = await loadManifest();
    const commands = manifest.contributes?.commands ?? [];
    const byId = new Map(commands.map((c) => [c.command, c]));
    for (const id of ALL_CONTRIBUTED_COMMANDS) {
      const entry = byId.get(id);
      assert.ok(entry, `command id missing from manifest: ${id}`);
      assert.equal(entry.category, 'TokenGauge', `command not in TokenGauge category: ${id}`);
      assert.ok(
        typeof entry.title === 'string' && entry.title.length > 0,
        `command has no title: ${id}`,
      );
    }
  });

  test('No contributed command id was removed (exact id set)', async () => {
    const manifest = await loadManifest();
    const ids = (manifest.contributes?.commands ?? []).map((c) => c.command).sort();
    const expected = [...ALL_CONTRIBUTED_COMMANDS].sort();
    assert.deepEqual(ids, expected);
  });

  test('Every primary command is registered in the live Extension Host', async () => {
    await loadManifest();
    const registered = await vscode.commands.getCommands(true);
    for (const id of PRIMARY_COMMANDS) {
      assert.ok(registered.includes(id), `primary command not registered: ${id}`);
    }
  });

  test('No commands are gated out of the palette (no when:false residue)', async () => {
    // R3-copy: the two hidden/dev commands (configureProviders, runCockpitReport)
    // were removed, so v1 contributes no when:false palette gates at all.
    const manifest = await loadManifest();
    const palette = manifest.contributes?.menus?.commandPalette ?? [];
    const hidden = palette.filter((m) => m.when === 'false');
    assert.equal(hidden.length, 0, 'v1 contributes no hidden/dev commands — no when:false gates');
  });

  // The top-right view-title Configure button is removed (the in-webview
  // ActionLinks row is the single action surface); Configure Cockpit stays in the
  // Command Palette. The view/title menu must carry NO cockpit entry.
  test('No cockpit command is wired into the view title (webview action links own it)', async () => {
    const manifest = await loadManifest();
    const viewTitle = manifest.contributes?.menus?.['view/title'] ?? [];
    const entry = viewTitle.find((m) => m.command === 'tokenGauge.configureCockpit');
    assert.equal(entry, undefined, 'Configure Cockpit must NOT appear in the view title menu');
  });
});

suite('Manifest — settings', () => {
  test('Every settings key is present with its unchanged default', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    assert.equal(
      Object.keys(props).length,
      SETTINGS_DEFAULTS.length,
      'settings key count changed — no key may be added or removed silently',
    );
    for (const { key, default: def } of SETTINGS_DEFAULTS) {
      const prop = props[key];
      assert.ok(prop, `settings key missing: ${key}`);
      assert.deepEqual(prop.default, def, `default changed for ${key}`);
    }
  });

  test('Every settings key carries a non-empty description', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    for (const { key } of SETTINGS_DEFAULTS) {
      const prop = props[key];
      const text = prop?.markdownDescription ?? prop?.description ?? '';
      assert.ok(text.trim().length > 0, `settings key has no description: ${key}`);
    }
  });

  // The new showTechnicalDetails key exists with the
  // simpler-default posture (boolean, default false) and a Display-band description.
  test('Display.showTechnicalDetails exists as boolean default false', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    const prop = props['tokenGauge.display.showTechnicalDetails'];
    assert.ok(prop, 'manifest missing tokenGauge.display.showTechnicalDetails');
    assert.equal(prop.type, 'boolean', 'showTechnicalDetails must be boolean');
    assert.equal(prop.default, false, 'showTechnicalDetails must default false (simpler card)');
    const text = String(prop.markdownDescription ?? prop.description ?? '');
    assert.match(text, /^Display:/, 'showTechnicalDetails must sit in the Display band');
  });

  test('Privacy-default keys document the private default + implication, non-recommending', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    for (const key of PRIVACY_DEFAULT_KEYS) {
      const text = String(props[key]?.markdownDescription ?? props[key]?.description ?? '');
      assert.ok(text.length > 0, `privacy-default key has no description: ${key}`);
      // States the default is the private/off posture.
      assert.match(
        text,
        /default|private|off|nativeOnly/i,
        `privacy-default description must state the private default: ${key}`,
      );
      // States the implication of CHANGING it (turning it on / opting in / enabling).
      assert.match(
        text,
        /when on|opt[- ]?in|enabl|turn(ing)? (it )?on|changing/i,
        `privacy-default description must state the implication of changing it: ${key}`,
      );
      // Non-recommending: must NOT urge the user to enable it.
      assert.doesNotMatch(
        text,
        /\brecommend(ed)? (to )?(turn|switch|set)?\s*(it )?(on|enabl)/i,
        `privacy-default description must not recommend enabling: ${key}`,
      );
    }
  });
});

// The cockpit AUTOMATIC refresh cadence setting.
// pollIntervalSeconds must read clearly as "how often the cockpit auto-refreshes /
// re-checks native status", advertise ONLY the honest 10-15s range the loop
// actually honors (FILE_POLL_MIN/MAX_SECONDS clamp), and clarify it does NOT
// force native probes faster than the provider-safe floor (poll ≠ probe cadence).
suite('Manifest — cockpit auto-refresh interval', () => {
  test('PollIntervalSeconds default matches the honest file-poll clamp (15)', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    assert.equal(props['tokenGauge.pollIntervalSeconds']?.default, 15);
  });

  test('PollIntervalSeconds bounds mirror the loop clamp (10-15s, no decorative range)', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    const prop = props['tokenGauge.pollIntervalSeconds'];
    const min = Number(prop?.minimum);
    const max = Number(prop?.maximum);
    // The loop clamps file polling to 10-15s; the manifest must never advertise
    // values the loop silently ignores (the old 10-3600 range was misleading).
    assert.equal(min, 10, 'minimum must stay at 10 (within the loop clamp)');
    assert.equal(max, 15, 'maximum must equal the loop FILE_POLL_MAX_SECONDS clamp');
    const def = Number(prop?.default);
    assert.ok(def >= min && def <= max, `default ${def} must be within [${min}, ${max}]`);
  });

  test('PollIntervalSeconds description names the cockpit AUTOMATIC refresh cadence', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    const prop = props['tokenGauge.pollIntervalSeconds'];
    const text = String(prop?.markdownDescription ?? prop?.description ?? '');
    assert.match(text, /automatic|auto[- ]?refresh/i, 'must read as the automatic refresh cadence');
    assert.match(text, /cockpit/i, 'must tie to the cockpit');
  });

  test('PollIntervalSeconds description clarifies it does NOT force faster native probes', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    const prop = props['tokenGauge.pollIntervalSeconds'];
    const text = String(prop?.markdownDescription ?? prop?.description ?? '');
    assert.match(
      text,
      /probe|rate[- ]?limit|cache|privacy|performance|floor|does not force/i,
      'must clarify the poll cadence does not force faster provider/native probes',
    );
  });

  // The interval setting reads in plain user semantics as
  // an automatic CHECK interval ("check native status every N seconds"), so the user
  // can reason about the cockpit's cadence without conflating it with provider probes.
  test('PollIntervalSeconds description reads as an automatic CHECK interval (check every N seconds)', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    const prop = props['tokenGauge.pollIntervalSeconds'];
    const text = String(prop?.markdownDescription ?? prop?.description ?? '');
    assert.match(text, /check/i, 'must describe a check cadence in plain user terms');
    assert.match(
      text,
      /every\s+\w+\s+seconds|each interval|every N seconds/i,
      'must state the per-interval cadence in user-facing language',
    );
    assert.match(text, /native status/i, 'must say what is being checked (native status)');
  });
});

// Searching `tokenGauge` in Settings must no longer
// present log-derived/manual options as the main product. Setting DESCRIPTIONS
// (markdownDescription) and `order` only — no key deleted, no default changed.
// Native cockpit settings group first and read "Cockpit (native)"; the legacy
// log-ingestion providers read "Advanced / optional log-derived compatibility"
// with the confusing "usage ingestion" wording removed. The three
// privacy-default keys stay non-recommending.
//
suite('Manifest — settings native-vs-historical relabel', () => {
  // Native cockpit band — these read "Cockpit (native)" and sort first.
  const NATIVE_COCKPIT_KEYS = [
    'tokenGauge.claude.statuslineSnapshotPath',
    'tokenGauge.providers.codex.nativeStatusProbe',
    'tokenGauge.pollIntervalSeconds',
  ] as const;
  function descOf(props: Record<string, ConfigProperty>, key: string): string {
    return String(props[key]?.markdownDescription ?? props[key]?.description ?? '');
  }

  test('Native cockpit settings carry a "Cockpit (native)" group classification', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    for (const key of NATIVE_COCKPIT_KEYS) {
      assert.match(
        descOf(props, key),
        /cockpit \(native\)/i,
        `native cockpit key must read "Cockpit (native)": ${key}`,
      );
    }
  });

  test('Manual/budget + log-ingestion settings are not contributed', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    assert.equal(props['tokenGauge.providers.manual.enabled'], undefined);
    assert.equal(props['tokenGauge.manualLimits'], undefined);
    // Native-only — no log-ingestion mode/consent/path settings.
    assert.equal(props['tokenGauge.logIngestionMode'], undefined);
    assert.equal(props['tokenGauge.allowBroadLogRoots'], undefined);
    assert.equal(props['tokenGauge.providers.claudeCode.logPath'], undefined);
    assert.equal(props['tokenGauge.providers.codex.logPath'], undefined);
    // R3-copy: inert display-only/no-op settings removed pre-release.
    assert.equal(props['tokenGauge.privacyMode'], undefined);
    assert.equal(props['tokenGauge.display.showAccuracyLabels'], undefined);
  });

  test('No key deleted and no default changed by the relabel (count + defaults pinned)', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    assert.equal(
      Object.keys(props).length,
      SETTINGS_DEFAULTS.length,
      'manifest key count must match the W3 public settings surface',
    );
    for (const { key, default: def } of SETTINGS_DEFAULTS) {
      assert.deepEqual(props[key]?.default, def, `default changed for ${key}`);
    }
  });
});

// Confirm the native/provider setup grouping holds
// with display-card settings present. Provider setup sections lead display; display
// leads the advanced polling section. No key deleted, no default changed.
//
suite('Manifest — native-first grouping holds with round-5 keys', () => {
  const PROVIDER_SETUP_KEYS = [
    'tokenGauge.claude.statuslineSnapshotPath',
    'tokenGauge.providers.codex.nativeStatusProbe',
  ] as const;
  const SHOW_TECHNICAL_DETAILS = 'tokenGauge.display.showTechnicalDetails';

  function descOf(props: Record<string, ConfigProperty>, key: string): string {
    return String(props[key]?.markdownDescription ?? props[key]?.description ?? '');
  }

  test('Display.showTechnicalDetails is in the Display group and defaults false', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    const prop = props[SHOW_TECHNICAL_DETAILS];
    assert.ok(prop, `manifest missing ${SHOW_TECHNICAL_DETAILS}`);
    assert.equal(prop.type, 'boolean');
    assert.equal(prop.default, false, 'showTechnicalDetails default must stay false');
    assert.match(
      descOf(props, SHOW_TECHNICAL_DETAILS),
      /^Display:/,
      'showTechnicalDetails must read in the Display group',
    );
  });

  test('Provider setup sections lead display, and display leads advanced polling', async () => {
    const manifest = await loadManifest();
    const blocks = manifestConfigurationBlocks(manifest);
    const byTitle = new Map(blocks.map((block) => [block.title, block]));
    const claudeOrder = byTitle.get('TokenGauge › Claude')?.order ?? Number.MAX_SAFE_INTEGER;
    const codexOrder = byTitle.get('TokenGauge › Codex')?.order ?? Number.MAX_SAFE_INTEGER;
    const displayOrder = byTitle.get('TokenGauge › Display')?.order ?? Number.MAX_SAFE_INTEGER;
    const pollingOrder =
      byTitle.get('TokenGauge › Advanced / Polling')?.order ?? Number.MAX_SAFE_INTEGER;

    assert.ok(claudeOrder < displayOrder, 'Claude settings section must lead Display');
    assert.ok(codexOrder < displayOrder, 'Codex settings section must lead Display');
    assert.ok(displayOrder < pollingOrder, 'Display settings section must lead Advanced / Polling');
  });

  test('Native cockpit settings (Claude snapshot, Codex probe) still lead showTechnicalDetails', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    const order = props[SHOW_TECHNICAL_DETAILS]?.order ?? 0;
    for (const key of PROVIDER_SETUP_KEYS) {
      const providerOrder = props[key]?.order ?? Number.MAX_SAFE_INTEGER;
      assert.ok(providerOrder < order, `${key} must lead ${SHOW_TECHNICAL_DETAILS}`);
    }
  });

  test('Settings keys are present and no key deleted / no default changed', async () => {
    const manifest = await loadManifest();
    const props = manifestConfigurationProperties(manifest);
    assert.equal(
      Object.keys(props).length,
      SETTINGS_DEFAULTS.length,
      'no key may be added/removed',
    );
    assert.ok(props[SHOW_TECHNICAL_DETAILS], 'showTechnicalDetails must be present');
    for (const { key, default: def } of SETTINGS_DEFAULTS) {
      assert.deepEqual(props[key]?.default, def, `default changed for ${key}`);
    }
  });
});

suite('Manifest — native cockpit view', () => {
  test('The native cockpit view is the only contributed view and is primary', async () => {
    const manifest = await loadManifest();
    const views = manifest.contributes?.views?.tokenGauge ?? [];
    const cockpit = views.find((v) => v.id === 'tokenGauge.views.cockpit');
    assert.ok(cockpit, 'cockpit view must be present');
    assert.equal(cockpit.type, 'webview');
    // The view name is the brand so the header reads "TOKENGAUGE" (not the
    // redundant "TOKENGAUGE: COCKPIT").
    assert.equal(cockpit.name, 'TokenGauge');
    assert.equal(views.length, 1, 'exactly one view: the native cockpit');
    assert.notEqual(cockpit.visibility, 'collapsed');
  });
});

// No Runtime Status "menu references a command not defined in the
// commands section" errors — every commandPalette entry must reference a DECLARED
// command (the auto-generated .focus commands were referenced before and must be gone).
// Advanced/destructive commands are gated out of the default palette;
// the primary cockpit + privacy commands stay visible by default.
suite('manifest — palette hygiene + first-release default palette', () => {
  test('Every commandPalette entry references a declared command (no .focus / undefined refs)', async () => {
    const manifest = await loadManifest();
    const declared = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
    const palette = manifest.contributes?.menus?.commandPalette ?? [];
    for (const entry of palette) {
      const cmd = entry.command;
      assert.ok(cmd, 'commandPalette entry has no command id');
      assert.ok(
        declared.has(cmd),
        `commandPalette references a command not in contributes.commands: ${cmd}`,
      );
      assert.ok(
        !cmd.endsWith('.focus'),
        `auto-generated .focus command must not be referenced from menus: ${cmd}`,
      );
    }
  });

  test('The removed advanced commands are no longer contributed (no palette residue)', async () => {
    const manifest = await loadManifest();
    const ids = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
    for (const id of [
      'tokenGauge.configureProviders',
      'tokenGauge.runCockpitReport',
      // R3-copy: the public install-salt deletion command was removed pre-release.
      'tokenGauge.deleteStoredSecrets',
    ]) {
      assert.ok(!ids.has(id), `removed command must be absent from contributes.commands: ${id}`);
    }
    const titles = new Set((manifest.contributes?.commands ?? []).map((c) => c.title));
    assert.ok(!titles.has('Clear Local Install Salt'), 'no install-salt deletion command title');
    assert.ok(!titles.has('Delete Stored Secrets'), 'no stored-secrets deletion command title');
    const palette = manifest.contributes?.menus?.commandPalette ?? [];
    assert.equal(
      palette.filter((m) => m.when === 'false').length,
      0,
      'no when:false palette residue should remain',
    );
  });

  test('Primary cockpit + privacy commands stay visible by default (no restricting when)', async () => {
    const manifest = await loadManifest();
    const palette = manifest.contributes?.menus?.commandPalette ?? [];
    for (const id of [
      'tokenGauge.openCockpit',
      'tokenGauge.refreshNativeStatus',
      'tokenGauge.configureCockpit',
      'tokenGauge.cockpitDiagnostics',
      'tokenGauge.openPrivacyReport',
    ]) {
      const entry = palette.find((m) => m.command === id);
      // visible-by-default = either no commandPalette entry at all, or one without a
      // restricting `when` (never when:false, never the historical gate).
      if (entry !== undefined) {
        assert.notEqual(entry.when, 'false', `primary/privacy command must not be hidden: ${id}`);
      }
    }
  });
});
