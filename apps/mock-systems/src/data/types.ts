import type { Customer, Loan, Payment, ScheduleRow } from '@app/domain';

export interface CustomerRecord extends Customer {
  /** Synthetic full account number; masked before reaching any prompt, log or trace. */
  bankAccount: string;
}

export interface LoanRecord extends Loan {
  /** Full schedule: instalments already due use the EMI in force at the time. */
  schedule: ScheduleRow[];
}

export interface ServiceRequest {
  requestId: string;
  customerId: string;
  loanId?: string;
  type: string;
  status: 'open' | 'in_progress' | 'closed';
  createdAt: string;
  details?: Record<string, unknown>;
}

export interface Interaction {
  interactionId: string;
  customerId: string;
  date: string;
  channel: 'call' | 'app' | 'branch' | 'email';
  summary: string;
}

export interface Dataset {
  customers: Map<string, CustomerRecord>;
  loans: Map<string, LoanRecord>;
  payments: Map<string, Payment[]>;
  requests: Map<string, ServiceRequest>;
  interactions: Map<string, Interaction[]>;
}
