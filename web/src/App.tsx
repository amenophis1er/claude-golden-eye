import { useEffect, useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { useDashboard } from './lib/useDashboard';
import { navigate, useRoute } from './lib/router';
import Sidebar from './components/Sidebar';
import SessionView from './components/SessionView';

export default function App() {
  const { state, connected } = useDashboard();
  const route = useRoute();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const session = useMemo(() => {
    if (!state) return null;
    return state.sessions.find((s) => s.id === route.sessionId) ?? state.sessions[0] ?? null;
  }, [state, route.sessionId]);

  // Keep the URL canonical once data arrives (deep-linkable tabs).
  useEffect(() => {
    if (session && route.sessionId !== session.id) navigate(session.id, route.tab);
  }, [session, route.sessionId, route.tab]);

  return (
    <div className="flex h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Sidebar state={state} connected={connected} now={now} selectedId={session?.id ?? null} tab={route.tab} />
      <main className="flex min-w-0 flex-1 flex-col">
        {session ? (
          <SessionView session={session} events={state?.events ?? []} tab={route.tab} now={now} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-400">
            <Eye size={40} strokeWidth={1.5} />
            <p className="text-sm">No sessions yet — start a Claude Code session and it will appear here.</p>
          </div>
        )}
      </main>
    </div>
  );
}
