import { daysBetween, penalCharge, penalRule, type Loan, type Paise, type PolicyClause } from '@app/domain';
import type { Gather } from '../../platform/tools/helpers.js';
import type { ToolContext } from '../../platform/tools/types.js';

export interface OverdueFacts {
  instalments: number;
  instalmentAmount: Paise;
  principalOverdue: Paise;
  penal: Paise;
  total: Paise;
  dpd: number;
  oldestDueDate: string;
  penalRateBpsPa: number;
  penalClause: PolicyClause;
}

/** Pending instalments due on or before today (the snapshot's definition), with PEN-01 penal charge computed per instalment on its own days overdue. */
export async function overdueFacts(ctx: ToolContext, g: Gather, loan: Loan): Promise<OverdueFacts | null> {
  const list = g.need('payments', await ctx.connectors.payments.list(loan.loanId, { status: 'pending' }, g.cc), `the instalments of loan ${loan.loanId}`);
  const due = list.filter((p) => p.date <= ctx.today).sort((a, b) => a.date.localeCompare(b.date));
  if (due.length === 0) return null;
  const rule = penalRule(loan, ctx.today);
  const principalOverdue = due.reduce((t, p) => t + p.amount, 0);
  const penal = due.reduce((t, p) => t + penalCharge({ overdueAmount: p.amount, daysPastDue: daysBetween(p.date, ctx.today), penalRateBpsPa: rule.penalRateBpsPa }), 0);
  return {
    instalments: due.length, instalmentAmount: loan.emi, principalOverdue, penal, total: principalOverdue + penal,
    dpd: Math.max(0, daysBetween(due[0]!.date, ctx.today)), oldestDueDate: due[0]!.date,
    penalRateBpsPa: rule.penalRateBpsPa, penalClause: rule.clause,
  };
}

/** Date of the customer's active promise to pay (open, not yet past), if any. */
export async function activePtpDate(ctx: ToolContext, g: Gather): Promise<string | undefined> {
  const reqs = g.need('ops', await ctx.connectors.ops.list(ctx.customerId, g.cc), 'your service requests');
  return reqs
    .filter((r) => r.type === 'promise_to_pay' && r.status === 'open' && typeof r.params.date === 'string' && r.params.date >= ctx.today)
    .map((r) => r.params.date as string)
    .sort()[0];
}

export const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
