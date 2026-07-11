// Privacy & Data Report command.
//
// The report reads as a trust report, not a raw diagnostics dump. TokenGauge is
// NATIVE-ONLY: the cockpit runs on native/statusLine snapshots and the Codex
// app-server probe. It does NOT parse conversation logs, transcripts, terminal
// buffers, or broad log roots, and it persists NO usage events. v1 has no API-key
// feature; the only data in SecretStorage is a local non-credential install salt
// used for privacy-preserving redaction/hashing. Field kinds describe schema
// categories, never raw rows. The document content is built by
// buildPrivacyReport(); rendering goes through an injected seam so this file
// stays clear of the no-UI-surface gate and is unit-testable.

import * as vscode from 'vscode';

export const OPEN_PRIVACY_REPORT_COMMAND = 'tokenGauge.openPrivacyReport' as const;

export interface PrivacyReportInput {
  readonly codexProbeEnabled: boolean;
  readonly codexCardVisible: boolean;
  readonly claudeCardVisible: boolean;
}

export interface PrivacyReport {
  readonly heading: string;
  readonly body: string;
}

const HEADING = 'TokenGauge Privacy & Data Report';

const BODY_LEAD =
  'TokenGauge is native-only: the cockpit runs on native/statusLine snapshots ' +
  'and the Codex app-server probe. It reads no conversation logs and persists no ' +
  'usage events, and it makes no developer-controlled telemetry calls.';

// Forbidden categories that are NEVER read or stored. The wording is deliberately
// precise: TokenGauge DOES read the native status surfaces you configure (the
// Claude statusLine snapshot, stats-cache/status data) and DOES inspect a small
// allowlisted set of process environment metadata to locate local CLIs — so the
// blanket "file contents" / "environment variables" / "raw paths" never-read
// claims would overclaim. The `## Scope notes` block below states those bounds.
const NEVER_STORED_FIELD_KINDS = [
  'prompts',
  'completions',
  'source code',
  'source/workspace file contents',
  'terminal output',
  'tool args/results',
  'arbitrary/raw environment variables',
  'OAuth tokens',
  'cookies',
  'raw transcripts',
  'git remote URLs',
  'raw native-payload paths',
  'conversation/agent logs',
];

// Precision caveats so the never-read list is not read as broader than the truth.
const SCOPE_NOTES = [
  '- Environment: for the opt-in Codex probe, TokenGauge may inspect a small allowlisted set of process environment metadata (such as HOME, SHELL, PATH, XDG_*, locale/user variables, and NVM_DIR) for two purposes: locating your local codex executable (which can include running your own shell non-interactively), and passing a bounded environment to the spawned codex process so it can find its own config and credentials. Raw values are not displayed or persisted.',
  '- Native surfaces: TokenGauge does read the native status surfaces you configure — such as the Claude statusLine snapshot and stats-cache/status data — but it does not read arbitrary source or workspace files.',
  '- Paths: raw native-payload paths are not displayed or persisted; configured paths are used only to locate native surfaces and are redacted in diagnostics.',
];

// Native-only headline. Every line is unconditionally true.
function nativePostureLines(input: PrivacyReportInput): string[] {
  return [
    '- The native cockpit is the only source; it reads native/statusLine snapshots.',
    '- No conversation-log scanning: there is no log parsing, no log-root resolution, and no watchers over agent logs.',
    '- No log-derived token calculation and no broad-log-root scanning.',
    '- TokenGauge persists no usage events and writes no usage-history database.',
    input.claudeCardVisible
      ? '- Claude card: visible, so TokenGauge may read the configured statusLine snapshot and local stats-cache/status data.'
      : '- Claude card: hidden, so TokenGauge does not read the Claude statusLine snapshot or stats-cache/status data.',
    input.codexProbeEnabled && input.codexCardVisible
      ? '- Codex native probe: ON and card visible (enabled by you) — TokenGauge spawns a short-lived local `codex` process; that process contacts its own backend with its own credentials. TokenGauge itself makes no network call and never reads codex credentials.'
      : input.codexProbeEnabled
        ? '- Codex native probe: setting enabled but card hidden — no `codex` process is spawned until the Codex card is visible.'
        : '- Codex native probe: off — no `codex` process is spawned.',
    '- Developer telemetry: none (no analytics, no tracking).',
    input.codexProbeEnabled && input.codexCardVisible
      ? '- TokenGauge network calls: none. The Codex native probe is enabled, so the only network is the local `codex` process above (started because you enabled the probe); TokenGauge itself makes no network request.'
      : '- TokenGauge network calls: none.',
  ];
}

export function buildPrivacyReport(input: PrivacyReportInput): PrivacyReport {
  const lines: string[] = [
    `# ${HEADING}`,
    '',
    BODY_LEAD,
    '',
    '## Native-only posture (active configuration)',
    ...nativePostureLines(input),
    '',
    '## Field kinds never read or stored',
    ...NEVER_STORED_FIELD_KINDS.map((k) => `- ${k}`),
    '',
    '## Scope notes',
    ...SCOPE_NOTES,
    '- Webview state: the cockpit may keep sanitized display card state in VS Code webview state while the view is active or restored; it does not store raw prompts, completions, transcripts, terminal output, raw session IDs, or a usage-history database.',
    '',
    '---',
    '',
    '# Deeper detail',
    '',
    '## SecretStorage',
    '- TokenGauge does not ask for API keys and stores no provider credentials.',
    '- TokenGauge may create one local non-credential value in VS Code SecretStorage: an install salt used only for privacy-preserving hashing/redaction when needed.',
    '- The install salt is not an API key, not a provider credential, and is never sent anywhere. You normally do not need to manage it.',
    '',
    '## No developer telemetry',
    '- TokenGauge sends no developer-controlled telemetry. There is no analytics or tracking.',
    '',
    '## No outbound network by default',
    '- TokenGauge itself makes no outbound network calls. If you enable the Codex native probe, TokenGauge starts a short-lived local `codex` process; Codex may contact its own backend using its own credentials, but TokenGauge does not read or store those credentials.',
    '',
    '---',
    '',
    '## Open deeper diagnostics',
    '- Run Cockpit Diagnostics for sanitized, rule-id-only native status detail.',
  ];

  return { heading: HEADING, body: lines.join('\n') };
}

export interface OpenPrivacyReportDeps {
  readonly buildInput: () => Promise<PrivacyReportInput>;
  readonly renderReport: (report: PrivacyReport) => Promise<void>;
}

export function registerOpenPrivacyReportCommand(
  context: vscode.ExtensionContext,
  deps: OpenPrivacyReportDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_PRIVACY_REPORT_COMMAND, () => runOpenPrivacyReport(deps)),
  );
}

export async function runOpenPrivacyReport(deps: OpenPrivacyReportDeps): Promise<PrivacyReport> {
  const input = await deps.buildInput();
  const report = buildPrivacyReport(input);
  await deps.renderReport(report);
  return report;
}
