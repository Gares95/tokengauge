// Native-only reset negative guard: the old log-derived usage model must not return.
//
// TokenGauge is native-only and persists no usage events. W3 removed the JSONL
// usage store, the normalizer, the aggregator, the cost engine + bundled
// pricing, the tokenizer registry, the PrivacyGuard append chokepoint, and the
// persisted UsageEvent schema. This gate fails closed if any of them re-appear.
//
// It intentionally does NOT ban the word "usage" in product copy, nor the kept
// shared enums in src/core/usage/UsageEvent.ts, nor the deferred estimator /
// LimitEngine (D1) or the deferred SourceTier/Accuracy taxonomy (W4).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const violations = [];

// 1. Removed modules/directories must not exist.
const FORBIDDEN_PATHS = [
  'src/storage',
  'src/storage/UsageStore.ts',
  'src/storage/JsonlFile.ts',
  'src/storage/fsRetry.ts',
  'src/core/usage/Normalizer.ts',
  'src/core/accuracy/Aggregator.ts',
  'src/core/cost',
  'src/core/cost/CostEngine.ts',
  'src/core/cost/ModelRegistry.ts',
  'src/core/cost/PriceCatalog.ts',
  'src/core/tokenizers',
  'src/core/tokenizers/TokenizerRegistry.ts',
  'src/security/PrivacyGuard.ts',
];

for (const rel of FORBIDDEN_PATHS) {
  if (existsSync(resolve(rel))) {
    violations.push(`removed usage-model path re-appeared: ${rel}`);
  }
}

// 2. The persisted UsageEvent schema/allowlist must not return.
const usageEvent = resolve('src/core/usage/UsageEvent.ts');
if (existsSync(usageEvent)) {
  const src = readFileSync(usageEvent, 'utf8');
  for (const token of ['UsageEventSchema', 'PERSISTED_FIELD_ALLOWLIST', 'USAGE_SOURCE_KINDS']) {
    // Match an actual export declaration, not a mention in a comment.
    if (new RegExp(`export\\s+(const|type)\\s+${token}\\b`).test(src)) {
      violations.push(`persisted usage schema export re-appeared in UsageEvent.ts: ${token}`);
    }
  }
}

if (violations.length > 0) {
  console.error('no-old-usage-model guard violations:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(
  'OK: no-old-usage-model - removed storage/cost/tokenizer/aggregation/normalizer/' +
    'PrivacyGuard modules and the persisted UsageEvent schema are absent.',
);
