import { useEffect, useState } from 'react';
import { ArrowDownUp, ChevronRight, Copy, Check, FolderClock, History, Radio, ScrollText } from 'lucide-react';
import type { HistoryProject, HistorySession } from '../lib/types';
import { navigate, navigateHistory } from '../lib/router';
import { baseName, relTime, shortId } from '../lib/format';
import TranscriptEntryList, { type TEntry } from './TranscriptEntryList';

function fmtBytes(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return Math.round(n / 1e3) + ' kB';
  return n + ' B';
}

function useFetch<T>(url: string | null): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!url) return;
    let dead = false;
    (async () => {
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (dead) return;
        if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
        else setData(j);
      } catch {
        if (!dead) setError('server unreachable');
      }
    })();
    return () => { dead = true; };
  }, [url]);
  return { data, error };
}

function Crumbs({ dir, id }: { dir: string | null; id: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <button
        onClick={() => navigateHistory()}
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <History size={14} className="text-amber-500" /> History
      </button>
      {dir && (
        <>
          <ChevronRight size={13} className="text-zinc-400" />
          <button
            onClick={() => navigateHistory(dir)}
            className={`rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${id ? '' : 'font-medium'}`}
          >
            {baseName(dir)}
          </button>
        </>
      )}
      {id && (
        <>
          <ChevronRight size={13} className="text-zinc-400" />
          <span className="px-1.5 font-mono text-xs text-zinc-500">{shortId(id)}</span>
        </>
      )}
    </div>
  );
}

function ProjectList({ now }: { now: number }) {
  const { data, error } = useFetch<{ projects: HistoryProject[] }>('/api/history');
  if (error) return <p className="p-6 text-sm text-zinc-400">{error}</p>;
  if (!data) return <p className="p-6 text-sm text-zinc-400">loading…</p>;
  if (!data.projects.length) return <p className="p-6 text-sm text-zinc-400">No transcripts found yet.</p>;
  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      {data.projects.map((p) => (
        <button
          key={p.dir}
          onClick={() => navigateHistory(p.dir)}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          <FolderClock size={16} className="shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{baseName(p.cwd)}</span>
            <span className="block truncate font-mono text-[11px] text-zinc-400">{p.cwd}</span>
          </span>
          <span className="shrink-0 text-xs text-zinc-400 tabular-nums">
            {p.sessions} session{p.sessions === 1 ? '' : 's'}
            {p.lastActive && ` · ${relTime(p.lastActive, now)}`}
          </span>
        </button>
      ))}
    </div>
  );
}

function SessionList({ dir, now }: { dir: string; now: number }) {
  const { data, error } = useFetch<{ sessions: HistorySession[] }>(
    `/api/history/sessions?dir=${encodeURIComponent(dir)}`
  );
  if (error) return <p className="p-6 text-sm text-zinc-400">{error}</p>;
  if (!data) return <p className="p-6 text-sm text-zinc-400">loading…</p>;
  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      {data.sessions.map((s) => (
        <button
          key={s.id}
          onClick={() => (s.live ? navigate(s.id) : navigateHistory(dir, s.id))}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
          title={s.live ? 'live on the dashboard — opens the live view' : undefined}
        >
          {s.live
            ? <Radio size={15} className="shrink-0 text-emerald-500" />
            : <ScrollText size={15} className="shrink-0 text-zinc-400" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{s.firstPrompt ?? <span className="text-zinc-400 italic">(no prompt recorded)</span>}</span>
            <span className="block font-mono text-[11px] text-zinc-400">{shortId(s.id)}</span>
          </span>
          <span className="shrink-0 text-right text-xs text-zinc-400 tabular-nums">
            {relTime(s.mtime, now)}
            <span className="block text-[10px]">{fmtBytes(s.size)}</span>
          </span>
        </button>
      ))}
      {!data.sessions.length && <p className="p-2 text-sm text-zinc-400">No transcripts in this project.</p>}
    </div>
  );
}

function TranscriptViewer({ dir, id }: { dir: string; id: string }) {
  const { data, error } = useFetch<{ entries: TEntry[]; model?: string | null; exists?: boolean; error?: string }>(
    `/api/history/transcript?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`
  );
  const [newestFirst, setNewestFirst] = useState(() => localStorage.getItem('ge-transcript-order') !== 'oldest');
  const [copied, setCopied] = useState(false);
  const resumeCmd = `claude --resume ${id}`;
  if (error) return <p className="p-6 text-sm text-zinc-400">{error}</p>;
  if (!data) return <p className="p-6 text-sm text-zinc-400">loading…</p>;
  if (data.exists === false) return <p className="p-6 text-sm text-zinc-400">transcript not found</p>;
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">read-only</span>
        {data.model && (
          <span className="rounded bg-violet-100 px-1.5 py-px font-mono text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">{data.model}</span>
        )}
        <button
          onClick={() => { navigator.clipboard.writeText(resumeCmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
          title="Copy the resume command (run it with the Claude instance this session belongs to)"
          className="inline-flex items-center gap-1 rounded border border-zinc-200 px-1.5 py-0.5 font-mono hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
        >
          {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />} {resumeCmd}
        </button>
        <button
          onClick={() => {
            const next = !newestFirst;
            setNewestFirst(next);
            localStorage.setItem('ge-transcript-order', next ? 'newest' : 'oldest');
          }}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <ArrowDownUp size={11} /> {newestFirst ? 'newest first' : 'oldest first'}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950/60">
        {data.entries.length
          ? <TranscriptEntryList entries={data.entries} newestFirst={newestFirst} />
          : <p className="p-2 text-[11px] text-zinc-400">transcript is empty</p>}
      </div>
    </div>
  );
}

/** Read-only browser over past sessions (server opt-in: {"history": true}). */
export default function HistoryView({ dir, id, now }: { dir: string | null; id: string | null; now: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-zinc-200 bg-white px-6 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <Crumbs dir={dir} id={id} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!dir && <ProjectList now={now} />}
        {dir && !id && <SessionList dir={dir} now={now} />}
        {dir && id && <TranscriptViewer dir={dir} id={id} />}
      </div>
    </div>
  );
}
