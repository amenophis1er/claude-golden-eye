'use strict';

/**
 * Golden-eye server (M1/V0): one dependency-free node process, three roles:
 *  1. HTTP ingest      POST /ingest        <- hook bridge posts every hook event
 *  2. Live API         GET  /api/state     (snapshot)  GET /api/events (SSE stream)
 *  3. Static hosting   GET  /              <- the web/ dashboard (no build step)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const Store = require('./state');
const config = require('./config');

const HOST = process.env.GOLDEN_EYE_HOST || '127.0.0.1';
const WEB_DIR = path.join(__dirname, '..', 'web');
const IDLE_EXIT_MS = Number(process.env.GOLDEN_EYE_IDLE_EXIT_MS ?? 30 * 60 * 1000);

let lastEventAt = Date.now();

// Desktop notifications (walk-away oversight). Throttled; off-switchable.
const { execFile } = require('child_process');
let lastNotifyAt = 0;
const NOTIFY_THROTTLE_MS = 5000;
// Throttled events are coalesced, not dropped: the newest one flushes when
// the window closes ("walk-away" oversight must not lose a blocked/deny ping).
let queuedNotify = null;
let suppressedCount = 0;
function notifyDesktop(title, body) {
  if (process.env.GOLDEN_EYE_NOTIFY === '0') return;
  if (process.platform !== 'darwin') return;
  const now = Date.now();
  if (now - lastNotifyAt < NOTIFY_THROTTLE_MS) {
    queuedNotify = { title, body };
    suppressedCount += 1;
    if (suppressedCount === 1) {
      setTimeout(() => {
        const q = queuedNotify;
        const extra = suppressedCount - 1;
        queuedNotify = null;
        suppressedCount = 0;
        if (q) notifyDesktop(q.title, extra > 0 ? `${q.body} (+${extra} more)` : q.body);
      }, NOTIFY_THROTTLE_MS - (now - lastNotifyAt) + 50).unref();
    }
    return;
  }
  lastNotifyAt = now;
  try {
    execFile('osascript', [
      '-e',
      `display notification ${JSON.stringify(String(body || '').slice(0, 120))} with title ${JSON.stringify(title)}`,
    ], () => {});
  } catch (_) {}
}

function maybeNotify(ev) {
  if (!ev) return;
  const p = ev.payload || {};
  if (ev.__hook === 'SubagentStop') {
    notifyDesktop('golden-eye: subagent finished', String(p.last_assistant_message || ''));
  } else if (ev.__hook === 'PMDeny') {
    notifyDesktop('golden-eye: PM write blocked', String(p.tool_name || ''));
  } else if (ev.__hook === 'MCPProgress' && p.state === 'blocked') {
    notifyDesktop('golden-eye: MISSION BLOCKED', String(p.note || ''));
  } else if (ev.__hook === 'Stop') {
    notifyDesktop('golden-eye: turn ended', String(p.last_assistant_message || ''));
  }
}

const store = new Store();
const sseClients = new Set();

// Only fixed filenames are served — no path traversal surface.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error('payload too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

function broadcast(eventObj) {
  const msg = `event: hook\ndata: ${JSON.stringify(eventObj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

// Keep local proxies from idling out an SSE connection; drop dead clients.
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch (_) { sseClients.delete(res); }
  }
}, 25_000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (req.method === 'POST' && url.pathname === '/ingest') {
      const ev = await readJsonBody(req);
      const stored = store.addEvent(ev);
      if (stored) broadcast(stored);
      maybeNotify(stored);
      lastEventAt = Date.now();
      return sendJson(res, 200, { ok: true, ts: stored ? stored.__ts : null });
    }

    if (req.method === 'POST' && url.pathname === '/mcp/attach') {
      // MCP server channel: resolve the session by cwd (most recent), then
      // store the agent-reported progress event under it.
      const body = await readJsonBody(req);
      if (!body || !body.cwd || !body.event || !body.event.payload) {
        return sendJson(res, 400, { error: 'cwd + event.payload required' });
      }
      let best = null;
      let candidates = 0;
      for (const s of store.sessions.values()) {
        if (s.cwd !== body.cwd) continue;
        candidates += 1;
        if (!best || String(s.lastActivity) > String(best.lastActivity)) best = s;
      }
      body.event.payload.session_id = best ? best.id : null;
      // cwd is not unique across concurrent sessions in one project — flag a
      // guessed attribution so the UI and the reporting agent can see it.
      if (candidates > 1) body.event.payload.ambiguous_sessions = candidates;
      const stored = store.addEvent(body.event);
      if (stored) broadcast(stored);
      maybeNotify(stored);
      lastEventAt = Date.now();
      return sendJson(res, 200, { ok: !!stored, sessionId: best ? best.id : null, candidates });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, store.serialize());
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/pm') {
      const body = await readJsonBody(req);
      if (!body || !body.sessionId) {
        return sendJson(res, 400, { error: 'sessionId required' });
      }
      const ev = store.addEvent({
        __hook: 'PMSync',
        payload: {
          session_id: body.sessionId,
          action: body.action === 'off' ? 'off' : 'on',
          mission: body.mission ?? null,
        },
      });
      if (ev) broadcast(ev);
      lastEventAt = Date.now();
      return sendJson(res, 200, pmView(body.sessionId));
    }

    if (req.method === 'GET' && url.pathname === '/pm') {
      const sid = url.searchParams.get('sessionId');
      return sendJson(res, 200, pmView(sid));
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, name: 'golden-eye', sessions: store.sessions.size, clients: sseClients.size });
    }

    const stat = STATIC_FILES[url.pathname];
    if (req.method === 'GET' && stat) {
      const [file, type] = stat;
      const body = fs.readFileSync(path.join(WEB_DIR, file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(body);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
});

// ---------- lifecycle: singleton server file, port candidates, idle exit ----------

function writeServerFile(port) {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(
      config.SERVER_FILE,
      JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }, null, 2) + '\n'
    );
  } catch (_) {
    /* unwritable home: hooks fall back to the default port */
  }
}

function removeServerFile() {
  try {
    const meta = JSON.parse(fs.readFileSync(config.SERVER_FILE, 'utf8'));
    if (meta && meta.pid === process.pid) fs.rmSync(config.SERVER_FILE, { force: true });
  } catch (_) {}
}

// PM discipline view for a session — what the enforcing hooks consume.
function pmView(sessionId) {
  const s = sessionId ? store.sessions.get(sessionId) : null;
  if (!s) return { pmMode: false, mission: null, denies: 0, agents: [], known: false };
  return {
    pmMode: !!s.pmMode,
    mission: s.mission || null,
    denies: s.stats.denies || 0,
    known: true,
    agents: Object.values(s.agents).map((a) => ({
      mainAgent: a.mainAgent,
      status: a.status,
      type: a.type,
      description: a.description,
      lastTool: a.lastTool,
    })),
  };
}

function startIdleWatch() {
  if (!IDLE_EXIT_MS) return;
  setInterval(() => {
    if (sseClients.size > 0) return;
    if (Date.now() - lastEventAt < IDLE_EXIT_MS) return;
    try { fs.rmSync(config.SERVER_FILE, { force: true }); } catch (_) {}
    console.log(`[golden-eye] idle ${Math.round(IDLE_EXIT_MS / 60000)}min with no events and no dashboard open — shutting down`);
    process.exit(0);
  }, 60_000).unref();
}

process.on('SIGINT', () => { removeServerFile(); process.exit(0); });
process.on('SIGTERM', () => { removeServerFile(); process.exit(0); });

function listenOn(index, pinnedPort) {
  const port = pinnedPort != null ? pinnedPort : config.PORT_CANDIDATES[index];
  if (port == null) {
    console.error(`[golden-eye] no free port among ${config.PORT_CANDIDATES.join(', ')} — exiting`);
    process.exit(1);
  }
  server.listen(port, HOST);
  server.once('listening', () => {
    writeServerFile(port);
    console.log(`[golden-eye] dashboard  http://${HOST}:${port}`);
    console.log(`[golden-eye] ingest     POST http://${HOST}:${port}/ingest`);
    console.log(`[golden-eye] data dir   ${config.DATA_DIR}`);
    startIdleWatch();
  });
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && pinnedPort == null) {
      console.log(`[golden-eye] :${port} busy — trying next candidate`);
      listenOn(index + 1, null);
    } else {
      console.error(`[golden-eye] listen failed: ${(err && err.message) || err}`);
      process.exit(1);
    }
  });
}

const pinnedPort = process.env.GOLDEN_EYE_PORT ? Number(process.env.GOLDEN_EYE_PORT) : null;
listenOn(0, pinnedPort);