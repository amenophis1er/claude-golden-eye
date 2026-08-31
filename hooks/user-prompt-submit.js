#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit: Observer logging (always), plus
 *   /pm <mission>   -> engage PM mode, inject the PM charter
 *   /pm off         -> disengage
 *   (any prompt while engaged) -> re-anchor: mission + team status + rules
 *
 * Injection is context-only; the prompt itself still reaches the model.
 * All failures are soft: no server => no injection, logging still works.
 */

const { logStdinEvent, readStdinJson } = require('./lib/logger');
const pm = require('./lib/pm');

function inject(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: text,
      },
    }) + '\n'
  );
}

async function main() {
  const payload = readStdinJson();
  await logStdinEvent('UserPromptSubmit', payload);

  try {
    const sid = payload && payload.session_id;
    const prompt = (payload && payload.prompt) || '';
    if (!sid) return;

    // /pm handling. Two entry paths:
    //  1. real slash command: Claude Code expands commands/pm.md — we detect
    //     the marker and parse $ARGUMENTS from `Arguments: "..."`.
    //  2. raw "/pm ..." text if it ever reaches the hook unexpanded.
    let pmArgs = null;
    const marker = prompt.indexOf('PM-MODE-COMMAND');
    if (marker !== -1) {
      // pm.md emits `User arguments: "..."` — match case-insensitively so the
      // expanded-command path can never mis-parse (a failed parse here used to
      // turn "/pm off" into an accidental re-engage).
      const m = prompt.match(/arguments:\s*"([\s\S]*)"/i);
      pmArgs = m ? m[1].trim() : '';
    } else if (/^\s*\/(?:[\w.-]+:)?pm\b/.test(prompt)) {
      // Raw command text. Matches both "/pm ..." and the plugin-namespaced
      // "/claude-golden-eye:pm ..." — plugin commands reach this hook as raw
      // text (unexpanded), so this path is the one that fires in practice.
      pmArgs = prompt.replace(/^\s*\/(?:[\w.-]+:)?pm\b/, '').trim();
    }

    if (pmArgs !== null) {
      if (/^off\b/i.test(pmArgs)) {
        await pm.setPm({ sessionId: sid, action: 'off' });
        return inject('🟡 golden-eye: PM mode OFF. You are back to normal execution.');
      }
      // "on", "<mission>", "on — <mission>" all engage.
      // Optional subagent model pin: "--sub <model>" / "sub-model: <model>"
      // anywhere in the args (e.g. "/pm on --sub opus MISSION: ship it").
      let subModel = null;
      const argsSansSub = pmArgs.replace(
        /(?:--sub(?:-model)?[\s=:]+|sub[-_]?model\s*[:=]\s*)([\w.-]+)\s*/i,
        (_, m) => { subModel = m.toLowerCase(); return ''; }
      );
      const mission = argsSansSub
        .replace(/^on\b/, '')
        .replace(/^[-–—:,.]?\s*/, '')
        .trim();
      const st = await pm.setPm({ sessionId: sid, action: 'on', mission, subModel });
      const state = st && st.pmMode ? st : { pmMode: true, mission, subModel, agents: [], denies: 0 };
      if (!state.subModel && subModel) state.subModel = subModel;
      return inject(pm.charter(state.mission || mission, state));
    }

    // Re-anchor on every ordinary prompt while PM mode is engaged.
    const st = await pm.getPmState(sid);
    if (st && st.pmMode) {
      return inject(pm.reanchor(st, st.denies));
    }
  } catch (_) {
    /* no injection on failure — observer behavior stays intact */
  }
}

main().then(() => process.exit(0), () => process.exit(0));