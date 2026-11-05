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

// The supported width floor. Below it the webview scrolls horizontally; at or
// above it every card renders without horizontal scroll.
const SUPPORTED_FLOOR_PX = 256;

// The first rule whose selector is exactly `selector` (not a compound like
// `body.vscode-dark` or `.tg-card__body`). Returns the declaration block body.
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `missing top-level rule for ${selector}`);
  return match[1] ?? '';
}

function pxValue(block: string, property: string, label: string): number {
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(block);
  assert.ok(match, `${label} must declare ${property} in px`);
  return Number(match[1]);
}

function mediaBody(css: string): string {
  const firstMedia = css.indexOf('@media');
  assert.ok(firstMedia >= 0, 'the narrow padding-relief breakpoint exists');
  // Scan the media BODY (past the condition, which legitimately says max-width).
  return css.slice(css.indexOf('{', firstMedia));
}

suite('responsive cockpit CSS guardrails', () => {
  test('Pins the 256px floor and around-720px max content width', () => {
    const css = cockpitCss();
    assert.match(css, /--tg-supported-floor:\s*256px;/);
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
      'the base .cockpit-shell rule pins the 256px internal min-width',
    );
    const shellBlock = /\.cockpit-shell\s*\{[^}]*\}/s.exec(css)?.[0] ?? '';
    assert.match(
      shellBlock,
      /width:\s*min\(100%,\s*var\(--tg-content-max\)\)/,
      'the floor and the 720px max live on the same base rule',
    );
  });

  // Regression: the body carried its own 280px min-width, which sat ABOVE a
  // narrower shell floor and became the real binding width. The body must
  // follow the shared token so there is exactly one floor.
  test('The body follows the shared floor instead of carrying a larger one', () => {
    const css = cockpitCss();
    assert.match(
      ruleBody(css, 'body'),
      /min-width:\s*var\(--tg-supported-floor\);/,
      'body min-width must reference --tg-supported-floor',
    );
  });

  // No other fixed min-width / width in the stylesheet may exceed the floor:
  // any such box would force horizontal scroll inside the supported range.
  test('No fixed width or min-width anywhere exceeds the supported floor', () => {
    const css = cockpitCss().replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = [...css.matchAll(/(?:^|[;{\s])((?:min-)?width):\s*(\d+(?:\.\d+)?)px/g)]
      .filter((match) => Number(match[2]) >= SUPPORTED_FLOOR_PX)
      .map((match) => `${match[1]}: ${match[2]}px`);
    assert.deepEqual(offenders, [], 'fixed widths at or above the floor force horizontal scroll');
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
    assert.ok(
      !/grid-template|flex-wrap|grid-column|display\s*:|min-width|[^-]width\s*:/.test(
        mediaBody(css),
      ),
      'media queries adjust padding only — never layout structure or width floors',
    );
    assert.match(
      css,
      /@media\s*\(max-width:\s*359\.98px\)\s*\{\s*\.cockpit-shell\s*\{[^}]*padding:\s*12px;/,
      'narrow placements get padding relief only',
    );
  });

  // The padding-relief breakpoint must cover the floor itself, otherwise the
  // narrowest supported width would render with the wider default padding.
  test('The padding-relief breakpoint applies at the supported floor', () => {
    const css = cockpitCss();
    const condition = /@media\s*\(max-width:\s*(\d+(?:\.\d+)?)px\)/.exec(css);
    assert.ok(condition, 'the padding-relief breakpoint is a max-width query');
    assert.ok(
      Number(condition[1]) >= SUPPORTED_FLOOR_PX,
      'padding relief must still apply at the supported floor',
    );
  });

  // Width budget at the floor for the tightest card row: the secondary window
  // row (label | meter | "100% left"). The track minimums, gaps, and every
  // horizontal padding/border between the viewport and that row are read from
  // the stylesheet, so growing any of them past what the floor can hold fails
  // here instead of shipping a horizontal scroll. Under pressure the grid
  // shrinks the label track toward its minimum before the meter track goes
  // under its own. 58px covers "100% left" at 12px tabular numerals, the widest
  // value the row renders (measured 50 to 58px in Liberation Sans, Inter, and
  // DejaVu Sans).
  test('The floor leaves room for the widest secondary-row value text', () => {
    const css = cockpitCss();
    const media = mediaBody(css);
    const narrowShellPad = pxValue(ruleBody(media, '.cockpit-shell'), 'padding', 'narrow shell');
    const narrowCardPad = pxValue(ruleBody(media, '.tg-card__body'), 'padding', 'narrow card');
    const cardBorder = pxValue(ruleBody(css, '.tg-card'), 'border', '.tg-card');
    const row = ruleBody(css, '.tg-row');
    const rowGap = pxValue(row, 'gap', '.tg-row');
    const tracks =
      /grid-template-columns:\s*minmax\((\d+)px,\s*max-content\)\s*minmax\((\d+)px,\s*1fr\)/.exec(
        row,
      );
    assert.ok(tracks, '.tg-row keeps minimum label and meter tracks');
    const labelTrackMin = Number(tracks[1]);
    const meterTrackMin = Number(tracks[2]);

    const rowContent = SUPPORTED_FLOOR_PX - 2 * narrowShellPad - 2 * cardBorder - 2 * narrowCardPad;
    const valueRoom = rowContent - labelTrackMin - meterTrackMin - 2 * rowGap;
    assert.ok(
      valueRoom >= 58,
      `at ${SUPPORTED_FLOOR_PX}px the window row leaves ${valueRoom}px for its value text`,
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
