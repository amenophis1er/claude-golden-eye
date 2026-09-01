import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashState } from './types';

export function useDashboard() {
  const [state, setState] = useState<DashState | null>(null);
  const [connected, setConnected] = useState(false);
  const debounceRef = useRef<number | null>(null);

  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/state');
      if (r.ok) setState(await r.json());
    } catch {
      /* server restarting — SSE reconnect will trigger the next refetch */
    }
  }, []);

  useEffect(() => {
    refetch();
    const es = new EventSource('/api/events');
    es.onopen = () => { setConnected(true); refetch(); };
    es.onerror = () => setConnected(false);
    es.addEventListener('hook', () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(refetch, 200);
    });
    return () => es.close();
  }, [refetch]);

  return { state, connected, refetch };
}

export async function pruneSessions(body: { sessionIds?: string[]; staleBefore?: string }) {
  await fetch('/api/prune', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
