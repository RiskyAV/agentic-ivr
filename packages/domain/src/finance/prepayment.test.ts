import { describe, expect, it } from 'vitest';
import { rupees } from '../format/inr.js';
import { simulatePrepayment } from './prepayment.js';

const base = {
  outstanding: rupees(2_500_000),
  annualRateBps: 910,
  emi: rupees(24327),
  remainingMonths: 200,
  amount: rupees(50_000),
  chargePct: 0,
  firstDueDate: '2026-11-05',
};

describe('simulatePrepayment', () => {
  it('matches the independent calculation', () => {
    const s = simulatePrepayment(base);
    expect(s.reduceTenure.monthsSaved).toBe(10);
    expect(Math.abs(s.reduceTenure.interestSaved - rupees(169_749))).toBeLessThanOrEqual(rupees(2));
    expect(s.reduceEmi.newEmi).toBe(rupees(23841));
    expect(s.reduceEmi.emiReduction).toBe(rupees(24327 - 23841));
    expect(Math.abs(s.reduceEmi.interestSaved - rupees(47_457))).toBeLessThanOrEqual(rupees(2));
    expect(s.charge).toBe(0);
    expect(s.netSavingTenure).toBe(s.reduceTenure.interestSaved);
    expect(s.netSavingEmi).toBe(s.reduceEmi.interestSaved);
  });
  it('applies the prepayment charge', () => {
    const s = simulatePrepayment({ ...base, chargePct: 4 });
    expect(s.charge).toBe(rupees(2000));
    expect(s.netSavingTenure).toBe(s.reduceTenure.interestSaved - rupees(2000));
    expect(s.netSavingEmi).toBe(s.reduceEmi.interestSaved - rupees(2000));
  });
  it('charges on min(amount, outstanding) and closes the loan when over-paying', () => {
    const s = simulatePrepayment({ ...base, amount: rupees(3_000_000), chargePct: 4 });
    expect(s.charge).toBe(rupees(100_000));
    expect(s.reduceTenure.months).toBe(0);
    expect(s.reduceEmi.newEmi).toBe(0);
    expect(s.reduceEmi.interest).toBe(0);
    expect(s.reduceTenure.interestSaved).toBe(s.baseline.interest);
    expect(s.reduceEmi.interestSaved).toBe(s.baseline.interest);
  });
  it('throws when the EMI does not cover interest', () => {
    expect(() => simulatePrepayment({ ...base, emi: rupees(100) })).toThrow(new RangeError('EMI does not cover interest'));
    expect(() => simulatePrepayment({ ...base, emi: 0 })).toThrow(RangeError);
  });
});
