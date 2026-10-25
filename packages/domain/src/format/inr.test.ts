import { afterEach, describe, expect, it } from 'vitest';
import { formatDate, formatInr, formatPct, rupees, speakDate, speakInr, speakPct } from './inr.js';

describe('inr formatting', () => {
  it('formatInr groups lakh/crore', () => {
    expect(formatInr(rupees(123456))).toBe('₹1,23,456');
    expect(formatInr(rupees(12345678))).toBe('₹1,23,45,678');
    expect(formatInr(rupees(999))).toBe('₹999');
    expect(formatInr(12345, { paise: true })).toBe('₹123.45');
  });
  it('rupees rounds to integer paise', () => {
    expect(rupees(12.34)).toBe(1234);
    expect(rupees(0.1 + 0.2)).toBe(30);
  });
  it('speakInr', () => {
    expect(speakInr(rupees(123456))).toBe('one lakh twenty-three thousand four hundred fifty-six rupees');
    expect(speakInr(rupees(50000))).toBe('fifty thousand rupees');
    expect(speakInr(rupees(25000000))).toBe('two crore fifty lakh rupees');
    expect(speakInr(0)).toBe('zero rupees');
    expect(speakInr(rupees(1))).toBe('one rupee');
    expect(speakInr(12350)).toBe('one hundred twenty-four rupees');
    expect(speakInr(rupees(100000000))).toBe('ten crore rupees');
  });
  it('pct', () => {
    expect(formatPct(910)).toBe('9.10%');
    expect(speakPct(850)).toBe('8.5 percent');
    expect(speakPct(900)).toBe('9 percent');
    expect(speakPct(925)).toBe('9.25 percent');
  });
  describe('dates', () => {
    const orig = process.env.DEMO_TODAY;
    afterEach(() => {
      if (orig === undefined) delete process.env.DEMO_TODAY;
      else process.env.DEMO_TODAY = orig;
    });
    it('formatDate', () => {
      expect(formatDate('2026-11-05')).toBe('5 Nov 2026');
    });
    it('speakDate drops current year only', () => {
      process.env.DEMO_TODAY = '2026-10-25';
      expect(speakDate('2026-11-05')).toBe('5th November');
      expect(speakDate('2027-01-01')).toBe('1st January 2027');
      expect(speakDate('2026-03-22')).toBe('22nd March');
      expect(speakDate('2026-03-23')).toBe('23rd March');
      expect(speakDate('2026-03-11')).toBe('11th March');
    });
  });
});
