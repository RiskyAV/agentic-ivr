import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildMockServer } from '@app/mock-systems';
import type { ClientMsg, ServerMsg } from '@app/shared';
import { buildApp, type AppHandle } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { ZERO_CHAOS } from '../platform/tools/testkit.js';
import { signToken, verifyToken } from './auth.js';

type Msg = ServerMsg;

let mock: ReturnType<typeof buildMockServer>;
let mockUrl: string;
let gw: AppHandle;
let base: string;
let wsBase: string;
const extra: AppHandle[] = [];

function testConfig(overrides: Partial<Config> = {}, env: Record<string, string> = {}): Config {
  return {
    ...loadConfig({ LLM_PROVIDER: 'stub', MOCK_BASE_URL: mockUrl, PORT: '0', SESSION_SECRET: 'test-secret', EVENT_LOG_DIR: mkdtempSync(join(tmpdir(), 'gw-')), LOGIN_RATE_PER_MIN: '1000', ...env }).config,
    ...overrides,
  };
}

async function startApp(config: Config, opts?: Parameters<typeof buildApp>[1]) {
  const h = await buildApp(config, opts);
  const port = await h.listen(0);
  extra.push(h);
  return { h, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

beforeAll(async () => {
  mock = buildMockServer({ today: '2026-10-25', seed: 1, chaos: ZERO_CHAOS });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address() as { port: number };
  mockUrl = `http://127.0.0.1:${addr.port}`;
  const s = await startApp(testConfig());
  gw = s.h;
  base = s.base;
  wsBase = s.wsBase;
});

afterAll(async () => {
  await Promise.all(extra.map((h) => h.close()));
  await mock.close();
});

async function login(customerId: string, extraBody: Record<string, unknown> = {}, url = base) {
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId, otp: '123456', ...extraBody }),
  });
  return { res, body: (await res.json()) as { token: string; sessionId: string } };
}

class Client {
  readonly msgs: Msg[] = [];
  closeCode?: number;
  private readonly waiters: Array<() => void> = [];
  readonly ws: WebSocket;
  constructor(token: string, url = wsBase) {
    this.ws = new WebSocket(`${url}/ws?token=${encodeURIComponent(token)}`);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.msgs.push(JSON.parse(data.toString()) as Msg);
      this.waiters.splice(0).forEach((w) => w());
    });
    this.ws.on('close', (code) => { this.closeCode = code; this.waiters.splice(0).forEach((w) => w()); });
  }
  async waitFor<T extends Msg['type']>(type: T, from = 0, ms = 5000): Promise<Extract<Msg, { type: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.msgs.slice(from).find((m) => m.type === type);
      if (found) return found as Extract<Msg, { type: T }>;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}; got ${this.msgs.map((m) => m.type).join(',')}`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }
  async closed(ms = 3000) {
    const deadline = Date.now() + ms;
    while (this.closeCode === undefined) {
      if (Date.now() > deadline) throw new Error('socket did not close');
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
    return this.closeCode;
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  close() { this.ws.close(); return this.closed(); }
  async ready() {
    await this.waitFor('session_ready');
    await this.waitFor('snapshot');
    return this;
  }
}

describe('auth tokens', () => {
  it('round-trips and rejects tampering and expiry', () => {
    const t = signToken({ customerId: 'C1001', sessionId: 's1', exp: Date.now() + 1000 }, 'k');
    expect(verifyToken(t, 'k')).toMatchObject({ customerId: 'C1001', sessionId: 's1' });
    expect(verifyToken(t, 'other')).toBeNull();
    expect(verifyToken(t.slice(0, -2) + 'xx', 'k')).toBeNull();
    expect(verifyToken(signToken({ customerId: 'C1001', sessionId: 's1', exp: Date.now() - 1 }, 'k'), 'k')).toBeNull();
    expect(verifyToken('garbage', 'k')).toBeNull();
  });
});

describe('HTTP', () => {
  it('(a) wrong OTP and missing access code give 401', async () => {
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customerId: 'C1001', otp: '000000' }) });
    expect(bad.status).toBe(401);
    const unknown = await login('C9999');
    expect(unknown.res.status).toBe(401);
    const gated = await startApp(testConfig({ demoAccessCode: 'letmein' }));
    expect((await login('C1001', {}, gated.base)).res.status).toBe(401);
    expect((await login('C1001', { accessCode: 'nope' }, gated.base)).res.status).toBe(401);
    expect((await login('C1001', { accessCode: 'letmein' }, gated.base)).res.status).toBe(200);
    const list = (await (await fetch(`${gated.base}/api/demo-customers`)).json()) as { customers: { id: string }[]; requiresAccessCode: boolean };
    expect(list.requiresAccessCode).toBe(true);
    expect(list.customers.map((c) => c.id)).toContain('C1001');
  });

  it('demo customers, workflows, health, snapshot, audit', async () => {
    const dc = (await (await fetch(`${base}/api/demo-customers`)).json()) as { customers: unknown[]; requiresAccessCode: boolean };
    expect(dc.customers).toHaveLength(4);
    expect(dc.requiresAccessCode).toBe(false);
    const wf = (await (await fetch(`${base}/api/workflows`)).json()) as { workflows: { id: string; suggestions: string[] }[] };
    expect(wf.workflows[0]!.id).toBe('loan-servicing');
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/me/snapshot`)).status).toBe(401);
    expect((await fetch(`${base}/api/audit`)).status).toBe(401);
    const { body } = await login('C1001');
    const snap = (await (await fetch(`${base}/api/me/snapshot`, { headers: { authorization: `Bearer ${body.token}` } })).json()) as { customer: { id: string }; loans: unknown[] };
    expect(snap.customer.id).toBe('C1001');
    expect(snap.loans).toHaveLength(1);
    const audit = await fetch(`${base}/api/audit?limit=5`, { headers: { authorization: `Bearer ${body.token}` } });
    expect(audit.status).toBe(200);
  });

  it('metrics exposes runtime numbers', async () => {
    const m = (await (await fetch(`${base}/api/metrics`)).json()) as Record<string, any>;
    expect(m).toHaveProperty('eventLoopLagP99');
    expect(m.rssMb).toBeGreaterThan(0);
    expect(m.voiceSessions).toBe(0);
    expect(m.limiter).toHaveProperty('active');
    expect(typeof m.sessions).toBe('number');
    expect(m).toHaveProperty('metrics');
  });

  it('chaos proxies the mock admin, validates PUT bodies, and reset clears overrides', async () => {
    const put = (body: unknown) => fetch(`${base}/api/chaos`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ payments: { extraLatencyMs: -1 } })).status).toBe(400);
    expect((await put({ payments: { extraLatencyMs: 20000 } })).status).toBe(400);
    expect((await put({ payments: { failRate: 2 } })).status).toBe(400);
    expect((await put({ payments: { hang: 'yes' } })).status).toBe(400);
    expect((await put({ nope: { hang: true } })).status).toBe(400);
    expect((await put({ payments: { extraLatencyMs: 'x' } })).status).toBe(400);
    const ok = await put({ payments: { extraLatencyMs: 5, failRate: 0.1 } });
    expect(ok.status).toBe(200);
    const all = (await (await fetch(`${base}/api/chaos`)).json()) as Record<string, any>;
    expect(all.payments.extraLatencyMs).toBe(5);
    const reset = await fetch(`${base}/api/chaos/reset`, { method: 'POST' });
    expect(reset.status).toBe(200);
    const after = (await (await fetch(`${base}/api/chaos`)).json()) as Record<string, any>;
    expect(after.payments.extraLatencyMs).toBe(0);
  });

  it('CORS allows the web dev origin and WEB_ORIGIN, not others', async () => {
    const s = await startApp(testConfig({}, { WEB_ORIGIN: 'https://demo.example.com' }));
    const h = async (o: string) => (await fetch(`${s.base}/api/health`, { headers: { origin: o } })).headers.get('access-control-allow-origin');
    expect(await h('http://localhost:5173')).toBe('http://localhost:5173');
    expect(await h('https://demo.example.com')).toBe('https://demo.example.com');
    expect(await h('https://evil.example.com')).toBeNull();
    const pre = await fetch(`${s.base}/api/login`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
  });

  it('login is limited to N per minute per IP', async () => {
    const s = await startApp(testConfig({ loginsPerMin: 3 }));
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await login('C1001', {}, s.base)).res.status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe('WebSocket', () => {
  it('rejects a bad token at upgrade', async () => {
    const c = new Client('bogus');
    const code = await new Promise<number>((resolve) => { c.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)); c.ws.on('error', () => {}); });
    expect(code).toBe(401);
  });

  it('(b) connect yields session_ready and a snapshot with 1 loan', async () => {
    const { body } = await login('C1001');
    const c = new Client(body.token);
    const ready = await c.waitFor('session_ready');
    expect(ready).toMatchObject({ sessionId: body.sessionId, resumed: false, workflowId: 'loan-servicing', customer: { id: 'C1001', name: 'Rahul Mehta' }, history: [] });
    const snap = await c.waitFor('snapshot');
    expect(snap.snapshot.loans).toHaveLength(1);
    await c.close();
  });

  it('(c) user_text streams turn_start, deltas, done with sources, trace', async () => {
    const { body } = await login('C1001');
    const c = await new Client(body.token).ready();
    c.send({ type: 'user_text', turnId: 't1', text: 'why did my EMI go up' });
    const done = await c.waitFor('assistant_done');
    await c.waitFor('trace');
    const types = c.msgs.map((m) => m.type);
    expect(types.indexOf('turn_start')).toBeLessThan(types.indexOf('assistant_delta'));
    expect(types.indexOf('assistant_delta')).toBeLessThan(types.indexOf('assistant_done'));
    expect(c.msgs.find((m) => m.type === 'turn_start')).toMatchObject({ turnId: 't1', channel: 'text', userText: 'why did my EMI go up' });
    expect(done.turnId).toBe('t1');
    expect(done.sources.length).toBeGreaterThan(0);
    expect(done.text).toContain('₹26,035');
    expect(done.text).toContain('₹27,045');
    await c.close();
  });

  it('(d) reconnect within the window resumes with history', async () => {
    const { body } = await login('C1001');
    const c1 = await new Client(body.token).ready();
    c1.send({ type: 'user_text', turnId: 'r1', text: 'why did my EMI go up' });
    await c1.waitFor('assistant_done');
    await c1.close();
    const c2 = new Client(body.token);
    const ready = await c2.waitFor('session_ready');
    expect(ready.resumed).toBe(true);
    expect(ready.history.filter((h) => h.kind === 'user' || h.kind === 'assistant')).toHaveLength(2);
    expect(ready.history[0]).toMatchObject({ kind: 'user', text: 'why did my EMI go up' });
    await c2.close();
  });

  it('a second connection replaces the first with code 4001', async () => {
    const { body } = await login('C1001');
    const c1 = await new Client(body.token).ready();
    const c2 = await new Client(body.token).ready();
    expect(await c1.closed()).toBe(4001);
    await c2.close();
  });

  it('a session idle past the resume window starts fresh', async () => {
    let t = Date.now();
    const s = await startApp(testConfig(), { now: () => t });
    const { body } = await login('C1001', {}, s.base);
    const c1 = await new Client(body.token, s.wsBase).ready();
    c1.send({ type: 'user_text', turnId: 'x', text: 'why did my EMI go up' });
    await c1.waitFor('assistant_done');
    await c1.close();
    await new Promise((r) => setTimeout(r, 50)); // let the server register the disconnect before the clock moves
    t += 6 * 60_000;
    const c2 = new Client(body.token, s.wsBase);
    const ready = await c2.waitFor('session_ready');
    expect(ready.resumed).toBe(false);
    expect(ready.history).toEqual([]);
    await c2.close();
  });

  it('(e) another customer cannot confirm a proposal; the owner can, once', async () => {
    const rahul = await login('C1001');
    const priya = await login('C1002');
    const r = await new Client(rahul.body.token).ready();
    const p = await new Client(priya.body.token).ready();
    r.send({ type: 'user_text', turnId: 'p1', text: 'please prepay 50k' });
    const prop = await r.waitFor('action_proposal');
    await r.waitFor('assistant_done');
    p.send({ type: 'confirm_action', proposalId: prop.proposal.id, termsHash: prop.proposal.termsHash });
    const denied = await p.waitFor('action_result');
    expect(denied.status).toBe('rejected');

    r.send({ type: 'confirm_action', proposalId: prop.proposal.id, termsHash: prop.proposal.termsHash });
    const ok = await r.waitFor('action_result');
    expect(ok.status).toBe('executed');
    expect(ok.reference).toBeTruthy();
    const refreshed = await r.waitFor('snapshot', r.msgs.indexOf(ok) + 1); // pushed after execution
    expect(refreshed.snapshot.loans).toHaveLength(1);
    // double confirm returns the same reference
    const from = r.msgs.length;
    r.send({ type: 'confirm_action', proposalId: prop.proposal.id, termsHash: prop.proposal.termsHash });
    const again = await r.waitFor('action_result', from);
    expect(again.reference).toBe(ok.reference);
    // audit holds this customer's entries only
    const audit = (await (await fetch(`${base}/api/audit`, { headers: { authorization: `Bearer ${priya.body.token}` } })).json()) as { entries: { customerId: string }[] };
    expect(audit.entries.every((e) => e.customerId === 'C1002')).toBe(true);
    const auditR = (await (await fetch(`${base}/api/audit`, { headers: { authorization: `Bearer ${rahul.body.token}` } })).json()) as { entries: { customerId: string; event: string }[] };
    expect(auditR.entries.some((e) => e.event === 'executed')).toBe(true);
    expect(auditR.entries.every((e) => e.customerId === 'C1001')).toBe(true);
    await Promise.all([r.close(), p.close()]);
  });

  it('cancel_action reports a result', async () => {
    const { body } = await login('C1001');
    const c = await new Client(body.token).ready();
    c.send({ type: 'user_text', turnId: 'c1', text: 'prepay 50k' });
    const prop = await c.waitFor('action_proposal');
    await c.waitFor('assistant_done');
    c.send({ type: 'cancel_action', proposalId: prop.proposal.id });
    const res = await c.waitFor('action_result');
    expect(res.proposalId).toBe(prop.proposal.id);
    expect(res.status).not.toBe('executed');
    await c.close();
  });

  it('set_workflow validates, and voice/binary frames answer voice_unavailable', async () => {
    const { body } = await login('C1001');
    const c = await new Client(body.token).ready();
    c.send({ type: 'set_workflow', workflowId: 'nope' });
    const err = await c.waitFor('error');
    expect(err.code).toBe('unknown_workflow');
    const from = c.msgs.length;
    c.send({ type: 'voice_start' });
    expect((await c.waitFor('error', from)).code).toBe('voice_unavailable');
    const from2 = c.msgs.length;
    c.ws.send(Buffer.from([0, 0, 0, 0, 1, 2]));
    expect((await c.waitFor('error', from2)).code).toBe('voice_unavailable');
    const from3 = c.msgs.length;
    c.ws.send('not json');
    expect((await c.waitFor('error', from3)).code).toBe('bad_request');
    c.send({ type: 'set_workflow', workflowId: 'loan-servicing' });
    await c.close();
  });

  it('(f) the 31st turn in a minute is rate limited and not run', async () => {
    const { body } = await login('C1002');
    const c = await new Client(body.token).ready();
    for (let i = 0; i < 31; i++) c.send({ type: 'user_text', turnId: `n${i}`, text: 'hello there' });
    const err = await c.waitFor('error');
    expect(err.code).toBe('rate_limited');
    await new Promise((r) => setTimeout(r, 300));
    expect(c.msgs.filter((m) => m.type === 'turn_start')).toHaveLength(30);
    await c.close();
  });

  it('a message over 64 KB closes the socket', async () => {
    const { body } = await login('C1001');
    const c = await new Client(body.token).ready();
    c.ws.send(JSON.stringify({ type: 'user_text', turnId: 'big', text: 'x'.repeat(70_000) }));
    expect(await c.closed()).toBe(1009);
  });
});

describe('main wiring', () => {
  it('exposes session counts', async () => {
    const m = (await (await fetch(`${base}/api/metrics`)).json()) as { sessions: number };
    expect(m.sessions).toBeGreaterThan(0);
    expect(gw.sessions.size()).toBe(m.sessions);
  });
});
