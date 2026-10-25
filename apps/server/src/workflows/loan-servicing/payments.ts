import { bounceRule, type Payment, type PolicyClause } from '@app/domain';
import type { ToolContext } from '../../platform/tools/types.js';

/** Failed payments newest first, ties by id descending: the one order behind every `failed_N` alias. */
export const orderFailed = (list: Payment[]): Payment[] =>
  list.filter((p) => p.status === 'failed').sort((x, y) => y.date.localeCompare(x.date) || y.paymentId.localeCompare(x.paymentId));

export type FailedPayments = { ok: true; data: Payment[] } | { ok: false; reason: string };

/** All of the customer's failed payments across all their loans, in alias order. Shared by the history tool and the dispute action. */
export async function failedPaymentsAllLoans(ctx: ToolContext): Promise<FailedPayments> {
  const cc = { signal: ctx.signal, observer: ctx.tracer.observer };
  const loans = await ctx.connectors.lms.getLoans(ctx.customerId, cc);
  if (!loans.ok) return { ok: false, reason: 'Your loans could not be retrieved right now.' };
  const lists = await Promise.all(loans.data.map((l) => ctx.connectors.payments.list(l.loanId, { status: 'failed' }, cc)));
  if (lists.some((l) => !l.ok)) return { ok: false, reason: 'Your payment history could not be retrieved right now.' };
  return { ok: true, data: orderFailed(lists.flatMap((l) => (l.ok ? l.data : []))) };
}

/** What was charged, what policy allows, and the difference to refund. */
export function assessBounce(p: Payment, today: string): { levied: number; due: number; refundable: number; clause: PolicyClause } {
  const rule = bounceRule(p.failureCode ?? '', today);
  const levied = p.bounceCharge ?? 0;
  const due = rule.chargeable ? rule.amount : 0;
  return { levied, due, refundable: Math.max(levied - due, 0), clause: rule.clause };
}
