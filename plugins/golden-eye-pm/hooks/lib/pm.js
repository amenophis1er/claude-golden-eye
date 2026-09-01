'use strict';

/**
 * PM-mode discipline (V1/M2). This module is the *discipline* side of
 * golden-eye (the Observer side stays read-only):
 *
 *  - getPmState()  — ask the singleton server whether this session is in PM
 *                    mode (fail-open: unreachable server => no enforcement)
 *  - setPm()       — flip ON/OFF (/pm commands) via the server bridge
 *  - notifyDenial()— mirror PMDeny events into the same event stream
 *  - charter()/reanchor() — the injected context texts
 *
 * Every call fails soft: discipline must never break a session.
 */

const { resolveServerUrl } = require('./util');

const PM_BLOCKED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

async function fetchJson(url, opts, timeoutMs = 400) {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

// The dashboard base URL (server.json / env aware), or null when no server
// exists — every consumer fails open on null without touching the network.
function bridgeBase() {
  const url = resolveServerUrl();
  return url ? url.replace(/\/ingest$/, '') : null;
}

async function getPmState(sessionId) {
  if (!sessionId) return null;
  const base = bridgeBase();
  if (!base) return null; // fail-open
  try {
    return (await fetchJson(`${base}/pm?sessionId=${encodeURIComponent(sessionId)}`)) || null;
  } catch (_) {
    return null; // fail-open
  }
}

async function setPm(body) {
  const base = bridgeBase();
  if (!base) return null;
  try {
    return (await fetchJson(`${base}/pm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })) || null;
  } catch (_) {
    return null;
  }
}

async function notifyDenial(event) {
  const base = bridgeBase();
  if (!base) return;
  try {
    await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(250),
    });
  } catch (_) {}
}

// helpers -------------------------------------------------------------------

function teamSummary(st) {
  if (!st || !Array.isArray(st.agents)) return '(unknown)';
  const running = st.agents.filter((a) => a.status === 'running' || a.status === 'starting').length;
  const done = st.agents.filter((a) => a.status === 'done').length;
  const mains = st.agents.filter((a) => a.mainAgent).length;
  return `main session + ${st.agents.length - mains} delegate(s) [${running} active, ${done} finished]`;
}

function charter(mission, st) {
  const lines = [
    '🟡 GOLDEN-EYE PM MODE — ENGAGED',
    'You are the PROJECT MANAGER for this session until "/pm off":',
    '• You decompose and DELEGATE. You do not implement.',
    '• Edit/Write/MultiEdit/NotebookEdit are BLOCKED in the main session; a golden-eye hook enforces this and will explain.',
    '• To create or change files, spawn a general-purpose subagent via the Agent (Task) tool: single mission, explicit file path(s), precise content.',
  ];
  if (st && st.subModel) {
    lines.push(
      `• Spawn EVERY subagent with model: "${st.subModel}" (set the model field on the Agent tool call); a golden-eye hook enforces this.`
    );
  }
  lines.push(
    '• Verify each subagent report against the mission before ending your turn.',
    '• End each turn with one status line: mission progress / delegated / returned / blocked.',
    'MISSION: ' + (mission || '(not stated — ask the user for the mission)'),
    'TEAM: ' + teamSummary(st)
  );
  return lines.join('\n');
}

function reanchor(st, deniedCount) {
  const denied = deniedCount ? ` · ${deniedCount} main-session write(s) already blocked (rule held)` : '';
  const sub = st.subModel ? ` (model: "${st.subModel}")` : '';
  return (
    '[golden-eye · PM re-anchor] MISSION: ' + (st.mission || '(not stated)') +
    ' | TEAM: ' + teamSummary(st) +
    denied +
    ` | Reminder: delegate implementation via Agent${sub}; do not Edit/Write yourself; end with a 1-line mission status.`
  );
}

module.exports = {
  PM_BLOCKED_TOOLS,
  getPmState,
  setPm,
  notifyDenial,
  charter,
  reanchor,
  teamSummary,
};