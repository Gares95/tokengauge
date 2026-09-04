// Command palette integration matrix.
//
// Two layers of coverage:
//   1. Registration: every contributed command id is present in the live VS Code
//      command registry after activation (the palette entry exists).
//   2. Structured sanitized results: command run-functions and the registered
//      Source Doctor command path are exercised without provider credentials,
//      raw user files, or a real Codex spawn.
//

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { runNativeSourceDoctor } from '../../src/commands/nativeSourceDoctor';
import { runOpenPrivacyReport } from '../../src/commands/openPrivacyReport';

const EXTENSION_ID = 'gares-extensions.tokengauge-vscode';

const RAW_LEAK_NEEDLES = [
  '/home/dev/private',
  'sk-test-value',
  'TOKEN_GAUGE_SENTINEL',
  'fixture-session',
];

const COMMAND_IDS = [
  'tokenGauge.openPrivacyReport',
  'tokenGauge.runNativeSourceDoctor',
  'tokenGauge.cockpitDiagnostics',
] as const;

function assertNoLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const needle of RAW_LEAK_NEEDLES) {
    assert.ok(!serialized.includes(needle), `command result leaked needle: ${needle}`);
  }
}

async function activate(): Promise<unknown> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension not loaded - confirm publisher.name is '${EXTENSION_ID}'`);
  return extension.activate();
}

suite('Command palette', () => {
  test('All contributed command ids are registered', async () => {
    await activate();
    const registered = await vscode.commands.getCommands(true);
    for (const id of COMMAND_IDS) {
      assert.ok(registered.includes(id), `command not registered: ${id}`);
    }
  });

  test('Registered Source Doctor command exercises production wiring without provider spawn', async () => {
    const api = await activate();
    assert.ok(api && typeof api === 'object', 'test activation should expose the test API');
    const testApi = api as { codexProbeSpawnCountForTest(): number };
    const beforeSpawnCount = testApi.codexProbeSpawnCountForTest();
    const config = vscode.workspace.getConfiguration('tokenGauge');
    const priorClaude = config.inspect<boolean>('display.cards.claude.visible');
    const priorCodex = config.inspect<boolean>('display.cards.codex.visible');

    try {
      await config.update('display.cards.claude.visible', false, vscode.ConfigurationTarget.Global);
      await config.update('display.cards.codex.visible', false, vscode.ConfigurationTarget.Global);
      const result = (await vscode.commands.executeCommand(
        'tokenGauge.runNativeSourceDoctor',
      )) as unknown;
      assertNoLeak(result);
      const serialized = JSON.stringify(result);
      assert.match(serialized, /claude/);
      assert.match(serialized, /codex/);
      assert.match(serialized, /claudeSnapshotScope/);
      assert.match(serialized, /codexProbeScope/);
      assert.equal(serialized.includes('/home/dev/private'), false);
      assert.equal(testApi.codexProbeSpawnCountForTest(), beforeSpawnCount);
      const editorText = vscode.window.activeTextEditor?.document.getText() ?? '';
      assert.match(editorText, /TokenGauge: Native Source Doctor/);
      assert.match(editorText, /Claude snapshot effective scope/);
      assert.match(editorText, /Codex probe effective scope/);
    } finally {
      await config.update(
        'display.cards.claude.visible',
        priorClaude?.globalValue,
        vscode.ConfigurationTarget.Global,
      );
      await config.update(
        'display.cards.codex.visible',
        priorCodex?.globalValue,
        vscode.ConfigurationTarget.Global,
      );
    }
  });

  test('Open Privacy Report renders a readable trust report', async () => {
    let rendered = false;
    const report = await runOpenPrivacyReport({
      buildInput: async () => ({
        codexProbeEnabled: false,
        codexCardVisible: true,
        claudeCardVisible: true,
      }),
      renderReport: async () => {
        rendered = true;
      },
    });
    assert.match(report.heading, /Privacy & Data Report/);
    assert.ok(rendered);
    assert.ok(!report.body.includes('/home/dev/private'));
    assertNoLeak(report);
  });

  test('Run Source Doctor renders a sanitized setup health report', async () => {
    let rendered = false;
    const result = await runNativeSourceDoctor({
      buildReport: () => ({
        generatedAtMs: Date.parse('2026-09-03T12:00:00.000Z'),
        host: { remoteKind: 'local', claudeSnapshotScope: 'default', codexProbeScope: 'default' },
        providers: [
          {
            provider: 'codex',
            displayName: 'Codex',
            visible: true,
            findings: [
              {
                ruleId: 'doctor_codex_probe_disabled',
                severity: 'info',
                title: 'Codex native probe is off',
                message: 'The explicit probe setting is disabled.',
              },
            ],
          },
        ],
      }),
      renderReport: async () => {
        rendered = true;
      },
    });

    assert.equal(result.commandId, 'tokenGauge.runNativeSourceDoctor');
    assert.ok(rendered);
    assertNoLeak(result);
  });
});
