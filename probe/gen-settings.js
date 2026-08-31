#!/usr/bin/env node
'use strict';

/**
 * Generate a probe project's .claude/settings.json that wires every probe
 * hook script to its hook event. Keeps run-probe.sh readable.
 * Usage: node gen-settings.js <outSettingsPath> <hooksDir>
 */

const fs = require('fs');
const path = require('path');

const outPath = process.argv[2];
const hooksDir = process.argv[3];
if (!outPath || !hooksDir) {
  console.error('usage: node gen-settings.js <outSettingsPath> <hooksDir>');
  process.exit(1);
}

const EVENTS = [
  { event: 'SessionStart', matcher: '*', script: 'session-start.js' },
  { event: 'UserPromptSubmit', matcher: null, script: 'user-prompt-submit.js' },
  { event: 'PreToolUse', matcher: '*', script: 'pre-tool-use.js' },
  { event: 'PostToolUse', matcher: '*', script: 'post-tool-use.js' },
  { event: 'SubagentStop', matcher: null, script: 'subagent-stop.js' },
  { event: 'Stop', matcher: null, script: 'stop.js' },
];

const hooks = {};
for (const { event, matcher, script } of EVENTS) {
  const hookCmds = [{ type: 'command', command: `node "${hooksDir}/${script}"` }];
  if (event === 'SessionStart') {
    // Bootstrap the singleton dashboard server before first ingest.
    hookCmds.unshift({
      type: 'command',
      command: `node "${path.join(hooksDir, '..', 'server', 'boot.js')}"`,
    });
  }
  const entry = { hooks: hookCmds };
  if (matcher) entry.matcher = matcher;
  hooks[event] = [entry];
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ hooks }, null, 2) + '\n');
console.log(`hooks wired: ${EVENTS.map((e) => e.event).join(', ')}`);

// Install the plugin's commands (e.g. /pm) into the probe project so the
// slash command expands like it would from a real plugin install.
const CMD_SRC = path.join(hooksDir, '..', 'commands', 'pm.md');
if (fs.existsSync(CMD_SRC)) {
  const cmdDir = path.join(path.dirname(outPath), 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.copyFileSync(CMD_SRC, path.join(cmdDir, 'pm.md'));
  console.log('commands copied: pm.md');
}