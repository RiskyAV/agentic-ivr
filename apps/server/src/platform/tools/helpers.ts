import type { Source, SystemName } from '@app/shared';
import type { PolicyClause, PolicyTopic } from '@app/domain';
import type { LoanRecordDto, PolicyClauseDto } from '../connectors/types.js';
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

export type PolicyFetch = Fetched<PolicyClauseDto[]>;

/** Starts a Policy-service fetch for a topic; never rejects, so it is safe to leave un-awaited if the tool fails first. */
export function startPolicy(ctx: ToolContext, topic: PolicyTopic): Promise<PolicyFetch> {
  return ctx.connectors.policy
    .byTopic(topic, { signal: ctx.signal, observer: ctx.tracer.observer })
    .catch((): PolicyFetch => ({ ok: false, error: 'unavailable' }));
}

/**
 * Citation for a clause the domain rules selected. Rule evaluation stays in @app/domain (D-017); the text shown comes
 * from the Policy service. If the service is down the local copy is cited (flagged in the detail and in a span); if the
 * service disagrees with the domain on version or text, the service's text is cited and `policy_mismatch` is recorded.
 */
export function citeClause(ctx: ToolContext, g: Gather, local: PolicyClause, fetched: PolicyFetch): Source {
  if (!fetched.ok) {
    ctx.tracer.span('policy_fallback', { clause: `${local.id} v${local.version}`, reason: fetched.error })();
    return { ...clauseSource(local), detail: `${local.text} (local policy copy)` };
  }
  g.noteStale(fetched.stale?.asOf);
  const same = fetched.data.filter((c) => c.id === local.id);
  const svc = same.find((c) => c.version === local.version) ?? same.sort((a, b) => b.version - a.version)[0];
  if (!svc) {
    ctx.tracer.span('policy_fallback', { clause: `${local.id} v${local.version}`, reason: 'not_in_service' })();
    ctx.tracer.span('policy_mismatch', { clause: local.id, domainVersion: local.version, serviceVersion: 'none' })();
    return { ...clauseSource(local), detail: `${local.text} (local policy copy)` };
  }
  if (svc.version !== local.version || svc.text !== local.text) {
    ctx.tracer.span('policy_mismatch', { clause: local.id, domainVersion: local.version, serviceVersion: svc.version })();
  }
  return clauseSource(svc);
}
