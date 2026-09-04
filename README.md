# claude golden-eye

[![npm](https://img.shields.io/npm/v/claude-golden-eye)](https://www.npmjs.com/package/claude-golden-eye)

A **live local dashboard** of what your Claude Code sessions are really doing —
every agent spawned, every delegation, every tool call, live transcripts, plan,
token/context usage. **View-only and passive**: the hooks observe, never
intervene, and the server has zero runtime dependencies.

This repo is a marketplace shipping **two independent plugins**:

- **`golden-eye`** (the observer) — passive hooks → singleton local server →
  real-time web UI (agent tree, live transcripts, timeline, plan board), plus
  MCP `report_progress` / `get_mission` self-reporting and desktop
  notifications when agents finish or missions block.
- **`golden-eye-pm`** (optional add-on) — PM-mode discipline: `/pm` turns the
  main session into a delegate-only project manager (charter + per-prompt
  re-anchor, hook-enforced write blocking, subagent model pinning). Composes
  with the observer for state and dashboard display; the observer never
  requires it.

Built empirically: every hook behavior the plugins rely on was verified against
a live probe rig first — see [probe/FINDINGS.md](probe/FINDINGS.md).

---

## Install

```bash
npx claude-golden-eye init
```

One command, no global install. It walks you through the optional pieces (PM
mode, dashboard composer, session history, always-on launchd server), copies a
pinned payload to `~/.golden-eye/app`, registers the marketplace + plugins via
the `claude` CLI, writes the server opt-ins, and starts the dashboard. Safe
defaults with `--yes` for scripts (`--pm --composer --history --launchd` to
opt in non-interactively). It targets the current `CLAUDE_CONFIG_DIR`
(default `~/.claude`); re-run with the env var set for a second instance.

- **Upgrade:** `npx claude-golden-eye@latest init` (re-runs are idempotent)
- **Remove:** `npx claude-golden-eye uninstall` (`--purge` also deletes data)
- **No npm registry?** The same installer runs straight from GitHub — nothing
  global, nothing published needed. The three specs are *not* equivalent:

  | command | installs |
  | --- | --- |
  | `npx claude-golden-eye@latest init` | the latest **published release** (needs the npm registry) |
  | `npx github:amenophis1er/claude-golden-eye#v0.1.4 init` | that exact **tag** — reproducible, no registry involved |
  | `npx github:amenophis1er/claude-golden-eye init` | the default branch's **HEAD**, which may be ahead of any release |

  A bare GitHub spec tracks `main`, not the newest tag, so pin the tag unless
  you specifically want unreleased code.

**Without npm** — the repo is itself a Claude Code marketplace:

```bash
claude plugin marketplace add amenophis1er/claude-golden-eye
claude plugin install golden-eye@claude-golden-eye        # the dashboard
claude plugin install golden-eye-pm@claude-golden-eye     # optional PM mode
```

The optional features then need their manual steps (config.json opt-ins,
launchd script) described in their sections below.

**From a local clone (development):**

```bash
# from this repo's directory
claude plugin marketplace add "$PWD"
claude plugin install golden-eye@claude-golden-eye
claude plugin install golden-eye-pm@claude-golden-eye
```

- Updates after edits: `claude plugin update golden-eye` (then restart sessions).
- Disable/enable without uninstalling: `claude plugin disable|enable golden-eye`.
- Remove: see [Uninstall](#uninstall) — plugin removal alone leaves the server
  running and its data behind.
- Note: the marketplace source is this directory. After code edits run
  `claude plugin marketplace update claude-golden-eye` (or reinstall) so the
  installed copy picks them up; restart sessions to reload hooks/MCP.

Optional history migration (dev sessions live in the repo's store):
`cp -R .golden-eye ~/.golden-eye` before the first real session.

## First-run walkthrough (what to eyeball)

1. Start any Claude Code session in any project. Its `SessionStart` hook bootstraps the
   dashboard automatically — nothing to launch.
2. Open **http://127.0.0.1:7717** (the server logs its URL to stderr if the port moved).
3. (With `golden-eye-pm` installed) run `/pm on MISSION: …` — the dashboard shows
   `PM ENGAGED`, the mission, and the charter the agent received. Steps 3–4 are
   PM-plugin features; the observer alone covers everything else here.
4. Give the model a task that needs files. Expect it to **delegate**: main-agent writes are
   hook-denied with an explanatory reason; the dashboard gets a red `DENY` row and a counter.
5. Subagents appear live in the agent tree (spawn prompt → tool calls → final report).
6. Try `/pm off` when done. Toggle dashboard tabs across multiple open sessions via the
   session chips (N sessions ⇒ 1 window).

## PM mode (`golden-eye-pm` plugin)

```
/pm on — MISSION: ship the payments refactor; subagents only
/pm on --sub sonnet MISSION: cheaper workforce for a mechanical sweep
/pm on --sub none MISSION: let each spawn pick its own model
/pm off
```

(The namespaced form `/golden-eye-pm:pm …` works identically. `/pm` ships as a
skill in the PM plugin; the raw prompt text is what its UserPromptSubmit hook
parses, so it works even before the skill expands.)

- The hook flips dashboard state and injects the **PM charter**; every later prompt gets a
  short **re-anchor** (mission + team status + rules) — the main agent can't lose the plot
  in long back-and-forth.
- Main-session `Edit/Write/MultiEdit/NotebookEdit` are **hook-denied** with a
  delegation-first reason; subagents keep full access (`agent_id` discrimination).
- `Bash` stays allowed (charter asks for read-only discipline — soft rule).
- **Subagent model pin** — delegations run on **opus by default**. PM mode exists to
  push all implementation onto subagents, so that is where capability matters; the main
  agent keeps the session model (`/model`), so a Fable PM runs an all-Opus workforce
  without being asked. `--sub <model>` picks a different one and `--sub none`
  (`off`/`inherit`/`default`) disables pinning so each spawn keeps whatever it asked for.
  Enforcement: the charter instructs the PM to set the Agent tool's `model` field, and the
  `PreToolUse` hook hard-rewrites the spawn input (`updatedInput`) if it is missing or
  different — logged as a `PMModelPin` event.
- Enforcement **fails open**: dashboard down ⇒ sessions run normally.

## Agent self-reporting (MCP)

Bundled MCP server (`plugins/golden-eye/server/mcp-server.js`, zero-dependency stdio JSON-RPC):

- `report_progress({ state: working|blocked|done, progress_pct?, note? })` — agents report
  milestones; call once before finishing per the PM charter. Resolves session by cwd.
- `get_mission()` — agent-side self re-anchor (mission, PM state, progress, stats).

Progress drives the mission card's bar; `blocked` shows red and fires a desktop
notification (macOS).

## Dashboard composer (opt-in, channels research preview)

Type into a live session from the dashboard. Built on [Claude Code
channels](https://code.claude.com/docs/en/channels-reference): the bundled MCP
server declares the `claude/channel` capability, and composer messages are
injected as channel events — visible in the terminal as a
`← golden-eye: …` line, and acted on as a real turn. **Off by default**; two
explicit opt-ins are required:

1. Server side — either of (otherwise every composer endpoint answers 404 and
   no bridge forms):
   - persistent: `echo '{"composer": true}' > ~/.golden-eye/config.json`
     (read at server start; works no matter what spawned the server), or
   - per-run: `GOLDEN_EYE_COMPOSER=1` (env wins over the file; `0` force-disables).
2. Session side: channels are a research preview, so each session must start
   with `claude --dangerously-load-development-channels plugin:golden-eye@claude-golden-eye`
   (full-screen warning; that's Anthropic's gate, not ours). Make it an
   alias — either a dedicated one so ordinary sessions stay flag-free, or
   shadow `claude` itself (safe: aliases don't recurse, and they don't apply
   to scripts/non-interactive shells — the only cost is the consent dialog
   at every interactive session start):

   ```bash
   # ~/.zshrc — pick one:
   alias claudege='claude --dangerously-load-development-channels plugin:golden-eye@claude-golden-eye'
   alias claude='claude --dangerously-load-development-channels plugin:golden-eye@claude-golden-eye'
   ```

The composer box appears in a session's Live-tab rail only when both are true
(the session's channel bridge is connected). Sends are attributed in the feed
as `DashboardPrompt` rows. Routing is deterministic: hooks and the MCP process
share the claude process pid, so a message reaches exactly one session.

**Question dialogs (`AskUserQuestion`) are display-only** — an open question
shows as a blue card (question + numbered options, desktop notification), but
the picker is the terminal's own UI: unlike permission prompts, Claude Code
has no remote-answer mechanism for it, so you answer in the terminal and the
card clears itself. Rejected tool calls no longer show as perpetually
"running" in the feed (a later event from the same agent supersedes them).

**Permission relay** — the channel also declares
`claude/channel/permission`, so when Claude asks to run a gated tool
(`Bash`, `Write`, …) the prompt appears as an amber card above the composer
with **allow / deny** buttons. Both stay live: answer in the terminal or on
the dashboard, first verdict wins (Claude Code drops the loser by request
id). Cards expire after 10 minutes — a prompt answered locally never
notifies us, so stale cards age out instead of resolving; a stale verdict is
dropped safely by Claude Code.

Security: the composer steers sessions and verdicts approve tool use, so both
share one gate. Direct loopback requests are trusted (Host-checked);
**proxied** requests (e.g. `tailscale serve` — they carry `X-Forwarded-*`)
must send the `X-Golden-Eye-Token` header matching
`<data dir>/composer.token` (0600). No reply tool — the dashboard already
sees the session's output passively.

## Notifications

Throttled (≥5 s) macOS notifications (`GOLDEN_EYE_NOTIFY=0` to disable): subagent finished ·
PM write blocked · mission blocked · turn ended.

## Singleton lifecycle

**Many Claude Code sessions, ONE dashboard.** Sessions never start their own UI:

```
any session's SessionStart hook
  └── node plugins/golden-eye/server/boot.js
        ├─ server.json healthy?            → do nothing (reuse)
        ├─ healthz probe on 7717–7721?     → reuse, do nothing
        └─ else: exclusive lockfile + spawn ONE detached server
              └─ writes server.json { pid, port }   (SIGINT/TERM removes it)
hooks POST events  →  follow server.json port (not hardcoded)
idle 30 min + no dashboard open  →  server shuts itself down
```

Default data dir: `~/.golden-eye/` (all projects converge). Manual run stays available:
`node plugins/golden-eye/server/index.js`.

## Dashboard tour

- **Header** — state chip (`working` / blue `waiting for you` / `stalled` / `ended`),
  PM badge, mission with `#N` task references resolved against the task store,
  and an env line: project path · git branch · permission mode · model ·
  `ctx <tokens>` · `↓in ↑out` tokens · Claude Code version (all read from the
  session transcript).
- **Live tab** — newest-first event feed (toggleable) with a "now" strip of running
  agents; expanded rows show structured detail (commands, prompts, `open agent →`
  links) with raw JSON one click deeper. Resizable right rail: last prompt
  (task-notifications rendered as cards), latest main output (markdown), compact
  plan (in-progress → open → completed).
- **Agents tab** — sub-tabs: Main session pinned first, live delegates next,
  finished ones collapsed into a `Done (N)` dropdown. Per-agent detail:
  properties/model/tokens on the left, full-height **live transcript** on the
  right (thinking, markdown prose, tool calls + expandable results; 2.5 s poll).
- **Timeline tab** — every hook event, filterable by type.
- **Sidebar** — sessions grouped Active / Idle / Stale (freshness-gated), per-session
  and bulk prune (persisted as tombstones).

## Architecture

```
plugins/golden-eye/            THE OBSERVER (view-only)
  hooks/   (one thin logging process per Claude hook event, fail-soft)
    ├── JSONL log <data dir>/logs/hook-events.jsonl   (fallback, always; size-capped)
    └── POST /ingest → server (port from server.json, best-effort)
  server/  singleton node process (zero runtime dependencies)
    ├── index.js       HTTP ingest + /pm bridge + /mcp/attach + /api/prune
    │                  + /api/agent-transcript + SSE + static hosting (web/dist)
    ├── state.js       event store + reducer (sessions, agents, tasks) — replay on boot
    ├── transcript.js  passive JSONL tail: per-agent transcripts, usage/branch/model stats
    ├── tasks.js       reads Claude Code's task store (<config>/tasks/<session>/*.json)
    ├── mcp-server.js  stdio JSON-RPC (report_progress, get_mission)
    └── boot.js        idempotent singleton bootstrap (SessionStart, stale-lock safe)
  web/     React + Vite + Tailwind dashboard (src/ → committed dist/, no build for users)

plugins/golden-eye-pm/         PM DISCIPLINE (optional add-on)
  skills/pm/SKILL.md   the /pm skill: charter instructions for the model
  hooks/
    ├── user-prompt-submit.js  /pm parse → engage/off/mission/--sub pin + charter inject
    ├── pre-tool-use.js        main-session write deny + subagent model pin (updatedInput)
    └── lib/pm.js, lib/util.js server bridge (fail-open when no observer server exists)
```

The plugins are independent: the observer never reads PM code, and PM
enforcement degrades gracefully (fail-open) when the observer's server is
absent — installing both is what lights up the PM chips, deny counter, and
delegation stats on the dashboard.

## Environment variables

The opt-in features (composer, history, files, updateCheck) can also be set
persistently in `<data dir>/config.json` — `{"composer": true, "history": true,
"files": true, "updateCheck": true}` — which survives every spawn path (SessionStart bootstrap,
launchd, manual). The env var wins when set: `1` forces on, `0` forces off even
if config.json enables it. All are read once at server start, so changing either
needs a server restart.

| Variable | Default | Purpose |
|---|---|---|
| `GOLDEN_EYE_DATA_DIR` | `~/.golden-eye` | store + server.json |
| `GOLDEN_EYE_PORT` | 7717 (candidates →7721) | preferred port |
| `GOLDEN_EYE_HOST` | 127.0.0.1 | bind host |
| `GOLDEN_EYE_SERVER_URL` | from `server.json` | hook override |
| `GOLDEN_EYE_IDLE_EXIT_MS` | 1 800 000 (30 min) | auto-exit (0 = never) |
| `GOLDEN_EYE_NOTIFY` | on | set `0` to disable notifications |
| `GOLDEN_EYE_LOG_DIR` | `<data dir>/logs` | hooks' fallback JSONL log location |
| `GOLDEN_EYE_COMPOSER` | off | `1` = enable the dashboard composer (channel injection) |
| `GOLDEN_EYE_HISTORY` | off | `1` = enable the read-only session history browser |
| `GOLDEN_EYE_FILES` | off | `1` = enable the read-only project file viewer |
| `GOLDEN_EYE_UPDATE_CHECK` | off | `1` = check GitHub daily for a newer release |
| `GOLDEN_EYE_ALLOWED_HOSTS` | none | comma-separated extra `Host` values to accept (reverse proxies / tailnet name) |
| `GOLDEN_EYE_DISABLE_POST` | unset | `1` = local logging only |

## Known limits

- Spawn→child binding: deterministic at collection (`PostToolUse(Agent).tool_response.agentId`);
  early FIFO hint can mis-label under parallel spawns until the repair lands.
- Plan data: the on-disk task store is authoritative; `TaskCreate`/`TaskUpdate`
  (+ legacy `TodoWrite`) events are the fallback when no store dir exists.
- Denied calls appear as `PRE` rows without `POST` (Pre-without-Post = denial signal).
- `startSource: null` means the session was observed without a `SessionStart` (attached mid-stream).
- **Resume backfill**: history from before the hooks were watching (resumes,
  mid-stream attaches) is read from the session transcript and shown as dimmed
  `replayed` rows in the Live feed (last 150 prompt/output/tool entries), and
  hydrates the last-prompt/last-output panels. Hook-level detail (permission
  decisions, PM denies, exact payloads) is not reconstructable for those turns.
- PM enforcement discriminates main session vs subagent by the presence of
  `agent_id` in PreToolUse payloads (verified against Claude Code ≥ 2.x via the
  probe rig). The failure polarity is safe — a payload-shape change can only
  over-block, never silently unblock the main session.
- The `--sub` model-pin rewrite answers `permissionDecision: "allow"` for the
  spawn it rewrites, so a pinned Agent/Task call bypasses any ask-rule you may
  have configured on that tool.
- The dashboard API is loopback-only and rejects non-local `Host` headers
  (DNS-rebinding guard); reverse proxies need their host allowlisted
  (`GOLDEN_EYE_ALLOWED_HOSTS` / config.json `allowedHosts`). It has no auth
  beyond that: any process on the machine, or any device reaching an
  allowlisted host, can read session data. See the Tailscale section.
- Probe rig and findings for the original hook-payload discovery: [probe/](probe/).

## Dashboard UI

React + Vite + Tailwind (lucide icons, light/dark mode, hash-routed deep links like
`#/s/<session>/agents`). The built app is committed at `plugins/golden-eye/web/dist/` and served by the
zero-dependency server — end users need no build step.

- The sidebar groups sessions **by project** (cwd), newest activity first, with a
  state dot per session (active / idle / stale) — several sessions of one repo no
  longer read as duplicate projects. Each row carries a **live status line** so a
  glance answers "who is blocked on me": an open question or approval shows amber
  and pulsing, a working session shows its current tool (and running delegations)
  with elapsed time, a finished turn with delegations still in flight says so
  rather than claiming your turn, and a genuinely waiting session shows **your
  turn** in blue. The session id moved to the row tooltip. Stale sessions (and non-active forks) can be
  pruned per-session or in bulk (persisted as `SessionPrune` tombstones so a server
  restart doesn't resurrect them). A `SessionEnd` hook marks closed sessions.
- **Artifacts** — every claude.ai page published from a watched session, grouped
  by project: favicon, title, publish count, capabilities, and a link to the
  page (plus a chip per session in its header). Publishes are read from the
  hook stream, so a redeploy updates one row instead of adding another; older
  publishes are recovered from session transcripts when history is enabled,
  and are marked "from transcript" (no title was recorded back then). A match
  only counts inside an `Artifact` tool result — the same "Published … at …"
  sentence in a shell result or assistant prose is not an artifact. This lists
  what golden-eye *saw published here*, not the account's whole gallery: that
  needs an authenticated claude.ai call this local, view-only server can't make.
- **Project file viewer (opt-in)** — file paths shown in a session are
  clickable: the `file_path` of any Read/Write/Edit tool call, and path-shaped
  code spans in assistant prose (those resolve on click, so a false guess says
  "not found" instead of dangling). The file opens read-only in an overlay,
  markdown-rendered for `.md`. At a desk this duplicates your editor; on a
  phone over the tailnet it is the only way to read what a session is talking
  about. Because it serves project source over the network it has its own
  switch, off by default: `"files": true` in `~/.golden-eye/config.json` (or
  `GOLDEN_EYE_FILES=1`, or answer yes during `npx claude-golden-eye init`).
  A requested path is resolved against that session's own cwd and its realpath
  must stay inside it — traversal, absolute escapes and symlinks pointing out
  are rejected, binaries refused, reads capped at 512 kB.
- **Update notice** — the sidebar reports the version the *running server* was
  started from (also on `/healthz`), and warns when a newer version is installed
  on disk while this process still serves the old code — the failure that makes
  a fix look deployed when it is not. That check is local and always on.
  Checking GitHub for a newer *release* is separate and **opt-in**
  (`"updateCheck": true` / `GOLDEN_EYE_UPDATE_CHECK=1`): it is the only outbound
  request golden-eye ever makes, at most once a day, cached, silent on failure,
  and it never updates anything — it names the command that fits how this copy
  was installed (npx / marketplace / checkout). GitHub rather than npm on
  purpose: endpoint proxies that withhold recently-published versions rewrite
  npm packuments, so an npm-based check would report "no update" indefinitely.
- **Session history (opt-in)** — a read-only browser over every past session's
  transcript on disk: projects → sessions (first prompt, age, size) → transcript
  viewer, with a copyable `claude --resume <id>` command. Discovery is derived
  from observed transcript paths (no configured directories; multiple Claude
  instances each surface their own transcript store, so the same project can
  appear once per instance). Because it exposes *all* past transcripts — not
  just live-session tails — it is off by default: enable with `"history": true`
  in `~/.golden-eye/config.json` (or `GOLDEN_EYE_HISTORY=1`) and restart the
  server. Server-side, a requested directory is only accepted when it resolves
  to a direct child of a derived projects root.
- The **Live** tab is the realtime view: a "now" strip of running agents (current
  tool + elapsed), an auto-following event feed (click any row for the raw payload),
  and a full-height panel with the main agent's latest prompt/output.
- UI development: `cd plugins/golden-eye/web && npm install && npm run dev` (Vite
  proxies `/api` + `/pm` to `127.0.0.1:7717`). Ship with `npm run build` and commit
  `web/dist/`.
- **Running the installer without npx**: `bin/cli.js` is a plain node script, so
  from a clone `node bin/cli.js init` (same flags) does exactly what `npx` would
  — useful for testing the install path, or when the registry is unreachable.
  `npm pack` + `npx ./claude-golden-eye-<v>.tgz init` tests the packed artifact.
  **But don't use `init` for day-to-day development**: it copies a payload to
  `~/.golden-eye/app` and repoints the marketplace there, so a repo-backed dev
  install gets silently switched to a snapshot and your edits stop reaching it.
  For that loop, keep the marketplace on the repo and use `dev-sync.sh` below.
- **Propagating code changes**: installed plugins run from a per-version cache
  snapshot (`<config dir>/plugins/cache/claude-golden-eye/…`), and
  `claude plugin update` skips same-version updates — so repo edits never reach
  running installs on their own. Run `./scripts/dev-sync.sh` after changing
  hook/server/web code: it rsyncs the working tree into every installed copy
  (`$CLAUDE_CONFIG_DIR` and `~/.claude` by default; pass extra config dirs as
  arguments) and restarts the dashboard server. Hook
  scripts and the server pick the new code up immediately; hooks.json
  registration and each session's MCP process still need a session restart.

## Always-on server (launchd)

Sessions bootstrap the server on demand (`SessionStart` → `boot.js`), but for
phone/tailnet access after a reboot — before any session runs — install a
LaunchAgent that starts it at login and keeps it alive (idle-exit disabled via
`GOLDEN_EYE_IDLE_EXIT_MS=0`):

```bash
./plugins/golden-eye/deploy/install-launchd.sh   # writes the plist (node + repo paths resolved) and loads it
# remove:
launchctl bootout gui/$(id -u)/com.golden-eye.server
rm ~/Library/LaunchAgents/com.golden-eye.server.plist
```

`boot.js` detects the healthy launchd instance and stands down, so the two paths
coexist; if the launchd server dies, KeepAlive restarts it. After server-code
changes: `launchctl kickstart -k gui/$(id -u)/com.golden-eye.server`.

## Remote access (Tailscale)

The server binds 127.0.0.1 only. To reach it from other devices, proxy it onto
your tailnet (tailnet-only, HTTPS, survives reboots):

```bash
# a spare HTTPS port keeps any existing `tailscale serve` on :443 intact
tailscale serve --bg --https=8443 http://127.0.0.1:7717
tailscale serve status        # shows the https://<name>.ts.net:8443 URL
# undo: tailscale serve --https=8443 off
```

**Required:** the server's DNS-rebinding guard rejects any non-loopback `Host`,
and `tailscale serve` forwards the original tailnet name — so without this the
dashboard 403s. Allowlist your tailnet host (find it in `tailscale serve
status`) so the guard accepts it:

```bash
# merge into <data dir>/config.json (alongside "composer": true)
{ "allowedHosts": ["<name>.<tailnet>.ts.net"] }
# or per-run: GOLDEN_EYE_ALLOWED_HOSTS=<name>.<tailnet>.ts.net
```

Allowlisting a host also makes it a **trusted origin** for the composer and
approve/deny buttons (a phone browser can't set the `X-Golden-Eye-Token`
header, so this is what lets remote steering work). The rule: allowlisting a
host = trusting devices that reach the server through it — i.e. your own
tailnet is your auth boundary. Any *other* proxy origin still needs the token.

Caveats: the dashboard has no auth of its own beyond that host trust — anyone
on the tailnet can view sessions, hit /pm & /api/prune, and (if the composer is
enabled) steer sessions. Leave `composer` off in config.json for view-only
tailnet access. The proxy also targets :7717 specifically; if a port squatter
pushes the server to a fallback port, re-point the proxy.

## Uninstall

**Installed via npx?** `npx claude-golden-eye uninstall` (add `--purge` to
also delete `~/.golden-eye`) does the whole teardown.

**Or:** run `/golden-eye:uninstall` in any session — it walks the whole
teardown (asks before deleting data, checks tailscale + aliases, then removes
the plugins). The same script is runnable directly:
`sh <plugin root>/deploy/uninstall.sh [--purge]`.

Manual teardown, in order (skip steps for pieces you never set up):

```bash
# 1. Remove the plugins + marketplace (stops new sessions from hooking in)
claude plugin uninstall golden-eye@claude-golden-eye
claude plugin uninstall golden-eye-pm@claude-golden-eye
claude plugin marketplace remove claude-golden-eye

# 2. Stop the running server (it outlives sessions by design)
kill "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.golden-eye/server.json","utf8")).pid)' 2>/dev/null)" 2>/dev/null

# 3. launchd (only if you ran install-launchd.sh)
launchctl bootout "gui/$(id -u)/com.golden-eye.server" 2>/dev/null
rm -f ~/Library/LaunchAgents/com.golden-eye.server.plist

# 4. Tailscale proxy (only if you served the dashboard)
tailscale serve --https=443 off    # or whichever port you mapped

# 5. Data: event log, server/lock files, hook logs, composer token, config
rm -rf ~/.golden-eye

# 6. Shell alias (only if you added one) — delete the golden-eye lines
#    from ~/.zshrc (the `claude`/`claudege` alias for the channels flag)
```

Restart any open Claude Code sessions afterwards — hooks and the MCP channel
load at SessionStart, so live sessions keep their observers until restarted.
Without step 2 the last server keeps running until its 30-minute idle exit
(forever under launchd); without step 5 your session history stays on disk.

## Development

- `npm test` — four suites: the state reducer (agent FIFO binding + repair, PM
  state, task mirroring, log rotation), `/pm` prompt parsing (incl. regression
  pins for both historical parsing bugs), the tolerant transcript parser
  (usage sums, 200k/1M window inference), and endpoint integration against a
  real server boot (agent-transcript path validation, static traversal).
- The server self-identifies on `/healthz` (`name: "golden-eye"`); bootstrap only
  adopts servers that answer with it, so restart any pre-0.1.0 server after updating.

## Releasing

Publishing is automated via GitHub Actions + [npm trusted
publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no tokens, no
OTP). To cut a release:

```bash
# 1. move CHANGELOG.md's "## [Unreleased]" heading to "## [x.y.z] — <date>"
#    and start a fresh Unreleased section above it
# 2. bump "version" in package.json, both plugin manifests, the marketplace
#    entries and the MCP serverInfo, then commit
git tag v0.1.5
git push origin main --tags
```

Entries go under **Unreleased** as work lands, so the notes are written while
the reasoning is fresh rather than reconstructed at tag time. The workflow
feeds that section to the GitHub release via `scripts/changelog-section.sh`
and **fails if the tagged version has no section** — a release cannot ship
without notes. Write for someone using the plugin: what is new, what behaves
differently, what was broken. The commit log carries the reasoning.

`.github/workflows/release.yml` runs the tests, publishes to npm, and creates
a GitHub release from the matching [CHANGELOG.md](CHANGELOG.md) section. The trusted publisher is configured in
the package's npmjs settings (repo `amenophis1er/claude-golden-eye`, workflow
`release.yml`).
