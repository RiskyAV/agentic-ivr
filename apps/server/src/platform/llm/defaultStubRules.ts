import type { StubRule } from './stub.js';

/** Small rule set for LLM_PROVIDER=stub: gateway tests, load runs and keyless demos. Figures come from placeholders. */
export const DEFAULT_STUB_RULES: StubRule[] = [
  {
    match: /\bemi\b/i,
    script: [
      [{ type: 'tool_calls', calls: [{ id: 'stub-1', name: 'explain_emi_change', args: {} }] }],
      [
        { type: 'text', text: 'Your EMI changed from {{emi_change.old_emi}} to {{emi_change.new_emi}}, ' },
        { type: 'text', text: 'because your interest rate was reset on {{emi_change.effective_date}}.' },
      ],
    ],
  },
  {
    match: /prepay/i,
    script: [
      [{ type: 'tool_calls', calls: [{ id: 'stub-2', name: 'propose_prepayment', args: { loanId: 'HL-88231', amount: '50k', mode: 'reduce_tenure' } }] }],
      [{ type: 'text', text: 'I have set up a prepayment request for you to review. Please check the details and confirm.' }],
    ],
  },
];
