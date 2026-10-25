import { afterEach, describe, expect, it } from 'vitest';
import { addMonths, daysBetween, monthsBetween, today } from './clock.js';

describe('clock', () => {
  const orig = process.env.DEMO_TODAY;
  afterEach(() => {
    if (orig === undefined) delete process.env.DEMO_TODAY;
    else process.env.DEMO_TODAY = orig;
  });

  it('today defaults to 2026-10-25 and reads env at call time', () => {
    delete process.env.DEMO_TODAY;
    expect(today()).toBe('2026-10-25');
    process.env.DEMO_TODAY = '2027-01-02';
    expect(today()).toBe('2027-01-02');
  });
  it('addMonths clamps to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-11-05', 3)).toBe('2027-02-05');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });
  it('monthsBetween counts whole months', () => {
    expect(monthsBetween('2026-01-15', '2026-04-15')).toBe(3);
    expect(monthsBetween('2026-01-15', '2026-04-14')).toBe(2);
    expect(monthsBetween('2026-01-31', '2026-02-28')).toBe(1); // consistent with addMonths clamping
  });
  it('daysBetween', () => {
    expect(daysBetween('2026-09-15', '2026-10-25')).toBe(40);
    expect(daysBetween('2026-10-25', '2026-09-15')).toBe(-40);
  });
});
