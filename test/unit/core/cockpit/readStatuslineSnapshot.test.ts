// ReadStatuslineSnapshotCandidate must surface EXPLICIT
// sanitized statuses (loaded / missing / parse_failed / missing_rate_limits)
// instead of silently swallowing failures and letting stats-cache masquerade as
// a statusLine snapshot. No raw path / raw session id appears in the result.

import * as assert from 'node:assert/strict';
import { readStatuslineSnapshotCandidate } from '../../../../src/core/cockpit/readStatuslineSnapshot';
import { IdHasher } from '../../../../src/security/IdHasher';

const hasher = new IdHasher('test-salt-0123456789');
const now = (): Date => new Date('2026-06-11T12:00:00.000Z');

const UAT_SNAPSHOT = {
  source: 'claude_statusline',
  session_id_hash: '7c8f0f43d0f96827',
  workspace_hash: '58844f10d95e5fa7',
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  cost: { total_cost_usd: 540.8158384999998 },
  rate_limits: {
    five_hour: { used_percentage: 62, resets_at_iso: '2026-06-11T17:30:00Z' },
    seven_day: { used_percentage: 34, resets_at_iso: '2026-06-15T00:00:00Z' },
  },
};

suite('ReadStatuslineSnapshotCandidate: sanitized statuses, no silent fallback (UAT #4)', () => {
  test('Valid snapshot -> statusline_snapshot_loaded with a candidate', () => {
    const result = readStatuslineSnapshotCandidate('/any/path', {
      readFile: () => JSON.stringify(UAT_SNAPSHOT),
      hasher,
      now,
    });
    assert.equal(result.status, 'statusline_snapshot_loaded');
    assert.ok(result.candidate);
    assert.equal(result.candidate?.session?.usedPct, 62);
    assert.equal(result.candidate?.sessionHash, '7c8f0f43d0f96827');
  });

  test('Absent file -> statusline_snapshot_missing (no candidate, no throw)', () => {
    const result = readStatuslineSnapshotCandidate('/any/path', {
      readFile: () => {
        throw new Error('ENOENT');
      },
      hasher,
      now,
    });
    assert.equal(result.status, 'statusline_snapshot_missing');
    assert.equal(result.candidate, undefined);
  });

  test('Invalid JSON -> statusline_snapshot_parse_failed (not silent fallback)', () => {
    const result = readStatuslineSnapshotCandidate('/any/path', {
      readFile: () => '{ not json',
      hasher,
      now,
    });
    assert.equal(result.status, 'statusline_snapshot_parse_failed');
    assert.equal(result.candidate, undefined);
  });

  test('Leaky payload (schema reject) -> statusline_snapshot_parse_failed', () => {
    const leaky = { ...UAT_SNAPSHOT, cwd: '/home/dev/secret', workspace: { current_dir: '/x' } };
    const result = readStatuslineSnapshotCandidate('/any/path', {
      readFile: () => JSON.stringify(leaky),
      hasher,
      now,
    });
    assert.equal(result.status, 'statusline_snapshot_parse_failed');
  });

  test('Snapshot without rate_limits -> statusline_snapshot_missing_rate_limits (candidate kept for cost/model)', () => {
    const noLimits = {
      source: 'claude_statusline',
      session_id_hash: '7c8f0f43d0f96827',
      model: { id: 'claude-opus-4-8' },
      cost: { total_cost_usd: 540.8158384999998 },
    };
    const result = readStatuslineSnapshotCandidate('/any/path', {
      readFile: () => JSON.stringify(noLimits),
      hasher,
      now,
    });
    assert.equal(result.status, 'statusline_snapshot_missing_rate_limits');
    assert.ok(result.candidate);
    assert.equal(result.candidate?.cost, 540.8158384999998);
    assert.equal(result.candidate?.unavailableReason, 'statusline_snapshot_missing_rate_limits');
  });

  test('No raw path or session id leaks into the result', () => {
    const result = readStatuslineSnapshotCandidate('/home/dev/secret/path', {
      readFile: () => JSON.stringify(UAT_SNAPSHOT),
      hasher,
      now,
    });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('/home/dev/secret'));
    assert.ok(!serialized.includes('session_id"'));
  });
});
