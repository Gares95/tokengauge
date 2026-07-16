# Changelog

All notable changes to TokenGauge will be documented here. This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.2

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

## 0.0.1

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
