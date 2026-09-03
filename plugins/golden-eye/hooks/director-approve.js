#!/usr/bin/env node
'use strict';

/**
 * Scoped auto-approve for DIRECTOR sessions (director mode preview).
 *
 * A director's legitimate instruments are exactly: its golden-eye MCP tools
 * and edits to its MISSION.md tracking doc. Prompting for those defeats the
 * autonomy; putting the whole session in bypass mode would also hand the
 * director unrestricted Bash/Write. This hook threads the needle: it emits a
 * PreToolUse "allow" ONLY for those two categories, and ONLY when the server
 * confirms this session is an attached director. Everything else — Bash,
 * writing other files — still prompts. Anything but that path is a silent
 * pass-through (no decision), so non-director sessions are unaffected.
 *
 * Fail-soft: server down / unknown → no decision → normal prompting.
 */

const path = require('path');
const { readStdinJson, resolveServerUrl } = require('./lib/logger');

const GOLDEN_EYE_TOOL = /^mcp__.*golden[-_]?eye.*__/i;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Two classes:
//  'tool'    — a golden-eye MCP tool. Always auto-approved: these are the
//              plugin's own instruments, only exist in golden-eye sessions,
//              and the actuators (send_to_session/answer_permission) are
//              already gated server-side by composer auth. Approving them
//              unconditionally also breaks the director_attach chicken-and-egg
//              (the call that MAKES a session a director can't require it to
//              already be one) with no server round-trip.
//  'mission' — a write to MISSION.md. Approved only for an attached director
//              (server-confirmed), so a normal session can't get a free pass
//              on a file that happens to be named MISSION.md.
function classify(payload) {
  const tool = payload.tool_name || '';
  if (GOLDEN_EYE_TOOL.test(tool)) return 'tool';
  if (WRITE_TOOLS.has(tool)) {
    const fp = (payload.tool_input && payload.tool_input.file_path) || '';
    if (path.basename(String(fp)) === 'MISSION.md') return 'mission';
  }
  return null;
}

async function isDirectorSession(sessionId) {
  const ingest = resolveServerUrl();
  if (!ingest || !sessionId) return false;
  const base = ingest.replace(/\/ingest$/, '');
  try {
    const r = await fetch(`${base}/api/director/status?sessionId=${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(250),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.isDirector);
  } catch (_) {
    return false;
  }
}

async function main() {
  const payload = readStdinJson();
  try {
    // Never auto-approve a subagent's call (agent_id present) — this is the
    // director's own main-session autonomy, not its workers'.
    if (!payload || payload.agent_id) return;
    const kind = classify(payload);
    if (!kind) return;
    // A MISSION.md write costs one server round-trip to confirm director
    // status; golden-eye tools are approved outright (see classify).
    if (kind === 'mission' && !(await isDirectorSession(payload.session_id))) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'golden-eye director: auto-approved director instrument',
        },
      }) + '\n'
    );
  } catch (_) {
    /* any failure → no decision → the session prompts normally */
  }
}

main().then(() => process.exit(0), () => process.exit(0));
