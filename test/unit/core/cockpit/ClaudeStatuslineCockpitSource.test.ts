// ClaudeStatuslineCockpitSource unit tests.
//
// A clean statusLine snapshot maps to a CockpitState candidate with the SINGLE
// canonical sourceTier `statusline_snapshot` (never `native_visible`, never
// both). Session 5h + weekly 7d %used + resetsAt + cost + model, hashed
// session/workspace, freshness from the snapshot timestamp. The leaky full
// payload is rejected by the reused .strict() schema; raw session/path never
// reach the candidate.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotToCockpitCandidate } from '../../../../src/core/cockpit/ClaudeStatuslineCockpitSource';
import { PrivacyViolationError } from '../../../../src/core/diagnostics/errors';
import { IdHasher } from '../../../../src/security/IdHasher';
import { findRepoRoot } from '../../../_helpers/repoRoot';
import { PRIVACY_SENTINELS } from '../../../fixtures/privacy/sentinels';

const FIXTURE_DIR = join(findRepoRoot(), 'test', 'fixtures', 'cockpit');
const STATUSLINE_FIXTURE_DIR = join(findRepoRoot(), 'test', 'fixtures', 'statusline');

function loadClean(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'claude-statusline-cockpit.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function loadUat(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'claude-statusline-uat.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function loadLeaky(): Record<string, unknown> {
  let json = readFileSync(join(STATUSLINE_FIXTURE_DIR, 'statusline-snapshot-leaky.json'), 'utf8');
  json = json
    .replaceAll('__SENTINEL_SLOT_PATH__', PRIVACY_SENTINELS.fakePosixPath)
    .replaceAll('__SENTINEL_SLOT_GITREMOTE__', PRIVACY_SENTINELS.fakeGitRemote)
    .replaceAll('__SENTINEL_SLOT_APIKEY__', PRIVACY_SENTINELS.fakeApiKey);
  return JSON.parse(json) as Record<string, unknown>;
}

const hasher = new IdHasher('test-salt-0123456789');
const now = (): Date => new Date('2026-06-11T12:00:00.000Z');
const deps = { hasher, now };

suite('ClaudeStatuslineCockpitSource: statusLine -> cockpit candidate', () => {
  // Legacy compatibility snapshots with hash-only identifiers, reset ISO fields,
  // and extra context fields still map correctly without raw ID leaks.
  test('UAT snapshot shape (session_id_hash, resets_at_iso) maps correctly with no raw session_id', () => {
    const snap = loadUat();
    assert.equal(
      (snap as { session_id?: unknown }).session_id,
      undefined,
      'fixture has NO raw session_id',
    );
    const candidate = snapshotToCockpitCandidate(snap, deps);
    assert.equal(candidate.sourceTier, 'statusline_snapshot');
    // session / 5h
    assert.equal(candidate.session?.usedPct, 62);
    assert.equal(candidate.session?.leftPct, 38);
    assert.equal(candidate.session?.resetsAt, '2026-06-11T17:30:00Z'); // resets_at_iso preferred
    // weekly / 7d
    assert.equal(candidate.weekly?.usedPct, 34);
    assert.equal(candidate.weekly?.leftPct, 66);
    assert.equal(candidate.weekly?.resetsAt, '2026-06-15T00:00:00Z');
    // model + cost
    assert.equal(candidate.model, 'claude-opus-4-8');
    assert.equal(candidate.cost, 540.8158384999998);
    // scope: pre-hashed ids used directly; raw never present.
    assert.equal(candidate.sessionHash, '7c8f0f43d0f96827');
    assert.equal(candidate.workspaceHash, '58844f10d95e5fa7');
    assert.ok(
      !JSON.stringify(candidate).includes('session_id'),
      'no raw session_id field on the candidate',
    );
  });

  test('A raw/malformed session_id_hash is RE-HASHED, never trusted verbatim', () => {
    const snap = loadUat();
    // A raw session id smuggled into the *_hash field (has dashes, not hash-like).
    const rawId = '11111111-2222-3333-4444-555555555555';
    (snap as Record<string, unknown>).session_id_hash = rawId;
    (snap as Record<string, unknown>).workspace_hash = rawId;
    const candidate = snapshotToCockpitCandidate(snap, deps);
    assert.notEqual(candidate.sessionHash, rawId, 'raw id must not be used verbatim');
    assert.equal(candidate.sessionHash, hasher.hashSessionId(rawId), 'must be re-hashed');
    assert.notEqual(candidate.workspaceHash, rawId);
    assert.equal(candidate.workspaceHash, hasher.hashWorkspaceId(rawId));
    assert.ok(!JSON.stringify(candidate).includes(rawId), 'no raw id anywhere on the candidate');
  });

  test('A hash-like session_id_hash is used directly (not double-hashed)', () => {
    const snap = loadUat(); // session_id_hash = 7c8f0f43d0f96827 (hex, 16)
    const candidate = snapshotToCockpitCandidate(snap, deps);
    assert.equal(candidate.sessionHash, '7c8f0f43d0f96827');
  });

  test('Clean snapshot maps to a statusline_snapshot candidate with cockpit fields', () => {
    const candidate = snapshotToCockpitCandidate(loadClean(), deps);
    assert.equal(candidate.sourceTier, 'statusline_snapshot');
    assert.equal(candidate.session?.usedPct, 62);
    assert.equal(candidate.weekly?.usedPct, 71);
    // LeftPct is derived from used_percentage (100 - used) so the native
    // cockpit "% left" field is populated rather than always unavailable.
    assert.equal(candidate.session?.leftPct, 38);
    assert.equal(candidate.weekly?.leftPct, 29);
    assert.equal(candidate.session?.resetsAt, new Date(1781110800 * 1000).toISOString());
    assert.equal(candidate.weekly?.resetsAt, new Date(1781308800 * 1000).toISOString());
    assert.equal(candidate.cost, 4.27);
    assert.equal(candidate.model, 'claude-opus-4');
    assert.equal(candidate.scope.provider, 'anthropic');
    assert.equal(candidate.scope.agent, 'claude-code');
    assert.equal(candidate.producedAtMs, now().getTime());
  });

  test('The single canonical sourceTier is statusline_snapshot — never native_visible', () => {
    const candidate = snapshotToCockpitCandidate(loadClean(), deps);
    assert.equal(candidate.sourceTier, 'statusline_snapshot');
    assert.notEqual(candidate.sourceTier, 'native_visible');
  });

  test('Session id is HASHED — the raw id never reaches the candidate', () => {
    const candidate = snapshotToCockpitCandidate(loadClean(), deps);
    const rawSession = '11111111-2222-3333-4444-555555555555';
    assert.notEqual(candidate.sessionHash, rawSession);
    assert.equal(candidate.sessionHash, hasher.hashSessionId(rawSession));
    // Serialized candidate carries no raw session id.
    assert.ok(!JSON.stringify(candidate).includes(rawSession));
  });

  // The schema admits
  // context_window.* but the earlier mapper dropped it. It now maps into a
  // candidate.context sub-object with explicit derivation rules; absent stays absent.
  test('Context_window with both percentages + token counts maps into candidate.context', () => {
    const snap = {
      model: { id: 'claude-opus-4' },
      context_window: {
        used_percentage: 42,
        context_window_size: 200000,
        total_input_tokens: 50000,
        total_output_tokens: 1200,
      },
    };
    const candidate = snapshotToCockpitCandidate(snap, deps);
    assert.equal(candidate.context?.usedPct, 42);
    assert.equal(candidate.context?.leftPct, 58); // 100 - used, clamped
    assert.equal(candidate.context?.windowSizeTokens, 200000);
    assert.equal(candidate.context?.inputTokens, 50000);
    assert.equal(candidate.context?.outputTokens, 1200);
    // usedTokens is never fabricated from input+output.
    assert.equal(candidate.context?.usedTokens, undefined);
  });

  test('Context_window with ONLY remaining_percentage derives usedPct = 100 - left', () => {
    const snap = {
      model: { id: 'claude-opus-4' },
      context_window: { remaining_percentage: 30 },
    };
    const candidate = snapshotToCockpitCandidate(snap, deps);
    assert.equal(candidate.context?.leftPct, 30);
    assert.equal(candidate.context?.usedPct, 70);
  });

  test('A snapshot without context_window yields no context sub-object (undefined-in, undefined-out)', () => {
    const snap = {
      model: { id: 'claude-opus-4' },
      rate_limits: { five_hour: { used_percentage: 50 } },
    };
    const candidate = snapshotToCockpitCandidate(snap, deps);
    assert.equal(candidate.context, undefined);
  });

  test('The leaky full payload is rejected (.strict() allowlist)', () => {
    assert.throws(() => snapshotToCockpitCandidate(loadLeaky(), deps));
  });

  test('A forbidden value in model.id is rejected without echoing the value', () => {
    const snap = {
      model: { id: PRIVACY_SENTINELS.fakeApiKey },
      rate_limits: { five_hour: { used_percentage: 42 } },
    };
    try {
      snapshotToCockpitCandidate(snap, deps);
      assert.fail('expected forbidden model.id content to be rejected');
    } catch (err) {
      assert.ok(err instanceof PrivacyViolationError);
      assert.ok(!String((err as Error).message).includes(PRIVACY_SENTINELS.fakeApiKey));
      assert.match((err as Error).message, /forbidden-content:model-id/);
    }
  });

  test('Serialized candidate carries no raw path or git-remote', () => {
    const candidate = snapshotToCockpitCandidate(loadClean(), deps);
    const serialized = JSON.stringify(candidate);
    assert.ok(!serialized.includes('/Users/'));
    assert.ok(!serialized.includes('/home/'));
    assert.ok(!serialized.includes('.git'));
  });
});
