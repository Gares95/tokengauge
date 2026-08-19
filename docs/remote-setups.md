# Remote, WSL, Dev Containers, and SSH

How TokenGauge behaves when the extension host and your agent CLI run on
different sides of a remote boundary, and which settings scope applies.

> Part of the [TokenGauge README](../README.md).


TokenGauge runs in a VS Code extension host and reads native agent surfaces
relative to the home directory of the environment that host runs in. When you
open a folder over **WSL**, **Remote-SSH**, or a **Dev Container**, workspace
extensions typically run on the **remote/WSL/container side**; TokenGauge does
not force a host location, so use **Developer: Show Running Extensions** to
confirm where TokenGauge is actually running. When it runs on the remote side:

- Native snapshot and stats-cache files are expected under the **remote**
  home. For example, `~/.claude/...` resolves to the home directory of the user on
  the WSL distro, SSH host, or container, not your local Windows/macOS home.
  If your Claude Code (and its statusLine writer) run inside the same remote,
  everything lines up automatically.
- Path handling is designed to be portable across macOS, Linux, and Windows;
  `~` and relative paths are resolved against the host the extension actually
  runs on.
- Windows native is supported when the needed files and commands are visible to
  the VS Code extension host. For local Windows VS Code with Claude, Claude Code
  must already run in that same local Windows environment. If `claude` does not
  start, fix Claude Code first. The writer must run where Claude Code runs, and
  TokenGauge must read a snapshot path visible to the local Windows extension
  host. For Codex on Windows native, `codex` should usually be on the
  extension-host `PATH`; fallback discovery is best-effort.
- Same-host setup is preferred: WSL Claude Code with the WSL VS Code extension
  host, or local Windows Claude Code with the local Windows VS Code extension
  host. If you use WSL Claude Code, prefer opening the workspace in WSL so
  TokenGauge also runs in WSL.
- A WSL snapshot under `/home/...` is for the WSL extension host, not local
  Windows VS Code. Cross-host paths, such as local Windows VS Code reading a WSL
  snapshot, can work but are not the recommended setup.
- WSL uses the Linux extension-host home and `PATH`, not the Windows host home
  and `PATH`.
- TokenGauge settings must be configured in the scope where the extension is
  running. In WSL, Remote-SSH, and Dev Container windows, use Remote settings or
  Workspace settings visible to that remote extension host. Local Windows/macOS
  desktop User settings can be different or wrong and may not affect the remote
  TokenGauge instance, because a remote window reads that remote's own settings
  files. Local desktop User settings are still the right place for local,
  non-remote windows; this scope split is normal VS Code behavior.
- Use **Preferences: Open Remote Settings (JSON)**, or the **Remote [WSL: ...]**
  tab in Settings when it is visible, to edit remote settings. Keep local User
  settings guidance for local, non-remote windows.
- Browser-only VS Code or web extension hosts are not supported because
  TokenGauge uses Node filesystem and process capabilities.
- If your agent runs on a **different** side than the extension host (for
  example, Claude Code on the Windows host while VS Code opened a folder inside
  WSL), the snapshot file may live where the extension host cannot see it. In
  that case point `tokenGauge.claude.statuslineSnapshotPath` at a path that
  exists on the **extension-host** side, or run the agent in the same remote.

**Codex CLI not found by TokenGauge**

The VS Code extension-host `PATH` can differ from the integrated terminal `PATH`.
This is common with NVM, asdf, mise, Volta, bun, npm-global, and other user-local
CLI managers. TokenGauge attempts safe discovery before giving up: extension-host
`PATH`, a bounded non-interactive shell/common user-bin resolver, and an NVM
fallback. Diagnostics report only sanitized labels such as `codex cli resolver` and
`codex cli resolver stage`, never raw executable paths. Run **TokenGauge: Cockpit
Diagnostics** after a manual refresh, and do not paste raw executable paths in issues
unless explicitly requested and redacted.

**Honesty note on testing.** TokenGauge's path handling is written to be
cross-platform, and the maintainer develops on WSL2, but the full matrix
(Remote-SSH, Dev Containers, every WSL distro, Windows host paths) is **not yet
exhaustively tested**. If a native surface is not found in your remote setup,
the cockpit shows the field as unavailable with its reason rather than guessing.
