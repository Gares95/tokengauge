// The cockpit webview message boundary.
//
// Parse-or-drop inbound boundary plus a fully typed outbound payload (closed
// z.enum sets, bounded strings, NO z.unknown).

import * as assert from 'node:assert/strict';
import {
  CockpitInboundMessageSchema,
  CockpitOutboundMessageSchema,
  parseCockpitInboundMessage,
} from '../../../src/cockpit/CockpitMessageSchema';

class FakeDiagnostics {
  public readonly records: Array<{
    readonly ruleId: string;
    readonly status: string;
    readonly severity: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }> = [];

  public record(entry: {
    readonly ruleId: string;
    readonly status: string;
    readonly severity: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }): void {
    this.records.push(entry);
  }
}

function validCard() {
  return {
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    colorKey: 'claude',
    session: { centerLabel: '84%', state: 'fresh', usedPct: 84, leftPct: 16 },
    weekly: { centerLabel: '40%', state: 'fresh', usedPct: 40, leftPct: 60 },
    context: { centerLabel: '30%', state: 'fresh', usedPct: 30, leftPct: 70 },
    risk: 'warning',
    sourceTier: 'statusline_snapshot',
    accuracyLabel: 'proxy_reported',
    freshness: 'fresh',
    costReason: 'cost_session_specific_collision',
  };
}

suite('CockpitMessage schemas', () => {
  test('Valid inbound messages parse', () => {
    for (const message of [
      { type: 'ready' },
      { type: 'refreshNativeStatus' },
      { type: 'openClaudeSnapshotPathSetting' },
      { type: 'openSettings' },
      { type: 'configureCockpit' },
      { type: 'openPrivacyReport' },
      { type: 'openCockpitDiagnostics' },
    ]) {
      const parsed = parseCockpitInboundMessage(message);
      assert.equal(parsed.ok, true, `expected ${message.type} to parse`);
    }
  });

  // ConfigureCockpit joins the allowlist so the generic getting-started
  // button can route to the read-only Configure Cockpit guidance.
  // OpenClaudeSnapshotPathSetting is deliberately separate so the Claude card CTA
  // cannot fall through to the generic Configure Cockpit picker.
  // OpenPrivacyReport + openCockpitDiagnostics join so the persistent action
  // links route to the existing read-only commands.
  test('Inbound type set is locked to the seven allowlisted types', () => {
    const inboundTypes = CockpitInboundMessageSchema.options.map(
      (option) => option.shape.type.value,
    );
    assert.deepEqual(inboundTypes.sort(), [
      'configureCockpit',
      'openClaudeSnapshotPathSetting',
      'openCockpitDiagnostics',
      'openPrivacyReport',
      'openSettings',
      'ready',
      'refreshNativeStatus',
    ]);
  });

  // OpenSettings may carry an optional CLOSED-enum `target` (one-click to a
  // specific setting/filter). Absent → the list. Unknown target or extra key fails.
  test('Inbound openSettings accepts an optional closed-enum target', () => {
    for (const target of ['claudeSnapshotPath', 'codexProbe', 'providerCards']) {
      assert.equal(parseCockpitInboundMessage({ type: 'openSettings', target }).ok, true);
    }
    // No target is still valid (opens the list).
    assert.equal(parseCockpitInboundMessage({ type: 'openSettings' }).ok, true);
    // An arbitrary target string is rejected — no arbitrary settings query.
    assert.equal(
      parseCockpitInboundMessage({ type: 'openSettings', target: '@id:anything' }).ok,
      false,
    );
    // .strict(): an extra key is rejected.
    assert.equal(
      parseCockpitInboundMessage({ type: 'openSettings', target: 'codexProbe', extra: 1 }).ok,
      false,
    );
  });

  test('Outbound type set is gaugeCards + buildInfo + displayConfig', () => {
    const outboundTypes = CockpitOutboundMessageSchema.options.map(
      (option) => option.shape.type.value,
    );
    assert.deepEqual(outboundTypes.sort(), ['buildInfo', 'displayConfig', 'gaugeCards']);
  });

  // DisplayConfig carries only NON-SENSITIVE display booleans
  // (technical details + provider card visibility). No path/secret/value may ride it.
  test('Outbound displayConfig validates display-only booleans', () => {
    for (const showTechnicalDetails of [true, false]) {
      const ok = CockpitOutboundMessageSchema.safeParse({
        type: 'displayConfig',
        showTechnicalDetails,
        cardVisibility: { claude: true, codex: false },
      });
      assert.equal(ok.success, true);
    }

    const nonBool = CockpitOutboundMessageSchema.safeParse({
      type: 'displayConfig',
      showTechnicalDetails: 'yes',
      cardVisibility: { claude: true, codex: true },
    });
    assert.equal(nonBool.success, false);

    const nonBoolVisibility = CockpitOutboundMessageSchema.safeParse({
      type: 'displayConfig',
      showTechnicalDetails: false,
      cardVisibility: { claude: true, codex: 'hidden' },
    });
    assert.equal(nonBoolVisibility.success, false);

    const extra = CockpitOutboundMessageSchema.safeParse({
      type: 'displayConfig',
      showTechnicalDetails: false,
      cardVisibility: { claude: true, codex: true },
      path: '/home/dev/.claude',
    });
    assert.equal(extra.success, false);
  });

  // BuildInfo carries a NON-SENSITIVE build id (version + short
  // content hash), bounded like every display string. No path/secret may ride it.
  test('Outbound buildInfo validates a non-sensitive build id', () => {
    const ok = CockpitOutboundMessageSchema.safeParse({
      type: 'buildInfo',
      buildId: 'build 0.0.1+ab12cd34ef56',
    });
    assert.equal(ok.success, true);

    // An unbounded (>120 char) buildId is rejected — the leak-vector guard.
    const tooLong = CockpitOutboundMessageSchema.safeParse({
      type: 'buildInfo',
      buildId: 'x'.repeat(200),
    });
    assert.equal(tooLong.success, false);

    // An extra key is rejected (.strict()).
    const extra = CockpitOutboundMessageSchema.safeParse({
      type: 'buildInfo',
      buildId: 'build 0.0.1',
      path: '/home/dev/.claude',
    });
    assert.equal(extra.success, false);
  });

  test('Malformed inbound dropped with sanitized diagnostic', () => {
    const diagnostics = new FakeDiagnostics();
    for (const raw of [
      { type: 'evil' },
      { type: 'ready', extra: 1 },
      'not-an-object',
      null,
      { type: 'refreshNativeStatus', limitId: 'x' },
    ]) {
      const parsed = parseCockpitInboundMessage(raw, diagnostics);
      assert.equal(parsed.ok, false);
    }
    assert.equal(diagnostics.records.length, 5);
    for (const record of diagnostics.records) {
      assert.equal(record.ruleId, 'cockpit-postmessage-invalid');
      assert.equal(record.status, 'dropped');
      assert.deepEqual(record.details, { reason: 'invalid-cockpit-message' });
    }
  });

  test('Outbound gaugeCards validates a full VM payload', () => {
    const result = CockpitOutboundMessageSchema.safeParse({
      type: 'gaugeCards',
      cards: [validCard()],
    });
    assert.equal(result.success, true);
  });

  test('Out-of-enum freshness fails validation (closed enums, no z.unknown)', () => {
    const card = { ...validCard(), freshness: 'totally-fresh' };
    const result = CockpitOutboundMessageSchema.safeParse({
      type: 'gaugeCards',
      cards: [card],
    });
    assert.equal(result.success, false);
  });

  test('Out-of-enum reason fails validation', () => {
    const card = {
      ...validCard(),
      session: { ...validCard().session, reason: 'free-form-leak' },
    };
    const result = CockpitOutboundMessageSchema.safeParse({
      type: 'gaugeCards',
      cards: [card],
    });
    assert.equal(result.success, false);
  });

  test('An unexpected extra key on a VM fails (.strict())', () => {
    const card = { ...validCard(), planType: 'max-20x' };
    const result = CockpitOutboundMessageSchema.safeParse({
      type: 'gaugeCards',
      cards: [card],
    });
    assert.equal(result.success, false);
  });
});
