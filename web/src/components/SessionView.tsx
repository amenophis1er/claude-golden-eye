import { Activity, Bot, Crown, Radio, ScrollText, Target } from 'lucide-react';
import type { HookEvent, SessionInfo } from '../lib/types';
import { navigate, type Tab } from '../lib/router';
import { baseName, relTime, shortId } from '../lib/format';
import LiveFeed from './LiveFeed';
import AgentsPanel from './AgentsPanel';
import Timeline from './Timeline';

const TABS: { id: Tab; label: string; icon: any }[] = [
  { id: 'feed', label: 'Live', icon: Radio },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'timeline', label: 'Timeline', icon: ScrollText },
];

function StatChip({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
        alert && value > 0
          ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300'
          : 'border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400'
      }`}
    >
      <span className="font-semibold tabular-nums">{value}</span> {label}
    </span>
  );
}

export default function SessionView({ session: s, events, tab, sub, now }: {
  session: SessionInfo; events: HookEvent[]; tab: Tab; sub: string | null; now: number;
}) {
  const sessionEvents = events.filter((e) => e.payload?.session_id === s.id);
  const delegates = s.agents.filter((a) => !a.mainAgent);
  const delegatesRunning = delegates.some((a) => a.status === 'running' || a.status === 'starting');
  const fresh = now - Date.parse(s.lastActivity) < 10 * 60 * 1000;
  const working = (s.state === 'working' || s.state === 'active') && fresh;
  const stateLabel = working ? s.state : s.state === 'working' || s.state === 'active' ? 'stalled' : s.state;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <header className="border-b border-zinc-200 bg-white px-6 pt-4 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-lg font-semibold tracking-tight">{baseName(s.cwd)}</h1>
          <span className="text-xs text-zinc-400">{shortId(s.id)}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              working
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : s.state === 'ended'
                  ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
            }`}
          >
            {stateLabel}
          </span>
          {s.pmMode && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-400/10 dark:text-amber-300">
              <Crown size={11} /> PM engaged
            </span>
          )}
          {s.pmMode && s.subModel && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-400/10 dark:text-violet-300">
              <Bot size={11} /> subs → {s.subModel}
            </span>
          )}
          <span className="ml-auto text-xs text-zinc-400">active {relTime(s.lastActivity, now)}</span>
        </div>

        {s.mission && (
          <div className="mt-2 flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <Target size={14} className="mt-0.5 shrink-0 text-amber-500" />
            <div className="min-w-0">
              <span className="line-clamp-2">{s.mission}</span>
              {/* "#N" in the mission usually references a task — resolve it
                  against the session's task store so the header says what
                  the mission actually is. */}
              {[...new Set(s.mission.match(/#\d+/g) ?? [])]
                .map((r) => s.todos.find((t) => t.id === r.slice(1)))
                .filter((t): t is NonNullable<typeof t> => !!t)
                .map((t) => (
                  <div key={t.id} className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
                    <span className="text-zinc-400 tabular-nums">#{t.id}</span>
                    <span className="min-w-0 truncate">{t.content}</span>
                    <span className={`shrink-0 rounded-full px-1.5 text-[10px] ${
                      t.status === 'completed'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : t.status === 'in_progress'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300'
                          : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}>{t.status}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {s.progress && (
          <div className="mt-2 flex items-center gap-3">
            <Activity size={13} className={s.progress.state === 'blocked' ? 'text-red-500' : 'text-emerald-500'} />
            <div className="h-1.5 w-56 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className={`h-full rounded-full transition-all ${s.progress.state === 'blocked' ? 'bg-red-500' : 'bg-emerald-500'}`}
                style={{ width: `${s.progress.pct ?? (s.progress.state === 'done' ? 100 : 5)}%` }}
              />
            </div>
            <span className="text-xs text-zinc-500">
              {s.progress.state}
              {s.progress.pct != null && ` · ${s.progress.pct}%`}
              {s.progress.note && ` · ${s.progress.note}`}
            </span>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <StatChip label="delegations" value={s.stats.spawns} />
          <StatChip label="tool calls" value={s.stats.toolCalls} />
          <StatChip label="writes blocked" value={s.stats.denies} alert />
        </div>

        <nav className="mt-3 flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => navigate(s.id, id)}
              className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === id
                  ? 'border-amber-500 text-zinc-900 dark:text-zinc-50'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <Icon size={14} /> {label}
              {id === 'agents' && delegates.length > 0 && (
                <span
                  className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                    delegatesRunning
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                      : 'bg-zinc-200 dark:bg-zinc-800'
                  }`}
                >
                  {delegates.length}
                </span>
              )}

            </button>
          ))}
        </nav>
      </header>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {(tab === 'feed' || tab === 'plan') && <LiveFeed session={s} events={sessionEvents} now={now} />}
        {tab === 'agents' && <AgentsPanel session={s} now={now} sub={sub} />}
        {tab === 'timeline' && <Timeline events={sessionEvents} />}
      </div>
    </div>
  );
}
