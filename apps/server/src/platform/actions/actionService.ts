import { createHash, randomUUID } from 'node:crypto';
import type { ProposalView } from '@app/shared';
import type { Session } from '../context/session.js';
import { formatBound, type BoundValue } from '../grounding/values.js';
import type { ToolContext, ToolDef } from '../tools/types.js';
import type { AuditEventType, AuditLog } from './audit.js';
import type { ActionHandler, ActionOutcome, Proposal } from './types.js';

export const PROPOSAL_TTL_MS = 5 * 60_000;

/** JSON with object keys sorted recursively, so equal terms always serialise identically. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function computeTermsHash(type: string, params: unknown, figures: Record<string, BoundValue>): string {
  return createHash('sha256').update(canonicalJson({ type, params, figures })).digest('hex').slice(0, 16);
}

const NOT_FOUND: ActionOutcome = { status: 'rejected', reason: 'not_found', message: 'I could not find that request to confirm.' };
const humanise = (key: string) => {
  const s = (key.split('.').pop() ?? key).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * The only path to a side effect. The LLM can call `propose_*` tools (which create pending proposals); execution happens
 * solely in `confirm`, which needs the exact termsHash the customer saw (D-021).
 */
export class ActionService {
  private readonly handlers = new Map<string, ActionHandler>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Map<string, Promise<ActionOutcome>>();

  constructor(
    handlers: ActionHandler[],
    private readonly audit: AuditLog,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = PROPOSAL_TTL_MS,
  ) {
    for (const h of handlers) this.handlers.set(h.type, h);
  }

  private log(p: Proposal, event: AuditEventType, detail: Record<string, unknown> = {}): void {
    this.audit.append({ at: this.now(), sessionId: p.sessionId, customerId: p.customerId, event, proposalId: p.id, detail: { type: p.type, termsHash: p.termsHash, ...detail } });
  }

  private settle(p: Proposal, session: Session | undefined = this.sessions.get(p.id)): void {
    this.sessions.delete(p.id);
    if (session) session.pendingProposalIds = session.pendingProposalIds.filter((x) => x !== p.id);
  }

  private expireIfDue(p: Proposal, session?: Session): boolean {
    if (p.status === 'pending' && this.now() >= p.expiresAt) {
      p.status = 'expired';
      this.log(p, 'expired');
      this.settle(p, session);
    }
    return p.status === 'expired';
  }

  async propose(ctx: ToolContext, type: string, params: unknown): Promise<{ ok: true; proposal: Proposal } | { ok: false; reason: string }> {
    const h = this.handlers.get(type);
    if (!h) return { ok: false, reason: `Unknown action type: ${type}` };
    const parsed = h.schema.safeParse(params);
    if (!parsed.success) {
      return { ok: false, reason: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ') };
    }
    return this.submit(ctx, h, parsed.data);
  }

  /** Creates a proposal from params that are already schema-normalised (the registry parses tool args first). */
  private async submit(ctx: ToolContext, h: ActionHandler, params: unknown): Promise<{ ok: true; proposal: Proposal } | { ok: false; reason: string }> {
    const type = h.type;
    let v;
    try {
      v = await h.validate(ctx, params);
    } catch {
      return { ok: false, reason: 'The request could not be checked right now.' };
    }
    if (!v.ok) return { ok: false, reason: v.reason };
    const proposal: Proposal = {
      id: `PRP-${randomUUID().slice(0, 8)}`, sessionId: ctx.session.id, customerId: ctx.customerId, type,
      params: v.params ?? params, figures: v.figures, summary: v.summary, sources: v.sources ?? [],
      termsHash: computeTermsHash(type, v.params ?? params, v.figures), expiresAt: this.now() + this.ttlMs, status: 'pending',
    };
    this.proposals.set(proposal.id, proposal);
    this.sessions.set(proposal.id, ctx.session);
    ctx.session.pendingProposalIds.push(proposal.id);
    this.log(proposal, 'proposed', { figures: proposal.figures });
    return { ok: true, proposal };
  }

  pending(sessionId: string): Proposal[] {
    const out: Proposal[] = [];
    for (const p of this.proposals.values()) {
      if (p.sessionId !== sessionId || p.status !== 'pending') continue;
      if (!this.expireIfDue(p)) out.push(p);
    }
    return out;
  }

  /** Lets callers (the gateway) look up a proposal they are entitled to see; null otherwise. */
  get(session: Session, proposalId: string): Proposal | null {
    const p = this.proposals.get(proposalId);
    return p && p.sessionId === session.id && p.customerId === session.customerId ? p : null;
  }

  async confirm(session: Session, proposalId: string, termsHash: string, via: 'ui' | 'voice', ctx: ToolContext): Promise<ActionOutcome> {
    const p = this.get(session, proposalId);
    if (!p || ctx.customerId !== p.customerId) return NOT_FOUND; // unknown id and someone else's id are indistinguishable
    if (p.status === 'executed') return { status: 'executed', reference: p.result?.reference, message: p.result?.message ?? 'Already done.' };
    const running = this.inflight.get(p.id);
    if (running) {
      if (termsHash !== p.termsHash) return { status: 'rejected', reason: 'hash_mismatch', message: 'These terms do not match what was shown.' };
      return running;
    }
    if (p.status === 'cancelled') return { status: 'cancelled', message: 'This request was cancelled.' };
    if (p.status === 'failed') return { status: 'failed', message: 'This request failed earlier. Nothing was changed; please start again.' };
    if (p.status === 'rejected') return { status: 'rejected', reason: 'closed', message: 'This request is no longer valid; please start again.' };
    if (this.expireIfDue(p, session)) return { status: 'expired', message: 'This request expired. Please ask again and confirm within 5 minutes.' };
    if (termsHash !== p.termsHash) {
      this.log(p, 'rejected', { reason: 'hash_mismatch', via });
      return { status: 'rejected', reason: 'hash_mismatch', message: 'These terms do not match what was shown, so nothing was done.' };
    }
    // From here to the in-flight registration there is no await, so concurrent confirms cannot both pass.
    const run = this.execute(p, session, via, ctx).finally(() => this.inflight.delete(p.id));
    this.inflight.set(p.id, run);
    return run;
  }

  private async execute(p: Proposal, session: Session, via: 'ui' | 'voice', ctx: ToolContext): Promise<ActionOutcome> {
    const h = this.handlers.get(p.type)!;
    this.log(p, 'confirmed', { via });
    const reject = (reason: string, message: string): ActionOutcome => {
      p.status = 'rejected';
      this.settle(p, session);
      this.log(p, 'rejected', { reason });
      return { status: 'rejected', reason, message };
    };
    let v;
    try {
      v = await h.validate(ctx, p.params);
    } catch {
      // Temporary outage: the proposal stays pending so the customer can simply confirm again.
      this.log(p, 'failed', { reason: 'validation_unavailable' });
      return { status: 'failed', reason: 'validation_unavailable', message: 'I could not re-check your request just now, so nothing was done. Please try again in a moment.' };
    }
    if (!v.ok) return reject('validation_failed', v.reason);
    if (computeTermsHash(p.type, p.params, v.figures) !== p.termsHash) {
      return reject('terms_changed', 'The figures changed since I showed you this request, so nothing was done. Please ask again to see the updated terms.');
    }
    try {
      const r = await h.execute(ctx, p.params, p.id);
      p.status = 'executed';
      p.result = r;
      this.settle(p, session);
      this.log(p, 'executed', { reference: r.reference });
      return { status: 'executed', reference: r.reference, message: r.message };
    } catch (e) {
      // The backend may have committed before the response was lost. Keep the proposal pending (same id, hash and
      // expiry) so a re-confirm reuses the same idempotency key and the backend de-duplicates.
      this.log(p, 'failed', { reason: 'execution_uncertain', error: e instanceof Error ? e.message : String(e) });
      return { status: 'failed', reason: 'execution_uncertain', message: "I couldn't confirm the request went through. You can safely retry — it won't create a duplicate." };
    }
  }

  async cancel(session: Session, proposalId: string): Promise<ActionOutcome> {
    const p = this.get(session, proposalId);
    if (!p) return NOT_FOUND;
    if (p.status === 'executed') return { status: 'rejected', reason: 'already_executed', message: 'This request has already been completed.' };
    if (p.status === 'pending' && !this.inflight.has(p.id) && !this.expireIfDue(p, session)) {
      p.status = 'cancelled';
      this.settle(p, session);
      this.log(p, 'cancelled');
    }
    if (p.status === 'cancelled') return { status: 'cancelled', message: 'Cancelled. Nothing was changed.' };
    if (p.status === 'expired') return { status: 'expired', message: 'This request had already expired.' };
    return { status: 'rejected', reason: 'not_cancellable', message: 'This request can no longer be cancelled.' };
  }

  toView(p: Proposal): ProposalView {
    const h = this.handlers.get(p.type);
    return {
      id: p.id, type: p.type, title: h?.title ?? p.type, summary: p.summary, termsHash: p.termsHash, expiresAt: p.expiresAt,
      figures: Object.entries(p.figures).map(([k, v]) => ({ label: h?.labels?.[k] ?? humanise(k), value: formatBound(v, 'text') })),
    };
  }

  /** LLM-facing wrapper: creates a pending proposal and tells the model that only the customer can confirm it. */
  proposeTool(type: string): ToolDef {
    const h = this.handlers.get(type);
    if (!h) throw new Error(`Unknown action type: ${type}`);
    return {
      name: `propose_${type}`,
      description: h.description ?? `Proposes: ${h.title}. This does NOT perform the action; the customer must confirm it.`,
      kind: 'propose',
      schema: h.schema,
      filler: 'Preparing that for you to confirm.',
      run: async (ctx, args) => {
        const r = await this.submit(ctx, h, args);
        if (!r.ok) return { ok: false, error: 'invalid', message: r.reason };
        const p = r.proposal;
        return {
          ok: true,
          data: {
            proposalId: p.id, summary: p.summary, status: 'pending_confirmation',
            instruction: 'Nothing has been done yet. Tell the customer the details and ask them to confirm in the app or by saying yes. Do not say the action is completed, submitted or done.',
          },
          values: Object.fromEntries(Object.entries(p.figures).map(([k, v]) => [`proposal.${k}`, v])),
          sources: p.sources,
        };
      },
    };
  }
}
