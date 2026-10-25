import type { Channel, SystemName } from './protocol.js';

/** Where a statement in an answer came from. */
export interface Source {
  kind: 'record' | 'clause' | 'calc';
  system?: SystemName;
  ref: string;
  label: string;
  detail?: string;
}

/** All money fields are integer paise; rates are integer basis points. */
export interface LoanCardView {
  loanId: string;
  product: string;
  status: string;
  principalPaise: number;
  outstandingPaise: number;
  annualRateBps: number;
  rateType: string;
  emiPaise: number;
  nextDueDate: string | null;
  tenureMonths: number;
  remainingMonths: number;
  overduePaise: number;
  maskedAccount: string;
  daysPastDue?: number;
  lastPayment?: { date: string; amount: number; status: string };
}

export interface PaymentRowView {
  paymentId: string;
  loanId: string;
  date: string;
  amountPaise: number;
  status: string;
  mode?: string;
  note?: string;
}

export interface SnapshotView {
  customer: { id: string; name: string };
  asOf: string;
  loans: LoanCardView[];
  recentPayments: PaymentRowView[];
  /** Systems that failed while loading the snapshot. */
  partial?: SystemName[];
}

export interface ProposalView {
  id: string;
  type: string;
  title: string;
  summary: string;
  figures: { label: string; value: string }[];
  termsHash: string;
  expiresAt: number;
}

export interface TableView {
  title: string;
  columns: string[];
  rows: string[][];
}

export interface SpanView {
  name: string;
  startMs: number;
  endMs: number;
  attrs?: Record<string, string | number | boolean>;
}

export interface TurnTrace {
  turnId: string;
  channel: Channel;
  spans: SpanView[];
  metrics: Record<string, number>;
  guard?: { verdict: string; category?: string; ms: number };
}

export type ChatItemView =
  | { kind: 'user'; turnId: string; text: string; channel: Channel }
  | { kind: 'assistant'; turnId: string; text: string; sources: Source[]; tables?: TableView[] }
  | { kind: 'proposal'; proposal: ProposalView; status: 'pending' | 'executed' | 'rejected' | 'failed' | 'expired' }
  | { kind: 'action_result'; proposalId: string; status: 'executed' | 'rejected' | 'failed' | 'expired'; reference?: string; message: string };
