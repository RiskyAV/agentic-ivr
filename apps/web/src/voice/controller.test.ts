import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientMsg, ServerMsg } from '@app/shared';
import { useStore } from '../store';
import type { Capture } from './capture';
import { VoiceController } from './controller';
import { FakeBackend } from './fakes';
import { PcmPlayer } from './player';

const frameOf = (ms: number) => new Uint8Array(Math.round((ms / 1000) * 24000) * 2);
const audio = (seq: number, ms: number) => { const f = frameOf(ms); const out = new Uint8Array(4 + f.length); new DataView(out.buffer).setUint32(0, seq, false); out.set(f, 4); return out.buffer; };

function setup() {
  const sent: ClientMsg[] = [];
  const backend = new FakeBackend();
  const captures: { stopped: boolean; resolve: (c: Capture) => void; reject: (e: unknown) => void; onFrame: (p: Uint8Array) => void }[] = [];
  const c = new VoiceController({
    startCapture: (onFrame) => new Promise<Capture>((resolve, reject) => {
      const rec = { stopped: false, resolve: () => {}, reject, onFrame };
      rec.resolve = () => resolve({ sampleRate: 48000, stop: () => { rec.stopped = true; } });
      captures.push(rec);
    }),
    createPlayer: () => new PcmPlayer(24000, backend),
    socket: { send: (m) => { sent.push(m); return true; }, sendBinary: () => true },
    now: () => 1000,
  });
  const state = () => useStore.getState().voice.state;
  const types = () => sent.map((m) => m.type);
  const msg = (m: ServerMsg) => c.handleMessage(m);
  const begin = (seq: number, turnId = 't1') => msg({ type: 'tts_begin', turnSeq: seq, turnId });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { c, sent, backend, captures, state, types, msg, begin, flush };
}

describe('VoiceController', () => {
  beforeEach(() => { useStore.getState().reset(); useStore.getState().setConnection('open'); });

  it('cancelling while the microphone is opening stops the late capture and never starts voice', async () => {
    const t = setup();
    const p = t.c.start(false);
    expect(t.state()).toBe('connecting');
    t.c.stop();
    expect(t.state()).toBe('off');
    t.captures[0]!.resolve({} as Capture);
    await p;
    expect(t.captures[0]!.stopped).toBe(true);
    expect(t.types()).toEqual([]);
    expect(t.state()).toBe('off');
    expect(t.backend.closed).toBe(true);
  });

  it('can start again after a cancelled start', async () => {
    const t = setup();
    const p1 = t.c.start(false);
    t.c.stop();
    const p2 = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    t.captures[1]!.resolve({} as Capture);
    await Promise.all([p1, p2]);
    expect(t.captures[0]!.stopped).toBe(true);
    expect(t.captures[1]!.stopped).toBe(false);
    expect(t.types()).toEqual(['voice_start']);
    expect(t.state()).toBe('listening');
  });

  it('stays speaking until the answer behind a filler ends', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    t.begin(1); t.c.handleBinary(audio(1, 500)); t.msg({ type: 'tts_end', turnSeq: 1 });
    t.begin(2); t.c.handleBinary(audio(2, 500)); t.msg({ type: 'tts_end', turnSeq: 2 });
    t.backend.advance(0.1);
    expect(t.state()).toBe('speaking');
    t.backend.advance(0.6); // filler done, answer (0.56..1.06) playing
    expect(t.sent.filter((m) => m.type === 'playback_report')).toEqual([{ type: 'playback_report', turnSeq: 1, playedMs: 500 }]);
    expect(t.state()).toBe('speaking');
    t.backend.advance(1.2);
    expect(t.state()).toBe('listening');
    expect(t.sent.filter((m) => m.type === 'playback_report')).toHaveLength(2);
  });

  it('marks speaking when the answer starts even though the turn already sent first_audio_played for the filler', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    t.begin(1); t.c.handleBinary(audio(1, 200)); t.msg({ type: 'tts_end', turnSeq: 1 });
    t.begin(2); t.c.handleBinary(audio(2, 300));
    t.backend.advance(0.1);
    expect(t.state()).toBe('speaking');
    t.backend.advance(0.3); // filler ended -> idle; answer started
    expect(t.state()).toBe('speaking');
    expect(t.sent.filter((m) => m.type === 'client_mark')).toHaveLength(1); // once per turn
  });

  it('barge-in mid-filler reports the filler with its played ms and the queued answer with 0', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    t.begin(1); t.c.handleBinary(audio(1, 1000)); t.msg({ type: 'tts_end', turnSeq: 1 });
    t.begin(2); t.c.handleBinary(audio(2, 500));
    t.backend.advance(0.56);
    t.msg({ type: 'barge_in', turnId: 't1' });
    expect(t.sent.filter((m) => m.type === 'playback_report')).toEqual([
      { type: 'playback_report', turnSeq: 1, playedMs: 500 },
      { type: 'playback_report', turnSeq: 2, playedMs: 0 },
    ]);
    expect(t.state()).toBe('listening');
    expect(t.backend.sources.every((s) => s.stopped || s.ended)).toBe(true);
  });

  it('audio_flush (guard retract) stops queued audio like a barge-in', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    t.begin(1); t.c.handleBinary(audio(1, 1000));
    t.backend.advance(0.2);
    t.msg({ type: 'audio_flush', turnId: 't1', reason: 'retract' });
    expect(t.backend.sources.every((s) => s.stopped || s.ended)).toBe(true);
    expect(t.sent.filter((m) => m.type === 'playback_report')).toHaveLength(1);
    expect(t.state()).toBe('listening');
  });

  it('voice_stopped from the server returns to text mode without sending voice_stop, and shows why', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    t.msg({ type: 'voice_stopped', reason: 'idle' });
    useStore.getState().apply({ type: 'voice_stopped', reason: 'idle' });
    expect(t.state()).toBe('off');
    expect(t.captures[0]!.stopped).toBe(true);
    expect(t.types()).toEqual(['voice_start']);
    expect(useStore.getState().notice?.message).toMatch(/idle/i);
  });

  it('a hidden tab stops capture and voice', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    t.c.onVisibility(false);
    expect(t.state()).toBe('listening');
    t.c.onVisibility(true);
    expect(t.state()).toBe('off');
    expect(t.captures[0]!.stopped).toBe(true);
    expect(t.types()).toEqual(['voice_start', 'voice_stop']);
  });

  it('a barge-in after the utterance was fully played and reported sends no second report', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    t.begin(1); t.c.handleBinary(audio(1, 200)); t.msg({ type: 'tts_end', turnSeq: 1 });
    t.backend.advance(1);
    t.msg({ type: 'barge_in', turnId: 't1' });
    expect(t.sent.filter((m) => m.type === 'playback_report')).toEqual([{ type: 'playback_report', turnSeq: 1, playedMs: 200 }]);
  });

  it('a barge-in with no audio sends nothing', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    t.begin(1);
    t.msg({ type: 'barge_in', turnId: 't1' });
    expect(t.types()).toEqual(['voice_start']);
  });

  it('stop after a started session sends voice_stop and closes everything', async () => {
    const t = setup();
    const p = t.c.start(true);
    t.captures[0]!.resolve({} as Capture);
    await p;
    expect(t.sent[0]).toEqual({ type: 'voice_start', mode: 'ptt' });
    t.c.stop();
    expect(t.types()).toEqual(['voice_start', 'voice_stop']);
    expect(t.captures[0]!.stopped).toBe(true);
    expect(t.backend.closed).toBe(true);
    expect(t.state()).toBe('off');
  });

  it('debug history is capped', async () => {
    const t = setup();
    const p = t.c.start(false);
    t.captures[0]!.resolve({} as Capture);
    await p;
    for (let i = 1; i <= 80; i++) { t.begin(i); t.c.handleBinary(audio(i, 20)); t.msg({ type: 'tts_end', turnSeq: i }); t.backend.advance(i); }
    expect(t.c.debug.reports.length).toBe(50);
    await t.flush();
  });
});
