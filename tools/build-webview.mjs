#!/usr/bin/env node
// Build the cockpit webview as a SELF-CONTAINED single-input bundle so
// the extension host can load it as a classic <script> under the strict nonce
// CSP. A single-input build inlines all static imports, so NO shared
// hooks.module-* chunk is emitted and cockpit.js never begins with `import`.
//
// This is a cross-platform replacement for inline `WEBVIEW_ENTRY=... vite build`
// (which would not work on Windows cmd) and adds no new dependency.

import { spawnSync } from 'node:child_process';

const PASSES = [{ WEBVIEW_ENTRY: 'cockpit', WEBVIEW_EMPTY_OUT: 'true' }];

const viteArgs = ['vite', 'build', '--config', 'vite.webview.config.ts', ...process.argv.slice(2)];

for (const passEnv of PASSES) {
  const result = spawnSync('npx', viteArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...passEnv },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
