import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LoggedEvent =
  | { type: 'user_input'; at: number; text: string; turnId?: string; channel?: string }
  | { type: 'llm_request'; at: number; promptHash: string; turnId?: string }
  | { type: 'llm_response'; at: number; chunks: string[]; turnId?: string }
  | { type: 'backend_call'; at: number; system: string; method: string; path: string; status?: number; body?: unknown; turnId?: string }
  | { type: 'guard'; at: number; verdict: string; category?: string; turnId?: string }
  | { type: 'proposal'; at: number; proposalId: string; actionType: string; termsHash: string; turnId?: string }
  | { type: 'confirm'; at: number; proposalId: string; outcome: string; reference?: string; turnId?: string }
  | { type: 'assistant_final'; at: number; text: string; turnId?: string }
  | { type: 'timing'; at: number; metrics: Record<string, number>; turnId?: string };

/** Append-only JSONL per session. appendFileSync keeps writes ordered; the dir is created on demand. */
export class EventLog {
  constructor(private readonly dir: string) {}

  private file(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
    return join(this.dir, `${safe}.jsonl`);
  }

  append(sessionId: string, ev: LoggedEvent): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(sessionId), JSON.stringify(ev) + '\n');
  }

  read(sessionId: string): LoggedEvent[] {
    const f = this.file(sessionId);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LoggedEvent);
  }
}
