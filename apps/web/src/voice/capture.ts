import workletUrl from './capture-worklet.js?url';

export interface Capture { stop(): void; readonly sampleRate: number }

/**
 * Opens the microphone and delivers 20 ms, 16 kHz, mono PCM16LE frames (640 bytes).
 * Echo cancellation, noise suppression and AGC are requested from the browser.
 */
export async function startCapture(onFrame: (pcm16: Uint8Array) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => onFrame(new Uint8Array(ev.data));
    src.connect(node);
    const c = ctx;
    let stopped = false;
    return {
      sampleRate: c.sampleRate,
      stop() {
        if (stopped) return;
        stopped = true;
        node.port.onmessage = null;
        try { src.disconnect(); node.disconnect(); } catch { /* already gone */ }
        node.port.close();
        for (const t of stream.getTracks()) t.stop();
        void c.close().catch(() => {});
      },
    };
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    void ctx?.close().catch(() => {});
    throw e;
  }
}

/** RMS level 0..1 of a PCM16LE frame, for the meter. */
export function frameLevel(pcm: Uint8Array): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = dv.getInt16(i * 2, true) / 32768; sum += v * v; }
  return Math.sqrt(sum / n);
}
