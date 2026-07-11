// Claude statusLine -> observed-limit bridge.
//
// The opt-in, local-only, NO-NETWORK visible-usage bridge. It maps a passive
// Claude statusLine JSON snapshot (read by the caller from a user-configured
// local file the user's own statusLine script writes — TokenGauge NEVER edits
// the user's ~/.claude config) into a guarded `source:'bridge'` ObservedLimitSample.
//
// The flow is deliberately a single pure transform with NO I/O of its own:
//
//   1. Validate the raw snapshot against ClaudeStatuslineSnapshotSchema. Its
//      `.strict()` allowlist rejects cwd/workspace/repo/account fields by
// construction. A leaky full payload fails here.
// 2. HASH session_id via IdHasher. The raw id is read transiently and
//      never persisted — only the 64-hex hash reaches `scopeHash`.
//   3. Defence-in-depth: scan the one untrusted free-shape field that survives
//      the schema (model.id) through the shared Redactor registry, so a smuggled
//      secret in model.id is rejected before mapping.
//   4. Map used_percentage -> percentConsumed, resets_at (epoch) -> ISO
//      resetTime, model.id -> model, with provider 'anthropic', agent
//      'claude-code', source 'bridge', and the windowType-selected rate-limit
//      window.
//   5. Run the candidate through ObservedLimitSampleGuard.assertSafe — the
//      privacy chokepoint — as the final backstop before the native sample is
//      handed to the cockpit.
//
// This bridge is self-contained: a cut here strands nothing. Codex stays a
// separate native app-server probe (A1) — there is intentionally no Codex bridge.
//
// NO network call, NO https/http import, NO background TUI execution lives here
//. The only input is the injected snapshot object.

import { PrivacyViolationError } from '../core/diagnostics/errors';
import { ObservedLimitSampleGuard } from '../core/native/ObservedLimitSampleGuard';
import type { ObservedLimitSample, WindowType } from '../core/native/ObservedLimitSampleSchema';
import type { IdHasher } from '../security/IdHasher';
import { redactString } from '../security/Redactor';
import {
  type ClaudeStatuslineSnapshot,
  ClaudeStatuslineSnapshotSchema,
  resolveResetIso,
  resolveSnapshotSessionHash,
} from './ClaudeStatuslineSnapshotSchema';

// Version tag recorded on every bridge sample so statusLine contract drift
// (e.g. the v2.1.132 context-token-meaning change) is detectable downstream
//. Bump when the safe-field contract changes.
export const BRIDGE_SOURCE_FINGERPRINT = 'claude-statusline-v1' as const;

export interface ClaudeStatuslineBridgeDeps {
  readonly hasher: IdHasher;
  readonly now: () => Date;
  readonly deriveId: (material: string) => string;
  readonly sourceFingerprint: string;
}

export interface ClaudeStatuslineBridgeOptions {
  // Which rate-limit window the sample observes. 'session' reads five_hour;
  // 'weekly' reads seven_day. Defaults to 'session'.
  readonly windowType?: Extract<WindowType, 'session' | 'weekly'>;
}

function selectWindow(
  snapshot: ClaudeStatuslineSnapshot,
  windowType: 'session' | 'weekly',
): { used_percentage?: number; resets_at?: number; resets_at_iso?: string } | undefined {
  return windowType === 'weekly'
    ? snapshot.rate_limits?.seven_day
    : snapshot.rate_limits?.five_hour;
}

export function snapshotToObservedLimitSample(
  rawSnapshot: unknown,
  deps: ClaudeStatuslineBridgeDeps,
  options: ClaudeStatuslineBridgeOptions = {},
): ObservedLimitSample {
  // Gate 1: strict allowlist. Leaky full payloads fail here by construction.
  const snapshot = ClaudeStatuslineSnapshotSchema.parse(rawSnapshot);

  // Gate 2 (defence-in-depth): the one untrusted free-shape string that the
  // schema admits is model.id. Reject if it carries a forbidden pattern before
  // it can be mapped into the sample.
  if (redactString(snapshot.model.id) !== snapshot.model.id) {
    throw new PrivacyViolationError('forbidden-content:model-id');
  }

  // Use the pre-hashed session_id_hash directly, else hash a raw
  // session_id; the raw value is never persisted. Neither present => no scopeHash.
  const scopeHash = resolveSnapshotSessionHash(snapshot, (raw) => deps.hasher.hashSessionId(raw));

  const windowType: 'session' | 'weekly' = options.windowType ?? 'session';
  const window = selectWindow(snapshot, windowType);

  const timestamp = deps.now().toISOString();
  const resetTime = window !== undefined ? resolveResetIso(window) : undefined;
  const percentConsumed =
    typeof window?.used_percentage === 'number' ? window.used_percentage : undefined;

  const fingerprint = deps.sourceFingerprint;
  const id = deps.deriveId(
    `${timestamp}|bridge|${windowType}|${scopeHash ?? 'no-session'}|${fingerprint}`,
  );

  const candidate: Record<string, unknown> = {
    id,
    timestamp,
    provider: 'anthropic',
    agent: 'claude-code',
    plan: 'custom',
    windowType,
    // The bridge observes percentages, not a raw TokenGauge token count; the
    // structured sample requires the field, so 0 records "not directly observed".
    observedTokenGaugeTokens: 0,
    limitHitFlag: percentConsumed !== undefined ? percentConsumed >= 100 : false,
    source: 'bridge',
    scopeKind: 'claude-session',
    // The version fingerprint rides in the bounded free-text note so drift is
    // detectable on the in-memory sample and is scanned by the guard's Redactor.
    // (TokenGauge persists no usage data; this sample is never written to disk.)
    note: `bridge:${fingerprint}`,
    ...(scopeHash !== undefined ? { scopeHash } : {}),
    ...(snapshot.model.id !== undefined ? { model: snapshot.model.id } : {}),
    ...(percentConsumed !== undefined ? { percentConsumed } : {}),
    ...(resetTime !== undefined ? { resetTime } : {}),
  };

  // Gate 3: the native-sample privacy chokepoint, as the final backstop.
  return new ObservedLimitSampleGuard().assertSafe(candidate);
}
