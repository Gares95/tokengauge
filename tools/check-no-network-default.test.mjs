// Self-test for the no-network-default / no-server gate. Asserts:
//  - a probe line containing `.listen(` trips the no-server gate;
//  - createServer / WebSocketServer / dgram.createSocket trip it too;
//  - a child_process.spawn stdio line (the Codex app-server shape) does NOT trip
//    it — stdio is allowed, only ports/listeners are forbidden;
//  - the real src/ passes both the network and server gates.
// Reports rule names and exit status only; never prints matched content.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(repoRoot, 'tools/check-no-network-default.mjs');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runGateOn(scanRoot) {
  const result = spawnSync('node', [scriptPath, scanRoot], { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function withTempSrc(fileName, contents, fn) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tokengauge-no-server-'));
  try {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, fileName), contents);
    fn(runGateOn(srcDir));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// (1) `.listen(` trips the no-server gate.
withTempSrc('listener.ts', 'const s = makeServer();\ns.listen(8080);\n', ({ status, output }) => {
  assert(status !== 0, 'a `.listen(` probe must trip the no-server gate');
  assert(output.includes('no-server:listen'), 'expected the no-server:listen rule to fire');
});

// (2) createServer / WebSocketServer / dgram.createSocket each trip it.
withTempSrc(
  'http-server.ts',
  "import * as http from 'http';\nhttp.createServer();\n",
  ({ status, output }) => {
    assert(status !== 0, 'http.createServer must trip the no-server gate');
    assert(output.includes('no-server:'), 'expected a no-server rule to fire for createServer');
  },
);
withTempSrc('ws.ts', 'const wss = new WebSocketServer({ port: 9000 });\n', ({ status, output }) => {
  assert(status !== 0, 'WebSocketServer must trip the no-server gate');
  assert(output.includes('no-server:websocket-server'), 'expected no-server:websocket-server');
});
withTempSrc(
  'udp.ts',
  "import * as dgram from 'dgram';\nconst u = dgram.createSocket('udp4');\n",
  ({ status }) => {
    assert(status !== 0, 'dgram.createSocket must trip the no-server gate');
  },
);

// (3) The documented Codex stdio spawn shape does NOT trip the gate (no port).
withTempSrc(
  'codex-stdio.ts',
  "import { spawn } from 'node:child_process';\nspawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });\n",
  ({ status, output }) => {
    assert(status === 0, 'child_process.spawn stdio must NOT trip the no-server gate');
    assert(!output.includes('no-server:'), 'stdio spawn must not be flagged as a server/listener');
  },
);

// (4) The real src/ passes both gates.
const real = runGateOn('src');
assert(real.status === 0, `real src/ must pass the no-network/no-server gate:\n${real.output}`);

console.log('OK: no-network-default / no-server gate self-test passed.');
