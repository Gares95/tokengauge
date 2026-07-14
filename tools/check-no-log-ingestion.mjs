// Native-only reset negative guard: the log-derived ingestion surface must not return.
//
// TokenGauge is native-only (Claude statusLine/stats-cache + Codex app-server
// probe). The log-derived token-consumption pipeline was removed in the native-only reset. This
// gate fails closed if any removed module re-appears, or if the removed
// log-adapter enable settings are re-contributed.
//
// It intentionally does NOT ban the modules/settings covered by the other
// removal guards (LogIngestionPolicy, UsageStore/storage, cost, estimator, SourceTier,
// the logIngestionMode/allowBroadLogRoots/logPath settings) — those have their
// own removal waves and guards.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const violations = [];

function contributedSettings(pkg) {
  const config = pkg?.contributes?.configuration;
  const blocks = Array.isArray(config) ? config : config ? [config] : [];
  return Object.assign({}, ...blocks.map((block) => block?.properties ?? {}));
}

// 1. Removed source modules must not exist.
const FORBIDDEN_FILES = [
  'src/adapters/claudeCode/ClaudeCodeParser.ts',
  'src/adapters/claudeCode/ClaudeCodeFingerprint.ts',
  'src/adapters/claudeCode/ClaudeCodeAdapter.ts',
  'src/adapters/codex/CodexParser.ts',
  'src/adapters/codex/CodexFingerprint.ts',
  'src/adapters/codex/CodexAdapter.ts',
  'src/adapters/AdapterRegistry.ts',
  'src/adapters/AdapterSupervisor.ts',
  'src/adapters/UsageAdapter.ts',
  'src/ui/UsageSnapshotService.ts',
  'src/ui/UsageSnapshotTypes.ts',
  'src/ui/AccuracyEducationState.ts',
  'src/notifications/ThresholdNotificationService.ts',
  // The log-ingestion consent policy was removed (native-only).
  'src/core/cockpit/LogIngestionPolicy.ts',
];

for (const rel of FORBIDDEN_FILES) {
  if (existsSync(resolve(rel))) {
    violations.push(`removed log-ingestion module re-appeared: ${rel}`);
  }
}

// 2. The removed log-adapter enable settings must not be re-contributed.
const FORBIDDEN_SETTINGS = [
  'tokenGauge.providers.claudeCode.enabled',
  'tokenGauge.providers.codex.enabled',
  // Native-only — no log-ingestion mode/consent/path settings.
  'tokenGauge.logIngestionMode',
  'tokenGauge.allowBroadLogRoots',
  'tokenGauge.providers.claudeCode.logPath',
  'tokenGauge.providers.codex.logPath',
];

const pkg = readFileSync(resolve('package.json'), 'utf8');
const props = contributedSettings(JSON.parse(pkg));
for (const key of FORBIDDEN_SETTINGS) {
  if (Object.hasOwn(props, key)) {
    violations.push(`removed log-ingestion setting re-contributed: ${key}`);
  }
}

// The source taxonomy must not carry the log_derived tier.
const sourceTier = resolve('src/core/sources/SourceTier.ts');
if (existsSync(sourceTier)) {
  const src = readFileSync(sourceTier, 'utf8');
  if (/['"]log_derived['"]/.test(src)) {
    violations.push('log_derived source tier re-appeared in SourceTier.ts');
  }
}

if (violations.length > 0) {
  console.error('no-log-ingestion guard violations:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(
  'OK: no-log-ingestion - removed log parsers/adapters/supervisor/usage-snapshot/' +
    'notification modules and log-adapter enable settings are absent.',
);
