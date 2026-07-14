// The per-field source-priority resolver.
//
// `resolve(candidates, ctx)` builds a CockpitState by selecting the BEST source
// PER FIELD using the SourceTier ranking for that field class (with the cost /
// reset per-field overrides), then stamping sourceTier + accuracyLabel +
// freshness + confidence. It never emits a value stronger than its source.
//
// Freshness policy (documented): a native candidate older than the
// per-field-class threshold is surfaced as DEGRADED (reason native_status_stale,
// confidence lowered) — NOT silently dropped. Tie-break order: higher tier
// first, then fresher. A stale native value is still shown UNLESS a non-stale
// higher-or-equal-tier candidate exists for that field.
//
// Native-only: the cockpit resolves among native Claude/Codex candidates. When
// no native candidate is available a field resolves `unavailable` (reason
// no_source) — never reconstructed from logs.
//
// Pure: injected clock; no I/O.

import {
  type FieldClass,
  type FieldOrClass,
  outranks,
  rankOf,
  type SourceTier,
} from '../sources/SourceTier';
import type { AccuracyLabel, AgentId, ProviderId } from '../usage/NativeUsageTaxonomy';
import {
  type CockpitContextWindow,
  type CockpitField,
  type CockpitFieldReason,
  type CockpitScope,
  type CockpitState,
  type Confidence,
  deriveRisk,
  emptyCockpitState,
  fieldOf,
  unavailableField,
} from './CockpitState';

// Per-field-class freshness thresholds. Limit/risk go stale fast (a 5h window
// moves quickly); token-detail (cost/model) tolerates a longer age.
export const FRESHNESS_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
export const FRESHNESS_DETAIL_MS = 60 * 60 * 1000; // 60 minutes

// A single source's contribution. Any subset of fields may be present; absent
// fields simply do not compete for that slot.
export interface SourceCandidate {
  readonly sourceTier: SourceTier;
  readonly producedAtMs: number;
  // The WRITER's own capture time (parsed from the snapshot
  // `timestamp`), distinct from the read-time `producedAtMs`. The Claude snapshot
  // stability gate uses it as the monotonic key so a watch/poll re-read of an
  // older-captured value can never replace a newer-accepted one. Undefined when
  // the snapshot carries no usable timestamp.
  readonly snapshotCapturedAtMs?: number;
  readonly scope: {
    readonly provider: ProviderId;
    readonly agent: AgentId;
    readonly model?: string;
  };
  readonly confidence?: Confidence;
  readonly session?: {
    readonly usedPct?: number;
    readonly leftPct?: number;
    readonly resetsAt?: string;
  };
  readonly weekly?: {
    readonly usedPct?: number;
    readonly leftPct?: number;
    readonly resetsAt?: string;
  };
  readonly cost?: number;
  readonly model?: string;
  // The current context-window usage plus the
  // agent's reasoning effort / version / plan type. Plain optional numbers/strings
  // (absent fields simply do not compete).
  readonly context?: {
    readonly usedPct?: number;
    readonly leftPct?: number;
    readonly windowSizeTokens?: number;
    readonly usedTokens?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
  readonly reasoning?: string;
  readonly agentVersion?: string;
  readonly planType?: string;
  readonly workspaceHash?: string;
  readonly sessionHash?: string;
  // A `sourceTier: 'unknown'` blocker candidate (Codex probe disabled,
  // statusLine snapshot not configured) carries the specific closed-set reason it
  // wants the card to surface. It NEVER competes for a value field (it has no
  // session/weekly) — `resolve()` ignores it entirely; the builder reads it only
  // to upgrade an otherwise-generic `no_source` card reason into the honest one.
  readonly unavailableReason?: CockpitFieldReason;
}

export interface ResolveContext {
  readonly now: () => Date;
}

// Map a sourceTier to its honesty accuracy label. SourceTier is distinct from
// AccuracyLabel — this is a presentation mapping, NOT a lattice mutation.
function accuracyFor(tier: SourceTier): AccuracyLabel {
  switch (tier) {
    // Native agent-reported status surfaces (statusLine / stats-cache) are
    // reported by the agent's own status surface, so `proxy_reported` is the
    // honest label.
    case 'statusline_snapshot':
    case 'stats_cache_snapshot':
    // The Codex native status probe is an agent-reported status surface, NOT
    // billing — proxy_reported is the honest label. It can
    // never present as exact/billing_authoritative.
    case 'codex_status_snapshot':
      return 'proxy_reported';
    case 'unknown':
      return 'unknown';
  }
}

function freshnessThreshold(field: FieldOrClass): number {
  // Limit/risk + reset are time-sensitive; cost + token detail tolerate age.
  return field === 'cost' ? FRESHNESS_DETAIL_MS : FRESHNESS_LIMIT_MS;
}

interface FieldCandidate<T> {
  readonly tier: SourceTier;
  readonly value: T;
  readonly producedAtMs: number;
  readonly confidence?: Confidence;
}

// Select the winning candidate for one field. Higher tier wins; ties break to
// fresher. A stale top candidate is replaced only by a non-stale candidate of
// HIGHER-OR-EQUAL tier; otherwise the stale value is shown degraded.
function selectField<T>(
  field: FieldOrClass,
  candidates: readonly FieldCandidate<T>[],
  ctx: ResolveContext,
): CockpitField<T> {
  // Native-only honesty: every field is shown ONLY from a native source. When no
  // native candidate is present the field resolves `no_source` (unavailable) —
  // TokenGauge never reconstructs or synthesizes a value.
  if (candidates.length === 0) {
    return unavailableField<T>('no_source');
  }
  const eligible = candidates;

  const nowMs = ctx.now().getTime();
  const threshold = freshnessThreshold(field);
  const isStale = (c: FieldCandidate<T>): boolean => nowMs - c.producedAtMs > threshold;

  // Rank: strongest tier first; tie-break fresher (smaller age).
  const ranked = [...eligible].sort((a, b) => {
    const tierDelta = rankOf(b.tier, field) - rankOf(a.tier, field);
    if (tierDelta !== 0) return tierDelta;
    return a.producedAtMs > b.producedAtMs ? -1 : a.producedAtMs < b.producedAtMs ? 1 : 0;
  });

  const top = ranked[0];
  // If the top is stale, see if a non-stale candidate of >= tier exists.
  if (isStale(top)) {
    const nonStaleEqualOrHigher = ranked.find(
      (c) => !isStale(c) && !outranks(top.tier, c.tier, field),
    );
    if (nonStaleEqualOrHigher !== undefined) {
      return stamp(field, nonStaleEqualOrHigher);
    }
    // Shown but degraded.
    return {
      available: true,
      value: top.value,
      sourceTier: top.tier,
      accuracyLabel: accuracyFor(top.tier),
      freshnessMs: nowMs - top.producedAtMs,
      confidence: 'low',
      reason: 'native_status_stale',
    };
  }

  return stamp(field, top);
}

function stamp<T>(_field: FieldOrClass, c: FieldCandidate<T>): CockpitField<T> {
  return fieldOf<T>(c.value, {
    sourceTier: c.tier,
    accuracyLabel: accuracyFor(c.tier),
    freshnessMs: 0,
    confidence: c.confidence ?? 'medium',
  });
}

function collect<T>(
  candidates: readonly SourceCandidate[],
  pick: (c: SourceCandidate) => T | undefined,
): FieldCandidate<T>[] {
  const out: FieldCandidate<T>[] = [];
  for (const c of candidates) {
    const value = pick(c);
    if (value !== undefined) {
      out.push({
        tier: c.sourceTier,
        value,
        producedAtMs: c.producedAtMs,
        ...(c.confidence !== undefined ? { confidence: c.confidence } : {}),
      });
    }
  }
  return out;
}

function resolveWindow(
  candidates: readonly SourceCandidate[],
  select: (
    c: SourceCandidate,
  ) => { usedPct?: number; leftPct?: number; resetsAt?: string } | undefined,
  ctx: ResolveContext,
): {
  usedPct: CockpitField<number>;
  leftPct: CockpitField<number>;
  resetsAt: CockpitField<string>;
} {
  const usedPct = selectField<number>(
    'limit',
    collect(candidates, (c) => select(c)?.usedPct),
    ctx,
  );
  const leftPct = selectField<number>(
    'limit',
    collect(candidates, (c) => select(c)?.leftPct),
    ctx,
  );
  const resetsAt = selectField<string>(
    'reset',
    collect(candidates, (c) => select(c)?.resetsAt),
    ctx,
  );
  return { usedPct, leftPct, resetsAt };
}

// Resolve the current context-window group under the tokenDetail field class
// (context usage is token-detail data, not a rate-limit window).
function resolveContextWindow(
  candidates: readonly SourceCandidate[],
  ctx: ResolveContext,
): CockpitContextWindow {
  const pick = (k: keyof NonNullable<SourceCandidate['context']>) =>
    selectField<number>(
      'tokenDetail',
      collect(candidates, (c) => c.context?.[k]),
      ctx,
    );
  return {
    usedPct: pick('usedPct'),
    leftPct: pick('leftPct'),
    windowSizeTokens: pick('windowSizeTokens'),
    usedTokens: pick('usedTokens'),
    inputTokens: pick('inputTokens'),
    outputTokens: pick('outputTokens'),
  };
}

export function resolve(candidates: readonly SourceCandidate[], ctx: ResolveContext): CockpitState {
  // Scope from the strongest candidate (by limit rank) — provider/agent/model
  // plus hashed workspace/session if present.
  const scopeSource = [...candidates].sort(
    (a, b) => rankOf(b.sourceTier, 'limit') - rankOf(a.sourceTier, 'limit'),
  )[0];
  const scope: CockpitScope = scopeSource
    ? {
        provider: scopeSource.scope.provider,
        agent: scopeSource.scope.agent,
        ...(scopeSource.model !== undefined ? { model: scopeSource.model } : {}),
        ...(scopeSource.workspaceHash !== undefined
          ? { workspaceHash: scopeSource.workspaceHash }
          : {}),
        ...(scopeSource.sessionHash !== undefined ? { sessionHash: scopeSource.sessionHash } : {}),
      }
    : { provider: 'unknown', agent: 'other' };

  const base = emptyCockpitState(scope);

  const session = resolveWindow(candidates, (c) => c.session, ctx);
  const weekly = resolveWindow(candidates, (c) => c.weekly, ctx);
  const cost = selectField<number>(
    'cost',
    collect(candidates, (c) => c.cost),
    ctx,
  );
  const model = selectField<string>(
    'tokenDetail',
    collect(candidates, (c) => c.model),
    ctx,
  );
  const context = resolveContextWindow(candidates, ctx);
  const reasoning = selectField<string>(
    'tokenDetail',
    collect(candidates, (c) => c.reasoning),
    ctx,
  );
  const agentVersion = selectField<string>(
    'tokenDetail',
    collect(candidates, (c) => c.agentVersion),
    ctx,
  );
  const planType = selectField<string>(
    'tokenDetail',
    collect(candidates, (c) => c.planType),
    ctx,
  );
  const riskLevel = deriveRisk(session.usedPct);

  return {
    ...base,
    scope,
    session,
    weekly,
    cost,
    model,
    riskLevel,
    context,
    reasoning,
    agentVersion,
    planType,
  };
}

export type { FieldClass };
