// Per-build cache-bust token + non-sensitive build id.
//
// ROOT CAUSE this closes: the cockpit referenced its
// webview JS via a STABLE resource uri (asWebviewUri(joinPath(root, 'cockpit.js')))
// with no content hash or version. VS Code's webview caches a resource by path, so
// a fresh VSIX install kept executing the cached OLD bundle. The CSS is
// Vite-content-hashed and busts correctly; the JS was not.
//
// The token is NON-SENSITIVE by construction: extension version + a short content
// hash (sha256, first 12 hex chars) of the bundle bytes. It is NEVER a path,
// account, email, session id, or secret. It changes when the bundle bytes change
// and stays identical when they do not — so VS Code re-fetches on a new build but
// still caches within a build.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as vscode from 'vscode';

// First 12 hex of sha256 over the bundle bytes — collision-irrelevant for a
// cache-bust token, short enough for a uri suffix and a UI marker.
export function bundleContentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

// Read the bundle's bytes and derive the short content hash. On any read failure
// (missing in dev, permission), fall back to undefined so the caller uses the
// version-only token — the page must still render.
function readBundleHash(bundleUri: vscode.Uri): string | undefined {
  try {
    return bundleContentHash(readFileSync(bundleUri.fsPath));
  } catch {
    return undefined;
  }
}

// The per-build cache-bust token appended to the webview script uri as `?v=<token>`.
// Content-derived when the bundle is readable; version-only otherwise. The shape is
// `<version>-<shorthash>` or just `<version>` — both non-sensitive.
export function webviewCacheBustToken(bundleUri: vscode.Uri, extensionVersion: string): string {
  const hash = readBundleHash(bundleUri);
  return hash !== undefined ? `${extensionVersion}-${hash}` : extensionVersion;
}

// The human-readable build id is kept internal for diagnostics/test traceability.
// Same non-sensitive inputs as the cache-bust token, formatted as
// `build <version>+<shorthash>` (or `build <version>` without bytes).
export function webviewBuildId(bundleUri: vscode.Uri, extensionVersion: string): string {
  const hash = readBundleHash(bundleUri);
  return hash !== undefined ? `build ${extensionVersion}+${hash}` : `build ${extensionVersion}`;
}
