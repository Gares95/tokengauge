// Native privacy invariant suite.
//
// A sentinel forbidden value (fake prompt, source snippet, raw POSIX/Windows
// path, API key, env var, OAuth bearer, cookie, git remote) MUST NOT appear
// unredacted in any of these native surfaces:
//
//   1. DiagnosticsService entries / OutputChannel text
//   2. Typed TokenGaugeError public messages
//   3. `Redactor.redactSerializable()` export-shaped payloads
//   4. The privacy fixtures file itself (no contiguous raw sentinels)
//   5. The VSIX audit pattern registry (every sentinel category has a rule)
//
// (The JSONL usage-store surface was removed in the native-only reset — TokenGauge is
// native-only and persists no usage events.) Failure output is rule-name /
// path / count only — never a matched sentinel value.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticsService } from '../../src/core/diagnostics/DiagnosticsService';
import { PrivacyViolationError } from '../../src/core/diagnostics/errors';
import { redactSerializable, redactString } from '../../src/security/Redactor';
import { PRIVACY_SENTINELS, type PrivacySentinelKind } from '../fixtures/privacy/sentinels';

const SENTINEL_KINDS = Object.keys(PRIVACY_SENTINELS) as readonly PrivacySentinelKind[];

// Sanitized assertion: never echo the sentinel value in the failure
// message. Reports rule kind + status only.
function assertSentinelAbsent(haystack: string, kind: PrivacySentinelKind): void {
  if (haystack.includes(PRIVACY_SENTINELS[kind])) {
    assert.fail(`sentinel category leaked into surface: ${kind}`);
  }
}

suite('Privacy invariant: DiagnosticsService entries and OutputChannel text', () => {
  test('Diagnostics path field is redacted when callers attempt to record a raw path', () => {
    const diagnostics = new DiagnosticsService();
    diagnostics.record({
      ruleId: 'caller-supplied-path',
      status: 'rejected',
      severity: 'warning',
      path: PRIVACY_SENTINELS.fakePosixPath,
      details: {
        echo: PRIVACY_SENTINELS.fakeApiKey,
        nested: { token: PRIVACY_SENTINELS.fakeOAuthBearer },
      },
    });
    const serialized = JSON.stringify(diagnostics.entries());
    assertSentinelAbsent(serialized, 'fakePosixPath');
    assertSentinelAbsent(serialized, 'fakeApiKey');
    assertSentinelAbsent(serialized, 'fakeOAuthBearer');
  });
});

suite('Privacy invariant: typed TokenGaugeError public messages', () => {
  for (const kind of SENTINEL_KINDS) {
    test(`PrivacyViolationError message redacts sentinel category ${kind}`, () => {
      const err = new PrivacyViolationError(`boundary failure: ${PRIVACY_SENTINELS[kind]}`);
      assertSentinelAbsent(err.message, kind);
    });
  }

  test('Error enumerable properties carry no raw sentinel value', () => {
    const err = new PrivacyViolationError(`forbidden-content: ${PRIVACY_SENTINELS.fakeApiKey}`);
    const exposed = JSON.stringify({ ...err, message: err.message, name: err.name });
    assertSentinelAbsent(exposed, 'fakeApiKey');
  });
});

suite('Privacy invariant: Redactor.redactSerializable export-shaped payloads', () => {
  for (const kind of SENTINEL_KINDS) {
    test(`export-shaped payload redacts sentinel category ${kind} in nested object`, () => {
      const payload = {
        meta: { source: 'log_derived' },
        records: [
          { detail: PRIVACY_SENTINELS[kind] },
          { nested: { value: PRIVACY_SENTINELS[kind] } },
        ],
      };
      const out = redactSerializable(payload);
      assertSentinelAbsent(JSON.stringify(out), kind);
    });
  }

  test('RedactString surface redacts every sentinel category', () => {
    for (const kind of SENTINEL_KINDS) {
      const redacted = redactString(`prefix ${PRIVACY_SENTINELS[kind]} suffix`);
      assertSentinelAbsent(redacted, kind);
      assert.match(redacted, /\[redacted:[a-z0-9-]+\]/i);
    }
  });
});

suite('Privacy invariant: fixture files contain no contiguous raw sentinel values', () => {
  // The sentinels module is intentionally constructed via fragmented
  // string concatenation so static scans (`tools/check-privacy-fast.mjs`)
  // do not match contiguous sentinel literals in source. Verify the
  // source file itself respects this — a regression would slip a literal
  // sentinel into the repo and trigger the privacy fast-sweep gate.
  test('Test/fixtures/privacy/sentinels.ts contains no contiguous sentinel literal in source', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'test', 'fixtures', 'privacy', 'sentinels.ts'),
      'utf8',
    );
    for (const kind of SENTINEL_KINDS) {
      assert.ok(
        !source.includes(PRIVACY_SENTINELS[kind]),
        `fixture source must not contain contiguous sentinel literal: ${kind}`,
      );
    }
  });
});

// Load the ESM `.mjs` audit-vsix-patterns registry without inviting
// NodeNext to type-check the file as a TS module. `pathToFileURL` plus
// a computed module specifier keeps the dynamic import opaque to tsc,
// so the assertions below execute against the live registry the VSIX
// audit uses, not a copy.
async function loadAuditVsixPatterns(): Promise<{
  readonly FORBIDDEN_CONTENT_PATTERNS: ReadonlyArray<{
    readonly name: string;
    readonly re: RegExp;
  }>;
}> {
  const { pathToFileURL } = await import('node:url');
  const patternsPath = join(__dirname, '..', '..', '..', 'tools', 'audit-vsix-patterns.mjs');
  const specifier = pathToFileURL(patternsPath).href;
  return import(specifier) as Promise<{
    readonly FORBIDDEN_CONTENT_PATTERNS: ReadonlyArray<{
      readonly name: string;
      readonly re: RegExp;
    }>;
  }>;
}

suite('Privacy invariant: VSIX audit pattern registry covers every sentinel category', () => {
  test('FORBIDDEN_CONTENT_PATTERNS registry includes a rule for every sentinel category', async () => {
    const patterns = await loadAuditVsixPatterns();
    const ruleNames = patterns.FORBIDDEN_CONTENT_PATTERNS.map((p) => p.name);

    const requiredRules = [
      'sentinel-prompt',
      'sentinel-source',
      'sentinel-apikey',
      'sentinel-envvar',
      'sentinel-oauth',
      'sentinel-cookie',
      'sentinel-gitremote',
      'sentinel-path',
    ];
    for (const ruleName of requiredRules) {
      assert.ok(
        ruleNames.includes(ruleName),
        `VSIX audit pattern registry missing required sentinel rule: ${ruleName}`,
      );
    }
  });

  test('FORBIDDEN_CONTENT_PATTERNS registry includes a rule for every credential category', async () => {
    const patterns = await loadAuditVsixPatterns();
    const ruleNames = patterns.FORBIDDEN_CONTENT_PATTERNS.map((p) => p.name);

    const requiredRules = [
      'openai-api-key',
      'anthropic-api-key',
      'oauth-bearer',
      'authorization-bearer-literal',
      'private-key-pem',
      'envvar-credential-assignment',
    ];
    for (const ruleName of requiredRules) {
      assert.ok(
        ruleNames.includes(ruleName),
        `VSIX audit pattern registry missing required credential rule: ${ruleName}`,
      );
    }
  });
});
