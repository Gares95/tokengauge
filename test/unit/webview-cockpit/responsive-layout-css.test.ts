import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../_helpers/repoRoot';

function cockpitCss(): string {
  // Resolve from the repo root, not process.cwd(): the @vscode/test-electron
  // host launches with cwd set to the unpacked VS Code archive (notably on
  // Windows CI), so a cwd-relative path 404s there.
  return readFileSync(join(findRepoRoot(), 'src/webview-cockpit/cockpit.css'), 'utf8');
}

suite('responsive cockpit CSS guardrails', () => {
  test('Pins the 320px floor and around-720px max content width', () => {
    const css = cockpitCss();
    assert.match(css, /--tg-supported-floor:\s*320px;/);
    assert.match(css, /--tg-content-max:\s*720px;/);
    assert.match(css, /width:\s*min\(100%,\s*var\(--tg-content-max\)\);/);
  });

  // The floor is unconditional on the shell's BASE rule — a
  // breakpoint-scoped floor left a band where card internals compressed before
  // the floor kicked in. Below the viewport the webview scrolls horizontally.
  test('The shell owns an unconditional min-width floor', () => {
    const css = cockpitCss();
    assert.match(
      css,
      /\.cockpit-shell\s*\{[^}]*min-width:\s*var\(--tg-supported-floor\);[^}]*\}/s,
      'the base .cockpit-shell rule pins the 320px internal min-width',
    );
    const shellBlock = /\.cockpit-shell\s*\{[^}]*\}/s.exec(css)?.[0] ?? '';
    assert.match(
      shellBlock,
      /width:\s*min\(100%,\s*var\(--tg-content-max\)\)/,
      'the floor and the 720px max live on the same base rule',
    );
  });

  // Below the floor the cards stay mounted — no blocking
  // helper, no hidden content, and no breakpoint may re-flow card internals
  // into a compressed intermediate layout.
  test('Narrow widths never hide content or re-flow card internals', () => {
    const css = cockpitCss();
    assert.ok(!css.includes('tg-narrow-helper'), 'the blocking narrow helper is gone');
    assert.ok(
      !/\.tg-cockpit__content\s*\{[^}]*display:\s*none;/s.test(css),
      'cockpit content is never display:none at any width',
    );
    assert.equal(
      (css.match(/@media/g) ?? []).length,
      1,
      'exactly one breakpoint (padding relief) — keeps the media section scan sound',
    );
    const firstMedia = css.indexOf('@media');
    assert.ok(firstMedia >= 0, 'the narrow padding-relief breakpoint exists');
    // Scan the media BODY (past the condition, which legitimately says max-width).
    const mediaBody = css.slice(css.indexOf('{', firstMedia));
    assert.ok(
      !/grid-template|flex-wrap|grid-column|display\s*:|min-width|[^-]width\s*:/.test(mediaBody),
      'media queries adjust padding only — never layout structure or width floors',
    );
    assert.match(
      css,
      /@media\s*\(max-width:\s*359\.98px\)\s*\{\s*\.cockpit-shell\s*\{[^}]*padding:\s*12px;/,
      'narrow placements get padding relief only',
    );
  });

  test('Keeps narrow card internals wrapping by construction', () => {
    const css = cockpitCss();
    assert.match(css, /\.tg-stack\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
    assert.match(css, /\.tg-summary__line\s*\{[^}]*flex-wrap:\s*wrap;/s);
    assert.match(css, /\.tg-gauge__labelrow\s*\{[^}]*flex-wrap:\s*wrap;/s);
    assert.match(
      css,
      /\.tg-row\s*\{[^}]*grid-template-columns:\s*minmax\(48px,\s*max-content\)\s*minmax\(64px,\s*1fr\)\s*max-content;/s,
    );
    assert.match(css, /\.tg-stale-note\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    assert.match(css, /\.tg-context-note\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    assert.match(css, /\.tg-cta\s*\{[^}]*white-space:\s*normal;/s);
  });
});
