import type { AgentId } from '../core/usage/NativeUsageTaxonomy';
import type { GaugeCardViewModel } from './GaugeCardViewModel';

export interface ProviderCardVisibility {
  readonly claude: boolean;
  readonly codex: boolean;
}

export interface ProviderCardVisibilityInput {
  readonly claude?: unknown;
  readonly codex?: unknown;
}

export const DEFAULT_PROVIDER_CARD_VISIBILITY: ProviderCardVisibility = {
  claude: true,
  codex: true,
};

export function resolveProviderCardVisibility(
  input: ProviderCardVisibilityInput = {},
): ProviderCardVisibility {
  return {
    claude: typeof input.claude === 'boolean' ? input.claude : true,
    codex: typeof input.codex === 'boolean' ? input.codex : true,
  };
}

export function visibleAgentsForCardVisibility(
  visibility: ProviderCardVisibility,
): readonly AgentId[] {
  const agents: AgentId[] = [];
  if (visibility.claude) agents.push('claude-code');
  if (visibility.codex) agents.push('codex');
  return agents;
}

export function codexProbeVisibleForCockpit(
  nativeStatusProbeEnabled: boolean,
  visibility: ProviderCardVisibility,
): boolean {
  return nativeStatusProbeEnabled && visibility.codex;
}

export function filterGaugeCardsByVisibility(
  cards: readonly GaugeCardViewModel[],
  visibility: ProviderCardVisibility,
): GaugeCardViewModel[] {
  return cards.filter((card) => {
    if (card.agent === 'claude-code') return visibility.claude;
    if (card.agent === 'codex') return visibility.codex;
    return true;
  });
}
