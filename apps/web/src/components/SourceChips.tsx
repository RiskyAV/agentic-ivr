import { useEffect, useRef, useState } from 'react';
import { BookText, Calculator, Database, X } from 'lucide-react';
import type { Source } from '@app/shared';

const KIND = {
  record: { icon: Database, label: 'Account record', tint: 'text-sky-700 bg-sky-50 ring-sky-200' },
  clause: { icon: BookText, label: 'Policy clause', tint: 'text-violet-700 bg-violet-50 ring-violet-200' },
  calc: { icon: Calculator, label: 'Calculation', tint: 'text-teal-700 bg-teal-50 ring-teal-200' },
} as const;

const SYSTEM: Record<string, string> = { crm: 'Customer records', lms: 'Loan management system', payments: 'Payments', policy: 'Policy library', ops: 'Service operations' };

export function SourceChips({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (sources.length === 0) return null;
  const active = open !== null ? sources[open] : undefined;
  return (
    <div ref={ref} className="relative mt-3">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Sources</p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((s, i) => {
          const k = KIND[s.kind];
          const Icon = k.icon;
          return (
            <button
              key={`${s.kind}:${s.ref}:${i}`} type="button" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition ${k.tint} ${open === i ? 'ring-2' : 'hover:brightness-95'}`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{s.kind === 'clause' ? `${s.ref} · ${s.label}` : s.label}</span>
            </button>
          );
        })}
      </div>
      {active && (
        <div role="dialog" className="absolute left-0 right-0 z-20 mt-2 rounded-xl border border-slate-200 bg-white p-4 shadow-xl sm:right-auto sm:w-[420px]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{KIND[active.kind].label}{active.system ? ` · ${SYSTEM[active.system] ?? active.system}` : ''}</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{active.label}</p>
              <p className="tnum mt-0.5 text-xs text-slate-500">Ref {active.ref}</p>
            </div>
            <button type="button" onClick={() => setOpen(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close"><X className="h-4 w-4" /></button>
          </div>
          {active.detail && <p className="pane-scroll mt-3 max-h-56 overflow-y-auto whitespace-pre-line rounded-lg bg-slate-50 p-3 text-[13px] leading-relaxed text-slate-700">{active.detail}</p>}
          {!active.detail && active.kind === 'record' && <p className="mt-3 text-xs text-slate-500">Figures in this answer were read live from this record.</p>}
        </div>
      )}
    </div>
  );
}
