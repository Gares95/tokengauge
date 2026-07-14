// Shared regex and sentinel patterns for VSIX and fast privacy scans.
// SELF-SKIP: tokengauge-audit-patterns

export const SELF_SKIP_MARKER = '// SELF-SKIP: tokengauge-audit-patterns';

const tokenGaugePrefix = '__TOKEN' + 'GAUGE_';
const sentinelPrefix = 'SEN' + 'TINEL_';
const sentinelRoot = `${tokenGaugePrefix}${sentinelPrefix}`;

const sentinelPrompt = `${sentinelRoot}PROMPT__`;
const sentinelSource = `${sentinelRoot}SOURCE__`;
const sentinelApiKey = `${sentinelRoot}APIKEY__`;
const sentinelPath = `${sentinelRoot}PATH__`;
const sentinelEnvVar = `${sentinelRoot}ENVVAR__`;
const sentinelOAuth = `${sentinelRoot}OAUTH__`;
const sentinelCookie = `${sentinelRoot}COOKIE__`;
const sentinelGitRemote = `${sentinelRoot}GITREMOTE__`;

export const SENTINEL_NAMES = Object.freeze([
  sentinelPrompt,
  sentinelSource,
  sentinelApiKey,
  sentinelPath,
  sentinelEnvVar,
  sentinelOAuth,
  sentinelCookie,
  sentinelGitRemote,
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const PROMPT_SHAPE_PATTERN = Object.freeze({
  name: 'prompt-shape',
  re: /"role"\s*:\s*"(system|user|assistant)"/i,
  skipExts: ['.ts', '.js', '.mjs', '.cjs', '.md'],
});

// The pricing-bundle presence/forbidden-fixture exports were removed.
// TokenGauge is native-only — there is no cost engine and no bundled pricing
// data, so the old "pricing data must be bundled" assertion no longer applies.
// Native provider-reported cost (statusLine `total_cost_usd`, stats-cache
// `costUSD`) is read directly and needs no bundled price table.

export const FORBIDDEN_CONTENT_PATTERNS = Object.freeze([
  {
    name: 'openai-api-key',
    re: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'anthropic-api-key',
    re: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'slack-bot-token',
    re: /xoxb-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'github-pat',
    re: /ghp_[A-Za-z0-9_]{20,}/,
  },
  {
    name: 'google-api-key',
    re: /AIza[A-Za-z0-9_-]{35}/,
  },
  {
    name: 'oauth-bearer',
    re: /ya29\.[A-Za-z0-9_-]{40,}/,
  },
  {
    name: 'authorization-bearer-literal',
    re: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    name: 'private-key-pem',
    re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  {
    name: 'envvar-credential-assignment',
    re: /process\.env\.[A-Z_]+\s*=\s*['"][^'"]{20,}['"]/,
  },
  {
    name: 'sentinel-prompt',
    re: new RegExp(escapeRegExp(sentinelPrompt)),
  },
  {
    name: 'sentinel-source',
    re: new RegExp(escapeRegExp(sentinelSource)),
  },
  {
    name: 'sentinel-apikey',
    re: new RegExp(escapeRegExp(sentinelApiKey)),
  },
  {
    name: 'sentinel-path',
    re: new RegExp(escapeRegExp(sentinelPath)),
  },
  {
    name: 'sentinel-envvar',
    re: new RegExp(escapeRegExp(sentinelEnvVar)),
  },
  {
    name: 'sentinel-oauth',
    re: new RegExp(escapeRegExp(sentinelOAuth)),
  },
  {
    name: 'sentinel-cookie',
    re: new RegExp(escapeRegExp(sentinelCookie)),
  },
  {
    name: 'sentinel-gitremote',
    re: new RegExp(escapeRegExp(sentinelGitRemote)),
  },
  PROMPT_SHAPE_PATTERN,
]);
