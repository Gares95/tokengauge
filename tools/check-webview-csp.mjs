import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const RULE_NAME = 'webview-csp';
const TARGET_FILES = ['src/cockpit/csp.ts', 'src/cockpit/GaugeCockpitViewProvider.ts'];
const TARGET_DIRS = ['src/webview', 'src/webview-cockpit'];
// Provider files whose localResourceRoots must be constrained to dist/webview.
const PROVIDER_FILES = ['src/cockpit/GaugeCockpitViewProvider.ts'];
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.vscode-test', 'coverage', '.git']);
const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html']);
const MAX_FILE_BYTES = 1024 * 1024;

const FORBIDDEN_PATTERNS = [
  { name: 'unsafe-inline', re: /unsafe-inline/i },
  { name: 'unsafe-eval', re: /unsafe-eval/i },
  { name: 'http-protocol', re: /\bhttp:/i },
  { name: 'https-protocol', re: /\bhttps:/i },
  { name: 'new-function', re: /\bnew\s+Function\b/ },
  { name: 'eval-call', re: /\beval\s*\(/ },
  { name: 'remote-script-url', re: /<script\b[^>]*\bsrc\s*=\s*["']https?:/i },
  { name: 'remote-image-url', re: /<img\b[^>]*\bsrc\s*=\s*["']https?:/i },
  { name: 'remote-stylesheet-url', re: /<link\b[^>]*\bhref\s*=\s*["']https?:/i },
  { name: 'remote-css-url', re: /\burl\s*\(\s*["']?https?:/i },
  { name: 'remote-css-import', re: /@import\s+(?:url\s*\(\s*)?["']https?:/i },
  // Inline style attributes are blocked by the per-render nonce CSP (no
  // unsafe-inline for styles), so the gate forbids them in webview .ts/.tsx
  // sources. Anchored on `style=` / `style={` so it never false-positives on
  // identifiers like `styles.css` or `stylesheetName`.
  { name: 'inline-style-attr', re: /\bstyle\s*=\s*(?:["']|\{)/, webviewDirsOnly: true },
];

const cwd = process.cwd();
const violations = [];

function toPosix(path) {
  return path.replaceAll('\\', '/');
}

function addViolation(name, filePath) {
  violations.push({
    ruleId: `${RULE_NAME}:${name}`,
    relPath: toPosix(relative(cwd, filePath) || filePath),
  });
}

function scanFile(filePath, size, inWebviewDir) {
  const ext = extname(filePath).toLowerCase();
  if (!TEXT_EXTS.has(ext) || size > MAX_FILE_BYTES) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.webviewDirsOnly && !inWebviewDir) {
      continue;
    }
    if (pattern.re.test(content)) {
      addViolation(pattern.name, filePath);
    }
  }
}

function walk(target, inWebviewDir) {
  if (!existsSync(target)) {
    return;
  }

  const stat = statSync(target);
  if (stat.isFile()) {
    scanFile(target, stat.size, inWebviewDir);
    return;
  }

  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(child, inWebviewDir);
      }
      continue;
    }
    if (entry.isFile()) {
      scanFile(child, statSync(child).size, inWebviewDir);
    }
  }
}

function localResourceRootsAreConstrained(content) {
  const rootIsDistWebview =
    /const\s+webviewRoot\s*=\s*vscode\.Uri\.joinPath\(\s*context\.extensionUri\s*,\s*['"]dist['"]\s*,\s*['"]webview['"]\s*\)/s.test(
      content,
    );
  const rootsUseWebviewRoot = /localResourceRoots\s*:\s*\[\s*webviewRoot\s*\]/s.test(content);
  const rootsInlineDistWebview =
    /localResourceRoots\s*:\s*\[[\s\S]*['"]dist['"][\s\S]*['"]webview['"][\s\S]*\]/s.test(content);
  return rootsInlineDistWebview || (rootIsDistWebview && rootsUseWebviewRoot);
}

function scanLocalResourceRoots() {
  // Every provider that hosts a webview must constrain localResourceRoots to
  // dist/webview via the exact joinPath(context.extensionUri,'dist','webview')
  // shape — asserted mechanically so a new surface cannot ship unaudited.
  for (const rel of PROVIDER_FILES) {
    const filePath = join(cwd, rel);
    if (!existsSync(filePath)) {
      addViolation('local-resource-roots-missing', filePath);
      continue;
    }
    const content = readFileSync(filePath, 'utf8');
    if (!/\blocalResourceRoots\s*:/.test(content)) {
      addViolation('local-resource-roots-missing', filePath);
      continue;
    }
    if (!localResourceRootsAreConstrained(content)) {
      addViolation('local-resource-roots-unconstrained', filePath);
    }
  }
}

for (const target of TARGET_FILES) {
  walk(target, false);
}
for (const target of TARGET_DIRS) {
  walk(target, true);
}
scanLocalResourceRoots();

if (violations.length > 0) {
  console.error('Webview CSP audit violations:');
  for (const violation of violations) {
    console.error(`  [${violation.ruleId}] ${violation.relPath}`);
  }
  console.error(`Total: ${violations.length}`);
  process.exit(1);
}

console.log(
  'OK: webview-csp - strict nonce CSP, constrained localResourceRoots, and no remote webview sources.',
);
