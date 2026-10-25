/** All money/percent/date display goes through the domain formatters (Indian digit grouping); the UI never computes money. */
export { formatDate, formatInr, formatPct } from '@app/domain';

const PRODUCTS: Record<string, string> = {
  home_loan: 'Home Loan', personal_loan: 'Personal Loan', two_wheeler_loan: 'Two-Wheeler Loan',
};
export const productLabel = (p: string) => PRODUCTS[p] ?? titleCase(p);

const REQUESTS: Record<string, string> = {
  prepayment: 'Prepayment', dispute: 'Charge dispute', statement: 'Statement request', ticket: 'Support ticket',
  promise_to_pay: 'Promise to pay', callback: 'Callback',
};
export const requestLabel = (t: string) => REQUESTS[t] ?? titleCase(t);

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Server reasons are sentences; codes like "reduce_tenure" become "Reduce tenure". */
export const humanise = (s: string) => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s` : `${Math.round(n)} ms`);
