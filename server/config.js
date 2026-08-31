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

module.exports = { DATA_DIR, PORT_CANDIDATES, SERVER_FILE, LOCK_FILE, EVENTS_FILE };