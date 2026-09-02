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
