'use strict';

/**
 * Transcript tail (the passive data path): tolerant reader for Claude Code
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
      if (meta.contextTokens > meta.maxContext) meta.maxContext = meta.contextTokens;
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
  } else if (j.type === 'user' && msg) {
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];
    for (const c of blocks) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_result') {
        const text = flattenContent(c.content).trim();
        if (text) entries.push({ ts, kind: 'result', text: SNIP(text, 600), isError: !!c.is_error });
      } else if (c.type === 'text' && typeof c.text === 'string' && !j.isMeta) {
        const text = c.text.trim();
        // Real prompts only: skip command expansions, caveat banners and
        // hook/system-injected context the harness stores as user turns.
        if (text && !/^<(command-name|local-command-stdout|system-reminder)|^Caveat: The messages below/.test(text)) {
          entries.push({ ts, kind: 'user', text: SNIP(text, 2000) });
        }
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
  return { model: null, branch: null, version: null, contextTokens: null, maxContext: 0, usage: { in: 0, cacheRead: 0, out: 0 } };
}

// Claude Code sessions run a 200k or 1M window; no transcript field states
// which, but a context high-water mark beyond ~190k proves the 1M tier.
function inferWindow(maxContext) {
  return maxContext > 190_000 ? 1_000_000 : 200_000;
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
        contextWindow: inferWindow(meta.maxContext),
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

// ---------- resume backfill ----------
// A resumed (or mid-stream-attached) session has history the hooks never saw.
// The transcript holds it all: everything strictly OLDER than the first
// observed hook event is replayable — newer entries would duplicate live hook
// rows, so the boundary is what makes this safe. Cached like sessionStats.
const REPLAY_MAX_ENTRIES = 150;
const replayCache = new Map(); // path -> { at, key, beforeTs, value }

function sessionReplay(file, beforeTs) {
  if (!file) return null;
  const hit = replayCache.get(file);
  if (hit && hit.beforeTs === beforeTs && Date.now() - hit.at < STATS_TTL_MS) return hit.value;
  let value = null;
  try {
    const stat = fs.statSync(file);
    const key = stat.size + ':' + stat.mtimeMs;
    if (hit && hit.key === key && hit.beforeTs === beforeTs) {
      value = hit.value;
    } else {
      const t = tailTranscript(file);
      if (t.exists) {
        value = t.entries
          .filter(
            (en) =>
              (en.kind === 'user' || en.kind === 'text' || en.kind === 'tool') &&
              en.ts &&
              (!beforeTs || en.ts < beforeTs)
          )
          .slice(-REPLAY_MAX_ENTRIES);
        if (!value.length) value = null;
      }
    }
    replayCache.set(file, { at: Date.now(), key, beforeTs, value });
  } catch (_) {
    replayCache.set(file, { at: Date.now(), key: null, beforeTs, value: null });
  }
  return value;
}

// ---------- head peek (history listings) ----------
// Cheap identity read for a transcript: its cwd and opening prompt, from a
// bounded read of the file head. Powers the history browser, where hundreds
// of files may be listed — never a full parse. Cached by size+mtime.
const HEAD_PEEK_BYTES = 64 * 1024;
const headCache = new Map(); // path -> { key, value }

function headPeek(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    const key = stat.size + ':' + stat.mtimeMs;
    const hit = headCache.get(file);
    if (hit && hit.key === key) return hit.value;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, HEAD_PEEK_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const value = { cwd: null, firstPrompt: null, firstTs: null };
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      if (!value.cwd && typeof j.cwd === 'string' && j.cwd) value.cwd = j.cwd;
      if (!value.firstTs && j.timestamp) value.firstTs = j.timestamp;
      if (!value.firstPrompt && j.type === 'user' && j.message && !j.isMeta) {
        const text = flattenContent(j.message.content).trim();
        // Same noise filter as parseLine: skip command expansions and
        // hook/system-injected context stored as user turns.
        if (text && !/^<(command-name|local-command-stdout|system-reminder)|^Caveat: The messages below/.test(text)) {
          value.firstPrompt = SNIP(text.split('\n')[0], 200);
        }
      }
      if (value.cwd && value.firstPrompt && value.firstTs) break;
    }
    headCache.set(file, { key, value });
    return value;
  } catch (_) {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

// ---------- artifact backfill (whole-file scan) ----------
// Artifacts published before golden-eye watched a session live are only
// recoverable from its transcript, where the Artifact tool's result reads
// "Published <path> at <url>". Publishes can sit anywhere in the file, so
// this is the one reader that scans it all.
//
// Accuracy matters more than it looks: that sentence also appears in ordinary
// text — a Bash result quoting another transcript, a pasted log, an assistant
// message about publishing. So a match only counts when it sits in the
// tool_result of a tool_use whose name is "Artifact", which means correlating
// tool_use_id across lines rather than grepping the file. Kept cheap by
// JSON-parsing only lines that mention the tool or an artifact URL, and
// cached by size+mtime (transcripts are append-only, so an unchanged file's
// cached scan is exact).
const ARTIFACT_URL_RE = /Published ([^\s"]+) at (https:\/\/claude\.ai\/code\/artifact\/([A-Za-z0-9_-]+))/;
const SCAN_CHUNK = 1 << 20; // 1 MiB
const artifactCache = new Map(); // path -> { key, value }

function artifactsFromTranscript(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    const key = stat.size + ':' + stat.mtimeMs;
    const hit = artifactCache.get(file);
    if (hit && hit.key === key) return hit.value;
    fd = fs.openSync(file, 'r');
    const byId = new Map();
    const pending = new Map(); // tool_use_id -> { favicon, description, path } from the Artifact call
    const buf = Buffer.alloc(SCAN_CHUNK);
    let carry = '';
    let pos = 0;

    const handleLine = (line) => {
      // Cheap pre-filter: only these lines can matter, so the vast majority
      // of a big transcript never reaches JSON.parse.
      if (!line.includes('"Artifact"') && !line.includes('claude.ai/code/artifact')) return;
      let j;
      try { j = JSON.parse(line); } catch (_) { return; }
      const msg = j.message;
      const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
      for (const c of blocks) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use' && c.name === 'Artifact' && c.id) {
          const inp = c.input || {};
          pending.set(c.id, {
            favicon: inp.favicon || null,
            description: inp.description || null,
            path: inp.file_path || null,
          });
        } else if (c.type === 'tool_result' && c.tool_use_id && pending.has(c.tool_use_id)) {
          const meta = pending.get(c.tool_use_id);
          const m = ARTIFACT_URL_RE.exec(flattenContent(c.content));
          if (!m) continue; // a non-publish Artifact action (db write, listing…)
          const prev = byId.get(m[3]);
          byId.set(m[3], {
            id: m[3],
            url: m[2],
            title: null, // only the live hook response carries it
            favicon: meta.favicon || (prev && prev.favicon) || null,
            description: meta.description || (prev && prev.description) || null,
            path: m[1] || meta.path || null,
            publishes: (prev ? prev.publishes : 0) + 1,
            firstAt: (prev && prev.firstAt) || j.timestamp || null,
            lastAt: j.timestamp || (prev && prev.lastAt) || null,
          });
        }
      }
    };

    while (pos < stat.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(SCAN_CHUNK, stat.size - pos), pos);
      if (n <= 0) break;
      const text = carry + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      carry = lines.pop() ?? ''; // last piece may be a partial line
      for (const line of lines) if (line) handleLine(line);
      pos += n;
    }
    if (carry) handleLine(carry);

    const value = [...byId.values()];
    artifactCache.set(file, { key, value });
    return value;
  } catch (_) {
    return [];
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

module.exports = { tailTranscript, sessionStats, agentMeta, sessionReplay, headPeek, artifactsFromTranscript };
