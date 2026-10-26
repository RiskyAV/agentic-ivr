import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { today } from '@app/domain';
import { decodeAudioFrame, type ChatItemView, type ClientMsg, type ServerMsg } from '@app/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { ActionOutcome } from '../platform/actions/types.js';
import type { CallEvent } from '../platform/connectors/resilientClient.js';
import type { Session } from '../platform/context/session.js';
import { loadSnapshot, toSnapshotView } from '../platform/context/snapshot.js';
import type { TurnSink } from '../platform/engine/engine.js';
import { TurnTracer } from '../platform/telemetry/tracer.js';
import type { ToolContext } from '../platform/tools/types.js';
import { TtsPool } from '../platform/voice/tts.js';
import { VoiceSession } from '../platform/voice/turnManager.js';
import { verifyToken, type TokenPayload } from './auth.js';
import type { GatewayCtx } from './context.js';

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const RESUME_WINDOW_MS = 5 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const SWEEP_EVERY_MS = 60_000;
export const REPLACED_CODE = 4001;
const MAX_TEXT_CHARS = 4000;
const PING_EVERY_MS = 25_000;
const VOICE_SWEEP_MS = 5_000;
/** Outbound audio is dropped (not queued) once this much is buffered for a slow client (D-024). */
const MAX_BUFFERED_AUDIO_BYTES = 2 * 1024 * 1024;

interface Conn {
  ws: WebSocket;
  session: Session;
  alive: boolean;
  /** Set before the socket is closed because a newer connection took over the session. */
  replaced: boolean;
  /** Present while the client is in voice mode. */
  voice?: VoiceSession;
  /** ctx.now() when voice started, and of the last committed transcript or assistant audio (idle/max limits). */
  voiceStartedAt?: number;
  voiceActiveAt?: number;
}

export interface WsGateway {
  /** Sessions with an open socket. */
  liveCount(): number;
  /** Marks every session with an open socket as seen, so the idle sweep never deletes a connected user. */
  touchLive(): void;
  /** Connections in voice mode. */
  voiceCount(): number;
  /** Stops voice sessions past VOICE_IDLE_MS or VOICE_MAX_MS (runs every few seconds; public for tests). */
  sweepVoice(): void;
  close(): Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError('unsupported frame');
}

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

/** Failures after which the proposal stays pending (D-040), so a re-confirm is safe. */
const RETRYABLE_REASONS = new Set(['execution_uncertain', 'validation_unavailable']);

export function actionResultMsg(proposalId: string, o: ActionOutcome): Extract<ServerMsg, { type: 'action_result' }> {
  // The wire protocol has no "cancelled" status; a cancelled or closed request is reported as rejected.
  const status = o.status === 'cancelled' ? 'rejected' : o.status;
  return {
    type: 'action_result', proposalId, status, ...(o.reference && { reference: o.reference }), message: o.message,
    ...(o.reason && { reason: o.reason }),
    ...(o.status === 'failed' && o.reason !== undefined && RETRYABLE_REASONS.has(o.reason) && { retryable: true }),
  };
}

export function attachWs(server: HttpServer, ctx: GatewayCtx): WsGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** One active socket per session. */
  const active = new Map<string, Conn>();
  const voices = new Set<VoiceSession>();

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

  const sendVoice = (c: Conn, m: ServerMsg | Uint8Array) => {
    // Activity for the idle limit: a committed transcript or assistant audio.
    if (m instanceof Uint8Array || (m.type === 'transcript' && m.final && m.text.trim())) c.voiceActiveAt = ctx.now();
    if (!(m instanceof Uint8Array)) return send(c, m);
    if (c.replaced || c.ws.readyState !== WebSocket.OPEN || c.ws.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) return;
    c.ws.send(m, { binary: true });
  };

  function stopVoice(c: Conn) {
    const v = c.voice;
    if (!v) return;
    c.voice = undefined;
    voices.delete(v);
    v.stop();
  }

  /** Server-initiated stop: the client returns to text mode and shows why. */
  function endVoice(c: Conn, reason: 'idle' | 'max_duration' | 'replaced') {
    if (!c.voice) return;
    stopVoice(c);
    send(c, { type: 'voice_stopped', reason });
  }

  function sweepVoice() {
    const t = ctx.now();
    const { idleMs, maxMs } = ctx.config.voice;
    for (const c of active.values()) {
      if (!c.voice) continue;
      if (t - (c.voiceStartedAt ?? t) > maxMs) endVoice(c, 'max_duration');
      else if (t - (c.voiceActiveAt ?? t) > idleMs) endVoice(c, 'idle');
    }
  }
  const voiceSweep = setInterval(sweepVoice, VOICE_SWEEP_MS);
  voiceSweep.unref();

  async function startVoice(c: Conn, mode: 'open' | 'ptt') {
    if (c.voice) return;
    const vendors = ctx.voice;
    if (!vendors) return err(c, 'voice_unavailable', 'Voice is not configured on this server.');
    // One voice session per customer: an older one (another tab or device) gives way, freeing its slot first.
    for (const other of active.values()) {
      if (other !== c && other.voice && other.session.customerId === c.session.customerId) endVoice(other, 'replaced');
    }
    if (voices.size >= ctx.config.maxVoiceSessions) {
      return err(c, 'voice_capacity', 'Voice is at capacity right now. Please use text, or try again shortly.');
    }
    const session = c.session;
    const v = new VoiceSession({
      sttFactory: vendors.stt,
      ttsPool: new TtsPool(vendors.tts),
      engine: ctx.engine,
      actions: ctx.actions,
      session,
      metrics: ctx.metrics,
      send: (m) => sendVoice(c, m),
      confirm: (id, hash) => confirm(c, id, hash, 'voice'),
      cancel: async (id) => {
        const o = await ctx.actions.cancel(session, id);
        sendResult(c, id, o);
        return o;
      },
      allowTurn: () => ctx.turnLimiter.take(session.id),
      log: (ev) => ctx.eventLog.append(session.id, { ...ev, at: ctx.now() }),
      // STT gave up for good: free the voice slot (the session already sent voice_vendor_error).
      onDead: () => { if (c.voice === v) stopVoice(c); },
      cfg: {
        bargeInMinWords: ctx.config.voice.bargeInMinWords, bargeInVadMs: ctx.config.voice.bargeInVadMs,
        bargeInVadDb: ctx.config.voice.bargeInVadDb, bargeInVadMarginDb: ctx.config.voice.bargeInVadMarginDb, fillerAfterMs: ctx.config.voice.fillerAfterMs, ptt: mode === 'ptt',
      },
    });
    // Reserve the slot before the vendor handshake so concurrent starts cannot exceed the cap.
    c.voice = v;
    c.voiceStartedAt = c.voiceActiveAt = ctx.now();
    voices.add(v);
    try {
      await v.start();
    } catch (e) {
      console.warn('[ws] voice start failed', (e as Error).message);
      if (c.voice === v) stopVoice(c);
      return err(c, 'voice_vendor_error', 'Voice could not start right now. You can keep typing.');
    }
    if (c.voice !== v || c.replaced) v.stop();
  }

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
      stopVoice(old);
      session.activeTurn?.abort.abort();
      old.replaced = true;
      old.ws.close(REPLACED_CODE, 'replaced by a newer connection');
    }

    ws.on('pong', () => { conn.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      stopVoice(conn);
      conn.session.lastSeenAt = ctx.now();
      if (active.get(p.sessionId) === conn) {
        active.delete(p.sessionId);
        conn.session.activeTurn?.abort.abort();
      }
    });

    const ready = (async () => {
      if (!session.snapshot) {
        try {
          // The backend responses are logged (no turn id) so `npm run replay` can serve the session's snapshot from the log.
          const observer = {
            onCall: (e: CallEvent) => ctx.eventLog.append(session.id, {
              type: 'backend_call', at: ctx.now(), system: e.system, method: e.method ?? 'GET', path: e.path ?? e.key, outcome: e.outcome,
              ...(e.status !== undefined && { status: e.status }), ...(e.body !== undefined && { body: e.body }),
            }),
          };
          session.snapshot = await loadSnapshot(ctx.connectors, p.customerId, { signal: AbortSignal.timeout(10_000), observer });
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
    c.voice?.clearAwaiting();
    const turnId = `opener-${randomUUID()}`;
    await ctx.engine.opener(c.session, sinkFor(c, turnId), 'text');
  }

  async function handle(c: Conn, data: unknown, isBinary: boolean) {
    const session = c.session;
    // A socket that lost the session (replaced or closed) must not drive it, even with messages already queued.
    if (c.replaced || active.get(session.id) !== c) return;
    session.lastSeenAt = ctx.now();
    if (isBinary) {
      if (!ctx.voice) return err(c, 'voice_unavailable', 'Voice is not configured on this server.');
      // Mic frames that race a voice_stop are dropped silently.
      if (!c.voice) return;
      let pcm: Uint8Array;
      try {
        pcm = decodeAudioFrame(toBuffer(data)).pcm;
      } catch {
        return err(c, 'bad_request', 'Malformed audio frame.');
      }
      c.voice.pushAudio(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      return;
    }
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
        c.voice?.clearAwaiting(); // a typed turn moves the conversation on: a later spoken yes is not consent (D-021)
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
        await confirm(c, msg.proposalId, msg.termsHash);
        c.voice?.proposalResolved(msg.proposalId);
        return;
      }
      case 'cancel_action': {
        if (!str(msg.proposalId, 128)) return err(c, 'bad_request', 'proposalId is required.');
        sendResult(c, msg.proposalId, await ctx.actions.cancel(session, msg.proposalId));
        c.voice?.proposalResolved(msg.proposalId);
        return;
      }
      case 'set_workflow': {
        const wf = typeof msg.workflowId === 'string' ? ctx.workflows.get(msg.workflowId) : undefined;
        if (!wf) return err(c, 'unknown_workflow', 'That workflow does not exist.');
        session.activeTurn?.abort.abort();
        c.voice?.clearAwaiting();
        session.workflowId = wf.id;
        if (wf.opener) await runOpener(c);
        return;
      }
      case 'voice_start':
        return startVoice(c, msg.mode === 'ptt' ? 'ptt' : 'open');
      case 'voice_stop':
        return stopVoice(c);
      case 'ptt':
        if (!c.voice) return err(c, 'voice_not_started', 'Start voice mode first.');
        c.voice.setPtt(msg.down === true);
        return;
      case 'playback_report':
        if (typeof msg.turnSeq === 'number' && typeof msg.playedMs === 'number') c.voice?.onPlaybackReport(msg.turnSeq, msg.playedMs);
        return;
      case 'client_mark':
        if (str(msg.turnId, 128) && (msg.mark === 'speech_end' || msg.mark === 'first_audio_played') && typeof msg.t === 'number') {
          c.voice?.onClientMark(msg.turnId, msg.mark, msg.t);
        }
        return;
      default:
        return err(c, 'bad_request', 'Unknown message type.');
    }
  }

  function sendResult(c: Conn, proposalId: string, o: ActionOutcome) {
    send(c, actionResultMsg(proposalId, o));
  }

  /** The one confirm path for both channels: confirm, audit event, action_result, then a snapshot refresh. */
  async function confirm(c: Conn, proposalId: string, termsHash: string, via: 'ui' | 'voice' = 'ui'): Promise<ActionOutcome> {
    const session = c.session;
    const loanId = (ctx.actions.get(session, proposalId)?.params as { loanId?: unknown } | undefined)?.loanId;
    const turnId = `confirm-${proposalId}`;
    const tctx: ToolContext = {
      customerId: session.customerId, session, turnId, channel: via === 'voice' ? 'voice' : 'text', connectors: ctx.connectors,
      tracer: new TurnTracer(turnId, via === 'voice' ? 'voice' : 'text'), signal: AbortSignal.timeout(20_000), today: today(),
    };
    const outcome = await ctx.actions.confirm(session, proposalId, termsHash, via, tctx);
    ctx.eventLog.append(session.id, { type: 'confirm', at: ctx.now(), proposalId, outcome: outcome.status, via, ...(outcome.reference && { reference: outcome.reference }) });
    sendResult(c, proposalId, outcome);
    if (outcome.status !== 'executed') return outcome;
    void refreshAfterExecution(c, loanId);
    return outcome;
  }

  async function refreshAfterExecution(c: Conn, loanId: unknown) {
    const session = c.session;
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
    voiceCount: () => voices.size,
    sweepVoice,
    touchLive() {
      const t = ctx.now();
      for (const c of active.values()) c.session.lastSeenAt = t;
    },
    async close() {
      clearInterval(ping);
      clearInterval(voiceSweep);
      for (const c of active.values()) stopVoice(c);
      for (const c of wss.clients) c.close(1001, 'server shutting down');
      await new Promise((r) => setTimeout(r, 50));
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
