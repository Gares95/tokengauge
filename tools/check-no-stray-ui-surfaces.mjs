// Enforces the UI-surface allowlist contract: TokenGauge may ship only the
// approved status bar, cockpit webview, and command-seam notification paths,
// and must not add the hidden developer command
// `tokenGauge.dev.writeSampleUsageEvent` to `package.json#contributes.commands`.
// Reports rule names and paths only; never prints matched UI text.
//
// Every approved UI API path is exact. Any new UI surface must extend this
// allowlist deliberately instead of broadening the scanner.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const RULE_NAME = 'no-stray-ui-surfaces';
const SCAN_ROOTS = ['src'];
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.vscode-test', 'coverage', '.git']);
const TEXT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const MAX_FILE_BYTES = 1024 * 1024;

const HIDDEN_DEV_COMMAND_ID = 'tokenGauge.dev.writeSampleUsageEvent';

// The single approved native status bar surface.
const STATUS_BAR_ALLOWED_PATH = 'src/status/StatusBarUsageItem.ts';

// The Native Multi-Agent Gauge Cockpit is a single approved sidebar Webview
// View. Its provider is the one place permitted to call
// registerWebviewViewProvider; the contributed view id is allowlisted in
// scanManifest below. The cockpit webview uses the SINGLE audited CSP builder
// (src/cockpit/csp.ts) — this allowance does not relax CSP enforcement.
const COCKPIT_WEBVIEW_VIEW_ALLOWED_PATH = 'src/cockpit/GaugeCockpitViewProvider.ts';
const COCKPIT_WEBVIEW_VIEW_ID = 'tokenGauge.views.cockpit';

// Files allowed to call notification APIs for non-usage purposes.
// `src/commands/nativeUiSeams.ts` is the single deliberately allowlisted home
// for the command-flow notification/confirmation seams the extension wiring
// injects into the otherwise gate-clean command modules. Notifications carry
// only short sanitized status copy.
const COMMAND_UI_SEAMS_PATH = 'src/commands/nativeUiSeams.ts';
const INFO_NOTIFICATION_ALLOWED_PATHS = [COMMAND_UI_SEAMS_PATH];
// The threshold-notification subsystem was removed with the native-only reset,
// so warning messages are allowed nowhere (there is no log-derived alert path).
const NOTIFICATION_ALLOWED_PATHS = [];
const ERROR_NOTIFICATION_ALLOWED_PATHS = [COMMAND_UI_SEAMS_PATH];

// UI surface APIs. Patterns without `allowedPaths` are forbidden in every
// source file. Patterns with `allowedPaths` are permitted ONLY in those exact
// paths and remain violations everywhere else. Any new allowance must update
// this list deliberately.
const UI_PATTERNS = [
  // createWebviewPanel + the tree-view APIs are forbidden in every source file
  // (the historical webview panel + Usage tree were removed).
  {
    name: 'webview-panel',
    re: /\bvscode\s*\.\s*window\s*\.\s*createWebviewPanel\s*\(/,
  },
  {
    name: 'webview-view',
    re: /\bvscode\s*\.\s*window\s*\.\s*registerWebviewViewProvider\s*\(/,
    allowedPaths: [COCKPIT_WEBVIEW_VIEW_ALLOWED_PATH],
  },
  {
    name: 'tree-view',
    re: /\bvscode\s*\.\s*window\s*\.\s*createTreeView\s*\(/,
  },
  {
    name: 'tree-data-provider',
    re: /\bvscode\s*\.\s*window\s*\.\s*registerTreeDataProvider\s*\(/,
  },
  {
    name: 'status-bar-item',
    re: /\bvscode\s*\.\s*window\s*\.\s*createStatusBarItem\s*\(/,
    allowedPaths: [STATUS_BAR_ALLOWED_PATH],
  },
  { name: 'quick-pick', re: /\bvscode\s*\.\s*window\s*\.\s*createQuickPick\s*\(/ },
  {
    name: 'show-information-message',
    re: /\bvscode\s*\.\s*window\s*\.\s*showInformationMessage\s*\(/,
    allowedPaths: INFO_NOTIFICATION_ALLOWED_PATHS,
  },
  {
    name: 'show-warning-message',
    re: /\bvscode\s*\.\s*window\s*\.\s*showWarningMessage\s*\(/,
    allowedPaths: NOTIFICATION_ALLOWED_PATHS,
  },
  {
    name: 'show-error-message',
    re: /\bvscode\s*\.\s*window\s*\.\s*showErrorMessage\s*\(/,
    allowedPaths: ERROR_NOTIFICATION_ALLOWED_PATHS,
  },
];

const cwd = process.cwd();
const violations = [];

function toPosix(p) {
  return p.replaceAll('\\', '/');
}

function walk(target) {
  if (!existsSync(target)) {
    return;
  }
  const stat = statSync(target);
  if (stat.isFile()) {
    scanFile(target, stat.size);
    return;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(child);
      }
      continue;
    }
    if (entry.isFile()) {
      scanFile(child, statSync(child).size);
    }
  }
}

function pathMatches(relPath, candidate) {
  return relPath === candidate || relPath.endsWith(`/${candidate}`);
}

function isPatternAllowedFor(pattern, relPath) {
  if (!pattern.allowedPaths) {
    return false;
  }
  return pattern.allowedPaths.some((candidate) => pathMatches(relPath, candidate));
}

function scanFile(filePath, size) {
  const ext = extname(filePath).toLowerCase();
  if (!TEXT_EXTS.has(ext) || size > MAX_FILE_BYTES) {
    return;
  }
  const relPath = toPosix(relative(cwd, filePath) || filePath);
  const content = readFileSync(filePath, 'utf8');
  for (const pattern of UI_PATTERNS) {
    if (!pattern.re.test(content)) {
      continue;
    }
    if (isPatternAllowedFor(pattern, relPath)) {
      continue;
    }
    violations.push({ ruleName: `${RULE_NAME}:${pattern.name}`, relPath });
  }
}

function scanManifest() {
  if (!existsSync('package.json')) {
    return;
  }
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const contributes = manifest.contributes ?? {};

  // Hidden developer command must NEVER be contributed.
  const commands = Array.isArray(contributes.commands) ? contributes.commands : [];
  for (const cmd of commands) {
    if (cmd?.command === HIDDEN_DEV_COMMAND_ID) {
      violations.push({
        ruleName: `${RULE_NAME}:contributed-hidden-dev-command`,
        relPath: 'package.json',
      });
    }
  }

  const viewContainers = contributes.viewsContainers;
  if (viewContainers !== undefined) {
    const activitybar = Array.isArray(viewContainers.activitybar) ? viewContainers.activitybar : [];
    const otherKeys = Object.keys(viewContainers).filter((key) => key !== 'activitybar');
    const allowed =
      activitybar.length === 1 &&
      activitybar[0]?.id === 'tokenGauge' &&
      activitybar[0]?.title === 'TokenGauge' &&
      activitybar[0]?.icon === 'resources/tokengauge-view.svg' &&
      otherKeys.length === 0;
    if (!allowed) {
      violations.push({
        ruleName: `${RULE_NAME}:contributes-viewsContainers`,
        relPath: 'package.json',
      });
    }
  }

  const views = contributes.views;
  if (views !== undefined) {
    const tokenGaugeViews = Array.isArray(views.tokenGauge) ? views.tokenGauge : [];
    const otherKeys = Object.keys(views).filter((key) => key !== 'tokenGauge');
    // One approved view: the cockpit Webview View, the always-on primary
    // surface (ungated). The historical Usage view was removed. Exact match on
    // id/type/name/count — any extra view, id, or type drift is a violation.
    // The view is named for the brand ("TokenGauge") so the sidebar header
    // reads "TOKENGAUGE" instead of "TOKENGAUGE: COCKPIT".
    const cockpitView = tokenGaugeViews.find((v) => v?.id === COCKPIT_WEBVIEW_VIEW_ID);
    const cockpitUngated = cockpitView?.when === undefined;
    const allowed =
      tokenGaugeViews.length === 1 &&
      cockpitView?.type === 'webview' &&
      cockpitView?.name === 'TokenGauge' &&
      cockpitUngated &&
      otherKeys.length === 0;
    if (!allowed) {
      violations.push({
        ruleName: `${RULE_NAME}:contributes-views`,
        relPath: 'package.json',
      });
    }
  }

  if (contributes.viewsWelcome !== undefined) {
    violations.push({
      ruleName: `${RULE_NAME}:contributes-viewsWelcome`,
      relPath: 'package.json',
    });
  }
}

for (const root of SCAN_ROOTS) {
  walk(root);
}
scanManifest();

if (violations.length > 0) {
  console.error('no-UI-surface violations:');
  for (const v of violations) {
    console.error(`  [${v.ruleName}] ${v.relPath}`);
  }
  console.error(`Total: ${violations.length}`);
  process.exit(1);
}

console.log(
  'OK: no-stray-ui-surfaces - only approved status bar, cockpit webview, and command-seam notification surfaces.',
);
