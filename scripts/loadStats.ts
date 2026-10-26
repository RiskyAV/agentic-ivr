import { percentile } from './eval/runner.js';

interface MetricsReply {
  metrics: Record<string, { p50: number; p95: number; n: number }>;
  eventLoopLagP99: number;
  rssMb: number;
  sessions: number;
  limiter: { active: number; queued: number };
}
export type { MetricsReply };

export interface LoadResult {
  sessions: number;
  turns: number;
  connected: number;
  completedTurns: number;
  failedTurns: number;
  highDemand: number;
  clientMs: number[];
  serverMs: number[];
  peakQueued: number;
  peakActive: number;
  lagMax: number;
  lagLast: number;
  rssBase: number;
  rssConnected: number;
  rssPeak: number;
  wallSec: number;
  stubDelay: number;
  llmConcurrency: number;
  idealTurnMs: number;
  serverMetrics: MetricsReply['metrics'];
  errors: string[];
}

const f = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : 'n/a');

export function renderLoad(r: LoadResult, label: string): string {
  const c = r.clientMs;
  const s = r.serverMs;
  const perSession = r.connected > 0 ? (r.rssConnected - r.rssBase) / r.connected : NaN;
  const llmFirst = r.serverMetrics.llm_first_token;
  return [
    `**${label}**`, '',
    `- Setup: ${r.sessions} sessions x ${r.turns} turns over WebSocket, stub LLM with ${r.stubDelay} ms per chunk-step (an ideal turn is about ${r.idealTurnMs} ms: three chunk-steps), LLM concurrency limit ${r.llmConcurrency}, think time 0 to 2x the configured mean between turns. ${r.connected}/${r.sessions} sessions connected.`,
    `- Turns: ${r.completedTurns} completed, ${r.failedTurns} failed, ${r.highDemand} answered with the "very high demand" message (limiter queue timeout). Wall time ${r.wallSec.toFixed(1)} s.`,
    `- Turn latency, client send to answer: p50 ${f(percentile(c, 0.5))} ms, p95 ${f(percentile(c, 0.95))} ms, max ${f(c.length ? Math.max(...c) : NaN)} ms. Server turn_total: p50 ${f(percentile(s, 0.5))} ms, p95 ${f(percentile(s, 0.95))} ms.`,
    `- llm_first_token (includes limiter wait): p50 ${f(llmFirst?.p50 ?? NaN)} ms, p95 ${f(llmFirst?.p95 ?? NaN)} ms.`,
    `- Limiter: peak active ${r.peakActive}, peak queued ${r.peakQueued}.`,
    `- Event-loop lag p99 (cumulative histogram of the server process): peak ${r.lagMax.toFixed(1)} ms, at the end ${r.lagLast.toFixed(1)} ms.`,
    `- Server RSS: ${r.rssBase} MB idle, ${r.rssConnected} MB with all sessions connected (${f(perSession * 1024)} KB per idle session), ${r.rssPeak} MB peak under load.`,
    ...(r.errors.length ? [`- Errors: ${[...new Set(r.errors)].slice(0, 5).join('; ')} (${r.errors.length} total)`] : []),
  ].join('\n');
}

