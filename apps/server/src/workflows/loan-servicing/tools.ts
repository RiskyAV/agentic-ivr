import { z } from 'zod';
import {
  bounceRule, foreclosureRule, foreclosureQuote, formatDate, formatInr, formatPct, parseAmount, penalRule, prepaymentRule,
  remainingTenure, selectClause, simulatePrepayment, type PolicyClause, type PolicyTopic,
} from '@app/domain';
import type { Source, TableView } from '@app/shared';
import { count, date, money, months, pct, text, type BoundValue } from '../../platform/grounding/values.js';
import {
  Gather, calcSource, clauseSource, dedupeSources, recordSource, requireLoan,
} from '../../platform/tools/helpers.js';
import { ToolFailure, type ToolContext, type ToolDef, type ToolResult } from '../../platform/tools/types.js';

type Values = Record<string, BoundValue>;
type Ok = Extract<ToolResult, { ok: true }>;

const loanId = z.string().min(1).optional().describe("Loan id; omit to use the customer's active loan.");
const GST_PCT = 18;
const gstOn = (charge: number) => Math.round((charge * GST_PCT) / 100);

const TOPICS = [
  'prepayment', 'foreclosure', 'rate_reset', 'bounce_charge', 'penal_charge',
  'emi_date_change', 'statement', 'dispute', 'collections_conduct', 'promise_to_pay', 'grievance',
] as const satisfies readonly PolicyTopic[];

const loanSrc = (id: string, product: string) => recordSource('lms', id, `Loan ${id} (${product.replace(/_/g, ' ')})`);

// ---------------------------------------------------------------- get_loan_details
const getLoanDetails: ToolDef<{ loanId?: string }> = {
  name: 'get_loan_details',
  description: "Current details of the customer's loan: outstanding, EMI, interest rate, next due date, tenure.",
  kind: 'read',
  filler: 'Let me pull up your loan.',
  schema: z.object({ loanId }),
  async run(ctx, args) {
    const g = new Gather(ctx);
    const picked = await requireLoan(ctx, g, args.loanId);
    const loan = g.need('lms', await ctx.connectors.lms.getLoan(picked.loanId, g.cc), `loan ${picked.loanId}`);
    const values: Values = {
      'loan.outstanding': money(loan.outstanding),
      'loan.principal': money(loan.principal),
      'loan.emi': money(loan.emi),
      'loan.rate': pct(loan.annualRateBps),
      'loan.next_due_date': date(loan.nextDueDate),
      'loan.remaining_months': months(loan.remainingMonths),
      'loan.tenure_months': months(loan.tenureMonths),
      'loan.rate_type': text(loan.rateType),
      'loan.product': text(loan.product.replace(/_/g, ' ')),
      'loan.sanction_date': date(loan.sanctionDate),
    };
    return { ok: true, data: { loanId: loan.loanId, product: loan.product }, values, sources: [loanSrc(loan.loanId, loan.product)], ...g.stale };
  },
};

// ---------------------------------------------------------------- get_repayment_schedule
const getRepaymentSchedule: ToolDef<{ loanId?: string; fromDate?: string; months?: number }> = {
  name: 'get_repayment_schedule',
  description: 'Upcoming instalments (due date, EMI, interest, principal, closing balance).',
  kind: 'read',
  filler: 'Checking your repayment schedule.',
  schema: z.object({
    loanId,
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('ISO date (YYYY-MM-DD); defaults to today.'),
    months: z.number().int().min(1).max(24).optional().describe('How many instalments, at most 24; default 6.'),
  }),
  async run(ctx, args) {
    const g = new Gather(ctx);
    const loan = await requireLoan(ctx, g, args.loanId);
    const rows = g.need(
      'lms',
      await ctx.connectors.lms.getSchedule(loan.loanId, { from: args.fromDate ?? ctx.today, months: args.months ?? 6 }, g.cc),
      `the schedule of loan ${loan.loanId}`,
    );
    const values: Values = { 'schedule.count': count(rows.length) };
    if (rows[0]) {
      values['schedule.first_due_date'] = date(rows[0].dueDate);
      values['schedule.first_emi'] = money(rows[0].emi);
    }
    for (const r of rows) {
      values[`schedule.${r.n}.due_date`] = date(r.dueDate);
      values[`schedule.${r.n}.emi`] = money(r.emi);
      values[`schedule.${r.n}.interest`] = money(r.interest);
      values[`schedule.${r.n}.principal`] = money(r.principal);
      values[`schedule.${r.n}.closing`] = money(r.closing);
    }
    const table: TableView = {
      title: `Repayment schedule for ${loan.loanId}`,
      columns: ['#', 'Due date', 'EMI', 'Interest', 'Principal', 'Balance after'],
      rows: rows.map((r) => [String(r.n), formatDate(r.dueDate), formatInr(r.emi), formatInr(r.interest), formatInr(r.principal), formatInr(r.closing)]),
    };
    return { ok: true, data: { loanId: loan.loanId, schedule: rows }, values, sources: [loanSrc(loan.loanId, loan.product)], tables: [table], ...g.stale };
  },
};

// ---------------------------------------------------------------- get_payment_history
const getPaymentHistory: ToolDef<{ loanId?: string; months?: number; status?: 'failed' | 'success' | 'all' }> = {
  name: 'get_payment_history',
  description: 'Past EMI payments with status. For failed payments, says whether any bounce charge levied is valid under policy.',
  kind: 'read',
  filler: 'Looking at your payment history.',
  schema: z.object({
    loanId,
    months: z.number().int().min(1).max(24).optional().describe('Look-back window in months, at most 24; default 6.'),
    status: z.enum(['failed', 'success', 'all']).optional().describe('Filter by status; default all.'),
  }),
  async run(ctx, args) {
    const g = new Gather(ctx);
    const loan = await requireLoan(ctx, g, args.loanId);
    const list = g.need(
      'payments',
      await ctx.connectors.payments.list(loan.loanId, { months: args.months ?? 6, status: args.status ?? 'all' }, g.cc),
      `the payment history of loan ${loan.loanId}`,
    );
    const values: Values = { 'payments.count': count(list.length) };
    const sources: Source[] = [loanSrc(loan.loanId, loan.product)];
    const rows = list.map((p) => {
      let bounceChargeValid: boolean | undefined;
      if (p.status === 'failed') {
        const rule = bounceRule(p.failureCode ?? '', ctx.today);
        const levied = p.bounceCharge ?? 0;
        bounceChargeValid = levied === 0 ? true : rule.chargeable && levied === rule.amount;
        values[`payments.${p.paymentId}.bounce_charge`] = money(levied);
        values[`payments.${p.paymentId}.bounce_charge_valid`] = text(bounceChargeValid ? 'yes' : 'no');
        values[`payments.${p.paymentId}.policy_charge`] = money(rule.amount);
        sources.push(clauseSource(rule.clause));
      }
      values[`payments.${p.paymentId}.amount`] = money(p.amount);
      values[`payments.${p.paymentId}.date`] = date(p.date);
      return { ...p, ...(bounceChargeValid !== undefined && { bounceChargeValid }) };
    });
    values['payments.failed_count'] = count(list.filter((p) => p.status === 'failed').length);
    const table: TableView = {
      title: `Payments for ${loan.loanId}`,
      columns: ['Date', 'Amount', 'Status', 'Reason', 'Bounce charge', 'Valid under policy'],
      rows: rows.map((r) => [
        formatDate(r.date), formatInr(r.amount), r.status, r.failureReason ?? '',
        r.status === 'failed' ? formatInr(r.bounceCharge ?? 0) : '',
        r.bounceChargeValid === undefined ? '' : r.bounceChargeValid ? 'yes' : 'no',
      ]),
    };
    return { ok: true, data: { loanId: loan.loanId, payments: rows }, values, sources: dedupeSources(sources), tables: [table], ...g.stale };
  },
};

// ---------------------------------------------------------------- get_policy
const getPolicy: ToolDef<{ topic: PolicyTopic; loanId?: string }> = {
  name: 'get_policy',
  description: "The bank policy clause on a topic that applies to the customer's loan, with its key parameters.",
  kind: 'read',
  filler: 'Checking the policy.',
  schema: z.object({ topic: z.enum(TOPICS).describe('Policy topic.'), loanId }),
  async run(ctx, args) {
    const g = new Gather(ctx);
    const loan = await requireLoan(ctx, g, args.loanId);
    let clause: PolicyClause;
    const values: Values = {};
    const sources: Source[] = [];
    try {
      switch (args.topic) {
        case 'prepayment': {
          const r = prepaymentRule(loan, ctx.today);
          clause = r.clause;
          values['policy.charge_pct'] = pct(Math.round(r.chargePct * 100));
          values['policy.min_amount'] = money(r.minAmount);
          break;
        }
        case 'foreclosure': {
          const r = foreclosureRule(loan, ctx.today);
          clause = r.clause;
          values['policy.charge_pct'] = pct(Math.round(r.chargePct * 100));
          values['policy.eligible'] = text(r.eligible ? 'yes' : 'no');
          if (r.lockInEndsOn) values['policy.lock_in_ends_on'] = date(r.lockInEndsOn);
          break;
        }
        case 'bounce_charge': {
          const r = bounceRule('INSUFFICIENT_FUNDS', ctx.today);
          clause = r.clause;
          values['policy.bounce_charge'] = money(r.amount);
          break;
        }
        case 'penal_charge': {
          const r = penalRule(loan, ctx.today);
          clause = r.clause;
          values['policy.penal_rate'] = pct(r.penalRateBpsPa);
          break;
        }
        default:
          clause = selectClause(args.topic, loan, ctx.today);
      }
    } catch (e) {
      throw new ToolFailure({ ok: false, error: 'not_found', message: e instanceof Error ? e.message : 'No applicable policy clause.' });
    }
    sources.push(clauseSource(clause), loanSrc(loan.loanId, loan.product));
    ctx.session.entities.lastTopic = args.topic;
    return {
      ok: true, data: { clauseId: clause.id, version: clause.version, title: clause.title, text: clause.text },
      values, sources: dedupeSources(sources), ...g.stale,
    };
  },
};

// ---------------------------------------------------------------- get_service_requests
const getServiceRequests: ToolDef<Record<string, never>> = {
  name: 'get_service_requests',
  description: "The customer's open and past service requests (disputes, statements, callbacks).",
  kind: 'read',
  filler: 'Checking your service requests.',
  schema: z.object({}),
  async run(ctx) {
    const g = new Gather(ctx);
    const list = g.need('ops', await ctx.connectors.ops.list(ctx.customerId, g.cc), 'your service requests');
    const values: Values = { 'requests.count': count(list.length) };
    for (const r of list) {
      values[`requests.${r.id}.type`] = text(r.type);
      values[`requests.${r.id}.status`] = text(r.status);
      values[`requests.${r.id}.created_on`] = date(r.createdAt.slice(0, 10));
    }
    const table: TableView = {
      title: 'Service requests',
      columns: ['Reference', 'Type', 'Status', 'Created'],
      rows: list.map((r) => [r.id, r.type, r.status, formatDate(r.createdAt.slice(0, 10))]),
    };
    return {
      ok: true, data: { requests: list }, values,
      sources: list.slice(0, 5).map((r) => recordSource('ops', r.id, `Service request ${r.id}`)), tables: [table], ...g.stale,
    };
  },
};

// ---------------------------------------------------------------- explain_emi_change
const explainEmiChange: ToolDef<{ loanId?: string }> = {
  name: 'explain_emi_change',
  description: 'Explains why the EMI changed: old and new EMI, the cause (rate reset, tenure change, prepayment), the rate change, and the effect of keeping the old EMI.',
  kind: 'calc',
  filler: 'Let me look at what changed on your EMI.',
  schema: z.object({ loanId }),
  async run(ctx, args) {
    const g = new Gather(ctx);
    const picked = await requireLoan(ctx, g, args.loanId);
    const loan = g.need('lms', await ctx.connectors.lms.getLoan(picked.loanId, g.cc), `loan ${picked.loanId}`);
    const change = loan.emiHistory[loan.emiHistory.length - 1];
    if (!change) return { ok: false, error: 'not_found', message: `No EMI change is on record for loan ${loan.loanId}.` };
    const rate = loan.rateHistory[loan.rateHistory.length - 1];
    const reason = change.reason ?? '';
    const cause = reason === 'tenure_change' || reason === 'prepayment' ? reason : reason === 'rate_reset' || rate ? 'rate_reset' : 'tenure_change';
    const newRate = rate?.newRateBps ?? loan.annualRateBps;
    const oldRate = rate?.oldRateBps ?? loan.annualRateBps;
    const values: Values = {
      'emi_change.old_emi': money(change.oldEmi),
      'emi_change.new_emi': money(change.newEmi),
      'emi_change.difference': money(Math.abs(change.newEmi - change.oldEmi)),
      'emi_change.cause': text(cause),
      'emi_change.effective_date': date(change.effectiveDate),
      'emi_change.old_rate': pct(oldRate),
      'emi_change.new_rate': pct(newRate),
      'emi_change.remaining_months': months(loan.remainingMonths),
    };
    const sources: Source[] = [loanSrc(loan.loanId, loan.product)];
    const altMonths = remainingTenure(loan.outstanding, newRate, change.oldEmi);
    if (Number.isFinite(altMonths)) {
      values['emi_change.alt_tenure_months_if_old_emi'] = months(altMonths);
      values['emi_change.alt_extra_months'] = months(Math.max(altMonths - loan.remainingMonths, 0));
      sources.push(calcSource(
        'remainingTenure', 'Tenure if the old EMI is kept',
        `outstanding ${formatInr(loan.outstanding)} at ${formatPct(newRate)} with EMI ${formatInr(change.oldEmi)}`,
      ));
    }
    if (cause === 'rate_reset') {
      try { sources.push(clauseSource(selectClause('rate_reset', loan, ctx.today))); } catch { /* not a floating loan */ }
    }
    return { ok: true, data: { loanId: loan.loanId, change, rateChange: rate ?? null }, values, sources: dedupeSources(sources), ...g.stale };
  },
};

// ---------------------------------------------------------------- simulate_prepayment
// Accepts a number or a string from the model; numbers are stringified so the declared schema stays a plain string.
const amountSchema = z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(1))
  .describe('Prepayment amount as the customer said it, e.g. "50k", "1.5 lakh" or "50000".');

const simulatePrepaymentTool: ToolDef<{ loanId?: string; amount: string; mode?: 'reduce_tenure' | 'reduce_emi' | 'both' }> = {
  name: 'simulate_prepayment',
  description: 'Simulates a part-prepayment: charge, GST, months saved, interest saved if tenure is reduced, new EMI and interest saved if the EMI is reduced.',
  kind: 'calc',
  filler: 'Running the numbers.',
  schema: z.object({
    loanId,
    amount: amountSchema,
    mode: z.enum(['reduce_tenure', 'reduce_emi', 'both']).optional().describe('What the prepayment should reduce; default both.'),
  }),
  async run(ctx, args) {
    const parsed = parseAmount(args.amount);
    if (!parsed.ok) return { ok: false, error: 'invalid', message: `Could not understand the amount "${args.amount}": ${parsed.reason}. Ask the customer for a clear amount.` };
    const g = new Gather(ctx);
    const picked = await requireLoan(ctx, g, args.loanId);
    const loan = g.need('lms', await ctx.connectors.lms.getLoan(picked.loanId, g.cc), `loan ${picked.loanId}`);
    const rule = prepaymentRule(loan, ctx.today);
    const amount = parsed.paise;
    if (amount < rule.minAmount) {
      return {
        ok: false, error: 'invalid',
        message: `The minimum prepayment is ${formatInr(rule.minAmount)}; ${formatInr(amount)} is below it.`,
        values: { 'prepay.min_amount': money(rule.minAmount) },
      };
    }
    const sched = g.need(
      'lms', await ctx.connectors.lms.getSchedule(loan.loanId, { from: loan.nextDueDate, months: 600 }, g.cc),
      `the schedule of loan ${loan.loanId}`,
    );
    const sim = simulatePrepayment({
      outstanding: loan.outstanding, annualRateBps: loan.annualRateBps, emi: loan.emi,
      remainingMonths: sched.length || loan.remainingMonths, amount, chargePct: rule.chargePct,
      firstDueDate: sched[0]?.dueDate ?? loan.nextDueDate,
    });
    const gst = gstOn(sim.charge);
    const mode = args.mode ?? 'both';
    const values: Values = {
      'prepay.amount': money(amount),
      'prepay.outstanding': money(loan.outstanding),
      'prepay.current_emi': money(loan.emi),
      'prepay.charge_pct': pct(Math.round(rule.chargePct * 100)),
      'prepay.charge': money(sim.charge),
      'prepay.charge_gst': money(gst),
    };
    if (mode !== 'reduce_emi') {
      values['prepay.months_saved'] = months(sim.reduceTenure.monthsSaved);
      values['prepay.new_tenure_months'] = months(sim.reduceTenure.months);
      values['prepay.interest_saved_tenure'] = money(sim.reduceTenure.interestSaved);
      values['prepay.net_saving_tenure'] = money(sim.reduceTenure.interestSaved - sim.charge - gst);
    }
    if (mode !== 'reduce_tenure') {
      values['prepay.new_emi'] = money(sim.reduceEmi.newEmi);
      values['prepay.emi_reduction'] = money(sim.reduceEmi.emiReduction);
      values['prepay.interest_saved_emi'] = money(sim.reduceEmi.interestSaved);
      values['prepay.net_saving_emi'] = money(sim.reduceEmi.interestSaved - sim.charge - gst);
    }
    if (amount >= loan.outstanding) values['prepay.note'] = text('covers_full_outstanding');
    ctx.session.entities.lastAmount = amount;
    ctx.session.entities.lastTopic = 'prepayment';
    const sources = [
      loanSrc(loan.loanId, loan.product),
      clauseSource(rule.clause),
      calcSource(
        'simulatePrepayment', 'Prepayment simulation',
        `prepay ${formatInr(amount)} on ${formatInr(loan.outstanding)} at ${formatPct(loan.annualRateBps)}, EMI ${formatInr(loan.emi)}, ${sched.length || loan.remainingMonths} months left`,
      ),
    ];
    return { ok: true, data: { loanId: loan.loanId, mode, simulation: sim, gst }, values, sources, ...g.stale };
  },
};

// ---------------------------------------------------------------- check_foreclosure
const checkForeclosure: ToolDef<{ loanId?: string }> = {
  name: 'check_foreclosure',
  description: 'Whether the loan can be foreclosed (closed early) today, and the payable amount: principal, accrued interest, charge, GST and total.',
  kind: 'calc',
  filler: 'Checking foreclosure.',
  schema: z.object({ loanId }),
  async run(ctx, args) {
    const g = new Gather(ctx);
    const picked = await requireLoan(ctx, g, args.loanId);
    const loan = g.need('lms', await ctx.connectors.lms.getLoan(picked.loanId, g.cc), `loan ${picked.loanId}`);
    const rule = foreclosureRule(loan, ctx.today);
    const prepay = prepaymentRule(loan, ctx.today);
    const values: Values = {
      'foreclosure.eligible': text(rule.eligible ? 'yes' : 'no'),
      'foreclosure.charge_pct': pct(Math.round(rule.chargePct * 100)),
      'foreclosure.as_on': date(ctx.today),
    };
    if (rule.lockInEndsOn) values['foreclosure.lock_in_ends_on'] = date(rule.lockInEndsOn);
    const sources: Source[] = [loanSrc(loan.loanId, loan.product), clauseSource(rule.clause), clauseSource(prepay.clause)];
    let quote;
    if (rule.eligible) {
      quote = foreclosureQuote({
        outstanding: loan.outstanding, annualRateBps: loan.annualRateBps,
        lastDueDate: loan.lastPaidDueDate ?? loan.disbursedOn, onDate: ctx.today, chargePct: rule.chargePct,
      });
      values['foreclosure.principal'] = money(quote.principal);
      values['foreclosure.accrued_interest'] = money(quote.accruedInterest);
      values['foreclosure.charge'] = money(quote.charge);
      values['foreclosure.gst'] = money(quote.gstOnCharge);
      values['foreclosure.total'] = money(quote.total);
      sources.push(calcSource(
        'foreclosureQuote', 'Foreclosure quote',
        `${formatInr(loan.outstanding)} at ${formatPct(loan.annualRateBps)} accrued since ${formatDate(loan.lastPaidDueDate ?? loan.disbursedOn)}, charge ${rule.chargePct}%`,
      ));
    }
    ctx.session.entities.lastTopic = 'foreclosure';
    return { ok: true, data: { loanId: loan.loanId, eligible: rule.eligible, lockInEndsOn: rule.lockInEndsOn ?? null, quote: quote ?? null }, values, sources: dedupeSources(sources), ...g.stale };
  },
};

// ---------------------------------------------------------------- list_options
const listOptions: ToolDef<{ loanId?: string }> = {
  name: 'list_options',
  description: 'Overview of what the customer can do with the loan: prepay (charge, minimum), foreclose, and any recent EMI change.',
  kind: 'calc',
  filler: 'Let me check your options.',
  schema: z.object({ loanId }),
  async run(ctx, args) {
    const g = new Gather(ctx);
    const loan = await requireLoan(ctx, g, args.loanId);
    const sub = { loanId: loan.loanId };
    const [fc, emiChange] = await Promise.all([checkForeclosure.run(ctx, sub), explainEmiChange.run(ctx, sub)]);
    if (!fc.ok) return fc;
    if (!emiChange.ok && emiChange.error !== 'not_found') return emiChange;
    const rule = prepaymentRule(loan, ctx.today);
    const values: Values = {
      ...fc.values,
      ...(emiChange.ok && emiChange.values),
      'options.prepay_charge_pct': pct(Math.round(rule.chargePct * 100)),
      'options.prepay_min_amount': money(rule.minAmount),
      'options.foreclosure_eligible': fc.values['foreclosure.eligible']!,
      'options.has_emi_change': text(emiChange.ok ? 'yes' : 'no'),
    };
    if (fc.values['foreclosure.total']) values['options.foreclosure_total'] = fc.values['foreclosure.total'];
    if (fc.values['foreclosure.lock_in_ends_on']) values['options.lock_in_ends_on'] = fc.values['foreclosure.lock_in_ends_on'];
    const parts: Ok[] = [fc, ...(emiChange.ok ? [emiChange] : [])];
    const stale = [g.stale.stale?.asOf, ...parts.map((p) => p.stale?.asOf)].filter((x): x is string => !!x).sort()[0];
    return {
      ok: true,
      data: {
        loanId: loan.loanId,
        options: [
          { id: 'prepay', label: 'Part-prepay the loan', chargePct: rule.chargePct, minAmount: rule.minAmount },
          { id: 'foreclose', label: 'Close the loan early', eligible: fc.values['foreclosure.eligible'] },
          ...(emiChange.ok ? [{ id: 'emi_change', label: 'Understand the recent EMI change' }] : []),
        ],
      },
      values,
      sources: dedupeSources([...parts.flatMap((p) => p.sources), clauseSource(rule.clause)]),
      ...(stale && { stale: { asOf: stale } }),
    };
  },
};

export const loanServicingTools: ToolDef[] = [
  getLoanDetails, getRepaymentSchedule, getPaymentHistory, getPolicy, getServiceRequests,
  explainEmiChange, simulatePrepaymentTool, checkForeclosure, listOptions,
];

export type { ToolContext };
