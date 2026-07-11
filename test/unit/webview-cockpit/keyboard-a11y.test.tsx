// A11y contract on the redesigned cockpit:
//   - every battery meter is a labelled role="progressbar" carrying aria-value*,
//   - interactive elements (Refresh, action links, welcome CTAs) are
//     keyboard-reachable native <button>s with no negative tabindex.
// Display/markup-only — no VM/state/metric change.

import * as assert from 'node:assert/strict';
import type { VNode } from 'preact';
import type {
  CardFreshness,
  CardRisk,
  GaugeCardViewModel,
  GaugeViewModel,
} from '../../../src/cockpit/GaugeCardViewModel';
import { AgentCard } from '../../../src/webview-cockpit/AgentCard';
import { CockpitView } from '../../../src/webview-cockpit/CockpitApp';

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

function gauge(overrides: Partial<GaugeViewModel> = {}): GaugeViewModel {
  return {
    usedPct: 50,
    leftPct: 50,
    centerLabel: '50%',
    state: 'fresh' as CardFreshness,
    accuracyLabel: 'proxy_reported',
    confidence: 'medium',
    ...overrides,
  };
}

function card(overrides: Partial<GaugeCardViewModel> = {}): GaugeCardViewModel {
  return {
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    colorKey: 'claude',
    session: gauge(),
    weekly: gauge({ centerLabel: '40%', usedPct: 40, leftPct: 60 }),
    context: gauge({ centerLabel: '20%', usedPct: 20, leftPct: 80 }),
    costLabel: '$1.00',
    risk: 'ok' as CardRisk,
    sourceTier: 'statusline_snapshot',
    accuracyLabel: 'proxy_reported',
    confidence: 'medium',
    freshness: 'fresh',
    ...overrides,
  };
}

function buttons(out: unknown): VNodeLike[] {
  return nodesWhere(out, (_props, type) => type === 'button');
}

function meters(out: unknown): VNodeLike[] {
  return nodesWhere(out, (props) => props.role === 'progressbar');
}

function tabReachable(button: VNodeLike | undefined): boolean {
  const ti = button?.props.tabindex ?? button?.props.tabIndex;
  return ti === undefined || Number(ti) >= 0;
}

suite('a11y — meters expose accessible names + values', () => {
  test('Every battery meter is a labelled progressbar with aria-value*', () => {
    const out = AgentCard({ card: card(), showTechnicalDetails: true });
    const bars = meters(out);
    // 5h + weekly + context (technical on).
    assert.ok(bars.length >= 3, `expected >=3 labelled meters, got ${bars.length}`);
    for (const bar of bars) {
      const label = bar.props['aria-label'];
      assert.equal(typeof label, 'string', 'meter missing aria-label');
      assert.ok(String(label).trim().length > 0, 'meter aria-label is empty');
      assert.equal(bar.props['aria-valuemin'], 0);
      assert.equal(bar.props['aria-valuemax'], 100);
      assert.equal(typeof bar.props['aria-valuenow'], 'number', 'meter carries aria-valuenow');
    }
  });

  test('The 5h meter names its window and carries the remaining value', () => {
    const out = AgentCard({ card: card() });
    const primary = meters(out).find((b) =>
      /5-hour window remaining/.test(String(b.props['aria-label'])),
    );
    assert.ok(primary, 'a 5-hour window meter must exist');
    assert.equal(primary?.props['aria-valuenow'], 50);
  });
});

suite('a11y — interactive elements are keyboard-reachable', () => {
  test('Refresh is a native <button> in tab order', () => {
    const out = CockpitView({ cards: [card()], onRefresh: () => {} });
    const refresh = buttons(out).filter((b) =>
      String(b.props.className ?? '').includes('cockpit-refresh'),
    );
    assert.equal(refresh.length, 1, 'one Refresh button');
    assert.ok(tabReachable(refresh[0]), 'Refresh removed from tab order');
  });

  test('The three action links are native <button>s in tab order', () => {
    const out = CockpitView({ cards: [card()], onRefresh: () => {} });
    const links = buttons(out).filter((b) =>
      String(b.props.className ?? '')
        .split(/\s+/)
        .includes('tg-link'),
    );
    assert.equal(links.length, 3, 'Configure / Privacy & data / Diagnostics');
    for (const link of links) assert.ok(tabReachable(link), 'an action link is not tab-reachable');
  });

  test('Welcome (zero cards): both setup CTAs are native <button>s in tab order', () => {
    const out = CockpitView({ cards: [], onRefresh: () => {}, onConfigure: () => {} });
    const configure = buttons(out).filter((b) =>
      String(b.props.className ?? '').includes('cockpit-configure'),
    );
    assert.ok(configure.length >= 1, 'welcome setup CTAs present');
    for (const c of configure) assert.ok(tabReachable(c), 'a welcome CTA is not tab-reachable');
  });

  test('A SetupCallout CTA is a native <button> in tab order', () => {
    const out = AgentCard({
      card: card({
        session: { centerLabel: '—', state: 'unavailable', reason: 'codex_probe_disabled' },
        freshness: 'unavailable',
        risk: 'unavailable',
        reason: 'codex_probe_disabled',
        colorKey: 'codex',
        agentLabel: 'Codex',
      }),
    });
    const cta = buttons(out);
    assert.equal(cta.length, 1, 'one SetupCallout CTA');
    assert.ok(tabReachable(cta[0]), 'the SetupCallout CTA is not tab-reachable');
  });
});
