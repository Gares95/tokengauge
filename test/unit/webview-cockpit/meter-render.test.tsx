// The battery Meter replaces the ring gauge. These tests pin the CSP-safe
// contract (fill width is an SVG geometry attribute, never an inline style) and
// the level/aria mapping. Pure-VNode walk harness (no jsdom), matching the other
// webview render tests.

import * as assert from 'node:assert/strict';
import type { VNode } from 'preact';
import type { CardRisk } from '../../../src/cockpit/GaugeCardViewModel';
import { levelFromLeftPct, levelFromRisk, Meter } from '../../../src/webview-cockpit/Meter';

type VNodeLike = VNode<Record<string, unknown>>;

function materialize(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  const vnode = node as VNodeLike;
  if (typeof vnode.type === 'function') {
    const component = vnode.type as (props: Record<string, unknown>) => unknown;
    return component(vnode.props);
  }
  return node;
}

function childList(node: unknown): readonly unknown[] {
  const current = materialize(node);
  if (Array.isArray(current)) return current;
  if (!current || typeof current !== 'object') return [];
  const value = (current as { props?: { children?: unknown } }).props?.children;
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function walk(node: unknown, visit: (node: VNodeLike) => void): void {
  const current = materialize(node);
  if (Array.isArray(current)) {
    for (const child of current) walk(child, visit);
    return;
  }
  if (current && typeof current === 'object') visit(current as VNodeLike);
  for (const child of childList(current)) walk(child, visit);
}

function nodesWhere(
  node: unknown,
  predicate: (props: Record<string, unknown>, type: unknown) => boolean,
): VNodeLike[] {
  const matches: VNodeLike[] = [];
  walk(node, (current) => {
    if (predicate(current.props ?? {}, current.type)) matches.push(current);
  });
  return matches;
}

function fillRect(out: unknown): VNodeLike | undefined {
  return nodesWhere(out, (props) =>
    String(props.className ?? '')
      .split(/\s+/)
      .includes('tg-meter__fill'),
  )[0];
}

function serializeProps(node: unknown): string {
  const chunks: string[] = [];
  walk(node, (current) => {
    if (current.props) for (const key of Object.keys(current.props)) chunks.push(key);
  });
  return chunks.join(' ');
}

suite('Battery meter render', () => {
  test('LeftPct 72 sets the fill rect width to 72 (SVG geometry, not a style)', () => {
    const out = Meter({ leftPct: 72, level: 'ok', ariaLabel: '5-hour window remaining' });
    const fill = fillRect(out);
    assert.ok(fill, 'a fill rect must exist');
    assert.equal(Number(fill.props.width), 72);
    assert.equal(fill.props['data-level'], 'ok');
  });

  test('The meter is a labelled progressbar carrying % remaining as aria-valuenow', () => {
    const out = Meter({ leftPct: 18, level: 'warn', ariaLabel: '5-hour window remaining' });
    const bars = nodesWhere(out, (props) => props.role === 'progressbar');
    assert.equal(bars.length, 1);
    assert.equal(bars[0]?.props['aria-valuenow'], 18);
    assert.equal(bars[0]?.props['aria-valuemin'], 0);
    assert.equal(bars[0]?.props['aria-valuemax'], 100);
    assert.equal(bars[0]?.props['aria-label'], '5-hour window remaining');
  });

  test('LeftPct clamps to 0..100', () => {
    assert.equal(
      Number(fillRect(Meter({ leftPct: 150, level: 'ok', ariaLabel: 'x' }))?.props.width),
      100,
    );
    assert.equal(
      Number(fillRect(Meter({ leftPct: -5, level: 'crit', ariaLabel: 'x' }))?.props.width),
      0,
    );
  });

  test('The large variant carries the tg-meter--lg class', () => {
    const out = Meter({ leftPct: 50, level: 'ok', large: true, ariaLabel: 'x' });
    const bar = nodesWhere(out, (props) => props.role === 'progressbar')[0];
    assert.match(String(bar?.props.className), /tg-meter--lg/);
  });

  test('Rendered markup contains zero inline style= attributes', () => {
    const out = Meter({ leftPct: 40, level: 'warn', large: true, ariaLabel: 'x' });
    assert.ok(!/\bstyle\b/.test(serializeProps(out)), 'meter must not use an inline style prop');
  });

  test('LevelFromLeftPct: <8 crit, <20 warn, else ok (handoff thresholds)', () => {
    assert.equal(levelFromLeftPct(7), 'crit');
    assert.equal(levelFromLeftPct(8), 'warn');
    assert.equal(levelFromLeftPct(19), 'warn');
    assert.equal(levelFromLeftPct(20), 'ok');
    assert.equal(levelFromLeftPct(72), 'ok');
  });

  test('LevelFromRisk mirrors the host-derived card risk', () => {
    const cases: ReadonlyArray<readonly [CardRisk, string]> = [
      ['ok', 'ok'],
      ['warning', 'warn'],
      ['critical', 'crit'],
      ['unavailable', 'ok'],
    ];
    for (const [risk, level] of cases) assert.equal(levelFromRisk(risk), level);
  });
});
