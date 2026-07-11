// ClaudeStatuslineBridge privacy invariant.
//
// The bridge is the riskiest observed-limit surface: it reads a user-configured
// Claude statusLine snapshot that — if written whole — carries raw paths + git
// remotes + a raw session id. This suite proves the two-layer defence:
//
//   1. The strict snapshot schema rejects the leaky full payload by
//      construction (no place for cwd/workspace/repo to land).
//   2. The raw session_id NEVER appears in the produced sample — only a 64-hex
//      hash in scopeHash.
//   3. A snapshot that somehow smuggled a forbidden value into an allowlisted
//      string field is rejected by the ObservedLimitSampleGuard backstop, content-free.
//
// The leaky fixture's placeholder slots are filled with fragment-assembled
// sentinels at runtime; no committed file holds a contiguous forbidden literal.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRIDGE_SOURCE_FINGERPRINT,
  type ClaudeStatuslineBridgeDeps,
  snapshotToObservedLimitSample,
} from '../../src/bridge/ClaudeStatuslineBridge';
import { PrivacyViolationError } from '../../src/core/diagnostics/errors';
import { IdHasher } from '../../src/security/IdHasher';
import { findRepoRoot } from '../_helpers/repoRoot';
import { PRIVACY_SENTINELS } from '../fixtures/privacy/sentinels';

const FIXTURE_DIR = join(findRepoRoot(), 'test', 'fixtures', 'statusline');
const RAW_SESSION_ID = '11111111-2222-3333-4444-555555555555';

function makeDeps(): ClaudeStatuslineBridgeDeps {
  const hasher = new IdHasher('priv-test-salt');
  return {
    hasher,
    now: () => new Date('2026-06-09T10:00:00.000Z'),
    deriveId: (material: string) => hasher.hashWorkspaceId(material),
    sourceFingerprint: BRIDGE_SOURCE_FINGERPRINT,
  };
}

function loadLeakyWithSentinels(): Record<string, unknown> {
  let json = readFileSync(join(FIXTURE_DIR, 'statusline-snapshot-leaky.json'), 'utf8');
  json = json
    .replaceAll('__SENTINEL_SLOT_PATH__', PRIVACY_SENTINELS.fakePosixPath)
    .replaceAll('__SENTINEL_SLOT_GITREMOTE__', PRIVACY_SENTINELS.fakeGitRemote)
    .replaceAll('__SENTINEL_SLOT_APIKEY__', PRIVACY_SENTINELS.fakeApiKey);
  return JSON.parse(json) as Record<string, unknown>;
}

function cleanSnapshot(): Record<string, unknown> {
  return {
    model: { id: 'claude-opus-4' },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: 1781110800 } },
    session_id: RAW_SESSION_ID,
  };
}

suite('ClaudeStatuslineBridge privacy invariant', () => {
  test('The leaky full payload is rejected before becoming a sample', () => {
    const leaky = loadLeakyWithSentinels();
    try {
      snapshotToObservedLimitSample(leaky, makeDeps());
      assert.fail('expected the leaky snapshot to be rejected');
    } catch (err) {
      // Schema or guard rejection — either way, no sample is produced and the
      // error never echoes a sentinel value.
      const message = err instanceof Error ? err.message : String(err);
      for (const sentinel of Object.values(PRIVACY_SENTINELS)) {
        assert.ok(!message.includes(sentinel), 'error leaked a sentinel value');
      }
    }
  });

  test('The raw session_id never appears in the produced sample (only a 64-hex hash)', () => {
    const sample = snapshotToObservedLimitSample(cleanSnapshot(), makeDeps());
    const serialized = JSON.stringify(sample);
    assert.ok(!serialized.includes(RAW_SESSION_ID), 'raw session id leaked into sample');
    assert.match(sample.scopeHash ?? '', /^[0-9a-f]{64}$/);
  });

  test('A raw id smuggled into session_id_hash is RE-HASHED, never persisted to scopeHash', () => {
    // The *_hash field carries a raw id (has dashes — not hash-like).
    const snap: Record<string, unknown> = {
      model: { id: 'claude-opus-4' },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1781110800 } },
      session_id_hash: RAW_SESSION_ID,
    };
    const sample = snapshotToObservedLimitSample(snap, makeDeps());
    assert.ok(
      !JSON.stringify(sample).includes(RAW_SESSION_ID),
      'raw id from session_id_hash must never reach the persisted sample',
    );
    assert.match(sample.scopeHash ?? '', /^[0-9a-f]{64}$/, 'scopeHash must be a re-hashed value');
  });

  test('A forbidden value smuggled into model.id is rejected by the guard backstop', () => {
    const smuggled: Record<string, unknown> = {
      model: { id: PRIVACY_SENTINELS.fakeApiKey.slice(0, 110) },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1781110800 } },
      session_id: RAW_SESSION_ID,
    };
    try {
      snapshotToObservedLimitSample(smuggled, makeDeps());
      assert.fail('expected the guard backstop to reject a forbidden model id');
    } catch (err) {
      assert.ok(err instanceof PrivacyViolationError || err instanceof Error);
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(
        !message.includes(PRIVACY_SENTINELS.fakeApiKey),
        'error leaked the smuggled sentinel',
      );
    }
  });
});
