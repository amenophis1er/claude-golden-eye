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
}

/**
 * The row renderer for parsed transcript entries — shared between the live
 * agent tail and the read-only history viewer. Parents own the scroller.
 * Keys are the original entry index, so newest-first inserts don't remount
 * (and re-parse) every row on each poll.
 */
export default function TranscriptEntryList({ entries, newestFirst, sessionId }: {
  entries: TEntry[]; newestFirst: boolean; sessionId?: string | null;
}) {
  const openFile = useOpenFile();
  const indexed = entries.map((en, idx) => ({ en, idx }));
  const shown = newestFirst ? [...indexed].reverse() : indexed;
  return (
    <>
      {shown.map(({ en, idx }) => {
        const i = idx;
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
    </>
  );
}
