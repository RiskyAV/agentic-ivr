/** Business clock. All "today" logic goes through here; never use `new Date()` for business dates. */
export function today(): string {
  return process.env.DEMO_TODAY ?? '2026-10-25';
}

export function parseIso(iso: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Invalid ISO date: ${iso}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function toIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Adds n calendar months, clamping the day to the end of the target month. */
export function addMonths(iso: string, n: number): string {
  const { y, m, d } = parseIso(iso);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12 + 12) % 12 + 1;
  return toIso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Whole months from `fromIso` to `toIso` (a partial month does not count). */
export function monthsBetween(fromIso: string, toIso_: string): number {
  const a = parseIso(fromIso);
  const b = parseIso(toIso_);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (months > 0 && b.d < Math.min(a.d, daysInMonth(b.y, b.m))) months -= 1;
  if (months < 0 && b.d > a.d) months += 1;
  return months;
}

export function daysBetween(fromIso: string, toIso_: string): number {
  const a = parseIso(fromIso);
  const b = parseIso(toIso_);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}
