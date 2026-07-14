// Enforces the SecretStorage boundary: access is only allowed inside
// src/security/SecretManager.ts and approved SecretManager tests. Every
// other source/test/tool file that calls context.secrets.* or secrets.*
// fails this gate. Reports rule names and paths only; never prints matched
// content.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const RULE_NAME = 'secretstorage-boundary';
const SCAN_ROOTS = ['src', 'test', 'tools'];
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.vscode-test', 'coverage', '.git']);
const TEXT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const MAX_FILE_BYTES = 1024 * 1024;

// Allowlist: only SecretManager.ts and approved SecretManager tests may
// call into VS Code SecretStorage.
const ALLOWED_PATH_SUFFIXES = [
  'src/security/SecretManager.ts',
  'test/unit/security/SecretManager.test.ts',
  'test/integration/secret-manager.test.ts',
];

// Patterns that indicate SecretStorage access. Matches:
//   context.secrets.get/store/delete/keys
//   secrets.get/store/delete/keys (when bound from context.secrets)
const SECRET_API_RE = /\bsecrets\s*\.\s*(?:get|store|delete|keys)\s*\(/;

const cwd = process.cwd();
const violations = [];

function toPosix(p) {
  return p.replaceAll('\\', '/');
}

function isAllowed(relPath) {
  const posix = toPosix(relPath);
  for (const suffix of ALLOWED_PATH_SUFFIXES) {
    if (posix === suffix || posix.endsWith(`/${suffix}`)) {
      return true;
    }
  }
  return false;
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

function scanFile(filePath, size) {
  const ext = extname(filePath).toLowerCase();
  if (!TEXT_EXTS.has(ext) || size > MAX_FILE_BYTES) {
    return;
  }
  const relPath = relative(cwd, filePath) || filePath;
  if (isAllowed(relPath)) {
    return;
  }
  const content = readFileSync(filePath, 'utf8');
  if (SECRET_API_RE.test(content)) {
    violations.push({ ruleName: RULE_NAME, relPath: toPosix(relPath) });
  }
}

for (const root of SCAN_ROOTS) {
  walk(root);
}

if (violations.length > 0) {
  console.error('SecretStorage boundary violations:');
  for (const v of violations) {
    console.error(`  [${v.ruleName}] ${v.relPath}`);
  }
  console.error(`Total: ${violations.length}`);
  process.exit(1);
}

console.log('OK: secretstorage-boundary - no unauthorized SecretStorage access.');
