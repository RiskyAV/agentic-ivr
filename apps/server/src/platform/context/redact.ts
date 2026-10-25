const MASKED_KEYS = new Set(['pan', 'phone', 'email', 'bankAccount', 'accountNumber']);

export function maskValue(v: string): string {
  return `XXXXXX${v.slice(-4)}`;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PAN = /(?<![A-Za-z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Za-z0-9])/g;
const PHONE = /(?<![\d])(?:\+91[\s-]?|0)?[6-9]\d{9}(?!\d)/g;
const ACCOUNT = /(?<!\d)\d{9,18}(?!\d)/g;

/** Masks PII-looking substrings in free text (emails, PAN, Indian mobiles, account-like numbers). */
export function scrubText(s: string): string {
  return s
    .replace(EMAIL, (m) => maskValue(m.slice(0, m.indexOf('@'))))
    .replace(PAN, (m) => maskValue(m))
    .replace(PHONE, (m) => maskValue(m))
    .replace(ACCOUNT, (m) => maskValue(m));
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
  return typeof obj === 'string' ? (scrubText(obj) as T) : obj;
}
