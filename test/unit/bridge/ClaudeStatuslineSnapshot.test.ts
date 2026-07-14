// ClaudeStatuslineSnapshotSchema unit tests.
//
// Assert the strict allowlist boundary for the opt-in Claude statusLine bridge:
// the clean fixture parses; the leaky full payload (cwd / workspace.* /
// workspace.repo.* / api_key) FAILS `.strict()` by construction; session_id is
// present in the parsed shape but is NOT itself persisted (the bridge hashes it
// — proven in the bridge test, not here); out-of-range used_percentage fails.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeStatuslineSnapshotSchema,
  STATUSLINE_SNAPSHOT_FIELD_ALLOWLIST,
} from '../../../src/bridge/ClaudeStatuslineSnapshotSchema';
import { findRepoRoot } from '../../_helpers/repoRoot';
import { PRIVACY_SENTINELS } from '../../fixtures/privacy/sentinels';

const FIXTURE_DIR = join(findRepoRoot(), 'test', 'fixtures', 'statusline');

function loadClean(): Record<string, unknown> {
  const raw = readFileSync(join(FIXTURE_DIR, 'statusline-snapshot-clean.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

// Fill the inert placeholder slots in the committed leaky fixture with real
// fragment-assembled sentinels at runtime. No committed file ever holds a
// contiguous forbidden literal (mirrors test/fixtures/privacy/sentinels.ts).
function loadLeakyWithSentinels(): Record<string, unknown> {
  let json = readFileSync(join(FIXTURE_DIR, 'statusline-snapshot-leaky.json'), 'utf8');
  json = json
    .replaceAll('__SENTINEL_SLOT_PATH__', PRIVACY_SENTINELS.fakePosixPath)
    .replaceAll('__SENTINEL_SLOT_GITREMOTE__', PRIVACY_SENTINELS.fakeGitRemote)
    .replaceAll('__SENTINEL_SLOT_APIKEY__', PRIVACY_SENTINELS.fakeApiKey);
  return JSON.parse(json) as Record<string, unknown>;
}

suite('ClaudeStatuslineSnapshotSchema: safe-field allowlist', () => {
  test('The clean fixture parses successfully', () => {
    const parsed = ClaudeStatuslineSnapshotSchema.parse(loadClean());
    assert.equal(parsed.model.id, 'claude-opus-4');
    assert.equal(parsed.rate_limits?.five_hour?.used_percentage, 42);
    assert.equal(parsed.rate_limits?.seven_day?.used_percentage, 71);
    assert.equal(parsed.session_id, '11111111-2222-3333-4444-555555555555');
  });

  test('The leaky full payload fails .strict() parse (extra forbidden keys)', () => {
    assert.throws(() => ClaudeStatuslineSnapshotSchema.parse(loadLeakyWithSentinels()));
  });

  test('A top-level cwd key causes parse failure', () => {
    const candidate = { ...loadClean(), cwd: '/some/raw/path' };
    assert.throws(() => ClaudeStatuslineSnapshotSchema.parse(candidate));
  });

  test('A workspace object causes parse failure', () => {
    const candidate = { ...loadClean(), workspace: { current_dir: '/some/raw/path' } };
    assert.throws(() => ClaudeStatuslineSnapshotSchema.parse(candidate));
  });

  test('A nested unknown/leaky key under model fails .strict() parse', () => {
    const candidate = loadClean();
    // display_name is now an allowlisted safe field; a genuinely-unknown key
    // (e.g. a smuggled path field) must still be rejected by .strict().
    (candidate.model as Record<string, unknown>).current_dir = '/home/dev/secret';
    assert.throws(() => ClaudeStatuslineSnapshotSchema.parse(candidate));
  });

  test('Session_id is present in the parsed shape (hashed later, not persisted raw)', () => {
    const parsed = ClaudeStatuslineSnapshotSchema.parse(loadClean());
    assert.equal(typeof parsed.session_id, 'string');
  });

  test('An out-of-range used_percentage (>100) fails validation', () => {
    const candidate = loadClean();
    (
      (candidate.rate_limits as Record<string, unknown>).five_hour as Record<string, unknown>
    ).used_percentage = 101;
    assert.throws(() => ClaudeStatuslineSnapshotSchema.parse(candidate));
  });

  test('The field allowlist names only safe bounded fields (no cwd/workspace/repo)', () => {
    const allow = new Set<string>(STATUSLINE_SNAPSHOT_FIELD_ALLOWLIST);
    assert.ok(!allow.has('cwd'));
    assert.ok(!allow.has('workspace'));
    assert.ok(!allow.has('repo'));
    assert.ok(allow.has('model'));
    assert.ok(allow.has('rate_limits'));
    assert.ok(allow.has('session_id'));
  });
});
