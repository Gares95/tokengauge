import * as assert from 'node:assert/strict';
import type { SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';
import { checkClaudeNativeSource } from '../../../src/core/sourceDoctor/checkClaudeNativeSource';
import { IdHasher } from '../../../src/security/IdHasher';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const hasher = new IdHasher('test-salt-0123456789');

const VALID_SNAPSHOT = {
  source: 'claude_statusline',
  session_id_hash: '7c8f0f43d0f96827',
  workspace_hash: '58844f10d95e5fa7',
  model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
  cost: { total_cost_usd: 12.34 },
  rate_limits: {
    five_hour: { used_percentage: 62, resets_at_iso: '2026-09-03T17:00:00Z' },
    seven_day: { used_percentage: 34, resets_at_iso: '2026-09-08T00:00:00Z' },
  },
};

function baseInput(overrides: Partial<Parameters<typeof checkClaudeNativeSource>[0]> = {}) {
  return {
    visible: true,
    configuredLocation: '/configured/source',
    statsCacheLocation: '/configured/stats',
    readFile: () => JSON.stringify(VALID_SNAPSHOT),
    isDirectory: () => false,
    listDir: () => [],
    join: (...parts: string[]) => parts.join('/'),
    hasher,
    now: () => NOW,
    readStatsCacheCandidates: () => [],
    ...overrides,
  } satisfies Parameters<typeof checkClaudeNativeSource>[0];
}

function ruleIds(report: ReturnType<typeof checkClaudeNativeSource>): string[] {
  return report.findings.map((finding) => finding.ruleId);
}

suite('Native Source Doctor — Claude checks', () => {
  test('Hidden Claude card performs no snapshot or stats-cache reads', () => {
    let reads = 0;
    let statsReads = 0;
    const report = checkClaudeNativeSource(
      baseInput({
        visible: false,
        readFile: () => {
          reads += 1;
          throw new Error('must not read');
        },
        readStatsCacheCandidates: () => {
          statsReads += 1;
          return [];
        },
      }),
    );

    assert.equal(report.visible, false);
    assert.deepEqual(ruleIds(report), ['doctor_claude_card_hidden']);
    assert.equal(reads, 0);
    assert.equal(statsReads, 0);
  });

  test('Missing configured snapshot reports a setup warning without fabricating data', () => {
    const report = checkClaudeNativeSource(baseInput({ configuredLocation: '' }));

    assert.deepEqual(ruleIds(report), [
      'doctor_claude_snapshot_not_configured',
      'doctor_claude_stats_cache_unavailable',
    ]);
    assert.equal(report.findings[0]?.severity, 'warning');
  });

  test('Readable single-file snapshot reports recognized short and weekly windows', () => {
    const report = checkClaudeNativeSource(baseInput());
    const loaded = report.findings.find(
      (finding) => finding.ruleId === 'doctor_claude_snapshot_loaded',
    );

    assert.ok(loaded);
    assert.equal(loaded.severity, 'ok');
    assert.deepEqual(
      loaded.facts?.find((fact) => fact.name === 'recognized windows')?.value,
      'short, weekly',
    );
  });

  test('Snapshot without rate-limit windows remains incomplete, not zero or unlimited', () => {
    const report = checkClaudeNativeSource(
      baseInput({
        readFile: () =>
          JSON.stringify({
            source: 'claude_statusline',
            session_id_hash: '7c8f0f43d0f96827',
            model: { id: 'claude-opus-4-8' },
          }),
      }),
    );

    const incomplete = report.findings.find(
      (finding) => finding.ruleId === 'doctor_claude_snapshot_missing_rate_limits',
    );
    assert.ok(incomplete);
    assert.equal(incomplete.severity, 'warning');
    assert.deepEqual(
      incomplete.facts?.find((fact) => fact.name === 'recognized windows')?.value,
      'none',
    );
  });

  test('Directory mode distinguishes no active writer from a bad snapshot source', () => {
    const report = checkClaudeNativeSource(
      baseInput({
        isDirectory: () => true,
        listDir: () => [],
      }),
    );

    assert.ok(ruleIds(report).includes('doctor_claude_snapshot_directory_no_active_writer'));
    assert.equal(
      report.findings.find(
        (finding) => finding.ruleId === 'doctor_claude_snapshot_directory_no_active_writer',
      )?.severity,
      'warning',
    );
  });

  test('Stats-cache availability is reported as optional cost/model detail', () => {
    const statsCandidate: SourceCandidate = {
      sourceTier: 'stats_cache_snapshot',
      producedAtMs: NOW.getTime(),
      scope: { provider: 'anthropic', agent: 'claude-code', model: 'claude-opus-4-8' },
      confidence: 'medium',
      model: 'claude-opus-4-8',
      cost: 1.23,
    };
    const report = checkClaudeNativeSource(
      baseInput({ readStatsCacheCandidates: () => [statsCandidate] }),
    );

    const stats = report.findings.find(
      (finding) => finding.ruleId === 'doctor_claude_stats_cache_loaded',
    );
    assert.ok(stats);
    assert.equal(stats.severity, 'ok');
    assert.deepEqual(stats.facts?.find((fact) => fact.name === 'candidate count')?.value, 1);
  });
});
