import type { Channel } from '@app/shared';
import type { Segment } from './renderer.js';
import type { BoundValue } from './values.js';

/**
 * Second line of defence (D-015): digit-based figures the LLM wrote itself must equal some tool value.
 * Only LLM-authored (unbound) segments are inspected. Spoken-word numbers ("five thousand") are out of scope.
 * `channel` is accepted for symmetry; digit extraction is identical for text and voice.
 */
export function numericCheck(
  segments: Segment[],
  allowed: BoundValue[],
  _channel: Channel,
): { ok: boolean; unverified: string[] } {
  const money = new Set<number>();
  const pcts = new Set<number>();
  const plain = new Set<number>();
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const v of allowed) {
    if (v.kind === 'money') {
      for (const n of [v.paise / 100, Math.round(v.paise / 100)]) { money.add(r2(n)); plain.add(r2(n)); }
    } else if (v.kind === 'pct') { pcts.add(r2(v.bps / 100)); plain.add(r2(v.bps / 100)); }
    else if (v.kind === 'months' || v.kind === 'count') plain.add(v.n);
  }
  const unverified: string[] = [];
  for (const s of segments) {
    if (s.bound) continue;
    for (const f of extract(s.text)) {
      const set = f.type === 'money' ? money : f.type === 'pct' ? pcts : plain;
      if (!set.has(r2(f.value))) unverified.push(f.raw);
    }
  }
  return { ok: unverified.length === 0, unverified };
}

interface Found { type: 'money' | 'pct' | 'plain'; value: number; raw: string }

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const MONEY = new RegExp(String.raw`(?:₹|\bRs\.?|\bINR)\s*(${NUM})|(${NUM})\s*(?:rupees?\b|₹)`, 'gi');
const PCT = new RegExp(String.raw`(${NUM})\s*(?:%|percent\b)`, 'gi');
const PLAIN = new RegExp(NUM, 'g');
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';

const toNum = (s: string) => Number(s.replace(/,/g, ''));

function extract(text: string): Found[] {
  const out: Found[] = [];
  const used: [number, number][] = [];
  const take = (re: RegExp, type: Found['type']) => {
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (used.some(([a, b]) => start < b && end > a)) continue;
      used.push([start, end]);
      out.push({ type, value: toNum((m[1] ?? m[2])!), raw: m[0].trim() });
    }
  };
  take(MONEY, 'money');
  take(PCT, 'pct');
  for (const m of text.matchAll(PLAIN)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (used.some(([a, b]) => start < b && end > a)) continue;
    const raw = m[0].replace(/[.,]+$/, '');
    const value = toNum(raw);
    if (value < 100) continue;
    const before = text.slice(0, start);
    const after = text.slice(end);
    if (/[A-Za-z0-9]-?$/.test(before) || /^-\d/.test(after) || /\d-$/.test(before)) continue; // ids, ISO dates
    if (/^(st|nd|rd|th)\b/i.test(after)) continue; // ordinals
    if (value >= 2000 && value <= 2100 && Number.isInteger(value)
      && (new RegExp(`${MONTH}\\s*(?:\\d{1,2},?\\s*)?$`, 'i').test(before) || new RegExp(`^\\s*${MONTH}`, 'i').test(after))) continue;
    out.push({ type: 'plain', value, raw });
  }
  return out;
}
