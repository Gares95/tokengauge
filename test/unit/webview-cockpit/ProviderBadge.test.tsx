// Provider reminder badges. The known providers render their inline
// SVG art (decorative, aria-hidden); unknown providers fall back to the plain
// CSS monogram letter. The badge must never be the sole state signal and must
// carry no external asset/script.

import * as assert from 'node:assert/strict';
import type { VNode } from 'preact';
import { ProviderBadge } from '../../../src/webview-cockpit/ProviderBadge';

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

function walk(node: unknown, visit: (node: VNodeLike) => void): void {
  const current = materialize(node);
  if (Array.isArray(current)) {
    for (const child of current) walk(child, visit);
    return;
  }
  if (current && typeof current === 'object') {
    visit(current as VNodeLike);
    const children = (current as { props?: { children?: unknown } }).props?.children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) walk(child, visit);
  }
}

function typesInTree(node: unknown): string[] {
  const types: string[] = [];
  walk(node, (n) => {
    if (typeof n.type === 'string') types.push(n.type);
  });
  return types;
}

function props(node: unknown): Record<string, unknown> {
  return (node as VNodeLike).props ?? {};
}

function nodesOfType(node: unknown, type: string): VNodeLike[] {
  const found: VNodeLike[] = [];
  walk(node, (n) => {
    if (n.type === type) found.push(n);
  });
  return found;
}

suite('ProviderBadge', () => {
  test('Claude renders the art badge container with an inline svg, no letter', () => {
    const out = ProviderBadge({ colorKey: 'claude', fallbackLabel: 'C' });
    const p = props(out);
    assert.equal(p.className, 'tg-monogram tg-monogram--art');
    assert.equal(p['data-agent'], 'claude');
    assert.equal(p['aria-hidden'], 'true');
    assert.ok(typesInTree(out).includes('svg'), 'claude badge must render an <svg>');
    // The fallback letter must not be emitted when the art badge renders.
    assert.equal(p.children === 'C', false);
  });

  test('Codex renders the art badge container with an inline svg', () => {
    const out = ProviderBadge({ colorKey: 'codex', fallbackLabel: '›' });
    const p = props(out);
    assert.equal(p.className, 'tg-monogram tg-monogram--art');
    assert.equal(p['data-agent'], 'codex');
    assert.ok(typesInTree(out).includes('svg'), 'codex badge must render an <svg>');
  });

  test('Codex badge renders the approved blue gradient (hyphenated stop-color, never black)', () => {
    // Regression: Preact does NOT camelCase-convert SVG attributes, so `stopColor`
    // renders as an ignored attribute and the <stop>s default to BLACK. The badge
    // must use the DOM attribute `stop-color` with the approved blue values.
    const out = ProviderBadge({ colorKey: 'codex', fallbackLabel: '›' });
    const stops = nodesOfType(out, 'stop');
    assert.equal(stops.length, 2, 'codex gradient must have two stops');
    const stopColors = stops.map((s) => (s.props as { 'stop-color'?: unknown })['stop-color']);
    assert.deepEqual(stopColors, ['#5AA6FF', '#2F7BEA'], 'stops carry the approved blue values');
    for (const s of stops) {
      assert.equal(
        'stopColor' in (s.props as Record<string, unknown>),
        false,
        'must use hyphenated stop-color, not camelCase stopColor',
      );
    }
    // The fill rect references the gradient by its (unique) id.
    const gradients = nodesOfType(out, 'linearGradient');
    assert.equal(gradients.length, 1, 'exactly one gradient');
    assert.equal((gradients[0].props as { id?: unknown }).id, 'tg-codex-badge');
    const fills = nodesOfType(out, 'rect').map((r) => (r.props as { fill?: unknown }).fill);
    assert.ok(fills.includes('url(#tg-codex-badge)'), 'a rect fills with the gradient');
  });

  test('Unknown provider falls back to the plain monogram letter', () => {
    const out = ProviderBadge({ colorKey: 'other', fallbackLabel: 'A' });
    const p = props(out);
    assert.equal(p.className, 'tg-monogram');
    assert.equal(p['aria-hidden'], 'true');
    assert.equal(p.children, 'A');
    assert.equal(typesInTree(out).includes('svg'), false, 'fallback renders no svg');
  });

  test('Badges carry no external/script/image nodes (CSP-safe inline vectors)', () => {
    for (const colorKey of ['claude', 'codex']) {
      const types = typesInTree(ProviderBadge({ colorKey, fallbackLabel: 'X' }));
      for (const banned of ['script', 'image', 'foreignObject', 'iframe', 'img']) {
        assert.equal(
          types.includes(banned),
          false,
          `${colorKey} badge must not contain <${banned}>`,
        );
      }
    }
  });
});
