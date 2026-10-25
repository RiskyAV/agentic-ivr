import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { useStore } from '../store';
import { ActionCard } from './ActionCard';
import { AssistantAvatar, AssistantMessage, NoticeMessage, UserMessage } from './Message';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function Typing({ label }: { label?: string | undefined }) {
  return (
    <div className="flex gap-3" data-testid="typing">
      <AssistantAvatar />
      <div className="flex items-center gap-2.5 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
        <span className="flex gap-1" aria-hidden="true">
          {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-blink rounded-full bg-teal-600" style={{ animationDelay: `${i * 0.15}s` }} />)}
        </span>
        <span>{label ?? 'Thinking…'}</span>
      </div>
    </div>
  );
}

function Suggestions({ items, onPick, disabled }: { items: string[]; onPick: (s: string) => void; disabled: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="suggestions">
      {items.map((s) => (
        <button
          key={s} type="button" disabled={disabled} onClick={() => onPick(s)}
          className="rounded-full border border-teal-200 bg-white px-3.5 py-1.5 text-sm text-teal-800 transition hover:border-teal-300 hover:bg-teal-50 disabled:opacity-50"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

export function Chat({ suggestions, onSend }: { suggestions: string[]; onSend: (text: string) => boolean }) {
  const items = useStore((s) => s.items);
  const activeTurn = useStore((s) => s.activeTurn);
  const name = useStore((s) => s.session?.customer.name ?? '');
  const connected = useStore((s) => s.connection === 'open');
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const asked = useMemo(() => new Set(items.filter((i) => i.kind === 'user').map((i) => i.text.trim().toLowerCase())), [items]);
  const nextPrompts = suggestions.filter((s) => !asked.has(s.toLowerCase())).slice(0, 3);
  const turnHasText = activeTurn ? items.some((i) => i.kind === 'assistant' && i.turnId === activeTurn.turnId && i.text.length > 0) : false;
  const last = items.at(-1);
  const showFollowUps = !activeTurn && items.length > 0 && last?.kind === 'assistant' && !last.streaming;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, activeTurn]);

  return (
    <div ref={scroller} className="pane-scroll min-h-0 flex-1 overflow-y-auto" data-testid="chat">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
        {items.length === 0 && !activeTurn && (
          <div className="py-6 sm:py-12">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><Sparkles className="h-5 w-5" /></div>
            <h2 className="mt-4 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{greeting()}{name ? `, ${name.split(' ')[0]}` : ''}.</h2>
            <p className="mt-1.5 max-w-lg text-[15px] text-slate-500">I can explain your EMI, check payments, run prepayment and foreclosure numbers, and raise requests for you. Every figure comes from your account.</p>
            <div className="mt-6"><Suggestions items={nextPrompts} onPick={onSend} disabled={!connected} /></div>
          </div>
        )}
        {items.map((it) => {
          switch (it.kind) {
            case 'user': return <UserMessage key={it.id} item={it} />;
            case 'assistant': return <AssistantMessage key={it.id} item={it} />;
            case 'proposal': return <div key={it.id} className="sm:pl-11"><ActionCard item={it} /></div>;
            case 'notice': return <NoticeMessage key={it.id} item={it} />;
          }
        })}
        {activeTurn && !turnHasText && <Typing label={activeTurn.progress} />}
        {activeTurn && turnHasText && activeTurn.progress && (
          <p className="-mt-3 pl-11 text-xs text-slate-400">{activeTurn.progress}</p>
        )}
        {showFollowUps && <div className="sm:pl-11"><Suggestions items={nextPrompts} onPick={onSend} disabled={!connected} /></div>}
      </div>
    </div>
  );
}
