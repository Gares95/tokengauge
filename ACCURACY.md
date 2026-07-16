# Accuracy and Source Taxonomy

TokenGauge's central promise is honesty: every metric is tracked with a label describing how trustworthy it is, and unavailable data is never presented as provider billing data. Cockpit cards surface that metadata as plain-language provenance ("Reported by Claude Code; not an official billing total"); the raw label ids appear in Cockpit Diagnostics rather than on the card. This document defines the accuracy labels, the source kinds that feed them, and the display contracts that follow.

## Accuracy labels

| Label                   | Meaning                                                                                  |
|-------------------------|------------------------------------------------------------------------------------------|
| `exact`                 | Directly measured value, strongest for token counts that the source reports precisely.   |
| `billing_authoritative` | Value sourced from a provider's billing/usage authority, strongest for cost.             |
| `proxy_reported`        | Value reported by a native agent status surface (Claude statusLine / stats-cache, Codex app-server probe). Native-reported, not billing-authoritative. |
| `partial`               | Declared for values with a missing or weaker component. Reserved: current v1 never emits it. |
| `unknown`               | Accuracy could not be established; the value should be treated with caution.             |

These five labels are the declared taxonomy. Current v1 emits only `proxy_reported` and `unknown`: values read from a native status surface resolve to `proxy_reported`, and unavailable data resolves to `unknown`. `exact`, `billing_authoritative`, and `partial` are declared but not currently emitted.

`billing_authoritative` and `exact` are kept distinct on purpose: billing is the strongest label for cost, while exact is the strongest label for directly measured token counts. Neither is emitted by v1, because no v1 source is a billing authority or a direct measurement.

## Source tier vs accuracy label (native-usage-first)

A cockpit field carries **two** independent pieces of metadata: a single canonical **source tier** (which surface produced the value) and an **accuracy label** (how trustworthy that value is). They are different dimensions and never collapse into one another. The source tier states which surface produced a value; the accuracy label states how much trust that value carries. The cockpit resolver derives each field's accuracy label directly from its winning source tier.

Source tiers, strongest to weakest for live limit/risk state:

| Source tier            | Meaning                                                                                       |
|------------------------|-----------------------------------------------------------------------------------------------|
| `statusline_snapshot`  | Guarded local Claude statusLine snapshot: the live native source for session/weekly %, resets, model, and cost. |
| `codex_status_snapshot`| Opt-in local Codex app-server structured probe: account rate-limit windows from the response shape this TokenGauge version recognizes. |
| `stats_cache_snapshot` | Local Claude `stats-cache.json` cache, read for per-model cost and model information. |
| `unknown`              | No native source available; the field reads `unavailable` with a documented reason. There is no synthetic estimator tier. |

TokenGauge does **not** synthesize, reconstruct, or estimate limit/usage values
(see ADR-004, the native-only privacy model). When a native source (`statusline_snapshot` or
`codex_status_snapshot`) does not report a field, that field reads
`unavailable`; there is no estimator engine that fills the gap with a computed
guess.

### Native source availability by agent

- **Claude Code**: `statusline_snapshot` is the live native source: session/5h %, weekly/7d %, resets, model, and cost come from a guarded local statusLine snapshot. `stats-cache.json` provides native per-model cost and model information. Both are PRIMARY. TokenGauge does not display token counts.
- **Codex**: `codex_status_snapshot` comes from the explicit opt-in local `codex app-server` structured request. Known Codex windows are independently optional: short-only, weekly-only, and dual-window states are supported when the native response exposes recognized fields. If neither recognized window is present, TokenGauge shows Codex as unavailable or unsupported instead of guessing. Missing window data is never treated as zero, unlimited, or fabricated from another window. It does not expose session context or cost today, so TokenGauge shows those fields as unavailable rather than fabricating them. TokenGauge never scrapes Codex terminal or inline statusline output, and future native format changes may require maintenance when providers change their structures.

## Source kinds

TokenGauge is native-only and persists no usage events. Each cockpit field's
accuracy label is derived from its native source tier:

- **Claude Code**: the guarded statusLine snapshot and `stats-cache.json` are native status surfaces, labeled `proxy_reported` (not billing-authoritative, never `exact`).
- **Codex**: the opt-in app-server probe is a native status surface, labeled `proxy_reported`.
- When no native source is available, a field reads `unavailable` (`unknown`), never reconstructed from logs.

## Label assignment

Each cockpit field gets its label from per-field source selection. The resolver picks the best available native source for that field and assigns the label mapped from that source's tier: active native tiers resolve to `proxy_reported`, and fields with no usable source resolve to `unknown`/unavailable. There is no aggregation step that combines values across sources into a blended label. The standing invariant is honesty-preserving: a value read from a native status surface is never presented as `exact` or `billing_authoritative`.

## Cost unknown behavior

When a native source does not expose a cost, TokenGauge shows `cost unknown` rather than fabricating a `$0.00` figure. The rest of the card (model, native usage percentages) is unaffected; only the cost is withheld. Cost is never coerced to a guessed rate.

## Limitations

- Anthropic does not publish a public tokenizer for current Claude models. TokenGauge does not display token counts and does not reconstruct them from logs; the native percentages and cost it shows come from the agent's own status surfaces and are labeled `proxy_reported`, never `exact`.
- `unknown`/unavailable states are expected whenever native data is missing or stale. That visibility is the point, not a defect. v1 never emits the `partial` label.

## Native limitations and known mismatches

TokenGauge reads the native agent status surfaces and shows what they expose. When they do not expose a value, TokenGauge shows an honest `unavailable`. The caveats below are **known and explained**, not bugs.

- **Pro/Max plan-quota gaps.** Anthropic's Pro and Max plan limits are dynamic and unpublished. Anthropic does not commit to a fixed token quota per window. TokenGauge shows whatever the native statusLine surface reports for the window (a `proxy_reported` used %), and when the native surface does not report a value the field reads `unavailable`. TokenGauge does NOT learn, estimate, or synthesize a plan quota from observed behavior; there is no estimator engine.

- **No public Anthropic tokenizer.** Anthropic publishes no public tokenizer for current Claude models. TokenGauge does not display token counts and does not reconstruct them from logs; native Claude values are labeled `proxy_reported`, never `exact`.

- **Native-reported-vs-billing delta.** A native `proxy_reported` total can diverge from what the provider's billing authority eventually reports. The native surface may lag or count slightly differently than the billed line item. TokenGauge surfaces this honestly via the `proxy_reported` label, which is not billing-authoritative; it never silently rewrites a label on your behalf.
