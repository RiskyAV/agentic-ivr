import { randomUUID } from 'node:crypto';
import { encodeAudioFrame, type ProposalView, type ServerMsg, type SpanView, type TurnTrace } from '@app/shared';
import type { ActionService } from '../actions/actionService.js';
import type { ActionOutcome, Proposal } from '../actions/types.js';
import type { HistoryEntry, Session } from '../context/session.js';
import type { Engine, TurnSink, TurnStatus } from '../engine/engine.js';
import type { Metrics } from '../telemetry/metrics.js';
import { bargeInTrigger, isAffirmation, isEcho, isFillerOnly, isNegation, realWords, spellReference } from './affirm.js';
import type { SttFactory, SttStream } from './stt.js';
import { ClauseChunker, cleanForSpeech, speakableSummary, type Alignment, type TtsPool, type TtsStream } from './tts.js';

export interface VoiceConfig {
  /** Real (non-filler) words in a partial that interrupt the assistant (D-012). */
  bargeInMinWords: number;
  /** Speak the tool filler only if no audio has gone out this long after the commit. */
  fillerAfterMs: number;
  /** Push-to-talk: manual STT commits, audio forwarded only while the button is held. */
  ptt: boolean;
  /** A partial with one real word that has lasted this long also interrupts. */
  bargeInSustainMs?: number;
  /**
   * Energy VAD on the raw mic PCM: this much sustained voice while assistant audio is in flight interrupts without
   * waiting for a transcript (Scribe partials lag speech by 1.5-2 s). 0 disables. Default 500.
   */
  bargeInVadMs?: number;
  /** Absolute level (dBFS) a mic frame must exceed to count as voice. Default -40. */
  bargeInVadDb?: number;
  /** ...and it must also be this many dB above the adaptive noise floor. Default 15. */
  bargeInVadMarginDb?: number;
  /** After an energy barge-in, words must follow within this long, or it is logged as unconfirmed. Default 2500. */
  bargeInConfirmMs?: number;
  /** Push-to-talk: a silent frame this often while the button is up keeps the STT session alive. Default 5000. */
  sttKeepaliveMs?: number;
  /** Added to the estimated client playback end. */
  playbackMarginMs?: number;
  /** If no playback_report arrives after a barge-in, estimate what was heard after this long. */
  heardFallbackMs?: number;
  /** Max wait for the first TTS audio before the turn trace is sent without voice timings. */
  traceHoldMs?: number;
}

export interface VoiceDeps {
  sttFactory: SttFactory;
  ttsPool: TtsPool;
  engine: Pick<Engine, 'runTurn'>;
  actions: Pick<ActionService, 'pending'>;
  session: Session;
  /** JSON messages and binary audio frames to this client. */
  send: (m: ServerMsg | Uint8Array) => void;
  /** The gateway's confirm path (sends action_result + snapshot refresh) with via='voice'. */
  confirm: (proposalId: string, termsHash: string) => Promise<ActionOutcome>;
  /** The gateway's cancel path (sends action_result). */
  cancel: (proposalId: string) => Promise<ActionOutcome>;
  /** Per-session turn rate limit; false drops the utterance with an error. */
  allowTurn?: () => boolean;
  metrics?: Pick<Metrics, 'record'>;
  /** Event log for turns answered without the engine (voice confirm/cancel/re-read-back). Redacted by the log. */
  log?: (ev: { type: 'user_input'; text: string; turnId: string; channel: 'voice' }) => void;
  /** Voice input gave up for good: the owner should release this session's voice slot. */
  onDead?: () => void;
  cfg: VoiceConfig;
}

const PCM24_BYTES_PER_MS = 48;
const SPOKEN_TAIL_CHARS = 200;
const MAX_PENDING_AUDIO_BYTES = 32_000; // 1 s of 16 kHz PCM16 while the STT reconnects
const PCM16K_BYTES_PER_MS = 32;
/** Silence longer than this ends a run of voiced frames. */
const VAD_HANGOVER_MS = 150;

/** RMS level of 16-bit little-endian PCM in dBFS (-100 for digital silence). */
export function pcmDbfs(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return -100;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n) / 32768;
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}
export const CANCELLED_SPEECH = "Okay, I've cancelled that.";
export const GO_AHEAD_SPEECH = 'Sorry, go ahead.';
/** 20 ms of 16 kHz PCM16 silence. */
const SILENT_FRAME = Buffer.alloc(640);

/** Concatenated per-character alignment of an utterance, in ms from its first audio sample. */
export function heardText(chars: string[], startsMs: number[], playedMs: number): string {
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    if (startsMs[i]! > playedMs) break;
    out += chars[i];
  }
  return out.trim();
}

export function readBack(p: ProposalView): string {
  return `${speakableSummary(p.summary)} Shall I go ahead?`;
}

/** What to show and what to say after a voice confirmation. */
export function confirmOutcomeText(o: ActionOutcome): { display: string; speech: string } {
  if (o.status === 'executed' && o.reference) {
    return { display: `Done — your reference is ${o.reference}.`, speech: `Done — your reference is ${spellReference(o.reference)}.` };
  }
  if (o.status === 'executed') return { display: 'Done.', speech: 'Done.' };
  return { display: o.message, speech: o.message };
}

/** One assistant utterance: one TTS socket, one turnSeq for its audio frames. */
class Utterance {
  tts?: TtsStream;
  closed = false;
  bargedIn = false;
  ttsDone = false;
  ttsFailed = false;
  engineRunning = false;
  fillerSent = false;
  fillerTimer?: NodeJS.Timeout;
  traceTimer?: NodeJS.Timeout;
  heardTimer?: NodeJS.Timeout;
  firstTextAt?: number;
  firstAudioAt?: number;
  audioBytes = 0;
  playbackComplete = false;
  sentChars = 0;
  spokenTail = '';
  readonly chunker = new ClauseChunker();
  readonly chars: string[] = [];
  readonly starts: number[] = [];
  readonly spans: SpanView[] = [];
  readonly traceMetrics: Record<string, number> = {};
  heldTrace?: TurnTrace;
  traceSent = false;
  historyEntry?: Extract<HistoryEntry, { role: 'assistant' }>;
  heard?: string;
  /** Proposal read back by this utterance; consent is awaited only if it was the last thing said, uninterrupted. */
  readBacks = 0;
  readBackFor?: { proposalId: string; termsHash: string };
  readBackAt = 0;
  /** The read-back was generated in full; consent is armed when its playback ends. */
  readBackGenerated = false;
  armTimer?: NodeJS.Timeout;
  private queue: Array<{ kind: 'text'; text: string } | { kind: 'flush' } | { kind: 'end' }> = [];

  constructor(
    readonly turnSeq: number,
    readonly turnId: string,
    readonly startedAt: number,
    private readonly owner: VoiceSession,
  ) {}

  rel(t = performance.now()): number {
    return Math.round((t - this.startedAt) * 100) / 100;
  }

  span(name: string, startAt: number, endAt = startAt, attrs?: Record<string, string | number | boolean>) {
    this.spans.push({ name, startMs: Math.max(0, this.rel(startAt)), endMs: Math.max(0, this.rel(endAt)), ...(attrs && { attrs }) });
  }

  audioMs(): number {
    return this.audioBytes / PCM24_BYTES_PER_MS;
  }

  playbackEndsAt(margin: number): number {
    return (this.firstAudioAt ?? Infinity) + this.audioMs() + margin;
  }

  /** Assistant audio is in flight: from the first frame until the client's playback would finish. */
  speaking(now: number, margin: number): boolean {
    if (this.closed || this.firstAudioAt === undefined || this.playbackComplete) return false;
    return !this.ttsDone || now < this.playbackEndsAt(margin);
  }

  attach(tts: TtsStream) {
    if (this.closed) { tts.close(); return; }
    this.tts = tts;
    tts.onAudio((pcm, a) => this.owner.onTtsAudio(this, pcm, a));
    tts.onDone(() => this.owner.onTtsDone(this));
    tts.onError((e) => this.owner.onTtsFailed(this, e));
    for (const op of this.queue.splice(0)) this.apply(op);
  }

  private apply(op: { kind: 'text'; text: string } | { kind: 'flush' } | { kind: 'end' }) {
    if (!this.tts || this.closed || this.ttsFailed) return;
    if (op.kind === 'text') this.tts.send(op.text);
    else if (op.kind === 'flush') this.tts.flush();
    else this.tts.end();
  }

  private op(o: { kind: 'text'; text: string } | { kind: 'flush' } | { kind: 'end' }) {
    if (this.closed || this.ttsFailed) return;
    if (this.tts) this.apply(o);
    else this.queue.push(o);
  }

  say(text: string, flush = false) {
    const t = cleanForSpeech(text);
    if (!t || this.closed || this.ttsFailed) return;
    if (this.firstTextAt === undefined) this.firstTextAt = performance.now();
    this.sentChars += t.length;
    this.spokenTail = `${this.spokenTail} ${t}`.slice(-SPOKEN_TAIL_CHARS);
    this.op({ kind: 'text', text: `${t} ` });
    if (flush) this.op({ kind: 'flush' });
  }

  /** Speak whatever the chunker still holds. */
  drain(flush: boolean) {
    for (const c of this.chunker.end()) this.say(c);
    if (flush) this.op({ kind: 'flush' });
  }

  finishInput() {
    this.drain(true);
    this.op({ kind: 'end' });
  }

  closeHard() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.fillerTimer);
    this.queue = [];
    this.tts?.close();
  }
}

/**
 * Voice turn manager for one WebSocket connection (spec 5.7, D-003/D-012/D-014/D-048):
 * mic audio -> streaming STT; committed transcript -> voice confirm/cancel or an engine turn on channel 'voice';
 * engine deltas -> clause chunks -> streaming TTS -> binary frames tagged with the utterance's turnSeq.
 * Barge-in, fillers, the self-echo guard and voice timings live here; the engine is unchanged by voice.
 */
export class VoiceSession {
  private stt?: SttStream;
  private connecting?: Promise<void>;
  private sttReconnects = 0;
  private sttDead = false;
  private stopped = false;
  private pttDown = false;
  private pendingAudio: Buffer[] = [];
  private pendingBytes = 0;
  private cur?: Utterance;
  private readonly recent = new Map<number, Utterance>();
  /** Segment bookkeeping: first partial of the current STT segment, whether audio was in flight then. */
  private segmentStart?: number;
  private segmentDuringSpeech = false;
  private lastPartialAt?: number;
  private readonly marks = new Map<string, { speech_end?: number; first_audio_played?: number }>();
  private vadVoicedMs = 0;
  private vadGapMs = 0;
  private noiseDb = -60;
  private unconfirmedTimer?: NodeJS.Timeout;
  private keepalive?: NodeJS.Timeout;
  private pendingCommit = false;
  private gaveUp = false;
  /**
   * D-021 for voice: a spoken yes/no acts only on the proposal whose read-back the customer just heard in full.
   * Cleared by any barge-in, any other utterance, voice_stop, or the proposal being resolved elsewhere.
   */
  private awaiting: { proposalId: string; termsHash: string } | null = null;
  /** When `awaiting` was armed (end of read-back playback). Speech that began before this is not an answer to it. */
  private armedAt = 0;
  /** Start of the latest run of mic voice energy, and when that run was last voiced. */
  private voiceRunStartAt?: number;
  private voiceLastAt?: number;
  /** Proposals this session actually put in front of the customer (emitted via the engine's proposal sink). */
  private readonly surfaced = new Map<string, ProposalView>();

  constructor(private readonly d: VoiceDeps) {}

  private get margin() { return this.d.cfg.playbackMarginMs ?? 300; }
  private now() { return performance.now(); }
  private send(m: ServerMsg | Uint8Array) { if (!this.stopped || !(m instanceof Uint8Array)) this.d.send(m); }
  private metric(name: string, v: number) { this.d.metrics?.record(name, Math.round(v)); }

  async start(): Promise<void> {
    this.d.ttsPool.prewarm();
    await this.connectStt();
    if (this.d.cfg.ptt) {
      // Push-to-talk sends no audio between presses; vendors close idle sessions, so send a silent frame now and then.
      this.keepalive = setInterval(() => { if (!this.pttDown) this.stt?.send(SILENT_FRAME); }, this.d.cfg.sttKeepaliveMs ?? 5000);
      this.keepalive.unref?.();
    }
  }

  private connectStt(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const stt = await this.d.sttFactory({ ptt: this.d.cfg.ptt });
      if (this.stopped) { stt.close(); return; }
      this.stt = stt;
      stt.on('partial', (t) => { if (this.stt === stt) this.onPartial(t); });
      stt.on('committed', (t) => { if (this.stt === stt) this.onCommitted(t); });
      stt.on('error', (e) => { if (this.stt === stt) this.onSttError(e); });
      stt.on('close', () => { if (this.stt === stt) this.stt = undefined; });
      for (const b of this.pendingAudio.splice(0)) stt.send(b);
      this.pendingBytes = 0;
      if (this.pendingCommit) { this.pendingCommit = false; stt.commit(); }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private onSttError(e: Error) {
    console.warn('[voice] stt error', e.message);
    this.stt?.close();
    this.stt = undefined;
    if (this.stopped) return;
    if (this.sttReconnects < 1) {
      this.sttReconnects++;
      this.connectStt().catch(() => this.giveUpStt());
    } else this.giveUpStt();
  }

  private giveUpStt() {
    if (this.gaveUp || this.stopped) return;
    this.gaveUp = true;
    this.sttDead = true;
    this.send({ type: 'error', code: 'voice_vendor_error', message: 'Voice input is unavailable right now. You can keep typing.' });
    this.stop();
    this.d.onDead?.();
  }

  private ensureStt() {
    if (this.stt || this.connecting || this.sttDead || this.stopped) return;
    this.connectStt().catch(() => this.onSttError(new Error('stt reconnect failed')));
  }

  pushAudio(pcm: Buffer): void {
    if (this.stopped || this.sttDead) return;
    if (this.d.cfg.ptt && !this.pttDown) return;
    if (!this.d.cfg.ptt) this.detectVoice(pcm);
    if (this.stt) { this.stt.send(pcm); return; }
    // The vendor closed an idle session (or a reconnect is under way): buffer briefly and reconnect.
    this.pendingAudio.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes > MAX_PENDING_AUDIO_BYTES) this.pendingBytes -= this.pendingAudio.shift()!.length;
    this.ensureStt();
  }

  /**
   * Energy VAD: sustained voice over an adaptive noise floor, counted only while our audio is in flight.
   * The floor follows every frame (EMA, ~3 s up, ~0.3 s down), so steady fan or street noise is learnt and ignored.
   */
  private detectVoice(pcm: Buffer) {
    const needMs = this.d.cfg.bargeInVadMs ?? 500;
    if (needMs <= 0) return;
    const ms = pcm.length / PCM16K_BYTES_PER_MS;
    const db = pcmDbfs(pcm);
    const floor = this.noiseDb;
    this.noiseDb = floor + (db - floor) * Math.min(1, ms / (db > floor ? 3000 : 300));
    const now = this.now();
    const voiced = db > Math.max(this.d.cfg.bargeInVadDb ?? -40, floor + (this.d.cfg.bargeInVadMarginDb ?? 15));
    if (voiced) {
      if (this.voiceLastAt === undefined || now - this.voiceLastAt > VAD_HANGOVER_MS) this.voiceRunStartAt = now - ms;
      this.voiceLastAt = now;
    }
    const u = this.cur;
    if (!u || !u.speaking(now, this.margin)) {
      this.vadVoicedMs = 0;
      this.vadGapMs = 0;
      return;
    }
    if (voiced) {
      // A short dip inside speech (between syllables or words) counts as voiced, as in any VAD with hangover.
      this.vadVoicedMs += ms + (this.vadVoicedMs > 0 ? this.vadGapMs : 0);
      this.vadGapMs = 0;
    } else {
      this.vadGapMs += ms;
      if (this.vadGapMs > VAD_HANGOVER_MS) this.vadVoicedMs = 0;
      return;
    }
    if (this.vadVoicedMs < needMs) return;
    this.vadVoicedMs = 0;
    this.bargeIn(u, 'vad');
  }

  setPtt(down: boolean): void {
    if (this.stopped) return;
    const wasDown = this.pttDown;
    this.pttDown = down;
    if (down && !wasDown) {
      // Pressing the button while the assistant talks is an explicit interruption.
      const u = this.cur;
      if (u && !u.closed && (u.speaking(this.now(), this.margin) || u.engineRunning)) this.bargeIn(u, 'ptt');
      this.ensureStt();
    } else if (!down && wasDown) {
      if (this.stt) this.stt.commit();
      else {
        // Released while the STT session is (re)connecting: commit as soon as it is up.
        this.pendingCommit = true;
        this.ensureStt();
      }
    }
  }

  /** The proposal was confirmed, cancelled or expired elsewhere (e.g. the UI card). */
  proposalResolved(proposalId: string): void {
    if (this.awaiting?.proposalId === proposalId) this.clearAwaiting();
    this.surfaced.delete(proposalId);
  }

  /** Something else happened in the conversation (typed turn, opener, workflow switch): a spoken yes is no longer consent. */
  clearAwaiting(): void {
    this.awaiting = null;
    for (const u of this.recent.values()) {
      u.readBackFor = undefined;
      clearTimeout(u.armTimer);
    }
  }

  /** Playback of a fully generated, uninterrupted read-back has ended: now a spoken yes is an answer to it. */
  private armAwaiting(u: Utterance) {
    clearTimeout(u.armTimer);
    if (this.stopped || this.cur !== u || u.bargedIn || u.closed || !u.readBackGenerated || !u.readBackFor || this.awaiting) return;
    this.awaiting = u.readBackFor;
    this.armedAt = this.now();
  }

  onPlaybackReport(turnSeq: number, playedMs: number): void {
    const u = this.recent.get(turnSeq);
    if (!u || !Number.isFinite(playedMs)) return;
    if (u.bargedIn) { this.resolveHeard(u, playedMs); return; }
    if (u.ttsDone && playedMs >= u.audioMs() - 100) {
      u.playbackComplete = true;
      this.armAwaiting(u);
    }
  }

  onClientMark(turnId: string, mark: 'speech_end' | 'first_audio_played', t: number): void {
    if (!Number.isFinite(t)) return;
    const m = this.marks.get(turnId) ?? {};
    m[mark] = t;
    this.marks.set(turnId, m);
    if (m.speech_end !== undefined && m.first_audio_played !== undefined) {
      const e2e = m.first_audio_played - m.speech_end;
      if (e2e >= 0 && e2e < 60_000) this.metric('voice_e2e_ms', e2e);
      this.marks.delete(turnId);
    }
    while (this.marks.size > 20) this.marks.delete(this.marks.keys().next().value!);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearAwaiting();
    clearInterval(this.keepalive);
    clearTimeout(this.unconfirmedTimer);
    this.stt?.close();
    this.stt = undefined;
    const u = this.cur;
    if (u && !u.closed) {
      u.closeHard();
      this.send({ type: 'tts_end', turnSeq: u.turnSeq });
    }
    for (const r of this.recent.values()) {
      clearTimeout(r.fillerTimer);
      clearTimeout(r.heardTimer);
      if (r.traceTimer) { clearTimeout(r.traceTimer); this.releaseTrace(r); }
    }
    this.d.ttsPool.close();
  }

  // ------------------------------------------------------------------ transcripts

  private onPartial(text: string) {
    const t = text.trim();
    if (!t) return;
    const now = this.now();
    this.lastPartialAt = now;
    const u = this.cur;
    const speaking = !!u && u.speaking(now, this.margin);
    if (this.segmentStart === undefined) {
      this.segmentStart = now;
      this.segmentDuringSpeech = speaking;
    }
    if (speaking && !this.d.cfg.ptt && isEcho(t, u!.spokenTail)) return;
    this.send({ type: 'transcript', text: t, final: false });
    if (realWords(t) >= 1) this.confirmBargeIn();
    if (!speaking || this.d.cfg.ptt) return;
    const trigger = bargeInTrigger(t, this.d.cfg.bargeInMinWords);
    const sustained = realWords(t) >= 1 && now - this.segmentStart >= (this.d.cfg.bargeInSustainMs ?? 400);
    if (trigger || sustained) this.bargeIn(u!, trigger ?? 'sustained');
  }

  private onCommitted(text: string) {
    const now = this.now();
    const t = text.trim();
    const duringSpeech = this.segmentDuringSpeech;
    // When this utterance's speech began: the first partial or the onset of recent mic voice, whichever is earlier.
    const voiceStart = this.voiceLastAt !== undefined && now - this.voiceLastAt < 3000 ? this.voiceRunStartAt : undefined;
    const speechStart = Math.min(this.segmentStart ?? now, voiceStart ?? now);
    const commitMs = this.lastPartialAt !== undefined ? now - this.lastPartialAt : undefined;
    this.segmentStart = undefined;
    this.segmentDuringSpeech = false;
    this.lastPartialAt = undefined;
    if (!t) return;
    this.sttReconnects = 0;
    const u = this.cur;
    // Self-echo: the segment began while our audio was playing and mostly repeats what we said.
    if (u && !this.d.cfg.ptt && (duringSpeech || u.speaking(now, this.margin)) && isEcho(t, u.spokenTail)) return;
    this.send({ type: 'transcript', text: t, final: true });
    if (commitMs !== undefined) this.metric('voice_stt_commit_ms', commitMs);

    if (!isFillerOnly(t)) this.confirmBargeIn();

    const yes = isAffirmation(t);
    if (yes || isNegation(t)) {
      const pending = this.d.actions.pending(this.d.session.id);
      const aw = this.awaiting;
      // A yes counts only if the customer started saying it after the read-back finished playing.
      const heard = aw && speechStart >= this.armedAt && pending.find((p) => p.id === aw.proposalId && p.termsHash === aw.termsHash);
      if (heard) { void (yes ? this.voiceConfirm(t, heard, now) : this.voiceCancel(t, heard, now)); return; }
      // Not just read back in full (cut off, or something else was said since): read it again before acting on "yes".
      const shown = pending.filter((p) => this.surfaced.has(p.id));
      if (shown.length === 1) {
        if (!yes) { void this.voiceCancel(t, shown[0]!, now); return; }
        if (this.reReadBack(t, shown[0]!, now)) return;
      }
    }
    if (isFillerOnly(t)) return;
    if (this.d.allowTurn && !this.d.allowTurn()) {
      this.send({ type: 'error', code: 'rate_limited', message: 'You are sending messages too quickly. Please wait a moment.' });
      return;
    }
    this.startTurn(t, now, commitMs);
  }

  // ------------------------------------------------------------------ utterances

  private newUtterance(turnSeq: number, turnId: string, startedAt: number): Utterance {
    const u = new Utterance(turnSeq, turnId, startedAt, this);
    this.cur = u;
    this.clearAwaiting();
    this.recent.set(turnSeq, u);
    while (this.recent.size > 6) this.recent.delete(this.recent.keys().next().value!);
    this.send({ type: 'tts_begin', turnSeq, turnId });
    if (this.stopped) u.closeHard();
    else this.d.ttsPool.take().then((tts) => u.attach(tts), (e: Error) => this.onTtsFailed(u, e));
    return u;
  }

  /** New input while the previous utterance is still thinking or talking: that utterance is over. */
  private interruptCurrent(reason: string) {
    const u = this.cur;
    if (u && !u.closed && (u.engineRunning || !u.ttsDone || u.speaking(this.now(), this.margin))) this.bargeIn(u, reason);
  }

  private bargeIn(u: Utterance, trigger: string) {
    if (u.closed) return;
    const now = this.now();
    u.bargedIn = true;
    this.clearAwaiting();
    if (trigger === 'vad') {
      clearTimeout(this.unconfirmedTimer);
      this.unconfirmedTimer = setTimeout(() => this.unconfirmedBargeIn(), this.d.cfg.bargeInConfirmMs ?? 2500);
      this.unconfirmedTimer.unref?.();
    }
    u.span('barge_in', now, now, { trigger });
    const active = this.d.session.activeTurn;
    if (active && active.turnId === u.turnId) active.abort.abort();
    u.closeHard();
    this.send({ type: 'barge_in', turnId: u.turnId });
    this.metric('voice_barge_in_audio_ms', u.firstAudioAt !== undefined ? now - u.firstAudioAt : 0);
    // What was heard comes from the client's playback_report; estimate it if none arrives.
    const estimate = u.firstAudioAt !== undefined ? Math.min(now - u.firstAudioAt, u.audioMs()) : 0;
    u.heardTimer = setTimeout(() => this.resolveHeard(u, estimate), this.d.cfg.heardFallbackMs ?? 1500);
    u.heardTimer.unref?.();
    this.releaseTrace(u);
  }

  /** Words arrived after an energy barge-in: it was real speech. */
  private confirmBargeIn() {
    clearTimeout(this.unconfirmedTimer);
    this.unconfirmedTimer = undefined;
  }

  /** Energy cut us off but no words followed (noise, a cough, the call's audio): say so, rather than stay silent. */
  private unconfirmedBargeIn() {
    this.unconfirmedTimer = undefined;
    if (this.stopped) return;
    this.metric('voice_barge_in_unconfirmed', 1);
    const cur = this.cur;
    if (cur && !cur.closed) return; // something else is already being said
    const u = this.newUtterance(++this.d.session.turnSeq, `voice-prompt-${randomUUID()}`, this.now());
    u.say(GO_AHEAD_SPEECH, true);
    u.finishInput();
  }

  private resolveHeard(u: Utterance, playedMs: number) {
    if (u.heard !== undefined) return;
    clearTimeout(u.heardTimer);
    u.heard = heardText(u.chars, u.starts, playedMs);
    this.applyHeard(u);
  }

  private applyHeard(u: Utterance) {
    if (u.heard !== undefined && u.historyEntry) u.historyEntry.interruptedAt = u.heard;
  }

  onTtsAudio(u: Utterance, pcm: Buffer, a?: Alignment) {
    if (u.closed || this.stopped) return;
    const now = this.now();
    const offset = u.audioMs();
    // ElevenLabs reports alignment times cumulatively over the utterance (seen at runtime), not per chunk as
    // documented; accept both: a chunk whose first char starts near the audio already sent is already absolute.
    if (u.firstAudioAt === undefined) {
      u.firstAudioAt = now;
      const fromCommit = now - u.startedAt;
      this.metric('voice_turn_e2e_server_ms', fromCommit);
      this.metric('voice_first_audio_ms', fromCommit);
      u.traceMetrics.voice_turn_e2e_server_ms = Math.round(fromCommit);
      if (u.firstTextAt !== undefined) this.metric('voice_tts_first_audio_ms', now - u.firstTextAt);
      u.span('tts_first_audio', u.firstTextAt ?? now, now);
    }
    if (a) {
      const first = a.charStartTimesMs[0] ?? 0;
      const base = offset > 0 && first >= offset / 2 ? 0 : offset;
      for (let i = 0; i < a.chars.length; i++) {
        u.chars.push(a.chars[i]!);
        u.starts.push(base + (a.charStartTimesMs[i] ?? 0));
      }
    }
    u.audioBytes += pcm.length;
    this.send(encodeAudioFrame(u.turnSeq, pcm));
    if (u.heldTrace) this.releaseTrace(u);
  }

  onTtsDone(u: Utterance) {
    if (u.ttsDone) return;
    u.ttsDone = true;
    // The read-back was generated in full and was the last thing in this utterance: arm consent when its playback
    // ends (client playback_report, or the estimate), unless it is cut off first.
    if (!u.closed && !u.ttsFailed && !u.bargedIn && this.cur === u && u.readBacks === 1 && u.readBackFor && u.sentChars === u.readBackAt) {
      u.readBackGenerated = true;
      if (u.playbackComplete) this.armAwaiting(u);
      else {
        u.armTimer = setTimeout(() => this.armAwaiting(u), Math.max(0, u.playbackEndsAt(this.margin) - this.now()));
        u.armTimer.unref?.();
      }
    }
    if (!u.closed) this.send({ type: 'tts_end', turnSeq: u.turnSeq });
    if (u.heldTrace) this.releaseTrace(u);
  }

  onTtsFailed(u: Utterance, e: Error) {
    if (u.closed || u.ttsFailed || this.stopped) return;
    console.warn('[voice] tts failed', e.message);
    u.ttsFailed = true;
    u.tts?.close();
    this.send({ type: 'error', code: 'voice_vendor_error', message: 'Voice output failed for this answer; the text is still shown.' });
    this.onTtsDone(u);
  }

  private holdTrace(u: Utterance, t: TurnTrace) {
    u.heldTrace = t;
    // The trace arrives at turn end; wait (bounded) for the first audio so the voice timings are in it.
    if (u.firstAudioAt !== undefined || u.closed || u.ttsDone) { this.releaseTrace(u); return; }
    u.traceTimer = setTimeout(() => this.releaseTrace(u), this.d.cfg.traceHoldMs ?? 3000);
    u.traceTimer.unref?.();
  }

  private releaseTrace(u: Utterance) {
    const t = u.heldTrace;
    if (!t || u.traceSent) return;
    u.traceSent = true;
    clearTimeout(u.traceTimer);
    this.send({
      type: 'trace',
      trace: { ...t, spans: [...t.spans, ...u.spans].sort((a, b) => a.startMs - b.startMs), metrics: { ...t.metrics, ...u.traceMetrics } },
    });
  }

  private startTurn(text: string, commitAt: number, commitMs: number | undefined) {
    this.interruptCurrent('new_input');
    const turnId = randomUUID();
    const session = this.d.session;
    this.send({ type: 'turn_start', turnId, channel: 'voice', userText: text });
    let u!: Utterance;
    const sink: TurnSink = {
      delta: (t) => {
        this.send({ type: 'assistant_delta', turnId, text: t });
        const clauses = u.chunker.push(t);
        clauses.forEach((c) => u.say(c, u.sentChars === 0));
      },
      progress: (tool, label) => {
        this.send({ type: 'progress', turnId, tool, label });
        u.drain(true);
        this.scheduleFiller(u, label);
      },
      proposal: (v) => {
        this.send({ type: 'action_proposal', proposal: v });
        this.surfaced.set(v.id, v);
        u.drain(false);
        u.say(readBack(v), true);
        u.readBacks++;
        u.readBackFor = { proposalId: v.id, termsHash: v.termsHash };
        u.readBackAt = u.sentChars;
      },
      done: (v) => {
        this.send({ type: 'assistant_done', turnId, text: v.text, sources: v.sources, ...(v.tables && { tables: v.tables }) });
        u.engineRunning = false;
        u.finishInput();
      },
      retract: (replacement) => {
        this.send({ type: 'assistant_retract', turnId, replacement });
        // Stop the withdrawn audio and say the replacement instead.
        if (!u.closed) {
          u.closeHard();
          this.send({ type: 'barge_in', turnId });
        }
        const r = this.newUtterance(++session.turnSeq, turnId, this.now());
        r.say(replacement, true);
        r.finishInput();
      },
      trace: (t) => this.holdTrace(u, t),
    };
    const p = this.d.engine.runTurn(session, { turnId, text, channel: 'voice' }, sink);
    const seq = session.activeTurn?.turnId === turnId ? session.activeTurn.seq : ++session.turnSeq;
    u = this.newUtterance(seq, turnId, commitAt);
    u.engineRunning = true;
    u.span('stt_commit', commitAt, commitAt, { ms: Math.round(commitMs ?? 0) });
    if (commitMs !== undefined) u.traceMetrics.voice_stt_commit_ms = Math.round(commitMs);
    p.then(
      ({ status }: { status: TurnStatus }) => this.afterTurn(u, status),
      (e: unknown) => {
        console.warn('[voice] turn failed', e);
        this.afterTurn(u, 'aborted');
        this.send({ type: 'error', code: 'internal', message: 'Something went wrong on my side. Please try again.' });
      },
    );
  }

  private afterTurn(u: Utterance, status: TurnStatus) {
    u.engineRunning = false;
    const last = this.d.session.history.at(-1);
    if (last?.role === 'assistant') u.historyEntry = last;
    this.applyHeard(u);
    if (status === 'aborted' && !u.closed) {
      // Aborted by something other than our barge-in (e.g. a typed message): stop this audio too.
      u.closeHard();
      this.send({ type: 'barge_in', turnId: u.turnId });
    }
  }

  private scheduleFiller(u: Utterance, label: string) {
    if (u.fillerSent || u.fillerTimer || u.closed || u.sentChars > 0 || u.firstAudioAt !== undefined) return;
    const delay = Math.max(0, this.d.cfg.fillerAfterMs - (this.now() - u.startedAt));
    u.fillerTimer = setTimeout(() => {
      u.fillerTimer = undefined;
      if (u.closed || u.fillerSent || u.sentChars > 0 || u.firstAudioAt !== undefined) return;
      u.fillerSent = true;
      const now = this.now();
      u.span('filler', now, now, { text: label });
      this.metric('voice_filler', 1);
      u.say(label, true);
    }, delay);
    u.fillerTimer.unref?.();
  }

  // ------------------------------------------------------------------ voice confirm / cancel

  private localTurn(kind: string, text: string): string {
    const turnId = `voice-${kind}-${randomUUID()}`;
    this.send({ type: 'turn_start', turnId, channel: 'voice', userText: text });
    this.d.log?.({ type: 'user_input', text, turnId, channel: 'voice' });
    return turnId;
  }

  /** "Just to confirm: …" — a fully heard re-read makes the next yes count. False if the terms no longer match. */
  private reReadBack(text: string, p: Proposal, at: number): boolean {
    const view = this.surfaced.get(p.id);
    if (!view || view.termsHash !== p.termsHash) return false;
    this.interruptCurrent('reread');
    const turnId = this.localTurn('reread', text);
    const u = this.newUtterance(++this.d.session.turnSeq, turnId, at);
    this.finishLocal(u, text, `Just to confirm: ${view.summary} Shall I go ahead?`, `Just to confirm: ${readBack(view)}`);
    u.readBacks = 1;
    u.readBackFor = { proposalId: view.id, termsHash: view.termsHash };
    u.readBackAt = u.sentChars;
    return true;
  }

  private async voiceConfirm(text: string, p: Proposal, at: number) {
    this.interruptCurrent('confirm');
    const turnId = this.localTurn('confirm', text);
    const u = this.newUtterance(++this.d.session.turnSeq, turnId, at);
    let outcome: ActionOutcome;
    try {
      outcome = await this.d.confirm(p.id, p.termsHash);
    } catch (e) {
      console.warn('[voice] confirm failed', e);
      outcome = { status: 'failed', message: "Sorry, I couldn't complete that just now. Nothing was changed." };
    }
    if (outcome.status !== 'failed' || !outcome.reason) this.proposalResolved(p.id);
    const { display, speech } = confirmOutcomeText(outcome);
    this.finishLocal(u, text, display, speech);
  }

  private async voiceCancel(text: string, p: Proposal, at: number) {
    this.interruptCurrent('cancel');
    const turnId = this.localTurn('cancel', text);
    const u = this.newUtterance(++this.d.session.turnSeq, turnId, at);
    let outcome: ActionOutcome;
    try {
      outcome = await this.d.cancel(p.id);
    } catch {
      outcome = { status: 'failed', message: "Sorry, I couldn't cancel that just now." };
    }
    this.proposalResolved(p.id);
    const msg = outcome.status === 'cancelled' ? CANCELLED_SPEECH : outcome.message;
    this.finishLocal(u, text, msg, msg);
  }

  /** A turn answered without the engine: show it, say it, and keep it in the conversation history. */
  private finishLocal(u: Utterance, userText: string, display: string, speech: string) {
    this.send({ type: 'assistant_delta', turnId: u.turnId, text: display });
    this.send({ type: 'assistant_done', turnId: u.turnId, text: display, sources: [] });
    this.d.session.history.push({ role: 'user', text: userText, channel: 'voice' }, { role: 'assistant', text: display });
    u.say(speech, true);
    u.finishInput();
  }
}
