import { describe, expect, it } from 'vitest';
import { Downsampler, FRAME_SAMPLES } from './capture-worklet.js';

describe('capture downsampler', () => {
  it('turns 48 kHz into 320-sample 16 kHz frames (20 ms = 960 input samples)', () => {
    const frames: Int16Array[] = [];
    const d = new Downsampler(48000, (f) => frames.push(f));
    d.push(new Float32Array(960 * 3).fill(0.5));
    expect(frames).toHaveLength(3);
    expect(frames[0]!.length).toBe(FRAME_SAMPLES);
    expect(Math.abs(frames[0]![10]! - 16383)).toBeLessThan(2);
  });

  it('handles fractional ratios (44.1 kHz) without drifting: 1 s in gives about 50 frames', () => {
    const frames: Int16Array[] = [];
    const d = new Downsampler(44100, (f) => frames.push(f));
    for (let i = 0; i < 44100 / 128; i++) d.push(new Float32Array(128));
    expect(frames.length).toBeGreaterThanOrEqual(49);
    expect(frames.length).toBeLessThanOrEqual(50);
  });

  it('averages to remove tones above the new Nyquist and clamps to int16', () => {
    const frames: Int16Array[] = [];
    const d = new Downsampler(48000, (f) => frames.push(f));
    const x = new Float32Array(960);
    for (let i = 0; i < x.length; i++) x[i] = i % 2 ? 1 : -1; // 24 kHz tone
    d.push(x);
    expect(Math.max(...frames[0]!.map(Math.abs))).toBeLessThan(12000);
    const loud = new Float32Array(960).fill(3);
    d.push(loud);
    expect(frames[1]![5]).toBe(32767);
  });
});
