'use strict';

/**
 * Pure /pm prompt parsing — extracted so the two entry paths and every arg
 * form are unit-testable (both shipped regressions in this project lived
 * here: a case-sensitive `Arguments:` match that turned "/pm off" into a
 * re-engage, and the namespaced "/plugin:pm" form not matching at all).
 *
 * Returns:
 *   null                                        — not a /pm invocation
 *   { action: 'off' }                           — disengage
 *   { action: 'on', mission, subModel }         — engage (subModel may be null)
 */

// Path 1: expanded skill/command text carrying the marker; $ARGUMENTS appears
// as `... arguments: "<args>"` (matched case-insensitively).
// Path 2: raw slash text, optionally plugin-namespaced ("/golden-eye-pm:pm").
const RAW_PM_RE = /^\s*\/(?:[\w.-]+:)?pm\b/;

function extractArgs(prompt) {
  if (typeof prompt !== 'string' || !prompt) return null;
  if (prompt.indexOf('PM-MODE-COMMAND') !== -1) {
    // Bound to one line: `.` excludes newlines, so the greedy match ends at
    // the last quote of the args line itself — quotes later in the expanded
    // skill body (e.g. `"/pm off"`) can no longer bleed into the mission.
    const m = prompt.match(/arguments:\s*"(.*)"/i);
    return m ? m[1].trim() : '';
  }
  if (RAW_PM_RE.test(prompt)) {
    return prompt.replace(RAW_PM_RE, '').trim();
  }
  return null;
}

function parsePmPrompt(prompt) {
  const args = extractArgs(prompt);
  if (args === null) return null;
  if (/^off\b/i.test(args)) return { action: 'off' };

  // "on", "<mission>", "on — <mission>" all engage. Optional subagent model
  // pin: "--sub <model>" / "--sub-model=<model>" / "sub-model: <model>"
  // anywhere in the args.
  let subModel = null;
  const argsSansSub = args.replace(
    /(?:--sub(?:-model)?[\s=:]+|sub[-_]?model\s*[:=]\s*)([\w.-]+)\s*/i,
    (_, m) => { subModel = m.toLowerCase(); return ''; }
  );
  const mission = argsSansSub
    .replace(/^on\b/i, '')
    .replace(/^\s*[-–—:,.]?\s*/, '')
    .trim();
  return { action: 'on', mission, subModel };
}

module.exports = { parsePmPrompt };
