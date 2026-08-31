import { CheckCircle2, Circle, CircleDot, OctagonMinus } from 'lucide-react';
import type { SessionInfo, Todo } from '../lib/types';

const ORDER: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };

function TaskRow({ t, all }: { t: Todo; all: Todo[] }) {
  const done = t.status === 'completed';
  const active = t.status === 'in_progress';
  const openBlockers = (t.blockedBy ?? []).filter((id) => {
    const b = all.find((x) => x.id === id);
    return b && b.status !== 'completed';
  });
  const blocked = !done && openBlockers.length > 0;
  const Icon = done ? CheckCircle2 : blocked ? OctagonMinus : active ? CircleDot : Circle;
  return (
    <div className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-900">
      <Icon
        size={16}
        className={`mt-0.5 shrink-0 ${done ? 'text-emerald-500' : blocked ? 'text-red-400' : active ? 'text-amber-500' : 'text-zinc-300 dark:text-zinc-600'}`}
      />
      <div className="min-w-0 flex-1">
        <div className={`text-sm ${done ? 'text-zinc-400 line-through' : ''} ${active ? 'font-medium' : ''}`}>
          {t.id && <span className="mr-1.5 text-[11px] text-zinc-400 tabular-nums">#{t.id}</span>}
          {t.content}
        </div>
        {active && t.activeForm && <div className="text-xs text-amber-600 italic dark:text-amber-400">{t.activeForm}…</div>}
        {t.description && !done && (
          <div className="mt-0.5 truncate text-xs text-zinc-400" title={t.description}>{t.description}</div>
        )}
        {blocked && (
          <div className="mt-0.5 text-[11px] text-red-400">blocked by {openBlockers.map((b) => '#' + b).join(', ')}</div>
        )}
      </div>
      <span className="shrink-0 pt-0.5 text-[11px] text-zinc-400">{t.status}</span>
    </div>
  );
}

export default function PlanBoard({ session }: { session: SessionInfo }) {
  const tasks = session.todos;
  if (!tasks.length) {
    return <p className="py-10 text-center text-xs text-zinc-400">No tasks yet — the plan board reads the session's task store (and mirrors TaskCreate/TaskUpdate events).</p>;
  }
  const done = tasks.filter((t) => t.status === 'completed').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const sorted = [...tasks].sort((a, b) => (ORDER[a.status] ?? 1) - (ORDER[b.status] ?? 1) || Number(a.id) - Number(b.id));
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="max-w-3xl">
        <p className="mb-2 px-3 text-xs text-zinc-400">
          {tasks.length} task(s) · <span className="text-emerald-600 dark:text-emerald-400">{done} done</span>
          {inProgress > 0 && <> · <span className="text-amber-600 dark:text-amber-400">{inProgress} in progress</span></>}
          {' · '}{tasks.length - done - inProgress} open
        </p>
        {sorted.map((t, i) => <TaskRow key={t.id ?? i} t={t} all={tasks} />)}
      </div>
    </div>
  );
}
