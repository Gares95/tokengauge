# Screenshot capture checklist

README screenshots are added after the public repository exists, against a
near-final build. Contributors capturing them MUST follow this checklist before
committing any image:

- **Build source.** Capture from the **real installed VSIX** (install the packaged
  `.vsix`, then screenshot), never from the dev Extension Host (`F5`). The dev host can
  differ from the shipped build.
- **Themes.** Capture each view in **both** a light and a dark VS Code theme. The agent
  identity hues (Claude terracotta, Codex blue) and risk states must read correctly in both.
- **Views to shoot:**
  1. Cockpit overview (per-agent gauge cards with plain-language provenance).
  2. Battery gauges in normal / warning / critical risk states (text + color, not color alone).
  3. Empty / getting-started state (no source enabled yet).
  4. Privacy report (redacted diagnostics).
- **Redaction: mandatory before committing any image.** No raw filesystem paths, no
  workspace/account names, no ids, no secrets, no provider account email, and no raw log
  content may be visible anywhere in frame (including window title bars, status bar,
  tooltips, and the Explorer). Use a throwaway workspace and sanitized mock native data.
- **Verify before commit.** Re-open each captured PNG at full size and scan the entire
  frame for the items above. If anything sensitive is present, re-capture. Do not crop
  over it (metadata and adjacent pixels can leak). Screenshots are images, so the VSIX
  content audit does not scan them; redaction is a human gate.
- **No fabrication.** Screenshots must reflect what the installed extension actually
  renders. Do not mock, composite, or hand-edit numbers.
