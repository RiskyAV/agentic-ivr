import type { ActionService } from '../platform/actions/actionService.js';
import type { AuditLog } from '../platform/actions/audit.js';
import type { Connectors } from '../platform/connectors/clients.js';
import type { SessionStore } from '../platform/context/session.js';
import type { Engine } from '../platform/engine/engine.js';
import type { Limiter } from '../platform/llm/limiter.js';
import type { EventLog } from '../platform/telemetry/eventLog.js';
import type { Metrics } from '../platform/telemetry/metrics.js';
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
  /** Live voice sessions (Task 18 replaces this). */
  voiceSessions: () => number;
}
