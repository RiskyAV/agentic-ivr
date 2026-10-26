/** The demo customers offered on the login screen; the mock systems hold their data under the same ids. */
export interface DemoCustomer { id: string; name: string; story: string }

export const DEMO_CUSTOMERS: DemoCustomer[] = [
  { id: 'C1001', name: 'Rahul Mehta', story: 'Floating-rate home loan whose rate reset raised the EMI; asks why it went up.' },
  { id: 'C1002', name: 'Priya Sharma', story: 'Personal loan with two failed debits; disputes a bounce charge levied on a bank technical failure.' },
  { id: 'C1003', name: 'Arjun Verma', story: 'Personal loan two instalments overdue (40 days past due); collections conversation.' },
  { id: 'C1004', name: 'Neha Kapoor', story: 'Two loans, all paid on time; saying "my EMI" is ambiguous and prepayment/foreclosure questions arise.' },
];
