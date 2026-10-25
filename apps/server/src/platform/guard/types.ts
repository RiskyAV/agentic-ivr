/** Input guard contract (D-026). Task 15 implements it; the engine runs `check` in parallel with the turn. */
export type GuardCategory = 'injection' | 'impersonation' | 'cross_customer' | 'coercion' | 'prompt_extraction' | 'abuse';
export const GUARD_CATEGORIES: readonly GuardCategory[] = ['injection', 'impersonation', 'cross_customer', 'coercion', 'prompt_extraction', 'abuse'];

export interface GuardVerdict {
  verdict: 'allow' | 'block';
  category?: GuardCategory;
  /** Which layer decided; `timeout` means no verdict arrived in time (treated as allow, but proposals are dropped). */
  by: 'rules' | 'model' | 'timeout';
  ms: number;
}

export interface GuardContext {
  customerName: string;
  otherCustomerNames: string[];
  /** Loan IDs the current customer owns; any other loan ID in the text is a cross-customer probe. */
  ownedLoanIds?: string[];
  strikes: number;
}

export interface Guard {
  check(text: string, ctx: GuardContext, signal: AbortSignal): Promise<GuardVerdict>;
}

/** Builds the customer-facing refusal for a blocked turn; `strikes` already includes this one. */
export type RefusalFn = (category: string | undefined, strikes: number) => string;
