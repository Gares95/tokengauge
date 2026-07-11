// Accuracy lattice helpers.
//
// Single source of truth for the least-accurate-wins ordering. Every
// aggregator, rollup, or UI component that needs to combine `AccuracyLabel`
// values goes through `compareAccuracy` / `leastAccurate`. Duplicating the
// table elsewhere is a project-rule violation — change it here, propagate
// everywhere.
//
// The design keeps `billing_authoritative` and `exact` DISTINCT labels even though
// each is the strongest for its respective metric kind:
//   - cost  : billing_authoritative > exact
//   - token : exact > billing_authoritative
// They never collapse into one generic "trusted" rank.
//
// Floor: `unknown` is the weakest label for every kind.

import type { AccuracyLabel } from '../usage/UsageEvent';

export type MetricKind = 'cost' | 'token';

// Strength tables. Higher number = stronger / more trusted. Two distinct
// tables are required because `billing_authoritative` and `exact`
// flip ordering between metric kinds.
//
// Shared middle ranks (proxy_reported > partial) stay constant across kinds.
// `unknown` is always 0 — the floor.
const COST_STRENGTH: Readonly<Record<AccuracyLabel, number>> = {
  billing_authoritative: 6,
  exact: 5,
  proxy_reported: 4,
  partial: 1,
  unknown: 0,
};

const TOKEN_STRENGTH: Readonly<Record<AccuracyLabel, number>> = {
  exact: 6,
  billing_authoritative: 5,
  proxy_reported: 4,
  partial: 1,
  unknown: 0,
};

function strengthOf(label: AccuracyLabel, kind: MetricKind): number {
  return kind === 'cost' ? COST_STRENGTH[label] : TOKEN_STRENGTH[label];
}

/**
 * Returns a negative number if `a` is weaker than `b`, positive if stronger,
 * 0 if equal — for the given metric kind. Mirrors `Array.prototype.sort`
 * comparator semantics.
 */
export function compareAccuracy(a: AccuracyLabel, b: AccuracyLabel, kind: MetricKind): number {
  return strengthOf(a, kind) - strengthOf(b, kind);
}

/**
 * Returns the weakest label in `labels` for the given metric kind. Empty
 * input is treated as `unknown` — there is nothing to be confident about.
 */
export function leastAccurate(labels: readonly AccuracyLabel[], kind: MetricKind): AccuracyLabel {
  if (labels.length === 0) return 'unknown';
  let weakest: AccuracyLabel = labels[0];
  for (let i = 1; i < labels.length; i++) {
    if (compareAccuracy(labels[i], weakest, kind) < 0) {
      weakest = labels[i];
    }
  }
  return weakest;
}
