import type { ProductType, RateType } from '../types.js';

export type PolicyTopic =
  | 'prepayment' | 'foreclosure' | 'rate_reset' | 'bounce_charge' | 'penal_charge'
  | 'emi_date_change' | 'statement' | 'dispute' | 'collections_conduct' | 'promise_to_pay' | 'grievance';

export interface PolicyClause {
  id: string;
  version: number;
  topic: PolicyTopic;
  title: string;
  /** Customer-citable wording. */
  text: string;
  effectiveFrom: string;
  effectiveTo?: string;
  /** Which date selects the version: the loan's sanction date, or the date of the event. */
  versionBy: 'sanctionDate' | 'eventDate';
  appliesTo: { products?: ProductType[]; rateTypes?: RateType[]; borrower?: 'individual' | 'business' };
  /** Numeric rule parameters. Charges exclude GST; money is in paise. */
  params?: Record<string, number>;
  /** String-list rule parameters (e.g. failure codes). */
  lists?: Record<string, string[]>;
}

const FROM = '2024-01-01';
const V2 = '2026-04-01';

export const CLAUSES: PolicyClause[] = [
  {
    id: 'PRE-01', version: 1, topic: 'prepayment', title: 'Prepayment on floating-rate loans',
    text: 'No prepayment charge applies to floating-rate loans held by individual borrowers. You can part-pay or close the loan at any time without a penalty.',
    effectiveFrom: FROM, versionBy: 'eventDate',
    appliesTo: { rateTypes: ['floating'], borrower: 'individual' },
    params: { chargePct: 0, minAmountPaise: 0 },
  },
  {
    id: 'PRE-02', version: 1, topic: 'prepayment', title: 'Prepayment on fixed-rate loans',
    text: 'For fixed-rate loans, a prepayment charge of 4% of the amount prepaid applies if the loan is less than 24 months old, and 2% after that. The minimum prepayment is ₹10,000.',
    effectiveFrom: FROM, effectiveTo: V2, versionBy: 'sanctionDate',
    appliesTo: { rateTypes: ['fixed'] },
    params: { youngChargePct: 4, matureChargePct: 2, ageThresholdMonths: 24, minAmountPaise: 1_000_000 },
  },
  {
    id: 'PRE-02', version: 2, topic: 'prepayment', title: 'Prepayment on fixed-rate loans',
    text: 'For fixed-rate loans sanctioned on or after 1 April 2026, a prepayment charge of 3% of the amount prepaid applies if the loan is less than 24 months old, and 2% after that. The minimum prepayment is ₹10,000.',
    effectiveFrom: V2, versionBy: 'sanctionDate',
    appliesTo: { rateTypes: ['fixed'] },
    params: { youngChargePct: 3, matureChargePct: 2, ageThresholdMonths: 24, minAmountPaise: 1_000_000 },
  },
  {
    id: 'FC-01', version: 1, topic: 'foreclosure', title: 'Foreclosure lock-in for fixed personal loans',
    text: 'Fixed-rate personal loans cannot be foreclosed during the first 12 months after sanction. After the lock-in, the foreclosure charge is the same as the prepayment charge under PRE-02.',
    effectiveFrom: FROM, versionBy: 'eventDate',
    appliesTo: { products: ['personal_loan'], rateTypes: ['fixed'] },
    params: { lockInMonths: 12 },
  },
  {
    id: 'RR-01', version: 1, topic: 'rate_reset', title: 'Rate reset on floating loans',
    text: 'Floating-rate loans reset when the repo rate changes. By default the bank revises your EMI and keeps the tenure; you may ask for a tenure extension instead, subject to the maximum age limit.',
    effectiveFrom: FROM, versionBy: 'eventDate',
    appliesTo: { rateTypes: ['floating'] },
  },
  {
    id: 'BC-01', version: 1, topic: 'bounce_charge', title: 'EMI bounce charge',
    text: 'A bounce charge of ₹500 plus 18% GST (₹590 in total) applies only when the failed payment is attributable to the customer, such as insufficient funds or a closed account. Failures caused by the bank or mandate processing are not charged.',
    effectiveFrom: FROM, versionBy: 'eventDate', appliesTo: {},
    params: { baseAmountPaise: 50_000, gstPct: 18 },
    lists: {
      chargeableCodes: ['INSUFFICIENT_FUNDS', 'ACCOUNT_CLOSED'],
      nonChargeableCodes: ['BANK_TECHNICAL_FAILURE', 'MANDATE_PROCESSING_ERROR'],
    },
  },
  {
    id: 'PEN-01', version: 1, topic: 'penal_charge', title: 'Penal charge on overdue instalments',
    text: 'A penal charge of 24% per annum, calculated as simple interest, applies on the overdue instalment for the days it remains unpaid. Penal charges are never capitalised.',
    effectiveFrom: FROM, versionBy: 'eventDate', appliesTo: {},
    params: { penalRateBpsPa: 2400 },
  },
  {
    id: 'PTP-01', version: 1, topic: 'promise_to_pay', title: 'Promise to pay',
    text: 'A promise to pay can be set for a date up to 7 days ahead, and only one promise can be active at a time.',
    effectiveFrom: FROM, versionBy: 'eventDate', appliesTo: {},
    params: { maxDaysAhead: 7, maxActive: 1 },
  },
  {
    id: 'COL-01', version: 1, topic: 'collections_conduct', title: 'Fair collections practice',
    text: 'We never threaten or harass customers and call only between 8am and 7pm. We state the amount due and all charges clearly, and always offer a grievance channel.',
    effectiveFrom: FROM, versionBy: 'eventDate', appliesTo: {},
    params: { callStartHour: 8, callEndHour: 19 },
  },
  {
    id: 'DSP-01', version: 1, topic: 'dispute', title: 'Dispute handling',
    text: 'Disputes are acknowledged within 2 working days and resolved within 7 working days.',
    effectiveFrom: FROM, versionBy: 'eventDate', appliesTo: {},
    params: { ackWorkingDays: 2, resolveWorkingDays: 7 },
  },
  {
    id: 'ST-01', version: 1, topic: 'statement', title: 'Account statements',
    text: 'You can request a statement for any period within the last 36 months.',
    effectiveFrom: FROM, versionBy: 'eventDate', appliesTo: {},
    params: { maxLookbackMonths: 36 },
  },
  {
    id: 'EDC-01', version: 1, topic: 'emi_date_change', title: 'EMI date change',
    text: 'The EMI due date can be changed once during the loan tenure.',
    effectiveFrom: FROM, versionBy: 'eventDate', appliesTo: {},
    params: { maxChangesPerTenure: 1 },
  },
  {
    id: 'GRV-01', version: 1, topic: 'grievance', title: 'Grievance escalation',
    text: 'If you are unhappy with a resolution, escalate to the branch grievance officer, then to the Nodal Officer, and finally to the Banking Ombudsman.',
    effectiveFrom: FROM, versionBy: 'eventDate', appliesTo: {},
  },
];
