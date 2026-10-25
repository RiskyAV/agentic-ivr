import type { Channel } from '@app/shared';
import type { EntityMemory } from './entities.js';
import type { CustomerSnapshot } from './snapshot.js';

export type HistoryEntry =
  | { role: 'user'; text: string; channel: Channel }
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
  /** Deletes sessions idle for longer than `idleMs`; returns how many were removed. */
  sweep(idleMs: number): number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly m = new Map<string, Session>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  get(id: string) { return this.m.get(id); }
  put(s: Session) { this.m.set(s.id, s); }
  delete(id: string) { this.m.delete(id); }
  sweep(idleMs: number): number {
    const cutoff = this.now() - idleMs;
    let n = 0;
    for (const [id, s] of this.m) {
      if (s.lastSeenAt < cutoff) { this.m.delete(id); n++; }
    }
    return n;
  }
}
