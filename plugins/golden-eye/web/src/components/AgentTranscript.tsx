import { useEffect, useRef, useState } from 'react';
import { ArrowDownUp } from 'lucide-react';
import { fmtTokens } from '../lib/format';
import TranscriptEntryList, { type TEntry } from './TranscriptEntryList';

/**
 * Live tail of an agent's own JSONL transcript — thinking, assistant text,
 * tool calls and results. Polls while the agent is running.
 */
export default function AgentTranscript({ sessionId, agentId, running, fill = false }: {
  sessionId: string; agentId?: string | null; running: boolean; fill?: boolean;
}) {
  const [entries, setEntries] = useState<TEntry[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ in: number; cacheRead: number; out: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Newest-first by default, matching the Live feed; an explicit 'oldest'
  // choice is respected.
  const [newestFirst, setNewestFirst] = useState(() => localStorage.getItem('ge-transcript-order') !== 'oldest');
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
          setUsage(j.usage ?? null);
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
    if (el && pinned.current && !newestFirst) el.scrollTop = el.scrollHeight;
  }, [entries, newestFirst]);

  const toggleOrder = () => {
    const next = !newestFirst;
    setNewestFirst(next);
    localStorage.setItem('ge-transcript-order', next ? 'newest' : 'oldest');
    if (scroller.current) scroller.current.scrollTop = next ? 0 : scroller.current.scrollHeight;
  };

  const headerRow = (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-[11px] text-zinc-400">
        {model && (
          <>{running ? 'running on' : 'model'} <span className="rounded bg-violet-100 px-1.5 py-px font-mono text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">{model}</span></>
        )}
        {usage && (usage.in > 0 || usage.out > 0) && (
          <span className="ml-2 tabular-nums" title={`cache read ${fmtTokens(usage.cacheRead)}`}>
            ↓ {fmtTokens(usage.in)} · ↑ {fmtTokens(usage.out)}
          </span>
        )}
      </span>
      <button
        onClick={toggleOrder}
        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
      >
        <ArrowDownUp size={11} /> {newestFirst ? 'newest first' : 'oldest first'}
      </button>
    </div>
  );

  if (error) return <p className="mt-1.5 text-[11px] text-zinc-400">{error}</p>;
  if (!entries) return <p className="mt-1.5 text-[11px] text-zinc-400">loading…</p>;
  if (!entries.length) return <p className="mt-1.5 text-[11px] text-zinc-400">transcript is empty so far</p>;

  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col' : ''}>
    {headerRow}
    <div
      ref={scroller}
      onScroll={() => {
        const el = scroller.current;
        if (el) pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
      }}
      className={`mt-1.5 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950/60 ${fill ? 'min-h-0 flex-1' : 'max-h-96'}`}
    >
      <TranscriptEntryList entries={entries} newestFirst={newestFirst} sessionId={sessionId} running={running} />
    </div>
    </div>
  );
}
