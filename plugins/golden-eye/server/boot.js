#!/usr/bin/env node
'use strict';

/**
 * Idempotent singleton bootstrap, meant to run on every SessionStart (and be
 * wired in hooks.json + project settings):
 *
 *   server healthy somewhere  ->  do nothing (exit 0, silent stdout:
 *                                 SessionStart stdout gets injected into context!)
 *   else                      ->  take exclusive lock, spawn exactly ONE
 *                                 detached server (first free candidate port)
 *
 * The spawned server outlives this process and every session; sessions never
 * own it, they only ensure it exists.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const say = (msg) => process.stderr.write(`[golden-eye] ${msg}\n`);

async function healthz(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(400),
    });
    if (!r.ok) return null;
    const j = await r.json();
    // Identity check: /healthz must self-identify, else a port squatter that
    // happens to answer { ok: true } would be adopted as "the" server.
    return j && j.ok === true && j.name === 'golden-eye' ? j : null;
  } catch (_) {
    return null;
  }
}

// Adopt a healthy server only if it runs code at least as new as ours.
// A stale one (older gen, or a pre-gen build reporting none) is killed so
// the spawn path below replaces it — this is how plugin updates propagate
// without anyone remembering to restart the singleton.
function adoptable(h) {
  return !!h && (h.gen || 0) >= config.SERVER_GENERATION;
}

async function retireStale(h, port, fallbackPid) {
  const pid = (h && h.pid) || fallbackPid;
  say(`server on :${port} runs older code (gen ${h && h.gen ? h.gen : 'none'} < ${config.SERVER_GENERATION}) — restarting it`);
  try {
    if (pid) process.kill(pid);
  } catch (_) {}
  // Give the port a moment to free up before the spawn path probes it.
  await new Promise((r) => setTimeout(r, 300));
}

// A bootstrap normally removes its lock in `finally`, but a SIGKILL (or
// power loss) between open and cleanup would otherwise deadlock every future
// SessionStart. The lock records { pid, ts }; a lock whose owner is dead or
// that has outlived any plausible bootstrap is broken and retaken.
const STALE_LOCK_MS = 15_000;
// A lock whose owner is STILL ALIVE gets a much longer leash: a legitimate
// bootstrap can spend >15s walking ports on a slow machine, and stealing its
// lock mid-spawn double-starts the server.
const STALE_LOCK_ALIVE_MS = 60_000;

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(config.LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return fd;
    } catch (_) {
      let stale = false;
      try {
        const st = fs.statSync(config.LOCK_FILE);
        let meta = null;
        try {
          meta = JSON.parse(fs.readFileSync(config.LOCK_FILE, 'utf8'));
        } catch (_) {}
        const age = Date.now() - st.mtimeMs;
        stale =
          meta && meta.pid
            ? !pidAlive(meta.pid) || age > STALE_LOCK_ALIVE_MS
            : age > STALE_LOCK_MS; // not yet written: judge by mtime alone
      } catch (_) {
        continue; // lock vanished between open-fail and stat — just retry
      }
      if (!stale) return null;
      try {
        fs.rmSync(config.LOCK_FILE, { force: true });
      } catch (_) {}
    }
  }
  return null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function startServer(port) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'index.js')],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, GOLDEN_EYE_PORT: String(port) },
      }
    );
    child.unref();
    const t0 = Date.now();
    const poll = async () => {
      if (await healthz(port)) return resolve(child.pid);
      if (Date.now() - t0 > 2500) {
        // Kill the straggler: a child that passes healthz AFTER this timeout
        // would coexist with the next port's spawn — two live servers.
        try { process.kill(child.pid); } catch (_) {}
        return resolve(null);
      }
      setTimeout(poll, 150);
    };
    poll();
  });
}

async function main() {
  // 1. Fast path: server.json says a server lives here and it is healthy.
  try {
    const meta = JSON.parse(fs.readFileSync(config.SERVER_FILE, 'utf8'));
    if (meta && meta.pid && pidAlive(meta.pid)) {
      const h = await healthz(meta.port);
      if (adoptable(h)) {
        say(`server already running on :${meta.port} (pid ${meta.pid})`);
        return;
      }
      if (h) await retireStale(h, meta.port, meta.pid);
    }
  } catch (_) {
    /* no/stale server file — fall through to discovery */
  }

  // 2. Discovery: healthy same-or-newer golden-eye on any candidate port ->
  //    reuse; a stale one is retired so the spawn path replaces it.
  for (const port of config.PORT_CANDIDATES) {
    const h = await healthz(port);
    if (adoptable(h)) {
      say(`found healthy server on :${port} (its server.json is stale, but it works)`);
      return;
    }
    if (h) await retireStale(h, port, null);
  }

  // 3. Exclusive lock so simultaneous SessionStarts spawn exactly one server.
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const lockFd = acquireLock();
  if (lockFd == null) {
    say('another bootstrap is starting the server; standing down');
    return;
  }

  try {
    for (const port of config.PORT_CANDIDATES) {
      const pid = await startServer(port);
      if (pid) {
        say(`started server on :${port} (pid ${pid})`);
        return;
      }
    }
    say('ERROR: no free port among ' + config.PORT_CANDIDATES.join(', '));
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch (_) {}
    try {
      fs.rmSync(config.LOCK_FILE, { force: true });
    } catch (_) {}
  }
}

main().catch(() => process.exit(0));