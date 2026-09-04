# Changelog

All notable changes to TokenGauge will be documented here. This project adheres
to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added **TokenGauge: Run Source Doctor**, a readonly, local-only, provider-neutral setup-health report for unavailable, stale, blocked, or incomplete native source cards. It reports sanitized rule IDs, settings scopes, closed categories, and next actions without reading logs, writing settings, synthesizing usage, or running a Codex probe by itself.

## [0.0.4] - 2026-08-21

### Added

- Added **TokenGauge: Set Up Claude statusLine**, which writes the canonical
  Node statusLine writer, validates it, configures TokenGauge's snapshot path,
  and shows the exact Claude Code `statusLine.command` JSON to paste. TokenGauge
  still does not edit `~/.claude/settings.json`.
- Added a compact terminal statusLine readout from the canonical writer, so the
  same setup that feeds the cockpit can also show the provider-reported 5h and
  weekly windows in Claude Code's terminal status line.
- Added setup guidance for Windows and WSL workflows while keeping the README as
  the concise setup authority.

### Changed

- Moved the canonical statusLine writer body into
  `docs/claude-statusline-writer.md` and kept it byte-identical to the shipped
  writer asset.
- Clarified native-source freshness, multiple-writer behavior, missing
  `rate_limits` states, and why TokenGauge uses local native surfaces rather
  than provider credentials or conversation logs.
- Reworked README, troubleshooting, SECURITY, and PRIVACY guidance for cleaner
  public onboarding and reader-first privacy/security reporting.

### Fixed

- The status bar now shows Codex's promoted weekly-only window when the local
  app-server reports weekly usage without a short window.
- The setup command now reports writer, validation, and settings-scope failures
  more directly.
- Release-documentation checks now protect the canonical writer location,
  freshness caveats, setup claims, packaged-link posture, and public-clean
  documentation boundaries.

### Migration notes

- Visual Studio Marketplace users upgrade from 0.0.2 straight to 0.0.4, because
  0.0.3 was published as a GitHub release only. The 0.0.3 notes below describe
  changes you also receive in this update.
- If you copied an older TokenGauge statusLine writer, refresh it before using
  v0.0.4. Run **TokenGauge: Set Up Claude statusLine** again, or replace your
  local writer with the current copy from
  [docs/claude-statusline-writer.md](docs/claude-statusline-writer.md).
- Review and merge the displayed `statusLine.command` into
  `~/.claude/settings.json` yourself. TokenGauge does not edit that file.
- The TokenGauge snapshot setting should point to the JSON snapshot file or
  per-session snapshot directory, not to the writer script.

### Security and maintenance

- Current full npm audit: zero vulnerabilities.
- Current production npm audit: zero vulnerabilities.

## [0.0.3] - 2026-08-08

### Fixed

- Manual Refresh now clears retained Codex probe state before forcing a fresh
  Codex native-status probe, matching the settings toggle behavior without
  requiring the user to disable and re-enable the probe.
- Codex app-server responses that expose recognized usage windows through
  `rateLimitsByLimitId` are accepted when direct rate-limit slots contain no
  recognized window, while duplicate recognized fallback windows still fail
  closed.

### Changed

- README installation and project-status wording now reflects the existing
  GitHub Releases and Visual Studio Marketplace publication.

### Security and maintenance

- Development and test tooling maintenance updated `@vscode/test-electron` to
  3.1.0 and refreshed affected dev-only transitive packages, including
  `linkify-it`, `brace-expansion`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`,
  and `undici`.
- Current full npm audit: zero vulnerabilities.
- Current production npm audit: zero vulnerabilities.

## [0.0.2] - 2026-07-16

### Added

- Support for Codex weekly-only status.
- Support for Codex short-window-only status.
- Promotion of the Weekly meter to the primary position when the short window is absent.
- Preservation of the existing two-window layout when both Codex windows exist.

### Changed

- Permanent Marketplace publisher identity changed before first publication to `gares-extensions`.
- Final extension ID is `gares-extensions.tokengauge-vscode`.
- Vite updated to 6.4.3.
- Vite's nested esbuild updated to 0.25.12.
- Deterministic webview JavaScript and CSS rebuilt.

### Security and maintenance

- Low-risk development-dependency patches.
- Temporary secure Mocha-scoped overrides for `serialize-javascript` 7.0.5 and `diff` 8.0.3.
- Current full npm audit: zero vulnerabilities.
- Current production npm audit: zero vulnerabilities.
- Current open Dependabot alerts: zero.
- Current dismissed Dependabot alerts: zero.

## [0.0.1] - 2026-07-15

First release line: a **native-only, privacy-first** multi-agent gauge cockpit.

- **Native multi-agent cockpit.** Claude Code and Codex appear as first-class
  per-agent gauge cards with plain-language provenance and freshness badges.
  Raw source, freshness, and accuracy metadata is available in Diagnostics.
- **Claude native snapshots.** Reads a passive local statusLine snapshot your
  own statusLine writer produces (opt-in bridge) plus per-model cost and model
  information from the local `stats-cache.json` cache.
- **Codex native app-server probe.** On explicit opt-in (off by default), asks
  the local `codex app-server` for account rate-limit information. The initial
  implementation recognized the account-window pair available during v0.0.1
  validation; different bucket shapes showed unavailable/unsupported instead of
  guessed values. Nothing is spawned while it is off or while the Codex card is
  hidden.
- **Honest states.** Missing native data reads unknown/unavailable; missing cost
  reads `cost unknown`. TokenGauge never reconstructs, estimates, or synthesizes
  values it cannot read natively.
- **Secret handling, diagnostics, and Command Palette workflows.** TokenGauge
  stores no API keys or provider credentials; the local install salt lives only
  in VS Code SecretStorage via `SecretManager`; redacted cockpit diagnostics and
  a privacy report; release-docs and release-workflow safety gates (release
  automation itself is added at release time).

Posture for this release:

- No developer-controlled telemetry; no outbound network by default.
- GitHub Release distribution was the first release channel; Marketplace and Open VSX publication were deferred.
- Every metric is accuracy-labeled; native-reported values are never presented as provider billing data.
- TokenGauge stores no API keys or provider credentials; the local install salt lives only in VS Code SecretStorage via `SecretManager`.

Internal cleanup (native-only reset):

- Removed the log-derived ingestion subsystem, the JSONL `UsageStore` and its
  `PrivacyGuard` write chokepoint, the cost engine and tokenizers, the synthetic
  observed-limit estimator and the `estimated`/`log_derived` taxonomy, and the
  inert threshold-notification settings. Each removal is protected by a negative
  CI guard. None of these were ever shipped as product features. See
  [ADR-004](docs/adr/ADR-004-native-only-privacy-model.md).

[Unreleased]: https://github.com/Gares95/tokengauge/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/Gares95/tokengauge/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Gares95/tokengauge/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/Gares95/tokengauge/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Gares95/tokengauge/releases/tag/v0.0.1
