'use strict';

/**
 * Background command state, read from the file Claude Code writes for each one.
 *
 * Every background command streams to <tmp>/<cwd-slug>/<session>/tasks/<id>.output
 * and gets an "[exited with code N]" marker appended when it ends. That file is
 * the durable truth: it exists while the command runs, so it gives live output,
 * and its exit marker retires the shell without depending on a completion
 * notice reaching the server.
 *
 * That dependency was the bug this replaces. Shells were only ever retired by a
 * task-notification hook event; hooks fail open, so any notice fired while the
 * server was restarting was lost forever and the shell showed as running for
 * good — a count that could only go up.
 *
 * The path is resolved by search rather than construction: a resumed session
 * writes under a different session id than the one the dashboard tracks, so
 * building the path from our own id would silently never match.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXIT_RE = /\[exited with code (-?\d+)\]/;
const TAIL_BYTES = 8 * 1024;
const PATH_TTL_MS = 30_000;   // re-search only when a lookup failed
const pathCache = new Map();  // taskId -> { at, file }

function tmpRoots() {
  // Claude Code scratch lives under <tmp>/claude-<uid>/. Note os.tmpdir() is
  // NOT enough on macOS: it resolves to the per-user /var/folders/... path,
  // while Claude Code writes under /tmp. Check both, plus TMPDIR.
  const bases = ['/tmp', os.tmpdir(), process.env.TMPDIR].filter(Boolean);
  const roots = [];
  const seen = new Set();
  for (const base of bases) {
    let names;
    try { names = fs.readdirSync(base); } catch (_) { continue; }
    for (const name of names) {
      if (!/^claude-\d+$/.test(name)) continue;
      const p = path.join(base, name);
      let real;
      try { real = fs.realpathSync(p); } catch (_) { real = p; }
      if (seen.has(real)) continue;
      seen.add(real);
      roots.push(real);
    }
  }
  return roots;
}

/** Locate <id>.output without assuming which session directory wrote it. */
function findOutputFile(taskId, cwd) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(taskId || ''))) return null;
  const hit = pathCache.get(taskId);
  if (hit && (hit.file || Date.now() - hit.at < PATH_TTL_MS)) return hit.file;

  const slug = cwd ? String(cwd).replace(/\//g, '-') : null;
  let found = null;
  for (const root of tmpRoots()) {
    // The project's own slug directory first; fall back to a full sweep only
    // when that misses (a session may have moved between projects).
    const projects = [];
    if (slug) projects.push(path.join(root, slug));
    try {
      for (const d of fs.readdirSync(root)) {
        const p = path.join(root, d);
        if (!projects.includes(p)) projects.push(p);
      }
    } catch (_) {}
    for (const proj of projects) {
      let sessions;
      try { sessions = fs.readdirSync(proj); } catch (_) { continue; }
      for (const sess of sessions) {
        const candidate = path.join(proj, sess, 'tasks', taskId + '.output');
        if (fs.existsSync(candidate)) { found = candidate; break; }
      }
      if (found) break;
    }
    if (found) break;
  }
  pathCache.set(taskId, { at: Date.now(), file: found });
  return found;
}

/**
 * { done, exitCode, output } for one background command, or null when its
 * output file cannot be found (then the caller keeps whatever it knew).
 */
function shellStatus(taskId, cwd) {
  const file = findOutputFile(taskId, cwd);
  if (!file) return null;
  let fd = null;
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    const m = EXIT_RE.exec(text);
    return {
      done: !!m,
      exitCode: m ? Number(m[1]) : null,
      // Drop the marker itself from displayed output; it is metadata.
      output: text.replace(EXIT_RE, '').trimEnd(),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (_) {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

module.exports = { shellStatus, findOutputFile, EXIT_RE };
