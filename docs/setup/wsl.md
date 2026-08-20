# TokenGauge setup in WSL (Remote WSL)

This guide is for VS Code **Remote WSL** windows: the VS Code client runs on
Windows, but the workspace — and normally the TokenGauge extension host — runs
inside the WSL distro. Claude Code, Node.js, the writer, the snapshot, and the
TokenGauge extension host should all be inside the **same WSL environment**.

**Evidence note for this guide.** This Remote WSL setup was smoke-tested end to
end in a WSL2 environment: WSL-side Claude Code, WSL Node, the canonical writer,
and TokenGauge's live snapshot readers in both file and directory modes on the
WSL Linux filesystem. Native non-WSL Linux distributions were not separately
exercised; path handling is designed to be portable.

## Where things run

Two different machines-in-one matter here:

- the **Windows client**: the VS Code window, running on Windows;
- the **WSL extension host**: where workspace extensions such as TokenGauge
  actually execute in a Remote WSL window.

Use **Developer: Show Running Extensions** to confirm TokenGauge runs on the
WSL side. The rule that decides every path question: **the configured snapshot
path must be visible to the extension host that reads it.** In a Remote WSL
window that means WSL-side paths like `/home/YOUR_USER/...`, resolved against
the WSL home — not your Windows profile.

Inside WSL, use the **Linux** Node installed in the distro (`node --version`
inside a WSL terminal), not Windows Node: Claude Code runs the writer inside
WSL, so the writer must run with WSL's own Node.

## 1. Create the writer (inside WSL)

> **Fastest route:** run **TokenGauge: Set Up Claude statusLine** from the VS Code
> Command Palette (`Ctrl+Shift+P`, or `Cmd+Shift+P` on macOS) instead. It writes the same writer file, validates it, and sets
> the User-scope snapshot path for the WSL extension host, leaving you only the
> `statusLine` line to add to your own Claude settings. Workspace or Remote
> overrides can still win, so check Settings or Diagnostics if the card stays
> empty. Run it from a VS Code
> window attached to WSL, so the file lands on that side. The steps below are the
> manual equivalent.

Use the `## WSL, Linux, macOS, or Git Bash` block in
[The Claude statusLine writer](../claude-statusline-writer.md), run from a WSL
terminal. It creates `~/.tokengauge/claude/claude-statusline-writer.mjs`,
validates it with `node --check`, and prints the absolute path with `realpath`.
That block is the tested source of the writer body; this guide intentionally does
not carry a second copy of it.

## 2. Wire Claude Code's statusLine command (WSL settings)

Edit the **WSL** file `~/.claude/settings.json` (inside the distro) and merge:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /home/YOUR_USER/.tokengauge/claude/claude-statusline-writer.mjs --file /home/YOUR_USER/.tokengauge/claude/statusline-snapshot.json"
  }
}
```

Verify what Claude Code will run with the same Node one-liner the README uses
(Bash syntax, run inside WSL):

```bash
node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(s.statusLine?.command ?? "")' ~/.claude/settings.json
```

## 3. Point TokenGauge at the snapshot (Remote settings)

**TokenGauge: Set Up Claude statusLine** sets this for you when you run it from
the Remote WSL window; skip to the next section if you did.

To set it by hand, set `tokenGauge.claude.statuslineSnapshotPath` to
`/home/YOUR_USER/.tokengauge/claude/statusline-snapshot.json` from **inside the
Remote WSL window**, in that window's own User settings or in Remote/Workspace
settings.

The distinction that matters is *which machine's* settings file you are editing,
not which tab is called "User". A Remote WSL window reads WSL-side settings, so
the **local Windows** User settings you see on the desktop may not affect it;
this scope split is normal VS Code behavior (use **Preferences: Open Remote
Settings (JSON)**).

## Directory mode (multiple Claude sessions)

For several concurrent Claude Code sessions in WSL, write one snapshot per
session: pass `--dir /home/YOUR_USER/.tokengauge/claude/statusline-snapshots`
in `statusLine.command` and point
`tokenGauge.claude.statuslineSnapshotPath` at that same directory.

Directory-mode behavior (same on every platform): TokenGauge reads only that
exact directory, non-recursively; it considers up to 32 hash-named snapshot
files; it treats files rewritten within about 90 seconds as active; and it
never deletes snapshot files. Filenames are derived from hashed identifiers —
no raw session or workspace value appears on disk. Directory mode is
poll-only — updates appear on the next poll (at most about 15 seconds), while
single-file mode also watches the exact configured file. Both modes were
executed against the live readers during WSL setup validation.

## Filesystem placement and `/mnt/<drive>` caveat

Keep the writer and the snapshot on the WSL Linux filesystem
(`/home/YOUR_USER/...`). Paths under `/mnt/c/...` (the mounted Windows drive)
are visible from WSL and may work, but they are **not the recommended
location** and were not exercised during setup validation: the 9P mount has
different permission semantics, and file modification times drive the
directory-mode ~90-second activity window, so cross-boundary timestamp
behavior can shift freshness judgments. The same visibility rule also means a
WSL snapshot under `/home/...` is for the **WSL** extension host — a local
Windows VS Code window cannot be assumed to read it; for local Windows use the
[Windows guide](windows.md).

## Troubleshooting

- Confirm TokenGauge's host with **Developer: Show Running Extensions**; if it
  runs on the WSL side, every path in this guide must be a WSL path.
- The writer's failure output is content-free by design: malformed or leaky
  input exits nonzero with `TokenGauge statusline writer error: ...` and never
  echoes the payload. Inspect the **snapshot** file (allowlisted fields plus
  hashed identifiers only) rather than printing raw statusLine payloads.
- If the snapshot exists but the Claude card shows no gauge, run
  **TokenGauge: Cockpit Diagnostics** and check for
  `statusline_snapshot_missing_rate_limits` — Claude Code did not report
  limit fields in that sample; this is not a path problem.
- macOS is not covered by this guide and has not been verified for this guide.
