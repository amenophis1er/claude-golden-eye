import { useEffect, useState } from 'react';

export type Tab = 'feed' | 'agents' | 'timeline' | 'plan';
export interface Route { sessionId: string | null; tab: Tab }

function parse(): Route {
  const m = window.location.hash.match(/^#\/s\/([^/]+)(?:\/(\w+))?/);
  const tab = (m?.[2] as Tab) || 'feed';
  return {
    sessionId: m ? decodeURIComponent(m[1]) : null,
    tab: ['feed', 'agents', 'timeline', 'plan'].includes(tab) ? tab : 'feed',
  };
}

export function navigate(sessionId: string, tab: Tab = 'feed') {
  window.location.hash = `#/s/${encodeURIComponent(sessionId)}/${tab}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
