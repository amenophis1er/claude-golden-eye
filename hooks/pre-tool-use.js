#!/usr/bin/env node
'use strict';

/**
 * PreToolUse: Observer logging (always) + PM-mode enforcement (V1/V2).
 *
 * Decision matrix:
 *  - payload has agent_id        -> it's a SUBAGENT's call: always allow
 *  - Agent/Task spawn + PM subModel pinned
 *                                -> rewrite tool_input.model via updatedInput
 *                                   (main session keeps its own model; every
 *                                   delegation runs on the pinned one)
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
    const isSpawn = tool === 'Agent' || tool === 'Task';
    if (!isSpawn && pm.PM_BLOCKED_TOOLS.has(tool) === false) return;
    if (payload.agent_id) return; // subagents are the workforce: always allow

    const st = await pm.getPmState(sid);
    if (!st || !st.pmMode) return; // observer-only session

    if (isSpawn) {
      // Model pin: /pm on --sub <model> forces every delegation onto that
      // model regardless of what the PM passed (or forgot to pass).
      const input = payload.tool_input || {};
      if (st.subModel && input.model !== st.subModel) {
        await pm.notifyDenial({
          __hook: 'PMModelPin',
          __ts: new Date().toISOString(),
          payload: {
            session_id: sid,
            tool_name: tool,
            model: st.subModel,
            was: input.model || null,
            description: input.description || null,
          },
        });
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: Object.assign({}, input, { model: st.subModel }),
            },
          }) + '\n'
        );
      }
      return;
    }

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