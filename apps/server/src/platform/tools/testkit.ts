import { buildMockServer } from '@app/mock-systems';
import type { Channel } from '@app/shared';
import { buildConnectors } from '../connectors/clients.js';
import { injectTransport } from '../connectors/transport.js';
import type { Session } from '../context/session.js';
import { TurnTracer } from '../telemetry/tracer.js';
import type { ToolContext } from './types.js';

type Chaos = NonNullable<Parameters<typeof buildMockServer>[0]['chaos']>;
const ZERO = { minMs: 0, maxMs: 0, failRate: 0 };
export const ZERO_CHAOS: Chaos = { crm: ZERO, lms: ZERO, payments: ZERO, policy: ZERO, ops: ZERO };

export function makeSession(customerId: string): Session {
  return {
    id: `s-${customerId}`, customerId, workflowId: 'loan-servicing', history: [], entities: {},
    turnSeq: 0, guardStrikes: 0, pendingProposalIds: [], lastSeenAt: 0,
  };
}

/** A mock backend with zero latency/failures (override per system) and a ToolContext factory. */
export function makeHarness(chaos: Chaos = {}) {
  const app = buildMockServer({ today: '2026-10-25', seed: 1, chaos: { ...ZERO_CHAOS, ...chaos } });
  const connectors = buildConnectors(injectTransport(app));
  const ctxFor = (customerId: string, channel: Channel = 'text', session: Session = makeSession(customerId)): ToolContext => ({
    customerId, session, turnId: 't1', channel, connectors,
    tracer: new TurnTracer('t1', channel), signal: new AbortController().signal, today: '2026-10-25',
  });
  return { app, connectors, ctxFor, close: () => app.close() };
}
