# Contributing to TokenGauge

Thanks for your interest in TokenGauge. This project is privacy-first and honesty-first; contributions are expected to uphold both. The rules every change must follow are captured in this document and in the project's [PRIVACY.md](PRIVACY.md), [ACCURACY.md](ACCURACY.md), and [SECURITY.md](SECURITY.md); please read them before opening a change.

## Verification commands

Every change must pass these before review. Run them locally:

```bash
npm run lint        # Biome lint + format check
npm run typecheck   # tsc --noEmit type check
npm run test        # Mocha unit, privacy, and integration tests via @vscode/test-cli
npm run check       # Full validation suite (lint, typecheck, privacy gates, manifest checks, tests)
npm run verify:vsix # Package the VSIX and run the packaged-content privacy audit
```

Use the smallest atomic gate while iterating (`lint`, `typecheck`, `npm test`, or direct `test:*` labels). For final local validation, run `npm run check` and `npm run verify:vsix`; `npm run check` already includes `npm test`, so running `npm test` immediately before it duplicates the three extension-host launches unless you are gathering separate timing or debugging a test failure.

`npm run check` is the authoritative local aggregate gate. PR CI runs core validation as explicit workflow steps instead of invoking that script directly, so local behavior can look different from CI even when coverage intent is the same. If a gate disagrees with your code, the gate wins. Fix the code, do not bypass the gate. Never use `--no-verify` or any hook bypass.

### Local VS Code test windows

Local validation may open several VS Code windows. This is expected with the current test topology: each `vscode-test` label starts a fresh extension host.

- `npm test` compiles tests, builds the extension, then runs three `vscode-test` labels: `unit`, `privacy`, and `integration`. Expect three VS Code extension-host launches.
- `npm run check` includes `npm test`, then runs the packaged activation/performance gate. Expect four VS Code extension-host launches: the same three labels plus one filtered `integration` run for `Activation budget` and `Adapter endurance`.
- `npm run verify:vsix` packages the VSIX and runs the packaged-content privacy audit. It does not launch VS Code.

Running `npm test` and then `npm run check` during final validation can therefore show about seven local VS Code windows. Prefer `npm run check` alone for the full aggregate gate, then `npm run verify:vsix` for packaged-content validation. Do not weaken or skip tests to reduce that count; safe consolidation of the test topology may be evaluated separately. Direct `test:*` labels execute compiled tests from `out/`, so they run a stale-output guard first; if it reports missing or stale output, run `npm run clean && npm run compile-tests` before retrying the direct label.

CI runs the same extension-host labels (`unit`, `privacy`, and `integration`) as explicit workflow steps on Ubuntu, macOS, and Windows. Linux CI wraps those labels in `xvfb-run`; local managed/sandboxed terminals may need host execution if VS Code startup fails with a `/run/user` socket or read-only filesystem error. Treat that as an environment issue and rerun the same command from a normal host terminal instead of skipping tests.

## Privacy rules

These are non-negotiable and enforced mechanically:

- **Native-only, no usage persistence.** TokenGauge keeps no usage store and writes no usage-history database; native values are read at display time. The cockpit may keep sanitized display state in VS Code webview state while the view is active or restored. The `check:no-log-ingestion` and `check:no-old-usage-model` guards enforce that the removed ingestion/storage path cannot return.
- **SecretManager is the only path to SecretStorage.** No raw `context.secrets.get/set` calls in adapter or feature code.
- **Never persist forbidden content:** prompts, completions, source code, file contents, terminal output, tool arguments or results, environment variables, OAuth tokens, cookies, raw transcripts, git remote URLs, or raw paths.
- **No outbound network except user-configured endpoints.** No telemetry, no discovery, no auto-update pings.
- **Accuracy labels propagate.** A value derived from a `proxy_reported` input cannot be labeled `exact` or `billing_authoritative`. Use `Accuracy.combine()`.
- **Diagnostics and reports stay redacted.** They expose statuses, rule IDs, counts, source kinds, and redacted paths only, never raw log content, secrets, or stack traces.

## Code conventions

- Default to no comments; only document the non-obvious WHY.
- No abstraction without three concrete uses.
- Validate at system boundaries (user input, external APIs, parsed logs, parsed config) with `zod`. Trust your own modules.
- No agent/runtime markers in code or commit messages.

## Commits

Use Conventional Commits: `type(scope): subject` with an imperative subject (`add`, not `added`). One logical change per commit; each commit must build and pass tests. Commit history must be agent-agnostic, with no attribution or runtime markers.

## Screenshots

Before committing any image, follow
[docs/screenshot-capture-checklist.md](docs/screenshot-capture-checklist.md):
captures come from the installed VSIX, in both themes, fully redacted.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Report vulnerabilities through GitHub Security Advisories, not public issues.
