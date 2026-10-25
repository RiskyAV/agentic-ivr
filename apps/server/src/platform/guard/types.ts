/** Input guard contract (D-026). Task 15 implements it; the engine runs `check` in parallel with the turn. */
export interface GuardVerdict {
  verdict: 'allow' | 'block';
  category?: string;
  /** Which layer decided; `timeout` means no verdict arrived in time (treated as allow, but proposals are dropped). */
  by: 'rules' | 'model' | 'timeout';
  ms: number;
}

export interface GuardContext {
  customerName: string;
  otherCustomerNames: string[];
  strikes: number;
}

export interface Guard {
  check(text: string, ctx: GuardContext, signal: AbortSignal): Promise<GuardVerdict>;
}

/** Builds the customer-facing refusal for a blocked turn; `strikes` already includes this one. */
export type RefusalFn = (category: string | undefined, strikes: number) => string;
