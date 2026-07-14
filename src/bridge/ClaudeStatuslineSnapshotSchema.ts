// Claude statusLine snapshot boundary.
//
// The shape the opt-in Claude statusLine snapshot reader accepts. The full
// documented statusLine payload is RICH and carries FORBIDDEN fields: `cwd`,
// `workspace.current_dir`, `workspace.project_dir`, `workspace.repo.host/owner/
// name` (raw paths + git remote identity), all banned from persistence.
//
// This schema is the structural defence: `.strict()` at EVERY object level, so
// any key NOT in the safe allowlist (e.g. `cwd`, a `workspace` object, `repo`)
// makes the parse FAIL by construction — the leaky fields never get a place to
// land. Only verified-safe bounded fields are allowlisted.
//
// IMPORTANT: the privacy-safe statusLine writer emits ALREADY-
// HASHED identifiers — `session_id_hash` and `workspace_hash` — NOT raw
// `session_id`. Earlier this schema REQUIRED raw `session_id` and rejected the
// safe writer's extra fields (`source`, `timestamp`,
// `model.display_name`, ...), so the valid snapshot was silently rejected.
// Identifiers are now optional: a hash is used directly; a raw `session_id`
// (legacy/alt writer) is hashed by the consumer and never stored raw; neither
// present degrades only the scope field. Every safe writer field is enumerated
// so `.strict()` keeps rejecting genuinely leaky keys.
//
// Live consumers add their own Redactor backstops for admitted free-shape
// strings after this structural boundary.

import { z } from 'zod';

const PctSchema = z.number().min(0).max(100);

// Unix epoch seconds for the rate-limit window reset.
const EpochSecondsSchema = z.number().int().nonnegative();

const RateLimitWindowSchema = z
  .object({
    used_percentage: PctSchema,
    resets_at: EpochSecondsSchema,
    // Compatibility for alternate/legacy writers. The official Claude payload
    // exposes epoch `resets_at`; the canonical v1 writer does not assume an
    // official `resets_at_iso` input field exists.
    resets_at_iso: z.string().min(1).max(64),
  })
  .partial()
  .strict();

export const ClaudeStatuslineSnapshotSchema = z
  .object({
    // Bounded provenance fields the safe writer stamps. None carry path/secret
    // content; they are explicitly allowlisted so `.strict()` does not reject
    // the valid snapshot.
    source: z.string().min(1).max(64).optional(),
    timestamp: z.string().min(1).max(64).optional(),
    provider: z.string().min(1).max(60).optional(),
    agent: z.string().min(1).max(60).optional(),
    // ALREADY-HASHED identifiers from the privacy-safe writer (preferred form).
    session_id_hash: z.string().min(1).max(128).optional(),
    workspace_hash: z.string().min(1).max(128).optional(),
    // Raw session id (legacy/alt writer). Accepted but HASHED by the consumer
    // before use — never stored or displayed raw. NOT required.
    session_id: z.string().min(1).max(256).optional(),
    model: z
      .object({
        id: z.string().min(1).max(120),
        display_name: z.string().min(1).max(120).optional(),
      })
      .strict(),
    cost: z
      .object({
        total_cost_usd: z.number().nonnegative(),
      })
      .partial()
      .strict()
      .optional(),
    context_window: z
      .object({
        context_window_size: z.number().int().positive(),
        used_percentage: PctSchema,
        remaining_percentage: PctSchema,
        total_input_tokens: z.number().int().nonnegative(),
        total_output_tokens: z.number().int().nonnegative(),
      })
      .partial()
      .strict()
      .optional(),
    exceeds_200k_tokens: z.boolean().optional(),
    rate_limits: z
      .object({
        five_hour: RateLimitWindowSchema,
        seven_day: RateLimitWindowSchema,
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export type ClaudeStatuslineSnapshot = z.infer<typeof ClaudeStatuslineSnapshotSchema>;

// The top-level safe-field allowlist. Defence-in-depth documentation of what the
// snapshot boundary admits — there is intentionally NO cwd/workspace/repo entry
// (only the hashed `workspace_hash`).
export const STATUSLINE_SNAPSHOT_FIELD_ALLOWLIST = [
  'source',
  'timestamp',
  'provider',
  'agent',
  'session_id_hash',
  'workspace_hash',
  'session_id',
  'model',
  'cost',
  'context_window',
  'exceeds_200k_tokens',
  'rate_limits',
] as const;

// WR-01 hardening: a field named `*_hash` must never carry a raw identifier into
// a persistence-capable path. A trusted value is a bounded lowercase-hex token
// (the form IdHasher emits, 16–64 chars). Anything else is treated as untrusted
// and RE-HASHED so a raw id can never persist verbatim.
const HASH_LIKE = /^[0-9a-f]{16,64}$/;

export function isHashLike(value: string): boolean {
  return HASH_LIKE.test(value);
}

// Trust a bounded lowercase-hex value directly; otherwise re-hash it. The raw
// value is never returned, displayed, or persisted.
function normalizeProvidedHash(value: string, hashRaw: (raw: string) => string): string {
  return isHashLike(value) ? value : hashRaw(value);
}

// Resolve a sanitized scope hash from a snapshot WITHOUT ever exposing a raw id:
// prefer a hash-like `session_id_hash` (used directly); a malformed/raw value in
// that field is RE-HASHED (never trusted verbatim); otherwise hash a raw
// `session_id`; otherwise undefined (the scope field degrades, the rest of the
// snapshot is still usable). The hasher is injected so this stays pure/testable.
export function resolveSnapshotSessionHash(
  snapshot: Pick<ClaudeStatuslineSnapshot, 'session_id_hash' | 'session_id'>,
  hashRawSessionId: (raw: string) => string,
): string | undefined {
  if (typeof snapshot.session_id_hash === 'string' && snapshot.session_id_hash.length > 0) {
    return normalizeProvidedHash(snapshot.session_id_hash, hashRawSessionId);
  }
  if (typeof snapshot.session_id === 'string' && snapshot.session_id.length > 0) {
    return hashRawSessionId(snapshot.session_id);
  }
  return undefined;
}

// Same hardening for the workspace hash: trust a hash-like value, re-hash a
// malformed/raw one, omit when absent.
export function resolveSnapshotWorkspaceHash(
  snapshot: Pick<ClaudeStatuslineSnapshot, 'workspace_hash'>,
  hashRawWorkspaceId: (raw: string) => string,
): string | undefined {
  if (typeof snapshot.workspace_hash === 'string' && snapshot.workspace_hash.length > 0) {
    return normalizeProvidedHash(snapshot.workspace_hash, hashRawWorkspaceId);
  }
  return undefined;
}

// Prefer the ISO reset string when present; otherwise convert Unix epoch seconds.
export function resolveResetIso(window: {
  resets_at_iso?: string;
  resets_at?: number;
}): string | undefined {
  if (typeof window.resets_at_iso === 'string' && window.resets_at_iso.length > 0) {
    return window.resets_at_iso;
  }
  if (typeof window.resets_at === 'number') {
    return new Date(window.resets_at * 1000).toISOString();
  }
  return undefined;
}
