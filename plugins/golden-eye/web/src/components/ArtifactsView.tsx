import { useEffect, useState } from 'react';
import { Database, ExternalLink, LayoutTemplate, Radio, ScrollText } from 'lucide-react';
import type { ArtifactProject } from '../lib/types';
import { navigate } from '../lib/router';
import { baseName, relTime, shortId } from '../lib/format';

/**
 * Published artifacts (claude.ai pages), grouped by project.
 *
 * Two sources, merged server-side: publishes observed live through the hooks
 * (rich — title, version, capabilities) and older ones recovered from session
 * transcripts when the history opt-in is on (no title recorded back then).
 * Either way this lists what golden-eye *saw published from these sessions* —
 * not the account's full artifact gallery, which needs an authenticated
 * claude.ai call this local server can't make.
 */
export default function ArtifactsView({ now }: { now: number }) {
  const [data, setData] = useState<{ projects: ArtifactProject[]; backfillEnabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch('/api/artifacts');
        const j = await r.json();
        if (dead) return;
        if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
        else { setError(null); setData(j); }
      } catch {
        if (!dead) setError('server unreachable');
      }
    };
    load();
    const t = window.setInterval(load, 10000);
    return () => { dead = true; window.clearInterval(t); };
  }, []);

  const total = data?.projects.reduce((n, p) => n + p.artifacts.length, 0) ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-zinc-200 bg-white px-6 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex items-center gap-2">
          <LayoutTemplate size={16} className="text-amber-500" />
          <h1 className="font-semibold tracking-tight">Artifacts</h1>
          {total > 0 && <span className="text-xs text-zinc-400 tabular-nums">{total}</span>}
        </div>
        <p className="mt-1 text-[11px] text-zinc-400">
          Pages published from sessions golden-eye has seen — not your full claude.ai gallery.
          {data && !data.backfillEnabled && ' Enable history to also recover older publishes from transcripts.'}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-sm text-zinc-400">{error}</p>}
        {!error && !data && <p className="p-6 text-sm text-zinc-400">loading…</p>}
        {data && !total && (
          <p className="p-6 text-sm text-zinc-400">
            No published artifacts yet — publish one from a session and it shows up here.
          </p>
        )}
        <div className="mx-auto w-full max-w-3xl p-4">
          {data?.projects.map((p) => (
            <div key={p.cwd} className="mt-5 first:mt-0">
              <div className="mb-1 flex items-center justify-between px-1" title={p.cwd}>
                <span className="truncate text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                  {baseName(p.cwd)}
                </span>
                <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{p.artifacts.length}</span>
              </div>
              {p.artifacts.map((a) => (
                <div
                  key={a.id}
                  className="group flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                >
                  <span className="mt-0.5 shrink-0 text-base leading-none" aria-hidden>
                    {a.favicon || '📄'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                    >
                      <span className="min-w-0 truncate">
                        {a.title ?? (a.path ? baseName(a.path).replace(/\.(html|md)$/, '') : 'untitled artifact')}
                      </span>
                      <ExternalLink size={11} className="shrink-0 text-zinc-400" />
                    </a>
                    {a.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{a.description}</p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-zinc-400">
                      {a.lastAt && <span>updated {relTime(a.lastAt, now)}</span>}
                      {a.publishes > 1 && <span className="tabular-nums">{a.publishes} publishes</span>}
                      {a.capabilities?.includes('db') && (
                        <span className="inline-flex items-center gap-1" title="declares the shared-database capability">
                          <Database size={10} /> db
                        </span>
                      )}
                      {a.backfilled ? (
                        <span className="inline-flex items-center gap-1" title="recovered from a session transcript">
                          <ScrollText size={10} /> from transcript
                        </span>
                      ) : (
                        a.sessionId && (
                          <button
                            onClick={() => navigate(a.sessionId!)}
                            className="inline-flex items-center gap-1 hover:text-zinc-600 hover:underline dark:hover:text-zinc-300"
                            title="open the session that published it"
                          >
                            <Radio size={10} /> {shortId(a.sessionId)}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
