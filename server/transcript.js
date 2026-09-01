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

function parseLine(line, entries, meta) {
  let j;
  try {
    j = JSON.parse(line);
  } catch (_) {
    return;
  }
  const ts = j.timestamp || null;
  const msg = j.message;
  if (j.gitBranch) meta.branch = j.gitBranch;
  if (j.version) meta.version = j.version;
  if (j.type === 'assistant' && msg && Array.isArray(msg.content)) {
    // Ground truth for "which model is this agent actually running on".
    if (typeof msg.model === 'string' && msg.model) meta.model = msg.model;
    const u = msg.usage;
    if (u && typeof u === 'object') {
      meta.usage.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      meta.usage.cacheRead += u.cache_read_input_tokens || 0;
      meta.usage.out += u.output_tokens || 0;
      // Context size ≈ everything the last request carried in.
      meta.contextTokens =
        (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
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
    const meta = newMeta();
    for (const line of text.split('\n')) {
      if (line.trim()) parseLine(line, entries, meta);
    }
    return {
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      model: meta.model,
      branch: meta.branch,
      usage: meta.usage,
      usageApprox: start > 0, // sums cover only the tail of a large file
      contextTokens: meta.contextTokens,
      entries: entries.slice(-MAX_ENTRIES),
    };
  } catch (err) {
    return { exists: false, entries: [], error: err && err.code === 'ENOENT' ? 'not-found' : String((err && err.message) || err) };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

function newMeta() {
  return { model: null, branch: null, version: null, contextTokens: null, usage: { in: 0, cacheRead: 0, out: 0 } };
}

// ---------- session-level stats (header enrichment) ----------
// Parses only entry-free metadata from the tail; cached because /api/state
// is hit on every SSE-debounced refresh and main transcripts can be huge.
const STATS_TTL_MS = 5000;
const statsCache = new Map(); // path -> { at, key, value }

function sessionStats(file) {
  if (!file) return null;
  const hit = statsCache.get(file);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value;
  let value = null;
  let fd = null;
  try {
    const stat = fs.statSync(file);
    const key = stat.size + ':' + stat.mtimeMs;
    if (hit && hit.key === key) {
      value = hit.value;
    } else {
      fd = fs.openSync(file, 'r');
      const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      const meta = newMeta();
      const sink = []; // entries unused here
      for (const line of text.split('\n')) {
        if (line.trim()) parseLine(line, sink, meta);
      }
      value = {
        model: meta.model,
        branch: meta.branch,
        version: meta.version,
        contextTokens: meta.contextTokens,
        usage: meta.usage,
        usageApprox: start > 0,
      };
    }
    statsCache.set(file, { at: Date.now(), key, value });
  } catch (_) {
    statsCache.set(file, { at: Date.now(), key: null, value: null });
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
  return value;
}

// ---------- delegation-prompt backfill ----------
// When the spawn event was never observed (agent born before a resume),
// the agent's own transcript still opens with the delegation prompt.
const metaCache = new Map(); // transcript file -> { description, agentType, model } | null

function agentMeta(file) {
  if (!file) return null;
  if (metaCache.has(file)) return metaCache.get(file);
  let value = null;
  // Preferred: the sibling .meta.json Claude Code writes next to each
  // subagent transcript — { agentType, description, model, ... }.
  try {
    const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    value = { description: m.description || null, agentType: m.agentType || null, model: m.model || null };
  } catch (_) {}
  // Fallback: the transcript's first user message is the delegation prompt.
  if (!value) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(16384);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!line.trim()) continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (j.type === 'user' && j.message) {
          const text = flattenContent(j.message.content).trim();
          if (text) {
            value = { description: SNIP(text.split('\n')[0], 140), agentType: null, model: null };
            break;
          }
        }
      }
    } catch (_) {
      return null; // transcript missing — retry on a later request
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch (_) {}
    }
  }
  metaCache.set(file, value);
  return value;
}

module.exports = { tailTranscript, sessionStats, agentMeta };
