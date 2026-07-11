// safe, bounded, fail-closed ingestion of ~/.claude/stats-cache.json as a
// NATIVE structured token-detail source.
//
// stats-cache.json is a local machine-readable file Claude Code maintains. It
// carries per-model token buckets (input/output/cache), costUSD, contextWindow,
// and maxOutputTokens — i.e. TOKEN-DETAIL. It does NOT carry session/5h or
// weekly/7d rate-limit percent/reset, so this source NEVER produces a
// session/weekly limit field: the schema does not admit them.
//
// Privacy/trust:
//   - `.strict()` allowlist per model row — forbidden/extra fields (e.g. the
//     file's `longestSession.sessionId`) are never read; the top-level read
//     only picks `modelUsage`, never `longestSession`/`hourCounts`/etc.
// - Local file read only — NO exec, NO network.
//   - Bounded: a malformed/oversized/missing file fails CLOSED — no throw into
//     the caller, no candidate, a documented absence.
//   - The live shape is INFORMED by a probe of the real file but verification is
// FIXTURE-BASED; the live file's absence is tolerated.
//
// Token-detail uses the distinct native tier `stats_cache_snapshot` — NEVER
// `statusline_snapshot`: a stale stats-cache value must never
// be presented as a live statusLine snapshot, and a failing statusLine snapshot
// must not be masked by stats-cache under the same label.

import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { SourceCandidate } from '../../core/cockpit/SourcePriorityResolver';

// Defensive cap so a corrupt/huge file never blows up the read (bounded).
const MAX_BYTES = 2 * 1024 * 1024;

const ModelUsageRowSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cacheReadInputTokens: z.number().nonnegative().optional(),
    cacheCreationInputTokens: z.number().nonnegative().optional(),
    webSearchRequests: z.number().nonnegative().optional(),
    costUSD: z.number().nonnegative().optional(),
    contextWindow: z.number().nonnegative().optional(),
    maxOutputTokens: z.number().nonnegative().optional(),
  })
  .strict();

// Only `modelUsage` is read. Other top-level keys (longestSession with its raw
// sessionId, dailyActivity, hourCounts, firstSessionDate) are intentionally NOT
// in this schema — `.passthrough()` on the top object lets us ignore them while
// the per-model rows stay strict.
const StatsCacheSchema = z
  .object({
    modelUsage: z.record(z.string(), ModelUsageRowSchema),
  })
  .passthrough();

export type StatsCacheModelRow = z.infer<typeof ModelUsageRowSchema>;

export type ParseStatsCacheResult =
  | { readonly ok: true; readonly modelUsage: Record<string, StatsCacheModelRow> }
  | { readonly ok: false; readonly reason: string };

export function parseStatsCache(raw: unknown): ParseStatsCacheResult {
  const parsed = StatsCacheSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'schema-rejected' };
  }
  return { ok: true, modelUsage: parsed.data.modelUsage };
}

export interface ReadStatsCacheDeps {
  readonly now: () => Date;
}

// Read + parse the stats-cache file at `filePath`, producing token-detail
// cockpit candidates (one per model). Fails CLOSED: any read/parse/size failure
// yields an empty array — never a throw, never a partial leak.
export function readStatsCacheCandidates(
  filePath: string,
  deps: ReadStatsCacheDeps,
): SourceCandidate[] {
  let text: string;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return [];
    }
    text = readFileSync(filePath, 'utf8');
  } catch {
    // Missing / unreadable file: documented absence, no candidate.
    return [];
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }

  const result = parseStatsCache(json);
  if (!result.ok) {
    return [];
  }

  const producedAtMs = deps.now().getTime();
  const out: SourceCandidate[] = [];
  for (const [model, row] of Object.entries(result.modelUsage)) {
    out.push({
      sourceTier: 'stats_cache_snapshot',
      producedAtMs,
      scope: { provider: 'anthropic', agent: 'claude-code', model },
      confidence: 'medium',
      model,
      ...(typeof row.costUSD === 'number' ? { cost: row.costUSD } : {}),
    });
  }
  return out;
}
