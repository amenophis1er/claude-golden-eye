import { useEffect, useState } from 'react';

export type Tab = 'feed' | 'agents' | 'timeline' | 'plan';
export interface Route {
  sessionId: string | null;
  tab: Tab;
  sub: string | null;
  /** Read-only history browser: list (#/history), a project's sessions, or one transcript. */
  history: { dir: string | null; id: string | null } | null;
  /** Published-artifacts list (#/artifacts). */
  artifacts: boolean;
}

function parse(): Route {
  if (/^#\/artifacts/.test(window.location.hash)) {
    return { sessionId: null, tab: 'feed', sub: null, history: null, artifacts: true };
  }
  const h = window.location.hash.match(/^#\/history(?:\/([^/]+))?(?:\/([^/?#]+))?/);
  if (h) {
    return {
      sessionId: null,
      tab: 'feed',
      sub: null,
      history: { dir: h[1] ? decodeURIComponent(h[1]) : null, id: h[2] ? decodeURIComponent(h[2]) : null },
      artifacts: false,
    };
  }
  const m = window.location.hash.match(/^#\/s\/([^/]+)(?:\/(\w+))?(?:\/([^/?#]+))?/);
  const tab = (m?.[2] as Tab) || 'feed';
  return {
    sessionId: m ? decodeURIComponent(m[1]) : null,
    tab: ['feed', 'agents', 'timeline', 'plan'].includes(tab) ? tab : 'feed',
    sub: m?.[3] ? decodeURIComponent(m[3]) : null,
    history: null,
    artifacts: false,
  };
}

export function navigate(sessionId: string, tab: Tab = 'feed', sub?: string | null) {
  window.location.hash = `#/s/${encodeURIComponent(sessionId)}/${tab}${sub ? '/' + encodeURIComponent(sub) : ''}`;
}

export function navigateHistory(dir?: string | null, id?: string | null) {
  window.location.hash =
    '#/history' + (dir ? '/' + encodeURIComponent(dir) + (id ? '/' + encodeURIComponent(id) : '') : '');
}

export function navigateArtifacts() {
  window.location.hash = '#/artifacts';
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
