import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { addMonths, getClause, CLAUSES, type PolicyTopic } from '@app/domain';
import { buildDataset } from './data/build.js';
import type { Dataset, LoanRecord } from './data/types.js';
import { Chaos, SYSTEMS, type ChaosOptions, type ChaosOverride, type SystemName } from './chaos.js';

export type OpsRequestType = 'prepayment' | 'dispute' | 'statement' | 'ticket' | 'promise_to_pay' | 'callback';
const OPS_TYPES: OpsRequestType[] = ['prepayment', 'dispute', 'statement', 'ticket', 'promise_to_pay', 'callback'];

export interface OpsRequest {
  id: string;
  customerId: string;
  type: OpsRequestType;
  params: Record<string, unknown>;
  status: 'open';
  createdAt: string;
}

export interface MockServerOptions { today: string; seed?: number; chaos?: ChaosOptions }

declare module 'fastify' {
  interface FastifyContextConfig { system?: SystemName }
}

const NOT_FOUND = { error: 'not_found' };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function summary(l: LoanRecord) {
  const { schedule: _schedule, ...rest } = l;
  return rest;
}

export function buildMockServer(opts: MockServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const chaos = new Chaos(opts.chaos, opts.seed);
  let data: Dataset = buildDataset(opts.today);
  let requests = new Map<string, OpsRequest>();
  let idem = new Map<string, { fingerprint: string; status: number; body: unknown; customerId: string }>();
  let srCounter = 482100;
  let linkCounter = 70100;
  const hung = new Set<FastifyReply['raw']>();

  const reset = () => {
    data = buildDataset(opts.today);
    requests = new Map();
    idem = new Map();
    srCounter = 482100;
    linkCounter = 70100;
    chaos.reset();
  };

  // One shared chaos hook: latency, failure, hang, per the system the route is tagged with.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const system = req.routeOptions.config.system;
    if (!system) { reply.header('x-mock-latency-ms', '0'); return; }
    const d = chaos.decide(system);
    reply.header('x-mock-latency-ms', String(d.latencyMs));
    if (d.hang) {
      // Never respond; the raw response is tracked so close() can drop it.
      reply.hijack();
      hung.add(reply.raw);
      return;
    }
    if (d.latencyMs > 0) await new Promise((r) => setTimeout(r, d.latencyMs));
    if (d.fail) return reply.code(503).send({ error: 'unavailable' });
  });

  app.addHook('onClose', async () => {
    for (const raw of hung) raw.destroy();
    hung.clear();
  });

  /** Runs `create` once per key; replays the original response (200) for the same body. `customerId` owns the entry (reset-customer). */
  function idempotent(req: FastifyRequest, reply: FastifyReply, scope: string, customerId: string, create: () => { status: number; body: unknown }) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) return reply.code(400).send({ error: 'idempotency_key_required' });
    const id = `${scope}:${key}`;
    const fingerprint = JSON.stringify(req.body ?? null);
    const prior = idem.get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return reply.code(409).send({ error: 'idempotency_key_reuse' });
      return reply.code(200).header('x-idempotent-replay', 'true').send(prior.body);
    }
    const out = create();
    idem.set(id, { fingerprint, ...out, customerId });
    return reply.code(out.status).send(out.body);
  }

  const crm = { config: { system: 'crm' as const } };
  const lms = { config: { system: 'lms' as const } };
  const payments = { config: { system: 'payments' as const } };
  const policy = { config: { system: 'policy' as const } };
  const ops = { config: { system: 'ops' as const } };

  // CRM
  app.get<{ Params: { id: string } }>('/crm/customers/:id', crm, async (req, reply) => {
    const c = data.customers.get(req.params.id);
    return c ?? reply.code(404).send(NOT_FOUND);
  });
  app.get<{ Params: { id: string } }>('/crm/customers/:id/interactions', crm, async (req, reply) => {
    if (!data.customers.has(req.params.id)) return reply.code(404).send(NOT_FOUND);
    return { customerId: req.params.id, interactions: data.interactions.get(req.params.id) ?? [] };
  });

  // LMS
  app.get<{ Params: { id: string } }>('/lms/customers/:id/loans', lms, async (req, reply) => {
    const c = data.customers.get(req.params.id);
    if (!c) return reply.code(404).send(NOT_FOUND);
    return { customerId: c.customerId, loans: c.loanIds.map((id) => summary(data.loans.get(id)!)) };
  });
  app.get<{ Params: { loanId: string } }>('/lms/loans/:loanId', lms, async (req, reply) => {
    const l = data.loans.get(req.params.loanId);
    return l ? summary(l) : reply.code(404).send(NOT_FOUND);
  });
  app.get<{ Params: { loanId: string }; Querystring: { from?: string; months?: string } }>(
    '/lms/loans/:loanId/schedule', lms, async (req, reply) => {
      const l = data.loans.get(req.params.loanId);
      if (!l) return reply.code(404).send(NOT_FOUND);
      const from = req.query.from ?? opts.today;
      const months = req.query.months === undefined ? 12 : Number(req.query.months);
      if (!Number.isInteger(months) || months < 1) return reply.code(400).send({ error: 'bad_request' });
      return { loanId: l.loanId, from, schedule: l.schedule.filter((r) => r.dueDate >= from).slice(0, months) };
    });

  // Payments
  app.get<{ Params: { loanId: string }; Querystring: { months?: string; status?: string } }>(
    '/payments/loans/:loanId', payments, async (req, reply) => {
      const list = data.payments.get(req.params.loanId);
      if (!list) return reply.code(404).send(NOT_FOUND);
      const { months, status = 'all' } = req.query;
      if (!['all', 'failed', 'success', 'pending'].includes(status)) return reply.code(400).send({ error: 'bad_request' });
      let out = list;
      if (months !== undefined) {
        const m = Number(months);
        if (!Number.isInteger(m) || m < 1) return reply.code(400).send({ error: 'bad_request' });
        const since = addMonths(opts.today, -m);
        out = out.filter((p) => p.date >= since);
      }
      if (status !== 'all') out = out.filter((p) => p.status === status);
      return { loanId: req.params.loanId, payments: [...out].sort((a, b) => b.date.localeCompare(a.date)) };
    });
  app.post<{ Body: { loanId?: string; amountPaise?: number } }>('/payments/links', payments, async (req, reply) => {
    const { loanId, amountPaise } = req.body ?? {};
    if (typeof loanId !== 'string' || !Number.isInteger(amountPaise) || (amountPaise as number) <= 0) return reply.code(400).send({ error: 'bad_request' });
    if (!data.loans.has(loanId)) return reply.code(404).send(NOT_FOUND);
    const owner = [...data.customers.values()].find((c) => c.loanIds.includes(loanId))?.customerId ?? '';
    return idempotent(req, reply, 'link', owner, () => {
      const linkId = `PLK-${linkCounter++}`;
      return { status: 201, body: { linkId, url: `https://pay.northstar.example/l/${linkId}`, amountPaise, loanId, expiresAt: `${addDays(opts.today, 2)}T23:59:59.000Z` } };
    });
  });

  // Policy
  app.get<{ Querystring: { topic?: string } }>('/policy/clauses', policy, async (req) => {
    const { topic } = req.query;
    return { clauses: CLAUSES.filter((c) => !topic || c.topic === (topic as PolicyTopic)) };
  });
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>('/policy/clauses/:id', policy, async (req, reply) => {
    const v = req.query.version === undefined ? undefined : Number(req.query.version);
    const c = getClause(req.params.id, v);
    return c ?? reply.code(404).send(NOT_FOUND);
  });

  // Ops
  app.post<{ Body: { customerId?: string; type?: string; params?: Record<string, unknown> } }>('/ops/requests', ops, async (req, reply) => {
    const { customerId, type, params } = req.body ?? {};
    if (typeof customerId !== 'string' || !OPS_TYPES.includes(type as OpsRequestType)) return reply.code(400).send({ error: 'bad_request' });
    if (!data.customers.has(customerId)) return reply.code(404).send(NOT_FOUND);
    return idempotent(req, reply, 'ops', customerId, () => {
      const r: OpsRequest = {
        id: `SR-${srCounter++}`, customerId, type: type as OpsRequestType, params: params ?? {}, status: 'open',
        createdAt: `${opts.today}T00:00:00.000Z`,
      };
      requests.set(r.id, r);
      return { status: 201, body: r };
    });
  });
  app.get<{ Querystring: { customerId?: string; type?: string } }>('/ops/requests', ops, async (req) => {
    const { customerId, type } = req.query;
    return { requests: [...requests.values()].filter((r) => (!customerId || r.customerId === customerId) && (!type || r.type === type)) };
  });
  app.get<{ Params: { id: string } }>('/ops/requests/:id', ops, async (req, reply) => {
    return requests.get(req.params.id) ?? reply.code(404).send(NOT_FOUND);
  });

  // Admin (no chaos)
  app.get('/admin/chaos', async () => chaos.all());
  app.put<{ Body: Record<string, ChaosOverride> }>('/admin/chaos', async (req, reply) => {
    const body = req.body ?? {};
    for (const [k, o] of Object.entries(body)) {
      if (!(SYSTEMS as readonly string[]).includes(k) || typeof o !== 'object' || o === null) return reply.code(400).send({ error: 'bad_request' });
    }
    for (const [k, o] of Object.entries(body)) {
      const { extraLatencyMs, failRate, hang } = o;
      chaos.set(k as SystemName, {
        ...(extraLatencyMs !== undefined && { extraLatencyMs }), ...(failRate !== undefined && { failRate }), ...(hang !== undefined && { hang }),
      });
    }
    return chaos.all();
  });
  app.post('/admin/reset', async () => { reset(); return { ok: true }; });
  // Per-login demo reset: drops one customer's mutable state (ops requests incl. promises to pay, payment links,
  // idempotency entries) so each login starts that customer's journeys fresh. Chaos and other customers are untouched.
  app.post<{ Body: { customerId?: unknown } }>('/admin/reset-customer', async (req, reply) => {
    const customerId = req.body?.customerId;
    if (typeof customerId !== 'string' || !customerId) return reply.code(400).send({ error: 'bad_request' });
    const customer = data.customers.get(customerId);
    if (!customer) return reply.code(404).send(NOT_FOUND);
    let removedRequests = 0;
    let removedIdem = 0;
    for (const [id, r] of requests) if (r.customerId === customerId) { requests.delete(id); removedRequests++; }
    for (const [k, e] of idem) if (e.customerId === customerId) { idem.delete(k); removedIdem++; }
    // loanIds lets the caller drop its per-loan caches too.
    return { ok: true, customerId, loanIds: customer.loanIds, requests: removedRequests, idempotency: removedIdem };
  });

  return app;
}
