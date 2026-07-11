import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// R1 (08-10 keystone): the extension host loads the cockpit bundle as a CLASSIC
// <script> under a strict nonce CSP (no type="module", no strict-dynamic). A
// classic script that contains a top-level `import` throws
// `SyntaxError: Cannot use import statement outside a module` and paints fully
// blank. A multi-input Rollup build would code-split a shared Preact-hooks
// chunk that the entry then `import`s — exactly the blank-cockpit blocker.
//
// Fix: a single-input build inlines every static import, so no shared chunk is
// emitted and the bundle is a self-contained classic script. entryFileNames
// stays '[name].js' so the literal cockpit.js filename the provider references
// is preserved. CSS is named per entry (cockpit-*.css).

const ENTRY_POINTS = {
  cockpit: 'src/webview-cockpit/main.tsx',
} as const;

type EntryName = keyof typeof ENTRY_POINTS;

function resolveEntryName(): EntryName {
  return 'cockpit';
}

export default defineConfig(({ mode }) => {
  const entry = resolveEntryName();
  return {
    plugins: [preact()],
    publicDir: false,
    build: {
      outDir: 'dist/webview',
      // Single cockpit pass; clears the output dir unless explicitly told not to.
      emptyOutDir: process.env.WEBVIEW_EMPTY_OUT !== 'false',
      assetsDir: 'assets',
      cssCodeSplit: false,
      sourcemap: mode !== 'production',
      minify: mode === 'production',
      rollupOptions: {
        // Single-input build: inlines all static imports, so no shared chunk.
        input: {
          [entry]: resolve(__dirname, ENTRY_POINTS[entry]),
        },
        output: {
          // '[name].js' preserves the literal cockpit.js the provider references.
          entryFileNames: '[name].js',
          // A self-contained single-input build emits no extra chunks, but keep
          // a per-entry name so any incidental chunk is still entry-scoped.
          chunkFileNames: `assets/${entry}-[hash].js`,
          // Per-entry CSS name so the provider matches its OWN stylesheet
          // (cockpit-*.css) by prefix, not "first .css".
          assetFileNames: (assetInfo) => {
            const name = assetInfo.name ?? '';
            if (name.endsWith('.css')) {
              return `assets/${entry}-[hash][extname]`;
            }
            return 'assets/[name]-[hash][extname]';
          },
        },
      },
    },
  };
});
