import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEMO_CUSTOMERS } from '@app/mock-systems';
import { loadSnapshot, toSnapshotView } from '../platform/context/snapshot.js';
import { bearer, signToken, TOKEN_TTL_MS, verifyToken, type TokenPayload } from './auth.js';
import type { GatewayCtx } from './context.js';

export const DEMO_OTP = '123456';
const SYSTEMS = ['crm', 'lms', 'payments', 'policy', 'ops'] as const;

const LoginBody = z.object({
  customerId: z.string().min(1).max(32),
  otp: z.string().max(16),
  accessCode: z.string().max(128).optional(),
});

const Override = z
  .object({
    extraLatencyMs: z.number().finite().min(0).max(10_000).optional(),
    failRate: z.number().finite().min(0).max(1).optional(),
    hang: z.boolean().optional(),
  })
  .strict();
const ChaosBody = z.record(z.enum(SYSTEMS), Override);

export function registerHttp(app: FastifyInstance, ctx: GatewayCtx): void {
  const allowed = new Set(ctx.config.webOrigins);

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const ok = typeof origin === 'string' && allowed.has(origin);
    if (ok) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (ok) {
        reply.header('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
        reply.header('access-control-allow-headers', 'authorization,content-type');
        reply.header('access-control-max-age', '600');
      }
      return reply.code(204).send();
    }
  });

  const auth = (req: FastifyRequest, reply: FastifyReply): TokenPayload | null => {
    const t = bearer(req.headers.authorization);
    const p = t ? verifyToken(t, ctx.config.sessionSecret, ctx.now()) : null;
    if (!p) void reply.code(401).send({ error: 'unauthorized' });
    return p;
  };

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/demo-customers', async () => ({
    customers: DEMO_CUSTOMERS,
    requiresAccessCode: ctx.config.demoAccessCode !== '',
  }));

  app.post('/api/login', async (req, reply) => {
    if (!ctx.loginLimiter.take(req.ip)) return reply.code(429).send({ error: 'rate_limited', message: 'Too many login attempts. Try again in a minute.' });
    const body = LoginBody.safeParse(req.body);
    const bad = () => reply.code(401).send({ error: 'invalid_credentials' });
    if (!body.success) return bad();
    const { customerId, otp, accessCode } = body.data;
    if (!DEMO_CUSTOMERS.some((c) => c.id === customerId)) return bad();
    if (otp !== DEMO_OTP) return bad();
    if (ctx.config.demoAccessCode && accessCode !== ctx.config.demoAccessCode) return bad();
    const sessionId = randomUUID();
    const token = signToken({ customerId, sessionId, exp: ctx.now() + TOKEN_TTL_MS }, ctx.config.sessionSecret);
    return { token, sessionId };
  });

  app.get('/api/workflows', async () => ({
    workflows: ctx.workflows.list().map((w) => ({ id: w.id, name: w.name, description: w.description, suggestions: w.suggestions })),
  }));

  app.get('/api/me/snapshot', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return reply;
    const snap = await loadSnapshot(ctx.connectors, p.customerId, { signal: AbortSignal.timeout(10_000) });
    return toSnapshotView(snap);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/audit', async (req, reply) => {
    const p = auth(req, reply);
    if (!p) return reply;
    const n = Number(req.query.limit);
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
    const entries = ctx.audit.list(1000).filter((e) => e.customerId === p.customerId).slice(0, limit);
    return { entries };
  });

  app.get('/api/metrics', async () => ({
    metrics: ctx.metrics.snapshot(),
    eventLoopLagP99: ctx.metrics.eventLoopLagP99(),
    rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
    sessions: ctx.sessions.size(),
    voiceSessions: ctx.voiceSessions(),
    limiter: ctx.limiter.stats(),
  }));

  const admin = async (reply: FastifyReply, path: string, init: RequestInit) => {
    try {
      const res = await fetch(ctx.config.mockBaseUrl.replace(/\/+$/, '') + path, { ...init, signal: AbortSignal.timeout(3000) });
      const text = await res.text();
      return reply.code(res.status).header('content-type', 'application/json').send(text || '{}');
    } catch {
      return reply.code(502).send({ error: 'mock_unreachable' });
    }
  };

  app.get('/api/chaos', async (_req, reply) => admin(reply, '/admin/chaos', { method: 'GET' }));

  app.put('/api/chaos', async (req, reply) => {
    const body = ChaosBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: body.error.issues[0]?.message ?? 'Invalid chaos settings' });
    return admin(reply, '/admin/chaos', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.data) });
  });

  if (ctx.config.testHooks) {
    // Eval only: age the cached fallback data by N ms (default 5 minutes).
    app.post<{ Body: { ms?: number } }>('/api/test/age-cache', async (req) => {
      const ms = typeof req.body?.ms === 'number' && req.body.ms > 0 && req.body.ms < 600_000 ? req.body.ms : 300_000;
      ctx.connectors.ageCache(ms);
      return { aged: ms };
    });
  }

  app.post('/api/chaos/reset', async (_req, reply) => {
    for (const s of SYSTEMS) ctx.connectors.invalidate(s, '');
    return admin(reply, '/admin/reset', { method: 'POST' });
  });
}
