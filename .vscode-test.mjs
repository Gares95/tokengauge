import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
  {
    label: 'unit',
    files: 'out/test/unit/**/*.test.js',
    mocha: {
      timeout: 5000,
      ui: 'tdd',
    },
  },
  {
    label: 'integration',
    files: 'out/test/integration/**/*.test.js',
    version: 'stable',
    workspaceFolder: './test/fixtures/empty-workspace',
    // Expose V8's gc() to the Extension Host so the adapter-endurance heap test
    // can force collection before sampling. Without it `global.gc` is undefined,
    // its gc() calls are no-ops, and the heap sample includes transient garbage
    // — making the bounded-heap ceiling assertion flaky (QUAL-05 / D-30).
    launchArgs: ['--js-flags=--expose-gc'],
    mocha: {
      timeout: 30000,
      ui: 'tdd',
    },
  },
  {
    label: 'privacy',
    files: 'out/test/privacy/**/*.test.js',
    mocha: {
      timeout: 5000,
      ui: 'tdd',
    },
  },
]);
