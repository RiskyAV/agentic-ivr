import type {
  ChatItemView, ProposalView, SnapshotView, Source, TableView, TurnTrace,
} from './views.js';

export type Channel = 'text' | 'voice';
export type SystemName = 'crm' | 'lms' | 'payments' | 'policy' | 'ops';

export type ClientMsg =
  | { type: 'user_text'; turnId: string; text: string }
  | { type: 'voice_start' }
  | { type: 'voice_stop' }
  | { type: 'ptt'; down: boolean }
  | { type: 'confirm_action'; proposalId: string; termsHash: string }
  | { type: 'cancel_action'; proposalId: string }
  | { type: 'set_workflow'; workflowId: string }
  | { type: 'playback_report'; turnSeq: number; playedMs: number }
  | { type: 'client_mark'; turnId: string; mark: 'speech_end' | 'first_audio_played'; t: number };

export type ServerMsg =
  | {
      type: 'session_ready';
      sessionId: string;
      workflowId: string;
      customer: { id: string; name: string };
      resumed: boolean;
      history: ChatItemView[];
    }
  | { type: 'snapshot'; snapshot: SnapshotView }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'turn_start'; turnId: string; channel: Channel; userText: string }
  | { type: 'assistant_delta'; turnId: string; text: string }
  | { type: 'assistant_done'; turnId: string; text: string; sources: Source[]; tables?: TableView[] }
  | { type: 'assistant_retract'; turnId: string; replacement: string }
  | { type: 'progress'; turnId: string; tool: string; label: string }
  | { type: 'action_proposal'; proposal: ProposalView }
  | {
      type: 'action_result';
      proposalId: string;
      status: 'executed' | 'rejected' | 'failed' | 'expired';
      reference?: string;
      message: string;
      /** Machine-readable cause, e.g. `execution_uncertain`, `hash_mismatch`. */
      reason?: string;
      /** True when the proposal is still pending server-side and confirming again is safe (no duplicate). */
      retryable?: boolean;
    }
  | { type: 'tts_begin'; turnSeq: number; turnId: string }
  | { type: 'tts_end'; turnSeq: number }
  | { type: 'barge_in'; turnId: string }
  | { type: 'trace'; trace: TurnTrace }
  | { type: 'error'; code: string; message: string };

const HEADER_BYTES = 4;

/** Binary audio frame: 4-byte big-endian uint32 turnSeq, then PCM16LE. Mic (upstream) frames use turnSeq 0. */
export function encodeAudioFrame(turnSeq: number, pcm: Uint8Array): Uint8Array {
  if (!Number.isInteger(turnSeq) || turnSeq < 0 || turnSeq > 0xffffffff) {
    throw new RangeError(`turnSeq out of uint32 range: ${turnSeq}`);
  }
  const out = new Uint8Array(HEADER_BYTES + pcm.length);
  new DataView(out.buffer).setUint32(0, turnSeq, false);
  out.set(pcm, HEADER_BYTES);
  return out;
}

export function decodeAudioFrame(buf: Uint8Array): { turnSeq: number; pcm: Uint8Array } {
  if (buf.length < HEADER_BYTES) {
    throw new RangeError(`audio frame too short: ${buf.length} bytes`);
  }
  const turnSeq = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
  return { turnSeq, pcm: buf.subarray(HEADER_BYTES) };
}
