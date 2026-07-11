# Privacy Policy

TokenGauge is local-first by design. This document describes exactly what TokenGauge does and does not read and how local SecretStorage is used. TokenGauge is **native-only**: it persists no usage data.

## Core posture

- **No outbound network by default.** TokenGauge itself makes no outbound network calls. If you enable the Codex native probe and keep the Codex card visible, TokenGauge starts a short-lived local `codex` process; Codex may contact its own backend using its own credentials, but TokenGauge makes no request and reads no credentials. There is no discovery, no auto-update ping, and no telemetry.
- **No developer-controlled telemetry.** TokenGauge never sends usage, diagnostics, or any data to the TokenGauge authors. The MVP ships zero telemetry.
- **No usage persistence.** TokenGauge is native-only and keeps no usage store. It reads native agent status surfaces at display time and persists no usage events; nothing usage-related leaves your machine.

## What TokenGauge stores

TokenGauge is native-only and **persists no usage data**. There is no usage store and no usage write chokepoint, because TokenGauge writes no usage-history database. Native limit/usage values are read from the agent's own status surfaces at display time. The cockpit may keep sanitized display state in VS Code webview state while the view is active or restored. TokenGauge does not store raw prompts, completions, transcripts, terminal output, raw session IDs, or a usage-history database. v1 has no API-key feature; the only persistent data TokenGauge stores is a local **install salt** in VS Code SecretStorage, a non-credential value used for privacy-preserving redaction/hashing (see below).

## What TokenGauge never stores

TokenGauge never persists prompts, completions, source code, file contents, terminal output, tool arguments or results, arbitrary environment variables, OAuth tokens, cookies, raw transcripts, git remote URLs, or raw filesystem paths. For the opt-in Codex probe, TokenGauge may inspect a small allowlisted set of process environment metadata (`PATH`, `HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `SHELL`, `USER`, `LOGNAME`, `TERM`, `TMPDIR`, `NVM_DIR`, `NVM_BIN`, and on Windows `USERPROFILE`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`) for two purposes: locating your local `codex` executable, and passing a bounded environment to the spawned `codex` process so your own tool can find its own config and credentials. If `codex` is not on the extension host's `PATH`, TokenGauge may run your own shell non-interactively (`$SHELL -lc 'command -v codex'`, which sources your shell profile) to resolve it. Raw environment values and resolved executable paths are not shown in UI/diagnostics and are not persisted as usage data.

## No log ingestion (native-only)

TokenGauge is **native-only**: it reads current session/weekly limit state, resets, model, and cost when available from native agent surfaces (the guarded Claude statusLine snapshot, the local `stats-cache.json` token-detail file, and the opt-in Codex app-server probe). The statusLine snapshot is the only source of Claude 5-hour/weekly limit windows; `~/.claude/stats-cache.json` is read whenever the Claude card is visible and supplies token-detail and cost only, never limit windows. Hiding the Claude card stops Claude statusLine and stats-cache reads. Hiding the Codex card stops Codex app-server probes, even if `tokenGauge.providers.codex.nativeStatusProbe` remains enabled. **It does not read, parse, or scan your agent conversation logs at all.**

There is no log-derived token-calculation path, no conversation-log parsing, no log-root resolution, no file watchers over agent logs, and no broad-log-root scanning. Prompts, completions, tool arguments or results, terminal output, raw transcripts, secrets, OAuth tokens, account email, and raw filesystem paths are never read.

When native limit status is unavailable, the cockpit shows the field as **unknown/unavailable** rather than inferring a value from logs.

## SecretStorage

TokenGauge v1 does not ask for API keys. The only value TokenGauge stores in VS Code SecretStorage is a local **install salt**: a non-credential random value used by the `SecretManager` / `IdHasher` for privacy-preserving redaction and hashing. It is never written to `settings.json` or logs, and it is never sent anywhere.

Important SecretStorage caveats, stated honestly:

- **VS Code SecretStorage does not sync as TokenGauge settings.** The install salt is kept in the OS-backed SecretStorage of the machine where it was created and is not carried by Settings Sync the way `tokenGauge.*` settings are.
- **TokenGauge does not clear SecretStorage on uninstall.** Uninstalling the extension does not automatically remove the install salt. It is a small non-credential value used only for local hashing/redaction, and you normally do not need to remove it.

## Configuring the Claude statusLine integration writes to `~/.claude/settings.json`

TokenGauge's optional native bridge reads a passive local snapshot that
your own Claude Code statusLine script writes. Setting that up the documented way
involves **you** configuring Claude Code's statusLine, which **writes to
`~/.claude/settings.json`** (the `statusLine.command` field). Stated plainly so
there are no surprises:

- This change is **user-initiated**. TokenGauge does **not** edit
  `~/.claude/settings.json`, does not run your statusLine command, and does
  **not** silently change any unrelated Claude Code setting.
- TokenGauge only ever **reads** a snapshot file you choose to write; it never
  writes to Claude Code's configuration.
- **Inspect** the current value with
  `jq -r '.statusLine.command' ~/.claude/settings.json`.
- **Restore** by removing or editing the `statusLine.command` entry in
  `~/.claude/settings.json`. Keeping a backup of that file before you configure
  the integration makes reverting trivial.

If you never configure the statusLine integration, `~/.claude/settings.json` is
never touched on your behalf. See the [Claude statusLine bridge setup
guide](src/bridge/README-bridge-setup.md) for the full opt-in setup, the bounded
fields read, and the strict schema that rejects anything else.

## Remote, WSL, and multiple sessions

TokenGauge reads native agent surfaces from the VS Code extension host where it
is actually running. In WSL, Remote-SSH, and Dev Container workspaces, VS Code
workspace extensions typically run on the remote, WSL, or container side, but
TokenGauge does not force that location; use **Developer: Show Running
Extensions** to confirm it. No raw path is ever shown, only the file's category.
When multiple windows or Claude sessions share one statusLine snapshot file, the
cockpit shows a conservative, ambiguity-labelled value rather than flapping, and
mutes context/cost under collision. Neither posture reads, stores, or displays
any prompt, transcript, secret, or raw path. See the README sections on
[remote workspaces](README.md#remote-wsl-dev-containers-and-ssh) and
[multiple windows or sessions](README.md#multiple-windows-and-multiple-claude-sessions)
for the user-facing details.

## Deletion

- TokenGauge stores no API keys, provider credentials, prompts, logs, transcripts, usage history, or raw paths. There is nothing of yours to delete. The only TokenGauge-owned value is the local non-credential install salt described under SecretStorage; it is a small implementation detail you normally do not need to manage.

## Privacy Report

Run **TokenGauge: Privacy & Data Report** for a readable trust report covering which native surfaces are read, which field kinds are never stored, the SecretStorage caveats above, the no-developer-telemetry posture, and the no outbound network by default posture, with deeper diagnostics kept separate.
