import { addMonths, monthsBetween } from '../clock.js';
import type { Paise } from '../format/inr.js';
import type { Loan } from '../types.js';
import { CLAUSES, type PolicyClause, type PolicyTopic } from './clauses.js';

export * from './clauses.js';

export type PolicyLoan = Pick<Loan, 'product' | 'rateType' | 'borrower' | 'sanctionDate'>;

function matchesLoan(c: PolicyClause, loan: PolicyLoan): boolean {
  const a = c.appliesTo;
  return (!a.products || a.products.includes(loan.product))
    && (!a.rateTypes || a.rateTypes.includes(loan.rateType))
    && (!a.borrower || a.borrower === loan.borrower);
}

function specificity(c: PolicyClause): number {
  const a = c.appliesTo;
  return (a.products ? 1 : 0) + (a.rateTypes ? 1 : 0) + (a.borrower ? 1 : 0);
}

/** Without a loan only clauses with no appliesTo constraints can match. */
function find(topic: PolicyTopic, onDate: string, loan?: PolicyLoan): PolicyClause | undefined {
  return CLAUSES
    .filter((c) => c.topic === topic)
    .filter((c) => (loan ? matchesLoan(c, loan) : specificity(c) === 0))
    .filter((c) => {
      const d = c.versionBy === 'sanctionDate' && loan ? loan.sanctionDate : onDate;
      return c.effectiveFrom <= d && (c.effectiveTo === undefined || d < c.effectiveTo);
    })
    .sort((x, y) => specificity(y) - specificity(x) || y.version - x.version)[0];
}

export function selectClause(topic: PolicyTopic, loan: PolicyLoan, onDate: string): PolicyClause {
  const c = find(topic, onDate, loan);
  if (!c) throw new Error(`No policy clause for topic ${topic} (${loan.product}/${loan.rateType}/${loan.borrower}) on ${onDate}`);
  return c;
}

function selectGeneral(topic: PolicyTopic, onDate: string): PolicyClause {
  const c = find(topic, onDate);
  if (!c) throw new Error(`No policy clause for topic ${topic} on ${onDate}`);
  return c;
}

function param(c: PolicyClause, key: string): number {
  const v = c.params?.[key];
  if (v === undefined) throw new Error(`Clause ${c.id} v${c.version} is missing param ${key}`);
  return v;
}

export function prepaymentRule(loan: PolicyLoan, onDate: string): { chargePct: number; minAmount: Paise; clause: PolicyClause } {
  const clause = selectClause('prepayment', loan, onDate);
  const minAmount = param(clause, 'minAmountPaise');
  if (clause.params && 'chargePct' in clause.params) return { chargePct: param(clause, 'chargePct'), minAmount, clause };
  const young = monthsBetween(loan.sanctionDate, onDate) < param(clause, 'ageThresholdMonths');
  return { chargePct: param(clause, young ? 'youngChargePct' : 'matureChargePct'), minAmount, clause };
}

export function foreclosureRule(loan: PolicyLoan, onDate: string): { eligible: boolean; lockInEndsOn?: string; chargePct: number; clause: PolicyClause } {
  const { chargePct, clause: prepay } = prepaymentRule(loan, onDate);
  // Loans outside FC-01's scope (e.g. floating) have no lock-in: foreclosure is always allowed.
  const clause = find('foreclosure', onDate, loan);
  if (!clause) return { eligible: true, chargePct, clause: prepay };
  const lockInEndsOn = addMonths(loan.sanctionDate, param(clause, 'lockInMonths'));
  return { eligible: onDate >= lockInEndsOn, lockInEndsOn, chargePct, clause };
}

export function bounceRule(failureCode: string, onDate: string): { chargeable: boolean; amount: Paise; clause: PolicyClause } {
  const clause = selectGeneral('bounce_charge', onDate);
  // Unknown codes are treated as not customer-attributable: never charge on ambiguity.
  const chargeable = clause.lists?.chargeableCodes?.includes(failureCode) ?? false;
  const base = param(clause, 'baseAmountPaise');
  const amount = chargeable ? base + Math.round((base * param(clause, 'gstPct')) / 100) : 0;
  return { chargeable, amount, clause };
}

export function penalRule(loan: PolicyLoan, onDate: string): { penalRateBpsPa: number; clause: PolicyClause } {
  const clause = selectClause('penal_charge', loan, onDate);
  return { penalRateBpsPa: param(clause, 'penalRateBpsPa'), clause };
}

export function ptpRule(onDate: string): { maxDaysAhead: number; maxActive: number; clause: PolicyClause } {
  const clause = selectGeneral('promise_to_pay', onDate);
  return { maxDaysAhead: param(clause, 'maxDaysAhead'), maxActive: param(clause, 'maxActive'), clause };
}

/** Direct lookup by id; latest version when `version` is omitted. */
export function getClause(id: string, version?: number): PolicyClause | undefined {
  return CLAUSES
    .filter((c) => c.id === id && (version === undefined || c.version === version))
    .sort((a, b) => b.version - a.version)[0];
}
