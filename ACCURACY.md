# Accuracy and Source Taxonomy

TokenGauge's central promise is honesty: every metric is tracked with a label describing how trustworthy it is, and unavailable data is never presented as provider billing data. Cockpit cards surface that metadata as plain-language provenance ("Reported by Claude Code; not an official billing total"); the raw label ids appear in Cockpit Diagnostics rather than on the card. This document defines the accuracy labels, the source kinds that feed them, and the display contracts that follow.

## Accuracy labels

| Label                   | Meaning                                                                                  |
|-------------------------|------------------------------------------------------------------------------------------|
| `exact`                 | Directly measured value, strongest for token counts that the source reports precisely.   |
| `billing_authoritative` | Value sourced from a provider's billing/usage authority, strongest for cost.             |
| `proxy_reported`        | Value reported by a native agent status surface (Claude statusLine / stats-cache, Codex app-server probe). Native-reported, not billing-authoritative. |
| `partial`               | A combined value where at least one component is missing or weaker than the others.      |
| `unknown`               | Accuracy could not be established; the value should be treated with caution.             |

`billing_authoritative` and `exact` are kept distinct on purpose: billing is the strongest label for cost, while exact is the strongest label for directly measured token counts.

## Source tier vs accuracy label (native-usage-first)

A cockpit field carries **two** independent pieces of metadata: a single canonical **source tier** (which surface produced the value) and an **accuracy label** (how trustworthy that value is). They are different dimensions and never collapse into one another. The source tier never mutates or feeds the accuracy lattice; `Accuracy.combine()` / `leastAccurate()` behavior is unchanged by the existence of source tiers.

Source tiers, strongest to weakest for live limit/risk state:

| Source tier            | Meaning                                                                                       |
|------------------------|-----------------------------------------------------------------------------------------------|
| `statusline_snapshot`  | Guarded local Claude statusLine snapshot: the live native source for session/weekly %, resets, model, and cost. |
| `codex_status_snapshot`| Opt-in local Codex app-server structured probe: account rate-limit windows from the response shape this TokenGauge version recognizes. |
| `stats_cache_snapshot` | Local Claude `stats-cache.json` token-detail/cost cache.                              |
| `unknown`              | No native source available; the field reads `unavailable` with a documented reason. There is no synthetic estimator tier. |

TokenGauge does **not** synthesize, reconstruct, or estimate limit/usage values
(see ADR-004, the native-only privacy model). When a native source (`statusline_snapshot` or
`codex_status_snapshot`) does not report a field, that field reads
`unavailable`; there is no estimator engine that fills the gap with a computed
guess.

### Native source availability by agent

- **Claude Code**: `statusline_snapshot` is the live native source: session/5h %, weekly/7d %, resets, model, and cost come from a guarded local statusLine snapshot. `stats-cache.json` provides native per-model token detail. Both are PRIMARY.
- **Codex**: `codex_status_snapshot` comes from the explicit opt-in local `codex app-server` structured request. This version recognizes the tested 5-hour and 7-day account-window shape. If your Codex version, plan, login mode, API-key setup, or app-server response reports different buckets, TokenGauge shows Codex as unavailable or unsupported instead of guessing. It does not expose session context or cost today, so TokenGauge shows those fields as unavailable rather than fabricating them. TokenGauge never scrapes Codex terminal or inline statusline output.

## Source kinds

TokenGauge is native-only and persists no usage events. Each cockpit field's
accuracy label is derived from its native source tier:

- **Claude Code**: the guarded statusLine snapshot and `stats-cache.json` are native status surfaces, labeled `proxy_reported` (not billing-authoritative, never `exact`).
- **Codex**: the opt-in app-server probe is a native status surface, labeled `proxy_reported`.
- When no native source is available, a field reads `unavailable` (`unknown`), never reconstructed from logs.

## Label propagation

Accuracy labels propagate through aggregation. A value derived from a `proxy_reported` input can never be promoted to `exact` or `billing_authoritative`. When components of differing strength are combined, the combined value takes the weaker label, and a result with any `unknown` component is dragged toward `unknown`. This logic lives in a single `Accuracy.combine()` helper so the rules are auditable in one place.

## Cost unknown behavior

When a native source does not expose a cost, TokenGauge shows `cost unknown` rather than fabricating a `$0.00` figure. Native token detail is still shown where the source exposes it; only the cost is withheld. Cost is never coerced to a guessed rate.

## Limitations

- Anthropic does not publish a public tokenizer for current Claude models. Native Claude token counts come from the agent's own statusLine/stats-cache surfaces and are labeled `proxy_reported`, never `exact`. TokenGauge does not reconstruct token counts from logs.
- `partial` and `unknown` labels are expected whenever sources disagree or data is missing. That visibility is the point, not a defect.

## Native limitations and known mismatches

TokenGauge reads the native agent status surfaces and shows what they expose. When they do not expose a value, TokenGauge shows an honest `unavailable`. The caveats below are **known and explained**, not bugs.

- **Pro/Max plan-quota gaps.** Anthropic's Pro and Max plan limits are dynamic and unpublished. Anthropic does not commit to a fixed token quota per window. TokenGauge shows whatever the native statusLine surface reports for the window (a `proxy_reported` used %), and when the native surface does not report a value the field reads `unavailable`. TokenGauge does NOT learn, estimate, or synthesize a plan quota from observed behavior; there is no estimator engine.

- **No public Anthropic tokenizer.** Because Anthropic publishes no public tokenizer for current Claude models, native Claude token counts (from the agent's own statusLine/stats-cache surfaces) are labeled `proxy_reported`, never `exact`. TokenGauge does not reconstruct token counts from logs, and a Claude token count is never promoted to `exact`.

- **Cache 5m/1h collapse.** Anthropic reports cache-creation tokens in separate 5-minute and 1-hour buckets, but the upstream `cache_creation_input_tokens` field collapses them into a single number. TokenGauge surfaces whatever the native source exposes, so cache-token totals may lose the 5-minute-vs-1-hour fidelity. This is a known mismatch inherited from the source data, not a counting defect on our side.

- **Native-reported-vs-billing delta.** A native `proxy_reported` total can diverge from what the provider's billing authority eventually reports. The native surface may lag or count slightly differently than the billed line item. TokenGauge surfaces this honestly via the `proxy_reported` label, which is not billing-authoritative; it never silently rewrites a label on your behalf.
