import { ONES, TENS, type Paise } from './inr.js';

export type ParseAmountResult = { ok: true; paise: Paise } | { ok: false; reason: string };

const fail = (reason: string): ParseAmountResult => ({ ok: false, reason });

const SUFFIX: Record<string, number> = {
  k: 1_000, l: 100_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000,
  cr: 10_000_000, crore: 10_000_000, crores: 10_000_000,
};
const SCALES: Record<string, number> = { thousand: 1_000, lakh: 100_000, crore: 10_000_000 };

// Reverse of the vocabulary speakInr emits.
const WORD_VALUE = new Map<string, number>();
ONES.forEach((w, i) => i > 0 && WORD_VALUE.set(w, i));
for (const [n, w] of Object.entries(TENS)) WORD_VALUE.set(w, Number(n));

/** Exact scaled-integer conversion of "int.frac" * mult rupees to paise (no float arithmetic). */
function fromDecimal(int: string, frac: string, mult: number): ParseAmountResult {
  const num = BigInt(int + frac) * BigInt(mult) * 100n;
  const den = 10n ** BigInt(frac.length);
  if (num % den !== 0n) return fail('amount has more than two decimal places');
  const paise = num / den;
  if (paise <= 0n) return fail('amount must be greater than zero');
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) return fail('amount too large');
  return { ok: true, paise: Number(paise) };
}

function fromNumber(n: number): ParseAmountResult {
  if (!Number.isFinite(n) || n <= 0) return fail('amount must be greater than zero');
  const s = String(n);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return fail('amount too large');
  return fromDecimal(m[1]!, m[2] ?? '', 1);
}

// Indian (1,23,456) or international (123,456 / 1,234,567) digit grouping only.
const INDIAN_GROUPING = /^\d{1,3}(?:,\d{2})*,\d{3}$/;
const INTL_GROUPING = /^\d{1,3}(?:,\d{3})+$/;

/** Parses number words ("one lakh fifty thousand") up to crore. Returns rupees or null. */
function wordsToRupees(text: string): number | null {
  const tokens = text.split(/[\s-]+/).filter((t) => t && t !== 'and');
  if (tokens.length === 0) return null;
  let total = 0;
  let lastScale = Infinity;
  let hundreds = 0;
  let low = 0; // value below 100 within the current group
  let lowKind: 'none' | 'tens' | 'ones' | 'teen' = 'none';
  let hundredUsed = false;
  const group = () => hundreds + low;
  const reset = () => { hundreds = 0; low = 0; lowKind = 'none'; hundredUsed = false; };

  for (const t of tokens) {
    const v = WORD_VALUE.get(t);
    if (v !== undefined) {
      if (v < 10) {
        if (lowKind === 'ones' || lowKind === 'teen') return null;
        low += v; lowKind = 'ones';
      } else if (v < 20) {
        if (lowKind !== 'none') return null;
        low = v; lowKind = 'teen';
      } else {
        if (lowKind !== 'none') return null;
        low = v; lowKind = 'tens';
      }
    } else if (t === 'hundred') {
      if (hundredUsed || hundreds !== 0 || low < 1 || low > 9 || lowKind !== 'ones') return null;
      hundreds = low * 100; low = 0; lowKind = 'none'; hundredUsed = true;
    } else if (t in SCALES) {
      const scale = SCALES[t]!;
      const g = group();
      if (g === 0 || scale >= lastScale) return null;
      total += g * scale;
      lastScale = scale;
      reset();
    } else {
      return null;
    }
  }
  const rest = group();
  if (rest === 0 && lastScale === Infinity) return null;
  return total + rest;
}

const NUMERIC = /^(\d[\d,]*|)(?:\.(\d+))?\s*([a-z]+)?$/;

/** Parses a loosely phrased amount. A number input means rupees. Never guesses. */
export function parseAmount(input: number | string): ParseAmountResult {
  if (typeof input === 'number') return fromNumber(input);
  if (typeof input !== 'string') return fail('unsupported input');

  const text = input
    .toLowerCase()
    .replace(/₹|\binr\b|\brs\b\.?|\brupees?\b|\bonly\b/g, ' ')
    .replace(/(?<=\d)\s*rs\.?$/, '')
    .replace(/^rs\.?(?=\d)/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fail('empty amount');
  if (text.startsWith('-')) return fail('amount cannot be negative');

  const m = NUMERIC.exec(text);
  if (m && (m[1] || m[2] !== undefined)) {
    const intPart = m[1] ?? '';
    if (intPart.includes(',') && !INDIAN_GROUPING.test(intPart) && !INTL_GROUPING.test(intPart)) {
      return fail('ambiguous digit grouping');
    }
    const mult = m[3] === undefined ? 1 : SUFFIX[m[3]];
    if (mult === undefined) return fail(`unrecognised unit "${m[3]}"`);
    return fromDecimal(intPart.replace(/,/g, '') || '0', m[2] ?? '', mult);
  }
  const words = wordsToRupees(text);
  if (words === null) return fail('could not understand the amount');
  return fromDecimal(String(words), '', 1);
}
