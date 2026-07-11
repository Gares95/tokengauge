// ObservedLimitSampleGuard unit tests.
//
// Assert the guard is the inviolable validate+sanitize boundary for observed-limit
// samples: strict schema (unknown/over-length/out-of-enum rejected), forbidden-
// content rejection (sentinels in the free-text note), and a sanitized error
// that never echoes the offending content. Grep target: "ObservedLimitSampleGuard".

import * as assert from 'node:assert/strict';
import { PrivacyViolationError } from '../../../src/core/diagnostics/errors';
import {
  assertSafeObservedLimitSample,
  ObservedLimitSampleGuard,
} from '../../../src/core/native/ObservedLimitSampleGuard';
import {
  OBSERVED_LIMIT_NOTE_MAX,
  OBSERVED_LIMIT_SAMPLE_FREE_TEXT_FIELDS,
} from '../../../src/core/native/ObservedLimitSampleSchema';
import { PRIVACY_SENTINELS, type PrivacySentinelKind } from '../../fixtures/privacy/sentinels';

const SENTINEL_KINDS = Object.keys(PRIVACY_SENTINELS) as readonly PrivacySentinelKind[];

const VALID_ID = 'a'.repeat(64);

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VALID_ID,
    timestamp: '2026-06-09T10:00:00.000Z',
    provider: 'anthropic',
    agent: 'claude-code',
    plan: 'max5x',
    windowType: 'session',
    observedTokenGaugeTokens: 120000,
    percentConsumed: 40,
    limitHitFlag: false,
    source: 'inferred',
    scopeKind: 'workspace',
    ...overrides,
  };
}

suite('ObservedLimitSampleGuard: schema gate', () => {
  test('A valid sample passes assertSafe and is returned unchanged', () => {
    const guard = new ObservedLimitSampleGuard();
    const out = guard.assertSafe(valid({ note: 'ok' }));
    assert.equal(out.provider, 'anthropic');
    assert.equal(out.agent, 'claude-code');
    assert.equal(out.plan, 'max5x');
    assert.equal(out.windowType, 'session');
    assert.equal(out.observedTokenGaugeTokens, 120000);
    assert.equal(out.limitHitFlag, false);
    assert.equal(out.source, 'inferred');
    assert.equal(out.scopeKind, 'workspace');
    assert.equal(out.note, 'ok');
  });

  test('The free-function export validates identically', () => {
    const out = assertSafeObservedLimitSample(valid({ note: 'ok' }));
    assert.equal(out.id, VALID_ID);
  });

  test('An unknown/extra field is rejected (strict)', () => {
    const guard = new ObservedLimitSampleGuard();
    assert.throws(
      () => guard.assertSafe(valid({ prompt: 'a leaked prompt body' })),
      PrivacyViolationError,
    );
  });

  test('Over-length note is rejected', () => {
    const guard = new ObservedLimitSampleGuard();
    assert.throws(
      () => guard.assertSafe(valid({ note: 'y'.repeat(OBSERVED_LIMIT_NOTE_MAX + 1) })),
      PrivacyViolationError,
    );
  });

  test('Out-of-enum plan is rejected', () => {
    const guard = new ObservedLimitSampleGuard();
    assert.throws(
      () => guard.assertSafe(valid({ plan: 'enterprise-ultra' })),
      PrivacyViolationError,
    );
  });

  test('Out-of-enum windowType is rejected', () => {
    const guard = new ObservedLimitSampleGuard();
    assert.throws(
      () => guard.assertSafe(valid({ windowType: 'fortnightly' })),
      PrivacyViolationError,
    );
  });

  test('Out-of-enum provider/agent is rejected', () => {
    const guard = new ObservedLimitSampleGuard();
    assert.throws(() => guard.assertSafe(valid({ provider: 'acme' })), PrivacyViolationError);
    assert.throws(() => guard.assertSafe(valid({ agent: 'acme-bot' })), PrivacyViolationError);
  });

  test('A non-integer observedTokenGaugeTokens is rejected', () => {
    const guard = new ObservedLimitSampleGuard();
    assert.throws(
      () => guard.assertSafe(valid({ observedTokenGaugeTokens: -1 })),
      PrivacyViolationError,
    );
  });

  test('Content-scanned fields are [note, scopeHash]', () => {
    assert.deepEqual([...OBSERVED_LIMIT_SAMPLE_FREE_TEXT_FIELDS], ['note', 'scopeHash']);
  });
});

suite('ObservedLimitSampleGuard: forbidden-content gate', () => {
  test('A sentinel-secret note is rejected with a forbidden-content:* code', () => {
    const guard = new ObservedLimitSampleGuard();
    try {
      guard.assertSafe(valid({ note: `note ${PRIVACY_SENTINELS.fakeApiKey}` }));
      assert.fail('expected ObservedLimitSampleGuard to reject the sentinel note');
    } catch (err) {
      assert.ok(err instanceof PrivacyViolationError);
      assert.match((err as Error).message, /forbidden-content:/);
    }
  });

  for (const kind of SENTINEL_KINDS) {
    test(`sentinel category ${kind} in note is rejected`, () => {
      const guard = new ObservedLimitSampleGuard();
      assert.throws(
        () => guard.assertSafe(valid({ note: `note ${PRIVACY_SENTINELS[kind]}` })),
        PrivacyViolationError,
      );
    });

    test(`the thrown error for ${kind} never echoes the offending content`, () => {
      const guard = new ObservedLimitSampleGuard();
      try {
        guard.assertSafe(valid({ note: `value ${PRIVACY_SENTINELS[kind]}` }));
        assert.fail('expected ObservedLimitSampleGuard to reject the sentinel');
      } catch (err) {
        assert.ok(err instanceof PrivacyViolationError);
        assert.ok(
          !(err as Error).message.includes(PRIVACY_SENTINELS[kind]),
          `error message leaked sentinel category ${kind}`,
        );
      }
    });
  }

  test('Diagnostics record carries ruleId + path only, never the offending value', () => {
    const records: Array<Record<string, unknown>> = [];
    const guard = new ObservedLimitSampleGuard({
      diagnostics: { record: (r: Record<string, unknown>) => records.push(r) } as never,
    });
    assert.throws(() => guard.assertSafe(valid({ note: `note ${PRIVACY_SENTINELS.fakeApiKey}` })));
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.path, 'note');
    assert.equal(rec.status, 'rejected');
    assert.equal(rec.severity, 'error');
    assert.match(String(rec.ruleId), /forbidden-content:/);
    assert.ok(!JSON.stringify(rec).includes(PRIVACY_SENTINELS.fakeApiKey));
  });
});
