import { parseIso, today } from '../clock.js';

/** Integer paise. Rupee conversion happens only in this file (and amount.ts for input). */
export type Paise = number;

export const rupees = (n: number): Paise => Math.round(n * 100);

const inrGroup = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function formatInr(p: Paise, opts: { paise?: boolean } = {}): string {
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  if (opts.paise) {
    const whole = Math.floor(abs / 100);
    const frac = String(abs % 100).padStart(2, '0');
    return `${sign}₹${inrGroup.format(whole)}.${frac}`;
  }
  return `${sign}₹${inrGroup.format(Math.round(abs / 100))}`;
}

// ---- number words (shared with amount.ts parsing) ----
export const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
] as const;
export const TENS: Record<number, string> = {
  20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety',
};

function below100(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = Math.floor(n / 10) * 10;
  return n % 10 ? `${TENS[t]}-${ONES[n % 10]}` : TENS[t]!;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) parts.push(below100(r));
  return parts.join(' ');
}

/** Indian-system words for a non-negative integer (crore / lakh / thousand / hundred). */
export function numberToWords(n: number): string {
  if (n === 0) return 'zero';
  const parts: string[] = [];
  let rest = n;
  const crore = Math.floor(rest / 10_000_000);
  rest %= 10_000_000;
  if (crore) parts.push(`${numberToWords(crore)} crore`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh) parts.push(`${below100(lakh)} lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand) parts.push(`${below100(thousand)} thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

/** Speech form; paise are rounded to the nearest rupee. */
export function speakInr(p: Paise): string {
  const r = Math.round(Math.abs(p) / 100);
  const sign = p < 0 && r > 0 ? 'minus ' : '';
  return `${sign}${numberToWords(r)} ${r === 1 ? 'rupee' : 'rupees'}`;
}

export function formatPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function speakPct(bps: number): string {
  return `${Number((bps / 100).toFixed(2))} percent`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

export function formatDate(iso: string): string {
  const { y, m, d } = parseIso(iso);
  return `${d} ${MONTHS[m - 1]!.slice(0, 3)} ${y}`;
}

/** "5th November"; the year is dropped when it equals the year of today(). */
export function speakDate(iso: string): string {
  const { y, m, d } = parseIso(iso);
  const base = `${ordinal(d)} ${MONTHS[m - 1]}`;
  return y === parseIso(today()).y ? base : `${base} ${y}`;
}
