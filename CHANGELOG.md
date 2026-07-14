# Changelog

All notable changes to TokenGauge will be documented here. This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1

First release line: a **native-only, privacy-first** multi-agent gauge cockpit.

- **Native multi-agent cockpit.** Claude Code and Codex appear as first-class
  per-agent gauge cards with plain-language provenance and freshness badges.
  Raw source, freshness, and accuracy metadata is available in Diagnostics.
- **Claude native snapshots.** Reads a passive local statusLine snapshot your
  own statusLine writer produces (opt-in bridge) plus per-model cost and model
  information from the local `stats-cache.json` cache.
- **Codex native app-server probe.** On explicit opt-in (off by default), asks
  the local `codex app-server` for account rate-limit information. This version
  recognizes the tested 5-hour and 7-day account-window shape; different bucket
  shapes show unavailable/unsupported instead of guessed values. Nothing is
  spawned while it is off or while the Codex card is hidden.
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
- GitHub Release first distribution is planned; Marketplace and Open VSX publishing are optional PAT-gated paths.
- Every metric is accuracy-labeled; native-reported values are never presented as provider billing data.
- TokenGauge stores no API keys or provider credentials; the local install salt lives only in VS Code SecretStorage via `SecretManager`.

Internal cleanup (native-only reset):

- Removed the log-derived ingestion subsystem, the JSONL `UsageStore` and its
  `PrivacyGuard` write chokepoint, the cost engine and tokenizers, the synthetic
  observed-limit estimator and the `estimated`/`log_derived` taxonomy, and the
  inert threshold-notification settings. Each removal is protected by a negative
  CI guard. None of these were ever shipped as product features. See
  [ADR-004](docs/adr/ADR-004-native-only-privacy-model.md).
