// Deterministic, cross-platform invoker for tools/audit-vsix.mjs.
// Computes the VSIX filename from package.json in Node (no shell variable
// expansion) and spawns the auditor with an explicit path. Mirrors the
// determinism of tools/package-vsix.mjs so verify:vsix uses the same
// computed filename on Linux, macOS, and Windows.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const filename = `tokengauge-vscode-${pkg.version}.vsix`;

const result = spawnSync(process.execPath, ['tools/audit-vsix.mjs', filename], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
