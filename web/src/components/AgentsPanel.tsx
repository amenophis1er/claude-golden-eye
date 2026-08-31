import { Bot, User } from 'lucide-react';
import type { AgentInfo, SessionInfo } from '../lib/types';
import { fmtDur, relTime, shortId } from '../lib/format';
import { navigate } from '../lib/router';
import AgentTranscript from './AgentTranscript';

function StatusPill({ status }: { status: AgentInfo['status'] }) {
  const map: Record<string, string> = {
    running: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    starting: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    done: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${map[status] ?? map.done}`}>{status}</span>;
}

function tabLabel(a: AgentInfo) {
  if (a.mainAgent) return 'Main session';
  const t = a.description ?? a.type ?? shortId(a.id);
  return t.length > 28 ? t.slice(0, 28) + '…' : t;
}

function AgentDetail({ a, now, sessionId }: { a: AgentInfo; now: number; sessionId: string }) {
  const running = a.status === 'running' || a.status === 'starting';
  const topTools = Object.entries(a.tools).sort((x, y) => y[1] - x[1]).slice(0, 8);
  const elapsed = running && a.startedAt ? fmtDur(now - Date.parse(a.startedAt)) : null;
  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col">
      <div className="flex items-center gap-2.5">
        {a.mainAgent ? <User size={16} className="text-zinc-400" /> : <Bot size={16} className="text-violet-400" />}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {a.mainAgent ? 'Main session' : (a.description ?? a.type ?? 'delegate')}
        </span>
        {elapsed && <span className="text-xs text-zinc-400 tabular-nums">⏱ {elapsed}</span>}
        <StatusPill status={a.status} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        {a.type && !a.mainAgent && <span>{a.type}</span>}
        {!a.mainAgent && a.id && <span className="font-mono">{shortId(a.id)}</span>}
        {a.model && (
          <span className="rounded bg-violet-100 px-1.5 font-mono text-[11px] text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">
            {a.model}
          </span>
        )}
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
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">delegation prompt</summary>
          <pre className="mt-1.5 max-h-56 overflow-y-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{a.prompt}</pre>
        </details>
      )}
      {a.lastMessage && (
        <details className="mt-2" open={!a.mainAgent && a.status === 'done'}>
          <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">final report</summary>
          <pre className="mt-1.5 max-h-56 overflow-y-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{a.lastMessage}</pre>
        </details>
      )}
      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <div className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-500">
          {running && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 pulse-dot" />}
          {running ? 'live transcript' : 'transcript'}
        </div>
        <AgentTranscript sessionId={sessionId} agentId={a.mainAgent ? null : a.id} running={running} fill />
      </div>
    </div>
  );
}

export default function AgentsPanel({ session, now, sub }: { session: SessionInfo; now: number; sub: string | null }) {
  const main = session.agents.find((a) => a.mainAgent);
  const delegates = session.agents.filter((a) => !a.mainAgent);
  const ordered = main ? [main, ...delegates] : delegates;

  const selected =
    (sub && sub !== 'main' && ordered.find((a) => a.id === sub)) ||
    (sub === 'main' || !sub ? main : null) ||
    main ||
    ordered[0] ||
    null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 pt-2 dark:border-zinc-800">
        {ordered.map((a, i) => {
          const running = a.status === 'running' || a.status === 'starting';
          const active = selected === a;
          return (
            <button
              key={a.id ?? i}
              onClick={() => navigate(session.id, 'agents', a.mainAgent ? 'main' : a.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                active
                  ? 'border-amber-500 text-zinc-900 dark:text-zinc-50'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-emerald-500 pulse-dot' : a.status === 'done' ? 'bg-zinc-300 dark:bg-zinc-600' : 'bg-sky-400'}`} />
              {a.mainAgent ? <User size={12} /> : <Bot size={12} />}
              {tabLabel(a)}
            </button>
          );
        })}
        {!delegates.length && (
          <span className="self-center px-2 pb-1 text-[11px] text-zinc-400">no subagents spawned yet</span>
        )}
      </div>
      <div className="min-h-0 flex-1 p-4">
        {selected ? <AgentDetail a={selected} now={now} sessionId={session.id} /> : (
          <p className="py-8 text-center text-xs text-zinc-400">No agents yet.</p>
        )}
      </div>
    </div>
  );
}
