// Strict observed-limit sample boundary.
//
// The canonical shape for a native observed plan-limit sample read from the
// Claude statusLine snapshot. It is provider-visible / statusLine METADATA only
// — it does not reconstruct usage, does not train an estimator, and does not
// synthesize missing limits. Every field is whitelisted and zod `.strict()`
// rejects unknown keys at the boundary. A sample is STRUCTURED metadata only —
// bounded enums, non-negative counts, optional 0-100 percentages, and a single
// length-capped free-text note. There is intentionally no field for a raw total
// operand, prompt, completion, transcript, path, or git remote. The forbidden
// categories from PROJECT.md are excluded by construction; `.strict()` makes any
// such extra key a parse error. The downstream ObservedLimitSampleGuard layers
// the forbidden-content scan + Redactor over the free-text fields so even an
// in-bounds string carrying a sentinel/secret is rejected at the boundary.

import { z } from 'zod';
import { AGENT_IDS, PROVIDER_IDS } from '../usage/UsageEvent';

// Which usage window the sample observed. `context` is the model context
// window; `session`/`weekly` are plan-limit windows; `custom` is user-defined.
export const WINDOW_TYPES = ['session', 'weekly', 'context', 'custom'] as const;
export type WindowType = (typeof WINDOW_TYPES)[number];

// Plan structure (structure not quota). Selecting a plan configures
// window/label structure only — it never produces a hardcoded official quota.
export const PLAN_KINDS = ['pro', 'max5x', 'max20x', 'team', 'api-payg', 'custom'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

// How the native sample was captured. `bridge` = opt-in local Claude statusLine
// snapshot (the only producer today). `imported`/`inferred` are reserved enum
// members for potential future native import paths; nothing emits them now and
// TokenGauge does not infer or synthesize values.
export const SAMPLE_SOURCES = ['bridge', 'imported', 'inferred'] as const;
export type SampleSource = (typeof SAMPLE_SOURCES)[number];

// Resolved scope the native sample is attributed to. `scopeHash` carries a
// hashed scope identity only — never a raw path.
export const SCOPE_KINDS = ['workspace', 'claude-session', 'all-claude', 'custom'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const OBSERVED_LIMIT_NOTE_MAX = 500 as const;
export const OBSERVED_LIMIT_MODEL_MAX = 120 as const;
export const OBSERVED_LIMIT_SCOPE_HASH_MIN = 16 as const;

const PctSchema = z.number().min(0).max(100);

// 64-char hex id derived from the install salt + sample content via the
// existing IdHasher (no new dependency). Stable shape, content-free once stored.
const IdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const TimestampSchema = z.string().datetime();

export const ObservedLimitSampleSchema = z
  .object({
    id: IdSchema,
    timestamp: TimestampSchema,
    provider: z.enum(PROVIDER_IDS),
    agent: z.enum(AGENT_IDS),
    plan: z.enum(PLAN_KINDS),
    model: z.string().min(1).max(OBSERVED_LIMIT_MODEL_MAX).optional(),
    windowType: z.enum(WINDOW_TYPES),
    observedTokenGaugeTokens: z.number().int().nonnegative(),
    percentConsumed: PctSchema.optional(),
    percentRemaining: PctSchema.optional(),
    resetTime: TimestampSchema.optional(),
    limitHitFlag: z.boolean(),
    source: z.enum(SAMPLE_SOURCES),
    scopeKind: z.enum(SCOPE_KINDS),
    scopeHash: z.string().min(OBSERVED_LIMIT_SCOPE_HASH_MIN).optional(),
    note: z.string().min(1).max(OBSERVED_LIMIT_NOTE_MAX).optional(),
  })
  .strict();

export type ObservedLimitSample = z.infer<typeof ObservedLimitSampleSchema>;

// Defence-in-depth against a future schema widening accidentally re-admitting a
// forbidden key. The guard re-checks every key against this set even after a
// successful strict parse.
export const OBSERVED_LIMIT_SAMPLE_FIELD_ALLOWLIST = [
  'id',
  'timestamp',
  'provider',
  'agent',
  'plan',
  'model',
  'windowType',
  'observedTokenGaugeTokens',
  'percentConsumed',
  'percentRemaining',
  'resetTime',
  'limitHitFlag',
  'source',
  'scopeKind',
  'scopeHash',
  'note',
] as const;

// The fields the guard must run the forbidden-content scan + Redactor over.
// `note` is free text. `scopeHash` is normally a bounded hash, but it can be
// populated from an external snapshot field (`session_id_hash`/`workspace_hash`),
// so it is scanned as defence-in-depth: a raw path/secret/sentinel that
// reached it is rejected before persistence. Other enum/timestamp/id/number/
// boolean fields are content-free by construction.
export const OBSERVED_LIMIT_SAMPLE_FREE_TEXT_FIELDS = ['note', 'scopeHash'] as const;
