import { bounceRule, daysBetween, emi, rupees } from '@app/domain';
import { describe, expect, it } from 'vitest';
import { buildDataset } from './build.js';
import { DEMO_CUSTOMERS } from './customers.js';

const today = '2026-10-25';
const ds = buildDataset(today);
const loan = (id: string) => ds.loans.get(id)!;

describe('buildDataset', () => {
  it('is deterministic', () => {
    expect(buildDataset(today)).toEqual(buildDataset(today));
  });

  it('Rahul: rate reset raises EMI to emi(outstandingAtReset, 910, remaining)', () => {
    const l = loan('HL-88231');
    const last = l.emiHistory[l.emiHistory.length - 1]!;
    expect(last.oldEmi).toBe(rupees(26_035));
    expect(last.newEmi).toBeGreaterThan(last.oldEmi);
    expect(last.reason).toBe('rate_reset');
    const atReset = l.schedule.find((r) => r.dueDate === '2026-09-05')!;
    expect(l.schedule.indexOf(atReset) + 1).toBe(41);
    expect(last.newEmi).toBe(emi(atReset.closing, 910, 240 - 41));
    expect(l.emi).toBe(last.newEmi);
    expect(l.annualRateBps).toBe(910);
    expect(atReset.emi).toBe(last.oldEmi);
    expect(l.schedule.find((r) => r.dueDate === '2026-10-05')!.emi).toBe(last.newEmi);
    expect(l.rateHistory[0]).toMatchObject({ effectiveDate: '2026-09-01', oldRateBps: 850, newRateBps: 910 });
    expect(ds.payments.get('HL-88231')!.every((p) => p.status === 'success')).toBe(true);
  });

  it('Priya: two failed payments, technical one still charged', () => {
    const failed = ds.payments.get('PL-55102')!.filter((p) => p.status === 'failed');
    expect(failed).toHaveLength(2);
    expect(failed.find((p) => p.failureCode === 'BANK_TECHNICAL_FAILURE')!.bounceCharge).toBe(rupees(590));
    expect(failed.find((p) => p.failureCode === 'INSUFFICIENT_FUNDS')!.bounceCharge).toBe(bounceRule('INSUFFICIENT_FUNDS', '2026-06-05').amount);
    expect(bounceRule('BANK_TECHNICAL_FAILURE', '2026-08-05').amount).toBe(0);
    const ids = ds.payments.get('PL-55102')!.map((p) => p.paymentId);
    expect(new Set(ids).size).toBe(ids.length);
    const retries = ds.payments.get('PL-55102')!.filter((p) => p.paymentId.endsWith('-R'));
    expect(retries.map((p) => p.date)).toEqual(['2026-06-09', '2026-08-07']);
  });

  it('Arjun: two overdue instalments, 40 DPD', () => {
    const pending = ds.payments.get('PL-60917')!.filter((p) => p.status === 'pending');
    expect(pending.map((p) => p.date)).toEqual(['2026-09-15', '2026-10-15']);
    expect(pending.reduce((s, p) => s + p.amount, 0)).toBe(2 * loan('PL-60917').emi);
    expect(daysBetween('2026-09-15', today)).toBe(40);
    expect(loan('PL-60917').nextDueDate).toBe('2026-09-15');
  });

  it('Neha has 2 loans, all paid', () => {
    expect(ds.customers.get('C1004')!.loanIds).toEqual(['PL-71230', 'TW-11804']);
    for (const id of ['PL-71230', 'TW-11804']) expect(ds.payments.get(id)!.every((p) => p.status === 'success')).toBe(true);
  });

  it('outstanding equals closing balance of the last paid schedule row', () => {
    for (const l of ds.loans.values()) {
      const paidDates = new Set(ds.payments.get(l.loanId)!.filter((p) => p.status === 'success').map((p) => p.paymentId.replace(/-R$/, '')));
      const paidRows = l.schedule.filter((r) => paidDates.has(`PAY-${l.loanId}-${r.n}`));
      expect(l.outstanding).toBe(paidRows[paidRows.length - 1]!.closing);
      expect(l.schedule[l.schedule.length - 1]!.closing).toBe(0);
    }
  });

  it('customers carry realistic PII and interactions; requests empty', () => {
    for (const c of ds.customers.values()) {
      expect(c.pan).toMatch(/^[A-Z]{5}\d{4}[A-Z]$/);
      expect(c.phone).toMatch(/^[789]\d{9}$/);
      expect(c.email).toContain('@');
      expect(c.bankAccount).toMatch(/^\d{9,18}$/);
      const n = ds.interactions.get(c.customerId)?.length ?? 0;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
    }
    expect(ds.requests.size).toBe(0);
    expect(DEMO_CUSTOMERS.map((c) => c.id)).toEqual(['C1001', 'C1002', 'C1003', 'C1004']);
  });

  it('every schedule has exactly tenureMonths rows and loan.emi matches the next unpaid row', () => {
    for (const l of ds.loans.values()) {
      expect(l.schedule).toHaveLength(l.tenureMonths);
      const paid = new Set(ds.payments.get(l.loanId)!.filter((p) => p.status === 'success').map((p) => p.paymentId.replace(/-R$/, '')));
      const next = l.schedule.find((r) => !paid.has(`PAY-${l.loanId}-${r.n}`))!;
      if (next.n !== l.tenureMonths) expect(l.emi).toBe(next.emi);
      expect(l.remainingMonths).toBe(l.tenureMonths - paid.size);
    }
  });
});
