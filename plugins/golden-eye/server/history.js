'use strict';

/**
 * Session history browser (read-only, opt-in): lists past Claude Code
 * sessions straight from the transcript store on disk.
 *
 * Discovery is derived, never configured: every observed hook event carries a
 * transcript_path of the shape <config dir>/projects/<slug>/<session>.jsonl,
 * so dirname² of any observed transcript is a projects root. That keeps the
 * server free of hardcoded config-dir paths and transparently covers multiple
 * Claude instances (each instance's sessions reveal its own root).
 *
 * Security model: the `dir` request parameter is only ever accepted when it
 * resolves to a DIRECT child of a derived projects root — no traversal, no
 * arbitrary reads. Session ids are filename-shaped tokens, never paths.
 */

const fs = require('fs');
const path = require('path');
const { headPeek, artifactsFromTranscript } = require('./transcript');

const MAX_SESSIONS_PER_PROJECT = 200;

/** Unique projects roots derived from every transcript path the store has seen. */
function historyRoots(store) {
  const roots = new Set();
  for (const s of store.sessions.values()) {
    if (!s.transcriptPath) continue;
    const root = path.dirname(path.dirname(s.transcriptPath));
    // Sanity: the Claude Code layout puts sessions under .../projects/<slug>/.
    if (path.basename(root) === 'projects') roots.add(root);
  }
  return [...roots];
}

/** All project dirs across the derived roots, newest activity first. */
function listProjects(store) {
  const projects = [];
  for (const root of historyRoots(store)) {
    let names;
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const name of names) {
      const dir = path.join(root, name);
      let files;
      try { files = fs.readdirSync(dir); } catch (_) { continue; }
      const jsonl = files.filter((f) => f.endsWith('.jsonl'));
      if (!jsonl.length) continue;
      let last = 0;
      let newest = null;
      for (const f of jsonl) {
        try {
          const m = fs.statSync(path.join(dir, f)).mtimeMs;
          if (m > last) { last = m; newest = f; }
        } catch (_) {}
      }
      // The slugged dir name is lossy (dashes); the true cwd is in the
      // transcript itself — peek the newest one.
      const peek = newest ? headPeek(path.join(dir, newest)) : null;
      projects.push({
        dir,
        cwd: (peek && peek.cwd) || name,
        sessions: jsonl.length,
        lastActive: last ? new Date(last).toISOString() : null,
      });
    }
  }
  projects.sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''));
  return projects;
}

/**
 * Validate a client-supplied project dir: must resolve to a direct child of a
 * derived projects root. Returns the resolved dir or null.
 */
function resolveProjectDir(store, dirParam) {
  if (typeof dirParam !== 'string' || !dirParam) return null;
  let resolved;
  try { resolved = fs.realpathSync(dirParam); } catch (_) { return null; }
  for (const root of historyRoots(store)) {
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch (_) { continue; }
    if (path.dirname(resolved) === realRoot) return resolved;
  }
  return null;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Sessions of one (validated) project dir, newest first. */
function listSessions(store, projectDir) {
  let files;
  try { files = fs.readdirSync(projectDir); } catch (_) { return []; }
  const liveIds = new Set(store.sessions.keys());
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    if (!ID_RE.test(id)) continue;
    const file = path.join(projectDir, f);
    let stat;
    try { stat = fs.statSync(file); } catch (_) { continue; }
    if (!stat.isFile()) continue;
    out.push({
      id,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      live: liveIds.has(id),
      _mtimeMs: stat.mtimeMs,
    });
  }
  out.sort((a, b) => b._mtimeMs - a._mtimeMs);
  const capped = out.slice(0, MAX_SESSIONS_PER_PROJECT);
  // Peek only what is actually returned — a first prompt per row.
  for (const s of capped) {
    const peek = headPeek(path.join(projectDir, s.id + '.jsonl'));
    s.firstPrompt = (peek && peek.firstPrompt) || null;
    s.startedAt = (peek && peek.firstTs) || null;
    delete s._mtimeMs;
  }
  return capped;
}

/** Transcript file for a (validated dir, filename-shaped id) pair, or null. */
function resolveTranscript(store, dirParam, id) {
  const dir = resolveProjectDir(store, dirParam);
  if (!dir || !ID_RE.test(String(id || ''))) return null;
  return path.join(dir, id + '.jsonl');
}

/**
 * Artifacts published from a project's past sessions, scanned from their
 * transcripts. Same-id publishes across sessions collapse to one row (the
 * newest session's copy wins). Bounded by MAX_SESSIONS_PER_PROJECT, and each
 * file's scan is cached in transcript.js, so a repeat call is nearly free.
 */
function artifactsForProject(projectDir) {
  let files;
  try { files = fs.readdirSync(projectDir); } catch (_) { return []; }
  const stamped = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    if (!ID_RE.test(id)) continue;
    const file = path.join(projectDir, f);
    let stat;
    try { stat = fs.statSync(file); } catch (_) { continue; }
    if (!stat.isFile()) continue;
    stamped.push({ file, id, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() });
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const byId = new Map();
  for (const s of stamped.slice(0, MAX_SESSIONS_PER_PROJECT)) {
    for (const a of artifactsFromTranscript(s.file)) {
      // Newest session first, so an id already seen has a fresher record.
      // lastAt comes from the transcript entry; the file mtime is the
      // fallback for an entry that carried no timestamp.
      if (!byId.has(a.id)) byId.set(a.id, { ...a, sessionId: s.id, lastAt: a.lastAt || s.mtime, backfilled: true });
    }
  }
  return [...byId.values()];
}

module.exports = { listProjects, resolveProjectDir, listSessions, resolveTranscript, artifactsForProject };
