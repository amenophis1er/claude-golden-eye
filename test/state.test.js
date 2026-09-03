'use strict';

/**
 * Reducer tests for server/state.js — the FIFO agent binding + repair logic
 * is the trickiest code in the project, and it's pure enough to test cheaply.
 * Run: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the store at a throwaway data dir BEFORE the config module loads.
process.env.GOLDEN_EYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-eye-test-'));
const Store = require('../plugins/golden-eye/server/state');

const SID = 'sess-test';
let tick = 0;
function ts() {
  return new Date(1700000000000 + ++tick * 1000).toISOString();
}
function ev(hook, payload) {
  return { __hook: hook, __ts: ts(), payload: { session_id: SID, cwd: '/tmp/proj', ...payload } };
}
function freshStore() {
  const store = new Store();
  store.sessions.clear();
  store.events = [];
  return store;
}
function add(store, hook, payload) {
  return store.addEvent(ev(hook, payload), { persist: false });
}
function session(store) {
  return store.sessions.get(SID);
}

test('main vs subagent attribution via agent_id presence', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'Read', tool_input: {} });
  add(store, 'PreToolUse', { tool_name: 'Write', tool_input: {}, agent_id: 'ag1', agent_type: 'general-purpose' });

  const s = session(store);
  assert.equal(s.agents.__main__.tools.Read, 1);
  assert.equal(s.agents.__main__.tools.Write, undefined);
  assert.equal(s.agents['agent:ag1'].tools.Write, 1);
  // main-session write counter only counts untagged (main) events
  assert.equal(s.stats.mainWrites, 0);

  add(store, 'PreToolUse', { tool_name: 'Write', tool_input: {} });
  assert.equal(session(store).stats.mainWrites, 1);
});

test('sequential spawn: FIFO bind keeps the delegation prompt through SubagentStop', () => {
  const store = freshStore();
  add(store, 'PreToolUse', {
    tool_name: 'Agent',
    tool_use_id: 'toolu_1',
    tool_input: { description: 'write file', prompt: 'create foo.txt' },
  });
  assert.equal(session(store).stats.spawns, 1);
  assert.equal(session(store).agents['spawn:toolu_1'].status, 'starting');

  // child's first tagged tool event arrives before its stop
  add(store, 'PreToolUse', { tool_name: 'Write', tool_input: {}, agent_id: 'child1' });
  add(store, 'SubagentStop', {
    agent_id: 'child1',
    agent_type: 'general-purpose',
    last_assistant_message: 'done, wrote foo.txt',
  });

  const a = session(store).agents['agent:child1'];
  assert.ok(a, 'spawn slot was rebound to agent:child1');
  assert.equal(a.prompt, 'create foo.txt');
  assert.equal(a.status, 'done');
  assert.equal(a.lastMessage, 'done, wrote foo.txt');
  assert.equal(session(store).agents['spawn:toolu_1'], undefined);
});

test('PostToolUse(Agent) tool_response.agentId binds an untouched spawn slot deterministically', () => {
  const store = freshStore();
  add(store, 'PreToolUse', {
    tool_name: 'Agent',
    tool_use_id: 'toolu_2',
    tool_input: { description: 'd', prompt: 'p2' },
  });
  add(store, 'PostToolUse', {
    tool_name: 'Agent',
    tool_use_id: 'toolu_2',
    duration_ms: 1234,
    tool_response: { agentId: 'child2', agentType: 'general-purpose' },
  });

  const a = session(store).agents['agent:child2'];
  assert.ok(a);
  assert.equal(a.prompt, 'p2');
  assert.equal(a.durationMs, 1234);
  assert.equal(a.type, 'general-purpose');
});

test('parallel spawns: repair merges slot metadata into the FIFO-bound entry', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't_a', tool_input: { prompt: 'pA' } });
  add(store, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't_b', tool_input: { prompt: 'pB' } });

  // child B reports first: FIFO wrongly hands it slot A's identity...
  add(store, 'PreToolUse', { tool_name: 'Bash', tool_input: {}, agent_id: 'B' });
  // ...then B's collection event carries the deterministic mapping for t_b
  add(store, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 't_b', tool_response: { agentId: 'B' } });

  const s = session(store);
  assert.equal(s.agents['agent:B'].prompt, 'pB', 'cross-bind repaired: B gets its own prompt');
  assert.equal(s.agents['spawn:t_b'], undefined, 'slot B consumed by the repair');
  // slot A was restored and is available for child A's own collection event
  add(store, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 't_a', tool_response: { agentId: 'A' } });
  assert.equal(s.agents['agent:A'].prompt, 'pA');
  assert.equal(s.agents['spawn:t_a'], undefined);
});

test('PMSync toggles pmMode + mission; PMDeny counts', () => {
  const store = freshStore();
  add(store, 'PMSync', { action: 'on', mission: 'ship it' });
  assert.equal(session(store).pmMode, true);
  assert.equal(session(store).mission, 'ship it');

  add(store, 'PMDeny', { tool_name: 'Write' });
  add(store, 'PMDeny', { tool_name: 'Edit' });
  assert.equal(session(store).stats.denies, 2);

  add(store, 'PMSync', { action: 'off' });
  assert.equal(session(store).pmMode, false);
  assert.equal(session(store).mission, 'ship it', 'mission survives disengage');
});

test('TaskCreate/TaskUpdate mirror into tasks; serialize prefers tasks over todos', () => {
  const store = freshStore();
  add(store, 'PostToolUse', {
    tool_name: 'TaskCreate',
    tool_input: { subject: 'do the thing' },
    tool_response: { taskId: 7 },
  });
  add(store, 'PostToolUse', {
    tool_name: 'TaskUpdate',
    tool_input: { taskId: 7, status: 'in_progress' },
  });

  const out = store.serialize().sessions.find((x) => x.id === SID);
  assert.deepEqual(out.todos, [{ id: '7', content: 'do the thing', status: 'in_progress' }]);
});

test('Stop marks the session idle and the serialized main agent done', () => {
  const store = freshStore();
  add(store, 'UserPromptSubmit', { prompt: 'hello' });
  add(store, 'PreToolUse', { tool_name: 'Read', tool_input: {} });
  add(store, 'Stop', { last_assistant_message: 'all finished' });

  const out = store.serialize().sessions.find((x) => x.id === SID);
  assert.equal(out.state, 'idle');
  assert.equal(out.lastResult, 'all finished');
  assert.equal(out.agents.find((a) => a.mainAgent).status, 'done');
});

test('rotateLines preserves PMSync/SessionStart for sessions kept in the tail', () => {
  const line = (hook, sid, extra = {}) =>
    JSON.stringify({ __hook: hook, __ts: ts(), payload: { session_id: sid, ...extra } });

  // head: state-bearing events for a kept and an evicted session, plus noise
  const head = [
    line('PMSync', 'kept', { action: 'on', mission: 'm' }),
    line('SessionStart', 'kept', { source: 'startup' }),
    line('PMSync', 'evicted', { action: 'on', mission: 'x' }),
    ...Array.from({ length: 1500 }, () => line('PreToolUse', 'kept', { tool_name: 'Read' })),
  ];
  const tail = Array.from({ length: 1000 }, () => line('PreToolUse', 'kept', { tool_name: 'Bash' }));
  const rotated = Store.rotateLines(head.concat(tail));

  const hooksForSession = (sid) =>
    rotated.map((l) => JSON.parse(l)).filter((e) => e.payload.session_id === sid).map((e) => e.__hook);
  assert.ok(hooksForSession('kept').includes('PMSync'));
  assert.ok(hooksForSession('kept').includes('SessionStart'));
  assert.equal(hooksForSession('evicted').length, 0, 'evicted session events stay dropped');
  assert.equal(rotated.length, 1000 + 2);
});

test('resumed session: TaskUpdate upserts unknown tasks; TaskList hydrates subjects', () => {
  const store = freshStore();
  add(store, 'PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: 3, status: 'in_progress' } });
  let out = store.serialize().sessions.find((x) => x.id === SID);
  assert.deepEqual(out.todos, [{ id: '3', content: 'task 3', status: 'in_progress' }]);

  add(store, 'PostToolUse', {
    tool_name: 'TaskList',
    tool_input: {},
    tool_response: { tasks: [{ taskId: 3, subject: 'wire telegram alerts', status: 'in_progress' }, { taskId: 4, subject: 'deploy grafana', status: 'pending' }] },
  });
  out = store.serialize().sessions.find((x) => x.id === SID);
  assert.deepEqual(out.todos, [
    { id: '3', content: 'wire telegram alerts', status: 'in_progress' },
    { id: '4', content: 'deploy grafana', status: 'pending' },
  ]);
});

test('late Stop cannot pin an active session on idle: tool events mark working', () => {
  const store = freshStore();
  add(store, 'UserPromptSubmit', { prompt: 'go' });
  // next turn's prompt arrives, then the PREVIOUS turn's Stop lands late
  add(store, 'UserPromptSubmit', { prompt: '<task-notification>...' });
  add(store, 'Stop', { last_assistant_message: 'turn ended' });
  assert.equal(session(store).state, 'idle', 'stop still wins with no later activity');

  add(store, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'kubectl get pods' } });
  assert.equal(session(store).state, 'working', 'tool activity flips it back');
});

test('Stop older than the latest prompt does not flip the session to idle', () => {
  const store = freshStore();
  const early = new Date(1700000000000).toISOString();
  const late = new Date(1700000000500).toISOString();
  store.addEvent({ __hook: 'UserPromptSubmit', __ts: late, payload: { session_id: SID, cwd: '/tmp/x', prompt: 'next turn' } }, { persist: false });
  store.addEvent({ __hook: 'Stop', __ts: early, payload: { session_id: SID, cwd: '/tmp/x', last_assistant_message: 'prev turn ended' } }, { persist: false });
  assert.equal(session(store).state, 'working');
  assert.equal(session(store).lastResult, 'prev turn ended', 'result still recorded');
});

test('SessionStart(resume) clears the ended state', () => {
  const store = freshStore();
  add(store, 'UserPromptSubmit', { prompt: 'work' });
  add(store, 'SessionEnd', { reason: 'prompt_input_exit' });
  assert.equal(session(store).state, 'ended');
  add(store, 'SessionStart', { source: 'resume' });
  assert.equal(session(store).state, 'idle');
  add(store, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(session(store).state, 'working');
});

test('spawn records the requested model, PostToolUse input (post-pin) wins', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't_m', tool_input: { description: 'd', prompt: 'p' } });
  add(store, 'PostToolUse', {
    tool_name: 'Agent', tool_use_id: 't_m',
    tool_input: { description: 'd', prompt: 'p', model: 'opus' },
    tool_response: { agentId: 'M1', agentType: 'general-purpose' },
  });
  assert.equal(session(store).agents['agent:M1'].model, 'opus');
});

test('first tagged tool event flips a FIFO-bound agent from starting to running', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't_r', tool_input: { description: 'd', prompt: 'p' } });
  add(store, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, agent_id: 'R1' });
  assert.equal(session(store).agents['agent:R1'].status, 'running');
});

test('serialized main agent reads done for ended sessions too', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  add(store, 'SessionEnd', { reason: 'other' });
  const out = store.serialize().sessions.find((x) => x.id === SID);
  assert.equal(out.agents.find((a) => a.mainAgent).status, 'done');
});

test('a done agent that emits tool events again was resumed — back to running', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't_bg', tool_input: { description: 'bg work', prompt: 'p' } });
  add(store, 'PreToolUse', { tool_name: 'Bash', tool_input: {}, agent_id: 'BG1' });
  add(store, 'SubagentStop', { agent_id: 'BG1', last_assistant_message: 'first stop' });
  assert.equal(session(store).agents['agent:BG1'].status, 'done');
  // SendMessage resume: same agent id starts working again
  add(store, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/x' }, agent_id: 'BG1' });
  assert.equal(session(store).agents['agent:BG1'].status, 'running');
  assert.equal(session(store).agents['agent:BG1'].endedAt, null);
  add(store, 'SubagentStop', { agent_id: 'BG1', last_assistant_message: 'second stop' });
  assert.equal(session(store).agents['agent:BG1'].status, 'done');
});

test('SessionEnd closes out agents still marked running (teardown emits no stop)', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't_z', tool_input: { description: 'bg', prompt: 'p' } });
  add(store, 'PreToolUse', { tool_name: 'Bash', tool_input: {}, agent_id: 'Z1' });
  assert.equal(session(store).agents['agent:Z1'].status, 'running');
  add(store, 'SessionEnd', { reason: 'other' });
  assert.equal(session(store).agents['agent:Z1'].status, 'done');
  assert.ok(session(store).agents['agent:Z1'].endedAt);
});

test('phantom SubagentStop (transcript never written) is dropped, not bound', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 't_real', tool_input: { description: 'real work', prompt: 'do it' } });
  // CC internal helper: empty agent_type, transcript path that never exists
  add(store, 'SubagentStop', {
    agent_id: 'phantom1',
    agent_type: '',
    agent_transcript_path: '/nonexistent/subagents/agent-phantom1.jsonl',
    last_assistant_message: 'run the drill',
  });
  const s = session(store);
  assert.equal(s.agents['agent:phantom1'], undefined, 'no roster record for the phantom');
  assert.equal(s.agents['spawn:t_real'].status, 'starting', 'pending spawn slot not stolen');
  // the real child still binds to its slot afterwards
  add(store, 'PreToolUse', { tool_name: 'Bash', tool_input: {}, agent_id: 'real1' });
  assert.equal(s.agents['agent:real1'].prompt, 'do it');
});

test('tool-less real agent still binds at stop when its transcript exists', () => {
  const store = freshStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-test-'));
  const tp = path.join(dir, 'agent-quiet1.jsonl');
  fs.writeFileSync(tp, '');
  add(store, 'SubagentStop', { agent_id: 'quiet1', agent_type: 'Explore', agent_transcript_path: tp, last_assistant_message: 'ok' });
  assert.equal(session(store).agents['agent:quiet1'].status, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SessionPrune tombstone: straggler events do not resurrect; SessionStart does', () => {
  const store = freshStore();
  add(store, 'UserPromptSubmit', { prompt: 'hi' });
  assert.ok(session(store));

  add(store, 'SessionPrune', {});
  assert.equal(session(store), undefined);

  // A racing Stop (or replayed line) must not bring the session back.
  add(store, 'Stop', { last_assistant_message: 'late' });
  assert.equal(session(store), undefined);

  // A genuine restart announces itself and lifts the tombstone.
  add(store, 'SessionStart', { source: 'resume' });
  assert.ok(session(store));
});

test('tool_name "__proto__" cannot corrupt per-agent tool counts', () => {
  const store = freshStore();
  add(store, 'PreToolUse', { tool_name: '__proto__', tool_input: {} });
  const counts = session(store).agents.__main__.tools;
  assert.equal(counts['__proto__'], 1);
  assert.equal(JSON.parse(JSON.stringify(counts))['__proto__'], 1);
});

test('AskUserQuestion lifecycle: open on Pre, cleared by Post / prompt / Stop', () => {
  const q = { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
  let store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: q });
  assert.equal(session(store).openQuestion.questions[0].question, 'Which?');
  add(store, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: q, tool_response: {} });
  assert.equal(session(store).openQuestion, null);

  store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: q });
  add(store, 'UserPromptSubmit', { prompt: 'dismissed it, moving on' });
  assert.equal(session(store).openQuestion, null);

  store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: q });
  add(store, 'Stop', {});
  assert.equal(session(store).openQuestion, null);

  // A subagent asking (hypothetically) must not hijack the main card.
  store = freshStore();
  add(store, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: q, agent_id: 'ag1' });
  assert.equal(session(store).openQuestion, null);
});

test('Notification while subagents run is stamped __active_agents at ingest', () => {
  const store = freshStore();
  add(store, 'PreToolUse', {
    tool_name: 'Agent',
    tool_use_id: 'toolu_bg',
    tool_input: { description: 'bg work', prompt: 'do it' },
  });

  // Main loop parks while the delegation runs — idle signal is not a real ask.
  const during = add(store, 'Notification', { message: 'Claude is waiting for your input' });
  assert.equal(during.payload.__active_agents, 1);

  add(store, 'SubagentStop', {
    agent_id: 'bg1',
    last_assistant_message: 'done',
    __transcript_exists: true,
  });
  const after = add(store, 'Notification', { message: 'Claude is waiting for your input' });
  assert.equal(after.payload.__active_agents, 0);

  // Replay determinism: a pre-stamped value is never recomputed.
  const replayed = add(store, 'Notification', { message: 'Claude is waiting for your input', __active_agents: 3 });
  assert.equal(replayed.payload.__active_agents, 3);
});

test('Artifact publishes are recorded per session and deduped by artifact id', () => {
  const store = freshStore();
  const publish = (id, title, updated) =>
    add(store, 'PostToolUse', {
      tool_name: 'Artifact',
      tool_input: { file_path: '/tmp/page.html', favicon: '📊', description: 'a page' },
      tool_response: {
        url: 'https://claude.ai/code/artifact/' + id,
        artifact_id: id,
        title,
        updated,
        version: '1788445160-061a',
        capabilities: { db: {} },
      },
    });
  publish('art-1', 'My Page', false);
  publish('art-1', 'My Page', true); // redeploy: same row, counted
  publish('art-2', 'Other', false);

  assert.equal(Object.keys(session(store).artifacts).length, 2);
  const a1 = session(store).artifacts['art-1'];
  assert.equal(a1.publishes, 2);
  assert.equal(a1.title, 'My Page');
  assert.equal(a1.favicon, '📊');
  assert.deepEqual(a1.capabilities, ['db']);
  assert.ok(a1.firstAt < a1.lastAt);
  // Serialized newest-first for the UI.
  assert.equal(store.serialize().sessions[0].artifacts[0].id, 'art-2');
});

test('non-publish Artifact actions (db writes, listings) are not artifacts', () => {
  const store = freshStore();
  add(store, 'PostToolUse', {
    tool_name: 'Artifact',
    tool_input: { action: 'write_db', db_op: 'set', collection: 'ticks', doc_id: 'vs-1', url: 'https://claude.ai/code/artifact/art-1' },
    tool_response: { db_write: { op: 'set', collection: 'ticks', doc_id: 'vs-1', committed: true } },
  });
  assert.deepEqual(Object.keys(session(store).artifacts), []);
});

test('background shells are tracked from launch until their completion notice', () => {
  const store = freshStore();
  const launch = (id, cmd) =>
    add(store, 'PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: cmd, run_in_background: true, description: 'watch CI' },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: id },
    });
  launch('bmv0lo3tb', 'sleep 60; check ci');
  launch('b5m71wipc', 'tail -f log');
  assert.equal(Object.keys(session(store).shells).length, 2);
  assert.equal(session(store).shells['bmv0lo3tb'].command, 'sleep 60; check ci');

  // The harness announces completion as a task-notification prompt.
  add(store, 'UserPromptSubmit', {
    prompt: '<task-notification>\n<task-id>bmv0lo3tb</task-id>\n<status>completed</status>\n<summary>Background command "watch CI" completed</summary>\n</task-notification>',
  });
  assert.deepEqual(Object.keys(session(store).shells), ['b5m71wipc']);

  // An agent notification uses the same envelope but never matches a shell.
  add(store, 'UserPromptSubmit', {
    prompt: '<task-notification>\n<task-id>a0f9385635ac21598</task-id>\n<summary>Agent "x" finished</summary>\n</task-notification>',
  });
  assert.deepEqual(Object.keys(session(store).shells), ['b5m71wipc']);
  assert.equal(store.serialize().sessions[0].shells.length, 1);
});

test('a foreground Bash is not tracked as a background shell', () => {
  const store = freshStore();
  add(store, 'PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'a\nb', stderr: '' },
  });
  assert.deepEqual(Object.keys(session(store).shells), []);
});

test('BashOutput reads attach to the shell they polled', () => {
  const store = freshStore();
  add(store, 'PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'tail -f log', run_in_background: true },
    tool_response: { backgroundTaskId: 'bxyz12345' },
  });
  add(store, 'PostToolUse', {
    tool_name: 'BashOutput',
    tool_input: { bash_id: 'bxyz12345' },
    tool_response: { stdout: 'line one\nline two', stderr: '' },
  });
  const sh = session(store).shells['bxyz12345'];
  assert.equal(sh.lastOutput, 'line one\nline two');
  assert.ok(sh.lastReadAt);
});
