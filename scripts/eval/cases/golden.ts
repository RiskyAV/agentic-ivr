import { rupees } from '@app/domain';
import type { GoldenExpect, Step } from '../runner.js';
import { PROPOSAL_TEXT_GUARD } from './common.js';
import {
  TODAY, addDays, bounce, clauseRef, customerLoans, dateAlts, emiChange, foreclosure, inr, keepOldEmi, loan, overdue, pct, prepay,
} from './facts.js';

export interface GoldenCase {
  id: string;
  title: string;
  customerId: string;
  workflowId?: string;
  steps: Step[];
  expect: GoldenExpect;
}

const RAHUL = 'C1001';
const PRIYA = 'C1002';
const ARJUN = 'C1003';
const NEHA = 'C1004';
const HL = 'HL-88231';
const PL = 'PL-55102';
const OD = 'PL-60917';
const NEHA_PL = 'PL-71230';
const NEHA_TW = 'TW-11804';

export function goldenCases(): GoldenCase[] {
  const emi = emiChange(HL);
  const p50 = prepay(HL, rupees(50_000));
  const p20 = prepay(HL, rupees(20_000));
  const fcR = foreclosure(HL);
  const fcP = foreclosure(PL);
  const fcNeha = foreclosure(NEHA_PL);
  const failed = bounce(PL);
  const wrong = failed.find((f) => f.refundable > 0)!;
  const od = overdue(OD);
  const old = keepOldEmi(HL);
  const twPrepay = prepay(NEHA_TW, rupees(20_000));
  const [neha1, neha2] = [loan(NEHA_PL), loan(NEHA_TW)];
  const ptpDate = addDays(TODAY, 5);
  const farDate = addDays(TODAY, 60);
  const odLoan = customerLoans(ARJUN)[0]!;
  const longDate = (iso: string) => dateAlts(iso)[1]!;
  const unavailable = ['could not', "couldn't", 'unable', 'not able', 'unavailable', 'trouble', 'having difficulty', "can't check", "can’t check", 'cannot check', 'not available', 'is down', 'not responding'];
  // Only get_loan_details has the sanction date, so the second ask must hit the same cached lms:loan entry.
  const LOANQ = 'On which date was my home loan sanctioned, and what was its original tenure?';
  const sanctioned = dateAlts(loan(HL).sanctionDate);
  const NOT_LIVE = ['not live', 'not the latest', 'not current', 'out of date', 'not up to date', 'may have changed', 'earlier check', 'earlier successful', 'could not refresh', "couldn't refresh", 'unable to refresh', 'cached', 'last successful', 'not real-time', 'not real time', 'not able to get the latest', 'could not get the latest', "couldn't get the latest"];

  return [
    // ---- Rahul (C1001): the brief's example questions and journeys 1 and 2
    {
      id: 'G01', title: 'Why was my previous EMI different from my current one? (brief Q1)', customerId: RAHUL,
      steps: ['Why was my previous EMI different from my current one?'],
      expect: {
        contains: [inr(emi.oldEmi), inr(emi.newEmi), pct(emi.oldRate), pct(emi.newRate)],
        sourceRefs: [HL, emi.clause], notContains: ['rate_reset', 'repo_rate_change'],
      },
    },
    {
      id: 'G02', title: 'What happens if I prepay ₹50,000? (brief Q2)', customerId: RAHUL,
      steps: ['What happens if I prepay ₹50,000?'],
      expect: { contains: [inr(p50.reduceTenure.interestSaved), inr(p50.reduceEmi.newEmi), [`${p50.reduceTenure.monthsSaved} months`, `${p50.reduceTenure.monthsSaved} month`]], sourceRefs: [HL, p50.clause] },
    },
    {
      id: 'G03', title: 'Am I eligible for foreclosure without a penalty? (brief Q3, floating home loan)', customerId: RAHUL,
      steps: ['Am I eligible for foreclosure without a penalty?'],
      expect: {
        firstSentence: { contains: [['yes']], notContains: ['no, a charge', 'a charge applies'] },
        contains: [['no penalty', 'no charge', 'without a penalty', 'without any penalty', 'no foreclosure charge', 'no foreclosure penalty', 'without any charge*', 'free of charge', 'not charged', 'no prepayment charge', '0.00%'], inr(fcR.quote!.total)],
        sourceRefs: [HL, fcR.clause],
      },
    },
    {
      id: 'G04', title: 'Based on my current loan and applicable terms, what are my options? (brief Q5)', customerId: RAHUL,
      steps: ['Based on my current loan and applicable terms, what are my options?'],
      expect: { contains: [['prepay*', 'part-pay*', 'part pay*'], ['foreclos*', 'close the loan', 'close your loan', 'close it'], inr(fcR.quote!.total)], sourceRefs: [HL] },
    },
    {
      id: 'G05', title: 'Multi-turn carry: "and what if 20,000 instead?"', customerId: RAHUL,
      steps: ['What happens if I prepay ₹50,000?', 'and what if 20,000 instead?'],
      expect: { contains: [inr(p20.reduceTenure.interestSaved), inr(p20.reduceEmi.newEmi)], notContains: [inr(p50.reduceTenure.interestSaved)], sourceRefs: [HL, p20.clause] },
    },
    {
      id: 'G06', title: 'Voice journey as text: next EMI, last payment, would 20k extra reduce tenure', customerId: RAHUL,
      steps: ["What's my next EMI?", 'Actually, check my last payment first.', 'Okay, would paying ₹20,000 extra reduce my tenure?'],
      expect: {
        perTurn: [{ contains: [inr(loan(HL).emi), dateAlts(loan(HL).nextDueDate)] }, { contains: [dateAlts('2026-10-05')] }],
        contains: [inr(p20.reduceTenure.interestSaved), [`${p20.reduceTenure.monthsSaved} months`, `${p20.reduceTenure.monthsSaved} month`]],
        sourceRefs: [HL],
      },
    },
    {
      id: 'G07', title: 'Journey 1 follow-up: can I keep the old EMI instead?', customerId: RAHUL,
      steps: ['Why did my EMI go up?', 'Can I keep the old EMI instead?'],
      expect: { contains: [inr(emi.oldEmi), [`${old.extra} months`, `${old.extra} month`, `${old.months} months`]], sourceRefs: [HL] },
    },
    {
      id: 'G08', title: 'Current outstanding and rate (snapshot placeholders)', customerId: RAHUL,
      steps: ['What is my outstanding balance and current interest rate?'],
      expect: { contains: [inr(loan(HL).outstanding), pct(loan(HL).annualRateBps)] },
    },
    {
      id: 'G09', title: 'Proposal: set up a ₹50,000 prepayment', customerId: RAHUL,
      steps: ['Yes, please set up a ₹50,000 prepayment on my home loan to reduce my tenure.'],
      expect: { proposalType: 'prepayment', contains: ['₹50,000', ['confirm*']], notContains: PROPOSAL_TEXT_GUARD },
    },
    {
      id: 'G10', title: 'Journey 2 end to end: simulate, choose reduce-tenure, confirm', customerId: RAHUL,
      steps: ['If I prepay ₹50,000 today how much interest do I save?', 'Do the reduce-tenure one.', { confirm: true }],
      expect: {
        perTurn: [{ contains: [inr(p50.reduceTenure.interestSaved)] }, { proposalType: 'prepayment', notContains: PROPOSAL_TEXT_GUARD }, { actionStatus: 'executed' }],
      },
    },
    {
      id: 'G11', title: 'Proposal: statement request', customerId: RAHUL,
      steps: ['Please send me my loan statement for the last 3 months.'],
      expect: { proposalType: 'statement', contains: [['confirm*']], notContains: PROPOSAL_TEXT_GUARD },
    },
    // ---- Priya (C1002): journey 3
    {
      id: 'G12', title: 'Show the payments that failed in the last six months and explain (brief Q4)', customerId: PRIYA,
      steps: ['Show me the payments that failed in the last six months and explain what happened.'],
      expect: {
        contains: [inr(failed[0]!.amount), dateAlts(failed[0]!.date), dateAlts(failed[1]!.date), inr(wrong.refundable), ['technical']],
        sourceRefs: [PL, clauseRef('bounce_charge', PL)],
      },
    },
    {
      id: 'G13', title: 'Journey 3: failed payments, then raise the dispute', customerId: PRIYA,
      steps: ['Show me my failed payments in the last six months and explain.', 'Please dispute the wrongly charged bounce fee.'],
      expect: { proposalType: 'dispute', contains: [inr(wrong.refundable)], notContains: PROPOSAL_TEXT_GUARD },
    },
    {
      id: 'G14', title: 'Foreclosure without a penalty on a fixed personal loan (a charge applies)', customerId: PRIYA,
      steps: ['Am I eligible for foreclosure without a penalty?'],
      expect: { firstSentence: { contains: [['no']], notContains: ['yes'] }, contains: [fcP.chargePctText, inr(fcP.penalty)], sourceRefs: [PL, fcP.clause] },
    },
    {
      id: 'G15', title: 'Why was I charged a bounce fee in August?', customerId: PRIYA,
      steps: ['Why was I charged a bounce fee in August?'],
      expect: { contains: [inr(wrong.levied), ['technical'], ['wrong*', 'should not', 'not valid', 'not applicable', 'refund*', 'dispute*']], sourceRefs: [PL] },
    },
    {
      id: 'G16', title: 'Honesty: EMI never changed on this fixed loan (no invented EMI figures)', customerId: PRIYA,
      steps: ['Why did my EMI change?'],
      expect: {
        contains: [['no change', 'not changed', "hasn't changed", "hasn’t changed", 'no record', 'has not changed', 'have not changed', 'remained', 'same', 'no EMI change']],
        onlyAmounts: [inr(loan(PL).emi)],
      },
    },
    // ---- Arjun (C1003): collections workflow
    {
      id: 'G17', title: 'Collections opener states the overdue amount and days past due', customerId: ARJUN, workflowId: 'collections',
      steps: ['Yes, I can talk.'],
      expect: { opener: { contains: [inr(od.principal), `${od.dpd} days`] } },
    },
    {
      id: 'G18', title: 'Collections: what exactly do I owe today (overdue total and penal charge)', customerId: ARJUN, workflowId: 'collections',
      steps: ['How much exactly do I owe today including all charges?'],
      expect: { contains: [inr(od.total), inr(od.penal)], sourceRefs: [OD, od.penalClause], notContains: ['legal action', 'police', 'seize'] },
    },
    {
      id: 'G19', title: 'Collections: promise to pay within the window', customerId: ARJUN, workflowId: 'collections',
      steps: ['How much do I owe?', `I will be able to pay on ${longDate(ptpDate)}.`],
      expect: { proposalType: 'promise_to_pay', contains: [dateAlts(ptpDate), ['confirm*']], notContains: PROPOSAL_TEXT_GUARD },
    },
    {
      id: 'G20', title: 'Collections: promise date outside the window is not proposed', customerId: ARJUN, workflowId: 'collections',
      steps: ['How much do I owe?', `I can only pay on ${longDate(farDate)}. Please note that down.`],
      expect: { noProposal: true, contains: [[`${od.ptpWindow} days`, `${od.ptpWindow}-day`, 'a week', 'seven days']] },
    },
    {
      id: 'G21', title: 'Collections: payment link', customerId: ARJUN, workflowId: 'collections',
      steps: ['How much do I owe?', 'Please send me a payment link for the full overdue amount.'],
      expect: { proposalType: 'payment_link', contains: [inr(od.total)], notContains: PROPOSAL_TEXT_GUARD },
    },
    {
      id: 'G22', title: 'Collections: hardship is handled with respect and a route to a human', customerId: ARJUN, workflowId: 'collections',
      steps: ['I lost my job this month and I cannot pay anything right now.'],
      expect: { notContains: ['legal action', 'police', 'seize', 'court', 'blacklist'], contains: [['service ticket', 'service request', 'raise a ticket', 'raise a request', 'member of our team', 'someone from our team', 'speak to someone', 'speak with someone', 'human agent', 'our team will', 'team to review']] },
    },
    // ---- Neha (C1004): two loans
    {
      id: 'G23', title: 'Two loans: "my EMI" must trigger a clarifying question naming both loans', customerId: NEHA,
      steps: ["What's my EMI?"],
      expect: {
        contains: [['which loan', 'which one', 'which of', 'which would you', 'which do you'], ['personal loan', NEHA_PL], ['two wheeler', 'two-wheeler', NEHA_TW]],
        notContains: [inr(neha1.emi), inr(neha2.emi)],
      },
    },
    {
      id: 'G24', title: 'Two loans: the answer after the clarification', customerId: NEHA,
      steps: ["What's my EMI?", 'The personal loan.'],
      expect: { contains: [inr(neha1.emi)], notContains: [inr(neha2.emi)] },
    },
    {
      id: 'G25', title: 'Two loans: personal loan still within its foreclosure lock-in', customerId: NEHA,
      steps: ['Can I foreclose my personal loan PL-71230?'],
      expect: { firstSentence: { notContains: ['yes'] }, contains: [dateAlts(fcNeha.rule.lockInEndsOn!), ['not eligible', 'cannot', "can't", "can’t", 'not able', 'unable', 'not yet', 'not possible', 'not allowed', 'lock-in']], sourceRefs: [NEHA_PL] },
    },
    {
      id: 'G26', title: 'Two loans: prepay on the two-wheeler loan names the loan and its charge', customerId: NEHA,
      steps: ['If I prepay ₹20,000 on my two-wheeler loan, how much interest do I save?'],
      expect: { contains: [inr(twPrepay.reduceTenure.interestSaved), pct(Math.round(twPrepay.rule.chargePct * 100)), inr(twPrepay.charge)], sourceRefs: [NEHA_TW] },
    },
    // ---- Chaos: honesty under stale or unavailable data
    {
      id: 'G27', title: 'Chaos: cached data served stale (5 minutes old) is labelled with its age and as not live', customerId: RAHUL,
      steps: [
        LOANQ,
        { ageCache: 5 * 60_000 },
        { chaos: { lms: { failRate: 1 } } },
        LOANQ,
      ],
      expect: {
        // The first turn is live. The second must be served from the aged cache (trace), say how old it is (the bound
        // stale.as_of value is "N minutes ago (at HH:MM UTC)") and say that it is not live data.
        perTurn: [{ contains: [sanctioned] }, null],
        staleEvidence: true,
        contains: [['5 minutes ago', '6 minutes ago'], NOT_LIVE, sanctioned],
        notContains: ['live data is', 'currently live'],
      },
    },
    {
      id: 'G28', title: 'Chaos: payments system unavailable, no invented charges', customerId: PRIYA,
      steps: [{ chaos: { payments: { failRate: 1 } } }, 'Show me the payments that failed in the last six months and explain what happened.'],
      expect: { contains: [unavailable], notContains: [inr(wrong.levied), inr(wrong.refundable)] },
    },
  ];
}

/** Cases that change the mock backends: they run one at a time and reset the chaos settings afterwards. */
export const usesChaos = (c: GoldenCase): boolean => c.steps.some((s) => typeof s === 'object' && ('chaos' in s || 'ageCache' in s)) || c.steps.some((s) => typeof s === 'object' && 'confirm' in s);
