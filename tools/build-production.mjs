// Cross-platform NODE_ENV=production gate for esbuild.config.mjs.
// Invoked by package.json#scripts.build:production.
// Production builds must emit no sourcemaps.
process.env.NODE_ENV = 'production';
await import('../esbuild.config.mjs');
