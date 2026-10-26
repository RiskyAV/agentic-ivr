import { describe, expect, it } from 'vitest';
import { accessCookie, basicPassword, decide, safeEqual } from './siteGate';

const basic = (u: string, p: string) => 'Basic ' + btoa(`${u}:${p}`);

describe('site gate', () => {
  it('fails closed with 503 when no password is configured', async () => {
    expect(await decide(basic('a', 'x'), undefined)).toMatchObject({ kind: 'deny', status: 503 });
    expect(await decide(basic('a', ''), '')).toMatchObject({ kind: 'deny', status: 503 });
  });
  it('denies missing, malformed and wrong credentials with 401', async () => {
    for (const h of [null, '', 'Bearer x', 'Basic !!!', basic('a', 'nope'), 'Basic ' + btoa('nocolon')]) {
      expect(await decide(h, 'secret')).toMatchObject({ kind: 'deny', status: 401 });
    }
  });
  it('allows any username with the right password, including colons', async () => {
    expect(await decide(basic('anyone', 'secret'), 'secret')).toEqual({ kind: 'allow' });
    expect(await decide(basic('', 'se:cret'), 'se:cret')).toEqual({ kind: 'allow' });
  });
  it('parses and compares', async () => {
    expect(basicPassword(basic('u', 'p:q'))).toBe('p:q');
    expect(await safeEqual('a', 'a')).toBe(true);
    expect(await safeEqual('a', 'b')).toBe(false);
  });
  it('builds a readable (non-HttpOnly) cookie', () => {
    const c = accessCookie('a b;c');
    expect(c).toBe('demo_access=a%20b%3Bc; Path=/; Secure; SameSite=Strict; Max-Age=43200');
    expect(c).not.toMatch(/HttpOnly/i);
  });
});
