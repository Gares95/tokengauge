// The presentation classifier (state mapping) + the leaf components. The
// cardinal honesty rule under test: a card with NO session value classifies to a
// no-meter state (notConfigured/disabled/unavailable/error) — never a 0% gauge.

import * as assert from 'node:assert/strict';
import type { VNode } from 'preact';
import type {
  CardFreshness,
  CardRisk,
  GaugeCardViewModel,
  GaugeViewModel,
} from '../../../src/cockpit/GaugeCardViewModel';
import type { CockpitFieldReason } from '../../../src/core/cockpit/CockpitState';
import {
  badgeForState,
  cardVisualState,
  edgeForState,
  monogramFor,
  setupCalloutFor,
  summarize,
} from '../../../src/webview-cockpit/cardVisualState';
import { PrivacyFooter } from '../../../src/webview-cockpit/PrivacyFooter';
import { SetupCallout } from '../../../src/webview-cockpit/SetupCallout';
import { StateBadge } from '../../../src/webview-cockpit/StateBadge';
import { SummaryStatus } from '../../../src/webview-cockpit/SummaryStatus';

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
    usedPct: 50,
    leftPct: 50,
    centerLabel: '50%',
    state: 'fresh' as CardFreshness,
    ...overrides,
  };
}

function valuelessGauge(reason: CockpitFieldReason): GaugeViewModel {
  return { centerLabel: '—', state: 'unavailable', reason };
}

function card(overrides: Partial<GaugeCardViewModel> = {}): GaugeCardViewModel {
  return {
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    colorKey: 'claude',
    session: gauge(),
    weekly: gauge(),
    context: gauge(),
    risk: 'ok' as CardRisk,
    sourceTier: 'statusline_snapshot',
    freshness: 'fresh',
    ...overrides,
  };
}

// A no-value card: session unavailable + a blocker reason (mirrors the VM builder).
function blockedCard(reason: CockpitFieldReason, overrides: Partial<GaugeCardViewModel> = {}) {
  return card({
    session: valuelessGauge(reason),
    weekly: valuelessGauge(reason),
    context: valuelessGauge(reason),
    risk: 'unavailable',
    sourceTier: 'unknown',
    freshness: 'unavailable',
    reason,
    ...overrides,
  });
}

suite('cardVisualState — state mapping', () => {
  test('A fresh card with a session value → live', () => {
    assert.equal(cardVisualState(card({ freshness: 'fresh' })), 'live');
  });

  test('A card with a retained value but non-fresh → stale (last known)', () => {
    assert.equal(
      cardVisualState(card({ freshness: 'stale', reason: 'native_status_stale' })),
      'stale',
    );
    assert.equal(
      cardVisualState(card({ freshness: 'degraded', reason: 'snapshot_writer_collision' })),
      'stale',
    );
  });

  test('No-value blockers map to no-meter states', () => {
    assert.equal(
      cardVisualState(blockedCard('statusline_snapshot_not_configured')),
      'notConfigured',
    );
    // no_source/no_candidate also cover "configured but unreadable" — they must
    // read as unavailable, never deny a configuration the user made.
    assert.equal(cardVisualState(blockedCard('no_source')), 'unavailable');
    assert.equal(cardVisualState(blockedCard('no_candidate')), 'unavailable');
    assert.equal(cardVisualState(blockedCard('codex_probe_disabled')), 'disabled');
    assert.equal(cardVisualState(blockedCard('codex_cli_not_found')), 'unavailable');
    assert.equal(cardVisualState(blockedCard('codex_probe_pending')), 'unavailable');
    assert.equal(cardVisualState(blockedCard('native_window_reset_pending')), 'unavailable');
    assert.equal(cardVisualState(blockedCard('codex_probe_failed')), 'error');
    assert.equal(cardVisualState(blockedCard('codex_probe_timeout')), 'error');
    assert.equal(cardVisualState(blockedCard('codex_protocol_drift')), 'error');
    assert.equal(cardVisualState(blockedCard('codex_probe_no_response')), 'error');
  });

  test('A no-value card with no classifying reason is unavailable (never a 0% gauge)', () => {
    const c = card({
      session: { centerLabel: '—', state: 'unavailable' },
      freshness: 'unavailable',
      risk: 'unavailable',
    });
    assert.equal(cardVisualState(c), 'unavailable');
  });

  test('Edge: error → crit, live/stale → brand, else neutral', () => {
    assert.equal(edgeForState('error'), 'crit');
    assert.equal(edgeForState('live'), 'brand');
    assert.equal(edgeForState('stale'), 'brand');
    assert.equal(edgeForState('notConfigured'), 'neutral');
    assert.equal(edgeForState('disabled'), 'neutral');
    assert.equal(edgeForState('unavailable'), 'neutral');
  });

  test('Badge tone + label per state', () => {
    assert.deepEqual(badgeForState('live'), { tone: 'live', label: 'Live' });
    assert.deepEqual(badgeForState('stale'), { tone: 'stale', label: 'Last known' });
    assert.deepEqual(badgeForState('notConfigured'), { tone: 'muted', label: 'Not configured' });
    assert.deepEqual(badgeForState('disabled'), { tone: 'muted', label: 'Probe off' });
    assert.deepEqual(badgeForState('unavailable'), { tone: 'muted', label: 'Unavailable' });
    assert.deepEqual(badgeForState('error'), { tone: 'blocked', label: 'Blocked' });
  });

  test('Monogram: C for Claude, › for Codex, first letter otherwise', () => {
    assert.equal(monogramFor(card({ colorKey: 'claude' })), 'C');
    assert.equal(monogramFor(card({ colorKey: 'codex' })), '›');
    assert.equal(monogramFor(card({ colorKey: 'other', agentLabel: 'Aider' })), 'A');
  });

  test('SetupCalloutFor maps reasons to the design copy + a read-only action', () => {
    const claude = setupCalloutFor(blockedCard('statusline_snapshot_not_configured'));
    assert.match(claude.title, /Not configured/);
    assert.match(claude.msg, /Claude statusLine snapshot/);
    assert.match(claude.msg, /per-session directory/);
    assert.match(claude.msg, /single-file mode/);
    assert.equal(claude.ctaLabel, 'Configure snapshot path');
    assert.equal(claude.action, 'openClaudeSnapshotPathSetting');
    assert.equal(claude.settingTarget, undefined);

    const noLimits = setupCalloutFor(blockedCard('statusline_snapshot_missing_rate_limits'));
    assert.equal(noLimits.title, 'Waiting for limit fields');
    assert.match(noLimits.msg, /snapshot/i);
    assert.match(noLimits.msg, /rate-limit fields/i);
    assert.match(noLimits.msg, /will not guess/i);
    assert.equal(noLimits.ctaLabel, 'Open diagnostics');
    assert.equal(noLimits.action, 'openCockpitDiagnostics');

    const probeOff = setupCalloutFor(blockedCard('codex_probe_disabled'));
    assert.match(probeOff.msg, /explicit opt-in probe/);
    assert.match(probeOff.msg, /off by default/);
    assert.match(probeOff.msg, /no provider secrets/i);
    assert.equal(probeOff.ctaLabel, 'Open probe setting');
    assert.equal(probeOff.action, 'openSettings');
    assert.equal(probeOff.settingTarget, 'codexProbe');

    const cli = setupCalloutFor(blockedCard('codex_cli_not_found'));
    assert.equal(cli.ctaLabel, 'Recheck native status');
    assert.equal(cli.action, 'refreshNativeStatus');
  });

  test('The unmapped-absence fallback never claims "not configured"', () => {
    for (const reason of ['no_source', 'no_candidate'] as const) {
      const spec = setupCalloutFor(blockedCard(reason));
      assert.equal(spec.title, 'No native status');
      assert.ok(
        !/not configured/i.test(spec.title) && !/not configured/i.test(spec.msg),
        'a configured-but-unreadable source must not read as unconfigured',
      );
      assert.match(spec.msg, /Diagnostics/);
      assert.equal(spec.action, 'configureCockpit');
    }
  });
});

suite('summarize — top-of-view aggregation', () => {
  const live = (agent: GaugeCardViewModel['agent']) =>
    card({ agent, agentLabel: agent === 'codex' ? 'Codex' : 'Claude Code', freshness: 'fresh' });

  test('All live → "All sources live" (live tone)', () => {
    const s = summarize([live('claude-code'), live('codex')], { checkedLabel: '20:08' });
    assert.equal(s.tone, 'live');
    assert.equal(s.text, 'All sources live');
    assert.match(s.sub ?? '', /Checked 20:08/);
    assert.match(s.sub ?? '', /native sources fresh/);
  });

  test('One live + one disabled → "1 source live"', () => {
    const s = summarize([
      live('claude-code'),
      blockedCard('codex_probe_disabled', { agentLabel: 'Codex' }),
    ]);
    assert.equal(s.tone, 'live');
    assert.equal(s.text, '1 source live');
  });

  test('Stale + no live → "Last known status" (warn-tone dot)', () => {
    const stale = card({ freshness: 'stale', reason: 'native_status_stale' });
    const s = summarize([stale, blockedCard('codex_probe_disabled')]);
    assert.equal(s.tone, 'stale');
    assert.equal(s.text, 'Last known status');
  });

  test('An errored source → "A source is blocked" (blocked tone) naming the agent', () => {
    const s = summarize([
      live('codex'),
      blockedCard('codex_probe_failed', { agent: 'claude-code', agentLabel: 'Claude Code' }),
    ]);
    assert.equal(s.tone, 'blocked');
    assert.equal(s.text, 'A source is blocked');
    assert.match(s.sub ?? '', /Claude Code/);
  });

  test('Nothing usable but configurable → "Setup needed" (muted)', () => {
    const s = summarize([
      blockedCard('statusline_snapshot_not_configured'),
      blockedCard('codex_probe_disabled'),
    ]);
    assert.equal(s.tone, 'muted');
    assert.equal(s.text, 'Setup needed');
  });
});

suite('leaf components', () => {
  test('StateBadge: text label carries meaning; dot is decorative', () => {
    const out = StateBadge({ tone: 'live', label: 'Live' });
    assert.match(textContent(out), /Live/);
    const dots = nodesWhere(out, (props) =>
      String(props.className ?? '')
        .split(/\s+/)
        .includes('tg-badge__dot'),
    );
    assert.equal(dots.length, 1);
    assert.equal(dots[0]?.props['aria-hidden'], 'true');
  });

  test('SetupCallout: title + msg + CTA button, NO progressbar (no fake gauge)', () => {
    let clicked = 0;
    const out = SetupCallout({
      spec: {
        title: 'Native probe is off',
        msg: 'Codex status uses an explicit opt-in probe, off by default.',
        ctaLabel: 'Open probe setting',
        action: 'configureCockpit',
      },
      onCta: () => clicked++,
    });
    const text = textContent(out);
    assert.match(text, /Native probe is off/);
    assert.match(text, /Open probe setting/);
    // Honesty: a no-value card shows NO meter.
    assert.equal(nodesWhere(out, (props) => props.role === 'progressbar').length, 0);
    const button = nodesWhere(out, (_props, type) => type === 'button')[0];
    assert.ok(button, 'a CTA button must exist');
    (button.props.onClick as () => void)();
    assert.equal(clicked, 1);
  });

  test('PrivacyFooter: both lines render with the agent attribution', () => {
    const out = PrivacyFooter({ agentLabel: 'Claude Code' });
    const text = textContent(out);
    assert.match(text, /Reported by Claude Code/);
    assert.match(text, /Reads only your agent's status — never your prompts, code, or logs/);
  });

  test('SummaryStatus: stale tone maps to the warn dot; text is shown', () => {
    const out = SummaryStatus({
      summary: { tone: 'stale', text: 'Last known status', sub: 'not live' },
    });
    assert.match(textContent(out), /Last known status/);
    const dot = nodesWhere(out, (props) =>
      String(props.className ?? '').includes('tg-summary__dot--warn'),
    );
    assert.equal(dot.length, 1, 'stale summary tone renders the amber/warn dot');
  });
});

// A rewritten-but-semantically-stale snapshot (fresh mtime, already-
// passed reset window) must read as "waiting for a fresh sample" with the ONE
// action that produces one — not like a broken install.
suite('setupCalloutFor — waiting-for-fresh-sample copy (window reset)', () => {
  test('Names the agent and the action that produces a fresh window', () => {
    const spec = setupCalloutFor(blockedCard('native_window_reset_pending'));
    assert.equal(spec.title, 'Waiting for a fresh sample');
    assert.match(spec.msg, /Claude Code has not reported a fresh limit window yet/);
    assert.match(spec.msg, /Continue a Claude Code response, then recheck/);
    assert.equal(spec.ctaLabel, 'Recheck native status');
    assert.equal(spec.action, 'refreshNativeStatus');
  });

  test('Is agent-aware (a Codex card names Codex, never Claude)', () => {
    const spec = setupCalloutFor(
      blockedCard('native_window_reset_pending', {
        agent: 'codex',
        agentLabel: 'Codex',
        colorKey: 'codex',
      }),
    );
    assert.match(spec.msg, /Codex has not reported a fresh limit window yet/);
    assert.ok(!/Claude/.test(spec.msg), 'must not name the wrong agent');
  });
});
