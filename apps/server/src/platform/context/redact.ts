const MASKED_KEYS = new Set(['pan', 'phone', 'email', 'bankAccount', 'accountNumber']);

export function maskValue(v: string): string {
  return `XXXXXX${v.slice(-4)}`;
}

/** Deep-masks PII fields (keeping the last 4 chars). Returns a new value; the input is never mutated. */
export function redact<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map((x) => redact(x)) as T;
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = MASKED_KEYS.has(k) && typeof v === 'string' ? maskValue(v) : redact(v);
    }
    return out as T;
  }
  return obj;
}
