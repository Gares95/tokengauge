import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { TOKENGAUGE_KEYS } from '../../src/config/keys';
import type { TokenGaugeTestApi } from '../../src/extension';

const EXTENSION_ID = 'tokengauge.tokengauge-vscode';
const ACTIVATION_CI_CEILING_MS = 400;
const ACTIVATION_MANUAL_GATE_MS = 200;
const RAW_LEAK_NEEDLES = [
  '.claude',
  'fixture-session-aaaa1111',
  'fixture-workspace-alpha',
  'prompt',
  'completion',
  'tool_result',
  'TOKEN_GAUGE_SENTINEL',
  'sk-test-value',
];

async function activateTokenGauge(): Promise<TokenGaugeTestApi> {
  const extension = vscode.extensions.getExtension<TokenGaugeTestApi>(EXTENSION_ID);
  assert.ok(
    extension,
    `extension not loaded - confirm publisher.name in package.json matches '${EXTENSION_ID}' and .vscode-test.mjs workspaceFolder is set`,
  );

  return extension.activate();
}

suite('Activation budget - dual gate: CI hard-fail at >400ms, warn at >200ms', () => {
  test('TokenGauge extension activates and returns test API', async () => {
    const api = await activateTokenGauge();
    assert.ok(api, 'activate() must return a test API object');
    assert.ok(api.configService, 'api.configService must be defined post-activation');
    assert.equal(typeof api.configService.snapshot, 'function');
  });

  test('Activation timing satisfies CI ceiling', async () => {
    const api = await activateTokenGauge();
    const ms = api.getLastActivationMs();

    if (typeof ms !== 'number') {
      assert.fail('lastActivationMs must be a number');
    }
    const activationMs = ms;
    assert.ok(
      activationMs < ACTIVATION_CI_CEILING_MS,
      `activation took ${activationMs}ms - CI ceiling is ${ACTIVATION_CI_CEILING_MS}ms. Manual UX-10 gate is ${ACTIVATION_MANUAL_GATE_MS}ms.`,
    );

    if (activationMs > ACTIVATION_MANUAL_GATE_MS) {
      console.warn(
        `WARN: activation ${activationMs}ms exceeds the manual UX-10 gate of ${ACTIVATION_MANUAL_GATE_MS}ms. CI hard-fail is ${ACTIVATION_CI_CEILING_MS}ms.`,
      );
    }

    console.log(`measured activation: ${activationMs}ms`);
  });

  test('Every TOKENGAUGE_KEYS entry is reachable via api.configService.snapshot()', async () => {
    const api = await activateTokenGauge();
    const snapshot = api.configService?.snapshot();
    assert.ok(snapshot, 'snapshot must be available');

    for (const key of TOKENGAUGE_KEYS) {
      assert.ok(Object.hasOwn(snapshot, key), `snapshot missing key: ${key}`);
    }
  });

  test('Command palette: all command ids are registered', async () => {
    await activateTokenGauge();

    const registered = await vscode.commands.getCommands(true);
    const required = ['tokenGauge.openPrivacyReport'];
    for (const id of required) {
      assert.ok(registered.includes(id), `command not registered: ${id}`);
    }
  });

  test('Test API exposes the sanitized native surface with no raw leaks', async () => {
    const api = await activateTokenGauge();

    assert.equal(typeof api.statusBarText, 'function', 'api.statusBarText must exist');
    assert.equal(typeof api.diagnosticsEntries, 'function', 'api.diagnosticsEntries must exist');

    const entries = api.diagnosticsEntries();
    assert.ok(Array.isArray(entries), 'diagnosticsEntries() must return an array');

    const text = api.statusBarText();
    assert.ok(text === undefined || typeof text === 'string');

    // No raw secret or store-internal leaks through the sanitized native surface.
    const serialized = JSON.stringify({ entries, statusBarText: text });
    assert.ok(!serialized.includes(api.globalStoragePath()), 'no raw store path in test API');
    for (const needle of RAW_LEAK_NEEDLES) {
      assert.ok(!serialized.includes(needle), `test API leaked forbidden needle: ${needle}`);
    }
  });
});
