'use strict';

/**
 * Shared stdin->JSONL logger for all hook scripts.
 * Contract: never throw, never write to stdout (some events like
 * SessionStart / UserPromptSubmit inject stdout into context on exit 0),
 * always exit 0 so a probe failure can never break a real session.
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
const LOG_DIR = process.env.GOLDEN_EYE_LOG_DIR || path.join(PLUGIN_ROOT, '.probe');
const LOG_FILE = path.join(LOG_DIR, 'hook-events.jsonl');

// Bridge target: the golden-eye dashboard server. The server records its
// actual port in server.json on boot, so hooks follow it (port candidates
// may have moved past 7717 when occupied by a squatter).
let sharedConfig = null;
try {
  sharedConfig = require('../../server/config');
} catch (_) {
  /* plugin running standalone — fall back to the default URL */
}

/**
 * Returns the ingest URL, or null when no server is known to exist (no
 * server.json, no env override). Null tells callers to skip network work
 * entirely — hooks run on EVERY tool call, so a dead-server fetch (even a
 * fast ECONNREFUSED) is per-call overhead worth avoiding.
 */
function resolveServerUrl() {
  if (process.env.GOLDEN_EYE_SERVER_URL) return process.env.GOLDEN_EYE_SERVER_URL;
  if (sharedConfig) {
    try {
      const meta = JSON.parse(fs.readFileSync(sharedConfig.SERVER_FILE, 'utf8'));
      if (meta && meta.port) return `http://127.0.0.1:${meta.port}/ingest`;
    } catch (_) {
      /* no server file — a server was never bootstrapped here */
    }
    return null;
  }
  return 'http://127.0.0.1:7717/ingest'; // standalone (no shared config): best effort
}

function appendJsonSafe(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (err) {
    try {
      fs.appendFileSync(file, JSON.stringify({ __appendError: String(err) }) + '\n');
    } catch (_) {
      /* truly nothing left to do */
    }
  }
}

/**
 * Best-effort POST of the event to the dashboard server. Fails silently when
 * the server is down — the JSONL log remains the fallback data path.
 */
async function postToServer(entry, timeoutMs = 250) {
  if (process.env.GOLDEN_EYE_DISABLE_POST === '1') return;
  const url = resolveServerUrl();
  if (!url) return; // server never started — JSONL log is the only sink
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (_) {
    /* server offline — fine, logging still worked */
  }
}

/**
 * Read all of stdin (before anything else touches fd 0) and parse it as JSON.
 * Returns the payload object; preserves raw input on parse failure.
 */
function readStdinJson() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    raw = '';
  }
  if (raw.trim() === '') return { __emptyStdin: true };
  try {
    return JSON.parse(raw);
  } catch (err) {
    return { __parseError: String(err), __raw: raw.slice(0, 4000) };
  }
}

/**
 * Read/persist an event: append `{ __hook, __ts, payload }` to the JSONL log
 * and mirror it to the dashboard server. `payloadArg` lets caller hooks that
 * already consumed stdin (e.g. pre-tool-use decide-then-log) pass it in.
 * Resolves after both sinks settle.
 */
async function logStdinEvent(hookName, payloadArg) {
  const payload = payloadArg !== undefined ? payloadArg : readStdinJson();

  const entry = {
    __hook: hookName,
    __ts: new Date().toISOString(),
    payload,
  };

  appendJsonSafe(LOG_FILE, entry);
  await postToServer(entry);
}

module.exports = { logStdinEvent, readStdinJson, resolveServerUrl, LOG_FILE, PLUGIN_ROOT };