import { useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, User } from 'lucide-react';
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
  const topTools = Object.entries(a.tools).sort((x, y) => y[1] - x[1]);
  const elapsed = running && a.startedAt ? fmtDur(now - Date.parse(a.startedAt)) : null;
  const meta: [string, string][] = [];
  if (!a.mainAgent && a.type) meta.push(['type', a.type]);
  if (!a.mainAgent && a.id) meta.push(['id', shortId(a.id)]);
  if (a.model) meta.push(['requested model', a.model]);
  if (a.startedAt) meta.push(['started', relTime(a.startedAt, now)]);
  if (a.durationMs != null) meta.push(['duration', fmtDur(a.durationMs)]);
  if (a.lastTool) meta.push(['last tool', a.lastTool]);
  meta.push(['tool events', String(a.toolEvents)]);

  return (
    <div className="flex h-full min-h-0 gap-5">
      {/* left: properties */}
      <div className="w-80 shrink-0 overflow-y-auto pr-1">
        <div className="flex items-center gap-2.5">
          {a.mainAgent ? <User size={16} className="text-zinc-400" /> : <Bot size={16} className="text-violet-400" />}
          <span className="min-w-0 flex-1 text-sm font-semibold">
            {a.mainAgent ? 'Main session' : (a.description ?? a.type ?? 'delegate')}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <StatusPill status={a.status} />
          {elapsed && <span className="text-xs text-zinc-400 tabular-nums">⏱ {elapsed}</span>}
        </div>
        <dl className="mt-3 space-y-1">
          {meta.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 text-xs">
              <dt className="text-zinc-400">{k}</dt>
              <dd className={`text-right ${k.includes('model') ? 'rounded bg-violet-100 px-1.5 font-mono text-violet-700 dark:bg-violet-400/10 dark:text-violet-300' : 'text-zinc-600 dark:text-zinc-300'}`}>{v}</dd>
            </div>
          ))}
        </dl>
        {topTools.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">tools</div>
            <div className="flex flex-wrap gap-1.5">
              {topTools.map(([tool, n]) => (
                <span key={tool} className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {tool} <span className="font-semibold tabular-nums">{n}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {a.prompt && (
          <details className="mt-3" open={!a.mainAgent}>
            <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">delegation prompt</summary>
            <pre className="mt-1.5 max-h-72 overflow-y-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{a.prompt}</pre>
          </details>
        )}
        {a.lastMessage && (
          <details className="mt-2" open={!a.mainAgent && a.status === 'done'}>
            <summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">final report</summary>
            <pre className="mt-1.5 max-h-72 overflow-y-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{a.lastMessage}</pre>
          </details>
        )}
      </div>
      {/* right: transcript */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-zinc-200 pl-5 dark:border-zinc-800">
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
  const isLive = (a: AgentInfo) => a.status === 'running' || a.status === 'starting';
  const sortTs = (a: AgentInfo) => Date.parse((isLive(a) ? a.startedAt : a.endedAt || a.startedAt) || '') || 0;
  const delegates = session.agents
    .filter((a) => !a.mainAgent)
    .sort((x, y) => Number(isLive(y)) - Number(isLive(x)) || sortTs(y) - sortTs(x));
  const liveDelegates = delegates.filter(isLive);
  // Finished delegates collapse into one dropdown so the bar only ever
  // holds Main + live agents.
  const doneDelegates = delegates.filter((a) => !isLive(a));
  const ordered = main ? [main, ...delegates] : delegates;
  const [menuOpen, setMenuOpen] = useState(false);

  const selected =
    (sub && sub !== 'main' && ordered.find((a) => a.id === sub)) ||
    (sub === 'main' || !sub ? main : null) ||
    main ||
    ordered[0] ||
    null;
  const selectedIsDone = !!selected && !selected.mainAgent && !isLive(selected);

  const tabCls = (active: boolean) =>
    `flex shrink-0 items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
      active
        ? 'border-amber-500 text-zinc-900 dark:text-zinc-50'
        : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 pt-2 dark:border-zinc-800">
        {(main ? [main, ...liveDelegates] : liveDelegates).map((a, i) => (
          <button
            key={a.id ?? i}
            onClick={() => navigate(session.id, 'agents', a.mainAgent ? 'main' : a.id)}
            className={tabCls(selected === a)}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isLive(a) ? 'bg-emerald-500 pulse-dot' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
            {a.mainAgent ? <User size={12} /> : <Bot size={12} />}
            {tabLabel(a)}
          </button>
        ))}
        {doneDelegates.length > 0 && (
          <div className="relative shrink-0">
            <button onClick={() => setMenuOpen((o) => !o)} className={tabCls(selectedIsDone)}>
              <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
              {selectedIsDone && selected ? tabLabel(selected) : `Done (${doneDelegates.length})`}
              <ChevronDown size={12} className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute left-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  {doneDelegates.map((a, i) => (
                    <button
                      key={a.id ?? i}
                      onClick={() => { setMenuOpen(false); if (a.id) navigate(session.id, 'agents', a.id); }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                        selected === a ? 'font-semibold' : ''
                      }`}
                    >
                      <CheckCircle2 size={12} className="shrink-0 text-emerald-500" />
                      <span className="min-w-0 flex-1 truncate">{a.description ?? a.type ?? shortId(a.id)}</span>
                      {a.durationMs != null && <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{fmtDur(a.durationMs)}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
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
