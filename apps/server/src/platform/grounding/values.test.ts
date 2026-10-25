import { describe, expect, it } from 'vitest';
import { formatBound, text } from './values.js';

describe('formatBound text safety net', () => {
  it('renders snake_case enum text with spaces', () => {
    expect(formatBound(text('rate_reset'), 'text')).toBe('rate reset');
    expect(formatBound(text('covers_full_outstanding'), 'voice')).toBe('covers full outstanding');
  });
  it('leaves human text and single words alone', () => {
    expect(formatBound(text('yes'), 'text')).toBe('yes');
    expect(formatBound(text('a change in your loan tenure'), 'text')).toBe('a change in your loan tenure');
    expect(formatBound(text('HL-88231'), 'text')).toBe('HL-88231');
  });
});
