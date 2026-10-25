import { describe, expect, it } from 'vitest';
import { Limiter, LimiterTimeout } from './limiter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<void>(() => {});

describe('Limiter', () => {
  it('queues beyond max and rejects queued work after the timeout', async () => {
    const l = new Limiter(2, 100);
    const sig = new AbortController().signal;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = l.run(() => gate, sig);
    const b = l.run(() => gate, sig);
    let thirdStarted = false;
    const c = l.run(async () => { thirdStarted = true; return 'c'; }, sig);
    await sleep(10);
    expect(l.stats()).toEqual({ active: 2, queued: 1 });
    expect(thirdStarted).toBe(false);
    release();
    await Promise.all([a, b]);
    expect(await c).toBe('c');
  });

  it('a queued call times out with LimiterTimeout', async () => {
    const l = new Limiter(2, 100);
    const sig = new AbortController().signal;
    void l.run(never, sig);
    void l.run(never, sig);
    void l.run(never, sig).catch(() => {});
    const fourth = l.run(async () => 'x', sig);
    const t0 = Date.now();
    await expect(fourth).rejects.toBeInstanceOf(LimiterTimeout);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(l.stats().queued).toBe(0);
  });

  it('aborting while queued rejects with AbortError', async () => {
    const l = new Limiter(1, 1000);
    void l.run(never, new AbortController().signal);
    const ac = new AbortController();
    const p = l.run(async () => 1, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(l.stats().queued).toBe(0);
  });

  it('releases the slot when fn throws and serves FIFO', async () => {
    const l = new Limiter(1, 1000);
    const sig = new AbortController().signal;
    const order: number[] = [];
    const p1 = l.run(async () => { order.push(1); throw new Error('boom'); }, sig).catch(() => {});
    const p2 = l.run(async () => order.push(2), sig);
    const p3 = l.run(async () => order.push(3), sig);
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
    expect(l.stats()).toEqual({ active: 0, queued: 0 });
  });
});
