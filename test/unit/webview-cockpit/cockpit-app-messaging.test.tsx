// Cockpit messaging wiring + the redesigned CockpitView. The messaging/wireCockpit
// logic tests are unchanged from the prior design (they pin messages.ts + the
// change-detection wiring); the rendering tests are updated for the battery
// cockpit (summary, action links, welcome).

import * as assert from 'node:assert/strict';
import type { VNode } from 'preact';
import type { CockpitInboundMessage } from '../../../src/cockpit/CockpitMessageSchema';
import type { GaugeCardViewModel } from '../../../src/cockpit/GaugeCardViewModel';
import { CockpitView, wireCockpit } from '../../../src/webview-cockpit/CockpitApp';
import {
  type CockpitMessagingOptions,
  initializeCockpitMessaging,
} from '../../../src/webview-cockpit/messages';

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

function buttonsIn(node: unknown): VNodeLike[] {
  const out: VNodeLike[] = [];
  const walk = (n: unknown): void => {
    const current = materialize(n);
    if (Array.isArray(current)) {
      for (const c of current) walk(c);
      return;
    }
    if (current && typeof current === 'object') {
      const v = current as VNodeLike;
      if (v.type === 'button') out.push(v);
      for (const child of childList(current)) walk(child);
    }
  };
  walk(node);
  return out;
}

function nodesWithClass(node: unknown, className: string): VNodeLike[] {
  const out: VNodeLike[] = [];
  const walk = (n: unknown): void => {
    const current = materialize(n);
    if (Array.isArray(current)) {
      for (const c of current) walk(c);
      return;
    }
    if (current && typeof current === 'object') {
      const v = current as VNodeLike;
      if (
        String(v.props.className ?? '')
          .split(/\s+/)
          .includes(className)
      ) {
        out.push(v);
      }
      for (const child of childList(current)) walk(child);
    }
  };
  walk(node);
  return out;
}

interface FakeTarget {
  readonly addEventListener: (type: 'message', listener: (e: MessageEvent) => void) => void;
  readonly removeEventListener: (type: 'message', listener: (e: MessageEvent) => void) => void;
  readonly listeners: Array<(e: MessageEvent) => void>;
}

function fakeTarget(): FakeTarget {
  const listeners: Array<(e: MessageEvent) => void> = [];
  return {
    listeners,
    addEventListener: (_type, listener) => listeners.push(listener),
    removeEventListener: (_type, listener) => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

function sampleCard(agent: GaugeCardViewModel['agent'] = 'codex'): GaugeCardViewModel {
  const g = { usedPct: 50, leftPct: 50, centerLabel: '50%', state: 'fresh' as const };
  return {
    agent,
    agentLabel: agent === 'codex' ? 'Codex' : 'Claude Code',
    colorKey: agent === 'codex' ? 'codex' : 'claude',
    session: g,
    weekly: g,
    context: g,
    risk: 'ok',
    sourceTier: 'statusline_snapshot',
    freshness: 'fresh',
  };
}

// A no-value card (a SetupCallout state) for the summary aggregation tests.
function notConfiguredCard(agent: GaugeCardViewModel['agent']): GaugeCardViewModel {
  const reason =
    agent === 'codex'
      ? ('codex_probe_disabled' as const)
      : ('statusline_snapshot_not_configured' as const);
  const g = { centerLabel: '—', state: 'unavailable' as const, reason };
  return {
    agent,
    agentLabel: agent === 'codex' ? 'Codex' : 'Claude Code',
    colorKey: agent === 'codex' ? 'codex' : 'claude',
    session: g,
    weekly: g,
    context: g,
    risk: 'unavailable',
    sourceTier: 'unknown',
    freshness: 'unavailable',
    reason,
  };
}

suite('Cockpit app messaging', () => {
  test('Initialize posts ready, registers a listener, and the disposer removes it', () => {
    const target = fakeTarget();
    const posted: CockpitInboundMessage[] = [];
    const dispose = initializeCockpitMessaging({
      target,
      postMessage: (m) => posted.push(m),
      onGaugeCards: () => {},
    });

    assert.deepEqual(posted, [{ type: 'ready' }]);
    assert.equal(target.listeners.length, 1);
    dispose();
    assert.equal(target.listeners.length, 0);
  });

  test('A gaugeCards message invokes onGaugeCards with the cards', () => {
    const target = fakeTarget();
    let received: readonly GaugeCardViewModel[] | undefined;
    initializeCockpitMessaging({
      target,
      postMessage: () => {},
      onGaugeCards: (cards) => {
        received = cards;
      },
    });
    const cards = [sampleCard()];
    target.listeners[0]?.({ data: { type: 'gaugeCards', cards } } as MessageEvent);
    assert.deepEqual(received, cards);
  });

  test('A buildInfo message invokes onBuildInfo with the build id', () => {
    const target = fakeTarget();
    let received: string | undefined;
    initializeCockpitMessaging({
      target,
      postMessage: () => {},
      onGaugeCards: () => {},
      onBuildInfo: (id) => {
        received = id;
      },
    });
    target.listeners[0]?.({
      data: { type: 'buildInfo', buildId: 'build 0.0.1+ab12cd34ef56' },
    } as MessageEvent);
    assert.equal(received, 'build 0.0.1+ab12cd34ef56');
  });

  test('A displayConfig message invokes onDisplayConfig with display-only booleans', () => {
    const target = fakeTarget();
    let received:
      | Parameters<NonNullable<CockpitMessagingOptions['onDisplayConfig']>>[0]
      | undefined;
    initializeCockpitMessaging({
      target,
      postMessage: () => {},
      onGaugeCards: () => {},
      onDisplayConfig: (config) => {
        received = config;
      },
    });
    target.listeners[0]?.({
      data: {
        type: 'displayConfig',
        showTechnicalDetails: true,
        cardVisibility: { claude: false, codex: true },
      },
    } as MessageEvent);
    assert.deepEqual(received, {
      showTechnicalDetails: true,
      cardVisibility: { claude: false, codex: true },
    });
  });

  test('A malformed displayConfig (non-boolean visibility) is ignored, not propagated', () => {
    const target = fakeTarget();
    let received = false;
    initializeCockpitMessaging({
      target,
      postMessage: () => {},
      onGaugeCards: () => {},
      onDisplayConfig: () => {
        received = true;
      },
    });
    target.listeners[0]?.({
      data: {
        type: 'displayConfig',
        showTechnicalDetails: true,
        cardVisibility: { claude: false, codex: 'hidden' },
      },
    } as MessageEvent);
    assert.equal(received, false, 'a non-boolean visibility flag must be dropped');
  });

  // Technical details (the Context row + cost) show only when showTechnicalDetails
  // is true; the privacy footer is always present.
  test('CockpitView shows the technical details only when showTechnicalDetails is true', () => {
    const cards = [sampleCard('claude-code')];
    const off = textContent(CockpitView({ cards, onRefresh: () => {} }));
    assert.ok(!/Context/.test(off), 'no Context row by default');
    assert.match(
      off,
      /Reads only your agent's status — never your prompts, code, or logs/,
      'the privacy footer is always present',
    );

    const on = textContent(CockpitView({ cards, onRefresh: () => {}, showTechnicalDetails: true }));
    assert.match(on, /Context/, 'the technical view adds the Context row');
  });

  test('CockpitView keeps build id metadata out of the primary UI', () => {
    const cards = [sampleCard('codex')];
    const text = textContent(CockpitView({ cards, onRefresh: () => {} }));
    assert.ok(!/build 0\.0\.1\+[0-9a-f]{12}/.test(text), 'no visible build hash in cockpit');
  });

  test('WireCockpit: a gaugeCards message updates cards AND persists via setState', () => {
    const target = fakeTarget();
    const saved: Array<{ cards: readonly GaugeCardViewModel[] }> = [];
    const setCalls: Array<readonly GaugeCardViewModel[]> = [];
    let onGaugeCards: CockpitMessagingOptions['onGaugeCards'] | undefined;

    wireCockpit({
      target,
      postMessage: () => {},
      getState: () => undefined,
      setState: (s) => saved.push(s),
      setCards: (c) => setCalls.push(c),
      initialize: (opts) => {
        onGaugeCards = opts.onGaugeCards;
        return () => {};
      },
    });

    const cards = [sampleCard('codex'), sampleCard('claude-code')];
    onGaugeCards?.(cards);
    assert.deepEqual(setCalls.at(-1), cards);
    assert.deepEqual(saved.at(-1), { cards });
  });

  test('WireCockpit: getState-restored cards are applied immediately on mount', () => {
    const cards = [sampleCard('claude-code')];
    const setCalls: Array<readonly GaugeCardViewModel[]> = [];
    wireCockpit({
      target: fakeTarget(),
      postMessage: () => {},
      getState: () => ({ cards }),
      setState: () => {},
      setCards: (c) => setCalls.push(c),
      initialize: () => () => {},
    });
    assert.deepEqual(setCalls[0], cards);
  });

  test('WireCockpit: restored Codex cards are dropped until the host posts fresh state', () => {
    const restored = [
      {
        ...sampleCard('codex'),
        session: { usedPct: 99, leftPct: 1, centerLabel: '99%', state: 'fresh' as const },
      },
      sampleCard('claude-code'),
    ];
    const setCalls: Array<readonly GaugeCardViewModel[]> = [];
    wireCockpit({
      target: fakeTarget(),
      postMessage: () => {},
      getState: () => ({ cards: restored }),
      setState: () => {},
      setCards: (c) => setCalls.push(c),
      initialize: () => () => {},
    });

    assert.deepEqual(setCalls[0], [restored[1]]);
    assert.ok(
      setCalls[0]?.every((card) => card.agent !== 'codex'),
      'Codex values restored from VS Code webview state must not render as live after reinstall',
    );
  });

  test('CockpitView renders one AgentCard per VM and no welcome', () => {
    const cards = [sampleCard('codex'), sampleCard('claude-code')];
    const text = textContent(CockpitView({ cards, onRefresh: () => {} }));
    assert.match(text, /Codex/);
    assert.match(text, /Claude Code/);
    assert.ok(!/Welcome to TokenGauge/i.test(text), 'no welcome with cards present');
  });

  // Narrow widths never swap the cards for a blocking helper —
  // the standard content stays mounted (CSS provides horizontal overflow).
  test('CockpitView keeps the standard content mounted with no narrow-width helper', () => {
    const tree = CockpitView({
      cards: [sampleCard('codex')],
      onRefresh: () => {},
    });
    assert.equal(nodesWithClass(tree, 'tg-narrow-helper').length, 0, 'no blocking narrow helper');
    const content = nodesWithClass(tree, 'tg-cockpit__content')[0];
    assert.ok(content, 'the cockpit content container is always mounted');
    assert.match(textContent(content), /Codex/, 'the card renders inside the content container');
  });

  // The card keeps its intended layout classes at every width —
  // no breakpoint swaps them for a compressed variant (CSS pins the floor).
  test('A rendered card keeps the standard gauge/meter/row layout classes', () => {
    const simple = CockpitView({ cards: [sampleCard('claude-code')], onRefresh: () => {} });
    assert.ok(nodesWithClass(simple, 'tg-gauge__primary').length > 0, 'primary gauge block');
    assert.ok(nodesWithClass(simple, 'tg-meter').length > 0, 'battery meter present');

    const technical = CockpitView({
      cards: [sampleCard('claude-code')],
      onRefresh: () => {},
      showTechnicalDetails: true,
    });
    assert.ok(nodesWithClass(technical, 'tg-row').length > 0, 'technical rows keep tg-row');
  });

  // Zero cards at the DEFAULT (both-visible) visibility → the first-run welcome
  // (transient pre-first-paint state).
  test('CockpitView with zero cards shows the first-run welcome', () => {
    const text = textContent(CockpitView({ cards: [], onRefresh: () => {} }));
    assert.match(text, /Welcome to TokenGauge/i);
    assert.match(text, /Native-only status cockpit for Claude Code and Codex/i);
    assert.match(text, /Claude Code/);
    assert.match(text, /Codex/);
    assert.match(text, /statusLine snapshot or per-session snapshot directory/i);
    assert.match(text, /Experimental native app-server probe/i);
    assert.match(text, /Off by default/i);
    assert.match(text, /keep the Codex card visible/i);
    assert.match(text, /Configure snapshot path/i);
  });

  // Re-enabling one card posts the new visibility before the
  // refreshed cards arrive. That zero-cards + one-hidden window must render a
  // neutral rechecking state — never the first-run welcome or its setup cards.
  test('Zero cards with one provider hidden shows a neutral state, never the welcome', () => {
    for (const cardVisibility of [
      { claude: false, codex: true },
      { claude: true, codex: false },
    ]) {
      const text = textContent(CockpitView({ cards: [], onRefresh: () => {}, cardVisibility }));
      assert.ok(!/Welcome to TokenGauge/i.test(text), 'no welcome during a visibility transition');
      assert.ok(!/Configure snapshot path/i.test(text), 'no Claude setup card mid-transition');
      assert.ok(!/Open probe setting/i.test(text), 'no Codex setup card mid-transition');
      assert.ok(!/No cards visible/i.test(text), 'not the both-hidden empty state either');
      assert.match(text, /Checking provider status/i);
    }
  });

  test('The enabled card renders once its data arrives after a visibility transition', () => {
    const text = textContent(
      CockpitView({
        cards: [sampleCard('codex')],
        onRefresh: () => {},
        cardVisibility: { claude: false, codex: true },
      }),
    );
    assert.match(text, /Codex/);
    assert.ok(!/Welcome to TokenGauge/i.test(text), 'no welcome once the card is delivered');
    assert.ok(!/Checking provider status/i.test(text), 'the neutral state resolves');
  });

  test('CockpitView with both provider cards hidden shows the empty state', () => {
    const text = textContent(
      CockpitView({
        cards: [],
        onRefresh: () => {},
        cardVisibility: { claude: false, codex: false },
      }),
    );
    assert.match(text, /No cards visible/i);
    assert.match(text, /display settings only/i);
    assert.match(text, /card visibility settings/i);
    assert.match(text, /Configure Cockpit/i);
    assert.match(text, /Privacy & data/i);
    assert.match(text, /Diagnostics/i);
    assert.ok(!/Welcome to TokenGauge/i.test(text), 'both-hidden is not first-run welcome');
  });

  test('The both-hidden Settings action targets provider card visibility', () => {
    const targets: Array<string | undefined> = [];
    const tree = CockpitView({
      cards: [],
      onRefresh: () => {},
      cardVisibility: { claude: false, codex: false },
      onOpenSettings: (target) => targets.push(target),
    });
    const visibilityButton = buttonsIn(tree).find((b) =>
      /Card visibility settings/i.test(textContent(b)),
    );
    assert.ok(visibilityButton, 'a card visibility settings action must exist');
    (visibilityButton?.props.onClick as () => void)();
    assert.deepEqual(targets, ['providerCards']);
  });

  // The welcome carries the persistent privacy promise and never nudges toward
  // log/transcript scraping (the native-only invariant). The owner-approved design
  // includes a neutral probe-setting affordance that opens the exact (read-only)
  // probe setting — it does not set the opt-in setting itself.
  test('The welcome carries the privacy promise and no log-scraping language', () => {
    const text = textContent(CockpitView({ cards: [], onRefresh: () => {} }));
    assert.match(text, /Private by design/i);
    assert.match(text, /no prompts, completions, transcripts, terminal output, code, or logs/i);
    assert.match(text, /No telemetry or default network calls/i);
    assert.ok(!/log ingestion/i.test(text), 'no log-ingestion nudge');
    assert.ok(!/scan(ning)?\s+logs/i.test(text), 'no log-scanning nudge');
  });

  test('The welcome Claude setup button posts the dedicated snapshot setting action', () => {
    const actions: string[] = [];
    const tree = CockpitView({
      cards: [],
      onRefresh: () => {},
      onOpenClaudeSnapshotPathSetting: () => actions.push('openClaudeSnapshotPathSetting'),
    });
    const configureButton = buttonsIn(tree).find((b) =>
      /Configure snapshot path/i.test(textContent(b)),
    );
    assert.ok(configureButton, 'a welcome configure button must exist');
    (configureButton?.props.onClick as () => void)();
    assert.deepEqual(actions, ['openClaudeSnapshotPathSetting']);
  });

  // The welcome Codex step matches the card SetupCallout — one click to
  // the exact probe setting (read-only focus; the user still flips the opt-in).
  test('The welcome probe-setting button targets the codexProbe setting', () => {
    const targets: Array<string | undefined> = [];
    const tree = CockpitView({
      cards: [],
      onRefresh: () => {},
      onOpenSettings: (target) => targets.push(target),
    });
    const probeButton = buttonsIn(tree).find((b) => /Open probe setting/i.test(textContent(b)));
    assert.ok(probeButton, 'a welcome probe button must exist');
    (probeButton?.props.onClick as () => void)();
    assert.deepEqual(targets, ['codexProbe']);
  });

  test('The refresh button invokes onRefresh', () => {
    let refreshed = 0;
    const tree = CockpitView({ cards: [sampleCard()], onRefresh: () => refreshed++ });
    const refresh = buttonsIn(tree).find((b) =>
      String(b.props.className ?? '').includes('cockpit-refresh'),
    );
    assert.ok(refresh, 'a Refresh button must exist with cards present');
    (refresh?.props.onClick as () => void)();
    assert.equal(refreshed, 1);
  });

  // The action links route to the existing read-only commands.
  test('The action links post the Privacy and Diagnostics messages', () => {
    const posted: string[] = [];
    const tree = CockpitView({
      cards: [sampleCard()],
      onRefresh: () => {},
      onConfigure: () => posted.push('config'),
      onPrivacy: () => posted.push('privacy'),
      onDiagnostics: () => posted.push('diag'),
    });
    const links = buttonsIn(tree).filter((b) =>
      String(b.props.className ?? '')
        .split(/\s+/)
        .includes('tg-link'),
    );
    assert.equal(links.length, 3, 'Configure / Privacy & data / Diagnostics');
    for (const b of links) (b.props.onClick as () => void)();
    assert.deepEqual(posted.sort(), ['config', 'diag', 'privacy']);
  });

  // A single throwing card VM must not unmount the app or
  // remove the Refresh button — the toolbar stays interactive and a safe inline
  // error card renders for the bad VM only.
  test('A card that throws while rendering does not remove the Refresh button', () => {
    const bad = {
      get agent(): never {
        throw new Error('boom');
      },
    } as unknown as GaugeCardViewModel;
    const cards = [sampleCard('codex'), bad, sampleCard('claude-code')];
    let refreshed = 0;
    const tree = CockpitView({ cards, onRefresh: () => refreshed++ });
    const refresh = buttonsIn(tree).find((b) =>
      String(b.props.className ?? '').includes('cockpit-refresh'),
    );
    assert.ok(refresh, 'Refresh button must survive a throwing card');
    (refresh?.props.onClick as () => void)();
    assert.equal(refreshed, 1);
    assert.match(textContent(tree), /unavailable|error/i);
    assert.match(textContent(tree), /Codex/);
    assert.match(textContent(tree), /Claude Code/);
  });

  test('A malformed inbound message does not stop later valid gaugeCards updates', () => {
    const target = fakeTarget();
    const received: Array<readonly GaugeCardViewModel[]> = [];
    initializeCockpitMessaging({
      target,
      postMessage: () => {},
      onGaugeCards: (cards) => received.push(cards),
    });
    const listener = target.listeners[0];
    assert.ok(listener);
    assert.doesNotThrow(() => listener?.({ data: undefined } as unknown as MessageEvent));
    assert.doesNotThrow(() => listener?.({ data: null } as unknown as MessageEvent));
    assert.doesNotThrow(() => listener?.({ data: 'nonsense' } as unknown as MessageEvent));
    assert.doesNotThrow(() => listener?.({ data: { type: 'unknown' } } as unknown as MessageEvent));
    const cards = [sampleCard('codex')];
    listener?.({ data: { type: 'gaugeCards', cards } } as MessageEvent);
    assert.deepEqual(received.at(-1), cards);
  });

  test('The refresh button has a stable affordance class hook and is never disabled', () => {
    const tree = CockpitView({ cards: [sampleCard()], onRefresh: () => {} });
    const refresh = buttonsIn(tree).find((b) =>
      String(b.props.className ?? '').includes('cockpit-refresh'),
    );
    assert.ok(refresh, 'a refresh button must exist');
    assert.notEqual(refresh?.props.disabled, true);
  });

  // The summary folds the last-check time into its sub-line.
  test('CockpitView summary surfaces the last-checked time when provided', () => {
    const text = textContent(
      CockpitView({ cards: [sampleCard()], onRefresh: () => {}, checkedLabel: '12:34:56' }),
    );
    assert.match(text, /Checked/i);
    assert.match(text, /12:34:56/);
  });

  test('CockpitView surfaces a "Checking now…" indicator while refreshing', () => {
    const text = textContent(
      CockpitView({ cards: [sampleCard()], onRefresh: () => {}, refreshing: true }),
    );
    assert.match(text, /Checking now/i);
  });

  test('The refresh button remains interactive with a degraded/collision card', () => {
    const degraded: GaugeCardViewModel = {
      ...sampleCard('claude-code'),
      session: {
        usedPct: 87,
        leftPct: 13,
        centerLabel: '87%',
        state: 'degraded',
        reason: 'snapshot_writer_collision',
      },
      freshness: 'degraded',
      reason: 'snapshot_writer_collision',
    };
    let refreshed = 0;
    const tree = CockpitView({ cards: [degraded], onRefresh: () => refreshed++ });
    const refresh = buttonsIn(tree).find((b) =>
      String(b.props.className ?? '').includes('cockpit-refresh'),
    );
    assert.notEqual(refresh?.props.disabled, true);
    (refresh?.props.onClick as () => void)();
    assert.equal(refreshed, 1);
  });

  // "Last sample" advances only on a real data change.
  test('WireCockpit notifies onUpdated only when the delivered cards CHANGED', () => {
    const target = fakeTarget();
    let updatedCount = 0;
    let onGaugeCards: CockpitMessagingOptions['onGaugeCards'] | undefined;
    wireCockpit({
      target,
      postMessage: () => {},
      getState: () => undefined,
      setState: () => {},
      setCards: () => {},
      onUpdated: () => {
        updatedCount += 1;
      },
      initialize: (opts) => {
        onGaugeCards = opts.onGaugeCards;
        return () => {};
      },
    });
    onGaugeCards?.([sampleCard('codex')]);
    assert.equal(updatedCount, 1, 'the first delivery is a real change');
    onGaugeCards?.([sampleCard('codex')]);
    assert.equal(updatedCount, 1, 'an identical re-post is NOT a real refresh');
    onGaugeCards?.([sampleCard('claude-code')]);
    assert.equal(updatedCount, 2, 'a changed card set is a real refresh');
  });

  test('WireCockpit notifies onDelivered on EVERY gaugeCards delivery (clears Refreshing…)', () => {
    const target = fakeTarget();
    let deliveredCount = 0;
    let onGaugeCards: CockpitMessagingOptions['onGaugeCards'] | undefined;
    wireCockpit({
      target,
      postMessage: () => {},
      getState: () => undefined,
      setState: () => {},
      setCards: () => {},
      onDelivered: () => {
        deliveredCount += 1;
      },
      initialize: (opts) => {
        onGaugeCards = opts.onGaugeCards;
        return () => {};
      },
    });
    onGaugeCards?.([sampleCard('codex')]);
    onGaugeCards?.([sampleCard('codex')]);
    assert.equal(deliveredCount, 2, 'every delivery resolves Refreshing…, change or not');
  });

  test('WireCockpit onDelivered reports changed=true on a real change, false on a no-change re-post', () => {
    const target = fakeTarget();
    const changes: boolean[] = [];
    let onGaugeCards: CockpitMessagingOptions['onGaugeCards'] | undefined;
    wireCockpit({
      target,
      postMessage: () => {},
      getState: () => undefined,
      setState: () => {},
      setCards: () => {},
      onDelivered: ({ changed }) => changes.push(changed),
      initialize: (opts) => {
        onGaugeCards = opts.onGaugeCards;
        return () => {};
      },
    });
    onGaugeCards?.([sampleCard('codex')]);
    onGaugeCards?.([sampleCard('codex')]);
    onGaugeCards?.([sampleCard('claude-code')]);
    assert.deepEqual(changes, [true, false, true]);
  });

  // Summary aggregation across cards (the top-of-view honest status line).
  test('CockpitView summary reads "All sources live" when every card is live', () => {
    const text = textContent(
      CockpitView({
        cards: [sampleCard('claude-code'), sampleCard('codex')],
        onRefresh: () => {},
        checkedLabel: '12:35:10',
      }),
    );
    assert.match(text, /All sources live/i);
    assert.match(text, /native sources fresh/i);
  });

  test('CockpitView summary reads "Setup needed" when nothing is configured', () => {
    const text = textContent(
      CockpitView({
        cards: [notConfiguredCard('claude-code'), notConfiguredCard('codex')],
        onRefresh: () => {},
      }),
    );
    assert.match(text, /Setup needed/i);
  });

  // When the view regains visibility, the webview re-requests
  // state (belt-and-braces re-post of `ready`) so a stale hidden→shown view repaints.
  test('Regaining visibility re-posts ready to re-request current state', () => {
    const target = fakeTarget();
    const posted: CockpitInboundMessage[] = [];
    initializeCockpitMessaging({
      target,
      postMessage: (m) => posted.push(m),
      onGaugeCards: () => {},
      onVisible: (cb) => {
        cb();
        return undefined;
      },
    });
    assert.ok(posted.filter((m) => m.type === 'ready').length >= 2);
  });
});
