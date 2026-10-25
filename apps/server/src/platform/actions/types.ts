import type { z } from 'zod';
import type { Source } from '@app/shared';
import type { BoundValue } from '../grounding/values.js';
import type { ToolContext } from '../tools/types.js';

export type ValidateResult =
  | { ok: true; figures: Record<string, BoundValue>; summary: string; sources?: Source[]; /** Normalised params to store on the proposal (so they enter the terms hash), e.g. an alias resolved to a real id. */ params?: unknown }
  | { ok: false; reason: string };

/** What a workflow offers as a customer-confirmable action. Validation and execution are separate steps. */
export interface ActionHandler<P = any> {
  type: string;
  title: string;
  /** Doubles as the LLM tool schema (input side) and the normaliser (output side, e.g. amount -> paise). */
  schema: z.ZodType<P, z.ZodTypeDef, any>;
  /** Description of the propose_<type> tool shown to the LLM. */
  description?: string;
  /** Customer-facing labels for figure keys (falls back to the humanised key). */
  labels?: Record<string, string>;
  /** Re-run at propose time and again at confirm time against live data. */
  validate(ctx: ToolContext, p: P): Promise<ValidateResult>;
  /** Performs the side effect. `idemKey` is the proposal id, so retries cannot duplicate it. */
  execute(ctx: ToolContext, p: P, idemKey: string): Promise<{ reference: string; message: string }>;
}

export type ProposalStatus = 'pending' | 'executed' | 'rejected' | 'expired' | 'failed' | 'cancelled';

export interface Proposal {
  id: string;
  sessionId: string;
  customerId: string;
  type: string;
  params: unknown;
  figures: Record<string, BoundValue>;
  summary: string;
  sources: Source[];
  termsHash: string;
  expiresAt: number;
  status: ProposalStatus;
  result?: { reference: string; message: string };
}

export interface ActionOutcome {
  status: 'executed' | 'rejected' | 'failed' | 'expired' | 'cancelled';
  reference?: string;
  message: string;
  reason?: string;
}
