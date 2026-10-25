import { addMonths } from '../clock.js';
import type { Paise } from '../format/inr.js';

export interface ScheduleRow {
  n: number;
  dueDate: string;
  opening: Paise;
  interest: Paise;
  principal: Paise;
  closing: Paise;
  emi: Paise;
}

const DEFAULT_MAX_MONTHS = 1200;

/** EMI rounded to the nearest whole rupee (100 paise). */
export function emi(principal: Paise, annualRateBps: number, months: number): Paise {
  if (months <= 0) throw new Error('months must be positive');
  if (principal <= 0) return 0;
  if (annualRateBps === 0) return Math.round(principal / months / 100) * 100;
  const r = annualRateBps / 120_000;
  const growth = Math.pow(1 + r, months);
  const exact = (principal * r * growth) / (growth - 1);
  return Math.round(exact / 100) * 100;
}

/** Month-by-month schedule; interest rounded to paise each month, last row absorbs the remainder. */
export function amortise(args: {
  principal: Paise;
  annualRateBps: number;
  emi: Paise;
  firstDueDate: string;
  maxMonths?: number;
}): ScheduleRow[] {
  const max = args.maxMonths ?? DEFAULT_MAX_MONTHS;
  // With an explicit maxMonths the contractual last instalment absorbs the residual.
  const forceLast = args.maxMonths !== undefined;
  const rows: ScheduleRow[] = [];
  let opening = args.principal;
  const firstInterest = Math.round((opening * args.annualRateBps) / 120_000);
  if (opening > 0 && args.emi < opening + firstInterest && args.emi <= firstInterest) {
    throw new RangeError('EMI does not cover interest');
  }
  for (let n = 1; n <= max && opening > 0; n++) {
    const interest = Math.round((opening * args.annualRateBps) / 120_000);
    const last = args.emi >= opening + interest || (forceLast && n === max);
    const rowEmi = last ? opening + interest : args.emi;
    const principal = rowEmi - interest;
    const closing = opening - principal;
    rows.push({ n, dueDate: addMonths(args.firstDueDate, n - 1), opening, interest, principal, closing, emi: rowEmi });
    opening = closing;
  }
  return rows;
}

export function totalInterest(rows: ScheduleRow[]): Paise {
  return rows.reduce((s, r) => s + r.interest, 0);
}

/** Whole months to clear `outstanding` at `emi` (a final partial instalment counts as a month). Infinity if the EMI never clears it. */
export function remainingTenure(outstanding: Paise, annualRateBps: number, emiAmount: Paise): number {
  if (outstanding <= 0) return 0;
  let rows: ScheduleRow[];
  try {
    rows = amortise({ principal: outstanding, annualRateBps, emi: emiAmount, firstDueDate: '2000-01-01' });
  } catch (e) {
    if (e instanceof RangeError) return Infinity;
    throw e;
  }
  return rows[rows.length - 1]!.closing === 0 ? rows.length : Infinity;
}
