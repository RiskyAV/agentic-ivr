import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp } from 'lucide-react';
import { useStore } from '../store';
import { VoiceButton } from './VoiceButton';
import { VoiceStatus } from './VoiceStatus';

export function Composer({ onSend }: { onSend: (text: string) => boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const connected = useStore((s) => s.connection === 'open');
  const busy = useStore((s) => s.activeTurn !== null);
  const canSend = connected && !busy && text.trim().length > 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const send = () => {
    if (!canSend) return;
    if (onSend(text.trim())) setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  return (
    <div className="border-t border-slate-200 bg-white/90 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:px-6">
      <VoiceStatus />
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <div className="flex min-w-0 flex-1 items-end rounded-2xl border border-slate-300 bg-white pl-4 pr-1.5 shadow-sm focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/15">
          <textarea
            ref={ref} rows={1} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            placeholder={connected ? 'Ask about your loan…' : 'Connecting…'} aria-label="Message"
            className="max-h-[140px] min-h-[44px] flex-1 resize-none bg-transparent py-[11px] text-[15px] leading-snug text-slate-900 outline-none placeholder:text-slate-400"
          />
          <button
            type="button" onClick={send} disabled={!canSend} aria-label="Send"
            className="mb-1.5 ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-600 text-white transition hover:bg-teal-700 disabled:bg-slate-200 disabled:text-slate-400"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-0.5"><VoiceButton /></div>
      </div>
      <p className="mx-auto mt-1.5 hidden max-w-3xl px-1 text-[11px] text-slate-400 sm:block">Answers use your live account data. Nothing is changed without your confirmation.</p>
    </div>
  );
}
