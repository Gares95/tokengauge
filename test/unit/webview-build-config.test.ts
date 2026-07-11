import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../_helpers/repoRoot';

function readProjectFile(path: string): string {
  return readFileSync(join(findRepoRoot(), path), 'utf8');
}

suite('Webview build config', () => {
  test('Package scripts route extension and webview builds separately', () => {
    const manifest = JSON.parse(readProjectFile('package.json'));

    assert.equal(manifest.scripts['build:webview'], 'node tools/build-webview.mjs');
    assert.match(manifest.scripts.build, /node esbuild\.config\.mjs/);
    assert.match(manifest.scripts.build, /npm run build:webview/);
  });

  test('Vite config declares the cockpit entry with [name].js', () => {
    const config = readProjectFile('vite.webview.config.ts');

    // The cockpit bundle is built as a single-input pass so no shared chunk
    // (e.g. hooks.module-*.js) can be emitted.
    assert.match(config, /['"]src\/webview-cockpit\/main\.tsx['"]/);
    // '[name].js' preserves the literal cockpit.js the provider references.
    assert.match(config, /entryFileNames:\s*['"]\[name\]\.js['"]/);
  });

  test('Build:webview runs the single-input cockpit builder', () => {
    const manifest = JSON.parse(readProjectFile('package.json'));
    const script = manifest.scripts['build:webview'] as string;
    assert.match(script, /tools\/build-webview\.mjs/);

    const builder = readProjectFile('tools/build-webview.mjs');
    assert.match(builder, /WEBVIEW_ENTRY:\s*'cockpit'/);
    assert.match(builder, /WEBVIEW_EMPTY_OUT:\s*'true'/);
  });

  test('Build emits cockpit.js, self-contained (no shared chunk)', () => {
    const root = findRepoRoot();
    const dist = join(root, 'dist', 'webview');
    assert.ok(existsSync(join(dist, 'cockpit.js')), 'dist/webview/cockpit.js missing');

    // KEYSTONE (R1): a classic <script> cannot contain a top-level `import` of a
    // shared chunk — that throws SyntaxError and paints blank. The bundle must
    // be self-contained.
    const cockpitJs = readFileSync(join(dist, 'cockpit.js'), 'utf8');
    const SHARED_CHUNK_IMPORT = /import\s*[{*]?[^;]*from\s*["']\.\/assets\//;
    assert.ok(
      !SHARED_CHUNK_IMPORT.test(cockpitJs),
      'cockpit.js imports a shared ./assets chunk — not a self-contained classic script',
    );
    // No shared hooks chunk file should be emitted at all.
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const jsAssets = readdirSync(join(dist, 'assets')).filter((name) => name.endsWith('.js'));
    assert.deepEqual(
      jsAssets.filter((name) => name.startsWith('hooks.module')),
      [],
      `unexpected shared chunk emitted: ${jsAssets.join(', ')}`,
    );
  });

  test('Build emits one cockpit-*.css for the cockpit provider', () => {
    const root = findRepoRoot();
    const dist = join(root, 'dist', 'webview');
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const cssFiles = readdirSync(join(dist, 'assets')).filter((name) => name.endsWith('.css'));
    const cockpitCss = cssFiles.filter((name) => name.startsWith('cockpit-'));
    assert.equal(cockpitCss.length, 1, `expected one cockpit-*.css, found ${cssFiles.join(', ')}`);
  });

  test('Webview TypeScript configs use Preact JSX', () => {
    const webviewConfig = JSON.parse(readProjectFile('tsconfig.webview.json'));
    const testConfig = JSON.parse(readProjectFile('tsconfig.test.json'));

    assert.equal(webviewConfig.compilerOptions.jsxImportSource, 'preact');
    assert.equal(testConfig.compilerOptions.jsxImportSource, 'preact');
  });
});

suite('UI static gate', () => {
  test('Permits only approved webview, tree, and notification paths', () => {
    const source = readProjectFile('tools/check-no-stray-ui-surfaces.mjs');

    // The cockpit Webview View is the only allowlisted webview surface; the old
    // createWebviewPanel and tree-view APIs are forbidden everywhere.
    assert.match(
      source,
      /name:\s*'webview-view'[\s\S]*allowedPaths:\s*\[COCKPIT_WEBVIEW_VIEW_ALLOWED_PATH\]/,
    );
    assert.match(
      source,
      /COCKPIT_WEBVIEW_VIEW_ALLOWED_PATH\s*=\s*'src\/cockpit\/GaugeCockpitViewProvider\.ts'/,
    );
    assert.match(
      source,
      /name:\s*'show-warning-message'[\s\S]*allowedPaths:\s*NOTIFICATION_ALLOWED_PATHS/,
    );
    // The threshold-notification subsystem was removed, so warning
    // messages are now allowed in NO source file.
    assert.match(source, /NOTIFICATION_ALLOWED_PATHS\s*=\s*\[\]/);
  });

  test('Keeps the hidden developer command out of package contributions', () => {
    const manifest = JSON.parse(readProjectFile('package.json'));
    const commands = manifest.contributes?.commands ?? [];
    const contributedCommands = commands.map((command: { command?: string }) => command.command);

    assert.equal(contributedCommands.includes('tokenGauge.dev.writeSampleUsageEvent'), false);
  });
});
