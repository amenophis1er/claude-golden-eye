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
const { parsePmPrompt } = require('./lib/parse');
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

    // /pm handling: parsing (both the expanded-marker path and the raw
    // slash-text path, incl. plugin-namespaced forms) lives in lib/parse.js.
    const parsed = parsePmPrompt(prompt);
    if (parsed) {
      if (parsed.action === 'off') {
        await pm.setPm({ sessionId: sid, action: 'off' });
        return inject('🟡 golden-eye: PM mode OFF. You are back to normal execution.');
      }
      const { mission, subModel } = parsed;
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
