# Security Policy

## Reporting a Vulnerability

Please report vulnerabilities through GitHub Security Advisories. Do not file public issues for unfixed vulnerabilities.

## Dependency Vulnerability Policy

We run `npm audit --omit=dev --audit-level=high` against the production dependency graph in CI. Advisories with severity `high` or `critical` block the build. Lower severities are reported informationally only.

An advisory of any severity that affects extension runtime security, secrets handling, packaging, or log parsing blocks the build regardless of severity. A human reviewer interprets this policy on the pull request.

GitHub Dependency Review Action is deferred until GitHub Code Security / Advanced Security is enabled for this repository. Runtime dependency audit remains enforced by CI.

## Code Scanning Posture

CodeQL code scanning and GitHub Dependency Review Action are deferred until Code Security / Advanced Security is available for this repository; they should be enabled at that point. Dependency graph and Dependabot are expected to be enabled in repository settings; `npm audit --omit=dev --audit-level=high` remains the enforced dependency vulnerability gate in CI.

## Supply-chain Posture

Every production dependency is exact-pinned. The `package-lock.json` is committed. CI installs via `npm ci`. Third-party GitHub Actions in the verification workflow are pinned to exact release versions (for example `actions/checkout@v4.2.2`, `actions/setup-node@v4.1.0`), not floating major-version tags; commit-SHA pinning is reserved for the future release workflow.

## Packaging Posture

The `package:vsix` npm script passes `--allow-missing-repository` defensively so local packaging works in any contributor checkout, including forks or detached worktrees where the `repository` field may differ. The `repository.url` in `package.json` is the canonical source of truth; the release automation, when added, relies on it directly.

## Release Workflow Posture

TokenGauge's planned release posture is **GitHub Release first**. The default output of a release will be a VSIX attached to a GitHub Release together with its SHA-256 checksum and install/verification instructions.

**The release workflow itself is deferred until release time.** This repository currently ships a verify-only CI workflow and no publish-capable automation. A static gate (`check:release-workflow`) enforces exactly that: while no release workflow exists it verifies CI stays verify-only, and the moment a release workflow is added it enforces the full locked posture below.

- **Tag-only trigger.** The release workflow runs only on `v*` tags. It never runs on pull requests, and no publish-capable step runs on a pull request.
- **GitHub Environment approval.** Build and audit jobs may run on a tag before approval, but any GitHub Release asset creation or publish-capable job waits for required-reviewer approval through a protected GitHub Environment.
- **SHA-pinned release actions.** Third-party GitHub Actions used in the release workflow are pinned to commit SHAs.
- **Optional Marketplace and Open VSX paths.** Publishing to the VS Code Marketplace (via `vsce`) and to Open VSX (via `ovsx`) are OPTIONAL, secret-gated paths. They use Environment-protected Personal Access Token secrets and never run automatically just because a secret is present.
- **No unsupported publishing claim.** TokenGauge makes no Marketplace, Open VSX, or OIDC publishing claim that the workflow does not actually satisfy. TokenGauge does not use or claim OIDC for VS Code Marketplace publishing; Marketplace and Open VSX publishing, when performed, are PAT-gated.
- **Best-effort reproducibility.** The workflow performs a best-effort reproducibility check; unexplained drift fails the workflow, while documented exception categories (such as timestamps or tool metadata) may be allowed.
