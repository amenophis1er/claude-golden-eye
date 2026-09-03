import { useEffect, useMemo, useState } from 'react';
import Logo from './components/Logo';
import { useDashboard } from './lib/useDashboard';
import { navigate, useRoute } from './lib/router';
import Sidebar from './components/Sidebar';
import SessionView from './components/SessionView';
import HistoryView from './components/HistoryView';
import ArtifactsView from './components/ArtifactsView';
import FileViewerProvider from './components/FileViewer';

export default function App() {
  const { state, connected } = useDashboard();
  const route = useRoute();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const session = useMemo(() => {
    if (!state || route.history || route.artifacts) return null;
    return state.sessions.find((s) => s.id === route.sessionId) ?? state.sessions[0] ?? null;
  }, [state, route.sessionId, route.history, route.artifacts]);

  // Keep the URL canonical once data arrives (deep-linkable tabs).
  useEffect(() => {
    if (!route.history && !route.artifacts && session && route.sessionId !== session.id) navigate(session.id, route.tab, route.sub);
  }, [session, route.sessionId, route.tab, route.history, route.artifacts]);

  return (
    <FileViewerProvider enabled={!!state?.filesEnabled}>
    <div className="flex h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Sidebar
        state={state}
        connected={connected}
        now={now}
        selectedId={session?.id ?? null}
        tab={route.tab}
        historyActive={!!route.history}
        artifactsActive={route.artifacts}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {route.artifacts ? (
          <ArtifactsView now={now} />
        ) : route.history ? (
          <HistoryView dir={route.history.dir} id={route.history.id} now={now} />
        ) : session ? (
          <SessionView session={session} events={state?.events ?? []} tab={route.tab} sub={route.sub} now={now} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-400">
            <Logo size={44} className="opacity-70" />
            <p className="text-sm">No sessions yet — start a Claude Code session and it will appear here.</p>
          </div>
        )}
      </main>
    </div>
    </FileViewerProvider>
  );
}
