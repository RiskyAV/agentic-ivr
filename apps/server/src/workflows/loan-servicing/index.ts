import { readFileSync } from 'node:fs';
import type { WorkflowDefinition } from '../../platform/workflows/types.js';
import { loanServicingActions } from './actions.js';
import { loanServicingTools } from './tools.js';

const systemPrompt = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8').trim();

export const loanServicing: WorkflowDefinition = {
  id: 'loan-servicing',
  name: 'Loan servicing',
  description: 'EMI, rate changes, payments, prepayment, foreclosure, statements and service requests.',
  systemPrompt,
  tools: [...loanServicingTools.map((t) => t.name), ...loanServicingActions.map((a) => `propose_${a.type}`)],
  actions: loanServicingActions.map((a) => a.type),
  policyTopics: ['prepayment', 'foreclosure', 'rate_reset', 'bounce_charge', 'penal_charge', 'emi_date_change', 'statement', 'dispute', 'grievance'],
  suggestions: [
    'Why did my EMI go up?',
    'What if I prepay ₹50,000?',
    'Show failed payments in the last 6 months',
    'Can I foreclose without penalty?',
  ],
  voice: {
    fillers: {
      get_loan_details: 'Let me pull up your loan details…',
      get_repayment_schedule: 'Let me check your repayment schedule…',
      get_payment_history: 'Let me pull up your payment history…',
      get_policy: 'Let me check the policy…',
      get_service_requests: 'Let me look at your service requests…',
      explain_emi_change: 'Let me look into that EMI change…',
      simulate_prepayment: 'Let me run those numbers…',
      check_foreclosure: 'Let me check foreclosure for you…',
      list_options: 'Let me see what options you have…',
      propose_prepayment: 'One moment while I set that up…',
      propose_dispute: 'One moment while I prepare that dispute…',
      propose_statement: 'One moment while I prepare that request…',
      propose_ticket: 'One moment while I prepare that ticket…',
    },
  },
};
