import { describe, expect, it } from 'vitest';
import { decodeAudioFrame, encodeAudioFrame } from './protocol.js';

describe('audio frames', () => {
  it('round-trips turnSeq and pcm', () => {
    const frame = encodeAudioFrame(7, new Uint8Array([1, 2, 3, 4]));
    expect(frame.length).toBe(8);
    const out = decodeAudioFrame(frame);
    expect(out.turnSeq).toBe(7);
    expect(Array.from(out.pcm)).toEqual([1, 2, 3, 4]);
  });

  it('uses a 4-byte big-endian header', () => {
    const frame = encodeAudioFrame(0x01020304, new Uint8Array([9]));
    expect(Array.from(frame)).toEqual([1, 2, 3, 4, 9]);
  });

  it('throws RangeError for frames shorter than 4 bytes', () => {
    expect(() => decodeAudioFrame(new Uint8Array([1, 2, 3]))).toThrow(RangeError);
  });
});
