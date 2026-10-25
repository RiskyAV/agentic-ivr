import { WebSocket } from 'ws';

/** One realtime STT session. Mic audio in (16 kHz PCM16 mono), partial and committed transcripts out. */
export interface SttStream {
  send(pcm16k: Buffer): void;
  /** Manual commit (push-to-talk release): ends the current segment now. */
  commit(): void;
  close(): void;
  on(ev: 'partial' | 'committed', cb: (text: string) => void): void;
  on(ev: 'error', cb: (e: Error) => void): void;
  /** The vendor ended the session without an error (e.g. its session time limit); reconnect when needed. */
  on(ev: 'close', cb: () => void): void;
}

export type SttFactory = (opts: { ptt: boolean }) => Promise<SttStream>;

export interface ElevenLabsSttConfig {
  apiKey: string;
  /** VAD end-of-speech silence (STT_SILENCE_SECS). */
  silenceSecs: number;
  keyterms?: string[];
  languageCode?: string;
  baseUrl?: string;
  connectTimeoutMs?: number;
}

/** Domain words Scribe should bias towards. */
export const DEFAULT_KEYTERMS = ['EMI', 'foreclosure', 'prepayment', 'prepay', 'NACH', 'Northstar', 'lakh', 'bounce charge', 'tenure'];

const ERROR_TYPES = new Set([
  'error', 'auth_error', 'quota_exceeded', 'rate_limited', 'input_error', 'transcriber_error', 'resource_exhausted',
  'unaccepted_terms', 'queue_overflow', 'chunk_size_exceeded',
]);
/** Per-request complaints (e.g. a push-to-talk tap with no speech): the session itself is fine. */
const IGNORED_TYPES = new Set(['commit_throttled', 'insufficient_audio_activity']);
/** Session-ending messages that are not faults: the caller reconnects on demand. */
const END_TYPES = new Set(['session_time_limit_exceeded', 'inactivity_timeout', 'session_timeout']);

export function sttUrl(cfg: ElevenLabsSttConfig, ptt: boolean): string {
  const q = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    audio_format: 'pcm_16000',
    commit_strategy: ptt ? 'manual' : 'vad',
    language_code: cfg.languageCode ?? 'en',
  });
  if (!ptt) q.set('vad_silence_threshold_secs', String(cfg.silenceSecs));
  for (const k of cfg.keyterms ?? []) q.append('keyterms', k);
  return `${cfg.baseUrl ?? 'wss://api.elevenlabs.io'}/v1/speech-to-text/realtime?${q.toString()}`;
}

/** ElevenLabs Scribe v2 realtime over WebSocket. Resolves once the vendor confirms the session. */
export function elevenLabsStt(cfg: ElevenLabsSttConfig): SttFactory {
  return ({ ptt }) =>
    new Promise<SttStream>((resolve, reject) => {
      const ws = new WebSocket(sttUrl(cfg, ptt), { headers: { 'xi-api-key': cfg.apiKey } });
      const cbs: Record<string, Array<(x?: unknown) => void>> = {};
      const emit = (ev: string, x?: unknown) => { for (const cb of cbs[ev] ?? []) cb(x); };
      let started = false;
      let ended = false;
      const timer = setTimeout(() => { if (!started) { ws.terminate(); reject(new Error('stt connect timeout')); } }, cfg.connectTimeoutMs ?? 5000);
      const end = (ev: 'error' | 'close', e?: Error) => {
        if (ended) return;
        ended = true;
        emit(ev, e);
        ws.close();
      };
      const chunk = (pcm: Buffer, commit: boolean) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm.toString('base64'), commit, sample_rate: 16000 }));
      };
      const stream: SttStream = {
        send: (pcm) => chunk(pcm, false),
        commit: () => chunk(Buffer.alloc(0), true),
        close: () => { ended = true; ws.close(); },
        on: (ev: string, cb: (x: never) => void) => { (cbs[ev] ??= []).push(cb as (x?: unknown) => void); },
      };
      ws.on('message', (data) => {
        let m: { message_type?: string; text?: string; error?: string; message?: string };
        try { m = JSON.parse(String(data)); } catch { return; }
        const t = m.message_type ?? '';
        if (t === 'session_started') {
          started = true;
          clearTimeout(timer);
          resolve(stream);
        } else if (t === 'partial_transcript') emit('partial', m.text ?? '');
        else if (t === 'committed_transcript') emit('committed', m.text ?? '');
        else if (IGNORED_TYPES.has(t)) return;
        else if (END_TYPES.has(t)) end('close');
        else if (ERROR_TYPES.has(t) || t.endsWith('error')) {
          const e = new Error(`stt ${t}: ${m.error ?? m.message ?? ''}`.trim());
          if (!started) { clearTimeout(timer); reject(e); ws.close(); return; }
          end('error', e);
        }
      });
      ws.on('error', (e) => {
        if (!started) { clearTimeout(timer); reject(e); return; }
        end('error', e);
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        if (!started) { reject(new Error(`stt closed before session start (${code})`)); return; }
        // 1000/1001: the vendor ended an idle or expired session normally; reconnect on demand, not a fault.
        end(code === 1000 || code === 1001 ? 'close' : 'error', new Error(`stt socket closed (${code})`));
      });
    });
}
