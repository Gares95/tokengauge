// promote the Claude statusLine snapshot to a PRIMARY cockpit source.
//
// This maps a validated Claude statusLine JSON snapshot to a SourceCandidate
// tagged with the SINGLE canonical sourceTier `statusline_snapshot`. It is
// INDEPENDENT of the observed-limit bridge
// — producing a cockpit candidate does NOT require recording an observed-limit
// sample. That bridge remains a separate cross-check path.
//
// Privacy: reuse the existing `.strict()` ClaudeStatuslineSnapshotSchema (do
// NOT re-derive the allowlist) so a leaky full payload (cwd/workspace/repo/
// account) fails by construction. Hash session_id via IdHasher; the raw id is
// read transiently and never lands on the candidate. The one free-shape field
// the schema admits (model.id) is run through the shared Redactor backstop.
// No I/O, no network — a single pure transform over the injected snapshot.

import {
  type ClaudeStatuslineSnapshot,
  ClaudeStatuslineSnapshotSchema,
  resolveResetIso,
  resolveSnapshotSessionHash,
  resolveSnapshotWorkspaceHash,
} from '../../bridge/ClaudeStatuslineSnapshotSchema';
import type { IdHasher } from '../../security/IdHasher';
import { redactString } from '../../security/Redactor';
import { PrivacyViolationError } from '../diagnostics/errors';
import type { SourceCandidate } from './SourcePriorityResolver';

export interface ClaudeStatuslineCockpitSourceDeps {
  readonly hasher: IdHasher;
  readonly now: () => Date;
}

function windowFields(
  window: { used_percentage?: number; resets_at?: number; resets_at_iso?: string } | undefined,
): { usedPct?: number; leftPct?: number; resetsAt?: string } | undefined {
  if (window === undefined) return undefined;
  const usedPct = typeof window.used_percentage === 'number' ? window.used_percentage : undefined;
  // The statusLine carries only used_percentage; derive the remaining
  // percentage from it (clamped 0..100) so the cockpit's native "% left" field
  // is populated from the primary source rather than always reading unavailable.
  const leftPct = usedPct !== undefined ? Math.max(0, Math.min(100, 100 - usedPct)) : undefined;
  // Prefer the ISO reset string the safe writer emits; else convert epoch.
  const resetsAt = resolveResetIso(window);
  if (usedPct === undefined && resetsAt === undefined) return undefined;
  return {
    ...(usedPct !== undefined ? { usedPct } : {}),
    ...(leftPct !== undefined ? { leftPct } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

// Map the schema's context_window
// into the candidate.context sub-object. Mirrors windowFields: undefined-in →
// undefined-out, per-field presence checks, clamped percentage derivations. When
// only one of used/remaining is present, derive the other as 100 - present
//. usedTokens is intentionally left unset — the Claude schema does not
// carry it and it is never fabricated from input+output.
function contextFields(
  ctx:
    | {
        context_window_size?: number;
        used_percentage?: number;
        remaining_percentage?: number;
        total_input_tokens?: number;
        total_output_tokens?: number;
      }
    | undefined,
):
  | {
      usedPct?: number;
      leftPct?: number;
      windowSizeTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | undefined {
  if (ctx === undefined) return undefined;
  const clamp = (n: number): number => Math.max(0, Math.min(100, n));
  const rawUsed = typeof ctx.used_percentage === 'number' ? clamp(ctx.used_percentage) : undefined;
  const rawLeft =
    typeof ctx.remaining_percentage === 'number' ? clamp(ctx.remaining_percentage) : undefined;
  const usedPct = rawUsed ?? (rawLeft !== undefined ? clamp(100 - rawLeft) : undefined);
  const leftPct = rawLeft ?? (rawUsed !== undefined ? clamp(100 - rawUsed) : undefined);
  const windowSizeTokens =
    typeof ctx.context_window_size === 'number' ? ctx.context_window_size : undefined;
  const inputTokens =
    typeof ctx.total_input_tokens === 'number' ? ctx.total_input_tokens : undefined;
  const outputTokens =
    typeof ctx.total_output_tokens === 'number' ? ctx.total_output_tokens : undefined;
  if (
    usedPct === undefined &&
    leftPct === undefined &&
    windowSizeTokens === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(usedPct !== undefined ? { usedPct } : {}),
    ...(leftPct !== undefined ? { leftPct } : {}),
    ...(windowSizeTokens !== undefined ? { windowSizeTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

// Parse the writer's ISO `timestamp` to epoch ms. A non-string, empty, or
// unparseable value yields undefined (never NaN on the candidate).
function parseSnapshotTimestamp(timestamp: string | undefined): number | undefined {
  if (typeof timestamp !== 'string' || timestamp.length === 0) {
    return undefined;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

export function snapshotToCockpitCandidate(
  rawSnapshot: unknown,
  deps: ClaudeStatuslineCockpitSourceDeps,
): SourceCandidate {
  // Gate 1: strict allowlist. A leaky full payload fails here by construction.
  const snapshot: ClaudeStatuslineSnapshot = ClaudeStatuslineSnapshotSchema.parse(rawSnapshot);

  // Gate 2 (defence-in-depth): model.id is the one free-shape string the schema
  // admits. Reject if it carries a forbidden pattern before mapping.
  if (redactString(snapshot.model.id) !== snapshot.model.id) {
    throw new PrivacyViolationError('forbidden-content:model-id');
  }

  // Sanitized scope hashes: a hash-like value is used directly; a raw or
  // malformed one is re-hashed; absent => omitted. The raw id never reaches the
  // candidate.
  const sessionHash = resolveSnapshotSessionHash(snapshot, (raw) => deps.hasher.hashSessionId(raw));
  const workspaceHash = resolveSnapshotWorkspaceHash(snapshot, (raw) =>
    deps.hasher.hashWorkspaceId(raw),
  );

  const session = windowFields(snapshot.rate_limits?.five_hour);
  const weekly = windowFields(snapshot.rate_limits?.seven_day);
  const context = contextFields(snapshot.context_window);
  const cost = snapshot.cost?.total_cost_usd;

  // Thread the WRITER's own capture time onto the
  // candidate. A valid ISO `timestamp` → epoch ms; absent/garbage → undefined
  // (the stability gate then falls back to its capturedAt-unavailable tie-break).
  const snapshotCapturedAtMs = parseSnapshotTimestamp(snapshot.timestamp);

  return {
    sourceTier: 'statusline_snapshot',
    producedAtMs: deps.now().getTime(),
    ...(snapshotCapturedAtMs !== undefined ? { snapshotCapturedAtMs } : {}),
    scope: { provider: 'anthropic', agent: 'claude-code', model: snapshot.model.id },
    confidence: 'high',
    ...(session !== undefined ? { session } : {}),
    ...(weekly !== undefined ? { weekly } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(typeof cost === 'number' ? { cost } : {}),
    model: snapshot.model.id,
    ...(workspaceHash !== undefined ? { workspaceHash } : {}),
    ...(sessionHash !== undefined ? { sessionHash } : {}),
  };
}
