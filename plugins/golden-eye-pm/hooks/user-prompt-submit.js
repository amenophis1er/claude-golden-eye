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
        const off = await pm.setPm({ sessionId: sid, action: 'off' });
        return inject(
          off
            ? '🟡 golden-eye: PM mode OFF. You are back to normal execution.'
            : '🟡 golden-eye: PM mode OFF (observer server unreachable — if it held engaged state, retry "/pm off" once it is back).'
        );
      }
      const { mission, subModel } = parsed;
      const st = await pm.setPm({ sessionId: sid, action: 'on', mission, subModel });
      const state = st && st.pmMode ? st : { pmMode: true, mission, subModel, agents: [], denies: 0 };
      if (!state.subModel && subModel) state.subModel = subModel;
      let text = pm.charter(state.mission || mission, state);
      if (!st || !st.pmMode) {
        // Server unreachable: the charter still instructs, but the PreToolUse
        // hook has no state to enforce with — don't claim protection we lack.
        text += '\n⚠ observer server unreachable — hook enforcement is INACTIVE; the rules above are advisory until it returns.';
      }
      return inject(text);
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
