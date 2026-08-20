# Privacy Policy

TokenGauge is local-first by design. This document describes exactly what
TokenGauge reads, what it stores, and how local SecretStorage is used.
TokenGauge is **native-only**: it persists no usage data.

## Short Version

- **No outbound network by default.** TokenGauge itself makes no outbound network
  calls. If you enable the Codex native probe and keep the Codex card visible,
  TokenGauge starts a short-lived local `codex` process; Codex may contact its
  own backend using its own credentials, but TokenGauge makes no request and
  reads no credentials. There is no discovery, no auto-update ping, and no
  telemetry.
- **No developer-controlled telemetry.** TokenGauge never sends usage,
  diagnostics, or any data to the TokenGauge authors. The MVP ships zero
  telemetry.
- **No usage persistence.** TokenGauge keeps no usage store. It reads native
  agent status surfaces at display time and persists no usage events; nothing
  usage-related leaves your machine.
- **No credential access.** TokenGauge asks for no provider API keys and reads
  no provider credential stores.
- **No conversation-log ingestion.** TokenGauge reads native status surfaces,
  not prompts, completions, transcripts, terminal buffers, or agent logs.

## What TokenGauge Reads

| Surface | When | Data | Storage |
|---------|------|------|---------|
| Claude statusLine snapshot | Card visible and configured | Limit windows, reset times, model, context, cost | No usage history |
| `~/.claude/stats-cache.json` | Card visible | Per-model cost and model details only | No usage history |
| Codex app-server probe | Probe enabled and card visible | Recognized account-level short and weekly windows | No usage history |
| VS Code SecretStorage | Activation and redaction setup | One local install salt | Local non-credential value |
| VS Code webview state | Cockpit active or restored | Sanitized display state | Temporary VS Code webview state |

The Claude statusLine snapshot is the only source of Claude 5-hour/weekly limit
windows. `~/.claude/stats-cache.json` never supplies those limit windows.

Hiding the Claude card stops Claude statusLine and stats-cache reads. Hiding the
Codex card stops Codex app-server probes, even if
`tokenGauge.providers.codex.nativeStatusProbe` remains enabled.

## Environment Fields for the Codex Probe

The Codex probe is off by default. When it is enabled and the Codex card is
visible, TokenGauge may inspect a small allowlisted set of process environment
metadata.

| Category | Examples | Use | Handling |
|----------|----------|-----|----------|
| Executable lookup | `PATH`, `PATHEXT` | Find local `codex` | Raw values not displayed or persisted |
| Home/config locations | `HOME`, `CODEX_HOME`, `XDG_*` | Let `codex` find its config | Forwarded only to spawned process |
| Shell and locale metadata | `SHELL`, `LANG`, `TERM` | Start the process predictably | Raw values not shown in UI or diagnostics |
| User-name compatibility | `USER`, `LOGNAME` | Preserve normal CLI behavior | Not treated as identity data |
| Node manager hints | `NVM_DIR`, `NVM_BIN` | Resolve common Node installs | Only forwarded when present |

The explicit allowlist is:

```text
PATH, HOME, CODEX_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME,
XDG_CACHE_HOME, XDG_RUNTIME_DIR, LANG, LC_ALL, LC_CTYPE, SHELL, USER, LOGNAME,
TERM, TMPDIR, NVM_DIR, NVM_BIN, USERPROFILE, PATHEXT, APPDATA, LOCALAPPDATA
```

If `codex` is not on the extension host's `PATH`, TokenGauge may run your own
shell non-interactively to resolve it. Login-capable shells such as Bash or Zsh
use `$SHELL -lc 'command -v codex'`; `sh` and `dash` use `-c` instead. Raw
environment values and resolved executable paths are not shown in UI or
diagnostics and are not persisted as usage data.

## What TokenGauge Never Reads or Stores

TokenGauge never persists prompts, completions, source code, source/workspace
file contents, terminal output, tool arguments or results, arbitrary/raw
environment variables, OAuth tokens, cookies, raw transcripts, git remote URLs,
raw native-payload paths, or provider credential files.

It also does not read, parse, or scan agent conversation logs. There is no
log-derived token-calculation path, conversation-log parsing, log-root
resolution, file watcher over agent logs, or broad-log-root scanning.

When native limit status is unavailable, the cockpit shows the field as
**unknown/unavailable** rather than inferring a value from logs.

## What TokenGauge Stores

TokenGauge is native-only and **persists no usage data**. There is no usage store
and no usage write chokepoint, because TokenGauge writes no usage-history
database.

The cockpit may keep sanitized display state in VS Code webview state while the
view is active or restored. That state does not contain raw prompts,
completions, transcripts, terminal output, raw session IDs, or a usage-history
database.

v1 has no API-key feature. The only persistent data TokenGauge stores is a local
**install salt** in VS Code SecretStorage, a non-credential value used for
privacy-preserving redaction/hashing.

## SecretStorage

TokenGauge v1 does not ask for API keys. The install salt is never written to
`settings.json` or logs, and it is never sent anywhere.

Important SecretStorage caveats, stated honestly:

- **VS Code SecretStorage does not sync as TokenGauge settings.** The install
  salt is kept in the OS-backed SecretStorage of the machine where it was created
  and is not carried by Settings Sync the way `tokenGauge.*` settings are.
- **TokenGauge does not clear SecretStorage on uninstall.** Uninstalling the
  extension does not automatically remove the install salt. It is a
  non-credential value used only for local hashing/redaction, and you normally
  do not need to remove it.

## Configuring the Claude statusLine integration writes to `~/.claude/settings.json`

TokenGauge's optional native bridge reads a passive local snapshot that
your own Claude Code statusLine script writes. Setting that up the documented
way involves **you** configuring Claude Code's statusLine, which **writes to
`~/.claude/settings.json`** (the `statusLine.command` field).

- This change is **user-initiated**. TokenGauge does **not** edit
  `~/.claude/settings.json`, does not run your statusLine command, and does
  **not** silently change any unrelated Claude Code setting.
- TokenGauge only ever **reads** a snapshot file you choose to write; it never
  writes to Claude Code's configuration.
- **Inspect** the current value with the same Node one-liner the README setup
  uses (no `jq` needed):
  `node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(s.statusLine?.command ?? "")' ~/.claude/settings.json`
- **Restore** by removing or editing the `statusLine.command` entry in
  `~/.claude/settings.json`. Keeping a backup of that file before you configure
  the integration makes reverting trivial.

If you never configure the statusLine integration, `~/.claude/settings.json` is
never touched on your behalf. The README's [Claude Code
setup](README.md#claude-code-setup) is the retained opt-in setup authority. The
writer emits only bounded snapshot fields, and TokenGauge rejects malformed or
leaky snapshots instead of reading them into the cockpit.

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

- TokenGauge stores no API keys, provider credentials, prompts, logs,
  transcripts, usage history, or raw paths.
- The only TokenGauge-owned persistent value is the local non-credential install
  salt described under SecretStorage. It is an implementation detail for local
  hashing/redaction and normally does not need user management.

## Privacy Report

Run **TokenGauge: Privacy & Data Report** for a readable trust report covering
which native surfaces are read, which field kinds are never stored, the
SecretStorage caveats above, the no-developer-telemetry posture, and the no
outbound network by default posture, with deeper diagnostics kept separate.
