// Activation-compatibility regression gate.
//
// VS Code's extension host installs a throwing `navigator` migration getter
// (`PendingMigrationError: navigator is now a global in nodejs`). Zod's
// `allowsEval` probe does `typeof navigator !== "undefined"` to sniff Cloudflare
// Workers; bundled into the extension host that probe throws during ZodObject
// construction at module load and breaks cockpit activation. esbuild folds
// `navigator` to `undefined` for the extension-host build so the branch is
// dropped (see esbuild.config.mjs). This gate fails closed if that probe ever
// re-enters the extension-host bundle.
//
// Two independent checks:
//   A. Bundle audit — `dist/extension.js` must not contain a raw `navigator`
//      browser-global token. Webview bundles (dist/webview/*) are a normal
//      browser context and are intentionally NOT audited here.
//   B. Throwing-global smoke — load the built extension-host bundle with a
//      VS Code-style throwing `globalThis.navigator` getter and confirm no
//      navigator access occurs during module initialization. The global
//      descriptor is restored afterward so no state leaks.

import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

const EXT_BUNDLE = resolve('dist/extension.js');
const NAV_RE = /\bnavigator\b/;

function fail(message) {
  console.error(`FAIL: activation-compat - ${message}`);
  process.exit(1);
}

if (!existsSync(EXT_BUNDLE)) {
  fail(`${EXT_BUNDLE} not found. Run \`npm run build\` first.`);
}

// A. Bundle audit.
const bundle = readFileSync(EXT_BUNDLE, 'utf8');
if (NAV_RE.test(bundle)) {
  fail(
    'dist/extension.js contains a raw `navigator` token. A browser-global ' +
      'probe must not reach the extension-host bundle (see esbuild define).',
  );
}

// B. Throwing-global smoke.
const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const priorLoad = Module._load;

function installThrowingNavigator() {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    get() {
      const error = new Error('navigator is now a global in nodejs');
      error.name = 'PendingMigrationError';
      throw error;
    },
  });
}

function restoreNavigator() {
  if (priorNavigator) {
    Object.defineProperty(globalThis, 'navigator', priorNavigator);
  } else {
    delete globalThis.navigator;
  }
}

// Minimal `vscode` module stub so the bundle can be required outside an
// extension host. Every access returns a callable no-op proxy.
function installVscodeStub() {
  Module._load = (request, ...rest) => {
    if (request === 'vscode') {
      const noop = () => ({ dispose() {} });
      return new Proxy({}, { get: () => new Proxy(noop, { get: () => noop }) });
    }
    return priorLoad.call(Module, request, ...rest);
  };
}

function isNavigatorError(error) {
  if (!error) {
    return false;
  }
  if (error.name === 'PendingMigrationError') {
    return true;
  }
  return NAV_RE.test(String(error.stack ?? error.message ?? ''));
}

let note = '';
installThrowingNavigator();
installVscodeStub();
try {
  require(EXT_BUNDLE);
} catch (error) {
  if (isNavigatorError(error)) {
    Module._load = priorLoad;
    restoreNavigator();
    fail(`extension-host bundle accessed navigator during init: ${error.name}: ${error.message}`);
  }
  // A non-navigator load error is out of scope for this gate (full activation
  // is covered by the integration tests); note it but do not fail.
  note = ` (bundle threw a non-navigator error under the vscode stub: ${error?.name ?? 'Error'})`;
} finally {
  Module._load = priorLoad;
  restoreNavigator();
}

console.log(
  `OK: activation-compat - no navigator probe in dist/extension.js and no ` +
    `navigator access under a throwing globalThis.navigator getter.${note}`,
);
