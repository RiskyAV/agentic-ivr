/** Seconds of audio buffered before the first frame of an utterance (or after an underrun) starts playing. */
export const JITTER_S = 0.06;

export interface ScheduledSource { stop(): void }

/** The audio device, injectable so scheduling can be tested with a manual clock. */
export interface PlayerBackend {
  /** Seconds on the audio clock. */
  now(): number;
  schedule(pcm: Int16Array, startAt: number, cb: { onStart?: () => void; onEnd: () => void }): ScheduledSource;
  close(): void;
}

interface Utterance {
  seq: number;
  startAt: number | null;
  endAt: number;
  pending: number;
  ended: boolean;
  reported: boolean;
  firstFired: boolean;
}

/**
 * Plays server TTS audio (PCM16LE, mono) back to back with a small jitter buffer.
 * Utterances are identified by turnSeq: stale ones are dropped, a newer one queues behind the audio already
 * scheduled (a filler is not cut by the answer), and flush() stops everything at once (barge-in).
 */
export class PcmPlayer {
  private readonly utts = new Map<number, Utterance>();
  private readonly sources = new Set<ScheduledSource>();
  private current = 0;
  private blocked = -1;
  private nextTime = 0;
  private firstCb: (turnSeq: number) => void = () => {};
  private idleCb: (turnSeq: number, playedMs: number) => void = () => {};

  constructor(private readonly sampleRate = 24000, private readonly backend: PlayerBackend = new WebAudioBackend(sampleRate)) {}

  onFirstAudio(cb: (turnSeq: number) => void): void { this.firstCb = cb; }
  onIdle(cb: (turnSeq: number, playedMs: number) => void): void { this.idleCb = cb; }

  /** True while any scheduled audio has yet to finish. */
  get playing(): boolean { return this.sources.size > 0; }
  get currentSeq(): number { return this.current; }

  /** `tts_begin`: start tracking a new utterance. */
  begin(turnSeq: number): void { this.utterance(turnSeq); }

  enqueue(turnSeq: number, pcm: Uint8Array): void {
    const u = this.utterance(turnSeq);
    if (!u || pcm.length < 2) return;
    const samples = new Int16Array(pcm.length >> 1);
    new Uint8Array(samples.buffer).set(pcm.subarray(0, samples.length * 2)); // copy: alignment-safe, little-endian host
    const now = this.backend.now();
    const start = this.nextTime > now ? this.nextTime : now + JITTER_S;
    const dur = samples.length / this.sampleRate;
    const first = u.startAt === null;
    if (first) u.startAt = start;
    u.pending += 1;
    this.nextTime = start + dur;
    u.endAt = this.nextTime;
    const src = this.backend.schedule(samples, start, {
      ...(first && { onStart: () => { if (!u.firstFired) { u.firstFired = true; this.firstCb(u.seq); } } }),
      onEnd: () => { this.sources.delete(src); u.pending -= 1; this.maybeIdle(u); },
    });
    this.sources.add(src);
  }

  /** `tts_end`: no more audio will arrive for this utterance. */
  end(turnSeq: number): void {
    const u = this.utts.get(turnSeq);
    if (!u) return;
    u.ended = true;
    this.maybeIdle(u);
  }

  /** Milliseconds of the utterance heard so far (capped at its scheduled length). */
  playedMs(turnSeq = this.current): number {
    const u = this.utts.get(turnSeq);
    if (!u || u.startAt === null) return 0;
    return Math.round(Math.max(0, Math.min(this.backend.now(), u.endAt) - u.startAt) * 1000);
  }

  /** Stops all audio immediately. Frames of the flushed utterance that are still in flight are dropped. */
  flush(): { turnSeq: number; playedMs: number } {
    const all = this.flushAll();
    return all.find((r) => r.turnSeq === this.current) ?? { turnSeq: this.current, playedMs: 0 };
  }

  /**
   * Like flush(), but returns one entry per utterance that was scheduled and has not already sent its idle
   * report (a filler still playing, an answer queued behind it with playedMs 0). Utterances with no audio, or
   * already reported as fully played, are not listed.
   */
  flushAll(): { turnSeq: number; playedMs: number }[] {
    const reports = [...this.utts.values()]
      .filter((u) => u.startAt !== null && !u.reported)
      .sort((a, b) => a.seq - b.seq)
      .map((u) => ({ turnSeq: u.seq, playedMs: this.playedMs(u.seq) }));
    for (const s of this.sources) s.stop();
    this.sources.clear();
    this.utts.clear();
    this.nextTime = 0;
    this.blocked = this.current;
    return reports;
  }

  close(): void {
    this.flush();
    this.backend.close();
  }

  private utterance(turnSeq: number): Utterance | null {
    if (turnSeq < this.current || turnSeq <= this.blocked) return null;
    if (turnSeq > this.current) this.current = turnSeq;
    let u = this.utts.get(turnSeq);
    if (!u) this.utts.set(turnSeq, (u = { seq: turnSeq, startAt: null, endAt: 0, pending: 0, ended: false, reported: false, firstFired: false }));
    return u;
  }

  private maybeIdle(u: Utterance): void {
    if (u.pending > 0 || !u.ended || u.reported || u.startAt === null) return;
    u.reported = true;
    const ms = Math.round((u.endAt - u.startAt) * 1000);
    this.utts.delete(u.seq);
    this.idleCb(u.seq, ms);
  }
}

/** Web Audio implementation: one AudioBuffer source per frame, scheduled on the context clock. */
export class WebAudioBackend implements PlayerBackend {
  private readonly ctx: AudioContext;

  constructor(private readonly sampleRate: number) {
    try { this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' }); } catch { this.ctx = new AudioContext({ latencyHint: 'interactive' }); }
    void this.ctx.resume().catch(() => {});
  }

  get context(): AudioContext { return this.ctx; }
  now(): number { return this.ctx.currentTime; }

  schedule(pcm: Int16Array, startAt: number, cb: { onStart?: () => void; onEnd: () => void }): ScheduledSource {
    // The buffer is declared at the TTS rate; the browser resamples if the context runs at another rate.
    const buf = this.ctx.createBuffer(1, pcm.length, this.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
    const node = this.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.ctx.destination);
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (cb.onStart) {
      const fire = cb.onStart;
      timer = setTimeout(fire, Math.max(0, (startAt - this.ctx.currentTime) * 1000));
    }
    node.onended = () => { if (timer) clearTimeout(timer); node.disconnect(); cb.onEnd(); };
    node.start(Math.max(startAt, this.ctx.currentTime));
    return {
      stop: () => {
        if (timer) clearTimeout(timer);
        node.onended = null;
        try { node.stop(); } catch { /* not started */ }
        node.disconnect();
      },
    };
  }

  close(): void { void this.ctx.close().catch(() => {}); }
}
