'use strict';

/**
 * golden-eye dashboard client. Renders /api/state snapshots; live-updates via
 * SSE from /api/events. All untrusted strings (prompts, reports, tool input)
 * are rendered with textContent only — never innerHTML.
 */

let state = null;
let selectedSession = null;

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function kvRow(k, v) {
  const row = el('div', 'kv');
  row.append(el('span', 'k', k));
  const val = el('span', 'v');
  val.textContent = v == null ? '—' : String(v);
  row.append(val);
  return row;
}

function shortId(id) { return id ? String(id).slice(0, 8) : '?'; }
function shortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function baseName(p) { return p ? String(p).split('/').filter(Boolean).pop() : '—'; }
function fmtDur(ms) { return ms == null ? '' : (ms / 1000).toFixed(1) + 's'; }

function setConn(ok) {
  $('#conn-dot').className = 'dot ' + (ok ? 'on' : 'off');
  $('#conn-label').textContent = ok ? 'live' : 'reconnecting…';
}

/* ---------- session selection ---------- */

function pickDefaultSession() {
  if (!state || !state.sessions.length) return null;
  if (selectedSession && state.sessions.some((s) => s.id === selectedSession)) {
    return state.sessions.find((s) => s.id === selectedSession);
  }
  selectedSession = state.sessions[0].id;
  return state.sessions[0];
}

function renderChips() {
  const nav = $('#session-chips');
  nav.textContent = '';
  for (const s of state.sessions) {
    const chip = el('button', 'chip' + (s.id === selectedSession ? ' active' : ''));
    chip.append(
      el('span', null, baseName(s.cwd) + ' · ' + shortId(s.id) + ' · '),
      el('span', null, s.state)
    );
    chip.addEventListener('click', () => { selectedSession = s.id; render(); });
    nav.append(chip);
  }
}

/* ---------- cards ---------- */

function renderMission(s) {
  const c = $('#mission');
  c.textContent = '';
  c.append(el('h2', null, 'mission'));
  const head = el('div', 'kv');
  head.append(el('span', 'k', 'state'));
  head.append(el('span', 'pill ' + (s.state === 'idle' ? 'idle' : 'working'), s.state));
  head.append(el('span', 'pill ' + (s.pmMode ? 'working' : 'off'), s.pmMode ? 'PM ENGAGED' : 'PM off'));
  c.append(head);
  c.append(kvRow('project', baseName(s.cwd)));
  c.append(kvRow('cwd', s.cwd || '—'));
  if (s.mission) {
    const m = el('details');
    m.append(el('summary', null, 'mission (PM)'));
    const pre = el('pre');
    pre.textContent = s.mission;
    m.append(pre);
    c.append(m);
  }
  if (s.progress) {
    const row = el('div', 'prog');
    row.append(el('span', 'pill ' + (s.progress.state === 'blocked' ? 'blocked' : s.progress.progress_pct === 100 || s.progress.state === 'done' ? 'idle' : 'working'), s.progress.state));
    const bar = el('span', 'bar');
    const fill = el('span', 'fill' + (s.progress.state === 'blocked' ? ' blocked' : ''));
    fill.style.width = (s.progress.pct == null ? (s.progress.state === 'done' ? 100 : 0) : Math.max(0, Math.min(100, s.progress.pct))) + '%';
    bar.append(fill);
    row.append(bar);
    c.append(row);
    if (s.progress.note) c.append(kvRow('note', s.progress.note));
  }
  c.append(kvRow('started', s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : '—'));
  c.append(kvRow('mode', s.permissionMode || '—'));
  const p = el('details');
  p.append(el('summary', null, 'last prompt'));
  const pre = el('pre');
  pre.textContent = s.lastPrompt || '—';
  p.append(pre);
  c.append(p);
  const r = el('details');
  r.append(el('summary', null, 'last turn result'));
  const pre2 = el('pre');
  pre2.textContent = s.lastResult || '—';
  r.append(pre2);
  c.append(r);
}

function agentCard(a, isChild) {
  const card = el('div', 'agent' + (isChild ? ' indent' : ''));
  card.style.borderLeftColor =
    a.status === 'done' ? 'var(--green)' : a.status === 'running' || a.status === 'starting' ? 'var(--amber)' : 'var(--line)';

  const head = el('div', 'head');
  head.append(el('span', 'status ' + (a.status || 'unknown')));
  const type = a.mainAgent ? 'MAIN AGENT' : (a.type || 'agent' + (a.boundId ? '' : ' (spawning)'));
  head.append(el('span', 'type', type));
  if (a.description) head.append(el('span', 'desc', '— ' + a.description));
  card.append(head);

  const meta = el('div', 'meta');
  const bits = [];
  if (!a.mainAgent) bits.push('id ' + (a.boundId ? shortId(a.boundId) : 'pending'));
  if (a.durationMs != null) bits.push(a.durationMs / 1000 + 's');
  if (a.toolEvents) bits.push(`${a.toolEvents} tool calls, last: ${a.lastTool}`);
  if (a.lastToolAt) bits.push('@ ' + new Date(a.lastToolAt).toLocaleTimeString());
  meta.textContent = bits.join(' · ');
  card.append(meta);

  if (a.prompt) {
    const d = el('details');
    d.append(el('summary', null, 'delegation prompt'));
    const pre = el('pre');
    pre.textContent = a.prompt;
    d.append(pre);
    card.append(d);
  }
  if (a.lastMessage) {
    const d = el('details');
    d.append(el('summary', null, 'final report'));
    const pre = el('pre');
    pre.textContent = a.lastMessage;
    d.append(pre);
    card.append(d);
  }
  const toolNames = Object.keys(a.tools || {});
  if (toolNames.length) {
    const d = el('details');
    d.append(el('summary', null, 'tools'));
    const pre = el('pre');
    pre.textContent = toolNames.sort().map((t) => `${t} ×${a.tools[t]}`).join('\n');
    d.append(pre);
    card.append(d);
  }
  return card;
}

function renderAgents(s) {
  const c = $('#agents');
  c.textContent = '';
  c.append(el('h2', null, 'agents (' + s.agents.length + ')'));
  const main = s.agents.find((a) => a.mainAgent);
  const children = s.agents.filter((a) => !a.mainAgent);
  if (main) c.append(agentCard(main, false));
  else c.append(el('div', 'meta', 'no events yet'));
  if (!children.length) c.append(el('div', 'meta', 'no subagents spawned yet'));
  for (const a of children) c.append(agentCard(a, true));
}

function todoRow(t) {
  const row = el('div', 'todo ' + (t.status || 'pending'));
  const mark = { completed: '✓', in_progress: '▶', pending: '○' }[t.status] || '○';
  row.append(el('span', 'mark', mark));
  row.append(el('span', null, t.content || t.activeForm || '(empty)'));
  return row;
}

function renderPlan(s) {
  const c = $('#plan');
  c.textContent = '';
  c.append(el('h2', null, 'plan board'));
  if (!s.todos.length) {
    c.append(el('div', 'meta', 'no TodoWrite yet — V0 reads it from tool events'));
  } else {
    for (const t of s.todos) c.append(todoRow(t));
  }
}

function renderDiscipline(s) {
  const c = $('#discipline');
  c.textContent = '';
  c.append(el('h2', null, 'discipline'));
  for (const [label, num] of [
    ['delegations', s.stats.spawns],
    ['tool calls (all agents)', s.stats.toolCalls],
    ['main-session Write/Edit', s.stats.mainWrites],
    ['writes blocked by PM', s.stats.denies || 0],
  ]) {
    const row = el('div', 'stat');
    row.append(el('span', null, label));
    row.append(el('span', 'num', String(num)));
    c.append(row);
  }
  const pm = el('div', 'stat');
  pm.append(el('span', null, 'PM mode'));
  pm.append(el('span', 'pill ' + (s.pmMode ? 'working' : 'off'), s.pmMode ? 'engaged — enforcing' : 'off'));
  c.append(pm);
}

/* ---------- timeline ---------- */

function whoLabel(p) {
  if (p.agent_id) return '⤷ ' + shortId(p.agent_id);
  return 'MAIN';
}

const BADGE_LABELS = {
  PreToolUse: 'PRE',
  PostToolUse: 'POST',
  UserPromptSubmit: 'PROMPT',
  SubagentStop: 'SUB-END',
  Stop: 'STOP',
  SessionStart: 'START',
  PMSync: 'PM-MODE',
  PMDeny: 'DENY',
};

function summarize(e) {
  const p = e.payload || {};
  switch (e.__hook) {
    case 'UserPromptSubmit':
      return 'prompt: ' + (p.prompt || '');
    case 'PreToolUse': {
      if (p.tool_name === 'Agent' || p.tool_name === 'Task') {
        return `spawn → ${p.tool_input && p.tool_input.description}`;
      }
      const hint = p.tool_input && (p.tool_input.file_path || p.tool_input.command || p.tool_input.pattern || '');
      return `${p.tool_name}${hint ? ' · ' + String(hint).slice(0, 90) : ''}`;
    }
    case 'PostToolUse': {
      if (p.tool_name === 'Agent' || p.tool_name === 'Task') {
        return `collected subagent (${fmtDur(p.duration_ms)})`;
      }
      if (p.tool_name === 'TodoWrite') return 'TodoWrite → plan board updated';
      return `${p.tool_name} ok${p.duration_ms != null ? ' · ' + fmtDur(p.duration_ms) : ''}`;
    }
    case 'SubagentStop':
      return 'subagent report: ' + String(p.last_assistant_message || '').slice(0, 110);
    case 'PMSync':
      return p.action === 'on'
        ? 'PM mode ENGAGED' + (p.mission ? ' · mission: ' + String(p.mission).slice(0, 80) : '')
        : 'PM mode off';
    case 'PMDeny':
      return 'main-session ' + (p.tool_name || '?') + ' blocked — delegation enforced';
    case 'MCPProgress':
      return `agent reports: ${p.state}${p.progress_pct != null ? ' ' + p.progress_pct + '%' : ''}${p.note ? ' · ' + String(p.note).slice(0, 80) : ''}`;
    case 'Stop':
      return 'turn ended';
    default:
      return e.__hook;
  }
}

function renderTimeline(s) {
  const c = $('#timeline');
  c.textContent = '';
  c.append(el('h2', null, 'event timeline'));
  const tl = el('div', 'tl');
  const evs = state.events
    .filter((e) => e.payload && e.payload.session_id === s.id)
    .slice(-120)
    .reverse();
  if (!evs.length) c.append(el('div', 'meta', 'no events for this session yet'));
  for (const e of evs) {
    const row = el('div', 'tl-row');
    row.append(el('span', 'tl-time', shortTime(e.__ts)));
    row.append(el('span', 'tl-who' + (e.payload.agent_id ? '' : ' main'), whoLabel(e.payload)));
    row.append(el('span', 'tl-badge ' + e.__hook, BADGE_LABELS[e.__hook] || e.__hook));
    row.append(el('span', 'tl-what', summarize(e)));
    c.append(row);
  }
}

function renderFooter() {
  $('#foot').textContent =
    `snapshot ${state.generatedAt} · ${state.sessions.length} session(s) · events cached: ${state.events.length}`;
}

function render() {
  if (!state) return;
  const s = pickDefaultSession();
  renderChips();
  if (!s) {
    $('#mission').textContent = '# waiting for the first hook event…';
    return;
  }
  renderMission(s);
  renderPlan(s);
  renderDiscipline(s);
  renderAgents(s);
  renderTimeline(s);
  renderFooter();
}

async function refresh() {
  try {
    const r = await fetch('/api/state');
    state = await r.json();
    setConn(true);
    render();
  } catch (_) {
    setConn(false);
  }
}

refresh();
setInterval(refresh, 15000);

const es = new EventSource('/api/events');
es.onopen = () => setConn(true);
es.onerror = () => setConn(false);
es.addEventListener('hook', () => refresh());