// Enforces exact-pinned dependencies and the chokidar 4.0.3 invariant.
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const violations = [];

function isRange(spec) {
  return (
    spec.startsWith('^') ||
    spec.startsWith('~') ||
    spec.startsWith('>') ||
    spec.startsWith('<') ||
    spec.startsWith('=') ||
    spec.includes(' - ') ||
    spec.includes('||') ||
    spec.includes('*')
  );
}

for (const section of sections) {
  const deps = packageJson[section] ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string') {
      continue;
    }

    const aliasedSpec = spec.startsWith('npm:') ? spec.slice('npm:'.length) : spec;
    if (isRange(aliasedSpec)) {
      violations.push(`${section}: ${name}@${spec}`);
    }

    if (name === 'chokidar' && spec !== '4.0.3') {
      violations.push(`${section}: chokidar must be exactly 4.0.3, got ${spec}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Exact-pin policy violations:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log('OK: every dependency is exact-pinned.');
