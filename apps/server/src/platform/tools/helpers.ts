import type { Source, SystemName } from '@app/shared';
import type { PolicyClause } from '@app/domain';
import type { LoanRecordDto } from '../connectors/types.js';
import type { Fetched } from '../connectors/resilientClient.js';
import { ToolFailure, type ToolContext, type ToolFailureResult } from './types.js';

const SYSTEM_LABEL: Record<SystemName, string> = {
  crm: 'CRM', lms: 'loan management system', payments: 'payments system', policy: 'policy service', ops: 'service request system',
};

/** Collects stale markers from several fetches; the oldest asOf wins. */
export class Gather {
  private asOf?: string;
  constructor(private readonly ctx: ToolContext) {}

  get cc() {
    return { signal: this.ctx.signal, observer: this.ctx.tracer.observer };
  }

  /** Unwraps a fetch or throws a ToolFailure naming the system. */
  need<T>(system: SystemName, f: Fetched<T>, what: string): T {
    if (!f.ok) {
      throw new ToolFailure(
        f.error === 'not_found'
          ? { ok: false, error: 'not_found', message: `${what} was not found in the ${SYSTEM_LABEL[system]}.` }
          : { ok: false, error: 'unavailable', message: `The ${SYSTEM_LABEL[system]} is currently unavailable, so ${what} could not be retrieved.` },
      );
    }
    if (f.stale && (!this.asOf || f.stale.asOf < this.asOf)) this.asOf = f.stale.asOf;
    return f.data;
  }

  noteStale(asOf?: string): void {
    if (asOf && (!this.asOf || asOf < this.asOf)) this.asOf = asOf;
  }

  get stale(): { stale: { asOf: string } } | Record<string, never> {
    return this.asOf ? { stale: { asOf: this.asOf } } : {};
  }
}

export type ResolvedLoan = { ok: true; loan: LoanRecordDto; stale?: { asOf: string } } | ToolFailureResult;

/** Resolves the loan the customer means; ownership is always checked against the customer's own loan list. */
export async function resolveLoan(ctx: ToolContext, loanId?: string): Promise<ResolvedLoan> {
  const g = new Gather(ctx);
  let loans: LoanRecordDto[];
  try {
    loans = g.need('lms', await ctx.connectors.lms.getLoans(ctx.customerId, g.cc), 'your loans');
  } catch (e) {
    if (e instanceof ToolFailure) return e.result;
    throw e;
  }
  const stale = g.stale;
  const entities = ctx.session.entities;
  const pick = (loan: LoanRecordDto): ResolvedLoan => {
    entities.activeLoanId = loan.loanId;
    return { ok: true, loan, ...stale };
  };
  if (loanId) {
    const loan = loans.find((l) => l.loanId === loanId);
    if (!loan) return { ok: false, error: 'forbidden', message: `Loan ${loanId} is not one of this customer's loans.` };
    return pick(loan);
  }
  const active = entities.activeLoanId ? loans.find((l) => l.loanId === entities.activeLoanId) : undefined;
  if (active) return pick(active);
  if (loans.length === 1) return pick(loans[0]!);
  if (loans.length === 0) return { ok: false, error: 'not_found', message: 'No loans were found for this customer.' };
  return {
    ok: false,
    error: 'ambiguous',
    message: 'The customer has more than one loan; ask which one they mean.',
    options: loans.map((l) => ({ id: l.loanId, label: `${l.loanId} (${l.product.replace(/_/g, ' ')})` })),
  };
}

/** Like resolveLoan but throws a ToolFailure on failure. */
export async function requireLoan(ctx: ToolContext, g: Gather, loanId?: string): Promise<LoanRecordDto> {
  const r = await resolveLoan(ctx, loanId);
  if (!r.ok) throw new ToolFailure(r);
  g.noteStale(r.stale?.asOf);
  return r.loan;
}

export const recordSource = (system: SystemName, ref: string, label: string): Source => ({ kind: 'record', system, ref, label });
export const clauseSource = (c: PolicyClause): Source => ({ kind: 'clause', ref: `${c.id} v${c.version}`, label: c.title, detail: c.text });
export const calcSource = (ref: string, label: string, detail: string): Source => ({ kind: 'calc', ref, label, detail });

export function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const k = `${s.kind}|${s.system ?? ''}|${s.ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
