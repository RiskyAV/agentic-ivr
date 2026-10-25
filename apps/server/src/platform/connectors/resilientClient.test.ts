import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIENT_CONFIG, ResilientClient, type CallEvent, type ClientConfig } from './resilientClient.js';
import type { Transport } from './transport.js';

const cfg = (over: Partial<ClientConfig> = {}): ClientConfig => ({
  timeoutMs: 100,
  retries: 2,
  backoffMs: 10,
  breaker: { failures: 5, cooldownMs: 10_000 },
  hedge: { enabled: true, maxRatio: 0.1 },
  staleTtlMs: 600_000,
  ...over,
});
const ok = (body: unknown = { v: 1 }) => ({ status: 200, body });
const mkClient = (t: Transport, c = cfg()) => new ResilientClient('crm', t, c, { random: () => 0 });
const hang = (): Promise<never> => new Promise(() => {});
const events = () => {
  const list: CallEvent[] = [];
  return { list, observer: { onCall: (e: CallEvent) => void list.push(e) } };
};
const ctl = () => new AbortController();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ResilientClient', () => {
  it('(a) times out, retries, succeeds on attempt 2', async () => {
    let n = 0;
    const c = mkClient(async () => (++n === 1 ? hang() : ok()));
    const { list, observer } = events();
    const p = c.get('/x', { signal: ctl().signal, observer });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ ok: true, data: { v: 1 } });
    expect(list.map((e) => [e.attempt, e.outcome])).toEqual([
      [1, 'timeout'],
      [2, 'ok'],
    ]);
  });

  it('returns timeout when the last attempt timed out', async () => {
    const c = mkClient(() => hang(), cfg({ hedge: { enabled: false, maxRatio: 0 } }));
    const p = c.get('/x', { signal: ctl().signal });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ ok: false, error: 'timeout' });
  });

  it('(b) opens the breaker after 5 consecutive 503s and stops calling the transport', async () => {
    const t = vi.fn<Transport>(async () => ({ status: 503, body: { error: 'unavailable' } }));
    const c = mkClient(t, cfg({ retries: 0 }));
    const { list, observer } = events();
    for (let i = 0; i < 5; i++) expect(await c.get(`/x${i}`, { signal: ctl().signal })).toEqual({ ok: false, error: 'unavailable' });
    expect(await c.get('/x', { signal: ctl().signal, observer })).toEqual({ ok: false, error: 'unavailable' });
    expect(t).toHaveBeenCalledTimes(5);
    expect(list[0]?.outcome).toBe('breaker_open');
  });

  it('half-open: one trial after cooldown; success closes, failure re-opens', async () => {
    let fail = true;
    const t = vi.fn<Transport>(async () => (fail ? { status: 503, body: {} } : ok()));
    const c = mkClient(t, cfg({ retries: 0, breaker: { failures: 2, cooldownMs: 1000 } }));
    const s = ctl().signal;
    await c.get('/a', { signal: s });
    await c.get('/a', { signal: s });
    expect(t).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await c.get('/a', { signal: s }); // trial fails -> re-open
    expect(t).toHaveBeenCalledTimes(3);
    await c.get('/a', { signal: s }); // still open
    expect(t).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    fail = false;
    expect((await c.get('/a', { signal: s })).ok).toBe(true); // trial succeeds -> closed
    await c.get('/a', { signal: s });
    expect(t).toHaveBeenCalledTimes(5);
  });

  it('half-open lets only one trial through concurrently', async () => {
    let n = 0;
    const t = vi.fn<Transport>(async () => (++n <= 1 ? { status: 503, body: {} } : new Promise((r) => setTimeout(() => r(ok()), 50))));
    const c = mkClient(t, cfg({ retries: 0, breaker: { failures: 1, cooldownMs: 1000 } }));
    const s = ctl().signal;
    await c.get('/a', { signal: s });
    await vi.advanceTimersByTimeAsync(1000);
    const p1 = c.get('/a', { signal: s });
    const p2 = await c.get('/b', { signal: s });
    expect(p2).toEqual({ ok: false, error: 'unavailable' });
    await vi.advanceTimersByTimeAsync(100);
    expect((await p1).ok).toBe(true);
    expect(t).toHaveBeenCalledTimes(2);
  });

  it('(c) serves stale data with asOf when a later GET fails, also when breaker is open', async () => {
    let up = true;
    const t = vi.fn<Transport>(async () => (up ? ok({ name: 'Priya' }) : { status: 503, body: {} }));
    const c = mkClient(t, cfg({ retries: 0, breaker: { failures: 2, cooldownMs: 10_000 } }));
    const s = ctl().signal;
    const t0 = Date.now();
    await c.get('/cust', { signal: s });
    up = false;
    await vi.advanceTimersByTimeAsync(5000);
    const { list, observer } = events();
    const r = await c.get('/cust', { signal: s, observer });
    expect(r).toEqual({ ok: true, data: { name: 'Priya' }, stale: { asOf: new Date(t0).toISOString() } });
    expect(list.at(-1)?.outcome).toBe('stale');
    await c.get('/cust', { signal: s }); // second failure opens breaker
    const r2 = await c.get('/cust', { signal: s, observer });
    expect(r2.ok && r2.stale).toBeTruthy();
    expect(list.at(-1)?.outcome).toBe('stale');
  });

  it('does not serve stale beyond staleTtlMs, nor for POST, and invalidate drops it', async () => {
    let up = true;
    const t: Transport = async () => (up ? ok() : { status: 503, body: {} });
    const c = mkClient(t, cfg({ retries: 0, staleTtlMs: 1000 }));
    const s = ctl().signal;
    await c.get('/old', { signal: s });
    await c.get('/inv', { signal: s });
    up = false;
    c.invalidate('/inv');
    expect((await c.get('/inv', { signal: s })).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await c.get('/old', { signal: s })).ok).toBe(false);
  });

  it('uses ctx.cacheKey for the cache and observer key', async () => {
    let up = true;
    const c = mkClient(async () => (up ? ok() : { status: 503, body: {} }), cfg({ retries: 0 }));
    const s = ctl().signal;
    const { list, observer } = events();
    await c.get('/a?x=1', { signal: s, cacheKey: 'k' });
    up = false;
    const r = await c.get('/b?y=2', { signal: s, cacheKey: 'k', observer });
    expect(r.ok && r.stale).toBeTruthy();
    expect(list[0]?.key).toBe('k');
  });

  it('(d) hedges a hung GET after p95; hedge wins; loser aborted', async () => {
    const signals: AbortSignal[] = [];
    const c = mkClient(async (r) => {
      signals.push(r.signal);
      return signals.length === 1 ? hang() : new Promise((res) => setTimeout(() => res(ok({ from: 'hedge' })), 50));
    }, cfg({ timeoutMs: 5000 }));
    const { list, observer } = events();
    const start = Date.now();
    const p = c.get('/x', { signal: ctl().signal, observer });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toEqual({ ok: true, data: { from: 'hedge' } });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(list.find((e) => e.hedged)?.outcome).toBe('ok');
    expect(signals[0]!.aborted).toBe(true);
  });

  it('hedge delay follows rolling p95 once 20 samples exist', async () => {
    const c = mkClient(async () => new Promise((r) => setTimeout(() => r(ok()), 30)), cfg({ timeoutMs: 5000 }));
    expect(c.p95()).toBe(400);
    for (let i = 0; i < 20; i++) {
      const p = c.get('/x', { signal: ctl().signal });
      await vi.advanceTimersByTimeAsync(30);
      await p;
    }
    expect(c.p95()).toBe(30);
  });

  it('caps hedges at maxRatio of requests', async () => {
    const t = vi.fn<Transport>(() => new Promise((r) => setTimeout(() => r(ok()), 600)));
    const c = mkClient(t, cfg({ timeoutMs: 5000 }));
    for (let i = 0; i < 10; i++) {
      const p = c.get('/x', { signal: ctl().signal });
      await vi.advanceTimersByTimeAsync(700);
      await p;
    }
    // 10 requests each slower than the 400 ms delay; only the first can hedge (1 <= 0.1*10)
    expect(t).toHaveBeenCalledTimes(11);
  });

  it('(e) POST without idempotency key is never retried or hedged', async () => {
    const t = vi.fn<Transport>(async () => ({ status: 503, body: {} }));
    const c = mkClient(t);
    expect(await c.post('/p', {}, { signal: ctl().signal, idempotencyKey: '' })).toEqual({ ok: false, error: 'unavailable' });
    expect(t).toHaveBeenCalledTimes(1);

    const slow = vi.fn<Transport>(() => hang());
    const c2 = mkClient(slow, cfg({ timeoutMs: 5000 }));
    const p = c2.post('/p', {}, { signal: ctl().signal, idempotencyKey: '' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(slow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toEqual({ ok: false, error: 'timeout' });
  });

  it('POST with idempotency key is retried (never hedged) and sends the header', async () => {
    let n = 0;
    const t = vi.fn<Transport>(async () => (++n === 1 ? { status: 503, body: {} } : { status: 201, body: { id: 'SR-1' } }));
    const c = mkClient(t);
    const r = await (async () => {
      const p = c.post('/p', { a: 1 }, { signal: ctl().signal, idempotencyKey: 'k1' });
      await vi.advanceTimersByTimeAsync(100);
      return p;
    })();
    expect(r).toEqual({ ok: true, data: { id: 'SR-1' } });
    expect(t).toHaveBeenCalledTimes(2);
    expect(t.mock.calls[1]![0].headers).toEqual({ 'Idempotency-Key': 'k1' });
    expect(t.mock.calls[1]![0].body).toEqual({ a: 1 });
  });

  it('(f) 404 is not_found, not retried, not a breaker failure', async () => {
    const t = vi.fn<Transport>(async () => ({ status: 404, body: { error: 'not_found' } }));
    const c = mkClient(t, cfg({ breaker: { failures: 2, cooldownMs: 1000 } }));
    const { list, observer } = events();
    for (let i = 0; i < 4; i++) expect(await c.get('/x', { signal: ctl().signal, observer })).toEqual({ ok: false, error: 'not_found' });
    expect(t).toHaveBeenCalledTimes(4);
    expect(list[0]).toMatchObject({ outcome: 'error', status: 404 });
  });

  it('other 4xx is non-retryable, unavailable, and not a breaker failure', async () => {
    const t = vi.fn<Transport>(async () => ({ status: 400, body: { error: 'bad' } }));
    const c = mkClient(t, cfg({ breaker: { failures: 1, cooldownMs: 1000 } }));
    const { list, observer } = events();
    expect(await c.get('/x', { signal: ctl().signal, observer })).toEqual({ ok: false, error: 'unavailable' });
    expect(await c.get('/x', { signal: ctl().signal })).toEqual({ ok: false, error: 'unavailable' });
    expect(t).toHaveBeenCalledTimes(2);
    expect(list[0]).toMatchObject({ outcome: 'error', status: 400 });
  });

  it('retries 429 and thrown network errors', async () => {
    let n = 0;
    const t = vi.fn<Transport>(async () => {
      n++;
      if (n === 1) return { status: 429, body: {} };
      if (n === 2) throw new Error('ECONNRESET');
      return ok();
    });
    const c = mkClient(t);
    const p = c.get('/x', { signal: ctl().signal });
    await vi.advanceTimersByTimeAsync(500);
    expect((await p).ok).toBe(true);
    expect(t).toHaveBeenCalledTimes(3);
  });

  it('caller abort rejects promptly with AbortError, no retry, no stale, no breaker count', async () => {
    let up = true;
    const t = vi.fn<Transport>(() => (up ? Promise.resolve(ok()) : hang()));
    const c = mkClient(t, cfg({ breaker: { failures: 1, cooldownMs: 1000 }, timeoutMs: 5000 }));
    await c.get('/x', { signal: ctl().signal });
    up = false;
    const ac = ctl();
    const p = c.get('/x', { signal: ac.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await assertion;
    expect(t).toHaveBeenCalledTimes(2);
    // breaker still closed: a following call reaches the transport
    c.get('/y', { signal: ctl().signal }).catch(() => {});
    expect(t).toHaveBeenCalledTimes(3);
    await expect(c.get('/z', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('exposes per-system defaults from the brief', () => {
    expect(Object.fromEntries(Object.entries(DEFAULT_CLIENT_CONFIG).map(([k, v]) => [k, v.timeoutMs]))).toEqual({
      crm: 800, lms: 1200, payments: 1500, policy: 500, ops: 2500,
    });
    expect(DEFAULT_CLIENT_CONFIG.crm).toMatchObject({ retries: 2, backoffMs: 100, breaker: { failures: 5, cooldownMs: 10_000 }, staleTtlMs: 600_000 });
  });
});
