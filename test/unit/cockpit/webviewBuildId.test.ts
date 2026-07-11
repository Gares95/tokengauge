// The per-build cache-bust token + non-sensitive build id are
// content-derived (change with bundle bytes, stable when identical) and carry NO
// path/secret — only the extension version and a short content hash.

import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  bundleContentHash,
  webviewBuildId,
  webviewCacheBustToken,
} from '../../../src/cockpit/webviewBuildId';

function tempBundle(bytes: string): { uri: vscode.Uri; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tg-buildid-'));
  const path = join(dir, 'cockpit.js');
  writeFileSync(path, bytes);
  return { uri: vscode.Uri.file(path), dir };
}

suite('WebviewBuildId / cache-bust token', () => {
  test('Content hash changes when bundle bytes change, stable when identical', () => {
    assert.equal(bundleContentHash(Buffer.from('a')), bundleContentHash(Buffer.from('a')));
    assert.notEqual(bundleContentHash(Buffer.from('a')), bundleContentHash(Buffer.from('b')));
  });

  test('Cache-bust token is content-derived: different bytes → different token', () => {
    const a = tempBundle('globalThis.__cockpit = 1;');
    const b = tempBundle('globalThis.__cockpit = 2; // new copy');
    try {
      const tokenA = webviewCacheBustToken(a.uri, '0.0.1');
      const tokenB = webviewCacheBustToken(b.uri, '0.0.1');
      assert.notEqual(tokenA, tokenB, 'a changed bundle must yield a changed token');
      // Identical bytes yield identical tokens (so caching still works in a build).
      assert.equal(webviewCacheBustToken(a.uri, '0.0.1'), tokenA);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  test('Token embeds the version and is non-sensitive (no path/secret)', () => {
    const a = tempBundle('x');
    try {
      const token = webviewCacheBustToken(a.uri, '1.2.3');
      assert.ok(token.startsWith('1.2.3'), 'token leads with the version');
      assert.ok(!token.includes('/'), 'token carries no path');
      assert.ok(!token.includes(a.dir), 'token carries no fs path fragment');
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  test('Falls back to version-only token when the bundle is unreadable', () => {
    const missing = vscode.Uri.file(join(tmpdir(), 'does-not-exist-tg', 'cockpit.js'));
    assert.equal(webviewCacheBustToken(missing, '9.9.9'), '9.9.9');
    assert.equal(webviewBuildId(missing, '9.9.9'), 'build 9.9.9');
  });

  test('Build id reads "build <version>+<shorthash>" and carries no path/secret', () => {
    const a = tempBundle('cockpit bytes');
    try {
      const id = webviewBuildId(a.uri, '0.0.1');
      assert.match(id, /^build 0\.0\.1\+[0-9a-f]{12}$/, 'build id shape');
      assert.ok(!id.includes('/'), 'no path in build id');
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });
});
