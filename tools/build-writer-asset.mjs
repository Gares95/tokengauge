// Ships the canonical statusLine writer into dist/ so the Set Up Claude
// statusLine command can write it to the user's machine at runtime.
//
// The writer is NOT otherwise packaged: the VSIX carries dist/, resources/ and
// the docs only, so `src/bridge/...` does not exist on an installed extension.
// Copying it here keeps ONE source of truth. It is a build artifact, never a
// maintained second copy: tools/check-release-docs.mjs and the writer unit test
// hold the README block byte-identical to the same canonical file, and a unit
// test asserts this copy matches it too.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const WRITER_SOURCE = join(root, 'src', 'bridge', 'claude-statusline-writer.example.mjs');
export const WRITER_ASSET = join(root, 'dist', 'claude-statusline-writer.mjs');

function main() {
  const source = readFileSync(WRITER_SOURCE, 'utf8');
  if (!source.includes('TOKENGAUGE_STATUSLINE_WRITER_START')) {
    console.error('build-writer-asset: canonical writer is missing its start marker');
    process.exit(1);
  }
  mkdirSync(dirname(WRITER_ASSET), { recursive: true });
  copyFileSync(WRITER_SOURCE, WRITER_ASSET);
  console.log(`[writer-asset] dist/claude-statusline-writer.mjs (${source.length} bytes)`);
}

main();
