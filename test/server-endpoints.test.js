'use strict';

/**
 * Endpoint integration: boots the real server (subprocess, isolated data dir)
 * and pins the security-relevant contracts — agent-transcript path validation
 * (the client never supplies a filesystem path) and static-path traversal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'plugins', 'golden-eye', 'server', 'index.js');
const SID = 'endpoint-test-session';

let child = null;
let base = null;
let tmp = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-endpoints-'));

  // Fixture session layout: main transcript + one subagent transcript.
  const main = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(
    main,
    JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'text', text: 'main says hi' }] },
    }) + '\n'
  );
  const subDir = path.join(tmp, 'session', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, 'agent-good1.jsonl'),
    JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'child says hi' }] },
    }) + '\n'
  );

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      GOLDEN_EYE_DATA_DIR: path.join(tmp, 'data'),
      GOLDEN_EYE_PORT: String(port),
      GOLDEN_EYE_NOTIFY: '0',
      GOLDEN_EYE_COMPOSER: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  for (let i = 0; i < 50; i++) {
    try {
      const h = await (await fetch(`${base}/healthz`)).json();
      if (h.ok && h.name === 'golden-eye') break;
    } catch (_) {}
    if (i === 49) throw new Error('server never became healthy:\n' + stderr);
    await new Promise((r) => setTimeout(r, 100));
  }

  // Register the fixture session via the real ingest path.
  const res = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      __hook: 'SessionStart',
      __ts: new Date().toISOString(),
      payload: { session_id: SID, cwd: tmp, transcript_path: main, hook_event_name: 'SessionStart' },
    }),
  });
  assert.equal(res.status, 200);
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('healthz self-identifies', async () => {
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h.name, 'golden-eye');
});

test('api/state includes the ingested session with transcript-derived env', async () => {
  const s = await (await fetch(`${base}/api/state`)).json();
  const sess = s.sessions.find((x) => x.id === SID);
  assert.ok(sess, 'session present');
  assert.equal(sess.env && sess.env.model, 'claude-fable-5');
});

test('agent-transcript: main session tail served, path derived server-side', async () => {
  const r = await fetch(`${base}/api/agent-transcript?sessionId=${SID}`);
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.entries[0].text, 'main says hi');
});

test('agent-transcript: subagent id resolves under the session dir', async () => {
  const r = await fetch(`${base}/api/agent-transcript?sessionId=${SID}&agentId=good1`);
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.model, 'claude-opus-5');
});

test('agent-transcript: traversal-shaped agentIds are rejected with 400', async () => {
  // (an EMPTY agentId is not evil — it is the documented main-session form)
  for (const evil of ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', 'a/b', 'a b']) {
    const r = await fetch(`${base}/api/agent-transcript?sessionId=${SID}&agentId=${encodeURIComponent(evil)}`);
    assert.equal(r.status, 400, `agentId ${JSON.stringify(evil)} must be rejected`);
  }
});

test('agent-transcript: unknown session is a 404, never a probe primitive', async () => {
  const r = await fetch(`${base}/api/agent-transcript?sessionId=no-such-session`);
  assert.equal(r.status, 404);
});

test('static: traversal paths fall through to the SPA, never leak files', async () => {
  for (const p of ['/../package.json', '/..%2f..%2fpackage.json', '/assets/../../server/config.js']) {
    const r = await fetch(`${base}${p}`);
    const body = await r.text();
    assert.ok(!body.includes('PORT_CANDIDATES'), `${p} leaked server source`);
    assert.ok(!body.includes('"private"'), `${p} leaked package.json`);
  }
});

test('composer: send without a connected bridge is a 409 with guidance', async () => {
  const r = await fetch(`${base}/api/channel/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SID, text: 'hello' }),
  });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /dangerously-load-development-channels/);
});

test('composer: bridge subscription routes a send to exactly that session', async () => {
  const http = require('http');
  const PID = '54321';

  // Bind the fixture session to a claude pid via the real ingest path.
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      __hook: 'UserPromptSubmit',
      __ts: new Date().toISOString(),
      __pid: Number(PID),
      payload: { session_id: SID, prompt: 'work' },
    }),
  });

  // Subscribe like the MCP channel process does.
  const lines = [];
  let onLine = null;
  const req = http.get(`${base}/api/channel/subscribe?pid=${PID}`, (res) => {
    assert.equal(res.statusCode, 200);
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { lines.push(JSON.parse(line)); onLine && onLine(); }
      }
    });
  });
  const waitFor = (pred) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out; got ' + JSON.stringify(lines))), 3000);
      onLine = () => { if (lines.some(pred)) { clearTimeout(t); resolve(); } };
      onLine();
    });
  await waitFor((l) => l.type === 'hello');

  // channelConnected now reflects the live bridge.
  const st = await (await fetch(`${base}/api/state`)).json();
  assert.equal(st.sessions.find((x) => x.id === SID).channelConnected, true);

  const r = await fetch(`${base}/api/channel/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SID, text: 'steer left' }),
  });
  assert.equal(r.status, 200);
  await waitFor((l) => l.type === 'message' && l.text === 'steer left');

  // The injection is attributed in the event feed.
  const st2 = await (await fetch(`${base}/api/state`)).json();
  assert.ok(st2.events.some((e) => e.__hook === 'DashboardPrompt' && e.payload.prompt === 'steer left'));
  req.destroy();
});

test('composer: proxied requests need the token; the right token passes', async () => {
  const denied = await fetch(`${base}/api/channel/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.7' },
    body: JSON.stringify({ sessionId: SID, text: 'hi' }),
  });
  assert.equal(denied.status, 403);

  const token = fs.readFileSync(path.join(tmp, 'data', 'composer.token'), 'utf8').trim();
  const ok = await fetch(`${base}/api/channel/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.7', 'x-golden-eye-token': token },
    body: JSON.stringify({ sessionId: SID, text: 'hi' }),
  });
  assert.notEqual(ok.status, 403); // authenticates; may 409 if the bridge test ran first and closed
});

test('composer: fully disabled without the opt-in env (404 on both endpoints)', async () => {
  const port = await freePort();
  const off = spawn(process.execPath, [SERVER], {
    env: { ...process.env, GOLDEN_EYE_DATA_DIR: path.join(tmp, 'data-off'), GOLDEN_EYE_PORT: String(port), GOLDEN_EYE_NOTIFY: '0' },
    stdio: 'ignore',
  });
  try {
    const b = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await (await fetch(`${b}/healthz`)).json()).ok) break; } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await fetch(`${b}/api/channel/subscribe?pid=1`)).status, 404);
    const r = await fetch(`${b}/api/channel/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x', text: 'x' }),
    });
    assert.equal(r.status, 404);
  } finally {
    off.kill('SIGTERM');
  }
});

test('composer: {"composer": true} in <data dir>/config.json enables it without env', async () => {
  const dataDir = path.join(tmp, 'data-cfg');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{"composer": true}\n');
  const port = await freePort();
  const cfg = spawn(process.execPath, [SERVER], {
    env: { ...process.env, GOLDEN_EYE_DATA_DIR: dataDir, GOLDEN_EYE_PORT: String(port), GOLDEN_EYE_NOTIFY: '0', GOLDEN_EYE_COMPOSER: '' },
    stdio: 'ignore',
  });
  try {
    const b = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await (await fetch(`${b}/healthz`)).json()).ok) break; } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    // Enabled: a bad pid is a 400 (validated), not the disabled 404.
    assert.equal((await fetch(`${b}/api/channel/subscribe?pid=abc`)).status, 400);
  } finally {
    cfg.kill('SIGTERM');
  }
});

test('permission relay: request -> pending in state -> verdict routed + cleared', async () => {
  const http = require('http');
  const PID = '77777';
  const PSID = 'perm-test-session';

  // Session bound to the pid, with a live bridge subscription.
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ __hook: 'SessionStart', __ts: new Date().toISOString(), __pid: Number(PID), payload: { session_id: PSID, cwd: '/tmp/perm' } }),
  });
  const lines = [];
  let onLine = null;
  const sub = http.get(`${base}/api/channel/subscribe?pid=${PID}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { lines.push(JSON.parse(line)); onLine && onLine(); }
      }
    });
  });
  const waitFor = (pred) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out; got ' + JSON.stringify(lines))), 3000);
      onLine = () => { if (lines.some(pred)) { clearTimeout(t); resolve(); } };
      onLine();
    });
  await waitFor((l) => l.type === 'hello');

  // The mcp process relays an open prompt.
  const pr = await fetch(`${base}/api/channel/permission-request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid: Number(PID), request: { request_id: 'abcde', tool_name: 'Bash', description: 'Run tests', input_preview: '{"command":"npm test"}' } }),
  });
  assert.equal(pr.status, 200);
  assert.equal((await pr.json()).sessionId, PSID);

  // Pending request visible on the session.
  const st = await (await fetch(`${base}/api/state`)).json();
  const sess = st.sessions.find((x) => x.id === PSID);
  assert.equal(sess.permissionRequests.length, 1);
  assert.equal(sess.permissionRequests[0].request_id, 'abcde');

  // Dashboard answers: verdict reaches the bridge, pending clears, feed logs it.
  const v = await fetch(`${base}/api/channel/verdict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: PSID, requestId: 'abcde', behavior: 'allow' }),
  });
  assert.equal(v.status, 200);
  await waitFor((l) => l.type === 'permission' && l.request_id === 'abcde' && l.behavior === 'allow');
  const st2 = await (await fetch(`${base}/api/state`)).json();
  assert.equal(st2.sessions.find((x) => x.id === PSID).permissionRequests.length, 0);
  assert.ok(st2.events.some((e) => e.__hook === 'PermissionVerdict' && e.payload.behavior === 'allow'));
  sub.destroy();
});

test('permission relay: verdict is gated like the composer (proxied needs token; bad behavior 400)', async () => {
  const denied = await fetch(`${base}/api/channel/verdict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.9' },
    body: JSON.stringify({ sessionId: SID, requestId: 'abcde', behavior: 'allow' }),
  });
  assert.equal(denied.status, 403);
  const bad = await fetch(`${base}/api/channel/verdict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SID, requestId: 'abcde', behavior: 'maybe' }),
  });
  assert.equal(bad.status, 400);
});

test('host allowlist: foreign Host is 403, but an allowlisted host passes (+ composer without token)', async () => {
  const http = require('http');
  // undici (Node fetch) forbids overriding the Host header, so drive these
  // with raw http.request — the same thing a reverse proxy / curl does.
  const raw = (port, { method = 'GET', pathname = '/healthz', headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  const dataDir = path.join(tmp, 'data-hosts');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{"composer": true, "allowedHosts": ["dash.example.ts.net"]}\n');
  const port = await freePort();
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, GOLDEN_EYE_DATA_DIR: dataDir, GOLDEN_EYE_PORT: String(port), GOLDEN_EYE_NOTIFY: '0' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await raw(port)) === 200) break; } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    // Foreign Host (DNS-rebinding shape) is rejected.
    assert.equal(await raw(port, { headers: { host: 'evil.example.com' } }), 403);
    // The allowlisted host passes the guard.
    assert.equal(await raw(port, { headers: { host: 'dash.example.ts.net' } }), 200);
    // A proxied request via the allowlisted host authorizes the composer with no token.
    assert.equal(
      await raw(port, {
        method: 'POST', pathname: '/api/channel/send',
        headers: { 'content-type': 'application/json', host: 'dash.example.ts.net', 'x-forwarded-host': 'dash.example.ts.net', 'x-forwarded-for': '100.64.0.2' },
        body: JSON.stringify({ sessionId: 'nope', text: 'hi' }),
      }),
      404 // past auth → unknown session, NOT 403
    );
    // A different proxied host still needs the token.
    assert.equal(
      await raw(port, {
        method: 'POST', pathname: '/api/channel/send',
        headers: { 'content-type': 'application/json', host: 'dash.example.ts.net', 'x-forwarded-host': 'other.example.com', 'x-forwarded-for': '100.64.0.2' },
        body: JSON.stringify({ sessionId: 'nope', text: 'hi' }),
      }),
      403
    );
  } finally {
    srv.kill('SIGTERM');
  }
});

test('director: attach routes worker events over the bridge; own session + non-wake events excluded', async () => {
  const http = require('http');
  const DPID = '88888'; // director claude pid
  const WSID = 'director-worker-session';
  const DSID = 'director-own-session';

  // Director's own session + a worker session, bound to pids.
  for (const [sid, pid] of [[DSID, DPID], [WSID, '88899']]) {
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ __hook: 'SessionStart', __ts: new Date().toISOString(), __pid: Number(pid), payload: { session_id: sid, cwd: '/tmp/' + sid } }),
    });
  }

  // Director's channel bridge.
  const lines = [];
  let onLine = null;
  const sub = http.get(`${base}/api/channel/subscribe?pid=${DPID}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { lines.push(JSON.parse(line)); onLine && onLine(); }
      }
    });
  });
  const waitFor = (pred) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out; got ' + JSON.stringify(lines))), 3000);
      onLine = () => { if (lines.some(pred)) { clearTimeout(t); resolve(); } };
      onLine();
    });
  await waitFor((l) => l.type === 'hello');

  // Attach as director (all sessions, default wake kinds).
  const at = await fetch(`${base}/api/director/attach`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid: Number(DPID) }),
  });
  const atJson = await at.json();
  assert.equal(atJson.ok, true);
  assert.equal(atJson.sessionId, DSID);

  // Director flag visible in state.
  const st = await (await fetch(`${base}/api/state`)).json();
  assert.equal(st.sessions.find((x) => x.id === DSID).isDirector, true);

  // A worker Stop wakes the director with a digest.
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ __hook: 'Stop', __ts: new Date().toISOString(), payload: { session_id: WSID, last_assistant_message: 'milestone one done' } }),
  });
  await waitFor((l) => l.type === 'message' && l.meta && l.meta.kind === 'stop' && l.meta.session_id === WSID && /milestone one done/.test(l.text));

  // The director's OWN Stop must not wake it; a plain worker PreToolUse must not either.
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ __hook: 'Stop', __ts: new Date().toISOString(), payload: { session_id: DSID, last_assistant_message: 'director thinking' } }),
  });
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ __hook: 'PreToolUse', __ts: new Date().toISOString(), payload: { session_id: WSID, tool_name: 'Bash', tool_input: {} } }),
  });
  // Blocked progress DOES wake — and proves the two above were skipped (ordering: streams are FIFO).
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ __hook: 'MCPProgress', __ts: new Date().toISOString(), payload: { session_id: WSID, state: 'blocked', note: 'need a decision' } }),
  });
  await waitFor((l) => l.meta && l.meta.kind === 'blocked');
  assert.ok(!lines.some((l) => l.meta && l.meta.session_id === DSID), 'own-session event leaked to director');
  assert.ok(!lines.some((l) => /director thinking/.test(l.text || '')), 'own Stop digest leaked');

  // Detach stops the flow.
  await fetch(`${base}/api/director/detach`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid: Number(DPID) }),
  });
  const st2 = await (await fetch(`${base}/api/state`)).json();
  assert.equal(st2.sessions.find((x) => x.id === DSID).isDirector, false);
  sub.destroy();
});

test('director status endpoint: true only for an attached director session', async () => {
  const DPID = '76543';
  const DSID = 'status-director';
  await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ __hook: 'SessionStart', __ts: new Date().toISOString(), __pid: Number(DPID), payload: { session_id: DSID, cwd: '/tmp/sd' } }),
  });
  // Not a director yet.
  let r = await (await fetch(`${base}/api/director/status?sessionId=${DSID}`)).json();
  assert.equal(r.isDirector, false);
  // Unknown session → false, never an error.
  r = await (await fetch(`${base}/api/director/status?sessionId=nope`)).json();
  assert.equal(r.isDirector, false);
  // Attach → true.
  await fetch(`${base}/api/director/attach`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid: Number(DPID) }),
  });
  r = await (await fetch(`${base}/api/director/status?sessionId=${DSID}`)).json();
  assert.equal(r.isDirector, true);
  // Detach → false again.
  await fetch(`${base}/api/director/detach`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid: Number(DPID) }),
  });
  r = await (await fetch(`${base}/api/director/status?sessionId=${DSID}`)).json();
  assert.equal(r.isDirector, false);
});

test('director: a newly connecting worker wakes the director (wake-on-connect)', async () => {
  const http = require('http');
  const DPID = '70001';
  const DSID = 'woc-director';
  const WPID = '70002';
  const WSID = 'woc-worker';

  // Director session + its bridge, then attach.
  await fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ __hook: 'SessionStart', __pid: Number(DPID), payload: { session_id: DSID, cwd: '/tmp/woc-dir' } }) });
  const lines = [];
  let onLine = null;
  const dsub = http.get(`${base}/api/channel/subscribe?pid=${DPID}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) !== -1) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { lines.push(JSON.parse(l)); onLine && onLine(); } } });
  });
  const waitFor = (pred) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out; got ' + JSON.stringify(lines))), 3000);
    onLine = () => { if (lines.some(pred)) { clearTimeout(t); resolve(); } };
    onLine();
  });
  await waitFor((l) => l.type === 'hello');
  await fetch(`${base}/api/director/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: Number(DPID) }) });

  // Worker session appears, then its bridge connects → director should wake.
  await fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ __hook: 'SessionStart', __pid: Number(WPID), payload: { session_id: WSID, cwd: '/tmp/woc-work' } }) });
  const wsub = http.get(`${base}/api/channel/subscribe?pid=${WPID}`, (res) => res.resume());
  await waitFor((l) => l.meta && l.meta.kind === 'worker-connected' && l.meta.session_id === WSID);

  // The director's own bridge reconnecting must NOT wake it about itself.
  const before = lines.length;
  const dsub2 = http.get(`${base}/api/channel/subscribe?pid=${DPID}`, (res) => res.resume());
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!lines.slice(before).some((l) => l.meta && l.meta.kind === 'worker-connected' && l.meta.session_id === DSID), 'director woke about its own connect');

  await fetch(`${base}/api/director/detach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: Number(DPID) }) });
  dsub.destroy(); wsub.destroy(); dsub2.destroy();
});
