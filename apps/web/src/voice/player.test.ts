import { describe, expect, it } from 'vitest';
import { FakeBackend } from './fakes';
import { PcmPlayer } from './player';

const frame = (ms: number) => new Uint8Array(Math.round((ms / 1000) * 24000) * 2);

describe('PcmPlayer', () => {
  it('schedules the first frame 60 ms after enqueue and the next back-to-back', () => {
    const b = new FakeBackend();
    b.t = 1;
    const p = new PcmPlayer(24000, b);
    p.enqueue(1, frame(100));
    p.enqueue(1, frame(100));
    expect(b.sources[0]!.startAt).toBeCloseTo(1.06, 5);
    expect(b.sources[1]!.startAt).toBeCloseTo(1.16, 5);
  });

  it('drops frames with a stale turnSeq and switches to a newer one without cutting audio', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    p.enqueue(5, frame(100));
    p.enqueue(4, frame(100));
    expect(b.sources).toHaveLength(1);
    p.enqueue(6, frame(100));
    expect(b.sources).toHaveLength(2);
    expect(b.sources[1]!.startAt).toBeCloseTo(0.16, 5); // queued behind turn 5
    expect(b.sources[0]!.stopped).toBe(false);
    p.enqueue(5, frame(100)); // late frame of the finished utterance
    expect(b.sources).toHaveLength(2);
  });

  it('flush returns the elapsed time since the first frame started and stops everything', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    for (let i = 0; i < 5; i++) p.enqueue(3, frame(200));
    b.advance(0.46); // first frame began at 0.06
    const r = p.flush();
    expect(r.turnSeq).toBe(3);
    expect(r.playedMs).toBe(400);
    expect(b.sources.every((s) => s.stopped || s.ended)).toBe(true);
    expect(b.sources.filter((s) => s.stopped).length).toBeGreaterThan(0);
  });

  it('caps playedMs at the scheduled audio length and drops frames still in flight after a flush', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    p.enqueue(2, frame(100));
    b.t = 5;
    expect(p.flush()).toEqual({ turnSeq: 2, playedMs: 100 });
    p.enqueue(2, frame(100));
    expect(b.sources).toHaveLength(1);
    p.enqueue(3, frame(100));
    expect(b.sources).toHaveLength(2);
  });

  it('fires onFirstAudio when the first buffer actually starts, once per utterance', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    const seen: number[] = [];
    p.onFirstAudio((s) => seen.push(s));
    p.enqueue(1, frame(100));
    p.enqueue(1, frame(100));
    expect(seen).toEqual([]);
    b.advance(0.05);
    expect(seen).toEqual([]);
    b.advance(0.07);
    b.advance(0.2);
    expect(seen).toEqual([1]);
  });

  it('reports idle once, with the full played duration, only after tts_end and the last buffer ends', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    const idle: [number, number][] = [];
    p.onIdle((s, ms) => idle.push([s, ms]));
    p.enqueue(1, frame(100));
    p.enqueue(1, frame(100));
    b.advance(0.5); // everything played, but the server has not said it is done
    expect(idle).toEqual([]);
    p.end(1);
    expect(idle).toEqual([[1, 200]]);
    p.end(1);
    expect(idle).toHaveLength(1);
  });

  it('reports idle when the last buffer ends after tts_end arrived early', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    const idle: [number, number][] = [];
    p.onIdle((s, ms) => idle.push([s, ms]));
    p.enqueue(7, frame(300));
    p.end(7);
    expect(idle).toEqual([]);
    b.advance(0.2);
    expect(idle).toEqual([]);
    b.advance(0.5);
    expect(idle).toEqual([[7, 300]]);
  });

  it('re-buffers 60 ms after an underrun', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    p.enqueue(1, frame(100));
    b.advance(1);
    p.enqueue(1, frame(100));
    expect(b.sources[1]!.startAt).toBeCloseTo(1.06, 5);
  });

  it('does not report an utterance that never produced audio', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    const idle: unknown[] = [];
    p.onIdle((s, ms) => idle.push([s, ms]));
    p.begin(4);
    p.end(4);
    expect(idle).toEqual([]);
  });

  it('flushAll reports every audible utterance: the filler with its played ms and the queued answer with 0', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    p.enqueue(1, frame(1000)); // filler: 0.06..1.06
    p.enqueue(2, frame(500)); // answer queued behind it
    b.advance(0.56);
    expect(p.flushAll()).toEqual([{ turnSeq: 1, playedMs: 500 }, { turnSeq: 2, playedMs: 0 }]);
    expect(b.sources.every((s) => s.stopped)).toBe(true);
  });

  it('flushAll skips utterances already reported as fully played and ones with no audio', () => {
    const b = new FakeBackend();
    const p = new PcmPlayer(24000, b);
    p.enqueue(1, frame(100));
    p.end(1);
    b.advance(1); // idle report sent for 1
    p.begin(2); // no audio
    expect(p.flushAll()).toEqual([]);
  });
});
