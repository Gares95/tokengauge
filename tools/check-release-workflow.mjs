// Blocking release-workflow static gate.
//
// Statically enforces the locked release posture of .github/workflows/release.yml:
//   - tag-only `v*` trigger, no pull_request/branch/schedule/dispatch trigger
//   - workflow-level permissions are exactly `contents: read`
//   - no `id-token: write` anywhere (no Marketplace OIDC claim)
//   - every `uses:` ref is a full-length 40-hex commit SHA
//   - the GitHub Release asset job uses environment `tokengauge-release`
//   - optional Marketplace/Open VSX jobs are opt-in (explicit vars), use the
//     environment, and bind PAT env names VSCE_PAT / OVSX_PAT
//   - every `gh release create`/`gh release upload` step binds GH_TOKEN or
//     GITHUB_TOKEN to ${{ github.token }}
//
// Deferred-release mode: while no release workflow exists yet (release
// automation is added at release time, not before), the gate passes ONLY when
// a verification workflow is present and no workflow in the repo contains a
// publish-capable step. The moment a release workflow appears, the full strict
// posture above applies. A workflow named explicitly via --file must exist.
//
// This is a line/structural parser, NOT a full YAML parser — the workflow is
// authored to a known shape and the gate cross-checks that shape. On failure it
// reports rule names and the relative file path ONLY, never matched content.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const fileArgIndex = process.argv.indexOf('--file');
const rootArgIndex = process.argv.indexOf('--root');
const repoRoot =
  rootArgIndex !== -1 && process.argv[rootArgIndex + 1]
    ? resolve(process.argv[rootArgIndex + 1])
    : resolve(import.meta.dirname, '..');
const explicitFile = fileArgIndex !== -1 && Boolean(process.argv[fileArgIndex + 1]);
const workflowPath = explicitFile
  ? resolve(process.argv[fileArgIndex + 1])
  : resolve(repoRoot, '.github/workflows/release.yml');

const reportPath = relative(repoRoot, workflowPath) || workflowPath;
const violations = [];

function fail(rule) {
  violations.push(rule);
}

// Strip whole-line comments so documentation prose (which may name forbidden
// patterns to explain why they are banned) never trips a scan.
function stripCommentLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => (/^\s*#/.test(l) ? '' : l))
    .join('\n');
}

if (!existsSync(workflowPath)) {
  if (explicitFile) {
    console.error('Release workflow gate violations:');
    console.error(`  [missing-release-workflow] ${reportPath}`);
    process.exit(1);
  }
  // Deferred-release mode: acceptable only while CI stays verify-only.
  const workflowsDir = resolve(repoRoot, '.github/workflows');
  const workflowFiles = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];
  const deferredViolations = [];
  if (workflowFiles.length === 0) {
    deferredViolations.push('missing-verify-workflow');
  }
  const PUBLISH_CAPABLE = [
    /vsce\s+publish/i,
    /ovsx\s+publish/i,
    /VSCE_PAT/,
    /OVSX_PAT/,
    /gh release (create|upload)/,
    /id-token\s*:\s*write/,
  ];
  for (const file of workflowFiles) {
    const content = stripCommentLines(readFileSync(join(workflowsDir, file), 'utf8'));
    if (PUBLISH_CAPABLE.some((re) => re.test(content))) {
      deferredViolations.push('publish-capable-workflow-without-release-gate');
      break;
    }
  }
  if (deferredViolations.length > 0) {
    console.error('Release workflow gate violations:');
    for (const rule of [...new Set(deferredViolations)]) {
      console.error(`  [${rule}] ${reportPath}`);
    }
    process.exit(1);
  }
  console.log(
    'OK: release workflow gate passed (release workflow deferred; verification workflow present, no publish-capable steps)',
  );
  process.exit(0);
}

const rawWithComments = readFileSync(workflowPath, 'utf8');
// Strip whole-line comments so documentation prose (which intentionally names
// forbidden patterns like `id-token: write` to explain why they are banned)
// never trips a rule. Inline `#` after a value is left intact — workflow values
// here do not use trailing comments, and stripping mid-line risks corrupting a
// `run:` shell line that contains `#`.
const raw = rawWithComments
  .split(/\r?\n/)
  .map((l) => (/^\s*#/.test(l) ? '' : l))
  .join('\n');
const lines = raw.split(/\r?\n/);

// Returns the indentation (leading-space count) of a line.
function indentOf(line) {
  const match = line.match(/^( *)/);
  return match ? match[1].length : 0;
}

// --- id-token-write-forbidden: no OIDC token request anywhere. -------------
if (/id-token\s*:\s*write/.test(raw)) {
  fail('id-token-write-forbidden');
}

// --- trigger-not-tag-only: only push.tags v* may trigger. ------------------
// Find the top-level `on:` block (indent 0) and capture its body.
function topLevelBlock(name) {
  const start = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (start === -1) {
    return null;
  }
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push(line);
      continue;
    }
    if (indentOf(line) === 0) {
      break;
    }
    body.push(line);
  }
  return body;
}

const onBlock = topLevelBlock('on');
if (onBlock === null) {
  fail('trigger-not-tag-only');
} else {
  const onText = onBlock.join('\n');
  const hasPush = /^\s*push\s*:/m.test(onText);
  const hasTags = /^\s*tags\s*:/m.test(onText);
  const hasVStar = /['"]?v\*['"]?/.test(onText);
  const forbiddenTriggers = [
    /^\s*pull_request\s*:/m,
    /^\s*schedule\s*:/m,
    /^\s*workflow_dispatch\s*:/m,
  ];
  const hasBranchTrigger = /^\s*branches\s*:/m.test(onText);
  const hasForbidden = forbiddenTriggers.some((re) => re.test(onText)) || hasBranchTrigger;
  if (!hasPush || !hasTags || !hasVStar || hasForbidden) {
    fail('trigger-not-tag-only');
  }
}

// --- workflow-permissions-not-read: top-level permissions are contents:read.
const permsBlock = topLevelBlock('permissions');
if (permsBlock === null) {
  fail('workflow-permissions-not-read');
} else {
  const permLines = permsBlock.map((l) => l.trim()).filter((l) => l.length > 0);
  const onlyContentsRead = permLines.length === 1 && /^contents\s*:\s*read$/.test(permLines[0]);
  if (!onlyContentsRead) {
    fail('workflow-permissions-not-read');
  }
}

// --- action-not-sha-pinned: every `uses:` is a 40-hex SHA. ------------------
const usesLines = lines.filter((l) => /^\s*-?\s*uses\s*:/.test(l));
for (const line of usesLines) {
  const refMatch = line.match(/uses\s*:\s*\S+@(\S+)/);
  if (!refMatch || !/^[0-9a-f]{40}$/.test(refMatch[1])) {
    fail('action-not-sha-pinned');
    break;
  }
}

// --- Job-level analysis. Split into jobs by indent-2 job keys under `jobs:`.
function parseJobs() {
  const jobsStart = lines.findIndex((l) => l.startsWith('jobs:'));
  if (jobsStart === -1) {
    return [];
  }
  const jobs = [];
  let current = null;
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      if (current) {
        current.body.push(line);
      }
      continue;
    }
    const indent = indentOf(line);
    if (indent === 0) {
      break;
    }
    // A job key sits at indent 2: `  job-name:`.
    if (indent === 2 && /^\s{2}[A-Za-z0-9_-]+\s*:\s*$/.test(line)) {
      current = { name: line.trim().replace(/:$/, ''), body: [] };
      jobs.push(current);
      continue;
    }
    if (current) {
      current.body.push(line);
    }
  }
  return jobs;
}

const jobs = parseJobs();

function jobUsesReleaseEnvironment(job) {
  return job.body.some((l) => /^\s*environment\s*:\s*tokengauge-release\s*$/.test(l));
}

function jobBodyText(job) {
  return job.body.join('\n');
}

// --- release-job-missing-environment: the GitHub Release asset job (one that
// runs `gh release create`/`upload`) must use the protected environment.
const releaseJobs = jobs.filter((job) => /gh release (create|upload)/.test(jobBodyText(job)));
if (releaseJobs.length === 0) {
  fail('release-job-missing-environment');
}
for (const job of releaseJobs) {
  if (!jobUsesReleaseEnvironment(job)) {
    fail('release-job-missing-environment');
    break;
  }
}

// --- gh-release-missing-github-token: every step that runs a gh release
// create/upload must explicitly bind GH_TOKEN or GITHUB_TOKEN to github.token.
// We split each release job into steps (indent-6 `- ` items) and check each
// step that contains a gh release command for an explicit token env binding.
function splitSteps(job) {
  const steps = [];
  let current = null;
  for (const line of job.body) {
    if (/^\s{6}-\s/.test(line)) {
      current = [line];
      steps.push(current);
      continue;
    }
    if (current) {
      current.push(line);
    }
  }
  return steps;
}

for (const job of releaseJobs) {
  for (const step of splitSteps(job)) {
    const text = step.join('\n');
    if (!/gh release (create|upload)/.test(text)) {
      continue;
    }
    const bindsToken =
      /GH_TOKEN\s*:\s*\$\{\{\s*github\.token\s*\}\}/.test(text) ||
      /GITHUB_TOKEN\s*:\s*\$\{\{\s*github\.token\s*\}\}/.test(text);
    if (!bindsToken) {
      fail('gh-release-missing-github-token');
      break;
    }
  }
}

// --- publish-job-not-opt-in-gated: optional Marketplace/Open VSX jobs must be
// disabled by default via an explicit var gate, use the protected environment,
// and bind the matching PAT env name. We key off the PAT env names so the
// check finds the publish jobs regardless of their job key.
const PUBLISH_SPECS = [
  { pat: 'VSCE_PAT', varName: 'TOKENGAUGE_ENABLE_MARKETPLACE_PUBLISH' },
  { pat: 'OVSX_PAT', varName: 'TOKENGAUGE_ENABLE_OPEN_VSX_PUBLISH' },
];
for (const spec of PUBLISH_SPECS) {
  const publishJobs = jobs.filter((job) => jobBodyText(job).includes(spec.pat));
  for (const job of publishJobs) {
    const text = jobBodyText(job);
    const varGated = new RegExp(`${spec.varName}\\s*==\\s*'true'`).test(text);
    const usesEnv = jobUsesReleaseEnvironment(job);
    if (!varGated || !usesEnv) {
      fail('publish-job-not-opt-in-gated');
      break;
    }
  }
}

if (violations.length > 0) {
  const unique = [...new Set(violations)];
  console.error('Release workflow gate violations:');
  for (const rule of unique) {
    console.error(`  [${rule}] ${reportPath}`);
  }
  process.exit(1);
}

console.log('OK: release workflow gate passed');
