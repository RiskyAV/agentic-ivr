import type { ActionService } from '../platform/actions/actionService.js';
import type { AuditLog } from '../platform/actions/audit.js';
import type { Connectors } from '../platform/connectors/clients.js';
import type { SessionStore } from '../platform/context/session.js';
import type { Engine } from '../platform/engine/engine.js';
import type { Limiter } from '../platform/llm/limiter.js';
import type { EventLog } from '../platform/telemetry/eventLog.js';
import type { Metrics } from '../platform/telemetry/metrics.js';
import type { SttFactory } from '../platform/voice/stt.js';
import type { TtsFactory } from '../platform/voice/tts.js';
import type { WorkflowRegistry } from '../platform/workflows/registry.js';
import type { Config } from '../config.js';
import type { RateLimiter } from './rateLimit.js';

/** Everything the HTTP and WebSocket layers need; built once in app.ts. */
export interface GatewayCtx {
  config: Config;
  now: () => number;
  sessions: SessionStore;
  engine: Engine;
  actions: ActionService;
  audit: AuditLog;
  connectors: Connectors;
  workflows: WorkflowRegistry;
  metrics: Metrics;
  limiter: Limiter;
  eventLog: EventLog;
  loginLimiter: RateLimiter;
  turnLimiter: RateLimiter;
  /** Live voice sessions (set by the WebSocket gateway). */
  voiceSessions: () => number;
  /** Speech vendors; absent when voice is not configured (voice_start then answers voice_unavailable). */
  voice?: VoiceVendors;
}

export interface VoiceVendors {
  stt: SttFactory;
  tts: TtsFactory;
}
