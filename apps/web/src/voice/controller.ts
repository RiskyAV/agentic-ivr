import { decodeAudioFrame, encodeAudioFrame, type ServerMsg } from '@app/shared';
import { socket, socketEvents } from '../socket';
import { useStore } from '../store';
import { frameLevel, startCapture, type Capture } from './capture';
import { PcmPlayer } from './player';

const PTT_KEY = 'northstar.voice.ptt';

export function loadPtt(): boolean {
  try { return localStorage.getItem(PTT_KEY) === '1'; } catch { return false; }
}
export function savePtt(on: boolean): void {
  try { localStorage.setItem(PTT_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

/** Epoch milliseconds from the high-resolution clock. */
const epochNow = () => performance.timeOrigin + performance.now();

export interface VoiceDebug {
  state: string; framesIn: number; framesOut: number; bytesIn: number; playing: boolean;
  reports: { turnSeq: number; playedMs: number }[]; marks: { turnId: string; mark: string; t: number }[];
  firstAudio: number[];
}

type LevelListener = (level: number) => void;

class VoiceController {
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
  readonly debug: VoiceDebug = { state: 'off', framesIn: 0, framesOut: 0, bytesIn: 0, playing: false, reports: [], marks: [], firstAudio: [] };

  constructor() {
    socketEvents.onMessage((m) => this.onMessage(m));
    socketEvents.onBinary((b) => this.onBinary(b));
    socketEvents.onClose(() => this.teardown(false));
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => this.onKey(e, true));
      window.addEventListener('keyup', (e) => this.onKey(e, false));
      window.addEventListener('blur', () => this.setPtt(false));
      if (import.meta.env.DEV) (window as unknown as { __voice?: unknown }).__voice = this.debug;
    }
  }

  get active(): boolean { return useStore.getState().voice.state !== 'off'; }
  onLevel(f: LevelListener): () => void { this.levelCb.add(f); return () => { this.levelCb.delete(f); }; }

  async start(ptt: boolean): Promise<void> {
    if (this.active || this.starting) return;
    this.starting = true;
    const st = useStore.getState();
    this.mode = ptt ? 'ptt' : 'open';
    st.setVoice({ state: 'connecting', caption: '', ptt });
    this.debug.state = 'connecting';
    try {
      // The player is created inside the click/keypress so the browser lets it play.
      this.player = new PcmPlayer(24000);
      this.player.onFirstAudio((seq) => this.onFirstAudioPlayed(seq));
      this.player.onIdle((seq, ms) => this.report(seq, ms));
      this.capture = await startCapture((pcm) => this.onMicFrame(pcm));
      if (useStore.getState().connection !== 'open' || !socket.send({ type: 'voice_start', ...(ptt ? { mode: 'ptt' as const } : {}) })) {
        throw new Error('not_connected');
      }
      this.setState('listening');
    } catch (e) {
      this.teardown(false);
      useStore.getState().notify('voice_start_failed', micMessage(e));
    } finally {
      this.starting = false;
    }
  }

  stop(): void { this.teardown(true); }

  /** Push-to-talk press/release (button or Space). Ignored unless a PTT session is running. */
  setPtt(down: boolean): void {
    if (this.mode !== 'ptt' || !this.capture || this.pttDown === down) return;
    if (down && useStore.getState().voice.state === 'connecting') return;
    this.pttDown = down;
    socket.send({ type: 'ptt', down });
    if (down) this.setState('listening');
    else this.onLevelValue(0);
  }

  get pttHeld(): boolean { return this.pttDown; }

  private teardown(notifyServer: boolean): void {
    const wasActive = this.active || this.capture !== null || this.player !== null;
    if (notifyServer && wasActive) socket.send({ type: 'voice_stop' });
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
    if (socket.sendBinary(encodeAudioFrame(0, pcm))) this.debug.framesOut++;
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
    this.debug.reports.push({ turnSeq, playedMs });
    socket.send({ type: 'playback_report', turnSeq, playedMs });
    this.debug.playing = this.player?.playing ?? false;
    // Everything said has been heard: back to listening (or thinking if an answer is still being prepared).
    if (useStore.getState().voice.state === 'speaking') this.setState(useStore.getState().activeTurn ? 'thinking' : 'listening');
  }

  private mark(turnId: string, mark: 'speech_end' | 'first_audio_played', t: number): void {
    this.debug.marks.push({ turnId, mark, t });
    socket.send({ type: 'client_mark', turnId, mark, t });
  }

  private onFirstAudioPlayed(seq: number): void {
    this.debug.firstAudio.push(seq);
    const turnId = this.seqTurn.get(seq);
    if (!turnId || this.firstAudioSent.has(turnId)) return;
    this.firstAudioSent.add(turnId);
    this.mark(turnId, 'first_audio_played', epochNow());
    this.setState('speaking');
  }

  private onMessage(m: ServerMsg): void {
    if (!this.capture && !this.starting) {
      return;
    }
    switch (m.type) {
      case 'transcript':
        if (m.final && m.text.trim()) { this.pendingSpeechEnd = epochNow(); this.setState('thinking'); }
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
      case 'barge_in': {
        if (!this.player) break;
        const { turnSeq, playedMs } = this.player.flush();
        this.report(turnSeq, playedMs);
        this.debug.playing = false;
        this.setState('listening');
        break;
      }
      case 'trace':
        // The server holds the trace until the first audio; a turn that ends without any audio must not leave us "thinking".
        if (useStore.getState().voice.state === 'thinking' && !(this.player?.playing)) this.setState('listening');
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
