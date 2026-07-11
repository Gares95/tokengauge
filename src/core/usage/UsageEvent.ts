// Shared usage-domain enums for the native cockpit.
//
// Native-only: the persisted UsageEvent schema, its zod
// validators, and PERSISTED_FIELD_ALLOWLIST were removed together with the
// log-derived usage store. What remains are the shared provider / agent /
// accuracy / token-bucket enums that the native cockpit, cockpit message
// schema, and source/accuracy taxonomy still import. The native-only taxonomy
// carries no `log_derived` label (removed in the native-only reset).

export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'azure-openai',
  'local',
  'litellm',
  'openrouter',
  'unknown',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const AGENT_IDS = [
  'claude-code',
  'codex',
  'copilot',
  'cursor',
  'cline',
  'roo',
  'aider',
  'continue',
  'opencode',
  'gemini-cli',
  'other',
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

// Token bucket literals. Anthropic distinguishes 5-minute and 1-hour
// cache writes; OpenAI exposes only cache_read; `reasoning` covers o-series /
// Claude reasoning tokens. Retained for native token-detail typing.
export const TOKEN_BUCKETS = [
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
  'reasoning',
] as const;
export type TokenBucket = (typeof TOKEN_BUCKETS)[number];

export const ACCURACY_LABELS = [
  'exact',
  'billing_authoritative',
  'proxy_reported',
  'partial',
  'unknown',
] as const;
export type AccuracyLabel = (typeof ACCURACY_LABELS)[number];
