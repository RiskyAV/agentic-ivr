import type { Paise } from '../format/inr.js';

/** Simple daily penal interest on the overdue amount, rounded to the nearest rupee. */
export function penalCharge(args: { overdueAmount: Paise; daysPastDue: number; penalRateBpsPa: number }): Paise {
  if (args.daysPastDue <= 0 || args.overdueAmount <= 0) return 0;
  const exact = (args.overdueAmount * args.penalRateBpsPa * args.daysPastDue) / 3_650_000;
  return Math.round(exact / 100) * 100;
}
