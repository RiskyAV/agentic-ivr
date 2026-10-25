import type { Alignment, TtsStream } from './tts.js';
import type { SttStream } from './stt.js';

/** Test double for the STT socket: the test drives `partial` / `committed` by hand. */
export class FakeStt implements SttStream {
  readonly audio: Buffer[] = [];
  commits = 0;
  closed = false;
  private readonly cbs: Record<string, Array<(x: never) => void>> = {};
  constructor(readonly opts: { ptt?: boolean } = {}) {}
  send(pcm: Buffer) { this.audio.push(pcm); }
  commit() { this.commits++; }
  close() { this.closed = true; }
  on(ev: 'partial' | 'committed', cb: (text: string) => void): void;
  on(ev: 'error', cb: (e: Error) => void): void;
  on(ev: 'close', cb: () => void): void;
  on(ev: string, cb: (x: never) => void): void {
    (this.cbs[ev] ??= []).push(cb);
  }
  emit(ev: 'partial' | 'committed', text: string): void;
  emit(ev: 'error', e: Error): void;
  emit(ev: 'close'): void;
  emit(ev: string, arg?: unknown): void {
    for (const cb of this.cbs[ev] ?? []) (cb as (x: unknown) => void)(arg);
  }
}

export type TtsOp = { kind: 'text'; text: string; t: number } | { kind: 'flush'; t: number } | { kind: 'end'; t: number } | { kind: 'close'; t: number };

/**
 * Test double for one TTS socket. With `auto`, every text chunk turns into fake audio a tick later:
 * 10 ms (480 bytes of 24 kHz PCM16) per character, with a matching per-character alignment.
 */
export class FakeTts implements TtsStream {
  readonly ops: TtsOp[] = [];
  closed = false;
  ended = false;
  private audioCbs: Array<(pcm: Buffer, a?: Alignment) => void> = [];
  private doneCbs: Array<() => void> = [];
  private errCbs: Array<(e: Error) => void> = [];
  private pendingAudio = 0;
  private emittedMs = 0;
  /** `absolute`: alignment times count from the start of the utterance, as ElevenLabs sends them in practice. */
  constructor(private readonly auto = true, private readonly msPerChar = 10, private readonly absolute = false) {}
  get texts() { return this.ops.filter((o): o is Extract<TtsOp, { kind: 'text' }> => o.kind === 'text').map((o) => o.text); }
  send(text: string) {
    this.ops.push({ kind: 'text', text, t: performance.now() });
    if (this.auto && !this.closed) {
      this.pendingAudio++;
      setTimeout(() => {
        this.pendingAudio--;
        if (!this.closed) this.emitAudio(text);
        this.maybeDone();
      }, 1);
    }
  }
  flush() { this.ops.push({ kind: 'flush', t: performance.now() }); }
  end() { this.ops.push({ kind: 'end', t: performance.now() }); this.ended = true; this.maybeDone(); }
  close() { this.ops.push({ kind: 'close', t: performance.now() }); this.closed = true; }
  alive() { return !this.closed && !this.ended; }
  onAudio(cb: (pcm: Buffer, a?: Alignment) => void) { this.audioCbs.push(cb); }
  onDone(cb: () => void) { this.doneCbs.push(cb); }
  onError(cb: (e: Error) => void) { this.errCbs.push(cb); }
  emitAudio(text: string) {
    const chars = [...text];
    const pcm = Buffer.alloc(chars.length * this.msPerChar * 48);
    const base = this.absolute ? this.emittedMs : 0;
    this.emittedMs += chars.length * this.msPerChar;
    const a: Alignment = { chars, charStartTimesMs: chars.map((_, i) => base + i * this.msPerChar), charDurationsMs: chars.map(() => this.msPerChar) };
    for (const cb of this.audioCbs) cb(pcm, a);
  }
  /** Vendor final with no audio at all (e.g. nothing generated). */
  finishSilently() { for (const cb of this.doneCbs.splice(0)) cb(); }
  fail(e = new Error('tts down')) { for (const cb of this.errCbs) cb(e); }
  private maybeDone() {
    if (this.ended && this.pendingAudio === 0 && !this.closed) for (const cb of this.doneCbs.splice(0)) cb();
  }
}
