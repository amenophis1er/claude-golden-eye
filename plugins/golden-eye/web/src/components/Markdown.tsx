import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useOpenFile } from './FileViewer';

// A code span worth trying as a file: has a slash or a known-ish extension,
// no spaces, and stays short. Deliberately optimistic — the click resolves it
// server-side and says "not found" rather than us guessing here, which keeps
// prose like `docs/decisions/policy.md` clickable without a lookup per span.
const PATH_RE = /^(?!https?:)[\w./@~-]+(?:\/[\w./@~-]+)*\.[A-Za-z][\w]{0,9}$|^[\w.@~-]+(?:\/[\w.@~-]+)+\/?$/;
function looksLikePath(s: string) {
  return s.length > 1 && s.length <= 200 && !/\s/.test(s) && PATH_RE.test(s);
}

/**
 * Reusable markdown renderer: GFM via marked, sanitized with DOMPurify
 * (agent output is our own data, but it can embed arbitrary HTML — never
 * trust it into the DOM raw). Styling comes from the global `.md` rules.
 *
 * When a session is in context and file viewing is enabled, path-shaped code
 * spans become clickable and open in the file viewer.
 */
export default function Markdown({ text, className = '', sessionId }: {
  text: string; className?: string; sessionId?: string | null;
}) {
  const openFile = useOpenFile();
  const linkPaths = !!(openFile && sessionId);

  const html = useMemo(() => {
    const raw = marked.parse(text, { gfm: true, breaks: true, async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);

  // Delegated click: one handler for the whole block, so linkifying costs
  // nothing per span and survives re-renders of sanitized HTML.
  const onClick = linkPaths
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        const el = (e.target as HTMLElement).closest('code');
        if (!el || el.parentElement?.tagName === 'PRE') return; // inline code only
        const candidate = (el.textContent ?? '').trim();
        if (!looksLikePath(candidate)) return;
        e.preventDefault();
        openFile!(sessionId!, candidate);
      }
    : undefined;

  return (
    <div
      className={`md ${linkPaths ? 'md-paths' : ''} ${className}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
