'use strict';

/**
 * Read-only peek at a file inside a watched session's project (opt-in).
 *
 * Why it exists: at a desk you would open the file in your editor. On a phone
 * over the tailnet — the case this dashboard is for — you cannot, so a
 * transcript that says "drafting docs/decisions/foo.md" is a dead end without
 * this. Read-only by design, like everything else here.
 *
 * Security model: the path is attacker-shaped input arriving over the network,
 * so it is resolved against the session's OWN cwd and the realpath must still
 * be inside it — symlinks that escape are rejected, not followed. Absolute
 * paths are accepted only when they already live inside that cwd, which keeps
 * "click the path in a tool call" working without widening anything.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;
// A file is served as text only if it looks like text: NUL bytes are the
// cheap, reliable tell for binaries, which have no business in a viewer.
function looksBinary(buf, len) {
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Resolve a requested path against a session cwd, or null if it escapes.
 * Exported for tests — this is the whole security boundary.
 */
function resolveInProject(cwd, requested) {
  if (!cwd || typeof requested !== 'string' || !requested) return null;
  let root;
  try { root = fs.realpathSync(cwd); } catch (_) { return null; }
  const abs = path.resolve(root, requested);
  // Resolve symlinks when the file exists; fall back to the lexical path so a
  // missing file reports "not found" rather than looking like an escape.
  let real;
  try { real = fs.realpathSync(abs); } catch (_) { real = abs; }
  const withinRoot = real === root || real.startsWith(root + path.sep);
  return withinRoot ? real : null;
}

function readProjectFile(cwd, requested) {
  const file = resolveInProject(cwd, requested);
  if (!file) return { error: 'outside the session project' };
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return { error: 'that path is a directory' };
    if (!stat.isFile()) return { error: 'not a regular file' };
    fd = fs.openSync(file, 'r');
    const len = Math.min(stat.size, MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    if (looksBinary(buf, len)) {
      return { error: 'binary file', path: file, size: stat.size };
    }
    return {
      path: file,
      relPath: path.relative(fs.realpathSync(cwd), file),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      truncated: stat.size > MAX_BYTES,
      text: buf.toString('utf8'),
    };
  } catch (err) {
    return { error: err && err.code === 'ENOENT' ? 'not found' : String((err && err.message) || err) };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

module.exports = { resolveInProject, readProjectFile };
