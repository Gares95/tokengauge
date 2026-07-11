import * as assert from 'node:assert/strict';
import { hashSessionId, hashWorkspaceId, IdHasher } from '../../../src/security/IdHasher';

const SALT_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SALT_B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

// Acceptance: IdHasher returns stable hashes with the same salt and divergent
// hashes with different salts. Hashes must never
// echo raw paths or raw session identifiers.

suite('IdHasher class hashing', () => {
  test('HashWorkspaceId returns the same hash twice for the same salt + input', () => {
    const hasher = new IdHasher(SALT_A);
    const a = hasher.hashWorkspaceId('/home/dev/project');
    const b = hasher.hashWorkspaceId('/home/dev/project');
    assert.equal(a, b);
  });

  test('HashWorkspaceId returns a different hash for a different input', () => {
    const hasher = new IdHasher(SALT_A);
    const a = hasher.hashWorkspaceId('/home/dev/project');
    const b = hasher.hashWorkspaceId('/home/dev/other-project');
    assert.notEqual(a, b);
  });

  test('HashWorkspaceId returns a different hash when the salt changes', () => {
    const hasherA = new IdHasher(SALT_A);
    const hasherB = new IdHasher(SALT_B);
    const a = hasherA.hashWorkspaceId('/home/dev/project');
    const b = hasherB.hashWorkspaceId('/home/dev/project');
    assert.notEqual(a, b);
  });

  test('HashSessionId is stable for the same salt + input', () => {
    const hasher = new IdHasher(SALT_A);
    const a = hasher.hashSessionId('session-uuid-abc');
    const b = hasher.hashSessionId('session-uuid-abc');
    assert.equal(a, b);
  });

  test('HashSessionId diverges for different salts', () => {
    const a = new IdHasher(SALT_A).hashSessionId('session-uuid-abc');
    const b = new IdHasher(SALT_B).hashSessionId('session-uuid-abc');
    assert.notEqual(a, b);
  });
});

suite('IdHasher does not echo raw inputs', () => {
  test('Workspace hash never contains the raw POSIX path', () => {
    const raw = '/home/dev/secret-workspace';
    const hashed = new IdHasher(SALT_A).hashWorkspaceId(raw);
    assert.ok(!hashed.includes(raw), 'hash output must not echo the raw path');
    assert.ok(!hashed.includes('/home'), 'hash output must not echo POSIX root segments');
  });

  test('Workspace hash never contains a raw Windows path', () => {
    const raw = 'C:\\Users\\dev\\secret-workspace';
    const hashed = new IdHasher(SALT_A).hashWorkspaceId(raw);
    assert.ok(!hashed.includes(raw));
    assert.ok(!hashed.includes('C:\\'));
    assert.ok(!hashed.includes('Users'));
  });

  test('Session hash never contains the raw session identifier', () => {
    const raw = 'session-uuid-7b3f9e2c-1234-5678-90ab-cdef01234567';
    const hashed = new IdHasher(SALT_A).hashSessionId(raw);
    assert.ok(!hashed.includes(raw));
    assert.ok(!hashed.includes('uuid'));
  });

  test('Hashes are fixed-length hex strings', () => {
    const hasher = new IdHasher(SALT_A);
    const workspaceHash = hasher.hashWorkspaceId('any-input');
    const sessionHash = hasher.hashSessionId('any-input');
    assert.match(workspaceHash, /^[0-9a-f]+$/);
    assert.match(sessionHash, /^[0-9a-f]+$/);
    assert.equal(workspaceHash.length, sessionHash.length);
    // SHA-256 hex is 64 characters; allow >= 32 for any fixed-length safe hash.
    assert.ok(workspaceHash.length >= 32);
  });
});

suite('IdHasher namespacing', () => {
  test('Workspace and session hashes of the same input differ', () => {
    // Workspace and session ID spaces must be disjoint so a leaked workspace
    // hash cannot be cross-referenced as a session hash with the same salt.
    const hasher = new IdHasher(SALT_A);
    const input = 'identical-string';
    const w = hasher.hashWorkspaceId(input);
    const s = hasher.hashSessionId(input);
    assert.notEqual(w, s);
  });
});

suite('IdHasher module helpers', () => {
  test('HashWorkspaceId helper matches IdHasher.hashWorkspaceId for the same salt', () => {
    const hasher = new IdHasher(SALT_A);
    const direct = hasher.hashWorkspaceId('/home/dev/project');
    const helper = hashWorkspaceId(SALT_A, '/home/dev/project');
    assert.equal(direct, helper);
  });

  test('HashSessionId helper matches IdHasher.hashSessionId for the same salt', () => {
    const hasher = new IdHasher(SALT_A);
    const direct = hasher.hashSessionId('session-uuid');
    const helper = hashSessionId(SALT_A, 'session-uuid');
    assert.equal(direct, helper);
  });
});
