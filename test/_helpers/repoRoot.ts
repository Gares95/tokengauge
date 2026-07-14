import * as fs from 'node:fs';
import * as path from 'node:path';

// Walks up from __dirname (a known location inside the compiled test tree)
// until it finds a package.json whose `name` is the extension manifest's name.
// Independent of process.cwd(), which is not the repo root when VS Code's
// extension host launches tests via @vscode/test-electron — on Windows it
// resolves to the unpacked VS Code archive directory.
const EXTENSION_PKG_NAME = 'tokengauge-vscode';

export function findRepoRoot(startDir: string = __dirname): string {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg.name === EXTENSION_PKG_NAME) return dir;
      } catch {
        // Unreadable or non-JSON file at this level; keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `findRepoRoot: could not locate package.json with name "${EXTENSION_PKG_NAME}" walking up from ${startDir}`,
      );
    }
    dir = parent;
  }
}

export interface ManifestConfigurationBlock {
  readonly title?: string;
  readonly order?: number;
  readonly properties?: Record<string, { default?: unknown; title?: string }>;
}

export function readManifest(): {
  contributes?: {
    viewsContainers?: {
      activitybar?: Array<{ id?: string; title?: string; icon?: string }>;
    };
    views?: {
      tokenGauge?: Array<{
        id?: string;
        name?: string;
        contextualTitle?: string;
        type?: string;
        visibility?: string;
      }>;
    };
    configuration?: ManifestConfigurationBlock | ManifestConfigurationBlock[];
  };
} {
  const manifestPath = path.join(findRepoRoot(), 'package.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function manifestConfigurationBlocks(
  manifest: ReturnType<typeof readManifest>,
): ManifestConfigurationBlock[] {
  const configuration = manifest.contributes?.configuration;
  if (Array.isArray(configuration)) return configuration;
  return configuration ? [configuration] : [];
}

export function manifestConfigurationProperties(
  manifest: ReturnType<typeof readManifest>,
): Record<string, { default?: unknown; title?: string }> {
  return Object.assign(
    {},
    ...manifestConfigurationBlocks(manifest).map((block) => block.properties ?? {}),
  );
}
