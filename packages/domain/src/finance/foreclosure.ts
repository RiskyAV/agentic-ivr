import { daysBetween } from '../clock.js';
import type { Paise } from '../format/inr.js';

export interface ForeclosureQuote {
  principal: Paise;
  accruedInterest: Paise;
  charge: Paise;
  gstOnCharge: Paise;
  total: Paise;
}

/** Simple daily interest (bps/36500) since the last due date; charge on principal; GST 18% of charge. */
export function foreclosureQuote(args: {
  outstanding: Paise;
  annualRateBps: number;
  lastDueDate: string;
  onDate: string;
  chargePct: number;
}): ForeclosureQuote {
  const days = Math.max(daysBetween(args.lastDueDate, args.onDate), 0);
  const accruedInterest = Math.round((args.outstanding * args.annualRateBps * days) / 3_650_000);
  const charge = Math.round((args.outstanding * args.chargePct) / 100);
  const gstOnCharge = Math.round(charge * 0.18);
  return {
    principal: args.outstanding,
    accruedInterest,
    charge,
    gstOnCharge,
    total: args.outstanding + accruedInterest + charge + gstOnCharge,
  };
}
