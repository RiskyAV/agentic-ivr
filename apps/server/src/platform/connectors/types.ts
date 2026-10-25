import type { Loan, Payment, PolicyClause, ScheduleRow } from '@app/domain';

/** DTOs mirroring the mock systems' JSON (kept local so the server has no runtime dependency on the mocks). */
export interface CrmCustomer {
  customerId: string;
  name: string;
  phone: string;
  email: string;
  pan: string;
  loanIds: string[];
  bankAccount?: string;
}
export interface Interaction {
  interactionId: string;
  customerId: string;
  date: string;
  channel: 'call' | 'app' | 'branch' | 'email';
  summary: string;
}
export type LoanRecordDto = Loan;
export type PaymentDto = Payment;
export type ScheduleRowDto = ScheduleRow;
export type PolicyClauseDto = PolicyClause;
export interface PaymentLink {
  linkId: string;
  url: string;
  amountPaise: number;
  loanId: string;
  expiresAt: string;
}
export type OpsRequestType = 'prepayment' | 'dispute' | 'statement' | 'ticket' | 'promise_to_pay' | 'callback';
export interface OpsRequestDto {
  id: string;
  customerId: string;
  type: OpsRequestType;
  params: Record<string, unknown>;
  status: 'open';
  createdAt: string;
}
