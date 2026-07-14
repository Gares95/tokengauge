# ADR-004: Native-only privacy model

**Status:** Accepted (2026-06-26)

This is the canonical statement of TokenGauge's v1 architecture: a native-only,
privacy-first cockpit.

## Context

TokenGauge began with a dual architecture: a native-usage-first cockpit plus a
log-derived ingestion subsystem (log parsers, an `UsageStore`, a cost engine,
tokenizers, an observed-limit estimator, and threshold notifications) that
reconstructed usage from AI-agent conversation logs as a fallback. The
reconstruction path carried real privacy weight (it read agent log directories),
was never the trustworthy source, and competed with the native surfaces the
product actually leads with.

## Decision

**TokenGauge is native-only and privacy-first for v1.** It reports
native/provider-visible status or honest unknown/unavailable. It never
reconstructs, estimates, or synthesizes usage/limit data. Native visible status
is the primary and only cockpit source; conversation logs are not read at all,
not even as a fallback.

The extension works exclusively through:

- the **Claude Code statusLine / native snapshot bridge** (a passive local
  snapshot the user's own statusLine writer produces) plus the local
  `stats-cache.json` cache, read for per-model cost and model information;
- the **Codex local app-server / native structured rate-limit probe** (explicit
  opt-in, off by default);
- honest **unknown / unavailable** states when native data is absent, stale, or
  incomplete.

TokenGauge MUST NOT:

- parse AI-agent conversation logs for usage reconstruction, or perform any
  prompt / transcript / log-derived token calculation;
- expose log-ingestion modes or broad-log-root scanning;
- persist usage events to a JSONL `UsageStore` (or any usage store);
- run a cost engine, tokenizer, or synthetic observed-limit estimator that
  fabricates numbers the native source did not report;
- ship threshold notifications as a v1 capability;
- present any value as stronger than its source.

Unknown/unavailable is always preferred over reconstruction.

## What this removed

The earlier dual architecture was reduced to the native-only model above. The
following were removed, and each removal is protected by a negative CI guard so
it cannot silently return:

- the log-derived ingestion surface (log parsers, fingerprints, log adapters,
  and the adapter registry/supervisor), the `UsageStore`/JSONL persistence and
  its write chokepoint, the cost engine, the tokenizers, the usage-snapshot UI,
  and the usage export;
- the `log_derived` source and accuracy taxonomy and the reserved
  `native_visible`/`provider_export` tiers, plus the
  `logIngestionMode`/`allowBroadLogRoots`/`logPath` settings;
- the synthetic estimator engine and the `estimated` tier/label;
- the inert threshold-notification settings.

The guards are `check:no-log-ingestion`, `check:no-old-usage-model`,
`check:no-synthetic-estimation`, and `check:no-threshold-notifications`.

## Accuracy labels (current)

`exact`, `billing_authoritative`, `proxy_reported`, `partial`, `unknown` is the
declared taxonomy; current v1 emits only `proxy_reported` and `unknown`. Native
agent surfaces are labeled `proxy_reported` (never `exact`, never billing-authoritative).
Missing cost reads `cost unknown`, never a fabricated `$0.00`.

## Consequences

- The native cockpit, the Claude statusLine bridge, and the Codex app-server
  probe are the load-bearing surfaces and are explicitly preserved.
- Future improvement effort focuses on **setup / onboarding / doctor flows**
  (helping users wire the statusLine snapshot and the Codex probe), never on log
  parsing or usage reconstruction.
- Native-only alerting may be designed later if there is a clear user need; it is
  out of scope for v1.
