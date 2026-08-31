import { useEffect, useRef, useState } from 'react';
import { Brain, MessageSquare, TerminalSquare, CornerDownRight } from 'lucide-react';
import { clock } from '../lib/format';

interface TEntry {
  ts: string | null;
  kind: 'thinking' | 'text' | 'tool' | 'result';
  text?: string;
  name?: string;
  input?: Record<string, string> | null;
  isError?: boolean;
}

/**
 * Live tail of an agent's own JSONL transcript — thinking, assistant text,
 * tool calls and results. Polls while the agent is running.
 */
export default function AgentTranscript({ sessionId, agentId, running, fill = false }: {
  sessionId: string; agentId?: string | null; running: boolean; fill?: boolean;
}) {
  const [entries, setEntries] = useState<TEntry[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const q = new URLSearchParams({ sessionId });
        if (agentId) q.set('agentId', agentId);
        const r = await fetch(`/api/agent-transcript?${q}`);
        const j = await r.json();
        if (dead) return;
        if (!r.ok || j.error === 'not-found' || j.exists === false) {
          setError(j.error === 'not-found' ? 'transcript not written yet' : (j.error ?? 'unavailable'));
          setEntries(null);
        } else {
          setError(null);
          setEntries(j.entries ?? []);
          setModel(j.model ?? null);
        }
      } catch {
        if (!dead) setError('server unreachable');
      }
    };
    load();
    const t = running ? window.setInterval(load, 2500) : null;
    return () => { dead = true; if (t) window.clearInterval(t); };
  }, [sessionId, agentId, running]);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const modelBadge = model && (
    <div className="mb-1 text-[11px] text-zinc-400">
      running on <span className="rounded bg-violet-100 px-1.5 py-px font-mono text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">{model}</span>
    </div>
  );

  if (error) return <p className="mt-1.5 text-[11px] text-zinc-400">{error}</p>;
  if (!entries) return <p className="mt-1.5 text-[11px] text-zinc-400">loading…</p>;
  if (!entries.length) return <p className="mt-1.5 text-[11px] text-zinc-400">transcript is empty so far</p>;

  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col' : ''}>
    {modelBadge}
    <div
      ref={scroller}
      onScroll={() => {
        const el = scroller.current;
        if (el) pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
      }}
      className={`mt-1.5 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950/60 ${fill ? 'min-h-0 flex-1' : 'max-h-96'}`}
    >
      {entries.map((en, i) => {
        if (en.kind === 'thinking')
          return (
            <details key={i} className="my-1 rounded px-1.5 py-0.5">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-zinc-400 italic [&::-webkit-details-marker]:hidden">
                <Brain size={11} className="shrink-0" /> thinking… <span className="not-italic">({(en.text ?? '').length} chars)</span>
              </summary>
              <p className="mt-1 ml-4 text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-500 italic">{en.text}</p>
            </details>
          );
        if (en.kind === 'text')
          return (
            <div key={i} className="my-2 flex gap-1.5 rounded-md bg-sky-50/60 px-1.5 py-1 dark:bg-sky-950/20">
              <MessageSquare size={11} className="mt-0.5 shrink-0 text-sky-500" />
              <p className="min-w-0 flex-1 text-xs leading-relaxed whitespace-pre-wrap">{en.text}</p>
              {en.ts && <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{clock(en.ts)}</span>}
            </div>
          );
        if (en.kind === 'tool') {
          const brief = en.input ? Object.values(en.input)[0] ?? '' : '';
          return (
            <div key={i} className="my-0.5 flex items-baseline gap-1.5 px-1.5">
              <TerminalSquare size={11} className="relative top-0.5 shrink-0 text-violet-500" />
              <span className="shrink-0 text-[11px] font-medium">{en.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500" title={brief}>{brief}</span>
              {en.ts && <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{clock(en.ts)}</span>}
            </div>
          );
        }
        const full = en.text ?? '';
        const firstLine = full.split('\n')[0];
        const expandable = full.length > firstLine.length || firstLine.length > 140;
        if (!expandable)
          return (
            <div key={i} className="my-0.5 ml-4 flex gap-1.5 px-1.5">
              <CornerDownRight size={11} className={`mt-0.5 shrink-0 ${en.isError ? 'text-red-400' : 'text-zinc-300 dark:text-zinc-600'}`} />
              <pre className={`min-w-0 flex-1 truncate font-mono text-[10px] ${en.isError ? 'text-red-500' : 'text-zinc-400'}`}>{firstLine}</pre>
            </div>
          );
        return (
          <details key={i} className="my-0.5 ml-4 px-1.5">
            <summary className="flex cursor-pointer list-none gap-1.5 [&::-webkit-details-marker]:hidden">
              <CornerDownRight size={11} className={`mt-0.5 shrink-0 ${en.isError ? 'text-red-400' : 'text-zinc-300 dark:text-zinc-600'}`} />
              <pre className={`min-w-0 flex-1 truncate font-mono text-[10px] ${en.isError ? 'text-red-500' : 'text-zinc-400'}`}>{firstLine} …</pre>
            </summary>
            <pre className={`mt-1 ml-4 max-h-48 overflow-auto rounded bg-zinc-100 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900 ${en.isError ? 'text-red-500' : 'text-zinc-500'}`}>{full}</pre>
          </details>
        );
      })}
    </div>
    </div>
  );
}
