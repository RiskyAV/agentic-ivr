import { useEffect, useState } from 'react';
import { Loader2, RotateCcw, Zap } from 'lucide-react';
import type { SystemName } from '@app/shared';
import { api, SYSTEMS } from '../api';
import { useStore, type ChaosConfig } from '../store';

const NAMES: Record<SystemName, string> = { crm: 'CRM', lms: 'Loan system', payments: 'Payments', policy: 'Policy', ops: 'Service ops' };

export function ChaosControls() {
  const server = useStore((s) => s.chaos);
  const setChaos = useStore((s) => s.setChaos);
  const [draft, setDraft] = useState<ChaosConfig | null>(server);
  const [busy, setBusy] = useState<'apply' | 'reset' | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    api.chaos().then((c) => { if (alive) { setChaos(c); setDraft(c); } }, () => { if (alive) setMsg({ text: 'Could not load chaos settings.', ok: false }); });
    return () => { alive = false; };
  }, [setChaos]);

  const dirty = !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server);
  const edit = (s: SystemName, patch: Partial<ChaosConfig[SystemName]>) => setDraft((d) => (d ? { ...d, [s]: { ...d[s], ...patch } } : d));

  async function apply() {
    if (!draft) return;
    setBusy('apply'); setMsg(null);
    try { const c = await api.setChaos(draft); setChaos(c); setDraft(c); setMsg({ text: 'Applied. The next backend calls use these settings.', ok: true }); }
    catch (e) { setMsg({ text: e instanceof Error ? e.message : 'Apply failed.', ok: false }); }
    finally { setBusy(null); }
  }
  async function reset() {
    setBusy('reset'); setMsg(null);
    try { await api.resetChaos(); const c = await api.chaos(); setChaos(c); setDraft(c); setMsg({ text: 'Reset to defaults. Demo data was restored too.', ok: true }); }
    catch (e) { setMsg({ text: e instanceof Error ? e.message : 'Reset failed.', ok: false }); }
    finally { setBusy(null); }
  }

  if (!draft) return <div className="h-40 animate-pulse rounded-xl bg-slate-100" />;
  return (
    <div data-testid="chaos">
      <div className="space-y-2">
        {SYSTEMS.map((s) => {
          const c = draft[s];
          const hot = c.extraLatencyMs > 0 || c.hang || c.failRate > (server?.[s].failRate ?? 0);
          return (
            <div key={s} className={`rounded-lg border p-2.5 ${hot ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200'}`} data-system={s}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">{NAMES[s]}</span>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
                  Hang
                  <input type="checkbox" className="peer sr-only" checked={c.hang} onChange={(e) => edit(s, { hang: e.target.checked })} />
                  <span className="relative h-4 w-7 rounded-full bg-slate-300 transition peer-checked:bg-red-500 after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-3" />
                </label>
              </div>
              <div className="mt-1.5 grid grid-cols-[64px_1fr_56px] items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                <span>Latency</span>
                <input aria-label={`${NAMES[s]} extra latency`} type="range" min={0} max={5000} step={250} value={c.extraLatencyMs} onChange={(e) => edit(s, { extraLatencyMs: Number(e.target.value) })} />
                <span className="tnum text-right font-medium text-slate-700">+{Number((c.extraLatencyMs / 1000).toFixed(2))} s</span>
                <span>Fail rate</span>
                <input aria-label={`${NAMES[s]} fail rate`} type="range" min={0} max={100} step={5} value={Math.round(c.failRate * 100)} onChange={(e) => edit(s, { failRate: Number(e.target.value) / 100 })} />
                <span className="tnum text-right font-medium text-slate-700">{Math.round(c.failRate * 100)}%</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={apply} disabled={!dirty || busy !== null}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-navy-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-navy-800 disabled:opacity-40">
          {busy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}Apply
        </button>
        <button type="button" onClick={reset} disabled={busy !== null} title="Restores default latency and failure rates, and the demo data"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40">
          {busy === 'reset' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}Reset all
        </button>
      </div>
      {msg && <p className={`mt-2 text-[11px] ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}
