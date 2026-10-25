import { z } from 'zod';
import { addMonths, formatDate, formatInr, parseAmount, type Payment } from '@app/domain';
import type { Source } from '@app/shared';
import type { ActionHandler, ValidateResult } from '../../platform/actions/types.js';
import { date, money, text, type BoundValue } from '../../platform/grounding/values.js';
import { recordSource, resolveLoan } from '../../platform/tools/helpers.js';
import type { ToolContext } from '../../platform/tools/types.js';
import type { OpsRequestType } from '../../platform/connectors/types.js';
import { assessBounce, failedPaymentsAllLoans } from './payments.js';
import { simulatePrepaymentTool } from './tools.js';

const loanIdField = z.string().min(1).describe('The id of the loan, as returned by the loan tools.');

/** Normalises a loosely phrased amount (number or string) to integer paise; rejects what it cannot parse. */
const paiseField = z
  .preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(1))
  .describe('Amount as the customer said it, e.g. "50k", "1.5 lakh" or "50000".')
  .transform((s, c) => {
    const r = parseAmount(s);
    if (!r.ok) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: `could not understand the amount "${s}" (${r.reason})` });
      return z.NEVER;
    }
    return r.paise;
  });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'not a real date');

/** Creates the Ops service request; the proposal id is the idempotency key. Caches that the new request makes stale are dropped. */
async function createRequest(ctx: ToolContext, type: OpsRequestType, params: Record<string, unknown>, idemKey: string, label: string, invalidateLoanId?: string) {
  const r = await ctx.connectors.ops.create(ctx.customerId, type, params, idemKey, { signal: ctx.signal, observer: ctx.tracer.observer });
  if (!r.ok) throw new Error(`ops create failed: ${r.error}`);
  ctx.connectors.invalidate('ops', `ops:requests:${ctx.customerId}`);
  if (invalidateLoanId) {
    ctx.connectors.invalidate('lms', `lms:loan:${invalidateLoanId}`);
    ctx.connectors.invalidate('lms', `lms:loans:${ctx.customerId}`);
  }
  return { reference: r.data.id, message: `${label} Your reference is ${r.data.id}.` };
}

// ---------------------------------------------------------------- prepayment
type PrepayP = { loanId: string; amount: number; mode: 'reduce_tenure' | 'reduce_emi' };
const PREPAY_KEYS = {
  common: ['prepay.amount', 'prepay.charge', 'prepay.charge_gst'],
  reduce_tenure: ['prepay.months_saved', 'prepay.interest_saved_tenure'],
  reduce_emi: ['prepay.new_emi', 'prepay.interest_saved_emi'],
};

const prepayment: ActionHandler<PrepayP> = {
  type: 'prepayment',
  title: 'Part-prepayment',
  description:
    'Proposes a part-prepayment of the loan. It does NOT make the payment: the customer must confirm in the app or by voice. Use only after the customer has stated an amount and whether to reduce tenure or EMI.',
  schema: z.object({
    loanId: loanIdField,
    amount: paiseField,
    mode: z.enum(['reduce_tenure', 'reduce_emi']).describe('Whether the prepayment should shorten the tenure or lower the EMI.'),
  }),
  labels: {
    'prepay.amount': 'Prepayment amount', 'prepay.charge': 'Prepayment charge', 'prepay.charge_gst': 'GST on charge',
    'prepay.months_saved': 'Months saved', 'prepay.interest_saved_tenure': 'Interest saved',
    'prepay.new_emi': 'New EMI', 'prepay.interest_saved_emi': 'Interest saved',
  },
  async validate(ctx, p): Promise<ValidateResult> {
    // Ownership, minimum amount and the numbers all come from the same simulation the customer's questions use.
    const sim = await simulatePrepaymentTool.run(ctx, { loanId: p.loanId, amount: String(p.amount / 100), mode: p.mode });
    if (!sim.ok) return { ok: false, reason: sim.message };
    const outstanding = sim.values['prepay.outstanding'];
    if (outstanding?.kind === 'money' && p.amount > outstanding.paise) {
      return { ok: false, reason: `The amount ${formatInr(p.amount)} is more than the outstanding balance of ${formatInr(outstanding.paise)}.` };
    }
    const figures: Record<string, BoundValue> = {};
    for (const k of [...PREPAY_KEYS.common, ...PREPAY_KEYS[p.mode]]) {
      const v = sim.values[k];
      if (!v) return { ok: false, reason: 'The prepayment could not be calculated.' };
      figures[k] = v;
    }
    const charge = figures['prepay.charge'] as { paise: number };
    const gst = figures['prepay.charge_gst'] as { paise: number };
    const effect =
      p.mode === 'reduce_tenure'
        ? `shorten the tenure by ${(figures['prepay.months_saved'] as { n: number }).n} months and save about ${formatInr((figures['prepay.interest_saved_tenure'] as { paise: number }).paise)} in interest`
        : `lower the EMI to ${formatInr((figures['prepay.new_emi'] as { paise: number }).paise)} and save about ${formatInr((figures['prepay.interest_saved_emi'] as { paise: number }).paise)} in interest`;
    return {
      ok: true, figures, sources: sim.sources,
      summary: `Prepay ${formatInr(p.amount)} on loan ${p.loanId} to ${effect}. Prepayment charge ${formatInr(charge.paise)} plus GST ${formatInr(gst.paise)}.`,
    };
  },
  execute: (ctx, p, idemKey) =>
    createRequest(ctx, 'prepayment', { loanId: p.loanId, amountPaise: p.amount, mode: p.mode }, idemKey, `Your prepayment request for ${formatInr(p.amount)} has been submitted.`, p.loanId),
};

// ---------------------------------------------------------------- dispute
type DisputeP = { paymentId: string; reason: string };

/** Resolves an ordinal alias (`failed_1`, as get_payment_history keys them) or a real payment id against the customer's own failed payments. */
async function resolveFailedPayment(ctx: ToolContext, ref: string): Promise<{ ok: true; pay: Payment } | { ok: false; reason: string }> {
  const all = await failedPaymentsAllLoans(ctx);
  if (!all.ok) return all;
  const alias = /^failed_(\d+)$/.exec(ref.trim());
  const pay = alias ? all.data[Number(alias[1]) - 1] : all.data.find((x) => x.paymentId === ref);
  if (!pay) return { ok: false, reason: 'I could not find that failed payment in your account.' };
  return { ok: true, pay };
}

const dispute: ActionHandler<DisputeP> = {
  type: 'dispute',
  title: 'Dispute a bounce charge',
  description:
    'Proposes a dispute of a bounce charge levied on one of the customer\'s failed payments. It does NOT file anything: the customer must confirm. Pass the payment alias from get_payment_history (failed_1, failed_2, ...). Only a payment whose disputable value is yes can be disputed.',
  schema: z.object({
    paymentId: z.string().min(1).describe('The payment alias from the payment history, for example "failed_1".'),
    reason: z.string().trim().min(1).max(300).describe('Why the charge should be reversed, in the customer\'s words (max 300 characters).'),
  }),
  labels: { 'dispute.disputed_amount': 'Charge disputed', 'dispute.payment_date': 'Failed payment dated' },
  // Runs at propose and again at confirm. The alias is frozen to the real payment id at propose (via `params`), so the
  // terms hash binds to that specific payment; at confirm the stored id is re-checked against live data and policy.
  async validate(ctx, p): Promise<ValidateResult> {
    const r = await resolveFailedPayment(ctx, p.paymentId);
    if (!r.ok) return r;
    const pay = r.pay;
    const { refundable, clause } = assessBounce(pay, ctx.today);
    if (!pay.bounceCharge) return { ok: false, reason: 'No bounce charge was levied on that payment, so there is nothing to dispute.' };
    if (refundable <= 0) return { ok: false, reason: `This charge was applied correctly under policy ${clause.id}, so it cannot be disputed.` };
    const sources: Source[] = [recordSource('payments', pay.paymentId, `Failed payment of ${formatInr(pay.amount)} on ${formatDate(pay.date)}`)];
    return {
      ok: true, sources,
      params: { paymentId: pay.paymentId, reason: p.reason },
      figures: { 'dispute.disputed_amount': money(refundable), 'dispute.payment_date': date(pay.date) },
      summary: `Dispute the wrongly applied bounce charge of ${formatInr(refundable)} on your failed EMI of ${formatInr(pay.amount)} dated ${formatDate(pay.date)} (loan ${pay.loanId}).`,
    };
  },
  execute: (ctx, p, idemKey) =>
    createRequest(ctx, 'dispute', { paymentId: p.paymentId, reason: p.reason }, idemKey, 'Your dispute has been raised and will be reviewed.'),
};

// ---------------------------------------------------------------- statement
type StatementP = { loanId: string; fromDate: string; toDate: string };

const statement: ActionHandler<StatementP> = {
  type: 'statement',
  title: 'Loan statement',
  description: 'Proposes a statement request for a loan over a date range (at most 36 months back). The customer must confirm; nothing is sent until then.',
  schema: z.object({ loanId: loanIdField, fromDate: isoDate.describe('Start date, YYYY-MM-DD.'), toDate: isoDate.describe('End date, YYYY-MM-DD.') }),
  labels: { 'statement.from': 'From', 'statement.to': 'To' },
  async validate(ctx, p): Promise<ValidateResult> {
    if (p.fromDate > p.toDate) return { ok: false, reason: 'The start date must be on or before the end date.' };
    if (p.fromDate < addMonths(ctx.today, -36)) return { ok: false, reason: `Statements can go back at most 36 months, to ${formatDate(addMonths(ctx.today, -36))}.` };
    if (p.toDate > ctx.today) return { ok: false, reason: 'The end date cannot be in the future.' };
    const r = await resolveLoan(ctx, p.loanId);
    if (!r.ok) return { ok: false, reason: r.message };
    return {
      ok: true,
      figures: { 'statement.from': date(p.fromDate), 'statement.to': date(p.toDate) },
      sources: [recordSource('lms', r.loan.loanId, `Loan ${r.loan.loanId}`)],
      summary: `Request a statement for loan ${p.loanId} from ${formatDate(p.fromDate)} to ${formatDate(p.toDate)}.`,
    };
  },
  execute: (ctx, p, idemKey) =>
    createRequest(ctx, 'statement', { loanId: p.loanId, fromDate: p.fromDate, toDate: p.toDate }, idemKey, 'Your statement request has been raised.'),
};

// ---------------------------------------------------------------- ticket
const CATEGORIES = ['payment', 'account', 'documents', 'complaint', 'other'] as const;
type TicketP = { category: (typeof CATEGORIES)[number]; description: string };

const ticket: ActionHandler<TicketP> = {
  type: 'ticket',
  title: 'Service request',
  description: 'Proposes raising a general service request for the customer. The customer must confirm; nothing is raised until then.',
  schema: z.object({
    category: z.enum(CATEGORIES).describe('Request category.'),
    description: z.string().trim().min(1).max(500).describe('What the customer needs, at most 500 characters.'),
  }),
  labels: { 'ticket.category': 'Category' },
  async validate(_ctx, p): Promise<ValidateResult> {
    return { ok: true, figures: { 'ticket.category': text(p.category) }, summary: `Raise a ${p.category} service request: "${p.description}"` };
  },
  execute: (ctx, p, idemKey) =>
    createRequest(ctx, 'ticket', { category: p.category, description: p.description }, idemKey, 'Your service request has been raised.'),
};

export const loanServicingActions: ActionHandler[] = [prepayment, dispute, statement, ticket];
