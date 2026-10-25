import type { ClientMsg, ServerMsg } from '@app/shared';
import { api, ApiError, wsUrl } from './api';
import { useStore } from './store';

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
  }

  send(m: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  /** Simulates a dropped connection (dev tooling and e2e checks); the normal reconnect path takes over. */
  drop(): void { this.ws?.close(4000, 'simulated drop'); }

  get isOpen(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  private open(): void {
    const store = useStore.getState();
    store.setConnection(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(wsUrl(this.token));
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      useStore.getState().setConnection('open');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // binary audio frames arrive with voice (Task 19)
      let msg: ServerMsg;
      try { msg = JSON.parse(ev.data) as ServerMsg; } catch { return; }
      useStore.getState().apply(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
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
};

if (import.meta.env.DEV) (window as unknown as { __northstar?: unknown }).__northstar = { dropSocket: () => socket.drop() };
