import { z } from 'zod';
import { formatInr, ptpRule, selectClause } from '@app/domain';
import { count, date, money, pct, text, type BoundValue } from '../../platform/grounding/values.js';
import { Gather, calcSource, citeClause, dedupeSources, recordSource, requireLoan, startPolicy } from '../../platform/tools/helpers.js';
import { ToolFailure, type ToolDef } from '../../platform/tools/types.js';
import { activePtpDate, overdueFacts } from './overdue.js';

const getOverdueSummary: ToolDef<{ loanId?: string }> = {
  name: 'get_overdue_summary',
  description:
    'Everything about what the customer owes on an overdue loan: overdue instalments, days past due, penal charge, total due today, the promise-to-pay window and any promise already active. Call this first for any question about the overdue amount.',
  kind: 'read',
  filler: 'Let me check your account.',
  schema: z.object({ loanId: z.string().min(1).optional().describe("Loan id; omit to use the customer's active loan.") }),
  async run(ctx, args) {
    const g = new Gather(ctx);
    const penPol = startPolicy(ctx, 'penal_charge');
    const colPol = startPolicy(ctx, 'collections_conduct');
    const ptpPol = startPolicy(ctx, 'promise_to_pay');
    const loan = await requireLoan(ctx, g, args.loanId);
    const [facts, activePtp] = await Promise.all([overdueFacts(ctx, g, loan), activePtpDate(ctx, g)]);
    if (!facts) throw new ToolFailure({ ok: false, error: 'not_found', message: `Loan ${loan.loanId} has no overdue amount.` });
    const ptp = ptpRule(ctx.today);
    const values: Record<string, BoundValue> = {
      'overdue.dpd': count(facts.dpd),
      'overdue.instalments_count': count(facts.instalments),
      'overdue.instalment_amount': money(facts.instalmentAmount),
      'overdue.penal_charge': money(facts.penal),
      'overdue.penal_rate': pct(facts.penalRateBpsPa),
      'overdue.total': money(facts.total),
      'overdue.oldest_due_date': date(facts.oldestDueDate),
      'overdue.ptp_window_days': count(ptp.maxDaysAhead),
      'overdue.product': text(loan.product.replace(/_/g, ' ')),
    };
    if (activePtp) values['overdue.active_ptp_date'] = date(activePtp);
    const sources = dedupeSources([
      recordSource('lms', loan.loanId, `Loan ${loan.loanId} (${loan.product.replace(/_/g, ' ')})`),
      recordSource('payments', loan.loanId, `Overdue instalments of loan ${loan.loanId}`),
      citeClause(ctx, g, facts.penalClause, await penPol),
      citeClause(ctx, g, selectClause('collections_conduct', loan, ctx.today), await colPol),
      citeClause(ctx, g, ptp.clause, await ptpPol),
      calcSource('overdue-total', 'Total due', `Overdue instalments ${formatInr(facts.principalOverdue)} + penal charge ${formatInr(facts.penal)} (${facts.penalRateBpsPa / 100}% p.a. simple, per instalment, to ${ctx.today})`),
    ]);
    return { ok: true, data: { loanId: loan.loanId, hasActivePtp: Boolean(activePtp) }, values, sources, ...g.stale };
  },
};

export const collectionsTools: ToolDef[] = [getOverdueSummary];
