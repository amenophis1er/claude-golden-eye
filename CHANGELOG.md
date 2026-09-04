# Changelog

Notable changes per release, written for people who *use* golden-eye — what is
new, what behaves differently, what was broken. The commit log has the
reasoning; this has the consequences. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/spec/v2.0.0.html).

Entries land under **Unreleased** as work merges; cutting a release renames
that heading to the version and date. `scripts/changelog-section.sh` feeds the
matching section to the GitHub release, and the release fails if a tagged
version has no section — so this file cannot silently fall behind.

## [Unreleased]

### Added

- **Update notice.** The sidebar reports the version the running server was
  started from (also on `/healthz`) and warns when a newer version is installed
  on disk while the old process is still serving — the failure that makes a fix
  look deployed when it is not. That check is local and always on. Checking
  GitHub for a newer *release* is separate and opt-in (`"updateCheck": true` /
  `GOLDEN_EYE_UPDATE_CHECK=1`): once a day, cached, silent on failure, never
  auto-updating, and it names the command that fits how this copy was installed.

- **`/golden-eye:server status|start|stop|restart`** — the dashboard server had
  no documented way to be restarted, which mattered because changed opt-ins are
  only read at start and the new update notice tells you to restart. It refuses
  to kill anything that is not golden-eye, and drives `launchctl` when the
  always-on service is installed so `stop` actually stops.

### Fixed

- A session waiting on background commands or live delegations no longer claims
  **your turn**. A finished background command wakes the session by itself, so
  the ball is not with you; the header and sidebar now say what is being waited
  on. Blue "your turn" is reserved for when nothing is in flight.

## [0.1.4] — 2026-09-03

### Added

- **Background shells.** The terminal's "N shells" now has an equivalent: a
  header chip that expands to each running command, its age, and its output when
  the session reads it. Tracked from launch (`backgroundTaskId`) to completion
  (the matching task-notification), so the count comes back down.
- **In-flight tool calls** show a live elapsed counter in agent transcripts
  instead of looking finished while a long command runs.
- **Running version** in the sidebar footer and `/healthz`.
- New eye-in-tile logo, favicon and wordmark.

### Changed

- **PM mode pins subagents to `opus` by default.** PM mode forbids the main
  session from writing, so every piece of implementation happens in a delegate.
  `--sub <model>` picks another; `--sub none` (`off`/`inherit`/`default`)
  restores inheritance.
- **Desktop notifications are quieter.** Turn-ended and subagent-finished no
  longer notify: the first duplicated Claude Code's own idle notice 60s later,
  and the second fired once per delegation (29 in one run) — burying the alerts
  that need a human. Permission prompts, questions, blocked missions and PM
  write blocks still notify; the rest remain in the feed.

### Fixed

- **One definition of a live agent.** A delegation no agent ever claimed sat at
  "starting" for hours with a live green dot, and three views disagreed about
  what counts as running — the sidebar claimed "1 agent running" while the
  Agents tab showed none. Stalled and never-started delegations are now
  labelled as such everywhere.
- Agent tabs carry the agent **type** (`Explore`), the name Claude Code uses, so
  one delegate no longer reads as two different ones across terminal and
  dashboard.
- Newest-first transcripts keep each tool result attached to the command that
  produced it, instead of floating results above the wrong call.

## [0.1.3] — 2026-09-02

### Added

- **Artifacts panel** — every claude.ai page published from a watched session,
  grouped by project, deduped across redeploys, with older ones recovered from
  transcripts when history is enabled.
- **Read-only project file viewer** (opt-in: `"files": true` /
  `GOLDEN_EYE_FILES=1`). Paths in tool calls and in prose become clickable and
  open in an overlay — the only way to read what a session is talking about from
  a phone.
- **Live status per sidebar row**: current tool, running delegations, open
  approvals and questions, with a spinning indicator for work and colour
  reserved for states that need a human.

### Security

- The file viewer resolves every requested path against that session's own cwd
  and requires the realpath to stay inside it; traversal, absolute escapes and
  symlinks pointing out are rejected, binaries refused, reads capped at 512 kB.

## [0.1.2] — 2026-09-02

### Added

- **`npx claude-golden-eye init`** — the whole install in one command:
  interactive opt-ins, payload copied to a stable home, marketplace and plugins
  registered, server started. `uninstall` mirrors it. Replaces a four-step npm
  dance that bought nothing.
- **Session history browser** (opt-in: `"history": true` /
  `GOLDEN_EYE_HISTORY=1`) — projects → past sessions → read-only transcript.
- The sidebar groups sessions **by project**, so several sessions in one repo no
  longer read as duplicate projects.

### Changed

- The idle "needs you" notification is a muted feed row rather than a red
  attention row, and the header says **your turn** instead of "waiting for you".

## [0.1.1] — 2026-09-02

### Added

- npm packaging with a trusted-publishing release workflow on `v*` tags.
- `/golden-eye:uninstall` command and a documented teardown.
- `scripts/dev-sync.sh` — pushes working-tree code into installed plugin copies,
  which per-version install caches otherwise never pick up.

### Fixed

- Forked sessions (background agent runners) go stale after 10 quiet minutes and
  can be removed while idle, instead of lingering with no delete button.
- The idle "needs you" notification no longer fires while subagents are still
  running — that resolves itself without you.

[Unreleased]: https://github.com/amenophis1er/claude-golden-eye/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/amenophis1er/claude-golden-eye/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/amenophis1er/claude-golden-eye/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/amenophis1er/claude-golden-eye/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/amenophis1er/claude-golden-eye/releases/tag/v0.1.1
