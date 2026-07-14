// Privacy & Data Report — native-only (ADR-004).
//
// The report reads as a trust report: TokenGauge is native-only — the cockpit
// runs on native/statusLine snapshots + the Codex app-server probe, reads no
// conversation logs, and persists no usage events. No raw paths/ids/secrets leak.
//

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPrivacyReport,
  OPEN_PRIVACY_REPORT_COMMAND,
  type PrivacyReportInput,
} from '../../../src/commands/openPrivacyReport';
import { findRepoRoot } from '../../_helpers/repoRoot';

function baseInput(overrides: Partial<PrivacyReportInput> = {}): PrivacyReportInput {
  return {
    codexProbeEnabled: false,
    codexCardVisible: true,
    claudeCardVisible: true,
    ...overrides,
  };
}

suite('Privacy & Data Report — native-only', () => {
  test('Command id constant is tokenGauge.openPrivacyReport (stable)', () => {
    assert.equal(OPEN_PRIVACY_REPORT_COMMAND, 'tokenGauge.openPrivacyReport');
  });

  test('Heading is the Privacy & Data Report', () => {
    const report = buildPrivacyReport(baseInput());
    assert.ok(report.heading.includes('Privacy & Data Report'), report.heading);
  });

  test('Report leads with the native-only posture before the deeper detail', () => {
    const body = buildPrivacyReport(baseInput()).body;
    const lower = body.toLowerCase();
    const nativeIdx = lower.indexOf('native');
    assert.ok(nativeIdx >= 0, 'report must mention the native posture');
    const detailIdx = lower.indexOf('deeper detail');
    assert.ok(detailIdx > nativeIdx, 'native-first framing must precede deeper detail');
  });

  test('States no conversation-log scanning + no persistence + probe state', () => {
    const body = buildPrivacyReport(baseInput()).body;
    const lower = body.toLowerCase();
    assert.ok(
      lower.includes('no conversation-log scanning'),
      'must state no conversation-log scanning',
    );
    assert.ok(lower.includes('persists no usage events'), 'must state no usage persistence');
    assert.ok(lower.includes('broad-log-root'), 'must mention broad-log-root posture');
    assert.ok(lower.includes('codex'), 'must mention Codex probe state');
    assert.ok(lower.includes('probe'), 'must mention probe state');
  });

  test('Codex probe enabled by user is reflected honestly', () => {
    const body = buildPrivacyReport(baseInput({ codexProbeEnabled: true })).body.toLowerCase();
    assert.ok(body.includes('enabled'), 'probe-enabled state must be reflected');
  });

  test('Never-read/stored field kinds explicitly include every forbidden category', () => {
    const body = buildPrivacyReport(baseInput()).body.toLowerCase();
    for (const kind of [
      'prompts',
      'completions',
      'source code',
      'source/workspace file contents',
      'terminal output',
      'tool args',
      'arbitrary/raw environment variables',
      'oauth tokens',
      'cookies',
      'raw transcripts',
      'git remote urls',
      'raw native-payload paths',
      'conversation/agent logs',
    ]) {
      assert.ok(body.includes(kind), `never-stored list missing: ${kind}`);
    }
  });

  test('Never-read wording is precise, not overclaimed (report precision)', () => {
    const body = buildPrivacyReport(baseInput()).body;
    // The blanket bullets that overclaimed against native reading + local CLI
    // discovery must NOT appear as absolute never-read categories.
    assert.doesNotMatch(
      body,
      /^- environment variables$/m,
      'no absolute "environment variables" bullet',
    );
    assert.doesNotMatch(body, /^- file contents$/m, 'no absolute "file contents" bullet');
    assert.doesNotMatch(body, /^- raw paths$/m, 'no absolute "raw paths" bullet');
    // The allowlisted env-metadata caveat must be present because Codex local
    // discovery inspects a small allowlisted set of process environment metadata.
    assert.match(
      body,
      /allowlisted set of process environment metadata/i,
      'must disclose the allowlisted env-metadata inspection',
    );
    // The report must distinguish arbitrary source/workspace files from the
    // configured native status surfaces it legitimately reads.
    assert.match(
      body,
      /native status surfaces you configure/i,
      'must acknowledge it reads configured native status surfaces',
    );
    assert.match(
      body,
      /does not read arbitrary source or workspace files/i,
      'must scope file reading to native surfaces, not arbitrary files',
    );
    // Path promise is about native-payload paths + redaction, not an absolute.
    assert.match(
      body,
      /raw native-payload paths are not displayed or persisted/i,
      'path promise must be precise (native-payload paths redacted, not absolute)',
    );
  });

  test('Lists raw native-payload paths plainly as never read/stored — no stale raw-path opt-in hedge', () => {
    // v1 is native-only: nothing branches on `privacyMode`, the persistence layer
    // is gone, and raw native-payload paths are unconditionally redacted. There is
    // no functional raw-path opt-in, so the report must not hedge with one.
    const body = buildPrivacyReport(baseInput()).body.toLowerCase();
    assert.ok(!body.includes('raw-path opt-in'), 'must not reference a raw-path opt-in');
    assert.ok(
      !body.includes('unless raw-path opt-in applies'),
      'stale opt-in hedge must be absent',
    );
    assert.ok(
      body.includes('field kinds never read or stored') &&
        /^- raw native-payload paths$/m.test(body),
      'raw native-payload paths must be listed plainly under the never-read/stored section',
    );
  });

  test('Retains required trust sections and a separated deeper diagnostics action', () => {
    const body = buildPrivacyReport(baseInput()).body;
    for (const section of [
      'Field kinds never read or stored',
      'SecretStorage',
      'No developer telemetry',
      'No outbound network by default',
    ]) {
      assert.ok(body.includes(section), `missing required section: ${section}`);
    }
    assert.ok(body.includes('Open deeper diagnostics'));
    const networkIdx = body.indexOf('No outbound network by default');
    const diagIdx = body.indexOf('Open deeper diagnostics');
    assert.ok(
      networkIdx >= 0 && diagIdx > networkIdx,
      'deeper diagnostics must come after readable sections',
    );
  });

  test('No raw paths/ids/secrets leak — only redacted category values appear', () => {
    const body = buildPrivacyReport(baseInput({ codexProbeEnabled: true })).body;
    assert.ok(!/\/home\/[a-z]/i.test(body), 'no raw POSIX home path');
    assert.ok(!/[A-Za-z]:\\Users\\/.test(body), 'no raw Windows user path');
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(body), 'no email address');
  });
});

suite('Contributed command labels', () => {
  const manifest = JSON.parse(readFileSync(join(findRepoRoot(), 'package.json'), 'utf8')) as {
    contributes: { commands: { command: string; title: string; category?: string }[] };
  };

  const REQUIRED: Record<string, string> = {
    'tokenGauge.openPrivacyReport': 'Privacy & Data Report',
  };

  for (const [id, label] of Object.entries(REQUIRED)) {
    test(`Test 5: contributes ${id} with exact label "${label}" under category TokenGauge`, () => {
      const entry = manifest.contributes.commands.find((c) => c.command === id);
      assert.ok(entry, `missing contributed command: ${id}`);
      assert.equal(entry.title, label);
      assert.equal(entry.category, 'TokenGauge');
    });
  }
});

// Active-mode wording polish — the headline stays native-only; the Codex-probe
// line is accurate for the EFFECTIVE setting (never says enabled when off); the
// network line is not contradicted by the opt-in local codex process.
suite('Privacy & Data Report — native wording', () => {
  test('Headline stays native/statusLine-only without manual input copy', () => {
    const body = buildPrivacyReport(baseInput()).body;
    assert.match(body, /native\/statusLine snapshots/i);
    assert.doesNotMatch(body, /manual input/i);
  });

  test('Probe OFF: does NOT say "enabled by you"; says the probe is off', () => {
    const body = buildPrivacyReport(baseInput({ codexProbeEnabled: false })).body;
    assert.doesNotMatch(body, /enabled by you/i);
    assert.match(body, /codex native probe: off/i);
  });

  test('Probe ON: careful enabled phrasing (local codex process; TG makes no call/reads no creds)', () => {
    const body = buildPrivacyReport(baseInput({ codexProbeEnabled: true })).body;
    assert.match(body, /enabled by you/i);
    assert.match(body, /local `codex` process/i);
    assert.match(body, /makes no network call|makes no request|no network call/i);
    assert.match(body, /never reads codex credentials|reads no credentials/i);
  });

  test('Probe setting ON but Codex card hidden does not claim a spawn', () => {
    const body = buildPrivacyReport(
      baseInput({ codexProbeEnabled: true, codexCardVisible: false }),
    ).body;
    assert.match(body, /setting enabled but card hidden/i);
    assert.match(body, /no `codex` process is spawned until the Codex card is visible/i);
    assert.doesNotMatch(body, /ON and card visible/i);
  });

  test('Hidden Claude card stops Claude native reads', () => {
    const body = buildPrivacyReport(baseInput({ claudeCardVisible: false })).body;
    assert.match(body, /Claude card: hidden/i);
    assert.match(body, /does not read the Claude statusLine snapshot/i);
  });

  test('Network line is not contradicted by the opt-in Codex probe when enabled', () => {
    const body = buildPrivacyReport(baseInput({ codexProbeEnabled: true })).body;
    assert.match(body, /TokenGauge network calls: none/i);
    assert.match(body, /you enabled the probe|local `codex` process/i);
  });

  // R3: native-only secret-storage truth — no API-key feature; no provider
  // credentials; the install salt is a local non-credential value the user does
  // not manage (the public deletion command was removed).
  test('V1 has no API-key feature; install salt is explained as a non-credential value', () => {
    const body = buildPrivacyReport(baseInput()).body;
    assert.doesNotMatch(
      body,
      /API keys live only in VS Code SecretStorage/i,
      'stale API-key claim must be gone',
    );
    assert.match(body, /does not ask for API keys/i);
    assert.match(body, /stores no provider credentials/i);
    assert.match(body, /install salt/i);
    assert.match(body, /not an API key, not a provider credential/i);
  });

  test('Privacy Report no longer advertises a salt-clearing command or a deletion section', () => {
    const body = buildPrivacyReport(baseInput()).body;
    assert.doesNotMatch(
      body,
      /Clear Local Install Salt/i,
      'removed command must not be advertised',
    );
    assert.doesNotMatch(body, /Delete Stored Secrets/i, 'removed command must not be advertised');
    assert.doesNotMatch(body, /Data deletion commands/i, 'data-deletion section removed');
    assert.match(body, /you normally do not need to manage it/i, 'salt framed as not user-managed');
  });

  test('Network wording: TokenGauge itself makes no outbound calls, no provider/proxy claim', () => {
    const body = buildPrivacyReport(baseInput()).body;
    assert.match(body, /makes no outbound network calls/i);
    assert.doesNotMatch(
      body,
      /provider\/proxy APIs you configure directly/i,
      'stale provider/proxy wording must be gone',
    );
  });

  test('No raw paths/emails/secrets leak under either probe state', () => {
    for (const enabled of [false, true]) {
      const body = buildPrivacyReport(baseInput({ codexProbeEnabled: enabled })).body;
      assert.doesNotMatch(body, /\/home\/[a-z]/i, 'no raw POSIX home path');
      assert.doesNotMatch(body, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, 'no email');
    }
  });
});
