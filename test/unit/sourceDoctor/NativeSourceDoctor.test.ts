import * as assert from 'node:assert/strict';
import { buildNativeSourceDoctorReport } from '../../../src/core/sourceDoctor/NativeSourceDoctor';
import { IdHasher } from '../../../src/security/IdHasher';

const hasher = new IdHasher('test-salt-0123456789');

suite('Native Source Doctor — report builder', () => {
  test('Builds a provider-neutral report with host scope and both providers', () => {
    const report = buildNativeSourceDoctorReport({
      generatedAtMs: Date.parse('2026-09-03T12:00:00.000Z'),
      remoteLabel: 'wsl',
      claudeSnapshotScope: 'workspaceFolder',
      codexProbeScope: 'workspace',
      claude: {
        visible: true,
        configuredLocation: '',
        statsCacheLocation: undefined,
        readFile: () => {
          throw new Error('not used');
        },
        isDirectory: () => false,
        listDir: () => [],
        join: (...parts: string[]) => parts.join('/'),
        hasher,
        now: () => new Date('2026-09-03T12:00:00.000Z'),
      },
      codex: {
        visible: true,
        configuredProbeEnabled: false,
        effectiveProbeEnabled: false,
        effectiveScope: 'workspace',
        lastProbeStage: 'idle',
        lastProbeIoStage: 'none',
        sawStderr: false,
        stdoutChunks: 0,
        exitBucket: 'none',
        cliResolver: 'not_found',
        cliResolverStage: 'nvm_not_found',
      },
    });

    assert.equal(report.host.remoteKind, 'remote');
    assert.equal(report.host.remoteLabel, 'wsl');
    assert.equal(report.host.claudeSnapshotScope, 'workspaceFolder');
    assert.equal(report.host.codexProbeScope, 'workspace');
    assert.deepEqual(
      report.providers.map((provider) => provider.provider),
      ['claude', 'codex'],
    );
  });
});

suite('Native Source Doctor — host report builder', () => {
  const baseDeps = () => ({
    snapshot: () => ({
      'tokenGauge.display.cards.claude.visible': false,
      'tokenGauge.display.cards.codex.visible': true,
      'tokenGauge.providers.codex.nativeStatusProbe': true,
      'tokenGauge.claude.statuslineSnapshotPath': '/raw/private/snapshot.json',
    }),
    getInstallSalt: async () => 'test-salt-0123456789',
    remoteName: () => undefined,
    inspectClaudeSnapshotScope: () => undefined,
    inspectCodexProbeScope: () => undefined,
    codexProbeState: () => ({
      lastProbeStage: 'idle' as const,
      lastProbeIoStage: 'none' as const,
      sawStderr: false,
      stdoutChunks: 0,
      exitBucket: 'none' as const,
      cliResolver: 'not_found' as const,
      cliResolverStage: 'nvm_not_found' as const,
    }),
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    homedir: () => '/home/private-user',
    join: (...parts: string[]) => parts.join('/'),
    readFile: () => {
      throw new Error('claude hidden: must not read');
    },
    isDirectory: () => false,
    listDir: () => [],
    fileMtimeMs: () => undefined,
    isFile: () => false,
    readStatsCacheCandidates: () => [],
  });

  test('Builds the production report with both providers and no raw snapshot path read', async () => {
    const { buildNativeSourceDoctorReportFromHost } = await import(
      '../../../src/commands/nativeSourceDoctorReportBuilder.js'
    );
    const report = await buildNativeSourceDoctorReportFromHost(baseDeps());

    assert.equal(report.host.remoteKind, 'local');
    assert.equal(report.host.claudeSnapshotScope, 'default');
    assert.equal(report.host.codexProbeScope, 'default');
    assert.deepEqual(
      report.providers.map((provider) => provider.provider),
      ['claude', 'codex'],
    );
    assert.equal(JSON.stringify(report).includes('/raw/private'), false);
  });

  test('Reports effective local user, workspace, and workspace-folder scopes', async () => {
    const { buildNativeSourceDoctorReportFromHost } = await import(
      '../../../src/commands/nativeSourceDoctorReportBuilder.js'
    );
    for (const [claudeInspection, codexInspection, expected] of [
      [{ globalValue: '/snapshot.json' }, { globalValue: true }, 'user'],
      [{ workspaceValue: '/snapshot.json' }, { workspaceValue: true }, 'workspace'],
      [
        { workspaceFolderValue: '/snapshot.json' },
        { workspaceFolderValue: true },
        'workspaceFolder',
      ],
    ] as const) {
      const report = await buildNativeSourceDoctorReportFromHost({
        ...baseDeps(),
        inspectClaudeSnapshotScope: () => claudeInspection,
        inspectCodexProbeScope: () => codexInspection,
      });
      assert.equal(report.host.claudeSnapshotScope, expected);
      assert.equal(report.host.codexProbeScope, expected);
    }
  });

  test('Combines remote host label with sanitized effective scopes', async () => {
    const { buildNativeSourceDoctorReportFromHost } = await import(
      '../../../src/commands/nativeSourceDoctorReportBuilder.js'
    );
    const report = await buildNativeSourceDoctorReportFromHost({
      ...baseDeps(),
      remoteName: () => 'ssh-remote',
      inspectClaudeSnapshotScope: () => ({ workspaceValue: '/private/workspace/snapshot.json' }),
      inspectCodexProbeScope: () => ({ globalValue: true }),
    });

    assert.equal(report.host.remoteKind, 'remote');
    assert.equal(report.host.remoteLabel, 'ssh-remote');
    assert.equal(report.host.claudeSnapshotScope, 'workspace');
    assert.equal(report.host.codexProbeScope, 'user');
    assert.equal(JSON.stringify(report).includes('/private/workspace'), false);
  });

  // Regression: the Doctor lister used to stop at 32 names in READDIR order
  // before anything was sorted by mtime, so once old per-session files piled up
  // the live session's file could fall past the cap and the Doctor reported "no
  // active writer" while a session was writing. More snapshot files than the
  // bounded inspection can cover must be reported as such, without per-entry
  // stats and without guessing from an arbitrary subset.
  test('A directory holding more than 32 snapshot files is reported over capacity', async () => {
    const { buildNativeSourceDoctorReportFromHost } = await import(
      '../../../src/commands/nativeSourceDoctorReportBuilder.js'
    );
    const nowMs = Date.parse('2026-09-03T12:00:00.000Z');
    const hex16 = (n: number) => n.toString(16).padStart(16, '0');
    const stale = Array.from({ length: 40 }, (_, i) => `${hex16(i + 1)}-${hex16(i + 1)}.json`);
    const live = `${hex16(0xabc)}-${hex16(0xdef)}.json`;
    const liveBody = JSON.stringify({
      timestamp: new Date(nowMs - 5_000).toISOString(),
      session_id_hash: hex16(0xdef),
      workspace_hash: hex16(0xabc),
      model: { id: 'claude-test' },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: nowMs / 1000 + 3600 } },
    });
    let entryStats = 0;
    const report = await buildNativeSourceDoctorReportFromHost({
      ...baseDeps(),
      snapshot: () => ({
        'tokenGauge.display.cards.claude.visible': true,
        'tokenGauge.display.cards.codex.visible': false,
        'tokenGauge.providers.codex.nativeStatusProbe': false,
        'tokenGauge.claude.statuslineSnapshotPath': '/cfg/snapshots',
      }),
      now: () => new Date(nowMs),
      isDirectory: (location: string) => location === '/cfg/snapshots',
      // The live session's file is listed LAST, past the 32-entry cap.
      listDir: () => [...stale, live],
      isFile: () => {
        entryStats += 1;
        return true;
      },
      fileMtimeMs: (location: string) => {
        entryStats += 1;
        return location.endsWith(live) ? nowMs - 5_000 : nowMs - 3 * 86_400_000;
      },
      readFile: (location: string) => {
        if (location.endsWith(live)) return liveBody;
        throw new Error('stale snapshot not expected to be read');
      },
      readStatsCacheCandidates: () => [],
    });
    const claude = report.providers.find((p) => p.provider === 'claude');
    const ruleIds: string[] = claude?.findings.map((f) => f.ruleId) ?? [];
    assert.ok(
      ruleIds.includes('doctor_claude_snapshot_directory_too_many_files'),
      `expected an over-capacity finding, got ${ruleIds.join(', ')}`,
    );
    assert.ok(!ruleIds.includes('doctor_claude_snapshot_directory_no_active_writer'));
    assert.equal(entryStats, 0, 'over capacity must not stat entries beyond the bound');
    assert.equal(JSON.stringify(report).includes('/cfg/snapshots'), false);
  });
});
