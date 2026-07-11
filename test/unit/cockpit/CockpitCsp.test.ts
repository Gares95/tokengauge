import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCockpitCsp, createNonce } from '../../../src/cockpit/csp';
import { findRepoRoot } from '../../_helpers/repoRoot';

suite('Cockpit CSP', () => {
  test('CreateNonce returns URL-safe random strings', () => {
    const nonce = createNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{32,}$/);
    assert.notEqual(nonce, createNonce());
  });

  test('CSP contains nonce directives and no unsafe or remote sources', () => {
    const csp = buildCockpitCsp({ nonce: 'abc123', webviewCspSource: 'vscode-resource:' });

    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("connect-src 'none'"));
    assert.ok(csp.includes("script-src 'nonce-abc123'"));
    assert.ok(csp.includes("style-src vscode-resource: 'nonce-abc123'"));
    assert.ok(!csp.includes('unsafe-inline'));
    assert.ok(!csp.includes('unsafe-eval'));
    assert.ok(!csp.includes('http:'));
    assert.ok(!csp.includes('https:'));
    assert.ok(!csp.includes('*'));
  });

  test('CSP builder source has no forbidden source literals', () => {
    const source = readFileSync(join(findRepoRoot(), 'src/cockpit/csp.ts'), 'utf8');

    assert.ok(!source.includes('unsafe-inline'));
    assert.ok(!source.includes('unsafe-eval'));
    assert.ok(!source.includes('https:'));
    assert.ok(!source.includes('http:'));
  });
});
