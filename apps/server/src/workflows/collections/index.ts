import { readFileSync } from 'node:fs';
import type { WorkflowDefinition } from '../../platform/workflows/types.js';
import { collectionsActions } from './actions.js';
import { collectionsTools } from './tools.js';

const systemPrompt = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8').trim();

export const collections: WorkflowDefinition = {
  id: 'collections',
  name: 'Collections call',
  description: 'A respectful collections conversation about an overdue loan: what is owed, pay now, or promise a date.',
  systemPrompt,
  tools: ['get_overdue_summary', 'get_loan_details', 'get_policy', 'get_service_requests', ...collectionsActions.map((a) => `propose_${a.type}`), 'propose_ticket'],
  actions: [...collectionsActions.map((a) => a.type), 'ticket'],
  policyTopics: ['collections_conduct', 'promise_to_pay', 'penal_charge', 'grievance'],
  // The agent speaks first. Figures are snapshot placeholders (resolved by the engine), never typed numbers.
  opener(s) {
    const l = s.loans.filter((x) => x.overdueAmount > 0).sort((a, b) => b.daysPastDue - a.daysPastDue)[0];
    if (!l) return null;
    const k = (f: string) => `{{snapshot.${l.loanId}.${f}}}`;
    const name = s.customer?.name.split(' ')[0];
    return (
      `Hello${name ? ` ${name}` : ''}, this is Northstar Finance calling on behalf of the lender about your ${l.product.replace(/_/g, ' ')} ${l.loanId}. ` +
      `Our records show ${k('overdue')} in instalments is overdue, ${k('days_past_due')} days past due, before any late charges. ` +
      `I am here to help you sort this out, and there is no pressure. Is this a good time to talk?`
    );
  },
  suggestions: ['Why is my account overdue?', 'What do I owe today?', 'Can I pay on the 30th?', 'Send me a payment link'],
  voice: {
    fillers: {
      get_overdue_summary: 'Let me check your account…',
      get_loan_details: 'Let me pull up your loan…',
      get_policy: 'Let me check the policy…',
      get_service_requests: 'Let me look at your requests…',
      propose_promise_to_pay: 'One moment while I note that down…',
      propose_payment_link: 'One moment while I set up the link…',
      propose_ticket: 'One moment while I prepare that request…',
    },
  },
};
