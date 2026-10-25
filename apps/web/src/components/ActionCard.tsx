import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Clock3, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import type { ChatItem } from '../store';
import { useStore } from '../store';
import { socket } from '../socket';

type ProposalItem = Extract<ChatItem, { kind: 'proposal' }>;

function useCountdown(expiresAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Math.max(0, expiresAt - now);
}

const HEADINGS: Record<ProposalItem['status'], string> = {
  pending: 'Review and confirm', confirming: 'Review and confirm', executed: 'Completed', failed: 'Not completed', rejected: 'Cancelled', expired: 'Expired',
};

const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function ActionCard({ item }: { item: ProposalItem }) {
  const { proposal: p, status } = item;
  const live = status === 'pending' || status === 'confirming';
  const left = useCountdown(p.expiresAt, live);
  const expire = useStore((s) => s.expire);
  const confirming = useStore((s) => s.confirming);
  const connected = useStore((s) => s.connection === 'open');

  useEffect(() => {
    if (status === 'pending' && left <= 0) expire(p.id);
  }, [left, status, p.id, expire]);

  const confirm = () => {
    if (socket.send({ type: 'confirm_action', proposalId: p.id, termsHash: p.termsHash })) confirming(p.id);
  };
  const cancel = () => { socket.send({ type: 'cancel_action', proposalId: p.id }); };

  const frame =
    status === 'executed' ? 'border-emerald-200' : status === 'failed' ? 'border-amber-200' : live ? 'border-teal-200 shadow-[0_6px_24px_-12px_rgba(13,148,136,0.45)]' : 'border-slate-200';

  return (
    <div className={`overflow-hidden rounded-xl border bg-white ${frame}`} data-testid="action-card" data-status={status}>
      <div className={`flex items-center justify-between gap-2 px-4 py-2 text-xs font-semibold ${live ? 'bg-teal-50 text-teal-800' : status === 'executed' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-50 text-slate-600'}`}>
        <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />{HEADINGS[status]}</span>
        {live && (
          <span className={`tnum flex items-center gap-1 font-medium ${left < 60_000 ? 'text-amber-700' : 'text-teal-700'}`}>
            <Clock3 className="h-3.5 w-3.5" />Expires in {mmss(left)}
          </span>
        )}
      </div>
      <div className="p-4">
        <h4 className="text-[15px] font-semibold text-slate-900">{p.title}</h4>
        {p.summary && <p className="mt-1 text-sm text-slate-600">{p.summary}</p>}
        {p.figures.length > 0 && (
          <dl className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-100 bg-slate-50/60">
            {p.figures.map((f, i) => (
              <div key={i} className="flex items-baseline justify-between gap-4 px-3 py-2 text-sm">
                <dt className="text-slate-600">{f.label}</dt>
                <dd className="tnum text-right font-semibold text-slate-900">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {live && (
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={cancel} disabled={status === 'confirming' || !connected}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">
              Cancel
            </button>
            <button type="button" onClick={confirm} disabled={status === 'confirming' || !connected}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-70">
              {status === 'confirming' ? <><Loader2 className="h-4 w-4 animate-spin" />Confirming…</> : 'Confirm'}
            </button>
          </div>
        )}
        {status === 'pending' && item.message && <p className="mt-3 text-xs text-amber-700">{item.message}</p>}

        {status === 'executed' && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 ring-1 ring-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Done{item.reference && <> · Reference <span className="tnum" data-testid="action-reference">{item.reference}</span></>}</p>
              {item.message && <p className="mt-0.5 text-emerald-700">{item.message}</p>}
            </div>
          </div>
        )}
        {status === 'failed' && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" /><p>{item.message ?? 'This request could not be completed. Nothing was changed.'}</p>
          </div>
        )}
        {status === 'rejected' && (
          <p className="mt-4 flex items-center gap-2 text-sm text-slate-500"><Ban className="h-4 w-4" />{item.message ?? 'Cancelled. Nothing was changed.'}</p>
        )}
        {status === 'expired' && (
          <p className="mt-4 flex items-center gap-2 text-sm text-slate-500"><Clock3 className="h-4 w-4" />{item.message ?? 'This offer expired. Ask again to get up-to-date terms.'}</p>
        )}
      </div>
    </div>
  );
}
