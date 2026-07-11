// Enforces no outbound network by default. Default network APIs
// (fetch, https.request, http.request) must not appear in extension source.
// User-configured provider/proxy adapters are a later-phase concern and
// will be allowlisted explicitly when they land. Reports rule names and
// paths only; never prints matched content.
//
// No-server rule: also FAIL if src/ opens a network listener/server.
// TokenGauge opens no TCP ports — the Codex app-server is stdio JSON-RPC via
// child_process.spawn (allowed; not a port). The Ports panel entries the user
// sees are from WSL/VS Code-remote/agent CLIs, never TokenGauge. This gate is
// the mechanical guarantee.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const RULE_NAME = 'no-network-default';
// Optional argv override (used by the self-test); defaults to the real source.
const SCAN_ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src'];
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.vscode-test', 'coverage', '.git']);
const TEXT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const MAX_FILE_BYTES = 1024 * 1024;

// Patterns: any direct call/import of default network APIs in extension
// source code. Whitespace tolerated. Word boundaries prevent matching
// substrings like `prefetch` or `unfetched`.
const NETWORK_PATTERNS = [
  { name: 'fetch-call', re: /(?<![A-Za-z0-9_$.])fetch\s*\(/ },
  { name: 'https-request', re: /\bhttps\s*\.\s*request\s*\(/ },
  { name: 'http-request', re: /\bhttp\s*\.\s*request\s*\(/ },
  { name: 'https-get', re: /\bhttps\s*\.\s*get\s*\(/ },
  { name: 'http-get', re: /\bhttp\s*\.\s*get\s*\(/ },
  { name: 'node-http-import', re: /from\s+['"]node:https?['"]/ },
];

// Network listeners / servers. TokenGauge must open no ports.
// `.listen(` covers net/http/https/dgram server binding and Express/etc.;
// `createServer` covers net/http/https/tls; WebSocketServer / `new WebSocket
// .Server` covers ws; `dgram.createSocket` covers UDP. child_process.spawn for
// the Codex stdio probe is NOT matched — it has no port.
const SERVER_PATTERNS = [
  { name: 'listen', re: /\.\s*listen\s*\(/ },
  { name: 'create-server', re: /(?<![A-Za-z0-9_$.])createServer\s*\(/ },
  { name: 'net-create-server', re: /\bnet\s*\.\s*createServer\s*\(/ },
  { name: 'http-create-server', re: /\bhttp\s*\.\s*createServer\s*\(/ },
  { name: 'https-create-server', re: /\bhttps\s*\.\s*createServer\s*\(/ },
  { name: 'tls-create-server', re: /\btls\s*\.\s*createServer\s*\(/ },
  { name: 'websocket-server', re: /\bWebSocketServer\b|new\s+WebSocket\s*\.\s*Server\b/ },
  { name: 'dgram-create-socket', re: /\bdgram\s*\.\s*createSocket\s*\(/ },
];

const ALL_PATTERNS = [
  ...NETWORK_PATTERNS.map((p) => ({ ...p, rule: 'no-network-default' })),
  ...SERVER_PATTERNS.map((p) => ({ ...p, rule: 'no-server' })),
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

function scanFile(filePath, size) {
  const ext = extname(filePath).toLowerCase();
  if (!TEXT_EXTS.has(ext) || size > MAX_FILE_BYTES) {
    return;
  }
  const content = readFileSync(filePath, 'utf8');
  const relPath = toPosix(relative(cwd, filePath) || filePath);
  for (const pattern of ALL_PATTERNS) {
    if (pattern.re.test(content)) {
      violations.push({ ruleName: `${pattern.rule}:${pattern.name}`, relPath });
    }
  }
}

for (const root of SCAN_ROOTS) {
  walk(root);
}

if (violations.length > 0) {
  console.error('No-network-default / no-server violations:');
  for (const v of violations) {
    console.error(`  [${v.ruleName}] ${v.relPath}`);
  }
  console.error(`Total: ${violations.length}`);
  process.exit(1);
}

console.log(
  `OK: ${RULE_NAME} + no-server - no default network APIs and no listeners/servers in source.`,
);
