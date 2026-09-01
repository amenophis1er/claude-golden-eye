import { useMemo } from 'react';
import { Eye, Crown, X, Trash2 } from 'lucide-react';
import type { DashState, SessionInfo } from '../lib/types';
import { pruneSessions } from '../lib/useDashboard';
import { navigate, type Tab } from '../lib/router';
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
  // Empty husks (viewer forks, aborted startups: no prompt, no tool calls)
  // shouldn't linger in Idle — stale after 10 quiet minutes.
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

function Row({ s, now, selected, tab }: { s: SessionInfo; now: number; selected: boolean; tab: Tab }) {
  const group = groupOf(s, now);
  return (
    <div
      className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
        selected
          ? 'bg-amber-100/70 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100'
          : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
      }`}
      onClick={() => navigate(s.id, tab)}
    >
      <Dot group={group} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate font-medium">
          {baseName(s.cwd)}
          {s.pmMode && <Crown size={12} className="shrink-0 text-amber-500" />}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {shortId(s.id)} · {relTime(s.lastActivity, now)}
        </div>
      </div>
      {group === 'stale' && (
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

export default function Sidebar({ state, connected, now, selectedId, tab }: {
  state: DashState | null; connected: boolean; now: number; selectedId: string | null; tab: Tab;
}) {
  const groups = useMemo(() => {
    const g = { active: [] as SessionInfo[], idle: [] as SessionInfo[], stale: [] as SessionInfo[] };
    for (const s of state?.sessions ?? []) g[groupOf(s, now)].push(s);
    return g;
  }, [state, now]);

  const section = (title: string, items: SessionInfo[], extra?: React.ReactNode) =>
    items.length > 0 && (
      <div className="mt-4 first:mt-0">
        <div className="mb-1 flex items-center justify-between px-3">
          <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">{title}</span>
          {extra}
        </div>
        {items.map((s) => (
          <Row key={s.id} s={s} now={now} selected={s.id === selectedId} tab={tab} />
        ))}
      </div>
    );

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
        {section('Active', groups.active)}
        {section('Idle', groups.idle)}
        {section(
          'Stale',
          groups.stale,
          <button
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            onClick={() => pruneSessions({ staleBefore: new Date(now - STALE_MS).toISOString() })}
          >
            <Trash2 size={11} /> clear
          </button>
        )}
        {!state?.sessions.length && (
          <p className="px-3 py-6 text-center text-xs text-zinc-400">Waiting for sessions…</p>
        )}
      </div>
      <div className="border-t border-zinc-200 px-4 py-2 text-[11px] text-zinc-400 dark:border-zinc-800">
        {state ? `${state.sessions.length} session(s) · ${state.events.length} events cached` : 'connecting…'}
      </div>
    </aside>
  );
}
