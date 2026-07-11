// The battery-meter AgentCard. These tests pin the redesign's honesty
// invariants: a no-value card shows a SetupCallout with NO meter (never 0%);
// stale values are dimmed + flagged "not live"; Context + cost are technical-only;
// the privacy footer (with the non-billing qualifier) is always present; and no
// raw reason id / source tier / accuracy label leaks on the simple card.

import * as assert from 'node:assert/strict';
import type { VNode } from 'preact';
import type {
  CardFreshness,
  CardRisk,
  GaugeCardViewModel,
  GaugeViewModel,
} from '../../../src/cockpit/GaugeCardViewModel';
import {
  COCKPIT_FIELD_REASONS,
  type CockpitFieldReason,
} from '../../../src/core/cockpit/CockpitState';
import type { AgentCardCallbacks } from '../../../src/webview-cockpit/AgentCard';
import { AgentCard, REASON_COPY } from '../../../src/webview-cockpit/AgentCard';

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

function progressbars(out: unknown): VNodeLike[] {
  return nodesWhere(out, (props) => props.role === 'progressbar');
}

function gauge(overrides: Partial<GaugeViewModel> = {}): GaugeViewModel {
  return {
    usedPct: 28,
    leftPct: 72,
    centerLabel: '28%',
    subLabel: '72% left · resets 12:30',
    state: 'fresh' as CardFreshness,
    accuracyLabel: 'proxy_reported',
    confidence: 'medium',
    ...overrides,
  };
}

function liveCard(overrides: Partial<GaugeCardViewModel> = {}): GaugeCardViewModel {
  return {
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    colorKey: 'claude',
    model: 'claude-opus-4',
    session: gauge(),
    weekly: gauge({
      centerLabel: '30%',
      usedPct: 30,
      leftPct: 70,
      subLabel: '70% left · resets Mon',
    }),
    context: gauge({ centerLabel: '5%', usedPct: 5, leftPct: 95, subLabel: undefined }),
    costLabel: '$1.20',
    risk: 'ok' as CardRisk,
    sourceTier: 'statusline_snapshot',
    accuracyLabel: 'proxy_reported',
    confidence: 'medium',
    freshness: 'fresh',
    ...overrides,
  };
}

function blockedCard(
  reason: CockpitFieldReason,
  overrides: Partial<GaugeCardViewModel> = {},
): GaugeCardViewModel {
  const g: GaugeViewModel = { centerLabel: '—', state: 'unavailable', reason };
  return {
    agent: 'codex',
    agentLabel: 'Codex',
    colorKey: 'codex',
    session: g,
    weekly: g,
    context: g,
    risk: 'unavailable',
    sourceTier: 'unknown',
    freshness: 'unavailable',
    reason,
    ...overrides,
  };
}

function recordingCallbacks(sink: string[]): AgentCardCallbacks {
  return {
    onConfigure: () => sink.push('configure'),
    onOpenClaudeSnapshotPathSetting: () => sink.push('openClaudeSnapshotPathSetting'),
    onOpenSettings: (target) =>
      sink.push(target !== undefined ? `openSettings:${target}` : 'openSettings'),
    onRefresh: () => sink.push('refresh'),
    onDiagnostics: () => sink.push('diagnostics'),
  };
}

suite('AgentCard — header + live meters', () => {
  test('Renders the name, model, provider badge, and a Live badge', () => {
    const out = AgentCard({ card: liveCard() });
    const text = textContent(out);
    assert.match(text, /Claude Code/);
    assert.match(text, /claude-opus-4/);
    assert.match(text, /Live/);
    // The header carries a provider badge (the tg-monogram container); its art
    // variant renders the inline SVG instead of a letter.
    let hasBadge = false;
    walk(out, (n) => {
      const cn = (n.props as { className?: unknown }).className;
      if (typeof cn === 'string' && cn.includes('tg-monogram')) hasBadge = true;
    });
    assert.ok(hasBadge, 'provider badge (tg-monogram) must render');
  });

  test('The 5h hero shows % LEFT and the "% used" label', () => {
    const text = textContent(AgentCard({ card: liveCard() }));
    assert.match(text, /72/); // hero left
    assert.match(text, /left/);
    assert.match(text, /28% used/);
  });

  test('The primary + weekly battery meters render as labelled progressbars', () => {
    const out = AgentCard({ card: liveCard() });
    const bars = progressbars(out);
    // 5h + weekly (context is technical-only and off by default).
    assert.equal(bars.length, 2);
    assert.ok(bars.some((b) => /5-hour window remaining/.test(String(b.props['aria-label']))));
    assert.ok(bars.some((b) => /Weekly remaining/.test(String(b.props['aria-label']))));
  });

  test('The reset line stands alone (no "% left" prefix — that is the hero)', () => {
    const text = textContent(AgentCard({ card: liveCard() }));
    assert.match(text, /resets 12:30/);
  });

  test('Codex model/reasoning surfaces with the "(configured)" qualifier', () => {
    const text = textContent(
      AgentCard({ card: liveCard({ colorKey: 'codex', model: 'gpt-5-codex', reasoning: 'high' }) }),
    );
    assert.match(text, /gpt-5-codex high \(configured\)/);
  });
});

suite('AgentCard — no-value states render a SetupCallout, never a 0% meter', () => {
  const cases: ReadonlyArray<readonly [CockpitFieldReason, RegExp, string]> = [
    ['statusline_snapshot_not_configured', /Not configured/, 'openClaudeSnapshotPathSetting'],
    ['statusline_snapshot_missing_rate_limits', /Waiting for limit fields/, 'diagnostics'],
    ['codex_probe_disabled', /Native probe is off/, 'openSettings:codexProbe'],
    ['codex_cli_not_found', /Codex CLI not found/, 'refresh'],
    ['codex_probe_no_response', /Native status blocked/, 'diagnostics'],
  ];

  for (const [reason, titleRe, expectedAction] of cases) {
    test(`${reason} → SetupCallout, no meter, CTA wired to ${expectedAction}`, () => {
      const sink: string[] = [];
      const out = AgentCard({
        card: blockedCard(reason),
        callbacks: recordingCallbacks(sink),
      });
      assert.match(textContent(out), titleRe);
      assert.equal(progressbars(out).length, 0, 'a no-value card must render NO meter');
      const cta = nodesWhere(out, (_props, type) => type === 'button')[0];
      assert.ok(cta, 'a CTA button must exist');
      (cta.props.onClick as () => void)();
      assert.deepEqual(sink, [expectedAction]);
    });
  }

  test('The error state carries the crit edge', () => {
    const out = AgentCard({ card: blockedCard('codex_probe_failed') });
    const card = nodesWhere(out, (props) => props['data-edge'] === 'crit');
    assert.ok(card.length >= 1, 'a blocked card has the crit edge');
  });
});

suite('AgentCard — stale (last known) is dimmed and flagged', () => {
  test('A stale card dims the data block and shows the last-known note (value retained)', () => {
    const out = AgentCard({
      card: liveCard({ freshness: 'stale', reason: 'native_status_stale' }),
    });
    // The value is retained — meters still render.
    assert.equal(progressbars(out).length, 2);
    // The data block is dimmed and the note is explicit.
    const dim = nodesWhere(out, (props) =>
      String(props.className ?? '')
        .split(/\s+/)
        .includes('tg-data--dim'),
    );
    assert.equal(dim.length, 1, 'the stale data block is dimmed');
    const text = textContent(out);
    assert.match(text, /last-known/i);
    assert.match(text, /Last known/); // badge
    // The reason copy + badge already carry "last known" —
    // the note must not append a third "not live" repetition.
    assert.ok(!/not live/i.test(text), 'no redundant "not live" suffix');
  });
});

suite('AgentCard — Context + cost are technical-only', () => {
  test('Default (off): no Context row, no cost, no raw internals', () => {
    const text = textContent(AgentCard({ card: liveCard() }));
    assert.ok(!/Context/.test(text), 'no Context row by default');
    assert.ok(!/Cost \$/.test(text), 'no cost by default');
    assert.ok(!/statusline_snapshot/.test(text), 'no raw source tier by default');
    assert.ok(!/freshness/.test(text), 'no raw freshness by default');
    assert.ok(!/proxy_reported/.test(text), 'no raw accuracy label by default');
  });

  test('Technical on: Context row + cost appear; NO raw internals', () => {
    const text = textContent(AgentCard({ card: liveCard(), showTechnicalDetails: true }));
    assert.match(text, /Context/);
    // Battery-consistent: the context row counts REMAINING like every other
    // meter (liveCard context.usedPct 5 → "95% left"), never a bare "5%".
    assert.match(text, /95% left/);
    assert.match(text, /Cost \$1\.20/);
    assert.match(text, /not a bill/, 'the cost carries the "not a bill" caveat');
    // The raw source-tier / freshness / accuracy internals are gone from the card.
    assert.ok(!/statusline_snapshot/.test(text), 'no raw source tier');
    assert.ok(!/freshness/.test(text), 'no raw freshness');
    assert.ok(!/Native-reported/.test(text), 'no raw accuracy line');
  });

  test('Technical on: the context meter is battery-style (aria carries % remaining)', () => {
    const bars = progressbars(AgentCard({ card: liveCard(), showTechnicalDetails: true }));
    const context = bars.find((b) =>
      /Context window remaining/.test(String(b.props['aria-label'])),
    );
    assert.ok(context, 'expected a context progressbar labelled as remaining');
    assert.equal(context?.props['aria-valuenow'], 95);
  });

  test('Technical on: a Codex card with no context shows the precise "not reported" copy', () => {
    const text = textContent(
      AgentCard({
        card: liveCard({
          colorKey: 'codex',
          agentLabel: 'Codex',
          sourceTier: 'codex_status_snapshot',
          context: { centerLabel: '—', state: 'unavailable', reason: 'codex_context_unavailable' },
        }),
        showTechnicalDetails: true,
      }),
    );
    assert.match(
      text,
      /Context unavailable — Codex app-server does not expose current session context/,
    );
  });
});

suite('AgentCard — persistent privacy footer', () => {
  test('Every card carries the non-billing + privacy footer lines', () => {
    for (const card of [liveCard(), blockedCard('codex_probe_disabled')]) {
      const text = textContent(AgentCard({ card }));
      assert.match(text, /Reported by /);
      assert.match(text, /Reads only your agent's status — never your prompts, code, or logs/);
    }
  });
});

suite('AgentCard — no raw leaks on the simple card', () => {
  test('An active stale signal shows its plain copy, NOT the raw reason id', () => {
    const text = textContent(
      AgentCard({ card: liveCard({ freshness: 'stale', reason: 'native_status_stale' }) }),
    );
    assert.match(text, /Stale · showing last-known/);
    assert.ok(!/native_status_stale/.test(text), 'the raw reason id must not leak');
  });

  test('Rendering does not mutate the VM', () => {
    const c = liveCard({ sourceTier: 'codex_status_snapshot', accuracyLabel: 'proxy_reported' });
    AgentCard({ card: c, showTechnicalDetails: true });
    assert.equal(c.sourceTier, 'codex_status_snapshot');
    assert.equal(c.accuracyLabel, 'proxy_reported');
  });
});

suite('AgentCard — honesty helpers (unchanged invariants)', () => {
  test('REASON_COPY maps every closed-union member to a non-empty string (exhaustive)', () => {
    for (const reason of COCKPIT_FIELD_REASONS) {
      assert.equal(typeof REASON_COPY[reason], 'string', `reason ${reason} not mapped`);
      assert.ok(REASON_COPY[reason].length > 0, `reason ${reason} maps to empty`);
    }
    assert.equal(Object.keys(REASON_COPY).length, COCKPIT_FIELD_REASONS.length);
  });

  test('Every retained-value reason keeps a "last-known" uncertainty cue', () => {
    const retained: readonly CockpitFieldReason[] = [
      'native_status_stale',
      'codex_probe_temporarily_unavailable',
      'codex_probe_parse_failed_after_valid',
      'codex_probe_no_data_after_valid',
      'codex_probe_stale',
      'snapshot_writer_collision',
      'native_temporarily_unavailable',
      'snapshot_incomplete_after_valid',
    ];
    for (const reason of retained) {
      assert.match(REASON_COPY[reason], /last-known/i, `${reason} lost its cue`);
    }
  });
});

// Under a writer collision the header must tell ONE stable story —
// "Multiple Claude Code sessions" — never swap model ids between competing
// sessions every poll.
suite('AgentCard — stable multi-session header under collision', () => {
  test('The model line reads "Multiple <agent> sessions", never a model id', () => {
    const text = textContent(
      AgentCard({
        card: liveCard({ freshness: 'degraded', reason: 'snapshot_writer_collision' }),
      }),
    );
    assert.match(text, /Multiple Claude Code sessions/);
    assert.ok(!/claude-opus-4/.test(text), 'a session-specific model id must not render');
  });

  test('The collision note keeps its last-known cue', () => {
    const text = textContent(
      AgentCard({
        card: liveCard({ freshness: 'degraded', reason: 'snapshot_writer_collision' }),
      }),
    );
    assert.match(text, /last-known/i);
  });
});

// The long multiple-writers warning renders as a compact
// title + guidance block (no bullet dot); short retained-value notes keep the
// dotted one-liner.
suite('AgentCard — collision note renders as a title/guidance block', () => {
  test('Collision note: warn title + actionable guidance, no bullet dot', () => {
    const out = AgentCard({
      card: liveCard({ freshness: 'degraded', reason: 'snapshot_writer_collision' }),
    });
    const text = textContent(out);
    assert.match(text, /Multiple Claude Code writers detected/);
    assert.match(text, /last-known/i, 'the uncertainty cue stays on the title line');
    assert.match(
      text,
      /Close other Claude Code terminals, or configure separate snapshot files\./,
      'the actionable guidance renders',
    );
    const dots = nodesWhere(
      out,
      (props) =>
        typeof props.className === 'string' && props.className.includes('tg-stale-note__dot'),
    );
    assert.equal(dots.length, 0, 'a long actionable note must not carry a bullet dot');
    const blocks = nodesWhere(
      out,
      (props) =>
        typeof props.className === 'string' && props.className.includes('tg-stale-note--block'),
    );
    assert.equal(blocks.length, 1, 'the note renders as the block variant');
  });

  test('A short retained-value note keeps the dotted one-liner (unchanged)', () => {
    const out = AgentCard({
      card: liveCard({ freshness: 'stale', reason: 'native_status_stale' }),
    });
    const dots = nodesWhere(
      out,
      (props) =>
        typeof props.className === 'string' && props.className.includes('tg-stale-note__dot'),
    );
    assert.equal(dots.length, 1, 'short notes keep the existing dot');
    const blocks = nodesWhere(
      out,
      (props) =>
        typeof props.className === 'string' && props.className.includes('tg-stale-note--block'),
    );
    assert.equal(blocks.length, 0);
  });
});

// The multiple-writers warning is one line by default; guidance (and,
// with the technical-details setting on, the session-specific context/cost
// explanations) sits behind a native collapsed Details disclosure.
suite('AgentCard — multiple-writers Details disclosure', () => {
  const collisionCard = () =>
    liveCard({ freshness: 'degraded', reason: 'snapshot_writer_collision' });

  test('Collapsed by default: always-visible title, compact Details toggle, guidance inside', () => {
    const out = AgentCard({ card: collisionCard() });
    const details = nodesWhere(out, (_props, type) => type === 'details');
    assert.equal(details.length, 1, 'exactly one disclosure');
    assert.ok(!details[0]?.props?.open, 'the disclosure must start collapsed');
    const summary = nodesWhere(out, (_props, type) => type === 'summary');
    assert.equal(summary.length, 1, 'exactly one toggle');
    assert.equal(textContent(summary[0]).trim(), 'Details');
    // The warn title stays outside the disclosure — always visible…
    const title = nodesWhere(
      out,
      (props) =>
        typeof props.className === 'string' && props.className.includes('tg-stale-note__title'),
    )[0];
    assert.match(textContent(title), /Multiple Claude Code writers detected/);
    assert.match(textContent(title), /last-known/i);
    assert.ok(
      !/Close other Claude Code terminals/.test(textContent(title)),
      'guidance must not be part of the always-visible title',
    );
    // …and the actionable guidance lives INSIDE it (revealed on expand).
    assert.match(textContent(details[0]), /Close other Claude Code terminals/);
  });

  test('Technical details OFF: no session-specific context/cost explanations anywhere', () => {
    const text = textContent(AgentCard({ card: collisionCard() }));
    assert.ok(!/session-specific/.test(text), 'tech explanations are gated by the setting');
  });

  test('Technical details ON: session-specific explanations inside the disclosure, not duplicated', () => {
    const out = AgentCard({ card: collisionCard(), showTechnicalDetails: true });
    const details = nodesWhere(out, (_props, type) => type === 'details')[0];
    const inside = textContent(details);
    assert.match(inside, /Context is session-specific/);
    assert.match(inside, /Cost is session-specific/);
    // The technical block below the note is suppressed under collision, so the
    // explanations appear exactly once each in the whole card.
    const text = textContent(out);
    assert.equal(text.match(/Context is session-specific/g)?.length, 1);
    assert.equal(text.match(/Cost is session-specific/g)?.length, 1);
  });

  test('Non-collision cards are untouched: no disclosure, technical block renders as before', () => {
    // A Codex-styled live card with technical details keeps its normal Context
    // row and gains no Details toggle (Codex rendering unchanged).
    const codex = liveCard({
      colorKey: 'codex',
      agentLabel: 'Codex',
      sourceTier: 'codex_status_snapshot',
    });
    const out = AgentCard({ card: codex, showTechnicalDetails: true });
    assert.equal(nodesWhere(out, (_props, type) => type === 'details').length, 0);
    assert.match(textContent(out), /Context/);
    // A short retained-value note also gains no disclosure.
    const stale = AgentCard({
      card: liveCard({ freshness: 'stale', reason: 'native_status_stale' }),
    });
    assert.equal(nodesWhere(stale, (_props, type) => type === 'details').length, 0);
  });
});
