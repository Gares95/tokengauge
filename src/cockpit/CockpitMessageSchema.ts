// The cockpit webview message contract.
//
// Parse-or-drop boundary: per-message .strict() objects,
// z.discriminatedUnion('type', ...), and sanitized, content-free diagnostics.
// The OUTBOUND payload is a fully-typed zod schema mirroring GaugeCardViewModel:
// closed z.enum sets for freshness/risk/colorKey/sourceTier/reason/accuracy,
// bounded z.string().max() for display strings, and NO z.unknown().
//
// Only seven inbound types are allowlisted: ready | refreshNativeStatus |
// openClaudeSnapshotPathSetting | openSettings | configureCockpit |
// openPrivacyReport | openCockpitDiagnostics.
// Anything else drops with ruleId 'cockpit-postmessage-invalid'. The two open*
// additions (cockpit refinement) carry NO payload — each is a bare
// `{ type }` the host routes to the matching read-only TokenGauge command.

import { z } from 'zod';
import { COCKPIT_FIELD_REASONS } from '../core/cockpit/CockpitState';
import type { DiagnosticsEntryInput } from '../core/diagnostics/DiagnosticsService';
import { SOURCE_TIERS } from '../core/sources/SourceTier';
import { ACCURACY_LABELS, AGENT_IDS } from '../core/usage/NativeUsageTaxonomy';

export interface CockpitDiagnosticsLike {
  record(entry: DiagnosticsEntryInput): void;
}

// ── Inbound (untrusted webview → extension host) ───────────────────────────
const ReadyMessageSchema = z.object({ type: z.literal('ready') }).strict();
const RefreshNativeStatusMessageSchema = z
  .object({ type: z.literal('refreshNativeStatus') })
  .strict();
// An optional CLOSED-enum `target` so CTAs can open SPECIFIC settings
// instead of the extension-filtered list. The webview can never pass an
// arbitrary settings query. Absent → the list.
const OpenSettingsMessageSchema = z
  .object({
    type: z.literal('openSettings'),
    target: z.enum(['claudeSnapshotPath', 'codexProbe', 'providerCards']).optional(),
  })
  .strict();
// The Claude card's specific "Configure snapshot path" CTA posts this distinct
// message so it cannot be confused with the generic Configure Cockpit picker.
const OpenClaudeSnapshotPathSettingMessageSchema = z
  .object({ type: z.literal('openClaudeSnapshotPathSetting') })
  .strict();
// The getting-started empty state's "Configure Cockpit" button posts this. The
// host routes it to the read-only `tokenGauge.configureCockpit` command — it
// never carries or sets any setting value.
const ConfigureCockpitMessageSchema = z.object({ type: z.literal('configureCockpit') }).strict();
// Cockpit refinement: the persistent action links post these. The host routes
// them to the existing read-only `tokenGauge.openPrivacyReport` /
// `tokenGauge.cockpitDiagnostics` commands — neither carries or sets any value.
const OpenPrivacyReportMessageSchema = z.object({ type: z.literal('openPrivacyReport') }).strict();
const OpenCockpitDiagnosticsMessageSchema = z
  .object({ type: z.literal('openCockpitDiagnostics') })
  .strict();

export const CockpitInboundMessageSchema = z.discriminatedUnion('type', [
  ReadyMessageSchema,
  RefreshNativeStatusMessageSchema,
  OpenClaudeSnapshotPathSettingMessageSchema,
  OpenSettingsMessageSchema,
  ConfigureCockpitMessageSchema,
  OpenPrivacyReportMessageSchema,
  OpenCockpitDiagnosticsMessageSchema,
]);

// ── Outbound (extension host → webview): fully-typed VM payload ─────────────
const FreshnessSchema = z.enum(['fresh', 'stale', 'degraded', 'unavailable']);
const ColorKeySchema = z.enum(['claude', 'codex', 'other']);
const RiskSchema = z.enum(['ok', 'warning', 'critical', 'unavailable']);
const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
const ReasonSchema = z.enum(COCKPIT_FIELD_REASONS);
const SourceTierSchema = z.enum(SOURCE_TIERS);
const AccuracySchema = z.enum(ACCURACY_LABELS);
const AgentSchema = z.enum(AGENT_IDS);

// Bounded display strings — a leak vector if unbounded.
const DisplayString = z.string().max(120);

const GaugeViewModelSchema = z
  .object({
    usedPct: z.number().optional(),
    leftPct: z.number().optional(),
    centerLabel: DisplayString,
    subLabel: DisplayString.optional(),
    state: FreshnessSchema,
    reason: ReasonSchema.optional(),
    accuracyLabel: AccuracySchema.optional(),
    confidence: ConfidenceSchema.optional(),
  })
  .strict();

const GaugeCardViewModelSchema = z
  .object({
    agent: AgentSchema,
    agentLabel: DisplayString,
    colorKey: ColorKeySchema,
    model: DisplayString.optional(),
    reasoning: DisplayString.optional(),
    agentVersion: DisplayString.optional(),
    session: GaugeViewModelSchema,
    weekly: GaugeViewModelSchema,
    context: GaugeViewModelSchema,
    costLabel: DisplayString.optional(),
    risk: RiskSchema,
    sourceTier: SourceTierSchema,
    accuracyLabel: AccuracySchema.optional(),
    confidence: ConfidenceSchema.optional(),
    freshness: FreshnessSchema,
    reason: ReasonSchema.optional(),
    costReason: ReasonSchema.optional(),
  })
  .strict();

const GaugeCardsMessageSchema = z
  .object({
    type: z.literal('gaugeCards'),
    cards: z.array(GaugeCardViewModelSchema),
  })
  .strict();

// A NON-SENSITIVE build id posted so UAT can prove
// which build is live. `buildId` is the extension version + a short content hash of
// the cockpit bundle (e.g. "build 0.0.1+ab12cd34ef56") — NEVER a path, account,
// email, session id, or secret. Bounded like every other display string; the host
// is the sole producer so a remote-style buildId can never be injected here.
const BuildInfoMessageSchema = z
  .object({
    type: z.literal('buildInfo'),
    buildId: DisplayString,
  })
  .strict();

// NON-SENSITIVE display-only flags plumbing technical details and
// card visibility to the webview. Booleans only — never a path/secret/value.
// Strict like every other outbound message so an extra key drops.
const DisplayConfigMessageSchema = z
  .object({
    type: z.literal('displayConfig'),
    showTechnicalDetails: z.boolean(),
    cardVisibility: z
      .object({
        claude: z.boolean(),
        codex: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const CockpitOutboundMessageSchema = z.discriminatedUnion('type', [
  GaugeCardsMessageSchema,
  BuildInfoMessageSchema,
  DisplayConfigMessageSchema,
]);

export type CockpitInboundMessage = z.infer<typeof CockpitInboundMessageSchema>;
export type CockpitOutboundMessage = z.infer<typeof CockpitOutboundMessageSchema>;
export type GaugeCardsMessage = z.infer<typeof GaugeCardsMessageSchema>;
export type BuildInfoMessage = z.infer<typeof BuildInfoMessageSchema>;
export type DisplayConfigMessage = z.infer<typeof DisplayConfigMessageSchema>;

export type CockpitInboundParseResult =
  | { readonly ok: true; readonly message: CockpitInboundMessage }
  | { readonly ok: false };

export function parseCockpitInboundMessage(
  raw: unknown,
  diagnostics?: CockpitDiagnosticsLike,
): CockpitInboundParseResult {
  const parsed = CockpitInboundMessageSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, message: parsed.data };
  }
  diagnostics?.record({
    ruleId: 'cockpit-postmessage-invalid',
    status: 'dropped',
    severity: 'warning',
    details: { reason: 'invalid-cockpit-message' },
  });
  return { ok: false };
}
