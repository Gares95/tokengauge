// Native observed-limit sample privacy chokepoint.
//
// ObservedLimitSampleGuard is the single privacy boundary every native
// observed-limit sample must cross before it is handed to the cockpit. It does
// not write a parallel scanner; instead it reuses the SAME centralized Redactor
// rule registry (src/security/Redactor.ts) for its forbidden-content scan, so
// the sentinel/secret patterns live in exactly one place. The sample is native
// statusLine metadata only — it is never persisted and never trains an estimator.
//
// Three gates run, in order, fail-closed on the first failure:
//
//   1. Strict schema validation (ObservedLimitSampleSchema.strict()) — rejects any
//      unknown key by construction and enforces enums + bounded text length.
//   2. Explicit allowlist re-check (OBSERVED_LIMIT_SAMPLE_FIELD_ALLOWLIST) —
//      defends against a future schema widening that re-admits a key.
//   3. Forbidden-content scan over every free-text field via Redactor's rule
//      registry. Any sentinel category (prompt, source, raw path, API key, env
//      var, OAuth, cookie, git remote) triggers rejection (fail-closed) with a
//      sanitized PrivacyViolationError that NEVER echoes the offending content.
//
// The guard returns the validated sample; the free-text fields are also re-run
// through the Redactor so a residual non-sentinel match is neutralized before
// the sample is used. Diagnostics record rule ids + field paths only.

import { redactString } from '../../security/Redactor';
import type { DiagnosticsService } from '../diagnostics/DiagnosticsService';
import { PrivacyViolationError } from '../diagnostics/errors';
import {
  OBSERVED_LIMIT_SAMPLE_FIELD_ALLOWLIST,
  OBSERVED_LIMIT_SAMPLE_FREE_TEXT_FIELDS,
  type ObservedLimitSample,
  ObservedLimitSampleSchema,
} from './ObservedLimitSampleSchema';

export interface ObservedLimitSampleGuardOptions {
  readonly diagnostics?: DiagnosticsService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scanForbidden(value: string): { ruleId: string } | undefined {
  const redacted = redactString(value);
  if (redacted === value) {
    return undefined;
  }
  const match = redacted.match(/\[redacted:([a-z0-9-]+)\]/i);
  return { ruleId: match ? `forbidden-content:${match[1]}` : 'forbidden-content' };
}

export class ObservedLimitSampleGuard {
  private readonly diagnostics?: DiagnosticsService;

  public constructor(options: ObservedLimitSampleGuardOptions = {}) {
    this.diagnostics = options.diagnostics;
  }

  public assertSafe(candidate: unknown): ObservedLimitSample {
    // Gate 1: strict schema — unknown keys, out-of-enum values, and
    // over-length free-text all fail here.
    const parsed = ObservedLimitSampleSchema.safeParse(candidate);
    if (!parsed.success) {
      const offendingKey = this.extractFirstUnknownKey(candidate);
      const ruleId = offendingKey ? `disallowed-field:${offendingKey}` : 'schema-invalid';
      this.recordViolation(ruleId, offendingKey ?? '');
      throw new PrivacyViolationError(ruleId);
    }

    // Gate 2: explicit allowlist defence-in-depth.
    const allowed = new Set<string>(OBSERVED_LIMIT_SAMPLE_FIELD_ALLOWLIST);
    for (const key of Object.keys(parsed.data)) {
      if (!allowed.has(key)) {
        this.recordViolation(`disallowed-field:${key}`, key);
        throw new PrivacyViolationError(`disallowed-field:${key}`);
      }
    }

    // Gate 3: forbidden-content scan over every free-text field. A sentinel /
    // secret pattern anywhere in `note` rejects the write.
    for (const field of OBSERVED_LIMIT_SAMPLE_FREE_TEXT_FIELDS) {
      const value = (parsed.data as Record<string, unknown>)[field];
      if (typeof value !== 'string') {
        continue;
      }
      const hit = scanForbidden(value);
      if (hit) {
        this.recordViolation(hit.ruleId, field);
        throw new PrivacyViolationError(hit.ruleId);
      }
    }

    // Defence-in-depth: re-run the Redactor over the free-text fields so any
    // residual non-sentinel match is neutralized before the sample is used. After
    // the gate-3 scan these are clean, so this is a no-op in the common case.
    const redacted: Record<string, unknown> = { ...parsed.data };
    for (const field of OBSERVED_LIMIT_SAMPLE_FREE_TEXT_FIELDS) {
      const value = redacted[field];
      if (typeof value === 'string') {
        redacted[field] = redactString(value);
      }
    }

    return redacted as ObservedLimitSample;
  }

  private extractFirstUnknownKey(candidate: unknown): string | undefined {
    if (!isRecord(candidate)) {
      return undefined;
    }
    const allowed = new Set<string>(OBSERVED_LIMIT_SAMPLE_FIELD_ALLOWLIST);
    for (const key of Object.keys(candidate)) {
      if (!allowed.has(key)) {
        return key;
      }
    }
    return undefined;
  }

  private recordViolation(ruleId: string, path: string): void {
    this.diagnostics?.record({
      ruleId,
      status: 'rejected',
      severity: 'error',
      path,
    });
  }
}

export function assertSafeObservedLimitSample(candidate: unknown): ObservedLimitSample {
  return new ObservedLimitSampleGuard().assertSafe(candidate);
}
