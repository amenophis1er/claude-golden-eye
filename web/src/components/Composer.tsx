import { useState } from 'react';
import { KeyRound, Send } from 'lucide-react';
import type { SessionInfo } from '../lib/types';

/**
 * Prompt composer: continues the session headlessly via POST /api/continue
 * (claude -p --resume). Requires the server token once (persisted locally);
 * disabled while the session is mid-turn. The resumed turn streams back into
 * the feed via the normal hooks.
 */
export default function Composer({ session }: { session: SessionInfo }) {
  const [text, setText] = useState('');
  const [token, setToken] = useState(() => localStorage.getItem('ge-token') ?? '');
  const [needToken, setNeedToken] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const working = session.state === 'working';
  const canSend = !working && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setNote(null);
    try {
      const r = await fetch('/api/continue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ge-token': token },
        body: JSON.stringify({ sessionId: session.id, prompt: text.trim() }),
      });
      const j = await r.json();
      if (r.status === 401) {
        setNeedToken(true);
        setNote('Paste the server token (cat ~/.golden-eye/token) and send again.');
      } else if (!r.ok) {
        setNote(j.error ?? `error ${r.status}`);
      } else {
        setText('');
        setNeedToken(false);
        setNote('Sent — the turn is starting; watch the feed.');
      }
    } catch {
      setNote('server unreachable');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      {needToken && (
        <div className="mb-2 flex items-center gap-2">
          <KeyRound size={13} className="shrink-0 text-amber-500" />
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              localStorage.setItem('ge-token', e.target.value);
            }}
            placeholder="server token — cat ~/.golden-eye/token"
            className="w-96 rounded-md border border-zinc-300 bg-transparent px-2.5 py-1 font-mono text-xs outline-none focus:border-amber-500 dark:border-zinc-700"
          />
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          placeholder={
            working
              ? 'session is working — wait for the turn to finish'
              : `Continue this session… (Enter to send, Shift+Enter for newline)`
          }
          disabled={working}
          className="min-h-9 flex-1 resize-none rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-amber-500 disabled:opacity-50 dark:border-zinc-700"
        />
        <button
          onClick={send}
          disabled={!canSend}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 text-sm font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-40 dark:text-zinc-950"
        >
          <Send size={14} /> Send
        </button>
      </div>
      {note && <p className="mt-1.5 text-[11px] text-zinc-400">{note}</p>}
      <p className="mt-1 text-[10px] text-zinc-400">
        Runs <span className="font-mono">claude -p --resume</span> in the project — your open terminal won't display
        this exchange until you resume it there.
      </p>
    </div>
  );
}
