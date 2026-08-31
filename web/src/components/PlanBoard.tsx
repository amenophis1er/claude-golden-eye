import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import type { SessionInfo } from '../lib/types';

export default function PlanBoard({ session }: { session: SessionInfo }) {
  if (!session.todos.length) {
    return <p className="py-10 text-center text-xs text-zinc-400">No tasks yet — the plan board mirrors TaskCreate/TaskUpdate (and legacy TodoWrite) events.</p>;
  }
  return (
    <div className="mx-auto max-w-2xl p-5">
      {session.todos.map((t, i) => {
        const done = t.status === 'completed';
        const active = t.status === 'in_progress';
        const Icon = done ? CheckCircle2 : active ? CircleDot : Circle;
        return (
          <div key={t.id ?? i} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-900">
            <Icon size={16} className={done ? 'text-emerald-500' : active ? 'text-amber-500' : 'text-zinc-300 dark:text-zinc-600'} />
            <span className={`flex-1 text-sm ${done ? 'text-zinc-400 line-through' : ''} ${active ? 'font-medium' : ''}`}>{t.content}</span>
            <span className="text-[11px] text-zinc-400">{t.status}</span>
          </div>
        );
      })}
    </div>
  );
}
