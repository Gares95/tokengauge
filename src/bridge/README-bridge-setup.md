# Claude statusLine snapshot bridge: EXPERIMENTAL opt-in setup

> **Status: EXPERIMENTAL, opt-in, local, no-network.** This is an advanced
> reference guide for the Claude statusLine snapshot bridge; the step-by-step
> setup lives in the README "Claude Code setup" section. The bridge is an
> optional, additive convenience. If you do nothing, TokenGauge simply has no
> Claude statusLine snapshot to read; nothing else is affected. Codex uses a
> separate explicit opt-in local `codex app-server` structured probe for native
> 5h/weekly limits; this Claude statusLine bridge is not used for Codex.

The bridge lets TokenGauge read a **passive local snapshot** of the safe,
bounded fields Claude Code already exposes in its statusLine: rate-limit
percentages, reset times, model id, cost total, and context-window usage. Each
refresh, TokenGauge validates the snapshot against a strict allowlist schema and
maps it into an **in-memory cockpit candidate**; nothing is persisted. It does
not reconstruct usage or synthesize missing limits; the values are
provider-visible statusLine metadata only.

## What this bridge is, and is NOT

- It reads **only** a snapshot file **you** choose to write from **your own**
  statusLine script. TokenGauge **never edits** `~/.claude/settings.json` or any
  Claude Code config, and never runs your statusLine command for you.
- It makes **no network call** and runs **no background process**. It scrapes
  **no TUI slash command** (`/usage`, `/status` are interactive-only and are not
  invoked). The only input is a JSON object you wrote to a local file.
- It captures **only** an allowlisted set of safe bounded fields. The Claude
  statusLine payload also carries `cwd`, `workspace.current_dir`,
  `workspace.repo.*` (raw paths + git remote identity), and a raw `session_id`.
  **all forbidden** by TokenGauge's data policy. The bridge schema is
  `.strict()` at every level, so if your script accidentally writes the **whole**
  payload, the parse **fails** and **nothing** is read into the cockpit. The
  leaky fields have no place to land. `session_id` is **hashed** (HMAC-SHA256
  with your per-install salt) before anything is used. The raw id is read
  transiently and never persisted; TokenGauge persists no usage data at all.

## Allowlisted safe fields

| Field | Use |
|-------|-----|
| `model.id` | recorded as the sample model (scanned for forbidden content) |
| `cost.total_cost_usd` | optional, informational |
| `context_window.context_window_size` / `used_percentage` | optional |
| `exceeds_200k_tokens` | optional |
| `rate_limits.five_hour.{used_percentage,resets_at}` | session-window sample |
| `rate_limits.seven_day.{used_percentage,resets_at}` | weekly-window sample |
| `session_id` | **hashed** before use; never stored raw (nothing is persisted) |

Anything else (`cwd`, `workspace`, `workspace.repo`, prompts, transcripts, raw
paths, api keys) is rejected by construction.

## Setup (you own every step)

1. In **your own** statusLine script, write a JSON file containing **only** the
   safe fields above to a local path you control, e.g.:

   ```json
   {
     "model": { "id": "claude-opus-4" },
     "rate_limits": {
       "five_hour": { "used_percentage": 42, "resets_at": 1781110800 }
     },
     "session_id": "<your-session-id>"
   }
   ```

   Do **not** pipe the full statusLine payload. Write only the fields you want
   shared. (If you do write the whole payload, the strict schema rejects it and
   no sample is recorded.)

2. Point TokenGauge at that snapshot path (a `tokenGauge.*` setting; opt-in,
   off by default).

## Write a PER-SESSION snapshot directory (recommended for multiple sessions)

> **Why this matters (active-writer fix).** A single snapshot file is
> last-writer-wins: TokenGauge can never prove that a second, *idle-but-open*
> Claude Code session still exists once its writes are overwritten. With one
> file **per session**, every open session keeps refreshing its own snapshot,
> so "how many sessions are active" is a simple bounded check of the
> configured directory, and the cockpit keeps the multiple-writers warning
> (with model/context/cost muted) for as long as more than one session is
> genuinely alive.

A ready-to-use version of the per-session writer below ships in this repo at
[`claude-statusline-writer.example.sh`](claude-statusline-writer.example.sh).
Copy it, `chmod +x` it, and point Claude Code's statusLine at it (see the
README "Claude Code setup" section).

Point `tokenGauge.claude.statuslineSnapshotPath` at a **directory** you own
(the same setting accepts a file or a directory; no new setting):

```jsonc
// settings.json
{
  "tokenGauge.claude.statuslineSnapshotPath": "~/.tokengauge/claude/statusline-snapshots/"
}
```

TokenGauge reads ONLY that exact directory, non-recursively, and only files
named `<workspace_hash>-<session_id_hash>.json` (both parts hash-derived by
your script; raw ids and paths never appear), capped at 32 files. A session
counts as **active** while its file's mtime is within ~90 seconds; every
refresh (including a manual Refresh) re-evaluates, so closing a session
returns the card to Live within that window. With two or more active
sessions the 5h/weekly gauges stay visible (conservative: newest reset
window, highest usage) while the session-specific model/context/cost stay
muted under the multiple-writers warning.

Example `bash` statusLine writer (reads Claude's JSON on stdin, writes ONE
atomic snapshot per session):

```bash
#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"

OUT_DIR="$HOME/.tokengauge/claude/statusline-snapshots"
mkdir -p "$OUT_DIR"

session_id="$(printf '%s' "$input" | jq -r '.session_id // ""')"
workspace_path="$(printf '%s' "$input" | jq -r '.workspace.project_dir // .workspace.current_dir // .cwd // ""')"

session_hash="$(printf '%s' "${session_id:-none}" | sha256sum | cut -c1-16)"
workspace_hash="$(printf '%s' "${workspace_path:-none}" | sha256sum | cut -c1-16)"

OUT="$OUT_DIR/${workspace_hash}-${session_hash}.json"
tmp="${OUT}.tmp"

printf '%s' "$input" | jq \
  --arg session_hash "$session_hash" \
  --arg workspace_hash "$workspace_hash" '
  {
    source: "claude_statusline",
    timestamp: (now | todateiso8601),
    session_id_hash: $session_hash,
    workspace_hash: $workspace_hash,
    model: { id: (.model.id // null) },
    cost: { total_cost_usd: (.cost.total_cost_usd // null) },
    rate_limits: {
      five_hour: (if .rate_limits.five_hour then {
        used_percentage: (.rate_limits.five_hour.used_percentage // null),
        resets_at: (.rate_limits.five_hour.resets_at // null)
      } else null end),
      seven_day: (if .rate_limits.seven_day then {
        used_percentage: (.rate_limits.seven_day.used_percentage // null),
        resets_at: (.rate_limits.seven_day.resets_at // null)
      } else null end)
    },
    context_window: {
      used_percentage: (.context_window.used_percentage // null),
      remaining_percentage: (.context_window.remaining_percentage // null)
    }
  }
' > "$tmp"
mv "$tmp" "$OUT"

jq -r '"[TG] \(.model.id // "model?") | 5h \(.rate_limits.five_hour.used_percentage // "--")%"' "$OUT"
```

Old per-session files from closed sessions simply expire out of the active
set after ~90 seconds; delete them whenever you like (TokenGauge never
deletes your files).

## Write a PER-WORKSPACE snapshot file (single-file alternative)

> **Why this matters.** Claude Code runs your statusLine script
> for **every** session, including sessions in **different** workspaces, in
> parallel. If every session writes to **one global** snapshot path (e.g. a
> single `~/.claude/statusline-snapshot.json`), each session **overwrites** the
> file with **its own** account-usage view. TokenGauge faithfully re-reads the
> file on every refresh, so the cockpit gauge appears to **live-update and then
> silently revert** as competing sessions take turns writing. The fix is to give
> **each workspace its own** snapshot file so sessions never clobber each other.

The statusLine payload Claude passes to your script carries the session's
workspace directory (e.g. `workspace.current_dir` / `workspace.project_dir`, or
`cwd`). Use it **only** to derive a **stable hashed filename**. Never write the
raw path into the snapshot (raw paths remain forbidden; only the bounded,
already-documented hashed identifiers may land in the snapshot file).

Example `bash` statusLine writer (reads Claude's JSON on stdin, writes a safe,
**per-workspace** snapshot keyed by a hash of the workspace dir):

```bash
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"                       # Claude's statusLine JSON on stdin

# Derive a STABLE per-workspace key from the workspace dir, then HASH it so the
# raw path never lands in a filename or the snapshot. (jq + sha256sum shown;
# any stable hash works. Fall back to cwd if the field is absent.)
ws_dir="$(printf '%s' "$payload" | jq -r '.workspace.current_dir // .workspace.project_dir // .cwd // empty')"
[ -z "$ws_dir" ] && ws_dir="$PWD"
ws_hash="$(printf '%s' "$ws_dir" | sha256sum | cut -c1-16)"

# One snapshot file PER workspace: sessions in different workspaces never
# overwrite each other.
out_dir="$HOME/.tokengauge/claude"
mkdir -p "$out_dir"
out_file="$out_dir/statusline-snapshot-$ws_hash.json"

# Emit ONLY the safe allowlisted fields. Never echo the whole payload, never the
# raw cwd/workspace/repo/account. `workspace_hash` carries the hashed identity.
printf '%s' "$payload" | jq \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg wh "$ws_hash" \
  '{
     source: "bridge",
     timestamp: $ts,
     workspace_hash: $wh,
     session_id_hash: (.session_id_hash // null),
     model: { id: .model.id },
     cost: (.cost // null),
     context_window: (.context_window // null),
     rate_limits: (.rate_limits // null)
   } | with_entries(select(.value != null))' \
  > "$out_file"
```

Then point TokenGauge at **that workspace's** file:

```jsonc
// .vscode/settings.json (per workspace): each workspace points at its OWN file
{
  "tokenGauge.claude.statuslineSnapshotPath": "~/.tokengauge/claude/statusline-snapshot-<that-workspace-hash>.json"
}
```

Because `tokenGauge.claude.statuslineSnapshotPath` is the **only configured
Claude statusLine snapshot path** TokenGauge reads (there is no fallback
snapshot path and no `.claude` scanning), each workspace's cockpit reads only
its own session's statusLine snapshot and the revert/flap cannot happen.
TokenGauge may separately read `~/.claude/stats-cache.json` for token-detail and
cost signals when the Claude card is visible; that file never supplies 5-hour or
weekly limits.

**Defence in depth: the extension also protects you.** The single-file bridge
is intended for **one active statusline writer per configured snapshot**. Even
if two sessions do share one file, TokenGauge's stability gate refuses to
silently revert: it holds the last-accepted value (monotonic, reset-window-
aware) and shows a clearly-labelled **"Multiple Claude Code writers detected"**
degraded state, with stable value and stable header, only on **live evidence** of
concurrent writers (writes observed alternating between two sessions). A
session restart or a new session is a handoff, not a conflict, and never
triggers it; the warning clears on its own within ~90 seconds once the
alternation stops. The per-workspace writer above is still the better fix
because it removes the collision at the source; the two are complementary.
Emitting `session_id_hash` from your writer is recommended: it lets TokenGauge
distinguish two sessions in the SAME workspace, which a workspace hash alone
cannot.

3. Each refresh, TokenGauge reads the snapshot transiently, validates it
   against the strict allowlist schema, hashes any raw session id, and maps the
   result into an in-memory cockpit candidate. Nothing is persisted; the value
   lives only for the current render.

## Failure modes

- **Snapshot missing / unreadable:** no candidate is produced. The bridge is
  purely additive.
- **Leaky payload written:** strict-schema parse fails; **nothing** is read into
  the cockpit. This is the intended safe failure.
- **Forbidden value smuggled into `model.id`:** the Redactor backstop rejects
  the snapshot content-free.
- **statusLine contract changed (version drift):** fields the schema does not
  recognize are rejected, so a changed payload degrades to an honest
  waiting/unavailable card instead of a wrong number.

## Why this is the best-case, not the only case

The documented statusLine JSON is machine-readable, local, and stable enough to
fingerprint: the best safe agent-native surface available. A cut of this bridge
strands nothing.

---

*This document is developer-facing setup material and is **excluded from the
packaged VSIX** (`.vscodeignore` ships only `dist/`, `package.json`,
`README.md`, `LICENSE`, `CHANGELOG.md`).*
