import process from 'node:process';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production';

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
  treeShaking: true,
  mainFields: ['module', 'main'],
  // The extension host is Node-only. Zod's `allowsEval` probe does
  // `typeof navigator !== "undefined"` to sniff Cloudflare Workers; VS Code's
  // extension host installs a throwing `navigator` migration getter, so that
  // probe throws PendingMigrationError during ZodObject construction at module
  // load. No extension-host code uses `navigator`, so we fold it to `undefined`
  // at build time: the Cloudflare branch becomes dead code and is dropped,
  // while Zod's JIT (`new Function`) path and all validation behavior are
  // unchanged.
  define: {
    navigator: 'undefined',
  },
};

try {
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await esbuild.build(options);
    console.log(
      `[esbuild] built dist/extension.js (production=${production}, sourcemap=${!production}, minify=${production})`,
    );
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
