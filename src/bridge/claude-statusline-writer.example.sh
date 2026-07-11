#!/usr/bin/env bash
#
# TokenGauge — example Claude Code statusLine writer (per-session DIRECTORY mode).
#
# WHAT THIS DOES
#   Claude Code runs your statusLine command on every status refresh and pipes a
#   JSON payload to it on stdin. This script reads that payload, keeps ONLY the
#   small, bounded set of fields TokenGauge accepts, and writes ONE snapshot file
#   PER SESSION into a directory you own. TokenGauge reads that directory and
#   renders your Claude 5h / weekly limit gauges.
#
# PRIVACY
#   This script never writes raw paths, raw session ids, prompts, completions, or
#   transcripts. The workspace path and session id are HASHED and used only to
#   name the per-session file; the raw values never leave this script. It makes no
#   network call. If you ever pipe the whole Claude payload by mistake,
#   TokenGauge's strict snapshot schema rejects it and records nothing.
#
# SETUP (three steps — see the TokenGauge README "Claude Code setup" section)
#   1. Save this file somewhere you own and make it executable, e.g.:
#        mkdir -p ~/.tokengauge/claude
#        cp src/bridge/claude-statusline-writer.example.sh \
#           ~/.tokengauge/claude/claude-statusline-writer.sh
#        chmod +x ~/.tokengauge/claude/claude-statusline-writer.sh
#   2. Point Claude Code's statusLine at it in ~/.claude/settings.json (TokenGauge
#      never edits that file — you configure Claude Code's statusLine yourself):
#        { "statusLine": { "type": "command",
#            "command": "~/.tokengauge/claude/claude-statusline-writer.sh" } }
#   3. Point TokenGauge at the SAME output directory:
#        "tokenGauge.claude.statuslineSnapshotPath":
#            "~/.tokengauge/claude/statusline-snapshots/"
#
# REQUIRES: bash, jq, sha256sum (coreutils). All local; no network.

set -euo pipefail

# Where per-session snapshots are written. This MUST match
# tokenGauge.claude.statuslineSnapshotPath. Override via TOKENGAUGE_SNAPSHOT_DIR
# or edit the default below to any directory you own.
OUT_DIR="${TOKENGAUGE_SNAPSHOT_DIR:-$HOME/.tokengauge/claude/statusline-snapshots}"

input="$(cat)"
mkdir -p "$OUT_DIR"

# Derive STABLE, HASHED identifiers so the raw workspace path / session id never
# land in a filename or in the snapshot. Fall back to "none" when a field is
# absent. Only the first 16 hex chars are kept — enough to separate sessions.
session_id="$(printf '%s' "$input" | jq -r '.session_id // ""')"
workspace_path="$(printf '%s' "$input" | jq -r '.workspace.project_dir // .workspace.current_dir // .cwd // ""')"

session_hash="$(printf '%s' "${session_id:-none}" | sha256sum | cut -c1-16)"
workspace_hash="$(printf '%s' "${workspace_path:-none}" | sha256sum | cut -c1-16)"

# One file per session: <workspace_hash>-<session_hash>.json (the exact name
# pattern TokenGauge's directory mode reads). Temp file + atomic rename so
# TokenGauge never reads a half-written file.
out="$OUT_DIR/${workspace_hash}-${session_hash}.json"
tmp="${out}.tmp.$$"

# Emit ONLY the allowlisted safe fields, hashed identity only. `del(.. | nulls)`
# strips any field Claude did not provide so the strict schema stays happy.
printf '%s' "$input" | jq \
  --arg session_hash "$session_hash" \
  --arg workspace_hash "$workspace_hash" \
  '{
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
   | del(.. | nulls)' > "$tmp"
mv "$tmp" "$out"

# Optional: print a short status line for Claude Code to show in its statusLine.
jq -r '"[TG] \(.model.id // "model?") · 5h \(.rate_limits.five_hour.used_percentage // "--")%"' "$out"
