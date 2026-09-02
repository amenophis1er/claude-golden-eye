import { useMemo } from 'react';
import { Eye, Crown, GitFork, History, X, Trash2 } from 'lucide-react';
import type { DashState, SessionInfo } from '../lib/types';
import { pruneSessions } from '../lib/useDashboard';
import { navigate, navigateHistory, type Tab } from '../lib/router';
import { baseName, relTime, shortId } from '../lib/format';
import ThemeToggle from './ThemeToggle';

const STALE_MS = 2 * 60 * 60 * 1000;
// A genuinely working session emits hook events constantly; with none for
// this long, a lingering state=working means the session died mid-turn
// (killed terminal — Stop/SessionEnd never fired) and must not pin Active.
const ACTIVE_FRESH_MS = 10 * 60 * 1000;

function groupOf(s: SessionInfo, now: number): 'active' | 'idle' | 'stale' {
  const age = now - Date.parse(s.lastActivity);
  if ((s.state === 'working' || s.state === 'active') && age < ACTIVE_FRESH_MS) return 'active';
  if (s.state === 'ended' || age > STALE_MS) return 'stale';
  // Forks are background agent runners: they never take direct user input,
  // so a quiet fork is a finished fork — stale after 10 minutes, even when
  // it did real work (forks often exit without a SessionEnd hook firing).
  // Same rule for empty husks (aborted startups: no prompt, no tool calls).
  if (s.startSource === 'fork' && age > 10 * 60 * 1000) return 'stale';
  if (!s.lastPrompt && s.stats.toolCalls === 0 && age > 10 * 60 * 1000) return 'stale';
  return 'idle';
}

function Dot({ group }: { group: string }) {
  const cls =
    group === 'active'
      ? 'bg-emerald-500 pulse-dot'
      : group === 'idle'
        ? 'bg-zinc-400'
        : 'bg-zinc-300 dark:bg-zinc-700';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

function Row({ s, group, now, selected, tab }: {
  s: SessionInfo; group: 'active' | 'idle' | 'stale'; now: number; selected: boolean; tab: Tab;
}) {
  return (
    <div
      className={`group flex cursor-pointer items-center gap-2.5 rounded-lg py-1.5 pr-2 pl-3 text-sm transition-colors ${
        selected
          ? 'bg-amber-100/70 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100'
          : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
      } ${group === 'stale' ? 'opacity-60' : ''}`}
      onClick={() => navigate(s.id, tab)}
    >
      <Dot group={group} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[13px]">
          <span className="min-w-0 truncate">
            {s.lastPrompt ?? <span className="font-mono text-xs text-zinc-400">{shortId(s.id)}</span>}
          </span>
          {s.pmMode && <Crown size={12} className="shrink-0 text-amber-500" />}
          {s.startSource === 'fork' && (
            <span title="forked session (background agent runner)" className="shrink-0">
              <GitFork size={11} className="text-violet-400" />
            </span>
          )}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {shortId(s.id)} · {relTime(s.lastActivity, now)}
        </div>
      </div>
      {/* Stale rows are removable; so are non-active forks — a fork never
          takes user input, so pruning one can't swallow a session someone
          is about to type back into. */}
      {(group === 'stale' || (s.startSource === 'fork' && group !== 'active')) && (
        <button
          title="Remove from dashboard"
          className="hidden rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 group-hover:block dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          onClick={(e) => { e.stopPropagation(); pruneSessions({ sessionIds: [s.id] }); }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

const GROUP_ORDER = { active: 0, idle: 1, stale: 2 } as const;

export default function Sidebar({ state, connected, now, selectedId, tab, historyActive }: {
  state: DashState | null; connected: boolean; now: number; selectedId: string | null; tab: Tab;
  historyActive: boolean;
}) {
  // One block per project (cwd), newest activity first; sessions within a
  // project ordered active → idle → stale so repeat sessions of the same
  // repo no longer read as duplicate "projects".
  const { projects, staleCount } = useMemo(() => {
    const byCwd = new Map<string, { s: SessionInfo; group: 'active' | 'idle' | 'stale' }[]>();
    let stale = 0;
    for (const s of state?.sessions ?? []) {
      const group = groupOf(s, now);
      if (group === 'stale') stale++;
      const key = s.cwd ?? '(unknown)';
      if (!byCwd.has(key)) byCwd.set(key, []);
      byCwd.get(key)!.push({ s, group });
    }
    const projects = [...byCwd.entries()].map(([cwd, rows]) => {
      rows.sort(
        (a, b) =>
          GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
          Date.parse(b.s.lastActivity) - Date.parse(a.s.lastActivity)
      );
      return { cwd, rows, last: Math.max(...rows.map((r) => Date.parse(r.s.lastActivity))) };
    });
    projects.sort((a, b) => b.last - a.last);
    return { projects, staleCount: stale };
  }, [state, now]);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-2.5 border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800">
        <Eye size={20} className="text-amber-500" />
        <span className="flex-1 font-semibold tracking-tight">golden-eye</span>
        <span
          className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500 pulse-dot'}`}
          title={connected ? 'live' : 'reconnecting…'}
        />
        <ThemeToggle />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {staleCount > 0 && (
          <div className="mb-1 flex justify-end px-1">
            <button
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              onClick={() => pruneSessions({ staleBefore: new Date(now - STALE_MS).toISOString() })}
            >
              <Trash2 size={11} /> clear stale ({staleCount})
            </button>
          </div>
        )}
        {projects.map(({ cwd, rows }) => (
          <div key={cwd} className="mt-3 first:mt-0">
            <div
              className="mb-0.5 flex items-center justify-between px-3"
              title={cwd}
            >
              <span className="truncate text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                {baseName(cwd)}
              </span>
              <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{rows.length}</span>
            </div>
            {rows.map(({ s, group }) => (
              <Row key={s.id} s={s} group={group} now={now} selected={!historyActive && s.id === selectedId} tab={tab} />
            ))}
          </div>
        ))}
        {!state?.sessions.length && (
          <p className="px-3 py-6 text-center text-xs text-zinc-400">Waiting for sessions…</p>
        )}
      </div>
      {state?.historyEnabled && (
        <button
          onClick={() => navigateHistory()}
          className={`flex items-center gap-2 border-t border-zinc-200 px-4 py-2.5 text-sm transition-colors dark:border-zinc-800 ${
            historyActive
              ? 'bg-amber-100/70 font-medium text-amber-950 dark:bg-amber-400/10 dark:text-amber-100'
              : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900'
          }`}
        >
          <History size={14} /> History
        </button>
      )}
      <div className="border-t border-zinc-200 px-4 py-2 text-[11px] text-zinc-400 dark:border-zinc-800">
        {state ? `${state.sessions.length} session(s) · ${state.events.length} events cached` : 'connecting…'}
      </div>
    </aside>
  );
}
