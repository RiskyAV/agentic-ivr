import type { Channel } from '@app/shared';
import type { EntityMemory } from './entities.js';
import type { CustomerSnapshot } from './snapshot.js';

export type HistoryEntry =
  | { role: 'user'; text: string; channel: Channel }
  /**
   * `interruptedAt`: set when the customer cut the answer off; it holds the part they actually got — the streamed
   * text for a typed turn, or the words heard up to the barge-in for voice (from TTS alignment and playback position).
   */
  | { role: 'assistant'; text: string; interruptedAt?: string }
  | { role: 'tool'; name: string; summary: string };

export interface Session {
  id: string;
  customerId: string;
  workflowId: string;
  history: HistoryEntry[];
  entities: EntityMemory;
  snapshot?: CustomerSnapshot;
  activeTurn?: { turnId: string; seq: number; abort: AbortController };
  turnSeq: number;
  guardStrikes: number;
  pendingProposalIds: string[];
  lastSeenAt: number;
}

export interface SessionStore {
  get(id: string): Session | undefined;
  put(s: Session): void;
  delete(id: string): void;
  size(): number;
  /** Deletes sessions idle for longer than `idleMs`; returns how many were removed. */
  sweep(idleMs: number): number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly m = new Map<string, Session>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  get(id: string) { return this.m.get(id); }
  put(s: Session) { this.m.set(s.id, s); }
  delete(id: string) { this.m.delete(id); }
  size() { return this.m.size; }
  sweep(idleMs: number): number {
    const cutoff = this.now() - idleMs;
    let n = 0;
    for (const [id, s] of this.m) {
      if (s.lastSeenAt < cutoff) { this.m.delete(id); n++; }
    }
    return n;
  }
}
