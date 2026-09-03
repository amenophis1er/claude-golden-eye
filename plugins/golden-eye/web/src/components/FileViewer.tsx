import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { FileText, RefreshCw, X } from 'lucide-react';
import Markdown from './Markdown';

/**
 * Read-only peek at a project file, opened from any path shown in a session
 * (tool calls, transcript rows, prose). One viewer lives at the app root and
 * anything can open it through the context — so links work the same in the
 * feed, the agent transcript, and the history browser.
 *
 * There is nothing to stream: the server is on the same machine as the file,
 * so this is one fetch per open, plus an explicit refresh.
 */
type Opener = (sessionId: string, path: string) => void;
const FileViewerContext = createContext<Opener | null>(null);

/** Open a project file in the viewer; null when the server has it disabled. */
export function useOpenFile(): Opener | null {
  return useContext(FileViewerContext);
}

interface FileData {
  relPath?: string;
  path?: string;
  size?: number;
  mtime?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}

function fmtBytes(n?: number) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return Math.round(n / 1e3) + ' kB';
  return n + ' B';
}

export default function FileViewerProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [target, setTarget] = useState<{ sessionId: string; path: string } | null>(null);
  const [data, setData] = useState<FileData | null>(null);
  const [nonce, setNonce] = useState(0);

  const open = useCallback<Opener>((sessionId, path) => setTarget({ sessionId, path }), []);

  useEffect(() => {
    if (!target) { setData(null); return; }
    let dead = false;
    (async () => {
      setData(null);
      try {
        const q = new URLSearchParams({ sessionId: target.sessionId, path: target.path });
        const r = await fetch(`/api/file?${q}`);
        const j = await r.json();
        if (!dead) setData(r.ok ? j : { error: j.error ?? `HTTP ${r.status}` });
      } catch {
        if (!dead) setData({ error: 'server unreachable' });
      }
    })();
    return () => { dead = true; };
  }, [target, nonce]);

  // Escape closes, matching every other overlay people expect.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTarget(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target]);

  const isMarkdown = !!target && /\.(md|markdown)$/i.test(target.path);

  return (
    <FileViewerContext.Provider value={enabled ? open : null}>
      {children}
      {target && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-8"
          onClick={() => setTarget(null)}
        >
          <div
            className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
              <FileText size={14} className="shrink-0 text-amber-500" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={data?.path ?? target.path}>
                {data?.relPath ?? target.path}
              </span>
              {data && !data.error && (
                <span className="shrink-0 text-[11px] text-zinc-400 tabular-nums">
                  {fmtBytes(data.size)}{data.truncated ? ' · truncated' : ''}
                </span>
              )}
              <button
                onClick={() => setNonce((n) => n + 1)}
                title="Reload from disk"
                className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <RefreshCw size={13} />
              </button>
              <button
                onClick={() => setTarget(null)}
                title="Close (Esc)"
                className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <X size={14} />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {!data && <p className="text-sm text-zinc-400">loading…</p>}
              {data?.error && (
                <p className="text-sm text-zinc-400">
                  {data.error}
                  {data.error === 'not found' && ' — the path may be relative to a different directory.'}
                </p>
              )}
              {data && !data.error && (isMarkdown
                ? <Markdown text={data.text ?? ''} />
                : <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{data.text}</pre>)}
            </div>
          </div>
        </div>
      )}
    </FileViewerContext.Provider>
  );
}
