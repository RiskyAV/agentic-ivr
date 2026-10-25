import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('masks pan and nested phone, keeping last 4', () => {
    const out = redact({ pan: 'ABCDE1234F', nested: { phone: '9876543210' } });
    expect(out.pan).toBe('XXXXXX234F');
    expect(out.nested.phone).toBe('XXXXXX3210');
  });
  it('masks inside arrays, does not mutate, leaves non-strings and other keys', () => {
    const input = { list: [{ email: 'a@b.in', bankAccount: '12345678901234' }], accountNumber: 5, name: 'Neha' };
    const out = redact(input);
    expect(out.list[0]).toEqual({ email: 'XXXXXX b.in'.replace(' ', ''), bankAccount: 'XXXXXX1234' });
    expect(out.accountNumber).toBe(5);
    expect(out.name).toBe('Neha');
    expect(input.list[0]!.email).toBe('a@b.in');
  });
});
