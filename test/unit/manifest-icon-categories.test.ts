import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findRepoRoot } from '../_helpers/repoRoot';

// The extension's visual identity + Marketplace metadata. INVARIANT:
// the `icon` field must point at a real packaged file, the asset must be
// allowlisted by BOTH the .vscodeignore packaging filter and the VSIX content
// audit (recall the historical fixture-exclusion bug — an allowlisted manifest
// path is useless if .vscodeignore strips the file), and `categories` must be
// accurate (not the scaffold default of just ["Other"]). Metadata only — no
// publish step is implied or permitted by this plan.
//

interface IconManifest {
  icon?: string;
  categories?: string[];
}

function readRawManifest(): IconManifest {
  const root = findRepoRoot();
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as IconManifest;
}

suite('Icon — extension icon', () => {
  test('Package.json declares an "icon" field', () => {
    const manifest = readRawManifest();
    assert.ok(typeof manifest.icon === 'string' && manifest.icon.length > 0, 'icon field missing');
  });

  test('The icon path resolves to an existing file in the repo', () => {
    const manifest = readRawManifest();
    const root = findRepoRoot();
    const iconPath = path.join(root, manifest.icon as string);
    assert.ok(fs.existsSync(iconPath), `icon file does not exist: ${manifest.icon}`);
  });

  test('The icon is a non-trivial PNG (valid signature, >=128px square header)', () => {
    const manifest = readRawManifest();
    const root = findRepoRoot();
    const buf = fs.readFileSync(path.join(root, manifest.icon as string));
    // PNG signature.
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < sig.length; i += 1) {
      assert.equal(buf[i], sig[i], 'icon is not a valid PNG');
    }
    // IHDR width/height are big-endian uint32 at offsets 16 and 20.
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.ok(width >= 128, `icon width too small: ${width}`);
    assert.equal(width, height, `icon must be square: ${width}x${height}`);
  });

  test('The icon is allowlisted in .vscodeignore so it actually packs', () => {
    const manifest = readRawManifest();
    const root = findRepoRoot();
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
    assert.ok(
      ignore.includes(`!${manifest.icon}`),
      `.vscodeignore must re-include the icon (!${manifest.icon}) or the VSIX strips it`,
    );
  });

  test('The icon path is allowlisted in the VSIX content audit (no unexpected-entry)', () => {
    const manifest = readRawManifest();
    const root = findRepoRoot();
    const audit = fs.readFileSync(path.join(root, 'tools/audit-vsix.mjs'), 'utf8');
    assert.ok(
      audit.includes(`extension/${manifest.icon}`),
      'audit-vsix.mjs ALLOWED_TOP_LEVEL must list the icon path',
    );
  });
});

suite('Icon — Marketplace categories', () => {
  test('Categories is a non-empty array of strings', () => {
    const manifest = readRawManifest();
    assert.ok(Array.isArray(manifest.categories), 'categories must be an array');
    assert.ok((manifest.categories as string[]).length > 0, 'categories must be non-empty');
    for (const c of manifest.categories as string[]) {
      assert.ok(typeof c === 'string' && c.length > 0, 'each category must be a non-empty string');
    }
  });

  test('Categories went beyond the scaffold default of only ["Other"]', () => {
    const manifest = readRawManifest();
    const cats = manifest.categories as string[];
    assert.ok(
      !(cats.length === 1 && cats[0] === 'Other'),
      'categories must be more specific than the scaffold default ["Other"]',
    );
    // The cockpit is a visualization surface.
    assert.ok(cats.includes('Visualization'), 'categories should include Visualization');
  });
});
