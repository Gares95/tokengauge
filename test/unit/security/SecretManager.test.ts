// SecretManager unit tests use a fake SecretStorage so the fast suite proves
// install-salt behavior without booting VS Code.

import * as assert from 'node:assert/strict';
import { INSTALL_SALT_SECRET_KEY, SecretManager } from '../../../src/security/SecretManager';

interface FakeSecretStorage {
  readonly store: Map<string, string>;
  readonly accessedKeys: string[];
  readonly storedKeys: string[];
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  onDidChange: unknown;
}

function createFakeSecrets(): FakeSecretStorage {
  const map = new Map<string, string>();
  const accessedKeys: string[] = [];
  const storedKeys: string[] = [];
  return {
    store: map,
    accessedKeys,
    storedKeys,
    async get(key: string) {
      accessedKeys.push(key);
      return map.get(key);
    },
    // SecretStorage.store; aliased to `set` to keep the fake readable.
    async set(key: string, value: string) {
      storedKeys.push(key);
      map.set(key, value);
    },
    onDidChange: () => ({ dispose() {} }),
  };
}

// Adapter that presents the fake under the SecretStorage shape SecretManager
// consumes (get/store/delete).
// biome-ignore lint/suspicious/noExplicitAny: structural test seam for vscode.SecretStorage
function asSecretStorage(fake: FakeSecretStorage): any {
  return {
    get: (k: string) => fake.get(k),
    store: (k: string, v: string) => fake.set(k, v),
    onDidChange: fake.onDidChange,
  };
}

suite('SecretManager install salt', () => {
  test('Creates one local install salt under the canonical SecretStorage key', async () => {
    const fake = createFakeSecrets();
    const mgr = new SecretManager(asSecretStorage(fake));

    const salt = await mgr.getOrCreateInstallSalt();

    assert.match(salt, /^[a-f0-9]{64}$/);
    assert.equal(fake.store.get(INSTALL_SALT_SECRET_KEY), salt);
    assert.deepEqual(fake.storedKeys, [INSTALL_SALT_SECRET_KEY]);
  });

  test('Reuses an existing install salt and caches it in-process', async () => {
    const fake = createFakeSecrets();
    await fake.set(INSTALL_SALT_SECRET_KEY, 'existing-salt');
    fake.storedKeys.length = 0;
    const mgr = new SecretManager(asSecretStorage(fake));

    const first = await mgr.getOrCreateInstallSalt();
    const second = await mgr.getOrCreateInstallSalt();

    assert.equal(first, 'existing-salt');
    assert.equal(second, 'existing-salt');
    assert.deepEqual(fake.accessedKeys, [INSTALL_SALT_SECRET_KEY]);
    assert.deepEqual(fake.storedKeys, []);
  });

  test('Does not expose salt material through JSON.stringify', async () => {
    const fake = createFakeSecrets();
    const mgr = new SecretManager(asSecretStorage(fake));
    await mgr.getOrCreateInstallSalt();

    const serialized = JSON.stringify(mgr);

    assert.ok(!serialized.toLowerCase().includes('salt'));
  });
});
