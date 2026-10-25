/**
 * Deterministic replay of a recorded session.
 *
 *   npm run replay -- <sessionId> [--turn n] [--live-llm] [--dir <event log dir>] [--model <gemini model>]
 *
 * Rebuilds the real engine (prompts, tools, grounding, numeric check, guard rules) with
 *  - a recorded transport: backend responses served from the logged `backend_call` events, in order, by method+path;
 *  - the recorded LLM output (llm_response events, in order), or live Gemini with --live-llm;
 *  - the recorded guard classifier verdicts.
 * It prints each turn's original and replayed answer with a word diff. Exit code 1 if a recorded-LLM replay differs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { loadConfig, loadRootEnv } from '../apps/server/src/config.js';
import type { Transport } from '../apps/server/src/platform/connectors/transport.js';
import type { Session } from '../apps/server/src/platform/context/session.js';
import type { TurnSink } from '../apps/server/src/platform/engine/engine.js';
import { GeminiClient } from '../apps/server/src/platform/llm/gemini.js';
import type { LlmChunk, LlmClient, LlmRequest } from '../apps/server/src/platform/llm/types.js';
import { EventLog, type LoggedEvent } from '../apps/server/src/platform/telemetry/eventLog.js';
import { arg } from './eval/runner.js';

type Ev<T extends LoggedEvent['type']> = Extract<LoggedEvent, { type: T }>;

/** Serves logged backend responses by `METHOD path`, in recorded order; the last one repeats once a queue runs dry. */
export function recordedTransport(events: LoggedEvent[]): Transport & { misses: string[] } {
  const queues = new Map<string, Array<{ status: number; body: unknown }>>();
  const last = new Map<string, { status: number; body: unknown }>();
  for (const e of events) {
    if (e.type !== 'backend_call' || e.status === undefined) continue; // stale / breaker-open events made no request
    const k = `${e.method} ${e.path}`;
    (queues.get(k) ?? queues.set(k, []).get(k)!).push({ status: e.status, body: e.body });
  }
  const misses: string[] = [];
  const t: Transport = async ({ method, url }) => {
    const k = `${method} ${url}`;
    const next = queues.get(k)?.shift();
    if (next) { last.set(k, next); return next; }
    const again = last.get(k);
    if (again) return again;
    misses.push(k);
    return { status: 404, body: { error: 'not_recorded' } };
  };
  return Object.assign(t, { misses });
}

/** Plays back the logged llm_response events (engine calls only, in order). */
export function recordedLlm(events: LoggedEvent[]): LlmClient & { remaining(): number } {
  const queue = events.filter((e): e is Ev<'llm_response'> => e.type === 'llm_response').map((e) => e.chunks as LlmChunk[]);
  return {
    remaining: () => queue.length,
    async *stream(_req: LlmRequest, signal: AbortSignal) {
      const chunks = queue.shift();
      if (!chunks) throw new Error('replay: the recording has no more LLM responses');
      for (const c of chunks) {
        if (signal.aborted) return;
        yield c;
      }
    },
  };
}

/** The guard classifier answers with the recorded verdicts (only turns the model, not the rules, decided). */
export function recordedGuardLlm(events: LoggedEvent[]): LlmClient {
  const queue = events.filter((e): e is Ev<'guard'> => e.type === 'guard' && e.by === 'model').map((e) => ({ verdict: e.verdict, category: e.category ?? 'none' }));
  return {
    async *stream() {
      const v = queue.shift() ?? { verdict: 'allow', category: 'none' };
      yield { type: 'text', text: JSON.stringify(v) } as LlmChunk;
      yield { type: 'done' } as LlmChunk;
    },
  };
}

/** Word-level diff: unchanged words as they are, removed as [-w-], added as {+w+}. */
export function wordDiff(a: string, b: string): string {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { out.push(x[i]!); i++; j++; }
    else if (j < y.length && (i === x.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) out.push(`{+${y[j++]}+}`);
    else out.push(`[-${x[i++]}-]`);
  }
  return out.join(' ');
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface ReplayTurn { turnId: string; user: string; original: string; replayed: string; same: boolean; status: string }

export async function replaySession(sessionId: string, o: { dir: string; live: boolean; model?: string }): Promise<{ turns: ReplayTurn[]; misses: string[]; llmLeft: number }> {
  const events = new EventLog(o.dir).read(sessionId);
  if (events.length === 0) throw new Error(`no events for session ${sessionId} in ${o.dir}`);
  const inputs = events.filter((e): e is Ev<'user_input'> => e.type === 'user_input');
  if (inputs.length === 0) throw new Error('the recording has no user turns');
  const first = inputs[0]!;
  if (!first.customerId) throw new Error('this recording predates replay support (no customerId in user_input); record a new session');

  const transport = recordedTransport(events);
  const rllm = recordedLlm(events);
  const env: Record<string, string | undefined> = {
    ...process.env, LLM_PROVIDER: o.live ? 'gemini' : 'stub', EVENT_LOG_DIR: mkdtempSync(join(tmpdir(), 'replay-')), SESSION_SECRET: 'replay', DEMO_ACCESS_CODE: '',
    ...(o.model && { GEMINI_MODEL: o.model }),
  };
  const { config } = loadConfig(env);
  const llm: LlmClient = o.live ? new GeminiClient(config.geminiApiKey!, config.model) : rllm;
  const app = await buildApp(config, { llm, transport, guardLlm: recordedGuardLlm(events) });
  const session: Session = {
    id: sessionId, customerId: first.customerId, workflowId: first.workflowId ?? 'loan-servicing', history: [], entities: {},
    turnSeq: 0, guardStrikes: 0, pendingProposalIds: [], lastSeenAt: Date.now(),
  };
  app.sessions.put(session);

  const turns: ReplayTurn[] = [];
  try {
    for (const inp of inputs) {
      const turnId = inp.turnId ?? `replay-${turns.length + 1}`;
      const original = events.filter((e): e is Ev<'assistant_final'> => e.type === 'assistant_final' && e.turnId === turnId).pop()?.text ?? '(no recorded answer; the turn was aborted)';
      session.workflowId = inp.workflowId ?? session.workflowId;
      let replayed = '';
      let streamed = '';
      const sink: TurnSink = {
        delta: (t) => { streamed += t; }, progress: () => {}, proposal: () => {}, trace: () => {},
        retract: (r) => { streamed = r; }, done: (v) => { replayed = v.text; },
      };
      const { status } = await app.ctx.engine.runTurn(session, { turnId, text: inp.text, channel: inp.channel === 'voice' ? 'voice' : 'text' }, sink);
      replayed = replayed || streamed;
      turns.push({ turnId, user: inp.text, original, replayed, same: norm(original) === norm(replayed), status });
    }
  } finally {
    await app.close();
  }
  return { turns, misses: transport.misses, llmLeft: o.live ? 0 : rllm.remaining() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadRootEnv();
  const sessionId = process.argv[2];
  if (!sessionId || sessionId.startsWith('--')) {
    console.error('usage: npm run replay -- <sessionId> [--turn n] [--live-llm] [--dir <dir>] [--model <name>]');
    process.exit(2);
  }
  const live = arg('live-llm') === 'true';
  const only = arg('turn') ? Number(arg('turn')) : undefined;
  const dir = arg('dir', loadConfig({ ...process.env, LLM_PROVIDER: 'stub' }).config.eventLogDir)!;
  const model = arg('model');
  const r = await replaySession(sessionId, { dir, live, ...(model && { model }) });
  console.log(`session ${sessionId}: ${r.turns.length} turn(s), LLM ${live ? `LIVE (${model ?? process.env.GEMINI_MODEL ?? 'default model'})` : 'recorded'}, backend recorded`);
  let diffs = 0;
  r.turns.forEach((t, i) => {
    if (only !== undefined && only !== i + 1) return;
    if (!t.same) diffs++;
    console.log(`\n--- turn ${i + 1}: "${t.user}"  [${t.status}]`);
    console.log(`ORIGINAL: ${norm(t.original)}`);
    console.log(`REPLAYED: ${norm(t.replayed)}`);
    console.log(t.same ? 'IDENTICAL' : `DIFF:     ${wordDiff(norm(t.original), norm(t.replayed))}`);
  });
  if (r.misses.length) console.log(`\nbackend requests with no recording (served 404): ${[...new Set(r.misses)].join(', ')}`);
  console.log(`\n${diffs === 0 ? 'All shown turns are identical.' : `${diffs} turn(s) differ.`}`);
  process.exit(!live && diffs > 0 ? 1 : 0);
}
