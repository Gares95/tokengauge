// Fragmented fake forbidden-value sentinels for privacy invariant tests
//. Every sentinel is assembled at runtime from short fragments
// so this source file does not contain any contiguous forbidden literal
// that would trip tools/check-privacy-fast.mjs or audit-vsix scans.
//
// Use PRIVACY_SENTINELS in unit/integration/privacy tests to seed
// PrivacyGuard, Redactor, UsageStore, and diagnostics with values that
// the data policy forbids from ever being persisted or logged. Real
// secrets MUST NOT be added to this file.

const tg = '__TOKEN' + 'GAUGE_';
const sen = 'SEN' + 'TINEL_';
const root = `${tg}${sen}`;

// Fake chat-shaped prompt. Keys are split to avoid the prompt-shape regex
// in tools/audit-vsix-patterns.mjs (which targets `"role": "..."` JSON).
const promptPayload = `{${'"ro' + 'le"'}:${'"us' + 'er"'},"content":"hello"}`;
const fakePrompt = `${root}PR${'OMPT'}__${promptPayload}`;

// Fake source-code snippet that should never be persisted.
const fakeSource = `${root}SO${'URCE'}__function leak(){return 1;}`;

// Fake POSIX and Windows raw paths.
const fakePosixPath = `/Users/test/${root}PA${'TH'}__/project/src/index.ts`;
const fakeWindowsPath = `C:\\Users\\test\\${root}PA${'TH'}__\\project\\src\\index.ts`;

// Fake OpenAI-style API key. The literal prefix `sk-` is split so static
// scans for `sk-[A-Za-z0-9_-]{20,}` do not match this source file itself.
const fakeApiKey = `${'sk' + '-'}${root}AP${'IKEY'}__abcdefghijklmnopqrstuvwxyz`;

// Fake env-var credential assignment shape.
const fakeEnvVar = `${'TOKENGAUGE'}_${root}EN${'VVAR'}__=value-with-secret-shape`;

// Fake OAuth bearer token. Prefix `ya29.` is split.
const fakeOAuthBearer = `${'ya29' + '.'}${root}OA${'UTH'}__zyxwvutsrqponmlkjihgfedcbaABCDEFGHIJ`;

// Fake HTTP cookie header value.
const fakeCookie = `session=${root}CO${'OKIE'}__deadbeefcafebabe; Path=/; HttpOnly`;

// Fake git remote URL. Should never be persisted per data policy.
const fakeGitRemote = `git@github.com:${root}GIT${'REMOTE'}__/example.git`;

export const PRIVACY_SENTINELS = Object.freeze({
  fakePrompt,
  fakeSource,
  fakePosixPath,
  fakeWindowsPath,
  fakeApiKey,
  fakeEnvVar,
  fakeOAuthBearer,
  fakeCookie,
  fakeGitRemote,
});

export type PrivacySentinelKind = keyof typeof PRIVACY_SENTINELS;
