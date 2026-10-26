import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMockServer } from './server.js';
import type { ChaosOptions } from './chaos.js';

const ZERO: ChaosOptions = Object.fromEntries(
  ['crm', 'lms', 'payments', 'policy', 'ops'].map((s) => [s, { minMs: 0, maxMs: 0, failRate: 0 }]),
) as ChaosOptions;

let app: FastifyInstance;
const make = (chaos: ChaosOptions = ZERO, seed = 1) => (app = buildMockServer({ today: '2026-10-25', seed, chaos }));
afterEach(async () => { await app?.close(); });

const json = (r: { body: string }) => JSON.parse(r.body);

describe('mock systems', () => {
  it('LMS lists two loans for C1004 and sets the latency header', async () => {
    make();
    const r = await app.inject('/lms/customers/C1004/loans');
    expect(r.statusCode).toBe(200);
    expect(json(r).loans).toHaveLength(2);
    expect(r.headers['x-mock-latency-ms']).toBeDefined();
  });

  it('CRM returns the profile and 404s unknown customers', async () => {
    make();
    expect(json(await app.inject('/crm/customers/C1001')).name).toBe('Rahul Mehta');
    const r = await app.inject('/crm/customers/NOPE');
    expect(r.statusCode).toBe(404);
    expect(json(r)).toEqual({ error: 'not_found' });
    expect(json(await app.inject('/crm/customers/C1003/interactions')).interactions.length).toBeGreaterThan(0);
  });

  it('LMS loan detail has histories; schedule honours from/months', async () => {
    make();
    const d = json(await app.inject('/lms/loans/HL-88231'));
    expect(d.rateHistory).toHaveLength(1);
    expect(d.emiHistory).toHaveLength(1);
    const s = json(await app.inject('/lms/loans/HL-88231/schedule?from=2026-10-01&months=3'));
    expect(s.schedule).toHaveLength(3);
    expect(s.schedule[0].dueDate >= '2026-10-01').toBe(true);
    expect((await app.inject('/lms/loans/XX')).statusCode).toBe(404);
  });

  it('payments filter by status and months back from today', async () => {
    make();
    const failed = json(await app.inject('/payments/loans/PL-55102?status=failed')).payments;
    expect(failed.length).toBe(2);
    expect(failed.every((p: { status: string }) => p.status === 'failed')).toBe(true);
    const recent = json(await app.inject('/payments/loans/PL-55102?months=2')).payments;
    expect(recent.every((p: { date: string }) => p.date >= '2026-08-25')).toBe(true);
    expect(recent.length).toBeGreaterThan(0);
  });

  it('policy returns all versions per topic, and a clause by id/version', async () => {
    make();
    const c = json(await app.inject('/policy/clauses?topic=prepayment')).clauses;
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c.every((x: { version: number; effectiveFrom: string }) => x.version && x.effectiveFrom)).toBe(true);
    const one = json(await app.inject('/policy/clauses/PRE-02?version=2'));
    expect(one.version).toBe(2);
    expect((await app.inject('/policy/clauses/ZZZ')).statusCode).toBe(404);
  });

  it('ops requests are idempotent and require a key', async () => {
    make();
    const body = { customerId: 'C1001', type: 'statement', params: { months: 6 } };
    expect((await app.inject({ method: 'POST', url: '/ops/requests', payload: body })).statusCode).toBe(400);
    const h = { 'idempotency-key': 'k1' };
    const a = await app.inject({ method: 'POST', url: '/ops/requests', payload: body, headers: h });
    const b = await app.inject({ method: 'POST', url: '/ops/requests', payload: body, headers: h });
    expect(json(a).id).toMatch(/^SR-\d{6}$/);
    expect(json(b).id).toBe(json(a).id);
    expect(json(a).status).toBe('open');
    expect(b.headers['x-idempotent-replay']).toBe('true');
    const c = await app.inject({ method: 'POST', url: '/ops/requests', payload: { ...body, type: 'dispute' }, headers: h });
    expect(c.statusCode).toBe(409);
    expect(json(await app.inject('/ops/requests?customerId=C1001')).requests).toHaveLength(1);
    expect(json(await app.inject('/ops/requests?customerId=C1001&type=dispute')).requests).toHaveLength(0);
    expect(json(await app.inject(`/ops/requests/${json(a).id}`)).customerId).toBe('C1001');
  });

  it('payment links are idempotent', async () => {
    make();
    const req = { method: 'POST' as const, url: '/payments/links', payload: { loanId: 'PL-55102', amountPaise: 500000 }, headers: { 'idempotency-key': 'p1' } };
    const a = json(await app.inject(req));
    const b = await app.inject(req);
    expect(a.url).toBe(`https://pay.northstar.example/l/${a.linkId}`);
    expect(json(b).linkId).toBe(a.linkId);
    expect(b.headers['x-idempotent-replay']).toBe('true');
    expect((await app.inject({ ...req, headers: {} })).statusCode).toBe(400);
  });

  it('admin reset-customer clears only that customer\'s requests, payment links and idempotency entries', async () => {
    make();
    const post = (customerId: string, key: string, type = 'promise_to_pay') =>
      app.inject({ method: 'POST', url: '/ops/requests', payload: { customerId, type, params: {} }, headers: { 'idempotency-key': key } });
    const link = (loanId: string, key: string) =>
      app.inject({ method: 'POST', url: '/payments/links', payload: { loanId, amountPaise: 500000 }, headers: { 'idempotency-key': key } });
    const mine = json(await post('C1003', 'k1'));
    await post('C1001', 'k2', 'statement');
    const myLink = json(await link('PL-60917', 'l1'));
    const otherLink = json(await link('PL-55102', 'l2'));
    expect((await app.inject({ method: 'POST', url: '/admin/reset-customer', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/reset-customer', payload: { customerId: 'NOPE' } })).statusCode).toBe(404);
    const r = await app.inject({ method: 'POST', url: '/admin/reset-customer', payload: { customerId: 'C1003' } });
    expect(json(r)).toEqual({ ok: true, customerId: 'C1003', loanIds: ['PL-60917'], requests: 1, idempotency: 2 });
    expect(json(await app.inject('/ops/requests?customerId=C1003')).requests).toEqual([]);
    expect(json(await app.inject('/ops/requests?customerId=C1001')).requests).toHaveLength(1);
    // The same key now creates a fresh request/link instead of replaying the old one; the other customer's still replays.
    expect(json(await post('C1003', 'k1')).id).not.toBe(mine.id);
    expect(json(await link('PL-60917', 'l1')).linkId).not.toBe(myLink.linkId);
    const replay = await link('PL-55102', 'l2');
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(json(replay).linkId).toBe(otherLink.linkId);
  });

  it('admin chaos: failRate 1 gives 503, reset restores; admin routes are exempt', async () => {
    make();
    const put = await app.inject({ method: 'PUT', url: '/admin/chaos', payload: { payments: { failRate: 1 } } });
    expect(put.statusCode).toBe(200);
    const r = await app.inject('/payments/loans/PL-55102');
    expect(r.statusCode).toBe(503);
    expect(json(r)).toEqual({ error: 'unavailable' });
    expect(json(await app.inject('/admin/chaos')).payments.failRate).toBe(1);
    await app.inject({ method: 'POST', url: '/admin/reset' });
    expect((await app.inject('/payments/loans/PL-55102')).statusCode).toBe(200);
  });

  it('extraLatencyMs delays responses and is reported', async () => {
    make();
    await app.inject({ method: 'PUT', url: '/admin/chaos', payload: { policy: { extraLatencyMs: 60 } } });
    const t = Date.now();
    const r = await app.inject('/policy/clauses?topic=statement');
    expect(Date.now() - t).toBeGreaterThanOrEqual(55);
    expect(Number(r.headers['x-mock-latency-ms'])).toBeGreaterThanOrEqual(60);
  });

  it('same seed gives the same failure sequence', async () => {
    const run = async () => {
      const a = make({ ...ZERO, ops: { minMs: 0, maxMs: 0, failRate: 0.5 } }, 7);
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await a.inject('/ops/requests?customerId=C1001')).statusCode);
      await a.close();
      return codes;
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(new Set(first).size).toBe(2);
  });

  it('hang never responds and close() still completes', async () => {
    make();
    await app.inject({ method: 'PUT', url: '/admin/chaos', payload: { crm: { hang: true } } });
    const p = app.inject('/crm/customers/C1001').then(() => 'responded', () => 'aborted');
    const first = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 150))]);
    expect(first).toBe('pending');
    await app.close();
  });
});
