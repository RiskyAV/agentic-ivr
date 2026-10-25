import type { ReactNode } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, CircleAlert, ClipboardList, Clock3, ReceiptText } from 'lucide-react';
import type { LoanCardView, PaymentRowView, ServiceRequestView, SnapshotView } from '@app/shared';
import { formatDate, formatInr, formatPct, humanise, productLabel, requestLabel, titleCase } from '../format';

const isOverdue = (l: LoanCardView) => l.overduePaise > 0 || (l.daysPastDue ?? 0) > 0;

export function StatusBadge({ loan }: { loan: LoanCardView }) {
  if (isOverdue(loan)) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-red-200">Overdue {loan.daysPastDue ?? 0} days</span>;
  }
  if (loan.status === 'closed') return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">Closed</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Active</span>;
}

function LoanCard({ loan }: { loan: LoanCardView }) {
  const od = isOverdue(loan);
  return (
    <article className={`rounded-xl border bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${od ? 'border-red-200' : 'border-slate-200'}`}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{productLabel(loan.product)}</h3>
          <p className="tnum mt-0.5 text-xs text-slate-500">{loan.loanId}</p>
        </div>
        <StatusBadge loan={loan} />
      </header>
      <div className="mt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Outstanding</p>
        <p className="tnum mt-0.5 text-[22px] font-semibold tracking-tight text-slate-900">{formatInr(loan.outstandingPaise)}</p>
      </div>
      {od && (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <span className="flex items-center gap-1.5 font-medium"><CircleAlert className="h-4 w-4" />Overdue amount</span>
          <span className="tnum font-semibold">{formatInr(loan.overduePaise)}</span>
        </div>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-slate-100 pt-3 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Next EMI</dt>
          <dd className="tnum font-semibold text-slate-900">{formatInr(loan.emiPaise)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Due date</dt>
          <dd className="tnum font-medium text-slate-800">{loan.nextDueDate ? formatDate(loan.nextDueDate) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Interest rate</dt>
          <dd className="tnum font-medium text-slate-800">{formatPct(loan.annualRateBps)} <span className="text-xs font-normal text-slate-500">{titleCase(loan.rateType)}</span></dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Tenure left</dt>
          <dd className="tnum font-medium text-slate-800">{loan.remainingMonths} <span className="text-xs font-normal text-slate-500">of {loan.tenureMonths} months</span></dd>
        </div>
      </dl>
    </article>
  );
}

function PaymentRow({ p }: { p: PaymentRowView }) {
  const failed = p.status === 'failed';
  const pending = p.status === 'pending';
  return (
    <li className={`rounded-lg px-3 py-2.5 ${failed ? 'bg-amber-50 ring-1 ring-amber-200' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {failed ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> : pending ? <Clock3 className="h-4 w-4 shrink-0 text-slate-400" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
          <div className="min-w-0">
            <p className="tnum text-sm font-medium text-slate-800">{formatDate(p.date)}</p>
            <p className="tnum truncate text-xs text-slate-500">{p.loanId}{p.mode ? ` · ${p.mode}` : ''}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="tnum text-sm font-semibold text-slate-900">{formatInr(p.amountPaise)}</p>
          <p className={`text-xs font-medium ${failed ? 'text-amber-700' : pending ? 'text-slate-500' : 'text-emerald-700'}`}>{failed ? 'Failed' : pending ? 'Pending' : 'Paid'}</p>
        </div>
      </div>
      {failed && p.note && <p className="mt-1.5 pl-6 text-xs leading-snug text-amber-800">{humanise(p.note)}</p>}
    </li>
  );
}

function RequestRow({ r }: { r: ServiceRequestView }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800">{requestLabel(r.type)}</p>
        <p className="tnum text-xs text-slate-500">{r.id}{r.loanId ? ` · ${r.loanId}` : ''}</p>
        {r.detail && <p className="text-xs text-slate-500">{humanise(r.detail)} · raised {formatDate(r.createdAt.slice(0, 10))}</p>}
      </div>
      <div className="shrink-0 text-right">
        {r.amountPaise !== undefined && <p className="tnum text-sm font-semibold text-slate-900">{formatInr(r.amountPaise)}</p>}
        <p className="inline-flex items-center gap-1 text-xs font-medium text-sky-700"><span className="h-1.5 w-1.5 rounded-full bg-sky-500" />{titleCase(r.status)}</p>
      </div>
    </li>
  );
}

function Section({ icon, title, children, count }: { icon: ReactNode; title: string; children: ReactNode; count?: number }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-2">
      <h3 className="flex items-center gap-2 px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {icon}{title}{count !== undefined && <span className="tnum ml-auto rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-600">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

export function AccountPanel({ snapshot }: { snapshot: SnapshotView | null }) {
  if (!snapshot) {
    return (
      <div className="space-y-3 p-4" aria-busy="true">
        <div className="h-48 animate-pulse rounded-xl bg-slate-200/60" />
        <div className="h-40 animate-pulse rounded-xl bg-slate-200/60" />
      </div>
    );
  }
  const requests = snapshot.openRequests;
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-slate-900">Your loans</h2>
        <span className="text-[11px] text-slate-400">Updated {new Date(snapshot.asOf).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      {snapshot.partial && snapshot.partial.length > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">Some details could not be refreshed just now ({snapshot.partial.join(', ')}). Figures shown may be incomplete.</p>
      )}
      {snapshot.loans.map((l) => <LoanCard key={l.loanId} loan={l} />)}
      {snapshot.loans.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">No loans to show.</p>}

      <Section icon={<ReceiptText className="h-3.5 w-3.5" />} title="Recent payments">
        {snapshot.recentPayments.length === 0 ? <p className="px-3 pb-2 text-sm text-slate-500">No payments yet.</p> : (
          <ul className="space-y-1">{snapshot.recentPayments.map((p) => <PaymentRow key={p.paymentId} p={p} />)}</ul>
        )}
      </Section>

      <Section icon={<ClipboardList className="h-3.5 w-3.5" />} title="Open requests" {...(requests && { count: requests.length })}>
        {!requests ? <p className="px-3 pb-2 text-sm text-slate-500">Requests are unavailable right now.</p>
          : requests.length === 0 ? <p className="px-3 pb-2 text-sm text-slate-500">No open requests.</p>
          : <ul className="divide-y divide-slate-100" data-testid="open-requests">{requests.map((r) => <RequestRow key={r.id} r={r} />)}</ul>}
      </Section>
    </div>
  );
}

/** Phone layout: a compact strip above the chat; tapping it opens the full panel. */
export function AccountStrip({ snapshot, onOpen }: { snapshot: SnapshotView | null; onOpen: () => void }) {
  if (!snapshot) return <div className="h-[68px] animate-pulse border-b border-slate-200 bg-white" />;
  return (
    <button type="button" onClick={onOpen} className="flex w-full gap-2 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2.5 text-left">
      {snapshot.loans.map((l) => (
        <div key={l.loanId} className="min-w-0 flex-1 basis-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-slate-800">{productLabel(l.product)}</span>
            <StatusBadge loan={l} />
          </div>
          <p className="tnum mt-0.5 truncate text-xs text-slate-500">
            EMI <span className="font-semibold text-slate-800">{formatInr(l.emiPaise)}</span>
            {l.nextDueDate && <> · <CalendarClock className="mb-0.5 inline h-3 w-3" /> {formatDate(l.nextDueDate)}</>}
          </p>
        </div>
      ))}
      <span className="self-center whitespace-nowrap text-xs font-medium text-teal-700">Details</span>
    </button>
  );
}
