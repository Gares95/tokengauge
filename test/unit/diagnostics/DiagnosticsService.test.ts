import * as assert from 'node:assert/strict';
import {
  DIAGNOSTICS_MAX_ENTRIES,
  type DiagnosticSeverity,
  type DiagnosticsEntry,
  DiagnosticsService,
} from '../../../src/core/diagnostics/DiagnosticsService';
import { PRIVACY_SENTINELS } from '../../fixtures/privacy/sentinels';

interface FakeOutputChannel {
  readonly lines: string[];
  appendLine(line: string): void;
}

function createFakeOutputChannel(): FakeOutputChannel {
  const lines: string[] = [];
  return {
    lines,
    appendLine(line: string) {
      lines.push(line);
    },
  };
}

// Acceptance: DiagnosticsService stores sanitized entries with rule IDs,
// status, severity, and redacted paths only; OutputChannel text never
// contains matched sentinel values.
suite('DiagnosticsService.record sanitization', () => {
  test('Stores rule id, status, and severity verbatim (no redaction needed)', () => {
    const svc = new DiagnosticsService();
    svc.record({
      ruleId: 'normalization-unknown-provider',
      status: 'rejected',
      severity: 'error',
      path: '/safe/relative/path/file.ts',
    });

    const entries = svc.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ruleId, 'normalization-unknown-provider');
    assert.equal(entries[0].status, 'rejected');
    assert.equal(entries[0].severity, 'error');
  });

  test('Redacts sentinel-shaped path field before storage', () => {
    const svc = new DiagnosticsService();
    svc.record({
      ruleId: 'path-leak-check',
      status: 'rejected',
      severity: 'warning',
      path: PRIVACY_SENTINELS.fakePosixPath,
    });

    const entry = svc.entries()[0];
    assert.ok(entry.path);
    assert.ok(
      !String(entry.path).includes(PRIVACY_SENTINELS.fakePosixPath),
      'raw sentinel path must not survive record()',
    );
  });

  test('Redacts serializable details payload before storage', () => {
    const svc = new DiagnosticsService();
    svc.record({
      ruleId: 'privacy-detail-leak',
      status: 'rejected',
      severity: 'error',
      details: {
        offending: PRIVACY_SENTINELS.fakeApiKey,
        nested: { token: PRIVACY_SENTINELS.fakeOAuthBearer },
      },
    });

    const serialized = JSON.stringify(svc.entries()[0].details ?? {});
    assert.ok(!serialized.includes(PRIVACY_SENTINELS.fakeApiKey));
    assert.ok(!serialized.includes(PRIVACY_SENTINELS.fakeOAuthBearer));
  });

  test('Accepts info/warning/error severities and rejects unknown literals at the type boundary', () => {
    const svc = new DiagnosticsService();
    const severities: readonly DiagnosticSeverity[] = ['info', 'warning', 'error'];
    for (const severity of severities) {
      svc.record({ ruleId: `severity-${severity}`, status: 'ok', severity });
    }
    const out = svc.entries().map((e) => e.severity);
    assert.deepEqual(out, ['info', 'warning', 'error']);
  });
});

// Acceptance: entries() returns a defensive copy that callers cannot use to
// mutate the diagnostic history.
suite('DiagnosticsService.entries defensive copy', () => {
  test('Returned array can be mutated without affecting internal state', () => {
    const svc = new DiagnosticsService();
    svc.record({ ruleId: 'rule-a', status: 'ok', severity: 'info' });

    const first = svc.entries() as DiagnosticsEntry[];
    first.push({
      ruleId: 'rule-b',
      status: 'ok',
      severity: 'info',
      timestamp: '2026-06-03T00:00:00.000Z',
    });
    first.length = 0;

    const second = svc.entries();
    assert.equal(second.length, 1, 'callers must not be able to shrink/extend internal history');
    assert.equal(second[0].ruleId, 'rule-a');
  });

  test('Returned entry objects do not allow mutation of the stored entry', () => {
    const svc = new DiagnosticsService();
    svc.record({ ruleId: 'rule-frozen', status: 'ok', severity: 'info' });

    const snapshot = svc.entries();
    const target = snapshot[0] as DiagnosticsEntry & { ruleId: string };
    let mutated = false;
    try {
      target.ruleId = 'mutated';
      mutated = true;
    } catch {
      mutated = false;
    }

    const fresh = svc.entries();
    assert.equal(fresh[0].ruleId, 'rule-frozen', 'internal entry must not change');
    void mutated;
  });
});

// Acceptance: optional OutputChannel sink mirrors the diagnostics command style.
// Per-record live output is OFF by default (the cockpit poll/watch
// loop must not flood the Output panel). It only emits when the `live` opt-in is
// explicitly enabled, and even then never leaks a matched sentinel value
//.
suite('DiagnosticsService OutputChannel sink', () => {
  test('Does NOT append per-record by default even when an OutputChannel is provided', () => {
    const channel = createFakeOutputChannel();
    const svc = new DiagnosticsService({ outputChannel: channel });

    svc.record({ ruleId: 'statusline-snapshot', status: 'ok', severity: 'info' });
    svc.record({ ruleId: 'lower_usage_snapshot_rejected', status: 'rejected', severity: 'info' });

    assert.equal(
      channel.lines.length,
      0,
      'default diagnostics must not write to the OutputChannel per record() (no live spam)',
    );
  });

  test('Appends sanitized rule/status/severity text only when live output is opted in', () => {
    const channel = createFakeOutputChannel();
    const svc = new DiagnosticsService({ outputChannel: channel, live: true });

    svc.record({
      ruleId: 'leak-path',
      status: 'rejected',
      severity: 'error',
      path: PRIVACY_SENTINELS.fakePosixPath,
      details: { offending: PRIVACY_SENTINELS.fakeApiKey },
    });

    const text = channel.lines.join('\n');
    assert.ok(text.includes('leak-path'));
    assert.ok(text.includes('rejected'));
    assert.ok(text.includes('error'));
    assert.ok(!text.includes(PRIVACY_SENTINELS.fakePosixPath));
    assert.ok(!text.includes(PRIVACY_SENTINELS.fakeApiKey));
  });

  test('No OutputChannel writes occur when none is provided', () => {
    const svc = new DiagnosticsService();
    svc.record({ ruleId: 'no-sink', status: 'ok', severity: 'info' });
    assert.equal(svc.entries().length, 1);
  });
});

// Acceptance: a long-running poll/watch loop must not grow memory
// unbounded. entries() is capped to a ring buffer; the oldest are dropped.
suite('DiagnosticsService bounded ring buffer', () => {
  test('Caps entries() at DIAGNOSTICS_MAX_ENTRIES, dropping the oldest', () => {
    const svc = new DiagnosticsService();
    const overflow = DIAGNOSTICS_MAX_ENTRIES + 250;
    for (let i = 0; i < overflow; i += 1) {
      svc.record({ ruleId: `rule-${i}`, status: 'ok', severity: 'info' });
    }

    const entries = svc.entries();
    assert.equal(entries.length, DIAGNOSTICS_MAX_ENTRIES, 'entries() must be capped');
    // The oldest (rule-0) must have been evicted; the newest must survive.
    assert.equal(entries[0].ruleId, `rule-${overflow - DIAGNOSTICS_MAX_ENTRIES}`);
    assert.equal(entries[entries.length - 1].ruleId, `rule-${overflow - 1}`);
  });
});

// Acceptance: summary() returns a finite, deduplicated, counted
// snapshot keyed by ruleId — counts + latest status/severity/timestamp only, no
// raw payload — so the report is bounded per invocation, not an ever-growing
// stream.
suite('DiagnosticsService.summary bounded counted snapshot', () => {
  test('Dedups + counts repeated ruleIds with the latest status and a correct total', () => {
    const svc = new DiagnosticsService();
    for (let i = 0; i < 18; i += 1) {
      svc.record({ ruleId: 'statusline_snapshot_loaded', status: 'ok', severity: 'info' });
    }
    for (let i = 0; i < 12; i += 1) {
      svc.record({
        ruleId: 'lower_usage_snapshot_rejected',
        status: i === 11 ? 'rejected-latest' : 'rejected',
        severity: 'warning',
      });
    }

    const summary = svc.summary();
    assert.equal(summary.total, 30, 'total must count every recorded entry');
    assert.equal(summary.rules.length, 2, 'summary must dedup by ruleId');

    const byId = new Map(summary.rules.map((r) => [r.ruleId, r]));
    const loaded = byId.get('statusline_snapshot_loaded');
    assert.ok(loaded);
    assert.equal(loaded?.count, 18);
    assert.equal(loaded?.latestStatus, 'ok');

    const rejected = byId.get('lower_usage_snapshot_rejected');
    assert.ok(rejected);
    assert.equal(rejected?.count, 12);
    assert.equal(rejected?.latestStatus, 'rejected-latest', 'latest status wins');
    assert.equal(rejected?.latestSeverity, 'warning');
    assert.ok(typeof rejected?.latestTimestamp === 'string' && rejected.latestTimestamp.length > 0);
  });

  test('Summary() carries no raw path/id/secret payload', () => {
    const svc = new DiagnosticsService();
    svc.record({
      ruleId: 'privacy-detail-leak',
      status: 'rejected',
      severity: 'error',
      path: PRIVACY_SENTINELS.fakePosixPath,
      details: { offending: PRIVACY_SENTINELS.fakeApiKey },
    });

    const serialized = JSON.stringify(svc.summary());
    assert.ok(!serialized.includes(PRIVACY_SENTINELS.fakePosixPath));
    assert.ok(!serialized.includes(PRIVACY_SENTINELS.fakeApiKey));
    // No `path` or `details` keys survive into the bounded summary at all.
    assert.ok(!/"path"/.test(serialized));
    assert.ok(!/"details"/.test(serialized));
  });

  test('Summary() is finite and identical in shape across repeated invocations (no unbounded append)', () => {
    const svc = new DiagnosticsService();
    for (let i = 0; i < 40; i += 1) {
      svc.record({ ruleId: 'tick', status: 'ok', severity: 'info' });
    }
    const first = svc.summary();
    const second = svc.summary();
    assert.equal(first.rules.length, 1);
    assert.equal(second.rules.length, 1, 'report is bounded — calling it again does not grow it');
    assert.equal(first.total, second.total);
  });
});

// Acceptance: DiagnosticsService has no dependency on UsageStore, SecretManager,
// or pricing modules — later slices consume it without circular imports.
suite('DiagnosticsService import isolation', () => {
  test('Module source imports only Redactor and vscode types (no usage/security/cost deps)', () => {
    // Read the compiled JS to assert it does not require forbidden modules.
    const requirePath = require.resolve('../../../src/core/diagnostics/DiagnosticsService.js');
    const compiledSource = require('node:fs').readFileSync(requirePath, 'utf8') as string;

    assert.ok(!/storage\/UsageStore/.test(compiledSource));
    assert.ok(!/security\/SecretManager/.test(compiledSource));
    assert.ok(!/security\/IdHasher/.test(compiledSource));
    assert.ok(!/core\/cost\//.test(compiledSource));
    assert.ok(!/core\/tokenizers\//.test(compiledSource));
  });
});
