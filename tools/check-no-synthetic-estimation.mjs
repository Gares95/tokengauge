// Native-only reset negative guard: TokenGauge must not synthesize usage/limit data.
//
// TokenGauge is native-only — it shows native/provider-visible values or honest
// unknown/unavailable states. W5 removed the observed-limit estimator engine and
// the `estimated` source tier / accuracy label; W10 moved the KEPT native
// observed-limit sample parsing out of the estimator namespace to
// `src/core/native`. This gate fails closed if the estimator engine or the
// `src/core/estimator` directory returns, or if the `estimated` taxonomy value
// re-appears in the taxonomy source.
//
// It does NOT ban the words "estimate"/"estimated" in docs/comments (e.g. honest
// caveats about provider-reported approximations), nor the native observed-limit
// SAMPLE parsing under `src/core/native` (it feeds the statusLine bridge and
// synthesizes nothing).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const violations = [];

// 1. The synthetic estimator engine — and the whole estimator namespace — must
//    not exist. The native observed-limit sample parsing lives in src/core/native.
const FORBIDDEN_FILES = [
  'src/core/estimator',
  'src/core/estimator/ObservedLimitEstimator.ts',
  'src/core/estimator/ConfidenceModel.ts',
  'src/core/estimator/LimitWeighting.ts',
  'src/core/estimator/EstimatorLimitInput.ts',
  'src/core/estimator/PlanStructure.ts',
  'src/core/limits',
  'src/core/limits/LimitEngine.ts',
];

for (const rel of FORBIDDEN_FILES) {
  if (existsSync(resolve(rel))) {
    violations.push(`removed estimator/limit-engine path re-appeared: ${rel}`);
  }
}

// 2. The `estimated` taxonomy value must not re-appear in taxonomy sources.
//    NativeUsageTaxonomy.ts is the live file. UsageEvent.ts and Accuracy.ts are
//    same-path canaries: B02/B03 deleted or renamed them, so a reintroduced file
//    carrying `estimated` must fail closed even before the broader G02 gate
//    generalizes stale-concept detection.
const TAXONOMY_FILES = [
  'src/core/sources/SourceTier.ts',
  'src/core/usage/NativeUsageTaxonomy.ts',
  'src/core/usage/UsageEvent.ts',
  'src/core/accuracy/Accuracy.ts',
];
for (const rel of TAXONOMY_FILES) {
  const p = resolve(rel);
  if (existsSync(p) && /['"]estimated['"]/.test(readFileSync(p, 'utf8'))) {
    violations.push(`'estimated' taxonomy value re-appeared in ${rel}`);
  }
}

if (violations.length > 0) {
  console.error('no-synthetic-estimation guard violations:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(
  'OK: no-synthetic-estimation - the observed-limit estimator engine and the ' +
    '`estimated` source tier / accuracy label are absent.',
);
