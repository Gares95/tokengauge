import * as assert from 'node:assert/strict';
import { buildNativeSourceDoctorReport } from '../../../src/core/sourceDoctor/NativeSourceDoctor';
import { IdHasher } from '../../../src/security/IdHasher';

const hasher = new IdHasher('test-salt-0123456789');

suite('Native Source Doctor — report builder', () => {
  test('Builds a provider-neutral report with host scope and both providers', () => {
    const report = buildNativeSourceDoctorReport({
      generatedAtMs: Date.parse('2026-09-03T12:00:00.000Z'),
      remoteLabel: 'wsl',
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
    assert.equal(report.host.codexProbeScope, 'workspace');
    assert.deepEqual(
      report.providers.map((provider) => provider.provider),
      ['claude', 'codex'],
    );
  });
});
