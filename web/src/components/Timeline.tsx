import { useMemo, useState } from 'react';
import type { HookEvent } from '../lib/types';
import { clock, toolSummary } from '../lib/format';

const TONES: Record<string, string> = {
  UserPromptSubmit: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  PreToolUse: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  PostToolUse: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  PMDeny: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  PMSync: 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  PMModelPin: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  SubagentStop: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  MCPProgress: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  Stop: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
};

function summary(e: HookEvent): string {
  const p = e.payload ?? {};
  if (e.__hook === 'UserPromptSubmit') return String(p.prompt ?? '').slice(0, 160);
  if (e.__hook === 'SubagentStop' || e.__hook === 'Stop') return String(p.last_assistant_message ?? '').slice(0, 160);
  if (p.tool_name) return `${p.tool_name} · ${toolSummary(p.tool_input)}`;
  if (e.__hook === 'PMSync') return `${p.action}${p.mission ? ` · ${p.mission}` : ''}`;
  if (e.__hook === 'MCPProgress') return `${p.state}${p.progress_pct != null ? ` ${p.progress_pct}%` : ''} ${p.note ?? ''}`;
  return p.source ?? '';
}

export default function Timeline({ events }: { events: HookEvent[] }) {
  const kinds = useMemo(() => [...new Set(events.map((e) => e.__hook))], [events]);
  const [filter, setFilter] = useState<string | null>(null);
  const shown = filter ? events.filter((e) => e.__hook === filter) : events;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap gap-1.5 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <button
          onClick={() => setFilter(null)}
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${!filter ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}
        >
          all
        </button>
        {kinds.map((k) => (
          <button
            key={k}
            onClick={() => setFilter(filter === k ? null : k)}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${filter === k ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : (TONES[k] ?? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')}`}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {[...shown].reverse().map((e, i) => (
          <details key={i} className="rounded-lg px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-900">
            <summary className="flex cursor-pointer list-none items-baseline gap-2.5 [&::-webkit-details-marker]:hidden">
              <span className="w-14 shrink-0 text-[11px] text-zinc-400 tabular-nums">{clock(e.__ts)}</span>
              <span className={`w-32 shrink-0 truncate rounded-full px-2 py-0.5 text-center text-[10px] font-medium ${TONES[e.__hook] ?? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>
                {e.__hook}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{summary(e)}</span>
            </summary>
            <pre className="mt-1.5 ml-16 overflow-x-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed dark:bg-zinc-900">
              {JSON.stringify(e.payload, null, 2)}
            </pre>
          </details>
        ))}
        {!shown.length && <p className="py-8 text-center text-xs text-zinc-400">No events.</p>}
      </div>
    </div>
  );
}
