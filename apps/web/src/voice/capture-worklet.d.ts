export const TARGET_RATE: number;
export const FRAME_SAMPLES: number;
export class Downsampler {
  constructor(inRate: number, onFrame: (frame: Int16Array) => void);
  push(input: Float32Array): void;
}
