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
