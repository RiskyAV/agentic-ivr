// AudioWorklet: averaging decimator from the context rate to 16 kHz, emitting 20 ms Int16 frames (320 samples).
export const TARGET_RATE = 16000;
export const FRAME_SAMPLES = 320;

export class Downsampler {
  constructor(inRate, onFrame) {
    this.step = TARGET_RATE / inRate; // output samples per input sample
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.n = 0;
    this.onFrame = onFrame;
  }

  push(input) {
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count += 1;
      this.phase += this.step;
      if (this.phase >= 1) {
        this.phase -= 1;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.frame[this.n++] = v < 0 ? v * 32768 : v * 32767;
        if (this.n === FRAME_SAMPLES) {
          const out = this.frame;
          this.frame = new Int16Array(FRAME_SAMPLES);
          this.n = 0;
          this.onFrame(out);
        }
      }
    }
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  // eslint-disable-next-line no-undef
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      // eslint-disable-next-line no-undef
      this.ds = new Downsampler(sampleRate, (f) => this.port.postMessage(f.buffer, [f.buffer]));
    }

    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) this.ds.push(ch);
      return true;
    }
  }
  // eslint-disable-next-line no-undef
  registerProcessor('capture-processor', CaptureProcessor);
}
