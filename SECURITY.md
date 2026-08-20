# Security Policy

TokenGauge is a local-first VS Code extension. Its security policy starts with
private reporting and supported versions, then documents the verification and
release controls maintainers apply before publishing.

## Report a Vulnerability

Report vulnerabilities through **GitHub Security Advisories**. Do not file a
public issue for an unfixed vulnerability.

When reporting, include the affected version, operating system, VS Code host
type (local, WSL, Remote-SSH, or Dev Container), and a minimal reproduction if
one is available. Do not include secrets, tokens, raw provider payloads, account
identifiers, private paths, prompts, transcripts, or terminal output. Use
placeholders for sensitive values.

## Response Expectations

Security reports are reviewed by the project owner. High-impact issues affecting
runtime security, credential handling, privacy boundaries, packaging, or release
integrity are prioritized over ordinary feature work.

If you need to follow up publicly, open an issue that says a private security
advisory is pending, without technical details.

## Supported Versions

Security fixes target the latest published TokenGauge version and the current
`main` branch. Older pre-release builds and locally modified VSIX files are not
maintained as separate support lines.

## What TokenGauge Protects

TokenGauge's security posture is tied to its privacy model:

- TokenGauge asks for no provider API keys and stores no provider credentials.
- TokenGauge makes no outbound network calls by default.
- The Codex native probe is explicit opt-in and runs the user's local `codex`
  process only when the Codex card is visible.
- Diagnostics and issue templates are designed to avoid raw payloads, prompts,
  transcripts, account data, and raw paths.
- Release and package checks fail closed when private files, generated assets,
  or publish-capable automation appear in the wrong place.

See [PRIVACY.md](PRIVACY.md) for the exact data boundary.

## Dependency Vulnerability Policy

CI runs `npm audit --omit=dev --audit-level=high` against the production
dependency graph. Advisories with severity `high` or `critical` block the build.
Lower severities are reported informationally unless they affect extension
runtime security, secrets handling, packaging, release integrity, or log/privacy
boundaries.

A human reviewer decides whether an advisory below `high` still blocks a pull
request under this policy.

GitHub Dependency Review Action is deferred until GitHub Code Security /
Advanced Security is enabled for this repository. Runtime dependency audit
remains enforced by CI.

## Code Scanning Posture

CodeQL code scanning and GitHub Dependency Review Action are deferred until Code
Security / Advanced Security is available for this repository; they should be
enabled at that point. Dependency graph and Dependabot are expected to be
enabled in repository settings.

## Supply-Chain Posture

Every production dependency is exact-pinned. The `package-lock.json` is
committed, and CI installs with `npm ci`. Third-party GitHub Actions in the
verification workflow are pinned to exact release versions, for example
`actions/checkout@v4.2.2` and `actions/setup-node@v4.1.0`, not floating
major-version tags. Commit-SHA pinning is reserved for the future release
workflow.

## Packaging Posture

The `package:vsix` npm script passes `--allow-missing-repository` defensively so
local packaging works in contributor checkouts, forks, and detached worktrees.
The `repository.url` in `package.json` remains the canonical source of truth;
future release automation relies on it directly.

## Release Workflow Posture

TokenGauge's release posture is **GitHub Release first**. The default release
output is a VSIX attached to a GitHub Release together with its SHA-256 checksum
and install/verification instructions.

**The release workflow itself is deferred until release time.** This repository
currently ships a verify-only CI workflow and no publish-capable automation. A
static gate (`check:release-workflow`) enforces exactly that: while no release
workflow exists it verifies CI stays verify-only, and the moment a release
workflow is added it enforces the locked posture below.

- **Tag-only trigger.** The release workflow runs only on `v*` tags. It never
  runs on pull requests, and no publish-capable step runs on a pull request.
- **GitHub Environment approval.** Build and audit jobs may run on a tag before
  approval, but any GitHub Release asset creation or publish-capable job waits
  for required-reviewer approval through a protected GitHub Environment.
- **SHA-pinned release actions.** Third-party GitHub Actions used in the release
  workflow are pinned to commit SHAs.
- **Credential isolation.** Publishing credentials must never enter the
  repository, issues, chats, planning records, CI logs, shell history, release
  assets, or package contents. Do not ask contributors to provide secret values,
  recovery information, session cookies, or token examples.
- **Manual first Marketplace publication.** Initial Visual Studio Marketplace
  publication uses owner-authenticated manual upload of one preverified VSIX.
  Future automated Marketplace publishing, if separately approved, must follow
  the official Marketplace authentication guidance current at that time.
- **Open VSX is separate.** Open VSX credentials and publication remain
  separately authorized. No Open VSX credential may be added merely because
  Marketplace publication is approved.
- **No unsupported publishing claim.** TokenGauge makes no Marketplace,
  Open VSX, OIDC-based Marketplace, or automated publishing claim that the
  workflow does not actually satisfy.
- **Best-effort reproducibility.** The workflow performs a best-effort
  reproducibility check; unexplained drift fails the workflow, while documented
  exception categories, such as timestamps or tool metadata, may be allowed.
