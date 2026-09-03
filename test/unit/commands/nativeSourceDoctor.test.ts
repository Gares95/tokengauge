import * as assert from 'node:assert/strict';
import {
  RUN_NATIVE_SOURCE_DOCTOR_COMMAND,
  runNativeSourceDoctor,
} from '../../../src/commands/nativeSourceDoctor';
import type { NativeSourceDoctorReport } from '../../../src/core/sourceDoctor/types';

function report(): NativeSourceDoctorReport {
  return {
    generatedAtMs: Date.parse('2026-09-03T12:00:00.000Z'),
    host: { remoteKind: 'local', codexProbeScope: 'default' },
    providers: [
      {
        provider: 'codex',
        displayName: 'Codex',
        visible: true,
        findings: [
          {
            ruleId: 'doctor_codex_probe_disabled',
            severity: 'info',
            title: 'Codex native probe is off',
            message: 'The explicit probe setting is disabled.',
          },
        ],
      },
    ],
  };
}

suite('Native Source Doctor command', () => {
  test('Command id is stable', () => {
    assert.equal(RUN_NATIVE_SOURCE_DOCTOR_COMMAND, 'tokenGauge.runNativeSourceDoctor');
  });

  test('Builds and renders one readonly report through injected seams', async () => {
    const rendered: string[] = [];
    const result = await runNativeSourceDoctor({
      buildReport: report,
      renderReport: async (output) => {
        rendered.push(output.body);
      },
    });

    assert.equal(result.commandId, RUN_NATIVE_SOURCE_DOCTOR_COMMAND);
    assert.equal(result.openedReport, true);
    assert.equal(rendered.length, 1);
    assert.match(rendered[0] ?? '', /^# TokenGauge: Native Source Doctor/);
  });
});
