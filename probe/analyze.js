'use strict';

/**
 * Summarize .probe/hook-events.jsonl for the M0 probe questions:
 *  Q1  Which hook events fired, and how often?
 *  Q2  Do payloads distinguish main session vs subagent?
 *      (session_id / transcript_path / agent-ish fields)
 *  Q3  What does the Task-tool payload actually contain about the subagent?
 * Everything printed compactly; full raw lines stay in the JSONL.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG = process.argv[2] || path.join(ROOT, '.probe', 'hook-events.jsonl');

if (!fs.existsSync(LOG)) {
  console.error(`No probe log at ${LOG}`);
  process.exit(1);
}

const events = fs
  .readFileSync(LOG, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter(Boolean);

const P = (e) => e.payload || {};
const short = (s, n = 60) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const sessSlug = (id) => (id ? String(id).slice(0, 8) : '∅');

console.log(`# events: ${events.length}  (log: ${LOG})\n`);

// 1. Counts per hook + per declared hook_event_name
const byHook = {};
for (const e of events) {
  const declared = P(e).hook_event_name || '(none)';
  const h = e.__hook;
  byHook[h] = byHook[h] || { count: 0, declared: {} };
  byHook[h].count++;
  const d = P(e).hook_event_name || '(none)';
  byHook[h].declared[d] = (byHook[h].declared[d] || 0) + 1;
}
console.log('== 1. Event counts (__hook -> declared hook_event_name) ==');
for (const [h, v] of Object.entries(byHook)) {
  console.log(`  ${h.padEnd(18)} ${v.count}   declared: ${JSON.stringify(v.declared)}`);
}

// 2. Distinct sessions
const sessions = {};
for (const e of events) {
  const sid = P(e).session_id || '(no session_id)';
  (sessions[sid] = sessions[sid] || { hooks: new Set(), transcript: new Set(), tools: new Set() });
  sessions[sid].hooks.add(e.__hook);
  if (P(e).transcript_path) sessions[sid].transcript.add(path.basename(P(e).transcript_path));
  if (P(e).tool_name) sessions[sid].tools.add(P(e).tool_name);
}
console.log('\n== 2. Distinct session_ids across all events ==');
for (const [sid, v] of Object.entries(sessions)) {
  console.log(`  session ${sessSlug(sid)}  hooks:[${[...v.hooks].join(',')}]  transcripts:[${[...v.transcript].join(',')}]`);
}

// 3. Payload keys of interest — any agent-ish discriminator
const interesting = new Set();
for (const e of events) {
  for (const k of Object.keys(P(e))) {
    if (/agent|parent|sub|task|team|hook/i.test(k)) interesting.add(k);
  }
}
console.log('\n== 3. Agent-ish payload keys found (any event) ==');
console.log(`  ${[...interesting].sort().join(', ') || '(none)'}`);

// 4. Every PreToolUse/PostToolUse: ts, session, tool, discriminating fields
console.log('\n== 4. Tool-event timeline (main vs subagent discrimination) ==');
for (const e of events) {
  if (e.__hook !== 'PreToolUse' && e.__hook !== 'PostToolUse') continue;
  const p = P(e);
  const extra = Object.entries(p)
    .filter(([k]) => !['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'tool_name', 'tool_input', 'tool_response', 'permission_mode'].includes(k))
    .map(([k, v]) => `${k}=${short(JSON.stringify(v), 40)}`);
  let inp = '';
  if (p.tool_input) {
    inp = short(JSON.stringify(p.tool_input), 90);
  }
  console.log(
    `  ${short(e.__ts, 23)}  ${e.__hook.padEnd(11)} s=${sessSlug(p.session_id)}  ${String(p.tool_name || '?').padEnd(14)} in:${inp}` +
      (extra.length ? `  |  ${extra.join(' ')}` : '')
  );
}

// 5. Full samples: PostToolUse(Task), SubagentStop, Stop, SessionStart
function dumpSample(hookName, toolName, label, max = 2200) {
  // toolName "Task" matches both "Task" (older) and "Agent" (2.1.x) spawn tools.
  const e = events.find(
    (e) => e.__hook === hookName && (!toolName || ['Task', 'Agent'].includes(P(e).tool_name))
  );
  if (!e) { console.log(`\n== 5s. Sample ${label}: (none) ==`); return; }
  const s = JSON.stringify(e, null, 2);
  console.log(`\n== 5s. Sample ${label} (${s.length} chars${s.length > max ? ', truncated' : ''}) ==`);
  console.log(s.length > max ? s.slice(0, max) + '\n  …' : s);
}
dumpSample('PreToolUse', 'Task', 'PreToolUse(Task)');
dumpSample('PostToolUse', 'Task', 'PostToolUse(Task)');
dumpSample('SubagentStop', null, 'SubagentStop');
dumpSample('Stop', null, 'Stop');
dumpSample('SessionStart', null, 'SessionStart', 1200);
dumpSample('UserPromptSubmit', null, 'UserPromptSubmit', 1200);