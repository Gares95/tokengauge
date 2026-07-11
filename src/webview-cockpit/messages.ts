// Cockpit webview ↔ host message wiring. Types against the cockpit contract
// and uses getState()/setState(): the
// WebviewView is destroyed when hidden (retainContextWhenHidden false, RESEARCH
// Pitfall 2), so webview-side state restore is mandatory (Pitfall 1).

import type {
  BuildInfoMessage,
  CockpitInboundMessage,
  DisplayConfigMessage,
  GaugeCardsMessage,
} from '../cockpit/CockpitMessageSchema';
import type { GaugeCardViewModel } from '../cockpit/GaugeCardViewModel';
import type { ProviderCardVisibility } from '../cockpit/providerCardVisibility';

// The persisted webview state — ONLY the sanitized VMs (already
// privacy-tested). Nothing else crosses into setState.
export interface CockpitWebviewState {
  readonly cards: readonly GaugeCardViewModel[];
}

interface VsCodeApi {
  postMessage(message: CockpitInboundMessage): void;
  getState(): CockpitWebviewState | undefined;
  setState(state: CockpitWebviewState): void;
}

declare const acquireVsCodeApi:
  | undefined
  | (() => {
      postMessage(message: CockpitInboundMessage): void;
      getState(): unknown;
      setState(state: unknown): void;
    });

let api: VsCodeApi | undefined;

function vscodeApi(): VsCodeApi | undefined {
  if (api !== undefined) {
    return api;
  }
  if (typeof acquireVsCodeApi === 'function') {
    api = acquireVsCodeApi() as VsCodeApi;
  }
  return api;
}

export function postCockpitMessage(message: CockpitInboundMessage): void {
  vscodeApi()?.postMessage(message);
}

export function getCockpitState(): CockpitWebviewState | undefined {
  return vscodeApi()?.getState();
}

export function setCockpitState(state: CockpitWebviewState): void {
  vscodeApi()?.setState(state);
}

type CockpitInboundEvent = GaugeCardsMessage | BuildInfoMessage | DisplayConfigMessage;

export interface CockpitDisplayConfig {
  readonly showTechnicalDetails: boolean;
  readonly cardVisibility: ProviderCardVisibility;
}

interface MessageTargetLike {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<CockpitInboundEvent>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<CockpitInboundEvent>) => void,
  ): void;
}

export interface CockpitMessagingOptions {
  readonly target: MessageTargetLike;
  readonly postMessage: typeof postCockpitMessage;
  readonly onGaugeCards: (cards: readonly GaugeCardViewModel[]) => void;
  // Fired when the host posts the non-sensitive build id. Optional; consumers may
  // keep it internal for diagnostics/test traceability, not primary UI chrome.
  readonly onBuildInfo?: (buildId: string) => void;
  // Fired when the host posts display-only config so the card can
  // switch simple/technical and distinguish deliberate both-hidden from welcome.
  readonly onDisplayConfig?: (config: CockpitDisplayConfig) => void;
  // Register a callback fired when the view regains visibility so
  // the webview can re-request current state (belt-and-braces with the host's
  // own re-post). Returns an optional disposer. Defaults to the real document
  // visibility + pageshow seams in production.
  readonly onVisible?: (callback: () => void) => (() => void) | undefined;
}

// A gaugeCards message carries a `cards` array. Validate the shape defensively —
// inbound webview messages are an untrusted boundary (a single malformed payload
// must never throw out of the listener and kill all subsequent updates).
function isGaugeCardsMessage(data: unknown): data is GaugeCardsMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'gaugeCards' &&
    Array.isArray((data as { cards?: unknown }).cards)
  );
}

// A buildInfo message carries a non-sensitive build id string. Validate the shape
// defensively — this is the same untrusted-boundary discipline as gaugeCards.
function isBuildInfoMessage(data: unknown): data is BuildInfoMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'buildInfo' &&
    typeof (data as { buildId?: unknown }).buildId === 'string'
  );
}

// A displayConfig message carries non-sensitive display-only booleans. Validate
// the shape defensively — same untrusted-boundary discipline as gaugeCards/buildInfo.
function isDisplayConfigMessage(data: unknown): data is DisplayConfigMessage {
  const cardVisibility = (data as { cardVisibility?: unknown } | undefined)?.cardVisibility;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'displayConfig' &&
    typeof (data as { showTechnicalDetails?: unknown }).showTechnicalDetails === 'boolean' &&
    typeof cardVisibility === 'object' &&
    cardVisibility !== null &&
    typeof (cardVisibility as { claude?: unknown }).claude === 'boolean' &&
    typeof (cardVisibility as { codex?: unknown }).codex === 'boolean'
  );
}

function defaultOnVisible(callback: () => void): (() => void) | undefined {
  if (typeof document === 'undefined') return undefined;
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') callback();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', callback);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', callback);
  };
}

export function initializeCockpitMessaging(options: CockpitMessagingOptions): () => void {
  const listener = (event: MessageEvent<CockpitInboundEvent>): void => {
    // The boundary: never let a malformed payload throw out of the listener —
    // a single bad message must not stop all future valid updates.
    try {
      if (isGaugeCardsMessage(event?.data)) {
        options.onGaugeCards(event.data.cards);
      } else if (isBuildInfoMessage(event?.data)) {
        options.onBuildInfo?.(event.data.buildId);
      } else if (isDisplayConfigMessage(event?.data)) {
        options.onDisplayConfig?.({
          showTechnicalDetails: event.data.showTechnicalDetails,
          cardVisibility: event.data.cardVisibility,
        });
      }
    } catch {
      // Ignore safely — an unexpected message must never drop later messages.
    }
  };
  const requestState = (): void => options.postMessage({ type: 'ready' });
  // The host re-posts the latest VMs on ready.
  requestState();
  options.target.addEventListener('message', listener);
  const onVisible = options.onVisible ?? defaultOnVisible;
  const disposeVisible = onVisible(requestState);
  return () => {
    options.target.removeEventListener('message', listener);
    if (typeof disposeVisible === 'function') disposeVisible();
  };
}
