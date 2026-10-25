import { daysBetween, today, type Paise, type ProductType, type RateType } from '@app/domain';
import type { LoanCardView, SnapshotView, SystemName } from '@app/shared';
import type { CallCtx, Connectors } from '../connectors/clients.js';
import type { CrmCustomer, LoanRecordDto, PaymentDto } from '../connectors/types.js';
import { redact } from './redact.js';

export interface LastPayment {
  date: string;
  amount: Paise;
  status: 'success' | 'failed' | 'pending';
}
export interface RecentPayment {
  loanId: string;
  date: string;
  amount: Paise;
  status: 'success' | 'failed' | 'pending';
  paymentId?: string;
  failureReason?: string;
}
export interface LoanSummary {
  loanId: string;
  product: ProductType;
  rateType: RateType;
  outstanding: Paise;
  emi: Paise;
  annualRateBps: number;
  nextDueDate: string | null;
  /** Unpaid instalments past due, in paise; 0 if none. */
  overdueAmount: Paise;
  daysPastDue: number;
  lastPayment?: LastPayment;
  // carried for the UI card
  principal: Paise;
  tenureMonths: number;
  remainingMonths: number;
  status: string;
}
export interface CustomerSnapshot {
  customerId: string;
  /** PII already masked. Absent when CRM was unavailable. */
  customer?: CrmCustomer;
  loans: LoanSummary[];
  /** Most recent 5 payment rows across all loans, newest first. */
  recentPayments: RecentPayment[];
  fetchedAt: string;
  partial: SystemName[];
}

/** Overdue = pending payments due on or before today; days past due runs from the oldest such date. */
function overdue(pays: PaymentDto[], on: string): { amount: Paise; days: number } {
  const due = pays.filter((p) => p.status === 'pending' && p.date <= on);
  if (due.length === 0) return { amount: 0, days: 0 };
  const oldest = due.map((p) => p.date).sort()[0]!;
  return { amount: due.reduce((t, p) => t + p.amount, 0), days: Math.max(0, daysBetween(oldest, on)) };
}

export async function loadSnapshot(c: Connectors, customerId: string, ctx: CallCtx): Promise<CustomerSnapshot> {
  const partial = new Set<SystemName>();
  const on = today();
  const [cust, loansRes] = await Promise.all([c.crm.getCustomer(customerId, ctx), c.lms.getLoans(customerId, ctx)]);
  if (!cust.ok) partial.add('crm');
  if (!loansRes.ok) partial.add('lms');

  const base = loansRes.ok ? loansRes.data : [];
  const allPays: PaymentDto[] = [];
  const loans = await Promise.all(
    base.map(async (s): Promise<LoanSummary> => {
      const [detail, pays] = await Promise.all([c.lms.getLoan(s.loanId, ctx), c.payments.list(s.loanId, {}, ctx)]);
      if (!detail.ok) partial.add('lms');
      if (!pays.ok) partial.add('payments');
      const l: LoanRecordDto = detail.ok ? detail.data : s;
      const list = pays.ok ? pays.data : [];
      allPays.push(...list);
      const last = list.filter((p) => p.status === 'success' && p.date <= on).sort((a, b) => b.date.localeCompare(a.date))[0];
      const od = overdue(list, on);
      return {
        loanId: l.loanId,
        product: l.product,
        rateType: l.rateType,
        outstanding: l.outstanding,
        emi: l.emi,
        annualRateBps: l.annualRateBps,
        nextDueDate: l.nextDueDate ?? null,
        overdueAmount: od.amount,
        daysPastDue: od.days,
        ...(last && { lastPayment: { date: last.date, amount: last.amount, status: last.status } }),
        principal: l.principal,
        tenureMonths: l.tenureMonths,
        remainingMonths: l.remainingMonths,
        status: l.outstanding > 0 ? 'active' : 'closed',
      };
    }),
  );

  return {
    customerId,
    ...(cust.ok && { customer: redact(cust.data) }),
    loans,
    recentPayments: allPays
      .filter((p) => p.date <= on)
      .sort((a, b) => b.date.localeCompare(a.date) || b.paymentId.localeCompare(a.paymentId))
      .slice(0, 5)
      .map((p) => ({
        loanId: p.loanId, date: p.date, amount: p.amount, status: p.status, paymentId: p.paymentId,
        ...(p.failureReason && { failureReason: p.failureReason }),
      })),
    fetchedAt: new Date().toISOString(),
    partial: [...partial],
  };
}

export function toSnapshotView(s: CustomerSnapshot): SnapshotView {
  const cards: LoanCardView[] = s.loans.map((l) => ({
    loanId: l.loanId,
    product: l.product,
    status: l.status,
    principalPaise: l.principal,
    outstandingPaise: l.outstanding,
    annualRateBps: l.annualRateBps,
    rateType: l.rateType,
    emiPaise: l.emi,
    nextDueDate: l.nextDueDate,
    tenureMonths: l.tenureMonths,
    remainingMonths: l.remainingMonths,
    overduePaise: l.overdueAmount,
    daysPastDue: l.daysPastDue,
    ...(l.lastPayment && { lastPayment: l.lastPayment }),
    maskedAccount: s.customer?.bankAccount ?? '',
  }));
  return {
    customer: { id: s.customerId, name: s.customer?.name ?? '' },
    asOf: s.fetchedAt,
    loans: cards,
    recentPayments: s.recentPayments.map((p) => ({
      paymentId: p.paymentId ?? `${p.loanId}:${p.date}`,
      loanId: p.loanId,
      date: p.date,
      amountPaise: p.amount,
      status: p.status,
      ...(p.failureReason && { note: p.failureReason }),
    })),
    ...(s.partial.length > 0 && { partial: s.partial }),
  };
}
