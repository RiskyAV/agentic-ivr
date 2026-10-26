/** Pure decision logic for the site password gate (Cloudflare Pages Functions middleware). No runtime imports. */

export const REALM = 'Northstar demo';
export const COOKIE_NAME = 'demo_access';
export const COOKIE_MAX_AGE_S = 43_200;

export type GateDecision = { kind: 'allow' } | { kind: 'deny'; status: 401 | 503; body: string };

const enc = new TextEncoder();

/** Compares two strings in constant time by hashing both (fixed length) and XOR-folding the digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The password part of an `Authorization: Basic ...` header (any username), or null if absent or malformed. */
export function basicPassword(header: string | null | undefined): string | null {
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header ?? '');
  if (!m?.[1]) return null;
  try {
    const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const i = text.indexOf(':');
    return i < 0 ? null : text.slice(i + 1);
  } catch {
    return null;
  }
}

export async function decide(authorization: string | null | undefined, sitePassword: string | undefined): Promise<GateDecision> {
  if (!sitePassword) return { kind: 'deny', status: 503, body: 'site password not configured' };
  const given = basicPassword(authorization);
  // Always run the comparison so timing does not reveal whether a header was present.
  const ok = await safeEqual(given ?? '', sitePassword);
  if (given !== null && ok) return { kind: 'allow' };
  return { kind: 'deny', status: 401, body: 'Authentication required' };
}

/** Not HttpOnly on purpose: the SPA reads it to sign in to the cross-origin API. */
export function accessCookie(password: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(password)}; Path=/; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`;
}
