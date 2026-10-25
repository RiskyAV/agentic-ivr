import { describe, expect, it } from 'vitest';
import { rupees } from '../format/inr.js';
import {
  CLAUSES, getClause, bounceRule, foreclosureRule, penalRule, prepaymentRule, ptpRule, selectClause,
} from './select.js';

const ON = '2026-10-25';
const base = { product: 'personal_loan', rateType: 'fixed', borrower: 'individual', sanctionDate: '2025-03-05' } as const;

describe('policy clauses', () => {
  it('floating home loan prepays free under PRE-01', () => {
    const r = prepaymentRule({ ...base, product: 'home_loan', rateType: 'floating' }, ON);
    expect(r.chargePct).toBe(0);
    expect(r.clause.id).toBe('PRE-01');
  });
  it('fixed loan sanctioned 2025-03-05 gets PRE-02 v1 at 4% (age 19m)', () => {
    const r = prepaymentRule(base, ON);
    expect(r.chargePct).toBe(4);
    expect(r.clause.id).toBe('PRE-02');
    expect(r.clause.version).toBe(1);
    expect(r.minAmount).toBe(rupees(10000));
  });
  it('fixed loan sanctioned 2026-05-01 gets PRE-02 v2 at 3%', () => {
    const r = prepaymentRule({ ...base, sanctionDate: '2026-05-01' }, ON);
    expect(r.chargePct).toBe(3);
    expect(r.clause.version).toBe(2);
  });
  it('fixed loan aged 24m+ pays 2%', () => {
    expect(prepaymentRule({ ...base, sanctionDate: '2024-01-10' }, ON).chargePct).toBe(2);
  });
  it('v2 boundary: sanctioned 2026-03-31 is v1, 2026-04-01 is v2', () => {
    expect(prepaymentRule({ ...base, sanctionDate: '2026-03-31' }, ON).clause.version).toBe(1);
    expect(prepaymentRule({ ...base, sanctionDate: '2026-04-01' }, ON).clause.version).toBe(2);
  });
  it('foreclosure of fixed personal loan is locked in for 12 months', () => {
    const r = foreclosureRule({ ...base, sanctionDate: '2026-02-01' }, ON);
    expect(r.eligible).toBe(false);
    expect(r.lockInEndsOn).toBe('2027-02-01');
    expect(r.chargePct).toBe(4);
    expect(r.clause.id).toBe('FC-01');
  });
  it('foreclosure after lock-in is eligible', () => {
    expect(foreclosureRule(base, ON).eligible).toBe(true);
  });
  it('floating loan has no lock-in and uses prepayment charge', () => {
    const r = foreclosureRule({ ...base, product: 'home_loan', rateType: 'floating' }, ON);
    expect(r.eligible).toBe(true);
    expect(r.chargePct).toBe(0);
    expect(r.lockInEndsOn).toBeUndefined();
  });
  it('bounce charge depends on attribution', () => {
    expect(bounceRule('BANK_TECHNICAL_FAILURE', ON).chargeable).toBe(false);
    expect(bounceRule('MANDATE_PROCESSING_ERROR', ON).amount).toBe(0);
    expect(bounceRule('ACCOUNT_CLOSED', ON).chargeable).toBe(true);
    const r = bounceRule('INSUFFICIENT_FUNDS', ON);
    expect(r.amount).toBe(rupees(590));
    expect(r.clause.id).toBe('BC-01');
  });
  it('unknown failure code is not chargeable', () => {
    expect(bounceRule('SOMETHING_ELSE', ON).chargeable).toBe(false);
  });
  it('penal and PTP rules read params', () => {
    expect(penalRule(base, ON).penalRateBpsPa).toBe(2400);
    const p = ptpRule(ON);
    expect(p.maxDaysAhead).toBe(7);
    expect(p.maxActive).toBe(1);
  });
  it('old fixed loan sanctioned 2020-01-01 resolves to PRE-02 v1 at 2%', () => {
    const r = prepaymentRule({ ...base, sanctionDate: '2020-01-01' }, ON);
    expect(r.clause.id).toBe('PRE-02');
    expect(r.clause.version).toBe(1);
    expect(r.chargePct).toBe(2);
    expect(foreclosureRule({ ...base, sanctionDate: '2020-01-01' }, ON).eligible).toBe(true);
  });
  it('getClause looks up by id and optional version', () => {
    expect(getClause('PRE-02')?.version).toBe(2);
    expect(getClause('PRE-02', 1)?.version).toBe(1);
    expect(getClause('NOPE')).toBeUndefined();
    expect(getClause('PRE-02', 9)).toBeUndefined();
  });
  it('throws when no clause matches', () => {
    expect(() => selectClause('prepayment', { ...base, rateType: 'floating', borrower: 'business' }, ON)).toThrow();
    expect(() => selectClause('prepayment', { ...base, rateType: 'floating', borrower: 'business' }, ON)).toThrow();
  });
  it('every clause has readable text and unique id+version', () => {
    const keys = CLAUSES.map((c) => `${c.id}@${c.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of CLAUSES) expect(c.text.length).toBeGreaterThan(20);
    for (const id of ['RR-01', 'COL-01', 'DSP-01', 'ST-01', 'EDC-01', 'GRV-01']) {
      expect(CLAUSES.some((c) => c.id === id)).toBe(true);
    }
  });
});
