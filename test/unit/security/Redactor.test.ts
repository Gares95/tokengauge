import * as assert from 'node:assert/strict';
import { PrivacyViolationError, TokenGaugeError } from '../../../src/core/diagnostics/errors';
import { Redactor, redactSerializable, redactString } from '../../../src/security/Redactor';
import { PRIVACY_SENTINELS } from '../../fixtures/privacy/sentinels';

// Acceptance: redactString covers every sentinel category, replaces matches
// with rule-name markers, and never returns the matched sentinel substring.
suite('Redactor.redactString sentinel coverage', () => {
  test('Returns the input unchanged when no forbidden content is present', () => {
    const safe = 'normal status message — no forbidden content here';
    assert.equal(redactString(safe), safe);
  });

  test('Replaces fake API key with a rule marker and never returns the key', () => {
    const out = redactString(`prefix ${PRIVACY_SENTINELS.fakeApiKey} suffix`);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakeApiKey), 'matched value must not survive');
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Replaces fake OAuth bearer token with a rule marker', () => {
    const out = redactString(PRIVACY_SENTINELS.fakeOAuthBearer);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakeOAuthBearer));
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Replaces fake POSIX raw path with a rule marker', () => {
    const out = redactString(PRIVACY_SENTINELS.fakePosixPath);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakePosixPath));
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Replaces fake Windows raw path with a rule marker', () => {
    const out = redactString(PRIVACY_SENTINELS.fakeWindowsPath);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakeWindowsPath));
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Replaces fake prompt JSON shape with a rule marker', () => {
    const out = redactString(PRIVACY_SENTINELS.fakePrompt);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakePrompt));
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Replaces fake source-code snippet sentinel with a rule marker', () => {
    const out = redactString(PRIVACY_SENTINELS.fakeSource);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakeSource));
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Replaces fake env var credential assignment with a rule marker', () => {
    const out = redactString(PRIVACY_SENTINELS.fakeEnvVar);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakeEnvVar));
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Replaces fake cookie sentinel with a rule marker', () => {
    const out = redactString(PRIVACY_SENTINELS.fakeCookie);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakeCookie));
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Replaces fake git remote URL sentinel with a rule marker', () => {
    const out = redactString(PRIVACY_SENTINELS.fakeGitRemote);
    assert.ok(!out.includes(PRIVACY_SENTINELS.fakeGitRemote));
    assert.match(out, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('Redactor class exposes redactString with identical behavior', () => {
    const input = PRIVACY_SENTINELS.fakeApiKey;
    assert.equal(new Redactor().redactString(input), redactString(input));
  });

  // An error string carrying a raw POSIX path must be redacted
  // for BOTH a standard home-style root AND a non-standard container/WSL root
  // (/data, /workspace, /snap). A synthetic "setup failed" error is built for
  // each root; the surfaced string must never contain the raw path.
  const wr04Paths = [
    '/home/dev/.claude/projects/session-abc/conversation.jsonl', // standard
    '/data/projects/acme/.claude/statusline-snapshot.json', // non-standard
    '/workspace/repo/.claude/statusline-snapshot.json', // dev-container
    '/snap/code/current/.claude/statusline-snapshot.json', // snap VS Code
  ];
  for (const rawPath of wr04Paths) {
    test(`redacts a raw path under root "${rawPath.split('/')[1]}/" in a surfaced error string`, () => {
      const surfaced = redactString(`setup failed: could not read ${rawPath}`);
      assert.ok(!surfaced.includes(rawPath), `raw path must not survive: ${rawPath}`);
      assert.match(surfaced, /\[redacted:[a-z0-9-]+\]/i);
    });
  }
});

// Acceptance: redactSerializable walks nested objects/arrays, redacts string leaves,
// and preserves non-string scalar values.
suite('Redactor.redactSerializable nested payloads', () => {
  test('Redacts string values inside nested object/array structures', () => {
    const payload = {
      ruleId: 'safe-rule-id',
      details: {
        path: PRIVACY_SENTINELS.fakePosixPath,
        history: [PRIVACY_SENTINELS.fakeApiKey, 'plain-status'],
        nested: { token: PRIVACY_SENTINELS.fakeOAuthBearer },
      },
    };

    const out = redactSerializable(payload) as typeof payload;
    const serialized = JSON.stringify(out);

    assert.ok(!serialized.includes(PRIVACY_SENTINELS.fakePosixPath));
    assert.ok(!serialized.includes(PRIVACY_SENTINELS.fakeApiKey));
    assert.ok(!serialized.includes(PRIVACY_SENTINELS.fakeOAuthBearer));
    assert.equal(out.ruleId, 'safe-rule-id');
    assert.equal(out.details.history[1], 'plain-status');
  });

  test('Preserves non-string scalar values (number, boolean, null)', () => {
    const payload = {
      count: 7,
      isFailure: true,
      missing: null,
      message: PRIVACY_SENTINELS.fakeApiKey,
    };

    const out = redactSerializable(payload) as typeof payload;

    assert.equal(out.count, 7);
    assert.equal(out.isFailure, true);
    assert.equal(out.missing, null);
    assert.ok(typeof out.message === 'string');
    assert.ok(!String(out.message).includes(PRIVACY_SENTINELS.fakeApiKey));
  });

  test('Returns a new object — does not mutate the caller-provided payload', () => {
    const original = {
      details: { token: PRIVACY_SENTINELS.fakeApiKey },
    };
    const snapshot = JSON.stringify(original);
    redactSerializable(original);
    assert.equal(JSON.stringify(original), snapshot);
  });

  test('Returns the input unchanged when given a non-string scalar', () => {
    assert.equal(redactSerializable(42), 42);
    assert.equal(redactSerializable(false), false);
    assert.equal(redactSerializable(null), null);
  });
});

// Acceptance: typed errors expose stable name/code and sanitized public messages.
// No raw invalid value is stored on public enumerable properties.
suite('TokenGaugeError typed-error contracts', () => {
  test('PrivacyViolationError exposes name=PrivacyViolationError and stable code', () => {
    const err = new PrivacyViolationError('forbidden-content', {
      detail: PRIVACY_SENTINELS.fakeApiKey,
    });
    assert.ok(err instanceof TokenGaugeError);
    assert.equal(err.name, 'PrivacyViolationError');
    assert.equal(err.code, 'TG_PRIVACY_VIOLATION');
    assert.ok(!err.message.includes(PRIVACY_SENTINELS.fakeApiKey));
  });

  test('PrivacyViolationError is an instance of TokenGaugeError and Error', () => {
    const err = new PrivacyViolationError('forbidden-content');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof TokenGaugeError);
    assert.ok(typeof err.code === 'string' && err.code.length > 0);
  });

  test('Messages with embedded sentinel substrings are redacted before being thrown', () => {
    const err = new PrivacyViolationError(`boundary failure: ${PRIVACY_SENTINELS.fakeApiKey}`);
    assert.ok(!err.message.includes(PRIVACY_SENTINELS.fakeApiKey));
    assert.match(err.message, /\[redacted:[a-z0-9-]+\]/i);
  });

  test('No raw invalid value is exposed via public enumerable properties', () => {
    const err = new PrivacyViolationError('forbidden-content', {
      detail: PRIVACY_SENTINELS.fakeApiKey,
    });
    const exposed = JSON.stringify({ ...err, message: err.message, name: err.name });
    assert.ok(!exposed.includes(PRIVACY_SENTINELS.fakeApiKey));
  });
});
