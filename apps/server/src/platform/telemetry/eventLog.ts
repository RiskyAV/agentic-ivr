import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../context/redact.js';

export type LoggedEvent =
  | { type: 'user_input'; at: number; text: string; turnId?: string; channel?: string; workflowId?: string; customerId?: string }
  | { type: 'llm_request'; at: number; promptHash: string; prefixHash?: string; model?: string; round?: number; turnId?: string }
  | { type: 'llm_response'; at: number; chunks: unknown[]; usage?: unknown; round?: number; turnId?: string }
  | { type: 'backend_call'; at: number; system: string; method: string; path: string; status?: number; body?: unknown; outcome?: string; turnId?: string }
  | { type: 'guard'; at: number; verdict: string; category?: string; by?: string; ms?: number; turnId?: string }
  | { type: 'proposal'; at: number; proposalId: string; actionType: string; termsHash: string; turnId?: string }
  | { type: 'confirm'; at: number; proposalId: string; outcome: string; reference?: string; via?: 'ui' | 'voice'; turnId?: string }
  | { type: 'assistant_final'; at: number; text: string; sources?: unknown[]; unverified?: string[]; status?: string; turnId?: string }
  | { type: 'timing'; at: number; metrics: Record<string, number>; turnId?: string };

export interface EventLogOptions {
  /** Total size cap for the directory; the oldest session files are deleted past it (default 200 MB). */
  maxBytes?: number;
  /** Receives `event_log_errors` (one sample per failed append). */
  metrics?: { record(name: string, v: number): void };
  warn?: (msg: string) => void;
}

export const DEFAULT_EVENT_LOG_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Append-only JSONL per session. appendFileSync keeps writes ordered; the dir is created on demand.
 * `append` never throws (a logging failure must not break a turn or a confirm): failures are warned about once and
 * counted. The directory is kept under `maxBytes` by deleting the oldest session files (by modification time).
 */
export class EventLog {
  private readonly maxBytes: number;
  private total: number | undefined;
  private warned = false;

  constructor(private readonly dir: string, private readonly opts: EventLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES;
  }

  private file(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
    return join(this.dir, `${safe}.jsonl`);
  }

  append(sessionId: string, ev: LoggedEvent): void {
    try {
      const line = JSON.stringify(redact(ev)) + '\n';
      mkdirSync(this.dir, { recursive: true });
      this.total ??= this.files().reduce((n, f) => n + f.size, 0);
      appendFileSync(this.file(sessionId), line);
      this.total += Buffer.byteLength(line);
      if (this.total > this.maxBytes) this.prune(this.file(sessionId));
    } catch (err) {
      this.opts.metrics?.record('event_log_errors', 1);
      if (!this.warned) {
        this.warned = true;
        (this.opts.warn ?? ((m: string) => console.warn(m)))(`[event-log] append failed; events are being dropped: ${(err as Error).message}`);
      }
    }
  }

  private files(): { path: string; size: number; mtimeMs: number }[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const path = join(this.dir, f);
        const st = statSync(path);
        return { path, size: st.size, mtimeMs: st.mtimeMs };
      });
  }

  /** Deletes the oldest files (never the one just written) until the directory is at 80% of the cap. */
  private prune(current: string): void {
    const list = this.files().sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = list.reduce((n, f) => n + f.size, 0);
    for (const f of list) {
      if (total <= this.maxBytes * 0.8) break;
      if (f.path === current) continue;
      unlinkSync(f.path);
      total -= f.size;
    }
    this.total = total;
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
