// The per-agent native candidate gatherer
// + the builder's blocker-reason override that surfaces the honest closed-set
// reasons (statusline_snapshot_not_configured / codex_probe_disabled) on the
// always-present cards.

import * as assert from 'node:assert/strict';
import { buildGaugeCardViewModels } from '../../../src/cockpit/GaugeCardViewModel';
import {
  gatherNativeCockpitCandidates,
  resolveStatuslineSnapshotPath,
} from '../../../src/cockpit/gatherNativeCockpitCandidates';
import { snapshotToCockpitCandidate } from '../../../src/core/cockpit/ClaudeStatuslineCockpitSource';
import {
  COCKPIT_FIELD_REASONS,
  type CockpitFieldReason,
} from '../../../src/core/cockpit/CockpitState';
import type { SourceCandidate } from '../../../src/core/cockpit/SourcePriorityResolver';
import { IdHasher } from '../../../src/security/IdHasher';

const NOW = new Date('2026-06-13T12:00:00.000Z');
const now = () => NOW;
const hasher = new IdHasher('test-salt-0123456789');

function cardFor(cards: readonly { agent: string }[], agent: string) {
  const card = cards.find((c) => c.agent === agent);
  assert.ok(card, `expected a card for agent ${agent}`);
  return card as ReturnType<typeof buildGaugeCardViewModels>[number];
}

suite('ResolveStatuslineSnapshotPath (native-only: the configured file path)', () => {
  const join = (...parts: string[]) => parts.join('/');
  const homedir = () => '/home/dev';

  test('Explicit statuslineSnapshotPath is the exact file', () => {
    const path = resolveStatuslineSnapshotPath({
      statuslineSnapshotPath: '/exact/snapshot.json',
      join,
    });
    assert.equal(path, '/exact/snapshot.json');
  });

  test('No configured path → undefined (not-configured world)', () => {
    const path = resolveStatuslineSnapshotPath({ statuslineSnapshotPath: '', join });
    assert.equal(path, undefined);
  });

  // Node readFileSync does not expand `~`; a leading tilde segment
  // must expand to the user home dir.
  test('A bare ~ explicit path expands to the home dir', () => {
    const path = resolveStatuslineSnapshotPath({ statuslineSnapshotPath: '~', join, homedir });
    assert.equal(path, '/home/dev');
  });

  test('A ~/x/y.json explicit path expands the leading tilde segment', () => {
    const path = resolveStatuslineSnapshotPath({
      statuslineSnapshotPath: '~/.claude/statusline-snapshot.json',
      join,
      homedir,
    });
    assert.equal(path, '/home/dev/.claude/statusline-snapshot.json');
  });

  test('An absolute explicit path is unchanged', () => {
    const path = resolveStatuslineSnapshotPath({
      statuslineSnapshotPath: '/exact/snapshot.json',
      join,
      homedir,
    });
    assert.equal(path, '/exact/snapshot.json');
  });

  test('A non-tilde relative explicit path is unchanged', () => {
    const path = resolveStatuslineSnapshotPath({
      statuslineSnapshotPath: 'logs/statusline-snapshot.json',
      join,
      homedir,
    });
    assert.equal(path, 'logs/statusline-snapshot.json');
  });

  test('A mid-path ~ is NEVER expanded (only a leading segment)', () => {
    const path = resolveStatuslineSnapshotPath({
      statuslineSnapshotPath: '/var/~weird/snapshot.json',
      join,
      homedir,
    });
    assert.equal(path, '/var/~weird/snapshot.json');
  });

  test('The configured explicit path is the one read by the gatherer', () => {
    const explicit = '/exact/explicit-snapshot.json';
    const resolved = resolveStatuslineSnapshotPath({ statuslineSnapshotPath: explicit, join });
    assert.equal(resolved, explicit);

    const readPaths: string[] = [];
    gatherNativeCockpitCandidates({
      statuslineSnapshotPath: resolved,
      statsCachePath: '/missing/stats-cache.json',
      hasher,
      now,
      readFile: (p) => {
        readPaths.push(p);
        throw new Error('ENOENT');
      },
      readStatsCache: () => [],
      codexProbeEnabled: false,
    });
    assert.ok(readPaths.includes(explicit), 'the explicit path is the one read');
  });
});

suite('SnapshotToCockpitCandidate carries the writer capture time', () => {
  const deps = { hasher, now };

  test('A valid ISO timestamp parses to epoch ms on snapshotCapturedAtMs', () => {
    const candidate = snapshotToCockpitCandidate(
      {
        timestamp: '2026-06-13T11:59:30.000Z',
        model: { id: 'claude-opus-4' },
        rate_limits: { five_hour: { used_percentage: 82 } },
      },
      deps,
    );
    assert.equal(candidate.snapshotCapturedAtMs, new Date('2026-06-13T11:59:30.000Z').getTime());
    assert.equal(candidate.producedAtMs, NOW.getTime());
  });

  test('An absent timestamp leaves snapshotCapturedAtMs undefined', () => {
    const candidate = snapshotToCockpitCandidate(
      { model: { id: 'claude-opus-4' }, rate_limits: { five_hour: { used_percentage: 82 } } },
      deps,
    );
    assert.equal(candidate.snapshotCapturedAtMs, undefined);
  });

  test('A garbage timestamp leaves snapshotCapturedAtMs undefined', () => {
    const candidate = snapshotToCockpitCandidate(
      {
        timestamp: 'not-a-date',
        model: { id: 'claude-opus-4' },
        rate_limits: { five_hour: { used_percentage: 82 } },
      },
      deps,
    );
    assert.equal(candidate.snapshotCapturedAtMs, undefined);
  });
});

suite('Snapshot_writer_collision is a member of the closed reason set', () => {
  test('The reason is in COCKPIT_FIELD_REASONS', () => {
    const reason: CockpitFieldReason = 'snapshot_writer_collision';
    assert.ok(COCKPIT_FIELD_REASONS.includes(reason));
  });
});

suite('GatherNativeCockpitCandidates', () => {
  test('No snapshot path → emits the statusline_snapshot_not_configured blocker', () => {
    const candidates = gatherNativeCockpitCandidates({
      statuslineSnapshotPath: undefined,
      statsCachePath: '/missing/stats-cache.json',
      hasher,
      now,
      readFile: () => {
        throw new Error('should not be read');
      },
      readStatsCache: () => [],
      codexProbeEnabled: false,
    });
    const claudeBlocker = candidates.find(
      (c) => c.scope.agent === 'claude-code' && c.unavailableReason !== undefined,
    );
    assert.ok(claudeBlocker, 'expected a claude blocker candidate');
    assert.equal(claudeBlocker.unavailableReason, 'statusline_snapshot_not_configured');
    assert.equal(claudeBlocker.sourceTier, 'unknown');
    assert.equal(claudeBlocker.session, undefined);
  });

  test('Codex probe disabled → emits the codex_probe_disabled blocker', () => {
    const candidates = gatherNativeCockpitCandidates({
      statuslineSnapshotPath: undefined,
      statsCachePath: '/missing/stats-cache.json',
      hasher,
      now,
      readFile: () => {
        throw new Error('nope');
      },
      readStatsCache: () => [],
      codexProbeEnabled: false,
    });
    const codexBlocker = candidates.find((c) => c.scope.agent === 'codex');
    assert.ok(codexBlocker, 'expected a codex blocker candidate');
    assert.equal(codexBlocker.unavailableReason, 'codex_probe_disabled');
    assert.equal(codexBlocker.scope.provider, 'openai');
  });

  test('Codex probe enabled → NO codex blocker (the loop supplies the live candidate)', () => {
    const candidates = gatherNativeCockpitCandidates({
      statuslineSnapshotPath: undefined,
      statsCachePath: '/missing/stats-cache.json',
      hasher,
      now,
      readFile: () => {
        throw new Error('nope');
      },
      readStatsCache: () => [],
      codexProbeEnabled: true,
    });
    assert.ok(candidates.every((c) => c.scope.agent !== 'codex'));
  });

  test('Hidden Claude skips cockpit stats-cache and statusline read seams', () => {
    let readFileCalls = 0;
    let readStatsCacheCalls = 0;
    let isDirectoryCalls = 0;
    let listDirCalls = 0;
    const diagnostics: string[] = [];

    const candidates = gatherNativeCockpitCandidates({
      claudeVisible: false,
      statuslineSnapshotPath: '/configured/statusline.json',
      statsCachePath: '/configured/stats-cache.json',
      hasher,
      now,
      readFile: () => {
        readFileCalls += 1;
        throw new Error('should not read statusline when hidden');
      },
      readStatsCache: () => {
        readStatsCacheCalls += 1;
        return [];
      },
      isDirectory: () => {
        isDirectoryCalls += 1;
        return true;
      },
      listDir: () => {
        listDirCalls += 1;
        return [];
      },
      join: (...parts) => parts.join('/'),
      diagnostics: {
        record: (entry) => diagnostics.push(entry.status),
      },
      codexProbeEnabled: false,
    });

    assert.equal(readStatsCacheCalls, 0, 'hidden Claude must not read stats-cache');
    assert.equal(readFileCalls, 0, 'hidden Claude must not read statusline snapshots');
    assert.equal(isDirectoryCalls, 0, 'hidden Claude must not inspect directory mode');
    assert.equal(listDirCalls, 0, 'hidden Claude must not list snapshot directories');
    assert.deepEqual(diagnostics, [], 'hidden Claude should not emit statusline diagnostics');
    assert.ok(
      candidates.some((candidate) => candidate.scope.agent === 'codex'),
      'Codex visibility is independent of hidden Claude',
    );
  });

  test('Hidden Codex omits the disabled blocker from cockpit candidates', () => {
    const candidates = gatherNativeCockpitCandidates({
      codexVisible: false,
      statuslineSnapshotPath: undefined,
      statsCachePath: '/missing/stats-cache.json',
      hasher,
      now,
      readFile: () => {
        throw new Error('nope');
      },
      readStatsCache: () => [],
      codexProbeEnabled: false,
    });

    assert.ok(
      candidates.every((candidate) => candidate.scope.agent !== 'codex'),
      'hidden Codex should not produce a card blocker',
    );
  });

  test('A missing snapshot file does not throw and yields no claude limit candidate', () => {
    const candidates = gatherNativeCockpitCandidates({
      statuslineSnapshotPath: '/configured/but-missing.json',
      statsCachePath: '/missing/stats-cache.json',
      hasher,
      now,
      readFile: () => {
        throw new Error('ENOENT');
      },
      readStatsCache: () => [],
      codexProbeEnabled: false,
    });
    assert.ok(candidates.every((c) => c.session === undefined));
  });
});

suite('GaugeCardViewModel blocker-reason override', () => {
  test('Claude blocker candidate surfaces statusline_snapshot_not_configured on the card', () => {
    const claudeBlocker: SourceCandidate = {
      sourceTier: 'unknown',
      producedAtMs: 0,
      scope: { provider: 'anthropic', agent: 'claude-code' },
      unavailableReason: 'statusline_snapshot_not_configured',
    };
    const cards = buildGaugeCardViewModels({
      candidates: [claudeBlocker],
      configuredAgents: ['claude-code', 'codex'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.reason, 'statusline_snapshot_not_configured');
    assert.equal(claude.session.reason, 'statusline_snapshot_not_configured');
    assert.equal(claude.session.state, 'unavailable');
  });

  test('Codex blocker candidate surfaces codex_probe_disabled on the card', () => {
    const codexBlocker: SourceCandidate = {
      sourceTier: 'unknown',
      producedAtMs: 0,
      scope: { provider: 'openai', agent: 'codex' },
      unavailableReason: 'codex_probe_disabled',
    };
    const cards = buildGaugeCardViewModels({
      candidates: [codexBlocker],
      configuredAgents: ['claude-code', 'codex'],
      now,
    });
    const codex = cardFor(cards, 'codex');
    assert.equal(codex.reason, 'codex_probe_disabled');
    assert.equal(codex.session.reason, 'codex_probe_disabled');
  });

  test('A blocker NEVER masks a live value (the real candidate wins)', () => {
    const live: SourceCandidate = {
      sourceTier: 'statusline_snapshot',
      producedAtMs: NOW.getTime(),
      scope: { provider: 'anthropic', agent: 'claude-code' },
      confidence: 'high',
      session: { usedPct: 50 },
    };
    const staleBlocker: SourceCandidate = {
      sourceTier: 'unknown',
      producedAtMs: 0,
      scope: { provider: 'anthropic', agent: 'claude-code' },
      unavailableReason: 'statusline_snapshot_not_configured',
    };
    const cards = buildGaugeCardViewModels({
      candidates: [live, staleBlocker],
      configuredAgents: ['claude-code'],
      now,
    });
    const claude = cardFor(cards, 'claude-code');
    assert.equal(claude.session.usedPct, 50);
    assert.notEqual(claude.session.reason, 'statusline_snapshot_not_configured');
  });
});

// A configured path that is a DIRECTORY selects the
// per-session snapshot mode; a file path keeps the legacy single-file reader.
suite('GatherNativeCockpitCandidates — snapshot directory dispatch', () => {
  const DIR_WS = 'aaaaaaaaaaaaaaaa';
  const dirBody = (sessionHash: string, usedPct: number) =>
    JSON.stringify({
      timestamp: NOW.toISOString(),
      session_id_hash: sessionHash,
      workspace_hash: DIR_WS,
      model: { id: 'claude-fable-5' },
      rate_limits: {
        five_hour: { used_percentage: usedPct, resets_at_iso: '2026-06-13T15:00:00.000Z' },
      },
    });

  function gatherDir(entries: Array<{ name: string; mtimeMs: number; body: string }>) {
    const statuses: string[] = [];
    const candidates = gatherNativeCockpitCandidates({
      statuslineSnapshotPath: '/cfg/snapshots',
      statsCachePath: '/none/stats-cache.json',
      hasher,
      now,
      readFile: (p) => {
        const hit = entries.find((e) => `/cfg/snapshots/${e.name}` === p);
        if (!hit) throw new Error('missing');
        return hit.body;
      },
      isDirectory: (p) => p === '/cfg/snapshots',
      listDir: () => entries.map(({ name, mtimeMs }) => ({ name, mtimeMs })),
      join: (...parts: string[]) => parts.join('/'),
      diagnostics: {
        record: (e) => {
          if (e.ruleId === 'statusline-snapshot') statuses.push(e.status);
        },
      },
      codexProbeEnabled: false,
    });
    return { candidates, statuses };
  }

  test('A directory path routes to per-session mode and merges two active writers', () => {
    const { candidates, statuses } = gatherDir([
      {
        name: `${DIR_WS}-1111111111111111.json`,
        mtimeMs: NOW.getTime() - 5_000,
        body: dirBody('1111111111111111', 80),
      },
      {
        name: `${DIR_WS}-2222222222222222.json`,
        mtimeMs: NOW.getTime() - 6_000,
        body: dirBody('2222222222222222', 60),
      },
    ]);
    assert.deepEqual(statuses, ['snapshot_dir_multi_writer']);
    const claude = candidates.find(
      (c) => c.scope.agent === 'claude-code' && c.sourceTier === 'statusline_snapshot',
    );
    assert.equal(claude?.unavailableReason, 'snapshot_writer_collision');
    assert.equal(claude?.session?.usedPct, 80);
    // The Codex disabled blocker is unaffected by the Claude snapshot mode.
    assert.ok(candidates.some((c) => c.unavailableReason === 'codex_probe_disabled'));
  });

  test('A directory with one active writer yields that session, status loaded', () => {
    const { candidates, statuses } = gatherDir([
      {
        name: `${DIR_WS}-1111111111111111.json`,
        mtimeMs: NOW.getTime() - 5_000,
        body: dirBody('1111111111111111', 42),
      },
    ]);
    assert.deepEqual(statuses, ['snapshot_dir_loaded']);
    const claude = candidates.find((c) => c.sourceTier === 'statusline_snapshot');
    assert.equal(claude?.session?.usedPct, 42);
    assert.equal(claude?.unavailableReason, undefined);
  });

  test('A FILE path (isDirectory false) keeps the legacy single-file reader', () => {
    const statuses: string[] = [];
    const body = dirBody('1111111111111111', 55);
    const candidates = gatherNativeCockpitCandidates({
      statuslineSnapshotPath: '/cfg/statusline-snapshot.json',
      statsCachePath: '/none/stats-cache.json',
      hasher,
      now,
      readFile: (p) => {
        if (p !== '/cfg/statusline-snapshot.json') throw new Error('missing');
        return body;
      },
      isDirectory: () => false,
      listDir: () => {
        throw new Error('must not be called in single-file mode');
      },
      join: (...parts: string[]) => parts.join('/'),
      diagnostics: {
        record: (e) => {
          if (e.ruleId === 'statusline-snapshot') statuses.push(e.status);
        },
      },
      codexProbeEnabled: false,
    });
    assert.deepEqual(statuses, ['statusline_snapshot_loaded']);
    assert.equal(
      candidates.find((c) => c.sourceTier === 'statusline_snapshot')?.session?.usedPct,
      55,
    );
  });
});
