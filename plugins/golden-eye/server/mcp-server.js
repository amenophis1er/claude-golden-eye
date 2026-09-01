'use strict';

/**
 * Golden-eye MCP server: a dependency-free JSON-RPC 2.0 server over
 * stdio (newline-delimited), the transport Claude Code uses for MCP servers.
 *
 * Tools:
 *   report_progress({ state, progress_pct?, note? })  — agents call this per
 *     the PM charter; events flow into the dashboard as MCPProgress.
 *   get_mission({}) — agent-side self-service re-anchor.
 *
 * Session resolution: MCP server processes are spawned with cwd = project
 * dir; we identify the target session as the most recently active session
 * with the same cwd (the payload carries no session id).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const STATE_FILE_GUESS = process.env.GOLDEN_EYE_SERVER_FILE; // optional override

function serverJson() {
  const candidates = [
    STATE_FILE_GUESS,
    path.join(process.env.GOLDEN_EYE_DATA_DIR || path.join(require('os').homedir(), '.golden-eye'), 'server.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (meta && meta.port) return meta;
    } catch (_) {}
  }
  return { port: 7717 };
}

function base() {
  return `http://127.0.0.1:${serverJson().port}`;
}

function post(pathname, payload, timeoutMs = 800) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      base() + pathname,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

async function getJson(pathname, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request(base() + pathname, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ---------- tool implementations ----------

async function reportProgress(args) {
  const state = ['working', 'blocked', 'done'].includes(args.state) ? args.state : 'working';
  // Attach by cwd: the most recently active session for this project.
  const cwd = process.cwd();
  const st = await post('/mcp/attach', {
    cwd,
    event: {
      __hook: 'MCPProgress',
      payload: {
        state,
        progress_pct: typeof args.progress_pct === 'number' ? args.progress_pct : null,
        note: typeof args.note === 'string' ? args.note.slice(0, 500) : '',
      },
    },
  });
  return { ok: !!(st && st.ok), sessionId: (st && st.sessionId) || null };
}

async function getMission() {
  const cwd = process.cwd();
  const st = await fetchState();
  if (!st || !st.sessions || !st.sessions.length) {
    return { mission: null, pmMode: false, note: 'no golden-eye session data' };
  }
  const mine = st.sessions
    .filter((s) => s.cwd === cwd)
    .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))[0];
  if (!mine) return { mission: null, pmMode: false, note: 'no session for cwd ' + cwd };
  return {
    pmMode: !!mine.pmMode,
    mission: mine.mission || null,
    state: mine.state,
    progress: mine.progress || null,
    stats: mine.stats,
  };
}

function fetchJsonPath(p, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request(base() + p, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}
function fetchState() {
  return fetchJsonPath('/api/state');
}

// ---------- MCP plumbing ----------

const TOOLS = [
  {
    name: 'report_progress',
    description:
      'golden-eye: report this delegation/session progress to the oversight dashboard. ' +
      'Call after meaningful milestones and always once before finishing.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['working', 'blocked', 'done'] },
        progress_pct: { type: 'number', minimum: 0, maximum: 100 },
        note: { type: 'string' },
      },
      required: ['state'],
    },
  },
  {
    name: 'get_mission',
    description: 'golden-eye: fetch the current session mission, PM state, progress, and stats for self re-anchoring.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function respond(id, result) {
  if (id === undefined || id === null) return; // notification: no reply
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  if (id === undefined || id === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'golden-eye', version: '0.1.0' },
      });
      return;
    case 'notifications/initialized':
      return;
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        if (name === 'report_progress') {
          const r = await reportProgress(args);
          respond(id, { content: [{ type: 'text', text: JSON.stringify(r) }] });
        } else if (name === 'get_mission') {
          const r = await getMission();
          respond(id, { content: [{ type: 'text', text: JSON.stringify(r) }] });
        } else {
          respondError(id, -32601, 'unknown tool: ' + name);
        }
      } catch (err) {
        respondError(id, -32000, String((err && err.message) || err));
      }
      return;
    }
    default:
      respondError(id, -32601, 'method not found: ' + method);
  }
}

function main() {
  let buf = '';
  let pending = 0;
  let stdinEnded = false;

  // Drain in-flight async handlers before exiting on stdin close — a tools/call
  // arriving just before stdin ends must still reach the dashboard.
  const maybeExit = () => {
    if (stdinEnded && pending === 0) process.exit(0);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      pending += 1;
      handle(msg)
        .catch(() => {})
        .finally(() => {
          pending -= 1;
          maybeExit();
        });
    }
  });
  process.stdin.on('end', () => {
    stdinEnded = true;
    maybeExit();
  });
  process.stderr.write('[golden-eye] MCP server ready\n');
}

main();