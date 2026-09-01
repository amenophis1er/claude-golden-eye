#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit (PM plugin):
 *   /pm <mission>   -> engage PM mode, inject the PM charter
 *   /pm off         -> disengage
 *   (any prompt while engaged) -> re-anchor: mission + team status + rules
 *
 * Injection is context-only; the prompt itself still reaches the model.
 * Observer logging lives in the golden-eye plugin — this hook only manages
 * PM state. All failures are soft: no server => charter still injects from
 * local parsing, but engaged-state persistence and team stats are skipped.
 */

const { readStdinJson } = require('./lib/util');
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

  try {
    const sid = payload && payload.session_id;
    const prompt = (payload && payload.prompt) || '';
    if (!sid) return;

    // /pm handling. Two entry paths:
    //  1. expanded skill/command text carrying the PM-MODE-COMMAND marker —
    //     parse $ARGUMENTS from `Arguments: "..."` (case-insensitive: a
    //     failed parse here used to turn "/pm off" into a re-engage).
    //  2. raw "/pm ..." text: plugin commands reach this hook unexpanded, so
    //     this is the path that fires in practice. Matches both "/pm ..."
    //     and the namespaced "/golden-eye-pm:pm ...".
    let pmArgs = null;
    const marker = prompt.indexOf('PM-MODE-COMMAND');
    if (marker !== -1) {
      const m = prompt.match(/arguments:\s*"([\s\S]*)"/i);
      pmArgs = m ? m[1].trim() : '';
    } else if (/^\s*\/(?:[\w.-]+:)?pm\b/.test(prompt)) {
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
    /* no injection on failure — the session proceeds undisciplined */
  }
}

main().then(() => process.exit(0), () => process.exit(0));
