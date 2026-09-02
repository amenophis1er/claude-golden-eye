# claude golden-eye

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

## Install locally (no publishing)

The repo is a self-contained marketplace.

```bash
# from this repo's directory
claude plugin marketplace add "$PWD"
claude plugin install golden-eye@claude-golden-eye        # the dashboard
claude plugin install golden-eye-pm@claude-golden-eye     # optional PM mode
claude plugin list                 # verify
```

- Updates after edits: `claude plugin update golden-eye` (then restart sessions).
- Disable/enable without uninstalling: `claude plugin disable|enable golden-eye`.
- Remove: `claude plugin uninstall golden-eye` (same for `golden-eye-pm`) and
  `claude plugin marketplace remove claude-golden-eye`.
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
/pm on --sub opus MISSION: fable PM, opus workforce
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
- **Subagent model pin** — `--sub <model>` (e.g. `--sub opus`) forces every delegation
  onto that model: the charter instructs the PM to set the Agent tool's `model` field,
  and the `PreToolUse` hook hard-rewrites the spawn input (`updatedInput`) if it is
  missing or different — logged as a `PMModelPin` event. The main agent keeps the
  session model (`/model`), so e.g. a Fable PM can run an all-Opus workforce.
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
   (full-screen warning; that's Anthropic's gate, not ours). Make it a
   dedicated alias so ordinary sessions stay flag-free:

   ```bash
   # ~/.zshrc — golden-eye session with the dashboard composer channel
   alias claudege='claude --dangerously-load-development-channels plugin:golden-eye@claude-golden-eye'
   ```

The composer box appears in a session's Live-tab rail only when both are true
(the session's channel bridge is connected). Sends are attributed in the feed
as `DashboardPrompt` rows. Routing is deterministic: hooks and the MCP process
share the claude process pid, so a message reaches exactly one session.

Security: the composer lets whoever reaches the HTTP port steer your sessions.
Direct loopback requests are trusted (Host-checked); **proxied** requests
(e.g. `tailscale serve` — they carry `X-Forwarded-*`) must send the
`X-Golden-Eye-Token` header matching `<data dir>/composer.token` (0600).
One-way by design: no reply tool, no permission relay — the dashboard already
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
- The dashboard API is loopback-only and rejects non-local `Host` headers, but
  has no auth: any process on the machine can read session data. Keep that in
  mind before proxying it anywhere (see the Tailscale section).
- Probe rig and findings for the original hook-payload discovery: [probe/](probe/).

## Dashboard UI

React + Vite + Tailwind (lucide icons, light/dark mode, hash-routed deep links like
`#/s/<session>/agents`). The built app is committed at `plugins/golden-eye/web/dist/` and served by the
zero-dependency server — end users need no build step.

- Sessions are grouped **Active / Idle / Stale** in the sidebar; stale ones can be
  pruned per-session or in bulk (persisted as `SessionPrune` tombstones so a server
  restart doesn't resurrect them). A `SessionEnd` hook marks closed sessions.
- The **Live** tab is the realtime view: a "now" strip of running agents (current
  tool + elapsed), an auto-following event feed (click any row for the raw payload),
  and a full-height panel with the main agent's latest prompt/output.
- UI development: `cd plugins/golden-eye/web && npm install && npm run dev` (Vite
  proxies `/api` + `/pm` to `127.0.0.1:7717`). Ship with `npm run build` and commit
  `web/dist/`.

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
tailscale serve --bg http://127.0.0.1:7717
# undo: tailscale serve reset
```

Caveats: the dashboard has no auth of its own — anyone on the tailnet can view
sessions and hit /pm & /api/prune. And the proxy targets :7717 specifically; if
a port squatter ever pushes the server to a fallback port, re-point the proxy.

## Development

- `npm test` — four suites: the state reducer (agent FIFO binding + repair, PM
  state, task mirroring, log rotation), `/pm` prompt parsing (incl. regression
  pins for both historical parsing bugs), the tolerant transcript parser
  (usage sums, 200k/1M window inference), and endpoint integration against a
  real server boot (agent-transcript path validation, static traversal).
- The server self-identifies on `/healthz` (`name: "golden-eye"`); bootstrap only
  adopts servers that answer with it, so restart any pre-0.1.0 server after updating.
