// ClaudeStatsCacheSource unit tests (fixture-based).
//
// stats-cache.json is a NATIVE structured token-detail source: per-model
// input/output/cache tokens, costUSD, contextWindow. It populates ONLY
// token-detail/model/cost candidates — NEVER session/5h or weekly/7d limit
// fields. A missing file fails closed (no throw, no candidate, a
// documented reason). No exec, no network — a bounded local file read only.
// Verification is fixture-based and tolerates the live file's absence.

import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  parseStatsCache,
  readStatsCacheCandidates,
} from '../../../../src/adapters/claudeCode/ClaudeStatsCacheSource';
import { findRepoRoot } from '../../../_helpers/repoRoot';

const FIXTURE = join(findRepoRoot(), 'test', 'fixtures', 'cockpit', 'claude-stats-cache.json');
const now = (): Date => new Date('2026-06-11T12:00:00.000Z');

suite('ClaudeStatsCacheSource: structured token-detail', () => {
  test('Fixture parses to allowlisted per-model token-detail candidates', () => {
    const candidates = readStatsCacheCandidates(FIXTURE, { now });
    assert.ok(candidates.length >= 1);
    const sonnet = candidates.find((c) => c.model === 'claude-sonnet-4-6');
    assert.ok(sonnet);
    // Distinct native label — never conflated with the live statusLine snapshot.
    assert.equal(sonnet?.sourceTier, 'stats_cache_snapshot');
    assert.equal(sonnet?.cost, 12.5);
    assert.equal(sonnet?.scope.provider, 'anthropic');
    assert.equal(sonnet?.scope.agent, 'claude-code');
  });

  test('Candidates NEVER populate session/5h or weekly/7d limit fields', () => {
    const candidates = readStatsCacheCandidates(FIXTURE, { now });
    for (const c of candidates) {
      assert.equal(c.session, undefined);
      assert.equal(c.weekly, undefined);
    }
  });

  test('The raw longestSession.sessionId is never ingested', () => {
    const candidates = readStatsCacheCandidates(FIXTURE, { now });
    const serialized = JSON.stringify(candidates);
    assert.ok(!serialized.includes('should-never-be-ingested'));
    assert.ok(!serialized.includes('sessionId'));
  });

  test('A missing file fails closed: no throw, no candidate', () => {
    const candidates = readStatsCacheCandidates(join(findRepoRoot(), 'nope-missing-stats.json'), {
      now,
    });
    assert.deepEqual(candidates, []);
  });

  test('ParseStatsCache rejects extra/leaky top-level keys via the allowlist (.strict on models)', () => {
    // An entry with a forbidden extra field in a model row fails the strict
    // per-model schema, producing no candidate for that row.
    const result = parseStatsCache({
      modelUsage: {
        'm-1': { inputTokens: 1, outputTokens: 2, costUSD: 3, leakyExtra: 'x' },
      },
    });
    assert.equal(result.ok, false);
  });

  test('ParseStatsCache accepts a clean per-model row', () => {
    const result = parseStatsCache({
      modelUsage: {
        'm-1': { inputTokens: 1, outputTokens: 2, costUSD: 3, contextWindow: 200000 },
      },
    });
    assert.equal(result.ok, true);
  });
});
