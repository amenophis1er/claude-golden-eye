import { Bot, User } from 'lucide-react';
import type { AgentInfo, SessionInfo } from '../lib/types';
import { fmtDur, relTime } from '../lib/format';

function StatusPill({ status }: { status: AgentInfo['status'] }) {
  const map: Record<string, string> = {
    running: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    starting: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    done: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${map[status] ?? map.done}`}>{status}</span>;
}

function AgentCard({ a, now }: { a: AgentInfo; now: number }) {
  const topTools = Object.entries(a.tools).sort((x, y) => y[1] - x[1]).slice(0, 6);
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-2.5">
        {a.mainAgent ? <User size={16} className="text-zinc-400" /> : <Bot size={16} className="text-violet-400" />}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {a.mainAgent ? 'Main session' : (a.description ?? a.type ?? 'delegate')}
        </span>
        <StatusPill status={a.status} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        {a.type && !a.mainAgent && <span>{a.type}</span>}
        {a.durationMs != null && <span>{fmtDur(a.durationMs)}</span>}
        {a.status !== 'done' && a.startedAt && <span>started {relTime(a.startedAt, now)}</span>}
        {a.lastTool && <span>last: {a.lastTool}</span>}
        <span>{a.toolEvents} tool event(s)</span>
      </div>
      {topTools.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {topTools.map(([tool, n]) => (
            <span key={tool} className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {tool} <span className="font-semibold tabular-nums">{n}</span>
            </span>
          ))}
        </div>
      )}
      {a.prompt && (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">delegation prompt</summary>
          <pre className="mt-1.5 max-h-56 overflow-y-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{a.prompt}</pre>
        </details>
      )}
      {a.lastMessage && (
        <details className="mt-1.5" open={!a.mainAgent && a.status === 'done'}>
          <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">final report</summary>
          <pre className="mt-1.5 max-h-56 overflow-y-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{a.lastMessage}</pre>
        </details>
      )}
    </div>
  );
}

export default function AgentsPanel({ session, now }: { session: SessionInfo; now: number }) {
  const main = session.agents.filter((a) => a.mainAgent);
  const delegates = session.agents.filter((a) => !a.mainAgent);
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {main.map((a, i) => <AgentCard key={a.id ?? i} a={a} now={now} />)}
        {delegates.map((a, i) => <AgentCard key={a.id ?? `d${i}`} a={a} now={now} />)}
      </div>
      {!delegates.length && (
        <p className="py-6 text-center text-xs text-zinc-400">No subagents spawned yet.</p>
      )}
    </div>
  );
}
