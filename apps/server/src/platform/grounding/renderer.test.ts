import { describe, expect, it } from 'vitest';
import { PlaceholderRenderer } from './renderer.js';
import { count, money, months, type BoundValue } from './values.js';

const vals: Record<string, BoundValue> = {
  'emi_change.new_emi': money(2_710_500),
  'x.n': count(7),
  'p.saved': months(8),
  'p.one': months(1),
};
const mk = (channel: 'text' | 'voice' = 'text') => new PlaceholderRenderer(() => vals, channel);

describe('PlaceholderRenderer', () => {
  it('resolves a placeholder split across chunks', () => {
    const r = mk();
    expect(r.push('Your EMI is {{emi')).toBe('Your EMI is ');
    expect(r.push('_change.new_emi}} now.')).toBe('₹27,105 now.');
    expect(r.end()).toBe('');
  });
  it('speaks on voice', () => {
    const r = mk('voice');
    r.push('Your EMI is {{emi_change.new_emi}}');
    expect(r.end()).toBe('');
    expect(r.segments().map((s) => s.text).join('')).toBe('Your EMI is twenty-seven thousand one hundred five rupees');
  });
  it('fails closed on unresolved keys', () => {
    const r = mk();
    expect(r.push('a {{nope.x}} b')).toBe('a [unverified] b');
    expect(r.unresolved).toEqual(['nope.x']);
    const v = mk('voice');
    expect(v.push('{{nope.x}}')).toBe("a figure I couldn't verify");
  });
  it('handles 3+ chunks', () => {
    const r = mk();
    const out = ['x {', '{', 'x.', 'n', '}', '} y'].map((c) => r.push(c)).join('') + r.end();
    expect(out).toBe('x 7 y');
  });
  it('emits { followed by non-brace immediately', () => {
    const r = mk();
    expect(r.push('a {b')).toBe('a {b');
    expect(r.push('{')).toBe('');
    expect(r.push('c')).toBe('{c');
  });
  it('flushes unterminated {{ literally at end, not unresolved', () => {
    const r = mk();
    expect(r.push('hi {{emi_ch')).toBe('hi ');
    expect(r.end()).toBe('{{emi_ch');
    expect(r.unresolved).toEqual([]);
  });
  it('two placeholders in one chunk, with spaces inside braces', () => {
    const r = mk();
    expect(r.push('{{ x.n }} and {{x.n}}')).toBe('7 and 7');
  });
  it('invalid placeholder text is literal; long unclosed is not held forever', () => {
    const r = mk();
    expect(r.push('{{Bad Key}} z')).toBe('{{Bad Key}} z');
    const long = '{{' + 'a'.repeat(90);
    expect(r.push(long)).toBe(long);
    expect(r.unresolved).toEqual([]);
  });
  it('sees values added mid-turn and tracks segments', () => {
    const m: Record<string, BoundValue> = {};
    const r = new PlaceholderRenderer(() => m, 'text');
    m['late.v'] = count(300);
    r.push('is {{late.v}} ok');
    expect(r.segments()).toEqual([
      { text: 'is ', bound: false },
      { text: '300', bound: true },
      { text: ' ok', bound: false },
    ]);
  });
  it('collapses a duplicated unit word after a months value, across chunk splits', () => {
    const whole = mk();
    expect(whole.push('You save {{p.saved}} months of EMIs.') + whole.end()).toBe('You save 8 months of EMIs.');
    const split = mk();
    const out = ['You save {{p.saved}}', ' mon', 'ths', ' of EMIs.'].map((c) => split.push(c)).join('') + split.end();
    expect(out).toBe('You save 8 months of EMIs.');
    expect(split.segments().map((x) => x.text).join('')).toBe('You save 8 months of EMIs.');
    const one = mk();
    expect(one.push('{{p.one}} month.') + one.end()).toBe('1 month.');
    const tail = mk();
    expect(tail.push('about {{p.saved}} months') + tail.end()).toBe('about 8 months');
  });
  it('keeps unrelated words after a months value', () => {
    const r = mk();
    expect(r.push('{{p.saved}} monthly, {{p.saved}} more') + r.end()).toBe('8 months monthly, 8 months more');
    const q = mk();
    expect(q.push('{{p.saved}} mo') + q.end()).toBe('8 months mo');
  });
});
