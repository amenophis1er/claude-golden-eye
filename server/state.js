'use strict';

/**
 * Golden-eye state: ingests hook events, maintains sessions/agents/todos.
 * Zero dependencies. Events persist as JSONL and are replayed on boot, so a
 * dashboard restart keeps its session history.
 *
 * Correlation note (see probe/FINDINGS.md): spawn events (PreToolUse/PostToolUse
 * on the Agent tool) carry no agent_id; SubagentStop carries agent_id but no
 * tool_use_id. Binding is FIFO over unbound spawns — correct for sequential
 * (PM-style) delegation, best-effort for parallel spawns. Flagged for M2.
 */

const fs = require('fs');

const { DATA_DIR, EVENTS_FILE } = require('./config');
const MAX_EVENTS_IN_MEMORY = 2000;
const ROTATE_FILE_BYTES = 10 * 1024 * 1024;
const ROTATE_KEEP_LINES = 1000;

const nowIso = () => new Date().toISOString();

const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const WRITE_TOOLS = /Edit|Write|MultiEdit|NotebookEdit/;

/**
 * Rotation keeps the tail of the log, but a session whose recent events
 * survive must not lose its earlier state-bearing events: dropping a PMSync
 * would silently disengage pmMode/mission on the next replay. Those events
 * (plus SessionStart, for cwd/startedAt) are carried over from the truncated
 * head for every session still represented in the kept tail.
 */
function rotateLines(lines) {
  const kept = lines.slice(-ROTATE_KEEP_LINES);
  if (kept.length === lines.length) return kept;
  const keptSessions = new Set();
  for (const line of kept) {
    try {
      const sid = JSON.parse(line).payload.session_id;
      if (sid) keptSessions.add(sid);
    } catch (_) {}
  }
  const preserved = [];
  for (const line of lines.slice(0, lines.length - kept.length)) {
    try {
      const e = JSON.parse(line);
      if (
        (e.__hook === 'PMSync' || e.__hook === 'SessionStart') &&
        e.payload &&
        keptSessions.has(e.payload.session_id)
      ) {
        preserved.push(line);
      }
    } catch (_) {}
  }
  return preserved.concat(kept);
}

function newAgent(overrides = {}) {
  return Object.assign(
    {
      id: null,            // bound claude agent_id once known
      boundId: null,       // same as id; null while unbound spawn placeholder
      spawnKey: null,      // which spawn slot the FIFO guess consumed (repairable)
      model: null,         // requested model from spawn input (tool_input.model)
      mainAgent: false,
      type: null,          // e.g. "general-purpose", "main"
      description: null,   // delegation description (spawn payload)
      prompt: null,        // full delegation prompt (spawn payload)
      status: 'running',   // starting | running | done
      startedAt: null,
      endedAt: null,
      durationMs: null,
      lastMessage: null,   // subagent final report (SubagentStop)
      transcriptPath: null,
      lastTool: null,
      lastToolAt: null,
      tools: {},
      toolEvents: 0,
    },
    overrides
  );
}

class Store {
  constructor() {
    this.sessions = new Map();
    this.events = [];
    this.load();
  }

  load() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
    try {
      if (fs.existsSync(EVENTS_FILE) && fs.statSync(EVENTS_FILE).size > ROTATE_FILE_BYTES) {
        const lines = fs.readFileSync(EVENTS_FILE, 'utf8').trimEnd().split('\n');
        fs.writeFileSync(EVENTS_FILE, rotateLines(lines).join('\n') + '\n');
      }
      if (fs.existsSync(EVENTS_FILE)) {
        for (const line of fs.readFileSync(EVENTS_FILE, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { this.addEvent(JSON.parse(line), { persist: false }); } catch (_) {}
        }
      }
    } catch (_) {
      /* unrecoverable data dir problems: start clean rather than crash */
      this.sessions = new Map();
      this.events = [];
    }
  }

  addEvent(event, { persist = true } = {}) {
    if (!event || !event.payload) return null;
    const e = {
      __ts: event.__ts || nowIso(),
      __hook: event.__hook || '(unknown)',
      payload: event.payload,
    };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-MAX_EVENTS_IN_MEMORY);
    }
    if (persist) {
      try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(e) + '\n'); } catch (_) {}
    }
    try { this.reduce(e); } catch (_) { /* a bad event must never kill ingest */ }
    return e;
  }

  getOrCreateSession(p, ts) {
    let s = this.sessions.get(p.session_id);
    if (!s) {
      s = {
        id: p.session_id,
        cwd: p.cwd || null,
        transcriptPath: p.transcript_path || null,
        permissionMode: p.permission_mode || null,
        startedAt: ts,
        lastPromptAt: null,
        lastActivity: ts,
        state: 'active',
        lastPrompt: null,
        lastResult: null,
        todos: [],
        tasks: [],
        startSource: null,
        pmMode: false,
        mission: null,
        subModel: null,
        progress: null,
        agents: {},
        stats: { spawns: 0, toolCalls: 0, mainWrites: 0, denies: 0 },
      };
      this.sessions.set(p.session_id, s);
    }
    return s;
  }

  ensureMainAgent(s) {
    if (!s.agents.__main__) {
      s.agents.__main__ = newAgent({
        id: '__main__', boundId: '__main__', mainAgent: true, type: 'main',
        description: 'Main session', startedAt: s.startedAt,
      });
    }
    return s.agents.__main__;
  }

  // FIFO-bind an arriving agent_id to the oldest unbound spawn slot.
  bindAgent(s, agentId) {
    let a = null;
    for (const key of Object.keys(s.agents)) {
      const cand = s.agents[key];
      if (!cand.mainAgent && cand.boundId === null) {
        a = cand;
        a.spawnKey = key; // remember the guess: PostToolUse(Agent) can repair it
        delete s.agents[key];
        break;
      }
    }
    if (!a) a = newAgent();
    a.boundId = agentId;
    a.id = agentId;
    s.agents['agent:' + agentId] = a;
    return a;
  }

  agentForToolEvent(s, p) {
    if (p.agent_id) {
      return s.agents['agent:' + p.agent_id] || this.bindAgent(s, p.agent_id);
    }
    return this.ensureMainAgent(s);
  }

  reduce(e) {
    const p = e.payload || {};
    if (!p.session_id) return;
    if (e.__hook === 'SessionPrune') {
      // Tombstone: must not pass through getOrCreateSession (it would
      // resurrect the session it is deleting).
      this.sessions.delete(p.session_id);
      return;
    }
    const s = this.getOrCreateSession(p, e.__ts);
    s.lastActivity = e.__ts;

    switch (e.__hook) {
      case 'SessionStart': {
        // Fires in normal (non-sandboxed) runs, e.g. source "startup".
        if (p.source && !s.startSource) s.startSource = p.source;
        // A start (fresh or "resume") supersedes any earlier SessionEnd —
        // without this, a restarted session stays labeled "ended"/stale.
        s.state = 'idle';
        break;
      }

      case 'PMSync': {
        // Golden-eye discipline bridge (not a Claude Code hook event): the
        // /pm command path flips engagement and stores the mission.
        s.pmMode = e.payload.action === 'on';
        if (e.payload.action === 'on') {
          if (e.payload.mission) s.mission = e.payload.mission;
          s.subModel = e.payload.sub_model || null;
        }
        break;
      }

      case 'PMDeny': {
        // Main-session write blocked under PM mode.
        s.stats.denies = (s.stats.denies || 0) + 1;
        break;
      }

      case 'MCPProgress': {
        // Agent-reported progress via the golden-eye MCP server (session_id
        // was already resolved by /mcp/attach).
        s.progress = {
          state: e.payload.state || 'working',
          pct: typeof e.payload.progress_pct === 'number' ? e.payload.progress_pct : null,
          note: e.payload.note || '',
          updatedAt: e.__ts,
        };
        break;
      }

      case 'UserPromptSubmit': {
        s.state = 'working';
        s.lastPrompt = typeof p.prompt === 'string' ? p.prompt : s.lastPrompt;
        s.lastPromptAt = e.__ts;
        break;
      }

      case 'PreToolUse': {
        // Tool activity IS work. Stop and the next UserPromptSubmit can land
        // out of order (separate hook processes, same second), so never let
        // a late-arriving Stop leave an actively-ticking session on "idle".
        s.state = 'working';
        const tool = p.tool_name || '?';
        if (SPAWN_TOOLS.has(tool)) {
          const key = 'spawn:' + (p.tool_use_id || e.__ts);
          s.agents[key] = newAgent({
            id: key,
            status: 'starting',
            description: (p.tool_input && p.tool_input.description) || null,
            prompt: (p.tool_input && p.tool_input.prompt) || null,
            model: (p.tool_input && p.tool_input.model) || null,
            startedAt: e.__ts,
          });
          s.stats.spawns += 1;
        } else {
          // PreToolUse counts each attempt once (denied calls fire Pre but
          // never Post — a Pre-without-Post pair IS a denial signal).
          s.stats.toolCalls += 1;
          const a = this.agentForToolEvent(s, p);
          // A tool event proves the agent is alive — "starting" otherwise
          // sticks until the parent's collection event at delegation end.
          if (!a.mainAgent && a.status === 'starting') a.status = 'running';
          a.lastTool = tool;
          a.lastToolAt = e.__ts;
          a.tools[tool] = (a.tools[tool] || 0) + 1;
          a.toolEvents += 1;
          if (!p.agent_id && WRITE_TOOLS.test(tool)) s.stats.mainWrites += 1;
        }
        break;
      }

      case 'PostToolUse': {
        s.state = 'working'; // see PreToolUse note
        const tool = p.tool_name || '?';
        if (SPAWN_TOOLS.has(tool)) {
          // Collection event: tool_response.agentId gives the DETERMINISTIC
          // spawn→child mapping. Child tool events / SubagentStop arrive
          // first and FIFO-bind a slot as a guess; this event verifies that
          // guess — or repairs it, including parallel-spawn cross-binds.
          const key = 'spawn:' + (p.tool_use_id || '');
          const slot = s.agents[key];
          const resp = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
          if (slot && slot.status === 'starting') slot.status = 'running';
          if (resp.agentId) {
            const trueKey = 'agent:' + resp.agentId;
            let a = s.agents[trueKey];
            if (a && a.spawnKey && a.spawnKey !== key && slot) {
              // Cross-bind: this child FIFO-consumed another spawn's slot.
              // Restore that slot (its rightful child repairs it in its own
              // collection event), then adopt THIS spawn's metadata.
              s.agents[a.spawnKey] = newAgent({
                id: a.spawnKey,
                status: 'starting',
                description: a.description,
                prompt: a.prompt,
                startedAt: a.startedAt,
              });
              a.prompt = slot.prompt;
              a.description = slot.description;
              a.startedAt = slot.startedAt;
              a.spawnKey = key;
              delete s.agents[key];
            } else if (a && a !== slot) {
              // Agent of unknown origin (e.g. created bare by SubagentStop):
              // fill its gaps from the deterministic slot.
              if (slot) {
                if (a.prompt == null) a.prompt = slot.prompt;
                if (a.description == null) a.description = slot.description;
                if (a.startedAt == null) a.startedAt = slot.startedAt;
                if (a.spawnKey == null) a.spawnKey = key;
                delete s.agents[key];
              }
            } else if (slot) {
              slot.boundId = resp.agentId;
              slot.id = resp.agentId;
              slot.spawnKey = key;
              delete s.agents[key];
              s.agents[trueKey] = slot;
              a = slot;
            }
            if (a) {
              if (p.duration_ms != null && a.durationMs == null) a.durationMs = p.duration_ms;
              if (resp.agentType && !a.type) a.type = resp.agentType;
              // PostToolUse carries the input the tool actually ran with —
              // including a model injected by the PMModelPin rewrite.
              if (p.tool_input && p.tool_input.model) a.model = p.tool_input.model;
            }
          } else if (slot && p.duration_ms != null) {
            slot.durationMs = p.duration_ms;
          }
        } else {
          if (tool === 'TaskCreate') {
            // Modern todo system (TodoWrite is gone in 2.1.x). Mirror tasks.
            const subj = (p.tool_input && p.tool_input.subject) || '(task)';
            const resp = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
            const tid = resp.taskId ?? resp.id ?? (resp.task && (resp.task.taskId ?? resp.task.id));
            s.tasks.push({
              id: tid != null ? String(tid) : 'task-' + (s.tasks.length + 1),
              content: subj,
              status: 'pending',
            });
          } else if (tool === 'TaskUpdate') {
            const inp = p.tool_input || {};
            const tid = String(inp.taskId ?? '');
            const item = s.tasks.find((t) => t.id === tid);
            if (item) {
              if (inp.status) item.status = inp.status;
              if (inp.subject) item.content = inp.subject;
            } else if (tid) {
              // Resumed session: TaskCreate predates our hooks — upsert so
              // the plan board isn't blind to pre-resume tasks.
              s.tasks.push({ id: tid, content: inp.subject || 'task ' + tid, status: inp.status || 'pending' });
            }
          } else if (tool === 'TaskList' || tool === 'TaskGet') {
            // Hydrate the board from list/get responses (fills in subjects
            // and statuses for tasks created before we were watching).
            const resp = p.tool_response;
            const arr = Array.isArray(resp)
              ? resp
              : resp && Array.isArray(resp.tasks)
                ? resp.tasks
                : resp && resp.task && typeof resp.task === 'object'
                  ? [resp.task]
                  : [];
            for (const t of arr) {
              if (!t || typeof t !== 'object') continue;
              const tid = String(t.taskId ?? t.id ?? '');
              if (!tid) continue;
              const content = t.subject ?? t.content ?? null;
              const status = t.status ?? null;
              const item = s.tasks.find((x) => x.id === tid);
              if (item) {
                if (content) item.content = content;
                if (status) item.status = status;
              } else {
                s.tasks.push({ id: tid, content: content || 'task ' + tid, status: status || 'pending' });
              }
            }
          } else if (tool === 'TodoWrite') {
            const t = (p.tool_input && p.tool_input.todos) || (p.tool_response && p.tool_response.todos);
            if (Array.isArray(t)) s.todos = t;
          }
          // Attribution for every collection event (counts taken at Pre).
          const a = this.agentForToolEvent(s, p);
          a.lastTool = tool;
          a.lastToolAt = e.__ts;
        }
        break;
      }

      case 'SubagentStop': {
        // The slot may already have been FIFO-bound by this child's first
        // tagged tool event (they arrive before SubagentStop). Reuse it so we
        // keep its delegation prompt/startedAt instead of overwriting.
        let a = s.agents['agent:' + (p.agent_id || '')];
        if (!a) a = this.bindAgent(s, p.agent_id || 'unknown:' + e.__ts);
        if (p.agent_type) a.type = p.agent_type;
        a.status = 'done';
        a.endedAt = e.__ts;
        if (a.durationMs == null && a.startedAt) {
          a.durationMs = Date.parse(e.__ts) - Date.parse(a.startedAt);
        }
        if (p.last_assistant_message != null) a.lastMessage = p.last_assistant_message;
        if (p.agent_transcript_path) a.transcriptPath = p.agent_transcript_path;
        break;
      }

      case 'SessionEnd': {
        s.state = 'ended';
        break;
      }

      case 'Stop': {
        // A Stop that lands after a NEWER prompt (hook processes race within
        // the same second) must not flip the fresh turn back to idle. The
        // hook-side __ts timestamps carry ms precision, so compare those.
        if (!(s.lastPromptAt && String(s.lastPromptAt) > String(e.__ts))) {
          s.state = 'idle';
        }
        if (p.last_assistant_message != null) s.lastResult = p.last_assistant_message;
        break;
      }

      default:
        break; // SessionStart etc. — keep, but no state change
    }
  }

  serialize() {
    return {
      generatedAt: nowIso(),
      sessions: [...this.sessions.values()]
        .sort((x, y) => String(y.lastActivity).localeCompare(String(x.lastActivity)))
        .map((s) => ({
          id: s.id,
          cwd: s.cwd,
          transcriptPath: s.transcriptPath,
          permissionMode: s.permissionMode,
          startedAt: s.startedAt,
          lastPromptAt: s.lastPromptAt,
          lastActivity: s.lastActivity,
          state: s.state,
          startSource: s.startSource,
          pmMode: !!s.pmMode,
          mission: s.mission || null,
          subModel: s.subModel || null,
          progress: s.progress || null,
          lastPrompt: s.lastPrompt,
          lastResult: s.lastResult,
          todos: s.tasks.length ? s.tasks : s.todos,
          stats: s.stats,
          agents: Object.values(s.agents).map((a) => ({
            ...a,
            tools: { ...a.tools },
            // The main agent's card follows session state (Stop ⇒ done).
            status: a.mainAgent ? (s.state === 'idle' ? 'done' : 'running') : a.status,
          })),
        })),
      events: this.events.slice(-400),
    };
  }
}

Store.rotateLines = rotateLines; // exposed for tests

module.exports = Store;