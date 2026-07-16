// Command palette integration matrix.
//
// Two layers of coverage:
//   1. Registration: every contributed command id is present in the live VS Code
//      command registry after activation (the palette entry exists).
//   2. Structured sanitized results: each command's pure `run<Command>(deps)`
//      function is driven through injected/test seams that auto-approve, and the
//      returned result is asserted to be structured and free of raw paths,
//      secret values, and sentinel strings. The real wiring in extension.ts
//      supplies the equivalent native seams; this test exercises the same
//      run-functions the wiring invokes, without blocking on real QuickPick UI.
//

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { runOpenPrivacyReport } from '../../src/commands/openPrivacyReport';

const EXTENSION_ID = 'gares-extensions.tokengauge-vscode';

const RAW_LEAK_NEEDLES = [
  '/home/dev/private',
  'sk-test-value',
  'TOKEN_GAUGE_SENTINEL',
  'fixture-session',
];

const COMMAND_IDS = ['tokenGauge.openPrivacyReport'] as const;

function assertNoLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const needle of RAW_LEAK_NEEDLES) {
    assert.ok(!serialized.includes(needle), `command result leaked needle: ${needle}`);
  }
}

async function activate(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension not loaded - confirm publisher.name is '${EXTENSION_ID}'`);
  await extension.activate();
}

suite('Command palette', () => {
  test('All contributed command ids are registered', async () => {
    await activate();
    const registered = await vscode.commands.getCommands(true);
    for (const id of COMMAND_IDS) {
      assert.ok(registered.includes(id), `command not registered: ${id}`);
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
});
