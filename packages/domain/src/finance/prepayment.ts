import type { Paise } from '../format/inr.js';
import { amortise, emi, totalInterest } from './emi.js';

export interface PrepaymentSim {
  baseline: { months: number; interest: Paise };
  reduceTenure: { months: number; monthsSaved: number; interest: Paise; interestSaved: Paise };
  reduceEmi: { newEmi: Paise; emiReduction: Paise; interest: Paise; interestSaved: Paise };
  charge: Paise;
  netSavingTenure: Paise;
  netSavingEmi: Paise;
}

export function simulatePrepayment(args: {
  outstanding: Paise;
  annualRateBps: number;
  emi: Paise;
  remainingMonths: number;
  amount: Paise;
  chargePct: number;
  firstDueDate: string;
}): PrepaymentSim {
  const { outstanding, annualRateBps, amount, firstDueDate } = args;
  const run = (principal: Paise, e: Paise) => amortise({ principal, annualRateBps, emi: e, firstDueDate });

  const base = run(outstanding, args.emi);
  const baseline = { months: base.length, interest: totalInterest(base) };

  const afterPrepay = Math.max(outstanding - amount, 0);

  const tenureRows = run(afterPrepay, args.emi);
  const tenureInterest = totalInterest(tenureRows);

  const newEmi = afterPrepay > 0 ? emi(afterPrepay, annualRateBps, args.remainingMonths) : 0;
  const emiRows = run(afterPrepay, newEmi);
  const emiInterest = totalInterest(emiRows);

  const charge = Math.round((Math.min(amount, outstanding) * args.chargePct) / 100);
  const reduceTenure = {
    months: tenureRows.length,
    monthsSaved: baseline.months - tenureRows.length,
    interest: tenureInterest,
    interestSaved: baseline.interest - tenureInterest,
  };
  const reduceEmi = {
    newEmi,
    emiReduction: args.emi - newEmi,
    interest: emiInterest,
    interestSaved: baseline.interest - emiInterest,
  };
  return {
    baseline,
    reduceTenure,
    reduceEmi,
    charge,
    netSavingTenure: reduceTenure.interestSaved - charge,
    netSavingEmi: reduceEmi.interestSaved - charge,
  };
}
