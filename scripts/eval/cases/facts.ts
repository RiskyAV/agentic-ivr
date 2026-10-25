/**
 * Expected figures for the eval cases. Everything is computed at runtime from the @app/domain calculators and the
 * mock dataset (buildDataset), then formatted with the domain formatters: no figure is typed by hand.
 */
import {
  bounceRule, daysBetween, foreclosureQuote, foreclosureRule, formatDate, formatInr, formatPct, penalCharge, penalRule, prepaymentRule,
  ptpRule, remainingTenure, selectClause, simulatePrepayment, today, type Paise, type PolicyTopic,
} from '@app/domain';
import { buildDataset } from '@app/mock-systems';

export const TODAY = today();
const data = buildDataset(TODAY);

export const loan = (id: string) => {
  const l = data.loans.get(id);
  if (!l) throw new Error(`unknown loan ${id}`);
  return l;
};
export const customerLoans = (customerId: string) => [...data.loans.values()].filter((l) => l.customerId === customerId);
export const payments = (loanId: string) => data.payments.get(loanId) ?? [];

/** Money as a needle group: the domain format, which the matcher also accepts as Rs./INR/plain digits. */
export const inr = (p: Paise): string => formatInr(p);
export const pct = (bps: number): string => formatPct(bps);
/** A date in the formats a spoken or written answer uses. */
export function dateAlts(iso: string): string[] {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const long = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
  return [formatDate(iso), `${d} ${long} ${y}`, `${ord(d)} ${long}`, `${d} ${long}`, `${long} ${d}`, `${long} ${ord(d)}`];
};
export const clauseRef = (topic: PolicyTopic, loanId: string): string => {
  const c = selectClause(topic, loan(loanId), TODAY);
  return `${c.id} v${c.version}`;
};

export function emiChange(loanId: string) {
  const l = loan(loanId);
  const change = l.emiHistory[l.emiHistory.length - 1]!;
  const rate = l.rateHistory[l.rateHistory.length - 1]!;
  return { oldEmi: change.oldEmi, newEmi: change.newEmi, oldRate: rate.oldRateBps, newRate: rate.newRateBps, clause: clauseRef('rate_reset', loanId) };
}

/** Mirrors simulate_prepayment: schedule from the next due date, charge from the prepayment clause. */
export function prepay(loanId: string, amount: Paise) {
  const l = loan(loanId);
  const rule = prepaymentRule(l, TODAY);
  const sched = l.schedule.filter((r) => r.dueDate >= l.nextDueDate);
  const sim = simulatePrepayment({
    outstanding: l.outstanding, annualRateBps: l.annualRateBps, emi: l.emi, remainingMonths: sched.length || l.remainingMonths,
    amount, chargePct: rule.chargePct, firstDueDate: sched[0]?.dueDate ?? l.nextDueDate,
  });
  return { ...sim, rule, clause: clauseRef('prepayment', loanId) };
}

/** Mirrors check_foreclosure. `penaltyFree` is the literal answer to "without a penalty?". */
export function foreclosure(loanId: string) {
  const l = loan(loanId);
  const rule = foreclosureRule(l, TODAY);
  const quote = rule.eligible
    ? foreclosureQuote({ outstanding: l.outstanding, annualRateBps: l.annualRateBps, lastDueDate: l.lastPaidDueDate ?? l.disbursedOn, onDate: TODAY, chargePct: rule.chargePct })
    : undefined;
  return {
    rule, quote, eligible: rule.eligible, penaltyFree: rule.eligible && rule.chargePct === 0,
    chargePctText: formatPct(Math.round(rule.chargePct * 100)),
    penalty: quote ? quote.charge + quote.gstOnCharge : 0,
    clause: `${rule.clause.id} v${rule.clause.version}`,
  };
}

/** Failed payments of a loan, newest first, with the bounce charge levied and what policy allows. */
export function failedPayments(loanId: string) {
  return payments(loanId).filter((p) => p.status === 'failed').sort((a, b) => b.date.localeCompare(a.date));
}

/** Mirrors get_overdue_summary: pending instalments due on or before today, PEN-01 penal charge per instalment. */
export function overdue(loanId: string) {
  const l = loan(loanId);
  const due = payments(loanId).filter((p) => p.status === 'pending' && p.date <= TODAY).sort((a, b) => a.date.localeCompare(b.date));
  const rule = penalRule(l, TODAY);
  const principal = due.reduce((t, p) => t + p.amount, 0);
  const penal = due.reduce((t, p) => t + penalCharge({ overdueAmount: p.amount, daysPastDue: daysBetween(p.date, TODAY), penalRateBpsPa: rule.penalRateBpsPa }), 0);
  return {
    instalments: due.length, principal, penal, total: principal + penal, dpd: Math.max(0, daysBetween(due[0]!.date, TODAY)),
    ptpWindow: ptpRule(TODAY).maxDaysAhead, penalClause: clauseRef('penal_charge', loanId),
  };
}

/** Bounce charge levied vs allowed by policy, per failed payment (mirrors assessBounce). */
export function bounce(loanId: string) {
  return failedPayments(loanId).map((p) => {
    const due = bounceRule(p.failureCode ?? '', p.date).amount;
    const levied = p.bounceCharge ?? 0;
    return { ...p, levied, due, refundable: Math.max(levied - due, 0) };
  });
}

/** "If I keep my old EMI": months the loan would run at the old EMI and the extra months. */
export function keepOldEmi(loanId: string) {
  const l = loan(loanId);
  const c = emiChange(loanId);
  const months = remainingTenure(l.outstanding, c.newRate, c.oldEmi);
  return { months: Math.round(months), extra: Math.round(months) - l.remainingMonths };
}

export const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
