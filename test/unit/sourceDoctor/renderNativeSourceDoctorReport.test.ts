import * as assert from 'node:assert/strict';
import { renderNativeSourceDoctorReport } from '../../../src/core/sourceDoctor/renderNativeSourceDoctorReport';
import type { NativeSourceDoctorReport } from '../../../src/core/sourceDoctor/types';
import { PRIVACY_SENTINELS, type PrivacySentinelKind } from '../../fixtures/privacy/sentinels';

function assertSentinelAbsent(haystack: string, kind: PrivacySentinelKind): void {
  if (haystack.includes(PRIVACY_SENTINELS[kind])) {
    assert.fail(`sentinel category leaked into Doctor report: ${kind}`);
  }
}

suite('Native Source Doctor — renderer', () => {
  test('Renders the expected readonly sections and next actions', () => {
    const rendered = renderNativeSourceDoctorReport({
      generatedAtMs: Date.parse('2026-09-03T12:00:00.000Z'),
      host: { remoteKind: 'local', claudeSnapshotScope: 'workspace', codexProbeScope: 'user' },
      providers: [
        {
          provider: 'claude',
          displayName: 'Claude Code',
          visible: true,
          findings: [
            {
              ruleId: 'doctor_claude_snapshot_not_configured',
              severity: 'warning',
              title: 'Claude statusLine snapshot is not configured',
              message: 'TokenGauge has no Claude statusLine snapshot source to read.',
              action: 'Run Configure Cockpit.',
            },
          ],
        },
      ],
    });

    assert.equal(rendered.heading, 'TokenGauge: Native Source Doctor');
    assert.match(rendered.body, /^# TokenGauge: Native Source Doctor/);
    assert.match(rendered.body, /## Extension host and settings scope/);
    assert.match(rendered.body, /## Provider visibility and checks/);
    assert.match(rendered.body, /## Recommended next actions/);
    assert.match(rendered.body, /Claude snapshot effective scope: workspace/);
    assert.match(rendered.body, /Codex probe effective scope: user/);
    assert.match(rendered.body, /readonly, local-only, no settings writes/);
  });

  test('Redacts sentinel strings from provider text before rendering', () => {
    const report: NativeSourceDoctorReport = {
      generatedAtMs: Date.parse('2026-09-03T12:00:00.000Z'),
      host: {
        remoteKind: 'remote',
        remoteLabel: PRIVACY_SENTINELS.fakePosixPath,
        claudeSnapshotScope: 'workspace',
        codexProbeScope: 'workspaceFolder',
      },
      providers: [
        {
          provider: 'codex',
          displayName: `Codex ${PRIVACY_SENTINELS.fakeGitRemote}`,
          visible: true,
          findings: [
            {
              ruleId: 'doctor_codex_probe_stage',
              severity: 'warning',
              title: PRIVACY_SENTINELS.fakeApiKey,
              message: PRIVACY_SENTINELS.fakeOAuthBearer,
              action: PRIVACY_SENTINELS.fakeWindowsPath,
              facts: [
                { name: 'sentinel', value: PRIVACY_SENTINELS.fakePrompt },
                { name: 'ok boolean', value: true },
              ],
            },
          ],
        },
      ],
    };

    const rendered = renderNativeSourceDoctorReport(report);
    for (const kind of Object.keys(PRIVACY_SENTINELS) as readonly PrivacySentinelKind[]) {
      assertSentinelAbsent(rendered.body, kind);
    }
    assert.match(rendered.body, /\[redacted:/);
  });
});
