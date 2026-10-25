import { describe, expect, it } from 'vitest';
import { numericCheck } from './numericCheck.js';
import { PlaceholderRenderer } from './renderer.js';
import { count, money, months, pct, type BoundValue } from './values.js';

const allowed: BoundValue[] = [money(2_710_500), pct(1050), months(24), count(300)];
const llm = (t: string) => [{ text: t, bound: false }];

describe('numericCheck', () => {
  it('flags a literal rupee amount not in values', () => {
    const r = numericCheck(llm('You will pay ₹5,000 extra'), allowed, 'text');
    expect(r).toEqual({ ok: false, unverified: ['₹5,000'] });
  });
  it('ignores bound spans', () => {
    const rr = new PlaceholderRenderer(() => ({ 'a.b': money(500_000) }), 'text');
    rr.push('Pay {{a.b}} today');
    rr.end();
    expect(numericCheck(rr.segments(), [], 'text').ok).toBe(true);
  });
  it('passes literals equal to allowed values (intl/Indian grouping, Rs, decimals)', () => {
    expect(numericCheck(llm('₹27,105 or Rs 2,710,500.00? no: INR 27105.00'), allowed, 'text').unverified).toEqual(['Rs 2,710,500.00']);
  });
  it('percentages and months', () => {
    expect(numericCheck(llm('rate 10.5% for 24 months'), allowed, 'text').ok).toBe(true);
    expect(numericCheck(llm('rate 11.25 percent'), allowed, 'voice').unverified).toEqual(['11.25 percent']);
  });
  it('plain numbers >=100 only; small numbers, ordinals, list numbers, dates, ids ignored', () => {
    expect(numericCheck(llm('1. First\n2) Second step 5 of 7, 3rd try'), allowed, 'text').ok).toBe(true);
    expect(numericCheck(llm('On 5 Nov 2026 and November 2026 and 2026-11-05 for PL-71230'), allowed, 'text').ok).toBe(true);
    expect(numericCheck(llm('about 450 days'), allowed, 'text').unverified).toEqual(['450']);
    expect(numericCheck(llm('300 days'), allowed, 'text').ok).toBe(true);
  });
  it('voice digit-based numbers', () => {
    expect(numericCheck(llm('about 5000 rupees'), allowed, 'voice').unverified).toEqual(['5000 rupees']);
  });
});
