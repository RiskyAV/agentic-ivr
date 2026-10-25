import { afterEach, describe, expect, it } from 'vitest';
import { penalCharge, penalRule, daysBetween } from '@app/domain';
import { ActionService } from '../../platform/actions/actionService.js';
import { AuditLog } from '../../platform/actions/audit.js';
import { snapshotValues } from '../../platform/engine/prompts.js';
import { loadSnapshot } from '../../platform/context/snapshot.js';
import { formatBound } from '../../platform/grounding/values.js';
import { ToolRegistry } from '../../platform/tools/registry.js';
import { makeHarness } from '../../platform/tools/testkit.js';
import { WorkflowRegistry } from '../../platform/workflows/registry.js';
import { loanServicingActions } from '../loan-servicing/actions.js';
import { loanServicingTools } from '../loan-servicing/tools.js';
import { collectionsActions } from './actions.js';
import { collections } from './index.js';
import { collectionsTools } from './tools.js';
import { addDays } from './overdue.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });
function setup() {
  const h = makeHarness();
  closers.push(h.close);
  const reg = new ToolRegistry();
  collectionsTools.forEach((t) => reg.register(t));
  const svc = new ActionService([...loanServicingActions, ...collectionsActions], new AuditLog());
  const snap = (id: string) => loadSnapshot(h.connectors, id, { signal: new AbortController().signal });
  return { ...h, reg, svc, snap };
}
const TODAY = '2026-10-25';
const PTP = (days: number) => ({ date: addDays(TODAY, days) });

describe('get_overdue_summary', () => {
  it('Arjun: 40 DPD, 2 instalments, total = 2 x EMI + per-instalment penal charge, sources PEN-01 and COL-01', async () => {
    const h = setup();
    const r = await h.reg.run('get_overdue_summary', {}, h.ctxFor('C1003'));
    if (!r.ok) throw new Error(r.message);
    const loan = await h.connectors.lms.getLoan('PL-60917', { signal: new AbortController().signal });
    if (!loan.ok) throw new Error('loan');
    const emi = loan.data.emi;
    const rate = penalRule(loan.data, TODAY).penalRateBpsPa;
    const penal = ['2026-09-15', '2026-10-15'].reduce((t, d) => t + penalCharge({ overdueAmount: emi, daysPastDue: daysBetween(d, TODAY), penalRateBpsPa: rate }), 0);
    expect(r.values['overdue.dpd']).toEqual({ kind: 'count', n: 40 });
    expect(r.values['overdue.instalments_count']).toEqual({ kind: 'count', n: 2 });
    expect(r.values['overdue.instalment_amount']).toEqual({ kind: 'money', paise: emi });
    expect(r.values['overdue.penal_charge']).toEqual({ kind: 'money', paise: penal });
    expect(r.values['overdue.total']).toEqual({ kind: 'money', paise: 2 * emi + penal });
    expect(r.values['overdue.oldest_due_date']).toEqual({ kind: 'date', iso: '2026-09-15' });
    expect(r.sources).toContainEqual(expect.objectContaining({ kind: 'clause', ref: 'PEN-01 v1' }));
    expect(r.sources).toContainEqual(expect.objectContaining({ kind: 'clause', ref: 'COL-01 v1' }));
  });
  it('a customer with nothing overdue gets not_found', async () => {
    const h = setup();
    expect(await h.reg.run('get_overdue_summary', {}, h.ctxFor('C1001'))).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('opener', () => {
  it('Arjun: greeting with resolved overdue total and disclosures; Rahul: null', async () => {
    const h = setup();
    const s = await h.snap('C1003');
    const raw = collections.opener!(s)!;
    expect(raw).toBeTruthy();
    const values = snapshotValues(s);
    const text = raw.replace(/\{\{([^}]+)\}\}/g, (_, k: string) => formatBound(values[k]!, 'text'));
    expect(text).not.toContain('{{');
    expect(text).toContain('on behalf of the lender');
    expect(text).toMatch(/good time/i);
    expect(text).toContain(formatBound(values[`snapshot.PL-60917.overdue`]!, 'text'));
    expect(text).toContain('40 days');
    expect(collections.opener!(await h.snap('C1001'))).toBeNull();
  });
});

describe('promise_to_pay', () => {
  it('rejects a date beyond the window', async () => {
    const h = setup();
    const r = await h.svc.propose(h.ctxFor('C1003'), 'promise_to_pay', PTP(10));
    expect(r).toMatchObject({ ok: false });
  });
  it('rejects a past date, an amount below one instalment and an amount above the total', async () => {
    const h = setup();
    const ctx = h.ctxFor('C1003');
    expect(await h.svc.propose(ctx, 'promise_to_pay', PTP(-1))).toMatchObject({ ok: false });
    expect(await h.svc.propose(ctx, 'promise_to_pay', { ...PTP(3), amount: '1000' })).toMatchObject({ ok: false });
    expect(await h.svc.propose(ctx, 'promise_to_pay', { ...PTP(3), amount: '10 lakh' })).toMatchObject({ ok: false });
  });
  it('rejects when the loan is not overdue', async () => {
    const h = setup();
    expect(await h.svc.propose(h.ctxFor('C1001'), 'promise_to_pay', PTP(3))).toMatchObject({ ok: false });
  });
  it('today+5 -> proposal -> confirm -> executed as an open ops request; a second PTP is rejected', async () => {
    const h = setup();
    const ctx = h.ctxFor('C1003');
    const r = await h.svc.propose(ctx, 'promise_to_pay', PTP(5));
    if (!r.ok) throw new Error(r.reason);
    expect(r.proposal.figures['ptp.overdue_total']).toBeDefined();
    expect(r.proposal.figures['ptp.amount']).toEqual(r.proposal.figures['ptp.overdue_total']);
    const out = await h.svc.confirm(ctx.session, r.proposal.id, r.proposal.termsHash, 'ui', ctx);
    expect(out.status).toBe('executed');
    const list = (await h.app.inject({ method: 'GET', url: '/ops/requests?customerId=C1003&type=promise_to_pay' })).json() as { requests: { params: { date: string } }[] };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]!.params.date).toBe(addDays(TODAY, 5));
    expect(await h.svc.propose(ctx, 'promise_to_pay', PTP(6))).toMatchObject({ ok: false, reason: expect.stringContaining('already have an active') });
  });
});

describe('promise_to_pay boundaries', () => {
  it('accepts today+7 and rejects today+8', async () => {
    const h = setup();
    expect(await h.svc.propose(h.ctxFor('C1003'), 'promise_to_pay', PTP(7))).toMatchObject({ ok: true });
    expect(await h.svc.propose(h.ctxFor('C1003'), 'promise_to_pay', PTP(8))).toMatchObject({ ok: false });
  });
  it('accepts an amount exactly equal to one instalment', async () => {
    const h = setup();
    const loan = await h.connectors.lms.getLoan('PL-60917', { signal: new AbortController().signal });
    if (!loan.ok) throw new Error('loan');
    const r = await h.svc.propose(h.ctxFor('C1003'), 'promise_to_pay', { ...PTP(3), amount: String(loan.data.emi / 100) });
    if (!r.ok) throw new Error(r.reason);
    expect(r.proposal.figures['ptp.amount']).toEqual({ kind: 'money', paise: loan.data.emi });
  });
});

describe('payment_link', () => {
  it('defaults to the overdue total; execution returns the customer-facing URL', async () => {
    const h = setup();
    const ctx = h.ctxFor('C1003');
    const r = await h.svc.propose(ctx, 'payment_link', {});
    if (!r.ok) throw new Error(r.reason);
    expect(r.proposal.figures['link.amount']).toEqual(r.proposal.figures['link.overdue_total']);
    const out = await h.svc.confirm(ctx.session, r.proposal.id, r.proposal.termsHash, 'ui', ctx);
    expect(out.status).toBe('executed');
    expect(out.message).toContain('https://pay.northstar.example/l/');
  });
  it('part payment amount is honoured; no overdue is rejected', async () => {
    const h = setup();
    const r = await h.svc.propose(h.ctxFor('C1003'), 'payment_link', { amount: '10k' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.proposal.figures['link.amount']).toEqual({ kind: 'money', paise: 1_000_000 });
    expect(await h.svc.propose(h.ctxFor('C1001'), 'payment_link', {})).toMatchObject({ ok: false });
  });
});

describe('workflow definition', () => {
  it('registers and every referenced tool exists', () => {
    const tools = new ToolRegistry();
    loanServicingTools.forEach((t) => tools.register(t));
    collectionsTools.forEach((t) => tools.register(t));
    const svc = new ActionService([...loanServicingActions, ...collectionsActions], new AuditLog());
    for (const a of [...loanServicingActions, ...collectionsActions]) tools.register(svc.proposeTool(a.type));
    new WorkflowRegistry().register(collections);
    expect(tools.declarations(collections.tools).map((d) => d.name).sort()).toEqual([...collections.tools].sort());
  });
});
