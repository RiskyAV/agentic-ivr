import { afterEach, describe, expect, it } from 'vitest';
import { rupees } from '@app/domain';
import { buildConnectors } from '../connectors/clients.js';
import { injectTransport, type Transport } from '../connectors/transport.js';
import { makeHarness, makeSession } from '../tools/testkit.js';
import type { ToolContext } from '../tools/types.js';
import { loanServicingActions } from '../../workflows/loan-servicing/actions.js';
import { ActionService } from './actionService.js';
import { AuditLog } from './audit.js';
import type { Proposal } from './types.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

function setup() {
  const h = makeHarness();
  closers.push(h.close);
  const clock = { t: 1_000_000 };
  const audit = new AuditLog();
  const svc = new ActionService(loanServicingActions, audit, () => clock.t);
  const opsCount = async (customerId: string) =>
    ((await h.app.inject({ method: 'GET', url: `/ops/requests?customerId=${customerId}` })).json() as { requests: unknown[] }).requests.length;
  return { ...h, clock, audit, svc, opsCount };
}
const okP = async (p: ReturnType<ActionService['propose']>): Promise<Proposal> => {
  const r = await p;
  if (!r.ok) throw new Error(`propose failed: ${r.reason}`);
  return r.proposal;
};
const prepay = { loanId: 'HL-88231', amount: '50k', mode: 'reduce_tenure' };

describe('ActionService', () => {
  it('(a) propose -> confirm -> executed with SR reference and audit trail', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    expect(p.status).toBe('pending');
    expect(p.expiresAt).toBe(s.clock.t + 5 * 60_000);
    expect(p.termsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(p.figures['prepay.amount']).toEqual({ kind: 'money', paise: rupees(50000) });
    expect(ctx.session.pendingProposalIds).toContain(p.id);
    expect(s.svc.pending(ctx.session.id)).toHaveLength(1);
    const out = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(out.status).toBe('executed');
    expect(out.reference).toMatch(/^SR-/);
    expect(p.status).toBe('executed');
    expect(s.svc.pending(ctx.session.id)).toHaveLength(0);
    expect(ctx.session.pendingProposalIds).not.toContain(p.id);
    expect(s.audit.list(10).map((e) => e.event).reverse()).toEqual(['proposed', 'confirmed', 'executed']);
  });

  it('(b) wrong hash -> rejected and the proposal stays pending', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const out = await s.svc.confirm(ctx.session, p.id, 'deadbeefdeadbeef', 'voice', ctx);
    expect(out).toMatchObject({ status: 'rejected', reason: 'hash_mismatch' });
    expect(p.status).toBe('pending');
    expect(await s.opsCount('C1001')).toBe(0);
    const again = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(again.status).toBe('executed');
  });

  it('(c) confirming twice returns the same reference and executes once', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const a = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    const b = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'voice', ctx);
    expect(b.status).toBe('executed');
    expect(b.reference).toBe(a.reference);
    expect(await s.opsCount('C1001')).toBe(1);
  });

  it('concurrent double-confirm awaits the in-flight execution and executes once', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const [a, b] = await Promise.all([
      s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx),
      s.svc.confirm(ctx.session, p.id, p.termsHash, 'voice', ctx),
    ]);
    expect(a.status).toBe('executed');
    expect(b).toEqual(a);
    expect(await s.opsCount('C1001')).toBe(1);
    expect(s.audit.list(20).filter((e) => e.event === 'executed')).toHaveLength(1);
  });

  it('(d) another session or customer cannot confirm, and learns nothing', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const otherSession = { ...makeSession('C1001'), id: 'other' };
    const o1 = await s.svc.confirm(otherSession, p.id, p.termsHash, 'ui', s.ctxFor('C1001', 'text', otherSession));
    const ctx2 = s.ctxFor('C1002');
    const o2 = await s.svc.confirm(ctx2.session, p.id, p.termsHash, 'ui', ctx2);
    const missing = await s.svc.confirm(ctx.session, 'nope', p.termsHash, 'ui', ctx);
    const mismatchedCtx = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', s.ctxFor('C1002'));
    expect(mismatchedCtx.reason).toBe('not_found');
    for (const o of [o1, o2, missing]) expect(o).toMatchObject({ status: 'rejected', reason: 'not_found' });
    expect(o1.message).toBe(missing.message);
    expect(p.status).toBe('pending');
    expect(await s.opsCount('C1001')).toBe(0);
  });

  it('(e) after expiry -> expired, audited, no execution', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    s.clock.t += 5 * 60_000 + 1;
    const out = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(out.status).toBe('expired');
    expect(p.status).toBe('expired');
    expect(s.audit.list(5).map((e) => e.event)).toContain('expired');
    expect(await s.opsCount('C1001')).toBe(0);
  });

  it('pending() lazily expires', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    s.clock.t += 6 * 60_000;
    expect(s.svc.pending(ctx.session.id)).toHaveLength(0);
    expect(p.status).toBe('expired');
    expect(ctx.session.pendingProposalIds).not.toContain(p.id);
  });

  it('(f) prepayment above outstanding or below the minimum is not proposed', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const big = await s.svc.propose(ctx, 'prepayment', { ...prepay, amount: '1 crore' });
    expect(big.ok).toBe(false);
    const small = await s.svc.propose(s.ctxFor('C1002'), 'prepayment', { loanId: 'PL-55102', amount: '5000', mode: 'reduce_tenure' });
    expect(small.ok).toBe(false);
    const junk = await s.svc.propose(ctx, 'prepayment', { ...prepay, amount: 'plenty' });
    expect(junk.ok).toBe(false);
    const foreign = await s.svc.propose(ctx, 'prepayment', { ...prepay, loanId: 'PL-55102' });
    expect(foreign.ok).toBe(false);
    expect(s.svc.pending(ctx.session.id)).toHaveLength(0);
  });

  it('(g) dispute on another customer\'s payment is not proposed; own bounced payment is', async () => {
    const s = setup();
    const priya = s.ctxFor('C1002');
    const pays = await s.connectors.payments.list('PL-55102', { status: 'failed' }, { signal: priya.signal });
    if (!pays.ok) throw new Error('no payments');
    const charged = pays.data.find((p) => p.bounceCharge);
    expect(charged).toBeDefined();
    const rahul = s.ctxFor('C1001');
    const bad = await s.svc.propose(rahul, 'dispute', { paymentId: charged!.paymentId, reason: 'not mine' });
    expect(bad.ok).toBe(false);
    const good = await okP(s.svc.propose(priya, 'dispute', { paymentId: charged!.paymentId, reason: 'Bank failure' }));
    expect(good.figures['dispute.disputed_amount']).toEqual({ kind: 'money', paise: charged!.bounceCharge });
    expect(good.summary).not.toContain(charged!.paymentId);
  });

  it('(h) response lost after the backend committed: retries are absorbed by the idempotency key, executed once', async () => {
    const s = setup();
    const inner = injectTransport(s.app);
    let posts = 0;
    const flaky: Transport = async (req) => {
      if (req.method === 'POST' && req.url.startsWith('/ops/requests') && posts++ === 0) {
        await inner(req); // committed ...
        return { status: 503, body: {} }; // ... but the client never sees it
      }
      return inner(req);
    };
    const ctx: ToolContext = { ...s.ctxFor('C1001'), connectors: buildConnectors(flaky) };
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const out = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(out.status).toBe('executed');
    expect(posts).toBeGreaterThanOrEqual(2);
    expect(await s.opsCount('C1001')).toBe(1);
  });

  it('uncertain execution: failed/execution_uncertain, stays pending, re-confirm returns same reference, one request', async () => {
    const s = setup();
    const inner = injectTransport(s.app);
    let lose = false;
    let first = true;
    const t: Transport = async (req) => {
      if (lose && req.method === 'POST' && req.url.startsWith('/ops/requests')) {
        if (first) { first = false; await inner(req); } // backend commits once; every response is lost
        return { status: 503, body: {} };
      }
      return inner(req);
    };
    const ctx: ToolContext = { ...s.ctxFor('C1001'), connectors: buildConnectors(t) };
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const expiry = p.expiresAt;
    lose = true;
    const out1 = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(out1).toMatchObject({ status: 'failed', reason: 'execution_uncertain' });
    expect(out1.message).toMatch(/safely retry/);
    expect(p.status).toBe('pending');
    expect(p.expiresAt).toBe(expiry);
    expect(s.audit.list(3).map((e) => e.event)).toContain('failed');
    expect(await s.opsCount('C1001')).toBe(1);
    lose = false;
    const out2 = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(out2.status).toBe('executed');
    expect(await s.opsCount('C1001')).toBe(1);
    const reqs = ((await s.app.inject({ method: 'GET', url: '/ops/requests?customerId=C1001' })).json() as { requests: { id: string }[] }).requests;
    expect(reqs[0]!.id).toBe(out2.reference);
  });

  it('validation outage at confirm keeps the proposal pending; a later confirm succeeds', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const real = s.connectors.lms.getLoan;
    s.connectors.lms.getLoan = async () => { throw new Error('boom'); };
    const down = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(down).toMatchObject({ status: 'failed', reason: 'validation_unavailable' });
    expect(down.message).toMatch(/try again/i);
    expect(p.status).toBe('pending');
    expect(await s.opsCount('C1001')).toBe(0);
    s.connectors.lms.getLoan = real;
    expect((await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx)).status).toBe('executed');
  });

  it('ticket free text with a phone number never reaches the audit log', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    await okP(s.svc.propose(ctx, 'ticket', { category: 'other', description: 'call me on 9820145567 re PAN ABCDE1234F' }));
    const dump = JSON.stringify(s.audit.list(10));
    expect(dump).not.toContain('9820145567');
    expect(dump).not.toContain('ABCDE1234F');
    expect(dump).not.toContain('call me');
  });

  it('terms_changed: figures that differ at execute time reject without executing', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const real = s.connectors.lms.getLoan;
    const orig = s.connectors.lms.getSchedule;
    s.connectors.lms.getLoan = async (id, c) => {
      const r = await real(id, c);
      return r.ok ? { ...r, data: { ...r.data, outstanding: r.data.outstanding - rupees(100000) } } : r;
    };
    s.connectors.lms.getSchedule = orig;
    const out = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(out).toMatchObject({ status: 'rejected', reason: 'terms_changed' });
    expect(p.status).toBe('rejected');
    expect(await s.opsCount('C1001')).toBe(0);
  });

  it('cancel moves a pending proposal to cancelled and blocks confirmation', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    expect((await s.svc.cancel(ctx.session, p.id)).status).toBe('cancelled');
    const out = await s.svc.confirm(ctx.session, p.id, p.termsHash, 'ui', ctx);
    expect(out.status).toBe('cancelled');
    expect(await s.opsCount('C1001')).toBe(0);
  });

  it('propose tool: kind propose, schema = handler schema, prefixed values, no execution', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const tool = s.svc.proposeTool('prepayment');
    expect(tool.name).toBe('propose_prepayment');
    expect(tool.kind).toBe('propose');
    const r = await tool.run(ctx, tool.schema.parse(prepay));
    if (!r.ok) throw new Error(r.message);
    const data = r.data as { proposalId: string; status: string; summary: string; instruction: string };
    expect(data.status).toBe('pending_confirmation');
    expect(data.instruction).toMatch(/confirm/i);
    expect(r.values['proposal.prepay.amount']).toEqual({ kind: 'money', paise: rupees(50000) });
    expect(r.sources.length).toBeGreaterThan(0);
    expect(await s.opsCount('C1001')).toBe(0);
    const bad = await tool.run(ctx, tool.schema.parse({ ...prepay, amount: '1 crore' }));
    expect(bad.ok).toBe(false);
  });

  it('statement, ticket handlers and validation bounds', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const st = { loanId: 'HL-88231', fromDate: '2026-01-01', toDate: '2026-06-30' };
    const sp = await okP(s.svc.propose(ctx, 'statement', st));
    expect((await s.svc.confirm(ctx.session, sp.id, sp.termsHash, 'ui', ctx)).status).toBe('executed');
    expect((await s.svc.propose(ctx, 'statement', { ...st, fromDate: '2022-01-01' })).ok).toBe(false);
    expect((await s.svc.propose(ctx, 'statement', { ...st, fromDate: '2026-07-01' })).ok).toBe(false);
    const tp = await okP(s.svc.propose(ctx, 'ticket', { category: 'documents', description: 'Need NOC copy' }));
    expect((await s.svc.confirm(ctx.session, tp.id, tp.termsHash, 'ui', ctx)).status).toBe('executed');
    expect((await s.svc.propose(ctx, 'ticket', { category: 'x', description: 'a' })).ok).toBe(false);
    expect((await s.svc.propose(ctx, 'ticket', { category: 'other', description: 'a'.repeat(501) })).ok).toBe(false);
  });

  it('toView gives labelled, formatted figures; audit redacts PII and is a ring buffer', async () => {
    const s = setup();
    const ctx = s.ctxFor('C1001');
    const p = await okP(s.svc.propose(ctx, 'prepayment', prepay));
    const v = s.svc.toView(p);
    expect(v).toMatchObject({ id: p.id, type: 'prepayment', termsHash: p.termsHash, expiresAt: p.expiresAt });
    expect(v.figures.some((f) => f.value.includes('50,000'))).toBe(true);
    const a = new AuditLog(3);
    for (let i = 0; i < 5; i++) a.append({ at: i, sessionId: 's', customerId: 'c', event: 'proposed', proposalId: `p${i}`, detail: { phone: '9820145567' } });
    expect(a.list(10).map((e) => e.proposalId)).toEqual(['p4', 'p3', 'p2']);
    expect(a.list(1)[0]!.detail).toEqual({ phone: 'XXXXXX5567' });
  });
});
