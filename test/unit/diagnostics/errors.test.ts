import * as assert from 'node:assert/strict';
import { classifyActivationFailure } from '../../../src/core/diagnostics/errors';

// Relocated from the removed cost-engine errors suite: the
// pricing-specific failure code is gone, but the privacy-safe activation-error
// classifier remains for the extension's `.catch` diagnostics.
suite('ClassifyActivationFailure', () => {
  test('An Error becomes unknown-with-error-name (never the raw message/path)', () => {
    assert.equal(classifyActivationFailure(new Error('boom')), 'unknown-with-error-name');
    assert.equal(
      classifyActivationFailure(Object.assign(new Error('x'), { code: 'ENOENT' })),
      'unknown-with-error-name',
    );
  });

  test('A non-Error value collapses to unknown', () => {
    assert.equal(classifyActivationFailure('a string'), 'unknown');
    assert.equal(classifyActivationFailure(null), 'unknown');
    assert.equal(classifyActivationFailure(42), 'unknown');
    assert.equal(classifyActivationFailure(undefined), 'unknown');
  });

  test('The derived code is never the raw message or a path', () => {
    const enoent = Object.assign(new Error("ENOENT: no such file, open '/home/user/x'"), {
      code: 'ENOENT',
    });
    const code = classifyActivationFailure(enoent);
    assert.ok(!/[/\\]/.test(code), 'derived code must be path-free');
    assert.equal(code, 'unknown-with-error-name');
  });
});
