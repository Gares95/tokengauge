import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const outTestRoot = join(repoRoot, 'out', 'test');
const sourceTestRoot = join(repoRoot, 'test');

function toPosix(path) {
  return path.replaceAll('\\', '/');
}

function walkFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function sourceCandidatesFor(compiledPath) {
  const rel = relative(outTestRoot, compiledPath);
  const base = rel.replace(/\.js$/, '');
  return [join(sourceTestRoot, `${base}.ts`), join(sourceTestRoot, `${base}.tsx`)];
}

if (!existsSync(outTestRoot) || !statSync(outTestRoot).isDirectory()) {
  console.error('Stale compiled-test guard: missing out/test compiled output.');
  console.error(
    'Run `npm run compile-tests` before direct `npm run test:*` labels, or run `npm test`.',
  );
  process.exit(1);
}

const compiledJs = walkFiles(outTestRoot).filter((file) => file.endsWith('.js'));

if (compiledJs.length === 0) {
  console.error('Stale compiled-test guard: no compiled JavaScript files found under out/test.');
  console.error(
    'Run `npm run compile-tests` before direct `npm run test:*` labels, or run `npm test`.',
  );
  process.exit(1);
}

const stale = compiledJs.filter(
  (file) => !sourceCandidatesFor(file).some((candidate) => existsSync(candidate)),
);

if (stale.length > 0) {
  console.error('Stale compiled-test guard: compiled test output has no matching source file.');
  for (const file of stale) {
    const rel = toPosix(relative(repoRoot, file));
    const expected = sourceCandidatesFor(file)
      .map((candidate) => toPosix(relative(repoRoot, candidate)))
      .join(' or ');
    console.error(`  ${rel} -> expected ${expected}`);
  }
  console.error('Run `npm run clean && npm run compile-tests` before running test labels.');
  process.exit(1);
}

console.log(`OK: stale compiled-test guard passed (${compiledJs.length} compiled files checked).`);
