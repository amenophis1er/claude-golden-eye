# claude golden-eye

A Claude Code plugin that gives you a **live local dashboard** of what your sessions are
really doing — every agent spawned, every delegation, every blocked write — plus **PM-mode
discipline**: the main agent becomes a project manager that delegates instead of implementing,
re-anchored on every prompt, with hard hook enforcement.

- **Observer** — hooks → singleton local server → real-time web UI (agent tree, timeline, plan board)
- **PM discipline** — `/pm on` charter, per-prompt re-anchor, hook-enforced delegation
- **Agent self-reporting** — MCP `report_progress` / `get_mission`, progress bar, blocker detection
- **Walk-away mode** — desktop notifications when agents finish or missions block

Status: **M0–M3 complete and empirically verified.** Spec: [SPEC.md](SPEC.md) ·
Probe evidence: [probe/FINDINGS.md](probe/FINDINGS.md)

---

## Install locally (no publishing)

The repo is a self-contained single-plugin marketplace.

```bash
# from this repo's directory
claude plugin marketplace add "$PWD"
claude plugin install claude-golden-eye@claude-golden-eye
claude plugin list                 # verify
```

- Updates after edits: `claude plugin update claude-golden-eye` (then restart sessions).
- Disable/enable without uninstalling: `claude plugin disable|enable claude-golden-eye`.
- Remove: `claude plugin uninstall claude-golden-eye` and
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
3. In the session, run `/pm on MISSION: …` — the dashboard shows `PM ENGAGED`, the mission,
   and the charter the agent received.
4. Give the model a task that needs files. Expect it to **delegate**: main-agent writes are
   hook-denied with an explanatory reason; the dashboard gets a red `DENY` row and a counter.
5. Subagents appear live in the agent tree (spawn prompt → tool calls → final report).
6. Try `/pm off` when done. Toggle dashboard tabs across multiple open sessions via the
   session chips (N sessions ⇒ 1 window).

## PM mode

```
/pm on — MISSION: ship the payments refactor; subagents only
/pm on --sub opus MISSION: fable PM, opus workforce
/pm off
```

(The namespaced form `/claude-golden-eye:pm …` works identically.)

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

Bundled MCP server (`server/mcp-server.js`, zero-dependency stdio JSON-RPC):

- `report_progress({ state: working|blocked|done, progress_pct?, note? })` — agents report
  milestones; call once before finishing per the PM charter. Resolves session by cwd.
- `get_mission()` — agent-side self re-anchor (mission, PM state, progress, stats).

Progress drives the mission card's bar; `blocked` shows red and fires a desktop
notification (macOS).

## Notifications

Throttled (≥5 s) macOS notifications (`GOLDEN_EYE_NOTIFY=0` to disable): subagent finished ·
PM write blocked · mission blocked · turn ended.

## Singleton lifecycle

**Many Claude Code sessions, ONE dashboard.** Sessions never start their own UI:

```
any session's SessionStart hook
  └── node server/boot.js
        ├─ server.json healthy?            → do nothing (reuse)
        ├─ healthz probe on 7717–7721?     → reuse, do nothing
        └─ else: exclusive lockfile + spawn ONE detached server
              └─ writes server.json { pid, port }   (SIGINT/TERM removes it)
hooks POST events  →  follow server.json port (not hardcoded)
idle 30 min + no dashboard open  →  server shuts itself down
```

Default data dir: `~/.golden-eye/` (all projects converge). Manual run stays available:
`node server/index.js`.

## Dashboard panels

- **Mission** — state, PM pill, mission text, progress bar, last prompt/turn result
- **Agent tree** — main + subagents: status, delegation prompt, final report, tool histograms
- **Plan board** — mirrored from `TaskCreate`/`TaskUpdate` (legacy `TodoWrite` too)
- **Discipline** — delegations, tool calls, main-session writes, writes blocked by PM
- **Event timeline** — every hook event with MAIN/agent attribution and deny markers

## Architecture

```
hooks/   (one thin process per Claude hook event, fail-soft)
  ├── JSONL log .probe/hook-events.jsonl   (fallback, always)
  └── POST /ingest → server (port from server.json, best-effort)
server/  singleton node process (no dependencies, no build step)
  ├── index.js   HTTP ingest + /pm bridge + /mcp/attach + SSE + static hosting
  ├── state.js   event store + reducer (sessions, agents, tasks, progress) — replay on boot
  ├── mcp-server.js  stdio JSON-RPC (report_progress, get_mission)
  └── boot.js    idempotent singleton bootstrap (SessionStart)
web/     vanilla-JS dashboard (SSE live, textContent only)
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GOLDEN_EYE_DATA_DIR` | `~/.golden-eye` | store + server.json |
| `GOLDEN_EYE_PORT` | 7717 (candidates →7721) | preferred port |
| `GOLDEN_EYE_HOST` | 127.0.0.1 | bind host |
| `GOLDEN_EYE_SERVER_URL` | from `server.json` | hook override |
| `GOLDEN_EYE_IDLE_EXIT_MS` | 1 800 000 (30 min) | auto-exit (0 = never) |
| `GOLDEN_EYE_NOTIFY` | on | set `0` to disable notifications |
| `GOLDEN_EYE_DISABLE_POST` | unset | `1` = local logging only |

## Known limits

- Spawn→child binding: deterministic at collection (`PostToolUse(Agent).tool_response.agentId`);
  early FIFO hint can mis-label under parallel spawns until the repair lands.
- Plan board mirrors the `TaskCreate`/`TaskUpdate` system + legacy `TodoWrite`.
- Denied calls appear as `PRE` rows without `POST` (Pre-without-Post = denial signal).
- `startSource: null` means the session was observed without a `SessionStart` (attached mid-stream).
- Probe rig and findings for the original M0 payload discovery: [probe/](probe/).

## Dashboard UI

React + Vite + Tailwind (lucide icons, light/dark mode, hash-routed deep links like
`#/s/<session>/agents`). The built app is committed at `web/dist/` and served by the
zero-dependency server — end users need no build step.

- Sessions are grouped **Active / Idle / Stale** in the sidebar; stale ones can be
  pruned per-session or in bulk (persisted as `SessionPrune` tombstones so a server
  restart doesn't resurrect them). A `SessionEnd` hook marks closed sessions.
- The **Live** tab is the realtime view: a "now" strip of running agents (current
  tool + elapsed), an auto-following event feed (click any row for the raw payload),
  and a full-height panel with the main agent's latest prompt/output.
- UI development: `cd web && npm install && npm run dev` (Vite proxies `/api` + `/pm`
  to `127.0.0.1:7717`). Ship with `npm run build` and commit `web/dist/`.

## Development

- `node --test` — reducer tests for `server/state.js` (agent FIFO binding + repair,
  PM state, task mirroring, log rotation).
- The server self-identifies on `/healthz` (`name: "golden-eye"`); bootstrap only
  adopts servers that answer with it, so restart any pre-0.1.0 server after updating.
