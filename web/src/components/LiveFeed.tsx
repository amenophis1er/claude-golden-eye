import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowDownUp, Bot, CheckCircle2, Circle, CircleDot, Flag, GitFork,
  ListTodo, MessageSquare, Play, Power, ShieldX, TerminalSquare, TrendingUp, User,
} from 'lucide-react';
import type { HookEvent, SessionInfo, Todo } from '../lib/types';
import EventDetail from './EventDetail';
import Markdown from './Markdown';
import { clock, fmtDur, toolSummary, parseTaskNotification } from '../lib/format';

interface Entry {
  icon: any;
  tone: string;       // tailwind text color for the icon
  label: string;
  summary: string;
  raw: any;
  event: HookEvent;
  ts: string;
  emphasis?: boolean; // red rows (denials, blocked)
  toolUseId?: string; // PreToolUse rows: for in-flight detection
}

function toEntry(e: HookEvent, nameFor: (id: string) => string): Entry | null {
  const base = baseEntry(e, nameFor);
  return base ? { ...base, event: e } : null;
}

function baseEntry(e: HookEvent, nameFor: (id: string) => string): Omit<Entry, 'event'> | null {
  const p = e.payload ?? {};
  const who = p.agent_id ? nameFor(String(p.agent_id)) : 'main';
  switch (e.__hook) {
    case 'SessionStart':
      return { icon: Play, tone: 'text-zinc-400', label: 'session start', summary: p.source ?? '', raw: p, ts: e.__ts };
    case 'UserPromptSubmit': {
      const notif = parseTaskNotification(p.prompt);
      if (notif)
        return {
          icon: CheckCircle2,
          tone: 'text-teal-500',
          label: `task ${notif.status ?? 'update'}`,
          summary: notif.summary ?? notif.taskId ?? '',
          raw: p, ts: e.__ts,
        };
      return { icon: MessageSquare, tone: 'text-sky-500', label: 'prompt', summary: String(p.prompt ?? '').slice(0, 200), raw: p, ts: e.__ts };
    }
    case 'PreToolUse': {
      const spawn = p.tool_name === 'Agent' || p.tool_name === 'Task';
      if (spawn)
        return { icon: GitFork, tone: 'text-violet-500', label: 'delegate', summary: p.tool_input?.description ?? toolSummary(p.tool_input), raw: p, ts: e.__ts };
      return { icon: TerminalSquare, tone: 'text-zinc-400', label: `${who} · ${p.tool_name}`, summary: toolSummary(p.tool_input), raw: p, ts: e.__ts, toolUseId: p.tool_use_id };
    }
    case 'PMDeny':
      return { icon: ShieldX, tone: 'text-red-500', label: `write blocked · ${p.tool_name}`, summary: toolSummary(p.tool_input), raw: p, ts: e.__ts, emphasis: true };
    case 'SubagentStop':
      return { icon: CheckCircle2, tone: 'text-emerald-500', label: `${nameFor(String(p.agent_id ?? ''))} finished`, summary: String(p.last_assistant_message ?? '').slice(0, 200), raw: p, ts: e.__ts };
    case 'MCPProgress':
      return {
        icon: TrendingUp,
        tone: p.state === 'blocked' ? 'text-red-500' : 'text-emerald-500',
        label: `progress · ${p.state}${p.progress_pct != null ? ` ${p.progress_pct}%` : ''}`,
        summary: p.note ?? '', raw: p, ts: e.__ts, emphasis: p.state === 'blocked',
      };
    case 'PMModelPin':
      return { icon: Bot, tone: 'text-violet-500', label: `model pinned → ${p.model}`, summary: p.description ?? (p.was ? `was ${p.was}` : ''), raw: p, ts: e.__ts };
    case 'DashboardPrompt':
      return { icon: MessageSquare, tone: 'text-amber-500', label: 'dashboard prompt', summary: String(p.prompt ?? '').slice(0, 200), raw: p, ts: e.__ts };
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
  // "Now" means now: hide entries whose last tool activity is stale (a
  // session killed mid-turn would otherwise show absurd elapsed times).
  const running = session.agents.filter(
    (a) =>
      (a.status === 'running' || a.status === 'starting') &&
      a.lastToolAt != null &&
      now - Date.parse(a.lastToolAt) < 10 * 60 * 1000
  );
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

function LastPrompt({ text }: { text: string }) {
  const notif = parseTaskNotification(text);
  if (!notif) {
    return <pre className="rounded-lg bg-zinc-100 p-3 text-xs leading-relaxed whitespace-pre-wrap dark:bg-zinc-900">{text}</pre>;
  }
  return (
    <div className="rounded-lg border border-teal-200 bg-teal-50/60 p-3 dark:border-teal-900 dark:bg-teal-950/30">
      <div className="flex items-center gap-1.5 text-xs font-medium text-teal-700 dark:text-teal-300">
        <CheckCircle2 size={13} /> background task {notif.status ?? 'update'}
        {notif.taskId && <span className="ml-auto font-mono text-[10px] text-teal-600/70 dark:text-teal-400/70">{notif.taskId}</span>}
      </div>
      {notif.summary && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{notif.summary}</p>}
      {notif.result && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-teal-700/80 hover:text-teal-800 dark:text-teal-400/80 dark:hover:text-teal-300">result</summary>
          <pre className="mt-1 max-h-64 overflow-y-auto rounded-md bg-white/70 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900/70">{notif.result}</pre>
        </details>
      )}
    </div>
  );
}

function PlanRail({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed');
  const active = todos.filter((t) => t.status === 'in_progress');
  const open = todos.filter((t) => t.status !== 'completed' && t.status !== 'in_progress');
  const row = (t: Todo, Icon: any, cls: string, extra?: string | null) => (
    <div key={t.id ?? t.content} className="flex items-start gap-2 py-0.5">
      <Icon size={13} className={`mt-0.5 shrink-0 ${cls}`} />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-xs ${t.status === 'completed' ? 'text-zinc-400 line-through' : ''}`} title={t.description ?? t.content}>
          {t.id && <span className="mr-1 text-[10px] text-zinc-400 tabular-nums">#{t.id}</span>}
          {t.content}
        </div>
        {extra && <div className="truncate text-[11px] text-amber-600 italic dark:text-amber-400">{extra}…</div>}
      </div>
    </div>
  );
  return (
    <section className="shrink-0 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
        <ListTodo size={12} /> Plan · {done.length}/{todos.length} done
      </h3>
      <div className="max-h-64 overflow-y-auto">
        {active.map((t) => row(t, CircleDot, 'text-amber-500', t.activeForm))}
        {open.map((t) => row(t, Circle, 'text-zinc-300 dark:text-zinc-600'))}
        {done.length > 0 && (
          <details>
            <summary className="cursor-pointer py-0.5 text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
              {done.length} completed
            </summary>
            {done.map((t) => row(t, CheckCircle2, 'text-emerald-500'))}
          </details>
        )}
      </div>
    </section>
  );
}

function OutputPanel({ session }: { session: SessionInfo }) {
  const [width, setWidth] = useState(() => {
    const w = Number(localStorage.getItem('ge-rail-width'));
    return w >= 280 && w <= 900 ? w : 416;
  });
  const widthRef = useRef(width);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(900, Math.max(280, window.innerWidth - ev.clientX));
      widthRef.current = w;
      setWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem('ge-rail-width', String(widthRef.current));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  return (
    <div
      className="relative flex shrink-0 flex-col gap-3 overflow-y-auto border-l border-zinc-200 p-4 dark:border-zinc-800"
      style={{ width }}
    >
      {/* drag handle over the left border */}
      <div
        onPointerDown={startDrag}
        title="Drag to resize"
        className="absolute top-0 left-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-amber-400/50 active:bg-amber-500/60"
      />
      {session.lastPrompt && (
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Last prompt</h3>
          <LastPrompt text={session.lastPrompt} />
        </section>
      )}
      <section className="flex min-h-0 flex-1 flex-col">
        <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Latest output (main)</h3>
        {session.lastResult ? (
          <div className="flex-1 overflow-y-auto rounded-lg bg-zinc-100 p-3 dark:bg-zinc-900">
            <Markdown text={session.lastResult} />
          </div>
        ) : (
          <p className="text-xs text-zinc-400">No turn result yet.</p>
        )}
      </section>
      <PlanRail todos={session.todos} />
    </div>
  );
}

export default function LiveFeed({ session, events, now }: { session: SessionInfo; events: HookEvent[]; now: number }) {
  // Feed rows carry only agent_id — resolve it to the delegation description
  // (what the human actually tracks), falling back to the short id.
  const nameFor = (id: string) => {
    const a = session.agents.find((x) => x.id === id);
    const d = a?.description;
    if (!d) return `agent ${id.slice(0, 6)}`;
    return d.length > 34 ? `${d.slice(0, 34)}…` : d;
  };
  const entries = events.map((e) => toEntry(e, nameFor)).filter(Boolean) as Entry[];

  // In-flight detection: a fresh PreToolUse with no matching PostToolUse is a
  // tool call still executing — the terminal shows a spinner; so should we.
  const postIds = new Set(
    events.filter((e) => e.__hook === 'PostToolUse' && e.payload?.tool_use_id).map((e) => e.payload.tool_use_id)
  );
  const isRunning = (en: Entry) =>
    !!en.toolUseId &&
    !postIds.has(en.toolUseId) &&
    now - Date.parse(en.ts) < 30 * 60 * 1000 &&
    (session.state === 'working' || session.state === 'active');
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  // newest-first is the monitoring default; chronological reads like a story.
  const [newestFirst, setNewestFirst] = useState(() => localStorage.getItem('ge-feed-order') !== 'oldest');
  const shown = newestFirst ? [...entries].reverse() : entries;

  useEffect(() => {
    if (!newestFirst && follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries.length, follow, newestFirst]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || newestFirst) return;
    setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 48);
  };

  const toggleOrder = () => {
    const next = !newestFirst;
    setNewestFirst(next);
    localStorage.setItem('ge-feed-order', next ? 'newest' : 'oldest');
    if (scroller.current) scroller.current.scrollTop = next ? 0 : scroller.current.scrollHeight;
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <NowStrip session={session} now={now} />
        <div className="flex justify-end border-b border-zinc-200 px-4 py-1 dark:border-zinc-800">
          <button
            onClick={toggleOrder}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <ArrowDownUp size={11} /> {newestFirst ? 'newest first' : 'oldest first'}
          </button>
        </div>
        <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3">
          {shown.map((en, i) => {
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
                  {isRunning(en) && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-1.5 text-[10px] font-medium text-emerald-700 tabular-nums dark:bg-emerald-950 dark:text-emerald-300">
                      <span className="h-1 w-1 rounded-full bg-emerald-500 pulse-dot" /> running {fmtDur(now - Date.parse(en.ts))}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{en.summary}</span>
                </summary>
                <EventDetail event={en.event} />
              </details>
            );
          })}
          {!entries.length && <p className="py-8 text-center text-xs text-zinc-400">No events yet for this session.</p>}
        </div>
        {!newestFirst && !follow && (
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
