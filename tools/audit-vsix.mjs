// Defense-in-depth VSIX content audit. Reports rule name and entry path only.
// SELF-SKIP: tokengauge-audit-patterns
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import yauzl from 'yauzl';
import {
  FORBIDDEN_CONTENT_PATTERNS,
  PROMPT_SHAPE_PATTERN,
  SELF_SKIP_MARKER,
} from './audit-vsix-patterns.mjs';

const MAX_TEXT_BYTES = 1024 * 1024;
const TEXT_EXTS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.html',
  '.css',
]);
const ALLOWED_TOP_LEVEL = [
  'extension/dist/',
  // The activity-bar view-container icon. Only the single SVG glyph is
  // permitted under resources/ — the REQUIRED_ENTRIES check below asserts it is
  // present, and the .svg extension is in ALLOWED_EXTENSIONS.
  'extension/resources/tokengauge-view.svg',
  // The Marketplace/extension icon (package.json "icon"). A local PNG
  // asset bundled in the VSIX — no network/CDN, no trademarked logos. Not a
  // text extension, so the content scan skips it; this allowlist entry keeps it
  // from tripping the unexpected-entry rule.
  'extension/resources/tokengauge-icon.png',
  'extension/package.json',
  'extension/readme.md',
  'extension/license',
  'extension/changelog.md',
  'extension.vsixmanifest',
  '[content_types].xml',
];
const REQUIRED_ENTRIES = [
  {
    name: 'extension-bundle',
    pathLabel: 'extension/dist/extension.js',
    test: (entryPathLC) => entryPathLC === 'extension/dist/extension.js',
  },
  {
    name: 'cockpit-bundle',
    pathLabel: 'extension/dist/webview/cockpit.js',
    test: (entryPathLC) => entryPathLC === 'extension/dist/webview/cockpit.js',
  },
  // The cockpit bundle must ship its OWN stylesheet (cockpit-*.css),
  // not just the first stylesheet — otherwise the cockpit renders unstyled.
  {
    name: 'cockpit-style',
    pathLabel: 'extension/dist/webview/assets/cockpit-*.css',
    test: (entryPathLC) =>
      entryPathLC.startsWith('extension/dist/webview/assets/cockpit-') &&
      entryPathLC.endsWith('.css'),
  },
  // The activity-bar view-container icon must ship (was a blank slot).
  {
    name: 'activitybar-icon',
    pathLabel: 'extension/resources/tokengauge-view.svg',
    test: (entryPathLC) => entryPathLC === 'extension/resources/tokengauge-view.svg',
  },
];

// The packaged cockpit bundle must CONTAIN the
// current copy sentinels. A shipped VSIX once served a stale, older cockpit
// copy; this gate fails a package that silently ships an older cockpit.js so the
// delivery regression cannot recur. Reports only the missing-sentinel COUNT and
// the entry path — never the matched content (no copy dump).
const REQUIRED_CONTENT = [
  {
    name: 'cockpit-copy-sentinels',
    pathLabel: 'extension/dist/webview/cockpit.js',
    test: (entryPathLC) => entryPathLC === 'extension/dist/webview/cockpit.js',
    sentinels: ['Near limit', 'Welcome to TokenGauge', '5-hour window'],
  },
];

function dotDir(name) {
  return `extension/.${name}/`;
}

function joined(...parts) {
  return parts.join('');
}

const localArtifactNames = [
  'git',
  'github',
  'vscode',
  joined('plan', 'ning'),
  joined('clau', 'de'),
  joined('co', 'dex'),
  'cursor',
  joined('wind', 'surf'),
  joined('open', 'code'),
  joined('gem', 'ini'),
];
const instructionFiles = [
  `${joined('CLA', 'UDE')}.md`,
  `${joined('AG', 'ENTS')}.md`,
  `${joined('GEM', 'INI')}.md`,
].map((value) => value.toLowerCase());

const FORBIDDEN_PATHS = [
  ...localArtifactNames.map((name) => ({
    name: 'local-workspace-artifact',
    test: (entryPathLC) => entryPathLC.startsWith(dotDir(name)),
  })),
  {
    name: 'src-dir',
    test: (entryPathLC) => entryPathLC.startsWith('extension/src/'),
  },
  {
    name: 'test-dir',
    test: (entryPathLC) =>
      entryPathLC.startsWith('extension/test/') ||
      entryPathLC.startsWith('extension/tests/') ||
      entryPathLC.startsWith('extension/fixtures/'),
  },
  {
    name: 'tools-dir',
    test: (entryPathLC) =>
      entryPathLC.startsWith('extension/tools/') || entryPathLC.startsWith('extension/scripts/'),
  },
  {
    name: 'node-modules',
    test: (entryPathLC) => entryPathLC.includes('/node_modules/'),
  },
  {
    name: 'coverage',
    test: (entryPathLC) => entryPathLC.startsWith('extension/coverage/'),
  },
  {
    name: 'out-dir',
    test: (entryPathLC) => entryPathLC.startsWith('extension/out/'),
  },
  {
    name: 'dotenv',
    test: (entryPathLC) =>
      entryPathLC === 'extension/.env' || entryPathLC.startsWith('extension/.env.'),
  },
  {
    name: 'cred-extension',
    test: (entryPathLC) =>
      ['.pem', '.key', '.p12', '.pfx'].some((extension) => entryPathLC.endsWith(extension)),
  },
  {
    name: 'local-db',
    test: (entryPathLC) => ['.sqlite', '.db'].some((extension) => entryPathLC.endsWith(extension)),
  },
  {
    name: 'local-log',
    test: (entryPathLC) => ['.log', '.jsonl'].some((extension) => entryPathLC.endsWith(extension)),
  },
  {
    name: 'sourcemap',
    test: (entryPathLC) => entryPathLC.endsWith('.map'),
  },
  {
    name: 'instruction-file',
    test: (entryPathLC) =>
      instructionFiles.some((fileName) => entryPathLC === `extension/${fileName}`),
  },
  {
    name: 'local-suffix',
    test: (entryPathLC) => entryPathLC.endsWith('.local'),
  },
];

function isAllowed(entryPath) {
  const lower = entryPath.toLowerCase();
  return ALLOWED_TOP_LEVEL.some((allowed) => lower.startsWith(allowed));
}

function openZip(vsixPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipFile);
    });
  });
}

function readEntry(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readZipEntries(vsixPath) {
  const zipFile = await openZip(vsixPath);
  const entries = [];

  return new Promise((resolveEntries, rejectEntries) => {
    zipFile.on('entry', async (entry) => {
      try {
        const entryPath = entry.fileName.replaceAll('\\', '/');
        if (entryPath.endsWith('/')) {
          entries.push({ entryPath, buffer: Buffer.alloc(0), size: 0 });
          zipFile.readEntry();
          return;
        }

        const buffer = await readEntry(zipFile, entry);
        entries.push({
          entryPath,
          buffer,
          size: entry.uncompressedSize ?? buffer.length,
        });
        zipFile.readEntry();
      } catch (error) {
        rejectEntries(error);
      }
    });

    zipFile.on('end', () => {
      zipFile.close();
      resolveEntries(entries);
    });
    zipFile.on('error', rejectEntries);
    zipFile.readEntry();
  });
}

function findDefaultVsixPath() {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const stableName = `tokengauge-vscode-${packageJson.version}.vsix`;
  if (existsSync(stableName)) {
    return stableName;
  }

  const candidates = readdirSync('.')
    .filter((entry) => entry.endsWith('.vsix'))
    .map((entry) => ({ entry, mtimeMs: statSync(entry).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No VSIX path provided and ${stableName} does not exist.`);
  }
  if (candidates.length > 1) {
    console.error(`Warning: multiple VSIX files found; using ${candidates[0].entry}`);
  }
  return candidates[0].entry;
}

function scanPath(entryPath, violations) {
  const lower = entryPath.toLowerCase();
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.test(lower)) {
      violations.push({ ruleName: rule.name, entryPath });
    }
  }
  if (!isAllowed(entryPath)) {
    violations.push({ ruleName: 'unexpected-entry', entryPath });
  }
}

function scanContent(entry, violations) {
  const extension = extname(entry.entryPath).toLowerCase();
  if (!TEXT_EXTS.has(extension) || entry.size > MAX_TEXT_BYTES) {
    return;
  }

  const content = entry.buffer.toString('utf8');
  if (content.includes(SELF_SKIP_MARKER)) {
    return;
  }

  for (const pattern of [...FORBIDDEN_CONTENT_PATTERNS, PROMPT_SHAPE_PATTERN]) {
    if (pattern.skipExts?.includes(extension)) {
      continue;
    }
    if (pattern.re.test(content)) {
      violations.push({ ruleName: pattern.name, entryPath: entry.entryPath });
    }
  }
}

function scanRequiredEntries(entries, violations) {
  const lowerEntryPaths = entries.map((entry) => entry.entryPath.toLowerCase());
  for (const required of REQUIRED_ENTRIES) {
    if (!lowerEntryPaths.some(required.test)) {
      violations.push({
        ruleName: `missing-${required.name}`,
        entryPath: required.pathLabel,
      });
    }
  }
}

// Assert each required entry CONTAINS its current copy sentinels.
// A missing target entry or any absent sentinel is a violation. Output is
// counts/booleans only — the matched copy is never emitted.
function scanRequiredContent(entries, violations) {
  for (const required of REQUIRED_CONTENT) {
    const target = entries.find((entry) => required.test(entry.entryPath.toLowerCase()));
    if (target === undefined) {
      violations.push({ ruleName: `missing-${required.name}`, entryPath: required.pathLabel });
      continue;
    }
    const content = target.buffer.toString('utf8');
    const missing = required.sentinels.filter((sentinel) => !content.includes(sentinel));
    if (missing.length > 0) {
      violations.push({
        ruleName: `stale-${required.name}`,
        entryPath: `${required.pathLabel} (missing ${missing.length}/${required.sentinels.length} sentinels)`,
      });
    }
  }
}

async function main() {
  const requestedPath = process.argv[2] ?? findDefaultVsixPath();
  const vsixPath = resolve(requestedPath);
  const entries = await readZipEntries(vsixPath);
  const violations = [];

  for (const entry of entries) {
    scanPath(entry.entryPath, violations);
    scanContent(entry, violations);
  }
  scanRequiredEntries(entries, violations);
  scanRequiredContent(entries, violations);

  if (violations.length > 0) {
    console.error('VSIX audit failed:');
    for (const violation of violations) {
      console.error(`  [${violation.ruleName}] ${violation.entryPath}`);
    }
    process.exit(1);
  }

  console.log(`OK: audit-vsix passed (${entries.length} entries inspected)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
