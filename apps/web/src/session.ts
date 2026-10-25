/** The signed-in identity survives a reload (sessionStorage), so a refresh resumes the same server session. */
export interface StoredSession { token: string; customerId: string; name: string }
const KEY = 'northstar.session';

export function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredSession>;
    return typeof v.token === 'string' && typeof v.customerId === 'string' ? { token: v.token, customerId: v.customerId, name: v.name ?? '' } : null;
  } catch {
    return null;
  }
}
export function saveSession(s: StoredSession | null): void {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode: the session simply won't survive a reload */ }
}
