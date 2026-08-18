# Multiple windows and multiple Claude sessions

What TokenGauge shows when several VS Code windows or several Claude Code
sessions are active at once, and how the multiple-writers warning behaves.

> Part of the [TokenGauge README](../README.md).


Which snapshot mode to use for multiple sessions is covered in
[Single-file vs. directory mode](../README.md#single-file-vs-directory-mode)
in the README:
**directory mode** (one snapshot file per session) is recommended when you run
several Claude Code sessions at once, and **single-file mode** remains supported
for one active writer. In directory mode TokenGauge can tell exactly how many
sessions are active. The multiple-writers warning stays up for as long as more
than one session is alive (even when both are idle) and clears within about 90
seconds of a session closing. This section explains what TokenGauge does if
sessions *do* end up sharing one file.

If several Claude Code sessions do end up sharing one snapshot file, each
session overwrites it with its own view. Rather than letting the gauge flap
between competing values, TokenGauge is deliberately conservative:

- The Claude usage gauge holds a **conservative, non-flapping, time-ordered**
  value. A warning appears only on **live evidence of concurrent writers**:
  TokenGauge must actually observe writes alternating between two different
  sessions. Starting a new session, restarting Claude Code, or reinstalling the
  extension never triggers it: one session handing off to another is not a
  conflict.
- While the conflict is observed, the card shows a stable **"Multiple Claude
  Code writers detected"** state with the actionable cause: another Claude Code
  terminal may still be writing the snapshot. Close other Claude Code
  terminals, or configure separate snapshot files. Model, context-window, and
  cost readings are **muted** (they are session-specific); the 5h/weekly limit
  gauges stay visible with the highest last-known usage (those are
  account-level).
- Recovery is driven by observed writes: once the alternation stops (you closed
  the other terminal), the warning clears on its own within about **a minute
  and a half**, and the card returns to Live on the next fresh sample. A manual
  **Refresh** re-checks immediately.
- Because the file is last-writer-wins, TokenGauge can only flag a conflict it
  can see; two sessions whose writes happen to line up may briefly read as one.
  The 5h/weekly numbers remain honest either way. They are account-level, so
  they include both sessions' consumption.
- Writer identity comes from the hashed `session_id_hash`/`workspace_hash`
  fields your writer emits; the recommended writer emits both. A writer that
  omits both cannot be told apart from another, so the warning cannot appear
  for it (the conservative value handling above still applies).
- The fix at the source is **directory mode**, which writes one hashed snapshot
  file per session so concurrent sessions do not clobber each other.

This is display/labelling behavior only. No metric loses its accuracy label,
and the gauge never silently reverts to a lower number without proof of a real
reset.
