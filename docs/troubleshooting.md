# Troubleshooting

Fixes for the states TokenGauge can show: no gauge, a stale value, a probe that
returns nothing, and the Claude and Codex checks worth running first.

> Part of the [TokenGauge README](../README.md).


**Cockpit (native):**

- Run **TokenGauge: Cockpit Diagnostics** to inspect native-status health, source kinds, and redacted state. Diagnostics never echo raw snapshot/log content, secrets, or paths beyond redacted form.
- If a cockpit card shows a field as unavailable, the card states the **reason** rather than guessing, for example the native surface was not found, or the Codex native status probe is off (the private default). Use **TokenGauge: Refresh Native Status (Cockpit)** after fixing the source.
- For Claude, confirm the statusLine snapshot path resolves on the **extension-host** side (see [Remote, WSL, Dev Containers, and SSH](remote-setups.md) and the README's Claude Code setup section) and that your statusLine writer is running.
- If the snapshot file does not exist, verify that Claude Code `statusLine.command` invokes the Node writer, that the writer creates the snapshot JSON, and that TokenGauge points to the JSON snapshot output or snapshot directory, not the writer script.
- If the snapshot file exists but the Claude card still shows no gauge, run **TokenGauge: Cockpit Diagnostics** and check the statusLine snapshot status. `statusline_snapshot_missing_rate_limits` means TokenGauge read the snapshot successfully, but Claude Code did not include 5h or weekly `rate_limits` fields in that sample. This is not a path problem, and TokenGauge will not guess a usage window.
- If the snapshot JSON is invalid, recreate or validate the recommended Node writer with
  `node --check ~/.tokengauge/claude/claude-statusline-writer.mjs`. Only custom shell writers need LF line-ending and executable-bit checks.
- If Diagnostics reports an invalid or rejected snapshot, rebuild the writer
  rather than copying the full Claude payload. The strict schema rejects leaky or malformed snapshots, and TokenGauge reads nothing from them.
- To test the writer manually, run:
  ```bash
  tmp="$(mktemp -d)"
  printf '{"session_id":"manual-test","workspace":{"current_dir":"%s"},"model":{"id":"manual"},"rate_limits":{}}\n' "$PWD" | node ~/.tokengauge/claude/claude-statusline-writer.mjs --file "$tmp/statusline-snapshot.json"
  cat "$tmp/statusline-snapshot.json"
  ```
  Then check `ls -l ~/.tokengauge/claude/statusline-snapshot.json`, your Claude
  Code `statusLine.command`, the TokenGauge snapshot setting, and the Remote or
  Workspace settings scope if this is a WSL/Remote window.
- For Codex native limits, the app-server probe is **opt-in and off by default**; leaving it off is the recommended private posture. Enable `tokenGauge.providers.codex.nativeStatusProbe` and keep the Codex card visible only if you deliberately want TokenGauge to spawn the local `codex app-server` probe.

**Claude card stuck on a waiting state although the snapshot file updates:**

- If Diagnostics reports `statusline_snapshot_missing_rate_limits`, the snapshot
  was read. The missing piece is provider-reported rate-limit fields, not the
  file path.
- Claude Code reports the 5h/weekly `rate_limits` fields only for Claude.ai
  subscription (Pro/Max) sessions, and only after the session's first response.
  With an API key, Console billing, or a third-party provider those fields never
  appear, and the waiting state is the honest answer, not a fault. TokenGauge
  does not synthesize usage windows.
- Send a fresh Claude response, restart Claude Code if needed, and check Claude
  Code health/auth locally with `claude auth status` and `claude doctor`.
  Do not paste raw auth output, email addresses, organization or account ids,
  raw snapshots, or raw paths into public issues. TokenGauge shows a gauge as soon as Claude Code reports the 5h or weekly fields.
- Sessions run through the Claude Code VS Code extension's graphical panel do
  not run statusLine commands. Start a Claude Code CLI session in a terminal so
  the writer runs.

**Codex card shows a blocked or no-response state in WSL or Remote:**

On some codex-cli versions (confirmed on 0.137.0), `codex app-server` responds
in an interactive terminal but returns nothing over a pipe in some WSL or Remote
setups. TokenGauge reports this precisely as a no-response state, and re-checking
will not fix it. Update the Codex CLI and try again, or use an environment where
`codex app-server` responds over stdio. TokenGauge never scrapes the terminal as
a fallback.

**Probe seems on although your User settings say off:**

A Workspace or Folder setting can override your User setting. Run **TokenGauge:
Cockpit Diagnostics** and check the probe's effective scope; **TokenGauge:
Configure Cockpit** routes you to the scope that actually controls the value.
In WSL, Remote-SSH, or Dev Container windows, also check Remote settings; local
desktop User settings are for local windows and may not affect the remote
extension host, which reads that remote's own settings files.

**Claude card temporarily unavailable after sleep or network loss:**

TokenGauge reads the local Claude statusLine snapshot; it does **not** contact Claude's servers itself. Claude Code may still need network connectivity to refresh its own usage/limit state and write a fresh statusLine sample. After sleep, hibernation, Wi-Fi reconnects, VPN changes, or provider reconnects, the Claude card can temporarily show stale or unavailable data until Claude Code writes the next valid snapshot. Run **TokenGauge: Refresh Native Status (Cockpit)** after Claude Code reconnects. If the card still does not recover, run **TokenGauge: Cockpit Diagnostics** and check the Claude snapshot status.

**Codex card vs the inline statusline disagree?**

When the Codex app-server probe is enabled and the Codex card is visible, TokenGauge reads account-level rate-limit windows as reported by the local app-server, if the response matches the tested shape. It **never** scrapes the interactive terminal/inline statusline. Codex's **inline statusline can lag**: it typically updates when you run `/status` (or take a new turn), so between refreshes the number you see inline may be **stale**. If the TokenGauge card and the inline statusline differ, the inline one may be the out-of-date view. To decide:

- The card only reads **fresh** when it is backed by a **recent** app-server probe (within the roughly 2-minute sample-age bound described under [Status bar, badges, and timing](../README.md#status-bar-badges-and-timing)). A held sample past that bound is labeled **"Stale · showing last-known"**; the value is kept but no longer claims to be current.
- Use the inline statusline as a **manual cross-check only**, and run `/status` in Codex to refresh it before comparing.
- Run **TokenGauge: Refresh Native Status (Cockpit)** to force a fresh app-server probe (only when the probe is enabled and the Codex card is visible), then **TokenGauge: Cockpit Diagnostics**. The diagnostics show, in redacted boolean/rule-id form, the last app-server probe age, the freshness tier (fresh / retained / stale), which recognized windows are available, whether the reset time is known, whether your last manual Refresh actually forced a probe, and whether a lower lagging probe was conservatively held back. Those fields tell you whether a mismatch is inline-statusline lag, probe lag, a retained sample, a missing or unsupported window, an unsupported response shape, or something to report without exposing any raw account, session, path, or probe payload.
