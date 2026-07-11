// Typed sanitized public errors for failure paths.
//
// Every TokenGaugeError sanitizes its public `message` through the Redactor,
// carries a stable machine-readable `code`, and does NOT store raw invalid
// values on public enumerable properties. Tests and diagnostics can match on
// `code`/`name` without exposing forbidden content.

import { redactString } from '../../security/Redactor';

// Native-only — the normalization / token-bucket / model-cost / JSONL
// error codes belonged to the removed adapter, cost-engine, and usage-store
// paths and are gone. `PrivacyViolationError` is the only live boundary error.
export type TokenGaugeErrorCode = 'TG_PRIVACY_VIOLATION';

export class TokenGaugeError extends Error {
  public readonly code: TokenGaugeErrorCode;

  protected constructor(code: TokenGaugeErrorCode, name: string, publicMessage: string) {
    super(redactString(publicMessage));
    // `name` is enumerable by default on the prototype only; setting on the
    // instance is fine because it is itself a stable, public-safe string.
    this.name = name;
    this.code = code;
    // Hide `code` from enumeration to keep `JSON.stringify(err)` minimal.
    Object.defineProperty(this, 'code', { value: code, enumerable: false, writable: false });
  }
}

export class PrivacyViolationError extends TokenGaugeError {
  public constructor(reason: string, _internalDetails?: Readonly<Record<string, unknown>>) {
    super('TG_PRIVACY_VIOLATION', 'PrivacyViolationError', `privacy violation: ${reason}`);
    // _internalDetails is intentionally NOT stored on `this`: public
    // enumerable properties must not carry raw invalid values.
    void _internalDetails;
  }
}

// The closed set of codes an activation/rebuild failure may report.
// `unknown-with-error-name` preserves only `error.name` (never the message,
// path, or stack); a non-Error value collapses to `unknown`.
export type ActivationFailureCode = 'unknown-with-error-name' | 'unknown';

// Derive a privacy-safe code from a thrown activation error for the `.catch`
// diagnostics. Reads only `error.name`; the raw message/stack/path is never
// read for content and never surfaced.
export function classifyActivationFailure(error: unknown): ActivationFailureCode {
  if (error instanceof Error) {
    return 'unknown-with-error-name';
  }
  return 'unknown';
}
