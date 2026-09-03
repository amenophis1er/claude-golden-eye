'use strict';

/**
 * Shared runtime config for the golden-eye server and its clients (hooks,
 * boot). Everything derives from one data dir so sessions in any project —
 * or any terminal — converge on the same server and store.
 */

const os = require('os');
const path = require('path');

const DATA_DIR =
  process.env.GOLDEN_EYE_DATA_DIR || path.join(os.homedir(), '.golden-eye');

// Bootstrap walks this list: 7717 preferred, N-1 squatter-occupancy fallbacks.
const PORT_CANDIDATES = [7717, 7718, 7719, 7720, 7721];

// server.json is written by the server itself on listen: { pid, port, startedAt }.
const SERVER_FILE = path.join(DATA_DIR, 'server.json');
// Exclusive-create lock serializes simultaneous SessionStart bootstraps.
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');

const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');

// Build generation: the newest mtime across this copy's server sources.
// /healthz reports it and boot.js compares — a healthy server built from
// OLDER code than the bootstrapping copy gets restarted instead of adopted,
// so plugin updates and branch switches take effect on the next
// SessionStart instead of silently serving stale code. Semantics: the most
// recently written/deployed copy wins.
const fs = require('fs');
let SERVER_GENERATION = 0;
try {
  for (const f of fs.readdirSync(__dirname)) {
    if (!f.endsWith('.js')) continue;
    const m = fs.statSync(path.join(__dirname, f)).mtimeMs;
    if (m > SERVER_GENERATION) SERVER_GENERATION = m;
  }
} catch (_) {}
SERVER_GENERATION = Math.round(SERVER_GENERATION);

module.exports = { DATA_DIR, PORT_CANDIDATES, SERVER_FILE, LOCK_FILE, EVENTS_FILE, SERVER_GENERATION };