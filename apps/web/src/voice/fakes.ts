import type { PlayerBackend } from './player';

/** A manual audio clock with fake scheduled sources, for tests. */
export class FakeBackend implements PlayerBackend {
  t = 0;
  closed = false;
  sources: { startAt: number; samples: number; stopped: boolean; started: boolean; ended: boolean; cb: { onStart?: () => void; onEnd: () => void } }[] = [];
  now() { return this.t; }
  schedule(pcm: Int16Array, startAt: number, cb: { onStart?: () => void; onEnd: () => void }) {
    const s = { startAt, samples: pcm.length, stopped: false, started: false, ended: false, cb };
    this.sources.push(s);
    return { stop: () => { s.stopped = true; } };
  }
  close() { this.closed = true; }
  /** Moves the clock, firing start/end callbacks of sources that are not stopped. */
  advance(to: number, rate = 24000) {
    this.t = to;
    for (const s of this.sources) {
      if (s.stopped) continue;
      if (!s.started && s.startAt <= to) { s.started = true; s.cb.onStart?.(); }
      if (!s.ended && s.startAt + s.samples / rate <= to) { s.ended = true; s.cb.onEnd(); }
    }
  }
}
