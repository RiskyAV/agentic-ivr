import { describe, expect, it } from 'vitest';
import { describeStale, staleValues } from './stale.js';

const NOW = Date.parse('2026-10-25T10:00:00.000Z');

describe('describeStale', () => {
  it('leads with the age and adds the UTC time', () => {
    expect(describeStale('2026-10-25T09:55:00.000Z', NOW)).toBe('5 minutes ago (at 09:55 UTC)');
    expect(describeStale('2026-10-25T09:59:30.000Z', NOW)).toBe('less than a minute ago (at 09:59 UTC)');
    expect(describeStale('2026-10-25T09:59:00.000Z', NOW)).toBe('1 minute ago (at 09:59 UTC)');
    expect(describeStale('2026-10-25T08:30:00.000Z', NOW)).toBe('1 hour ago (at 08:30 UTC)');
    expect(describeStale('2026-10-25T07:00:00.000Z', NOW)).toBe('3 hours ago (at 07:00 UTC)');
  });
});

describe('staleValues', () => {
  it('binds one key per stale tool and stale.as_of as the oldest, so mixed ages are not overwritten', () => {
    const v = staleValues({ get_loan_details: '2026-10-25T09:59:00.000Z', get_payment_history: '2026-10-25T09:50:00.000Z' }, NOW);
    expect(v['stale.get_loan_details.as_of']).toEqual({ kind: 'text', s: '1 minute ago (at 09:59 UTC)' });
    expect(v['stale.get_payment_history.as_of']).toEqual({ kind: 'text', s: '10 minutes ago (at 09:50 UTC)' });
    expect(v['stale.as_of']).toEqual({ kind: 'text', s: '10 minutes ago (at 09:50 UTC)' });
  });
  it('binds nothing when no tool was stale', () => {
    expect(staleValues({}, NOW)).toEqual({});
  });
});
