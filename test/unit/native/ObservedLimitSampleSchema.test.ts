// Observed-limit sample schema unit tests.
//
// Assert the strict boundary: a valid sample parses; an unknown key (e.g.
// `prompt`) fails `.strict()`; over-length note and out-of-enum plan fail; and
// the leaky statusLine fixture — once its placeholder slots are filled with real
// fragment-assembled sentinels at runtime — both fails the strict schema (extra
// forbidden keys) and trips the Redactor. Grep target: "ObservedLimitSampleSchema".

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OBSERVED_LIMIT_NOTE_MAX,
  OBSERVED_LIMIT_SAMPLE_FREE_TEXT_FIELDS,
  ObservedLimitSampleSchema,
} from '../../../src/core/native/ObservedLimitSampleSchema';
import { redactString } from '../../../src/security/Redactor';
import { findRepoRoot } from '../../_helpers/repoRoot';
import { PRIVACY_SENTINELS } from '../../fixtures/privacy/sentinels';

const SAMPLE_FIXTURE_DIR = join(findRepoRoot(), 'test', 'fixtures', 'observed-limit');
const STATUSLINE_FIXTURE_DIR = join(findRepoRoot(), 'test', 'fixtures', 'statusline');

const VALID_ID = `${'0'.repeat(63)}1`;

function validSample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

suite('ObservedLimitSampleSchema: strict boundary', () => {
  test('A valid sample parses and round-trips its fields', () => {
    const out = ObservedLimitSampleSchema.parse(validSample({ note: 'ok' }));
    assert.equal(out.provider, 'anthropic');
    assert.equal(out.agent, 'claude-code');
    assert.equal(out.plan, 'max5x');
    assert.equal(out.windowType, 'session');
    assert.equal(out.observedTokenGaugeTokens, 120000);
    assert.equal(out.limitHitFlag, false);
    assert.equal(out.note, 'ok');
  });

  test('Every sanitized fixture sample parses', () => {
    const raw = readFileSync(join(SAMPLE_FIXTURE_DIR, 'samples-sanitized.json'), 'utf8');
    const samples = JSON.parse(raw) as unknown[];
    assert.ok(samples.length >= 3);
    for (const sample of samples) {
      assert.doesNotThrow(() => ObservedLimitSampleSchema.parse(sample));
    }
  });

  test('An unknown `prompt` key fails .strict() parse', () => {
    assert.throws(() =>
      ObservedLimitSampleSchema.parse(validSample({ prompt: 'a leaked prompt body' })),
    );
  });

  test('An over-length note is rejected', () => {
    assert.throws(() =>
      ObservedLimitSampleSchema.parse(
        validSample({ note: 'x'.repeat(OBSERVED_LIMIT_NOTE_MAX + 1) }),
      ),
    );
  });

  test('An out-of-enum plan is rejected', () => {
    assert.throws(() => ObservedLimitSampleSchema.parse(validSample({ plan: 'enterprise-ultra' })));
  });

  test('Content-scanned fields are [note, scopeHash]', () => {
    // scopeHash is scanned because it can be populated from an external snapshot
    // field (session_id_hash/workspace_hash) — WR-01 defence-in-depth.
    assert.deepEqual([...OBSERVED_LIMIT_SAMPLE_FREE_TEXT_FIELDS], ['note', 'scopeHash']);
  });
});

suite('ObservedLimitSampleSchema: leaky statusLine fixture', () => {
  // Fill the inert placeholder slots in the committed fixture with real
  // fragment-assembled sentinels at runtime. No committed file ever holds a
  // contiguous forbidden literal (mirrors test/fixtures/privacy/sentinels.ts).
  function loadLeakyWithSentinels(): { json: string; parsed: Record<string, unknown> } {
    let json = readFileSync(join(STATUSLINE_FIXTURE_DIR, 'statusline-snapshot-leaky.json'), 'utf8');
    json = json
      .replaceAll('__SENTINEL_SLOT_PATH__', PRIVACY_SENTINELS.fakePosixPath)
      .replaceAll('__SENTINEL_SLOT_GITREMOTE__', PRIVACY_SENTINELS.fakeGitRemote)
      .replaceAll('__SENTINEL_SLOT_APIKEY__', PRIVACY_SENTINELS.fakeApiKey);
    return { json, parsed: JSON.parse(json) as Record<string, unknown> };
  }

  test('The leaky snapshot fails ObservedLimitSampleSchema (extra forbidden keys)', () => {
    const { parsed } = loadLeakyWithSentinels();
    assert.throws(() => ObservedLimitSampleSchema.parse(parsed));
  });

  test('The leaky snapshot content trips the Redactor', () => {
    const { json } = loadLeakyWithSentinels();
    const redacted = redactString(json);
    assert.match(redacted, /\[redacted:/);
  });
});
