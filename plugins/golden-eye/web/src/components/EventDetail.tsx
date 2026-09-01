import { Bot } from 'lucide-react';
import type { HookEvent } from '../lib/types';

/**
 * Structured expansion for a feed/timeline row: long strings become labeled
 * blocks (commands mono, prose wrapped), short fields become chips, and the
 * raw payload stays one nested click away.
 */

const PROSE_KEYS = new Set(['prompt', 'description', 'message', 'note', 'reason']);
const isLong = (v: string) => v.length > 80 || v.includes('\n');

function Block({ label, text, mono }: { label: string; text: string; mono: boolean }) {
  return (
    <div className="mt-1.5">
      <div className="mb-0.5 text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">{label}</div>
      <pre
        className={`max-h-64 overflow-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-zinc-900 ${mono ? '' : 'font-sans'}`}
      >
        {text}
      </pre>
    </div>
  );
}

export default function EventDetail({ event }: { event: HookEvent }) {
  const p = event.payload ?? {};
  const blocks: { key: string; label: string; text: string; mono: boolean }[] = [];
  const chips: [string, string][] = [];

  const pushValue = (key: string, label: string, v: unknown) => {
    if (v == null) return;
    const sv = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    if (isLong(sv)) blocks.push({ key, label, text: sv, mono: !PROSE_KEYS.has(label) });
    else chips.push([label, sv]);
  };

  if (typeof p.prompt === 'string') pushValue('p:prompt', 'prompt', p.prompt);
  if (typeof p.last_assistant_message === 'string') pushValue('p:msg', 'message', p.last_assistant_message);
  if (typeof p.reason === 'string') pushValue('p:reason', 'reason', p.reason);

  if (p.tool_input && typeof p.tool_input === 'object') {
    for (const [k, v] of Object.entries(p.tool_input)) pushValue('in:' + k, k, v);
  }
  if (p.tool_response && typeof p.tool_response === 'object') {
    const sv = JSON.stringify(p.tool_response, null, 2);
    if (sv !== '{}') blocks.push({ key: 'resp', label: 'tool response', text: sv, mono: true });
  }
  for (const k of ['agent_id', 'agent_type', 'source', 'duration_ms', 'model', 'was', 'state', 'progress_pct', 'action', 'mission']) {
    if (p[k] != null && k !== 'mission') chips.push([k, String(p[k])]);
    else if (k === 'mission' && typeof p.mission === 'string') pushValue('p:mission', 'mission', p.mission);
  }

  return (
    <div className="mt-1.5 mr-2 ml-16">
      {(chips.length > 0 || (p.agent_id && p.session_id)) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {p.agent_id && p.session_id && (
            <a
              href={`#/s/${encodeURIComponent(p.session_id)}/agents/${encodeURIComponent(p.agent_id)}`}
              className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-200 dark:bg-violet-400/10 dark:text-violet-300 dark:hover:bg-violet-400/20"
            >
              <Bot size={11} /> open agent →
            </a>
          )}
          {chips.map(([k, v]) => (
            <span key={k} className="max-w-full truncate rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-800">
              <span className="text-zinc-400">{k}:</span>{' '}
              <span className="font-mono">{v.length > 120 ? v.slice(0, 120) + '…' : v}</span>
            </span>
          ))}
        </div>
      )}
      {blocks.map((b) => (
        <Block key={b.key} label={b.label} text={b.text} mono={b.mono} />
      ))}
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          raw JSON
        </summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-zinc-100 p-2.5 text-[11px] leading-relaxed dark:bg-zinc-900">
          {JSON.stringify(p, null, 2)}
        </pre>
      </details>
    </div>
  );
}
