'use strict';

/**
 * Golden-eye server: one dependency-free node process, three roles:
 *  1. HTTP ingest      POST /ingest        <- hook bridge posts every hook event
 *  2. Live API         GET  /api/state     (snapshot)  GET /api/events (SSE stream)
 *  3. Static hosting   GET  /              <- the web/ dashboard (no build step)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const Store = require('./state');
const { tailTranscript, sessionStats, agentMeta, sessionReplay } = require('./transcript');
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
  } else if (ev.__hook === 'Notification') {
    // Claude Code's own "needs your attention" signal (permission prompt,
    // waiting for input) — the walk-away case this dashboard exists for.
    notifyDesktop('golden-eye: session needs you', String(p.message || ''));
  } else if (ev.__hook === 'PreToolUse' && p.tool_name === 'AskUserQuestion' && !p.agent_id) {
    const q = p.tool_input && Array.isArray(p.tool_input.questions) && p.tool_input.questions[0];
    notifyDesktop('golden-eye: session is asking you a question', String((q && q.question) || ''));
  }
}

const store = new Store();
const sseClients = new Set();

// ---------- dashboard composer (channel bridge) ----------
// Opt-in: everything below 404s unless GOLDEN_EYE_COMPOSER=1 on the server.
// Each session's golden-eye MCP process subscribes here (keyed by the claude
// process pid it shares with the hooks); the composer routes a message to
// exactly one session's bridge, which injects it as a Claude Code channel
// event. See README "Dashboard composer".
// Enablement, in priority order: env override ('1'/'0') wins, else the
// persistent opt-in in <data dir>/config.json ({"composer": true}) — that
// file survives every spawn path (SessionStart bootstrap, launchd, manual),
// unlike an env var that GUI-launched sessions would not inherit.
function composerConfigured() {
  if (process.env.GOLDEN_EYE_COMPOSER === '1') return true;
  if (process.env.GOLDEN_EYE_COMPOSER === '0') return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'config.json'), 'utf8')).composer === true;
  } catch (_) {
    return false; // no config file: composer stays off
  }
}
const COMPOSER_ENABLED = composerConfigured();

// Permission relay: open tool-approval prompts per claude pid. In-memory
// only — a prompt answered in the terminal never notifies us, so entries
// expire instead of resolving (Claude Code drops stale-id verdicts safely).
const PERMISSION_TTL_MS = 10 * 60 * 1000;
const pendingPermissions = new Map(); // claude pid (string) -> Map(request_id -> {request, at})

function prunePermissions() {
  const cutoff = Date.now() - PERMISSION_TTL_MS;
  for (const [pid, reqs] of pendingPermissions) {
    for (const [id, r] of reqs) if (r.at < cutoff) reqs.delete(id);
    if (!reqs.size) pendingPermissions.delete(pid);
  }
}
const channelSubs = new Map(); // claude pid (string) -> ndjson response stream

let composerToken = null;
function getComposerToken() {
  if (composerToken) return composerToken;
  const file = path.join(config.DATA_DIR, 'composer.token');
  try { composerToken = fs.readFileSync(file, 'utf8').trim() || null; } catch (_) {}
  if (!composerToken) {
    composerToken = require('crypto').randomBytes(24).toString('hex');
    try {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
      fs.writeFileSync(file, composerToken + '\n', { mode: 0o600 });
    } catch (_) {}
  }
  return composerToken;
}

// Direct loopback requests are the trusted path (Host is already validated).
// A proxied request (e.g. `tailscale serve` adds X-Forwarded-*) can inject
// prompts into sessions, so it must present the token from the data dir.
function composerAuthorized(req) {
  const proxied = !!(req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']);
  if (!proxied) return true;
  return req.headers['x-golden-eye-token'] === getComposerToken();
}

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
  for (const [pid, res] of channelSubs) {
    try { res.write('{"type":"ping"}\n'); } catch (_) { channelSubs.delete(pid); }
  }
}, 25_000).unref();

// Host allowlist: the server is loopback-only, but browsers will happily send
// requests to 127.0.0.1 on behalf of a hostile page via DNS rebinding (an
// attacker domain resolving to 127.0.0.1 keeps the page same-origin with us).
// Rejecting foreign Host headers closes that hole. Proxies that rewrite Host
// (e.g. `tailscale serve`) present a loopback/localhost Host and still pass.
function hostAllowed(hostHeader) {
  if (!hostHeader) return true; // HTTP/1.0 or same-box tooling without Host
  const name = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return (
    name === '127.0.0.1' ||
    name === 'localhost' ||
    name === '::1' ||
    name === HOST.toLowerCase()
  );
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden host');
  }
  const url = new URL(req.url, `http://${HOST}`);
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
        // Composer availability for this session: bridge connected right now.
        sess.channelConnected =
          COMPOSER_ENABLED && sess.claudePid != null && channelSubs.has(String(sess.claudePid));
        prunePermissions();
        const perms = sess.claudePid != null ? pendingPermissions.get(String(sess.claudePid)) : null;
        sess.permissionRequests = perms
          ? [...perms.values()].map((p) => ({ ...p.request, at: new Date(p.at).toISOString() }))
          : [];
        const tasks = tasksForSession(sess.id, sess.transcriptPath);
        if (tasks) sess.todos = tasks;
        sess.env = sessionStats(sess.transcriptPath); // branch/model/tokens/context
        // Resume backfill: transcript history older than our first observed
        // event, rendered by the UI as dimmed "replayed" rows. Also hydrates
        // the last-prompt/last-output panels that hooks haven't filled yet.
        const replay = sessionReplay(sess.transcriptPath, sess.startedAt);
        if (replay) {
          sess.replay = replay;
          if (!sess.lastPrompt) {
            for (let i = replay.length - 1; i >= 0; i--) {
              if (replay[i].kind === 'user') { sess.lastPrompt = replay[i].text; break; }
            }
          }
          if (!sess.lastResult) {
            for (let i = replay.length - 1; i >= 0; i--) {
              if (replay[i].kind === 'text') { sess.lastResult = replay[i].text; break; }
            }
          }
        }
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

    if (req.method === 'GET' && url.pathname === '/api/channel/subscribe') {
      // The per-session MCP channel process registers its bridge here.
      if (!COMPOSER_ENABLED) return sendJson(res, 404, { error: 'composer disabled (set GOLDEN_EYE_COMPOSER=1 on the server)' });
      const pid = url.searchParams.get('pid');
      if (!/^\d+$/.test(pid || '')) return sendJson(res, 400, { error: 'pid required' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('{"type":"hello"}\n');
      channelSubs.set(pid, res);
      req.on('close', () => { if (channelSubs.get(pid) === res) channelSubs.delete(pid); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/channel/send') {
      if (!COMPOSER_ENABLED) return sendJson(res, 404, { error: 'composer disabled (set GOLDEN_EYE_COMPOSER=1 on the server)' });
      if (!composerAuthorized(req)) return sendJson(res, 403, { error: 'proxied access requires X-Golden-Eye-Token (see composer.token in the data dir)' });
      const body = await readJsonBody(req);
      const sid = body && body.sessionId;
      const text = body && typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
      if (!sid || !text) return sendJson(res, 400, { error: 'sessionId + text required' });
      const s = store.sessions.get(sid);
      if (!s) return sendJson(res, 404, { error: 'unknown session' });
      const sub = s.claudePid != null ? channelSubs.get(String(s.claudePid)) : null;
      if (!sub) {
        return sendJson(res, 409, {
          error: 'no channel bridge for this session — start it with: claude --dangerously-load-development-channels plugin:golden-eye@claude-golden-eye',
        });
      }
      try {
        sub.write(JSON.stringify({ type: 'message', text }) + '\n');
      } catch (_) {
        channelSubs.delete(String(s.claudePid));
        return sendJson(res, 502, { error: 'bridge write failed — retry' });
      }
      const ev = store.addEvent({ __hook: 'DashboardPrompt', payload: { session_id: sid, prompt: text } });
      if (ev) broadcast(ev);
      lastEventAt = Date.now();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/channel/permission-request') {
      // From a session's MCP channel process: Claude Code relayed an open
      // tool-approval prompt. Loopback-only by nature (the mcp process).
      if (!COMPOSER_ENABLED) return sendJson(res, 404, { error: 'composer disabled' });
      const body = await readJsonBody(req);
      const pid = body && body.pid != null ? String(body.pid) : null;
      const r = body && body.request;
      if (!pid || !r || !r.request_id) return sendJson(res, 400, { error: 'pid + request.request_id required' });
      let reqs = pendingPermissions.get(pid);
      if (!reqs) pendingPermissions.set(pid, (reqs = new Map()));
      reqs.set(String(r.request_id), {
        request: {
          request_id: String(r.request_id),
          tool_name: String(r.tool_name || ''),
          description: String(r.description || '').slice(0, 4000),
          input_preview: String(r.input_preview || '').slice(0, 8000),
        },
        at: Date.now(),
      });
      // Attribute in the feed + wake the dashboard.
      let sid = null;
      for (const s of store.sessions.values()) if (String(s.claudePid) === pid) { sid = s.id; break; }
      const ev = store.addEvent({
        __hook: 'PermissionRequest',
        payload: { session_id: sid, tool_name: r.tool_name || '', description: String(r.description || '').slice(0, 500), request_id: r.request_id },
      });
      if (ev) broadcast(ev);
      lastEventAt = Date.now();
      return sendJson(res, 200, { ok: true, sessionId: sid });
    }

    if (req.method === 'POST' && url.pathname === '/api/channel/verdict') {
      // Dashboard answers a relayed prompt. Same gate as the composer:
      // verdicts approve tool use, so proxied requests need the token.
      if (!COMPOSER_ENABLED) return sendJson(res, 404, { error: 'composer disabled' });
      if (!composerAuthorized(req)) return sendJson(res, 403, { error: 'proxied access requires X-Golden-Eye-Token' });
      const body = await readJsonBody(req);
      const sid = body && body.sessionId;
      const requestId = body && body.requestId != null ? String(body.requestId) : null;
      const behavior = body && (body.behavior === 'allow' || body.behavior === 'deny') ? body.behavior : null;
      if (!sid || !requestId || !behavior) return sendJson(res, 400, { error: 'sessionId + requestId + behavior(allow|deny) required' });
      const s = store.sessions.get(sid);
      if (!s) return sendJson(res, 404, { error: 'unknown session' });
      const pid = s.claudePid != null ? String(s.claudePid) : null;
      const sub = pid ? channelSubs.get(pid) : null;
      if (!sub) return sendJson(res, 409, { error: 'no channel bridge for this session' });
      try {
        sub.write(JSON.stringify({ type: 'permission', request_id: requestId, behavior }) + '\n');
      } catch (_) {
        channelSubs.delete(pid);
        return sendJson(res, 502, { error: 'bridge write failed — retry' });
      }
      const reqs = pendingPermissions.get(pid);
      const known = reqs ? reqs.get(requestId) : null;
      if (reqs) { reqs.delete(requestId); if (!reqs.size) pendingPermissions.delete(pid); }
      const ev = store.addEvent({
        __hook: 'PermissionVerdict',
        payload: { session_id: sid, request_id: requestId, behavior, tool_name: (known && known.request.tool_name) || null },
      });
      if (ev) broadcast(ev);
      lastEventAt = Date.now();
      return sendJson(res, 200, { ok: true });
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
  const onListenError = (err) => {
    server.removeListener('listening', onListening);
    if (err && err.code === 'EADDRINUSE' && pinnedPort == null) {
      console.log(`[golden-eye] :${port} busy — trying next candidate`);
      listenOn(index + 1, null);
    } else {
      console.error(`[golden-eye] listen failed: ${(err && err.message) || err}`);
      process.exit(1);
    }
  };
  const onListening = () => {
    server.removeListener('error', onListenError);
    // Post-listen errors (e.g. EMFILE on accept) must not kill the singleton.
    server.on('error', (err) => {
      console.error(`[golden-eye] server error: ${(err && err.message) || err}`);
    });
    writeServerFile(port);
    console.log(`[golden-eye] dashboard  http://${HOST}:${port}`);
    console.log(`[golden-eye] ingest     POST http://${HOST}:${port}/ingest`);
    console.log(`[golden-eye] data dir   ${config.DATA_DIR}`);
    startIdleWatch();
  };
  server.listen(port, HOST);
  server.once('error', onListenError);
  server.once('listening', onListening);
}

const pinnedPort = process.env.GOLDEN_EYE_PORT ? Number(process.env.GOLDEN_EYE_PORT) : null;
listenOn(0, pinnedPort);