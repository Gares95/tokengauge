// Observed-limit sample privacy invariant suite.
//
// The observed-limit sample boundary must hold the same invariant as the privacy
// chokepoints and the observation guard: a sentinel forbidden value fed
// through ObservedLimitSampleGuard MUST be rejected and MUST NOT appear unredacted in
// the thrown error. A fake api-key, a posix path, and a git-remote in `note`
// are each rejected with a content-free error.
//
// Failure output is rule-kind only — the test never echoes a matched sentinel
// value back through assert.fail messages.

import * as assert from 'node:assert/strict';
import { PrivacyViolationError } from '../../src/core/diagnostics/errors';
import { ObservedLimitSampleGuard } from '../../src/core/native/ObservedLimitSampleGuard';
import { PRIVACY_SENTINELS, type PrivacySentinelKind } from '../fixtures/privacy/sentinels';

const SENTINEL_KINDS = Object.keys(PRIVACY_SENTINELS) as readonly PrivacySentinelKind[];

function captureCandidate(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'a'.repeat(64),
    timestamp: '2026-06-09T10:00:00.000Z',
    provider: 'anthropic',
    agent: 'claude-code',
    plan: 'max5x',
    windowType: 'session',
    observedTokenGaugeTokens: 120000,
    limitHitFlag: false,
    source: 'inferred',
    scopeKind: 'workspace',
    ...overrides,
  };
}

suite('ObservedLimitSampleGuard privacy invariant: forbidden note content', () => {
  const TARGETS: readonly PrivacySentinelKind[] = ['fakeApiKey', 'fakePosixPath', 'fakeGitRemote'];

  for (const kind of TARGETS) {
    test(`a ${kind} in note is rejected with a content-free error`, () => {
      const guard = new ObservedLimitSampleGuard();
      try {
        guard.assertSafe(captureCandidate({ note: `n ${PRIVACY_SENTINELS[kind]}` }));
        assert.fail(`expected rejection for sentinel category ${kind}`);
      } catch (err) {
        assert.ok(err instanceof PrivacyViolationError);
        assert.ok(
          !(err as Error).message.includes(PRIVACY_SENTINELS[kind]),
          `error message leaked sentinel category ${kind}`,
        );
      }
    });
  }

  // WR-01 defence-in-depth: scopeHash can be populated from an external snapshot
  // field, so the guard must content-scan it too — a forbidden value there is
  // rejected before persistence, never echoed.
  for (const kind of TARGETS) {
    test(`a ${kind} in scopeHash is rejected with a content-free error`, () => {
      const guard = new ObservedLimitSampleGuard();
      try {
        // Pad with hex so the min-16 schema passes and the CONTENT scan is what rejects.
        guard.assertSafe(
          captureCandidate({ scopeHash: `${'a'.repeat(16)}${PRIVACY_SENTINELS[kind]}` }),
        );
        assert.fail(`expected rejection for scopeHash sentinel ${kind}`);
      } catch (err) {
        assert.ok(err instanceof PrivacyViolationError);
        assert.ok(
          !(err as Error).message.includes(PRIVACY_SENTINELS[kind]),
          `error message leaked sentinel category ${kind}`,
        );
      }
    });
  }

  test('Every sentinel category in note is rejected and never echoed', () => {
    const guard = new ObservedLimitSampleGuard();
    for (const kind of SENTINEL_KINDS) {
      try {
        guard.assertSafe(captureCandidate({ note: `n ${PRIVACY_SENTINELS[kind]}` }));
        assert.fail(`expected rejection for sentinel category ${kind}`);
      } catch (err) {
        assert.ok(err instanceof PrivacyViolationError, `category ${kind} threw non-privacy error`);
        if ((err as Error).message.includes(PRIVACY_SENTINELS[kind])) {
          assert.fail(`error message leaked sentinel category ${kind}`);
        }
      }
    }
  });
});
