// Privacy chokepoint: this is the ONLY source file allowed to call into
// vscode.SecretStorage (context.secrets.get/store). The static gate
// tools/check-secretstorage-boundary.mjs enforces the exclusivity.
//
// Also owns the per-install salt that backs IdHasher. The
// salt is generated lazily on first activation, stored in SecretStorage, and
// never written to settings, the usage store, logs, diagnostics, or any
// public enumerable property of this class.

import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';

// SecretStorage key for the per-install hash salt. Exported so tests and
// boundary checks can refer to the canonical name without re-declaring it.
export const INSTALL_SALT_SECRET_KEY = 'tokengauge.install.saltV1';

const SALT_BYTE_LENGTH = 32;

export class SecretManager {
  // Note: the underlying SecretStorage is intentionally held in a private
  // field (`#secrets`) so it cannot appear in JSON.stringify(this) or in
  // for-in iteration. The cached install salt is held the same way.
  #secrets: vscode.SecretStorage;
  #cachedSalt: string | undefined;

  public constructor(secrets: vscode.SecretStorage) {
    this.#secrets = secrets;
  }

  // Lazy-create the per-install salt. The first activation generates 32
  // random bytes (hex-encoded, 64 chars) and stores them; subsequent
  // activations return the same salt. The salt is cached in-process to
  // avoid hitting SecretStorage on every hash call.
  public async getOrCreateInstallSalt(): Promise<string> {
    if (this.#cachedSalt !== undefined) {
      return this.#cachedSalt;
    }
    const existing = await this.#secrets.get(INSTALL_SALT_SECRET_KEY);
    if (typeof existing === 'string' && existing.length > 0) {
      this.#cachedSalt = existing;
      return existing;
    }
    const fresh = randomBytes(SALT_BYTE_LENGTH).toString('hex');
    await this.#secrets.store(INSTALL_SALT_SECRET_KEY, fresh);
    this.#cachedSalt = fresh;
    return fresh;
  }
}
