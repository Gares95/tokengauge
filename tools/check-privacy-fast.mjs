// Fast scan of source, test, and tool files for sensitive content.
// Reports rule name and path only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { FORBIDDEN_CONTENT_PATTERNS, SELF_SKIP_MARKER } from './audit-vsix-patterns.mjs';

const DEFAULT_SCAN_ROOTS = ['src', 'test', 'tools'];
const scanRoots = process.argv.slice(2);
const SCAN_ROOTS = scanRoots.length > 0 ? scanRoots : DEFAULT_SCAN_ROOTS;
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.vscode-test', 'coverage', '.git']);
const TEXT_EXTS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
]);
const MAX_FILE_BYTES = 1024 * 1024;
const cwd = process.cwd();
const violations = [];

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

function scanFile(filePath, size) {
  const extension = extname(filePath).toLowerCase();
  if (!TEXT_EXTS.has(extension) || size > MAX_FILE_BYTES) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');
  if (content.includes(SELF_SKIP_MARKER)) {
    return;
  }

  for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.skipExts?.includes(extension)) {
      continue;
    }
    if (pattern.re.test(content)) {
      violations.push({
        ruleName: pattern.name,
        relPath: relative(cwd, filePath) || filePath,
      });
    }
  }
}

for (const root of SCAN_ROOTS) {
  walk(root);
}

if (violations.length > 0) {
  console.error('Privacy fast-sweep violations:');
  for (const violation of violations) {
    console.error(`  [${violation.ruleName}] ${violation.relPath}`);
  }
  process.exit(1);
}

console.log('OK: privacy fast-sweep - no leaks found.');
