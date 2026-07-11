import { useEffect, useState } from 'preact/hooks';
import type { GaugeCardViewModel } from '../cockpit/GaugeCardViewModel';
import {
  DEFAULT_PROVIDER_CARD_VISIBILITY,
  type ProviderCardVisibility,
} from '../cockpit/providerCardVisibility';
import { ActionLinks } from './ActionLinks';
import { AgentCard, type AgentCardCallbacks } from './AgentCard';
import { type SettingTarget, summarize } from './cardVisualState';
import {
  type CockpitDisplayConfig,
  type CockpitMessagingOptions,
  getCockpitState,
  initializeCockpitMessaging,
  postCockpitMessage,
  setCockpitState,
} from './messages';
import { ProviderBadge } from './ProviderBadge';
import { SummaryStatus } from './SummaryStatus';

interface MessageTargetLike {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const NOOP = (): void => {};

// Render ONE card behind a guard so a throw on a single bad card
// state can never kill the whole app, its event handlers, or the Refresh button.
// On a render error, surface a safe inline error state for that card only and
// keep the surrounding toolbar interactive. No raw error text reaches the DOM.
function SafeAgentCard({
  card,
  showTechnicalDetails,
  callbacks,
}: {
  readonly card: GaugeCardViewModel;
  readonly showTechnicalDetails: boolean;
  readonly callbacks: AgentCardCallbacks;
}) {
  try {
    return AgentCard({ card, showTechnicalDetails, callbacks });
  } catch {
    return (
      <article className="tg-card" role="status">
        <div className="tg-card__body">
          <p className="agent-card__reason">This agent card is temporarily unavailable.</p>
        </div>
      </article>
    );
  }
}

// Resolve a stable key without touching a getter that may throw (a malformed VM
// could throw on property access — see SafeAgentCard). Fall back to the index.
function cardKey(card: GaugeCardViewModel, index: number): string {
  try {
    return card.agent ?? `card-${index}`;
  } catch {
    return `card-${index}`;
  }
}

// First-run welcome (design state 7): shown only when there are zero cards (the
// transient pre-first-paint state — the host normally posts a card per agent).
// Two setup steps + a persistent privacy promise. Static local copy only; no data
// source, no network. Each CTA matches the corresponding card SetupCallout:
// Claude and Codex both one-click focus the exact setting. Neither sets a
// setting; the Codex probe stays a user-flipped opt-in.
function Welcome({
  onOpenClaudeSnapshotPathSetting,
  onOpenSettings,
}: {
  readonly onOpenClaudeSnapshotPathSetting: () => void;
  readonly onOpenSettings: (target?: SettingTarget) => void;
}) {
  return (
    <div className="tg-welcome" role="status">
      <div className="tg-welcome__title">Welcome to TokenGauge</div>
      <div className="tg-welcome__intro">
        Native-only status cockpit for Claude Code and Codex. Configure a local source to show live
        status.
      </div>
      <div className="tg-step">
        <ProviderBadge colorKey="claude" fallbackLabel="C" />
        <div className="tg-card__id">
          <div className="tg-step__title">Claude Code</div>
          <div className="tg-step__msg">
            Read the statusLine snapshot or per-session snapshot directory you choose to write.
          </div>
          <button
            type="button"
            className="cockpit-configure tg-cta"
            onClick={onOpenClaudeSnapshotPathSetting}
          >
            Configure snapshot path
          </button>
        </div>
      </div>
      <div className="tg-step">
        <ProviderBadge colorKey="codex" fallbackLabel="›" />
        <div className="tg-card__id">
          <div className="tg-step__title">Codex</div>
          <div className="tg-step__msg">
            Experimental native app-server probe. Off by default; opt in from Settings and keep the
            Codex card visible. No provider secrets are requested.
          </div>
          <button
            type="button"
            className="cockpit-configure tg-cta"
            onClick={() => onOpenSettings('codexProbe')}
          >
            Open probe setting
          </button>
        </div>
      </div>
      <div className="tg-privacy">
        <div className="tg-privacy__title">Private by design</div>
        <div className="tg-privacy__body">
          Reads only native status surfaces — no prompts, completions, transcripts, terminal output,
          code, or logs. No telemetry or default network calls.
        </div>
      </div>
    </div>
  );
}

function NoCardsVisible({
  onConfigure,
  onOpenSettings,
  onPrivacy,
  onDiagnostics,
}: {
  readonly onConfigure: () => void;
  readonly onOpenSettings: (target?: SettingTarget) => void;
  readonly onPrivacy: () => void;
  readonly onDiagnostics: () => void;
}) {
  return (
    <div className="tg-welcome" role="status">
      <div className="tg-welcome__title">No cards visible</div>
      <div className="tg-welcome__intro">
        Cards are hidden by display settings only. Show provider cards again from Configure Cockpit
        or the card visibility settings.
      </div>
      <div className="tg-actions">
        <button type="button" className="tg-link" onClick={onConfigure}>
          Configure Cockpit
        </button>
        <button type="button" className="tg-link" onClick={() => onOpenSettings('providerCards')}>
          Card visibility settings
        </button>
        <button type="button" className="tg-link" onClick={onPrivacy}>
          Privacy &amp; data
        </button>
        <button type="button" className="tg-link" onClick={onDiagnostics}>
          Diagnostics
        </button>
      </div>
    </div>
  );
}

// A visibility transition (a card just re-enabled while the
// host's refreshed cards are still in flight) leaves zero cards with a
// not-both-hidden visibility. Rendering the first-run welcome there flashes
// setup cards at a user who only toggled a display setting — show a neutral
// rechecking line instead; the next gaugeCards post replaces it.
function CheckingProviderStatus() {
  return (
    <div className="tg-checking" role="status" aria-live="polite">
      Checking provider status…
    </div>
  );
}

export function CockpitView({
  cards,
  onRefresh,
  onConfigure = NOOP,
  onOpenClaudeSnapshotPathSetting = NOOP,
  onOpenSettings = NOOP,
  onPrivacy = NOOP,
  onDiagnostics = NOOP,
  checkedLabel,
  refreshing = false,
  showTechnicalDetails = false,
  cardVisibility = DEFAULT_PROVIDER_CARD_VISIBILITY,
}: {
  readonly cards: readonly GaugeCardViewModel[];
  readonly onRefresh: () => void;
  // Each routes to an existing read-only inbound message (configureCockpit /
  // openSettings / openPrivacyReport / openCockpitDiagnostics). Never sets a value.
  readonly onConfigure?: () => void;
  readonly onOpenClaudeSnapshotPathSetting?: () => void;
  // Carries the closed-enum SettingTarget so one-click CTAs (card callouts +
  // welcome setup steps) can focus the exact setting.
  readonly onOpenSettings?: (target?: SettingTarget) => void;
  readonly onPrivacy?: () => void;
  readonly onDiagnostics?: () => void;
  // Local-time "HH:MM" stamp of the last completed check (manual or poll),
  // folded into the summary sub-line.
  readonly checkedLabel?: string;
  readonly refreshing?: boolean;
  // Plumbed from tokenGauge.display.showTechnicalDetails. Default false → simple.
  readonly showTechnicalDetails?: boolean;
  readonly cardVisibility?: ProviderCardVisibility;
}) {
  const callbacks: AgentCardCallbacks = {
    onConfigure,
    onOpenClaudeSnapshotPathSetting,
    onOpenSettings,
    onRefresh,
    onDiagnostics,
  };
  const summary = summarize(cards, checkedLabel !== undefined ? { checkedLabel } : {});
  const bothProviderCardsHidden = !cardVisibility.claude && !cardVisibility.codex;
  // The first-run welcome is gated on the DEFAULT visibility (both visible):
  // any hidden card means the user has already configured the cockpit, so an
  // empty card set is a transition, never a first run.
  const bothProviderCardsVisible = cardVisibility.claude && cardVisibility.codex;

  // No in-webview title row: VS Code already draws the view title bar
  // ("TOKENGAUGE" — the brand-named view — plus the ··· overflow menu), so a
  // second header here is pure redundancy.
  return (
    <section className="cockpit-shell tg-cockpit" aria-label="TokenGauge">
      <div className="tg-cockpit__content">
        {cards.length === 0 ? (
          bothProviderCardsHidden ? (
            <NoCardsVisible
              onConfigure={onConfigure}
              onOpenSettings={onOpenSettings}
              onPrivacy={onPrivacy}
              onDiagnostics={onDiagnostics}
            />
          ) : bothProviderCardsVisible ? (
            <Welcome
              onOpenClaudeSnapshotPathSetting={onOpenClaudeSnapshotPathSetting}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <CheckingProviderStatus />
          )
        ) : (
          <>
            <div className="tg-summary">
              <div className="tg-summary__row">
                <SummaryStatus summary={summary} />
                {/* The Refresh button is never disabled and carries a visible pointer
                  affordance (cockpit.css) so it works in every card state. */}
                <button
                  type="button"
                  className="cockpit-refresh tg-btn"
                  onClick={onRefresh}
                  title="Recheck native status"
                  aria-label="Recheck native status"
                >
                  Refresh
                </button>
              </div>
              {refreshing ? (
                <span className="cockpit-status" role="status" aria-live="polite">
                  Checking now…
                </span>
              ) : null}
              <ActionLinks
                onConfigure={onConfigure}
                onPrivacy={onPrivacy}
                onDiagnostics={onDiagnostics}
              />
            </div>
            <div className="tg-stack">
              {cards.map((card, index) => (
                <SafeAgentCard
                  key={cardKey(card, index)}
                  card={card}
                  showTechnicalDetails={showTechnicalDetails}
                  callbacks={callbacks}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export interface WireCockpitOptions {
  readonly target: MessageTargetLike;
  readonly postMessage: typeof postCockpitMessage;
  readonly getState: typeof getCockpitState;
  readonly setState: typeof setCockpitState;
  readonly setCards: (cards: readonly GaugeCardViewModel[]) => void;
  readonly initialize: (options: CockpitMessagingOptions) => () => void;
  // Fired ONLY when an inbound gaugeCards delivery actually CHANGED the cards (a
  // real data refresh) so the "Last sample" stamp reflects an actual refresh.
  readonly onUpdated?: () => void;
  // Fired on EVERY inbound gaugeCards delivery (change or not) so the manual-
  // refresh indicator always resolves. Carries `changed` for the caller.
  readonly onDelivered?: (info: { readonly changed: boolean }) => void;
  readonly onBuildId?: (buildId: string) => void;
  readonly onDisplayConfig?: (config: CockpitDisplayConfig) => void;
}

// Compare two card sets for a REAL change. The cards are closed, serializable
// display-only VMs (no functions, no cycles), so a stable JSON comparison is a
// faithful "did the data actually change?" test. The host re-posts the SAME cards
// on every poll/ready/visibility tick; an identical re-post must NOT count.
function cardsChanged(
  prev: readonly GaugeCardViewModel[] | undefined,
  next: readonly GaugeCardViewModel[],
): boolean {
  if (prev === undefined) return true;
  return JSON.stringify(prev) !== JSON.stringify(next);
}

function restorableCards(
  cards: readonly GaugeCardViewModel[] | undefined,
): readonly GaugeCardViewModel[] {
  return cards?.filter((card) => card.agent !== 'codex') ?? [];
}

// Hook-free wiring: restore persisted cards, then initialize messaging so that
// inbound gaugeCards updates state AND persists via setState (the hidden view is
// destroyed, so webview-side restore is useful). Codex cards are not restored:
// an old app-server sample from VS Code webview state must never appear as a
// live value after reinstall/reactivation before the extension host performs a
// fresh consent-gated probe.
export function wireCockpit(options: WireCockpitOptions): () => void {
  const restored = restorableCards(options.getState()?.cards);
  if (restored.length > 0) {
    options.setCards(restored);
  }
  let lastDelivered: readonly GaugeCardViewModel[] | undefined =
    restored.length > 0 ? restored : undefined;
  return options.initialize({
    target: options.target as CockpitMessagingOptions['target'],
    postMessage: options.postMessage,
    onGaugeCards: (next) => {
      options.setCards(next);
      options.setState({ cards: next });
      const changed = cardsChanged(lastDelivered, next);
      if (changed) {
        options.onUpdated?.();
      }
      options.onDelivered?.({ changed });
      lastDelivered = next;
    },
    ...(options.onBuildId !== undefined ? { onBuildInfo: options.onBuildId } : {}),
    ...(options.onDisplayConfig !== undefined ? { onDisplayConfig: options.onDisplayConfig } : {}),
  });
}

export interface CockpitAppProps {
  readonly initialCards?: readonly GaugeCardViewModel[];
  readonly postMessage?: typeof postCockpitMessage;
  readonly target?: MessageTargetLike;
  readonly initialize?: (options: CockpitMessagingOptions) => () => void;
  readonly getState?: typeof getCockpitState;
  readonly setState?: typeof setCockpitState;
}

// Local-time "HH:MM" stamp for the glanceable summary "Checked …" line — seconds
// are noise for a last-checked cue.
function nowLabelHM(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

export function CockpitApp({
  initialCards,
  postMessage = postCockpitMessage,
  target = typeof window !== 'undefined' ? window : ({} as MessageTargetLike),
  initialize = initializeCockpitMessaging,
  getState = getCockpitState,
  setState = setCockpitState,
}: CockpitAppProps = {}) {
  const [cards, setCards] = useState<readonly GaugeCardViewModel[]>(
    () => initialCards ?? restorableCards(getState()?.cards),
  );
  const [checkedLabel, setCheckedLabel] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [displayConfig, setDisplayConfig] = useState<CockpitDisplayConfig>({
    showTechnicalDetails: false,
    cardVisibility: DEFAULT_PROVIDER_CARD_VISIBILITY,
  });

  useEffect(
    () =>
      wireCockpit({
        target,
        postMessage,
        getState,
        setState,
        setCards,
        initialize,
        onDelivered: () => {
          setCheckedLabel(nowLabelHM());
          setRefreshing(false);
        },
        onDisplayConfig: setDisplayConfig,
      }),
    [initialize, postMessage, target, getState, setState],
  );

  const onRefresh = (): void => {
    setRefreshing(true);
    postMessage({ type: 'refreshNativeStatus' });
  };
  const onConfigure = (): void => postMessage({ type: 'configureCockpit' });
  const onOpenClaudeSnapshotPathSetting = (): void =>
    postMessage({ type: 'openClaudeSnapshotPathSetting' });
  const onOpenSettings = (target?: SettingTarget): void =>
    postMessage(target !== undefined ? { type: 'openSettings', target } : { type: 'openSettings' });
  const onPrivacy = (): void => postMessage({ type: 'openPrivacyReport' });
  const onDiagnostics = (): void => postMessage({ type: 'openCockpitDiagnostics' });

  return (
    <CockpitView
      cards={cards}
      onRefresh={onRefresh}
      onConfigure={onConfigure}
      onOpenClaudeSnapshotPathSetting={onOpenClaudeSnapshotPathSetting}
      onOpenSettings={onOpenSettings}
      onPrivacy={onPrivacy}
      onDiagnostics={onDiagnostics}
      {...(checkedLabel !== undefined ? { checkedLabel } : {})}
      refreshing={refreshing}
      showTechnicalDetails={displayConfig.showTechnicalDetails}
      cardVisibility={displayConfig.cardVisibility}
    />
  );
}
