import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  customerId: string;
  sessionId: string;
  /** Expiry as epoch milliseconds. */
  exp: number;
}

export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest();

/** `base64url(json).base64url(hmac-sha256)`. Stateless: the session itself lives in the SessionStore. */
export function signToken(p: TokenPayload, secret: string): string {
  const body = b64(JSON.stringify({ customerId: p.customerId, sessionId: p.sessionId, exp: p.exp }));
  return `${body}.${b64(mac(body, secret))}`;
}

/** Returns the payload, or null for anything malformed, tampered with or expired. */
export function verifyToken(token: string, secret: string, now: number = Date.now()): TokenPayload | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const given = Buffer.from(sig, 'base64url');
  const want = mac(body, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TokenPayload>;
    if (typeof p.customerId !== 'string' || typeof p.sessionId !== 'string' || typeof p.exp !== 'number') return null;
    if (p.exp <= now) return null;
    return { customerId: p.customerId, sessionId: p.sessionId, exp: p.exp };
  } catch {
    return null;
  }
}

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1]! : null;
}
