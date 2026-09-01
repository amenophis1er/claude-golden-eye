# Hook-payload probe — findings

- **Date:** 2026-08-31 · **claude:** 2.1.221 · **node:** v26.5.0 · **auth:** team OAuth
- **Method:** 6 logger hooks wired into `probe/test-project/.claude/settings.json`; one headless
  `claude -p` run: main agent writes a file, spawns one `general-purpose` subagent that writes
  two files, then summarizes. Raw evidence: `.probe/hook-events.jsonl` (11 events),
  `session-result.json`, `session-stderr.txt`.

## Q1 — Can hooks distinguish main-session vs subagent tool calls? ✅ YES

| Context | `session_id` | `agent_id` | `agent_type` |
|---|---|---|---|
| Main agent `Write` (main-agent-file.txt) | `75a8d451…` | **absent** | absent |
| Subagent `Write` (sub-agent-file-*.txt) | `75a8d451…` (same!) | `a257c37b45c232b33` | `general-purpose` |

- `session_id` is **shared** between main and subagent events — it is *not* a discriminator.
- **The discriminator is the presence of `agent_id`** (plus `agent_type`, `agent_transcript_path`).
- **PM-enforcement consequence:** a `PreToolUse` deny on Write/Edit that fires only when the
  payload *lacks* `agent_id` = main-session-only blocking. Feasible, now proven at the payload
  level. Later confirmed by a live smoke test that a deny decision actually blocks + guides (finding 10).

## Q2 — What does a spawn/collection cycle expose? ✅ Everything the Observer needs

Note: the spawn tool is named **`Agent`** in 2.1.221 (was `Task` in older docs/versions).

**Spawn (`PreToolUse`/`PostToolUse` with `tool_name: "Agent"`):**
- `tool_input.description` + `tool_input.prompt` — the *full delegation prompt is visible at
  spawn time* → agent tree nodes can show what each subagent was asked to do, before it finishes
- `tool_use_id` on both; `duration_ms` on PostToolUse (29 364 ms for the whole delegation)

**Collection (`SubagentStop`):**
- `agent_id`, `agent_type`
- `agent_transcript_path` — per-subagent transcript at `<session-dir>/subagents/agent-<id>.jsonl`
  → the passive tailing path works per-subagent, not just per-session
- `last_assistant_message` — the subagent's **final report text** arrives free with the event
- `stop_hook_active`, `background_tasks`, `session_crons`

**Correlation caveat:** the spawn event carries no `agent_id`, and `SubagentStop` carries no
spawn `tool_use_id`. With multiple concurrent subagents, correlate spawn → child by
`prompt_id` + time proximity (or by diffing the `subagents/` directory). Later retired by finding 3.

**Ordering nuance:** `SubagentStop` fires ~34 ms *before* the parent's `PostToolUse(Agent)`
completes — the event flow is child-stop, then parent-collection. Build the UI accordingly.

## Q3 — Bonus findings

1. ~~SessionStart does not fire in headless `-p`~~ **CORRECTED by a second run in a normal
   (non-sandboxed) environment:** `SessionStart` fires reliably in both headless and
   interactive sessions, payload includes `source` (`"startup"` etc.). The earlier negative
   result was an artifact of running the probe inside a file-access sandbox (the hook
   spawn/write was blocked). Treat a missing SessionStart as "attached mid-stream" instead.
2. **`TodoWrite` is gone in 2.1.221.** The model reported "TodoWrite isn't available here";
   plan tracking now flows through the ToolSearch-discoverable tasks system:
   `TaskCreate` (subject/description) + `TaskUpdate` (`taskId`, `status` transitions:
   pending → in_progress → completed). The plan board mirrors both `TodoWrite` (legacy) and
   the `TaskCreate`/`TaskUpdate` stream (current).
3. **The spawn→child correlation caveat is retired:** `PostToolUse(Agent).tool_response`
   carries `agentId` and `agentType` — a deterministic mapping that repairs any early FIFO
   mis-label. Also exposed at spawn time: `tool_input.subagent_type` and
   `tool_input.run_in_background` (background agents are addressable too).
4. **`prompt_id` groups every event of one user prompt** (shared across main AND subagent
   events of that turn) — turn-level grouping comes free.
5. `PostToolUse.duration_ms` and `permission_mode` are present on every tool event.
6. `UserPromptSubmit` carries the full prompt text — the PM re-anchor has everything it needs.
7. Existing hook consumers on this machine (user settings: Otty integration + `claude-voice`
   dispatch on most events) — the plugin must merge with, never clobber, other hook configs.
8. **Denied tool calls are visible in the event stream** (observed live): a denied or
   erroring call fires `PreToolUse` but never `PostToolUse` — a Pre-without-Post pair is a free
   denial/blocked-call signal for the Observer's timeline. (A sandboxed run showed 8 such
   denials; the non-sandboxed rerun showed 0 — the signal is environment-sensitive, exactly
   the kind of thing this dashboard exists to surface.)
9. **Slash-command namespace collision (smoke test):** unknown `/commands` are rejected
   client-side by Claude Code — *before* `UserPromptSubmit` hooks fire (headless printed
   `Unknown command: /pm`). A plugin must register a real `commands/pm.md`; the hook then
   sees the command's **expansion** (body with `$ARGUMENTS` substituted), not the raw slash
   text. Pattern: embed a unique marker token in the command body and parse it in the hook.
10. **The `PreToolUse` deny JSON contract is empirically confirmed** (smoke test):
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
   "permissionDecisionReason":"…"}}` on stdout blocks main-session writes even under
   `--dangerously-skip-permissions`, the reason text reaches the model, and the agent
   adapts by delegating. Subagent calls (payload carries `agent_id`) are untouched.
11. **MCP plugin wiring confirmed live:** a hand-rolled stdio JSON-RPC server
   (newline-delimited) works via `--mcp-config` headless; MCP tool calls surface in hooks
   as `mcp__golden-eye__report_progress`. Session attribution: MCP servers get cwd, not
   session_id — resolution by "most recently active session with same cwd" works. Pitfall
   found+fixed: stdio servers must drain in-flight async handlers on stdin close before
   `process.exit`, else the final `tools/call` dies mid-flight.

## Design consequences

- Observer: the full agent tree (spawn reason, live per-child tool calls, final report,
  durations) is derivable from hooks **alone**; transcript tailing is the fidelity booster, not
  a crutch. Hybrid path confirmed.
- PM mode: enforcement via `agent_id` discrimination is viable; re-anchor via
  `UserPromptSubmit` is viable. Both open risks are retired; the live deny smoke test (finding 10) closed the last one.
- Terminology: docs' `Task` tool = runtime `Agent` tool in 2.1.221.