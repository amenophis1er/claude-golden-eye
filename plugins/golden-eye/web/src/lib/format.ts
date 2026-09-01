export function shortId(id?: string | null) { return id ? String(id).slice(0, 8) : '?'; }

export function baseName(p?: string | null) {
  return p ? String(p).split('/').filter(Boolean).pop() ?? '—' : '—';
}

export function clock(ts?: string | null) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function relTime(ts: string | null, now: number) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtDur(ms?: number | null) {
  if (ms == null) return '';
  return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** One-line human summary of a tool_input. */
export function toolSummary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.description ?? input.file_path ?? input.prompt ?? input.query ?? input.subject ?? input.skill ?? input.url ?? '';
  return String(v).slice(0, 160);
}

/** Parse the harness's <task-notification> prompt blob, or null if not one. */
export function parseTaskNotification(text: string | null | undefined) {
  if (!text || !/^\s*<task-notification>/.test(text)) return null;
  const tag = (name: string) => {
    const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? m[1].trim() : null;
  };
  return {
    taskId: tag('task-id'),
    status: tag('status'),
    summary: tag('summary'),
    result: tag('result'),
  };
}

export function fmtTokens(n?: number | null) {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}
