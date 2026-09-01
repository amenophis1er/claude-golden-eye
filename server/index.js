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
const { tailTranscript, sessionStats, agentMeta } = require('./transcript');
const { tasksForSession } = require('./tasks');
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

// Static hosting for the built dashboard (web/dist, hashed asset names).
// Resolved paths are verified to stay inside DIST_DIR — no traversal surface.
const DIST_DIR = path.join(WEB_DIR, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.normalize(path.join(DIST_DIR, rel));
  if (!file.startsWith(DIST_DIR + path.sep) && file !== path.join(DIST_DIR, 'index.html')) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Unknown GET path → SPA entry (hash routing handles the rest).
    file = path.join(DIST_DIR, 'index.html');
    if (!fs.existsSync(file)) return false;
  }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    // Hashed assets are immutable; everything else must revalidate.
    'Cache-Control': /assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(body);
  return true;
}

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

    if (req.method === 'GET' && url.pathname === '/api/agent-transcript') {
      // Live deep-dive: tail the JSONL transcript of the session (no agentId)
      // or one subagent. The path is DERIVED server-side from stored session
      // state — the client never supplies a filesystem path.
      const sid = url.searchParams.get('sessionId');
      const aid = url.searchParams.get('agentId');
      const sess = sid ? store.sessions.get(sid) : null;
      if (!sess || !sess.transcriptPath) return sendJson(res, 404, { error: 'unknown session / no transcript path' });
      let file = sess.transcriptPath;
      if (aid) {
        if (!/^[\w.-]+$/.test(aid)) return sendJson(res, 400, { error: 'bad agentId' });
        const a = sess.agents['agent:' + aid];
        file =
          (a && a.transcriptPath) ||
          sess.transcriptPath.replace(/\.jsonl$/, '') + '/subagents/agent-' + aid + '.jsonl';
      }
      return sendJson(res, 200, { file, ...tailTranscript(file) });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const snapshot = store.serialize();
      // Plan board: the on-disk task store is authoritative (it holds tasks
      // created before hooks were watching); event-mirrored todos are the
      // fallback when no store dir exists for the session.
      for (const sess of snapshot.sessions) {
        const tasks = tasksForSession(sess.id, sess.transcriptPath);
        if (tasks) sess.todos = tasks;
        sess.env = sessionStats(sess.transcriptPath); // branch/model/tokens/context
        // Agents observed only from their tail (spawn predates a resume)
        // have no description — recover it from their own transcript.
        for (const a of sess.agents) {
          if (!a.mainAgent && a.id && sess.transcriptPath && (!a.description || !a.type || !a.model)) {
            const f =
              a.transcriptPath ||
              sess.transcriptPath.replace(/\.jsonl$/, '') + '/subagents/agent-' + a.id + '.jsonl';
            const m = agentMeta(f);
            if (m) {
              if (!a.description) a.description = m.description;
              if (!a.type) a.type = m.agentType;
              if (!a.model) a.model = m.model;
            }
          }
        }
      }
      return sendJson(res, 200, snapshot);
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
          sub_model: body.subModel ?? null,
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

    if (req.method === 'POST' && url.pathname === '/api/prune') {
      // Remove sessions from the dashboard. Persisted as SessionPrune
      // tombstones so an events.jsonl replay does not resurrect them.
      const body = await readJsonBody(req);
      const ids = [];
      if (body && Array.isArray(body.sessionIds)) {
        for (const id of body.sessionIds) if (store.sessions.has(id)) ids.push(id);
      } else if (body && body.staleBefore) {
        for (const s of store.sessions.values()) {
          if (String(s.lastActivity) < String(body.staleBefore) && s.state !== 'working') ids.push(s.id);
        }
      }
      for (const id of ids) {
        const ev = store.addEvent({ __hook: 'SessionPrune', payload: { session_id: id } });
        if (ev) broadcast(ev);
      }
      lastEventAt = Date.now();
      return sendJson(res, 200, { ok: true, pruned: ids });
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, name: 'golden-eye', sessions: store.sessions.size, clients: sseClients.size });
    }

    if (req.method === 'GET' && serveStatic(res, url.pathname)) return;

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
  if (!s) return { pmMode: false, mission: null, subModel: null, denies: 0, agents: [], known: false };
  return {
    pmMode: !!s.pmMode,
    mission: s.mission || null,
    subModel: s.subModel || null,
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