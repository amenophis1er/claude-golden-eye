import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, Bot, CheckCircle2, Flag, GitFork, MessageSquare,
  Play, Power, ShieldX, TerminalSquare, TrendingUp, User,
} from 'lucide-react';
import type { HookEvent, SessionInfo } from '../lib/types';
import { clock, fmtDur, toolSummary } from '../lib/format';

interface Entry {
  icon: any;
  tone: string;       // tailwind text color for the icon
  label: string;
  summary: string;
  raw: any;
  ts: string;
  emphasis?: boolean; // red rows (denials, blocked)
}

function toEntry(e: HookEvent): Entry | null {
  const p = e.payload ?? {};
  const who = p.agent_id ? `agent ${String(p.agent_id).slice(0, 6)}` : 'main';
  switch (e.__hook) {
    case 'SessionStart':
      return { icon: Play, tone: 'text-zinc-400', label: 'session start', summary: p.source ?? '', raw: p, ts: e.__ts };
    case 'UserPromptSubmit':
      return { icon: MessageSquare, tone: 'text-sky-500', label: 'prompt', summary: String(p.prompt ?? '').slice(0, 200), raw: p, ts: e.__ts };
    case 'PreToolUse': {
      const spawn = p.tool_name === 'Agent' || p.tool_name === 'Task';
      if (spawn)
        return { icon: GitFork, tone: 'text-violet-500', label: 'delegate', summary: p.tool_input?.description ?? toolSummary(p.tool_input), raw: p, ts: e.__ts };
      return { icon: TerminalSquare, tone: 'text-zinc-400', label: `${who} · ${p.tool_name}`, summary: toolSummary(p.tool_input), raw: p, ts: e.__ts };
    }
    case 'PMDeny':
      return { icon: ShieldX, tone: 'text-red-500', label: `write blocked · ${p.tool_name}`, summary: toolSummary(p.tool_input), raw: p, ts: e.__ts, emphasis: true };
    case 'SubagentStop':
      return { icon: CheckCircle2, tone: 'text-emerald-500', label: `agent ${String(p.agent_id ?? '').slice(0, 6)} finished`, summary: String(p.last_assistant_message ?? '').slice(0, 200), raw: p, ts: e.__ts };
    case 'MCPProgress':
      return {
        icon: TrendingUp,
        tone: p.state === 'blocked' ? 'text-red-500' : 'text-emerald-500',
        label: `progress · ${p.state}${p.progress_pct != null ? ` ${p.progress_pct}%` : ''}`,
        summary: p.note ?? '', raw: p, ts: e.__ts, emphasis: p.state === 'blocked',
      };
    case 'PMSync':
      return { icon: Flag, tone: 'text-amber-500', label: `PM mode ${p.action}`, summary: p.mission ?? '', raw: p, ts: e.__ts };
    case 'Stop':
      return { icon: Flag, tone: 'text-indigo-400', label: 'turn ended', summary: String(p.last_assistant_message ?? '').slice(0, 200), raw: p, ts: e.__ts };
    case 'SessionEnd':
      return { icon: Power, tone: 'text-zinc-400', label: 'session ended', summary: p.reason ?? '', raw: p, ts: e.__ts };
    default:
      return null;
  }
}

function NowStrip({ session, now }: { session: SessionInfo; now: number }) {
  const running = session.agents.filter((a) => a.status === 'running' || a.status === 'starting');
  if (!running.length) return null;
  return (
    <div className="flex flex-wrap gap-2 border-b border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
      {running.map((a, i) => (
        <div key={a.id ?? i} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 pulse-dot" />
          {a.mainAgent ? <User size={12} className="text-zinc-400" /> : <Bot size={12} className="text-violet-400" />}
          <span className="font-medium">{a.mainAgent ? 'main' : (a.description ?? a.type ?? 'agent').slice(0, 40)}</span>
          {a.lastTool && <span className="text-zinc-400">→ {a.lastTool}</span>}
          {a.lastToolAt && <span className="text-zinc-400 tabular-nums">{fmtDur(now - Date.parse(a.lastToolAt))}</span>}
        </div>
      ))}
    </div>
  );
}

function OutputPanel({ session }: { session: SessionInfo }) {
  return (
    <div className="flex w-[26rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-zinc-200 p-4 dark:border-zinc-800">
      {session.lastPrompt && (
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Last prompt</h3>
          <pre className="rounded-lg bg-zinc-100 p-3 text-xs leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{session.lastPrompt}</pre>
        </section>
      )}
      <section className="flex min-h-0 flex-1 flex-col">
        <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Latest output (main)</h3>
        {session.lastResult ? (
          <pre className="flex-1 overflow-y-auto rounded-lg bg-zinc-100 p-3 text-xs leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{session.lastResult}</pre>
        ) : (
          <p className="text-xs text-zinc-400">No turn result yet.</p>
        )}
      </section>
    </div>
  );
}

export default function LiveFeed({ session, events, now }: { session: SessionInfo; events: HookEvent[]; now: number }) {
  const entries = events.map(toEntry).filter(Boolean) as Entry[];
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries.length, follow]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 48);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <NowStrip session={session} now={now} />
        <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3">
          {entries.map((en, i) => {
            const Icon = en.icon;
            return (
              <details
                key={i}
                className={`group rounded-lg px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900 ${en.emphasis ? 'bg-red-50 dark:bg-red-950/30' : ''}`}
              >
                <summary className="flex cursor-pointer list-none items-baseline gap-2.5 [&::-webkit-details-marker]:hidden">
                  <span className="w-14 shrink-0 text-[11px] text-zinc-400 tabular-nums">{clock(en.ts)}</span>
                  <Icon size={13} className={`relative top-0.5 shrink-0 ${en.tone}`} />
                  <span className={`shrink-0 text-xs font-medium ${en.emphasis ? 'text-red-600 dark:text-red-400' : ''}`}>{en.label}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{en.summary}</span>
                </summary>
                <pre className="mt-1.5 ml-16 overflow-x-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed dark:bg-zinc-900">
                  {JSON.stringify(en.raw, null, 2)}
                </pre>
              </details>
            );
          })}
          {!entries.length && <p className="py-8 text-center text-xs text-zinc-400">No events yet for this session.</p>}
        </div>
        {!follow && (
          <button
            onClick={() => { setFollow(true); scroller.current!.scrollTop = scroller.current!.scrollHeight; }}
            className="absolute right-4 bottom-4 inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
          >
            <ArrowDownToLine size={13} /> Follow live
          </button>
        )}
      </div>
      <OutputPanel session={session} />
    </div>
  );
}
