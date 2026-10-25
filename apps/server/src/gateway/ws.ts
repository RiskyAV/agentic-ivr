import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { today } from '@app/domain';
import type { ChatItemView, ClientMsg, ServerMsg } from '@app/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { ActionOutcome } from '../platform/actions/types.js';
import type { Session } from '../platform/context/session.js';
import { loadSnapshot, toSnapshotView } from '../platform/context/snapshot.js';
import type { TurnSink } from '../platform/engine/engine.js';
import { TurnTracer } from '../platform/telemetry/tracer.js';
import type { ToolContext } from '../platform/tools/types.js';
import { verifyToken, type TokenPayload } from './auth.js';
import type { GatewayCtx } from './context.js';

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const RESUME_WINDOW_MS = 5 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const SWEEP_EVERY_MS = 60_000;
export const REPLACED_CODE = 4001;
const MAX_TEXT_CHARS = 4000;
const PING_EVERY_MS = 25_000;

interface Conn {
  ws: WebSocket;
  session: Session;
  alive: boolean;
  /** Set before the socket is closed because a newer connection took over the session. */
  replaced: boolean;
}

export interface WsGateway {
  /** Sessions with an open socket. */
  liveCount(): number;
  /** Marks every session with an open socket as seen, so the idle sweep never deletes a connected user. */
  touchLive(): void;
  close(): Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function historyView(session: Session, ctx: Pick<GatewayCtx, 'actions'>): ChatItemView[] {
  const items: ChatItemView[] = [];
  let turnId = 'h0';
  session.history.forEach((e, i) => {
    if (e.role === 'user') {
      turnId = `h${i}`;
      items.push({ kind: 'user', turnId, text: e.text, channel: e.channel });
    } else if (e.role === 'assistant') {
      items.push({ kind: 'assistant', turnId, text: e.text, sources: [] });
    }
  });
  for (const p of ctx.actions.pending(session.id)) items.push({ kind: 'proposal', proposal: ctx.actions.toView(p), status: 'pending' });
  return items;
}

export function attachWs(server: HttpServer, ctx: GatewayCtx): WsGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** One active socket per session. */
  const active = new Map<string, Conn>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const payload = verifyToken(url.searchParams.get('token') ?? '', ctx.config.sessionSecret, ctx.now());
    if (!payload) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, payload));
  });

  const ping = setInterval(() => {
    for (const c of active.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, PING_EVERY_MS);
  ping.unref();

  const send = (c: Conn, m: ServerMsg) => {
    if (!c.replaced && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m));
  };

  const sinkFor = (c: Conn, turnId: string): TurnSink => ({
    delta: (text) => send(c, { type: 'assistant_delta', turnId, text }),
    progress: (tool, label) => send(c, { type: 'progress', turnId, tool, label }),
    proposal: (proposal) => send(c, { type: 'action_proposal', proposal }),
    done: (v) => send(c, { type: 'assistant_done', turnId, text: v.text, sources: v.sources, ...(v.tables && { tables: v.tables }) }),
    retract: (replacement) => send(c, { type: 'assistant_retract', turnId, replacement }),
    trace: (trace) => send(c, { type: 'trace', trace }),
  });

  const err = (c: Conn, code: string, message: string) => send(c, { type: 'error', code, message });

  function onConnection(ws: WebSocket, p: TokenPayload) {
    const now = ctx.now();
    let session = ctx.sessions.get(p.sessionId);
    const resumed = !!session && session.customerId === p.customerId && now - session.lastSeenAt <= RESUME_WINDOW_MS;
    if (!session || !resumed) {
      if (session) {
        // Past the resume window: the old session is gone, and so are its open proposals (they must not resurface).
        const stale = session;
        stale.activeTurn?.abort.abort();
        for (const prop of ctx.actions.pending(stale.id)) void ctx.actions.cancel(stale, prop.id).catch(() => {});
      }
      session = {
        id: p.sessionId, customerId: p.customerId, workflowId: ctx.workflows.list()[0]!.id, history: [], entities: {},
        turnSeq: 0, guardStrikes: 0, pendingProposalIds: [], lastSeenAt: now,
      };
      ctx.sessions.put(session);
    }
    session.lastSeenAt = now;
    const conn: Conn = { ws, session, alive: true, replaced: false };

    // One socket per session: the newcomer wins, and the old socket's turn is abandoned.
    const old = active.get(p.sessionId);
    active.set(p.sessionId, conn);
    if (old) {
      session.activeTurn?.abort.abort();
      old.replaced = true;
      old.ws.close(REPLACED_CODE, 'replaced by a newer connection');
    }

    ws.on('pong', () => { conn.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      conn.session.lastSeenAt = ctx.now();
      if (active.get(p.sessionId) === conn) {
        active.delete(p.sessionId);
        conn.session.activeTurn?.abort.abort();
      }
    });

    const ready = (async () => {
      if (!session.snapshot) {
        try {
          session.snapshot = await loadSnapshot(ctx.connectors, p.customerId, { signal: AbortSignal.timeout(10_000) });
        } catch (e) {
          console.warn('[ws] snapshot load failed', (e as Error).message);
        }
      }
      const cust = session.snapshot?.customer ?? { id: p.customerId, name: p.customerId };
      send(conn, {
        type: 'session_ready', sessionId: session.id, workflowId: session.workflowId,
        customer: { id: p.customerId, name: cust.name }, resumed, history: historyView(session, ctx),
      });
      if (session.snapshot) send(conn, { type: 'snapshot', snapshot: toSnapshotView(session.snapshot) });
      else err(conn, 'snapshot_unavailable', 'Your account details could not be loaded just now.');
      if (!resumed) await runOpener(conn);
    })().catch((e) => console.warn('[ws] connect failed', e));

    ws.on('message', (data, isBinary) => {
      void ready.then(() => handle(conn, data, isBinary)).catch((e) => {
        console.warn('[ws] handler failed', e);
        err(conn, 'internal', 'Something went wrong.');
      });
    });
  }

  async function runOpener(c: Conn) {
    const turnId = `opener-${randomUUID()}`;
    await ctx.engine.opener(c.session, sinkFor(c, turnId), 'text');
  }

  async function handle(c: Conn, data: unknown, isBinary: boolean) {
    const session = c.session;
    // A socket that lost the session (replaced or closed) must not drive it, even with messages already queued.
    if (c.replaced || active.get(session.id) !== c) return;
    session.lastSeenAt = ctx.now();
    if (isBinary) return err(c, 'voice_unavailable', 'Voice is not available yet.');
    let msg: ClientMsg;
    try {
      const parsed: unknown = JSON.parse(String(data));
      if (!isObj(parsed) || typeof parsed.type !== 'string') throw new Error('not a message');
      msg = parsed as unknown as ClientMsg;
    } catch {
      return err(c, 'bad_request', 'Messages must be JSON objects with a type.');
    }

    switch (msg.type) {
      case 'user_text': {
        if (typeof msg.text !== 'string' || msg.text.trim() === '') return err(c, 'bad_request', 'Message text is required.');
        if (msg.text.length > MAX_TEXT_CHARS) return err(c, 'bad_request', `Messages are limited to ${MAX_TEXT_CHARS} characters.`);
        if (msg.turnId !== undefined && !str(msg.turnId, 64)) return err(c, 'bad_request', 'Invalid turnId.');
        if (!ctx.turnLimiter.take(session.id)) return err(c, 'rate_limited', 'You are sending messages too quickly. Please wait a moment.');
        const turnId = msg.turnId ?? randomUUID();
        send(c, { type: 'turn_start', turnId, channel: 'text', userText: msg.text });
        // Not awaited: the socket must keep accepting messages (barge-in, confirm) while a turn runs.
        void ctx.engine.runTurn(session, { turnId, text: msg.text, channel: 'text' }, sinkFor(c, turnId)).catch((e) => {
          console.warn('[ws] turn failed', e);
          err(c, 'internal', 'Something went wrong on my side. Please try again.');
        });
        return;
      }
      case 'confirm_action': {
        if (!str(msg.proposalId, 128) || !str(msg.termsHash, 128)) return err(c, 'bad_request', 'proposalId and termsHash are required.');
        return confirm(c, msg.proposalId, msg.termsHash);
      }
      case 'cancel_action': {
        if (!str(msg.proposalId, 128)) return err(c, 'bad_request', 'proposalId is required.');
        return sendResult(c, msg.proposalId, await ctx.actions.cancel(session, msg.proposalId));
      }
      case 'set_workflow': {
        const wf = typeof msg.workflowId === 'string' ? ctx.workflows.get(msg.workflowId) : undefined;
        if (!wf) return err(c, 'unknown_workflow', 'That workflow does not exist.');
        session.activeTurn?.abort.abort();
        session.workflowId = wf.id;
        if (wf.opener) await runOpener(c);
        return;
      }
      case 'voice_start':
      case 'voice_stop':
      case 'ptt':
        return err(c, 'voice_unavailable', 'Voice is not available yet.');
      case 'playback_report':
      case 'client_mark':
        return;
      default:
        return err(c, 'bad_request', 'Unknown message type.');
    }
  }

  function sendResult(c: Conn, proposalId: string, o: ActionOutcome) {
    // The wire protocol has no "cancelled" status; a cancelled or closed request is reported as rejected.
    const status = o.status === 'cancelled' ? 'rejected' : o.status;
    send(c, { type: 'action_result', proposalId, status, ...(o.reference && { reference: o.reference }), message: o.message });
  }

  async function confirm(c: Conn, proposalId: string, termsHash: string) {
    const session = c.session;
    const loanId = (ctx.actions.get(session, proposalId)?.params as { loanId?: unknown } | undefined)?.loanId;
    const turnId = `confirm-${proposalId}`;
    const tctx: ToolContext = {
      customerId: session.customerId, session, turnId, channel: 'text', connectors: ctx.connectors,
      tracer: new TurnTracer(turnId, 'text'), signal: AbortSignal.timeout(20_000), today: today(),
    };
    const outcome = await ctx.actions.confirm(session, proposalId, termsHash, 'ui', tctx);
    ctx.eventLog.append(session.id, { type: 'confirm', at: ctx.now(), proposalId, outcome: outcome.status, ...(outcome.reference && { reference: outcome.reference }) });
    sendResult(c, proposalId, outcome);
    if (outcome.status !== 'executed') return;
    const cid = session.customerId;
    ctx.connectors.invalidate('ops', `ops:requests:${cid}`);
    ctx.connectors.invalidate('lms', `lms:loans:${cid}`);
    if (typeof loanId === 'string') {
      ctx.connectors.invalidate('lms', `lms:loan:${loanId}`);
      ctx.connectors.invalidate('lms', `lms:schedule:${loanId}`);
      ctx.connectors.invalidate('payments', `payments:list:${loanId}`);
    }
    // The result is already sent; a failed reload must not turn a successful action into an error.
    try {
      const fresh = await loadSnapshot(ctx.connectors, cid, { signal: AbortSignal.timeout(10_000) });
      if (fresh.partial.length > 0 && session.snapshot) {
        console.warn('[ws] snapshot reload after execution was partial; keeping the previous one');
        return;
      }
      session.snapshot = fresh;
      send(c, { type: 'snapshot', snapshot: toSnapshotView(fresh) });
    } catch (e) {
      console.warn('[ws] snapshot reload after execution failed', (e as Error).message);
    }
  }

  return {
    liveCount: () => active.size,
    touchLive() {
      const t = ctx.now();
      for (const c of active.values()) c.session.lastSeenAt = t;
    },
    async close() {
      clearInterval(ping);
      for (const c of wss.clients) c.close(1001, 'server shutting down');
      await new Promise((r) => setTimeout(r, 50));
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
