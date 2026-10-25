import { speakInr } from '@app/domain';
import { WebSocket } from 'ws';

/** Character timings for one audio chunk; times are relative to the start of that chunk. */
export interface Alignment {
  chars: string[];
  charStartTimesMs: number[];
  charDurationsMs?: number[];
}

/** One streaming TTS connection, used for exactly one assistant utterance. */
export interface TtsStream {
  /** Queues text; generation starts per the chunk schedule, or at `flush`. */
  send(text: string): void;
  /** Forces generation of everything queued so far. */
  flush(): void;
  /** End of input: generate the rest, then the server closes (onDone fires after the last audio). */
  end(): void;
  /** Immediate close (barge-in): no more audio. */
  close(): void;
  /** False once the socket is closing or closed. */
  alive(): boolean;
  onAudio(cb: (pcm24k: Buffer, alignment?: Alignment) => void): void;
  onDone(cb: () => void): void;
  onError(cb: (e: Error) => void): void;
}

export type TtsFactory = () => Promise<TtsStream>;

export interface ElevenLabsTtsConfig {
  apiKey: string;
  voiceId: string;
  model: string;
  baseUrl?: string;
  speed?: number;
  /** Connect timeout. */
  connectTimeoutMs?: number;
}

/** ElevenLabs stream-input WebSocket: text in, 24 kHz PCM16 + character alignment out. */
export function elevenLabsTts(cfg: ElevenLabsTtsConfig): TtsFactory {
  const base = cfg.baseUrl ?? 'wss://api.elevenlabs.io';
  const url =
    `${base}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream-input` +
    `?model_id=${encodeURIComponent(cfg.model)}&output_format=pcm_24000&inactivity_timeout=180&sync_alignment=true`;
  return () =>
    new Promise<TtsStream>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { 'xi-api-key': cfg.apiKey } });
      const audioCbs: Array<(pcm: Buffer, a?: Alignment) => void> = [];
      const doneCbs: Array<() => void> = [];
      const errCbs: Array<(e: Error) => void> = [];
      let opened = false;
      let finished = false;
      let closing = false;
      const timer = setTimeout(() => { if (!opened) { ws.terminate(); reject(new Error('tts connect timeout')); } }, cfg.connectTimeoutMs ?? 5000);
      const finish = () => {
        if (finished) return;
        finished = true;
        for (const cb of doneCbs.splice(0)) cb();
      };
      const fail = (e: Error) => {
        if (finished || closing) return;
        for (const cb of errCbs) cb(e);
        finish();
      };
      const sendJson = (o: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
      const stream: TtsStream = {
        send: (text) => { if (text && !closing) sendJson({ text }); },
        flush: () => { if (!closing) sendJson({ text: ' ', flush: true }); },
        end: () => { if (!closing) { sendJson({ text: '' }); closing = true; } },
        close: () => {
          closing = true;
          finished = true;
          if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
          else ws.close();
        },
        alive: () => !closing && !finished && ws.readyState === WebSocket.OPEN,
        onAudio: (cb) => { audioCbs.push(cb); },
        onDone: (cb) => { doneCbs.push(cb); },
        onError: (cb) => { errCbs.push(cb); },
      };
      ws.on('open', () => {
        opened = true;
        clearTimeout(timer);
        sendJson({
          text: ' ',
          voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: cfg.speed ?? 1.05 },
          generation_config: { chunk_length_schedule: [50, 90, 140, 200] },
        });
        resolve(stream);
      });
      ws.on('message', (data) => {
        if (finished) return;
        let m: { audio?: string | null; isFinal?: boolean | null; alignment?: Alignment | null; normalizedAlignment?: Alignment | null; error?: string; message?: string };
        try { m = JSON.parse(String(data)); } catch { return; }
        if (m.error) return fail(new Error(`tts: ${m.error}${m.message ? ` ${m.message}` : ''}`));
        if (m.audio) {
          const pcm = Buffer.from(m.audio, 'base64');
          const a = m.alignment ?? m.normalizedAlignment ?? undefined;
          for (const cb of audioCbs) cb(pcm, a ?? undefined);
        }
        if (m.isFinal) finish();
      });
      ws.on('error', (e) => {
        if (!opened) { clearTimeout(timer); reject(e); return; }
        fail(e);
      });
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        if (!opened) { reject(new Error(`tts closed before open (${code})`)); return; }
        // A close after `end()` is the normal end of the stream; anything else mid-utterance is a failure.
        if (!closing && !finished) fail(new Error(`tts socket closed (${code} ${String(reason)})`));
        closing = true;
        finish();
      });
    });
}

/**
 * Keeps one pre-opened TTS connection ready so an utterance never pays the connect + handshake cost (D-048).
 * Each connection serves one utterance; `take()` hands it out and opens the next one in the background.
 */
export class TtsPool {
  private warm?: Promise<TtsStream | null>;
  private warmAt = 0;
  private closed = false;

  constructor(
    private readonly factory: TtsFactory,
    private readonly opts: { maxAgeMs?: number } = {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  prewarm(): void {
    if (this.warm || this.closed) return;
    this.warmAt = this.now();
    this.warm = this.factory().catch(() => null);
  }

  async take(): Promise<TtsStream> {
    if (this.closed) throw new Error('tts pool closed');
    const w = this.warm;
    const age = this.now() - this.warmAt;
    this.warm = undefined;
    try {
      let s = w ? await w : null;
      // ElevenLabs closes idle sockets (inactivity_timeout=180 s); recycle well before that.
      if (s && (!s.alive() || age > (this.opts.maxAgeMs ?? 150_000))) { s.close(); s = null; }
      s ??= await this.factory();
      if (this.closed) { s.close(); throw new Error('tts pool closed'); }
      return s;
    } finally {
      this.prewarm();
    }
  }

  close(): void {
    this.closed = true;
    const w = this.warm;
    this.warm = undefined;
    void w?.then((s) => s?.close());
  }
}

/**
 * Cuts an LLM token stream into speakable clauses: at `.?!;:` followed by whitespace, at a `,` once the buffer is
 * at least 40 characters, or at a word boundary once it reaches 120 characters. `end()` returns the remainder.
 */
export class ClauseChunker {
  private buf = '';

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      const cut = this.cutAt();
      if (cut < 0) break;
      const clause = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut).replace(/^\s+/, '');
      if (clause) out.push(clause);
    }
    return out;
  }

  end(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }

  private cutAt(): number {
    const strong = /[.?!;:]\s/.exec(this.buf);
    if (strong) return strong.index + 1;
    if (this.buf.length >= 40) {
      const comma = this.buf.lastIndexOf(', ');
      if (comma > 0) return comma + 1;
    }
    if (this.buf.length >= 120) {
      const space = this.buf.lastIndexOf(' ', 120);
      return space > 0 ? space : 120;
    }
    return -1;
  }
}

/** Strips markdown and list markup that TTS would read aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*|__|`+|^#+\s*/gm, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\[(\d+)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Display money in a summary ("₹1,67,261") becomes speech ("one lakh ..."), so read-backs never say digit groups. */
export function speakableSummary(summary: string): string {
  return cleanForSpeech(
    summary.replace(/₹\s?([\d,]+)(?:\.(\d{1,2}))?/g, (_m, whole: string, frac?: string) => {
      const paise = Number(whole.replace(/,/g, '')) * 100 + (frac ? Number(frac.padEnd(2, '0')) : 0);
      return Number.isFinite(paise) ? speakInr(paise) : _m;
    }),
  );
}
