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
const Store = require('../server/state');

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
