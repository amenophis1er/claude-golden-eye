'use strict';

/**
 * "Is this copy current?" — two independent questions, one cheap and one that
 * costs a network call.
 *
 * 1. Local staleness (always on, no network): the server runs out of a
 *    versioned install directory. If a NEWER sibling exists, an update was
 *    installed while this process kept serving the old code — the exact
 *    failure that makes a fix look deployed when it is not.
 *
 * 2. New release (opt-in): golden-eye otherwise makes zero outbound requests,
 *    so phoning a release feed is a property worth spending deliberately.
 *    GitHub is the source rather than npm because an endpoint proxy that
 *    withholds recently-published versions (common on managed machines)
 *    rewrites npm packuments and would report "no update" indefinitely.
 *
 * Never auto-updates: it reports, and names the command that fits how this
 * copy was installed.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const config = require('./config');

const RELEASES_URL = 'https://api.github.com/repos/amenophis1er/claude-golden-eye/releases/latest';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = path.join(config.DATA_DIR, 'update-check.json');

/** -1 / 0 / 1 for dotted numeric versions; unparseable parts sort as 0. */
function cmpVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * How this copy was installed, inferred from where its code lives — so the
 * suggested command is the one that actually works here.
 */
function installKind(dir) {
  if (dir.includes(`${path.sep}.golden-eye${path.sep}app${path.sep}`)) return 'npx';
  if (dir.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) return 'marketplace';
  return 'source';
}

function updateCommand(kind) {
  if (kind === 'npx') return 'npx claude-golden-eye@latest init';
  if (kind === 'marketplace') return 'claude plugin update golden-eye@claude-golden-eye';
  return 'git pull (development checkout)';
}

/**
 * A newer version directory sitting beside this one means the running process
 * is behind what is installed. Purely a filesystem read.
 */
function installedNewerThanRunning(serverDir = __dirname) {
  const versionDir = path.dirname(serverDir); // <…>/golden-eye/<version>
  const running = path.basename(versionDir);
  if (!/^\d+\.\d+\.\d+$/.test(running)) return null; // source checkout
  let siblings;
  try { siblings = fs.readdirSync(path.dirname(versionDir)); } catch (_) { return null; }
  const newer = siblings
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && cmpVersions(v, running) > 0)
    .sort(cmpVersions)
    .pop();
  return newer ? { running, installed: newer } : null;
}

// ---------- remote release check (opt-in) ----------
function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}

function writeCache(obj) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj) + '\n'); } catch (_) {}
}

function fetchLatest() {
  return new Promise((resolve) => {
    const req = https.request(
      RELEASES_URL,
      { method: 'GET', headers: { 'user-agent': 'golden-eye', accept: 'application/vnd.github+json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const tag = String(JSON.parse(data).tag_name || '').replace(/^v/, '');
            resolve(/^\d+\.\d+\.\d+$/.test(tag) ? tag : null);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null)); // offline / blocked: stay silent
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

let checking = false;

/**
 * Cached, at most once a day, fire-and-forget. Returns the last known result
 * immediately and refreshes in the background when stale.
 */
function latestRelease(enabled) {
  if (!enabled) return null;
  const cache = readCache();
  const fresh = cache.checkedAt && Date.now() - Date.parse(cache.checkedAt) < CHECK_EVERY_MS;
  if (!fresh && !checking) {
    checking = true;
    fetchLatest().then((latest) => {
      checking = false;
      // Record the attempt either way, so a blocked network retries daily
      // rather than on every single request.
      writeCache({ checkedAt: new Date().toISOString(), latest: latest || cache.latest || null });
    });
  }
  return cache.latest || null;
}

/** Snapshot for /api/state: never throws, never blocks. */
function updateStatus(enabled) {
  const running = config.VERSION;
  const local = installedNewerThanRunning();
  const latest = latestRelease(enabled);
  const kind = installKind(__dirname);
  return {
    running,
    // A newer version is installed but this process is still serving the old.
    staleServer: local ? local.installed : null,
    // A newer release exists upstream (null when the check is off).
    latestRelease: latest && running && cmpVersions(latest, running) > 0 ? latest : null,
    command: updateCommand(kind),
    installKind: kind,
  };
}

module.exports = { updateStatus, cmpVersions, installKind, updateCommand, installedNewerThanRunning };
