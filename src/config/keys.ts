/**
 * Canonical list of every tokenGauge.* setting key.
 * Mirrors package.json#contributes.configuration.properties.
 * The parity is enforced by test/unit/manifest-keys.test.ts (Plan 04).
 * When adding a new key, add it here AND in package.json; drift is a CI failure.
 */
export const TOKENGAUGE_KEYS = [
  'tokenGauge.pollIntervalSeconds',
  // Gates the technical trust details on cockpit
  // cards. Default false → the card hides source tier / raw freshness / logs-off /
  // reason id / billing disclaimer / confidence; warnings + context stay visible.
  'tokenGauge.display.showTechnicalDetails',
  // Card visibility preferences. Default true; hiding a card removes it from
  // summaries and gates that provider's native reads/probes without changing
  // the Codex native probe opt-in setting.
  'tokenGauge.display.cards.claude.visible',
  'tokenGauge.display.cards.codex.visible',
  // Cockpit wiring. nativeStatusProbe (default
  // false) gates ALL Codex app-server probes incl. the manual Refresh command;
  // statuslineSnapshotPath (default '') is the exact native-snapshot file path.
  'tokenGauge.providers.codex.nativeStatusProbe',
  'tokenGauge.claude.statuslineSnapshotPath',
] as const;

export type TokenGaugeKey = (typeof TOKENGAUGE_KEYS)[number];

export type EffectiveConfig = {
  readonly [K in TokenGaugeKey]: unknown;
};

export const TOKENGAUGE_NAMESPACE = 'tokenGauge' as const;
