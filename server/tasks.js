'use strict';

/**
 * Passive reader for Claude Code's on-disk task store:
 *   <config-root>/tasks/<session-id>/<taskId>.json
 * The config root is derived from the session's transcript path
 * (<root>/projects/<proj>/<sid>.jsonl), so it follows whichever
 * CLAUDE_CONFIG_DIR the session runs under. Small TTL cache: /api/state is
 * hit on every SSE-debounced refresh.
 */

const fs = require('fs');
const path = require('path');

const TTL_MS = 2000;
const cache = new Map(); // sessionId -> { at, tasks }

function tasksForSession(sessionId, transcriptPath) {
  if (!sessionId || !transcriptPath) return null;
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tasks;

  let tasks = null;
  try {
    const root = path.dirname(path.dirname(path.dirname(transcriptPath)));
    const dir = path.join(root, 'tasks', sessionId);
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => parseInt(a) - parseInt(b));
    tasks = [];
    for (const f of files) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        tasks.push({
          id: String(t.id ?? parseInt(f)),
          content: t.subject || '(untitled task)',
          status: t.status || 'pending',
          description: t.description || null,
          activeForm: t.activeForm || null,
          blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
        });
      } catch (_) {}
    }
    if (!tasks.length) tasks = null;
  } catch (_) {
    tasks = null; // no store for this session — caller falls back to events
  }
  cache.set(sessionId, { at: Date.now(), tasks });
  return tasks;
}

module.exports = { tasksForSession };
