import { describe, expect, it } from 'vitest';
import { rupees } from '../format/inr.js';
import { amortise, emi, remainingTenure, totalInterest } from './emi.js';

describe('emi', () => {
  it.each([
    [3_000_000, 850, 240, 26035],
    [3_000_000, 910, 240, 27185],
    [500_000, 1350, 36, 16968],
    [100_000, 1200, 12, 8885],
  ])('emi(%i, %i, %i) = %i', (p, bps, n, expected) => {
    expect(emi(rupees(p), bps, n)).toBe(rupees(expected));
  });

  it('handles zero rate', () => {
    expect(emi(rupees(120_000), 0, 12)).toBe(rupees(10_000));
  });
});

describe('amortise', () => {
  const args = { principal: rupees(100_000), annualRateBps: 1200, emi: rupees(8885), firstDueDate: '2026-11-05' };
  it('produces 12 rows, closes at 0 and principal sums exactly', () => {
    const rows = amortise(args);
    expect(rows).toHaveLength(12);
    expect(rows[11]!.closing).toBe(0);
    expect(rows.reduce((s, r) => s + r.principal, 0)).toBe(rupees(100_000));
    expect(rows[0]!.dueDate).toBe('2026-11-05');
    expect(rows[1]!.dueDate).toBe('2026-12-05');
    expect(rows[0]!.interest).toBe(rupees(1000));
    expect(rows[11]!.emi).toBe(rows[11]!.opening + rows[11]!.interest);
  });
  it('totalInterest sums interest', () => {
    const rows = amortise(args);
    expect(totalInterest(rows)).toBe(rows.reduce((s, r) => s + r.interest, 0));
  });
  it('throws when the EMI cannot amortise the principal', () => {
    expect(() => amortise({ ...args, emi: rupees(500) })).toThrow(new RangeError('EMI does not cover interest'));
    expect(() => amortise({ ...args, emi: rupees(1000) })).toThrow(RangeError);
    expect(() => amortise({ ...args, emi: 0 })).toThrow(RangeError);
  });
  it('respects maxMonths', () => {
    expect(amortise({ ...args, maxMonths: 3 })).toHaveLength(3);
  });
  it('remainingTenure counts a final partial instalment', () => {
    expect(remainingTenure(rupees(100_000), 1200, rupees(8885))).toBe(12);
  });
  it('remainingTenure is Infinity when emi does not cover interest', () => {
    expect(remainingTenure(rupees(100_000), 1200, rupees(500))).toBe(Infinity);
  });
});

describe('amortise with maxMonths', () => {
  it('final scheduled instalment absorbs the residual: exactly maxMonths rows ending at 0', () => {
    const p = rupees(200_000);
    const rows = amortise({ principal: p, annualRateBps: 1250, emi: emi(p, 1250, 24), firstDueDate: '2025-12-01', maxMonths: 24 });
    expect(rows).toHaveLength(24);
    expect(rows[23]!.closing).toBe(0);
  });
});
