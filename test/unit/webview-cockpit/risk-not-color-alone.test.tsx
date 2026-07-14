// Risk state must NOT be conveyed by color alone. Each
// active risk level (warning/critical) carries a non-color TEXT + inline-SVG cue
// on the card; risk=ok stays quiet (no risk noise). The agent color class /
// hue identity is preserved — the cue is additive, never a
// replacement for the agent arc color.

import * as assert from 'node:assert/strict';
import type { VNode } from 'preact';
import type {
  CardFreshness,
  CardRisk,
  GaugeCardViewModel,
  GaugeViewModel,
} from '../../../src/cockpit/GaugeCardViewModel';
import { AgentCard } from '../../../src/webview-cockpit/AgentCard';

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

function textContent(node: unknown): string {
  const chunks: string[] = [];
  const collect = (n: unknown): void => {
    const current = materialize(n);
    if (typeof current === 'string' || typeof current === 'number') {
      chunks.push(String(current));
      return;
    }
    if (Array.isArray(current)) {
      for (const c of current) collect(c);
      return;
    }
    for (const child of childList(current)) collect(child);
  };
  collect(node);
  return chunks.join(' ');
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

function gauge(overrides: Partial<GaugeViewModel> = {}): GaugeViewModel {
  return {
    usedPct: 92,
    leftPct: 8,
    centerLabel: '92%',
    state: 'fresh' as CardFreshness,
    accuracyLabel: 'proxy_reported',
    confidence: 'high',
    ...overrides,
  };
}

function card(overrides: Partial<GaugeCardViewModel> = {}): GaugeCardViewModel {
  return {
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    colorKey: 'claude',
    session: gauge(),
    weekly: gauge({ centerLabel: '60%', usedPct: 60, leftPct: 40 }),
    context: gauge({ centerLabel: '30%', usedPct: 30, leftPct: 70 }),
    costLabel: '$3.10',
    risk: 'critical' as CardRisk,
    sourceTier: 'statusline_snapshot',
    accuracyLabel: 'proxy_reported',
    confidence: 'high',
    freshness: 'fresh',
    ...overrides,
  };
}

function riskPills(out: unknown): VNodeLike[] {
  // Match the pill root only (className token === 'risk-pill'), not its
  // 'risk-pill__icon' / 'risk-pill__text' descendants.
  return nodesWhere(out, (props) =>
    String(props.className ?? '')
      .split(/\s+/)
      .includes('risk-pill'),
  );
}

suite('Risk is never conveyed by color alone', () => {
  test('Risk=critical renders a non-color text cue ("Critical") in a risk-status pill', () => {
    const out = AgentCard({ card: card({ risk: 'critical' }) });
    const pills = riskPills(out);
    assert.equal(pills.length, 1, 'exactly one risk pill for an active risk');
    assert.match(textContent(pills[0]), /critical/i);
    // It is announced (role="status") so the cue is not visual-only.
    assert.equal(pills[0]?.props.role, 'status');
  });

  test('Risk=warning renders a non-color text cue ("Near limit")', () => {
    const out = AgentCard({ card: card({ risk: 'warning' }) });
    const pills = riskPills(out);
    assert.equal(pills.length, 1);
    assert.match(textContent(pills[0]), /near limit/i);
  });

  test('The risk pill carries an inline SVG icon (a second non-color channel)', () => {
    const out = AgentCard({ card: card({ risk: 'warning' }) });
    const svgs = nodesWhere(out, (_props, type) => type === 'svg').filter((svg) => {
      // an svg whose aria-hidden marks it decorative beside the text label
      return svg.props?.['aria-hidden'] === true || svg.props?.['aria-hidden'] === 'true';
    });
    assert.ok(svgs.length >= 1, 'expected a decorative inline SVG warning glyph');
  });

  test('Risk=ok renders NO risk pill (quiet — no risk noise)', () => {
    const out = AgentCard({ card: card({ risk: 'ok' }) });
    assert.equal(riskPills(out).length, 0);
    assert.ok(!/near limit/i.test(textContent(out)));
    assert.ok(!/\bcritical\b/i.test(textContent(out)));
  });

  test('Risk=unavailable renders NO risk pill (absence is handled by reason, not a risk cue)', () => {
    const out = AgentCard({ card: card({ risk: 'unavailable' }) });
    assert.equal(riskPills(out).length, 0);
  });

  test('Agent color class / hue identity is preserved under an active risk (cue is additive)', () => {
    const out = AgentCard({ card: card({ risk: 'critical', colorKey: 'claude' }) });
    // The card still carries its agent-claude identity class + the data-agent hue
    // hook that drives --tg-accent (the risk override is the meter fill color via
    // data-level — the agent identity is never stripped).
    const cardNodes = nodesWhere(out, (props) =>
      String(props.className ?? '')
        .split(/\s+/)
        .includes('agent-claude'),
    );
    assert.ok(cardNodes.length >= 1, 'agent-claude class must remain on the card');
    const hueHook = nodesWhere(out, (props) => props['data-agent'] === 'claude');
    assert.ok(hueHook.length >= 1, 'the data-agent hue hook must remain on the card');
    // The primary battery meter still renders — its color carries the risk
    // ADDITIVELY to the text pill, never as the only cue.
    const meters = nodesWhere(out, (props) => props.role === 'progressbar');
    assert.ok(meters.length >= 1, 'the primary battery meter must render');
  });
});
