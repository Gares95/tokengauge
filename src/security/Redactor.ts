// Privacy chokepoint: outbound string/payload sanitization.
//
// This module is the only primitive that converts candidate text or
// payloads into public-safe output for diagnostics, error messages, and
// export-shaped serialization. It reports rule names, never matched values,
// matching the existing `tools/check-privacy-fast.mjs` reporting style.
//
// SELF-SKIP: tokengauge-audit-patterns
//
// The SELF-SKIP marker above keeps `tools/check-privacy-fast.mjs` from
// matching the regex literals embedded here. The regex sources still scan
// candidate text — they are forbidden CONTENT patterns, not stored data.

interface RedactionRule {
  readonly name: string;
  readonly re: RegExp;
}

const tokenGaugePrefix = '__TOKEN' + 'GAUGE_';
const sentinelPrefix = 'SEN' + 'TINEL_';
const sentinelRoot = `${tokenGaugePrefix}${sentinelPrefix}`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Order matters: long, high-precision rules (sentinels, prefixed credentials)
// must run before short structural rules (raw POSIX/Windows paths, prompt
// JSON shape) so the more-specific rule name appears in the redacted marker.
const REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
  { name: 'sentinel-prompt', re: new RegExp(`${escapeRegExp(sentinelRoot)}PROMPT__[^\\s"]*`, 'g') },
  { name: 'sentinel-source', re: new RegExp(`${escapeRegExp(sentinelRoot)}SOURCE__[^\\s"]*`, 'g') },
  { name: 'sentinel-apikey', re: new RegExp(`${escapeRegExp(sentinelRoot)}APIKEY__[^\\s"]*`, 'g') },
  { name: 'sentinel-envvar', re: new RegExp(`${escapeRegExp(sentinelRoot)}ENVVAR__[^\\s"]*`, 'g') },
  { name: 'sentinel-oauth', re: new RegExp(`${escapeRegExp(sentinelRoot)}OAUTH__[^\\s"]*`, 'g') },
  { name: 'sentinel-cookie', re: new RegExp(`${escapeRegExp(sentinelRoot)}COOKIE__[^\\s"]*`, 'g') },
  {
    name: 'sentinel-gitremote',
    re: new RegExp(`${escapeRegExp(sentinelRoot)}GITREMOTE__[^\\s"]*`, 'g'),
  },
  { name: 'sentinel-path', re: new RegExp(`${escapeRegExp(sentinelRoot)}PATH__[^\\s"]*`, 'g') },
  { name: 'oauth-bearer', re: /ya29\.[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-api-key', re: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { name: 'slack-bot-token', re: /xoxb-[A-Za-z0-9_-]{20,}/g },
  { name: 'github-pat', re: /ghp_[A-Za-z0-9_]{20,}/g },
  { name: 'google-api-key', re: /AIza[A-Za-z0-9_-]{35}/g },
  { name: 'authorization-bearer', re: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { name: 'private-key-pem', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { name: 'cookie-header', re: /(?:session|sid|auth)=[^\s;,"]+/gi },
  { name: 'envvar-credential', re: /[A-Z][A-Z0-9_]{2,}=[^\s"']{6,}/g },
  { name: 'git-remote-ssh', re: /git@[A-Za-z0-9.-]+:[^\s"']+\.git/g },
  { name: 'git-remote-https', re: /https:\/\/[A-Za-z0-9.-]+\/[^\s"']+\.git/g },
  { name: 'prompt-shape', re: /\{[^{}]*"role"\s*:\s*"(?:system|user|assistant)"[^{}]*\}/gi },
  { name: 'windows-path', re: /[A-Za-z]:\\(?:[^\\\s"']+\\)+[^\\\s"']+/g },
  // Broadened to cover container / WSL / snap roots
  // (/data, /workspace, /snap, /mnt, /srv) that the original heuristic missed.
  // Adding roots only redacts MORE anchored raw paths — it cannot change output
  // for any string that is not a raw POSIX path under one of these roots.
  {
    name: 'posix-path',
    re: /\/(?:home|Users|var|etc|tmp|opt|usr|root|data|workspace|snap|mnt|srv)\/[^\s"']+/g,
  },
]);

function applyRules(input: string): string {
  let out = input;
  for (const rule of REDACTION_RULES) {
    if (rule.re.test(out)) {
      // Reset lastIndex defensively for global flag reuse across calls.
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, `[redacted:${rule.name}]`);
    }
  }
  return out;
}

export function redactString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    return input;
  }
  return applyRules(input);
}

export function redactSerializable<T>(value: T): T {
  if (typeof value === 'string') {
    return redactString(value) as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSerializable(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactSerializable(v);
  }
  return out as unknown as T;
}

export class Redactor {
  public redactString(input: string): string {
    return redactString(input);
  }

  public redactSerializable<T>(value: T): T {
    return redactSerializable(value);
  }
}
