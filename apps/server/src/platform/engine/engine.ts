import { createHash } from 'node:crypto';
import { today } from '@app/domain';
import type { Channel, ProposalView, Source, TableView, TurnTrace } from '@app/shared';
import type { ActionService } from '../actions/actionService.js';
import type { Proposal } from '../actions/types.js';
import type { Connectors } from '../connectors/clients.js';
import { redact } from '../context/redact.js';
import type { HistoryEntry, Session } from '../context/session.js';
import { loadSnapshot, type CustomerSnapshot } from '../context/snapshot.js';
import { numericCheck } from '../grounding/numericCheck.js';
import { PlaceholderRenderer } from '../grounding/renderer.js';
import { formatBound, type BoundValue } from '../grounding/values.js';
import { staleValues } from './stale.js';
import type { AuditLog } from '../actions/audit.js';
import { refusalFor } from '../guard/refusal.js';
import type { Guard, GuardVerdict, RefusalFn } from '../guard/types.js';
import { LimiterTimeout, type Limiter } from '../llm/limiter.js';
import type { LlmChunk, LlmClient, LlmMessage, LlmRequest, ToolCall } from '../llm/types.js';
import type { EventLog, LoggedEvent } from '../telemetry/eventLog.js';
import type { Metrics } from '../telemetry/metrics.js';
import { TurnTracer } from '../telemetry/tracer.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { FunctionDeclaration, ToolContext, ToolResult } from '../tools/types.js';
import type { WorkflowRegistry } from '../workflows/registry.js';
import type { WorkflowDefinition } from '../workflows/types.js';
import { buildPrompt, entityValues, snapshotValues, summarisePolicies, wrapUntrusted } from './prompts.js';

export interface TurnSink {
  delta(text: string): void;
  progress(tool: string, label: string): void;
  proposal(v: ProposalView): void;
  /** Always the last content event of a non-aborted turn; `text` is the final text (after any retraction). */
  done(v: { text: string; sources: Source[]; tables?: TableView[] }): void;
  /** Replace everything streamed so far in this turn with `replacement`. */
  retract(replacement: string): void;
  trace(t: TurnTrace): void;
}

export type TurnStatus = 'completed' | 'aborted' | 'blocked' | 'degraded';

export interface EngineConfig {
  turnBudgetMs: number;
  maxToolRounds: number;
  toolTimeoutMs: number;
  /** Max wait for the guard verdict once the answer is ready (default 1500). */
  guardWaitMs?: number;
  /** Below this remaining budget no new tool calls start (default 1500). Also reserved for the final LLM answer. */
  reserveMs?: number;
  /** LLM model override; the client's default when absent. */
  model?: string;
}

export interface EngineDeps {
  llm: LlmClient;
  limiter: Limiter;
  tools: ToolRegistry;
  actions: ActionService;
  workflows: WorkflowRegistry;
  connectors: Connectors;
  eventLog: EventLog;
  metrics: Metrics;
  guard?: Guard;
  refusal?: RefusalFn;
  /** Names of other customers the guard should watch for (cross-customer probing). */
  otherCustomerNames?: (customerId: string) => string[];
  /** Names of all demo customers; the current customer's own name is filtered out before the guard sees them. */
  demoCustomerNames?: string[];
  /** Receives `guard_escalation` entries when a block happens at 2+ strikes. */
  audit?: AuditLog;
  config: EngineConfig;
}

export const HIGH_DEMAND_MESSAGE = "We're seeing very high demand right now. Please try again in a moment.";
export const BLOCKED_FALLBACK = "I'm sorry, I can't help with that. Could you rephrase?";
export const DEGRADED_FALLBACK = "I'm still checking some of that — shall I raise a ticket so we can follow up?";
export const ERROR_FALLBACK = "Sorry, something went wrong on my side. Could you ask again, or shall I raise a ticket for you?";
export const WITHHELD_INPUT = '[message withheld by safety check]';
export const PROPOSAL_DROPPED_NOTE = "(I couldn't finalise that request just now — please ask again to set it up.)";
/** Bounded wait for a guard verdict when a turn ends early (abort or error), before its input is stored in history. */
const EARLY_GUARD_WAIT_MS = 800;

export const defaultRefusal: RefusalFn = refusalFor;

export function engineConfigFromEnv(env: Record<string, string | undefined> = process.env): EngineConfig {
  const budget = Number(env.TURN_BUDGET_MS);
  const guardWait = Number(env.GUARD_WAIT_MS);
  return {
    turnBudgetMs: Number.isFinite(budget) && budget > 0 ? budget : 9000,
    // The classifier takes about 1.0-1.4 s, so the default leaves headroom over the engine's built-in 1500.
    guardWaitMs: env.GUARD_WAIT_MS && Number.isFinite(guardWait) && guardWait > 0 ? guardWait : 2000,
    maxToolRounds: 4,
    toolTimeoutMs: 4000,
    ...(env.GEMINI_MODEL && { model: env.GEMINI_MODEL }),
  };
}

type ToolResponse = { callId: string; name: string; response: unknown };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
const onAbort = (signal: AbortSignal) =>
  new Promise<'aborted'>((r) => (signal.aborted ? r('aborted') : signal.addEventListener('abort', () => r('aborted'), { once: true })));

/** Wraps free text (any string with whitespace) from backends so the model treats it as data (D-026). */
function wrapStrings(v: unknown): unknown {
  if (typeof v === 'string') return /\s/.test(v) ? wrapUntrusted(v) : v;
  if (Array.isArray(v)) return v.map(wrapStrings);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wrapStrings(x)]));
  return v;
}

const valueList = (values: Record<string, BoundValue> | undefined) =>
  Object.entries(values ?? {}).map(([k, v]) => `{{${k}}} = ${formatBound(v, 'text')}`);

function dedupeSources(list: Source[]): Source[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.kind}|${s.system ?? ''}|${s.ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Workflow-agnostic turn loop (spec 5.2): prompt -> streamed LLM -> parallel tools (bounded rounds) -> final answer,
 * with placeholder-bound figures, a parallel guard gating proposals, a hard turn budget and cancellation.
 */
export class Engine {
  private readonly running = new WeakMap<Session, Promise<unknown>>();
  private readonly decls = new Map<string, FunctionDeclaration[]>();
  private readonly policyText = new Map<string, string>();

  constructor(private readonly deps: EngineDeps) {}

  private cfg() {
    return { guardWaitMs: 1500, reserveMs: 1500, ...this.deps.config };
  }

  private workflow(session: Session): WorkflowDefinition {
    const wf = this.deps.workflows.get(session.workflowId);
    if (!wf) throw new Error(`Unknown workflow: ${session.workflowId}`);
    return wf;
  }

  private log(session: Session, turnId: string | undefined, ev: Record<string, unknown> & { type: LoggedEvent['type'] }): void {
    try {
      this.deps.eventLog.append(session.id, { ...ev, at: Date.now(), ...(turnId && { turnId }) } as LoggedEvent);
    } catch {
      /* logging must never fail a turn */
    }
  }

  runTurn(session: Session, input: { turnId: string; text: string; channel: Channel }, sink: TurnSink): Promise<{ status: TurnStatus }> {
    session.activeTurn?.abort.abort();
    const previous = this.running.get(session);
    const abort = new AbortController();
    const seq = ++session.turnSeq;
    session.activeTurn = { turnId: input.turnId, seq, abort };
    session.lastSeenAt = Date.now();
    const p = (async () => {
      // Let the aborted turn record its partial history first, so history order matches turn order.
      if (previous) await Promise.race([previous, sleep(1000)]);
      return this.turn(session, input, sink, abort.signal);
    })().finally(() => {
      if (session.activeTurn?.seq === seq) session.activeTurn = undefined;
    });
    this.running.set(session, p.catch(() => undefined));
    return p;
  }

  private async turn(
    session: Session,
    input: { turnId: string; text: string; channel: Channel },
    sink: TurnSink,
    signal: AbortSignal,
  ): Promise<{ status: TurnStatus }> {
    const { llm, limiter, tools, actions, metrics } = this.deps;
    const cfg = this.cfg();
    const { turnId, channel } = input;
    const t0 = performance.now();
    const elapsed = () => performance.now() - t0;
    const remaining = () => cfg.turnBudgetMs - elapsed();
    const tracer = new TurnTracer(turnId, channel);
    const log = (ev: Record<string, unknown> & { type: LoggedEvent['type'] }) => this.log(session, turnId, ev);
    tracer.onCall((e) => log({
      type: 'backend_call', system: e.system, method: e.method ?? 'GET', path: e.path ?? e.key,
      ...(e.status !== undefined && { status: e.status }), ...(e.body !== undefined && { body: e.body }), outcome: e.outcome,
    }));
    log({ type: 'user_input', text: input.text, channel, workflowId: session.workflowId, customerId: session.customerId });

    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), Math.max(0, cfg.turnBudgetMs));
    const roundSignal = AbortSignal.any([signal, budget.signal]);
    // Not tied to the turn signal: an aborted turn still needs the verdict before its input enters history.
    const guardCtl = new AbortController();
    const entitiesBefore = structuredClone(session.entities);
    let guardP: Promise<GuardVerdict | null> | undefined;
    let guardT0 = performance.now();
    let verdict: GuardVerdict | undefined;

    const values: Record<string, BoundValue> = {};
    const staleAsOf: Record<string, string> = {};
    const sources: Source[] = [];
    const tables: TableView[] = [];
    const toolEntries: HistoryEntry[] = [];
    const held: Proposal[] = [];
    const renderer = new PlaceholderRenderer(() => values, channel);
    let shown = '';
    let firstDeltaAt: number | undefined;
    let toolRounds = 0;
    let status: TurnStatus = 'completed';
    let llmBlocked = false;
    let finished = false;

    const emit = (t: string) => {
      if (!t || signal.aborted) return;
      if (firstDeltaAt === undefined) firstDeltaAt = elapsed();
      shown += t;
      sink.delta(t);
    };
    // A note after a cut-off sentence reads as a new sentence ("... an increase of… I'm still checking ...").
    const appendNote = (note: string) => {
      if (!shown) return emit(note);
      const trimmed = /\s$/.test(shown) ? '' : ' ';
      emit(/[.!?]\s*$/.test(shown) ? `${trimmed}${note}` : `…${trimmed || ' '}${note}`);
    };
    const cancelHeld = async () => {
      for (const p of held.splice(0)) {
        await actions.cancel(session, p.id).catch(() => tracer.mark('proposal_cancel_failed'));
      }
    };
    const recordVerdict = (v: GuardVerdict) => {
      verdict = v;
      tracer.guard = { verdict: v.by === 'timeout' ? 'timeout' : v.verdict, ...(v.category && { category: v.category }), ms: v.ms };
      log({ type: 'guard', verdict: v.verdict, by: v.by, ms: v.ms, ...(v.category && { category: v.category }) });
      if (v.verdict === 'block') {
        session.guardStrikes++;
        if (session.guardStrikes >= 2) {
          this.deps.audit?.append({
            at: Date.now(), sessionId: session.id, customerId: session.customerId, event: 'guard_escalation', proposalId: '',
            detail: { turnId: input.turnId, category: v.category ?? null, by: v.by, strikes: session.guardStrikes },
          });
        }
      }
    };
    /** Waits (bounded) for the verdict if none is recorded yet; a missing guard verdict counts as allow. */
    const settleVerdict = async (waitMs: number, abortable: boolean) => {
      if (verdict || !this.deps.guard) return;
      if (!guardP) return; // the turn ended before the guard started: nothing was screened, and nothing ran either
      const v = await Promise.race([guardP, sleep(waitMs), ...(abortable ? [onAbort(signal)] : [])]);
      if (v === 'aborted') return;
      recordVerdict(v && v !== 'timeout' ? v : { verdict: 'allow', by: 'timeout', ms: Math.round(performance.now() - guardT0) });
    };
    /**
     * Commits the turn to history. A blocked input is never replayed to the LLM (two-step bypass): the user entry is
     * withheld, the turn's tool entries are dropped and its entity changes are rolled back.
     */
    const commitHistory = (assistant?: HistoryEntry) => {
      if (verdict?.verdict === 'block') {
        session.entities = structuredClone(entitiesBefore);
        session.history.push({ role: 'user', text: WITHHELD_INPUT, channel }, ...(assistant ? [assistant] : []));
        return;
      }
      session.history.push({ role: 'user', text: input.text, channel }, ...toolEntries, ...(assistant ? [assistant] : []));
    };
    const updateEntities = (name: string, r: ToolResult) => {
      session.entities.lastTopic = name;
      for (const [k, v] of Object.entries(r.values ?? {})) {
        if (v.kind === 'money' && (k === 'prepay.amount' || (k.startsWith('proposal.') && k.endsWith('.amount')))) session.entities.lastAmount = v.paise;
      }
    };
    const finishAborted = async () => {
      finished = true;
      await cancelHeld();
      await settleVerdict(EARLY_GUARD_WAIT_MS, false);
      commitHistory(shown && verdict?.verdict !== 'block' ? { role: 'assistant', text: shown, interruptedAt: shown } : undefined);
      tracer.setMetric('turn_total', Math.round(elapsed()));
      log({ type: 'timing', metrics: { turn_total: Math.round(elapsed()), aborted: 1 } });
      sink.trace(tracer.toTrace());
      return { status: 'aborted' as const };
    };

    try {
      // Context: snapshot (normally preloaded at session start) and the per-turn value map.
      if (!session.snapshot) {
        const end = tracer.span('snapshot');
        try {
          session.snapshot = await loadSnapshot(this.deps.connectors, session.customerId, { signal, observer: tracer.observer });
        } catch {
          if (signal.aborted) return await finishAborted();
        }
        end();
      }
      const snapshot: CustomerSnapshot = session.snapshot ?? { customerId: session.customerId, loans: [], recentPayments: [], fetchedAt: new Date().toISOString(), partial: ['crm', 'lms'] };
      Object.assign(values, snapshotValues(snapshot), entityValues(session.entities));

      // 1. Guard runs in parallel with the whole turn.
      guardT0 = performance.now();
      guardP = this.deps.guard
        ?.check(
          input.text,
          {
            customerName: snapshot.customer?.name ?? '',
            otherCustomerNames: this.otherNames(session.customerId, snapshot.customer?.name),
            ownedLoanIds: snapshot.loans.map((l) => l.loanId),
            strikes: session.guardStrikes,
          },
          guardCtl.signal,
        )
        .catch(() => null);

      // 2. Prompt.
      const wf = this.workflow(session);
      const prompt = buildPrompt({
        wf, snapshot, entities: session.entities, history: session.history, channel, values, policySummaries: this.policies(wf),
      });
      const messages: LlmMessage[] = [...prompt.messages, { role: 'user', text: input.text }];
      const decls = this.declarations(wf);
      const ctxBase: Omit<ToolContext, 'signal'> = {
        customerId: session.customerId, session, turnId, channel, connectors: this.deps.connectors, tracer, today: today(),
      };

      let stopNoticeSent = false;
      for (let round = 0; ; round++) {
        if (signal.aborted) return await finishAborted();
        const req: LlmRequest = { system: prompt.system, tools: decls, messages: [...messages], ...(cfg.model && { model: cfg.model }) };
        log({ type: 'llm_request', promptHash: sha(prompt.system + JSON.stringify(messages)), prefixHash: prompt.prefixHash, model: cfg.model ?? 'default', round });
        const chunks: LlmChunk[] = [];
        const endSpan = tracer.span('llm', { round });
        const reqAt = performance.now();
        let raw = '';
        const calls: ToolCall[] = [];
        let usage: unknown;
        let failure: unknown;
        try {
          await limiter.run(async () => {
            for await (const c of llm.stream(req, roundSignal)) {
              if (roundSignal.aborted) break;
              if (chunks.length === 0 && round === 0) {
                const ms = performance.now() - reqAt;
                metrics.record('llm_first_token', ms);
                tracer.setMetric('llm_first_token', Math.round(ms));
              }
              chunks.push(c);
              if (c.type === 'text') { raw += c.text; emit(renderer.push(c.text)); }
              else if (c.type === 'tool_calls') calls.push(...c.calls);
              else if (c.type === 'done') { usage = c.usage; if (c.blocked) llmBlocked = true; }
            }
            if (roundSignal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          }, roundSignal);
          emit(renderer.end());
        } catch (e) {
          failure = e;
        }
        endSpan({ chunks: chunks.length, ...(failure !== undefined && { error: failure instanceof Error ? failure.name : 'error' }) });
        log({ type: 'llm_response', round, chunks, ...(usage !== undefined && { usage }) });
        if (signal.aborted) return await finishAborted();
        if (failure !== undefined) {
          status = 'degraded';
          if (failure instanceof LimiterTimeout) appendNote(HIGH_DEMAND_MESSAGE);
          else if (budget.signal.aborted) appendNote(DEGRADED_FALLBACK);
          else appendNote(shown ? DEGRADED_FALLBACK : ERROR_FALLBACK);
          break;
        }
        if (llmBlocked || calls.length === 0) break;

        // 4. Tool round.
        messages.push({ role: 'assistant', ...(raw && { text: raw }), toolCalls: calls });
        let results: ToolResponse[];
        const outOfTime = remaining() < cfg.reserveMs;
        if (outOfTime || toolRounds >= cfg.maxToolRounds) {
          if (stopNoticeSent) { status = 'degraded'; appendNote(DEGRADED_FALLBACK); break; }
          stopNoticeSent = true;
          const error = outOfTime ? 'time_budget_exceeded' : 'tool_limit_reached';
          tracer.mark(error);
          results = calls.map((c) => ({
            callId: c.id, name: c.name,
            response: { error, message: 'No more checks can run in this turn. Answer with what you already have and say what you could not check.' },
          }));
        } else {
          toolRounds++;
          results = await this.runTools(calls, { ctxBase, wf, sink, signal, remaining, cfg, values, stale: staleAsOf, sources, tables, toolEntries, held, updateEntities, finishedRef: () => finished || signal.aborted });
          if (signal.aborted) return await finishAborted();
        }
        messages.push({ role: 'tool', results });
      }

      // 6. Guard verdict gates proposals and can retract the answer.
      await settleVerdict(Math.min(cfg.guardWaitMs, Math.max(remaining(), 250)), true);
      if (signal.aborted) return await finishAborted();

      let finalText = shown;
      let finalSources = dedupeSources(sources);
      let finalTables = tables;
      if (verdict?.verdict === 'block' || llmBlocked) {
        status = 'blocked';
        await cancelHeld();
        if (signal.aborted) return await finishAborted();
        finalText = verdict?.verdict === 'block' ? (this.deps.refusal ?? defaultRefusal)(verdict.category, session.guardStrikes) : BLOCKED_FALLBACK;
        finalSources = [];
        finalTables = [];
        sink.retract(finalText);
      } else {
        if (verdict?.by === 'timeout' && held.length > 0) {
          // No verdict: the answer stands, but nothing actionable is offered — and the customer is told so.
          await cancelHeld();
          if (signal.aborted) return await finishAborted();
          appendNote(PROPOSAL_DROPPED_NOTE);
        }
        if (!shown && held.length === 0) {
          status = 'degraded';
          emit(ERROR_FALLBACK);
        }
        finalText = shown;
        for (const p of held.splice(0)) {
          if (signal.aborted) return await finishAborted();
          if (p.status !== 'pending') continue;
          sink.proposal(actions.toView(p));
          log({ type: 'proposal', proposalId: p.id, actionType: p.type, termsHash: p.termsHash });
        }
      }
      if (signal.aborted) return await finishAborted();

      // 7. Numeric check, done, history, telemetry.
      const check = numericCheck(renderer.segments(), Object.values(values), channel);
      const unverified = status === 'blocked' ? [] : check.unverified;
      tracer.setMetric('unverified', unverified.length);
      tracer.setMetric('unresolved', renderer.unresolved.length);
      finished = true;
      sink.done({ text: finalText, sources: finalSources, ...(finalTables.length > 0 && { tables: finalTables }) });
      commitHistory({ role: 'assistant', text: finalText });

      const total = Math.round(elapsed());
      metrics.record('turn_total', total);
      metrics.record('turn_tool_rounds', toolRounds);
      tracer.setMetric('turn_total', total);
      tracer.setMetric('turn_tool_rounds', toolRounds);
      if (firstDeltaAt !== undefined) tracer.setMetric('first_delta', Math.round(firstDeltaAt));
      log({ type: 'assistant_final', text: finalText, sources: finalSources, unverified, status });
      log({ type: 'timing', metrics: tracer.toTrace().metrics });
      sink.trace(tracer.toTrace());
      return { status };
    } catch (e) {
      // Unexpected failure (bug, registry/prompt error, throwing sink): end the turn honestly, never silently.
      tracer.mark('turn_error');
      if (signal.aborted) return await finishAborted();
      finished = true;
      await cancelHeld();
      await settleVerdict(EARLY_GUARD_WAIT_MS, true);
      if (signal.aborted) return await finishAborted();
      const blocked = verdict?.verdict === 'block';
      const text = blocked ? (this.deps.refusal ?? defaultRefusal)(verdict!.category, session.guardStrikes) : null;
      try {
        if (text) sink.retract(text);
        else appendNote(ERROR_FALLBACK);
        const finalText = text ?? shown;
        sink.done({ text: finalText, sources: [] });
        commitHistory({ role: 'assistant', text: finalText });
        log({ type: 'assistant_final', text: finalText, sources: [], unverified: [], status: blocked ? 'blocked' : 'degraded', error: e instanceof Error ? e.message : String(e) });
        tracer.setMetric('turn_total', Math.round(elapsed()));
        metrics.record('turn_total', Math.round(elapsed()));
        sink.trace(tracer.toTrace());
      } catch {
        /* the sink itself is broken; nothing more we can tell the customer */
      }
      return { status: blocked ? 'blocked' : 'degraded' };
    } finally {
      finished = true;
      clearTimeout(budgetTimer);
      guardCtl.abort();
      if (held.length > 0) await cancelHeld();
    }
  }

  private otherNames(customerId: string, ownName?: string): string[] {
    const own = ownName?.trim().toLowerCase();
    const all = [...(this.deps.otherCustomerNames?.(customerId) ?? []), ...(this.deps.demoCustomerNames ?? [])];
    return [...new Set(all)].filter((n) => n.trim().toLowerCase() !== own);
  }

  private async runTools(
    calls: ToolCall[],
    t: {
      ctxBase: Omit<ToolContext, 'signal'>;
      wf: WorkflowDefinition;
      sink: TurnSink;
      signal: AbortSignal;
      remaining: () => number;
      cfg: EngineConfig & { reserveMs: number };
      values: Record<string, BoundValue>;
      /** asOf of each stale tool result in this turn, by tool name. */
      stale: Record<string, string>;
      sources: Source[];
      tables: TableView[];
      toolEntries: HistoryEntry[];
      held: Proposal[];
      updateEntities: (name: string, r: ToolResult) => void;
      finishedRef: () => boolean;
    },
  ): Promise<ToolResponse[]> {
    const { tools, actions, metrics } = this.deps;
    const session = t.ctxBase.session;
    for (const c of calls) {
      if (t.signal.aborted) break;
      t.sink.progress(c.name, t.wf.voice?.fillers?.[c.name] ?? tools.get(c.name)?.filler ?? 'One moment…');
    }
    // Never let a tool eat the time the final answer needs.
    const timeoutMs = Math.max(0, Math.min(t.cfg.toolTimeoutMs, t.remaining() - t.cfg.reserveMs));
    const proposalOf = (r: ToolResult): string | undefined =>
      r.ok && r.data && typeof r.data === 'object' ? ((r.data as { proposalId?: string }).proposalId ?? undefined) : undefined;

    const runOne = async (c: ToolCall): Promise<{ call: ToolCall; result?: ToolResult; timedOut?: boolean; ms: number }> => {
      const started = performance.now();
      const ctl = new AbortController();
      let lost = false;
      // In-flight backend calls are not cancelled on barge-in (reads land in the client cache); only on timeout.
      const run = tools.run(c.name, c.args, { ...t.ctxBase, signal: ctl.signal }).then((r) => {
        const pid = proposalOf(r);
        if (pid && (lost || t.finishedRef())) {
          // A late proposal nobody will see.
          actions.cancel(session, pid).catch(() => t.ctxBase.tracer.mark('late_proposal_cancel_failed'));
        }
        return r;
      });
      const winner = await Promise.race([run, sleep(timeoutMs), onAbort(t.signal)]);
      const ms = performance.now() - started;
      if (winner === 'timeout' || winner === 'aborted') {
        lost = true;
        if (winner === 'timeout') ctl.abort();
        return { call: c, timedOut: winner === 'timeout', ms };
      }
      return { call: c, result: winner, ms };
    };

    const settled = await Promise.allSettled(calls.map(runOne));
    const out: ToolResponse[] = [];
    settled.forEach((s, i) => {
      const call = calls[i]!;
      const base = { callId: call.id, name: call.name };
      if (s.status === 'rejected' || (!s.value.result && !s.value.timedOut)) {
        out.push({ ...base, response: { error: 'unavailable', message: 'This check failed.' } });
        return;
      }
      const { result, timedOut, ms } = s.value;
      metrics.record(`tool:${call.name}`, ms);
      if (timedOut || !result) {
        t.toolEntries.push({ role: 'tool', name: call.name, summary: 'timed out' });
        t.ctxBase.session.entities.lastTopic = call.name;
        out.push({ ...base, response: { error: 'timeout', message: 'This check did not respond in time. Tell the customer you could not check it right now.' } });
        return;
      }
      Object.assign(t.values, result.values ?? {});
      if (result.ok && result.stale) {
        t.stale[call.name] = result.stale.asOf;
        Object.assign(t.values, staleValues(t.stale, Date.now()));
      }
      t.updateEntities(call.name, result);
      if (result.ok) {
        t.sources.push(...result.sources);
        if (result.tables) t.tables.push(...result.tables);
        const pid = proposalOf(result);
        const tool = tools.get(call.name);
        if (pid && tool?.kind === 'propose') {
          const p = actions.get(session, pid);
          if (p) t.held.push(p);
        }
        t.toolEntries.push({ role: 'tool', name: call.name, summary: `ok; sources: ${result.sources.map((x) => x.ref).join(', ') || 'none'}` });
        out.push({
          ...base,
          response: {
            ok: true,
            data: wrapStrings(redact(result.data)),
            values: valueList(result.values),
            sources: result.sources.map((x) => x.ref),
            ...(result.stale && { stale: `NOT LIVE: these figures come from an earlier successful check because the system did not respond now. You must tell the customer plainly that this is not live data and that it is as of {{stale.${call.name}.as_of}}.` }),
          },
        });
      } else {
        t.toolEntries.push({ role: 'tool', name: call.name, summary: `${result.error}: ${result.message}` });
        out.push({
          ...base,
          response: {
            error: result.error,
            message: result.message,
            ...(result.options && { options: wrapStrings(redact(result.options)) }),
            ...(result.values && { values: valueList(result.values) }),
          },
        });
      }
    });
    return out;
  }

  private declarations(wf: WorkflowDefinition): FunctionDeclaration[] {
    let d = this.decls.get(wf.id);
    if (!d) this.decls.set(wf.id, (d = this.deps.tools.declarations(wf.tools)));
    return d;
  }

  private policies(wf: WorkflowDefinition): string {
    let p = this.policyText.get(wf.id);
    if (p === undefined) this.policyText.set(wf.id, (p = summarisePolicies(wf.policyTopics)));
    return p;
  }

  /** Proactive first message for a fresh session; no LLM call. Returns false when the workflow has none. */
  async opener(session: Session, sink: TurnSink, channel: Channel = 'text'): Promise<boolean> {
    const wf = this.workflow(session);
    if (!wf.opener) return false;
    if (!session.snapshot) {
      session.snapshot = await loadSnapshot(this.deps.connectors, session.customerId, { signal: new AbortController().signal });
    }
    const raw = wf.opener(session.snapshot);
    if (!raw) return false;
    const values = { ...snapshotValues(session.snapshot), ...entityValues(session.entities) };
    const renderer = new PlaceholderRenderer(() => values, channel);
    const text = renderer.push(raw) + renderer.end();
    sink.delta(text);
    sink.done({ text, sources: [] });
    session.history.push({ role: 'assistant', text });
    this.log(session, undefined, { type: 'assistant_final', text, sources: [], unverified: [], status: 'opener' });
    return true;
  }
}
