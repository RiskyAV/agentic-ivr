import { decodeAudioFrame, encodeAudioFrame, type ClientMsg, type ServerMsg } from '@app/shared';
import { socket, socketEvents } from '../socket';
import { useStore } from '../store';
import { frameLevel, startCapture, type Capture } from './capture';
import { PcmPlayer } from './player';

export interface VoiceDeps {
  startCapture(onFrame: (pcm: Uint8Array) => void): Promise<Capture>;
  createPlayer(): PcmPlayer;
  socket: { send(m: ClientMsg): boolean; sendBinary(d: Uint8Array): boolean };
  now(): number;
}

const defaultDeps = (): VoiceDeps => ({ startCapture, createPlayer: () => new PcmPlayer(24000), socket, now: () => performance.timeOrigin + performance.now() });

const DEBUG_CAP = 50;
const capped = <T,>(a: T[], v: T) => { a.push(v); if (a.length > DEBUG_CAP) a.shift(); };

const PTT_KEY = 'northstar.voice.ptt';

export function loadPtt(): boolean {
  try { return localStorage.getItem(PTT_KEY) === '1'; } catch { return false; }
}
export function savePtt(on: boolean): void {
  try { localStorage.setItem(PTT_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

export interface VoiceDebug {
  state: string; framesIn: number; framesOut: number; bytesIn: number; playing: boolean;
  reports: { turnSeq: number; playedMs: number }[]; marks: { turnId: string; mark: string; t: number }[];
  firstAudio: number[];
}

type LevelListener = (level: number) => void;

export class VoiceController {
  private capture: Capture | null = null;
  private player: PcmPlayer | null = null;
  private mode: 'open' | 'ptt' = 'open';
  private pttDown = false;
  private starting = false;
  private levelCb = new Set<LevelListener>();
  private lastLevelAt = 0;
  /** speech_end time waiting for the turn_start that carries its turnId. */
  private pendingSpeechEnd: number | null = null;
  private firstAudioSent = new Set<string>();
  private seqTurn = new Map<number, string>();
  private gen = 0;
  private serverStarted = false;
  readonly debug: VoiceDebug = { state: 'off', framesIn: 0, framesOut: 0, bytesIn: 0, playing: false, reports: [], marks: [], firstAudio: [] };

  constructor(private readonly deps: VoiceDeps = defaultDeps()) {}

  /** Wires the browser: socket events, Space key and the dev debug hook. Not used in unit tests. */
  attach(): void {
    socketEvents.onMessage((m) => this.onMessage(m));
    socketEvents.onBinary((b) => this.onBinary(b));
    socketEvents.onClose(() => this.teardown(false));
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.setPtt(false));
    // A hidden tab must not keep the microphone and two vendor sockets open.
    document.addEventListener('visibilitychange', () => this.onVisibility(document.visibilityState === 'hidden'));
    if (import.meta.env.DEV) (window as unknown as { __voice?: unknown }).__voice = this.debug;
  }

  /** Server message entry points (public for the socket hooks and tests). */
  handleMessage(m: ServerMsg): void { this.onMessage(m); }
  handleBinary(b: ArrayBuffer): void { this.onBinary(b); }

  get active(): boolean { return useStore.getState().voice.state !== 'off'; }
  onLevel(f: LevelListener): () => void { this.levelCb.add(f); return () => { this.levelCb.delete(f); }; }

  async start(ptt: boolean): Promise<void> {
    if (this.active || this.starting) return;
    this.starting = true;
    const g = ++this.gen;
    const st = useStore.getState();
    this.mode = ptt ? 'ptt' : 'open';
    st.setVoice({ state: 'connecting', caption: '', ptt });
    this.debug.state = 'connecting';
    try {
      // The player is created inside the click/keypress so the browser lets it play.
      this.player = this.deps.createPlayer();
      this.player.onFirstAudio((seq) => this.onFirstAudioPlayed(seq));
      this.player.onIdle((seq, ms) => this.onIdle(seq, ms));
      const capture = await this.deps.startCapture((pcm) => this.onMicFrame(pcm));
      if (g !== this.gen) { capture.stop(); return; } // cancelled while the microphone was opening
      this.capture = capture;
      if (useStore.getState().connection !== 'open' || !this.deps.socket.send({ type: 'voice_start', ...(ptt ? { mode: 'ptt' as const } : {}) })) {
        throw new Error('not_connected');
      }
      this.serverStarted = true;
      this.setState('listening');
    } catch (e) {
      if (g !== this.gen) return;
      this.teardown(false);
      useStore.getState().notify('voice_start_failed', micMessage(e));
    } finally {
      if (g === this.gen) this.starting = false;
    }
  }

  stop(): void { this.teardown(true); }

  /** Page visibility changed (public for tests): a hidden tab stops voice. */
  onVisibility(hidden: boolean): void {
    if (hidden && (this.active || this.starting)) this.stop();
  }

  /** Push-to-talk press/release (button or Space). Ignored unless a PTT session is running. */
  setPtt(down: boolean): void {
    if (this.mode !== 'ptt' || !this.capture || this.pttDown === down) return;
    if (down && useStore.getState().voice.state === 'connecting') return;
    this.pttDown = down;
    this.deps.socket.send({ type: 'ptt', down });
    if (down) this.setState('listening');
    else this.onLevelValue(0);
  }

  get pttHeld(): boolean { return this.pttDown; }

  private teardown(notifyServer: boolean): void {
    if (notifyServer && this.serverStarted) this.deps.socket.send({ type: 'voice_stop' });
    this.serverStarted = false;
    this.gen += 1; // invalidates a start() still waiting for the microphone
    this.starting = false;
    this.capture?.stop();
    this.capture = null;
    this.player?.close();
    this.player = null;
    this.pttDown = false;
    this.pendingSpeechEnd = null;
    this.firstAudioSent.clear();
    this.seqTurn.clear();
    this.onLevelValue(0);
    this.debug.state = 'off';
    this.debug.playing = false;
    const st = useStore.getState();
    if (st.voice.state !== 'off' || st.voice.caption) st.setVoice({ state: 'off', caption: '' });
  }

  private setState(state: 'listening' | 'thinking' | 'speaking'): void {
    if (!this.capture && !this.starting) return;
    this.debug.state = state;
    useStore.getState().setVoice({ state });
  }

  private onMicFrame(pcm: Uint8Array): void {
    this.onLevelValue(this.mode === 'ptt' && !this.pttDown ? 0 : frameLevel(pcm));
    if (this.mode === 'ptt' && !this.pttDown) return;
    if (useStore.getState().voice.state === 'connecting') return;
    if (this.deps.socket.sendBinary(encodeAudioFrame(0, pcm))) this.debug.framesOut++;
  }

  private onLevelValue(v: number): void {
    const now = performance.now();
    if (v !== 0 && now - this.lastLevelAt < 50) return;
    this.lastLevelAt = now;
    for (const f of this.levelCb) f(v);
  }

  private onBinary(buf: ArrayBuffer): void {
    if (!this.player) return;
    this.debug.framesIn++;
    this.debug.bytesIn += buf.byteLength;
    try {
      const { turnSeq, pcm } = decodeAudioFrame(new Uint8Array(buf));
      this.player.enqueue(turnSeq, pcm);
      this.debug.playing = this.player.playing;
    } catch { /* malformed frame */ }
  }

  private report(turnSeq: number, playedMs: number): void {
    capped(this.debug.reports, { turnSeq, playedMs });
    this.deps.socket.send({ type: 'playback_report', turnSeq, playedMs });
  }

  /** An utterance finished playing. Leave "speaking" only when nothing else (e.g. the answer behind a filler) is still scheduled. */
  private onIdle(turnSeq: number, playedMs: number): void {
    this.report(turnSeq, playedMs);
    this.debug.playing = this.player?.playing ?? false;
    if (this.player?.playing) return;
    if (useStore.getState().voice.state === 'speaking') this.setState(useStore.getState().activeTurn ? 'thinking' : 'listening');
  }

  private mark(turnId: string, mark: 'speech_end' | 'first_audio_played', t: number): void {
    capped(this.debug.marks, { turnId, mark, t });
    this.deps.socket.send({ type: 'client_mark', turnId, mark, t });
  }

  private onFirstAudioPlayed(seq: number): void {
    capped(this.debug.firstAudio, seq);
    this.setState('speaking'); // every utterance's first audible buffer, filler or answer
    const turnId = this.seqTurn.get(seq);
    if (!turnId || this.firstAudioSent.has(turnId)) return;
    this.firstAudioSent.add(turnId);
    this.mark(turnId, 'first_audio_played', this.deps.now());
  }

  private onMessage(m: ServerMsg): void {
    if (!this.capture && !this.starting) {
      return;
    }
    switch (m.type) {
      case 'transcript':
        if (m.final && m.text.trim()) { this.pendingSpeechEnd = this.deps.now(); this.setState('thinking'); }
        break;
      case 'turn_start':
        if (m.channel === 'voice') {
          if (this.pendingSpeechEnd !== null) { this.mark(m.turnId, 'speech_end', this.pendingSpeechEnd); this.pendingSpeechEnd = null; }
          this.setState('thinking');
        }
        break;
      case 'tts_begin':
        this.seqTurn.set(m.turnSeq, m.turnId);
        if (this.seqTurn.size > 32) this.seqTurn.delete(this.seqTurn.keys().next().value as number);
        this.player?.begin(m.turnSeq);
        break;
      case 'tts_end':
        this.player?.end(m.turnSeq);
        break;
      case 'barge_in':
      case 'audio_flush': {
        if (!this.player) break;
        for (const r of this.player.flushAll()) this.report(r.turnSeq, r.playedMs);
        this.debug.playing = false;
        this.setState('listening');
        break;
      }
      case 'trace':
        // The server holds the trace until the first audio; a turn that ends without any audio must not leave us "thinking".
        if (useStore.getState().voice.state === 'thinking' && !(this.player?.playing)) this.setState('listening');
        break;
      case 'voice_stopped':
        this.teardown(false); // the server already stopped its side
        break;
      case 'error':
        if (m.code === 'voice_capacity' || m.code === 'voice_vendor_error' || m.code === 'voice_unavailable') this.teardown(false);
        break;
      default:
        break;
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.code !== 'Space' || this.mode !== 'ptt' || !this.capture) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const onOtherButton = !!t && t.tagName === 'BUTTON' && t.dataset.voiceButton === undefined;
    if (typing || onOtherButton) return;
    e.preventDefault();
    if (e.repeat) return;
    this.setPtt(down);
  }
}

function micMessage(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow the microphone in your browser settings to use voice, or keep typing.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one to use voice, or keep typing.';
  if ((e as Error)?.message === 'not_connected') return 'Voice needs a live connection. Please wait a moment and try again.';
  return 'Could not start the microphone. You can keep using text.';
}

export const voice = new VoiceController();
if (typeof window !== 'undefined') voice.attach();
