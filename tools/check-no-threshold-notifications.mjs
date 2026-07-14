// Native-only reset negative guard: no threshold-notification settings or model.
//
// The old threshold-notification model belonged to the removed usage/limit
// reconstruction system and was inert. W6 cut it for v1: TokenGauge focuses on the
// native cockpit and honest provider states. Native-only alerting can be designed
// later. This gate fails closed if the threshold-notification settings, config
// keys, or a threshold-notification service module re-appear.
//
// It does NOT ban ordinary VS Code notifications (showInformationMessage /
// showWarningMessage / showErrorMessage) used for commands and error feedback —
// those are legitimate user-facing messages, not threshold alerts.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const violations = [];

function contributedSettings(pkg) {
  const config = pkg?.contributes?.configuration;
  const blocks = Array.isArray(config) ? config : config ? [config] : [];
  return Object.assign({}, ...blocks.map((block) => block?.properties ?? {}));
}

// 1. Contributed settings must not re-appear.
const FORBIDDEN_SETTINGS = [
  'tokenGauge.thresholds.warningPercents',
  'tokenGauge.notifications.enabled',
  'tokenGauge.notifications.snoozeMinutes',
];
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const props = contributedSettings(pkg);
for (const key of FORBIDDEN_SETTINGS) {
  if (Object.hasOwn(props, key)) {
    violations.push(`threshold-notification setting re-contributed: ${key}`);
  }
}
// Also catch any new tokenGauge.thresholds.* / tokenGauge.notifications.* key.
for (const key of Object.keys(props)) {
  if (/^tokenGauge\.(thresholds|notifications)\./.test(key)) {
    violations.push(`threshold-notification namespace re-contributed: ${key}`);
  }
}

// 2. The canonical key list must not carry them.
const keysFile = resolve('src/config/keys.ts');
if (existsSync(keysFile)) {
  const src = readFileSync(keysFile, 'utf8');
  if (/tokenGauge\.(thresholds|notifications)\./.test(src)) {
    violations.push('threshold-notification key re-appeared in src/config/keys.ts');
  }
}

// 3. A dedicated threshold-notification service module must not exist.
const FORBIDDEN_FILES = ['src/notifications/ThresholdNotificationService.ts', 'src/notifications'];
for (const rel of FORBIDDEN_FILES) {
  if (existsSync(resolve(rel))) {
    violations.push(`removed threshold-notification module re-appeared: ${rel}`);
  }
}

if (violations.length > 0) {
  console.error('no-threshold-notifications guard violations:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(
  'OK: no-threshold-notifications - threshold-notification settings, config keys, ' +
    'and service module are absent (ordinary VS Code notifications are unaffected).',
);
