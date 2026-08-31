#!/usr/bin/env node
'use strict';

/**
 * PreToolUse: Observer logging (always) + PM-mode enforcement (V1).
 *
 * Decision matrix:
 *  - payload has agent_id        -> it's a SUBAGENT's call: always allow
 *  - tool not in PM_BLOCKED set  -> allow (observer logging only)
 *  - PM mode off / server down   -> allow (fail-open, per SPEC §8)
 *  - PM mode ON + main session + blocked tool
 *                                -> deny with a delegation-first reason, and
 *                                   mirror a PMDeny event to the dashboard.
 */

const { logStdinEvent, readStdinJson } = require('./lib/logger');
const pm = require('./lib/pm');

const DENY_REASON = (tool) =>
  `GOLDEN-EYE PM MODE: main-session "${tool}" is blocked. ` +
  `You are the project manager — delegate file changes by spawning a general-purpose ` +
  `subagent via the Agent (Task) tool, with the exact target path and content in its prompt.`;

function denyJson(tool) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON(tool),
    },
  });
}

async function main() {
  const payload = readStdinJson();
  // Observer path: log + mirror. Deliberately NOT awaited before the
  // decision — this hook sits on every tool call, so the POST runs
  // concurrently with the PM-state fetch and we settle both at the end.
  const logged = logStdinEvent('PreToolUse', payload);

  try {
    const sid = payload && payload.session_id;
    const tool = payload && payload.tool_name;
    if (!sid || !tool) return;
    if (pm.PM_BLOCKED_TOOLS.has(tool) === false) return;
    if (payload.agent_id) return; // subagents are the workforce: always allow

    const st = await pm.getPmState(sid);
    if (!st || !st.pmMode) return; // observer-only session

    await pm.notifyDenial({
      __hook: 'PMDeny',
      __ts: new Date().toISOString(),
      payload: {
        session_id: sid,
        tool_name: tool,
        tool_input: payload.tool_input || null,
        reason: DENY_REASON(tool),
      },
    });
    process.stdout.write(denyJson(tool) + '\n');
  } catch (_) {
    /* any discipline failure must degrade to allow — never break the session */
  } finally {
    await logged.catch(() => {}); // settle the log POST before process.exit
  }
}

main().then(() => process.exit(0), () => process.exit(0));