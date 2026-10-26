import Fastify, { type FastifyInstance } from 'fastify';
import { DEMO_CUSTOMERS } from '@app/shared';
import { ActionService, PROPOSAL_TTL_MS } from './platform/actions/actionService.js';
import { AuditLog } from './platform/actions/audit.js';
import { buildConnectors } from './platform/connectors/clients.js';
import { fetchTransport, type Transport } from './platform/connectors/transport.js';
import { InMemorySessionStore, type SessionStore } from './platform/context/session.js';
import { Engine } from './platform/engine/engine.js';
import { Guard } from './platform/guard/guard.js';
import { GeminiClient } from './platform/llm/gemini.js';
import { Limiter } from './platform/llm/limiter.js';
import { DEFAULT_STUB_RULES } from './platform/llm/defaultStubRules.js';
import { StubLlm } from './platform/llm/stub.js';
import type { LlmClient } from './platform/llm/types.js';
import { EventLog } from './platform/telemetry/eventLog.js';
import { Metrics } from './platform/telemetry/metrics.js';
import { ToolRegistry } from './platform/tools/registry.js';
import { WorkflowRegistry } from './platform/workflows/registry.js';
import { loanServicingActions } from './workflows/loan-servicing/actions.js';
import { loanServicing } from './workflows/loan-servicing/index.js';
import { loanServicingTools } from './workflows/loan-servicing/tools.js';
import { collectionsActions } from './workflows/collections/actions.js';
import { collections } from './workflows/collections/index.js';
import { collectionsTools } from './workflows/collections/tools.js';
import type { Config } from './config.js';
import type { GatewayCtx, VoiceVendors } from './gateway/context.js';
import { DEFAULT_KEYTERMS, elevenLabsStt } from './platform/voice/stt.js';
import { elevenLabsTts } from './platform/voice/tts.js';
import { registerHttp } from './gateway/http.js';
import { RateLimiter } from './gateway/rateLimit.js';
import { attachWs, SESSION_IDLE_MS, SWEEP_EVERY_MS } from './gateway/ws.js';

export interface AppOptions {
  /** Replaces the LLM chosen by config (tests). */
  llm?: LlmClient;
  /** Injectable clock for session and rate-limit logic (tests). */
  now?: () => number;
  /** Replaces the ElevenLabs STT/TTS factories (tests); `null` disables voice. */
  voice?: VoiceVendors | null;
  /** Replaces the HTTP transport to the mock systems (deterministic replay). */
  transport?: Transport;
  /** Replaces the model behind the guard classifier (deterministic replay). */
  guardLlm?: LlmClient;
}

function vendorsFrom(config: Config): VoiceVendors | undefined {
  const v = config.voice;
  if (!v.elevenLabsApiKey || !v.voiceId) return undefined;
  return {
    stt: elevenLabsStt({ apiKey: v.elevenLabsApiKey, silenceSecs: v.sttSilenceSecs, keyterms: DEFAULT_KEYTERMS }),
    tts: elevenLabsTts({ apiKey: v.elevenLabsApiKey, voiceId: v.voiceId, model: v.ttsModel }),
  };
}

export interface AppHandle {
  app: FastifyInstance;
  llm: LlmClient;
  sessions: SessionStore;
  ctx: GatewayCtx;
  /** Applies the voice idle/duration limits now (they also run every few seconds); for tests. */
  sweepVoice(): void;
  /** Listens and returns the bound port (pass 0 for an ephemeral one). */
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** Wires config into connectors, tools, actions, engine, guard, sessions and the HTTP/WebSocket gateway. */
export async function buildApp(config: Config, opts: AppOptions = {}): Promise<AppHandle> {
  // A swept session takes its pending proposals with it; they must have expired first.
  if (PROPOSAL_TTL_MS >= SESSION_IDLE_MS) throw new Error(`PROPOSAL_TTL_MS (${PROPOSAL_TTL_MS}) must be below SESSION_IDLE_MS (${SESSION_IDLE_MS})`);
  const now = opts.now ?? (() => Date.now());
  const llm: LlmClient =
    opts.llm ??
    (config.llmProvider === 'gemini' ? new GeminiClient(config.geminiApiKey!, config.model) : new StubLlm(DEFAULT_STUB_RULES, { chunkDelayMs: config.stubChunkDelayMs }));
  // Under the stub there is no classifier model: the guard keeps its rules and the model step always allows.
  const guardLlm: LlmClient =
    opts.guardLlm ??
    (config.llmProvider === 'stub' && !opts.llm
      ? new StubLlm([{ match: /[\s\S]*/, script: [[{ type: 'text', text: '{"verdict":"allow"}' }]] }])
      : llm);

  const connectors = buildConnectors(opts.transport ?? fetchTransport(config.mockBaseUrl));
  const audit = new AuditLog();
  const actions = new ActionService([...loanServicingActions, ...collectionsActions], audit);
  const tools = new ToolRegistry();
  for (const t of loanServicingTools) tools.register(t);
  for (const t of collectionsTools) tools.register(t);
  for (const a of [...loanServicingActions, ...collectionsActions]) tools.register(actions.proposeTool(a.type));
  const workflows = new WorkflowRegistry().register(loanServicing).register(collections);
  const metrics = new Metrics();
  // Never throws (a failing disk must not break a turn or a confirm); capped at 200 MB, oldest sessions dropped first.
  const eventLog = new EventLog(config.eventLogDir, { metrics });
  const limiter = new Limiter(config.llmMaxConcurrency, config.llmQueueTimeoutMs);
  const sessions = new InMemorySessionStore(now);
  const engine = new Engine({
    llm, limiter, tools, actions, workflows, connectors, eventLog, metrics, audit,
    guard: new Guard(guardLlm, config.guardModel),
    demoCustomerNames: DEMO_CUSTOMERS.map((c) => c.name),
    config: config.engine,
  });

  const ctx: GatewayCtx = {
    config, now, sessions, engine, actions, audit, connectors, workflows, metrics, limiter, eventLog,
    loginLimiter: new RateLimiter(config.loginsPerMin, 60_000, now),
    turnLimiter: new RateLimiter(config.turnsPerMin, 60_000, now),
    voiceSessions: () => 0,
  };
  const vendors = opts.voice === undefined ? vendorsFrom(config) : opts.voice ?? undefined;
  if (vendors) ctx.voice = vendors;

  // Behind nginx on the same host, trust only the loopback hop, so X-Forwarded-For from the internet cannot be spoofed past it.
  const app = Fastify({ logger: false, ...(config.trustLoopbackProxy && { trustProxy: '127.0.0.1' }) });
  registerHttp(app, ctx);
  const ws = attachWs(app.server, ctx);
  ctx.voiceSessions = () => ws.voiceCount();
  const sweep = setInterval(() => {
    ws.touchLive();
    sessions.sweep(SESSION_IDLE_MS);
  }, SWEEP_EVERY_MS);
  sweep.unref();

  return {
    app, llm, sessions, ctx,
    sweepVoice: () => ws.sweepVoice(),
    async listen(port = config.port, host = config.host) {
      await app.listen({ port, host });
      return (app.server.address() as { port: number }).port;
    },
    async close() {
      clearInterval(sweep);
      await ws.close();
      await app.close();
      metrics.dispose();
    },
  };
}
