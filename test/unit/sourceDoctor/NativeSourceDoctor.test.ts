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
});
