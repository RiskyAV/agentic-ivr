import { addMonths, daysBetween, today, type Paise, type ProductType, type RateType } from '@app/domain';
import type { LoanCardView, SnapshotView, SystemName } from '@app/shared';
import type { CallCtx, Connectors } from '../connectors/clients.js';
import type { CrmCustomer, LoanRecordDto } from '../connectors/types.js';
import { redact } from './redact.js';

export interface LastPayment {
  date: string;
  amount: Paise;
  status: 'success' | 'failed' | 'pending';
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
  fetchedAt: string;
  partial: SystemName[];
}

/** Overdue = every monthly instalment from nextDueDate that fell strictly before today. */
function overdue(nextDueDate: string | undefined, emi: Paise, on: string): { amount: Paise; days: number } {
  if (!nextDueDate || nextDueDate >= on) return { amount: 0, days: 0 };
  let n = 0;
  while (addMonths(nextDueDate, n) < on) n++;
  return { amount: n * emi, days: daysBetween(nextDueDate, on) };
}

export async function loadSnapshot(c: Connectors, customerId: string, ctx: CallCtx): Promise<CustomerSnapshot> {
  const partial = new Set<SystemName>();
  const on = today();
  const [cust, loansRes] = await Promise.all([c.crm.getCustomer(customerId, ctx), c.lms.getLoans(customerId, ctx)]);
  if (!cust.ok) partial.add('crm');
  if (!loansRes.ok) partial.add('lms');

  const base = loansRes.ok ? loansRes.data : [];
  const loans = await Promise.all(
    base.map(async (s): Promise<LoanSummary> => {
      const [detail, pays] = await Promise.all([c.lms.getLoan(s.loanId, ctx), c.payments.list(s.loanId, {}, ctx)]);
      if (!detail.ok) partial.add('lms');
      if (!pays.ok) partial.add('payments');
      const l: LoanRecordDto = detail.ok ? detail.data : s;
      const last = pays.ok ? pays.data.filter((p) => p.date <= on).sort((a, b) => b.date.localeCompare(a.date))[0] : undefined;
      const od = overdue(l.nextDueDate, l.emi, on);
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
    recentPayments: [],
    ...(s.partial.length > 0 && { partial: s.partial }),
  };
}
