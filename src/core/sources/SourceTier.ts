// Source-priority architecture.
//
// SourceTier is the RUNTIME provenance dimension for a cockpit field: which
// surface produced the value. It is structurally distinct from `AccuracyLabel`;
// the resolver assigns the displayed honesty label from the winning source.
//
// Canonical tiers (native-only, ADR-004):
//   statusline_snapshot  — guarded Claude statusLine snapshot (the live native tier)
//   codex_status_snapshot— opt-in Codex app-server structured probe (native)
//   stats_cache_snapshot — local Claude stats-cache.json token-detail/cost cache
//   unknown              — no source; weakest floor
//
// Claude statusLine maps to the SINGLE canonical value `statusline_snapshot`.
// There is NO synthetic estimator tier — missing native data reads unavailable.

export const SOURCE_TIERS = [
  'statusline_snapshot',
  // Agent-reported native status via a bounded Codex app-server probe. A live
  // native limit/risk surface — ranked just below the Claude
  // statusLine snapshot. It carries NO token-bucket detail and NO cost, so it is
  // demoted in those two tables. Never conflated with the Claude tiers.
  'codex_status_snapshot',
  // Native structured token-detail/cost cache (~/.claude/stats-cache.json). A
  // distinct, honest native label — NEVER conflated with statusline_snapshot
  // (the report must not present a stale stats-cache value as live statusLine).
  'stats_cache_snapshot',
  'unknown',
] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];

// A field CLASS groups fields that share a ranking table; a per-FIELD override
// (`cost`, `reset`) lets a single field rank differently from its class default
// where the field's semantics demand it.
// Risk is NOT an independently-sourced field class — it is derived from the
// resolved session usedPct (see deriveRisk) and never flows through per-field
// source selection. Only limit/tokenDetail (plus the cost/reset overrides) are
// resolved classes.
export type FieldClass = 'limit' | 'tokenDetail';
export type FieldOverride = 'cost' | 'reset';
export type FieldOrClass = FieldClass | FieldOverride;

// Strength tables. Higher number = stronger source for that field class.
// `unknown` is always 0 (the floor). Each table is a strict total order over
// the canonical tiers so `outranks` is comparable for every pair.

// Limit / risk fields (session %, weekly %, resets, risk): live native status
// is preferred. `unknown` is the floor — there is no synthetic fallback.
const LIMIT_RISK_STRENGTH: Readonly<Record<SourceTier, number>> = {
  statusline_snapshot: 6,
  // Codex native status probe — live limit/risk, just below the Claude statusLine.
  // (The two native tiers never compete: resolution is per-agent.)
  codex_status_snapshot: 5.9,
  // stats-cache carries NO limit/risk fields; ranked above only the floor so it
  // can never win a limit field even if one were erroneously produced.
  stats_cache_snapshot: 0.5,
  unknown: 0,
};

// Token-bucket detail: native structured usage (statusLine / stats-cache via
// native tiers) is preferred.
const TOKEN_DETAIL_STRENGTH: Readonly<Record<SourceTier, number>> = {
  statusline_snapshot: 6,
  // stats-cache is the authoritative native token-detail source — just below the
  // statusLine snapshot.
  stats_cache_snapshot: 5.5,
  // the Codex status probe carries no token-bucket detail; demoted near the floor.
  codex_status_snapshot: 0.6,
  unknown: 0,
};

// Per-FIELD override for `reset`: live reset time must come from a live native
// source. Native tiers stay strongest; `unknown` is the floor.
const RESET_STRENGTH: Readonly<Record<SourceTier, number>> = {
  statusline_snapshot: 6,
  // Codex native status probe carries a live reset window — just below statusLine.
  codex_status_snapshot: 5.9,
  // stats-cache carries no reset time; ranked just above the floor.
  stats_cache_snapshot: 0.4,
  unknown: 0,
};

// Per-FIELD override for `cost`: a native structured cost (statusLine
// `cost.total_cost_usd`, stats-cache `costUSD`) wins.
const COST_STRENGTH: Readonly<Record<SourceTier, number>> = {
  statusline_snapshot: 6,
  // stats-cache costUSD is a native structured cost — just below statusLine.
  stats_cache_snapshot: 5.5,
  // the Codex status probe carries no cost; demoted near the floor.
  codex_status_snapshot: 0.6,
  unknown: 0,
};

function tableFor(field: FieldOrClass): Readonly<Record<SourceTier, number>> {
  switch (field) {
    case 'limit':
      return LIMIT_RISK_STRENGTH;
    case 'tokenDetail':
      return TOKEN_DETAIL_STRENGTH;
    case 'reset':
      return RESET_STRENGTH;
    case 'cost':
      return COST_STRENGTH;
  }
}

/**
 * Numeric strength of `tier` for the given field/class. `unknown` is always 0.
 * Higher = stronger. Intended for tie-break comparisons in the resolver.
 */
export function rankOf(tier: SourceTier, field: FieldOrClass): number {
  return tableFor(field)[tier];
}

/**
 * True when `a` is a strictly stronger source than `b` for the given
 * field/class. A total order per field class — every distinct pair is
 * comparable, and no tier outranks itself.
 */
export function outranks(a: SourceTier, b: SourceTier, field: FieldOrClass): boolean {
  return rankOf(a, field) > rankOf(b, field);
}
