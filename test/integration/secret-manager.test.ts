import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { TokenGaugeTestApi } from '../../src/extension';
import { INSTALL_SALT_SECRET_KEY, type SecretManager } from '../../src/security/SecretManager';

const EXTENSION_ID = 'tokengauge.tokengauge-vscode';

async function activateAndGetApi(): Promise<TokenGaugeTestApi> {
  const extension = vscode.extensions.getExtension<TokenGaugeTestApi>(EXTENSION_ID);
  assert.ok(extension, `extension not loaded: ${EXTENSION_ID}`);
  return extension.activate();
}

async function getSecretManager(): Promise<SecretManager> {
  const api = await activateAndGetApi();
  assert.ok(api.secretManager, 'api.secretManager must be defined post-activation');
  return api.secretManager;
}

suite('SecretManager install salt lifecycle', () => {
  test('GetOrCreateInstallSalt() generates a random salt with sufficient entropy', async () => {
    const mgr = await getSecretManager();
    const salt = await mgr.getOrCreateInstallSalt();
    assert.equal(typeof salt, 'string');
    assert.ok(salt.length >= 32, `salt length ${salt.length} must be >= 32`);
  });

  test('GetOrCreateInstallSalt() returns the same salt on subsequent calls', async () => {
    const mgr = await getSecretManager();
    const first = await mgr.getOrCreateInstallSalt();
    const second = await mgr.getOrCreateInstallSalt();
    assert.equal(first, second);
  });

  test('Install salt is not stored under a credential-shaped settings key', () => {
    // The exported salt secret key must not collide with the tokenGauge.* settings
    // namespace. SecretStorage keys are independent of workspace settings.
    const cfg = vscode.workspace.getConfiguration('tokenGauge');
    const relativeKey = INSTALL_SALT_SECRET_KEY.replace(/^tokenGauge\./, '');
    const cfgValue = cfg.get<unknown>(relativeKey);
    assert.equal(
      cfgValue,
      undefined,
      'install salt SecretStorage key must not be a tokenGauge.* settings key',
    );
  });

  test('Install salt does not leak through JSON.stringify on SecretManager', async () => {
    const mgr = await getSecretManager();
    await mgr.getOrCreateInstallSalt();
    const serialized = JSON.stringify(mgr);
    assert.ok(
      !serialized.toLowerCase().includes('salt'),
      'serialized SecretManager must not include salt material',
    );
  });
});

suite('SecretManager activation salt initialization', () => {
  test('Api.saltReady resolves without exposing the raw salt value', async () => {
    const api = await activateAndGetApi();
    const result = await api.saltReady;
    assert.equal(result, undefined, 'saltReady must resolve to undefined');
  });

  test('Install salt is available via SecretManager after saltReady resolves', async () => {
    const api = await activateAndGetApi();
    await api.saltReady;
    assert.ok(api.secretManager);
    const salt = await api.secretManager.getOrCreateInstallSalt();
    assert.equal(typeof salt, 'string');
    assert.ok(salt.length >= 32);
  });
});
