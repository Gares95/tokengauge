import * as assert from 'node:assert/strict';
import { manifestConfigurationProperties, readManifest } from '../_helpers/repoRoot';

suite('No secret-shaped key names', () => {
  test('No contributes.configuration property name contains credential-shaped terms', () => {
    const manifest = readManifest();
    const properties = manifestConfigurationProperties(manifest);
    const offenders = Object.keys(properties).filter((key) => {
      const settingName = key.replace(/^tokenGauge\./, '');
      return /(apiKey|token|password|secret)/i.test(settingName);
    });

    assert.deepEqual(
      offenders,
      [],
      `Secrets MUST go through SecretManager, not VS Code settings. Offenders: ${offenders.join(', ')}`,
    );
  });
});
