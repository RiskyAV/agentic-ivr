import { useStore } from '../store';

export function ConnectionPill() {
  const c = useStore((s) => s.connection);
  const view =
    c === 'open' ? { dot: 'bg-emerald-400', text: 'Live', cls: 'text-emerald-200' }
    : c === 'connecting' ? { dot: 'bg-amber-400 animate-pulse', text: 'Connecting', cls: 'text-amber-200' }
    : c === 'reconnecting' ? { dot: 'bg-amber-400 animate-pulse', text: 'Reconnecting', cls: 'text-amber-200' }
    : { dot: 'bg-slate-400', text: 'Offline', cls: 'text-slate-300' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-2 py-1 text-[11px] font-medium ring-1 ring-white/10 ${view.cls}`} data-testid="connection" data-state={c} title={`Connection: ${view.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${view.dot}`} />
      <span className="hidden sm:inline">{view.text}</span>
    </span>
  );
}
