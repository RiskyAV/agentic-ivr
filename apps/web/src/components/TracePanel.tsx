import { useEffect, useState, type ReactNode } from 'react';
import { Activity, ChevronDown, FlaskConical, Gauge, X } from 'lucide-react';
import type { TurnTrace } from '@app/shared';
import { api, type MetricsResponse } from '../api';
import { ms } from '../format';
import { useStore } from '../store';
import { ChaosControls } from './ChaosControls';
import { colorFor, LEGEND, Waterfall } from './Waterfall';

function Tile({ label, stat, hint }: { label: string; stat?: { p50: number; p95: number; n: number } | undefined; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5" data-testid={`metric-${label}`}>
      <p className="truncate text-[11px] font-medium text-slate-500">{label}</p>
      {stat ? (
        <>
          <p className="tnum mt-1 text-[17px] font-semibold leading-none text-slate-900">{ms(stat.p50)}<span className="ml-1 text-[10px] font-medium text-slate-400">p50</span></p>
          <p className="tnum mt-1 text-[11px] text-slate-500">p95 {ms(stat.p95)} · n={stat.n}</p>
        </>
      ) : (
        <>
          <p className="mt-1 text-[17px] font-semibold leading-none text-slate-300">—</p>
          <p className="mt-1 text-[11px] text-slate-400">{hint ?? 'No samples yet'}</p>
        </>
      )}
    </div>
  );
}

function GuardBadge({ g }: { g: TurnTrace['guard'] }) {
  if (!g) return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">guard —</span>;
  const tone = g.verdict === 'allow' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : g.verdict === 'block' ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-amber-50 text-amber-700 ring-amber-200';
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${tone}`} title={g.category ?? ''}>guard {g.verdict}{g.category ? ` · ${g.category}` : ''} · {ms(g.ms)}</span>;
}

function TurnCard({ trace, question, open, onToggle }: { trace: TurnTrace; question?: string | undefined; open: boolean; onToggle: () => void }) {
  const m = trace.metrics;
  return (
    <div className="rounded-xl border border-slate-200 bg-white" data-testid="turn-trace">
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-2 p-3 text-left">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-slate-800">{question ?? (trace.turnId.startsWith('confirm-') ? 'Action confirmation' : 'Turn')}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <GuardBadge g={trace.guard} />
            {m.llm_first_token !== undefined && <span className="tnum rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">first token {ms(m.llm_first_token)}</span>}
            {m.turn_total !== undefined && <span className="tnum rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">total {ms(m.turn_total)}</span>}
            {(m.unverified ?? 0) > 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{m.unverified} unverified</span>}
          </div>
        </div>
        <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-slate-100 p-3"><Waterfall trace={trace} /></div>}
    </div>
  );
}

function Section({ icon, title, children, aside }: { icon: ReactNode; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{icon}{title}<span className="ml-auto normal-case tracking-normal">{aside}</span></h3>
      {children}
    </section>
  );
}

export function TracePanel({ onClose }: { onClose?: () => void }) {
  const traces = useStore((s) => s.traces);
  const items = useStore((s) => s.items);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => api.metrics().then((m) => { if (alive) setMetrics(m); }, () => {});
    void poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const latest = traces[0]?.turnId;
  useEffect(() => { setOpenId(null); }, [latest]);
  const questionFor = (turnId: string) => {
    const u = items.find((i) => i.kind === 'user' && i.turnId === turnId);
    return u?.kind === 'user' ? u.text : undefined;
  };
  const mm = metrics?.metrics ?? {};

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
        <h2 className="text-sm font-semibold text-slate-900">Under the hood</h2>
        {onClose && <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-4 w-4" /></button>}
      </div>
      <div className="pane-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <Section icon={<Gauge className="h-3.5 w-3.5" />} title="Latency (rolling)" aside={metrics ? <span className="text-[10px] text-slate-400">{metrics.sessions} live session{metrics.sessions === 1 ? '' : 's'}</span> : null}>
          <div className="grid grid-cols-3 gap-2">
            <Tile label="First token" stat={mm.llm_first_token} />
            <Tile label="Turn total" stat={mm.turn_total} />
            <Tile label="Voice → audio" stat={mm.voice_first_audio} hint="Voice not enabled" />
          </div>
        </Section>

        <Section icon={<Activity className="h-3.5 w-3.5" />} title="Turns"
          aside={<span className="flex items-center gap-2 text-[10px] text-slate-500">{LEGEND.map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${colorFor(k)}`} />{l}</span>)}</span>}>
          {traces.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-4 text-xs text-slate-500">Ask a question to see each step — model calls, tools and backend systems — with timings.</p>
          ) : (
            <div className="space-y-2">
              {traces.map((t) => (
                <TurnCard key={t.turnId} trace={t} question={questionFor(t.turnId)} open={(openId ?? latest) === t.turnId}
                  onToggle={() => setOpenId((openId ?? latest) === t.turnId ? '' : t.turnId)} />
              ))}
            </div>
          )}
        </Section>

        <Section icon={<FlaskConical className="h-3.5 w-3.5" />} title="Chaos controls">
          <ChaosControls />
        </Section>
      </div>
    </div>
  );
}
