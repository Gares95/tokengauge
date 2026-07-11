// Deterministic, cross-platform VSIX packager.
// Reads the version from package.json in Node (no shell variable expansion),
// removes any stale *.vsix at the repo root, and invokes vsce's library API
// to produce tokengauge-vscode-<version>.vsix. Avoids Windows cmd.exe vs.
// POSIX-shell differences in ${npm_package_version} expansion that caused
// the file to be created with a literal "${...}" name on the Windows runner.
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createVSIX } from '@vscode/vsce';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const filename = `tokengauge-vscode-${pkg.version}.vsix`;

for (const entry of readdirSync('.')) {
  if (entry.endsWith('.vsix')) {
    unlinkSync(entry);
    console.log(`removed stale ${entry}`);
  }
}

try {
  await createVSIX({
    cwd: process.cwd(),
    packagePath: filename,
    allowMissingRepository: true,
  });
  console.log(`packaged ${filename}`);
} catch (err) {
  const msg = err?.message ?? String(err);
  console.error(`vsce createVSIX failed: ${msg}`);
  process.exit(1);
}
