# claude-golden-eye — Product Spec

A Claude Code plugin + local web UI that (a) gives you a live, detailed view of what your
Claude Code session is doing — including every agent it spawns — and (b) keeps the main agent
operating as a **project manager** that delegates work instead of implementing it.

> Positioning: Claude Code hooks currently cannot bridge context between subagents and the
> parent (anthropics/claude-code#5812). The golden-eye server *is* that bridge: subagent
> status flows into it, and re-anchored context flows back into the parent's turns.

---

## 1. Problem → mechanism map

| Pain | Mechanism | Run |
|---|---|---|
| Can't see what agents are doing | Lifecycle hooks → local server → web UI; JSONL transcript tails for detail | V0 |
| Main agent drifts in chat back-and-forth | `UserPromptSubmit` hook re-injects mission + team state before every prompt | V1 |
| Want autonomy + oversight | UI mission header, live agent tree, (later) notifications | V0→V2 |
| Main agent should delegate, not implement | `/pm` charter + `PreToolUse` deny on Edit/Write in the main session | V1 |

Two layers, deliberately separated:
- **Observer** (V0): read-only. Zero influence on agent behavior.
- **Discipline** (V1): changes agent behavior via injected context and hook enforcement.

## 2. Architecture

One local Node process plays three roles. It is a **singleton over a global store**
(`~/.golden-eye/`): each session's `SessionStart` runs idempotent `boot.js`, which reuses a
healthy server (server.json + healthz probe on 7717–7721) or spawns exactly one detached
instance; hooks POST to the port recorded in `server.json`; the server auto-exits after 30
idle minutes with no dashboard open. N sessions ⇒ 1 UI:

```
Claude Code session
 ├─ hooks/  ──POST /events──▶ ┌──────────────────┐     ┌──────────────┐
 │  SessionStart              │  server (node)   │────▶│  web UI      │
 │  UserPromptSubmit ◀────────│  · HTTP ingest    │ SSE │  (one view,  │
 │  PreToolUse ◀─deny/allow───│  · MCP server     │     │   deep)      │
 │  PostToolUse (Task spawn)  │  · static hosting │     └──────────────┘
 │  SubagentStop / Stop       └──────────────────┘
 └─ MCP tools: report_progress, request_context   (active path)
        +
 JSONL transcript tails under ~/.claude/projects/<hash>/<session>.jsonl  (passive path)
```

**Hybrid data policy**: hooks/MCP give structured semantics (agents, goals, status);
transcript tails give raw fidelity (every tool call, todos, exact prompts). Neither is trusted
alone.

## 3. Components

```
claude-golden-eye/
├── .claude-plugin/plugin.json   # incl. mcpServers registration (M3)
├── hooks/                       # thin stdin-JSON → POST wrappers
│   ├── hooks.json
│   ├── lib/logger.js            # stdin→JSONL log + server POST bridge
│   ├── lib/pm.js                # PM state bridge + charter/re-anchor texts
│   ├── session-start.js
│   ├── user-prompt-submit.js    # the re-anchor + /pm handling (V1 core)
│   ├── pre-tool-use.js          # delegation enforcement (V1)
│   ├── post-tool-use.js         # Task spawn capture
│   ├── subagent-stop.js
│   └── stop.js
├── server/
│   ├── boot.js                  # SessionStart singleton bootstrap (lock + healthz)
│   ├── config.js
│   ├── index.js                 # single process: ingest + PM API + SSE + static
│   ├── state.js                 # sessions/agents/events reducer + JSONL replay
│   └── mcp-server.js            # stdio JSON-RPC: report_progress / get_mission
├── web/                         # React+Vite dashboard (src/ → committed dist/)
├── commands/pm.md               # /pm → toggle manager mode
├── test/state.test.js           # reducer tests — `node --test`
└── SPEC.md
```

Planned, not yet built: `commands/eye.md` (/eye → open dashboard), `commands/status.md`.
(The passive transcript path shipped as `server/transcript.js` + `/api/agent-transcript`.)

## 4. Data model (server)

- `Session { id, cwd, startedAt, mission, pmMode, transcriptPath }`
- `Agent { id, parentId, prompt, status: running|done|blocked, startedAt, lastEvent, result }`
- `Event { ts, type, agentId?, payload }` — types: `session_start, prompt, tool_use,
  agent_spawn, agent_stop, delegation_denied, progress, session_stop`
- Persistence: JSON file (crash-safe enough); UI subscribes via SSE.

## 5. The PM charter (what /pm + UserPromptSubmit inject)

```
You are acting as PROJECT MANAGER for this session.
- Decompose the mission; delegate implementation via Task subagents.
- Never implement yourself: Edit/Write in the main session is BLOCKED. Delegate instead.
- Before finishing a turn: call report_progress (goal, state, blockers, next action).
Current mission: <mission file / latest statement>
Team status: <agent tree summary from monitor>
Open blockers: <…>
```

The re-anchor is the anti-drift core: it fires on **every** `UserPromptSubmit`, so the
mission and live team state are refreshed into context each turn regardless of how deep the
conversation has wandered.

## 6. UI (one session, deep)

- **Mission header** — charter, mission statement, PM-mode indicator
- **Agent tree** — main + spawned agents, live status, current tool, result summary
- **Event timeline** — spawns, tool calls, completions, denials
- **Plan board** — todos extracted from transcript tail
- **Discipline panel** — delegation ratio; count of main-session Edit/Write attempts blocked

## 7. Build milestones

- **M0 — Probe.** Plugin skeleton + hook logger; verify experimentally: does `PreToolUse`
  distinguish main-session vs subagent calls (`session_id`/`transcript_path`)? What does the
  `PostToolUse(Task)` payload actually contain about the subagent? → **DONE** — answered and
  written up in [probe/FINDINGS.md](probe/FINDINGS.md): discrimination via `agent_id` presence,
  spawn prompt + per-subagent transcript + final report all exposed.
- **M1 = V0.** Server + ingest + state; SSE; UI with timeline + agent tree (+ transcript tail).
- **M2 = V1 — DONE.** `/pm` (registered command + marker-expansion hook), per-prompt
  `UserPromptSubmit` re-anchor, and `PreToolUse` delegation enforcement — live deny smoke
  test passed: main-agent Write denied with reason, agent adapted by delegating, dashboard
  recorded `PMDeny` (see probe/FINDINGS.md items 9–10).
- **M3 ≈ V2 — DONE (core).** Dependency-free MCP server (`report_progress`, `get_mission`)
  registered via plugin.json `mcpServers`; `/mcp/attach` resolves sessions by cwd;
  `MCPProgress` events drive a session progress bar + `blocked` detection; desktop
  notifications (SubagentStop/PMDeny/blocked/Stop). Live smoke test passed: agent called
  `report_progress` under PM mode and the dashboard showed done@100%.

## 8. Known risks / open questions

- ~~PreToolUse main-vs-subagent distinction~~ **RESOLVED by M0:** subagent tool events carry
  `agent_id`/`agent_type`; main-session events don't (same `session_id` either way). Details in
  [probe/FINDINGS.md](probe/FINDINGS.md). Remaining: live deny smoke test (M2).
- Subagent internals may be thinner in hook payloads than in transcripts → hybrid path covers it;
  M0 confirmed per-subagent transcripts exist at `<session>/subagents/agent-<id>.jsonl`.
- Transcript JSONL format is unofficial; keep the tail parser tolerant and version-aware.
- Enforcement must degrade gracefully: a deny reason is guidance, not a hard wall — always
  pair it with a delegation hint the agent can act on.
- ~~SessionStart does not fire in headless `-p`~~ **REVERSED by a non-sandboxed rerun:**
  SessionStart fires reliably (payload includes `source`); the original negative was a
  sandbox artifact. Missing SessionStart now *means something*: attached mid-stream.