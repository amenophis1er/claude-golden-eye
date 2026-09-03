import { useEffect, useState } from 'react';
import { Brain, MessageSquare, TerminalSquare, CornerDownRight, User } from 'lucide-react';
import { clock } from '../lib/format';
import Markdown from './Markdown';
import { useOpenFile } from './FileViewer';

export interface TEntry {
  ts: string | null;
  kind: 'thinking' | 'text' | 'tool' | 'result' | 'user';
  text?: string;
  name?: string;
  input?: Record<string, string> | null;
  isError?: boolean;
  /** tool_use id (tool rows) and the id a result answers (result rows). */
  id?: string | null;
  forId?: string | null;
  /** Result that carried no text — recorded only as proof the call finished. */
  empty?: boolean;
}

function elapsedShort(from: string | null, now: number) {
  if (!from) return '';
  const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The row renderer for parsed transcript entries — shared between the live
 * agent tail and the read-only history viewer. Parents own the scroller.
 * Keys are the original entry index, so newest-first inserts don't remount
 * (and re-parse) every row on each poll.
 */
export default function TranscriptEntryList({ entries, newestFirst, sessionId, running = false }: {
  entries: TEntry[]; newestFirst: boolean; sessionId?: string | null; running?: boolean;
}) {
  const openFile = useOpenFile();
  // Tick only while something is actually running, so a long command shows a
  // live elapsed counter the way the terminal does. Claude Code streams a
  // running command's output in its own UI; hooks and the transcript only
  // record the result once it finishes, so "how long has this been going" is
  // the honest thing we CAN show while it runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const answered = new Set(entries.filter((e) => e.kind === 'result' && e.forId).map((e) => e.forId));
  // Only the newest tool call can be in flight — agents run tools in sequence,
  // and an older unanswered call just means its result fell outside the tail.
  let inFlightId: string | null = null;
  if (running) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === 'tool' && e.id) { inFlightId = answered.has(e.id) ? null : e.id; break; }
    }
  }
  // A tool result is a continuation of the call above it, not an independent
  // row: reversing the flat list floated every result above its own command.
  // So reverse GROUPS — a call plus the results it produced — and keep each
  // group internally chronological.
  const groups: { en: TEntry; idx: number }[][] = [];
  entries.forEach((en, idx) => {
    if (en.kind === 'result' && groups.length) groups[groups.length - 1].push({ en, idx });
    else groups.push([{ en, idx }]);
  });
  const shown = (newestFirst ? [...groups].reverse() : groups).flat();
  return (
    <>
      {shown.map(({ en, idx }) => {
        const i = idx;
        if (en.kind === 'result' && en.empty) return null;
        if (en.kind === 'thinking')
          return (
            <details key={i} className="my-1 rounded px-1.5 py-0.5">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-zinc-400 italic [&::-webkit-details-marker]:hidden">
                <Brain size={11} className="shrink-0" /> thinking… <span className="not-italic">({(en.text ?? '').length} chars)</span>
              </summary>
              <p className="mt-1 ml-4 text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-500 italic">{en.text}</p>
            </details>
          );
        if (en.kind === 'user')
          return (
            <div key={i} className="my-2 flex gap-1.5 rounded-md bg-amber-50/70 px-1.5 py-1.5 dark:bg-amber-950/20">
              <User size={11} className="mt-1 shrink-0 text-amber-500" />
              <pre className="min-w-0 flex-1 font-sans text-[11px] leading-relaxed whitespace-pre-wrap">{en.text}</pre>
              {en.ts && <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{clock(en.ts)}</span>}
            </div>
          );
        if (en.kind === 'text')
          return (
            <div key={i} className="my-2 flex gap-1.5 rounded-md bg-sky-50/60 px-1.5 py-1.5 dark:bg-sky-950/20">
              <MessageSquare size={11} className="mt-1 shrink-0 text-sky-500" />
              <Markdown text={en.text ?? ''} className="min-w-0 flex-1" sessionId={sessionId} />
              {en.ts && <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{clock(en.ts)}</span>}
            </div>
          );
        if (en.kind === 'tool') {
          const brief = en.input ? Object.values(en.input)[0] ?? '' : '';
          // file_path is a path we KNOW (no guessing) — always openable.
          const filePath = en.input?.file_path;
          const canOpen = !!(openFile && sessionId && filePath);
          return (
            <div key={i} className="my-0.5 flex items-baseline gap-1.5 px-1.5">
              <TerminalSquare size={11} className="relative top-0.5 shrink-0 text-violet-500" />
              <span className="shrink-0 text-[11px] font-medium">{en.name}</span>
              {canOpen ? (
                <button
                  onClick={() => openFile!(sessionId!, filePath!)}
                  title={`open ${filePath}`}
                  className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-zinc-500 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
                >
                  {brief}
                </button>
              ) : (
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500" title={brief}>{brief}</span>
              )}
              {en.id && en.id === inFlightId ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-emerald-600 tabular-nums dark:text-emerald-400">
                  <span className="spin-ring inline-block h-2 w-2" /> {elapsedShort(en.ts, now)}
                </span>
              ) : (
                en.ts && <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{clock(en.ts)}</span>
              )}
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
    </>
  );
}
