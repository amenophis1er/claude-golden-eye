import type { AgentInfo } from './types';

/**
 * When is a delegate actually working?
 *
 * The status field alone lies in two ways: a spawn slot that never bound to an
 * agent sits at "starting" forever, and an agent that died without a
 * SubagentStop stays "running". Both then get counted as live work — the
 * sidebar claiming "1 agent running" while the terminal sits idle.
 *
 * One definition, used by every view (sidebar status, agent tabs, now strip),
 * so they can never disagree about what is live.
 */
export const AGENT_STALL_MS = 10 * 60 * 1000;

/** Claims to be working, but has shown no activity for AGENT_STALL_MS. */
export function isStalled(a: AgentInfo, now: number) {
  if (a.status === 'done') return false;
  const since = Date.parse(a.lastToolAt || a.startedAt || '') || 0;
  return !!since && now - since > AGENT_STALL_MS;
}

/** A spawn placeholder no agent ever claimed — the delegation never started. */
export function neverStarted(a: AgentInfo) {
  return !a.mainAgent && !a.boundId && a.toolEvents === 0;
}

/** Genuinely live right now: running or starting, and not stalled. */
export function isLiveAgent(a: AgentInfo, now: number) {
  return (a.status === 'running' || a.status === 'starting') && !isStalled(a, now);
}

/** Live delegates only (excludes the main agent). */
export function liveDelegateCount(agents: AgentInfo[], now: number) {
  return agents.filter((a) => !a.mainAgent && isLiveAgent(a, now)).length;
}
