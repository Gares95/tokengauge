import { redactString } from '../../security/Redactor';
import {
  highestNativeSourceDoctorSeverity,
  type NativeSourceDoctorFinding,
  type NativeSourceDoctorProviderReport,
  type NativeSourceDoctorRenderedReport,
  type NativeSourceDoctorReport,
  type NativeSourceDoctorSeverity,
} from './types';

const HEADING = 'TokenGauge: Native Source Doctor';

const SEVERITY_LABELS: Readonly<Record<NativeSourceDoctorSeverity, string>> = {
  ok: 'OK',
  info: 'Info',
  warning: 'Warning',
  blocked: 'Blocked',
};

function safeText(value: string): string {
  return redactString(value).replace(/\s+/g, ' ').trim();
}

function safeValue(value: string | number | boolean): string {
  if (typeof value === 'string') return safeText(value);
  return String(value);
}

function renderFacts(finding: NativeSourceDoctorFinding): string[] {
  const facts = finding.facts ?? [];
  if (facts.length === 0) return [];
  return facts.map((fact) => `  - ${safeText(fact.name)}: ${safeValue(fact.value)}`);
}

function renderFinding(finding: NativeSourceDoctorFinding): string[] {
  return [
    `- **${SEVERITY_LABELS[finding.severity]}** \`${finding.ruleId}\` - ${safeText(finding.title)}`,
    `  - ${safeText(finding.message)}`,
    ...renderFacts(finding),
    ...(finding.action !== undefined ? [`  - Next action: ${safeText(finding.action)}`] : []),
  ];
}

function providerSummary(provider: NativeSourceDoctorProviderReport): string {
  const highest = highestNativeSourceDoctorSeverity(provider.findings);
  return `${provider.displayName}: ${SEVERITY_LABELS[highest]}`;
}

function nextActions(report: NativeSourceDoctorReport): string[] {
  const actions = new Map<string, NativeSourceDoctorFinding>();
  for (const provider of report.providers) {
    for (const finding of provider.findings) {
      if (finding.action !== undefined && finding.severity !== 'ok') {
        actions.set(finding.action, finding);
      }
    }
  }
  if (actions.size === 0) {
    return ['- No setup action is currently recommended.'];
  }
  return [...actions.entries()].map(
    ([action, finding]) => `- ${safeText(action)} (from \`${finding.ruleId}\`)`,
  );
}

export function renderNativeSourceDoctorReport(
  report: NativeSourceDoctorReport,
): NativeSourceDoctorRenderedReport {
  const generatedAt = new Date(report.generatedAtMs).toISOString();
  const remoteLine =
    report.host.remoteKind === 'remote'
      ? `remote (${safeText(report.host.remoteLabel ?? 'unknown')})`
      : 'local';
  const lines: string[] = [
    `# ${HEADING}`,
    '',
    'Sanitized setup health report. No raw paths, prompts, logs, credentials, provider payloads, account identifiers, or secrets are shown.',
    '',
    '## Summary',
    `- generated at: ${generatedAt}`,
    ...report.providers.map((provider) => `- ${safeText(providerSummary(provider))}`),
    '',
    '## Extension host and settings scope',
    `- extension host: ${remoteLine}`,
    `- Claude snapshot effective scope: ${report.host.claudeSnapshotScope}`,
    `- Codex probe effective scope: ${report.host.codexProbeScope}`,
    '- Doctor posture: user-triggered, readonly, local-only, no settings writes.',
    '',
    '## Provider visibility and checks',
  ];

  for (const provider of report.providers) {
    lines.push('', `### ${safeText(provider.displayName)}`, `- card visible: ${provider.visible}`);
    for (const finding of provider.findings) {
      lines.push(...renderFinding(finding));
    }
  }

  lines.push('', '## Recommended next actions', ...nextActions(report));
  return { heading: HEADING, body: lines.join('\n') };
}
