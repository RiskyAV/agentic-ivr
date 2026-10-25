import { addMonths, amortise, bounceRule, emi, type EmiChange, type Loan, type Payment, type RateChange, type ScheduleRow } from '@app/domain';
import { INTERACTIONS, LOAN_SPECS, PROFILES, type LoanSpec } from './customers.js';
import type { CustomerRecord, Dataset, Interaction, LoanRecord } from './types.js';

function buildSchedule(spec: LoanSpec): { schedule: ScheduleRow[]; rateHistory: RateChange[]; emiHistory: EmiChange[]; currentRateBps: number } {
  const baseEmi = emi(spec.principal, spec.rateBps, spec.tenureMonths);
  const base = amortise({ principal: spec.principal, annualRateBps: spec.rateBps, emi: baseEmi, firstDueDate: spec.firstEmiDate });
  const reset = spec.reset;
  if (!reset) return { schedule: base, rateHistory: [], emiHistory: [], currentRateBps: spec.rateBps };

  // The last pre-reset instalment is at the old rate and EMI; the revised EMI starts the next one.
  const old = base.filter((r) => r.dueDate <= reset.lastOldDueDate);
  const outstandingAtReset = old[old.length - 1]!.closing;
  const remainingMonthsAtReset = spec.tenureMonths - old.length;
  const newEmi = emi(outstandingAtReset, reset.newRateBps, remainingMonthsAtReset);
  const after = amortise({ principal: outstandingAtReset, annualRateBps: reset.newRateBps, emi: newEmi, firstDueDate: reset.firstNewDueDate })
    .map((r) => ({ ...r, n: r.n + old.length }));
  return {
    schedule: [...old, ...after],
    rateHistory: [{ effectiveDate: reset.effectiveDate, oldRateBps: spec.rateBps, newRateBps: reset.newRateBps, reason: 'repo_rate_change' }],
    emiHistory: [{ effectiveDate: reset.firstNewDueDate, oldEmi: baseEmi, newEmi, reason: 'rate_reset' }],
    currentRateBps: reset.newRateBps,
  };
}

function buildPayments(spec: LoanSpec, schedule: ScheduleRow[], today: string): Payment[] {
  const out: Payment[] = [];
  for (const row of schedule) {
    if (row.dueDate > today) break;
    const id = `PAY-${spec.loanId}-${row.n}`;
    const fail = spec.failures?.[row.dueDate];
    if (fail) {
      out.push({
        paymentId: id, loanId: spec.loanId, date: row.dueDate, amount: row.emi, status: 'failed',
        failureCode: fail.code, failureReason: fail.reason,
        bounceCharge: fail.bounceCharge === 'policy' ? bounceRule(fail.code, row.dueDate).amount : fail.bounceCharge,
      });
      out.push({ paymentId: `${id}-R`, loanId: spec.loanId, date: fail.retryDate, amount: row.emi, status: 'success' });
    } else if (spec.unpaid?.includes(row.dueDate)) {
      out.push({ paymentId: id, loanId: spec.loanId, date: row.dueDate, amount: row.emi, status: 'pending' });
    } else {
      out.push({ paymentId: id, loanId: spec.loanId, date: row.dueDate, amount: row.emi, status: 'success' });
    }
  }
  return out;
}

/** Pure and deterministic: every figure derives from the domain calculators and `today`. */
export function buildDataset(today: string): Dataset {
  const loans = new Map<string, LoanRecord>();
  const payments = new Map<string, Payment[]>();
  const customers = new Map<string, CustomerRecord>();

  for (const spec of LOAN_SPECS) {
    const { schedule, rateHistory, emiHistory, currentRateBps } = buildSchedule(spec);
    const pays = buildPayments(spec, schedule, today);
    const unpaid = new Set(spec.unpaid ?? []);
    const paidRows = schedule.filter((r) => r.dueDate <= today && !unpaid.has(r.dueDate));
    const lastPaid = paidRows[paidRows.length - 1];
    const remaining = schedule.filter((r) => r.dueDate > today || unpaid.has(r.dueDate));
    const current = remaining.find((r) => r.dueDate > today) ?? schedule[schedule.length - 1]!;
    const loan: LoanRecord = {
      loanId: spec.loanId, customerId: spec.customerId, product: spec.product, rateType: spec.rateType,
      principal: spec.principal, outstanding: lastPaid ? lastPaid.closing : spec.principal,
      annualRateBps: currentRateBps, emi: current.emi, tenureMonths: spec.tenureMonths, remainingMonths: remaining.length,
      disbursedOn: spec.sanctionDate, nextDueDate: remaining[0]?.dueDate ?? addMonths(spec.firstEmiDate, spec.tenureMonths),
      lastPaidDueDate: lastPaid?.dueDate, borrower: 'individual', sanctionDate: spec.sanctionDate,
      rateHistory, emiHistory, schedule,
    };
    loans.set(spec.loanId, loan);
    payments.set(spec.loanId, pays);
  }

  for (const p of PROFILES) {
    customers.set(p.customerId, { ...p, loanIds: LOAN_SPECS.filter((s) => s.customerId === p.customerId).map((s) => s.loanId) });
  }

  const interactions = new Map<string, Interaction[]>();
  INTERACTIONS.filter((i) => i.date <= today).forEach((i, idx) => {
    const list = interactions.get(i.customerId) ?? [];
    list.push({ ...i, interactionId: `INT-${i.customerId}-${idx + 1}` });
    interactions.set(i.customerId, list);
  });

  return { customers, loans, payments, requests: new Map(), interactions };
}
