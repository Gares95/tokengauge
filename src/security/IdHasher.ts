// Privacy chokepoint: salted, non-reversible workspace/session ID
// hashing. The salt is owned by SecretManager (per-install, stored in
// SecretStorage); IdHasher is a pure transform from (salt, raw-id) to a
// fixed-length opaque token. Workspace and session ID spaces are kept
// disjoint via distinct namespace tags so a leaked workspace hash cannot be
// cross-referenced as a session hash with the same salt.

import { createHmac } from 'node:crypto';

const WORKSPACE_NAMESPACE = 'tokengauge.workspace.v1';
const SESSION_NAMESPACE = 'tokengauge.session.v1';

function hmacHex(salt: string, namespace: string, raw: string): string {
  // HMAC-SHA256 with the install salt as the key, and (namespace || ":" || raw)
  // as the message. Using the salt as the HMAC key (not as a prefix) prevents
  // length-extension attacks and guarantees a deterministic 64-char hex output
  // per (salt, namespace, raw).
  return createHmac('sha256', salt).update(`${namespace}:${raw}`).digest('hex');
}

export class IdHasher {
  readonly #salt: string;

  public constructor(salt: string) {
    this.#salt = salt;
  }

  public hashWorkspaceId(raw: string): string {
    return hmacHex(this.#salt, WORKSPACE_NAMESPACE, raw);
  }

  public hashSessionId(raw: string): string {
    return hmacHex(this.#salt, SESSION_NAMESPACE, raw);
  }
}

export function hashWorkspaceId(salt: string, raw: string): string {
  return hmacHex(salt, WORKSPACE_NAMESPACE, raw);
}

export function hashSessionId(salt: string, raw: string): string {
  return hmacHex(salt, SESSION_NAMESPACE, raw);
}
