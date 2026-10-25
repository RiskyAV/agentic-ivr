import type { ClientMsg, ServerMsg } from '@app/shared';
import { api, ApiError, wsUrl } from './api';
import { useStore } from './store';

type MsgListener = (m: ServerMsg) => void;
const msgListeners = new Set<MsgListener>();
const binaryListeners = new Set<(buf: ArrayBuffer) => void>();
const closeListeners = new Set<() => void>();
/** Hooks for the voice controller (kept here so socket.ts does not import it). */
export const socketEvents = {
  onMessage: (f: MsgListener) => { msgListeners.add(f); return () => { msgListeners.delete(f); }; },
  onBinary: (f: (buf: ArrayBuffer) => void) => { binaryListeners.add(f); return () => { binaryListeners.delete(f); }; },
  /** The socket closed or was stopped: the server-side voice session is gone with it. */
  onClose: (f: () => void) => { closeListeners.add(f); return () => { closeListeners.delete(f); }; },
};

const REPLACED_CODE = 4001;
const MAX_BACKOFF_MS = 10_000;

/** One WebSocket per signed-in tab; reconnects with exponential backoff, reusing the same token (so the server resumes the session). */
export class Socket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly token: string, private readonly onAuthLost: () => void) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'bye');
    useStore.getState().setConnection('closed');
    for (const f of closeListeners) f();
  }

  send(m: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  sendBinary(data: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 1_000_000) return false;
    this.ws.send(data);
    return true;
  }

  /** Simulates a dropped connection (dev tooling and e2e checks); the normal reconnect path takes over. */
  drop(): void { this.ws?.close(4000, 'simulated drop'); }

  get isOpen(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  private open(): void {
    const store = useStore.getState();
    store.setConnection(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(wsUrl(this.token));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      useStore.getState().setConnection('open');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { for (const f of binaryListeners) f(ev.data as ArrayBuffer); return; }
      let msg: ServerMsg;
      try { msg = JSON.parse(ev.data) as ServerMsg; } catch { return; }
      useStore.getState().apply(msg);
      for (const f of msgListeners) f(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      for (const f of closeListeners) f();
      if (ev.code === REPLACED_CODE) {
        useStore.getState().setConnection('closed');
        useStore.getState().apply({ type: 'error', code: 'replaced', message: 'This conversation was opened in another window.' });
        return;
      }
      void this.scheduleReconnect(opened);
    };
  }

  private async scheduleReconnect(wasOpen: boolean): Promise<void> {
    this.attempt += 1;
    useStore.getState().setConnection('reconnecting');
    // A handshake that never opened may be an expired or invalid token: ask the API once before retrying forever.
    if (!wasOpen && this.attempt >= 2) {
      try {
        await api.checkToken(this.token);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // The user may have logged out or signed in again while the check was in flight.
          if (this.stopped || current !== this) return;
          this.stopped = true;
          this.onAuthLost();
          return;
        }
      }
    }
    if (this.stopped) return;
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.attempt - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) this.open(); }, Math.min(delay, MAX_BACKOFF_MS));
  }
}

let current: Socket | null = null;
export const socket = {
  connect(token: string, onAuthLost: () => void): Socket {
    current?.stop();
    current = new Socket(token, onAuthLost);
    current.start();
    return current;
  },
  disconnect(): void { current?.stop(); current = null; },
  drop(): void { current?.drop(); },
  send(m: ClientMsg): boolean { return current?.send(m) ?? false; },
  sendBinary(d: Uint8Array): boolean { return current?.sendBinary(d) ?? false; },
};

if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __northstar?: unknown }).__northstar = { dropSocket: () => socket.drop() };
