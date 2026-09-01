import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Reusable markdown renderer: GFM via marked, sanitized with DOMPurify
 * (agent output is our own data, but it can embed arbitrary HTML — never
 * trust it into the DOM raw). Styling comes from the global `.md` rules.
 */
export default function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { gfm: true, breaks: true, async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
