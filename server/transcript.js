'use strict';

/**
 * Transcript tail (SPEC's passive path): tolerant reader for Claude Code
 * JSONL transcripts — the session's own file, or a subagent's file under
 * <session-dir>/subagents/agent-<id>.jsonl. The format is unofficial, so
 * every line parse is best-effort and unknown shapes are skipped.
 */

const fs = require('fs');

const MAX_TAIL_BYTES = 512 * 1024;
const MAX_ENTRIES = 300;
const SNIP = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);

function flattenContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function toolInputBrief(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of ['command', 'description', 'file_path', 'skill', 'query', 'url', 'subject', 'prompt', 'pattern']) {
    if (typeof input[k] === 'string' && input[k]) out[k] = SNIP(input[k], 300);
  }
  return Object.keys(out).length ? out : null;
}

function parseLine(line, entries) {
  let j;
  try {
    j = JSON.parse(line);
  } catch (_) {
    return;
  }
  const ts = j.timestamp || null;
  const msg = j.message;
  if (j.type === 'assistant' && msg && Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) {
        entries.push({ ts, kind: 'thinking', text: SNIP(c.thinking, 2000) });
      } else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        entries.push({ ts, kind: 'text', text: SNIP(c.text, 4000) });
      } else if (c.type === 'tool_use') {
        entries.push({ ts, kind: 'tool', name: c.name || '?', input: toolInputBrief(c.input) });
      }
    }
  } else if (j.type === 'user' && msg && Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c && c.type === 'tool_result') {
        const text = flattenContent(c.content).trim();
        if (text) entries.push({ ts, kind: 'result', text: SNIP(text, 600), isError: !!c.is_error });
      }
    }
  }
}

/** Read + normalize the tail of a transcript file. */
function tailTranscript(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    fd = fs.openSync(file, 'r');
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
    const entries = [];
    for (const line of text.split('\n')) {
      if (line.trim()) parseLine(line, entries);
    }
    return { exists: true, size: stat.size, mtime: stat.mtime.toISOString(), entries: entries.slice(-MAX_ENTRIES) };
  } catch (err) {
    return { exists: false, entries: [], error: err && err.code === 'ENOENT' ? 'not-found' : String((err && err.message) || err) };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

module.exports = { tailTranscript };
