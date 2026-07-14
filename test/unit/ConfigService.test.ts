import * as assert from 'node:assert/strict';
import { TOKENGAUGE_KEYS } from '../../src/config/keys';

suite('ConfigService snapshot (CONF-01)', () => {
  test('TOKENGAUGE_KEYS is non-empty and every entry starts with tokenGauge.', () => {
    // R3-copy reduced the surface to 4 keys (privacyMode + showAccuracyLabels were
    // inert and removed). Assert the floor matches the current native-only surface.
    assert.ok(TOKENGAUGE_KEYS.length >= 4);
    for (const key of TOKENGAUGE_KEYS) {
      assert.ok(key.startsWith('tokenGauge.'), `expected tokenGauge.* key, got ${key}`);
    }
  });

  test('TOKENGAUGE_KEYS has no duplicates', () => {
    assert.equal(new Set(TOKENGAUGE_KEYS).size, TOKENGAUGE_KEYS.length);
  });
});
