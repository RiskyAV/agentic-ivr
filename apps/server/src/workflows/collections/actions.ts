import { z } from 'zod';
import { formatDate, formatInr, ptpRule } from '@app/domain';
import type { ActionHandler, ValidateResult } from '../../platform/actions/types.js';
import { date, money, type BoundValue } from '../../platform/grounding/values.js';
import { Gather, recordSource, resolveLoan } from '../../platform/tools/helpers.js';
import type { ToolContext } from '../../platform/tools/types.js';
import { createRequest, isoDate, paiseField } from '../loan-servicing/actions.js';
import { activePtpDate, addDays, overdueFacts } from './overdue.js';

const loanIdField = z.string().min(1).optional().describe('The loan id; omit to use the active loan.');
const amountField = paiseField.optional().describe('Amount as the customer said it; omit to use the full overdue total.');

/** Resolves the loan and its overdue facts, or a customer-facing reason. */
async function overdueFor(ctx: ToolContext, loanId?: string) {
  const r = await resolveLoan(ctx, loanId);
  if (!r.ok) return { ok: false as const, reason: r.message };
  const g = new Gather(ctx);
  try {
    const facts = await overdueFacts(ctx, g, r.loan);
    return { ok: true as const, loan: r.loan, facts, g };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : 'Your account could not be checked right now.' };
  }
}

type PtpP = { loanId?: string; amount?: number; date: string };
const promiseToPay: ActionHandler<PtpP> = {
  type: 'promise_to_pay',
  title: 'Promise to pay',
  description:
    'Proposes recording a promise to pay a given amount on a given date (YYYY-MM-DD, within the promise window). It does NOT take any payment: the customer must confirm. Omit the amount to promise the full overdue total.',
  schema: z.object({ loanId: loanIdField, amount: amountField, date: isoDate.describe('The date the customer will pay, YYYY-MM-DD.') }),
  labels: { 'ptp.amount': 'Promised amount', 'ptp.date': 'Pay by', 'ptp.overdue_total': 'Total overdue today' },
  async validate(ctx, p): Promise<ValidateResult> {
    const rule = ptpRule(ctx.today);
    const latest = addDays(ctx.today, rule.maxDaysAhead);
    if (p.date < ctx.today || p.date > latest) {
      return { ok: false, reason: `A promise to pay must be for a date between today and ${formatDate(latest)} (${rule.clause.id}).` };
    }
    const o = await overdueFor(ctx, p.loanId);
    if (!o.ok) return o;
    if (!o.facts) return { ok: false, reason: 'There is no overdue amount on this loan, so no promise is needed.' };
    const amount = p.amount ?? o.facts.total;
    if (amount < o.facts.instalmentAmount) {
      return { ok: false, reason: `A promise to pay must be at least one instalment, ${formatInr(o.facts.instalmentAmount)}.` };
    }
    if (amount > o.facts.total) return { ok: false, reason: `The amount is more than the total overdue of ${formatInr(o.facts.total)}.` };
    let existing: string | undefined;
    try { existing = await activePtpDate(ctx, o.g); } catch { return { ok: false, reason: 'Your existing promises could not be checked right now.' }; }
    if (existing) return { ok: false, reason: `You already have an active promise to pay for ${formatDate(existing)}. Only ${rule.maxActive} can be active at a time (${rule.clause.id}).` };
    const figures: Record<string, BoundValue> = { 'ptp.amount': money(amount), 'ptp.date': date(p.date), 'ptp.overdue_total': money(o.facts.total) };
    return {
      ok: true, figures,
      params: { loanId: o.loan.loanId, amount, date: p.date },
      sources: [recordSource('lms', o.loan.loanId, `Loan ${o.loan.loanId}`), { kind: 'clause', ref: `${rule.clause.id} v${rule.clause.version}`, label: rule.clause.title, detail: rule.clause.text }],
      summary: `Record a promise to pay ${formatInr(amount)} on ${formatDate(p.date)} for loan ${o.loan.loanId} (total overdue today ${formatInr(o.facts.total)}).`,
    };
  },
  execute: (ctx, p, idemKey) =>
    createRequest(
      ctx, 'promise_to_pay', { loanId: p.loanId, amountPaise: p.amount, date: p.date }, idemKey,
      `Your promise to pay ${formatInr(p.amount!)} on ${formatDate(p.date)} has been recorded.`, p.loanId,
    ),
};

type LinkP = { loanId?: string; amount?: number };
const paymentLink: ActionHandler<LinkP> = {
  type: 'payment_link',
  title: 'Payment link',
  description:
    'Proposes creating a secure payment link for the customer to pay now. Nothing is created until the customer confirms. Omit the amount to use the full overdue total; pass an amount for a part payment.',
  schema: z.object({ loanId: loanIdField, amount: amountField }),
  labels: { 'link.amount': 'Payment amount', 'link.overdue_total': 'Total overdue today' },
  async validate(ctx, p): Promise<ValidateResult> {
    const o = await overdueFor(ctx, p.loanId);
    if (!o.ok) return o;
    if (!o.facts) return { ok: false, reason: 'There is no overdue amount on this loan, so no payment link is needed.' };
    const amount = p.amount ?? o.facts.total;
    if (amount <= 0) return { ok: false, reason: 'The amount must be more than zero.' };
    if (amount > o.loan.outstanding) return { ok: false, reason: `The amount is more than the outstanding balance of ${formatInr(o.loan.outstanding)}.` };
    return {
      ok: true,
      figures: { 'link.amount': money(amount), 'link.overdue_total': money(o.facts.total) },
      params: { loanId: o.loan.loanId, amount },
      sources: [recordSource('lms', o.loan.loanId, `Loan ${o.loan.loanId}`)],
      summary: `Create a payment link for ${formatInr(amount)} on loan ${o.loan.loanId} (total overdue today ${formatInr(o.facts.total)}).`,
    };
  },
  async execute(ctx, p, idemKey) {
    const r = await ctx.connectors.payments.createLink(p.loanId!, p.amount!, idemKey, { signal: ctx.signal, observer: ctx.tracer.observer });
    if (!r.ok) throw new Error(`payment link failed: ${r.error}`);
    return { reference: r.data.linkId, message: `Your payment link for ${formatInr(r.data.amountPaise)} is ready: ${r.data.url} (valid until ${formatDate(r.data.expiresAt.slice(0, 10))}).` };
  },
};

export const collectionsActions: ActionHandler[] = [promiseToPay, paymentLink];
