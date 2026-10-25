import type { SpanView, TurnTrace } from '@app/shared';
import { ms } from '../format';

export interface Row { name: string; start: number; end: number; kind: string; failed: boolean; title: string }

const COLORS: Record<string, string> = {
  llm: 'bg-violet-500', tool: 'bg-teal-500', backend: 'bg-sky-500', guard: 'bg-slate-400', tts: 'bg-orange-400',
  snapshot: 'bg-slate-300', policy: 'bg-amber-400', mark: 'bg-slate-500', other: 'bg-slate-400',
};
export const LEGEND: [string, string][] = [['llm', 'LLM'], ['tool', 'Tool'], ['backend', 'Backend'], ['guard', 'Guard']];
export const colorFor = (kind: string, failed = false) => (failed ? 'bg-red-500' : COLORS[kind] ?? COLORS.other!);

function kindOf(name: string): string {
  if (name === 'llm' || name.startsWith('llm')) return 'llm';
  if (name.startsWith('tool:')) return 'tool';
  if (name.startsWith('backend:')) return 'backend';
  if (name.startsWith('tts')) return 'tts';
  if (name.startsWith('policy_')) return 'policy';
  if (name === 'snapshot') return 'snapshot';
  if (name === 'guard') return 'guard';
  return 'other';
}

function label(s: SpanView): string {
  const a = s.attrs ?? {};
  if (s.name === 'llm') return `LLM${a.round !== undefined ? ` · round ${a.round}` : ''}`;
  if (s.name.startsWith('tool:')) return s.name.slice(5);
  if (s.name.startsWith('backend:')) {
    const extra = Number(a.attempt) > 1 ? ` · try ${a.attempt}` : a.hedged ? ' · hedged' : '';
    return `${s.name.slice(8)}${extra}`;
  }
  return s.name.replace(/_/g, ' ');
}

export function rowsFor(t: TurnTrace): { rows: Row[]; total: number } {
  const rows: Row[] = t.spans.map((s) => {
    const a = s.attrs ?? {};
    const failed = (typeof a.outcome === 'string' && !/^(ok|success|cached|stale)$/.test(a.outcome)) || a.error !== undefined;
    const attrs = Object.entries(a).map(([k, v]) => `${k}: ${String(v)}`).join('\n');
    return { name: label(s), start: s.startMs, end: s.endMs, kind: kindOf(s.name), failed, title: `${s.name} · ${ms(s.endMs - s.startMs)}${attrs ? `\n${attrs}` : ''}` };
  });
  if (t.guard) {
    rows.unshift({ name: `guard · ${t.guard.verdict}`, start: 0, end: t.guard.ms, kind: 'guard', failed: t.guard.verdict === 'block', title: `guard ${t.guard.verdict}${t.guard.category ? ` (${t.guard.category})` : ''} · ${ms(t.guard.ms)}` });
  }
  const total = Math.max(t.metrics.turn_total ?? 0, ...rows.map((r) => r.end), 1);
  return { rows, total };
}

export function Waterfall({ trace }: { trace: TurnTrace }) {
  const { rows, total } = rowsFor(trace);
  if (rows.length === 0) return <p className="text-xs text-slate-400">No spans recorded.</p>;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="text-[11px]" data-testid="waterfall">
      <div className="relative mb-1 ml-[104px] h-3 text-slate-400">
        {ticks.map((t) => (
          <span key={t} className="tnum absolute whitespace-nowrap" style={{ left: `${t * 100}%`, transform: t === 1 ? 'translateX(-100%)' : t === 0 ? 'none' : 'translateX(-50%)' }}>{ms(t * total)}</span>
        ))}
      </div>
      <ul className="space-y-1">
        {rows.map((r, i) => {
          const left = (r.start / total) * 100;
          const width = Math.max(((r.end - r.start) / total) * 100, 0.6);
          const point = r.end - r.start < 0.5;
          return (
            <li key={i} className="flex items-center gap-1.5" title={r.title} data-span={r.kind} data-duration={Math.round(r.end - r.start)}>
              <span className={`w-[98px] shrink-0 truncate ${r.failed ? 'text-red-600' : 'text-slate-600'}`}>{r.name}</span>
              <div className="relative h-4 flex-1 rounded bg-slate-100">
                {point ? (
                  <span className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 ${colorFor(r.kind, r.failed)}`} style={{ left: `${left}%` }} />
                ) : (
                  <span className={`absolute inset-y-0.5 rounded-sm ${colorFor(r.kind, r.failed)}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
                )}
                {!point && (() => {
                  // Label after the bar; near the right edge, inside a wide bar or before a narrow one.
                  const nearEnd = left + width > 72;
                  const inside = nearEnd && width >= 16;
                  const style = !nearEnd ? { left: `${left + width}%` } : inside ? { right: `${Math.max(0, 100 - left - width)}%` } : { right: `${100 - left}%` };
                  return <span className={`tnum absolute top-1/2 -translate-y-1/2 whitespace-nowrap px-1 text-[10px] font-medium ${inside ? 'text-white' : 'text-slate-600'}`} style={style}>{ms(r.end - r.start)}</span>;
                })()}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
