import { describe, expect, it } from 'vitest';
import { rupees } from '../format/inr.js';
import { foreclosureQuote } from './foreclosure.js';

describe('foreclosureQuote', () => {
  it('computes interest, charge, GST and total', () => {
    const q = foreclosureQuote({
      outstanding: rupees(1_000_000), annualRateBps: 1000,
      lastDueDate: '2026-10-05', onDate: '2026-10-25', chargePct: 2,
    });
    expect(q.principal).toBe(rupees(1_000_000));
    expect(q.accruedInterest).toBe(Math.round((rupees(1_000_000) * 1000 * 20) / 3_650_000));
    expect(q.charge).toBe(rupees(20_000));
    expect(q.gstOnCharge).toBe(rupees(3_600));
    expect(q.total).toBe(q.principal + q.accruedInterest + q.charge + q.gstOnCharge);
  });
  it('accrues nothing for a date on or before the last due date', () => {
    const q = foreclosureQuote({
      outstanding: rupees(1000), annualRateBps: 1000,
      lastDueDate: '2026-10-25', onDate: '2026-10-25', chargePct: 0,
    });
    expect(q.accruedInterest).toBe(0);
    expect(q.total).toBe(rupees(1000));
  });
});
