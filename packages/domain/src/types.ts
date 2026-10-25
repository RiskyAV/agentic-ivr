import type { Paise } from './format/inr.js';

export type ProductType = 'home_loan' | 'personal_loan' | 'two_wheeler_loan';
export type RateType = 'fixed' | 'floating';

export interface RateChange {
  effectiveDate: string;
  oldRateBps: number;
  newRateBps: number;
  reason?: string;
}

export interface EmiChange {
  effectiveDate: string;
  oldEmi: Paise;
  newEmi: Paise;
  reason?: string;
}

export interface Loan {
  loanId: string;
  customerId: string;
  product: ProductType;
  rateType: RateType;
  principal: Paise;
  outstanding: Paise;
  annualRateBps: number;
  emi: Paise;
  tenureMonths: number;
  remainingMonths: number;
  disbursedOn: string;
  nextDueDate: string;
  /** Most recent instalment due date already passed (on or before today); accrual start for foreclosure. */
  lastPaidDueDate?: string;
  /** Selects policy clauses (versioned in code, D-017) together with product, rateType and borrower. */
  borrower: 'individual' | 'business';
  sanctionDate: string;
  rateHistory: RateChange[];
  emiHistory: EmiChange[];
}

export interface Payment {
  paymentId: string;
  loanId: string;
  date: string;
  amount: Paise;
  status: 'success' | 'failed' | 'pending';
  failureCode?: string;
  failureReason?: string;
  /** The charge actually levied on this payment's bounce. A recorded outcome that may contradict policy; never use it as the policy figure. */
  bounceCharge?: Paise;
}

export interface Customer {
  customerId: string;
  name: string;
  phone: string;
  email: string;
  pan: string;
  loanIds: string[];
}
