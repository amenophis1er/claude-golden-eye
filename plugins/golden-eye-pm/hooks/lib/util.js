'use strict';

/**
 * Standalone helpers for the PM plugin — deliberately no dependency on the
 * golden-eye observer plugin's code. The only coupling is the shared data
 * dir (~/.golden-eye): the observer's server records its port in server.json
 * there, and PM state lives on that server. No server => every PM network
 * call fails open (charter still injects; enforcement is skipped).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR =
  process.env.GOLDEN_EYE_DATA_DIR || path.join(os.homedir(), '.golden-eye');
const SERVER_FILE = path.join(DATA_DIR, 'server.json');

/**
 * Returns the golden-eye ingest URL, or null when no server is known to
 * exist. Null tells callers to skip network work entirely — the PreToolUse
 * hook runs on every tool call.
 */
function resolveServerUrl() {
  if (process.env.GOLDEN_EYE_SERVER_URL) return process.env.GOLDEN_EYE_SERVER_URL;
  try {
    const meta = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    if (meta && meta.port) return `http://127.0.0.1:${meta.port}/ingest`;
  } catch (_) {
    /* no server file — observer plugin absent or never bootstrapped */
  }
  return null;
}

/** Read all of stdin and parse it as JSON (hook payload contract). */
function readStdinJson() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }
  if (raw.trim() === '') return { __emptyStdin: true };
  try {
    return JSON.parse(raw);
  } catch (err) {
    return { __parseError: String(err), __raw: raw.slice(0, 4000) };
  }
}

module.exports = { resolveServerUrl, readStdinJson };
