import { z } from 'zod';
import { parseAmount } from '@app/domain';
import type { OpsRequestType } from '../../platform/connectors/types.js';
import type { ToolContext } from '../../platform/tools/types.js';

/** Normalises a loosely phrased amount (number or string) to integer paise; rejects what it cannot parse. */
export const paiseField = z
  .preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(1))
  .describe('Amount as the customer said it, e.g. "50k", "1.5 lakh" or "50000".')
  .transform((s, c) => {
    const r = parseAmount(s);
    if (!r.ok) {
      c.addIssue({ code: z.ZodIssueCode.custom, message: `could not understand the amount "${s}" (${r.reason})` });
      return z.NEVER;
    }
    return r.paise;
  });

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'not a real date');

/** Creates the Ops service request; the proposal id is the idempotency key. Caches that the new request makes stale are dropped. */
export async function createRequest(ctx: ToolContext, type: OpsRequestType, params: Record<string, unknown>, idemKey: string, label: string, invalidateLoanId?: string) {
  const r = await ctx.connectors.ops.create(ctx.customerId, type, params, idemKey, { signal: ctx.signal, observer: ctx.tracer.observer });
  if (!r.ok) throw new Error(`ops create failed: ${r.error}`);
  ctx.connectors.invalidate('ops', `ops:requests:${ctx.customerId}`);
  if (invalidateLoanId) {
    ctx.connectors.invalidate('lms', `lms:loan:${invalidateLoanId}`);
    ctx.connectors.invalidate('lms', `lms:loans:${ctx.customerId}`);
  }
  return { reference: r.data.id, message: `${label} Your reference is ${r.data.id}.` };
}
