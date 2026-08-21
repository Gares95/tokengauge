# ADR-005: Claude quota comes from the statusLine snapshot

**Status:** Accepted (2026-08-18)

[ADR-004](ADR-004-native-only-privacy-model.md) establishes that TokenGauge reads
native, provider-visible surfaces and never reconstructs usage. This ADR records
which surface supplies Claude quota, why that surface requires a one-time user
setup, and what was checked before accepting that cost.

## Context

The Claude card is fed by a statusLine writer the user installs into Claude Code.
Installing it is a short manual procedure that ends with the user adding a
`statusLine` entry to `~/.claude/settings.json` themselves.

That setup is the most visible friction in the product, and there is an apparent
way to remove it: read the OAuth credentials Claude Code stores locally and call
an account usage endpoint directly. Someone meeting the setup step without
context could reasonably read it as unfinished onboarding and try to remove it
that way.

The setup exists because of a constraint and a boundary. The constraint is that
no other local surface was found to carry the data. The boundary is that
TokenGauge does not read provider credentials and makes no outbound request of
its own. This record exists so both are visible at the point someone considers
reversing them.

## Decision

**Claude quota comes from the statusLine snapshot the user's own writer
produces.** TokenGauge does not read provider credentials and does not call a
provider API to obtain quota.

Scoped precisely: as of 2026-08-18, for Claude.ai Pro/Max personal quota, under
the trust boundaries in ADR-004 together with this repository's no-credential and
no-network-by-default rules, the statusLine payload is the only supported local
source identified. That is a finding about a platform at a point in time rather
than a permanent property, so it carries explicit revisit conditions below.

## What was checked

The findings below are point-in-time observations of a local Claude Code
installation, recorded 2026-08-18. They are version sensitive: a negative result
about where a value does *not* appear can be invalidated by any release. The
Claude Code version used for the investigation was not recorded, so treat the
table as evidence that these routes were checked rather than as a claim about any
particular version, and re-verify against the version in use before relying on
it.

| Route | Finding |
|---|---|
| statusLine payload | Carries `rate_limits.five_hour` and `rate_limits.seven_day`. This is the route in use. |
| Stored OAuth credentials plus an account usage endpoint | Technically reachable. Excluded by the trust boundaries below. |
| Conversation JSONL | 5,877 entries inspected, no quota fields present. |
| Other Claude Code hooks | 31 hook events reviewed, none carry quota. |
| Other local files under `~/.claude`, including `stats-cache.json` | No quota keys found. |
| Official Anthropic usage API | The Admin API is organization-scoped and requires an Admin API key. It does not expose personal consumer quota. |
| Claude Code VS Code panel internal state | Undocumented internal state, and panel sessions do not run a statusLine command. |

## Why the credential route is excluded

**The primary basis is the Consumer Terms.** Section 3 reserves automated or
non-human access to the Services for cases where the user is using an Anthropic
API key or where access is otherwise explicitly permitted. A third-party
extension that reads a user's stored OAuth token and scripts an authenticated
call falls outside that reservation.

Section 2, which concerns sharing account credentials with other people, is not
relied on here. A local tool reading a credential on the user's own machine is
not clearly the same act, and the argument does not need it.

**The endpoint is undocumented and unsupported.** An account usage endpoint
reached with a consumer OAuth token is not a published integration surface. It
can change shape or stop responding without notice, which is a poor foundation
for a gauge whose whole value is being trustworthy when a user is near a limit.

**Risk falls unevenly.** The most direct account-level risk sits with the user,
because it is their subscription and their account. TokenGauge would also carry
risk of its own: reputational risk from a product premised on not touching
credentials doing exactly that, and maintenance risk from depending on an
interface nobody has promised to keep stable.

The decisive point does not rest on any one of these details. TokenGauge should
not depend on extracting stored consumer credentials and automating an
undocumented consumer endpoint, because that conflicts with the trust model the
product is built on.

## Freshness

The architectural difference is that TokenGauge receives quota state as part of
the Claude Code workflow instead of polling an account endpoint on a timer.

The writer runs when Claude Code updates its status line, which includes every
assistant response, so the snapshot reflects the user's most recent turn. A
polled approach reflects whenever its last poll happened to run, and the gap
matters most in exactly the situation the gauge exists for: a user close to a
limit, deciding whether to start more work. Specific polling intervals are
implementation details of whichever tool is doing the polling and are not
relied on here.

Running inside Claude Code also produces something the credential route cannot:
a live usage readout in the terminal status line, where the user is already
working, rather than only in a VS Code panel.

## Restrictions retained

Three restrictions stand between the current setup and a shorter one. All three
were examined and all three stand, but they are not equally strong.

1. **No credential reads.** Follows from the Consumer Terms position above and
   from a stated product promise.
2. **No outbound network by default.** Same basis, and it is the claim that most
   differentiates TokenGauge. Enforced by `check:no-network-default`.
3. **No writing to `~/.claude/settings.json`.** This one is discretionary rather
   than compelled. Claude Code's own `/statusline` command writes that file
   behind its own approval prompt, so a consented edit is not inherently a
   boundary violation.

   It stands as a product and trust decision. Automatic editing would remove only
   the last small piece of setup friction, a single paste of a string TokenGauge
   already displays. In exchange it would cross from writing TokenGauge's own
   files into mutating the user's Claude configuration, which is a stronger
   boundary than anything else the extension does. Keeping the paste manual
   leaves that mutation explicitly under the user's control. Enforced by the
   `automatic-claude-settings-edit` rule in `tools/check-release-docs.mjs`.

## Consequences

- **Setup is automated as far as the boundary allows.** `TokenGauge: Set Up
  Claude statusLine` writes the canonical writer, validates it with
  `node --check`, and sets the User-scope snapshot path, then displays the exact
  `statusLine` entry for the user to add. It neither writes nor reads
  `~/.claude/settings.json`; the user opens that file to paste, so an existing
  entry is visible to them without TokenGauge reading it.
- **Timer-based refresh is not a shortcut to fresher data.** The writer stamps
  `timestamp` when it writes and re-emits whatever `rate_limits` it was handed,
  so re-running it on a timer can present a previously captured value with a
  newer timestamp. An idle session is usually still accurate, but a second
  session or another device consuming quota is exactly the case where the gauge
  must not look more confident than it is. Recommending
  `statusLine.refreshInterval` for freshness would require the snapshot schema to
  distinguish capture time from write time.
- **This is repository-internal reference material.** It is not linked from the
  README or the CHANGELOG, which carry an approved link target list for packaged
  documentation. The user-facing version of this rationale lives in the README
  under "Why this needs setup".

## Revisiting this

Reopen this decision if any of the following becomes true:

- Anthropic publishes a supported API for personal consumer quota.
- The Consumer Terms change in a way that permits third-party automated access
  using consumer authentication.
- Claude Code exposes quota through a documented hook or local file.
- The statusLine payload stops carrying `rate_limits`, which would invalidate the
  current route rather than merely add an alternative.
