import { rupees, type Paise, type ProductType, type RateType } from '@app/domain';
import type { CustomerRecord, Interaction } from './types.js';

// The demo customer list lives in @app/shared so production code (the gateway) does not import the mocks.
export { DEMO_CUSTOMERS } from '@app/shared';

export const PROFILES: Omit<CustomerRecord, 'loanIds'>[] = [
  { customerId: 'C1001', name: 'Rahul Mehta', phone: '9820145567', email: 'rahul.mehta@example.in', pan: 'BKMPM4821Q', bankAccount: '50100234871965' },
  { customerId: 'C1002', name: 'Priya Sharma', phone: '8123456709', email: 'priya.sharma@example.in', pan: 'CXDPS7733L', bankAccount: '31620987451203' },
  { customerId: 'C1003', name: 'Arjun Verma', phone: '7011223344', email: 'arjun.verma@example.in', pan: 'AGRPV2290H', bankAccount: '09871234560021' },
  { customerId: 'C1004', name: 'Neha Kapoor', phone: '9988776655', email: 'neha.kapoor@example.in', pan: 'DLFPK5618M', bankAccount: '60234598710346' },
];

export interface LoanSpec {
  loanId: string;
  customerId: string;
  product: ProductType;
  rateType: RateType;
  principal: Paise;
  rateBps: number;
  tenureMonths: number;
  sanctionDate: string;
  firstEmiDate: string;
  /** Floating-rate reset: instalments on or before `lastOldDueDate` use the old rate/EMI. */
  reset?: { effectiveDate: string; newRateBps: number; lastOldDueDate: string; firstNewDueDate: string };
  /** Failed first attempts keyed by due date, with retry date. */
  failures?: Record<string, { code: string; reason: string; retryDate: string; bounceCharge: 'policy' | Paise }>;
  /** Due dates left unpaid (pending). */
  unpaid?: string[];
}

export const LOAN_SPECS: LoanSpec[] = [
  {
    loanId: 'HL-88231', customerId: 'C1001', product: 'home_loan', rateType: 'floating',
    principal: rupees(3_000_000), rateBps: 850, tenureMonths: 240, sanctionDate: '2023-04-10', firstEmiDate: '2023-05-05',
    reset: { effectiveDate: '2026-09-01', newRateBps: 910, lastOldDueDate: '2026-09-05', firstNewDueDate: '2026-10-05' },
  },
  {
    loanId: 'PL-55102', customerId: 'C1002', product: 'personal_loan', rateType: 'fixed',
    principal: rupees(500_000), rateBps: 1350, tenureMonths: 36, sanctionDate: '2025-03-05', firstEmiDate: '2025-04-05',
    failures: {
      '2026-06-05': { code: 'INSUFFICIENT_FUNDS', reason: 'Insufficient balance in account at time of debit', retryDate: '2026-06-09', bounceCharge: 'policy' },
      '2026-08-05': { code: 'BANK_TECHNICAL_FAILURE', reason: 'Debit failed due to a technical failure at the customer\'s bank', retryDate: '2026-08-07', bounceCharge: rupees(590) },
    },
  },
  {
    loanId: 'PL-60917', customerId: 'C1003', product: 'personal_loan', rateType: 'fixed',
    principal: rupees(300_000), rateBps: 1400, tenureMonths: 24, sanctionDate: '2025-06-15', firstEmiDate: '2025-07-15',
    unpaid: ['2026-09-15', '2026-10-15'],
  },
  {
    loanId: 'PL-71230', customerId: 'C1004', product: 'personal_loan', rateType: 'fixed',
    principal: rupees(200_000), rateBps: 1250, tenureMonths: 24, sanctionDate: '2025-11-01', firstEmiDate: '2025-12-01',
  },
  {
    loanId: 'TW-11804', customerId: 'C1004', product: 'two_wheeler_loan', rateType: 'fixed',
    principal: rupees(120_000), rateBps: 1100, tenureMonths: 18, sanctionDate: '2026-01-20', firstEmiDate: '2026-02-20',
  },
];

export const INTERACTIONS: Omit<Interaction, 'interactionId'>[] = [
  { customerId: 'C1001', date: '2026-09-02', channel: 'email', summary: 'Rate revision notice sent: floating rate moved from 8.50% to 9.10% effective 2026-09-01.' },
  { customerId: 'C1001', date: '2026-10-06', channel: 'app', summary: 'Customer viewed revised EMI after the 2026-10-05 debit.' },
  { customerId: 'C1002', date: '2026-06-06', channel: 'call', summary: 'Customer informed of failed EMI debit (insufficient funds) and advised to retry.' },
  { customerId: 'C1002', date: '2026-08-06', channel: 'app', summary: 'Customer reported EMI debit failed despite sufficient balance.' },
  { customerId: 'C1003', date: '2026-09-20', channel: 'call', summary: 'Reminder call: EMI due 2026-09-15 not received; customer said salary delayed.' },
  { customerId: 'C1003', date: '2026-10-18', channel: 'email', summary: 'Overdue notice sent for two missed instalments.' },
  { customerId: 'C1004', date: '2026-02-21', channel: 'branch', summary: 'Two-wheeler loan documentation completed; first EMI scheduled.' },
];
