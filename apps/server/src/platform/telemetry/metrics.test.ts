import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.js';
import { TurnTracer } from './tracer.js';

describe('Metrics', () => {
  it('p50/p95 of 1..100', () => {
    const m = new Metrics();
    for (let i = 1; i <= 100; i++) m.record('x', i);
    expect(m.snapshot().x).toEqual({ p50: 50, p95: 95, n: 100 });
  });
  it('keeps a rolling window of 500', () => {
    const m = new Metrics();
    for (let i = 1; i <= 600; i++) m.record('x', i);
    expect(m.snapshot().x!.n).toBe(500);
  });
  it('reports event loop lag', () => {
    expect(new Metrics().eventLoopLagP99()).toBeGreaterThanOrEqual(0);
  });
});

describe('TurnTracer', () => {
  it('records spans relative to start and backend calls', () => {
    let t = 1000;
    const tr = new TurnTracer('t1', 'text', () => t);
    const end = tr.span('llm', { a: 1 });
    t = 1050; end({ b: true });
    tr.observer.onCall({ system: 'crm', key: 'k', attempt: 1, hedged: false, ms: 20, outcome: 'ok' });
    tr.mark('first_token');
    const trace = tr.toTrace();
    expect(trace.turnId).toBe('t1');
    expect(trace.spans[0]).toMatchObject({ name: 'llm', startMs: 0, endMs: 50, attrs: { a: 1, b: true } });
    expect(trace.spans.some((s) => s.name === 'backend:crm')).toBe(true);
    expect(trace.spans.some((s) => s.name === 'first_token')).toBe(true);
  });
  it('redacts PII in span attrs', () => {
    const tr = new TurnTracer('t', 'text');
    const end = tr.span('x', { phone: '9876543210' });
    end({ email: 'a@b.in' });
    expect(tr.toTrace().spans[0]!.attrs).toEqual({ phone: 'XXXXXX3210', email: 'XXXXXXb.in' });
  });
});
