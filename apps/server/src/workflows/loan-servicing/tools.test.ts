import { afterEach, describe, expect, it } from 'vitest';
import { rupees, simulatePrepayment } from '@app/domain';
import { formatBound } from '../../platform/grounding/values.js';
import { ToolRegistry } from '../../platform/tools/registry.js';
import { makeHarness } from '../../platform/tools/testkit.js';
import { ToolFailure } from '../../platform/tools/types.js';
import { loanServicingTools } from './tools.js';
import { z } from 'zod';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });
function harness(chaos?: Parameters<typeof makeHarness>[0]) {
  const h = makeHarness(chaos);
  closers.push(h.close);
  const reg = new ToolRegistry();
  loanServicingTools.forEach((t) => reg.register(t));
  return { ...h, reg };
}
const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok).toBe(true); return r as Extract<T, { ok: true }>; };

describe('explain_emi_change', () => {
  it('Rahul: old EMI, cause and sources', async () => {
    const h = harness();
    const r = ok(await h.reg.run('explain_emi_change', {}, h.ctxFor('C1001')));
    expect(r.values['emi_change.old_emi']).toEqual({ kind: 'money', paise: rupees(26035) });
    expect(r.values['emi_change.new_emi']).toEqual({ kind: 'money', paise: rupees(27045) });
    expect(r.values['emi_change.cause']).toEqual({ kind: 'text', s: 'a change in your floating interest rate (repo-linked reset)' });
    expect(r.values['emi_change.difference']).toEqual({ kind: 'money', paise: rupees(1010) });
    expect(r.values['emi_change.old_rate']).toEqual({ kind: 'pct', bps: 850 });
    expect(r.values['emi_change.new_rate']).toEqual({ kind: 'pct', bps: 910 });
    expect(r.values['emi_change.effective_date']).toEqual({ kind: 'date', iso: '2026-10-05' });
    expect(r.values['emi_change.alt_extra_months']).toBeDefined();
    expect(r.values['emi_change.alt_tenure_months_if_old_emi']).toBeDefined();
    expect(r.sources).toContainEqual(expect.objectContaining({ kind: 'clause', ref: 'RR-01 v1' }));
    expect(r.sources).toContainEqual(expect.objectContaining({ kind: 'record', system: 'lms', ref: 'HL-88231' }));
    expect(r.sources.some((s) => s.kind === 'calc')).toBe(true);
  });
  it('a loan with no EMI change is not_found', async () => {
    const h = harness();
    const r = await h.reg.run('explain_emi_change', {}, h.ctxFor('C1003'));
    expect(r).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('fix round 1', () => {
  it('Rahul EMI change: direction and the rate entry matched to the EMI change', async () => {
    const h = harness();
    const r = ok(await h.reg.run('explain_emi_change', {}, h.ctxFor('C1001')));
    expect(r.values['emi_change.direction']).toEqual({ kind: 'text', s: 'increase' });
    expect(r.values['emi_change.old_rate']).toEqual({ kind: 'pct', bps: 850 });
    expect(r.values['emi_change.new_rate']).toEqual({ kind: 'pct', bps: 910 });
  });
  it('rate keys are omitted when no rate entry precedes the EMI change; cause comes from the EMI record', async () => {
    const h = harness();
    const ctx = h.ctxFor('C1001');
    const real = h.connectors.lms.getLoan;
    h.connectors.lms.getLoan = async (id, c) => {
      const r = await real(id, c);
      if (!r.ok) return r;
      return { ...r, data: { ...r.data, rateHistory: [{ effectiveDate: '2026-12-01', oldRateBps: 910, newRateBps: 950 }], emiHistory: [{ effectiveDate: '2026-10-05', oldEmi: 100, newEmi: 90, reason: 'prepayment' }] } };
    };
    const r = ok(await h.reg.run('explain_emi_change', {}, ctx));
    expect(r.values['emi_change.old_rate']).toBeUndefined();
    expect(r.values['emi_change.new_rate']).toBeUndefined();
    expect(r.values['emi_change.cause']).toEqual({ kind: 'text', s: 'a part-prepayment on your loan' });
    expect(r.values['emi_change.direction']).toEqual({ kind: 'text', s: 'decrease' });
  });
  it('get_service_requests exposes only whitelisted fields', async () => {
    const h = harness();
    const ctx = h.ctxFor('C1002');
    await h.connectors.ops.create('C1002', 'dispute', { secret: 'free text' }, 'k1', { signal: ctx.signal });
    const r = ok(await h.reg.run('get_service_requests', {}, ctx));
    const rows = (r.data as { requests: Array<Record<string, unknown>> }).requests;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'id', 'status', 'type']);
    expect(JSON.stringify(r.data)).not.toMatch(/customerId|params|secret/);
  });
  it('clause citation comes from the Policy service', async () => {
    const h = harness();
    const r = ok(await h.reg.run('simulate_prepayment', { amount: '50k' }, h.ctxFor('C1001')));
    const svc = await h.connectors.policy.byTopic('prepayment', { signal: new AbortController().signal });
    if (!svc.ok) throw new Error('x');
    const src = r.sources.find((s) => s.kind === 'clause')!;
    expect(src.detail).toBe(svc.data.find((c) => c.id === 'PRE-01')!.text);
    expect(src.detail).not.toContain('local policy copy');
  });
  it('Policy service down falls back to the local copy, flagged, still ok', async () => {
    const h = harness({ policy: { minMs: 0, maxMs: 0, failRate: 1 } });
    const ctx = h.ctxFor('C1001');
    const r = ok(await h.reg.run('simulate_prepayment', { amount: '50k' }, ctx));
    const src = r.sources.find((s) => s.kind === 'clause')!;
    expect(src.ref).toBe('PRE-01 v1');
    expect(src.detail!.endsWith('(local policy copy)')).toBe(true);
    expect(ctx.tracer.toTrace().spans.some((sp) => sp.name === 'policy_fallback')).toBe(true);
  }, 15_000);
  it('a service/domain disagreement cites the service text and records policy_mismatch', async () => {
    const h = harness();
    const ctx = h.ctxFor('C1001');
    const real = h.connectors.policy.byTopic;
    h.connectors.policy.byTopic = async (t, c) => {
      const r = await real(t, c);
      return r.ok ? { ...r, data: r.data.map((x) => ({ ...x, text: `${x.text} [revised]` })) } : r;
    };
    const r = ok(await h.reg.run('get_policy', { topic: 'prepayment' }, ctx));
    expect(r.sources.find((s) => s.kind === 'clause')!.detail).toMatch(/\[revised\]$/);
    expect(ctx.tracer.toTrace().spans.some((sp) => sp.name === 'policy_mismatch')).toBe(true);
  });
});

describe('simulate_prepayment', () => {
  it('Rahul 50k both modes matches the domain simulation', async () => {
    const h = harness();
    const ctx = h.ctxFor('C1001');
    const r = ok(await h.reg.run('simulate_prepayment', { amount: '50k', mode: 'both' }, ctx));
    const loan = (await h.connectors.lms.getLoan('HL-88231', { signal: ctx.signal }));
    if (!loan.ok) throw new Error('x');
    const sched = await h.connectors.lms.getSchedule('HL-88231', { from: loan.data.nextDueDate, months: 600 }, { signal: ctx.signal });
    if (!sched.ok) throw new Error('x');
    const sim = simulatePrepayment({
      outstanding: loan.data.outstanding, annualRateBps: loan.data.annualRateBps, emi: loan.data.emi,
      remainingMonths: sched.data.length, amount: rupees(50_000), chargePct: 0, firstDueDate: sched.data[0]!.dueDate,
    });
    expect(r.values['prepay.amount']).toEqual({ kind: 'money', paise: rupees(50_000) });
    expect(r.values['prepay.charge']).toEqual({ kind: 'money', paise: 0 });
    expect(r.values['prepay.charge_gst']).toEqual({ kind: 'money', paise: 0 });
    expect(r.values['prepay.interest_saved_tenure']).toEqual({ kind: 'money', paise: sim.reduceTenure.interestSaved });
    expect(r.values['prepay.months_saved']).toEqual({ kind: 'months', n: sim.reduceTenure.monthsSaved });
    expect(r.values['prepay.new_emi']).toEqual({ kind: 'money', paise: sim.reduceEmi.newEmi });
    expect(r.values['prepay.net_saving_emi']).toEqual({ kind: 'money', paise: sim.reduceEmi.interestSaved });
    expect(r.sources).toContainEqual(expect.objectContaining({ kind: 'clause', ref: 'PRE-01 v1' }));
    expect(ctx.session.entities.lastAmount).toBe(rupees(50_000));
  });
  it('charge and GST are subtracted for a fixed loan', async () => {
    const h = harness();
    const r = ok(await h.reg.run('simulate_prepayment', { amount: 100_000 }, h.ctxFor('C1002')));
    const charge = (r.values['prepay.charge'] as { paise: number }).paise;
    const gst = (r.values['prepay.charge_gst'] as { paise: number }).paise;
    expect(charge).toBeGreaterThan(0);
    expect(gst).toBe(Math.round((charge * 18) / 100));
    const saved = (r.values['prepay.interest_saved_tenure'] as { paise: number }).paise;
    expect(r.values['prepay.net_saving_tenure']).toEqual({ kind: 'money', paise: saved - charge - gst });
  });
  it('unparseable amount is invalid', async () => {
    const h = harness();
    const r = await h.reg.run('simulate_prepayment', { amount: 'some' }, h.ctxFor('C1001'));
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
  });
  it('below the policy minimum is invalid and states the minimum', async () => {
    const h = harness();
    const r = await h.reg.run('simulate_prepayment', { amount: '5000' }, h.ctxFor('C1002'));
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
    expect((r as { message: string }).message).toContain('₹10,000');
  });
  it('amount at or above outstanding is flagged as full closure', async () => {
    const h = harness();
    const r = ok(await h.reg.run('simulate_prepayment', { amount: '1 crore' }, h.ctxFor('C1001')));
    expect(r.values['prepay.note']).toEqual({ kind: 'text', s: 'covers_full_outstanding' });
  });
});

describe('get_payment_history', () => {
  it('Priya failed payments: levied/due/refundable/disputable per ordinal alias', async () => {
    const h = harness();
    const r = ok(await h.reg.run('get_payment_history', { months: 6, status: 'failed' }, h.ctxFor('C1002')));
    const rows = (r.data as { payments: Array<Record<string, unknown>> }).payments;
    expect(rows).toHaveLength(2);
    expect(r.values['payments.failed_count']).toEqual({ kind: 'count', n: 2 });
    const v = r.values;
    expect(v['payments.failed_1.date']).toEqual({ kind: 'date', iso: '2026-08-05' });
    expect(v['payments.failed_1.bounce_charge_levied']).toEqual({ kind: 'money', paise: rupees(590) });
    expect(v['payments.failed_1.bounce_charge_due']).toEqual({ kind: 'money', paise: 0 });
    expect(v['payments.failed_1.refundable']).toEqual({ kind: 'money', paise: rupees(590) });
    expect(v['payments.failed_1.disputable']).toEqual({ kind: 'text', s: 'yes' });
    expect(v['payments.failed_1.failure_reason']?.kind).toBe('text');
    expect(v['payments.failed_2.date']).toEqual({ kind: 'date', iso: '2026-06-05' });
    expect(v['payments.failed_2.bounce_charge_levied']).toEqual({ kind: 'money', paise: rupees(590) });
    expect(v['payments.failed_2.bounce_charge_due']).toEqual({ kind: 'money', paise: rupees(590) });
    expect(v['payments.failed_2.refundable']).toEqual({ kind: 'money', paise: 0 });
    expect(v['payments.failed_2.disputable']).toEqual({ kind: 'text', s: 'no' });
    expect(v['payments.total_refundable']).toEqual({ kind: 'money', paise: rupees(590) });
    // Id-keyed values exist too, and the old ambiguous pair is gone.
    const id = (rows[0] as { ref: string }).ref;
    expect(v[`payments.${id}.refundable`]).toEqual(v['payments.failed_1.refundable']);
    expect(Object.keys(v).some((k) => k.endsWith('.bounce_charge') || k.endsWith('.bounce_charge_valid'))).toBe(false);
    // The model-facing data carries the id only inside `ref`.
    expect(rows.every((x) => !('paymentId' in x))).toBe(true);
    expect(JSON.stringify(rows).match(/PAY-/g)?.length).toBe(rows.length);
    expect(r.tables?.[0]?.rows).toHaveLength(2);
    expect(r.sources).toContainEqual(expect.objectContaining({ kind: 'clause', ref: 'BC-01 v1' }));
  });
});

describe('check_foreclosure', () => {
  it('Priya: 4% charge, eligible', async () => {
    const h = harness();
    const r = ok(await h.reg.run('check_foreclosure', {}, h.ctxFor('C1002')));
    expect(r.values['foreclosure.charge_pct']).toEqual({ kind: 'pct', bps: 400 });
    expect(r.values['foreclosure.eligible']).toEqual({ kind: 'text', s: 'yes' });
    expect(r.values['foreclosure.penalty_free']).toEqual({ kind: 'text', s: 'no' });
    const pa = (r.values['foreclosure.charge'] as { paise: number }).paise + (r.values['foreclosure.gst'] as { paise: number }).paise;
    expect(r.values['foreclosure.penalty_amount']).toEqual({ kind: 'money', paise: pa });
    const v = r.values;
    const sum = ['principal', 'accrued_interest', 'charge', 'gst'].reduce((s, k) => s + (v[`foreclosure.${k}`] as { paise: number }).paise, 0);
    expect(v['foreclosure.total']).toEqual({ kind: 'money', paise: sum });
    expect(r.sources).toContainEqual(expect.objectContaining({ kind: 'clause', ref: 'FC-01 v1' }));
  });
});

describe('loan resolution', () => {
  it('Neha without a loan id is ambiguous with 2 options', async () => {
    const h = harness();
    const r = await h.reg.run('get_loan_details', {}, h.ctxFor('C1004'));
    expect(r).toMatchObject({ ok: false, error: 'ambiguous' });
    expect((r as { options: unknown[] }).options).toHaveLength(2);
  });
  it('Neha picks a loan, which becomes the active loan', async () => {
    const h = harness();
    const ctx = h.ctxFor('C1004');
    ok(await h.reg.run('get_loan_details', { loanId: 'TW-11804' }, ctx));
    expect(ctx.session.entities.activeLoanId).toBe('TW-11804');
    const r = ok(await h.reg.run('get_loan_details', {}, ctx));
    expect(r.sources).toContainEqual(expect.objectContaining({ ref: 'TW-11804' }));
  });
  it("Priya cannot read Rahul's loan", async () => {
    const h = harness();
    const r = await h.reg.run('get_loan_details', { loanId: 'HL-88231' }, h.ctxFor('C1002'));
    expect(r).toMatchObject({ ok: false, error: 'forbidden' });
  });
  it('loan details expose the minimum value keys', async () => {
    const h = harness();
    const r = ok(await h.reg.run('get_loan_details', {}, h.ctxFor('C1001')));
    for (const k of ['outstanding', 'emi', 'rate', 'next_due_date', 'remaining_months', 'tenure_months', 'rate_type']) {
      expect(r.values[`loan.${k}`], k).toBeDefined();
    }
  });
});

describe('other tools', () => {
  it('schedule, policy, service requests, options', async () => {
    const h = harness();
    const ctx = h.ctxFor('C1002');
    const s = ok(await h.reg.run('get_repayment_schedule', { months: 3 }, ctx));
    expect(s.tables?.[0]?.rows).toHaveLength(3);
    const p = ok(await h.reg.run('get_policy', { topic: 'prepayment' }, ctx));
    expect(p.sources).toContainEqual(expect.objectContaining({ kind: 'clause', ref: 'PRE-02 v1', detail: expect.any(String) }));
    ok(await h.reg.run('get_service_requests', {}, ctx));
    const o = ok(await h.reg.run('list_options', {}, ctx));
    expect(o.values['options.foreclosure_eligible']).toBeDefined();
    expect(o.values['options.prepay_charge_pct']).toBeDefined();
  });
  it('rejects months over 24', async () => {
    const h = harness();
    expect(await h.reg.run('get_repayment_schedule', { months: 99 }, h.ctxFor('C1001'))).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('backend failure', () => {
  it('lms down with no warm cache is unavailable and names the system', async () => {
    const h = harness({ lms: { minMs: 0, maxMs: 0, failRate: 1 } });
    const r = await h.reg.run('explain_emi_change', {}, h.ctxFor('C1001'));
    expect(r).toMatchObject({ ok: false, error: 'unavailable' });
    expect((r as { message: string }).message).toContain('loan management system');
  }, 15_000);
  it('warm cache then lms down returns stale data', async () => {
    const h = harness();
    ok(await h.reg.run('explain_emi_change', {}, h.ctxFor('C1001')));
    await h.app.inject({ method: 'PUT', url: '/admin/chaos', payload: { lms: { failRate: 1 } } });
    const r = ok(await h.reg.run('explain_emi_change', {}, h.ctxFor('C1001')));
    expect(r.stale?.asOf).toBeTruthy();
  }, 15_000);
});

describe('registry', () => {
  it('declarations are Gemini-friendly JSON schema', () => {
    const reg = new ToolRegistry();
    loanServicingTools.forEach((t) => reg.register(t));
    const [d] = reg.declarations(['simulate_prepayment']);
    expect(d!.name).toBe('simulate_prepayment');
    expect(d!.parameters.type).toBe('object');
    expect(Object.keys(d!.parameters.properties)).toEqual(expect.arrayContaining(['amount', 'mode']));
    expect(d!.parameters.required).toEqual(['amount']);
    const s = JSON.stringify(reg.declarations(loanServicingTools.map((t) => t.name)));
    expect(s).not.toMatch(/\$schema|additionalProperties|\$ref|definitions/);
    expect(s).not.toContain('customerId');
  });
  it('exceptions become unavailable/internal error', async () => {
    const h = harness();
    h.reg.register({ name: 'boom', description: 'x', kind: 'read', schema: z.object({}), run: async () => { throw new Error('kaboom'); } });
    const ctx = h.ctxFor('C1001');
    expect(await h.reg.run('boom', {}, ctx)).toEqual({ ok: false, error: 'unavailable', message: 'internal error' });
    expect(JSON.stringify(ctx.tracer.toTrace())).toContain('kaboom');
  });
  it('ToolFailure passes through', async () => {
    const h = harness();
    h.reg.register({ name: 'f', description: 'x', kind: 'read', schema: z.object({}), run: async () => { throw new ToolFailure({ ok: false, error: 'not_found', message: 'm' }); } });
    expect(await h.reg.run('f', {}, h.ctxFor('C1001'))).toMatchObject({ error: 'not_found' });
  });
});

describe('formatBound', () => {
  it('formats per channel', () => {
    expect(formatBound({ kind: 'money', paise: rupees(26035) }, 'text')).toBe('₹26,035');
    expect(formatBound({ kind: 'money', paise: rupees(26035) }, 'voice')).toContain('twenty-six thousand');
    expect(formatBound({ kind: 'pct', bps: 910 }, 'text')).toBe('9.10%');
    expect(formatBound({ kind: 'pct', bps: 910 }, 'voice')).toBe('9.1 percent');
    expect(formatBound({ kind: 'date', iso: '2026-10-05' }, 'text')).toBe('5 Oct 2026');
    expect(formatBound({ kind: 'months', n: 10 }, 'text')).toBe('10 months');
    expect(formatBound({ kind: 'count', n: 2 }, 'voice')).toBe('2');
    expect(formatBound({ kind: 'text', s: 'yes' }, 'text')).toBe('yes');
  });
});
