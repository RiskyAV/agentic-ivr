import { redact } from '../context/redact.js';

export type AuditEventType = 'proposed' | 'confirmed' | 'executed' | 'rejected' | 'failed' | 'cancelled' | 'expired' | 'guard_escalation';

export interface AuditEntry {
  at: number;
  sessionId: string;
  customerId: string;
  event: AuditEventType;
  proposalId: string;
  detail: Record<string, unknown>;
}

/** In-memory ring buffer of action events. Detail is PII-redacted on the way in. */
export class AuditLog {
  private readonly buf: AuditEntry[] = [];
  constructor(private readonly max = 1000) {}

  append(e: AuditEntry): void {
    this.buf.push({ ...e, detail: redact(e.detail) });
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  }

  /** Newest first. */
  list(limit = 100): AuditEntry[] {
    return this.buf.slice(-Math.max(0, limit)).reverse();
  }
}
