import { afterEach, describe, expect, it } from 'vitest';
import { buildMockServer } from '@app/mock-systems';
import { buildConnectors } from '../connectors/clients.js';
import { injectTransport } from '../connectors/transport.js';
import { loadSnapshot, toSnapshotView } from './snapshot.js';
import { InMemorySessionStore, type Session } from './session.js';

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

function setup(chaos?: Parameters<typeof buildMockServer>[0]['chaos']) {
  const app = buildMockServer({ today: '2026-10-25', seed: 1, chaos: { payments: { failRate: 0 }, ops: { failRate: 0 }, ...chaos } });
  apps.push(app);
  return buildConnectors(injectTransport(app));
}
const ctx = () => ({ signal: new AbortController().signal });

describe('loadSnapshot', () => {
  it('C1004 has 2 loans and a masked PAN', async () => {
    const s = await loadSnapshot(setup(), 'C1004', ctx());
    expect(s.loans).toHaveLength(2);
    expect(s.partial).toEqual([]);
    expect(s.customer?.pan).toBe('XXXXXX618M');
    expect(JSON.stringify(s)).not.toContain('DLFPK5618M');
    for (const l of s.loans) expect(l.lastPayment).toBeDefined();
    expect(toSnapshotView(s).loans).toHaveLength(2);
  });
  it('crm failure is partial, loans remain', async () => {
    const s = await loadSnapshot(setup({ crm: { failRate: 1, minMs: 0, maxMs: 0 } }), 'C1004', ctx());
    expect(s.partial).toEqual(['crm']);
    expect(s.loans).toHaveLength(2);
  }, 10_000);
  it('overdue customer C1003: pending payments summed, days from oldest', async () => {
    const s = await loadSnapshot(setup(), 'C1003', ctx());
    const l = s.loans[0]!;
    expect(l.overdueAmount).toBe(2 * l.emi);
    expect(l.overdueAmount).toBe(2_880_800);
    expect(l.daysPastDue).toBe(40);
  });
  it('C1001 has no overdue', async () => {
    const s = await loadSnapshot(setup(), 'C1001', ctx());
    expect(s.loans[0]!.overdueAmount).toBe(0);
    expect(s.loans[0]!.daysPastDue).toBe(0);
  });
  it('C1002 view has recent payments incl. a failed row; lastPayment is a success', async () => {
    const s = await loadSnapshot(setup(), 'C1002', ctx());
    expect(s.loans[0]!.lastPayment?.status).toBe('success');
    const v = toSnapshotView(s);
    expect(v.recentPayments.length).toBeGreaterThan(0);
    expect(v.recentPayments.length).toBeLessThanOrEqual(5);
    expect(v.recentPayments.some((p) => p.status === 'failed')).toBe(true);
    const dates = v.recentPayments.map((p) => p.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
  it('healthy loan has zero overdue', async () => {
    const s = await loadSnapshot(setup(), 'C1004', ctx());
    expect(s.loans.every((l) => l.overdueAmount === 0 && l.daysPastDue === 0)).toBe(true);
  });
});

describe('InMemorySessionStore', () => {
  it('sweeps idle sessions', () => {
    const st = new InMemorySessionStore(() => 10_000);
    const mk = (id: string, lastSeenAt: number) => ({ id, lastSeenAt }) as Session;
    st.put(mk('a', 1000)); st.put(mk('b', 9500));
    expect(st.sweep(5000)).toBe(1);
    expect(st.get('a')).toBeUndefined();
    expect(st.get('b')).toBeDefined();
  });
});
