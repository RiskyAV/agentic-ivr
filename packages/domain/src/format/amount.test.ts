import { describe, expect, it } from 'vitest';
import { parseAmount } from './amount.js';

describe('parseAmount', () => {
  const cases: [number | string, number][] = [
    [50000, 5_000_000], ['50000', 5_000_000], ['50,000', 5_000_000], ['₹50,000', 5_000_000],
    ['Rs. 50000', 5_000_000], ['rs50000', 5_000_000], ['50k', 5_000_000], ['50 K', 5_000_000],
    ['fifty thousand', 5_000_000], ['0.5 lakh', 5_000_000], ['0.5L', 5_000_000],
    ['1.5L', 15_000_000], ['1.5 lakh', 15_000_000], ['one lakh fifty thousand', 15_000_000],
    ['1,23,456', 12_345_600], ['2 crore', 2_000_000_000], ['1.5 cr', 1_500_000_000], ['2 lac', 20_000_000],
    ['fifty thousand rupees', 5_000_000], ['twenty-five thousand', 2_500_000],
    ['two crore fifty lakh', 2_500_000_000], ['one hundred twenty three', 12_300],
    ['123,456', 12_345_600], ['12,34,56,789', 12_345_678_900], ['1,234,567', 123_456_700], ['12.34 crore', 12_340_000_000],
    ['123456789.12', 12_345_678_912], ['.5 lakh', 5_000_000], ['  ₹ 1,500.50 ', 150_050], ['50000 rupees', 5_000_000],
  ];
  it.each(cases)('parses %j -> %i paise', (input, paise) => {
    expect(parseAmount(input)).toEqual({ ok: true, paise });
  });

  const bad: (number | string)[] = [
    'some money', '', '   ', '-500', '50 crore crore', 0, '0', -5, NaN, Infinity, 'fifty fifty',
    '50 lakh lakh', 'one thousand lakh', '12abc', '1.2.3', 'thousand', 1.234, '1.234', '1,5 lakh', '50,00', '1,2,3', '5,0,0,0,0', '1,23,45', '1234,567', '1,,000', '1,000.5,0',
  ];
  it.each(bad)('rejects %j', (input) => {
    expect(parseAmount(input).ok).toBe(false);
  });
});
