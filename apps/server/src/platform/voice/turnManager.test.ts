import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeAudioFrame, type ServerMsg } from '@app/shared';
import { ActionService } from '../actions/actionService.js';
import { AuditLog } from '../actions/audit.js';
import { loadSnapshot } from '../context/snapshot.js';
import type { Session } from '../context/session.js';
import { Engine } from '../engine/engine.js';
import type { Guard, GuardVerdict } from '../guard/types.js';
import { Limiter } from '../llm/limiter.js';
import { StubLlm, type StubRule } from '../llm/stub.js';
import type { LlmChunk, LlmRequest } from '../llm/types.js';
import { EventLog } from '../telemetry/eventLog.js';
import { Metrics } from '../telemetry/metrics.js';
import { ToolRegistry } from '../tools/registry.js';
import { makeHarness, makeSession } from '../tools/testkit.js';
import { WorkflowRegistry } from '../workflows/registry.js';
import { loanServicing } from '../../workflows/loan-servicing/index.js';
import { loanServicingActions } from '../../workflows/loan-servicing/actions.js';
import { loanServicingTools } from '../../workflows/loan-servicing/tools.js';
import { FakeStt, FakeTts } from './fakes.js';
import { TtsPool } from './tts.js';
import { VoiceSession, type VoiceConfig } from './turnManager.js';

const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000, what = 'condition') {
  const end = performance.now() + ms;
  while (!pred()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
const text = (t: string): LlmChunk => ({ type: 'text', text: t });
const call = (name: string, args: unknown = {}): LlmChunk => ({ type: 'tool_calls', calls: [{ id: name, name, args }] });

const SENTENCES = [
  'Your next instalment is due on the fifth of next month. ',
  'It will be debited from your registered bank account automatically. ',
  'Please keep enough balance in the account, so the debit does not fail. ',
  'A failed debit can attract a bounce charge under our policy. ',
  'You can also pay early from the app if you prefer. ',
  'Is there anything else I can help you with today? ',
  'I am happy to explain your schedule as well. ',
  'Or we could look at prepayment options together. ',
];
const EMI_RULE: StubRule = { match: /next EMI/i, script: [SENTENCES.map(text)] };
const PREPAY_RULE: StubRule = {
  match: /prepay/i,
  script: [
    [call('propose_prepayment', { loanId: 'HL-88231', amount: '50k', mode: 'reduce_tenure' })],
    [text('I have set up a prepayment of {{proposal.prepay.amount}}. ')],
  ],
};

async function setup(opts: {
  rules: StubRule[];
  chunkDelayMs?: number;
  llm?: { stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk> };
  cfg?: Partial<VoiceConfig>;
  ttsAuto?: boolean;
  absoluteAlignment?: boolean;
  sttFactory?: () => Promise<FakeStt>;
  guard?: Guard;
}) {
  const h = makeHarness({});
  closers.push(h.close);
  const tools = new ToolRegistry();
  for (const t of loanServicingTools) tools.register(t);
  const audit = new AuditLog();
  const actions = new ActionService(loanServicingActions, audit);
  for (const a of loanServicingActions) tools.register(actions.proposeTool(a.type));
  const workflows = new WorkflowRegistry().register(loanServicing);
  const metrics = new Metrics();
  const engine = new Engine({
    llm: opts.llm ?? new StubLlm(opts.rules, { chunkDelayMs: opts.chunkDelayMs ?? 0 }),
    limiter: new Limiter(10, 1000), tools, actions, workflows, connectors: h.connectors,
    eventLog: new EventLog(mkdtempSync(join(tmpdir(), 'voice-'))), metrics, audit,
    ...(opts.guard && { guard: opts.guard }),
    config: { turnBudgetMs: 9000, maxToolRounds: 4, toolTimeoutMs: 4000 },
  });
  const session: Session = makeSession('C1001');
  session.snapshot = await loadSnapshot(h.connectors, session.customerId, { signal: new AbortController().signal });
  const stts: FakeStt[] = [];
  const stt = new FakeStt();
  stts.push(stt);
  const ttsList: FakeTts[] = [];
  const pool = new TtsPool(async () => { const t = new FakeTts(opts.ttsAuto ?? true, 10, opts.absoluteAlignment); ttsList.push(t); return t; });
  const out: Array<ServerMsg | Uint8Array> = [];
  const confirm = vi.fn((id: string, hash: string) => actions.confirm(session, id, hash, 'voice', h.ctxFor(session.customerId, 'voice', session)));
  const cancel = vi.fn((id: string) => actions.cancel(session, id));
  const logged: Array<Record<string, unknown>> = [];
  let dead = 0;
  const vs = new VoiceSession({
    sttFactory: opts.sttFactory ?? (async () => stt),
    ttsPool: pool, engine, actions, session, metrics, confirm, cancel,
    send: (m) => out.push(m),
    log: (ev) => logged.push(ev),
    onDead: () => { dead++; },
    cfg: { bargeInMinWords: 2, fillerAfterMs: 700, ptt: false, bargeInVadMs: 0, ...opts.cfg },
  });
  await vs.start();
  closers.push(() => vs.stop());
  const msgs = <K extends ServerMsg['type']>(k: K) =>
    out.filter((m): m is Extract<ServerMsg, { type: K }> => !(m instanceof Uint8Array) && m.type === k);
  const frames = () => out.filter((m): m is Uint8Array => m instanceof Uint8Array).map((b) => decodeAudioFrame(b));
  const audioMs = (seq: number) => frames().filter((f) => f.turnSeq === seq).reduce((n, f) => n + f.pcm.length / 48, 0);
  const tts_ends = (seq: number) => msgs('tts_end').filter((m) => m.turnSeq === seq).length;
  return { h, engine, session, actions, metrics, stt, stts, ttsList, pool, out, msgs, frames, audioMs, vs, confirm, cancel, logged, dead: () => dead, tts_ends };
}

describe('VoiceSession', () => {
  it('(a) streams clause chunks to TTS before the LLM finishes; frames carry the turn seq', async () => {
    let lastChunkAt = 0;
    const stub = new StubLlm([EMI_RULE], { chunkDelayMs: 40 });
    const llm = {
      async *stream(req: LlmRequest, signal: AbortSignal) {
        for await (const c of stub.stream(req, signal)) {
          if (c.type === 'text') lastChunkAt = performance.now();
          yield c;
        }
      },
    };
    const s = await setup({ rules: [], llm });
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('assistant_done').length === 1 && s.ttsList[0]!.ended, 5000, 'done');
    const tts = s.ttsList[0]!;
    const firstSend = tts.ops.find((o) => o.kind === 'text')!;
    expect(firstSend.t).toBeLessThan(lastChunkAt);
    expect(tts.texts[0]).toBe(SENTENCES[0]!.trim() + ' ');
    expect(s.msgs('transcript').at(-1)).toMatchObject({ text: "what's my next EMI", final: true });
    const start = s.msgs('turn_start')[0]!;
    expect(start).toMatchObject({ channel: 'voice', userText: "what's my next EMI" });
    const begin = s.msgs('tts_begin')[0]!;
    expect(begin.turnId).toBe(start.turnId);
    expect(begin.turnSeq).toBe(s.session.turnSeq);
    await waitFor(() => s.msgs('tts_end').length === 1, 2000, 'tts_end');
    expect(s.frames().length).toBeGreaterThan(0);
    expect(new Set(s.frames().map((f) => f.turnSeq))).toEqual(new Set([begin.turnSeq]));
    // Captions mirror the engine deltas.
    expect(s.msgs('assistant_delta').map((d) => d.text).join('')).toBe(SENTENCES.join(''));
    // Voice spans and metrics are merged into the engine trace.
    await waitFor(() => s.msgs('trace').length === 1, 4000, 'trace');
    const trace = s.msgs('trace')[0]!.trace;
    expect(trace.spans.map((x) => x.name)).toEqual(expect.arrayContaining(['stt_commit', 'tts_first_audio']));
    expect(trace.metrics.voice_turn_e2e_server_ms).toBeGreaterThanOrEqual(0);
    expect(s.metrics.snapshot().voice_first_audio_ms?.n).toBe(1);
  });

  it('a classifier block mid-answer cuts the TTS at once and speaks the refusal; not labelled as a barge-in', async () => {
    const guard: Guard = {
      check: (_t, _c, signal) => new Promise<GuardVerdict>((resolve, reject) => {
        const t = setTimeout(() => resolve({ verdict: 'block', category: 'abuse', by: 'model', ms: 250 }), 250);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      }),
    };
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 80, guard });
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('assistant_retract').length === 1, 3000, 'retract');
    const turnId = s.msgs('turn_start')[0]!.turnId;
    expect(s.ttsList[0]!.closed).toBe(true);
    expect(s.msgs('audio_flush')).toEqual([{ type: 'audio_flush', turnId, reason: 'retract' }]);
    expect(s.msgs('barge_in')).toHaveLength(0);
    await waitFor(() => s.msgs('assistant_done').length === 1, 3000, 'done');
    // The stream stopped early: far fewer than all 8 sentences reached the caption.
    expect(s.msgs('assistant_delta').length).toBeLessThan(SENTENCES.length);
    expect(s.msgs('assistant_done')[0]!.text).toBe(s.msgs('assistant_retract')[0]!.replacement);
  });

  it('(b) barge-in aborts the turn, stops frames, and records what was heard', async () => {
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 60 });
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('tts_begin').length === 1);
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    const turnId = s.msgs('tts_begin')[0]!.turnId;
    await waitFor(() => s.audioMs(seq) >= 700, 3000, 'audio');
    expect(s.session.activeTurn?.turnId).toBe(turnId);
    s.stt.emit('partial', 'actually check my');
    expect(s.msgs('barge_in')).toEqual([{ type: 'barge_in', turnId }]);
    const n = s.frames().length;
    const tts = s.ttsList[0]!;
    expect(tts.closed).toBe(true);
    await waitFor(() => s.session.activeTurn === undefined, 2000, 'turn end');
    await sleep(150);
    expect(s.frames().length).toBe(n);
    expect(s.msgs('assistant_done')).toHaveLength(0);
    s.vs.onPlaybackReport(seq, 600);
    const sent = tts.texts.join('');
    await waitFor(() => s.session.history.at(-1)?.role === 'assistant');
    const last = s.session.history.at(-1) as { interruptedAt?: string };
    expect(last.interruptedAt).toBe(sent.slice(0, 61).trim());
    // The next utterance becomes the next turn.
    s.stt.emit('committed', 'actually check my last payment');
    await waitFor(() => s.msgs('turn_start').length === 2);
    expect(s.msgs('turn_start')[1]!.userText).toBe('actually check my last payment');
    await waitFor(() => s.msgs('trace').length >= 1, 4000, 'trace');
    expect(s.msgs('trace')[0]!.trace.spans.map((x) => x.name)).toContain('barge_in');
  });

  it('heard text also works when the vendor reports alignment cumulatively across chunks', async () => {
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 60, absoluteAlignment: true });
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('tts_begin').length === 1);
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    await waitFor(() => s.audioMs(seq) >= 1000, 3000, 'audio');
    s.stt.emit('partial', 'stop');
    s.vs.onPlaybackReport(seq, 900);
    await waitFor(() => s.session.activeTurn === undefined && s.session.history.at(-1)?.role === 'assistant', 2000);
    const sent = s.ttsList[0]!.texts.join('');
    expect((s.session.history.at(-1) as { interruptedAt?: string }).interruptedAt).toBe(sent.slice(0, 91).trim());
  });

  const tone = (ms: number, amp: number) => {
    const b = Buffer.alloc(ms * 32);
    for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
    return b;
  };
  const feeder = (vs: VoiceSession) => (ms: number, amp: number) => { for (let t = 0; t < ms; t += 20) vs.pushAudio(tone(20, amp)); };

  it('sustained voice energy (500 ms) during audio barges in before any transcript; short bursts and quiet noise do not', async () => {
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 60, cfg: { bargeInVadMs: 500 } });
    const feed = feeder(s.vs);
    feed(600, 8000); // loud speech before the assistant talks: not a barge-in, and not carried over
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('tts_begin').length === 1);
    await waitFor(() => s.audioMs(s.msgs('tts_begin')[0]!.turnSeq) > 0);
    feed(20, 8000);
    expect(s.msgs('barge_in')).toHaveLength(0);
    feed(1000, 60); // background noise
    feed(300, 8000); // a cough
    feed(200, 60);
    expect(s.msgs('barge_in')).toHaveLength(0);
    feed(400, 8000);
    expect(s.msgs('barge_in')).toHaveLength(0);
    feed(100, 8000);
    expect(s.msgs('barge_in')).toHaveLength(1);
    await waitFor(() => s.msgs('trace').length === 1, 4000);
    expect(s.msgs('trace')[0]!.trace.spans.find((x) => x.name === 'barge_in')?.attrs).toMatchObject({ trigger: 'vad' });
  });

  it('steady noise above the old fixed threshold is learnt as the floor and never triggers', async () => {
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 60, cfg: { bargeInVadMs: 500 } });
    const feed = feeder(s.vs);
    feed(6000, 600); // about -35 dBFS fan/street noise, above the -40 dBFS absolute threshold
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('tts_begin').length === 1);
    await waitFor(() => s.audioMs(s.msgs('tts_begin')[0]!.turnSeq) > 0);
    feed(1000, 600);
    expect(s.msgs('barge_in')).toHaveLength(0);
    feed(520, 8000); // real speech over the noise
    expect(s.msgs('barge_in')).toHaveLength(1);
  });

  it('an energy barge-in with no words after it records barge_in_unconfirmed and invites the customer to go on', async () => {
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 60, cfg: { bargeInVadMs: 500, bargeInConfirmMs: 200 } });
    const feed = feeder(s.vs);
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('tts_begin').length === 1);
    await waitFor(() => s.audioMs(s.msgs('tts_begin')[0]!.turnSeq) > 0);
    feed(520, 8000);
    expect(s.msgs('barge_in')).toHaveLength(1);
    await waitFor(() => s.ttsList.some((t) => t.texts.join('').includes('Sorry, go ahead.')), 2000, 'prompt');
    expect(s.metrics.snapshot().voice_barge_in_unconfirmed?.n).toBe(1);

    // Confirmed by words: no prompt.
    const s2 = await setup({ rules: [EMI_RULE], chunkDelayMs: 60, cfg: { bargeInVadMs: 500, bargeInConfirmMs: 200 } });
    s2.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s2.msgs('tts_begin').length === 1);
    await waitFor(() => s2.audioMs(s2.msgs('tts_begin')[0]!.turnSeq) > 0);
    feeder(s2.vs)(520, 8000);
    s2.stt.emit('partial', 'check my');
    await sleep(350);
    expect(s2.metrics.snapshot().voice_barge_in_unconfirmed).toBeUndefined();
    expect(s2.ttsList.some((t) => t.texts.join('').includes('Sorry, go ahead.'))).toBe(false);
  });

  it('(c) a lone filler never barges in; "stop" does', async () => {
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 60 });
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('tts_begin').length === 1);
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    await waitFor(() => s.audioMs(seq) > 0);
    s.stt.emit('partial', 'um');
    s.stt.emit('partial', 'hmm');
    expect(s.msgs('barge_in')).toHaveLength(0);
    expect(s.session.activeTurn).toBeDefined();
    s.stt.emit('partial', 'stop');
    expect(s.msgs('barge_in')).toHaveLength(1);
  });

  it('a partial that echoes the assistant is ignored, and no barge-in happens without audio', async () => {
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 60 });
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('tts_begin').length === 1);
    // Before any audio: not speaking, so no barge-in from a partial.
    s.stt.emit('partial', 'check my payments');
    expect(s.msgs('barge_in')).toHaveLength(0);
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    await waitFor(() => s.audioMs(seq) > 0);
    s.stt.emit('partial', 'next instalment is due on the fifth');
    expect(s.msgs('barge_in')).toHaveLength(0);
    s.stt.emit('committed', 'next instalment is due on the fifth');
    expect(s.msgs('turn_start')).toHaveLength(1);
  });

  it('(d) a slow tool gets the filler spoken before any answer text', async () => {
    const s = await setup({
      rules: [{ match: /EMI go up/i, script: [[call('explain_emi_change')], [text('Your EMI went up because of a rate reset. ')]] }],
    });
    await s.h.app.inject({ method: 'PUT', url: '/admin/chaos', payload: { lms: { extraLatencyMs: 1500 } } });
    s.stt.emit('committed', 'why did my EMI go up');
    await waitFor(() => s.msgs('assistant_done').length === 1, 8000, 'done');
    const texts = s.ttsList[0]!.texts;
    expect(texts[0]).toContain('Let me look into that EMI change');
    expect(texts.findIndex((t) => t.includes('rate reset'))).toBeGreaterThan(0);
    expect(texts.filter((t) => t.includes('Let me look'))).toHaveLength(1);
    await waitFor(() => s.msgs('trace').length === 1, 4000, 'trace');
    expect(s.msgs('trace')[0]!.trace.spans.map((x) => x.name)).toContain('filler');
  }, 15000);

  it('a fast tool gets no filler', async () => {
    const s = await setup({
      rules: [{ match: /EMI go up/i, script: [[call('explain_emi_change')], [text('Your EMI went up because of a rate reset. ')]] }],
    });
    s.stt.emit('committed', 'why did my EMI go up');
    await waitFor(() => s.msgs('assistant_done').length === 1, 4000, 'done');
    await sleep(800);
    expect(s.ttsList[0]!.texts.some((t) => t.includes('Let me look'))).toBe(false);
  });

  /** Proposal turn; resolves once its read-back utterance has been fully spoken (TTS final arrived). */
  async function proposed(s: Awaited<ReturnType<typeof setup>>, opts: { played?: boolean } = {}) {
    s.stt.emit('committed', 'I want to prepay fifty thousand');
    await waitFor(() => s.msgs('action_proposal').length === 1 && s.msgs('assistant_done').length === 1, 4000, 'proposal');
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    await waitFor(() => s.tts_ends(seq) === 1, 2000, 'read-back generated');
    if (opts.played !== false) s.vs.onPlaybackReport(seq, s.audioMs(seq)); // the client finished playing it
    return s.msgs('action_proposal')[0]!.proposal;
  }

  it('(e) barge-in during a read-back keeps it pending; "yes" then re-reads; "yes" after the re-read confirms once; "yes but" goes to the engine', async () => {
    const s = await setup({ rules: [PREPAY_RULE] });
    s.stt.emit('committed', 'I want to prepay fifty thousand');
    await waitFor(() => s.msgs('action_proposal').length === 1, 4000, 'proposal');
    const prop = s.msgs('action_proposal')[0]!.proposal;
    const tts = s.ttsList[0]!;
    await waitFor(() => tts.texts.some((t) => t.includes('Shall I go ahead?')), 2000, 'read-back');
    const readBack = tts.texts.find((t) => t.includes('Shall I go ahead?'))!;
    expect(readBack).not.toContain('₹');
    expect(readBack).toContain('fifty thousand');
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    await waitFor(() => s.audioMs(seq) > 0);
    s.stt.emit('partial', 'wait a second');
    expect(s.msgs('barge_in')).toHaveLength(1);
    await sleep(50);
    expect(s.actions.pending(s.session.id).map((p) => p.id)).toEqual([prop.id]);

    s.stt.emit('committed', 'yes but make it 30k');
    await waitFor(() => s.msgs('turn_start').length === 2);
    expect(s.msgs('turn_start')[1]!.userText).toBe('yes but make it 30k');
    await waitFor(() => s.msgs('assistant_done').length === 2, 4000, 'second done');
    expect(s.confirm).not.toHaveBeenCalled();

    // The read-back was cut off, so "yes" is not consent yet: read it back again.
    s.stt.emit('committed', 'Yes.');
    await waitFor(() => s.msgs('turn_start').length === 3 && s.msgs('assistant_done').length === 3, 2000, 're-read');
    expect(s.confirm).not.toHaveBeenCalled();
    const reread = s.msgs('tts_begin').at(-1)!;
    await waitFor(() => s.ttsList.some((t) => t.texts.join('').startsWith('Just to confirm')), 2000);
    const rereadTts = s.ttsList.find((t) => t.texts.join('').startsWith('Just to confirm'))!;
    expect(rereadTts.texts.join('')).toMatch(/^Just to confirm: Prepay fifty thousand rupees.*Shall I go ahead\? $/);
    expect(s.msgs('assistant_done')[2]!.text).toMatch(/^Just to confirm: Prepay ₹50,000/);
    await waitFor(() => s.tts_ends(reread.turnSeq) === 1, 2000, 're-read spoken');
    s.vs.onPlaybackReport(reread.turnSeq, s.audioMs(reread.turnSeq));
    expect(s.logged.filter((e) => e.type === 'user_input').map((e) => e.text)).toEqual(['Yes.']);

    s.stt.emit('committed', 'yes');
    await waitFor(() => s.confirm.mock.calls.length === 1 && s.msgs('assistant_done').length === 4, 4000, 'confirm');
    expect(s.confirm).toHaveBeenCalledWith(prop.id, prop.termsHash);
    expect(s.actions.get(s.session, prop.id)?.status).toBe('executed');
    expect(s.msgs('assistant_done')[3]!.text).toMatch(/^Done — your reference is SR-\d+\.$/);
    await waitFor(() => s.ttsList.some((t) => /your reference is SR( \d){6}\./.test(t.texts.join(''))), 2000);
    expect(s.logged.filter((e) => e.type === 'user_input')).toHaveLength(2);
    s.stt.emit('committed', 'yes');
    await sleep(100);
    expect(s.confirm).toHaveBeenCalledTimes(1);
  });

  it('a fully heard read-back makes the next "yes" a confirmation', async () => {
    const s = await setup({ rules: [PREPAY_RULE] });
    const prop = await proposed(s);
    s.stt.emit('committed', 'Yes, go ahead.');
    await waitFor(() => s.confirm.mock.calls.length === 1, 3000);
    expect(s.confirm).toHaveBeenCalledWith(prop.id, prop.termsHash);
  });

  it('a "yes" after the read-back is generated but before its playback ends is not consent; after the end it is', async () => {
    const s = await setup({ rules: [PREPAY_RULE], cfg: { playbackMarginMs: 100 } });
    const prop = await proposed(s, { played: false });
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('assistant_done').length === 2, 2000);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.msgs('assistant_done')[1]!.text).toContain('Just to confirm');
    // No playback_report this time: the estimated playback end (audio length + margin) arms it.
    const reread = s.msgs('tts_begin').at(-1)!;
    await waitFor(() => s.tts_ends(reread.turnSeq) === 1, 2000);
    await sleep(s.audioMs(reread.turnSeq) + 200);
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.confirm.mock.calls.length === 1, 3000);
    expect(s.confirm).toHaveBeenCalledWith(prop.id, prop.termsHash);
  }, 15000);

  it('a "yes" whose speech began before the read-back finished playing is re-read, even if committed after', async () => {
    const s = await setup({ rules: [PREPAY_RULE] });
    await proposed(s, { played: false });
    s.stt.emit('partial', 'yes'); // spoken over the end of "Shall I go ahead?"
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    s.vs.onPlaybackReport(seq, s.audioMs(seq));
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('assistant_done').length === 2, 2000);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.msgs('assistant_done')[1]!.text).toContain('Just to confirm');
  });

  it('the re-read uses the spoken terms: if the pending terms no longer match, "yes" is a normal turn', async () => {
    const s = await setup({ rules: [PREPAY_RULE] });
    await proposed(s, { played: false });
    (s.actions.pending(s.session.id)[0] as { termsHash: string }).termsHash = 'changed';
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('turn_start').length === 2, 2000);
    await waitFor(() => s.msgs('assistant_done').length === 2, 4000);
    expect(s.msgs('assistant_done')[1]!.text).not.toContain('Just to confirm');
    expect(s.confirm).not.toHaveBeenCalled();
  });

  it('a read-back that produced no audio never arms consent', async () => {
    const s = await setup({ rules: [PREPAY_RULE], ttsAuto: false });
    s.stt.emit('committed', 'I want to prepay fifty thousand');
    await waitFor(() => s.msgs('action_proposal').length === 1 && s.msgs('assistant_done').length === 1, 4000);
    const tts = s.ttsList[0]!;
    await waitFor(() => tts.ended, 2000);
    tts.finishSilently(); // TTS final with zero audio frames
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    await waitFor(() => s.tts_ends(seq) === 1, 2000);
    await sleep(50);
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('assistant_done').length === 2, 2000);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.msgs('assistant_done')[1]!.text).toContain('Just to confirm');
  });

  it('with BARGE_IN_VAD_MS=0, mic voice that began before consent was armed still makes "yes" a re-read', async () => {
    const s = await setup({ rules: [PREPAY_RULE], cfg: { bargeInVadMs: 0 } });
    await proposed(s, { played: false });
    feeder(s.vs)(300, 8000); // "yes" spoken over the end of the read-back
    const seq = s.msgs('tts_begin')[0]!.turnSeq;
    s.vs.onPlaybackReport(seq, s.audioMs(seq)); // consent armed now
    s.stt.emit('partial', 'yes'); // transcripts arrive later
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('assistant_done').length === 2, 2000);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.msgs('assistant_done')[1]!.text).toContain('Just to confirm');
  });

  it('a typed turn after a fully heard read-back clears the awaited consent', async () => {
    const s = await setup({ rules: [PREPAY_RULE, EMI_RULE] });
    await proposed(s);
    s.vs.clearAwaiting(); // the gateway does this when a user_text turn starts
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('assistant_done').length === 2, 2000);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.msgs('assistant_done')[1]!.text).toContain('Just to confirm');
  });

  it('"yes" while a proposal is held but not yet surfaced never confirms or executes it', async () => {
    const s = await setup({
      rules: [{
        match: /prepay/i,
        script: [
          [call('propose_prepayment', { loanId: 'HL-88231', amount: '50k', mode: 'reduce_tenure' })],
          SENTENCES.map(text),
        ],
      }],
      chunkDelayMs: 60,
    });
    s.stt.emit('committed', 'I want to prepay fifty thousand');
    await waitFor(() => s.actions.pending(s.session.id).length === 1, 4000, 'held');
    expect(s.msgs('action_proposal')).toHaveLength(0);
    const held = s.actions.pending(s.session.id)[0]!;
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('turn_start').length === 2, 2000);
    expect(s.msgs('turn_start')[1]!.userText).toBe('yes');
    await waitFor(() => s.msgs('assistant_done').length >= 1, 4000);
    await sleep(100);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.actions.get(s.session, held.id)?.status).not.toBe('executed');
  });

  it('"yes" after an unrelated assistant answer re-reads the proposal instead of confirming', async () => {
    const s = await setup({ rules: [PREPAY_RULE, EMI_RULE] });
    const prop = await proposed(s);
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('assistant_done').length === 2, 4000);
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('assistant_done').length === 3, 2000);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.msgs('assistant_done')[2]!.text).toContain('Just to confirm');
    expect(s.actions.pending(s.session.id).map((p) => p.id)).toEqual([prop.id]);
  });

  it('a proposal confirmed in the UI is no longer awaiting a spoken yes', async () => {
    const s = await setup({ rules: [PREPAY_RULE] });
    const prop = await proposed(s);
    await s.actions.cancel(s.session, prop.id);
    s.vs.proposalResolved(prop.id);
    s.stt.emit('committed', 'yes');
    await waitFor(() => s.msgs('turn_start').length === 2, 2000);
    expect(s.msgs('turn_start')[1]!.userText).toBe('yes');
    expect(s.confirm).not.toHaveBeenCalled();
  });

  it('a plain "no" with one pending proposal cancels it', async () => {
    const s = await setup({ rules: [PREPAY_RULE] });
    s.stt.emit('committed', 'I want to prepay fifty thousand');
    await waitFor(() => s.msgs('action_proposal').length === 1 && s.msgs('assistant_done').length === 1, 4000);
    s.stt.emit('committed', 'No.');
    await waitFor(() => s.cancel.mock.calls.length === 1 && s.msgs('assistant_done').length === 2, 2000);
    expect(s.actions.pending(s.session.id)).toHaveLength(0);
    await waitFor(() => s.ttsList.some((t) => t.texts.join('').includes("Okay, I've cancelled that.")), 2000);
  });

  it('push-to-talk: release commits; press during audio barges in; audio is only forwarded while held', async () => {
    const s = await setup({ rules: [EMI_RULE], chunkDelayMs: 60, cfg: { ptt: true } });
    s.vs.pushAudio(Buffer.alloc(640));
    expect(s.stt.audio).toHaveLength(0);
    s.vs.setPtt(true);
    s.vs.pushAudio(Buffer.alloc(640));
    s.vs.setPtt(false);
    expect(s.stt.audio).toHaveLength(1);
    expect(s.stt.commits).toBe(1);
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.msgs('tts_begin').length === 1);
    await waitFor(() => s.audioMs(s.msgs('tts_begin')[0]!.turnSeq) > 0);
    s.vs.setPtt(true);
    expect(s.msgs('barge_in')).toHaveLength(1);
  });

  it('STT failure reconnects once, then reports voice_vendor_error', async () => {
    const stts: FakeStt[] = [];
    const s = await setup({ rules: [EMI_RULE], sttFactory: async () => { const x = new FakeStt(); stts.push(x); return x; } });
    stts[0]!.emit('error', new Error('boom'));
    await waitFor(() => stts.length === 2);
    expect(s.msgs('error')).toHaveLength(0);
    stts[1]!.emit('error', new Error('boom again'));
    await waitFor(() => s.msgs('error').length === 1);
    expect(s.msgs('error')[0]!.code).toBe('voice_vendor_error');
  });

  it('after giving up on STT the slot is released once, and the pool opens nothing more', async () => {
    const stts: FakeStt[] = [];
    const s = await setup({ rules: [EMI_RULE], sttFactory: async () => { const x = new FakeStt(); stts.push(x); return x; } });
    stts[0]!.emit('error', new Error('a'));
    await waitFor(() => stts.length === 2);
    stts[1]!.emit('error', new Error('b'));
    await waitFor(() => s.dead() === 1);
    const n = s.ttsList.length;
    await expect(s.pool.take()).rejects.toThrow(/closed/);
    expect(s.ttsList.length).toBe(n);
    expect(s.msgs('error')).toHaveLength(1);
  });

  it('an idle vendor close is not an error: PTT reconnects on press, replays the pending commit, and never gives up', async () => {
    const stts: FakeStt[] = [];
    let gate: (() => void) | undefined;
    const s = await setup({
      rules: [EMI_RULE], cfg: { ptt: true },
      sttFactory: async () => {
        if (stts.length > 0) await new Promise<void>((r) => { gate = r; });
        const x = new FakeStt({ ptt: true }); stts.push(x); return x;
      },
    });
    for (let i = 0; i < 3; i++) {
      stts.at(-1)!.emit('close');
      s.vs.setPtt(true);
      s.vs.pushAudio(Buffer.alloc(640));
      s.vs.setPtt(false); // released before the reconnect finished
      await waitFor(() => gate !== undefined);
      const g = gate!; gate = undefined; g();
      await waitFor(() => stts.length === i + 2);
      expect(stts.at(-1)!.audio).toHaveLength(1);
      expect(stts.at(-1)!.commits).toBe(1);
    }
    expect(s.msgs('error')).toHaveLength(0);
    expect(s.dead()).toBe(0);
  });

  it('PTT mode keeps the STT socket alive with silent frames while the button is up', async () => {
    const s = await setup({ rules: [EMI_RULE], cfg: { ptt: true, sttKeepaliveMs: 30 } });
    await sleep(120);
    expect(s.stt.audio.length).toBeGreaterThanOrEqual(2);
    expect(s.stt.audio.every((b) => b.every((x) => x === 0))).toBe(true);
    expect(s.stt.commits).toBe(0);
    s.vs.setPtt(true);
    const n = s.stt.audio.length;
    await sleep(100);
    expect(s.stt.audio.length).toBe(n);
  });

  it('a TTS failure still streams the text answer', async () => {
    const s = await setup({ rules: [EMI_RULE], ttsAuto: false });
    s.stt.emit('committed', "what's my next EMI");
    await waitFor(() => s.ttsList[0]!.texts.length > 0);
    s.ttsList[0]!.fail();
    await waitFor(() => s.msgs('assistant_done').length === 1, 3000);
    expect(s.msgs('error').map((e) => e.code)).toEqual(['voice_vendor_error']);
    expect(s.msgs('tts_end')).toHaveLength(1);
  });
});
