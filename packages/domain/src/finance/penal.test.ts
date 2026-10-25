import { describe, expect, it } from 'vitest';
import { rupees } from '../format/inr.js';
import { penalCharge } from './penal.js';

describe('penalCharge', () => {
  it('is simple daily interest rounded to the rupee', () => {
    expect(penalCharge({ overdueAmount: rupees(10000), daysPastDue: 30, penalRateBpsPa: 2400 })).toBe(rupees(197));
  });
  it('is zero when not overdue', () => {
    expect(penalCharge({ overdueAmount: rupees(10000), daysPastDue: 0, penalRateBpsPa: 2400 })).toBe(0);
  });
});
