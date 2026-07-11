import * as assert from 'node:assert/strict';
import { TOKENGAUGE_KEYS } from '../../src/config/keys';
import {
  manifestConfigurationBlocks,
  manifestConfigurationProperties,
  readManifest,
} from '../_helpers/repoRoot';

function readManifestProperties(): Record<string, { default?: unknown }> {
  const manifest = readManifest();
  const properties = manifestConfigurationProperties(manifest);
  assert.ok(
    Object.keys(properties).length > 0,
    'package.json#contributes.configuration.properties missing',
  );
  return properties;
}

suite('Manifest <-> TOKENGAUGE_KEYS parity (CONF-01)', () => {
  test('Every TOKENGAUGE_KEYS entry exists in package.json', () => {
    const properties = readManifestProperties();
    for (const key of TOKENGAUGE_KEYS) {
      assert.ok(Object.hasOwn(properties, key), `manifest missing key: ${key}`);
    }
  });

  test('Every package.json contributes.configuration key exists in TOKENGAUGE_KEYS', () => {
    const properties = readManifestProperties();
    const keySet = new Set<string>(TOKENGAUGE_KEYS);
    for (const key of Object.keys(properties)) {
      assert.ok(keySet.has(key), `TOKENGAUGE_KEYS missing manifest key: ${key}`);
    }
  });

  test('Every manifest property has a default value declared', () => {
    const properties = readManifestProperties();
    for (const [key, schema] of Object.entries(properties)) {
      assert.notEqual(schema.default, undefined, `manifest key missing default: ${key}`);
    }
  });

  // The two cockpit-wiring settings exist with
  // the exact privacy-relevant defaults (probe OFF, snapshot path empty) and the
  // honest disclosure copy. These are the consent + precedence gates, so their
  // shape is asserted here rather than left to manifest parity alone.
  test('Cockpit settings have correct types, defaults, and disclosure copy', () => {
    const properties = readManifestProperties() as Record<
      string,
      { type?: string; default?: unknown; markdownDescription?: string; description?: string }
    >;

    const probe = properties['tokenGauge.providers.codex.nativeStatusProbe'];
    assert.ok(probe, 'manifest missing tokenGauge.providers.codex.nativeStatusProbe');
    assert.equal(probe.type, 'boolean', 'nativeStatusProbe must be boolean');
    assert.equal(probe.default, false, 'nativeStatusProbe must default false (consent off)');
    const probeCopy = `${probe.markdownDescription ?? ''}${probe.description ?? ''}`;
    assert.ok(
      probeCopy.includes('backend'),
      'nativeStatusProbe description must disclose the authenticated backend call',
    );

    const snapPath = properties['tokenGauge.claude.statuslineSnapshotPath'];
    assert.ok(snapPath, 'manifest missing tokenGauge.claude.statuslineSnapshotPath');
    assert.equal(snapPath.type, 'string', 'statuslineSnapshotPath must be string');
    assert.equal(snapPath.default, '', 'statuslineSnapshotPath must default to empty string');
    const snapPathCopy = `${snapPath.markdownDescription ?? ''}${snapPath.description ?? ''}`;
    assert.match(
      snapPathCopy,
      /snapshot output/i,
      'statuslineSnapshotPath copy must name the snapshot output',
    );
    assert.match(
      snapPathCopy,
      /not the writer file/i,
      'statuslineSnapshotPath copy must not let users point TokenGauge at the writer script',
    );
    assert.match(
      snapPathCopy,
      /Remote or Workspace settings/i,
      'statuslineSnapshotPath copy must mention remote/workspace settings scope',
    );
    assert.match(
      snapPathCopy,
      /local User settings may not affect/i,
      'statuslineSnapshotPath copy must warn that local User settings may not affect remote windows',
    );
  });

  test('Provider card visibility settings are display-only and default visible', () => {
    const properties = readManifestProperties() as Record<
      string,
      { type?: string; default?: unknown; markdownDescription?: string; description?: string }
    >;

    const claudeVisible = properties['tokenGauge.display.cards.claude.visible'];
    assert.ok(claudeVisible, 'manifest missing tokenGauge.display.cards.claude.visible');
    assert.equal(claudeVisible.type, 'boolean', 'Claude card visibility must be boolean');
    assert.equal(claudeVisible.default, true, 'Claude card must default visible');
    const claudeCopy = `${claudeVisible.markdownDescription ?? ''}${claudeVisible.description ?? ''}`;
    assert.match(claudeCopy, /Display/i, 'Claude visibility copy must be display-only');
    assert.match(
      claudeCopy,
      /visible|visibility|hidden/i,
      'Claude copy must use visibility language',
    );

    const codexVisible = properties['tokenGauge.display.cards.codex.visible'];
    assert.ok(codexVisible, 'manifest missing tokenGauge.display.cards.codex.visible');
    assert.equal(codexVisible.type, 'boolean', 'Codex card visibility must be boolean');
    assert.equal(codexVisible.default, true, 'Codex card must default visible');
    const codexCopy = `${codexVisible.markdownDescription ?? ''}${codexVisible.description ?? ''}`;
    assert.match(codexCopy, /Display/i, 'Codex visibility copy must be display-only');
    assert.match(
      codexCopy,
      /visible|visibility|hidden/i,
      'Codex copy must use visibility language',
    );
    assert.match(
      codexCopy,
      /tokenGauge\.providers\.codex\.nativeStatusProbe/,
      'Codex visibility copy must keep the native probe setting separate',
    );
  });

  test('Settings are grouped into provider and display configuration sections', () => {
    const blocks = manifestConfigurationBlocks(readManifest());
    const byTitle = new Map(blocks.map((block) => [block.title, block]));

    const claude = byTitle.get('TokenGauge › Claude');
    assert.ok(claude, 'Claude settings section missing');
    assert.deepEqual(Object.keys(claude.properties ?? {}), [
      'tokenGauge.claude.statuslineSnapshotPath',
      'tokenGauge.display.cards.claude.visible',
    ]);
    assert.equal(
      claude.properties?.['tokenGauge.display.cards.claude.visible']?.title,
      'Card Visible',
    );

    const codex = byTitle.get('TokenGauge › Codex');
    assert.ok(codex, 'Codex settings section missing');
    assert.deepEqual(Object.keys(codex.properties ?? {}), [
      'tokenGauge.providers.codex.nativeStatusProbe',
      'tokenGauge.display.cards.codex.visible',
    ]);
    assert.equal(
      codex.properties?.['tokenGauge.display.cards.codex.visible']?.title,
      'Card Visible',
    );

    assert.ok(byTitle.get('TokenGauge › Display'), 'Display settings section missing');
    assert.ok(byTitle.get('TokenGauge › Advanced / Polling'), 'Polling settings section missing');
  });
});
