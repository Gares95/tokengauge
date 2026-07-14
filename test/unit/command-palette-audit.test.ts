// Palette hygiene: the command-palette audit. The native-first cockpit is the product; the
// palette must lead with the native primaries and never route a user back to the
// legacy log-derived surface as the main surface.
//
// Asserted against the manifest (package.json) directly — no vscode runtime —
// because contributes.commands + contributes.menus.commandPalette are the
// single source of truth for palette presentation.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findRepoRoot } from '../_helpers/repoRoot';

interface CommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

interface PaletteMenuItem {
  readonly command: string;
  readonly when?: string;
}

interface ViewContribution {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

interface Manifest {
  readonly contributes?: {
    readonly commands?: readonly CommandContribution[];
    readonly menus?: {
      readonly commandPalette?: readonly PaletteMenuItem[];
    };
    readonly views?: Readonly<Record<string, readonly ViewContribution[]>>;
  };
}

function viewsById(): Map<string, ViewContribution> {
  const groups = readRawManifest().contributes?.views ?? {};
  const all: ViewContribution[] = [];
  for (const group of Object.values(groups)) {
    all.push(...group);
  }
  return new Map(all.map((v) => [v.id, v]));
}

function readRawManifest(): Manifest {
  const manifestPath = path.join(findRepoRoot(), 'package.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
}

function commandsById(): Map<string, CommandContribution> {
  const commands = readRawManifest().contributes?.commands ?? [];
  return new Map(commands.map((c) => [c.command, c]));
}

function paletteWhenFor(command: string): string | undefined | 'absent' {
  const palette = readRawManifest().contributes?.menus?.commandPalette ?? [];
  const entry = palette.find((m) => m.command === command);
  if (entry === undefined) return 'absent';
  return entry.when;
}

// A command is HIDDEN from the palette iff a commandPalette entry pins when:false.
function isHiddenFromPalette(command: string): boolean {
  const when = paletteWhenFor(command);
  return when === 'false';
}

// The three native primaries the palette must lead with.
const NATIVE_PRIMARIES = [
  'tokenGauge.openCockpit',
  'tokenGauge.refreshNativeStatus',
  'tokenGauge.cockpitDiagnostics',
] as const;

// R3-copy: obsolete / dev-only commands removed pre-release. They must be ABSENT
// from the manifest entirely — no hidden when:false residue routing users astray.
const REMOVED_COMMANDS = ['tokenGauge.runCockpitReport', 'tokenGauge.configureProviders'] as const;

suite('Command-palette audit — native-first clarity', () => {
  test('The three native primaries are contributed with clear titles', () => {
    const commands = commandsById();
    const openCockpit = commands.get('tokenGauge.openCockpit');
    assert.ok(openCockpit, 'manifest must contribute tokenGauge.openCockpit');
    assert.match(openCockpit?.title ?? '', /open cockpit/i);

    const refresh = commands.get('tokenGauge.refreshNativeStatus');
    assert.ok(refresh, 'manifest must contribute tokenGauge.refreshNativeStatus');
    assert.match(refresh?.title ?? '', /refresh native status/i);

    const diag = commands.get('tokenGauge.cockpitDiagnostics');
    assert.ok(diag, 'manifest must contribute tokenGauge.cockpitDiagnostics');
    assert.match(diag?.title ?? '', /cockpit diagnostics/i);
  });

  test('The native primaries are visible in the command palette (not hidden)', () => {
    for (const command of NATIVE_PRIMARIES) {
      assert.equal(isHiddenFromPalette(command), false, `${command} must remain palette-visible`);
    }
  });

  test('Removed obsolete / dev-only commands are no longer contributed (no palette residue)', () => {
    const commands = commandsById();
    const palette = readRawManifest().contributes?.menus?.commandPalette ?? [];
    for (const command of REMOVED_COMMANDS) {
      assert.ok(!commands.has(command), `removed command must be absent: ${command}`);
      assert.equal(
        paletteWhenFor(command),
        'absent',
        `removed command must leave no palette gate: ${command}`,
      );
    }
    assert.equal(
      palette.filter((m) => m.when === 'false').length,
      0,
      'v1 has no when:false palette residue',
    );
  });

  // VS Code auto-generates `<viewId>.focus` commands for every
  // contributed view. They surface in the palette as "Focus on Cockpit View" /
  // "Focus on Usage View" and clutter/mislead. They are NOT in
  // contributes.commands (auto-generated), so the only lever is a commandPalette
  // entry pinning when:false.
  const FOCUS_COMMANDS = ['tokenGauge.views.cockpit.focus'] as const;

  // Pinning the auto-generated *.focus
  // commands with when:false made VS Code report a Runtime Status error ("menu item
  // references a command not defined in the commands section"). The fix is to NOT
  // reference them from menus at all — so they must be ABSENT from commandPalette.
  // (The cockpit "Focus on Cockpit" may reappear in the palette — benign, primary
  // view; the usage view's focus stays hidden because the VIEW is gated by
  // tokenGauge.showHistoricalUsage.)
  test('Auto-generated view *.focus commands are NOT referenced from the palette', () => {
    for (const command of FOCUS_COMMANDS) {
      assert.equal(
        paletteWhenFor(command),
        'absent',
        `${command} must not be referenced from commandPalette (it triggers a Runtime Status error)`,
      );
    }
  });

  test('The cockpit view name remains clear so its focus opens the cockpit', () => {
    const cockpit = viewsById().get('tokenGauge.views.cockpit');
    assert.ok(cockpit, 'manifest must contribute the cockpit view');
    // The view name is the brand ("TokenGauge") so the header reads
    // "TOKENGAUGE" and the auto-generated focus reads "Focus on TokenGauge View".
    assert.match(cockpit?.name ?? '', /tokengauge/i);
    assert.equal(cockpit?.type, 'webview');
  });

  test('Every commandPalette menu entry references a contributed OR auto-generated command', () => {
    const palette = readRawManifest().contributes?.menus?.commandPalette ?? [];
    const commands = commandsById();
    const autoGenerated = new Set<string>(FOCUS_COMMANDS);
    for (const item of palette) {
      assert.ok(
        commands.has(item.command) || autoGenerated.has(item.command),
        `commandPalette references unknown command: ${item.command}`,
      );
    }
  });
});
