/**
 * Voice smoke test against the real vendors: in-process mock systems + server (real Gemini, real ElevenLabs STT/TTS),
 * driven over the WebSocket exactly like the browser: 16 kHz PCM mic frames up, transcripts/deltas/audio frames down.
 *
 *   npx tsx scripts/voice-smoke.ts
 *
 * Scenario 1: "What's my next EMI?" -> stage timings.
 * Scenario 2: the same question, then "Actually, check my last payment first." streamed while the first answer's
 * audio is arriving -> barge_in, and the second question is answered.
 *
 * Fixtures were made with: say -o q.aiff "<text>" && afconvert -f WAVE -d LEI16@16000 -c 1 q.aiff <name>.wav
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { today } from '@app/domain';
import { buildMockServer } from '@app/mock-systems';
import { encodeAudioFrame, type ServerMsg } from '@app/shared';
import { buildApp } from '../apps/server/src/app.js';
import { loadConfig, loadRootEnv } from '../apps/server/src/config.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FRAME_MS = 20;
const FRAME_BYTES = 16000 * 2 * (FRAME_MS / 1000);

/** PCM16 payload of a WAV file (walks the RIFF chunks; afconvert adds an FLLR chunk). */
function wavPcm(path: string): Buffer {
  const b = readFileSync(path);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const rate = b.readUInt32LE(off + 12);
      const ch = b.readUInt16LE(off + 10);
      if (rate !== 16000 || ch !== 1) throw new Error(`${path}: need 16 kHz mono, got ${rate} Hz x${ch}`);
    }
    if (id === 'data') return b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

loadRootEnv();
process.env.LLM_PROVIDER ??= 'gemini';
process.env.GEMINI_MODEL ??= 'gemini-3.5-flash-lite';
const mock = buildMockServer({ today: today() });
await mock.listen({ port: 0, host: '127.0.0.1' });
const mockPort = (mock.server.address() as { port: number }).port;
const { config } = loadConfig({
  ...process.env, MOCK_BASE_URL: `http://127.0.0.1:${mockPort}`, PORT: '0', DEMO_ACCESS_CODE: '',
  EVENT_LOG_DIR: mkdtempSync(join(tmpdir(), 'voice-smoke-')),
});
if (!config.voice.elevenLabsApiKey || !config.voice.voiceId) throw new Error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID missing in .env');
const app = await buildApp(config);
const port = await app.listen(0, '127.0.0.1');
console.log(`model=${config.model} tts=${config.voice.ttsModel} stt_silence=${config.voice.sttSilenceSecs}s`);

const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customerId: 'C1001', otp: '123456' }),
});
const { token } = (await login.json()) as { token: string };
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);

type Ev = { at: number; m: ServerMsg | { type: 'audio'; bytes: number } };
const evs: Ev[] = [];
const T0 = performance.now();
const now = () => performance.now();
const rel = (t: number) => `${Math.round(t - T0)}ms`;
ws.on('message', (data, isBinary) => {
  const at = now();
  if (isBinary) { evs.push({ at, m: { type: 'audio', bytes: (data as Buffer).length - 4 } }); return; }
  const m = JSON.parse(String(data)) as ServerMsg;
  evs.push({ at, m });
  if (m.type === 'transcript' && m.final) console.log(`  ${rel(at)} transcript(final): "${m.text}"`);
  else if (m.type === 'turn_start') console.log(`  ${rel(at)} turn_start ${m.turnId.slice(0, 8)} "${m.userText}"`);
  else if (m.type === 'barge_in') {
    console.log(`  ${rel(at)} BARGE_IN turn ${m.turnId.slice(0, 8)}`);
    // Like the browser: report how much of that turn's audio had been played when it stopped.
    const begin = [...evs].reverse().find((e) => e.m.type === 'tts_begin' && (e.m as { turnId: string }).turnId === m.turnId);
    const firstAudio = begin && evs.slice(evs.indexOf(begin)).find((e) => e.m.type === 'audio');
    if (begin && firstAudio) {
      ws.send(JSON.stringify({ type: 'playback_report', turnSeq: (begin.m as { turnSeq: number }).turnSeq, playedMs: Math.round(at - firstAudio.at) }));
    }
  }
  else if (m.type === 'assistant_done') console.log(`  ${rel(at)} assistant_done: ${m.text.replace(/\s+/g, ' ')}`);
  else if (m.type === 'progress') console.log(`  ${rel(at)} progress ${m.tool}: ${m.label}`);
  else if (m.type === 'error') console.log(`  ${rel(at)} ERROR ${m.code}: ${m.message}`);
});
await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });

async function waitFor(pred: (e: Ev) => boolean, from: number, ms = 20_000): Promise<Ev> {
  const end = now() + ms;
  for (;;) {
    const hit = evs.slice(from).find(pred);
    if (hit) return hit;
    if (now() > end) throw new Error('timeout');
    await sleep(10);
  }
}
const isType = (t: string) => (e: Ev) => e.m.type === t;
await waitFor(isType('session_ready'), 0);

// Mic pump: real-time 20 ms frames; silence unless an utterance is queued (like an open browser mic).
let queue: Buffer[] = [];
let lastSpeechFrameAt = 0;
const silence = Buffer.alloc(FRAME_BYTES);
const pump = setInterval(() => {
  const f = queue.shift();
  if (f) lastSpeechFrameAt = now();
  if (ws.readyState === WebSocket.OPEN) ws.send(encodeAudioFrame(0, f ?? silence));
}, FRAME_MS);
async function speak(path: string): Promise<number> {
  const pcm = wavPcm(path);
  const frames: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += FRAME_BYTES) frames.push(pcm.subarray(i, Math.min(pcm.length, i + FRAME_BYTES)));
  queue = frames;
  while (queue.length) await sleep(5);
  return lastSpeechFrameAt;
}

const tStart = now();
ws.send(JSON.stringify({ type: 'voice_start' }));
await sleep(1200);
const err0 = evs.find((e) => e.m.type === 'error');
if (err0) throw new Error(`voice_start failed: ${JSON.stringify(err0.m)}`);
console.log(`voice_start sent at ${rel(tStart)}`);

function report(label: string, speechEnd: number, from: number) {
  const after = evs.slice(from).filter((e) => e.at >= speechEnd);
  const first = (t: string) => after.find((e) => e.m.type === t);
  const final = after.find((e) => e.m.type === 'transcript' && (e.m as { final: boolean }).final);
  const start = first('turn_start');
  const delta = first('assistant_delta');
  const audio = first('audio');
  const ttsEnd = first('tts_end');
  const trace = first('trace')?.m as Extract<ServerMsg, { type: 'trace' }> | undefined;
  const audioMs = after.filter((e) => e.m.type === 'audio').reduce((n, e) => n + (e.m as { bytes: number }).bytes / 48, 0);
  const d = (e?: Ev) => (e ? `${Math.round(e.at - speechEnd)} ms` : 'n/a');
  console.log(`\n== ${label} (times from end of speech) ==`);
  console.log(`  stt committed transcript : ${d(final)}`);
  console.log(`  turn_start               : ${d(start)}`);
  console.log(`  llm first token          : ${trace?.trace.metrics.llm_first_token ?? 'n/a'} ms after turn start (engine)`);
  console.log(`  first assistant delta    : ${d(delta)}`);
  console.log(`  first TTS audio at client: ${d(audio)}  (server commit->first audio: ${trace?.trace.metrics.voice_turn_e2e_server_ms ?? 'n/a'} ms)`);
  console.log(`  tts_end (all audio sent) : ${d(ttsEnd)}  audio=${(audioMs / 1000).toFixed(1)} s`);
  console.log(`  turn_total (engine)      : ${trace?.trace.metrics.turn_total ?? 'n/a'} ms`);
  if (trace) console.log(`  spans: ${trace.trace.spans.map((s) => `${s.name}@${Math.round(s.startMs)}-${Math.round(s.endMs)}`).join(', ')}`);
}

// ---- Scenario 1
console.log('\n-- Scenario 1: "What\'s my next EMI?"');
let from = evs.length;
let speechEnd = await speak(here('./fixtures/next-emi.wav'));
await waitFor(isType('tts_end'), from, 30_000);
await waitFor(isType('trace'), from, 10_000).catch(() => undefined);
report('Scenario 1', speechEnd, from);
// Let the (virtual) playback of answer 1 finish before the next question, as a listening user would.
const s1Audio = evs.slice(from).filter((e) => e.m.type === 'audio');
const playEnd = s1Audio[0]!.at + s1Audio.reduce((n, e) => n + (e.m as { bytes: number }).bytes / 48, 0) + 500;
await sleep(Math.max(0, playEnd - now()));

// ---- Scenario 2: barge-in
console.log('\n-- Scenario 2: barge-in with "Actually, check my last payment first."');
from = evs.length;
speechEnd = await speak(here('./fixtures/next-emi.wav'));
const firstAudio = await waitFor(isType('audio'), from, 30_000);
console.log(`  ${rel(firstAudio.at)} first audio of answer 1 -> streaming the interruption now`);
const interruptStart = now();
const speech2End = await speak(here('./fixtures/last-payment.wav'));
const barge = await waitFor((e) => e.m.type === 'barge_in' && e.at >= interruptStart, from, 10_000).catch(() => undefined);
console.log(`  barge_in ${barge ? `fired ${Math.round(barge.at - interruptStart)} ms after the interruption began` : 'DID NOT FIRE'}`);
const from2 = evs.findIndex((e, i) => i >= from && e.m.type === 'turn_start' && /payment/i.test((e.m as { userText: string }).userText));
if (from2 < 0) await waitFor((e) => e.m.type === 'turn_start' && /payment/i.test((e.m as { userText: string }).userText), from, 15_000);
const idx = evs.findIndex((e, i) => i >= from && e.m.type === 'turn_start' && /payment/i.test((e.m as { userText: string }).userText));
await waitFor(isType('assistant_done'), idx, 30_000);
await waitFor(isType('tts_end'), idx, 30_000).catch(() => undefined);
await waitFor(isType('trace'), idx, 10_000).catch(() => undefined);
report('Scenario 2, second question', speech2End, from);
const heard = app.sessions.get([...evs].find((e) => e.m.type === 'session_ready')!.m.type === 'session_ready'
  ? (evs.find((e) => e.m.type === 'session_ready')!.m as { sessionId: string }).sessionId : '')?.history
  .filter((h) => h.role === 'assistant' && h.interruptedAt !== undefined)
  .map((h) => (h as { interruptedAt?: string }).interruptedAt);
console.log(`  interrupted answer, heard part: ${JSON.stringify(heard)}`);

console.log('\nserver voice metrics:', JSON.stringify(Object.fromEntries(Object.entries(app.ctx.metrics.snapshot()).filter(([k]) => k.startsWith('voice_') || k === 'llm_first_token' || k === 'turn_total'))));
clearInterval(pump);
ws.send(JSON.stringify({ type: 'voice_stop' }));
ws.close();
await app.close();
await mock.close();
process.exit(0);
